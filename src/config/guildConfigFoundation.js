const { prisma } = require("./prisma");
const {
  DEFAULT_MAX_ADMIN_ROUTES,
  DEFAULT_MAX_LEARNED_ITEMS,
} = require("./productDefaults");

function normalizeGuildId(value) {
  const guildId = String(value || "").trim();
  if (!guildId) throw new TypeError("A guild ID is required to load guild configuration.");
  return guildId;
}

function buildGuildConfigCreateData(guildId) {
  return {
    guildId: normalizeGuildId(guildId),
    enabled: true,
    maxLearnedItems: DEFAULT_MAX_LEARNED_ITEMS,
    maxAdminRoutes: DEFAULT_MAX_ADMIN_ROUTES,
  };
}

async function ensureGuildConfig(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const existing = await client.guildConfig.findUnique({
    where: { guildId: normalizedGuildId },
  });
  if (existing) return existing;

  try {
    return await client.guildConfig.create({
      data: buildGuildConfigCreateData(normalizedGuildId),
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    return client.guildConfig.findUniqueOrThrow({
      where: { guildId: normalizedGuildId },
    });
  }
}

module.exports = {
  buildGuildConfigCreateData,
  ensureGuildConfig,
  normalizeGuildId,
};
