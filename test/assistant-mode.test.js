const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAssistantTicketPrompt,
} = require("../src/ai/buildAssistantTicketPrompt");
const {
  buildTicketContext,
} = require("../src/ai/buildTicketContext");
const {
  buildTicketPrompt,
} = require("../src/ai/buildTicketPrompt");
const {
  SUBSCRIPTION_BLOCKED_AGENT_OUTPUT_STATUS,
  buildPromptForEntitlement,
  channelControlPlans,
  refreshControlsForPlanChange,
} = require("../src/events/tickets/messageCreate");

function promptText(messages) {
  return messages.map((message) => message.content).join("\n\n");
}

test("expired context keeps recent conversation without querying learned data or routes", async () => {
  const databaseCalls = [];
  const client = {
    guildConfig: {
      async findUnique() {
        databaseCalls.push("guildConfig");
        throw new Error("premium context must not be loaded");
      },
    },
    learnedAnswer: {
      async findMany() {
        databaseCalls.push("learnedAnswer");
        throw new Error("premium context must not be loaded");
      },
    },
    adminRoute: {
      async findMany() {
        databaseCalls.push("adminRoute");
        throw new Error("premium context must not be loaded");
      },
    },
  };
  const recent = new Map([
    ["old-1", {
      id: "old-1",
      author: { bot: false, username: "Sam" },
      member: { displayName: "Sam" },
      content: "My payment failed yesterday",
      createdTimestamp: 1,
    }],
    ["current", {
      id: "current",
      author: { bot: false, username: "Current" },
      content: "current message",
      createdTimestamp: 2,
    }],
  ]);
  const message = {
    id: "current",
    guild: {
      id: "guild-1",
      name: "Example Guild",
      roles: {
        cache: new Map(),
        async fetch() {},
      },
    },
    channel: {
      name: "ticket-payment",
      messages: {
        async fetch() {
          return recent;
        },
      },
    },
  };

  const context = await buildTicketContext({
    message,
    client,
    includeLearnedKnowledge: false,
    includeAdminRoutes: false,
  });

  assert.deepEqual(databaseCalls, []);
  assert.deepEqual(context.learnedQna, []);
  assert.deepEqual(context.learnedFreeform, []);
  assert.deepEqual(context.adminRoutes, []);
  assert.deepEqual(context.recentMessages, [{
    speakerType: "user",
    authorName: "Sam",
    content: "My payment failed yesterday",
  }]);
});

test("expired assistant prompt is text-only and preserves Pixy conversation turns", () => {
  const messages = buildAssistantTicketPrompt({
    guildName: "Example Guild",
    channelName: "ticket-payment",
    userName: "Sam",
    userMessage: "Yes",
    recentMessages: [
      {
        speakerType: "user",
        authorName: "Sam",
        content: "My payment failed yesterday",
      },
      {
        speakerType: "assistant",
        authorName: "Pixy Tests",
        content: "Do you want to continue with that?",
      },
    ],
  });
  const text = promptText(messages);

  assert.match(text, /User \(Sam\): My payment failed yesterday/);
  assert.match(text, /Pixy AI: Do you want to continue with that\?/);
  assert.match(text, /Previous Pixy AI replies are conversation state only/);
  assert.match(text, /Return normal helpful text only/);
  assert.doesNotMatch(text, /close_ticket/);
  assert.doesNotMatch(text, /rename_ticket/);
  assert.doesNotMatch(text, /escalate_ticket/);
  assert.doesNotMatch(text, /action_request/);
  assert.doesNotMatch(text, /Server learned Q&A/);
  assert.doesNotMatch(text, /Server free-form knowledge/);
  assert.doesNotMatch(text, /Configured escalation roles/);
});

test("prompt selection ignores learned and route context in expired mode", () => {
  const context = {
    guildName: "Example Guild",
    channelName: "ticket-payment",
    recentMessages: [{
      speakerType: "user",
      authorName: "Sam",
      content: "recent sentinel",
    }],
    learnedQna: [{ question: "LEARNED_QNA_SENTINEL", answer: "secret" }],
    learnedFreeform: [{ title: "LEARNED_FREEFORM_SENTINEL", content: "secret" }],
    adminRoutes: [{
      roleId: "123",
      roleName: "ROUTE_SENTINEL",
      description: "billing",
    }],
  };

  const messages = buildPromptForEntitlement({
    entitlement: { plan: "expired", premiumEntitled: false },
    context,
    config: { aiSystemPrompt: "CUSTOM_AGENT_SENTINEL close_ticket" },
    userName: "Sam",
    userMessage: "Help me",
  });
  const text = promptText(messages);

  assert.match(text, /recent sentinel/);
  assert.doesNotMatch(text, /LEARNED_QNA_SENTINEL/);
  assert.doesNotMatch(text, /LEARNED_FREEFORM_SENTINEL/);
  assert.doesNotMatch(text, /ROUTE_SENTINEL/);
  assert.doesNotMatch(text, /CUSTOM_AGENT_SENTINEL/);
  assert.doesNotMatch(text, /close_ticket/);
});

test("premium prompt behavior still includes learned knowledge and action schemas", () => {
  const messages = buildTicketPrompt({
    guildName: "Example Guild",
    channelName: "ticket-payment",
    userName: "Sam",
    userMessage: "Please escalate this",
    recentMessages: [],
    learnedQna: [{ question: "LEARNED_QNA_SENTINEL", answer: "answer" }],
    learnedFreeform: [{ title: "LEARNED_FREEFORM_SENTINEL", content: "content" }],
    adminRoutes: [{ roleId: "123", roleName: "Billing", description: "Payments" }],
  });
  const text = promptText(messages);

  assert.match(text, /LEARNED_QNA_SENTINEL/);
  assert.match(text, /LEARNED_FREEFORM_SENTINEL/);
  assert.match(text, /close_ticket/);
  assert.match(text, /rename_ticket/);
  assert.match(text, /escalate_ticket/);
  assert.match(text, /action_request/);
});

test("subscription-blocked agent output uses a stable AI usage status", () => {
  assert.equal(
    SUBSCRIPTION_BLOCKED_AGENT_OUTPUT_STATUS,
    "action_rejected:subscription_agent_output_blocked"
  );
});

test("the next ticket message refreshes controls only when the effective plan changes", async () => {
  channelControlPlans.clear();
  const refreshes = [];
  const message = {
    channelId: "channel-1",
    channel: { id: "channel-1" },
    guild: { id: "guild-1" },
  };
  const ticket = { aiEnabled: true };
  const refreshControl = async (payload) => {
    refreshes.push(payload);
    return { ok: true };
  };

  await refreshControlsForPlanChange({
    message,
    ticket,
    entitlement: { plan: "trial" },
    refreshControl,
  });
  await refreshControlsForPlanChange({
    message,
    ticket,
    entitlement: { plan: "trial" },
    refreshControl,
  });
  await refreshControlsForPlanChange({
    message,
    ticket,
    entitlement: { plan: "expired" },
    refreshControl,
  });

  assert.equal(refreshes.length, 2);
  assert.equal(refreshes[0].entitlement.plan, "trial");
  assert.equal(refreshes[1].entitlement.plan, "expired");
});
