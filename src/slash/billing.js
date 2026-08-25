const {
  ActionRowBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");

const {
  BILLING_CAPABILITIES,
  BILLING_PLANS,
} = require("../billing/constants");
const { loadBillingSummary } = require("../billing/billingService");
const {
  formatBillingEmoji,
  getBillingEmoji,
} = require("../config/applicationEmojis");

const EPHEMERAL = 64;
const PAYMENT_SELECT_PREFIX = "billing_payment:";

const PAYMENT_METHODS = Object.freeze({
  paypal: Object.freeze({
    label: "PayPal",
    description: "Contact the configured PayPal owner.",
    ownerConfigKey: "paypalOwnerId",
  }),
  vodafone: Object.freeze({
    label: "Vodafone Cash",
    description: "Contact the configured Vodafone Cash owner.",
    ownerConfigKey: "vodafoneOwnerId",
  }),
  orange: Object.freeze({
    label: "Orange Cash",
    description: "Contact the configured cash-payment owner.",
    ownerConfigKey: "vodafoneOwnerId",
  }),
});

const PLAN_COLORS = Object.freeze({
  [BILLING_PLANS.TRIAL]: 0xfee75c,
  [BILLING_PLANS.EXPIRED]: 0xed4245,
  [BILLING_PLANS.PRO]: 0x57f287,
  [BILLING_PLANS.PARTNER]: 0x5865f2,
});

function cleanText(value, maxLength = 300) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxLength);
}

function formatDiscordDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  const unix = Math.floor(date.getTime() / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function getPaymentVerb(summary) {
  if (summary?.plan === BILLING_PLANS.PARTNER) return null;
  if (summary?.plan === BILLING_PLANS.TRIAL) return "Subscribe";
  if (summary?.plan === BILLING_PLANS.PRO) return "Renew";
  return "Activate";
}

function getPlanDescription(summary) {
  if (!summary?.initialized) {
    return [
      "Billing has not been initialized for this server.",
      "Run `/pixy-setup` to complete onboarding and start the one-time seven-day Trial.",
    ].join("\n");
  }

  if (summary.plan === BILLING_PLANS.TRIAL) {
    return "The one-time Pixy Pro Trial is active for this server.";
  }

  if (summary.plan === BILLING_PLANS.PRO) {
    return "Pixy Pro is active for this server.";
  }

  if (summary.plan === BILLING_PLANS.PARTNER) {
    return "Partner entitlement is active with no subscription expiry.";
  }

  return [
    "Premium entitlement is inactive.",
    "Generic Pixy AI replies remain available, while learned AI context and ticket agent actions require Pixy Pro.",
  ].join("\n");
}

function getRemainingValue(summary) {
  if (summary?.remaining?.unlimited) return "Unlimited";
  if (summary?.expiresAt) {
    return `${summary.remainingLabel}\nEnds ${formatDiscordDate(summary.expiresAt)}`;
  }
  return summary?.plan === BILLING_PLANS.EXPIRED
    ? "Expired"
    : summary?.remainingLabel || "Unknown";
}

function getRenewalWarning(summary) {
  if (
    !summary ||
    ![BILLING_PLANS.TRIAL, BILLING_PLANS.PRO].includes(summary.plan) ||
    summary.remaining?.unlimited
  ) {
    return null;
  }

  const days = Number(summary.remaining?.displayDays);
  if (!Number.isFinite(days) || days <= 0 || days > 3) return null;

  return summary.plan === BILLING_PLANS.TRIAL
    ? `The Trial expires in **${summary.remainingLabel}**. Subscribe before it ends to keep learned knowledge and agent actions available.`
    : `Pixy Pro expires in **${summary.remainingLabel}**. Renew before it ends to avoid switching to Expired mode.`;
}

function buildTimelineValue(summary) {
  const lines = [];

  if (summary?.trial?.startedAt) {
    lines.push(`**Trial started:** ${formatDiscordDate(summary.trial.startedAt)}`);
  }
  if (summary?.trial?.endsAt) {
    lines.push(`**Trial ends:** ${formatDiscordDate(summary.trial.endsAt)}`);
  }
  if (summary?.pro?.startedAt) {
    lines.push(`**Pro started:** ${formatDiscordDate(summary.pro.startedAt)}`);
  }
  if (summary?.pro?.endsAt) {
    lines.push(`**Pro ends:** ${formatDiscordDate(summary.pro.endsAt)}`);
  }
  if (summary?.partner?.startedAt) {
    lines.push(`**Partner since:** ${formatDiscordDate(summary.partner.startedAt)}`);
  }
  if (summary?.fallbackPlanLabel) {
    lines.push(`**Fallback beneath Partner:** ${summary.fallbackPlanLabel}`);
  }

  return lines.length ? lines.join("\n") : "No billing dates are recorded yet.";
}

function buildCapabilityValue(summary) {
  const capabilities = summary?.capabilities || {};
  const genericAi = capabilities[BILLING_CAPABILITIES.GENERIC_AI_REPLIES] === true;
  const learnedContext = capabilities[BILLING_CAPABILITIES.LEARNED_KNOWLEDGE_CONTEXT] === true;
  const learnedWrite = capabilities[BILLING_CAPABILITIES.LEARNED_KNOWLEDGE_WRITE] === true;
  const agentActions = capabilities[BILLING_CAPABILITIES.AGENT_ACTIONS] === true;

  return [
    `**Generic AI replies:** ${genericAi ? "✅ Available" : "❌ Unavailable"}`,
    learnedContext && learnedWrite
      ? "**Learned knowledge:** ✅ AI context and additions available"
      : "**Learned knowledge:** 🔒 Existing items can be managed, but additions and AI context require Pixy Pro",
    `**Agent ticket actions:** ${agentActions ? "✅ Available" : "🔒 Requires Pixy Pro"}`,
  ].join("\n");
}

function buildBillingStatusEmbed({ summary, guildName, guildId }) {
  const warning = getRenewalWarning(summary);
  const embed = new EmbedBuilder()
    .setTitle("💳 Pixy Billing")
    .setColor(PLAN_COLORS[summary?.plan] || PLAN_COLORS[BILLING_PLANS.EXPIRED])
    .setDescription(getPlanDescription(summary))
    .addFields(
      {
        name: "Effective plan",
        value: summary?.planLabel || "Expired",
        inline: true,
      },
      {
        name: "Status",
        value: summary?.initialized ? summary.statusLabel : "Not initialized",
        inline: true,
      },
      {
        name: "Remaining",
        value: getRemainingValue(summary),
        inline: true,
      }
    );

  if (warning) {
    embed.addFields({
      name: "⚠️ Renewal needed soon",
      value: warning,
    });
  }

  embed.addFields(
    {
      name: "Billing timeline",
      value: buildTimelineValue(summary),
    },
    {
      name: "Feature availability",
      value: buildCapabilityValue(summary),
    },
    {
      name: "AI provider usage",
      value:
        "This guild supplies its own API key for its selected AI provider (Groq, Google Gemini, or Mistral) and is responsible for that provider's usage, limits, and charges. Pixy does not provide a shared provider quota.",
    }
  );

  embed.setFooter({
    text: `${cleanText(guildName, 80) || "Unknown server"} • ${cleanText(guildId, 30)}`,
  });

  return embed;
}

function buildPaymentComponents(summary, userId, appEmojis = {}) {
  const verb = getPaymentVerb(summary);
  if (!verb) return [];

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${PAYMENT_SELECT_PREFIX}${userId}`)
    .setPlaceholder(`${verb} Pixy Pro...`)
    .addOptions(
      Object.entries(PAYMENT_METHODS).map(([value, method]) => ({
        label: `${verb} with ${method.label}`,
        description: method.description,
        value,
        emoji: getBillingEmoji(appEmojis, value),
      }))
    );

  return [new ActionRowBuilder().addComponents(menu)];
}

function buildBillingPanelPayload({
  summary,
  guildName,
  guildId,
  userId,
  appEmojis = {},
}) {
  return {
    embeds: [buildBillingStatusEmbed({ summary, guildName, guildId })],
    components: buildPaymentComponents(summary, userId, appEmojis),
    allowedMentions: { parse: [] },
  };
}

function buildPaymentInstructions({
  methodKey,
  ownerId,
  guildName,
  guildId,
  appEmojis = {},
}) {
  const method = PAYMENT_METHODS[methodKey];
  if (!method) return null;

  const methodEmoji = formatBillingEmoji(appEmojis, methodKey);
  return [
    `### ${methodEmoji ? `${methodEmoji} ` : ""}${method.label} contact`,
    `Contact <@${ownerId}> to discuss manual Pixy Pro activation or renewal.`,
    "",
    "1. Open the owner profile from the mention above.",
    "2. Send the owner a direct message.",
    "3. Include all of the following:",
    `   - Server name: **${cleanText(guildName, 100) || "Unknown server"}**`,
    `   - Server ID: \`${cleanText(guildId, 30)}\``,
    "   - Your desired subscription duration.",
    "",
    "⚠️ **Never send passwords, Discord tokens, AI provider API keys, backup codes, or other secrets.**",
    "",
    "Pixy did not send the owner a DM, collect a payment, or activate/renew this server automatically.",
  ].join("\n");
}

