const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BILLING_EVENT_ACTIONS,
  STANDARD_TRIAL_DURATION_MS,
} = require("../src/billing/constants");
const {
  SYSTEM_BILLING_ACTOR,
  startTrialOnce,
} = require("../src/billing/billingService");
const {
  SETUP_STEPS,
} = require("../src/config/productDefaults");
const {
  completeOnboarding,
} = require("../src/setup/setupService");

const NOW = new Date("2026-08-01T12:00:00.000Z");

function createBillingClient(initialBilling = null) {
  let billing = initialBilling;
  const events = [];
  const calls = [];

  const transaction = {
    guildBilling: {
      async create({ data }) {
        calls.push(["billing.create", data]);
        billing = { id: "billing-1", ...data };
        return billing;
      },
    },
    billingEvent: {
      async create({ data }) {
        calls.push(["event.create", data]);
        events.push({ id: `event-${events.length + 1}`, ...data });
        return events.at(-1);
      },
    },
  };

  return {
    calls,
    events,
    get billing() {
      return billing;
    },
    guildBilling: {
      async findUnique({ where }) {
        calls.push(["billing.findUnique", where]);
        return billing;
      },
    },
    async $transaction(callback) {
      calls.push(["transaction"]);
      return callback(transaction);
    },
  };
}

function addOnboardingState(client, order = []) {
  let config = {
    guildId: "123",
    enabled: false,
    maxLearnedItems: 50,
    maxAdminRoutes: 10,
  };
  let setupState = null;

  client.guildConfig = {
    async findUnique() {
      return { ...config };
    },
    async update({ data }) {
      order.push(["guild.update", data]);
      config = { ...config, ...data };
      return { ...config };
    },
  };
  client.guildSetupState = {
    async upsert({ create, update }) {
      order.push(["setup.upsert", create, update]);
      setupState = setupState
        ? { ...setupState, ...update }
        : { id: "setup-1", ...create };
      return { ...setupState };
    },
  };
  client.getGuildConfig = () => ({ ...config });
  client.getSetupState = () => setupState ? { ...setupState } : null;
  return client;
}

test("startTrialOnce atomically creates exact seven-day trial and audit event", async () => {
  const client = createBillingClient();

  const billing = await startTrialOnce(" 123 ", { client, now: NOW });

  assert.equal(billing.guildId, "123");
  assert.equal(billing.trialStartedAt.getTime(), NOW.getTime());
  assert.equal(
    billing.trialEndsAt.getTime(),
    NOW.getTime() + STANDARD_TRIAL_DURATION_MS
  );
  assert.equal(client.events.length, 1);
  assert.equal(client.events[0].guildId, "123");
  assert.equal(client.events[0].actorUserId, SYSTEM_BILLING_ACTOR);
  assert.equal(client.events[0].action, BILLING_EVENT_ACTIONS.TRIAL_STARTED);
  assert.deepEqual(
    client.calls.map(([name]) => name),
    ["billing.findUnique", "transaction", "billing.create", "event.create"]
  );
});

test("startTrialOnce returns existing billing without extending dates or auditing again", async () => {
  const existing = {
    id: "existing",
    guildId: "123",
    trialStartedAt: new Date("2026-07-01T00:00:00.000Z"),
    trialEndsAt: new Date("2026-07-08T00:00:00.000Z"),
  };
  const client = createBillingClient(existing);

  const billing = await startTrialOnce("123", {
    client,
    now: new Date("2026-08-01T00:00:00.000Z"),
  });

  assert.equal(billing, existing);
  assert.equal(billing.trialStartedAt.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(billing.trialEndsAt.toISOString(), "2026-07-08T00:00:00.000Z");
  assert.equal(client.events.length, 0);
  assert.deepEqual(client.calls, [["billing.findUnique", { guildId: "123" }]]);
});

test("completed onboarding starts the trial and activates Pixy at the final step", async () => {
  const order = [];
  const client = addOnboardingState(createBillingClient(), order);

  const result = await completeOnboarding("123", {
    client,
    now: NOW,
    actorUserId: "admin-user",
    async startTrial(guildId, options) {
      order.push(["trial.start", guildId, options.actorUserId]);
      return startTrialOnce(guildId, options);
    },
  });

  assert.equal(order[0][0], "trial.start");
  assert.equal(order[0][1], "123");
  assert.equal(order[0][2], "admin-user");
  assert.equal(client.getGuildConfig().enabled, true);
  assert.equal(result.state.lastStep, SETUP_STEPS.COMPLETE);
  assert.equal(result.state.completedAt.getTime(), NOW.getTime());
  assert.equal(client.events.length, 1);
});

test("repeating completed onboarding never extends the original trial", async () => {
  const client = addOnboardingState(createBillingClient());

  await completeOnboarding("123", {
    client,
    now: NOW,
    startTrial: (guildId, options) => startTrialOnce(guildId, options),
  });
  const firstStartedAt = client.billing.trialStartedAt.toISOString();
  const firstEndsAt = client.billing.trialEndsAt.toISOString();

  const later = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
  await completeOnboarding("123", {
    client,
    now: later,
    startTrial: (guildId, options) => startTrialOnce(guildId, options),
  });

  assert.equal(client.billing.trialStartedAt.toISOString(), firstStartedAt);
  assert.equal(client.billing.trialEndsAt.toISOString(), firstEndsAt);
  assert.equal(client.events.length, 1);
});
