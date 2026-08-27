const { aiConfig, getGuildAiConfig } = require("../config/ai");
const { getCurrentGuildId } = require("../context/guildContext");
const { getAiProvider } = require("./providers/providerRegistry");

function createMissingProviderCredentialError(providerDefinition) {
  const error = new Error(
    `${providerDefinition.displayName} requires a configured credential for this server.`
  );
  error.code = providerDefinition.id === "groq"
    ? "missing_guild_groq_api_key"
    : "missing_guild_ai_credential";
  error.provider = providerDefinition.id;
  return error;
}

async function generateAiReply({
  messages,
  provider,
  model,
  credential,
  apiKey,
  guildId,
  providerResolver = getAiProvider,
} = {}) {
  const resolvedGuildId = guildId || getCurrentGuildId();
  let selectedProvider = provider || null;
  let selectedModel = model || null;
  let selectedCredential = credential || apiKey || null;

  // Guild configuration is authoritative whenever the caller did not provide
  // an explicit credential. This keeps legacy callers safe while allowing the
  // selected provider to change without touching every AI call site.
  if (resolvedGuildId && !selectedCredential) {
    const guildConfig = await getGuildAiConfig(resolvedGuildId);
    selectedProvider = guildConfig.provider;
    selectedModel = guildConfig.model;
    selectedCredential = guildConfig.credential;
  }

  selectedProvider = selectedProvider || aiConfig.provider;
  const providerDefinition = providerResolver(selectedProvider);
  selectedModel = selectedModel || providerDefinition.defaultModel;

  if (providerDefinition.requiresCredential && !String(selectedCredential || "").trim()) {
    throw createMissingProviderCredentialError(providerDefinition);
  }

  const result = await providerDefinition.generateReply({
    messages,
    model: selectedModel,
    credential: selectedCredential,
    guildId: resolvedGuildId,
    generation: {
      temperature: aiConfig.temperature,
      maxOutputTokens: aiConfig.maxOutputTokens,
    },
  });

  return {
    ...result,
    provider: result?.provider || providerDefinition.id,
    model: result?.model || selectedModel,
  };
}

module.exports = {
  createMissingProviderCredentialError,
  generateAiReply,
};
