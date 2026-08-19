const { Events } = require("discord.js");
const {
  trackTicketChannel,
} = require("../../tickets/ticketChannelLifecycle");
const {
  scheduleOpeningContextReconciliation,
} = require("./channelCreate");
const {
  isThreadTicketChannel,
} = require("../../utils/tickets/ticketSurface");

const event = {
  name: Events.ThreadCreate,

  async execute(thread) {
    try {
      if (!isThreadTicketChannel(thread)) return;
      const result = await trackTicketChannel(thread);
      if (result.tracked) {
        scheduleOpeningContextReconciliation(thread);
      }
    } catch (error) {
      console.error("ThreadCreate ticket handler failed:", error);
    }
  },
};

module.exports = event;
