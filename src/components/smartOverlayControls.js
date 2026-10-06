const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require("discord.js");
const { hasPremiumEntitlement } = require("../billing/billingService");
const {
  ACTION_SELECT_ID,
  buildTicketAiOption,
} = require("./ticketAiToggle");

function isPremium(options = {}) {
  return options.plan ? hasPremiumEntitlement(options.plan) : true;
}

function buildSmartOverlayContent(aiEnabled = true, options = {}) {
  const escalationEnabled = options.settings?.escalationEnabled !== false;
  const premiumEntitled = isPremium(options);
  const escalated = options.escalated === true;

  if (!premiumEntitled) {
    return [
      "Hello 👋 I'm Pixy AI. Ask your question here and I'll try to assist while the support team reviews your ticket.",
      "",
      "**Ticket Assistant**",
      "Automated ticket actions are unavailable. Staff will assist you directly and can pause or resume AI replies below.",
      options.escalated === true
        ? "🤝 **Human support requested** — this ticket has already been handed off for review."
        : null,
      "",
      aiEnabled
        ? "🤖 **Pixy AI is ON** — staff can pause automatic replies from the menu below."
        : "⏸️ **Pixy AI is OFF** — staff can resume automatic replies from the menu below.",
    ].filter((line) => line !== null).join("\n");
  }

  const handoffLine = escalated
    ? "🤝 **Human support requested** — Pixy has handed this ticket off for human review."
    : escalationEnabled
      ? "If human review is needed, Pixy can hand the conversation off to the configured support team."
      : "Human handoff is currently disabled by this server's administrators.";

  return [
    "Hello 👋 I'm Pixy AI. Ask your question here and I'll try to help using this server's knowledge.",
    "",
    "**Smart Overlay**",
    "Pixy works alongside this server's existing ticket system and won't close, rename, move, or delete this ticket.",
    handoffLine,
    "",
    aiEnabled
      ? "🤖 **Pixy AI is ON** — staff can pause automatic replies from the menu below."
      : "⏸️ **Pixy AI is OFF** — staff can resume automatic replies from the menu below.",
  ].join("\n");
}

function buildHumanSupportOption() {
  return new StringSelectMenuOptionBuilder()
    .setLabel("Request Human Support")
    .setDescription("Ask Pixy to route this ticket to the right support team.")
    .setValue("escalate")
    .setEmoji("🤝");
}

function buildSmartOverlayComponents(aiEnabled = true, options = {}) {
  const premiumEntitled = isPremium(options);
  const escalationEnabled = options.settings?.escalationEnabled !== false;
  const escalated = options.escalated === true;

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(ACTION_SELECT_ID)
    .setPlaceholder(escalated ? "Control Pixy AI..." : "Select a Pixy action...");

  if (premiumEntitled && escalationEnabled && !escalated) {
    selectMenu.addOptions(buildHumanSupportOption());
  }

  selectMenu.addOptions(buildTicketAiOption(aiEnabled));

  return [new ActionRowBuilder().addComponents(selectMenu)];
}

function buildSmartOverlayPayload(aiEnabled = true, options = {}) {
  return {
    content: buildSmartOverlayContent(aiEnabled, options),
    components: buildSmartOverlayComponents(aiEnabled, options),
    allowedMentions: { parse: [] },
  };
}

module.exports = {
  ACTION_SELECT_ID,
  buildHumanSupportOption,
  buildSmartOverlayComponents,
  buildSmartOverlayContent,
  buildSmartOverlayPayload,
};
