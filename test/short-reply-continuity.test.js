const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildTicketPrompt,
} = require("../src/ai/buildTicketPrompt");
const {
  buildAssistantTicketPrompt,
} = require("../src/ai/buildAssistantTicketPrompt");
const {
  buildShortReplyContinuationHint,
  classifyShortReply,
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

test("Arabic and English short affirmatives are classified as affirmative", () => {
  for (const value of ["تمام", "تمام؟", "ايوه", "أيوه", "نعم", "yes", "OK", "okay", "sure"]) {
    assert.equal(classifyShortReply(value), "affirmative", value);
  }
});

test("Arabic and English short negatives are classified as negative", () => {
  for (const value of ["لا", "لأ", "مش دلوقتي", "no", "nope", "not now"]) {
    assert.equal(classifyShortReply(value), "negative", value);
  }
});

test("affirmative reply after Pixy offer creates a do-not-repeat continuation signal", () => {
  const hint = buildShortReplyContinuationHint(recentPixyOffer(), "تمام");

  assert.equal(hint.role, "system");
  assert.match(hint.content, /short affirmative response/);
  assert.match(hint.content, /continue with the offered next step immediately/);
  assert.match(hint.content, /Do not repeat the same question or offer/);
  assert.match(hint.content, /never bypasses grounding, safety, entitlement, or application action validation rules/);
});

test("negative reply after Pixy offer creates a rejection continuation signal", () => {
  const hint = buildShortReplyContinuationHint(recentPixyOffer(), "لا");

  assert.equal(hint.role, "system");
  assert.match(hint.content, /short negative response/);
  assert.match(hint.content, /treat the reply as a rejection/);
});

test("short reply is not linked to an older Pixy turn when the immediately previous turn is another user", () => {
  const hint = buildShortReplyContinuationHint([
    ...recentPixyOffer(),
    {
      speakerType: "user",
      authorName: "Other Member",
      content: "أنا عندي سؤال كمان",
    },
  ], "تمام");

  assert.equal(hint, null);
});

test("premium prompt sends the affirmative state note plus native dialogue roles before current reply", () => {
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

  const currentIndex = messages.length - 1;
  const historicalAssistantIndex = messages.findIndex(
    (message) => message.role === "assistant" && /هل تحب أن أساعدك/.test(message.content)
  );
  const hintIndex = messages.findIndex(
    (message) => message.role === "system" && /short affirmative response/.test(message.content)
  );

  assert.ok(hintIndex > 0);
  assert.ok(historicalAssistantIndex > hintIndex);
  assert.ok(historicalAssistantIndex < currentIndex);
  assert.equal(messages[currentIndex].role, "user");
  assert.match(messages[currentIndex].content, /تمام/);
  assert.doesNotMatch(messages[1].content, /Recent ticket messages:/);
});

test("assistant-only prompt gets the same affirmative conversation signal without premium actions", () => {
  const messages = buildAssistantTicketPrompt({
    guildName: "Example Guild",
    channelName: "ticket-help",
    userName: "Yosef",
    userMessage: "تمام",
    recentMessages: recentPixyOffer(),
  });
  const text = messages.map((message) => message.content).join("\n\n");

  assert.match(systemTexts(messages), /short affirmative response/);
  assert.doesNotMatch(text, /close_ticket/);
  assert.doesNotMatch(text, /rename_ticket/);
  assert.doesNotMatch(text, /escalate_ticket/);
});
