const { Events } = require("discord.js");
const {
  cleanupDeletedTicketChannel,
} = require("../../tickets/ticketChannelLifecycle");
const {
  isThreadTicketChannel,
} = require("../../utils/tickets/ticketSurface");

const event = {
  name: Events.ThreadDelete,

  async execute(thread) {
    try {
      if (!isThreadTicketChannel(thread)) return;
      await cleanupDeletedTicketChannel(thread);
    } catch (error) {
      console.error("ThreadDelete ticket cleanup failed:", error);
    }
  },
};

module.exports = event;
