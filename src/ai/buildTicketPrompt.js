const {
  buildTicketPrompt: buildBaseTicketPrompt,
} = require("./buildTicketPromptBase");
const {
  promoteRecentConversation,
} = require("./conversationPromptMessages");

const IMMEDIATE_PURCHASE_HANDOFF_POLICY = [
  "Immediate purchase/order handoff (clarification):",
  "- A clear current-turn commitment to obtain, buy, order, purchase, or take a specific server product, package, plan, or service is a human-support need when one configured escalation route clearly matches that intent.",
  "- When that condition is met, request escalate_ticket immediately in the same turn.",
  "- Do not ask for an extra confirmation such as whether the user wants to buy, wants to be transferred, wants staff, or wants you to proceed after the purchase/order intent is already clear.",
  "- Do not re-explain the selected package or service before the handoff when the user has already chosen it.",
  "- Statements such as 'I want the Epic package', 'I'll take Epic', 'عايز الـ Epic دي', 'عايز اشتريها', or 'أريد أطلب هذه الباقة' are clear purchase/order intent when the conversation identifies the paid package or service.",
  "- Questions that only ask for information, such as price, features, availability, or package details, are not purchase/order intent by themselves and should be answered normally when the answer is safely available.",
  "- If no configured escalation route clearly matches, do not invent one; follow the normal missing-route behavior.",
].join("\n");

function addImmediatePurchaseHandoffPolicy(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  return messages.map((message, index) => {
    if (index !== 0 || message?.role !== "system") return message;

    return {
      ...message,
      content: `${String(message.content || "")}\n\n${IMMEDIATE_PURCHASE_HANDOFF_POLICY}`,
    };
  });
}

function buildTicketPrompt(options = {}) {
  const messages = buildBaseTicketPrompt(options);
  const promotedMessages = promoteRecentConversation(
    messages,
    options.recentMessages || [],
    {
      nextContextHeading: "Server learned Q&A:",
    }
  );

  return addImmediatePurchaseHandoffPolicy(promotedMessages);
}

module.exports = {
  IMMEDIATE_PURCHASE_HANDOFF_POLICY,
  addImmediatePurchaseHandoffPolicy,
  buildTicketPrompt,
};
