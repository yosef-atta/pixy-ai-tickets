const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProviderRegistry,
  getAiProvider,
  listAiProviders,
} = require("../src/ai/providers/providerRegistry");
const { generateAiReply } = require("../src/ai/aiClient");
const {
  resolveGuildAiConfig,
  saveGuildAiCredential,
  saveGuildAiModel,
} = require("../src/config/guildAiConfig");
const { isEncryptedCredential } = require("../src/security/credentialEncryption");

const GUILD_ID = "123456789012345678";
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

test("the production provider registry exposes Groq through a generic contract", () => {
  const providers = listAiProviders();
  assert.ok(providers.some((provider) => provider.id === "groq"));

  const groq = getAiProvider("GROQ");
  assert.equal(groq.id, "groq");
  assert.equal(groq.displayName, "Groq");
  assert.equal(groq.requiresCredential, true);
  assert.equal(groq.credentialType, "groq-api-key");
  assert.ok(groq.defaultModel);
  assert.equal(typeof groq.generateReply, "function");
  assert.equal(typeof groq.validateCredential, "function");
  assert.equal(typeof groq.validateModel, "function");
});

test("provider registries reject duplicates and unsupported providers cleanly", () => {
  const fake = {
    id: "fake",
    displayName: "Fake AI",
    defaultModel: "fake-default",
    credentialType: "fake-api-key",
    async generateReply() {
      return { text: "ok" };
    },
  };

  const registry = createProviderRegistry([fake]);
  assert.equal(registry.get("FAKE").id, "fake");
  assert.throws(() => registry.register(fake), /already registered/i);
  assert.throws(
    () => registry.get("missing"),
    (error) => error?.code === "unsupported_ai_provider"
  );
});

test("aiClient dispatches through provider metadata instead of provider-specific branches", async () => {
  const calls = [];
  const fakeProvider = {
    id: "fake",
    displayName: "Fake AI",
    defaultModel: "fake-default",
    requiresCredential: true,
    async generateReply(args) {
      calls.push(args);
      return {
        text: "provider reply",
        model: args.model,
        usage: { total_tokens: 3 },
      };
    },
  };

  const result = await generateAiReply({
    messages: [{ role: "user", content: "hello" }],
    provider: "fake",
    credential: "secret",
    providerResolver(providerId) {
      assert.equal(providerId, "fake");
      return fakeProvider;
    },
  });

  assert.equal(result.text, "provider reply");
  assert.equal(result.provider, "fake");
  assert.equal(result.model, "fake-default");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].credential, "secret");
  assert.equal(calls[0].model, "fake-default");
  assert.equal(typeof calls[0].generation.temperature, "number");
  assert.equal(typeof calls[0].generation.maxOutputTokens, "number");
});

function createAiConfigClient() {
  let aiRecord = {
    id: "ai-1",
    guildId: GUILD_ID,
    provider: "groq",
    model: null,
    credentialEncrypted: null,
    credentialType: "groq-api-key",
    systemPrompt: null,
  };
  let guildConfig = {
    guildId: GUILD_ID,
    aiProvider: "groq",
    aiModel: null,
    aiSystemPrompt: null,
  };
  let guildSetting = {
    guildId: GUILD_ID,
    groqApiKeyEncrypted: null,
    aiModel: null,
  };

  const client = {
    guildAiConfig: {
      async findUnique() {
        return { ...aiRecord };
      },
      async findUniqueOrThrow() {
        return { ...aiRecord };
      },
      async create({ data }) {
        aiRecord = { id: "ai-1", ...data };
        return { ...aiRecord };
      },
      async update({ data }) {
        aiRecord = { ...aiRecord, ...data };
        return { ...aiRecord };
      },
    },
    guildConfig: {
      async findUnique() {
        return { ...guildConfig };
      },
      async updateMany({ data }) {
        guildConfig = { ...guildConfig, ...data };
        return { count: 1 };
      },
    },
    guildSetting: {
      async findUnique() {
        return { ...guildSetting };
      },
      async upsert({ create, update }) {
        guildSetting = guildSetting ? { ...guildSetting, ...update } : { ...create };
        return { ...guildSetting };
      },
    },
    async $transaction(callback) {
      return callback(this);
    },
    snapshot() {
      return {
        aiRecord: { ...aiRecord },
        guildConfig: { ...guildConfig },
        guildSetting: { ...guildSetting },
      };
    },
  };

  return client;
}

test("generic credential storage encrypts provider credentials and keeps legacy Groq fields synchronized", async () => {
  const previousKey = process.env.PIXY_CREDENTIAL_ENCRYPTION_KEY;
  process.env.PIXY_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY;

  try {
    const client = createAiConfigClient();
    const saved = await saveGuildAiCredential(GUILD_ID, "gsk_test_secret", {
      client,
      provider: "groq",
      model: "model-one",
    });

    const snapshot = client.snapshot();
    assert.equal(saved.provider, "groq");
    assert.equal(saved.model, "model-one");
    assert.equal(saved.credential, "gsk_test_secret");
    assert.equal(saved.credentialStatus, "configured");
    assert.equal(isEncryptedCredential(snapshot.aiRecord.credentialEncrypted), true);
    assert.equal(snapshot.aiRecord.credentialEncrypted, snapshot.guildSetting.groqApiKeyEncrypted);
    assert.equal(snapshot.guildConfig.aiProvider, "groq");
    assert.equal(snapshot.guildConfig.aiModel, "model-one");

    await saveGuildAiModel(GUILD_ID, "model-two", { client });
    const updated = await resolveGuildAiConfig(GUILD_ID, { client, requireCredential: true });
    assert.equal(updated.model, "model-two");
    assert.equal(client.snapshot().guildSetting.aiModel, "model-two");
    assert.equal(client.snapshot().guildConfig.aiModel, "model-two");
  } finally {
    if (previousKey === undefined) delete process.env.PIXY_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.PIXY_CREDENTIAL_ENCRYPTION_KEY = previousKey;
  }
});
