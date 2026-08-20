const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PROVIDER_VALIDATION_MAX_OUTPUT_TOKENS,
  PROVIDER_VALIDATION_PROMPT,
  PROVIDER_VALIDATION_RETRY_OUTPUT_TOKENS,
  validateProviderCredential,
  validateProviderModel,
} = require("../src/ai/providers/providerRegistry");
const {
  GROQ_GPT_OSS_MODEL_PATTERN,
  buildGroqCompletionRequest,
} = require("../src/ai/providers/groqProvider");
const {
  SETUP_VALIDATION_CHANNEL_ID,
  SETUP_VALIDATION_FAILED,
  SETUP_VALIDATION_SUCCESS,
  buildProviderHealthIssue,
  getLatestProviderHealthEvent,
  recordProviderSetupValidation,
} = require("../src/ai/providerValidationHealth");

function createFakeProvider(overrides = {}) {
  return {
    id: "future",
    displayName: "Future AI",
    defaultModel: "future-default",
    requiresCredential: true,
    credentialType: "future-api-key",
    async validateCredential() {
      return { valid: true, modelIds: ["future-default", "future-custom"] };
    },
    async validateModel({ modelId }) {
      return { id: modelId, compatible: true };
    },
    async generateReply({ model }) {
      return {
        text: "Hello from Future AI",
        model,
        provider: "future",
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      };
    },
    ...overrides,
  };
}

test("credential validation requires a real live generation probe", async () => {
  const calls = [];
  const provider = createFakeProvider({
    async generateReply(args) {
      calls.push(args);
      return {
        text: "Hello back",
        provider: "future",
        model: args.model,
        usage: { total_tokens: 4 },
      };
    },
  });

  const result = await validateProviderCredential("future", "secret", {
    providerResolver() {
      return provider;
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.liveGeneration, true);
  assert.equal(result.probe.text, "Hello back");
  assert.equal(result.probe.retried, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].credential, "secret");
  assert.equal(calls[0].model, "future-default");
  assert.equal(calls[0].validationProbe, true);
  assert.deepEqual(calls[0].messages, [
    { role: "user", content: PROVIDER_VALIDATION_PROMPT },
  ]);
  assert.equal(
    calls[0].generation.maxOutputTokens,
    PROVIDER_VALIDATION_MAX_OUTPUT_TOKENS
  );
  assert.equal(calls[0].generation.temperature, 0);
});

test("an empty successful probe retries once with a larger completion budget", async () => {
  const calls = [];
  const provider = createFakeProvider({
    async generateReply(args) {
      calls.push(args);
      if (calls.length === 1) {
        return { text: "", provider: "future", model: args.model };
      }
      return { text: "Hello after reasoning", provider: "future", model: args.model };
    },
  });

  const result = await validateProviderCredential("future", "secret", {
    providerResolver() {
      return provider;
    },
  });

  assert.equal(result.probe.text, "Hello after reasoning");
  assert.equal(result.probe.retried, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].generation.maxOutputTokens, PROVIDER_VALIDATION_MAX_OUTPUT_TOKENS);
  assert.equal(calls[1].generation.maxOutputTokens, PROVIDER_VALIDATION_RETRY_OUTPUT_TOKENS);
  assert.equal(calls[0].validationProbe, true);
  assert.equal(calls[1].validationProbe, true);
});

test("Groq GPT-OSS minimizes reasoning only for setup live validation", () => {
  assert.equal(GROQ_GPT_OSS_MODEL_PATTERN.test("openai/gpt-oss-120b"), true);

  const validationRequest = buildGroqCompletionRequest({
    selectedModel: "openai/gpt-oss-120b",
    messages: [{ role: "user", content: "Hello" }],
    temperature: 0,
    maxOutputTokens: PROVIDER_VALIDATION_MAX_OUTPUT_TOKENS,
    validationProbe: true,
  });

  assert.equal(validationRequest.reasoning_effort, "low");
  assert.equal(validationRequest.include_reasoning, false);

  const runtimeRequest = buildGroqCompletionRequest({
    selectedModel: "openai/gpt-oss-120b",
    messages: [{ role: "user", content: "Hello" }],
    temperature: 0.3,
    maxOutputTokens: 500,
    validationProbe: false,
  });

  assert.equal(Object.prototype.hasOwnProperty.call(runtimeRequest, "reasoning_effort"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(runtimeRequest, "include_reasoning"), false);
});

test("a key that passes metadata validation still fails setup when live generation is denied", async () => {
  const provider = createFakeProvider({
    async validateCredential() {
      return { valid: true, modelIds: ["future-default"] };
    },
    async generateReply() {
      const error = new Error(
        "Your project has been denied access. Please contact support."
      );
      error.status = 403;
      error.code = "provider_http_error";
      throw error;
    },
  });

  await assert.rejects(
    () => validateProviderCredential("future", "secret", {
      providerResolver() {
        return provider;
      },
    }),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, "provider_http_error");
      assert.match(error.message, /project has been denied access/i);
      return true;
    }
  );
});

test("future providers without a custom credential validator are still live-tested", async () => {
  let probes = 0;
  const provider = createFakeProvider({
    validateCredential: undefined,
    async generateReply(args) {
      probes += 1;
      return {
        text: "working",
        provider: "future",
        model: args.model,
      };
    },
  });

  const result = await validateProviderCredential("future", "secret", {
    providerResolver() {
      return provider;
    },
  });

  assert.equal(result.liveGeneration, true);
  assert.equal(probes, 1);
});

test("model validation live-tests the exact selected model before saving", async () => {
  const calls = [];
  const provider = createFakeProvider({
    async generateReply(args) {
      calls.push(args);
      return {
        text: "custom model works",
        provider: "future",
        model: args.model,
      };
    },
  });

  const result = await validateProviderModel("future", {
    credential: "secret",
    modelId: "future-custom",
    providerResolver() {
      return provider;
    },
  });

  assert.equal(result.compatible, true);
  assert.equal(result.liveGeneration, true);
  assert.equal(result.id, "future-custom");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "future-custom");
});

test("setup validation state stores only health metadata and surfaces provider errors", async () => {
  const rows = [];
  const client = {
    aiUsageLog: {
      async create({ data }) {
        const row = { id: `log-${rows.length + 1}`, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
      async findFirst({ where }) {
        return [...rows]
          .reverse()
          .find((row) => row.guildId === where.guildId && row.provider === where.provider) || null;
      },
    },
  };

  await recordProviderSetupValidation({
    guildId: "guild-1",
    userId: "user-1",
    provider: "google",
    model: "gemini-test",
    ok: false,
    error: new Error("Your project has been denied access. Please contact support."),
  }, { client });

  assert.equal(rows[0].channelId, SETUP_VALIDATION_CHANNEL_ID);
  assert.equal(rows[0].status, SETUP_VALIDATION_FAILED);
  assert.equal(rows[0].provider, "google");
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], "credential"), false);

  const failed = await getLatestProviderHealthEvent("guild-1", "google", { client });
  assert.match(
    buildProviderHealthIssue(failed, { displayName: "Google Gemini" }),
    /project has been denied access/i
  );

  await recordProviderSetupValidation({
    guildId: "guild-1",
    userId: "user-1",
    provider: "google",
    model: "gemini-test",
    ok: true,
    probe: {
      model: "gemini-test",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  }, { client });

  assert.equal(rows[1].status, SETUP_VALIDATION_SUCCESS);
  const recovered = await getLatestProviderHealthEvent("guild-1", "google", { client });
  assert.equal(buildProviderHealthIssue(recovered, { displayName: "Google Gemini" }), null);
});
