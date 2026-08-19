const { ChannelType, PermissionFlagsBits } = require("discord.js");

const { prisma } = require("../../../config/prisma");
const { aiConfig } = require("../../../config/ai");

const {
  TICKET_ACTIONS,
  isAllowedTicketAction,
} = require("./ticketActionTypes");

const {
  getUnsafeTicketNameReason,
} = require("./renameSafety");

function cleanSingleLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeTicketName(value) {
  const text = String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 90)
    .replace(/^[-_]+|[-_]+$/g, "");

  return text;
}

function getTicketUserPrefix(message, ticket) {
  const rawName =
    message.author?.username ||
    message.member?.displayName ||
    ticket?.userId ||
    "user";

  return sanitizeTicketName(rawName) || "user";
}

function buildUserPrefixedTicketName({ message, ticket, name }) {
  const prefix = getTicketUserPrefix(message, ticket);
  const cleanName = sanitizeTicketName(name);

  if (!cleanName) return prefix;

  if (cleanName === prefix || cleanName.startsWith(`${prefix}-`)) {
    return cleanName;
  }

  return sanitizeTicketName(`${prefix}-${cleanName}`);
}

async function getBotMember(guild) {
  if (!guild) return null;

  if (guild.members?.me) {
    return guild.members.me;
  }

  try {
    return await guild.members.fetchMe();
  } catch {
    return null;
  }
}

async function botCanManageChannel(channel) {
  const botMember = await getBotMember(channel.guild);

  if (!botMember) return false;

  const permissions = channel.permissionsFor(botMember);

  return Boolean(permissions?.has(PermissionFlagsBits.ManageChannels));
}

async function getCategoryById(guild, categoryId) {
  if (!guild || !categoryId) return null;

  const cached = guild.channels.cache.get(categoryId);

  if (cached?.type === ChannelType.GuildCategory) {
    return cached;
  }

  try {
    const fetched = await guild.channels.fetch(categoryId);
    return fetched?.type === ChannelType.GuildCategory ? fetched : null;
  } catch {
    return null;
  }
}

async function getRoleById(guild, roleId) {
  if (!guild || !roleId) return null;

  const cached = guild.roles.cache.get(roleId);

  if (cached) return cached;

  try {
    return await guild.roles.fetch(roleId);
  } catch {
    return null;
  }
}

function getEscalationRoleId(data) {
  return cleanSingleLine(
    data?.roleId ||
      data?.role_id ||
      data?.supportRoleId ||
      data?.support_role_id ||
      data?.adminRoleId ||
      data?.admin_role_id
  );
}

function getProposedTicketName(data) {
  return (
    data?.name ||
    data?.channelName ||
    data?.newName ||
    data?.new_name ||
    data?.ticketName ||
    data?.ticket_name
  );
}

function buildFallbackEscalationName({ role, reason, currentChannelName }) {
  const rolePart = sanitizeTicketName(role?.name || "");
  const reasonPart = sanitizeTicketName(reason || "");
  const currentPart = sanitizeTicketName(currentChannelName || "");

  return (
    sanitizeTicketName(`${rolePart}-${reasonPart}`) ||
    sanitizeTicketName(`${rolePart}-ticket`) ||
    sanitizeTicketName(`escalated-${currentPart}`) ||
    "escalated-ticket"
  );
}

