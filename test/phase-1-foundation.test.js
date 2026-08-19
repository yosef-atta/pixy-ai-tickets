const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CURRENT_SETUP_VERSION,
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_MAX_ADMIN_ROUTES,
  DEFAULT_MAX_LEARNED_ITEMS,
  SETUP_STEPS,
  TICKET_SOURCE_TYPES,
} = require("../src/config/productDefaults");
const {
  ensureLegacyTicketCategorySource,
  normalizeSourceType,
} = require("../src/config/ticketSources");
const {
  getOrCreateGuildAiConfig,
  getProviderCredentialType,
} = require("../src/config/guildAiConfig");
const {
  inferSetupProgress,
  markSetupComplete,
} = require("../src/config/setupState");
const {
  buildGuildConfigCreateData,
} = require("../src/config/guildConfigFoundation");

const GUILD_ID = "123456789012345678";

test("phase 1 defaults use safe overlay behavior and one shared set of limits", () => {
  assert.equal(CURRENT_SETUP_VERSION, 2);
  assert.equal(DEFAULT_MAX_LEARNED_ITEMS, 50);
  assert.equal(DEFAULT_MAX_ADMIN_ROUTES, 10);
  assert.equal(DEFAULT_GUILD_SETTINGS.aiReplyEnabled, true);
  assert.equal(DEFAULT_GUILD_SETTINGS.closeTicketEnabled, false);
  assert.equal(DEFAULT_GUILD_SETTINGS.renameReviewEnabled, false);
  assert.equal(DEFAULT_GUILD_SETTINGS.escalationEnabled, true);
  assert.equal(DEFAULT_GUILD_SETTINGS.agentActionsEnabled, true);

  assert.deepEqual(buildGuildConfigCreateData(GUILD_ID), {
    guildId: GUILD_ID,
    enabled: true,
    maxLearnedItems: 50,
    maxAdminRoutes: 10,
  });
});

test("ticket source foundation backfills the legacy category without restricting future source types", async () => {
  let upsertArgs = null;
  const client = {
    guildConfig: {
      async findUnique() {
        return { ticketCategoryId: "987654321098765432" };
      },
    },
    ticketSource: {
      async upsert(args) {
        upsertArgs = args;
        return { id: "source-1", ...args.create };
      },
    },
  };

  const result = await ensureLegacyTicketCategorySource(GUILD_ID, { client });
  assert.equal(result.type, TICKET_SOURCE_TYPES.CATEGORY);
  assert.equal(result.sourceId, "987654321098765432");
  assert.equal(result.enabled, true);
  assert.deepEqual(upsertArgs.where.guildId_type_sourceId, {
    guildId: GUILD_ID,
    type: TICKET_SOURCE_TYPES.CATEGORY,
    sourceId: "987654321098765432",
  });
  assert.equal(normalizeSourceType("THREAD_PARENT"), TICKET_SOURCE_TYPES.THREAD_PARENT);
});

test("guild AI foundation preserves the existing Groq key and prefers the guild setting model", async () => {
  let created = null;
  const client = {
    guildAiConfig: {
      async findUnique() {
        return null;
      },
      async create({ data }) {
        created = data;
        return { id: "ai-1", ...data };
      },
    },
    guildConfig: {
      async findUnique() {
        return {
          aiProvider: "groq",
          aiModel: "legacy-config-model",
          aiSystemPrompt: "server prompt",
        };
      },
    },
    guildSetting: {
      async findUnique() {
        return {
          groqApiKeyEncrypted: "encrypted-key",
          aiModel: "legacy-setting-model",
        };
      },
    },
  };

  const result = await getOrCreateGuildAiConfig(GUILD_ID, { client });
  assert.equal(result.provider, "groq");
  assert.equal(result.model, "legacy-setting-model");
  assert.equal(result.credentialEncrypted, "encrypted-key");
  assert.equal(result.credentialType, "groq-api-key");
  assert.equal(result.systemPrompt, "server prompt");
  assert.deepEqual(created, {
    guildId: GUILD_ID,
    provider: "groq",
    model: "legacy-setting-model",
    credentialEncrypted: "encrypted-key",
    credentialType: "groq-api-key",
    systemPrompt: "server prompt",
  });
  assert.equal(getProviderCredentialType("future-provider"), "future-provider-api-key");
});

test("setup progress can resume legacy setup and treats human support as optional", async () => {
  const completeClient = {
    ticketSource: { async count() { return 1; } },
    guildConfig: { async findUnique() { return { ticketCategoryId: null }; } },
    guildAiConfig: { async findUnique() { return { credentialEncrypted: "key" }; } },
    guildSetting: { async findUnique() { return null; } },
  };

  assert.deepEqual(await inferSetupProgress(GUILD_ID, { client: completeClient }), {
    lastStep: SETUP_STEPS.COMPLETE,
    completed: true,
  });

  const missingAiClient = {
    ticketSource: { async count() { return 0; } },
    guildConfig: { async findUnique() { return { ticketCategoryId: "legacy-category" }; } },
    guildAiConfig: { async findUnique() { return null; } },
    guildSetting: { async findUnique() { return { groqApiKeyEncrypted: null }; } },
  };

  assert.deepEqual(await inferSetupProgress(GUILD_ID, { client: missingAiClient }), {
    lastStep: SETUP_STEPS.AI_PROVIDER,
    completed: false,
  });
});

test("marking setup complete records the current onboarding version", async () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  let args = null;
  const client = {
    guildSetupState: {
      async upsert(value) {
        args = value;
        return { id: "setup-1", ...value.create };
      },
    },
  };

  const result = await markSetupComplete(GUILD_ID, { client, now });
  assert.equal(result.setupVersion, CURRENT_SETUP_VERSION);
  assert.equal(result.lastStep, SETUP_STEPS.COMPLETE);
  assert.equal(result.completedAt.getTime(), now.getTime());
  assert.equal(args.where.guildId, GUILD_ID);
});
