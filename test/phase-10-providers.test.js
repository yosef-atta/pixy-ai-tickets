const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getAiProvider,
  listAiProviders,
} = require("../src/ai/providers/providerRegistry");
const {
  DEFAULT_GOOGLE_MODEL,
  buildGoogleRequest,
  generateGoogleReply,
  validateGoogleApiKey,
  validateGoogleChatModel,
} = require("../src/ai/providers/googleProvider");
const {
  DEFAULT_MISTRAL_MODEL,
  generateMistralReply,
  validateMistralApiKey,
  validateMistralChatModel,
} = require("../src/ai/providers/mistralProvider");

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("production registry exposes Groq, Google Gemini, and Mistral", () => {
  assert.deepEqual(
    listAiProviders().map((provider) => provider.id),
    ["groq", "google", "mistral"]
  );

  const google = getAiProvider("GOOGLE");
  assert.equal(google.displayName, "Google Gemini");
  assert.equal(google.defaultModel, DEFAULT_GOOGLE_MODEL);
  assert.equal(google.credentialType, "google-gemini-api-key");

  const mistral = getAiProvider("MISTRAL");
  assert.equal(mistral.displayName, "Mistral");
  assert.equal(mistral.defaultModel, DEFAULT_MISTRAL_MODEL);
  assert.equal(mistral.credentialType, "mistral-api-key");
});

test("Google request maps system and assistant messages to Gemini content roles", () => {
  const request = buildGoogleRequest(
    [
      { role: "system", content: "Follow server policy." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Help me" },
    ],
    { temperature: 0.2, maxOutputTokens: 321 }
  );

  assert.equal(request.systemInstruction.parts[0].text, "Follow server policy.");
  assert.deepEqual(
    request.contents.map((entry) => entry.role),
    ["user", "model", "user"]
  );
  assert.equal(request.generationConfig.temperature, 0.2);
  assert.equal(request.generationConfig.maxOutputTokens, 321);
});

test("Google credential/model validation uses the models endpoint and generateContent metadata", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({
      models: [
        {
          name: "models/gemini-3.6-flash",
          displayName: "Gemini 3.6 Flash",
          supportedGenerationMethods: ["generateContent", "countTokens"],
        },
        {
          name: "models/embedding-only",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
    });
  };

  const validation = await validateGoogleApiKey("google-secret", { fetchImpl });
  assert.deepEqual(validation.modelIds, ["gemini-3.6-flash"]);
  assert.equal(calls[0].options.headers["x-goog-api-key"], "google-secret");
  assert.match(calls[0].url, /\/v1beta\/models\?/);
  assert.equal(calls[0].url.includes("google-secret"), false);

  const model = await validateGoogleChatModel({
    apiKey: "google-secret",
    modelId: "models/gemini-3.6-flash",
    fetchImpl,
  });
  assert.equal(model.id, "gemini-3.6-flash");
  assert.equal(model.compatible, true);
});

test("Google generation returns normalized text, model, and token usage", async () => {
  let captured = null;
  const fetchImpl = async (url, options = {}) => {
    captured = { url: String(url), options };
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: "Hello from Gemini" }] } }],
      usageMetadata: {
        promptTokenCount: 7,
        candidatesTokenCount: 4,
        totalTokenCount: 11,
      },
      modelVersion: "gemini-3.6-flash",
    });
  };

  const result = await generateGoogleReply({
    messages: [{ role: "user", content: "Hello" }],
    credential: "google-secret",
    fetchImpl,
  });

  assert.equal(result.provider, "google");
  assert.equal(result.model, "gemini-3.6-flash");
  assert.equal(result.text, "Hello from Gemini");
  assert.deepEqual(result.usage, {
    prompt_tokens: 7,
    completion_tokens: 4,
    total_tokens: 11,
  });
  assert.match(captured.url, /gemini-3\.6-flash:generateContent$/);
  assert.equal(captured.options.headers["x-goog-api-key"], "google-secret");
  assert.equal(JSON.parse(captured.options.body).contents[0].role, "user");
});

test("Mistral credential/model validation filters non-chat models", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({
      data: [
        {
          id: "mistral-small-latest",
          capabilities: { completion_chat: true },
        },
        {
          id: "mistral-embed",
          capabilities: { completion_chat: false },
        },
      ],
    });
  };

  const validation = await validateMistralApiKey("mistral-secret", { fetchImpl });
  assert.deepEqual(validation.modelIds, ["mistral-small-latest"]);
  assert.equal(calls[0].options.headers.Authorization, "Bearer mistral-secret");
  assert.match(calls[0].url, /\/v1\/models$/);

  const model = await validateMistralChatModel({
    apiKey: "mistral-secret",
    modelId: "mistral-small-latest",
    fetchImpl,
  });
  assert.equal(model.id, "mistral-small-latest");
  assert.equal(model.compatible, true);
});

test("Mistral generation returns normalized text, model, and token usage", async () => {
  let captured = null;
  const fetchImpl = async (url, options = {}) => {
    captured = { url: String(url), options };
    return jsonResponse({
      choices: [{ message: { content: "Hello from Mistral" } }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 3,
        total_tokens: 11,
      },
      model: "mistral-small-latest",
    });
  };

  const result = await generateMistralReply({
    messages: [{ role: "user", content: "Hello" }],
    credential: "mistral-secret",
    fetchImpl,
  });

  assert.equal(result.provider, "mistral");
  assert.equal(result.model, "mistral-small-latest");
  assert.equal(result.text, "Hello from Mistral");
  assert.deepEqual(result.usage, {
    prompt_tokens: 8,
    completion_tokens: 3,
    total_tokens: 11,
  });
  assert.match(captured.url, /\/v1\/chat\/completions$/);
  assert.equal(captured.options.headers.Authorization, "Bearer mistral-secret");
  const body = JSON.parse(captured.options.body);
  assert.equal(body.model, "mistral-small-latest");
  assert.equal(body.messages[0].role, "user");
});

test("HTTP provider failures preserve status codes used by Pixy rate-limit handling", async () => {
  await assert.rejects(
    () => generateMistralReply({
      messages: [{ role: "user", content: "Hello" }],
      credential: "bad-key",
      fetchImpl: async () => jsonResponse({ message: "Rate limited" }, 429),
    }),
    (error) => error?.status === 429 && error?.provider === "mistral"
  );

  await assert.rejects(
    () => generateGoogleReply({
      messages: [{ role: "user", content: "Hello" }],
      credential: "bad-key",
      fetchImpl: async () => jsonResponse({ error: { message: "Invalid API key" } }, 401),
    }),
    (error) => error?.status === 401 && error?.provider === "google"
  );
});
