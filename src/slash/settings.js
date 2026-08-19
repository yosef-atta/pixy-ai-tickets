const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { prisma } = require("../config/prisma");
const { defaultAiConfig, getGuildAiConfig, getOrCreateGuildSetting } = require("../config/ai");
const {
  removeGuildAiCredential,
  saveGuildAiCredential,
  saveGuildAiModel,
} = require("../config/guildAiConfig");
const {
  validateProviderCredential,
  validateProviderModel,
} = require("../ai/providers/providerRegistry");
const { getBlockedTermsStats, addGuildBlockedTerm, removeGuildBlockedTerm } = require("../utils/blockedTerms");
const { createStringSelectMenus } = require("../utils/selectMenuHelper");
const { BILLING_PLANS } = require("../billing/constants");
const { loadBillingSummary } = require("../billing/billingService");

const EPHEMERAL = 64;
const PREFIX = Object.freeze({
  HOME: "settings_home:",
  NAV: "settings_nav:",
  TOGGLE: "settings_toggle:",
  CLOSE: "settings_close:",
  BADWORD_ACTION: "settings_badwords_action:",
  BADWORD_ADD_MODAL: "settings_badwords_add_modal:",
  BADWORD_REMOVE_MODAL: "settings_badwords_remove_modal:",
  API_SET: "settings_api_set:",
  API_MODAL: "settings_api_modal:",
  API_REMOVE: "settings_api_remove:",
  MODEL_SET: "settings_model_set:",
  MODEL_MODAL: "settings_model_modal:",
  MODEL_RESET: "settings_model_reset:",
});

const PAGES = Object.freeze({ HOME: "home", FEATURES: "features", ESCALATION: "escalation", AIAPI: "aiapi", BADWORDS: "badwords" });
const FEATURES = Object.freeze([
  { field: "aiReplyEnabled", label: "AI Reply", description: "Enable or disable automatic AI ticket replies", emoji: "🤖" },
  { field: "closeTicketEnabled", label: "Close Ticket", description: "Allow Pixy to close explicitly requested tickets", emoji: "🔒" },
  { field: "renameReviewEnabled", label: "Rename Review", description: "Enable or disable AI review for ticket names", emoji: "✏️" },
  { field: "escalationEnabled", label: "Escalation", description: "Enable or disable ticket escalation", emoji: "🚨" },
  { field: "agentActionsEnabled", label: "Agent Actions", description: "Allow Pixy to perform validated ticket actions", emoji: "🛠️" },
]);
const FEATURE_FIELDS = new Set(FEATURES.map(({ field }) => field));
const scoped = (prefix, userId) => `${prefix}${userId}`;
const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();

async function assertOwner(interaction, userId) {
  if (interaction.guild && interaction.user.id === userId && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  await interaction.reply({ content: "Only the administrator who opened /pixy-settings can use this control.", flags: EPHEMERAL });
  return false;
}

function navigation(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(scoped(PREFIX.HOME, userId)).setLabel("Home").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(scoped(PREFIX.CLOSE, userId)).setLabel("Close").setStyle(ButtonStyle.Secondary)
  );
}

function getFeaturePlanDescription(summary) {
  if (summary.plan !== BILLING_PLANS.EXPIRED) {
    return `Effective plan: **${summary.planLabel}**. Disabled features are blocked at execution time, including actions requested by the AI.`;
  }
  return [
    "Effective plan: **Expired**.",
    "Generic AI replies and ticket AI On/Off remain available. Learned AI context, learned additions, and agent ticket actions stay subscription-locked even when their stored feature preferences are enabled.",
    "Use `/pixy-billing` to view activation options.",
  ].join("\n");
}

function credentialStatusLabel(config) {
  if (config.credentialStatus === "configured") return "Configured";
  if (config.credentialStatus === "invalid") return "Invalid";
  if (config.credentialStatus === "not_required") return "Not required";
  return "Required";
}

