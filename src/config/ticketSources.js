const { prisma } = require("./prisma");
const { TICKET_SOURCE_TYPES } = require("./productDefaults");
const {
  isCategoryTicketChannel,
  isThreadTicketChannel,
} = require("../utils/tickets/ticketSurface");

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

async function listResolvedTicketSources(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const sources = await listTicketSources(normalizedGuildId, {
    client,
    includeDisabled: options.includeDisabled,
  });

  if (sources.length || options.includeLegacyFallback !== true) return sources;

  const config = await client.guildConfig.findUnique({
    where: { guildId: normalizedGuildId },
    select: { ticketCategoryId: true },
  });

  if (!config?.ticketCategoryId) return [];

  return [{
    id: null,
    guildId: normalizedGuildId,
    type: TICKET_SOURCE_TYPES.CATEGORY,
    sourceId: config.ticketCategoryId,
    enabled: true,
    legacyFallback: true,
  }];
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

async function replaceTicketSourcesByType(guildId, type, sourceIds, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedType = normalizeSourceType(type);
  const normalizedIds = [...new Set((sourceIds || []).map(normalizeSourceId))];

  const execute = async (tx) => {
    await tx.ticketSource.deleteMany({
      where: {
        guildId: normalizedGuildId,
        type: normalizedType,
        ...(normalizedIds.length ? { sourceId: { notIn: normalizedIds } } : {}),
      },
    });

    const saved = [];
    for (const sourceId of normalizedIds) {
      saved.push(await upsertTicketSource({
        guildId: normalizedGuildId,
        type: normalizedType,
        sourceId,
        enabled: true,
      }, { client: tx }));
    }
    return saved;
  };

  if (options.useTransaction !== false && typeof client.$transaction === "function") {
    return client.$transaction(async (tx) => execute(tx));
  }
  return execute(client);
}

async function replaceCategoryTicketSources(guildId, categoryIds, options = {}) {
  return replaceTicketSourcesByType(
    guildId,
    TICKET_SOURCE_TYPES.CATEGORY,
    categoryIds,
    options
  );
}

async function replaceThreadParentTicketSources(guildId, parentIds, options = {}) {
  return replaceTicketSourcesByType(
    guildId,
    TICKET_SOURCE_TYPES.THREAD_PARENT,
    parentIds,
    options
  );
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

function findMatchingSourceForChannel(channel, sources = []) {
  if (!channel) return null;

  if (isCategoryTicketChannel(channel)) {
    return sources.find((source) =>
      source?.enabled !== false &&
      source.type === TICKET_SOURCE_TYPES.CATEGORY &&
      source.sourceId === channel.parentId
    ) || null;
  }

  if (isThreadTicketChannel(channel)) {
    return sources.find((source) =>
      source?.enabled !== false &&
      source.type === TICKET_SOURCE_TYPES.THREAD_PARENT &&
      source.sourceId === channel.parentId
    ) || null;
  }

  return null;
}

async function matchTicketSourceForChannel(channel, options = {}) {
  if (!channel?.guild?.id) return null;
  const sources = options.sources || await listResolvedTicketSources(channel.guild.id, options);
  return findMatchingSourceForChannel(channel, sources);
}

module.exports = {
  ensureLegacyTicketCategorySource,
  findMatchingSourceForChannel,
  getTicketSource,
  listResolvedTicketSources,
  listTicketSources,
  matchTicketSourceForChannel,
  normalizeGuildId,
  normalizeSourceId,
  normalizeSourceType,
  replaceCategoryTicketSources,
  replaceThreadParentTicketSources,
  replaceTicketSourcesByType,
  upsertTicketSource,
};
