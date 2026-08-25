const { stripThinkBlocks } = require("../sanitizeModelOutput");
const {
  createProviderError,
  normalizeMessages,
  requestJson,
} = require("./httpProviderUtils");

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CREDENTIAL_TYPE = "openai-api-key";
const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
const OPENAI_API_ROOT = "https://api.openai.com/v1";

const NON_TEXT_MODEL_PATTERN = /(?:embed|embedding|moderation|image|dall-e|sora|realtime|audio|speech|transcrib|whisper|tts)/i;
const GPT_56_MODEL_PATTERN = /^gpt-5\.6(?:-|$)/i;

function normalizeOpenAiModelId(value) {
  return String(value || "").trim();
}

function modelSupportsTextResponse(model) {
  const id = normalizeOpenAiModelId(model?.id);
  if (!id) return false;
  return !NON_TEXT_MODEL_PATTERN.test(id);
}

function createMissingCredentialError() {
  return createProviderError(
    "missing_guild_ai_credential",
    "This server must configure an OpenAI API key in /pixy-setup.",
    { provider: OPENAI_PROVIDER_ID }
  );
}

async function listOpenAiModels(apiKey, options = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw createMissingCredentialError();

  const payload = await requestJson({
    provider: OPENAI_PROVIDER_ID,
    url: `${OPENAI_API_ROOT}/models`,
    headers: { Authorization: `Bearer ${key}` },
    fetchImpl: options.fetchImpl,
  });

  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

async function validateOpenAiApiKey(apiKey, options = {}) {
  const models = await listOpenAiModels(apiKey, options);
  return {
    valid: true,
    modelIds: models
      .filter(modelSupportsTextResponse)
      .map((model) => normalizeOpenAiModelId(model?.id))
      .filter(Boolean),
  };
}

async function validateOpenAiTextModel({ apiKey, modelId, fetchImpl } = {}) {
  const id = normalizeOpenAiModelId(modelId);
  if (!id) {
    throw createProviderError("model_required", "A model ID is required.", {
      provider: OPENAI_PROVIDER_ID,
    });
  }

  const models = await listOpenAiModels(apiKey, { fetchImpl });
  const model = models.find(
    (item) => normalizeOpenAiModelId(item?.id) === id
  );

  if (!model) {
    throw createProviderError(
      "model_not_found",
      "That model is not available to this OpenAI API key.",
      { provider: OPENAI_PROVIDER_ID, modelId: id }
    );
  }

  if (!modelSupportsTextResponse(model)) {
    throw createProviderError(
      "not_text_compatible",
      "That OpenAI model is not a text-response model Pixy can use for tickets.",
      { provider: OPENAI_PROVIDER_ID, modelId: id }
    );
  }

  return { id, model, compatible: true };
}

function normalizeOpenAiRole(role) {
  const normalized = String(role || "user").trim().toLowerCase();
  if (["system", "developer", "user", "assistant"].includes(normalized)) {
    return normalized;
  }
  return "user";
}

function buildOpenAiRequest(messages, generation = {}, options = {}) {
  const maxOutputTokens = Number.isFinite(Number(generation.maxOutputTokens))
    ? Math.max(1, Math.floor(Number(generation.maxOutputTokens)))
    : 500;
  const selectedModel = normalizeOpenAiModelId(options.model);

  const request = {
    input: normalizeMessages(messages).map((message) => ({
      role: normalizeOpenAiRole(message.role),
      content: message.content,
    })),
    max_output_tokens: maxOutputTokens,
    store: false,
  };

  // GPT-5.6 defaults to medium reasoning. Ticket support is latency-sensitive,
  // so keep reasoning modest while still allowing it to help with support tasks.
  // Avoid sending this option to unrelated/older model families.
  if (GPT_56_MODEL_PATTERN.test(selectedModel)) {
    request.reasoning = { effort: "low" };
  }

  return request;
}

function extractOpenAiText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (!Array.isArray(payload?.output)) return "";

  return payload.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "output_text" && typeof part.text === "string") {
        return part.text;
      }
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeOpenAiUsage(payload) {
  const usage = payload?.usage;
  if (!usage) return null;

  return {
    prompt_tokens: Number.isFinite(Number(usage.input_tokens))
      ? Number(usage.input_tokens)
      : null,
    completion_tokens: Number.isFinite(Number(usage.output_tokens))
      ? Number(usage.output_tokens)
      : null,
    total_tokens: Number.isFinite(Number(usage.total_tokens))
      ? Number(usage.total_tokens)
      : null,
  };
}

async function generateOpenAiReply({
  messages,
  model,
  credential,
  apiKey,
  generation = {},
  fetchImpl,
} = {}) {
  const key = String(credential || apiKey || "").trim();
  if (!key) throw createMissingCredentialError();

  const selectedModel = normalizeOpenAiModelId(model || DEFAULT_OPENAI_MODEL);
  const request = buildOpenAiRequest(messages, generation, { model: selectedModel });
  const payload = await requestJson({
    provider: OPENAI_PROVIDER_ID,
    url: `${OPENAI_API_ROOT}/responses`,
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
    text: stripThinkBlocks(extractOpenAiText(payload)),
    raw: payload,
    usage: normalizeOpenAiUsage(payload),
    model: normalizeOpenAiModelId(payload?.model) || selectedModel,
    provider: OPENAI_PROVIDER_ID,
  };
}

async function listOpenAiModelOptions(credential, options = {}) {
  const models = await listOpenAiModels(credential, options);
  return models
    .filter(modelSupportsTextResponse)
    .map((model) => ({
      id: normalizeOpenAiModelId(model?.id),
      label: normalizeOpenAiModelId(model?.id),
      description: "OpenAI text model",
    }))
    .filter((model) => model.id);
}

const openaiProvider = Object.freeze({
  id: OPENAI_PROVIDER_ID,
  displayName: "OpenAI API",
  defaultModel: DEFAULT_OPENAI_MODEL,
  requiresCredential: true,
  credentialType: OPENAI_CREDENTIAL_TYPE,
  credentialLabel: "OpenAI API Key",
  credentialPlaceholder: "OpenAI Platform API key",
  generateReply: generateOpenAiReply,
  listModels: listOpenAiModels,
  listModelOptions: listOpenAiModelOptions,
  validateCredential: validateOpenAiApiKey,
  validateModel({ credential, modelId }) {
    return validateOpenAiTextModel({
      apiKey: credential,
      modelId,
    });
  },
});

module.exports = {
  DEFAULT_OPENAI_MODEL,
  OPENAI_API_ROOT,
  OPENAI_CREDENTIAL_TYPE,
  OPENAI_PROVIDER_ID,
  buildOpenAiRequest,
  extractOpenAiText,
  generateOpenAiReply,
  listOpenAiModelOptions,
  listOpenAiModels,
  modelSupportsTextResponse,
  normalizeOpenAiModelId,
  normalizeOpenAiRole,
  normalizeOpenAiUsage,
  openaiProvider,
  validateOpenAiApiKey,
  validateOpenAiTextModel,
};
