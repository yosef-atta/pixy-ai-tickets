const GroqSDK = require("groq-sdk");
const {
  DEFAULT_GROQ_MODEL,
  getBlockedModelReason,
  listGroqModels,
  validateGroqApiKey,
  validateGroqChatModel,
} = require("../groqModels");
const { stripThinkBlocks } = require("../sanitizeModelOutput");

const Groq = GroqSDK.default || GroqSDK;
const GROQ_PROVIDER_ID = "groq";
const GROQ_CREDENTIAL_TYPE = "groq-api-key";
const GROQ_GPT_OSS_MODEL_PATTERN = /^openai\/gpt-oss-(?:20b|120b)$/i;

function createMissingCredentialError() {
  const error = new Error(
    "This server must configure a Groq API key in /pixy-setup."
  );
  error.code = "missing_guild_groq_api_key";
  error.provider = GROQ_PROVIDER_ID;
  return error;
}

function buildGroqCompletionRequest({
  selectedModel,
  messages,
  temperature,
  maxOutputTokens,
  validationProbe,
}) {
  const request = {
    model: selectedModel,
    messages,
    temperature,
    max_completion_tokens: maxOutputTokens,
  };

  // GPT-OSS is a reasoning model. A tiny validation completion can otherwise
  // spend its whole token budget on reasoning and leave message.content empty,
  // which is a false negative for an otherwise healthy Groq credential.
  // Keep normal runtime behavior untouched and only minimize reasoning for the
  // setup live probe.
  if (validationProbe && GROQ_GPT_OSS_MODEL_PATTERN.test(selectedModel)) {
    request.reasoning_effort = "low";
    request.include_reasoning = false;
  }

  return request;
}

async function generateGroqReply({
  messages,
  model,
  credential,
  apiKey,
  generation = {},
  validationProbe = false,
} = {}) {
  const key = String(credential || apiKey || "").trim();
  if (!key) throw createMissingCredentialError();

  // Construct per request so plaintext guild credentials are not retained in
  // an unbounded process-wide cache.
  const groq = new Groq({ apiKey: key });
  const selectedModel = String(model || DEFAULT_GROQ_MODEL).trim();
  const temperature = Number.isFinite(Number(generation.temperature))
    ? Number(generation.temperature)
    : 0.3;
  const maxOutputTokens = Number.isFinite(Number(generation.maxOutputTokens))
    ? Math.max(1, Number(generation.maxOutputTokens))
    : 500;

  const response = await groq.chat.completions.create(
    buildGroqCompletionRequest({
      selectedModel,
      messages,
      temperature,
      maxOutputTokens,
      validationProbe,
    })
  );

  const rawContent = response.choices?.[0]?.message?.content || "";
  const content = stripThinkBlocks(rawContent);

  return {
    text: content,
    raw: response,
    usage: response.usage || null,
    model: response.model || selectedModel,
    provider: GROQ_PROVIDER_ID,
  };
}

async function listGroqModelOptions(credential) {
  const models = await listGroqModels(credential);
  return models
    .filter((model) => model?.active !== false && !getBlockedModelReason(model?.id))
    .map((model) => ({
      id: String(model?.id || "").trim(),
      label: String(model?.id || "").trim(),
      description: model?.owned_by ? `Groq model • ${model.owned_by}` : "Groq chat model",
    }))
    .filter((model) => model.id);
}

const groqProvider = Object.freeze({
  id: GROQ_PROVIDER_ID,
  displayName: "Groq",
  defaultModel: DEFAULT_GROQ_MODEL,
  requiresCredential: true,
  credentialType: GROQ_CREDENTIAL_TYPE,
  credentialLabel: "Groq API Key",
  credentialPlaceholder: "gsk_...",
  generateReply: generateGroqReply,
  listModels: listGroqModels,
  listModelOptions: listGroqModelOptions,
  validateCredential: validateGroqApiKey,
  validateModel({ credential, modelId }) {
    return validateGroqChatModel({
      apiKey: credential,
      modelId,
    });
  },
});

module.exports = {
  GROQ_CREDENTIAL_TYPE,
  GROQ_GPT_OSS_MODEL_PATTERN,
  GROQ_PROVIDER_ID,
  buildGroqCompletionRequest,
  generateGroqReply,
  groqProvider,
  listGroqModelOptions,
};
