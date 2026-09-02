const {
  buildTicketPrompt: buildBaseTicketPrompt,
} = require("./buildTicketPromptBase");
const {
  promoteRecentConversation,
} = require("./conversationPromptMessages");

function buildTicketPrompt(options = {}) {
  const messages = buildBaseTicketPrompt(options);
  return promoteRecentConversation(messages, options.recentMessages || [], {
    nextContextHeading: "Server learned Q&A:",
    currentUserMessage: options.userMessage || "",
  });
}

module.exports = { buildTicketPrompt };
