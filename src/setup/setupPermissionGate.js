const { PermissionFlagsBits } = require("discord.js");

const SETUP_REQUIRED_PERMISSIONS = Object.freeze([
  Object.freeze({
    flag: PermissionFlagsBits.ViewChannel,
    label: "View Channel",
    reason: "lets Pixy access configured ticket and Human Support channels",
  }),
  Object.freeze({
    flag: PermissionFlagsBits.SendMessages,
    label: "Send Messages",
    reason: "lets Pixy reply in channel tickets and post Human Support notifications",
  }),
  Object.freeze({
    flag: PermissionFlagsBits.SendMessagesInThreads,
    label: "Send Messages in Threads",
    reason: "lets Pixy reply inside Thread tickets",
  }),
  Object.freeze({
    flag: PermissionFlagsBits.ReadMessageHistory,
    label: "Read Message History",
    reason: "lets Pixy use the ticket conversation as context",
  }),
  Object.freeze({
    flag: PermissionFlagsBits.ManageChannels,
    label: "Manage Channels",
    reason: "lets Pixy create setup resources and use Full Ticket Control on channel tickets",
  }),
  Object.freeze({
    flag: PermissionFlagsBits.ManageRoles,
    label: "Manage Roles",
    reason: "lets Pixy prepare channel permission overwrites for ticket access and Full Ticket Control",
  }),
]);

const ACCESS_PROFILES = Object.freeze({
  CATEGORY_SOURCE: Object.freeze({
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    ManageChannels: true,
    ManageRoles: true,
  }),
  THREAD_PARENT: Object.freeze({
    ViewChannel: true,
    SendMessages: true,
    SendMessagesInThreads: true,
    ReadMessageHistory: true,
  }),
  HUMAN_SUPPORT_CATEGORY: Object.freeze({
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    ManageChannels: true,
    ManageRoles: true,
  }),
  HUMAN_SUPPORT_NOTIFICATION: Object.freeze({
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  }),
});

async function fetchFreshBotMember(guild) {
  if (!guild) return null;

  const botUserId = guild.client?.user?.id || guild.members?.me?.id || null;
  if (botUserId && typeof guild.members?.fetch === "function") {
    try {
      return await guild.members.fetch({ user: botUserId, force: true });
    } catch {
      // Fall through to fetchMe/cached member.
    }
  }

  if (typeof guild.members?.fetchMe === "function") {
    try {
      return await guild.members.fetchMe({ force: true });
    } catch {
      // Fall through to cached member.
    }
  }

  return guild.members?.me || null;
}

async function checkSetupPermissions(guild) {
  const member = await fetchFreshBotMember(guild);
  if (!member?.permissions) {
    return {
      ok: false,
      code: "bot_member_unavailable",
      member: member || null,
      missing: [...SETUP_REQUIRED_PERMISSIONS],
    };
  }

  const missing = SETUP_REQUIRED_PERMISSIONS.filter(
    ({ flag }) => !member.permissions.has(flag)
  );

  return {
    ok: missing.length === 0,
    code: missing.length ? "missing_setup_permissions" : null,
    member,
    missing,
  };
}

async function ensureChannelAccess(channel, member, profile, reason) {
  if (!channel || !member || !profile) {
    return { ok: false, code: "invalid_channel_access_request" };
  }

  const manager = channel.permissionOverwrites;
  if (!manager || typeof manager.edit !== "function") {
    return { ok: false, code: "permission_overwrite_unavailable" };
  }

  try {
    await manager.edit(
      member.user || member.id,
      profile,
      { reason: reason || "Pixy setup access" }
    );
    return { ok: true, channel };
  } catch (error) {
    return {
      ok: false,
      code: "permission_overwrite_failed",
      channel,
      error,
    };
  }
}

async function prepareTicketSourceAccess(guild, channels, type) {
  const status = await checkSetupPermissions(guild);
  if (!status.ok) return status;

  const profile = type === "thread_parent"
    ? ACCESS_PROFILES.THREAD_PARENT
    : ACCESS_PROFILES.CATEGORY_SOURCE;
  const failed = [];

  for (const channel of channels || []) {
    const result = await ensureChannelAccess(
      channel,
      status.member,
      profile,
      "Pixy Ticket Source setup access"
    );
    if (!result.ok) failed.push({ channel, ...result });
  }

  return {
    ok: failed.length === 0,
    code: failed.length ? "ticket_source_access_failed" : null,
    member: status.member,
    failed,
  };
}

async function prepareHumanSupportCategoryAccess(guild, category) {
  const status = await checkSetupPermissions(guild);
  if (!status.ok) return status;

  const result = await ensureChannelAccess(
    category,
    status.member,
    ACCESS_PROFILES.HUMAN_SUPPORT_CATEGORY,
    "Pixy Human Support category access"
  );

  return {
    ...result,
    member: status.member,
  };
}

async function prepareHumanSupportNotificationAccess(channel, member) {
  return ensureChannelAccess(
    channel,
    member,
    ACCESS_PROFILES.HUMAN_SUPPORT_NOTIFICATION,
    "Pixy Human Support notification access"
  );
}

module.exports = {
  ACCESS_PROFILES,
  SETUP_REQUIRED_PERMISSIONS,
  checkSetupPermissions,
  ensureChannelAccess,
  fetchFreshBotMember,
  prepareHumanSupportCategoryAccess,
  prepareHumanSupportNotificationAccess,
  prepareTicketSourceAccess,
};
