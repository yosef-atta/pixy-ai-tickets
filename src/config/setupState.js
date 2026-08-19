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

async function getOrCreateSetupState(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const existing = await client.guildSetupState.findUnique({
    where: { guildId: normalizedGuildId },
  });
  if (existing) return existing;

  const progress = await inferSetupProgress(normalizedGuildId, { client });
  const data = {
    guildId: normalizedGuildId,
    setupVersion: CURRENT_SETUP_VERSION,
    lastStep: progress.lastStep,
    completedAt: progress.completed ? new Date() : null,
  };

  try {
    return await client.guildSetupState.create({ data });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    return client.guildSetupState.findUniqueOrThrow({
      where: { guildId: normalizedGuildId },
    });
  }
}

async function markSetupStep(guildId, lastStep, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const step = String(lastStep || "").trim();
  if (!Object.values(SETUP_STEPS).includes(step)) {
    throw new TypeError(`Unsupported setup step: ${step || "empty"}`);
  }

  return client.guildSetupState.upsert({
    where: { guildId: normalizedGuildId },
    create: {
      guildId: normalizedGuildId,
      setupVersion: CURRENT_SETUP_VERSION,
      lastStep: step,
      completedAt: step === SETUP_STEPS.COMPLETE ? new Date() : null,
    },
    update: {
      setupVersion: CURRENT_SETUP_VERSION,
      lastStep: step,
      completedAt: step === SETUP_STEPS.COMPLETE ? new Date() : null,
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
};
