const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SETUP_STEPS,
} = require("../src/config/productDefaults");
const {
  reconcileSetupState,
} = require("../src/config/setupState");
const {
  completeOnboarding,
  setTicketCategories,
  skipHumanSupportAndComplete,
  upsertSupportRoute,
} = require("../src/setup/setupService");

const GUILD_ID = "123456789012345678";
const CATEGORY_A = "200000000000000001";
const CATEGORY_B = "200000000000000002";

function createTicketSourceClient() {
  let config = {
    guildId: GUILD_ID,
    enabled: true,
    ticketCategoryId: null,
    maxLearnedItems: 50,
    maxAdminRoutes: 10,
  };
  const sources = new Map();

  const client = {
    guildConfig: {
      async findUnique() {
        return { ...config };
      },
      async update({ data }) {
        config = { ...config, ...data };
        return { ...config };
      },
    },
    ticketSource: {
      async deleteMany({ where }) {
        let count = 0;
        for (const [key, source] of [...sources.entries()]) {
          if (source.guildId !== where.guildId || source.type !== where.type) continue;
          if (where.sourceId?.notIn && where.sourceId.notIn.includes(source.sourceId)) continue;
          sources.delete(key);
          count += 1;
        }
        return { count };
      },
      async upsert({ where, create, update }) {
        const key = `${where.guildId_type_sourceId.guildId}:${where.guildId_type_sourceId.type}:${where.guildId_type_sourceId.sourceId}`;
        const current = sources.get(key);
        const next = current ? { ...current, ...update } : { id: `source-${sources.size + 1}`, ...create };
        sources.set(key, next);
        return { ...next };
      },
      async findMany() {
        return [...sources.values()].map((source) => ({ ...source }));
      },
    },
    async $transaction(callback) {
      return callback(this);
    },
    snapshot() {
      return {
        config: { ...config },
        sources: [...sources.values()].map((source) => ({ ...source })),
      };
    },
  };

  return client;
}

test("multi-category onboarding stores all ticket sources without starting billing", async () => {
  const client = createTicketSourceClient();

  await setTicketCategories(GUILD_ID, [CATEGORY_A, CATEGORY_B], { client });

  const snapshot = client.snapshot();
  assert.equal(snapshot.config.ticketCategoryId, CATEGORY_A);
  assert.equal(snapshot.sources.length, 2);
  assert.deepEqual(
    snapshot.sources.map((source) => source.sourceId).sort(),
    [CATEGORY_A, CATEGORY_B].sort()
  );
  assert.equal("guildBilling" in client, false);
});

test("onboarding completion initializes billing only at the final step", async () => {
  const calls = [];
  const completedAt = new Date("2026-08-19T14:00:00.000Z");
  const client = {
    guildSetupState: {
      async upsert(args) {
        calls.push(["setup", args]);
        return { id: "setup-1", ...args.create };
      },
    },
  };

  const result = await completeOnboarding(GUILD_ID, {
    client,
    now: completedAt,
    actorUserId: "admin-user",
    async startTrial(guildId, options) {
      calls.push(["trial", guildId, options.actorUserId]);
      return { guildId, trialStartedAt: completedAt };
    },
  });

  assert.equal(calls[0][0], "trial");
  assert.equal(calls[0][1], GUILD_ID);
  assert.equal(calls[0][2], "admin-user");
  assert.equal(calls[1][0], "setup");
  assert.equal(result.state.lastStep, SETUP_STEPS.COMPLETE);
  assert.equal(result.state.completedAt.getTime(), completedAt.getTime());
});

test("skipping optional human support disables escalation and still completes setup", async () => {
  let setting = null;
  const client = {
    guildSetting: {
      async upsert({ create, update }) {
        setting = setting ? { ...setting, ...update } : { ...create };
        return { ...setting };
      },
    },
    guildSetupState: {
      async upsert(args) {
        return { id: "setup-1", ...args.create };
      },
    },
  };

  const result = await skipHumanSupportAndComplete(GUILD_ID, {
    client,
    async startTrial(guildId) {
      return { guildId };
    },
  });

  assert.equal(setting.escalationEnabled, false);
  assert.equal(result.state.lastStep, SETUP_STEPS.COMPLETE);
});

test("saving a support route enables escalation and respects the route limit", async () => {
  let route = null;
  let setting = null;
  const client = {
    guildConfig: {
      async findUnique() {
        return {
          guildId: GUILD_ID,
          enabled: true,
          maxLearnedItems: 50,
          maxAdminRoutes: 1,
        };
      },
    },
    adminRoute: {
      async findUnique() {
        return route ? { ...route } : null;
      },
      async count() {
        return route ? 1 : 0;
      },
      async upsert({ create, update }) {
        route = route ? { ...route, ...update } : { id: "route-1", ...create };
        return { ...route };
      },
    },
    guildSetting: {
      async upsert({ create, update }) {
        setting = setting ? { ...setting, ...update } : { ...create };
        return { ...setting };
      },
    },
  };

  const saved = await upsertSupportRoute(GUILD_ID, "role-1", "Handles billing issues", { client });
  assert.equal(saved.totalRoutes, 1);
  assert.equal(setting.escalationEnabled, true);

  client.adminRoute.findUnique = async () => null;
  await assert.rejects(
    () => upsertSupportRoute(GUILD_ID, "role-2", "Handles technical issues", { client }),
    (error) => error?.code === "support_route_limit_reached"
  );
});

test("completed migrated setups stay completed instead of being forced through onboarding again", async () => {
  const completedAt = new Date("2026-08-18T10:00:00.000Z");
  let extraReads = 0;
  const existing = {
    id: "setup-old",
    guildId: GUILD_ID,
    setupVersion: 2,
    lastStep: SETUP_STEPS.COMPLETE,
    completedAt,
  };
  const client = {
    guildSetupState: {
      async findUnique() {
        return { ...existing };
      },
    },
    ticketSource: {
      async count() {
        extraReads += 1;
        return 0;
      },
    },
  };

  const state = await reconcileSetupState(GUILD_ID, { client });
  assert.equal(state.completedAt.getTime(), completedAt.getTime());
  assert.equal(state.lastStep, SETUP_STEPS.COMPLETE);
  assert.equal(extraReads, 0);
});

test("reopening setup keeps the AI step until the admin explicitly presses Next", async () => {
  let savedState = {
    id: "setup-progress",
    guildId: GUILD_ID,
    setupVersion: 2,
    lastStep: SETUP_STEPS.AI_PROVIDER,
    completedAt: null,
  };
  const client = {
    guildSetupState: {
      async findUnique() {
        return { ...savedState };
      },
      async upsert({ create, update }) {
        savedState = savedState ? { ...savedState, ...update } : { id: "setup-progress", ...create };
        return { ...savedState };
      },
    },
    ticketSource: {
      async count() {
        return 2;
      },
    },
    guildConfig: {
      async findUnique() {
        return { ticketCategoryId: CATEGORY_A };
      },
    },
    guildAiConfig: {
      async findUnique() {
        return { provider: "groq", credentialEncrypted: "encrypted-key" };
      },
    },
    guildSetting: {
      async findUnique() {
        return { groqApiKeyEncrypted: "encrypted-key" };
      },
    },
  };

  const state = await reconcileSetupState(GUILD_ID, { client });
  assert.equal(state.lastStep, SETUP_STEPS.AI_PROVIDER);
  assert.equal(state.completedAt, null);
});
