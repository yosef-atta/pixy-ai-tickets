const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} = require("discord.js");

const { BILLING_PLANS } = require("../src/billing/constants");
const {
  findMatchingSourceForChannel,
} = require("../src/config/ticketSources");
const {
  TICKET_SOURCE_TYPES,
} = require("../src/config/productDefaults");
const {
  getTicketOperatingModePreferences,
  TICKET_OPERATING_MODES,
} = require("../src/features/ticketOperatingMode");
const {
  buildModeAwareTicketControlPayload,
} = require("../src/components/ticketAiControls");
const {
  getTicketSurfaceSettings,
  isSupportedTicketChannel,
  isThreadParentChannel,
  isThreadTicketChannel,
} = require("../src/utils/tickets/ticketSurface");
const {
  preflightFullControlForTicket,
} = require("../src/utils/tickets/humanSupportPermissions");
const {
  reconcileGuildTicketChannels,
  resolveTicketChannelEligibility,
} = require("../src/tickets/ticketChannelLifecycle");
const {
  validateTicketAction,
} = require("../src/utils/tickets/actions/ticketActionValidator");
const {
  TICKET_ACTIONS,
} = require("../src/utils/tickets/actions/ticketActionTypes");
const {
  validateThreadParentIds,
} = require("../src/setup/setupService");
const {
  validateExcludedTicketTarget,
} = require("../src/settings/excludedTicketsService");

const GUILD_ID = "123456789012345678";
const THREAD_PARENT_ID = "200000000000000001";
const CATEGORY_ID = "200000000000000002";
const THREAD_ID = "300000000000000001";

function optionValues(payload) {
  return payload.components.flatMap((row) =>
    row.toJSON().components.flatMap((component) =>
      (component.options || []).map((option) => option.value)
    )
  );
}

function withoutReset(values) {
  return values.filter((value) => value !== "reset");
}

function thread(type = ChannelType.PublicThread, overrides = {}) {
  return {
    id: THREAD_ID,
    type,
    parentId: THREAD_PARENT_ID,
    name: "ticket-thread",
    guild: { id: GUILD_ID },
    ...overrides,
  };
}

test("ticket surface helpers recognize Discord thread tickets and valid parent channels", () => {
  assert.equal(isThreadTicketChannel(thread(ChannelType.PublicThread)), true);
  assert.equal(isThreadTicketChannel(thread(ChannelType.PrivateThread)), true);
  assert.equal(isThreadTicketChannel(thread(ChannelType.AnnouncementThread)), true);
  assert.equal(isSupportedTicketChannel(thread()), true);

  assert.equal(isThreadParentChannel({ type: ChannelType.GuildText }), true);
  assert.equal(isThreadParentChannel({ type: ChannelType.GuildAnnouncement }), true);
  assert.equal(isThreadParentChannel({ type: ChannelType.GuildForum }), true);
  assert.equal(isThreadParentChannel({ type: ChannelType.GuildMedia }), true);
  assert.equal(isThreadParentChannel({ type: ChannelType.GuildCategory }), false);
});

test("thread parent sources match threads directly and never inherit Category-source eligibility", () => {
  const ticketThread = thread();
  const sources = [
    {
      guildId: GUILD_ID,
      type: TICKET_SOURCE_TYPES.CATEGORY,
      sourceId: CATEGORY_ID,
      enabled: true,
    },
    {
      guildId: GUILD_ID,
      type: TICKET_SOURCE_TYPES.THREAD_PARENT,
      sourceId: THREAD_PARENT_ID,
      enabled: true,
    },
  ];

  const match = findMatchingSourceForChannel(ticketThread, sources);
  assert.equal(match.type, TICKET_SOURCE_TYPES.THREAD_PARENT);
  assert.equal(match.sourceId, THREAD_PARENT_ID);

  const categoryOnly = findMatchingSourceForChannel(ticketThread, [sources[0]]);
  assert.equal(categoryOnly, null);
});

