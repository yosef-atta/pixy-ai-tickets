const { groqProvider } = require("./groqProvider");

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

const providerRegistry = createProviderRegistry([groqProvider]);

function getAiProvider(providerId) {
  return providerRegistry.get(providerId);
}

function listAiProviders() {
  return providerRegistry.list();
}

async function validateProviderCredential(providerId, credential) {
  const provider = getAiProvider(providerId);
  if (provider.requiresCredential && !String(credential || "").trim()) {
    const error = new Error(`${provider.displayName} requires a credential.`);
    error.code = "provider_credential_required";
    error.provider = provider.id;
    throw error;
  }
  if (typeof provider.validateCredential !== "function") {
    return { valid: true };
  }
  return provider.validateCredential(credential);
}

async function validateProviderModel(providerId, { credential, modelId } = {}) {
  const provider = getAiProvider(providerId);
  const normalizedModel = String(modelId || "").trim();
  if (!normalizedModel) {
    const error = new Error("A model ID is required.");
    error.code = "model_required";
    throw error;
  }
  if (typeof provider.validateModel !== "function") {
    return { id: normalizedModel, compatible: true };
  }
  return provider.validateModel({ credential, modelId: normalizedModel });
}

module.exports = {
  createProviderRegistry,
  getAiProvider,
  listAiProviders,
  normalizeProviderDefinition,
  normalizeProviderId,
  providerRegistry,
  validateProviderCredential,
  validateProviderModel,
};
