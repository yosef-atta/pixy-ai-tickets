const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildTicketPrompt,
} = require("../src/ai/buildTicketPrompt");
const {
  buildAssistantTicketPrompt,
} = require("../src/ai/buildAssistantTicketPrompt");
const {
  buildSemanticContinuationPolicy,
} = require("../src/ai/conversationPromptMessages");

function recentPixyOffer() {
  return [
    {
      speakerType: "user",
      authorName: "Yosef",
      content: "قارنلي بين Nitro و Server Boost",
    },
    {
      speakerType: "assistant",
      authorName: "Pixy Tests",
      content: "هل تحب أن أساعدك في اختيار الأنسب لك؟",
    },
  ];
}

function systemTexts(messages) {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
}

test("continuation policy is semantic rather than exact-word based", () => {
  const policy = buildSemanticContinuationPolicy(recentPixyOffer());

  assert.match(policy, /semantic meaning/);
  assert.match(policy, /not by exact keyword matching/);
  assert.match(policy, /accepting, confirming, approving, or consenting/);
  assert.match(policy, /rejecting, declining, cancelling, or withholding consent/);
  assert.match(policy, /ambiguous, mixed, or starts a new topic/);
  assert.match(policy, /Do not require a fixed vocabulary/);
  assert.match(policy, /across languages, dialects, slang, spelling variation/);
});

test("semantic continuation policy only attaches when the immediately previous turn is Pixy", () => {
  const policy = buildSemanticContinuationPolicy([
    ...recentPixyOffer(),
    {
      speakerType: "user",
      authorName: "Other Member",
      content: "أنا عندي سؤال كمان",
    },
  ]);

  assert.equal(policy, null);
});

test("premium prompt uses the same semantic policy regardless of exact acknowledgement wording", () => {
  const commonOptions = {
    guildName: "Example Guild",
    channelName: "ticket-help",
    userName: "Yosef",
    recentMessages: recentPixyOffer(),
    learnedQna: [],
    learnedFreeform: [],
    adminRoutes: [],
  };

  const first = buildTicketPrompt({
    ...commonOptions,
    userMessage: "تمام",
  });
  const second = buildTicketPrompt({
    ...commonOptions,
    userMessage: "works for me",
  });

  assert.equal(first[0].content, second[0].content);
  assert.match(first[0].content, /semantic meaning/);
  assert.match(first[0].content, /continue the offered next step immediately/);
  assert.match(first[0].content, /Do not repeat the same question or offer/);
  assert.equal(first.filter((message) => message.role === "system").length, 1);

  const currentIndex = first.length - 1;
  const historicalAssistantIndex = first.findIndex(
    (message) => message.role === "assistant" && /هل تحب أن أساعدك/.test(message.content)
  );
  assert.ok(historicalAssistantIndex > 1);
  assert.ok(historicalAssistantIndex < currentIndex);
  assert.equal(first[currentIndex].role, "user");
  assert.match(first[currentIndex].content, /تمام/);
  assert.doesNotMatch(first[1].content, /Recent ticket messages:/);
});

test("semantic continuation policy preserves action-specific safety rules", () => {
  const messages = buildTicketPrompt({
    guildName: "Example Guild",
    channelName: "ticket-help",
    userName: "Yosef",
    userMessage: "تمام",
    recentMessages: recentPixyOffer(),
    learnedQna: [],
    learnedFreeform: [],
    adminRoutes: [],
  });

  const system = systemTexts(messages);
  assert.match(system, /Action-specific rules are stronger than this continuation policy/);
  assert.match(system, /never infer a destructive action such as close_ticket/);
  assert.match(system, /all grounding, safety, entitlement, and application action validation rules remain in force/);
});

test("assistant-only prompt gets semantic continuity without premium actions", () => {
  const messages = buildAssistantTicketPrompt({
    guildName: "Example Guild",
    channelName: "ticket-help",
    userName: "Yosef",
    userMessage: "تمام",
    recentMessages: recentPixyOffer(),
  });
  const text = messages.map((message) => message.content).join("\n\n");

  assert.equal(messages.filter((message) => message.role === "system").length, 1);
  assert.match(systemTexts(messages), /semantic meaning/);
  assert.doesNotMatch(text, /close_ticket/);
  assert.doesNotMatch(text, /rename_ticket/);
  assert.doesNotMatch(text, /escalate_ticket/);
});
