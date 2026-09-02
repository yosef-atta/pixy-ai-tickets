const { aiConfig } = require("../config/ai");
const { ragConfig } = require("../config/rag");
const { prisma } = require("../config/prisma");
const { searchKnowledge } = require("./ragClient");
const {
  DEFAULT_MAX_ADMIN_ROUTES,
  DEFAULT_MAX_LEARNED_ITEMS,
} = require("../config/productDefaults");

const KNOWLEDGE_TYPE_QNA = "qna";
const KNOWLEDGE_TYPE_FREEFORM = "freeform";
const KNOWLEDGE_TYPE_ADMIN_ROUTE = "admin_route";
const RAG_KNOWLEDGE_TYPES = Object.freeze([
  KNOWLEDGE_TYPE_QNA,
  KNOWLEDGE_TYPE_FREEFORM,
]);
const RAG_ROUTE_TYPES = Object.freeze([KNOWLEDGE_TYPE_ADMIN_ROUTE]);
const FALLBACK_MAX_LEARNED_ITEMS = 25;
const FALLBACK_MAX_ADMIN_ROUTES = 25;

function cleanMessageContent(content) {
  return String(content || "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractQuestionFromText(text) {
  const match = String(text || "").match(/^Question:\s*(.*?)(?:\nAnswer:|$)/is);
  return match ? match[1].trim() : String(text || "").trim();
}

function extractAnswerFromText(text) {
  const match = String(text || "").match(/\nAnswer:\s*([\s\S]*)$/i);
  return match ? match[1].trim() : String(text || "").trim();
}

function buildCompositeSearchQuery(message, recentMessages = []) {
  const currentContent = cleanMessageContent(message?.content);
  const recentUserTexts = (recentMessages || [])
    .slice(-3)
    .map((m) => cleanMessageContent(m.content))
    .filter(Boolean);

  if (!recentUserTexts.length) return currentContent;
  return [...new Set([...recentUserTexts, currentContent])].join("\n");
}

function parseRagResults(results = []) {
  const learnedQna = [];
  const learnedFreeform = [];

  for (const r of results) {
    const meta = r.metadata || {};
    const itemType = (r.item_type || "").toLowerCase();

    if (itemType === KNOWLEDGE_TYPE_QNA) {
      const q = meta.question || r.title || extractQuestionFromText(r.text);
      const a = meta.answer || extractAnswerFromText(r.text);
      learnedQna.push({
        id: r.item_id || r.id,
        type: KNOWLEDGE_TYPE_QNA,
        question: q,
        answer: a,
        score: r.score,
      });
    } else if (itemType === KNOWLEDGE_TYPE_FREEFORM) {
      learnedFreeform.push({
        id: r.item_id || r.id,
        type: KNOWLEDGE_TYPE_FREEFORM,
        title: r.title || meta.title || "Knowledge Snippet",
        content: r.text || meta.content || "",
        score: r.score,
      });
    }
  }

  return { learnedQna, learnedFreeform };
}

async function parseRagAdminRoutes(results = [], guild) {
  if (!guild?.id || !Array.isArray(results) || results.length === 0) return [];

  await guild.roles.fetch().catch(() => null);
  const routes = [];
  const seenRoleIds = new Set();

  for (const result of results) {
    if (String(result?.item_type || "").toLowerCase() !== KNOWLEDGE_TYPE_ADMIN_ROUTE) {
      continue;
    }

    const metadata = result.metadata || {};
    const roleId = String(
      metadata.roleId || metadata.role_id || ""
    ).trim();
    if (!roleId || seenRoleIds.has(roleId)) continue;

    const role = guild.roles.cache.get(roleId);
    if (!role || role.id === guild.id) continue;

    seenRoleIds.add(roleId);
    routes.push({
      id: result.item_id || result.id,
      roleId,
      roleName: role.name,
      description: metadata.description || result.text || "",
      score: result.score,
    });
  }

  return routes;
}

async function getRecentChannelMessages(channel, currentMessageId) {
  try {
    const fetched = await channel.messages.fetch({
      limit: aiConfig.recentMessagesLimit + 3,
    });

    return Array.from(fetched.values())
      .filter((msg) => msg.id !== currentMessageId)
      .filter((msg) => !msg.author?.bot)
      .filter((msg) => cleanMessageContent(msg.content).length > 0)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-aiConfig.recentMessagesLimit)
      .map((msg) => ({
        authorName: msg.member?.displayName || msg.author?.username || "User",
        content: cleanMessageContent(msg.content).slice(0, 500),
      }));
  } catch (error) {
    console.error("Failed to fetch recent ticket messages:", error);
    return [];
  }
}

async function getLearnedKnowledge(guildId, options = {}) {
  if (!guildId) {
    return {
      learnedQna: [],
      learnedFreeform: [],
    };
  }

  const client = options.client || prisma;

  try {
    const config = await client.guildConfig.findUnique({
      where: {
        guildId,
      },
      select: {
        maxLearnedItems: true,
      },
    });

    const configuredLimit = Number(
      config?.maxLearnedItems ?? DEFAULT_MAX_LEARNED_ITEMS
    );
    if (!Number.isFinite(configuredLimit) || configuredLimit <= 0) {
      return {
        learnedQna: [],
        learnedFreeform: [],
      };
    }
    const take = Math.min(
      Math.floor(configuredLimit),
      FALLBACK_MAX_LEARNED_ITEMS
    );

    const items = await client.learnedAnswer.findMany({
      where: {
        guildId,
      },
      orderBy: {
        updatedAt: "desc",
      },
      take,
      select: {
        id: true,
        type: true,
        question: true,
        answer: true,
        title: true,
        content: true,
      },
    });

    return {
      learnedQna: items.filter((item) => item.type === KNOWLEDGE_TYPE_QNA),
      learnedFreeform: items.filter((item) => item.type === KNOWLEDGE_TYPE_FREEFORM),
    };
  } catch (error) {
    console.error("Failed to fetch learned knowledge:", error);

    return {
      learnedQna: [],
      learnedFreeform: [],
    };
  }
}

