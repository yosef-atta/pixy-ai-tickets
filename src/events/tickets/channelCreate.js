const { Events } = require("discord.js");
const {
  trackTicketChannel,
} = require("../../tickets/ticketChannelLifecycle");
const { reconcileOpeningContext } = require("./openingContext");

const OPENING_RECONCILE_DELAYS_MS = [500, 2000];

function scheduleOpeningContextReconciliation(channel, options = {}) {
  const reconcile = options.reconcile || reconcileOpeningContext;
  const delays = options.delays || OPENING_RECONCILE_DELAYS_MS;

  return delays.map((delayMs) => {
    const timer = setTimeout(() => {
      reconcile(channel).catch((error) => {
        console.error("Delayed opening context reconciliation failed:", error);
      });
    }, delayMs);
    timer.unref?.();
    return timer;
  });
}

const channelCreateEvent = {
  name: Events.ChannelCreate,

  async execute(channel) {
    try {
      const result = await trackTicketChannel(channel);
      if (result.tracked) {
        scheduleOpeningContextReconciliation(channel);
      }
    } catch (error) {
      console.error("ChannelCreate ticket handler failed:", error);
    }
  },
};

module.exports = Object.assign(channelCreateEvent, {
  OPENING_RECONCILE_DELAYS_MS,
  scheduleOpeningContextReconciliation,
  trackTicketChannel,
});
