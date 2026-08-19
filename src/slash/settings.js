const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const { prisma } = require("../config/prisma");
const { getOrCreateGuildSetting } = require("../config/ai");
const { loadBillingSummary } = require("../billing/billingService");
const {
  getGuildLearnedKnowledgeWriteAvailability,
  getSubscriptionRejectionMessage,
} = require("../billing/entitlementService");
const {
  TICKET_OPERATING_MODES,
  resolveTicketOperatingMode,
} = require("../features/ticketOperatingMode");
const {
  setTicketOperatingMode,
  toggleBehaviorField,
} = require("../settings/ticketBehaviorService");
const {
  KNOWLEDGE_TYPE_FREEFORM,
  addKnowledgeFreeform,
  addKnowledgeQna,
  clearKnowledge,
  deleteKnowledgeItem,
  getKnowledgeOverview,
  listKnowledgeItems,
} = require("../settings/knowledgeService");
const {
  excludeTicket,
  listExcludedTickets,
  restoreExcludedTicket,
  validateExcludedTicketTarget,
} = require("../settings/excludedTicketsService");
const {
  listResolvedTicketSources,
} = require("../config/ticketSources");
const {
  addGuildAllowedTerm,
  addGuildBlockedTerm,
  getBlockedTermsStats,
  removeGuildAllowedTerm,
  removeGuildBlockedTerm,
} = require("../utils/blockedTerms");
const { createStringSelectMenus } = require("../utils/selectMenuHelper");

const EPHEMERAL = 64;
const KNOWLEDGE_PAGE_SIZE = 8;
const EXCLUDED_PREVIEW_LIMIT = 24;

const PREFIX = Object.freeze({
  HOME: "settings_home:",
  NAV: "settings_nav:",
  CLOSE: "settings_close:",

  MODE: "settings_mode:",
  TOGGLE: "settings_toggle:",

  KNOWLEDGE_ADD_QNA: "settings_knowledge_add_qna:",
  KNOWLEDGE_ADD_QNA_MODAL: "settings_knowledge_add_qna_modal:",
  KNOWLEDGE_ADD_FREEFORM: "settings_knowledge_add_freeform:",
  KNOWLEDGE_ADD_FREEFORM_MODAL: "settings_knowledge_add_freeform_modal:",
  KNOWLEDGE_DELETE: "settings_knowledge_delete:",
  KNOWLEDGE_PAGE: "settings_knowledge_page:",
  KNOWLEDGE_CLEAR: "settings_knowledge_clear:",
  KNOWLEDGE_CLEAR_CONFIRM: "settings_knowledge_clear_confirm:",
  KNOWLEDGE_CLEAR_CANCEL: "settings_knowledge_clear_cancel:",

  SAFETY_ADD_BLOCKED: "settings_safety_add_blocked:",
  SAFETY_ADD_BLOCKED_MODAL: "settings_safety_add_blocked_modal:",
  SAFETY_REMOVE_BLOCKED: "settings_safety_remove_blocked:",
  SAFETY_REMOVE_BLOCKED_MODAL: "settings_safety_remove_blocked_modal:",
  SAFETY_ADD_ALLOWED: "settings_safety_add_allowed:",
  SAFETY_ADD_ALLOWED_MODAL: "settings_safety_add_allowed_modal:",
  SAFETY_REMOVE_ALLOWED: "settings_safety_remove_allowed:",
  SAFETY_REMOVE_ALLOWED_MODAL: "settings_safety_remove_allowed_modal:",

  EXCLUDED_ADD: "settings_excluded_add:",
  EXCLUDED_REASON_YES: "settings_excluded_reason_yes:",
  EXCLUDED_REASON_NO: "settings_excluded_reason_no:",
  EXCLUDED_REASON_MODAL: "settings_excluded_reason_modal:",
  EXCLUDED_CANCEL: "settings_excluded_cancel:",
  EXCLUDED_REMOVE: "settings_excluded_remove:",
});

const PAGES = Object.freeze({
  HOME: "home",
  BEHAVIOR: "behavior",
  KNOWLEDGE: "knowledge",
  SAFETY: "safety",
  EXCLUDED: "excluded",
});

const BEHAVIOR_FEATURES = Object.freeze([
  {
    field: "aiReplyEnabled",
    label: "AI Replies",
    description: "Automatic AI replies inside tracked tickets",
    emoji: "🤖",
  },
  {
    field: "closeTicketEnabled",
    label: "Close Ticket",
    description: "Allow validated close actions when explicitly requested",
    emoji: "🔒",
  },
  {
    field: "renameReviewEnabled",
    label: "Rename Ticket",
    description: "Allow validated ticket rename actions",
    emoji: "✏️",
  },
  {
    field: "escalationEnabled",
    label: "Human Escalation",
    description: "Allow handoff to configured Human Support routes",
    emoji: "🚨",
  },
  {
    field: "agentActionsEnabled",
    label: "Agent Actions",
    description: "Allow Pixy to execute validated ticket actions",
    emoji: "🛠️",
  },
]);
const BEHAVIOR_FIELDS = new Set(BEHAVIOR_FEATURES.map(({ field }) => field));

const scoped = (prefix, userId, ...parts) =>
  `${prefix}${[userId, ...parts].filter((part) => part !== undefined && part !== null).join(":")}`;
