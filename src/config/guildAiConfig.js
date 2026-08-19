const { prisma } = require("./prisma");
const { DEFAULT_AI_PROVIDER } = require("./productDefaults");

function normalizeGuildId(value) {
  const guildId = String(value || "").trim();
  if (!guildId) throw new TypeError("A guild ID is required to load AI configuration.");
  return guildId;
}

function normalizeProvider(value) {
  return String(value || DEFAULT_AI_PROVIDER).trim().toLowerCase() || DEFAULT_AI_PROVIDER;
}

function getProviderCredentialType(provider) {
  return `${normalizeProvider(provider)}-api-key`;
}

async function readLegacyAiConfig(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const [config, setting] = await Promise.all([
    client.guildConfig.findUnique({
      where: { guildId: normalizedGuildId },
      select: {
        aiProvider: true,
        aiModel: true,
        aiSystemPrompt: true,
      },
    }),
    client.guildSetting.findUnique({
      where: { guildId: normalizedGuildId },
      select: {
        groqApiKeyEncrypted: true,
        aiModel: true,
      },
    }),
  ]);

  const provider = normalizeProvider(config?.aiProvider);
  return {
    guildId: normalizedGuildId,
    provider,
    model: setting?.aiModel || config?.aiModel || null,
    credentialEncrypted:
      provider === "groq" ? setting?.groqApiKeyEncrypted || null : null,
    credentialType: getProviderCredentialType(provider),
    systemPrompt: config?.aiSystemPrompt || null,
  };
}

async function getOrCreateGuildAiConfig(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const existing = await client.guildAiConfig.findUnique({
    where: { guildId: normalizedGuildId },
  });
  if (existing) return existing;

  const legacy = await readLegacyAiConfig(normalizedGuildId, { client });
  try {
    return await client.guildAiConfig.create({ data: legacy });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    return client.guildAiConfig.findUniqueOrThrow({
      where: { guildId: normalizedGuildId },
    });
  }
}

async function syncGuildAiConfigFromLegacy(guildId, options = {}) {
  const client = options.client || prisma;
  const legacy = await readLegacyAiConfig(guildId, { client });

  return client.guildAiConfig.upsert({
    where: { guildId: legacy.guildId },
    create: legacy,
    update: {
      provider: legacy.provider,
      model: legacy.model,
      credentialEncrypted: legacy.credentialEncrypted,
      credentialType: legacy.credentialType,
      systemPrompt: legacy.systemPrompt,
    },
  });
}

module.exports = {
  getOrCreateGuildAiConfig,
  getProviderCredentialType,
  normalizeGuildId,
  normalizeProvider,
  readLegacyAiConfig,
  syncGuildAiConfigFromLegacy,
};