async function validateEscalateTicket({ actionRequest, message, ticket }) {
  if (!aiConfig.escalationEnabled) {
    return {
      ok: false,
      code: "escalation_disabled",
    };
  }

  if (ticket.escalated) {
    return {
      ok: false,
      code: "ticket_already_escalated",
    };
  }

  const config = await prisma.guildConfig.findUnique({
    where: {
      guildId: message.guild.id,
    },
    select: {
      escalationCategoryId: true,
    },
  });

  if (!config?.escalationCategoryId) {
    return {
      ok: false,
      code: "missing_escalation_category",
    };
  }

  const category = await getCategoryById(
    message.guild,
    config.escalationCategoryId
  );

  if (!category) {
    return {
      ok: false,
      code: "invalid_escalation_category",
    };
  }

  const roleId = getEscalationRoleId(actionRequest.data);

  if (!roleId) {
    return {
      ok: false,
      code: "missing_escalation_role",
    };
  }

  const route = await prisma.adminRoute.findFirst({
    where: {
      guildId: message.guild.id,
      roleId,
      enabled: true,
    },
  });

  if (!route) {
    return {
      ok: false,
      code: "escalation_role_not_configured",
    };
  }

  const role = await getRoleById(message.guild, roleId);

  if (!role || role.id === message.guild.id) {
    return {
      ok: false,
      code: "invalid_escalation_role",
    };
  }

  // Role pinging is intentionally not a prerequisite for escalation. Discord
  // can render the role reference without notifying it, while Pixy still
  // completes the handoff and pauses AI replies.
  const reason = cleanSingleLine(actionRequest.data?.reason).slice(0, 500);

  const proposedName = getProposedTicketName(actionRequest.data);
  const fallbackName = buildFallbackEscalationName({
    role,
    reason,
    currentChannelName: message.channel.name,
  });

  const sanitizedName = buildUserPrefixedTicketName({
    message,
    ticket,
    name: sanitizeTicketName(proposedName) || fallbackName,
  });

  if (!sanitizedName || sanitizedName.length < 2) {
    return {
      ok: false,
      code: "invalid_ticket_name",
    };
  }

  const unsafeReason = await getUnsafeTicketNameReason(
    message.guild?.id,
    `${proposedName || ""} ${sanitizedName || ""}`
  );

  if (unsafeReason) {
    return {
      ok: false,
      code: "unsafe_ticket_name",
      reason: unsafeReason,
    };
  }

  return {
    ok: true,
    action: TICKET_ACTIONS.ESCALATE_TICKET,
    data: {
      categoryId: category.id,
      categoryName: category.name,
      roleId: role.id,
      roleName: role.name,
      routeId: route.id,
      reason,
      name: sanitizedName,
    },
  };
}

async function validateTicketAction({ actionRequest, message, ticket }) {
  const action = String(actionRequest?.action || "").trim();

  if (!isAllowedTicketAction(action)) {
    return {
      ok: false,
      code: "unsupported_action",
    };
  }

  if (!message?.guild || !message?.channel) {
    return {
      ok: false,
      code: "invalid_context",
    };
  }

  if (message.channel.type !== ChannelType.GuildText) {
    return {
      ok: false,
      code: "invalid_channel_type",
    };
  }

  if (!ticket) {
    return {
      ok: false,
      code: "ticket_not_found",
    };
  }

  if (ticket.closed) {
    return {
      ok: false,
      code: "ticket_already_closed",
    };
  }

  if (action === TICKET_ACTIONS.CLOSE_TICKET) {
    if (!(await botCanManageChannel(message.channel))) {
      return {
        ok: false,
        code: "missing_manage_channels_permission",
      };
    }

    if (message.channel.deletable === false) {
      return {
        ok: false,
        code: "channel_not_deletable",
      };
    }

    return {
      ok: true,
      action,
      data: {},
    };
  }

  if (action === TICKET_ACTIONS.RENAME_TICKET) {
    if (!(await botCanManageChannel(message.channel))) {
      return {
        ok: false,
        code: "missing_manage_channels_permission",
      };
    }

    const proposedName = getProposedTicketName(actionRequest.data);
    const sanitizedName = buildUserPrefixedTicketName({
      message,
      ticket,
      name: proposedName,
    });

    if (!sanitizedName || sanitizedName.length < 2) {
      return {
        ok: false,
        code: "invalid_ticket_name",
      };
    }

    if (sanitizedName.length > 90) {
      return {
        ok: false,
        code: "ticket_name_too_long",
      };
    }

    if (sanitizedName === message.channel.name) {
      return {
        ok: false,
        code: "same_ticket_name",
      };
    }

    if (message.channel.manageable === false) {
      return {
        ok: false,
        code: "channel_not_manageable",
      };
    }

    const unsafeReason = await getUnsafeTicketNameReason(
      message.guild?.id,
      `${proposedName || ""} ${sanitizedName || ""}`
    );

    if (unsafeReason) {
      return {
        ok: false,
        code: "unsafe_ticket_name",
        reason: unsafeReason,
      };
    }

    return {
      ok: true,
      action,
      data: {
        name: sanitizedName,
      },
    };
  }

  if (action === TICKET_ACTIONS.ESCALATE_TICKET) {
    return validateEscalateTicket({
      actionRequest,
      message,
      ticket,
    });
  }

  return {
    ok: false,
    code: "unsupported_action",
  };
}

module.exports = {
  buildUserPrefixedTicketName,
  sanitizeTicketName,
  validateTicketAction,
};
