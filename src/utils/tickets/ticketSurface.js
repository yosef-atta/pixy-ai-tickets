const { ChannelType, PermissionFlagsBits } = require("discord.js");

const THREAD_CHANNEL_TYPES = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

const THREAD_PARENT_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

const THREAD_PARENT_REQUIRED_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ReadMessageHistory,
]);

function isThreadTicketChannel(channel) {
  if (!channel) return false;
  if (THREAD_CHANNEL_TYPES.has(channel.type)) return true;
  return typeof channel.isThread === "function" && channel.isThread() === true;
}

function isThreadParentChannel(channel) {
  return Boolean(channel && THREAD_PARENT_CHANNEL_TYPES.has(channel.type));
}

function isCategoryTicketChannel(channel) {
  return channel?.type === ChannelType.GuildText;
}

function isSupportedTicketChannel(channel) {
  return isCategoryTicketChannel(channel) || isThreadTicketChannel(channel);
}

function getTicketSurfaceKind(channel) {
  if (isThreadTicketChannel(channel)) return "thread";
  if (isCategoryTicketChannel(channel)) return "channel";
  return "unsupported";
}

function getTicketSurfaceSettings(channel, settings = null) {
  if (!settings || !isThreadTicketChannel(channel)) return settings;

  // Thread tickets are always non-destructive overlays. A guild may use Full
  // Ticket Control for category-based ticket channels while thread tickets in
  // the same guild keep Close/Rename disabled and only allow safe handoff.
  return {
    ...settings,
    closeTicketEnabled: false,
    renameReviewEnabled: false,
  };
}

module.exports = {
  THREAD_CHANNEL_TYPES,
  THREAD_PARENT_CHANNEL_TYPES,
  THREAD_PARENT_REQUIRED_PERMISSIONS,
  getTicketSurfaceKind,
  getTicketSurfaceSettings,
  isCategoryTicketChannel,
  isSupportedTicketChannel,
  isThreadParentChannel,
  isThreadTicketChannel,
};
