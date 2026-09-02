const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildTicketContext,
  parseRagAdminRoutes,
} = require("../src/ai/buildTicketContext");
const {
  buildGuildRagItems,
} = require("../src/ai/ragSyncService");
const {
  getMaxAdminRoutes,
  removeSupportRoutes,
  upsertSupportRoute,
} = require("../src/setup/setupService");

const GUILD_ID = "123456789012345678";
const ROLE_ID = "223456789012345678";

function createGuild() {
  const role = { id: ROLE_ID, name: "Billing Support" };
  return {
    id: GUILD_ID,
    name: "RAG Test Guild",
    roles: {
      cache: new Map([[ROLE_ID, role]]),
      async fetch() {},
    },
  };
}

test("admin route capacity can scale to the shared 1000-route default", () => {
  assert.equal(getMaxAdminRoutes({ maxAdminRoutes: 1000 }), 1000);
  assert.equal(getMaxAdminRoutes({ maxAdminRoutes: 5000 }), 1000);
});

test("saving and removing support routes synchronizes their Qdrant item IDs", async () => {
  let savedRoute = null;
  let ragUpsertPayload = null;
  let ragDeletePayload = null;
  const client = {
    guildConfig: {
      async findUnique() {
        return { guildId: GUILD_ID, maxAdminRoutes: 1000 };
      },
    },
    adminRoute: {
      async findUnique() {
        return savedRoute;
      },
      async count() {
        return savedRoute ? 1 : 0;
      },
      async upsert({ create, update }) {
        savedRoute = savedRoute
          ? { ...savedRoute, ...update, updatedAt: new Date() }
          : { id: "route-1", ...create, updatedAt: new Date() };
        return { ...savedRoute };
      },
      async deleteMany() {
        savedRoute = null;
        return { count: 1 };
      },
    },
    guildSetting: {
      async upsert({ create, update }) {
        return { ...create, ...update };
      },
    },
  };

  const saved = await upsertSupportRoute(
    GUILD_ID,
    ROLE_ID,
    "Handles payments, failed purchases, and billing questions.",
    {
      client,
      async ragUpsert(payload) {
        ragUpsertPayload = payload;
        return { ok: true };
      },
    }
  );

  assert.equal(saved.maxRoutes, 1000);
  assert.equal(ragUpsertPayload.items[0].type, "admin_route");
  assert.equal(ragUpsertPayload.items[0].id, "route-1");
  assert.equal(ragUpsertPayload.items[0].metadata.roleId, ROLE_ID);

  await removeSupportRoutes(GUILD_ID, ["route-1"], {
    client,
    async ragDelete(payload) {
      ragDeletePayload = payload;
      return { ok: true };
    },
  });

  assert.deepEqual(ragDeletePayload, {
    guildId: GUILD_ID,
    itemIds: ["route-1"],
  });
});

test("RAG admin route results resolve back to live Discord roles", async () => {
  const guild = createGuild();
  const routes = await parseRagAdminRoutes([
    {
      id: "vector-1",
      item_id: "route-1",
      item_type: "admin_route",
      text: "Admin Route: Billing Support\nDescription: Handles failed payments.",
      score: 0.91,
      metadata: {
        roleId: ROLE_ID,
        description: "Handles failed payments.",
      },
    },
  ], guild);

  assert.deepEqual(routes, [{
    id: "route-1",
    roleId: ROLE_ID,
    roleName: "Billing Support",
    description: "Handles failed payments.",
    score: 0.91,
  }]);
});

test("ticket context retrieves knowledge and admin routes through one bounded RAG request", async () => {
  const calls = [];
  const guild = createGuild();
  const message = {
    id: "current-message",
    content: "My payment failed and I need help",
    guild,
    channel: {
      name: "ticket-billing",
      messages: {
        async fetch() {
          return new Map();
        },
      },
    },
  };

  const context = await buildTicketContext({
    message,
    client: {},
    async searchContext(args) {
      calls.push(args);
      return {
        ok: true,
        knowledgeCandidates: 7,
        routeCandidates: 4,
        timingsMs: { total: 321.5 },
        knowledgeResults: [{
          id: "vector-qna",
          item_id: "qna-1",
          item_type: "qna",
          title: "What if a payment fails?",
          text: "Question: What if a payment fails?\nAnswer: Do not retry multiple charges.",
          score: 0.88,
          metadata: {
            question: "What if a payment fails?",
            answer: "Do not retry multiple charges.",
          },
        }],
        routeResults: [{
          id: "vector-route",
          item_id: "route-1",
          item_type: "admin_route",
          text: "Admin Route: Billing Support\nDescription: Handles payment failures.",
          score: 0.93,
          metadata: {
            roleId: ROLE_ID,
            description: "Handles payment failures.",
          },
        }],
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].guildId, GUILD_ID);
  assert.ok(calls[0].knowledgeCandidateK >= calls[0].knowledgeTopK);
  assert.ok(calls[0].routeCandidateK >= calls[0].routeTopK);
  assert.equal(context.knowledgeRetrievalSource, "rag");
  assert.equal(context.routeRetrievalSource, "rag");
  assert.equal(context.learnedQna.length, 1);
  assert.equal(context.adminRoutes[0].roleId, ROLE_ID);
  assert.equal(context.ragCandidates, 7);
  assert.equal(context.ragRouteCandidates, 4);
  assert.equal(context.ragTimingsMs.total, 321.5);
});

test("successful RAG response with no matching route does not inject arbitrary MySQL routes", async () => {
  let mysqlRouteReads = 0;
  const guild = createGuild();
  const message = {
    id: "current-message",
    content: "How do I apply for staff?",
    guild,
    channel: {
      name: "ticket-staff",
      messages: { async fetch() { return new Map(); } },
    },
  };
  const client = {
    guildConfig: {
      async findUnique() {
        return { maxLearnedItems: 1000, maxAdminRoutes: 1000 };
      },
    },
    learnedAnswer: { async findMany() { return []; } },
    adminRoute: {
      async findMany() {
        mysqlRouteReads += 1;
        return [{ id: "billing", roleId: ROLE_ID, description: "Billing only" }];
      },
    },
  };

  const context = await buildTicketContext({
    message,
    client,
    async searchContext() {
      return {
        ok: true,
        knowledgeResults: [],
        routeResults: [],
        knowledgeCandidates: 0,
        routeCandidates: 0,
      };
    },
  });

  assert.equal(context.routeRetrievalSource, "rag");
  assert.deepEqual(context.adminRoutes, []);
  assert.equal(mysqlRouteReads, 0);
});

test("full RAG sync includes both learned knowledge and enabled admin routes", async () => {
  const client = {
    guildConfig: {
      async findUnique() {
        return {
          maxLearnedItems: 1000,
          maxAdminRoutes: 1000,
        };
      },
    },
    learnedAnswer: {
      async findMany() {
        return [{
          id: "qna-1",
          type: "qna",
          question: "How much is Gold?",
          answer: "100 credits",
          updatedAt: new Date("2026-09-02T10:00:00Z"),
        }];
      },
    },
    adminRoute: {
      async findMany() {
        return [{
          id: "route-1",
          roleId: ROLE_ID,
          description: "Handles billing questions",
          enabled: true,
          updatedAt: new Date("2026-09-02T10:00:00Z"),
        }];
      },
    },
  };

  const items = await buildGuildRagItems(GUILD_ID, { client });
  assert.equal(items.length, 2);
  assert.equal(items[0].type, "qna");
  assert.equal(items[1].type, "admin_route");
  assert.equal(items[1].metadata.roleId, ROLE_ID);
});
