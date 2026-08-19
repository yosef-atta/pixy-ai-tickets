const {
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");

const { prisma } = require("../config/prisma");
const { getOrCreateGuildSetting } = require("../config/ai");
const {
  refreshOpenTicketControlsForGuild,
} = require("../billing/ticketControlRefresh");
const {
  TICKET_OPERATING_MODES,
  getTicketOperatingModePreferences,
  resolveTicketOperatingMode,
} = require("../features/ticketOperatingMode");
const {
  preflightFullControlForGuild,
} = require("../utils/tickets/humanSupportPermissions");

const EPHEMERAL = 64;

function describeMode(mode) {
  if (mode === TICKET_OPERATING_MODES.FULL) {
    return [
      "**Full Ticket Control**",
      "Pixy can expose Close and Rename controls, and escalation may move/rename the ticket and adjust support-role access.",
      "Use this when Pixy is intended to participate in the ticket lifecycle.",
    ].join("\n");
  }

  if (mode === TICKET_OPERATING_MODES.OVERLAY) {
    return [
      "**Smart Overlay** — recommended",
      "Pixy focuses on AI support without taking over the ticket lifecycle. Close and Rename stay hidden.",
      "Human handoff remains available only when Human Support is configured and Escalation is enabled in `/pixy-settings`.",
      "Use this when another ticket bot or a custom ticket system already manages the ticket.",
    ].join("\n");
  }

  return [
    "**Custom**",
    "This server has a mixed set of ticket-action preferences.",
    "Use `/pixy-settings` to adjust Close, Rename, and Escalation individually, or set a preset with this command.",
  ].join("\n");
}

function formatPreflightIssues(preflight) {
  const lines = [];
  for (const issue of preflight?.issues || []) {
    if (issue.sourceName) {
      lines.push(`• **${issue.sourceName}**: ${issue.labels.join(", ") || issue.code || "permission check failed"}`);
      continue;
    }
    const scope = issue.scope === "server" ? "Server permissions" : issue.scope || "Pixy";
    lines.push(`• **${scope}**: ${issue.labels.join(", ") || issue.code || "permission check failed"}`);
  }
  return lines.join("\n") || "• Pixy could not verify the permissions required for Full Ticket Control.";
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("mode")
    .setDescription("View or change how Pixy interacts with your ticket system.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Choose a Pixy ticket operating mode.")
        .setRequired(false)
        .addChoices(
          { name: "Smart Overlay (recommended)", value: TICKET_OPERATING_MODES.OVERLAY },
          { name: "Full Ticket Control", value: TICKET_OPERATING_MODES.FULL }
        )
    ),
  guildOnly: true,
  userPermissions: [PermissionFlagsBits.Administrator],

  async execute(interaction) {
    const current = await getOrCreateGuildSetting(interaction.guild.id);
    const requestedMode = interaction.options.getString("mode");

    if (!requestedMode) {
      const currentMode = resolveTicketOperatingMode(current);
      await interaction.reply({
        content: `Current mode:\n${describeMode(currentMode)}`,
        flags: EPHEMERAL,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const preferences = getTicketOperatingModePreferences(requestedMode);
    if (!preferences) {
      await interaction.reply({
        content: "That Pixy operating mode is not supported.",
        flags: EPHEMERAL,
      });
      return;
    }

    if (requestedMode === TICKET_OPERATING_MODES.FULL) {
      const preflight = await preflightFullControlForGuild(interaction.guild);
      if (!preflight.ok) {
        await interaction.reply({
          content: [
            "Full Ticket Control was **not enabled** because Pixy is missing required permissions or Human Support setup.",
            "",
            formatPreflightIssues(preflight),
            "",
            "Smart Overlay can keep working without these destructive permissions. Fix the items above in `/pixy-setup`, then enable Full Ticket Control again.",
          ].join("\n"),
          flags: EPHEMERAL,
          allowedMentions: { parse: [] },
        });
        return;
      }
    }

    await prisma.guildSetting.update({
      where: { guildId: interaction.guild.id },
      data: preferences,
    });

    const refreshResult = await refreshOpenTicketControlsForGuild(
      interaction.guild.id,
      {
        guild: interaction.guild,
        discordClient: interaction.client,
      }
    );

    const refreshNote = refreshResult.ok
      ? `Updated ${refreshResult.refreshed} open ticket control panel(s).`
      : "The mode was saved, but one or more existing ticket control panels could not be refreshed immediately.";

    await interaction.reply({
      content: `${describeMode(requestedMode)}\n\n${refreshNote}`,
      flags: EPHEMERAL,
      allowedMentions: { parse: [] },
    });
  },
};