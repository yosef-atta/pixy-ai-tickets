const { Events, ChannelType } = require("discord.js");
const {
  reconcileTicketChannel,
} = require("../../tickets/ticketChannelLifecycle");

const event = {
  name: Events.ChannelUpdate,

  async execute(oldChannel, newChannel) {
    try {
      if (!newChannel?.guild) return;
      const wasText = oldChannel?.type === ChannelType.GuildText;
      const isText = newChannel.type === ChannelType.GuildText;
      if (!wasText && !isText) return;

      const parentChanged = oldChannel?.parentId !== newChannel.parentId;
      const typeChanged = oldChannel?.type !== newChannel.type;
      if (!parentChanged && !typeChanged) return;

      await reconcileTicketChannel(newChannel);
    } catch (error) {
      console.error("ChannelUpdate ticket reconciliation failed:", error);
    }
  },
};

module.exports = event;
