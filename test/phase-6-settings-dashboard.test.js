const assert = require("node:assert/strict");
const test = require("node:test");
const { ChannelType } = require("discord.js");

const {
  TICKET_OPERATING_MODES,
  getTicketOperatingModePreferences,
  resolveTicketOperatingMode,
} = require("../src/features/ticketOperatingMode");
const {
  setTicketOperatingMode,
  toggleBehaviorField,
} = require("../src/settings/ticketBehaviorService");
const {
  addKnowledgeFreeform,
  addKnowledgeQna,
  clearKnowledge,
  deleteKnowledgeItem,
  getKnowledgeLimit,
  listKnowledgeItems,
} = require("../src/settings/knowledgeService");
const {
  excludeTicket,
  restoreExcludedTicket,
  validateExcludedTicketTarget,
} = require("../src/settings/excludedTicketsService");
const {
  PAGES,
} = require("../src/slash/settings");

function createBehaviorClient(initial) {
  let setting = { guildId: "guild-1", ...initial };
  let config = { guildId: "guild-1", enabled: true, aiEnabled: true };
  const client = {
    guildSetting: {
      async update({ data }) {
        setting = { ...setting, ...data };
        return { ...setting };
      },
    },
    guildConfig: {
      async findUnique() {
        return { ...config };
      },
      async updateMany({ data }) {
        config = { ...config, ...data };
        return { count: 1 };
      },
    },
    async $transaction(callback) {
      return callback(this);
    },
    snapshot() {
      return { setting: { ...setting }, config: { ...config } };
    },
  };
  return client;
}

test("Smart Overlay stays Smart Overlay when Human Support is disabled", () => {
  assert.equal(
    resolveTicketOperatingMode({
      closeTicketEnabled: false,
      renameReviewEnabled: false,
      escalationEnabled: false,
    }),
    TICKET_OPERATING_MODES.OVERLAY
  );

  assert.deepEqual(
    getTicketOperatingModePreferences(TICKET_OPERATING_MODES.OVERLAY),
    {
      closeTicketEnabled: false,
      renameReviewEnabled: false,
    }
  );
});

test("Full Ticket Control is rejected before saving when preflight fails", async () => {
  const client = createBehaviorClient({
    aiReplyEnabled: true,
    closeTicketEnabled: false,
    renameReviewEnabled: false,
    escalationEnabled: false,
    agentActionsEnabled: true,
  });
  const current = client.snapshot().setting;
  let refreshCalls = 0;

  const result = await setTicketOperatingMode(
    { id: "guild-1" },
    TICKET_OPERATING_MODES.FULL,
    {
      client,
      getSetting: async () => ({ ...current }),
      preflightFullControl: async () => ({
        ok: false,
        code: "full_control_preflight_failed",
        issues: [{ scope: "server", labels: ["Manage Channels"] }],
      }),
      refreshControls: async () => {
        refreshCalls += 1;
        return { ok: true };
      },
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "full_control_preflight_failed");
  assert.equal(client.snapshot().setting.closeTicketEnabled, false);
  assert.equal(client.snapshot().setting.renameReviewEnabled, false);
  assert.equal(refreshCalls, 0);
});

test("individual toggles cannot silently cross into Full Control without preflight", async () => {
  const client = createBehaviorClient({
    aiReplyEnabled: true,
    closeTicketEnabled: true,
    renameReviewEnabled: true,
    escalationEnabled: false,
    agentActionsEnabled: true,
  });
  const current = client.snapshot().setting;

  const result = await toggleBehaviorField(
    { id: "guild-1" },
    "escalationEnabled",
    {
      client,
      getSetting: async () => ({ ...current }),
      preflightFullControl: async () => ({
        ok: false,
        code: "full_control_preflight_failed",
        issues: [],
      }),
      skipRefresh: true,
    }
  );

  assert.equal(result.ok, false);
  assert.equal(client.snapshot().setting.escalationEnabled, false);
});

function createKnowledgeClient(maxLearnedItems = 3) {
  let config = {
    guildId: "guild-1",
    enabled: true,
    maxLearnedItems,
    maxAdminRoutes: 10,
  };
  let nextId = 1;
  let items = [];

  function matches(item, where = {}) {
    if (where.guildId && item.guildId !== where.guildId) return false;
    if (where.type && item.type !== where.type) return false;
    if (where.id && item.id !== where.id) return false;
    return true;
  }

  return {
    guildConfig: {
      async findUnique() {
        return { ...config };
      },
      async create({ data }) {
        config = { ...data };
        return { ...config };
      },
      async findUniqueOrThrow() {
        return { ...config };
      },
    },
    learnedAnswer: {
      async count({ where }) {
        return items.filter((item) => matches(item, where)).length;
      },
      async findMany({ where = {}, skip = 0, take, select } = {}) {
        let found = items.filter((item) => matches(item, where));
        found = [...found].reverse();
        found = found.slice(skip, take ? skip + take : undefined);
        if (!select) return found.map((item) => ({ ...item }));
        return found.map((item) => Object.fromEntries(
          Object.entries(select)
            .filter(([, enabled]) => enabled)
            .map(([key]) => [key, item[key]])
        ));
      },
      async create({ data }) {
        const item = {
          id: `knowledge-${nextId++}`,
          createdAt: new Date(nextId * 1000),
          ...data,
        };
        items.push(item);
        return { ...item };
      },
      async findFirst({ where }) {
        const item = items.find((entry) => matches(entry, where));
        return item ? { ...item } : null;
      },
      async delete({ where }) {
        const index = items.findIndex((item) => item.id === where.id);
        const [removed] = items.splice(index, 1);
        return removed;
      },
      async deleteMany({ where }) {
        const before = items.length;
        items = items.filter((item) => !matches(item, where));
        return { count: before - items.length };
      },
    },
    snapshot() {
      return items.map((item) => ({ ...item }));
    },
  };
}

test("knowledge service respects zero limits instead of falling back to 50", async () => {
  const client = createKnowledgeClient(0);
  assert.equal(getKnowledgeLimit({ maxLearnedItems: 0 }), 0);

  const result = await addKnowledgeQna(
    "guild-1",
    "How do I pay?",
    "Use the payment channel.",
    { client }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "knowledge_disabled");
  assert.equal(client.snapshot().length, 0);
});

test("knowledge dashboard service detects duplicate Q&A and supports paging/delete/clear", async () => {
  const client = createKnowledgeClient(5);
  const first = await addKnowledgeQna("guild-1", "How do I buy?", "Use shop.", { client });
  assert.equal(first.ok, true);

  const duplicate = await addKnowledgeQna("guild-1", "  HOW   do I buy? ", "Another answer", { client });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "duplicate_question");

  await addKnowledgeFreeform("guild-1", "Refunds", "Refunds take three days.", { client });
  await addKnowledgeFreeform("guild-1", "Rules", "Follow the server rules.", { client });

  const page = await listKnowledgeItems("guild-1", { client, page: 0, pageSize: 2 });
  assert.equal(page.total, 3);
  assert.equal(page.totalPages, 2);
  assert.equal(page.items.length, 2);

  const deleted = await deleteKnowledgeItem("guild-1", first.item.id, { client });
  assert.equal(deleted.ok, true);
  assert.equal(client.snapshot().length, 2);

  const cleared = await clearKnowledge("guild-1", { client });
  assert.equal(cleared.deleted, 2);
  assert.equal(client.snapshot().length, 0);
});

