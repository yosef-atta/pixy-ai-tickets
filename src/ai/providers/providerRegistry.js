const { googleProvider } = require("./googleProvider");
const { groqProvider } = require("./groqProvider");
const { mistralProvider } = require("./mistralProvider");
const { openaiProvider } = require("./openaiProvider");

const PROVIDER_VALIDATION_PROMPT = "Hello";
const PROVIDER_VALIDATION_MAX_OUTPUT_TOKENS = 128;
const PROVIDER_VALIDATION_RETRY_OUTPUT_TOKENS = 512;

function normalizeProviderId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!id) throw new TypeError("An AI provider ID is required.");
  return id;
}

function normalizeProviderDefinition(definition) {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("AI provider definition must be an object.");
  }

  const id = normalizeProviderId(definition.id);
  const displayName = String(definition.displayName || id).trim() || id;
  const defaultModel = String(definition.defaultModel || "").trim();
  const credentialType = String(
    definition.credentialType || `${id}-api-key`
  ).trim();

  if (typeof definition.generateReply !== "function") {
    throw new TypeError(`AI provider ${id} must implement generateReply().`);
  }
  if (!defaultModel) {
    throw new TypeError(`AI provider ${id} must define a defaultModel.`);
  }
  if (definition.requiresCredential !== false && !credentialType) {
    throw new TypeError(`AI provider ${id} must define a credentialType.`);
  }

  return Object.freeze({
    ...definition,
    id,
    displayName,
    defaultModel,
    credentialType,
    requiresCredential: definition.requiresCredential !== false,
    credentialLabel:
      String(definition.credentialLabel || "API Key").trim() || "API Key",
    credentialPlaceholder:
      String(definition.credentialPlaceholder || "").trim() || null,
  });
}

function createProviderRegistry(definitions = []) {
  const providers = new Map();

  function register(definition) {
    const normalized = normalizeProviderDefinition(definition);
    if (providers.has(normalized.id)) {
      throw new Error(`AI provider is already registered: ${normalized.id}`);
    }
    providers.set(normalized.id, normalized);
    return normalized;
  }

  function get(providerId) {
    const id = normalizeProviderId(providerId);
    const provider = providers.get(id);
    if (!provider) {
      const error = new Error(`Unsupported AI provider: ${id}`);
      error.code = "unsupported_ai_provider";
      error.provider = id;
      throw error;
    }
    return provider;
  }

  function has(providerId) {
    try {
      return providers.has(normalizeProviderId(providerId));
    } catch {
      return false;
    }
  }

  function list() {
    return Array.from(providers.values());
  }

  for (const definition of definitions) register(definition);

  return Object.freeze({
    get,
    has,
    list,
    register,
  });
}

const providerRegistry = createProviderRegistry([
  groqProvider,
  googleProvider,
  mistralProvider,
  openaiProvider,
]);

function getAiProvider(providerId) {
  return providerRegistry.get(providerId);
}

function listAiProviders() {
  return providerRegistry.list();
}

function createEmptyValidationResponseError(provider, modelId) {
  const error = new Error(
    `${provider.displayName} accepted the request but returned an empty live test response.`
  );
  error.code = "provider_validation_empty_response";
  error.provider = provider.id;
  error.model = modelId;
  return error;
}

async function runProviderProbe(provider, {
  credential,
  modelId,
  messages,
  maxOutputTokens,
} = {}) {
  return provider.generateReply({
    messages,
    model: modelId,
    credential,
    validationProbe: true,
    generation: {
      temperature: 0,
      maxOutputTokens,
    },
  });
}

