const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { prisma } = require("../config/prisma");
const {
  SUBSCRIPTION_REJECTION_MESSAGES,
  getGuildTicketActionAvailability,
  isSubscriptionRejectionCode,
} = require("../billing/entitlementService");
const { TICKET_ACTIONS } = require("../utils/tickets/actions/ticketActionTypes");

const ACTION_SELECT_ID = "ticket_control_action";

const ACTION_PREFIXES = Object.freeze({
  [TICKET_ACTIONS.CLOSE_TICKET]: ["ticket_control_close_confirm:"],
  [TICKET_ACTIONS.RENAME_TICKET]: ["ticket_control_rename_modal:"],
  [TICKET_ACTIONS.ESCALATE_TICKET]: [
    "ticket_control_escalate_ai:",
    "ticket_control_escalate_choose:",
    "ticket_control_escalate_role_select:",
    "ticket_control_escalate_ai_modal:",
    "ticket_control_escalate_role_modal:",
  ],
});

const DISABLED_MESSAGES = Object.freeze({
  ...SUBSCRIPTION_REJECTION_MESSAGES,
  setup_required:
    "Pixy core setup is not configured for this server. Run `/pixy-setup` first, then open `/pixy-settings` again.",
  agent_actions_disabled:
    "That ticket action isn't available right now. Please continue describing what you need here, and the support team can help.",
  close_ticket_disabled:
    "Closing tickets through Pixy isn't available right now. Please leave a message here if you need the support team to close it.",
  rename_review_disabled:
    "Ticket renaming isn't available right now. You can continue using this ticket normally.",
  escalation_disabled:
    "Human escalation isn't available right now. Please continue describing your issue here so the support team can review it.",
});

function getTicketControlAction(interaction) {
  const customId = String(interaction.customId || "");

  if (interaction.isStringSelectMenu?.() && customId === ACTION_SELECT_ID) {
    const selected = interaction.values?.[0];
    if (selected === "close") return TICKET_ACTIONS.CLOSE_TICKET;
    if (selected === "rename") return TICKET_ACTIONS.RENAME_TICKET;
    if (selected === "escalate") return TICKET_ACTIONS.ESCALATE_TICKET;
    return null;
  }

  for (const [action, prefixes] of Object.entries(ACTION_PREFIXES)) {
    if (prefixes.some((prefix) => customId.startsWith(prefix))) return action;
  }

  return null;
}

async function getHumanSupportAvailability(guild, options = {}) {
  const client = options.client || prisma;
  const [rolesFetched, channelsFetched] = await Promise.all([
    guild.roles.fetch().then(() => true).catch(() => false),
    guild.channels.fetch().then(() => true).catch(() => false),
  ]);

  const config = await client.guildConfig.findUnique({
    where: { guildId: guild.id },
    select: { escalationCategoryId: true },
  });

  if (!config?.escalationCategoryId) {
    return { available: false, code: "missing_escalation_category" };
  }

  const category = guild.channels.cache.get(config.escalationCategoryId);
  if (channelsFetched && (!category || category.type !== ChannelType.GuildCategory)) {
    return { available: false, code: "invalid_escalation_category" };
  }
  if (!category || category.type !== ChannelType.GuildCategory) {
    return { available: false, code: "escalation_category_unavailable" };
  }

  const routes = await client.adminRoute.findMany({
    where: { guildId: guild.id, enabled: true },
    select: { id: true, roleId: true },
    take: 25,
  });

  const invalidRoutes = rolesFetched
    ? routes.filter(({ roleId }) => roleId === guild.id || !guild.roles.cache.has(roleId))
    : [];

  if (invalidRoutes.length && typeof client.adminRoute.updateMany === "function") {
    await client.adminRoute.updateMany({
      where: {
        guildId: guild.id,
        id: { in: invalidRoutes.map(({ id }) => id).filter(Boolean) },
        enabled: true,
      },
      data: { enabled: false },
    }).catch(() => null);
  }

  const invalidRoleIds = new Set(invalidRoutes.map(({ roleId }) => roleId));
  const hasValidRoute = routes.some(({ roleId }) =>
    roleId !== guild.id &&
    !invalidRoleIds.has(roleId) &&
    (!rolesFetched || guild.roles.cache.has(roleId))
  );
  if (!hasValidRoute) {
    return {
      available: false,
      code: "no_support_routes",
      disabledMissingRoutes: invalidRoutes.length,
    };
  }

  return {
    available: true,
    code: null,
    disabledMissingRoutes: invalidRoutes.length,
  };
}

async function hasConfiguredSupportRoute(guild, options = {}) {
  const result = await getHumanSupportAvailability(guild, options);
  return result.available;
}

function getHumanSupportUnavailableMessage(interaction, code) {
  const userMessage =
    "Human escalation isn't available right now. Please continue describing your issue in this ticket so the support team can still review the conversation here.";

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return userMessage;
  }

  if (
    code === "missing_escalation_category" ||
    code === "invalid_escalation_category" ||
    code === "escalation_category_unavailable"
  ) {
    return `${userMessage}\n\nAdministrator note: open \`/pixy-setup\` and repair the Human Support escalation category.`;
  }

  return `${userMessage}\n\nAdministrator note: open \`/pixy-setup\` and add at least one valid Human Support role route.`;
}

function getNoRoutesMessage(interaction) {
  return getHumanSupportUnavailableMessage(interaction, "no_support_routes");
}

async function getTicketActionAvailability(interaction, options = {}) {
  const action = getTicketControlAction(interaction);
  if (!action || !interaction.guild || !interaction.channel) return null;

  const client = options.client || prisma;
  const ticket = await client.ticketChannel.findUnique({
    where: { channelId: interaction.channel.id },
    select: { closed: true, aiEnabled: true },
  });
  if (!ticket || ticket.closed) return null;

  const availability = await getGuildTicketActionAvailability(
    interaction.guild.id,
    action,
    {
      client,
      now: options.now,
    }
  );

  if (!availability.available) {
    return {
      available: false,
      action,
      code: availability.code,
      message:
        DISABLED_MESSAGES[availability.code] ||
        "That ticket action isn't available right now.",
      refreshControls: isSubscriptionRejectionCode(availability.code),
      aiEnabled: ticket.aiEnabled !== false,
    };
  }

  if (action === TICKET_ACTIONS.ESCALATE_TICKET) {
    const humanSupport = await getHumanSupportAvailability(interaction.guild, {
      client,
    });
    if (!humanSupport.available) {
      return {
        available: false,
        action,
        code: humanSupport.code,
        message: getHumanSupportUnavailableMessage(interaction, humanSupport.code),
        refreshControls: false,
        aiEnabled: ticket.aiEnabled !== false,
      };
    }
  }

  return {
    available: true,
    action,
    code: null,
    refreshControls: false,
    aiEnabled: ticket.aiEnabled !== false,
  };
}

module.exports = {
  ACTION_PREFIXES,
  ACTION_SELECT_ID,
  DISABLED_MESSAGES,
  getHumanSupportAvailability,
  getHumanSupportUnavailableMessage,
  getNoRoutesMessage,
  getTicketActionAvailability,
  getTicketControlAction,
  hasConfiguredSupportRoute,
};
