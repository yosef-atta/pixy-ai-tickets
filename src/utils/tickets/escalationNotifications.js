const {
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");

const { prisma } = require("../../config/prisma");
const { aiConfig } = require("../../config/ai");
const {
  getBotMember,
  permissionLabel,
  refreshGuildRoles,
} = require("./humanSupportPermissions");
const {
  isThreadTicketChannel,
} = require("./ticketSurface");

const NOTIFICATION_REQUIRED_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
]);

function getNotificationChannelName() {
  return String(
    aiConfig.escalationNotificationChannelName || "pixy-notifications"
  )
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "") || "pixy-notifications";
}

function cleanText(value, maxLength = 1000) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, Math.max(1, Number(maxLength || 1000)));
}

function formatSummaryValue(value, fallback = "Not provided.") {
  if (Array.isArray(value)) {
    const items = value.map((item) => cleanText(item, 300)).filter(Boolean);
    return items.length ? items.map((item) => `• ${item}`).join("\n") : fallback;
  }

  const text = cleanText(value, 1000);
  return text || fallback;
}

async function getRecentTicketContext(ticketChannel) {
  try {
    const messages = await ticketChannel.messages.fetch({ limit: 20 });
    const recent = Array.from(messages.values())
      .filter((message) => !message.author?.bot && !message.webhookId)
      .filter((message) => cleanText(message.content, 500).length > 0)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-6)
      .map((message) => {
        const author = message.member?.displayName || message.author?.username || "User";
        return `• **${cleanText(author, 80)}:** ${cleanText(message.content, 350)}`;
      });

    return recent.length ? recent.join("\n") : "No recent user messages were available.";
  } catch {
    return "Recent ticket messages could not be loaded.";
  }
}

async function getExistingTextChannel(guild, channelId, categoryId) {
  if (!guild || !channelId) return null;

  const cached = guild.channels.cache.get(channelId);

  if (
    cached?.type === ChannelType.GuildText &&
    (!categoryId || cached.parentId === categoryId)
  ) {
    return cached;
  }

  try {
    const fetched = await guild.channels.fetch(channelId);

    if (
      fetched?.type === ChannelType.GuildText &&
      (!categoryId || fetched.parentId === categoryId)
    ) {
      return fetched;
    }
  } catch {
    return null;
  }

  return null;
}

async function findNotificationChannelInCategory(guild, categoryId) {
  if (!guild || !categoryId) return null;

  await guild.channels.fetch().catch(() => null);

  const wantedName = getNotificationChannelName();

  return (
    guild.channels.cache.find((channel) => {
      return (
        channel.type === ChannelType.GuildText &&
        channel.parentId === categoryId &&
        String(channel.name || "").toLowerCase() === wantedName
      );
    }) || null
  );
}

async function getFreshBotMember(guild) {
  if (!guild) return null;

  const botUserId = guild.client?.user?.id || guild.members?.me?.id || null;
  if (botUserId && typeof guild.members?.fetch === "function") {
    try {
      return await guild.members.fetch({ user: botUserId, force: true });
    } catch {
      // Fall back to fetchMe/cached member when Discord cannot be refreshed.
    }
  }

  if (typeof guild.members?.fetchMe === "function") {
    try {
      return await guild.members.fetchMe({ force: true });
    } catch {
      // Fall back to the cached member when Discord cannot be refreshed.
    }
  }

  return getBotMember(guild);
}

async function refreshNotificationChannel(channel) {
  if (!channel?.guild) return channel || null;

  if (typeof channel.fetch === "function") {
    try {
      return await channel.fetch(true);
    } catch {
      // Fall back to the guild channel manager below.
    }
  }

  if (channel.id && typeof channel.guild.channels?.fetch === "function") {
    try {
      return await channel.guild.channels.fetch(channel.id);
    } catch {
      return channel;
    }
  }

  return channel;
}

function labelsForPermissions(permissions = []) {
  return permissions.map(permissionLabel);
}

async function getNotificationChannelPermissionStatus(channel, options = {}) {
  if (!channel?.guild) {
    return {
      ok: false,
      channel: channel || null,
      missingPermissions: [...NOTIFICATION_REQUIRED_PERMISSIONS],
      missingPermissionLabels: NOTIFICATION_REQUIRED_PERMISSIONS.map(permissionLabel),
      missingBasePermissions: [...NOTIFICATION_REQUIRED_PERMISSIONS],
      missingBasePermissionLabels: NOTIFICATION_REQUIRED_PERMISSIONS.map(permissionLabel),
      blockedByOverwritePermissions: [],
      blockedByOverwritePermissionLabels: [],
    };
  }

  let resolvedChannel = channel;
  const guild = channel.guild;

  if (options.refresh === true) {
    await refreshGuildRoles(guild);
    resolvedChannel = await refreshNotificationChannel(channel) || channel;
  }

  const botMember = options.refresh === true
    ? await getFreshBotMember(guild)
    : await getBotMember(guild);
  const effectivePermissions = botMember
    ? resolvedChannel.permissionsFor(botMember)
    : null;
  const basePermissions = botMember?.permissions || null;

  const missingPermissions = NOTIFICATION_REQUIRED_PERMISSIONS.filter(
    (permission) => !effectivePermissions?.has(permission)
  );
  const missingBasePermissions = missingPermissions.filter(
    (permission) => !basePermissions?.has(permission)
  );
  const blockedByOverwritePermissions = missingPermissions.filter(
    (permission) => basePermissions?.has(permission)
  );

  return {
    ok: missingPermissions.length === 0,
    channel: resolvedChannel,
    missingPermissions,
    missingPermissionLabels: labelsForPermissions(missingPermissions),
    missingBasePermissions,
    missingBasePermissionLabels: labelsForPermissions(missingBasePermissions),
    blockedByOverwritePermissions,
    blockedByOverwritePermissionLabels: labelsForPermissions(blockedByOverwritePermissions),
  };
}

