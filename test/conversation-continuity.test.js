const assert = require("node:assert/strict");
const test = require("node:test");

const { aiConfig } = require("../src/config/ai");
const {
  buildCompositeSearchQuery,
  buildTicketContext,
} = require("../src/ai/buildTicketContext");
const {
  buildTicketPrompt,
} = require("../src/ai/buildTicketPrompt");
const {
  getRecentChannelMessages,
  selectRecentConversationMessages,
} = require("../src/ai/conversationHistory");

const PIXY_ID = "pixy-123";

function makeMessage({
  id,
  bot = false,
  authorId,
  username,
  displayName,
  content,
  createdTimestamp,
  webhookId = null,
  components = [],
}) {
  return {
    id,
    author: {
      id: authorId || id,
      bot,
      username: username || (bot ? "Bot" : "User"),
    },
    member: displayName ? { displayName } : null,
    content,
    createdTimestamp,
    webhookId,
    components,
  };
}

function promptText(messages) {
  return messages.map((message) => message.content).join("\n\n");
}

test("recent history includes humans and Pixy, but excludes other bots, controls, webhooks, and current input", async () => {
  const fetched = new Map([
    ["user-1", makeMessage({
      id: "user-1",
      authorId: "human-1",
      username: "Seif",
      displayName: "Seif",
      content: "عايز اشتري",
      createdTimestamp: 100,
    })],
    ["other-bot", makeMessage({
      id: "other-bot",
      bot: true,
      authorId: "ticket-tool",
      username: "Ticket Tool",
      content: "Ticket metadata",
      createdTimestamp: 110,
    })],
    ["pixy-control", makeMessage({
      id: "pixy-control",
      bot: true,
      authorId: PIXY_ID,
      username: "Pixy Tests",
      content: "Ticket Actions",
      createdTimestamp: 115,
      components: [{ type: 1 }],
    })],
    ["pixy-1", makeMessage({
      id: "pixy-1",
      bot: true,
      authorId: PIXY_ID,
      username: "Pixy Tests",
      content: "تحب أحولك لفريق الدعم؟",
      createdTimestamp: 120,
    })],
    ["webhook", makeMessage({
      id: "webhook",
      bot: false,
      authorId: "external",
      username: "External",
      content: "Webhook content",
      createdTimestamp: 125,
      webhookId: "webhook-1",
    })],
    ["current", makeMessage({
      id: "current",
      authorId: "human-1",
      username: "Seif",
      content: "تمام",
      createdTimestamp: 130,
    })],
  ]);
  const channel = {
    messages: {
      async fetch({ limit }) {
        assert.equal(limit, aiConfig.recentMessagesFetchLimit);
        return fetched;
      },
    },
  };

  const history = await getRecentChannelMessages(channel, "current", {
    pixyUserId: PIXY_ID,
  });

  assert.deepEqual(history, [
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
  ]);
});

test("conversation memory is bounded to 20 turns with a soft 10/10 preference", () => {
  const mixed = [];
  for (let i = 0; i < 18; i += 1) {
    mixed.push({
      speakerType: "user",
      authorName: "User",
      content: `user-${i}`,
      createdTimestamp: i * 2,
    });
  }
  for (let i = 0; i < 2; i += 1) {
    mixed.push({
      speakerType: "assistant",
      authorName: "Pixy",
      content: `assistant-${i}`,
      createdTimestamp: i * 2 + 1,
    });
  }

  const selected = selectRecentConversationMessages(mixed, {
    totalLimit: 20,
    preferredPerSpeaker: 10,
    perMessageMaxChars: 500,
    totalMaxChars: 8000,
  });

  assert.equal(selected.length, 20);
  assert.equal(selected.filter((item) => item.speakerType === "assistant").length, 2);
  assert.equal(selected.filter((item) => item.speakerType === "user").length, 18);
});

