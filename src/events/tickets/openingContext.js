const { Events } = require("discord.js");
const { prisma } = require("../../config/prisma");
const ticketMessageCreate = require("./messageCreate");
const {
  extractOpeningContext,
  isExternalOpeningCandidate,
  isWithinOpeningWindow,
} = require("../../utils/tickets/openingContext");
const {
  isSupportedTicketChannel,
} = require("../../utils/tickets/ticketSurface");

const processingChannels = new Set();

function buildSyntheticOpeningMessage(message, userMessage) {
  return {
    id: `opening:${message.id}`,
    guild: message.guild,
    channel: message.channel,
    channelId: message.channelId || message.channel?.id,
    client: message.client,
    author: { id: null, bot: false, username: "Ticket opener" },
    member: null,
    content: userMessage,
    syntheticOpeningContext: true,
    openingActor: null,
    openingMember: null,
    async reply(payload) {
      return message.channel.send(payload);
    },
  };
}

async function tryProcessOpeningMessage(message, options = {}) {
  const client = options.client || prisma;
  const executeTicketMessage = options.executeTicketMessage || ticketMessageCreate.execute;
  const channelId = message?.channelId || message?.channel?.id;
  const guildId = message?.guild?.id;

  if (!channelId || !guildId) return { processed: false, code: "missing_context" };
  if (!isSupportedTicketChannel(message.channel)) {
    return { processed: false, code: "unsupported_channel_type" };
  }
  if (!isExternalOpeningCandidate(message, message.client?.user?.id)) {
    return { processed: false, code: "not_candidate" };
  }
  if (processingChannels.has(channelId)) {
    return { processed: false, code: "already_processing" };
  }

  const ticket = await client.ticketChannel.findUnique({ where: { channelId } });
  if (!ticket || ticket.closed || ticket.aiEnabled === false) {
    return { processed: false, code: "ticket_unavailable" };
  }
  if (ticket.lastUserMessageAt || ticket.lastAiReplyAt) {
    return { processed: false, code: "already_started" };
  }
  if (!isWithinOpeningWindow(message, ticket)) {
    return { processed: false, code: "outside_opening_window" };
  }

  const ignored = await client.guildIgnoredChannel.findUnique({
    where: { guildId_channelId: { guildId, channelId } },
  });
  if (ignored) return { processed: false, code: "ignored_channel" };

  const userMessage = extractOpeningContext(message);
  if (!userMessage) return { processed: false, code: "empty_context" };

  processingChannels.add(channelId);
  try {
    const synthetic = buildSyntheticOpeningMessage(message, userMessage);
    await executeTicketMessage(synthetic);
    return { processed: true, code: "processed" };
  } finally {
    processingChannels.delete(channelId);
  }
}

async function reconcileOpeningContext(channel, options = {}) {
  try {
    const fetched = await channel.messages.fetch({ limit: 12 });
    const candidates = Array.from(fetched.values())
      .filter((message) => isExternalOpeningCandidate(message, channel.client?.user?.id))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const message of candidates) {
      const result = await tryProcessOpeningMessage(message, options);
      if (result.processed || result.code === "already_started") return result;
    }

    return { processed: false, code: "no_candidate" };
  } catch (error) {
    console.error("Opening context reconciliation failed:", error);
    return { processed: false, code: "fetch_failed" };
  }
}

const openingContextEvent = {
  name: Events.MessageCreate,
  async execute(message) {
    try {
      await tryProcessOpeningMessage(message);
    } catch (error) {
      console.error("Opening context message handler failed:", error);
    }
  },
};

module.exports = Object.assign(openingContextEvent, {
  buildSyntheticOpeningMessage,
  processingChannels,
  reconcileOpeningContext,
  tryProcessOpeningMessage,
});