function createExcludedClient() {
  const ignored = new Map();
  let ticketDeletes = 0;
  return {
    guildIgnoredChannel: {
      async findUnique({ where }) {
        return ignored.get(where.guildId_channelId.channelId) || null;
      },
      async create({ data }) {
        const entry = { id: `ignored-${ignored.size + 1}`, createdAt: new Date(), ...data };
        ignored.set(data.channelId, entry);
        return { ...entry };
      },
      async deleteMany({ where }) {
        const existed = ignored.delete(where.channelId);
        return { count: existed ? 1 : 0 };
      },
    },
    ticketChannel: {
      async deleteMany() {
        ticketDeletes += 1;
        return { count: 1 };
      },
    },
    async $transaction(callback) {
      return callback(this);
    },
    snapshot() {
      return { ignored: [...ignored.values()], ticketDeletes };
    },
  };
}

test("excluded tickets validate against any configured category and reactivate on removal", async () => {
  const client = createExcludedClient();
  const guild = {
    id: "guild-1",
    channels: {
      cache: new Map(),
      async fetch(id) {
        return this.cache.get(id) || null;
      },
    },
  };
  const channel = {
    id: "ticket-2",
    type: ChannelType.GuildText,
    parentId: "category-b",
    guild,
  };
  guild.channels.cache.set(channel.id, channel);
  const sources = [
    { guildId: guild.id, type: "category", sourceId: "category-a", enabled: true },
    { guildId: guild.id, type: "category", sourceId: "category-b", enabled: true },
  ];

  const validation = await validateExcludedTicketTarget(guild, channel.id, {
    client,
    channel,
    sources,
  });
  assert.equal(validation.ok, true);
  assert.equal(validation.source.sourceId, "category-b");

  const excluded = await excludeTicket(guild, channel.id, "private test reason", {
    client,
    channel,
    sources,
  });
  assert.equal(excluded.ok, true);
  assert.equal(client.snapshot().ignored.length, 1);
  assert.equal(client.snapshot().ticketDeletes, 1);

  let reconcileCalls = 0;
  const restored = await restoreExcludedTicket(guild, channel.id, {
    client,
    reconcile: async () => {
      reconcileCalls += 1;
      return { tracked: true, code: "tracked" };
    },
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.reactivated, true);
  assert.equal(reconcileCalls, 1);
  assert.equal(client.snapshot().ignored.length, 0);
});

test("new settings dashboard exposes only secondary settings sections", () => {
  assert.deepEqual(
    Object.values(PAGES).sort(),
    ["behavior", "excluded", "home", "knowledge", "safety"].sort()
  );
  assert.equal(Object.values(PAGES).includes("aiapi"), false);
  assert.equal(Object.values(PAGES).includes("escalation"), false);
});