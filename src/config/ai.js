const { prisma } = require("./prisma");
const { DEFAULT_GROQ_MODEL } = require("../ai/groqModels");
const { getAiProvider } = require("../ai/providers/providerRegistry");
const {
  resolveGuildAiConfig,
} = require("./guildAiConfig");
const {
  DEFAULT_AI_PROVIDER,
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_MAX_ADMIN_ROUTES,
} = require("./productDefaults");

const defaultProvider = getAiProvider(DEFAULT_AI_PROVIDER);

const defaultAiConfig = Object.freeze({
  provider: defaultProvider.id,
  defaultModel: defaultProvider.defaultModel,
  // Temporary compatibility alias for code that has not moved to generic provider metadata yet.
  groq: Object.freeze({
    model: DEFAULT_GROQ_MODEL,
  }),
  maxOutputTokens: 500,
  temperature: 0.3,
  replyCooldownMs: 3000,
  maxInputChars: 2500,
  recentMessagesLimit: 8,
  agentActionsEnabled: DEFAULT_GUILD_SETTINGS.agentActionsEnabled,
  escalationEnabled: DEFAULT_GUILD_SETTINGS.escalationEnabled,
  maxAdminRoutesPerGuild: DEFAULT_MAX_ADMIN_ROUTES,
  ticketCloseDeleteDelayMs: 2500,
  actionMaxReplyChars: 1000,
  renameReviewEnabled: DEFAULT_GUILD_SETTINGS.renameReviewEnabled,
  escalationNotificationChannelName: "pixy-notifications",
});

const aiConfig = {
  ...defaultAiConfig,
  groq: {
    model: DEFAULT_GROQ_MODEL,
    apiKey: null,
  },
};

function createSetupRequiredError() {
  const error = new Error("Run /pixy-setup before managing Pixy settings.");
  error.code = "setup_required";
  return error;
}

async function getOrCreateGuildSetting(guildId) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) {
    throw new Error("A guild ID is required to load Pixy settings.");
  }

  const existing = await prisma.guildSetting.findUnique({
    where: { guildId: normalizedGuildId },
  });
  if (existing) return existing;

  // Settings are secondary configuration. Do not let /pixy-settings or a stale
  // component interaction recreate operational state after /pixy-clear.
  const coreConfig = await prisma.guildConfig.findUnique({
    where: { guildId: normalizedGuildId },
    select: { guildId: true },
  });
  if (!coreConfig) throw createSetupRequiredError();

  try {
    return await prisma.guildSetting.create({
      data: {
        guildId: normalizedGuildId,
        ...DEFAULT_GUILD_SETTINGS,
      },
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    return prisma.guildSetting.findUniqueOrThrow({
      where: { guildId: normalizedGuildId },
    });
  }
}

async function getGuildAiConfig(
  guildId,
  { requireApiKey = false, requireCredential = false } = {}
) {
  const [setting, runtime] = await Promise.all([
    getOrCreateGuildSetting(guildId),
    resolveGuildAiConfig(guildId, {
      client: prisma,
      requireCredential: requireCredential || requireApiKey,
    }),
  ]);

  const result = {
    ...defaultAiConfig,
    provider: runtime.provider,
    providerDefinition: runtime.providerDefinition,
    model: runtime.model,
    modelSource: runtime.modelSource,
    credential: runtime.credential,
    credentialType: runtime.credentialType,
    credentialStatus: runtime.credentialStatus,
    systemPrompt: runtime.systemPrompt,
    aiConfigRecord: runtime.record,
    aiReplyEnabled: setting.aiReplyEnabled,
    closeTicketEnabled: setting.closeTicketEnabled,
    renameReviewEnabled: setting.renameReviewEnabled,
    escalationEnabled: setting.escalationEnabled,
    agentActionsEnabled: setting.agentActionsEnabled,
    setting,
  };

  // Keep a Groq compatibility view until the remaining legacy callers are removed.
  result.groq = {
    apiKey: runtime.provider === "groq" ? runtime.credential : null,
    model: runtime.provider === "groq" ? runtime.model : DEFAULT_GROQ_MODEL,
  };

  return result;
}

module.exports = {
  aiConfig,
  createSetupRequiredError,
  defaultAiConfig,
  getGuildAiConfig,
  getOrCreateGuildSetting,
};