const parseScoped = (customId, prefix) =>
  String(customId || "").slice(prefix.length).split(":");

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, maxLength = 180) {
  const text = cleanText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 3)).trim()}...`;
}

function shortId(value) {
  return String(value || "").slice(0, 8);
}

async function assertOwner(interaction, userId) {
  const allowed =
    interaction.guild &&
    interaction.user.id === userId &&
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  if (allowed) return true;

  await interaction.reply({
    content: "Only the administrator who opened `/pixy-settings` can use this control.",
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
  const finalPayload = {
    allowedMentions: { parse: [] },
    ...payload,
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(finalPayload);
    return;
  }
  await interaction.update(finalPayload);
}

function navigation(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.HOME, userId))
      .setLabel("Settings Home")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.CLOSE, userId))
      .setLabel("Close")
      .setStyle(ButtonStyle.Secondary)
  );
}

function pageMenu(userId) {
  return createStringSelectMenus({
    customId: scoped(PREFIX.NAV, userId),
    placeholder: "Choose a settings section...",
    includeReset: false,
    options: [
      {
        label: "Ticket Behavior",
        description: "AI replies, operating mode, actions, and escalation preference",
        value: PAGES.BEHAVIOR,
        emoji: "🎛️",
      },
      {
        label: "Knowledge",
        description: "Manage the server information Pixy learns",
        value: PAGES.KNOWLEDGE,
        emoji: "📚",
      },
      {
        label: "Safety",
        description: "Blocked terms and false-positive exceptions",
        value: PAGES.SAFETY,
        emoji: "🛡️",
      },
      {
        label: "Excluded Tickets",
        description: "Ticket channels or threads Pixy should ignore",
        value: PAGES.EXCLUDED,
        emoji: "🚫",
      },
    ],
  });
}

function modeLabel(mode) {
  if (mode === TICKET_OPERATING_MODES.FULL) return "Full Ticket Control";
  if (mode === TICKET_OPERATING_MODES.OVERLAY) return "Smart Overlay";
  return "Custom";
}

function enabledLabel(enabled) {
  return enabled ? "✅ Enabled" : "❌ Disabled";
}

function formatPreflightIssues(preflight) {
  const lines = [];
  for (const issue of preflight?.issues || []) {
    const label = issue.sourceName ||
      (issue.scope === "server" ? "Server permissions" : issue.scope || "Pixy");
    const detail = issue.labels?.join(", ") || issue.code || "permission check failed";
    lines.push(`• **${label}**: ${detail}`);
  }
  return lines.join("\n") || "• Pixy could not verify the permissions required for Full Ticket Control.";
}

function behaviorPlanNote(billing) {
  if (billing.plan === "expired") {
    return [
      `Effective plan: **${billing.planLabel}**.`,
      "Stored preferences are preserved, but premium agent actions remain entitlement-gated at execution time.",
      "Use `/pixy-billing` for activation details.",
    ].join("\n");
  }
  return `Effective plan: **${billing.planLabel}**. Runtime entitlement checks still apply to premium actions.`;
}

async function renderHome(guild, userId, notice = null) {
  const guildId = guild.id;
  const [setting, billing, knowledge, safety, excludedCount] = await Promise.all([
    getOrCreateGuildSetting(guildId),
    loadBillingSummary(guildId),
    getKnowledgeOverview(guildId),
    getBlockedTermsStats(guildId),
    prisma.guildIgnoredChannel.count({ where: { guildId } }),
  ]);
  const mode = resolveTicketOperatingMode(setting);

  const embed = new EmbedBuilder()
    .setTitle("Pixy Settings")
    .setColor(0x5865f2)
    .setDescription([
      "Manage Pixy's secondary behavior and server content here.",
      "Ticket Sources, AI Provider credentials/models, and Human Support routes live in `/pixy-setup`.",
    ].join("\n"))
    .addFields(
      { name: "Plan", value: billing.planLabel, inline: true },
      { name: "Ticket Behavior", value: modeLabel(mode), inline: true },
      { name: "Knowledge", value: `${knowledge.total}/${knowledge.limit}`, inline: true },
      {
        name: "Safety",
        value: `${safety.guildBlockedCount} custom blocked • ${safety.guildAllowedCount} allow exceptions`,
        inline: true,
      },
      { name: "Excluded Tickets", value: String(excludedCount), inline: true },
      {
        name: "Core Setup",
        value: "Use `/pixy-setup` to manage Ticket Sources, AI Provider, and Human Support.",
        inline: false,
      }
    );

  return {
    content: notice,
    embeds: [embed],
    components: [...pageMenu(userId), navigation(userId)],
  };
}

async function renderBehavior(guild, userId, notice = null) {
  const guildId = guild.id;
  const [setting, billing, config, routeCount] = await Promise.all([
    getOrCreateGuildSetting(guildId),
    loadBillingSummary(guildId),
    prisma.guildConfig.findUnique({ where: { guildId } }),
    prisma.adminRoute.count({ where: { guildId, enabled: true } }),
  ]);
  const mode = resolveTicketOperatingMode(setting);
  const humanConfigured = Boolean(config?.escalationCategoryId && routeCount > 0);

  const embed = new EmbedBuilder()
    .setTitle("Ticket Behavior")
    .setColor(mode === TICKET_OPERATING_MODES.FULL ? 0xfee75c : 0x5865f2)
    .setDescription([
      behaviorPlanNote(billing),
      "",
      "**Smart Overlay** keeps Pixy away from the ticket lifecycle: Close and Rename stay off. Human Escalation can stay enabled or disabled independently.",
      "**Full Ticket Control** enables Close, Rename, and Escalation only after Pixy passes its permission preflight.",
      "**Thread tickets always use Smart Overlay** for lifecycle safety, even when channel tickets use Full Ticket Control.",
    ].join("\n"))
    .addFields(
      { name: "Operating Mode", value: `**${modeLabel(mode)}**`, inline: true },
      {
        name: "Human Support",
        value: humanConfigured ? `Configured • ${routeCount} route${routeCount === 1 ? "" : "s"}` : "Needs `/pixy-setup`",
        inline: true,
      },
      ...BEHAVIOR_FEATURES.map(({ field, label }) => ({
        name: label,
        value: enabledLabel(setting[field] === true),
        inline: true,
      }))
    );

  const modeMenu = createStringSelectMenus({
    customId: scoped(PREFIX.MODE, userId),
    placeholder: "Apply an operating mode preset...",
    includeReset: false,
    options: [
      {
        label: "Smart Overlay (recommended)",
        description: "Disable Close and Rename; preserve your escalation choice",
        value: TICKET_OPERATING_MODES.OVERLAY,
        emoji: "🛡️",
      },
      {
        label: "Full Ticket Control",
        description: "Enable Close, Rename, and Human Escalation after preflight",
        value: TICKET_OPERATING_MODES.FULL,
        emoji: "🧰",
      },
    ],
  });

  const toggleMenu = createStringSelectMenus({
    customId: scoped(PREFIX.TOGGLE, userId),
    placeholder: "Toggle an individual behavior...",
    options: BEHAVIOR_FEATURES.map((feature) => ({
      label: `Toggle ${feature.label}`,
      description: feature.description,
      value: feature.field,
      emoji: feature.emoji,
    })),
  });

  return {
    content: notice,
    embeds: [embed],
    components: [...modeMenu, ...toggleMenu, navigation(userId)],
  };
}

function knowledgeTypeLabel(item) {
  return item?.type === KNOWLEDGE_TYPE_FREEFORM ? "Free-form" : "Q&A";
}

function knowledgeItemPreview(item) {
  if (item?.type === KNOWLEDGE_TYPE_FREEFORM) {
    return [
      `**${truncate(item.title, 120) || "Untitled"}**`,
      truncate(item.content, 260) || "No content",
    ].join("\n");
  }
  return [
    `**Q:** ${truncate(item?.question, 180) || "No question"}`,
    `**A:** ${truncate(item?.answer, 240) || "No answer"}`,
  ].join("\n");
}

async function getKnowledgeWriteState(guildId) {
  try {
    const availability = await getGuildLearnedKnowledgeWriteAvailability(guildId);
    return {
      available: availability.available === true,
      code: availability.code || null,
      plan: availability.plan || null,
      message: availability.available
        ? null
        : getSubscriptionRejectionMessage(availability.code) ||
          "Adding learned knowledge requires an active Trial, Pro, or Partner plan.",
    };
  } catch {
    return {
      available: false,
      code: "subscription_check_failed",
      plan: null,
      message: "Pixy could not verify the subscription right now. Try again in a moment.",
    };
  }
}

async function renderKnowledge(guild, userId, page = 0, notice = null) {
  const guildId = guild.id;
  const [overview, list, billing, writeState] = await Promise.all([
    getKnowledgeOverview(guildId),
    listKnowledgeItems(guildId, { page, pageSize: KNOWLEDGE_PAGE_SIZE }),
    loadBillingSummary(guildId),
    getKnowledgeWriteState(guildId),
  ]);

  const atLimit = overview.limit <= 0 || overview.total >= overview.limit;
  const embed = new EmbedBuilder()
    .setTitle("Knowledge")
    .setColor(0x57f287)
    .setDescription([
      "Knowledge is server-specific information Pixy can use when answering ticket questions.",
      writeState.available
        ? "You can add Q&A items or longer free-form notes."
        : `New additions are currently locked: ${writeState.message}`,
    ].join("\n"))
    .addFields(
      { name: "Plan", value: billing.planLabel, inline: true },
      { name: "Total", value: `${overview.total}/${overview.limit}`, inline: true },
      { name: "Q&A", value: String(overview.qna), inline: true },
      { name: "Free-form", value: String(overview.freeform), inline: true }
    )
    .setFooter({
      text: `Page ${list.page + 1}/${list.totalPages} • ${list.total} item${list.total === 1 ? "" : "s"}`,
    });

  if (!list.items.length) {
    embed.addFields({ name: "Items", value: "No knowledge has been added yet." });
  } else {
    list.items.forEach((item, index) => {
      const number = list.page * list.pageSize + index + 1;
      embed.addFields({
        name: `${number}. ${knowledgeTypeLabel(item)} • ${shortId(item.id)}`,
        value: knowledgeItemPreview(item),
      });
    });
  }

  const addRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.KNOWLEDGE_ADD_QNA, userId, list.page))
      .setLabel("Add Q&A")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!writeState.available || atLimit),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.KNOWLEDGE_ADD_FREEFORM, userId, list.page))
      .setLabel("Add Free-form")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!writeState.available || atLimit),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.KNOWLEDGE_CLEAR, userId, list.page))
      .setLabel("Clear Knowledge")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(overview.total === 0)
  );

  const components = [addRow];
  if (list.items.length) {
    components.push(...createStringSelectMenus({
      customId: scoped(PREFIX.KNOWLEDGE_DELETE, userId, list.page),
      placeholder: "Delete an item from this page...",
      options: list.items.map((item) => ({
        label: truncate(
          item.type === KNOWLEDGE_TYPE_FREEFORM ? item.title : item.question,
          90
        ) || `Knowledge ${shortId(item.id)}`,
        description: `${knowledgeTypeLabel(item)} • ID ${shortId(item.id)}`,
        value: item.id,
      })),
    }));
  }

  if (list.totalPages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.KNOWLEDGE_PAGE, userId, list.page - 1))
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(list.page <= 0),
      new ButtonBuilder()
        .setCustomId(scoped(PREFIX.KNOWLEDGE_PAGE, userId, list.page + 1))
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(list.page >= list.totalPages - 1)
    ));
  }
  components.push(navigation(userId));

  return { content: notice, embeds: [embed], components };
}

function buildQnaModal(userId, page) {
  const question = new TextInputBuilder()
    .setCustomId("question")
    .setLabel("Question")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(500)
    .setPlaceholder("Example: How do I buy Nitro?");
  const answer = new TextInputBuilder()
    .setCustomId("answer")
    .setLabel("Answer")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1500)
    .setPlaceholder("Write the answer Pixy should learn.");

  return new ModalBuilder()
    .setCustomId(scoped(PREFIX.KNOWLEDGE_ADD_QNA_MODAL, userId, page))
    .setTitle("Add Q&A Knowledge")
    .addComponents(
      new ActionRowBuilder().addComponents(question),
      new ActionRowBuilder().addComponents(answer)
    );
}

function buildFreeformModal(userId, page) {
  const title = new TextInputBuilder()
    .setCustomId("title")
    .setLabel("Title")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(120)
    .setPlaceholder("Example: Refund policy");
  const content = new TextInputBuilder()
    .setCustomId("content")
    .setLabel("Knowledge content")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(2500)
    .setPlaceholder("Write the server-specific policy, rule, or information.");

  return new ModalBuilder()
    .setCustomId(scoped(PREFIX.KNOWLEDGE_ADD_FREEFORM_MODAL, userId, page))
    .setTitle("Add Free-form Knowledge")
    .addComponents(
      new ActionRowBuilder().addComponents(title),
      new ActionRowBuilder().addComponents(content)
    );
}

function knowledgeResultMessage(result, type) {
  if (result.ok) {
    return type === "qna"
      ? `Q&A saved. Knowledge usage: **${result.total}/${result.limit}**.`
      : `Free-form knowledge saved. Knowledge usage: **${result.total}/${result.limit}**.`;
  }
  if (result.code === "duplicate_question") {
    return `That question is already learned. Existing item: \`${result.existingId}\`.`;
  }
  if (result.code === "knowledge_limit_reached") {
    return `This server reached its knowledge limit: **${result.total}/${result.limit}**.`;
  }
  if (result.code === "knowledge_disabled") {
    return "Knowledge additions are disabled for this server because its limit is 0.";
  }
  return `Pixy could not save that knowledge item: ${result.code || "unknown_error"}.`;
}