async function getAdminRoutes(guild, options = {}) {
  if (!guild?.id) return [];

  const client = options.client || prisma;

  try {
    const config = await client.guildConfig.findUnique({
      where: {
        guildId: guild.id,
      },
      select: {
        maxAdminRoutes: true,
      },
    });

    const configuredLimit = Number(
      config?.maxAdminRoutes ?? aiConfig.maxAdminRoutesPerGuild ?? DEFAULT_MAX_ADMIN_ROUTES
    );
    const take = Math.max(
      1,
      Math.min(
        Number.isFinite(configuredLimit)
          ? Math.floor(configuredLimit)
          : DEFAULT_MAX_ADMIN_ROUTES,
        FALLBACK_MAX_ADMIN_ROUTES
      )
    );

    const routes = await client.adminRoute.findMany({
      where: {
        guildId: guild.id,
        enabled: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
      take,
      select: {
        id: true,
        roleId: true,
        description: true,
      },
    });

    await guild.roles.fetch().catch(() => null);

    return routes
      .map((route) => {
        const role = guild.roles.cache.get(route.roleId);

        if (!role || role.id === guild.id) return null;

        return {
          id: route.id,
          roleId: route.roleId,
          roleName: role.name,
          description: route.description,
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.error("Failed to fetch admin routes:", error);
    return [];
  }
}

async function searchRagContext({
  guildId,
  query,
  itemTypes,
  search = searchKnowledge,
}) {
  if (!ragConfig.enabled || !guildId || !query) {
    return { ok: false, results: [], totalCandidates: 0 };
  }

  return search({
    guildId,
    query,
    topK: ragConfig.topK,
    candidateK: ragConfig.candidateK,
    minScore: ragConfig.minScore,
    itemTypes,
  });
}

async function buildTicketContext({
  message,
  includeLearnedKnowledge = true,
  includeAdminRoutes = true,
  client = prisma,
  search = searchKnowledge,
}) {
  const guildId = message.guild?.id;
  const recentMessages = await getRecentChannelMessages(
    message.channel,
    message.id
  );
  const query = buildCompositeSearchQuery(message, recentMessages);

  let learnedKnowledge = {
    learnedQna: [],
    learnedFreeform: [],
  };
  let adminRoutes = [];
  let knowledgeRetrievalSource = "none";
  let routeRetrievalSource = "none";
  let ragCandidates = 0;
  let ragRouteCandidates = 0;

  if (includeLearnedKnowledge && guildId) {
    let ragKnowledge = null;
    if (ragConfig.enabled && query) {
      try {
        ragKnowledge = await searchRagContext({
          guildId,
          query,
          itemTypes: RAG_KNOWLEDGE_TYPES,
          search,
        });
      } catch (ragError) {
        console.warn(
          "RAG knowledge retrieval failed, falling back to database:",
          ragError?.message || ragError
        );
      }
    }

    if (
      ragKnowledge?.ok &&
      Array.isArray(ragKnowledge.results) &&
      ragKnowledge.results.length > 0
    ) {
      learnedKnowledge = parseRagResults(ragKnowledge.results);
      knowledgeRetrievalSource = "rag";
      ragCandidates = ragKnowledge.totalCandidates || 0;
    } else {
      learnedKnowledge = await getLearnedKnowledge(guildId, { client });
      knowledgeRetrievalSource = "mysql";
    }
  }

  if (includeAdminRoutes && guildId) {
    let ragRoutes = null;
    if (ragConfig.enabled && query) {
      try {
        ragRoutes = await searchRagContext({
          guildId,
          query,
          itemTypes: RAG_ROUTE_TYPES,
          search,
        });
      } catch (ragError) {
        console.warn(
          "RAG route retrieval failed, falling back to database:",
          ragError?.message || ragError
        );
      }
    }

    if (
      ragRoutes?.ok &&
      Array.isArray(ragRoutes.results) &&
      ragRoutes.results.length > 0
    ) {
      adminRoutes = await parseRagAdminRoutes(ragRoutes.results, message.guild);
      if (adminRoutes.length > 0) {
        routeRetrievalSource = "rag";
        ragRouteCandidates = ragRoutes.totalCandidates || 0;
      }
    }

    if (routeRetrievalSource !== "rag") {
      adminRoutes = await getAdminRoutes(message.guild, { client });
      routeRetrievalSource = "mysql";
    }
  }

  return {
    guildName: message.guild?.name || null,
    channelName: message.channel?.name || null,
    recentMessages,
    learnedQna: learnedKnowledge.learnedQna,
    learnedFreeform: learnedKnowledge.learnedFreeform,
    adminRoutes,
    retrievalSource: knowledgeRetrievalSource,
    knowledgeRetrievalSource,
    routeRetrievalSource,
    ragCandidates,
    ragRouteCandidates,
  };
}

module.exports = {
  FALLBACK_MAX_ADMIN_ROUTES,
  FALLBACK_MAX_LEARNED_ITEMS,
  RAG_KNOWLEDGE_TYPES,
  RAG_ROUTE_TYPES,
  buildCompositeSearchQuery,
  buildTicketContext,
  cleanMessageContent,
  getAdminRoutes,
  getLearnedKnowledge,
  getRecentChannelMessages,
  parseRagAdminRoutes,
  parseRagResults,
  searchRagContext,
};
