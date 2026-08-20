const assert = require("node:assert/strict");
const test = require("node:test");
const { ChannelType, Collection } = require("discord.js");

const {
  BILLING_PLANS,
  DAY_MS,
} = require("../src/billing/constants");
const {
  buildTicketControlPayload,
} = require("../src/components/ticketAiControls");
const {
  refreshOpenTicketControlsForGuild,
} = require("../src/billing/ticketControlRefresh");
const {
  trackTicketChannel,
} = require("../src/events/tickets/channelCreate");

const NOW = new Date("2026-08-01T12:00:00.000Z");

function optionValues(payload) {
  const json = payload.components.map((row) => row.toJSON());
  return json.flatMap((row) =>
    row.components.flatMap((component) =>
      (component.options || []).map((option) => option.value)
    )
  );
}

for (const plan of [
  BILLING_PLANS.TRIAL,
  BILLING_PLANS.PRO,
  BILLING_PLANS.PARTNER,
]) {
  test(`${plan} renders premium actions, AI toggle, and reset`, () => {
    const payload = buildTicketControlPayload(true, { plan });
    const values = optionValues(payload);

    assert.deepEqual(
      new Set(values),
      new Set(["escalate", "rename", "close", "ai_off", "reset"])
    );
    assert.match(payload.content, /Ticket Actions/);
  });
}

test("expired renders only AI On/Off without disabled premium choices or reset", () => {
  const onPayload = buildTicketControlPayload(true, {
    plan: BILLING_PLANS.EXPIRED,
  });
  const offPayload = buildTicketControlPayload(false, {
    plan: BILLING_PLANS.EXPIRED,
  });

  assert.deepEqual(optionValues(onPayload), ["ai_off"]);
  assert.deepEqual(optionValues(offPayload), ["ai_on"]);
  assert.match(onPayload.content, /Pixy AI Control/);
  assert.doesNotMatch(onPayload.content, /Use the menu below if you want to escalate/);
});

test("new ticket tracking renders controls from the current effective plan", async () => {
  let sentPayload = null;
  let createdData = null;
  const client = {
    guildConfig: {
      async findUnique() {
        return {
          guildId: "guild-1",
          enabled: true,
          ticketCategoryId: "category-1",
        };
      },
    },
    ticketSource: {
      async findMany() {
        return [{
          id: "source-1",
          guildId: "guild-1",
          type: "category",
          sourceId: "category-1",
          enabled: true,
        }];
      },
    },
    guildIgnoredChannel: {
      async findUnique() {
        return null;
      },
    },
    ticketChannel: {
      async findUnique() {
        return null;
      },
      async create({ data }) {
        createdData = data;
        return {
          id: "ticket-1",
          escalated: false,
          ...data,
        };
      },
    },
  };
  const channel = {
    id: "channel-1",
    type: ChannelType.GuildText,
    parentId: "category-1",
    guild: { id: "guild-1" },
    async send(payload) {
      sentPayload = payload;
      return { id: "control-1" };
    },
  };

  const result = await trackTicketChannel(channel, {
    client,
    entitlement: {
      plan: BILLING_PLANS.EXPIRED,
      premiumEntitled: false,
    },
    settings: null,
  });

  assert.equal(result.tracked, true);
  assert.equal(result.created, true);
  assert.equal(result.source.sourceId, "category-1");
  assert.deepEqual(createdData, {
    guildId: "guild-1",
    channelId: "channel-1",
    closed: false,
    status: "open",
    aiEnabled: true,
  });
  assert.deepEqual(optionValues(sentPayload), ["ai_off"]);
});

function createRefreshFixture({ editError = null } = {}) {
  let editedPayload = null;
  const controlMessage = {
    id: "control-1",
    author: { bot: true },
    createdTimestamp: 1,
    components: [{ components: [{ customId: "ticket_control_action" }] }],
    async edit(payload) {
      if (editError) throw editError;
      editedPayload = payload;
      return this;
    },
  };
  const messages = new Collection([[controlMessage.id, controlMessage]]);
  const channel = {
    id: "channel-1",
    messages: {
      async fetch() {
        return messages;
      },
    },
  };
  const guild = {
    id: "guild-1",
    channels: {
      cache: new Collection([[channel.id, channel]]),
      async fetch(channelId) {
        return this.cache.get(channelId) || null;
      },
    },
  };
  const client = {
    guildBilling: {
      async findUnique() {
        return {
          guildId: "guild-1",
          trialStartedAt: new Date(NOW.getTime() - 8 * DAY_MS),
          trialEndsAt: new Date(NOW.getTime() - DAY_MS),
        };
      },
    },
    ticketChannel: {
      async findMany() {
        return [{ channelId: "channel-1", aiEnabled: true }];
      },
    },
  };

  return {
    channel,
    client,
    guild,
    getEditedPayload() {
      return editedPayload;
    },
  };
}

test("open-ticket refresh rewrites stale controls from current entitlement", async () => {
  const fixture = createRefreshFixture();

  const result = await refreshOpenTicketControlsForGuild("guild-1", {
    client: fixture.client,
    guild: fixture.guild,
    now: NOW,
  });

  assert.equal(result.plan, BILLING_PLANS.EXPIRED);
  assert.equal(result.attempted, 1);
  assert.equal(result.refreshed, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(optionValues(fixture.getEditedPayload()), ["ai_off"]);
});

test("refresh failures are logged and never thrown back into billing flows", async () => {
  const fixture = createRefreshFixture({
    editError: new Error("missing permission"),
  });
  const logs = [];

  const result = await refreshOpenTicketControlsForGuild("guild-1", {
    client: fixture.client,
    guild: fixture.guild,
    now: NOW,
    logger: {
      error(message, details) {
        logs.push([message, details]);
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.refreshed, 0);
  assert.equal(result.failed, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0][1].error, /missing permission/);
});