function safetyResultMessage(result, action) {
  if (result?.ok) {
    const labels = {
      add_blocked: "Custom blocked term added.",
      remove_blocked: "Custom blocked term removed.",
      add_allowed: "Allow exception added.",
      remove_allowed: "Allow exception removed.",
    };
    return labels[action] || "Safety settings updated.";
  }

  const codeMessages = {
    empty_term: "Enter a valid term.",
    already_global: "That term is already covered by Pixy's global safety list.",
    already_exists: "That term already exists in this list.",
    max_reached: "This server reached the custom blocked-term limit.",
    not_found: "That exact term was not found in this list.",
  };
  return codeMessages[result?.code] || `Safety update failed: ${result?.code || "unknown_error"}.`;
}

async function renderSafety(guild, userId, notice = null) {
  const stats = await getBlockedTermsStats(guild.id);
  const embed = new EmbedBuilder()
    .setTitle("Safety")
    .setColor(0xed4245)
    .setDescription([
      "Custom blocked terms extend Pixy's built-in safety list for this server.",
      "Allow exceptions are for false positives and can override matching global or server terms, so only add exceptions you intentionally trust.",
    ].join("\n"))
    .addFields(
      { name: "Global Safety Terms", value: String(stats.globalCount), inline: true },
      { name: "Custom Blocked", value: `${stats.guildBlockedCount}/${stats.maxGuildCustom}`, inline: true },
      { name: "Allow Exceptions", value: String(stats.guildAllowedCount), inline: true }
    );

  if (stats.guildBlockedTerms.length) {
    embed.addFields({
      name: "Custom Blocked Preview",
      value: stats.guildBlockedTerms.slice(0, 20).map((term) => `\`${truncate(term, 60)}\``).join(", "),
    });
  }
  if (stats.guildAllowedTerms.length) {
    embed.addFields({
      name: "Allow Exception Preview",
      value: stats.guildAllowedTerms.slice(0, 20).map((term) => `\`${truncate(term, 60)}\``).join(", "),
    });
  }

  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.SAFETY_ADD_BLOCKED, userId))
      .setLabel("Add Blocked")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(stats.guildBlockedCount >= stats.maxGuildCustom),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.SAFETY_REMOVE_BLOCKED, userId))
      .setLabel("Remove Blocked")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(stats.guildBlockedCount === 0),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.SAFETY_ADD_ALLOWED, userId))
      .setLabel("Add Allow Exception")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.SAFETY_REMOVE_ALLOWED, userId))
      .setLabel("Remove Allow Exception")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(stats.guildAllowedCount === 0)
  );

  return {
    content: notice,
    embeds: [embed],
    components: [actions, navigation(userId)],
  };
}

