const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");

const setup = require("../slash/setup");
const { prisma } = require("../config/prisma");
const { SETUP_STEPS } = require("../config/productDefaults");
const { getOrCreateSetupState } = require("../config/setupState");
const {
  SETUP_REQUIRED_PERMISSIONS,
  checkSetupPermissions,
  clearSetupPermissionVerification,
} = require("../setup/setupPermissionGate");

const EPHEMERAL = 64;
const CHECK_PREFIX = "setup11_permission_check:";

const checkId = (userId) => `${CHECK_PREFIX}${userId}`;

function permissionList(items = SETUP_REQUIRED_PERMISSIONS) {
  return items
    .map(({ label, reason }) => `• **${label}** — ${reason}`)
    .join("\n");
}

function renderPermissionStart(userId) {
  const embed = new EmbedBuilder()
    .setTitle("Pixy Setup — Permission Check")
    .setDescription([
      "Before setup continues, Pixy needs to verify the Discord permissions used by the full feature set.",
      "Nothing is being checked yet. Press **Start Checks** when you're ready; Pixy will acknowledge the button first, then run the slower Discord checks safely.",
    ].join("\n"))
    .addFields({
      name: `Permissions to check — ${SETUP_REQUIRED_PERMISSIONS.length}`,
      value: permissionList().slice(0, 1024),
      inline: false,
    });

  return {
    content: null,
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(checkId(userId))
        .setLabel("Start Checks")
        .setStyle(ButtonStyle.Primary)
    )],
    allowedMentions: { parse: [] },
  };
}

function renderChecking() {
  const total = SETUP_REQUIRED_PERMISSIONS.length;
  const embed = new EmbedBuilder()
    .setTitle("Pixy Setup — Checking Permissions")
    .setDescription("Pixy is refreshing its server permissions from Discord. This can take a few seconds.")
    .addFields({
      name: "Progress",
      value: `**0 / ${total} checked** — waiting for Discord permission data...`,
      inline: false,
    });

  return {
    content: null,
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("setup11_permission_check_running")
        .setLabel("Checking...")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    )],
    allowedMentions: { parse: [] },
  };
}

function renderPermissionResult(status, userId) {
  const total = SETUP_REQUIRED_PERMISSIONS.length;
  const missing = status?.missing || SETUP_REQUIRED_PERMISSIONS;
  const ready = Math.max(0, total - missing.length);
  const memberUnavailable = status?.code === "bot_member_unavailable";

  const embed = new EmbedBuilder()
    .setTitle("Pixy Setup — Permission Check")
    .setDescription(
      memberUnavailable
        ? "Pixy could not refresh its bot member from Discord. Try the check again in a moment."
        : "The permission check finished. Add the missing permissions to Pixy's bot role, then recheck."
    )
    .addFields(
      {
        name: "Result",
        value: `**${ready} / ${total} ready**${missing.length ? ` — ${missing.length} missing` : ""}`,
        inline: false,
      },
      {
        name: `Missing Permissions — ${missing.length}`,
        value: missing.length ? permissionList(missing).slice(0, 1024) : "None.",
        inline: false,
      }
    );

  return {
    content: null,
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(checkId(userId))
        .setLabel("Recheck Permissions")
        .setStyle(ButtonStyle.Primary)
    )],
    allowedMentions: { parse: [] },
  };
}

async function assertOwner(interaction, userId) {
  const allowed =
    interaction.guild &&
    interaction.user.id === userId &&
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  if (allowed) return true;

  await interaction.reply({
    content: "Only the administrator who opened `/pixy-setup` can use this control.",
    flags: EPHEMERAL,
  });
  return false;
}

async function editPanel(interaction, payload) {
  await interaction.editReply({
    ...payload,
    allowedMentions: payload.allowedMentions || { parse: [] },
  });
}

async function getExistingHumanCategory(guild) {
  const config = await prisma.guildConfig.findUnique({
    where: { guildId: guild.id },
    select: { escalationCategoryId: true },
  });
  if (!config?.escalationCategoryId) return null;

  const cached = guild.channels?.cache?.get(config.escalationCategoryId);
  if (cached?.type === ChannelType.GuildCategory) return cached;
  const fetched = await guild.channels?.fetch?.(config.escalationCategoryId).catch(() => null);
  return fetched?.type === ChannelType.GuildCategory ? fetched : null;
}

async function renderCurrentStepAfterCheck(guild, userId, state) {
  const notice = `Permission check complete — **${SETUP_REQUIRED_PERMISSIONS.length}/${SETUP_REQUIRED_PERMISSIONS.length} ready**.`;

  if (state.lastStep === SETUP_STEPS.AI_PROVIDER) {
    return setup.renderOnboardingAiProvider(guild.id, userId, notice);
  }

  if (state.lastStep === SETUP_STEPS.HUMAN_SUPPORT) {
    const category = await getExistingHumanCategory(guild);
    if (category) {
      await setup.prepareHumanSupportResources(guild, category).catch(() => null);
    }
    return setup.renderHumanSupport(guild, userId, setup.MODE.ONBOARD, notice);
  }

  return setup.renderOnboardingTicketSources(guild, userId, notice);
}

const previousExecute = setup.execute.bind(setup);
setup.execute = async function executeSetupWithPermissionStart(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: EPHEMERAL });
  }

  const state = await getOrCreateSetupState(interaction.guild.id);
  if (state.completedAt) {
    const payload = await setup.renderDashboard(interaction.guild, interaction.user.id);
    await editPanel(interaction, payload);
    return;
  }

  clearSetupPermissionVerification(interaction.guild.id);
  await editPanel(interaction, renderPermissionStart(interaction.user.id));
};

module.exports = {
  buttonHandlers: [
    {
      customIdPrefix: CHECK_PREFIX,
      async execute(interaction) {
        const userId = String(interaction.customId || "").slice(CHECK_PREFIX.length);
        if (!(await assertOwner(interaction, userId))) return;

        await interaction.deferUpdate();
        await editPanel(interaction, renderChecking());

        const status = await checkSetupPermissions(interaction.guild, { force: true });
        if (!status.ok) {
          await editPanel(interaction, renderPermissionResult(status, userId));
          return;
        }

        const state = await getOrCreateSetupState(interaction.guild.id);
        const payload = await renderCurrentStepAfterCheck(
          interaction.guild,
          userId,
          state
        );
        await editPanel(interaction, payload);
      },
    },
  ],
  CHECK_PREFIX,
  previousExecute,
  renderChecking,
  renderCurrentStepAfterCheck,
  renderPermissionResult,
  renderPermissionStart,
};
