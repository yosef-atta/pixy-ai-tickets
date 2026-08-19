const {
  ActionRowBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require("discord.js");

const core = require("../setup/setupCommandCore");
const { prisma } = require("../config/prisma");
const { SETUP_STEPS } = require("../config/productDefaults");
const { getOrCreateSetupState } = require("../config/setupState");
const {
  listAiProviders,
} = require("../ai/providers/providerRegistry");
const {
  setGuildAiProvider,
} = require("../config/guildAiConfig");
const {
  listSetupTicketSources,
  moveSetupToAiProvider,
} = require("../setup/setupService");

const EPHEMERAL = 64;
const { MODE, PREFIX } = core;

const scoped = (prefix, mode, userId) => `${prefix}${mode}:${userId}`;

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

async function deferUpdate(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate();
  }
}

async function editPanel(interaction, payload) {
  const next = {
    ...payload,
    allowedMentions: payload.allowedMentions || { parse: [] },
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(next);
  } else {
    await interaction.update(next);
  }
}

function orderedProviders(providers = listAiProviders()) {
  return [...providers].sort((left, right) =>
    left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" })
  );
}

async function getSavedAiProviderRecord(guildId, options = {}) {
  const client = options.client || prisma;
  return client.guildAiConfig.findUnique({
    where: { guildId: String(guildId) },
    select: {
      guildId: true,
      provider: true,
    },
  });
}

function buildInitialProviderChoice(userId, notice = null, providers = listAiProviders()) {
  const availableProviders = orderedProviders(providers);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(scoped(PREFIX.AI_PROVIDER, MODE.ONBOARD, userId))
    .setPlaceholder("Choose an AI provider...")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(availableProviders.slice(0, 25).map((provider) => ({
      label: provider.displayName.slice(0, 100),
      value: provider.id,
      description: `Default model: ${provider.defaultModel}`.slice(0, 100),
    })));

  const embed = new EmbedBuilder()
    .setTitle("Pixy Setup — 2/3 AI Provider")
    .setDescription([
      "Choose which AI provider this server should use.",
      "Pixy does **not** preselect or prefer one provider here — pick the provider that fits your server.",
      "After you choose, Pixy will show that provider's credential and model controls.",
    ].join("\n"))
    .addFields(
      {
        name: "Provider",
        value: "Not selected yet — choose one below.",
        inline: false,
      },
      {
        name: "Available",
        value: availableProviders.map((provider) => `**${provider.displayName}**`).join(" • "),
        inline: false,
      }
    );

  return {
    content: notice,
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

async function renderOnboardingAiProvider(guildId, userId, notice = null) {
  const saved = await getSavedAiProviderRecord(guildId);
  if (saved) {
    return core.renderAiProvider(guildId, userId, MODE.ONBOARD, notice);
  }
  return buildInitialProviderChoice(userId, notice);
}

const originalExecute = core.execute.bind(core);
core.execute = async function execute(interaction) {
  const state = await getOrCreateSetupState(interaction.guild.id);
  if (!state.completedAt && state.lastStep === SETUP_STEPS.AI_PROVIDER) {
    const payload = await renderOnboardingAiProvider(
      interaction.guild.id,
      interaction.user.id
    );
    await interaction.reply({
      ...payload,
      flags: EPHEMERAL,
      allowedMentions: { parse: [] },
    });
    return;
  }

  return originalExecute(interaction);
};

const ticketNextHandler = core.buttonHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.TICKET_NEXT
);
if (!ticketNextHandler) {
  throw new Error("Pixy setup Ticket Sources -> AI Provider handler is missing.");
}

ticketNextHandler.execute = async function executeTicketNext(interaction) {
  const { userId } = core.parseScoped(interaction.customId, PREFIX.TICKET_NEXT);
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  const sources = await listSetupTicketSources(interaction.guild.id);
  if (!sources.length) {
    await editPanel(
      interaction,
      await core.renderOnboardingTicketSources(
        interaction.guild,
        userId,
        "Add at least one Category or Thread Parent before continuing."
      )
    );
    return;
  }

  await moveSetupToAiProvider(interaction.guild.id);
  await editPanel(
    interaction,
    await renderOnboardingAiProvider(
      interaction.guild.id,
      userId,
      `Saved ${sources.length} Ticket Source${sources.length === 1 ? "" : "s"}. Choose an AI provider to continue.`
    )
  );
};

const providerSelectHandler = core.selectMenuHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.AI_PROVIDER
);
if (!providerSelectHandler) {
  throw new Error("Pixy setup AI Provider select handler is missing.");
}

providerSelectHandler.execute = async function executeProviderSelect(interaction) {
  const { mode, userId } = core.parseScoped(interaction.customId, PREFIX.AI_PROVIDER);
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  const providerId = interaction.values?.[0];
  const previous = await getSavedAiProviderRecord(interaction.guild.id);
  const ai = await setGuildAiProvider(interaction.guild.id, providerId);

  let notice;
  if (!previous) {
    notice = `Selected **${ai.providerDefinition.displayName}**. Configure this server's credential to continue.`;
  } else if (previous.provider !== ai.provider) {
    notice = `AI provider changed to **${ai.providerDefinition.displayName}**. Configure its credential before continuing.`;
  } else {
    notice = `AI provider remains **${ai.providerDefinition.displayName}**.`;
  }

  await editPanel(
    interaction,
    await core.renderAiProvider(interaction.guild.id, userId, mode, notice)
  );
};

module.exports = Object.assign(core, {
  buildInitialProviderChoice,
  getSavedAiProviderRecord,
  orderedProviders,
  renderOnboardingAiProvider,
});