async function renderHome(guildId, userId) {
  const [setting, billing, ai] = await Promise.all([
    getOrCreateGuildSetting(guildId),
    loadBillingSummary(guildId),
    getGuildAiConfig(guildId),
  ]);
  const enabledCount = FEATURES.filter(({ field }) => setting[field]).length;
  const embed = new EmbedBuilder()
    .setTitle("🤖 Pixy Settings")
    .setColor(0x5865f2)
    .setDescription("Select a category below to configure Pixy for this server. Subscription availability is enforced independently from stored feature preferences.")
    .addFields(
      { name: "Plan", value: billing.planLabel, inline: true },
      { name: "Features", value: `${enabledCount}/${FEATURES.length} enabled`, inline: true },
      { name: "AI Provider", value: `${ai.providerDefinition.displayName} — ${credentialStatusLabel(ai)}`, inline: true },
      { name: "Model", value: `\`${ai.model}\``, inline: true },
      { name: "Billing", value: "Use `/pixy-billing` for dates, remaining time, and activation instructions.", inline: false }
    );
  const menus = createStringSelectMenus({
    customId: scoped(PREFIX.NAV, userId),
    placeholder: "Select a settings category...",
    options: [
      { label: "Features", description: "Enable or disable Pixy's server preferences", value: PAGES.FEATURES, emoji: "📝" },
      { label: "Escalation", description: "View escalation configuration", value: PAGES.ESCALATION, emoji: "🚨" },
      { label: "AI Provider", description: "Manage the selected provider credential and model", value: PAGES.AIAPI, emoji: "🔑" },
      { label: "Bad Words", description: "Manage custom blocked terms", value: PAGES.BADWORDS, emoji: "🛡️" },
    ],
  });
  return { content: null, embeds: [embed], components: [...menus] };
}

async function renderFeatures(guildId, userId) {
  const [setting, billing] = await Promise.all([
    getOrCreateGuildSetting(guildId),
    loadBillingSummary(guildId),
  ]);
  const menus = createStringSelectMenus({
    customId: scoped(PREFIX.TOGGLE, userId),
    placeholder: "Select a feature preference to toggle...",
    options: FEATURES.map((feature) => ({
      label: `Toggle ${feature.label}`,
      description: feature.description,
      value: feature.field,
      emoji: feature.emoji,
    })),
  });
  return {
    content: null,
    embeds: [new EmbedBuilder()
      .setTitle("📝 Feature Settings")
      .setColor(billing.plan === BILLING_PLANS.EXPIRED ? 0xed4245 : 0x5865f2)
      .setDescription(getFeaturePlanDescription(billing))
      .addFields(...FEATURES.map(({ field, label }) => ({
        name: label,
        value: setting[field] ? "✅ Preference enabled" : "❌ Preference disabled",
        inline: true,
      })))],
    components: [...menus, navigation(userId)],
  };
}

async function renderEscalation(guildId, userId) {
  const [config, setting, routeCount, billing] = await Promise.all([
    prisma.guildConfig.findUnique({ where: { guildId } }),
    getOrCreateGuildSetting(guildId),
    prisma.adminRoute.count({ where: { guildId, enabled: true } }),
    loadBillingSummary(guildId),
  ]);
  return {
    content: null,
    embeds: [new EmbedBuilder()
      .setTitle("🚨 Escalation Settings")
      .setColor(0xed4245)
      .setDescription(billing.plan === BILLING_PLANS.EXPIRED
        ? "Escalation configuration is preserved, but execution requires Trial, Pro, or Partner. Use `/pixy-billing`."
        : "Use /pixy-admins to configure routes and channels.")
      .addFields(
        { name: "Plan", value: billing.planLabel, inline: true },
        { name: "Feature preference", value: setting.escalationEnabled ? "✅ Enabled" : "❌ Disabled", inline: true },
        { name: "Category", value: config?.escalationCategoryId ? `<#${config.escalationCategoryId}>` : "Not configured", inline: true },
        { name: "Notifications", value: config?.escalationNotificationChannelId ? `<#${config.escalationNotificationChannelId}>` : "Not configured", inline: true },
        { name: "Routes", value: `${routeCount}/${config?.maxAdminRoutes || defaultAiConfig.maxAdminRoutesPerGuild}`, inline: true }
      )],
    components: [navigation(userId)],
  };
}

