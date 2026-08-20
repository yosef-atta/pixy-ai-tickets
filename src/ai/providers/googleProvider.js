const { stripThinkBlocks } = require("../sanitizeModelOutput");
const {
  createProviderError,
  normalizeMessages,
  requestJson,
} = require("./httpProviderUtils");

const GOOGLE_PROVIDER_ID = "google";
const GOOGLE_CREDENTIAL_TYPE = "google-gemini-api-key";
const DEFAULT_GOOGLE_MODEL = "gemini-3.6-flash";
const GOOGLE_API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const NON_TEXT_MODEL_PATTERN = /(?:embedding|embed-|image|imagen|tts|live|robotics|veo|aqa)/i;

function normalizeGoogleModelId(value) {
  return String(value || "")
    .trim()
    .replace(/^models\//i, "");
}

function modelSupportsGenerateContent(model) {
  const methods = Array.isArray(model?.supportedGenerationMethods)
    ? model.supportedGenerationMethods
    : [];
  return methods.includes("generateContent");
}

function modelSupportsTextGeneration(model) {
  const id = normalizeGoogleModelId(model?.name || model?.baseModelId);
  return Boolean(
    id &&
    modelSupportsGenerateContent(model) &&
    !NON_TEXT_MODEL_PATTERN.test(id)
  );
}

function createMissingCredentialError() {
  return createProviderError(
    "missing_guild_ai_credential",
    "This server must configure a Google Gemini API key in /pixy-setup.",
    { provider: GOOGLE_PROVIDER_ID }
  );
}

async function listGoogleModels(apiKey, options = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw createMissingCredentialError();

  const models = [];
  let pageToken = null;
  let pageCount = 0;

  do {
    const params = new URLSearchParams({ pageSize: "1000" });
    if (pageToken) params.set("pageToken", pageToken);
    const payload = await requestJson({
      provider: GOOGLE_PROVIDER_ID,
      url: `${GOOGLE_API_ROOT}/models?${params.toString()}`,
      headers: { "x-goog-api-key": key },
      fetchImpl: options.fetchImpl,
    });
    models.push(...(Array.isArray(payload?.models) ? payload.models : []));
    pageToken = String(payload?.nextPageToken || "").trim() || null;
    pageCount += 1;
  } while (pageToken && pageCount < 10);

  return models;
}

async function validateGoogleApiKey(apiKey, options = {}) {
  const models = await listGoogleModels(apiKey, options);
  return {
    valid: true,
    modelIds: models
      .filter(modelSupportsTextGeneration)
      .map((model) => normalizeGoogleModelId(model?.name))
      .filter(Boolean),
  };
}

async function validateGoogleChatModel({ apiKey, modelId, fetchImpl } = {}) {
  const id = normalizeGoogleModelId(modelId);
  if (!id) {
    throw createProviderError("model_required", "A model ID is required.", {
      provider: GOOGLE_PROVIDER_ID,
    });
  }

  const models = await listGoogleModels(apiKey, { fetchImpl });
  const model = models.find(
    (item) => normalizeGoogleModelId(item?.name) === id
  );
  if (!model) {
    throw createProviderError(
      "model_not_found",
      "That model is not available to this Google Gemini API key.",
      { provider: GOOGLE_PROVIDER_ID, modelId: id }
    );
  }
  if (!modelSupportsTextGeneration(model)) {
    throw createProviderError(
      "not_chat_compatible",
      "That Google model is not suitable for Pixy's normal text ticket replies.",
      { provider: GOOGLE_PROVIDER_ID, modelId: id }
    );
  }

  return { id, model, compatible: true };
}

function buildGoogleRequest(messages, generation = {}) {
  const normalized = normalizeMessages(messages);
  const systemText = normalized
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  const contents = normalized
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));

  const temperature = Number.isFinite(Number(generation.temperature))
    ? Number(generation.temperature)
    : 0.3;
  const maxOutputTokens = Number.isFinite(Number(generation.maxOutputTokens))
    ? Math.max(1, Math.floor(Number(generation.maxOutputTokens)))
    : 500;

  return {
    contents,
    ...(systemText
      ? { systemInstruction: { parts: [{ text: systemText }] } }
      : {}),
    generationConfig: {
      temperature,
      maxOutputTokens,
    },
  };
}