function singleTermModal({ customId, title, label, placeholder }) {
  const input = new TextInputBuilder()
    .setCustomId("term")
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(191);
  if (placeholder) input.setPlaceholder(placeholder);
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function allowedTermModal(userId) {
  const term = new TextInputBuilder()
    .setCustomId("term")
    .setLabel("Term to allow")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(191);
  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Reason for exception (optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(300);

  return new ModalBuilder()
    .setCustomId(scoped(PREFIX.SAFETY_ADD_ALLOWED_MODAL, userId))
    .setTitle("Add Safety Exception")
    .addComponents(
      new ActionRowBuilder().addComponents(term),
      new ActionRowBuilder().addComponents(reason)
    );
}

function formatTicketSources(sources) {
  const active = sources.filter((source) => source.enabled !== false);
  if (!active.length) return "No active Ticket Sources";
  return active
    .slice(0, 20)
    .map((source) =>
      `${source.type === "thread_parent" ? "Thread Parent" : "Category"}: <#${source.sourceId}>`
    )
    .join("\n");
}

function excludedAddMenu(userId) {
  return new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(scoped(PREFIX.EXCLUDED_ADD, userId))
      .setPlaceholder("Choose a ticket channel or thread to exclude...")
      .setChannelTypes(
        ChannelType.GuildText,
        ChannelType.AnnouncementThread,
        ChannelType.PublicThread,
        ChannelType.PrivateThread
      )
      .setMinValues(1)
      .setMaxValues(1)
  );
}

function excludedReasonButtons(userId, channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.EXCLUDED_REASON_YES, userId, channelId))
      .setLabel("Add Private Reason")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.EXCLUDED_REASON_NO, userId, channelId))
      .setLabel("Exclude Without Reason")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.EXCLUDED_CANCEL, userId))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