async function renderAiApi(guildId, userId) {
  const config = await getGuildAiConfig(guildId);
  const provider = config.providerDefinition;
  const configured = config.credentialStatus === "configured" || config.credentialStatus === "not_required";
  return {
    content: null,
    embeds: [new EmbedBuilder()
      .setTitle("🔑 AI Provider Settings")
      .setColor(0xfee75c)
      .setDescription(
        provider.requiresCredential
          ? `This server currently uses **${provider.displayName}** and supplies its own provider credential. Existing credentials are never displayed.`
          : `This server currently uses **${provider.displayName}**. No external credential is required.`
      )
      .addFields(
        { name: "Provider", value: provider.displayName, inline: true },
        { name: "Credential", value: config.credentialStatus === "configured" ? "✅ Configured" : config.credentialStatus === "invalid" ? "⚠️ Invalid" : config.credentialStatus === "not_required" ? "✅ Not required" : "❌ Required", inline: true },
        { name: "Model", value: `\`${config.model}\``, inline: true },
        { name: "Model Source", value: config.modelSource === "guild" ? "Server override" : "Provider default", inline: true }
      )],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(scoped(PREFIX.API_SET, userId))
          .setLabel(config.credentialStatus === "configured" ? "Replace Credential" : "Set Credential")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!provider.requiresCredential),
        new ButtonBuilder()
          .setCustomId(scoped(PREFIX.API_REMOVE, userId))
          .setLabel("Remove Credential")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!config.aiConfigRecord?.credentialEncrypted),
        new ButtonBuilder()
          .setCustomId(scoped(PREFIX.MODEL_SET, userId))
          .setLabel("Set Model")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(provider.requiresCredential && !configured),
        new ButtonBuilder()
          .setCustomId(scoped(PREFIX.MODEL_RESET, userId))
          .setLabel("Reset Model")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(config.modelSource !== "guild")
      ),
      navigation(userId),
    ],
  };
}

async function renderBadWords(guildId, userId) {
  const stats = await getBlockedTermsStats(guildId);
  const embed = new EmbedBuilder()
    .setTitle("🛡️ Blocked Terms Settings")
    .setColor(0xed4245)
    .setDescription("Type the exact custom term when removing it; no paginated menus are needed.")
    .addFields(
      { name: "Global Terms", value: String(stats.globalCount), inline: true },
      { name: "Custom Terms", value: `${stats.guildBlockedCount}/${stats.maxGuildCustom}`, inline: true },
      { name: "Allow Terms", value: String(stats.guildAllowedCount), inline: true }
    );
  if (stats.globalByCategory) {
    embed.addFields({ name: "Global by Category", value: Object.entries(stats.globalByCategory).map(([category, count]) => `${category}: ${count}`).join(", ") || "None" });
  }
  if (stats.guildBlockedTerms.length) {
    embed.addFields({ name: "Custom list preview", value: `\`${stats.guildBlockedTerms.slice(0, 20).join(", ")}\`` });
  }
  const actionMenus = createStringSelectMenus({
    customId: scoped(PREFIX.BADWORD_ACTION, userId),
    placeholder: "Select an action...",
    options: [
      { label: "Add Custom Term", description: "Add a term to this server's blocked list", value: "add", emoji: "🟢" },
      { label: "Remove Custom Term", description: "Type the exact term to remove", value: "remove", emoji: "🗑️" },
    ],
  });
  return { content: null, embeds: [embed], components: [...actionMenus, navigation(userId)] };
}

async function render(page, guildId, userId) {
  if (page === PAGES.FEATURES) return renderFeatures(guildId, userId);
  if (page === PAGES.ESCALATION) return renderEscalation(guildId, userId);
  if (page === PAGES.AIAPI) return renderAiApi(guildId, userId);
  if (page === PAGES.BADWORDS) return renderBadWords(guildId, userId);
  return renderHome(guildId, userId);
}

async function renderWithNotice(page, guildId, userId, content) {
  return {
    ...(await render(page, guildId, userId)),
    content,
    allowedMentions: { parse: [] },
  };
}

function singleInputModal({ customId, title, inputId, label, placeholder, maxLength }) {
  const input = new TextInputBuilder().setCustomId(inputId).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true);
  if (placeholder) input.setPlaceholder(placeholder);
  if (maxLength) input.setMaxLength(maxLength);
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(new ActionRowBuilder().addComponents(input));
}

function credentialModal(userId, config) {
  const provider = config.providerDefinition;
  return singleInputModal({
    customId: scoped(PREFIX.API_MODAL, userId),
    title: `Set ${provider.displayName} Credential`.slice(0, 45),
    inputId: "provider_credential",
    label: provider.credentialLabel.slice(0, 45),
    placeholder: provider.credentialPlaceholder || undefined,
  });
}