async function probeProviderGeneration(provider, {
  credential,
  modelId,
  messages,
} = {}) {
  if (!provider || typeof provider.generateReply !== "function") {
    throw new TypeError("A valid AI provider definition is required for a live validation probe.");
  }

  const selectedModel = String(modelId || provider.defaultModel || "").trim();
  const probeMessages = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: "user", content: PROVIDER_VALIDATION_PROMPT }];

  let result = await runProviderProbe(provider, {
    credential,
    modelId: selectedModel,
    messages: probeMessages,
    maxOutputTokens: PROVIDER_VALIDATION_MAX_OUTPUT_TOKENS,
  });

  let text = String(result?.text || "").trim();
  let retried = false;

  // Some reasoning models can spend a very small completion budget entirely
  // on internal reasoning and return an empty assistant content field even
  // though the credential/model are healthy. Retry once with a larger budget
  // before treating an empty response as a failed live validation.
  if (!text) {
    retried = true;
    result = await runProviderProbe(provider, {
      credential,
      modelId: selectedModel,
      messages: probeMessages,
      maxOutputTokens: PROVIDER_VALIDATION_RETRY_OUTPUT_TOKENS,
    });
    text = String(result?.text || "").trim();
  }

  if (!text) throw createEmptyValidationResponseError(provider, selectedModel);

  return {
    valid: true,
    liveGeneration: true,
    provider: result?.provider || provider.id,
    model: result?.model || selectedModel,
    text,
    usage: result?.usage || null,
    retried,
  };
}

async function validateProviderCredential(providerId, credential, options = {}) {
  const resolveProvider = options.providerResolver || getAiProvider;
  const provider = resolveProvider(providerId);
  const normalizedCredential = String(credential || "").trim();

  if (provider.requiresCredential && !normalizedCredential) {
    const error = new Error(`${provider.displayName} requires a credential.`);
    error.code = "provider_credential_required";
    error.provider = provider.id;
    throw error;
  }

  const basicValidation = typeof provider.validateCredential === "function"
    ? await provider.validateCredential(normalizedCredential)
    : { valid: true };

  const liveProbe = await probeProviderGeneration(provider, {
    credential: normalizedCredential,
    modelId: options.modelId || provider.defaultModel,
    messages: options.messages,
  });

  return {
    ...(basicValidation && typeof basicValidation === "object"
      ? basicValidation
      : { valid: basicValidation !== false }),
    valid: true,
    liveGeneration: true,
    probe: liveProbe,
  };
}

async function validateProviderModel(providerId, {
  credential,
  modelId,
  providerResolver,
  messages,
} = {}) {
  const resolveProvider = providerResolver || getAiProvider;
  const provider = resolveProvider(providerId);
  const normalizedModel = String(modelId || "").trim();
  if (!normalizedModel) {
    const error = new Error("A model ID is required.");
    error.code = "model_required";
    throw error;
  }

  const basicValidation = typeof provider.validateModel === "function"
    ? await provider.validateModel({ credential, modelId: normalizedModel })
    : { id: normalizedModel, compatible: true };

  const liveProbe = await probeProviderGeneration(provider, {
    credential,
    modelId: normalizedModel,
    messages,
  });

  return {
    ...(basicValidation && typeof basicValidation === "object"
      ? basicValidation
      : { id: normalizedModel, compatible: basicValidation !== false }),
    id: basicValidation?.id || normalizedModel,
    compatible: true,
    liveGeneration: true,
    probe: liveProbe,
  };
}

async function listProviderModelOptions(providerId, credential) {
  const provider = getAiProvider(providerId);
  if (typeof provider.listModelOptions === "function") {
    const options = await provider.listModelOptions(credential);
    return Array.isArray(options) ? options : [];
  }
  if (typeof provider.listModels !== "function") return [];

  const models = await provider.listModels(credential);
  const rows = Array.isArray(models) ? models : Array.isArray(models?.data) ? models.data : [];
  return rows
    .map((model) => {
      const id = String(model?.id || model?.name || "").replace(/^models\//, "").trim();
      if (!id) return null;
      return {
        id,
        label: String(model?.displayName || id).trim() || id,
        description: String(model?.description || "").trim() || null,
      };
    })
    .filter(Boolean);
}

module.exports = {
  PROVIDER_VALIDATION_MAX_OUTPUT_TOKENS,
  PROVIDER_VALIDATION_PROMPT,
  PROVIDER_VALIDATION_RETRY_OUTPUT_TOKENS,
  createProviderRegistry,
  getAiProvider,
  listAiProviders,
  listProviderModelOptions,
  normalizeProviderDefinition,
  normalizeProviderId,
  probeProviderGeneration,
  providerRegistry,
  validateProviderCredential,
  validateProviderModel,
};