function excludedReasonModal(userId, channelId) {
  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Private admin reason")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(300)
    .setPlaceholder("Why should Pixy ignore this ticket?");
  return new ModalBuilder()
    .setCustomId(scoped(PREFIX.EXCLUDED_REASON_MODAL, userId, channelId))
    .setTitle("Exclude Ticket")
    .addComponents(new ActionRowBuilder().addComponents(reason));
}

async function renderExcluded(guild, userId, notice = null) {
  const guildId = guild.id;
  const [sources, entries, total] = await Promise.all([
    listResolvedTicketSources(guildId, { client: prisma }),
    listExcludedTickets(guildId, { limit: EXCLUDED_PREVIEW_LIMIT }),
    prisma.guildIgnoredChannel.count({ where: { guildId } }),
  ]);
  await Promise.all([
    guild.channels.fetch().catch(() => null),
    guild.channels.fetchActiveThreads?.().catch(() => null),
  ]);

  const embed = new EmbedBuilder()
    .setTitle("Excluded Tickets")
    .setColor(0x99aab5)
    .setDescription([
      "Excluded ticket channels or threads are ignored by Pixy even when they are inside a configured Ticket Source.",
      "Removing an exclusion immediately asks Pixy to reconcile that ticket surface and reactivate it if it is still valid.",
    ].join("\n"))
    .addFields(
      { name: "Configured Ticket Sources", value: String(sources.length), inline: true },
      { name: "Excluded", value: String(total), inline: true },
      { name: "Current Ticket Sources", value: formatTicketSources(sources), inline: false }
    );

  if (!entries.length) {
    embed.addFields({ name: "Excluded List", value: "No ticket channels or threads are currently excluded." });
  } else {
    embed.addFields({
      name: total > entries.length ? `First ${entries.length} Exclusions` : "Excluded List",
      value: entries
        .map((entry, index) => {
          const channel = guild.channels.cache.get(entry.channelId);
          const name = channel ? `<#${entry.channelId}>` : `Unavailable \`${entry.channelId}\``;
          return `${index + 1}. ${name}${entry.reason ? ` — ${truncate(entry.reason, 90)}` : ""}`;
        })
        .join("\n")
        .slice(0, 4096),
    });
  }

  const components = [];
  if (sources.length) components.push(excludedAddMenu(userId));
  if (entries.length) {
    components.push(...createStringSelectMenus({
      customId: scoped(PREFIX.EXCLUDED_REMOVE, userId),
      placeholder: "Restore an excluded ticket...",
      options: entries.map((entry) => {
        const channel = guild.channels.cache.get(entry.channelId);
        return {
          label: (channel?.name ? `#${channel.name}` : `Unavailable ${entry.channelId.slice(-6)}`).slice(0, 100),
          value: entry.channelId,
          description: truncate(entry.reason || "No private reason", 100),
        };
      }),
    }));
  }
  components.push(navigation(userId));

  return {
    content: notice || (!sources.length ? "Configure Ticket Sources in `/pixy-setup` before adding exclusions." : null),
    embeds: [embed],
    components,
  };
}

async function renderPage(page, guild, userId, options = {}) {
  if (page === PAGES.BEHAVIOR) return renderBehavior(guild, userId, options.notice);
  if (page === PAGES.KNOWLEDGE) return renderKnowledge(guild, userId, options.page || 0, options.notice);
  if (page === PAGES.SAFETY) return renderSafety(guild, userId, options.notice);
  if (page === PAGES.EXCLUDED) return renderExcluded(guild, userId, options.notice);
  return renderHome(guild, userId, options.notice);
}

async function ensureKnowledgeWriteAllowed(interaction) {
  const state = await getKnowledgeWriteState(interaction.guild.id);
  if (state.available) return true;
  await interaction.reply({
    content: state.message,
    flags: EPHEMERAL,
    allowedMentions: { parse: [] },
  });
  return false;
}

async function finishExclude(interaction, userId, channelId, reason) {
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);
  const result = await excludeTicket(interaction.guild, channelId, reason);

  let notice;
  if (result.ok) {
    notice = `<#${channelId}> is now excluded. Pixy will not read or reply there until the exclusion is removed.`;
  } else if (result.code === "already_excluded") {
    notice = `<#${channelId}> is already excluded.`;
  } else if (result.code === "outside_ticket_sources") {
    notice = "That channel or thread is not inside any configured Pixy Ticket Source.";
  } else if (result.code === "ticket_sources_not_configured") {
    notice = "Configure Ticket Sources in `/pixy-setup` first.";
  } else {
    notice = `Pixy could not exclude that ticket: ${result.code || "unknown_error"}.`;
  }

  await editPanel(interaction, await renderExcluded(interaction.guild, userId, notice));
}

