const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  deleteGuildOperationalData,
} = require("../data/guildOperationalCleanup");

const EPHEMERAL = 64;
const CONFIRM_PREFIX = "reset_guild_confirm:";
const CANCEL_PREFIX = "reset_guild_cancel:";

async function assertOwnerAndAdmin(interaction, ownerUserId) {
  if (
    !interaction.guild ||
    interaction.user.id !== ownerUserId ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    await interaction.reply({
      content: "Only the administrator who used `/pixy-reset` can confirm this action.",
      flags: EPHEMERAL,
    });
    return false;
  }
  return true;
}

const command = {
  data: new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Reset Pixy operational data for this server.")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  guildOnly: true,
  userPermissions: [PermissionFlagsBits.Administrator],

  async execute(interaction) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONFIRM_PREFIX}${interaction.user.id}`)
        .setLabel("Reset Pixy Data")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${CANCEL_PREFIX}${interaction.user.id}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content: [
        "This permanently resets Pixy's operational data for this server, including:",
        "- Ticket Sources and Human Support configuration",
        "- Learned knowledge and tracked ticket records",
        "- Excluded tickets and custom safety terms",
        "- Support routes and AI usage logs",
        "- Feature preferences, AI provider/model settings, and the encrypted provider credential",
        "",
        "Billing continuity is retained: Trial, Pro, Partner state and billing audit events are not deleted. Resetting Pixy does not grant another Trial.",
        "Discord channels, threads, categories, and roles are not deleted.",
      ].join("\n"),
      components: [row],
      flags: EPHEMERAL,
      allowedMentions: { parse: [] },
    });
  },

  buttonHandlers: [
    {
      customIdPrefix: CONFIRM_PREFIX,
      async execute(interaction) {
        const ownerUserId = interaction.customId.slice(CONFIRM_PREFIX.length);
        if (!(await assertOwnerAndAdmin(interaction, ownerUserId))) return;

        await interaction.deferUpdate();
        const result = await deleteGuildOperationalData(interaction.guild.id);
        await interaction.editReply({
          content: [
            "Done. Pixy's operational data for this server has been reset.",
            `Deleted records: **${result.totalDeleted}**`,
            "Trial, Pro, Partner, and billing audit records were retained for continuity and Trial-abuse prevention.",
            "The saved AI provider credential was removed. Run `/pixy-setup` to configure Pixy again; setup will not start another Trial.",
          ].join("\n"),
          components: [],
          allowedMentions: { parse: [] },
        });
      },
    },
    {
      customIdPrefix: CANCEL_PREFIX,
      async execute(interaction) {
        const ownerUserId = interaction.customId.slice(CANCEL_PREFIX.length);
        if (!(await assertOwnerAndAdmin(interaction, ownerUserId))) return;

        await interaction.update({
          content: "Cancelled. No Pixy data was reset.",
          components: [],
          allowedMentions: { parse: [] },
        });
      },
    },
  ],
};

module.exports = Object.assign(command, {
  CANCEL_PREFIX,
  CONFIRM_PREFIX,
  EPHEMERAL,
  assertOwnerAndAdmin,
});
