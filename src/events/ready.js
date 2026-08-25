const { Events } = require("discord.js");
const {
  syncBillingApplicationEmojis,
} = require("../config/applicationEmojis");
const {
  reconcileGuildTicketChannels,
} = require("../tickets/ticketChannelLifecycle");

module.exports = {
  name: Events.ClientReady,

  async execute(client) {
    console.log(`Bot is ready as ${client.user.tag}`);

    try {
      client.appEmojis = await syncBillingApplicationEmojis({
        token: client.appEnv?.token,
        clientId: client.appEnv?.clientId,
      });
      console.log(
        `Synced ${Object.keys(client.appEmojis).length} Pixy billing application emoji(s).`
      );
    } catch (error) {
      client.appEmojis = Object.freeze({});
      console.warn(
        `Billing application emoji sync failed; using Unicode fallbacks: ${error?.message || error}`
      );
    }

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
