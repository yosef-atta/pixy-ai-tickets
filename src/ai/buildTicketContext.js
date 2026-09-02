const { aiConfig } = require("../config/ai");
const { ragConfig } = require("../config/rag");
const { prisma } = require("../config/prisma");
const { searchTicketContext } = require("./ragClient");
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
    .map((messageItem) => cleanMessageContent(messageItem.content))
    .filter(Boolean);

  if (!recentUserTexts.length) return currentContent;
  return [...new Set([...recentUserTexts, currentContent])].join("\n");
}

function parseRagResults(results = []) {
  const learnedQna = [];
  const learnedFreeform = [];

  for (const result of results) {
    const metadata = result.metadata || {};
    const itemType = String(result.item_type || "").toLowerCase();

    if (itemType === KNOWLEDGE_TYPE_QNA) {
      const question = metadata.question || result.title || extractQuestionFromText(result.text);
      const answer = metadata.answer || extractAnswerFromText(result.text);
      learnedQna.push({
        id: result.item_id || result.id,
        type: KNOWLEDGE_TYPE_QNA,
        question,
        answer,
        score: result.score,
      });
    } else if (itemType === KNOWLEDGE_TYPE_FREEFORM) {
      learnedFreeform.push({
        id: result.item_id || result.id,
        type: KNOWLEDGE_TYPE_FREEFORM,
        title: result.title || metadata.title || "Knowledge Snippet",
        content: result.text || metadata.content || "",
        score: result.score,
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
    const roleId = String(metadata.roleId || metadata.role_id || "").trim();
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
      .filter((messageItem) => messageItem.id !== currentMessageId)
      .filter((messageItem) => !messageItem.author?.bot)
      .filter((messageItem) => cleanMessageContent(messageItem.content).length > 0)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-aiConfig.recentMessagesLimit)
      .map((messageItem) => ({
        authorName: messageItem.member?.displayName || messageItem.author?.username || "User",
        content: cleanMessageContent(messageItem.content).slice(0, 500),
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
      where: { guildId },
      select: { maxLearnedItems: true },
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
      where: { guildId },
      orderBy: { updatedAt: "desc" },
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
      where: { guildId: guild.id },
      select: { maxAdminRoutes: true },
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
      orderBy: { updatedAt: "desc" },
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

async function buildTicketContext({
  message,
  includeLearnedKnowledge = true,
  includeAdminRoutes = true,
  client = prisma,
  searchContext = searchTicketContext,
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
  let ragTimingsMs = {};
  let ragResult = null;

  if (
    ragConfig.enabled &&
    guildId &&
    query &&
    (includeLearnedKnowledge || includeAdminRoutes)
  ) {
    try {
      ragResult = await searchContext({
        guildId,
        query,
        knowledgeCandidateK: ragConfig.candidateK,
        routeCandidateK: ragConfig.routeCandidateK,
        knowledgeTopK: includeLearnedKnowledge ? ragConfig.topK : 0,
        routeTopK: includeAdminRoutes ? ragConfig.routeTopK : 0,
        minScore: ragConfig.minScore,
      });
    } catch (ragError) {
      console.warn(
        "RAG ticket context retrieval failed, falling back to database:",
        ragError?.message || ragError
      );
    }
  }

  if (includeLearnedKnowledge && guildId) {
    if (ragResult?.ok) {
      learnedKnowledge = parseRagResults(ragResult.knowledgeResults || []);
      knowledgeRetrievalSource = "rag";
      ragCandidates = ragResult.knowledgeCandidates || 0;
    } else {
      learnedKnowledge = await getLearnedKnowledge(guildId, { client });
      knowledgeRetrievalSource = "mysql";
    }
  }

  if (includeAdminRoutes && guildId) {
    if (ragResult?.ok) {
      adminRoutes = await parseRagAdminRoutes(
        ragResult.routeResults || [],
        message.guild
      );
      routeRetrievalSource = "rag";
      ragRouteCandidates = ragResult.routeCandidates || 0;
    } else {
      adminRoutes = await getAdminRoutes(message.guild, { client });
      routeRetrievalSource = "mysql";
    }
  }

  if (ragResult?.ok) {
    ragTimingsMs = ragResult.timingsMs || {};
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
    ragTimingsMs,
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
};
