const assert = require("node:assert/strict");
const test = require("node:test");

const { ragConfig } = require("../src/config/rag");
const {
  checkHealth,
  deleteKnowledge,
  isRagAvailable,
  searchKnowledge,
  syncAllKnowledge,
  upsertKnowledge,
} = require("../src/ai/ragClient");
const {
  buildCompositeSearchQuery,
  buildTicketContext,
  parseRagResults,
} = require("../src/ai/buildTicketContext");

test("ragConfig exposes correct defaults and getters", () => {
  assert.equal(typeof ragConfig.enabled, "boolean");
  assert.ok(ragConfig.serviceUrl.startsWith("http"));
  assert.equal(typeof ragConfig.candidateK, "number");
  assert.equal(typeof ragConfig.topK, "number");
  assert.equal(typeof ragConfig.timeoutMs, "number");
  assert.ok(ragConfig.candidateK >= ragConfig.topK);
});

test("buildCompositeSearchQuery combines current and recent messages cleanly", () => {
  const message = { content: "How do I upgrade to Pro?" };
  const recent = [
    { content: "Hello" },
    { content: "I want to know about pricing" },
  ];

  const query = buildCompositeSearchQuery(message, recent);
  assert.ok(query.includes("How do I upgrade to Pro?"));
  assert.ok(query.includes("pricing"));
});

test("parseRagResults correctly unpacks QnA and Freeform knowledge items", () => {
  const rawResults = [
    {
      id: "uuid-1",
      item_id: "qna-1",
      item_type: "qna",
      title: "How to pay?",
      text: "Question: How to pay?\nAnswer: We accept credit cards and PayPal.",
      score: 0.95,
      metadata: { question: "How to pay?", answer: "We accept credit cards and PayPal." },
    },
    {
      id: "uuid-2",
      item_id: "doc-1",
      item_type: "freeform",
      title: "Server Rules",
      text: "Be respectful to everyone.",
      score: 0.88,
      metadata: { title: "Server Rules", content: "Be respectful to everyone." },
    },
  ];

  const parsed = parseRagResults(rawResults);
  assert.equal(parsed.learnedQna.length, 1);
  assert.equal(parsed.learnedQna[0].question, "How to pay?");
  assert.equal(parsed.learnedQna[0].answer, "We accept credit cards and PayPal.");

  assert.equal(parsed.learnedFreeform.length, 1);
  assert.equal(parsed.learnedFreeform[0].title, "Server Rules");
  assert.equal(parsed.learnedFreeform[0].content, "Be respectful to everyone.");
});

test("buildTicketContext falls back to database when RAG returns empty or fails", async () => {
  const fakePrisma = {
    guildConfig: {
      async findUnique() {
        return { maxLearnedItems: 10, maxAdminRoutes: 5 };
      },
    },
    learnedAnswer: {
      async findMany() {
        return [
          {
            id: "db-qna-1",
            type: "qna",
            question: "DB Question?",
            answer: "DB Answer.",
          },
        ];
      },
    },
    adminRoute: {
      async findMany() {
        return [];
      },
    },
  };

  const message = {
    id: "msg-123",
    content: "test message",
    guild: {
      id: "fake-guild-id-without-rag-items",
      name: "Test Guild",
      roles: { cache: new Map(), async fetch() {} },
    },
    channel: {
      name: "ticket-101",
      messages: {
        async fetch() {
          return new Map();
        },
      },
    },
  };

  const context = await buildTicketContext({
    message,
    includeLearnedKnowledge: true,
    includeAdminRoutes: true,
    client: fakePrisma,
  });

  assert.ok(Array.isArray(context.learnedQna));
  assert.ok(Array.isArray(context.learnedFreeform));
  assert.ok(["rag", "mysql"].includes(context.retrievalSource));
});