test("thread surfaces force lifecycle controls into Smart Overlay without disabling safe handoff", () => {
  const fullSettings = {
    ...getTicketOperatingModePreferences(TICKET_OPERATING_MODES.FULL),
    aiReplyEnabled: true,
    agentActionsEnabled: true,
  };
  const surfaceSettings = getTicketSurfaceSettings(thread(), fullSettings);

  assert.equal(surfaceSettings.closeTicketEnabled, false);
  assert.equal(surfaceSettings.renameReviewEnabled, false);
  assert.equal(surfaceSettings.escalationEnabled, true);
  assert.equal(surfaceSettings.agentActionsEnabled, true);

  const threadPayload = buildModeAwareTicketControlPayload(true, {
    plan: BILLING_PLANS.PRO,
    settings: fullSettings,
    channel: thread(),
  });
  assert.deepEqual(optionValues(threadPayload), ["escalate", "ai_off"]);
  assert.match(threadPayload.content, /Smart Overlay/i);
  assert.match(threadPayload.content, /won't close, rename, move, or delete/i);

  const channelPayload = buildModeAwareTicketControlPayload(true, {
    plan: BILLING_PLANS.PRO,
    settings: fullSettings,
    channel: {
      id: "ticket-channel",
      type: ChannelType.GuildText,
      parentId: CATEGORY_ID,
      guild: { id: GUILD_ID },
    },
  });
  assert.deepEqual(withoutReset(optionValues(channelPayload)), [
    "escalate",
    "rename",
    "close",
    "ai_off",
  ]);
});

test("per-ticket Full Control preflight degrades threads to overlay before destructive permission checks", async () => {
  const guild = {
    id: GUILD_ID,
    members: {
      me: {
        id: "pixy",
        permissions: new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.ReadMessageHistory,
        ]),
      },
    },
  };
  const result = await preflightFullControlForTicket({
    guild,
    ticketChannel: thread(ChannelType.PublicThread, { guild }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "thread_overlay_only");
  assert.equal(result.issues[0].code, "thread_overlay_only");
});

test("validator rejects Close and Rename on threads before any lifecycle mutation can run", async () => {
  const message = {
    guild: { id: GUILD_ID },
    channel: thread(),
    author: { username: "user" },
  };
  const ticketRecord = {
    guildId: GUILD_ID,
    channelId: THREAD_ID,
    closed: false,
    escalated: false,
  };

  const close = await validateTicketAction({
    actionRequest: { action: TICKET_ACTIONS.CLOSE_TICKET, data: {} },
    message,
    ticket: ticketRecord,
  });
  assert.equal(close.ok, false);
  assert.equal(close.code, "thread_lifecycle_action_unsupported");

  const rename = await validateTicketAction({
    actionRequest: {
      action: TICKET_ACTIONS.RENAME_TICKET,
      data: { name: "new-ticket-name" },
    },
    message,
    ticket: ticketRecord,
  });
  assert.equal(rename.ok, false);
  assert.equal(rename.code, "thread_lifecycle_action_unsupported");
});

function eligibilityClient(sources) {
  return {
    guildConfig: {
      async findUnique() {
        return { guildId: GUILD_ID, enabled: true };
      },
    },
    ticketSource: {
      async findMany() {
        return sources;
      },
    },
    guildIgnoredChannel: {
      async findUnique() {
        return null;
      },
    },
  };
}

test("lifecycle eligibility tracks a thread only under an explicitly configured Thread Parent", async () => {
  const source = {
    guildId: GUILD_ID,
    type: TICKET_SOURCE_TYPES.THREAD_PARENT,
    sourceId: THREAD_PARENT_ID,
    enabled: true,
  };
  const ticketThread = thread();

  const eligible = await resolveTicketChannelEligibility(ticketThread, {
    client: eligibilityClient([source]),
  });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.source.type, TICKET_SOURCE_TYPES.THREAD_PARENT);

  const outside = await resolveTicketChannelEligibility(ticketThread, {
    client: eligibilityClient([{
      guildId: GUILD_ID,
      type: TICKET_SOURCE_TYPES.CATEGORY,
      sourceId: CATEGORY_ID,
      enabled: true,
    }]),
  });
  assert.equal(outside.eligible, false);
  assert.equal(outside.code, "outside_ticket_sources");
});

test("startup reconciliation preserves archived configured threads instead of treating them as deleted", async () => {
  const parent = {
    id: THREAD_PARENT_ID,
    name: "tickets",
    type: ChannelType.GuildText,
    guild: null,
  };
  const archivedThread = thread(ChannelType.PublicThread, {
    archived: true,
  });
  const cache = new Map([[parent.id, parent]]);
  const guild = {
    id: GUILD_ID,
    channels: {
      cache,
      async fetch(channelId) {
        if (!channelId) return cache;
        if (channelId === archivedThread.id) return archivedThread;
        return cache.get(channelId) || null;
      },
      async fetchActiveThreads() {
        return { threads: new Map() };
      },
    },
  };
  parent.guild = guild;
  archivedThread.guild = guild;

  let deleteCalls = 0;
  const client = {
    guildConfig: {
      async findUnique() {
        return { guildId: GUILD_ID, enabled: true };
      },
    },
    ticketSource: {
      async findMany() {
        return [{
          guildId: GUILD_ID,
          type: TICKET_SOURCE_TYPES.THREAD_PARENT,
          sourceId: THREAD_PARENT_ID,
          enabled: true,
        }];
      },
    },
    guildIgnoredChannel: {
      async findMany() {
        return [];
      },
    },
    ticketChannel: {
      async findMany() {
        return [{
          guildId: GUILD_ID,
          channelId: THREAD_ID,
          closed: false,
          aiEnabled: true,
        }];
      },
      async deleteMany() {
        deleteCalls += 1;
        return { count: 1 };
      },
    },
  };

  const result = await reconcileGuildTicketChannels(guild, {
    client,
    ensureControls: false,
  });

  assert.equal(result.eligible, 1);
  assert.equal(result.removed, 0);
  assert.equal(result.created, 0);
  assert.equal(deleteCalls, 0);
});

test("setup accepts text, announcement, forum, and media channels as Thread Parents but not categories", async () => {
  const channels = new Map([
    ["text", { id: "text", type: ChannelType.GuildText }],
    ["announcement", { id: "announcement", type: ChannelType.GuildAnnouncement }],
    ["forum", { id: "forum", type: ChannelType.GuildForum }],
    ["media", { id: "media", type: ChannelType.GuildMedia }],
    ["category", { id: "category", type: ChannelType.GuildCategory }],
  ]);
  const guild = {
    channels: {
      cache: channels,
      async fetch(id) {
        return id ? channels.get(id) || null : channels;
      },
    },
  };

  const valid = await validateThreadParentIds(guild, [
    "text",
    "announcement",
    "forum",
    "media",
    "category",
  ]);

  assert.deepEqual(valid.map((channel) => channel.id), [
    "text",
    "announcement",
    "forum",
    "media",
  ]);
});

test("Excluded Tickets accepts a configured thread ticket", async () => {
  const ticketThread = thread();
  const source = {
    guildId: GUILD_ID,
    type: TICKET_SOURCE_TYPES.THREAD_PARENT,
    sourceId: THREAD_PARENT_ID,
    enabled: true,
  };

  const result = await validateExcludedTicketTarget(
    ticketThread.guild,
    ticketThread.id,
    {
      client: {},
      channel: ticketThread,
      sources: [source],
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.source.type, TICKET_SOURCE_TYPES.THREAD_PARENT);
});
