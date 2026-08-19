const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require("discord.js");

const core = require("../setup/setupCommandCore");
const { prisma } = require("../config/prisma");
const { SETUP_STEPS, TICKET_SOURCE_TYPES } = require("../config/productDefaults");
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
  validateCategoryIds,
  validateThreadParentIds,
} = require("../setup/setupService");
const {
  SETUP_REQUIRED_PERMISSIONS,
  checkSetupPermissions,
  prepareHumanSupportCategoryAccess,
  prepareHumanSupportNotificationAccess,
  prepareTicketSourceAccess,
} = require("../setup/setupPermissionGate");

const EPHEMERAL = 64;
const { MODE, PREFIX } = core;
const PERMISSION_RECHECK_PREFIX = "setup10_permissions_recheck:";

const scoped = (prefix, mode, userId) => `${prefix}${mode}:${userId}`;
const permissionRecheckId = (userId) => `${PERMISSION_RECHECK_PREFIX}${userId}`;

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

function renderPermissionGateFromStatus(status, userId, notice = null) {
  const missing = status?.missing || SETUP_REQUIRED_PERMISSIONS;
  const missingText = missing.length
    ? missing.map(({ label, reason }) => `• **${label}** — ${reason}`).join("\n")
    : "No permissions are missing.";

  const embed = new EmbedBuilder()
    .setTitle("Pixy Setup — Permission Check")
    .setDescription([
      "Before Ticket Sources, Pixy checks the server-level permissions needed for the full feature set once.",
      "This avoids stopping later in AI, Human Support, or Full Ticket Control to ask for permissions one by one.",
      "",
      "Grant the missing permissions to Pixy's bot role, then press **Recheck Permissions**.",
    ].join("\n"))
    .addFields(
      {
        name: `Missing Permissions — ${missing.length}`,
        value: missingText.slice(0, 1024),
        inline: false,
      },
      {
        name: "Full Pixy Permission Set",
        value: SETUP_REQUIRED_PERMISSIONS.map(({ label }) => `• ${label}`).join("\n"),
        inline: false,
      }
    );

  return {
    content: notice,
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(permissionRecheckId(userId))
        .setLabel("Recheck Permissions")
        .setStyle(ButtonStyle.Primary)
    )],
  };
}

async function renderPostPermissionStep(guild, userId, state, notice = null) {
  if (state.lastStep === SETUP_STEPS.AI_PROVIDER) {
    return renderOnboardingAiProvider(guild.id, userId, notice);
  }
  if (state.lastStep === SETUP_STEPS.HUMAN_SUPPORT) {
    return core.renderHumanSupport(guild, userId, MODE.ONBOARD, notice);
  }
  return core.renderOnboardingTicketSources(guild, userId, notice);
}

async function renderPermissionGateOrCurrentStep(guild, userId, state, notice = null) {
  const status = await checkSetupPermissions(guild);
  if (!status.ok) {
    return renderPermissionGateFromStatus(status, userId, notice);
  }

  return renderPostPermissionStep(
    guild,
    userId,
    state,
    notice || (state.lastStep === SETUP_STEPS.TICKET_SOURCES
      ? "Permissions ready — Pixy can use the full feature set."
      : null)
  );
}

function humanSupportFailureNotice() {
  return [
    "Pixy could not prepare that Human Support location automatically.",
    "The upfront permission check already passed, so this is usually caused by an unusual category/channel override or Discord refusing the overwrite update.",
    "Try another category or use Pixy's automatically created Human Support category.",
  ].join(" ");
}

async function prepareHumanSupportResources(guild, category) {
  const categoryAccess = await prepareHumanSupportCategoryAccess(guild, category);
  if (!categoryAccess.ok) {
    return { ok: false, code: categoryAccess.code, categoryAccess };
  }

  let configured = await configureEscalationCategory(guild, category.id);
  if (configured.notification.ok) {
    return { ok: true, configured, categoryAccess };
  }

  const notificationChannel = configured.notification.channel || null;
  if (notificationChannel) {
    const notificationAccess = await prepareHumanSupportNotificationAccess(
      notificationChannel,
      categoryAccess.member
    );
    if (notificationAccess.ok) {
      configured = await configureEscalationCategory(guild, category.id);
    }
  }

  return {
    ok: configured.notification.ok,
    code: configured.notification.code || "human_support_provision_failed",
    configured,
    categoryAccess,
  };
}

