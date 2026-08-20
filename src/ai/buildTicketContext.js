const { aiConfig } = require("../config/ai");
const { prisma } = require("../config/prisma");
const {
  DEFAULT_MAX_ADMIN_ROUTES,
  DEFAULT_MAX_LEARNED_ITEMS,
} = require("../config/productDefaults");

const KNOWLEDGE_TYPE_QNA = "qna";
const KNOWLEDGE_TYPE_FREEFORM = "freeform";

function cleanMessageContent(content) {
  return String(content || "")
    .replace(/\s+/g, " ")
    .trim();
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
    const take = Math.min(Math.floor(configuredLimit), 100);

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
      Math.min(Number.isFinite(configuredLimit) ? Math.floor(configuredLimit) : DEFAULT_MAX_ADMIN_ROUTES, 25)
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

async function buildTicketContext({
  message,
  includeLearnedKnowledge = true,
  includeAdminRoutes = true,
  client = prisma,
}) {
  const [recentMessages, learnedKnowledge, adminRoutes] = await Promise.all([
    getRecentChannelMessages(message.channel, message.id),
    includeLearnedKnowledge
      ? getLearnedKnowledge(message.guild?.id, { client })
      : Promise.resolve({ learnedQna: [], learnedFreeform: [] }),
    includeAdminRoutes
      ? getAdminRoutes(message.guild, { client })
      : Promise.resolve([]),
  ]);

  return {
    guildName: message.guild?.name || null,
    channelName: message.channel?.name || null,
    recentMessages,
    learnedQna: learnedKnowledge.learnedQna,
    learnedFreeform: learnedKnowledge.learnedFreeform,
    adminRoutes,
  };
}

module.exports = {
  buildTicketContext,
  cleanMessageContent,
  getAdminRoutes,
  getLearnedKnowledge,
  getRecentChannelMessages,
};