async function canSendInChannel(channel) {
  const status = await getNotificationChannelPermissionStatus(channel);
  return status.ok;
}

async function canMentionRoleInChannel(channel, role) {
  if (!channel || !role) return false;
  if (role.mentionable) return true;

  const botMember = await getBotMember(channel.guild);
  if (!botMember) return false;

  const permissions = channel.permissionsFor(botMember);
  return Boolean(permissions?.has(PermissionFlagsBits.MentionEveryone));
}

async function getOrCreateEscalationNotificationChannel({
  guild,
  categoryId,
  existingChannelId,
  client = prisma,
}) {
  if (!guild || !categoryId) {
    return {
      ok: false,
      code: "missing_escalation_category",
    };
  }

  let channel = await getExistingTextChannel(
    guild,
    existingChannelId,
    categoryId
  );

  if (!channel) {
    channel = await findNotificationChannelInCategory(guild, categoryId);
  }

  if (!channel) {
    await refreshGuildRoles(guild);
    const botMember = await getFreshBotMember(guild);

    if (!botMember?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      return {
        ok: false,
        code: "missing_manage_channels_permission",
        missingPermissionLabels: [permissionLabel(PermissionFlagsBits.ManageChannels)],
      };
    }

    try {
      channel = await guild.channels.create({
        name: getNotificationChannelName(),
        type: ChannelType.GuildText,
        parent: categoryId,
        reason: "Pixy AI escalation notification channel setup",
      });
    } catch {
      return {
        ok: false,
        code: "notification_channel_create_failed",
      };
    }
  }

  const permissionStatus = await getNotificationChannelPermissionStatus(channel, {
    refresh: true,
  });
  channel = permissionStatus.channel || channel;

  if (!permissionStatus.ok) {
    return {
      ok: false,
      code: "missing_notification_channel_permissions",
      channel,
      missingPermissions: permissionStatus.missingPermissions,
      missingPermissionLabels: permissionStatus.missingPermissionLabels,
      missingBasePermissions: permissionStatus.missingBasePermissions,
      missingBasePermissionLabels: permissionStatus.missingBasePermissionLabels,
      blockedByOverwritePermissions: permissionStatus.blockedByOverwritePermissions,
      blockedByOverwritePermissionLabels: permissionStatus.blockedByOverwritePermissionLabels,
    };
  }

  await client.guildConfig.update({
    where: {
      guildId: guild.id,
    },
    data: {
      escalationNotificationChannelId: channel.id,
    },
  });

  return {
    ok: true,
    channel,
  };
}

async function sendEscalationNotification({
  notificationChannel,
  ticketChannel,
  role,
  reason,
  routeId,
  requestedBy,
  newName,
  summary,
}) {
  const recentContext = await getRecentTicketContext(ticketChannel);
  const details = summary && typeof summary === "object" && !Array.isArray(summary)
    ? summary
    : {};
  const roleCanBePinged = await canMentionRoleInChannel(notificationChannel, role);
  const threadTicket = isThreadTicketChannel(ticketChannel);

  const sections = [
    "🚨 **Ticket Escalated**",
    "",
    `**${threadTicket ? "Ticket Thread" : "Ticket Channel"}:** <#${ticketChannel.id}>`,
    `**Support Role:** <@&${role.id}>`,
    `**Support Team:** ${role.name}`,
    roleCanBePinged ? null : "**Role Ping:** Not sent — the role is not mentionable. The handoff still completed.",
    `**${threadTicket ? "Thread Name" : "New Ticket Name"}:** ${newName || ticketChannel.name}`,
    routeId ? `**Route ID:** \`${routeId}\`` : null,
    requestedBy
      ? `**Requested By:** ${requestedBy.tag || requestedBy.username || requestedBy.id} (${requestedBy.id})`
      : null,
    "",
    "**User Issue**",
    formatSummaryValue(details.userIssue || details.issue || reason, "No issue summary was provided."),
    "",
    "**Environment**",
    formatSummaryValue(details.environment),
    "",
    "**Already Checked**",
    formatSummaryValue(details.alreadyChecked || details.troubleshooting),
    "",
    "**Observed Error**",
    formatSummaryValue(details.observedError || details.error),
    "",
    "**Likely Cause**",
    formatSummaryValue(details.likelyCause || details.cause, "Unknown — staff review is required."),
    "",
    "**Requires Staff**",
    `Yes — ${formatSummaryValue(details.requiresStaff || reason, "Human review was requested.")}`,
    "",
    "**Recent Ticket Context**",
    recentContext,
  ].filter(Boolean);

  let content = sections.join("\n");
  if (content.length > 1950) {
    content = `${content.slice(0, 1947).trim()}...`;
  }

  const message = await notificationChannel.send({
    content,
    allowedMentions: {
      roles: roleCanBePinged ? [role.id] : [],
      users: [],
      repliedUser: false,
    },
  });

  return Object.assign(message, {
    pixyRolePinged: roleCanBePinged,
  });
}

module.exports = {
  NOTIFICATION_REQUIRED_PERMISSIONS,
  canMentionRoleInChannel,
  canSendInChannel,
  getFreshBotMember,
  getNotificationChannelPermissionStatus,
  getOrCreateEscalationNotificationChannel,
  refreshNotificationChannel,
  sendEscalationNotification,
};