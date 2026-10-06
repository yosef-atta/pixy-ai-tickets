const CURRENT_SETUP_VERSION = 2;
const DEFAULT_AI_PROVIDER = "groq";
const DEFAULT_MAX_LEARNED_ITEMS = 1000;
const DEFAULT_MAX_ADMIN_ROUTES = 1000;

const TICKET_SOURCE_TYPES = Object.freeze({
  CATEGORY: "category",
  THREAD_PARENT: "thread_parent",
});

const SETUP_STEPS = Object.freeze({
  TICKET_SOURCES: "ticket_sources",
  AI_PROVIDER: "ai_provider",
  HUMAN_SUPPORT: "human_support",
  COMPLETE: "complete",
});

const ESCALATION_MENTION_TARGETS = Object.freeze({
  OUTSIDE: "outside",
  INSIDE: "inside",
  BOTH: "both",
});

const DEFAULT_GUILD_SETTINGS = Object.freeze({
  aiReplyEnabled: true,
  closeTicketEnabled: false,
  renameReviewEnabled: false,
  escalationEnabled: true,
  agentActionsEnabled: true,
  escalationMentionTarget: ESCALATION_MENTION_TARGETS.OUTSIDE,
});

module.exports = {
  CURRENT_SETUP_VERSION,
  DEFAULT_AI_PROVIDER,
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_MAX_ADMIN_ROUTES,
  DEFAULT_MAX_LEARNED_ITEMS,
  ESCALATION_MENTION_TARGETS,
  SETUP_STEPS,
  TICKET_SOURCE_TYPES,
};