function extractGoogleText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeGoogleUsage(payload) {
  const usage = payload?.usageMetadata;
  if (!usage) return null;
  return {
    prompt_tokens: Number.isFinite(Number(usage.promptTokenCount))
      ? Number(usage.promptTokenCount)
      : null,
    completion_tokens: Number.isFinite(Number(usage.candidatesTokenCount))
      ? Number(usage.candidatesTokenCount)
      : null,
    total_tokens: Number.isFinite(Number(usage.totalTokenCount))
      ? Number(usage.totalTokenCount)
      : null,
  };
}

async function generateGoogleReply({
  messages,
  model,
  credential,
  apiKey,
  generation = {},
  fetchImpl,
} = {}) {
  const key = String(credential || apiKey || "").trim();
  if (!key) throw createMissingCredentialError();

  const selectedModel = normalizeGoogleModelId(model || DEFAULT_GOOGLE_MODEL);
  const payload = await requestJson({
    provider: GOOGLE_PROVIDER_ID,
    url: `${GOOGLE_API_ROOT}/models/${encodeURIComponent(selectedModel)}:generateContent`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": key,
    },
    body: buildGoogleRequest(messages, generation),
    fetchImpl,
  });

  if (payload?.promptFeedback?.blockReason) {
    throw createProviderError(
      "provider_response_blocked",
      `Google Gemini blocked the request: ${payload.promptFeedback.blockReason}.`,
      { provider: GOOGLE_PROVIDER_ID }
    );
  }

  const text = stripThinkBlocks(extractGoogleText(payload));
  return {
    text,
    raw: payload,
    usage: normalizeGoogleUsage(payload),
    model: normalizeGoogleModelId(payload?.modelVersion) || selectedModel,
    provider: GOOGLE_PROVIDER_ID,
  };
}

async function listGoogleModelOptions(credential, options = {}) {
  const models = await listGoogleModels(credential, options);
  return models
    .filter(modelSupportsTextGeneration)
    .map((model) => ({
      id: normalizeGoogleModelId(model?.name),
      label: String(model?.displayName || normalizeGoogleModelId(model?.name)).trim(),
      description: String(model?.description || "Google Gemini text model").trim(),
    }))
    .filter((model) => model.id);
}

const googleProvider = Object.freeze({
  id: GOOGLE_PROVIDER_ID,
  displayName: "Google Gemini",
  defaultModel: DEFAULT_GOOGLE_MODEL,
  requiresCredential: true,
  credentialType: GOOGLE_CREDENTIAL_TYPE,
  credentialLabel: "Gemini API Key",
  credentialPlaceholder: "Google AI Studio API key",
  generateReply: generateGoogleReply,
  listModels: listGoogleModels,
  listModelOptions: listGoogleModelOptions,
  validateCredential: validateGoogleApiKey,
  validateModel({ credential, modelId }) {
    return validateGoogleChatModel({
      apiKey: credential,
      modelId,
    });
  },
});

module.exports = {
  DEFAULT_GOOGLE_MODEL,
  GOOGLE_CREDENTIAL_TYPE,
  GOOGLE_PROVIDER_ID,
  buildGoogleRequest,
  extractGoogleText,
  generateGoogleReply,
  googleProvider,
  listGoogleModelOptions,
  listGoogleModels,
  modelSupportsGenerateContent,
  modelSupportsTextGeneration,
  normalizeGoogleModelId,
  normalizeGoogleUsage,
  validateGoogleApiKey,
  validateGoogleChatModel,
};
