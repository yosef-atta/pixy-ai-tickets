const { Events } = require("discord.js");
const {
  reconcileTicketChannel,
} = require("../../tickets/ticketChannelLifecycle");
const {
  isThreadTicketChannel,
} = require("../../utils/tickets/ticketSurface");

const event = {
  name: Events.ThreadUpdate,

  async execute(oldThread, newThread) {
    try {
      if (!isThreadTicketChannel(oldThread) && !isThreadTicketChannel(newThread)) return;
      if (!newThread?.guild) return;
      await reconcileTicketChannel(newThread);
    } catch (error) {
      console.error("ThreadUpdate ticket reconciliation failed:", error);
    }
  },
};

module.exports = event;
