const { prisma } = require("./prisma");
const {
  getAiProvider,
  providerRegistry,
} = require("../ai/providers/providerRegistry");
const {
  CURRENT_SETUP_VERSION,
  DEFAULT_AI_PROVIDER,
  SETUP_STEPS,
} = require("./productDefaults");

function normalizeGuildId(value) {
  const guildId = String(value || "").trim();
  if (!guildId) throw new TypeError("A guild ID is required to load setup state.");
  return guildId;
}

function hasConfiguredAiProvider(aiConfig, legacySetting) {
  if (aiConfig) {
    const providerId = String(aiConfig.provider || DEFAULT_AI_PROVIDER)
      .trim()
      .toLowerCase() || DEFAULT_AI_PROVIDER;

    if (providerRegistry.has(providerId)) {
      const provider = getAiProvider(providerId);
      if (provider.requiresCredential === false) return true;
      return Boolean(aiConfig.credentialEncrypted);
    }

    return Boolean(aiConfig.credentialEncrypted);
  }

  return Boolean(legacySetting?.groqApiKeyEncrypted);
}

async function inferSetupProgress(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);

  const [sourceCount, config, aiConfig, legacySetting] = await Promise.all([
    client.ticketSource.count({
      where: { guildId: normalizedGuildId, enabled: true },
    }),
    client.guildConfig.findUnique({
      where: { guildId: normalizedGuildId },
      select: { ticketCategoryId: true },
    }),
    client.guildAiConfig.findUnique({
      where: { guildId: normalizedGuildId },
      select: {
        provider: true,
        credentialEncrypted: true,
      },
    }),
    client.guildSetting.findUnique({
      where: { guildId: normalizedGuildId },
      select: { groqApiKeyEncrypted: true },
    }),
  ]);

  const hasTicketSource = sourceCount > 0 || Boolean(config?.ticketCategoryId);
  const hasAiConfiguration = hasConfiguredAiProvider(aiConfig, legacySetting);

  if (!hasTicketSource) {
    return {
      lastStep: SETUP_STEPS.TICKET_SOURCES,
      completed: false,
    };
  }

  if (!hasAiConfiguration) {
    return {
      lastStep: SETUP_STEPS.AI_PROVIDER,
      completed: false,
    };
  }

  // Human support is optional, but the first-run wizard still gives the admin
  // an explicit chance to configure or skip it before setup is considered done.
  return {
    lastStep: SETUP_STEPS.HUMAN_SUPPORT,
    completed: false,
  };
}

async function reconcileSetupState(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const existing = await client.guildSetupState.findUnique({
    where: { guildId: normalizedGuildId },
  });

  // Migrated or already-completed servers stay completed. Runtime health is
  // shown by /pixy-setup instead of forcing onboarding to restart.
  if (existing?.completedAt && existing.setupVersion === CURRENT_SETUP_VERSION) {
    return existing;
  }

  const progress = await inferSetupProgress(normalizedGuildId, { client });
  const data = {
    setupVersion: CURRENT_SETUP_VERSION,
    lastStep: progress.lastStep,
    completedAt: null,
  };

  return client.guildSetupState.upsert({
    where: { guildId: normalizedGuildId },
    create: {
      guildId: normalizedGuildId,
      ...data,
    },
    update: data,
  });
}

async function getOrCreateSetupState(guildId, options = {}) {
  return reconcileSetupState(guildId, options);
}

async function markSetupStep(guildId, lastStep, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const step = String(lastStep || "").trim();
  if (!Object.values(SETUP_STEPS).includes(step)) {
    throw new TypeError(`Unsupported setup step: ${step || "empty"}`);
  }

  const now = options.now instanceof Date ? options.now : new Date();
  return client.guildSetupState.upsert({
    where: { guildId: normalizedGuildId },
    create: {
      guildId: normalizedGuildId,
      setupVersion: CURRENT_SETUP_VERSION,
      lastStep: step,
      completedAt: step === SETUP_STEPS.COMPLETE ? now : null,
    },
    update: {
      setupVersion: CURRENT_SETUP_VERSION,
      lastStep: step,
      completedAt: step === SETUP_STEPS.COMPLETE ? now : null,
    },
  });
}

async function markSetupComplete(guildId, options = {}) {
  return markSetupStep(guildId, SETUP_STEPS.COMPLETE, options);
}

module.exports = {
  getOrCreateSetupState,
  hasConfiguredAiProvider,
  inferSetupProgress,
  markSetupComplete,
  markSetupStep,
  normalizeGuildId,
  reconcileSetupState,
};
