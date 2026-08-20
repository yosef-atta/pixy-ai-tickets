const { Events } = require("discord.js");
const {
  reconcileGuildTicketChannels,
} = require("../tickets/ticketChannelLifecycle");

module.exports = {
  name: Events.ClientReady,

  async execute(client) {
    console.log(`Bot is ready as ${client.user.tag}`);

    for (const guild of client.guilds.cache.values()) {
      try {
        const result = await reconcileGuildTicketChannels(guild);
        if (result.created || result.removed || result.failed) {
          console.log(
            `Reconciled Pixy tickets for ${guild.id}: ${result.created} tracked, ${result.removed} removed, ${result.failed} failed.`
          );
        }
      } catch (error) {
        console.error(`Failed to reconcile Pixy tickets for guild ${guild.id}:`, error);
      }
    }
  },
};
