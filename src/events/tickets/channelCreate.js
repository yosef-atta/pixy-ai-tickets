const { Events, ChannelType } = require("discord.js");
const { prisma } = require("../../config/prisma");
const {
  loadGuildEntitlementState,
} = require("../../billing/entitlementService");
const {
  buildModeAwareTicketControlPayload,
} = require("../../components/ticketAiControls");
const { reconcileOpeningContext } = require("./openingContext");

const OPENING_RECONCILE_DELAYS_MS = [500, 2000];

function scheduleOpeningContextReconciliation(channel, options = {}) {
  const reconcile = options.reconcile || reconcileOpeningContext;
  const delays = options.delays || OPENING_RECONCILE_DELAYS_MS;

  return delays.map((delayMs) => {
    const timer = setTimeout(() => {
      reconcile(channel).catch((error) => {
        console.error("Delayed opening context reconciliation failed:", error);
      });
    }, delayMs);
    timer.unref?.();
    return timer;
  });
}

async function trackTicketChannel(channel, options = {}) {
  const client = options.client || prisma;
  const loadEntitlement =
    options.loadEntitlement || loadGuildEntitlementState;

  if (!channel.guild) return { tracked: false, code: "missing_guild" };
  if (channel.type !== ChannelType.GuildText) {
    return { tracked: false, code: "unsupported_channel_type" };
  }

  const [config, setting] = await Promise.all([
    client.guildConfig.findUnique({
      where: { guildId: channel.guild.id },
    }),
    client.guildSetting?.findUnique
      ? client.guildSetting.findUnique({
          where: { guildId: channel.guild.id },
        })
      : Promise.resolve(null),
  ]);

  if (!config?.enabled || !config.ticketCategoryId) {
    return { tracked: false, code: "ticket_category_not_configured" };
  }
  if (channel.parentId !== config.ticketCategoryId) {
    return { tracked: false, code: "outside_ticket_category" };
  }

  const ignored = await client.guildIgnoredChannel.findUnique({
    where: {
      guildId_channelId: {
        guildId: channel.guild.id,
        channelId: channel.id,
      },
    },
  });
  if (ignored) return { tracked: false, code: "ignored_channel" };

  const entitlement = await loadEntitlement(channel.guild.id, { client });

  await client.ticketChannel.upsert({
    where: { channelId: channel.id },
    create: {
      guildId: channel.guild.id,
      channelId: channel.id,
      closed: false,
      status: "open",
      aiEnabled: true,
    },
    update: {
      closed: false,
      status: "open",
      aiEnabled: true,
      closedByAi: false,
      closedAt: null,
      renamedByAiAt: null,
      lastAiAction: null,
      lastAiActionAt: null,
      escalated: false,
      escalatedAt: null,
      escalatedRoleId: null,
      escalationReason: null,
    },
  });

  const payload = buildModeAwareTicketControlPayload(true, {
    plan: entitlement.plan,
    settings: setting,
    escalated: false,
  });
  await channel.send(payload);

  if (options.scheduleReconciliation !== false) {
    scheduleOpeningContextReconciliation(channel, options);
  }

  return {
    tracked: true,
    plan: entitlement.plan,
    payload,
  };
}

const channelCreateEvent = {
  name: Events.ChannelCreate,

  async execute(channel) {
    try {
      await trackTicketChannel(channel);
    } catch (error) {
      console.error("ChannelCreate ticket handler failed:", error);
    }
  },
};

module.exports = Object.assign(channelCreateEvent, {
  OPENING_RECONCILE_DELAYS_MS,
  scheduleOpeningContextReconciliation,
  trackTicketChannel,
});