function modelModal(userId, config) {
  const provider = config.providerDefinition;
  return singleInputModal({
    customId: scoped(PREFIX.MODEL_MODAL, userId),
    title: `Set ${provider.displayName} Model`.slice(0, 45),
    inputId: "provider_model",
    label: "Exact model ID",
    placeholder: provider.defaultModel,
  });
}

module.exports = {
  data: new SlashCommandBuilder().setName("settings").setDescription("Configure Pixy AI settings for this server.").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  guildOnly: true,
  userPermissions: [PermissionFlagsBits.Administrator],

  async execute(interaction) {
    await getOrCreateGuildSetting(interaction.guild.id);
    await interaction.reply({ ...(await render(PAGES.HOME, interaction.guild.id, interaction.user.id)), flags: EPHEMERAL, allowedMentions: { parse: [] } });
  },

  selectMenuHandlers: [
    {
      customIdPrefix: PREFIX.NAV,
      type: "string",
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.NAV.length).split(":")[0];
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.deferUpdate();
        const page = interaction.values[0] === "reset" ? PAGES.HOME : interaction.values[0];
        await interaction.editReply(await render(page, interaction.guild.id, userId));
      },
    },
    {
      customIdPrefix: PREFIX.TOGGLE,
      type: "string",
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.TOGGLE.length).split(":")[0];
        if (!(await assertOwner(interaction, userId))) return;
        const field = interaction.values[0];
        if (field === "reset") {
          await interaction.update(await render(PAGES.FEATURES, interaction.guild.id, userId));
          return;
        }
        if (!FEATURE_FIELDS.has(field)) return;
        const setting = await getOrCreateGuildSetting(interaction.guild.id);
        const enabled = !setting[field];
        await prisma.$transaction(async (tx) => {
          await tx.guildSetting.update({ where: { guildId: interaction.guild.id }, data: { [field]: enabled } });
          if (field === "aiReplyEnabled") await tx.guildConfig.updateMany({ where: { guildId: interaction.guild.id }, data: { aiEnabled: enabled } });
        });
        await interaction.update(await render(PAGES.FEATURES, interaction.guild.id, userId));
      },
    },
    {
      customIdPrefix: PREFIX.BADWORD_ACTION,
      type: "string",
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.BADWORD_ACTION.length).split(":")[0];
        if (!(await assertOwner(interaction, userId))) return;
        const val = interaction.values[0];
        if (val === "reset") {
          await interaction.update(await render(PAGES.BADWORDS, interaction.guild.id, userId));
          return;
        }
        const remove = val === "remove";
        if (remove) {
          const stats = await getBlockedTermsStats(interaction.guild.id);
          if (!stats.guildBlockedTerms.length) {
            await interaction.update(await renderWithNotice(PAGES.BADWORDS, interaction.guild.id, userId, "No custom terms to remove."));
            return;
          }
        }
        await interaction.showModal(singleInputModal({
          customId: scoped(remove ? PREFIX.BADWORD_REMOVE_MODAL : PREFIX.BADWORD_ADD_MODAL, userId),
          title: remove ? "Remove Custom Term" : "Add Custom Term",
          inputId: "word",
          label: remove ? "Exact term to remove" : "Term to add",
          maxLength: 191,
        }));
      },
    },
  ],

  buttonHandlers: [
    { customIdPrefix: PREFIX.HOME, async execute(interaction) { const userId = interaction.customId.slice(PREFIX.HOME.length); if (await assertOwner(interaction, userId)) await interaction.update(await render(PAGES.HOME, interaction.guild.id, userId)); } },
    { customIdPrefix: PREFIX.CLOSE, async execute(interaction) { const userId = interaction.customId.slice(PREFIX.CLOSE.length); if (await assertOwner(interaction, userId)) await interaction.update({ content: "Settings panel closed.", embeds: [], components: [] }); } },
    {
      customIdPrefix: PREFIX.API_SET,
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.API_SET.length);
        if (!(await assertOwner(interaction, userId))) return;
        const config = await getGuildAiConfig(interaction.guild.id);
        if (!config.providerDefinition.requiresCredential) {
          await interaction.reply({ content: `${config.providerDefinition.displayName} does not require an external credential.`, flags: EPHEMERAL });
          return;
        }
        await interaction.showModal(credentialModal(userId, config));
      },
    },
    {
      customIdPrefix: PREFIX.MODEL_SET,
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.MODEL_SET.length);
        if (!(await assertOwner(interaction, userId))) return;
        const config = await getGuildAiConfig(interaction.guild.id);
        await interaction.showModal(modelModal(userId, config));
      },
    },
    {
      customIdPrefix: PREFIX.API_REMOVE,
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.API_REMOVE.length);
        if (!(await assertOwner(interaction, userId))) return;
        await removeGuildAiCredential(interaction.guild.id, { clearModel: true });
        await interaction.update(await render(PAGES.AIAPI, interaction.guild.id, userId));
      },
    },
    {
      customIdPrefix: PREFIX.MODEL_RESET,
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.MODEL_RESET.length);
        if (!(await assertOwner(interaction, userId))) return;
        await saveGuildAiModel(interaction.guild.id, null);
        await interaction.update(await render(PAGES.AIAPI, interaction.guild.id, userId));
      },
    },
  ],

  modalHandlers: [
    {
      customIdPrefix: PREFIX.API_MODAL,
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.API_MODAL.length);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.deferUpdate();
        const credential = cleanText(interaction.fields.getTextInputValue("provider_credential"));
        const config = await getGuildAiConfig(interaction.guild.id);
        const provider = config.providerDefinition;
        try {
          const validation = await validateProviderCredential(config.provider, credential);
          const currentOverride = config.modelSource === "guild" ? config.aiConfigRecord?.model || null : null;
          const nextModel = currentOverride && Array.isArray(validation?.modelIds) && !validation.modelIds.includes(currentOverride)
            ? null
            : currentOverride;
          await saveGuildAiCredential(interaction.guild.id, credential, {
            provider: config.provider,
            model: nextModel,
          });
          await interaction.editReply(await renderWithNotice(PAGES.AIAPI, interaction.guild.id, userId, `✅ ${provider.displayName} credential validated, encrypted, and saved.`));
        } catch (error) {
          const message = error?.status === 401
            ? `${provider.displayName} rejected that credential.`
            : `Pixy could not validate that ${provider.displayName} credential.`;
          await interaction.editReply(await renderWithNotice(PAGES.AIAPI, interaction.guild.id, userId, `❌ ${message}`));
        }
      },
    },
    {
      customIdPrefix: PREFIX.MODEL_MODAL,
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.MODEL_MODAL.length);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.deferUpdate();
        const modelId = cleanText(interaction.fields.getTextInputValue("provider_model"));
        try {
          const config = await getGuildAiConfig(interaction.guild.id, { requireCredential: true });
          await validateProviderModel(config.provider, {
            credential: config.credential,
            modelId,
          });
          await saveGuildAiModel(interaction.guild.id, modelId);
          await interaction.editReply(await renderWithNotice(PAGES.AIAPI, interaction.guild.id, userId, `✅ Model verified and saved: \`${modelId}\`.`));
        } catch (error) {
          await interaction.editReply(await renderWithNotice(PAGES.AIAPI, interaction.guild.id, userId, `❌ ${error?.message || "Pixy could not verify that model."}`));
        }
      },
    },
    {
      customIdPrefix: PREFIX.BADWORD_ADD_MODAL,
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.BADWORD_ADD_MODAL.length);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.deferUpdate();
        const result = await addGuildBlockedTerm(interaction.guild.id, cleanText(interaction.fields.getTextInputValue("word")));
        const message = result.ok ? "✅ Custom term added." : `❌ Could not add that term: ${result.code}.`;
        await interaction.editReply(await renderWithNotice(PAGES.BADWORDS, interaction.guild.id, userId, message));
      },
    },
    {
      customIdPrefix: PREFIX.BADWORD_REMOVE_MODAL,
      async execute(interaction) {
        const userId = interaction.customId.slice(PREFIX.BADWORD_REMOVE_MODAL.length);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.deferUpdate();
        const result = await removeGuildBlockedTerm(interaction.guild.id, cleanText(interaction.fields.getTextInputValue("word")));
        const message = result?.ok === false ? `❌ Could not remove that term: ${result.code}.` : "✅ Custom term removed.";
        await interaction.editReply(await renderWithNotice(PAGES.BADWORDS, interaction.guild.id, userId, message));
      },
    },
  ],
};
