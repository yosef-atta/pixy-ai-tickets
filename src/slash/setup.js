const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  EmbedBuilder,
} = require("discord.js");
const {
  loadBillingSummary,
} = require("../billing/billingService");
const {
  getGuildAiConfig,
  getOrCreateGuildSetting,
} = require("../config/ai");
const { prisma } = require("../config/prisma");
const {
  SETUP_STEPS,
} = require("../config/productDefaults");
const {
  getOrCreateSetupState,
} = require("../config/setupState");
const {
  listAiProviders,
  validateProviderCredential,
  validateProviderModel,
} = require("../ai/providers/providerRegistry");
const {
  removeGuildAiCredential,
  saveGuildAiCredential,
  saveGuildAiModel,
  setGuildAiProvider,
} = require("../config/guildAiConfig");
const {
  addTicketCategories,
  completeOnboarding,
  configureEscalationCategory,
  createOrFindEscalationCategory,
  createOrFindTicketCategory,
  listCategoryTicketSources,
  moveSetupToAiProvider,
  moveSetupToHumanSupport,
  removeSupportRoutes,
  removeTicketCategories,
  setEscalationEnabled,
  setTicketCategories,
  skipHumanSupportAndComplete,
  upsertSupportRoute,
  validateCategoryIds,
} = require("../setup/setupService");

const EPHEMERAL = 64;
const MODE = Object.freeze({
  ONBOARD: "o",
  MANAGE: "m",
});
const PREFIX = Object.freeze({
  HOME: "setup4_home:",
  TICKET_OPEN: "setup4_ticket:",
  TICKET_SELECT_OPEN: "setup4_ticket_sel_open:",
  TICKET_SELECT: "setup4_ticket_sel:",
  TICKET_CREATE: "setup4_ticket_create:",
  TICKET_REMOVE: "setup4_ticket_remove:",
  AI_OPEN: "setup4_ai:",
  AI_PROVIDER: "setup4_ai_provider:",
  AI_CREDENTIAL: "setup4_ai_credential:",
  AI_CREDENTIAL_MODAL: "setup4_ai_credential_modal:",
  AI_REMOVE: "setup4_ai_remove:",
  AI_MODEL: "setup4_ai_model:",
  AI_MODEL_MODAL: "setup4_ai_model_modal:",
  AI_MODEL_RESET: "setup4_ai_model_reset:",
  AI_NEXT: "setup4_ai_next:",
  HUMAN_OPEN: "setup4_human:",
  HUMAN_CATEGORY_OPEN: "setup4_hcat_open:",
  HUMAN_CATEGORY_SELECT: "setup4_hcat_select:",
  HUMAN_CATEGORY_CREATE: "setup4_hcat_create:",
  HUMAN_RETRY_NOTIFICATION: "setup4_hretry:",
  HUMAN_ROLE: "setup4_hrole:",
  HUMAN_DESCRIPTION_MODAL: "setup4_hdesc:",
  HUMAN_SKIP: "setup4_hskip:",
  HUMAN_FINISH: "setup4_hfinish:",
  HUMAN_REMOVE_ROUTE: "setup4_hremove:",
});

const scoped = (prefix, mode, userId, extra = null) =>
  `${prefix}${mode}:${userId}${extra ? `:${extra}` : ""}`;

