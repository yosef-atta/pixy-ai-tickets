const { prisma } = require("../config/prisma");
const {
  DEFAULT_MAX_ADMIN_ROUTES,
  DEFAULT_MAX_LEARNED_ITEMS,
} = require("../config/productDefaults");
const { syncAllKnowledge } = require("./ragClient");

function clampSyncLimit(value, fallback) {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.floor(numeric), fallback);
}

function learnedAnswerToRagItem(item) {
  return {
    id: item.id,
    type: item.type,
    question: item.question || undefined,
    answer: item.answer || undefined,
    title: item.title || undefined,
    content: item.content || undefined,
    updatedAt: item.updatedAt,
  };
}

function adminRouteToRagItem(route) {
  return {
    id: route.id,
    type: "admin_route",
    roleId: route.roleId,
    description: route.description,
    metadata: {
      roleId: route.roleId,
      description: route.description,
    },
    updatedAt: route.updatedAt,
  };
}

async function buildGuildRagItems(guildId, options = {}) {
  const client = options.client || prisma;
  const config = await client.guildConfig.findUnique({
    where: { guildId },
    select: { maxLearnedItems: true, maxAdminRoutes: true },
  });
  if (!config) throw new Error(`Guild ${guildId} is not configured.`);

  const knowledgeLimit = clampSyncLimit(
    config.maxLearnedItems,
    DEFAULT_MAX_LEARNED_ITEMS
  );
  const routeLimit = clampSyncLimit(
    config.maxAdminRoutes,
    DEFAULT_MAX_ADMIN_ROUTES
  );

  const [knowledge, routes] = await Promise.all([
    client.learnedAnswer.findMany({
      where: { guildId },
      orderBy: { updatedAt: "asc" },
      take: knowledgeLimit,
    }),
    client.adminRoute.findMany({
      where: { guildId, enabled: true },
      orderBy: { updatedAt: "asc" },
      take: routeLimit,
    }),
  ]);

  return [
    ...knowledge.map(learnedAnswerToRagItem),
    ...routes.map(adminRouteToRagItem),
  ];
}

async function syncGuildRagData(guildId, options = {}) {
  const items = await buildGuildRagItems(guildId, options);
  const sync = options.sync || syncAllKnowledge;
  const result = await sync({
    guildId,
    items,
    clearExisting: true,
    timeoutMs: options.timeoutMs || 120000,
  });

  return {
    ...result,
    sourceItems: items.length,
  };
}

module.exports = {
  adminRouteToRagItem,
  buildGuildRagItems,
  clampSyncLimit,
  learnedAnswerToRagItem,
  syncGuildRagData,
};
