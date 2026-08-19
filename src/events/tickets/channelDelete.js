const { Events, ChannelType } = require("discord.js");
const {
  cleanupDeletedTicketChannel,
} = require("../../tickets/ticketChannelLifecycle");

const event = {
  name: Events.ChannelDelete,

  async execute(channel) {
    try {
      if (channel?.type !== ChannelType.GuildText) return;
      await cleanupDeletedTicketChannel(channel);
    } catch (error) {
      console.error("ChannelDelete ticket cleanup failed:", error);
    }
  },
};

module.exports = event;