function parseScoped(customId, prefix) {
  const parts = String(customId || "").slice(prefix.length).split(":");
  return {
    mode: parts[0] || MODE.MANAGE,
    userId: parts[1] || "",
    extra: parts.slice(2),
  };
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, max = 900) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3)).trim()}...`;
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

function backButton(userId) {
  return new ButtonBuilder()
    .setCustomId(scoped(PREFIX.HOME, MODE.MANAGE, userId))
    .setLabel("Back to Setup")
    .setStyle(ButtonStyle.Secondary);
}

async function getCategory(guild, categoryId) {
  if (!guild || !categoryId) return null;
  const cached = guild.channels.cache.get(categoryId);
  if (cached?.type === ChannelType.GuildCategory) return cached;
  const fetched = await guild.channels.fetch(categoryId).catch(() => null);
  return fetched?.type === ChannelType.GuildCategory ? fetched : null;
}

async function getTextChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const cached = guild.channels.cache.get(channelId);
  if (cached?.type === ChannelType.GuildText) return cached;
  const fetched = await guild.channels.fetch(channelId).catch(() => null);
  return fetched?.type === ChannelType.GuildText ? fetched : null;
}

async function getRole(guild, roleId) {
  if (!guild || !roleId) return null;
  const cached = guild.roles.cache.get(roleId);
  if (cached) return cached;
  return guild.roles.fetch(roleId).catch(() => null);
}

async function loadSetupOverview(guild) {
  await Promise.all([
    guild.channels.fetch().catch(() => null),
    guild.roles.fetch().catch(() => null),
  ]);

  const guildId = guild.id;
  const [sources, ai, config, setting, routes, billing] = await Promise.all([
    listCategoryTicketSources(guildId),
    getGuildAiConfig(guildId),
    prisma.guildConfig.findUnique({ where: { guildId } }),
    getOrCreateGuildSetting(guildId),
    prisma.adminRoute.findMany({
      where: { guildId, enabled: true },
      orderBy: { createdAt: "asc" },
    }),
    loadBillingSummary(guildId),
  ]);

  const sourceDetails = sources.map((source) => ({
    source,
    channel: guild.channels.cache.get(source.sourceId) || null,
  }));
  const escalationCategory = config?.escalationCategoryId
    ? guild.channels.cache.get(config.escalationCategoryId) || null
    : null;
  const notificationChannel = config?.escalationNotificationChannelId
    ? guild.channels.cache.get(config.escalationNotificationChannelId) || null
    : null;
  const routeDetails = routes.map((route) => ({
    route,
    role: guild.roles.cache.get(route.roleId) || null,
  }));

  const health = [];
  if (!sources.length) health.push("Ticket Sources are not configured.");
  const missingSources = sourceDetails.filter(({ channel }) =>
    !channel || channel.type !== ChannelType.GuildCategory
  );
  if (missingSources.length) {
    health.push(`${missingSources.length} configured ticket source(s) no longer exist.`);
  }
  if (
    ai.providerDefinition.requiresCredential &&
    ai.credentialStatus !== "configured"
  ) {
    health.push(`${ai.providerDefinition.displayName} credential is ${ai.credentialStatus}.`);
  }
  if (setting.escalationEnabled) {
    if (!escalationCategory || escalationCategory.type !== ChannelType.GuildCategory) {
      health.push("Human Support escalation category is missing.");
    }
    if (!notificationChannel || notificationChannel.type !== ChannelType.GuildText) {
      health.push("Human Support notification channel is missing.");
    }
    const missingRoles = routeDetails.filter(({ role }) => !role);
    if (!routes.length) health.push("Human Support is enabled but has no support routes.");
    if (missingRoles.length) health.push(`${missingRoles.length} support route role(s) no longer exist.`);
  }

  return {
    sources,
    ai,
    config,
    setting,
    routes,
    billing,
    sourceDetails,
    escalationCategory,
    notificationChannel,
    routeDetails,
    health,
  };
}

function formatTicketSources(sourceDetails) {
  if (!sourceDetails.length) return "Not configured";
  return sourceDetails
    .slice(0, 12)
    .map(({ source, channel }) =>
      channel?.type === ChannelType.GuildCategory
        ? `• **${channel.name}**`
        : `• Missing category \`${source.sourceId}\``
    )
    .join("\n");
}