const command = {
  data: new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Manage Pixy behavior, knowledge, safety, and excluded tickets.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  guildOnly: true,
  userPermissions: [PermissionFlagsBits.Administrator],

  async execute(interaction) {
    await getOrCreateGuildSetting(interaction.guild.id);
    await interaction.reply({
      ...(await renderHome(interaction.guild, interaction.user.id)),
      flags: EPHEMERAL,
      allowedMentions: { parse: [] },
    });
  },

  selectMenuHandlers: [
    {
      customIdPrefix: PREFIX.NAV,
      type: "string",
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.NAV);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await editPanel(
          interaction,
          await renderPage(interaction.values?.[0] || PAGES.HOME, interaction.guild, userId)
        );
      },
    },
    {
      customIdPrefix: PREFIX.MODE,
      type: "string",
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.MODE);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const mode = interaction.values?.[0];
        const result = await setTicketOperatingMode(interaction.guild, mode, {
          discordClient: interaction.client,
        });

        const notice = result.ok
          ? `${modeLabel(result.mode)} saved.${result.refresh?.ok === false ? " One or more existing control panels could not be refreshed immediately." : ""}`
          : result.code === "full_control_preflight_failed"
            ? [
                "Full Ticket Control was not enabled because Pixy is missing required setup or permissions.",
                formatPreflightIssues(result.preflight),
                "Fix these items in `/pixy-setup`, then try again. Smart Overlay remains available.",
              ].join("\n")
            : `Pixy could not apply that operating mode: ${result.code || "unknown_error"}.`;

        await editPanel(interaction, await renderBehavior(interaction.guild, userId, notice));
      },
    },
    {
      customIdPrefix: PREFIX.TOGGLE,
      type: "string",
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.TOGGLE);
        if (!(await assertOwner(interaction, userId))) return;
        const field = interaction.values?.[0];
        if (field === "reset") {
          await editPanel(interaction, await renderBehavior(interaction.guild, userId));
          return;
        }
        if (!BEHAVIOR_FIELDS.has(field)) return;

        await deferUpdate(interaction);
        const result = await toggleBehaviorField(interaction.guild, field, {
          discordClient: interaction.client,
          skipRefresh: true,
        });
        const feature = BEHAVIOR_FEATURES.find((item) => item.field === field);
        const notice = result.ok
          ? `${feature?.label || field} is now ${result.settings[field] ? "enabled" : "disabled"}.`
          : result.code === "full_control_preflight_failed"
            ? [
                "That toggle would put Pixy into Full Ticket Control, but its preflight failed.",
                formatPreflightIssues(result.preflight),
                "Fix the missing setup/permissions or keep Smart Overlay.",
              ].join("\n")
            : `Pixy could not update that behavior: ${result.code || "unknown_error"}.`;
        await editPanel(interaction, await renderBehavior(interaction.guild, userId, notice));
      },
    },
    {
      customIdPrefix: PREFIX.KNOWLEDGE_DELETE,
      type: "string",
      async execute(interaction) {
        const [userId, pageRaw] = parseScoped(interaction.customId, PREFIX.KNOWLEDGE_DELETE);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const itemId = interaction.values?.[0];
        if (itemId === "reset") {
          await editPanel(interaction, await renderKnowledge(interaction.guild, userId, Number(pageRaw) || 0));
          return;
        }
        const result = await deleteKnowledgeItem(interaction.guild.id, itemId);
        const notice = result.ok
          ? `Deleted ${knowledgeTypeLabel(result.item)} knowledge item \`${shortId(result.item.id)}\`.`
          : "That knowledge item no longer exists.";
        await editPanel(
          interaction,
          await renderKnowledge(interaction.guild, userId, Number(pageRaw) || 0, notice)
        );
      },
    },
    {
      customIdPrefix: PREFIX.EXCLUDED_ADD,
      type: "channel",
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.EXCLUDED_ADD);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const channelId = interaction.values?.[0];
        const channel = interaction.channels?.get(channelId) || null;
        const validation = await validateExcludedTicketTarget(interaction.guild, channelId, { channel });

        if (!validation.ok) {
          const messages = {
            ticket_sources_not_configured: "Configure Ticket Sources in `/pixy-setup` first.",
            invalid_ticket_channel: "That ticket channel or thread no longer exists.",
            outside_ticket_sources: "That channel or thread is not inside any configured Pixy Ticket Source.",
          };
          await editPanel(
            interaction,
            await renderExcluded(
              interaction.guild,
              userId,
              messages[validation.code] || `That ticket cannot be excluded: ${validation.code}.`
            )
          );
          return;
        }

        const existing = await prisma.guildIgnoredChannel.findUnique({
          where: {
            guildId_channelId: {
              guildId: interaction.guild.id,
              channelId,
            },
          },
        });
        if (existing) {
          await editPanel(
            interaction,
            await renderExcluded(interaction.guild, userId, `<#${channelId}> is already excluded.`)
          );
          return;
        }

        await editPanel(interaction, {
          content: `Selected <#${channelId}>. Do you want to save a private admin reason for this exclusion?`,
          embeds: [],
          components: [excludedReasonButtons(userId, channelId)],
        });
      },
    },
    {
      customIdPrefix: PREFIX.EXCLUDED_REMOVE,
      type: "string",
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.EXCLUDED_REMOVE);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const channelId = interaction.values?.[0];
        if (channelId === "reset") {
          await editPanel(interaction, await renderExcluded(interaction.guild, userId));
          return;
        }

        const result = await restoreExcludedTicket(interaction.guild, channelId);
        const notice = !result.ok
          ? "That exclusion was already removed."
          : result.reactivated
            ? `<#${channelId}> is no longer excluded and was reactivated for Pixy.`
            : result.code === "channel_missing"
              ? `The exclusion was removed, but the ticket channel or thread no longer exists.`
              : `The exclusion was removed, but the ticket was not reactivated because it is no longer a valid Pixy ticket.`;
        await editPanel(interaction, await renderExcluded(interaction.guild, userId, notice));
      },
    },
  ],

  buttonHandlers: [
    {
      customIdPrefix: PREFIX.HOME,
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.HOME);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await editPanel(interaction, await renderHome(interaction.guild, userId));
      },
    },
    {
      customIdPrefix: PREFIX.CLOSE,
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.CLOSE);
        if (!(await assertOwner(interaction, userId))) return;
        await editPanel(interaction, {
          content: "Settings panel closed.",
          embeds: [],
          components: [],
        });
      },
    },
    {
      customIdPrefix: PREFIX.KNOWLEDGE_PAGE,
      async execute(interaction) {
        const [userId, pageRaw] = parseScoped(interaction.customId, PREFIX.KNOWLEDGE_PAGE);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await editPanel(
          interaction,
          await renderKnowledge(interaction.guild, userId, Number(pageRaw) || 0)
        );
      },
    },
    {
      customIdPrefix: PREFIX.KNOWLEDGE_ADD_QNA,
      async execute(interaction) {
        const [userId, pageRaw] = parseScoped(interaction.customId, PREFIX.KNOWLEDGE_ADD_QNA);
        if (!(await assertOwner(interaction, userId))) return;
        if (!(await ensureKnowledgeWriteAllowed(interaction))) return;
        await interaction.showModal(buildQnaModal(userId, Number(pageRaw) || 0));
      },
    },
    {
      customIdPrefix: PREFIX.KNOWLEDGE_ADD_FREEFORM,
      async execute(interaction) {
        const [userId, pageRaw] = parseScoped(interaction.customId, PREFIX.KNOWLEDGE_ADD_FREEFORM);
        if (!(await assertOwner(interaction, userId))) return;
        if (!(await ensureKnowledgeWriteAllowed(interaction))) return;
        await interaction.showModal(buildFreeformModal(userId, Number(pageRaw) || 0));
      },
    },
    {
      customIdPrefix: PREFIX.KNOWLEDGE_CLEAR,
      async execute(interaction) {
        const [userId, pageRaw] = parseScoped(interaction.customId, PREFIX.KNOWLEDGE_CLEAR);
        if (!(await assertOwner(interaction, userId))) return;
        await editPanel(interaction, {
          content: "Delete **all learned knowledge** for this server? This does not reset Pixy setup, billing, or other settings.",
          embeds: [],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(scoped(PREFIX.KNOWLEDGE_CLEAR_CONFIRM, userId, Number(pageRaw) || 0))
              .setLabel("Delete All Knowledge")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(scoped(PREFIX.KNOWLEDGE_CLEAR_CANCEL, userId, Number(pageRaw) || 0))
              .setLabel("Cancel")
              .setStyle(ButtonStyle.Secondary)
          )],
        });
      },
    },
    {
      customIdPrefix: PREFIX.KNOWLEDGE_CLEAR_CONFIRM,
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.KNOWLEDGE_CLEAR_CONFIRM);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const result = await clearKnowledge(interaction.guild.id);
        await editPanel(
          interaction,
          await renderKnowledge(interaction.guild, userId, 0, `Deleted **${result.deleted}** knowledge item${result.deleted === 1 ? "" : "s"}.`)
        );
      },
    },
    {
      customIdPrefix: PREFIX.KNOWLEDGE_CLEAR_CANCEL,
      async execute(interaction) {
        const [userId, pageRaw] = parseScoped(interaction.customId, PREFIX.KNOWLEDGE_CLEAR_CANCEL);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await editPanel(
          interaction,
          await renderKnowledge(interaction.guild, userId, Number(pageRaw) || 0, "Knowledge deletion cancelled.")
        );
      },
    },
    {
      customIdPrefix: PREFIX.SAFETY_ADD_BLOCKED,
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.SAFETY_ADD_BLOCKED);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.showModal(singleTermModal({
          customId: scoped(PREFIX.SAFETY_ADD_BLOCKED_MODAL, userId),
          title: "Add Custom Blocked Term",
          label: "Term to block",
          placeholder: "Exact word or phrase",
        }));
      },
    },
    {
      customIdPrefix: PREFIX.SAFETY_REMOVE_BLOCKED,
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.SAFETY_REMOVE_BLOCKED);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.showModal(singleTermModal({
          customId: scoped(PREFIX.SAFETY_REMOVE_BLOCKED_MODAL, userId),
          title: "Remove Custom Blocked Term",
          label: "Exact term to remove",
        }));
      },
    },
    {
      customIdPrefix: PREFIX.SAFETY_ADD_ALLOWED,
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.SAFETY_ADD_ALLOWED);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.showModal(allowedTermModal(userId));
      },
    },
    {
      customIdPrefix: PREFIX.SAFETY_REMOVE_ALLOWED,
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.SAFETY_REMOVE_ALLOWED);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.showModal(singleTermModal({
          customId: scoped(PREFIX.SAFETY_REMOVE_ALLOWED_MODAL, userId),
          title: "Remove Safety Exception",
          label: "Exact allowed term to remove",
        }));
      },
    },
    {
      customIdPrefix: PREFIX.EXCLUDED_REASON_YES,
      async execute(interaction) {
        const [userId, channelId] = parseScoped(interaction.customId, PREFIX.EXCLUDED_REASON_YES);
        if (!(await assertOwner(interaction, userId))) return;
        await interaction.showModal(excludedReasonModal(userId, channelId));
      },
    },
    {
      customIdPrefix: PREFIX.EXCLUDED_REASON_NO,
      async execute(interaction) {
        const [userId, channelId] = parseScoped(interaction.customId, PREFIX.EXCLUDED_REASON_NO);
        await finishExclude(interaction, userId, channelId, null);
      },
    },
    {
      customIdPrefix: PREFIX.EXCLUDED_CANCEL,
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.EXCLUDED_CANCEL);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        await editPanel(interaction, await renderExcluded(interaction.guild, userId, "Exclusion cancelled."));
      },
    },
  ],

  modalHandlers: [
    {
      customIdPrefix: PREFIX.KNOWLEDGE_ADD_QNA_MODAL,
      async execute(interaction) {
        const [userId, pageRaw] = parseScoped(interaction.customId, PREFIX.KNOWLEDGE_ADD_QNA_MODAL);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const writeState = await getKnowledgeWriteState(interaction.guild.id);
        if (!writeState.available) {
          await editPanel(
            interaction,
            await renderKnowledge(interaction.guild, userId, Number(pageRaw) || 0, writeState.message)
          );
          return;
        }

        const result = await addKnowledgeQna(
          interaction.guild.id,
          interaction.fields.getTextInputValue("question"),
          interaction.fields.getTextInputValue("answer")
        );
        await editPanel(
          interaction,
          await renderKnowledge(
            interaction.guild,
            userId,
            Number(pageRaw) || 0,
            knowledgeResultMessage(result, "qna")
          )
        );
      },
    },
    {
      customIdPrefix: PREFIX.KNOWLEDGE_ADD_FREEFORM_MODAL,
      async execute(interaction) {
        const [userId, pageRaw] = parseScoped(interaction.customId, PREFIX.KNOWLEDGE_ADD_FREEFORM_MODAL);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const writeState = await getKnowledgeWriteState(interaction.guild.id);
        if (!writeState.available) {
          await editPanel(
            interaction,
            await renderKnowledge(interaction.guild, userId, Number(pageRaw) || 0, writeState.message)
          );
          return;
        }

        const result = await addKnowledgeFreeform(
          interaction.guild.id,
          interaction.fields.getTextInputValue("title"),
          interaction.fields.getTextInputValue("content")
        );
        await editPanel(
          interaction,
          await renderKnowledge(
            interaction.guild,
            userId,
            Number(pageRaw) || 0,
            knowledgeResultMessage(result, "freeform")
          )
        );
      },
    },
    {
      customIdPrefix: PREFIX.SAFETY_ADD_BLOCKED_MODAL,
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.SAFETY_ADD_BLOCKED_MODAL);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const result = await addGuildBlockedTerm(
          interaction.guild.id,
          cleanText(interaction.fields.getTextInputValue("term"))
        );
        await editPanel(
          interaction,
          await renderSafety(interaction.guild, userId, safetyResultMessage(result, "add_blocked"))
        );
      },
    },
    {
      customIdPrefix: PREFIX.SAFETY_REMOVE_BLOCKED_MODAL,
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.SAFETY_REMOVE_BLOCKED_MODAL);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const result = await removeGuildBlockedTerm(
          interaction.guild.id,
          cleanText(interaction.fields.getTextInputValue("term"))
        );
        await editPanel(
          interaction,
          await renderSafety(interaction.guild, userId, safetyResultMessage(result, "remove_blocked"))
        );
      },
    },
    {
      customIdPrefix: PREFIX.SAFETY_ADD_ALLOWED_MODAL,
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.SAFETY_ADD_ALLOWED_MODAL);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const term = cleanText(interaction.fields.getTextInputValue("term"));
        const reason = cleanText(interaction.fields.getTextInputValue("reason")) || null;
        const result = await addGuildAllowedTerm(interaction.guild.id, term, reason);
        await editPanel(
          interaction,
          await renderSafety(interaction.guild, userId, safetyResultMessage(result, "add_allowed"))
        );
      },
    },
    {
      customIdPrefix: PREFIX.SAFETY_REMOVE_ALLOWED_MODAL,
      async execute(interaction) {
        const [userId] = parseScoped(interaction.customId, PREFIX.SAFETY_REMOVE_ALLOWED_MODAL);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);
        const result = await removeGuildAllowedTerm(
          interaction.guild.id,
          cleanText(interaction.fields.getTextInputValue("term"))
        );
        await editPanel(
          interaction,
          await renderSafety(interaction.guild, userId, safetyResultMessage(result, "remove_allowed"))
        );
      },
    },
    {
      customIdPrefix: PREFIX.EXCLUDED_REASON_MODAL,
      async execute(interaction) {
        const [userId, channelId] = parseScoped(interaction.customId, PREFIX.EXCLUDED_REASON_MODAL);
        const reason = cleanText(interaction.fields.getTextInputValue("reason"));
        await finishExclude(interaction, userId, channelId, reason);
      },
    },
  ],
};

module.exports = Object.assign(command, {
  BEHAVIOR_FEATURES,
  PAGES,
  PREFIX,
  formatPreflightIssues,
  knowledgeItemPreview,
  modeLabel,
  renderBehavior,
  renderExcluded,
  renderHome,
  renderKnowledge,
  renderSafety,
});