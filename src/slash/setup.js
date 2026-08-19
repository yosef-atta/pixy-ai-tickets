const {
  ActionRowBuilder,
  ChannelType,
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
  configureEscalationCategory,
  createOrFindEscalationCategory,
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

async function getCategory(guild, categoryId) {
  if (!guild || !categoryId) return null;
  const cached = guild.channels?.cache?.get(categoryId);
  if (cached?.type === ChannelType.GuildCategory) return cached;
  const fetched = await guild.channels?.fetch?.(categoryId).catch(() => null);
  return fetched?.type === ChannelType.GuildCategory ? fetched : null;
}

function formatNotificationSetupFailure(notification) {
  const code = String(notification?.code || "");
  const labels = [...new Set(
    (notification?.missingPermissionLabels || [])
      .map((label) => String(label || "").trim())
      .filter(Boolean)
  )];

  if (code === "missing_manage_channels_permission") {
    return [
      "Pixy needs **Manage Channels** to create or repair the Human Support notification channel.",
      "Grant it to the bot role, then press **Create/Repair Notification Channel** again.",
    ].join(" ");
  }

  if (code === "missing_notification_channel_permissions" && labels.length) {
    const explanations = labels.map((label) => {
      if (label === "View Channel") {
        return "**View Channel** lets Pixy access the Human Support notification channel.";
      }
      if (label === "Send Messages") {
        return "**Send Messages** lets Pixy post escalation alerts in that channel.";
      }
      return `**${label}** is required for the Human Support notification channel.`;
    });

    return [
      `Pixy is still missing **${labels.join("** and **")}** in the Human Support notification channel.`,
      ...explanations,
      `Grant ${labels.length === 1 ? "that permission" : "those permissions"} to the bot role or the category/channel overrides, then press **Create/Repair Notification Channel** again.`,
      "If you use ticket **Threads**, **Send Messages in Threads** is also recommended so Pixy can reply inside those ticket threads; it is not required for this notification channel itself.",
    ].join(" ");
  }

  if (code === "notification_channel_create_failed") {
    return "Discord rejected the notification channel creation. Check Pixy's **Manage Channels** permission and any category permission overrides, then try Repair again.";
  }

  if (code === "missing_escalation_category") {
    return "Choose a Human Support escalation category before creating the notification channel.";
  }

  return code
    ? `Pixy could not prepare the Human Support notification channel (${code}).`
    : "Pixy could not prepare the Human Support notification channel.";
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

const humanCategoryCreateHandler = core.buttonHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.HUMAN_CATEGORY_CREATE
);
if (!humanCategoryCreateHandler) {
  throw new Error("Pixy setup Human Support category-create handler is missing.");
}

humanCategoryCreateHandler.execute = async function executeHumanCategoryCreate(interaction) {
  const { mode, userId } = core.parseScoped(interaction.customId, PREFIX.HUMAN_CATEGORY_CREATE);
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  const result = await createOrFindEscalationCategory(interaction.guild);
  if (!result.ok || !result.category) {
    const notice = result.code === "missing_manage_channels_permission"
      ? "Pixy needs **Manage Channels** to create the Human Support category. Grant it, then try again."
      : "Pixy could not create the Human Support category automatically.";
    await editPanel(
      interaction,
      await core.renderHumanSupport(interaction.guild, userId, mode, notice)
    );
    return;
  }

  const configured = await configureEscalationCategory(interaction.guild, result.category.id);
  const notice = configured.notification.ok
    ? `Human Support category saved as **${result.category.name}**.`
    : `Human Support category **${result.category.name}** is saved. ${formatNotificationSetupFailure(configured.notification)}`;
  await editPanel(
    interaction,
    await core.renderHumanSupport(interaction.guild, userId, mode, notice)
  );
};

const humanRetryHandler = core.buttonHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.HUMAN_RETRY_NOTIFICATION
);
if (!humanRetryHandler) {
  throw new Error("Pixy setup Human Support notification-repair handler is missing.");
}

humanRetryHandler.execute = async function executeHumanNotificationRepair(interaction) {
  const { mode, userId } = core.parseScoped(interaction.customId, PREFIX.HUMAN_RETRY_NOTIFICATION);
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  const config = await prisma.guildConfig.findUnique({
    where: { guildId: interaction.guild.id },
  });
  if (!config?.escalationCategoryId) {
    await editPanel(
      interaction,
      await core.renderHumanSupport(
        interaction.guild,
        userId,
        mode,
        "Choose an escalation category first."
      )
    );
    return;
  }

  const configured = await configureEscalationCategory(
    interaction.guild,
    config.escalationCategoryId
  );
  const notice = configured.notification.ok
    ? "Human Support notification channel is ready."
    : formatNotificationSetupFailure(configured.notification);
  await editPanel(
    interaction,
    await core.renderHumanSupport(interaction.guild, userId, mode, notice)
  );
};

const humanCategorySelectHandler = core.selectMenuHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.HUMAN_CATEGORY_SELECT
);
if (!humanCategorySelectHandler) {
  throw new Error("Pixy setup Human Support category-select handler is missing.");
}

humanCategorySelectHandler.execute = async function executeHumanCategorySelect(interaction) {
  const { mode, userId } = core.parseScoped(interaction.customId, PREFIX.HUMAN_CATEGORY_SELECT);
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  const categoryId = interaction.values?.[0];
  const category = await getCategory(interaction.guild, categoryId);
  if (!category) {
    await editPanel(
      interaction,
      await core.renderHumanSupport(
        interaction.guild,
        userId,
        mode,
        "That category no longer exists."
      )
    );
    return;
  }

  const configured = await configureEscalationCategory(interaction.guild, category.id);
  const notice = configured.notification.ok
    ? `Human Support category saved as **${category.name}**.`
    : `Human Support category **${category.name}** is saved. ${formatNotificationSetupFailure(configured.notification)}`;
  await editPanel(
    interaction,
    await core.renderHumanSupport(interaction.guild, userId, mode, notice)
  );
};

module.exports = Object.assign(core, {
  buildInitialProviderChoice,
  formatNotificationSetupFailure,
  getSavedAiProviderRecord,
  orderedProviders,
  renderOnboardingAiProvider,
});