function formatRoutes(routeDetails) {
  if (!routeDetails.length) return "No support routes configured";
  return routeDetails
    .slice(0, 8)
    .map(({ route, role }) =>
      `• ${role ? `**${role.name}**` : `Missing role \`${route.roleId}\``} — ${truncate(route.description, 90)}`
    )
    .join("\n");
}

async function renderDashboard(guild, userId, notice = null) {
  const overview = await loadSetupOverview(guild);
  const humanStatus = overview.setting.escalationEnabled
    ? `${overview.routes.length} route(s) enabled`
    : "Disabled (optional)";
  const health = overview.health.length
    ? overview.health.map((issue) => `• ${issue}`).join("\n")
    : "Ready — no setup problems detected.";

  const embed = new EmbedBuilder()
    .setTitle("Pixy Setup Dashboard")
    .setDescription(
      "Core setup is managed here. `/pixy-settings` is for secondary behavior and feature preferences."
    )
    .addFields(
      {
        name: `Ticket Sources — ${overview.sources.length} configured`,
        value: formatTicketSources(overview.sourceDetails),
        inline: false,
      },
      {
        name: `AI Provider — ${overview.ai.providerDefinition.displayName}`,
        value: [
          `Credential: **${overview.ai.credentialStatus}**`,
          `Model: \`${overview.ai.model}\``,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Human Support",
        value: [
          `Status: **${humanStatus}**`,
          `Category: ${overview.escalationCategory ? `**${overview.escalationCategory.name}**` : "Not configured"}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Plan",
        value: overview.billing.planLabel,
        inline: true,
      },
      {
        name: "Setup Health",
        value: health,
        inline: false,
      }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.TICKET_OPEN, MODE.MANAGE, userId))
      .setLabel("Ticket Sources")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.AI_OPEN, MODE.MANAGE, userId))
      .setLabel("AI Provider")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.HUMAN_OPEN, MODE.MANAGE, userId))
      .setLabel("Human Support")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.HOME, MODE.MANAGE, userId))
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    content: notice,
    embeds: [embed],
    components: [row],
  };
}

async function renderOnboardingTicketSources(guild, userId, notice = null) {
  const sources = await listCategoryTicketSources(guild.id);
  await guild.channels.fetch().catch(() => null);
  const sourceDetails = sources.map((source) => ({
    source,
    channel: guild.channels.cache.get(source.sourceId) || null,
  }));

  const embed = new EmbedBuilder()
    .setTitle("Pixy Setup — 1/3 Ticket Sources")
    .setDescription([
      "Choose every category where your existing ticket system creates ticket channels.",
      "Pixy does not replace your ticket bot — it watches the ticket channels created inside these categories.",
      "",
      sources.length ? "Current selection:" : "No ticket sources selected yet.",
      sources.length ? formatTicketSources(sourceDetails) : null,
    ].filter(Boolean).join("\n"));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.TICKET_SELECT_OPEN, MODE.ONBOARD, userId))
      .setLabel("Select Categories")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.TICKET_CREATE, MODE.ONBOARD, userId))
      .setLabel("Create Automatically")
      .setStyle(ButtonStyle.Secondary)
  );

  return { content: notice, embeds: [embed], components: [row] };
}

async function renderTicketSourceManager(guild, userId, notice = null) {
  const sources = await listCategoryTicketSources(guild.id);
  await guild.channels.fetch().catch(() => null);
  const sourceDetails = sources.map((source) => ({
    source,
    channel: guild.channels.cache.get(source.sourceId) || null,
  }));

  const embed = new EmbedBuilder()
    .setTitle("Ticket Sources")
    .setDescription([
      "Pixy will treat ticket channels inside any configured category as eligible tickets.",
      "",
      formatTicketSources(sourceDetails),
    ].join("\n"));

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.TICKET_SELECT_OPEN, MODE.MANAGE, userId))
      .setLabel("Add Categories")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.TICKET_CREATE, MODE.MANAGE, userId))
      .setLabel("Create Category")
      .setStyle(ButtonStyle.Secondary),
    backButton(userId)
  );

  const components = [buttons];
  if (sources.length) {
    const options = sources.slice(0, 25).map((source) => {
      const channel = guild.channels.cache.get(source.sourceId);
      return {
        label: (channel?.name || `Missing ${source.sourceId.slice(-6)}`).slice(0, 100),
        value: source.sourceId,
        description: "Remove this category from Pixy ticket sources",
      };
    });
    components.unshift(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(scoped(PREFIX.TICKET_REMOVE, MODE.MANAGE, userId))
        .setPlaceholder("Remove configured categories...")
        .setMinValues(1)
        .setMaxValues(options.length)
        .addOptions(options)
    ));
  }

  return { content: notice, embeds: [embed], components };
}

function renderTicketCategorySelect(userId, mode) {
  return {
    content: mode === MODE.ONBOARD
      ? "Select one or more categories used by your ticket system. Saving moves directly to AI setup."
      : "Select one or more categories to add to Pixy ticket sources.",
    embeds: [],
    components: [new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(scoped(PREFIX.TICKET_SELECT, mode, userId))
        .setPlaceholder("Select ticket categories...")
        .setChannelTypes(ChannelType.GuildCategory)
        .setMinValues(1)
        .setMaxValues(25)
    )],
  };
}

function credentialButtonLabel(ai) {
  const type = String(ai.credentialType || "").toLowerCase();
  const noun = type.includes("api-key") ? "API Key" : "Credential";
  return ai.credentialStatus === "configured" ? `Replace ${noun}` : `Add ${noun}`;
}

function buildProviderSelect(userId, mode, providers, selectedProvider) {
  if (providers.length <= 1) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(scoped(PREFIX.AI_PROVIDER, mode, userId))
    .setPlaceholder("Choose AI provider")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(providers.slice(0, 25).map((provider) => ({
      label: provider.displayName.slice(0, 100),
      value: provider.id,
      description: `Default model: ${provider.defaultModel}`.slice(0, 100),
      default: provider.id === selectedProvider,
    })));
  return new ActionRowBuilder().addComponents(menu);
}

async function renderAiProvider(guildId, userId, mode, notice = null) {
  const [ai, providers] = await Promise.all([
    getGuildAiConfig(guildId),
    Promise.resolve(listAiProviders()),
  ]);
  const provider = ai.providerDefinition;
  const ready = provider.requiresCredential === false || ai.credentialStatus === "configured";

  const embed = new EmbedBuilder()
    .setTitle(mode === MODE.ONBOARD ? "Pixy Setup — 2/3 AI Provider" : "AI Provider")
    .setDescription(
      provider.requiresCredential
        ? `Pixy is configured to use **${provider.displayName}**. Add this server's API credential first; it is encrypted and never displayed again.`
        : `Pixy is configured to use **${provider.displayName}**. This provider does not require an external credential.`
    )
    .addFields(
      { name: "Provider", value: provider.displayName, inline: true },
      { name: "Credential", value: ai.credentialStatus, inline: true },
      { name: "Model", value: `\`${ai.model}\``, inline: false }
    );

  const components = [];
  const providerSelect = buildProviderSelect(userId, mode, providers, ai.provider);
  if (providerSelect) components.push(providerSelect);

  if (mode === MODE.ONBOARD) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.AI_CREDENTIAL, mode, userId))
        .setLabel(credentialButtonLabel(ai))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!provider.requiresCredential),
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.AI_MODEL, mode, userId))
        .setLabel("Change Model")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!ready)
    ));
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.AI_NEXT, mode, userId))
        .setLabel("Next")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!ready)
    ));
  } else {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.AI_CREDENTIAL, mode, userId))
        .setLabel(credentialButtonLabel(ai))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!provider.requiresCredential),
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.AI_REMOVE, mode, userId))
        .setLabel("Remove Credential")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!ai.aiConfigRecord?.credentialEncrypted),
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.AI_MODEL, mode, userId))
        .setLabel("Change Model")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!ready),
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.AI_MODEL_RESET, mode, userId))
        .setLabel("Reset Model")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(ai.modelSource !== "guild")
    ));
    components.push(new ActionRowBuilder().addComponents(backButton(userId)));
  }

  return { content: notice, embeds: [embed], components };
}

