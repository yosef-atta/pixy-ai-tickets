const { prisma } = require("./prisma");
const {
  CURRENT_SETUP_VERSION,
  SETUP_STEPS,
} = require("./productDefaults");

function normalizeGuildId(value) {
  const guildId = String(value || "").trim();
  if (!guildId) throw new TypeError("A guild ID is required to load setup state.");
  return guildId;
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
      select: { credentialEncrypted: true },
    }),
    client.guildSetting.findUnique({
      where: { guildId: normalizedGuildId },
      select: { groqApiKeyEncrypted: true },
    }),
  ]);

  const hasTicketSource = sourceCount > 0 || Boolean(config?.ticketCategoryId);
  const hasAiCredential = Boolean(
    aiConfig?.credentialEncrypted || legacySetting?.groqApiKeyEncrypted
  );

  if (!hasTicketSource) {
    return {
      lastStep: SETUP_STEPS.TICKET_SOURCES,
      completed: false,
    };
  }

  if (!hasAiCredential) {
    return {
      lastStep: SETUP_STEPS.AI_PROVIDER,
      completed: false,
    };
  }

  return {
    lastStep: SETUP_STEPS.COMPLETE,
    completed: true,
  };
}

async function reconcileSetupState(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const progress = await inferSetupProgress(normalizedGuildId, { client });
  const existing = await client.guildSetupState.findUnique({
    where: { guildId: normalizedGuildId },
  });

  if (existing?.completedAt && existing.setupVersion === CURRENT_SETUP_VERSION) {
    return existing;
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const data = {
    setupVersion: CURRENT_SETUP_VERSION,
    lastStep: progress.lastStep,
    completedAt: progress.completed ? existing?.completedAt || now : null,
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
  inferSetupProgress,
  markSetupComplete,
  markSetupStep,
  normalizeGuildId,
  reconcileSetupState,
};