async function assertPanelOwner(interaction, ownerUserId) {
  const allowed = Boolean(
    interaction.guild &&
      interaction.user?.id === ownerUserId &&
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );

  if (allowed) return true;

  await interaction.reply({
    content: "Only the administrator who opened `/pixy-billing` can use this control.",
    flags: EPHEMERAL,
  });
  return false;
}

async function handlePaymentSelection(interaction) {
  const ownerUserId = String(interaction.customId || "")
    .slice(PAYMENT_SELECT_PREFIX.length)
    .split(":")[0];

  if (!(await assertPanelOwner(interaction, ownerUserId))) return;

  const methodKey = interaction.values?.[0];
  const method = PAYMENT_METHODS[methodKey];
  if (!method) {
    await interaction.reply({
      content: "Unknown payment method selected.",
      flags: EPHEMERAL,
    });
    return;
  }

  const ownerId = interaction.client?.appEnv?.[method.ownerConfigKey];
  if (!ownerId) {
    await interaction.reply({
      content: `${method.label} contact is not configured. Ask the Pixy operator to check the owner environment settings.`,
      flags: EPHEMERAL,
    });
    return;
  }

  await interaction.reply({
    content: buildPaymentInstructions({
      methodKey,
      ownerId,
      guildName: interaction.guild.name,
      guildId: interaction.guild.id,
      appEmojis: interaction.client?.appEmojis || {},
    }),
    flags: EPHEMERAL,
    allowedMentions: { parse: [] },
  });
}

async function executeBillingCommand(interaction, options = {}) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used inside a server.",
      flags: EPHEMERAL,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "You need Administrator permission to view Pixy billing.",
      flags: EPHEMERAL,
    });
    return;
  }

  const loadSummary = options.loadSummary || loadBillingSummary;
  const summary = await loadSummary(interaction.guild.id, options);
  await interaction.reply({
    ...buildBillingPanelPayload({
      summary,
      guildName: interaction.guild.name,
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      appEmojis: interaction.client?.appEmojis || {},
    }),
    flags: EPHEMERAL,
  });
}

const command = {
  data: new SlashCommandBuilder()
    .setName("billing")
    .setDescription("View Pixy billing status and manual activation options.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  guildOnly: true,
  userPermissions: [PermissionFlagsBits.Administrator],

  execute: executeBillingCommand,

  selectMenuHandlers: [
    {
      customIdPrefix: PAYMENT_SELECT_PREFIX,
      type: "string",
      execute: handlePaymentSelection,
    },
  ],
};

module.exports = Object.assign(command, {
  EPHEMERAL,
  PAYMENT_METHODS,
  PAYMENT_SELECT_PREFIX,
  assertPanelOwner,
  buildBillingPanelPayload,
  buildBillingStatusEmbed,
  buildCapabilityValue,
  buildPaymentComponents,
  buildPaymentInstructions,
  buildTimelineValue,
  executeBillingCommand,
  formatDiscordDate,
  getPaymentVerb,
  getRenewalWarning,
  handlePaymentSelection,
});
