const { prisma } = require("./prisma");
const { TICKET_SOURCE_TYPES } = require("./productDefaults");

const VALID_SOURCE_TYPES = new Set(Object.values(TICKET_SOURCE_TYPES));

function normalizeGuildId(value) {
  const guildId = String(value || "").trim();
  if (!guildId) throw new TypeError("A guild ID is required for ticket sources.");
  return guildId;
}

function normalizeSourceId(value) {
  const sourceId = String(value || "").trim();
  if (!sourceId) throw new TypeError("A Discord source ID is required.");
  return sourceId;
}

function normalizeSourceType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (!VALID_SOURCE_TYPES.has(type)) {
    throw new TypeError(`Unsupported ticket source type: ${type || "empty"}`);
  }
  return type;
}

async function listTicketSources(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const where = { guildId: normalizedGuildId };
  if (options.includeDisabled !== true) where.enabled = true;

  return client.ticketSource.findMany({
    where,
    orderBy: [{ type: "asc" }, { createdAt: "asc" }],
  });
}

async function upsertTicketSource({ guildId, type, sourceId, enabled = true }, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedType = normalizeSourceType(type);
  const normalizedSourceId = normalizeSourceId(sourceId);

  return client.ticketSource.upsert({
    where: {
      guildId_type_sourceId: {
        guildId: normalizedGuildId,
        type: normalizedType,
        sourceId: normalizedSourceId,
      },
    },
    create: {
      guildId: normalizedGuildId,
      type: normalizedType,
      sourceId: normalizedSourceId,
      enabled: enabled !== false,
    },
    update: {
      enabled: enabled !== false,
    },
  });
}

async function ensureLegacyTicketCategorySource(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const config = await client.guildConfig.findUnique({
    where: { guildId: normalizedGuildId },
    select: { ticketCategoryId: true },
  });

  if (!config?.ticketCategoryId) return null;

  return upsertTicketSource(
    {
      guildId: normalizedGuildId,
      type: TICKET_SOURCE_TYPES.CATEGORY,
      sourceId: config.ticketCategoryId,
      enabled: true,
    },
    { client }
  );
}

async function getTicketSource(guildId, type, sourceId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedType = normalizeSourceType(type);
  const normalizedSourceId = normalizeSourceId(sourceId);

  return client.ticketSource.findUnique({
    where: {
      guildId_type_sourceId: {
        guildId: normalizedGuildId,
        type: normalizedType,
        sourceId: normalizedSourceId,
      },
    },
  });
}

module.exports = {
  ensureLegacyTicketCategorySource,
  getTicketSource,
  listTicketSources,
  normalizeGuildId,
  normalizeSourceId,
  normalizeSourceType,
  upsertTicketSource,
};
