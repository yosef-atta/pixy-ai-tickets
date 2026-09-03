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
      content: "شرحت لك الفرق بالتفصيل. هل تحب أن أساعدك في اختيار الأنسب لك؟",
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
  assert.match(policy, /active pending turn/);
  assert.match(policy, /final question, offer, choice, confirmation request, handoff proposal/);
  assert.match(policy, /accepting, confirming, approving, authorizing, or consenting/);
  assert.match(policy, /rejecting, declining, cancelling, or withholding consent/);
  assert.match(policy, /genuinely ambiguous, mixed, or starts a new topic/);
  assert.match(policy, /Do not require or maintain a fixed vocabulary/);
  assert.match(policy, /across languages, dialects, slang, spelling variation, punctuation, emojis/);
});

test("brief continuation is anchored to Pixy's final unresolved move rather than earlier explanation", () => {
  const policy = buildSemanticContinuationPolicy(recentPixyOffer());

  assert.match(policy, /Resolve a brief or elliptical user reply against the active pending turn before interpreting it as a request to continue an earlier informational part/);
  assert.match(policy, /prefer the final pending turn when the reply naturally answers it/);
  assert.match(policy, /Continue earlier informational content only when the user explicitly refers to that content/);
  assert.match(policy, /Do not restate or ask the same pending question again/);
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
    userMessage: "اشطا كمل",
  });
  const third = buildTicketPrompt({
    ...commonOptions,
    userMessage: "works for me",
  });

  assert.equal(first[0].content, second[0].content);
  assert.equal(second[0].content, third[0].content);
  assert.match(first[0].content, /active pending turn/);
  assert.match(first[0].content, /continue the promised or offered next step immediately/);
  assert.match(first[0].content, /Do not restate or ask the same pending question again/);
  assert.equal(first.filter((message) => message.role === "system").length, 1);

  const currentIndex = second.length - 1;
  const historicalAssistantIndex = second.findIndex(
    (message) => message.role === "assistant" && /هل تحب أن أساعدك/.test(message.content)
  );
  assert.ok(historicalAssistantIndex > 1);
  assert.ok(historicalAssistantIndex < currentIndex);
  assert.equal(second[currentIndex].role, "user");
  assert.match(second[currentIndex].content, /اشطا كمل/);
  assert.doesNotMatch(second[1].content, /Recent ticket messages:/);
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
    userMessage: "اشطا كمل",
    recentMessages: recentPixyOffer(),
  });
  const text = messages.map((message) => message.content).join("\n\n");

  assert.equal(messages.filter((message) => message.role === "system").length, 1);
  assert.match(systemTexts(messages), /active pending turn/);
  assert.doesNotMatch(text, /close_ticket/);
  assert.doesNotMatch(text, /rename_ticket/);
  assert.doesNotMatch(text, /escalate_ticket/);
});
