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
  assert.match(policy, /accepting, confirming, approving, authorizing, or consenting/);
  assert.match(policy, /rejecting, declining, cancelling, or withholding consent/);
  assert.match(policy, /full local dialogue and the user's wording/);
  assert.match(policy, /Do not require or maintain a fixed vocabulary/);
  assert.match(policy, /across languages, dialects, slang, spelling variation, punctuation, emojis/);
});

test("semantic continuation does not mechanically force every brief reply into the final question", () => {
  const policy = buildSemanticContinuationPolicy(recentPixyOffer());

  assert.match(policy, /do not mechanically force every brief reply to answer it/);
  assert.match(policy, /naturally asks to continue, expand, explain, or revisit informational content/);
  assert.match(policy, /choose the one best supported by the full local dialogue and the user's wording/);
  assert.match(policy, /clarification only when the ambiguity would materially change the next action/);
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

test("premium prompt uses one semantic policy regardless of exact acknowledgement wording", () => {
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
  assert.match(first[0].content, /semantic meaning/);
  assert.match(first[0].content, /without repeating the same question/);
  assert.match(first[0].content, /continue that content instead of forcing it into a yes\/no interpretation/);
  assert.match(first[0].content, /semantic relationship to the recent dialogue rather than from a fixed list of words/);
  assert.doesNotMatch(first[0].content, /yes, no, okay, تمام, ايوه, نعم, or لا/);
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
  assert.match(system, /Never infer or perform a destructive or privileged application action/);
  assert.match(system, /current mode exposes that action and its existing validation policy allows it/);
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
  assert.match(systemTexts(messages), /semantic meaning/);
  assert.match(systemTexts(messages), /semantic relationship to the recent dialogue rather than from a fixed list of words/);
  assert.doesNotMatch(text, /yes, no, okay, تمام, ايوه, نعم, or لا/);
  assert.doesNotMatch(text, /close_ticket/);
  assert.doesNotMatch(text, /rename_ticket/);
  assert.doesNotMatch(text, /escalate_ticket/);
});