const originalExecute = core.execute.bind(core);
core.execute = async function execute(interaction) {
  const state = await getOrCreateSetupState(interaction.guild.id);

  if (!state.completedAt) {
    const status = await checkSetupPermissions(interaction.guild);
    if (!status.ok) {
      const payload = renderPermissionGateFromStatus(status, interaction.user.id);
      await interaction.reply({
        ...payload,
        flags: EPHEMERAL,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (state.lastStep === SETUP_STEPS.TICKET_SOURCES) {
      const payload = await core.renderOnboardingTicketSources(
        interaction.guild,
        interaction.user.id,
        "Permissions ready — Pixy can use the full feature set."
      );
      await interaction.reply({
        ...payload,
        flags: EPHEMERAL,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (state.lastStep === SETUP_STEPS.AI_PROVIDER) {
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

    if (state.lastStep === SETUP_STEPS.HUMAN_SUPPORT) {
      const config = await prisma.guildConfig.findUnique({
        where: { guildId: interaction.guild.id },
        select: { escalationCategoryId: true },
      });
      if (config?.escalationCategoryId) {
        const category = await getCategory(interaction.guild, config.escalationCategoryId);
        if (category) await prepareHumanSupportResources(interaction.guild, category);
      }
    }
  }

  return originalExecute(interaction);
};

core.buttonHandlers.push({
  customIdPrefix: PERMISSION_RECHECK_PREFIX,
  async execute(interaction) {
    const userId = String(interaction.customId || "").slice(PERMISSION_RECHECK_PREFIX.length);
    if (!(await assertOwner(interaction, userId))) return;
    await deferUpdate(interaction);

    const state = await getOrCreateSetupState(interaction.guild.id);
    const payload = await renderPermissionGateOrCurrentStep(
      interaction.guild,
      userId,
      state,
      null
    );
    await editPanel(interaction, payload);
  },
});

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

  const permissionStatus = await checkSetupPermissions(interaction.guild);
  if (!permissionStatus.ok) {
    await editPanel(
      interaction,
      renderPermissionGateFromStatus(
        permissionStatus,
        userId,
        "Pixy's permissions changed before setup could continue."
      )
    );
    return;
  }

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

function wrapTicketSourceAccess(handler, type) {
  if (!handler) throw new Error(`Pixy setup ${type} source handler is missing.`);
  const original = handler.execute.bind(handler);

  handler.execute = async function executeWithAccess(interaction) {
    const prefix = type === TICKET_SOURCE_TYPES.THREAD_PARENT
      ? PREFIX.TICKET_THREAD_SELECT
      : PREFIX.TICKET_SELECT;
    const { mode, userId } = core.parseScoped(interaction.customId, prefix);
    if (!(await assertOwner(interaction, userId))) return;
    await deferUpdate(interaction);

    const permissionStatus = await checkSetupPermissions(interaction.guild);
    if (!permissionStatus.ok && mode === MODE.ONBOARD) {
      await editPanel(
        interaction,
        renderPermissionGateFromStatus(permissionStatus, userId)
      );
      return;
    }

    const selectedIds = interaction.values || [];
    const channels = type === TICKET_SOURCE_TYPES.THREAD_PARENT
      ? await validateThreadParentIds(interaction.guild, selectedIds)
      : await validateCategoryIds(interaction.guild, selectedIds);

    if (selectedIds.length && channels.length === selectedIds.length) {
      const access = await prepareTicketSourceAccess(interaction.guild, channels, type);
      if (!access.ok) {
        const message = "Pixy could not prepare access to one or more selected Ticket Sources. Choose a source where Pixy can manage its channel permissions, or restore the full Pixy permission set and try again.";
        const payload = mode === MODE.ONBOARD
          ? await core.renderOnboardingTicketSources(interaction.guild, userId, message)
          : await core.renderTicketSourceManager(interaction.guild, userId, message);
        await editPanel(interaction, payload);
        return;
      }
    }

    return original(interaction);
  };
}

wrapTicketSourceAccess(
  core.selectMenuHandlers.find((handler) => handler.customIdPrefix === PREFIX.TICKET_SELECT),
  TICKET_SOURCE_TYPES.CATEGORY
);
wrapTicketSourceAccess(
  core.selectMenuHandlers.find((handler) => handler.customIdPrefix === PREFIX.TICKET_THREAD_SELECT),
  TICKET_SOURCE_TYPES.THREAD_PARENT
);

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
    await editPanel(
      interaction,
      await core.renderHumanSupport(
        interaction.guild,
        userId,
        mode,
        "Pixy could not create the Human Support category automatically. Re-run `/pixy-setup` to verify the full permission set, then try again."
      )
    );
    return;
  }

  const prepared = await prepareHumanSupportResources(interaction.guild, result.category);
  const notice = prepared.ok
    ? `Human Support category **${result.category.name}** and its notification channel are ready.`
    : humanSupportFailureNotice();
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

  const category = await getCategory(interaction.guild, config.escalationCategoryId);
  if (!category) {
    await editPanel(
      interaction,
      await core.renderHumanSupport(
        interaction.guild,
        userId,
        mode,
        "That Human Support category no longer exists. Choose or create another one."
      )
    );
    return;
  }

  const prepared = await prepareHumanSupportResources(interaction.guild, category);
  const notice = prepared.ok
    ? "Human Support resources are ready."
    : humanSupportFailureNotice();
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

  const prepared = await prepareHumanSupportResources(interaction.guild, category);
  const notice = prepared.ok
    ? `Human Support category **${category.name}** and its notification channel are ready.`
    : humanSupportFailureNotice();
  await editPanel(
    interaction,
    await core.renderHumanSupport(interaction.guild, userId, mode, notice)
  );
};

module.exports = Object.assign(core, {
  buildInitialProviderChoice,
  getSavedAiProviderRecord,
  humanSupportFailureNotice,
  orderedProviders,
  prepareHumanSupportResources,
  renderOnboardingAiProvider,
  renderPermissionGateFromStatus,
  renderPermissionGateOrCurrentStep,
});