function buildCredentialModal(userId, mode, ai) {
  const provider = ai.providerDefinition;
  const input = new TextInputBuilder()
    .setCustomId("provider_credential")
    .setLabel(String(provider.credentialLabel || "API Key").slice(0, 45))
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  if (provider.credentialPlaceholder) {
    input.setPlaceholder(String(provider.credentialPlaceholder).slice(0, 100));
  }

  return new ModalBuilder()
    .setCustomId(scoped(PREFIX.AI_CREDENTIAL_MODAL, mode, userId))
    .setTitle(`Configure ${provider.displayName}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function buildModelModal(userId, mode, ai) {
  const input = new TextInputBuilder()
    .setCustomId("provider_model")
    .setLabel("Model ID")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(191)
    .setPlaceholder(String(ai.providerDefinition.defaultModel).slice(0, 100));

  return new ModalBuilder()
    .setCustomId(scoped(PREFIX.AI_MODEL_MODAL, mode, userId))
    .setTitle(`Set ${ai.providerDefinition.displayName} Model`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function loadHumanSupport(guild) {
  await Promise.all([
    guild.channels.fetch().catch(() => null),
    guild.roles.fetch().catch(() => null),
  ]);
  const [config, setting, routes] = await Promise.all([
    prisma.guildConfig.findUnique({ where: { guildId: guild.id } }),
    getOrCreateGuildSetting(guild.id),
    prisma.adminRoute.findMany({
      where: { guildId: guild.id, enabled: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const category = config?.escalationCategoryId
    ? await getCategory(guild, config.escalationCategoryId)
    : null;
  const notification = config?.escalationNotificationChannelId
    ? await getTextChannel(guild, config.escalationNotificationChannelId)
    : null;
  const routeDetails = [];
  for (const route of routes) {
    routeDetails.push({ route, role: await getRole(guild, route.roleId) });
  }
  return { config, setting, routes, routeDetails, category, notification };
}

function humanCategoryButtons(userId, mode) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.HUMAN_CATEGORY_OPEN, mode, userId))
      .setLabel("Select Existing Category")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.HUMAN_CATEGORY_CREATE, mode, userId))
      .setLabel("Create Automatically")
      .setStyle(ButtonStyle.Secondary)
  );
}

function humanRoleRow(userId, mode) {
  return new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(scoped(PREFIX.HUMAN_ROLE, mode, userId))
      .setPlaceholder("Choose a support role")
      .setMinValues(1)
      .setMaxValues(1)
  );
}

async function renderHumanSupport(guild, userId, mode, notice = null) {
  const human = await loadHumanSupport(guild);
  const configured = Boolean(human.category && human.notification && human.routes.length);
  const lines = [
    `Escalation category: ${human.category ? `**${human.category.name}**` : "Not configured"}`,
    `Notification channel: ${human.notification ? `<#${human.notification.id}>` : "Not configured"}`,
    `Support routes: **${human.routes.length}**`,
    human.routeDetails.length ? "" : null,
    human.routeDetails.length ? formatRoutes(human.routeDetails) : null,
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle(mode === MODE.ONBOARD ? "Pixy Setup — 3/3 Human Support" : "Human Support")
    .setDescription([
      mode === MODE.ONBOARD
        ? "Human escalation is recommended but optional. Configure where escalated tickets go and which role should handle them, or skip it for now."
        : "Manage the escalation destination and support role routes used by Pixy.",
      "",
      ...lines,
    ].join("\n"));

  const components = [];
  if (!human.category) {
    components.push(humanCategoryButtons(userId, mode));
  } else if (!human.notification) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.HUMAN_RETRY_NOTIFICATION, mode, userId))
        .setLabel("Create/Repair Notification Channel")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.HUMAN_CATEGORY_OPEN, mode, userId))
        .setLabel("Change Category")
        .setStyle(ButtonStyle.Secondary)
    ));
  } else {
    components.push(humanRoleRow(userId, mode));
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.HUMAN_CATEGORY_OPEN, mode, userId))
        .setLabel("Change Category")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.HUMAN_CATEGORY_CREATE, mode, userId))
        .setLabel("Use Auto Category")
        .setStyle(ButtonStyle.Secondary)
    ));
  }

  if (mode === MODE.ONBOARD) {
    const finishRow = new ActionRowBuilder();
    if (configured) {
      finishRow.addComponents(
        new ButtonBuilder()
          .setCustomId(scoped(PREFIX.HUMAN_FINISH, mode, userId))
          .setLabel("Finish Setup")
          .setStyle(ButtonStyle.Success)
      );
    }
    finishRow.addComponents(
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.HUMAN_SKIP, mode, userId))
        .setLabel("Skip for Now")
        .setStyle(ButtonStyle.Secondary)
    );
    components.push(finishRow);
  } else {
    if (human.routes.length) {
      const options = human.routeDetails.slice(0, 25).map(({ route, role }) => ({
        label: (role?.name || `Missing ${route.roleId.slice(-6)}`).slice(0, 100),
        value: route.id,
        description: truncate(route.description, 100),
      }));
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(scoped(PREFIX.HUMAN_REMOVE_ROUTE, mode, userId))
          .setPlaceholder("Remove support routes...")
          .setMinValues(1)
          .setMaxValues(options.length)
          .addOptions(options)
      ));
    }
    components.push(new ActionRowBuilder().addComponents(backButton(userId)));
  }

  return { content: notice, embeds: [embed], components };
}

function renderHumanCategorySelect(userId, mode) {
  return {
    content: "Choose the category where escalated tickets should be moved. Pixy will also create or reuse its notification channel there.",
    embeds: [],
    components: [new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(scoped(PREFIX.HUMAN_CATEGORY_SELECT, mode, userId))
        .setPlaceholder("Select escalation category")
        .setChannelTypes(ChannelType.GuildCategory)
        .setMinValues(1)
        .setMaxValues(1)
    )],
  };
}

function buildRoleDescriptionModal(userId, mode, role, existing = null) {
  const input = new TextInputBuilder()
    .setCustomId("description")
    .setLabel("What should this role handle?")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(700)
    .setPlaceholder("Example: Handles billing, payment issues, refunds, and failed purchases.");
  if (existing?.description) input.setValue(existing.description.slice(0, 700));

  return new ModalBuilder()
    .setCustomId(scoped(PREFIX.HUMAN_DESCRIPTION_MODAL, mode, userId, role.id))
    .setTitle(existing ? "Update Support Route" : "Add Support Route")
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function renderCompletion(guild, userId, humanConfigured, notice = null) {
  const [billing, ai, sources] = await Promise.all([
    loadBillingSummary(guild.id),
    getGuildAiConfig(guild.id),
    listCategoryTicketSources(guild.id),
  ]);
  const embed = new EmbedBuilder()
    .setTitle("Pixy Setup Complete")
    .setDescription([
      "Pixy is ready for this server.",
      "From now on, `/pixy-setup` opens the setup dashboard instead of restarting onboarding.",
      "Use `/pixy-settings` for secondary behavior settings and `/pixy-billing` for plan details.",
    ].join("\n"))
    .addFields(
      { name: "Ticket Sources", value: `${sources.length} configured`, inline: true },
      { name: "AI Provider", value: ai.providerDefinition.displayName, inline: true },
      { name: "Human Support", value: humanConfigured ? "Configured" : "Skipped", inline: true },
      { name: "Plan", value: billing.planLabel, inline: true }
    );
  return {
    content: notice,
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.HOME, MODE.MANAGE, userId))
        .setLabel("Open Setup Dashboard")
        .setStyle(ButtonStyle.Primary)
    )],
  };
}

async function renderCurrentOnboardingStep(guild, userId, state) {
  if (state.lastStep === SETUP_STEPS.AI_PROVIDER) {
    return renderAiProvider(guild.id, userId, MODE.ONBOARD);
  }
  if (state.lastStep === SETUP_STEPS.HUMAN_SUPPORT) {
    return renderHumanSupport(guild, userId, MODE.ONBOARD);
  }
  return renderOnboardingTicketSources(guild, userId);
}

const command = {
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Setup and manage Pixy core configuration.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  guildOnly: true,
  userPermissions: [PermissionFlagsBits.Administrator],

  async execute(interaction) {
    const state = await getOrCreateSetupState(interaction.guild.id);
    const payload = state.completedAt
      ? await renderDashboard(interaction.guild, interaction.user.id)
      : await renderCurrentOnboardingStep(interaction.guild, interaction.user.id, state);
    await interaction.reply({
      ...payload,
      flags: EPHEMERAL,
      allowedMentions: { parse: [] },
    });
  },

  buttonHandlers: [
    {
      customIdPrefix: PREFIX.HOME,
      async execute(interaction) {
        const { userId } = parseScoped(interaction.customId, PREFIX.HOME);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await editPanel(interaction, await renderDashboard(interaction.guild, userId));
      },
    },
    {
      customIdPrefix: PREFIX.TICKET_OPEN,
      async execute(interaction) {
        const { userId } = parseScoped(interaction.customId, PREFIX.TICKET_OPEN);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await editPanel(interaction, await renderTicketSourceManager(interaction.guild, userId));
      },
    },
    {
      customIdPrefix: PREFIX.TICKET_SELECT_OPEN,
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.TICKET_SELECT_OPEN);
        if (!(await assertOwner(interaction, userId))) return;
        await editPanel(interaction, renderTicketCategorySelect(userId, mode));
      },
    },
    {
      customIdPrefix: PREFIX.TICKET_CREATE,
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.TICKET_CREATE);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const result = await createOrFindTicketCategory(interaction.guild);
        if (!result.ok || !result.category) {
          const message = result.code === "missing_manage_channels_permission"
            ? "Pixy needs Manage Channels permission to create a ticket category automatically."
            : "Pixy could not create the ticket category automatically.";
          const payload = mode === MODE.ONBOARD
            ? await renderOnboardingTicketSources(interaction.guild, userId, message)
            : await renderTicketSourceManager(interaction.guild, userId, message);
          await editPanel(interaction, payload);
          return;
        }

        if (mode === MODE.ONBOARD) {
          await setTicketCategories(interaction.guild.id, [result.category.id], {
            guild: interaction.guild,
          });
          await moveSetupToAiProvider(interaction.guild.id);
          await editPanel(
            interaction,
            await renderAiProvider(
              interaction.guild.id,
              userId,
              MODE.ONBOARD,
              `Ticket source saved as **${result.category.name}**.`
            )
          );
          return;
        }

        await addTicketCategories(interaction.guild.id, [result.category.id], {
          guild: interaction.guild,
        });
        await editPanel(
          interaction,
          await renderTicketSourceManager(
            interaction.guild,
            userId,
            `Added **${result.category.name}** to Ticket Sources.`
          )
        );
      },
    },
    {
      customIdPrefix: PREFIX.AI_OPEN,
      async execute(interaction) {
        const { userId } = parseScoped(interaction.customId, PREFIX.AI_OPEN);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await editPanel(interaction, await renderAiProvider(interaction.guild.id, userId, MODE.MANAGE));
      },
    },
    {
      customIdPrefix: PREFIX.AI_CREDENTIAL,
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.AI_CREDENTIAL);
        if (!(await assertOwner(interaction, userId))) return;
        const ai = await getGuildAiConfig(interaction.guild.id);
        if (!ai.providerDefinition.requiresCredential) {
          await interaction.reply({
            content: `${ai.providerDefinition.displayName} does not require an external credential.`,
            flags: EPHEMERAL,
          });
          return;
        }
        await interaction.showModal(buildCredentialModal(userId, mode, ai));
      },
    },
    {
      customIdPrefix: PREFIX.AI_REMOVE,
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.AI_REMOVE);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await removeGuildAiCredential(interaction.guild.id, { clearModel: true });
        await editPanel(
          interaction,
          await renderAiProvider(interaction.guild.id, userId, mode, "AI credential removed.")
        );
      },
    },
    {
      customIdPrefix: PREFIX.AI_MODEL,
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.AI_MODEL);
        if (!(await assertOwner(interaction, userId))) return;
        const ai = await getGuildAiConfig(interaction.guild.id);
        const ready = ai.providerDefinition.requiresCredential === false || ai.credentialStatus === "configured";
        if (!ready) {
          await interaction.reply({ content: "Configure the provider credential first.", flags: EPHEMERAL });
          return;
        }
        await interaction.showModal(buildModelModal(userId, mode, ai));
      },
    },
    {
      customIdPrefix: PREFIX.AI_MODEL_RESET,
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.AI_MODEL_RESET);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await saveGuildAiModel(interaction.guild.id, null);
        await editPanel(
          interaction,
          await renderAiProvider(interaction.guild.id, userId, mode, "Model reset to the provider default.")
        );
      },
    },
    {
      customIdPrefix: PREFIX.AI_NEXT,
      async execute(interaction) {
        const { userId } = parseScoped(interaction.customId, PREFIX.AI_NEXT);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const ai = await getGuildAiConfig(interaction.guild.id);
        const ready = ai.providerDefinition.requiresCredential === false || ai.credentialStatus === "configured";
        if (!ready) {
          await editPanel(
            interaction,
            await renderAiProvider(interaction.guild.id, userId, MODE.ONBOARD, "Configure a valid provider credential before continuing.")
          );
          return;
        }
        await moveSetupToHumanSupport(interaction.guild.id);
        await editPanel(interaction, await renderHumanSupport(interaction.guild, userId, MODE.ONBOARD));
      },
    },
    {
      customIdPrefix: PREFIX.HUMAN_OPEN,
      async execute(interaction) {
        const { userId } = parseScoped(interaction.customId, PREFIX.HUMAN_OPEN);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await editPanel(interaction, await renderHumanSupport(interaction.guild, userId, MODE.MANAGE));
      },
    },
    {
      customIdPrefix: PREFIX.HUMAN_CATEGORY_OPEN,
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.HUMAN_CATEGORY_OPEN);
        if (!(await assertOwner(interaction, userId))) return;
        await editPanel(interaction, renderHumanCategorySelect(userId, mode));
      },
    },
    {
      customIdPrefix: PREFIX.HUMAN_CATEGORY_CREATE,
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.HUMAN_CATEGORY_CREATE);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const result = await createOrFindEscalationCategory(interaction.guild);
        if (!result.ok || !result.category) {
          await editPanel(
            interaction,
            await renderHumanSupport(
              interaction.guild,
              userId,
              mode,
              result.code === "missing_manage_channels_permission"
                ? "Pixy needs Manage Channels permission to create the Human Support category automatically."
                : "Pixy could not create the Human Support category automatically."
            )
          );
          return;
        }
        const configured = await configureEscalationCategory(interaction.guild, result.category.id);
        const notice = configured.notification.ok
          ? `Human Support category saved as **${result.category.name}**.`
          : `Category saved, but the notification channel could not be prepared: ${configured.notification.code}.`;
        await editPanel(interaction, await renderHumanSupport(interaction.guild, userId, mode, notice));
      },
    },
    {
      customIdPrefix: PREFIX.HUMAN_RETRY_NOTIFICATION,
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.HUMAN_RETRY_NOTIFICATION);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const config = await prisma.guildConfig.findUnique({ where: { guildId: interaction.guild.id } });
        if (!config?.escalationCategoryId) {
          await editPanel(interaction, await renderHumanSupport(interaction.guild, userId, mode, "Choose an escalation category first."));
          return;
        }
        const configured = await configureEscalationCategory(interaction.guild, config.escalationCategoryId);
        const notice = configured.notification.ok
          ? "Human Support notification channel is ready."
          : `Could not prepare the notification channel: ${configured.notification.code}.`;
        await editPanel(interaction, await renderHumanSupport(interaction.guild, userId, mode, notice));
      },
    },
    {
      customIdPrefix: PREFIX.HUMAN_SKIP,
      async execute(interaction) {
        const { userId } = parseScoped(interaction.customId, PREFIX.HUMAN_SKIP);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await skipHumanSupportAndComplete(interaction.guild.id, {
          actorUserId: interaction.user.id,
          guild: interaction.guild,
          discordClient: interaction.client,
        });
        await editPanel(interaction, await renderCompletion(interaction.guild, userId, false));
      },
    },
    {
      customIdPrefix: PREFIX.HUMAN_FINISH,
      async execute(interaction) {
        const { userId } = parseScoped(interaction.customId, PREFIX.HUMAN_FINISH);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const human = await loadHumanSupport(interaction.guild);
        if (!human.category || !human.notification || !human.routes.length) {
          await editPanel(
            interaction,
            await renderHumanSupport(interaction.guild, userId, MODE.ONBOARD, "Finish Human Support configuration first, or choose Skip for Now.")
          );
          return;
        }
        await setEscalationEnabled(interaction.guild.id, true);
        await completeOnboarding(interaction.guild.id, {
          actorUserId: interaction.user.id,
          guild: interaction.guild,
          discordClient: interaction.client,
        });
        await editPanel(interaction, await renderCompletion(interaction.guild, userId, true));
      },
    },
  ],

  selectMenuHandlers: [
    {
      customIdPrefix: PREFIX.TICKET_SELECT,
      type: "channel",
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.TICKET_SELECT);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const selectedIds = interaction.values || [];
        const categories = await validateCategoryIds(interaction.guild, selectedIds);
        if (!selectedIds.length || categories.length !== selectedIds.length) {
          const payload = mode === MODE.ONBOARD
            ? await renderOnboardingTicketSources(interaction.guild, userId, "One or more selected categories are no longer valid.")
            : await renderTicketSourceManager(interaction.guild, userId, "One or more selected categories are no longer valid.");
          await editPanel(interaction, payload);
          return;
        }

        if (mode === MODE.ONBOARD) {
          await setTicketCategories(interaction.guild.id, selectedIds, { guild: interaction.guild });
          await moveSetupToAiProvider(interaction.guild.id);
          await editPanel(
            interaction,
            await renderAiProvider(
              interaction.guild.id,
              userId,
              MODE.ONBOARD,
              `Saved ${selectedIds.length} Ticket Source${selectedIds.length === 1 ? "" : "s"}.`
            )
          );
          return;
        }

        await addTicketCategories(interaction.guild.id, selectedIds, { guild: interaction.guild });
        await editPanel(
          interaction,
          await renderTicketSourceManager(
            interaction.guild,
            userId,
            `Added ${selectedIds.length} Ticket Source${selectedIds.length === 1 ? "" : "s"}.`
          )
        );
      },
    },
    {
      customIdPrefix: PREFIX.TICKET_REMOVE,
      type: "string",
      async execute(interaction) {
        const { userId } = parseScoped(interaction.customId, PREFIX.TICKET_REMOVE);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await removeTicketCategories(interaction.guild.id, interaction.values || [], {
          guild: interaction.guild,
        });
        await editPanel(
          interaction,
          await renderTicketSourceManager(interaction.guild, userId, "Selected Ticket Sources were removed.")
        );
      },
    },
    {
      customIdPrefix: PREFIX.AI_PROVIDER,
      type: "string",
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.AI_PROVIDER);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const providerId = interaction.values?.[0];
        await setGuildAiProvider(interaction.guild.id, providerId);
        await editPanel(
          interaction,
          await renderAiProvider(interaction.guild.id, userId, mode, "AI provider changed. Configure its credential before continuing.")
        );
      },
    },
    {
      customIdPrefix: PREFIX.HUMAN_CATEGORY_SELECT,
      type: "channel",
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.HUMAN_CATEGORY_SELECT);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const categoryId = interaction.values?.[0];
        const category = await getCategory(interaction.guild, categoryId);
        if (!category) {
          await editPanel(interaction, await renderHumanSupport(interaction.guild, userId, mode, "That category no longer exists."));
          return;
        }
        const configured = await configureEscalationCategory(interaction.guild, category.id);
        const notice = configured.notification.ok
          ? `Human Support category saved as **${category.name}**.`
          : `Category saved, but the notification channel could not be prepared: ${configured.notification.code}.`;
        await editPanel(interaction, await renderHumanSupport(interaction.guild, userId, mode, notice));
      },
    },
    {
      customIdPrefix: PREFIX.HUMAN_ROLE,
      type: "role",
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.HUMAN_ROLE);
        if (!(await assertOwner(interaction, userId))) return;
        const roleId = interaction.values?.[0];
        const role = await getRole(interaction.guild, roleId);
        if (!role || role.id === interaction.guild.id) {
          await interaction.reply({
            content: "Choose a valid server role. `@everyone` cannot be used as a support route.",
            flags: EPHEMERAL,
          });
          return;
        }
        const existing = await prisma.adminRoute.findUnique({
          where: {
            guildId_roleId: {
              guildId: interaction.guild.id,
              roleId: role.id,
            },
          },
        });
        await interaction.showModal(buildRoleDescriptionModal(userId, mode, role, existing));
      },
    },
    {
      customIdPrefix: PREFIX.HUMAN_REMOVE_ROUTE,
      type: "string",
      async execute(interaction) {
        const { userId } = parseScoped(interaction.customId, PREFIX.HUMAN_REMOVE_ROUTE);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const result = await removeSupportRoutes(interaction.guild.id, interaction.values || []);
        await editPanel(
          interaction,
          await renderHumanSupport(
            interaction.guild,
            userId,
            MODE.MANAGE,
            `Removed ${result.removed} support route${result.removed === 1 ? "" : "s"}.`
          )
        );
      },
    },
  ],

  modalHandlers: [
    {
      customIdPrefix: PREFIX.AI_CREDENTIAL_MODAL,
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.AI_CREDENTIAL_MODAL);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const credential = cleanText(interaction.fields.getTextInputValue("provider_credential"));
        const ai = await getGuildAiConfig(interaction.guild.id);
        try {
          const validation = await validateProviderCredential(ai.provider, credential);
          const currentOverride = ai.modelSource === "guild" ? ai.aiConfigRecord?.model || null : null;
          const nextModel = currentOverride && Array.isArray(validation?.modelIds) && !validation.modelIds.includes(currentOverride)
            ? null
            : currentOverride;
          await saveGuildAiCredential(interaction.guild.id, credential, {
            provider: ai.provider,
            model: nextModel,
          });
          await editPanel(
            interaction,
            await renderAiProvider(
              interaction.guild.id,
              userId,
              mode,
              `${ai.providerDefinition.displayName} credential validated, encrypted, and saved.`
            )
          );
        } catch (error) {
          const message = error?.status === 401
            ? `${ai.providerDefinition.displayName} rejected that credential.`
            : `Pixy could not validate that ${ai.providerDefinition.displayName} credential.`;
          await editPanel(interaction, await renderAiProvider(interaction.guild.id, userId, mode, message));
        }
      },
    },
    {
      customIdPrefix: PREFIX.AI_MODEL_MODAL,
      async execute(interaction) {
        const { mode, userId } = parseScoped(interaction.customId, PREFIX.AI_MODEL_MODAL);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const modelId = cleanText(interaction.fields.getTextInputValue("provider_model"));
        try {
          const ai = await getGuildAiConfig(interaction.guild.id, { requireCredential: true });
          await validateProviderModel(ai.provider, {
            credential: ai.credential,
            modelId,
          });
          await saveGuildAiModel(interaction.guild.id, modelId);
          await editPanel(
            interaction,
            await renderAiProvider(interaction.guild.id, userId, mode, `Model verified and saved: \`${modelId}\`.`)
          );
        } catch (error) {
          await editPanel(
            interaction,
            await renderAiProvider(interaction.guild.id, userId, mode, error?.message || "Pixy could not verify that model.")
          );
        }
      },
    },
    {
      customIdPrefix: PREFIX.HUMAN_DESCRIPTION_MODAL,
      async execute(interaction) {
        const { mode, userId, extra } = parseScoped(interaction.customId, PREFIX.HUMAN_DESCRIPTION_MODAL);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const roleId = extra[0];
        const role = await getRole(interaction.guild, roleId);
        if (!role || role.id === interaction.guild.id) {
          await editPanel(interaction, await renderHumanSupport(interaction.guild, userId, mode, "That support role no longer exists."));
          return;
        }
        const description = cleanText(interaction.fields.getTextInputValue("description"));
        try {
          await upsertSupportRoute(interaction.guild.id, role.id, description);
        } catch (error) {
          await editPanel(interaction, await renderHumanSupport(interaction.guild, userId, mode, error?.message || "Could not save the support route."));
          return;
        }

        if (mode === MODE.ONBOARD) {
          await completeOnboarding(interaction.guild.id, {
            actorUserId: interaction.user.id,
            guild: interaction.guild,
            discordClient: interaction.client,
          });
          await editPanel(
            interaction,
            await renderCompletion(interaction.guild, userId, true, `Support route for **${role.name}** saved.`)
          );
          return;
        }

        await editPanel(
          interaction,
          await renderHumanSupport(interaction.guild, userId, MODE.MANAGE, `Support route for **${role.name}** saved.`)
        );
      },
    },
  ],
};

module.exports = Object.assign(command, {
  MODE,
  PREFIX,
  buildCredentialModal,
  buildModelModal,
  buildRoleDescriptionModal,
  loadHumanSupport,
  loadSetupOverview,
  parseScoped,
  renderAiProvider,
  renderCompletion,
  renderDashboard,
  renderHumanSupport,
  renderOnboardingTicketSources,
  renderTicketSourceManager,
});
