const basePrompt = require("./buildAssistantTicketPromptBase");
const {
  promoteRecentConversation,
} = require("./conversationPromptMessages");

function buildAssistantTicketPrompt(options = {}) {
  const messages = basePrompt.buildAssistantTicketPrompt(options);
  return promoteRecentConversation(messages, options.recentMessages || []);
}

module.exports = {
  buildAssistantTicketPrompt,
  formatRecentMessages: basePrompt.formatRecentMessages,
};
