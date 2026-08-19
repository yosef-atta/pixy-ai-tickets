const {
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");

const { prisma } = require("../../config/prisma");
const { aiConfig } = require("../../config/ai");
const {
  getBotMember,
} = require("./humanSupportPermissions");

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

async function canSendInChannel(channel) {
  const botMember = await getBotMember(channel?.guild);
  if (!botMember) return false;

  const permissions = channel.permissionsFor(botMember);

  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
      permissions?.has(PermissionFlagsBits.SendMessages)
  );
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
    const botMember = await getBotMember(guild);

    if (!botMember?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      return {
        ok: false,
        code: "missing_manage_channels_permission",
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

  const canSend = await canSendInChannel(channel);

  if (!canSend) {
    return {
      ok: false,
      code: "missing_notification_channel_send_permission",
    };
  }

  await prisma.guildConfig.update({
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

  const sections = [
    "🚨 **Ticket Escalated**",
    "",
    `**Ticket Channel:** <#${ticketChannel.id}>`,
    `**Support Role:** <@&${role.id}>`,
    `**Support Team:** ${role.name}`,
    roleCanBePinged ? null : "**Role Ping:** Not sent — the role is not mentionable. The handoff still completed.",
    `**New Ticket Name:** ${newName || ticketChannel.name}`,
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
  canMentionRoleInChannel,
  canSendInChannel,
  getOrCreateEscalationNotificationChannel,
  sendEscalationNotification,
};
