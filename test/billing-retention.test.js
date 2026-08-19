const assert = require("node:assert/strict");
const test = require("node:test");

const { DAY_MS } = require("../src/billing/constants");
const { startTrialOnce } = require("../src/billing/billingService");
const {
  buildOperationalDeleteOperations,
  deleteGuildOperationalData,
} = require("../src/data/guildOperationalCleanup");
const {
  GUILD_ID,
  NOW,
} = require("./helpers/ownerBillingFakes");

const OPERATIONAL_MODELS = [
  "aiUsageLog",
  "ticketChannel",
  "learnedAnswer",
  "adminRoute",
  "guildIgnoredChannel",
  "guildBlockedTerm",
  "guildAllowedTerm",
  "ticketSource",
  "guildAiConfig",
  "guildSetupState",
  "guildSetting",
  "guildConfig",
];

function createCleanupClient(count = 1) {
  const calls = [];
  const client = {};
  for (const model of OPERATIONAL_MODELS) {
    client[model] = {
      deleteMany(args) {
        calls.push([model, args]);
        return Promise.resolve({ count });
      },
    };
  }
  client.guildBilling = {
    deleteMany() {
      throw new Error("GuildBilling must be retained");
    },
  };
  client.billingEvent = {
    deleteMany() {
      throw new Error("BillingEvent must be retained");
    },
  };
  client.$transaction = async (operations) => Promise.all(operations);
  return { client, calls };
}

test("clear and guild-removal cleanup delete operational data but never billing", async () => {
  const { client, calls } = createCleanupClient(2);
  const operations = buildOperationalDeleteOperations(client, GUILD_ID);
  assert.equal(operations.length, OPERATIONAL_MODELS.length);
  calls.length = 0;

  const result = await deleteGuildOperationalData(GUILD_ID, { client });
  assert.equal(result.billingPreserved, true);
  assert.equal(result.totalDeleted, OPERATIONAL_MODELS.length * 2);
  assert.deepEqual(calls.map(([model]) => model), OPERATIONAL_MODELS);
  assert.ok(calls.every(([, args]) => args.where.guildId === GUILD_ID));
});

test("setup after clear or reinvitation returns the retained Trial without extending it", async () => {
  const retained = {
    id: "billing-1",
    guildId: GUILD_ID,
    trialStartedAt: new Date(NOW.getTime() - 10 * DAY_MS),
    trialEndsAt: new Date(NOW.getTime() - 3 * DAY_MS),
    proStartedAt: null,
    proEndsAt: null,
    partnerActive: false,
    partnerSince: null,
  };
  let transactions = 0;
  const client = {
    guildBilling: {
      async findUnique() {
        return retained;
      },
    },
    async $transaction() {
      transactions += 1;
      throw new Error("setup must not create another Trial");
    },
  };

  const afterClear = await startTrialOnce(GUILD_ID, { client, now: NOW });
  const afterReinvite = await startTrialOnce(GUILD_ID, {
    client,
    now: new Date(NOW.getTime() + 30 * DAY_MS),
  });

  assert.equal(afterClear.trialStartedAt.getTime(), retained.trialStartedAt.getTime());
  assert.equal(afterClear.trialEndsAt.getTime(), retained.trialEndsAt.getTime());
  assert.equal(afterReinvite.trialEndsAt.getTime(), retained.trialEndsAt.getTime());
  assert.equal(transactions, 0);
});

test("active Pro and Partner entitlement survive operational cleanup and setup", async () => {
  const retained = {
    id: "billing-1",
    guildId: GUILD_ID,
    trialStartedAt: new Date(NOW.getTime() - 20 * DAY_MS),
    trialEndsAt: new Date(NOW.getTime() - 13 * DAY_MS),
    proStartedAt: new Date(NOW.getTime() - DAY_MS),
    proEndsAt: new Date(NOW.getTime() + 30 * DAY_MS),
    partnerActive: true,
    partnerSince: new Date(NOW.getTime() - 2 * DAY_MS),
  };
  const client = {
    guildBilling: {
      async findUnique() {
        return retained;
      },
    },
    async $transaction() {
      throw new Error("must not mutate retained billing");
    },
  };

  const result = await startTrialOnce(GUILD_ID, { client, now: NOW });
  assert.equal(result.proEndsAt.getTime(), retained.proEndsAt.getTime());
  assert.equal(result.partnerActive, true);
  assert.equal(result.partnerSince.getTime(), retained.partnerSince.getTime());
});
