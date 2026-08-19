const { stripThinkBlocks } = require("../sanitizeModelOutput");
const {
  createProviderError,
  normalizeMessages,
  requestJson,
} = require("./httpProviderUtils");

const MISTRAL_PROVIDER_ID = "mistral";
const MISTRAL_CREDENTIAL_TYPE = "mistral-api-key";
const DEFAULT_MISTRAL_MODEL = "mistral-small-latest";
const MISTRAL_API_ROOT = "https://api.mistral.ai/v1";

const NON_CHAT_MODEL_PATTERN = /(?:embed|embedding|moderation|moderator|ocr|transcrib|audio|speech|voxtral|codestral-embed)/i;

function normalizeMistralModelId(value) {
  return String(value || "").trim();
}

function modelSupportsChat(model) {
  if (!model?.id) return false;
  if (model.capabilities && typeof model.capabilities.completion_chat === "boolean") {
    return model.capabilities.completion_chat;
  }
  return !NON_CHAT_MODEL_PATTERN.test(String(model.id));
}

function createMissingCredentialError() {
  return createProviderError(
    "missing_guild_ai_credential",
    "This server must configure a Mistral API key in /pixy-setup.",
    { provider: MISTRAL_PROVIDER_ID }
  );
}

async function listMistralModels(apiKey, options = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw createMissingCredentialError();

  const payload = await requestJson({
    provider: MISTRAL_PROVIDER_ID,
    url: `${MISTRAL_API_ROOT}/models`,
    headers: { Authorization: `Bearer ${key}` },
    fetchImpl: options.fetchImpl,
  });
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function validateMistralApiKey(apiKey, options = {}) {
  const models = await listMistralModels(apiKey, options);
  return {
    valid: true,
    modelIds: models
      .filter(modelSupportsChat)
      .map((model) => normalizeMistralModelId(model?.id))
      .filter(Boolean),
  };
}

async function validateMistralChatModel({ apiKey, modelId, fetchImpl } = {}) {
  const id = normalizeMistralModelId(modelId);
  if (!id) {
    throw createProviderError("model_required", "A model ID is required.", {
      provider: MISTRAL_PROVIDER_ID,
    });
  }

  const models = await listMistralModels(apiKey, { fetchImpl });
  const model = models.find(
    (item) => normalizeMistralModelId(item?.id) === id
  );
  if (!model) {
    throw createProviderError(
      "model_not_found",
      "That model is not available to this Mistral API key.",
      { provider: MISTRAL_PROVIDER_ID, modelId: id }
    );
  }
  if (!modelSupportsChat(model)) {
    throw createProviderError(
      "not_chat_compatible",
      "That Mistral model is not a normal chat-completion model.",
      { provider: MISTRAL_PROVIDER_ID, modelId: id }
    );
  }

  return { id, model, compatible: true };
}

function buildMistralRequest(messages, generation = {}) {
  const temperature = Number.isFinite(Number(generation.temperature))
    ? Number(generation.temperature)
    : 0.3;
  const maxTokens = Number.isFinite(Number(generation.maxOutputTokens))
    ? Math.max(1, Math.floor(Number(generation.maxOutputTokens)))
    : 500;

  return {
    messages: normalizeMessages(messages).map((message) => ({
      role: ["system", "assistant", "user"].includes(message.role)
        ? message.role
        : "user",
      content: message.content,
    })),
    temperature,
    max_tokens: maxTokens,
  };
}

function extractMistralText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeMistralUsage(payload) {
  const usage = payload?.usage;
  if (!usage) return null;
  return {
    prompt_tokens: Number.isFinite(Number(usage.prompt_tokens))
      ? Number(usage.prompt_tokens)
      : null,
    completion_tokens: Number.isFinite(Number(usage.completion_tokens))
      ? Number(usage.completion_tokens)
      : null,
    total_tokens: Number.isFinite(Number(usage.total_tokens))
      ? Number(usage.total_tokens)
      : null,
  };
}

async function generateMistralReply({
  messages,
  model,
  credential,
  apiKey,
  generation = {},
  fetchImpl,
} = {}) {
  const key = String(credential || apiKey || "").trim();
  if (!key) throw createMissingCredentialError();

  const selectedModel = normalizeMistralModelId(model || DEFAULT_MISTRAL_MODEL);
  const request = buildMistralRequest(messages, generation);
  const payload = await requestJson({
    provider: MISTRAL_PROVIDER_ID,
    url: `${MISTRAL_API_ROOT}/chat/completions`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: {
      model: selectedModel,
      ...request,
    },
    fetchImpl,
  });

  return {
    text: stripThinkBlocks(extractMistralText(payload)),
    raw: payload,
    usage: normalizeMistralUsage(payload),
    model: normalizeMistralModelId(payload?.model) || selectedModel,
    provider: MISTRAL_PROVIDER_ID,
  };
}

async function listMistralModelOptions(credential, options = {}) {
  const models = await listMistralModels(credential, options);
  return models
    .filter(modelSupportsChat)
    .map((model) => ({
      id: normalizeMistralModelId(model?.id),
      label: normalizeMistralModelId(model?.id),
      description: "Mistral chat model",
    }))
    .filter((model) => model.id);
}

const mistralProvider = Object.freeze({
  id: MISTRAL_PROVIDER_ID,
  displayName: "Mistral",
  defaultModel: DEFAULT_MISTRAL_MODEL,
  requiresCredential: true,
  credentialType: MISTRAL_CREDENTIAL_TYPE,
  credentialLabel: "Mistral API Key",
  credentialPlaceholder: "Mistral AI Studio API key",
  generateReply: generateMistralReply,
  listModels: listMistralModels,
  listModelOptions: listMistralModelOptions,
  validateCredential: validateMistralApiKey,
  validateModel({ credential, modelId }) {
    return validateMistralChatModel({
      apiKey: credential,
      modelId,
    });
  },
});

module.exports = {
  DEFAULT_MISTRAL_MODEL,
  MISTRAL_CREDENTIAL_TYPE,
  MISTRAL_PROVIDER_ID,
  buildMistralRequest,
  extractMistralText,
  generateMistralReply,
  listMistralModelOptions,
  listMistralModels,
  mistralProvider,
  modelSupportsChat,
  normalizeMistralModelId,
  normalizeMistralUsage,
  validateMistralApiKey,
  validateMistralChatModel,
};