test("conversation memory enforces per-message and total character budgets", () => {
  const selected = selectRecentConversationMessages(
    Array.from({ length: 20 }, (_, index) => ({
      speakerType: index % 2 === 0 ? "user" : "assistant",
      authorName: index % 2 === 0 ? "User" : "Pixy",
      content: "x".repeat(1000),
      createdTimestamp: index,
    })),
    {
      totalLimit: 20,
      preferredPerSpeaker: 10,
      perMessageMaxChars: 500,
      totalMaxChars: 1200,
    }
  );

  assert.ok(selected.length <= 3);
  assert.ok(selected.every((item) => item.content.length <= 500));
  assert.ok(
    selected.reduce((sum, item) => sum + item.content.length, 0) <= 1200
  );
});

test("RAG query uses current input plus recent human turns and never previous Pixy replies", () => {
  const query = buildCompositeSearchQuery(
    { content: "تمام" },
    [
      {
        speakerType: "user",
        authorName: "Seif",
        content: "سعر الباقة؟",
      },
      {
        speakerType: "assistant",
        authorName: "Pixy",
        content: "السعر 500",
      },
      {
        speakerType: "user",
        authorName: "Seif",
        content: "عايز اشتري",
      },
      {
        speakerType: "assistant",
        authorName: "Pixy",
        content: "تحب أحولك للدعم؟",
      },
    ]
  );

  assert.match(query, /سعر الباقة؟/);
  assert.match(query, /عايز اشتري/);
  assert.match(query, /تمام/);
  assert.doesNotMatch(query, /السعر 500/);
  assert.doesNotMatch(query, /تحب أحولك للدعم؟/);
});

test("ticket context sends only user-grounded dialogue into the batched RAG request", async () => {
  let ragQuery = null;
  const guild = {
    id: "guild-1",
    name: "Example Guild",
    members: { me: { id: PIXY_ID } },
    roles: {
      cache: new Map(),
      async fetch() {},
    },
  };
  const fetched = new Map([
    ["u1", makeMessage({
      id: "u1",
      authorId: "human-1",
      username: "Seif",
      content: "عايز اشتري",
      createdTimestamp: 1,
    })],
    ["p1", makeMessage({
      id: "p1",
      bot: true,
      authorId: PIXY_ID,
      username: "Pixy Tests",
      content: "تحب أحولك للدعم؟",
      createdTimestamp: 2,
    })],
  ]);
  const message = {
    id: "current",
    content: "تمام",
    guild,
    client: { user: { id: PIXY_ID } },
    channel: {
      name: "ticket-sales",
      messages: { async fetch() { return fetched; } },
    },
  };

  const context = await buildTicketContext({
    message,
    async searchContext(args) {
      ragQuery = args.query;
      return {
        ok: true,
        knowledgeResults: [],
        routeResults: [],
        knowledgeCandidates: 0,
        routeCandidates: 0,
      };
    },
  });

  assert.equal(context.recentMessages.length, 2);
  assert.equal(context.recentMessages[1].speakerType, "assistant");
  assert.match(ragQuery, /عايز اشتري/);
  assert.match(ragQuery, /تمام/);
  assert.doesNotMatch(ragQuery, /تحب أحولك للدعم؟/);
});

test("premium prompt exposes the immediately previous Pixy question for short confirmations without trusting it as server fact", () => {
  const messages = buildTicketPrompt({
    guildName: "Example Guild",
    channelName: "ticket-sales",
    userName: "Seif",
    userMessage: "تمام",
    recentMessages: [
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
    ],
    learnedQna: [],
    learnedFreeform: [],
    adminRoutes: [{
      roleId: "role-1",
      roleName: "Sales",
      description: "Handles purchases and sales requests.",
    }],
  });
  const text = promptText(messages);

  assert.match(text, /User \(Seif\): عايز اشتري/);
  assert.match(text, /Pixy AI: تحب أحولك لفريق الدعم؟/);
  assert.match(text, /Seif asked:\nتمام/);
  assert.match(text, /Previous Pixy AI replies are conversation state only/);
  assert.match(text, /not authoritative server knowledge/);
});
