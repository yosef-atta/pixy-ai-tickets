const assert = require("node:assert/strict");
const test = require("node:test");

const { buildTicketPrompt } = require("../src/ai/buildTicketPrompt");
const {
  buildAssistantTicketPrompt,
} = require("../src/ai/buildAssistantTicketPrompt");

const recentMessages = [
  {
    speakerType: "user",
    authorName: "Seif",
    content: "عايز اشتري",
  },
  {
    speakerType: "assistant",
    authorName: "Pixy Tests",
    content: "تحب أحولك لفريق الدعم؟",
  },
];

function assertNativeDialogue(messages) {
  const tail = messages.slice(-3);
  assert.deepEqual(tail, [
    {
      role: "user",
      content: "User (Seif): عايز اشتري",
    },
    {
      role: "assistant",
      content: "Pixy AI: تحب أحولك لفريق الدعم؟",
    },
    {
      role: "user",
      content: "Seif asked:\nتمام",
    },
  ]);

  assert.doesNotMatch(messages[1].content, /Recent ticket messages:/);
  assert.match(
    messages[0].content,
    /actual chronological user and assistant conversation turns/
  );
}

test("premium prompt promotes Discord history to native user and assistant turns", () => {
  const messages = buildTicketPrompt({
    guildName: "Example Guild",
    channelName: "ticket-sales",
    userName: "Seif",
    userMessage: "تمام",
    recentMessages,
    learnedQna: [],
    learnedFreeform: [],
    adminRoutes: [],
  });

  assertNativeDialogue(messages);
  assert.match(messages[1].content, /Server learned Q&A:/);
});

test("assistant-only prompt uses the same native dialogue roles without premium context", () => {
  const messages = buildAssistantTicketPrompt({
    guildName: "Example Guild",
    channelName: "ticket-sales",
    userName: "Seif",
    userMessage: "تمام",
    recentMessages,
  });

  assertNativeDialogue(messages);
  assert.doesNotMatch(messages[1].content, /Server learned Q&A:/);
  assert.doesNotMatch(messages.map((item) => item.content).join("\n"), /escalate_ticket/);
});
