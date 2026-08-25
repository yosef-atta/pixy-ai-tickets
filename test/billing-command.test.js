const assert = require("node:assert/strict");
const test = require("node:test");
const { PermissionFlagsBits } = require("discord.js");

const {
  BILLING_PLANS,
  DAY_MS,
} = require("../src/billing/constants");
const {
  buildBillingSummary,
} = require("../src/billing/billingService");
const billingCommand = require("../src/slash/billing");

const {
  EPHEMERAL,
  PAYMENT_SELECT_PREFIX,
  buildBillingPanelPayload,
  executeBillingCommand,
  getPaymentVerb,
  handlePaymentSelection,
} = billingCommand;

const NOW = new Date("2026-08-01T12:00:00.000Z");
const GUILD_ID = "123456789012345678";
const ADMIN_ID = "234567890123456789";
const PAYPAL_OWNER_ID = "345678901234567890";
const VODAFONE_OWNER_ID = "456789012345678901";

function summaryFor(billing) {
  return buildBillingSummary(billing, { now: NOW });
}

function getEmbedJson(payload) {
  return payload.embeds[0].toJSON();
}

function getMenuJson(payload) {
  if (!payload.components.length) return null;
  return payload.components[0].toJSON().components[0];
}

function getField(embed, name) {
  return embed.fields.find((field) => field.name === name);
}

const ROWS = {
  trial: {
    guildId: GUILD_ID,
    trialStartedAt: new Date(NOW.getTime() - 5 * DAY_MS),
    trialEndsAt: new Date(NOW.getTime() + 2 * DAY_MS),
  },
  expired: {
    guildId: GUILD_ID,
    trialStartedAt: new Date(NOW.getTime() - 8 * DAY_MS),
    trialEndsAt: new Date(NOW.getTime() - DAY_MS),
  },
  pro: {
    guildId: GUILD_ID,
    trialStartedAt: new Date(NOW.getTime() - 20 * DAY_MS),
    trialEndsAt: new Date(NOW.getTime() - 13 * DAY_MS),
    proStartedAt: new Date(NOW.getTime() - 10 * DAY_MS),
    proEndsAt: new Date(NOW.getTime() + 20 * DAY_MS),
  },
  partner: {
    guildId: GUILD_ID,
    trialStartedAt: new Date(NOW.getTime() - 20 * DAY_MS),
    trialEndsAt: new Date(NOW.getTime() - 13 * DAY_MS),
    proStartedAt: new Date(NOW.getTime() - 2 * DAY_MS),
    proEndsAt: new Date(NOW.getTime() + 28 * DAY_MS),
    partnerActive: true,
    partnerSince: new Date(NOW.getTime() - 30 * DAY_MS),
  },
};

test("billing command is guild-only, administrator-only, and registered from the billing base name", () => {
  const json = billingCommand.data.toJSON();

  assert.equal(json.name, "billing");
  assert.equal(billingCommand.guildOnly, true);
  assert.deepEqual(billingCommand.userPermissions, [PermissionFlagsBits.Administrator]);
  assert.ok(json.default_member_permissions);
  assert.equal(billingCommand.selectMenuHandlers[0].customIdPrefix, PAYMENT_SELECT_PREFIX);
});

for (const [name, billing] of Object.entries(ROWS)) {
  test(`${name} status renders plan details and feature availability`, () => {
    const summary = summaryFor(billing);
    const payload = buildBillingPanelPayload({
      summary,
      guildName: "Pixy Test Guild",
      guildId: GUILD_ID,
      userId: ADMIN_ID,
    });
    const embed = getEmbedJson(payload);
    const timeline = getField(embed, "Billing timeline").value;
    const features = getField(embed, "Feature availability").value;
    const providerUsage = getField(embed, "AI provider usage").value;

    assert.equal(getField(embed, "Effective plan").value, summary.planLabel);
    assert.match(getField(embed, "Remaining").value, summary.remaining.unlimited ? /Unlimited/ : /day|Expired/);
    assert.match(features, /Generic AI replies/);
    assert.match(features, /Learned knowledge/);
    assert.match(features, /Agent ticket actions/);
    assert.match(providerUsage, /selected AI provider/);
    assert.match(providerUsage, /Groq, Google Gemini, or Mistral/);
    assert.match(providerUsage, /shared provider quota/);

    if (summary.trial.startedAt) assert.match(timeline, /Trial started/);
    if (summary.pro.startedAt) assert.match(timeline, /Pro started/);
    if (summary.partner.startedAt) assert.match(timeline, /Partner since/);
  });
}

test("missing billing is shown clearly and still offers activation contacts", () => {
  const summary = summaryFor(null);
  const payload = buildBillingPanelPayload({
    summary,
    guildName: "Pixy Test Guild",
    guildId: GUILD_ID,
    userId: ADMIN_ID,
  });
  const embed = getEmbedJson(payload);
  const menu = getMenuJson(payload);

  assert.equal(summary.plan, BILLING_PLANS.EXPIRED);
  assert.equal(getField(embed, "Status").value, "Not initialized");
  assert.match(embed.description, /Billing has not been initialized/);
  assert.match(embed.description, /\/pixy-setup/);
  assert.match(embed.description, /complete onboarding/);
  assert.equal(menu.placeholder, "Activate Pixy Pro...");
});

const PAYMENT_LABEL_CASES = [
  ["trial", ROWS.trial, "Subscribe"],
  ["expired", ROWS.expired, "Activate"],
  ["pro", ROWS.pro, "Renew"],
];

for (const [name, billing, verb] of PAYMENT_LABEL_CASES) {
  test(`${name} payment menu uses ${verb} labels for all methods`, () => {
    const summary = summaryFor(billing);
    const payload = buildBillingPanelPayload({
      summary,
      guildName: "Pixy Test Guild",
      guildId: GUILD_ID,
      userId: ADMIN_ID,
    });
    const menu = getMenuJson(payload);

    assert.equal(getPaymentVerb(summary), verb);
    assert.equal(menu.custom_id, `${PAYMENT_SELECT_PREFIX}${ADMIN_ID}`);
    assert.equal(menu.placeholder, `${verb} Pixy Pro...`);
    assert.deepEqual(
      menu.options.map((option) => [option.value, option.label]),
      [
        ["paypal", `${verb} with PayPal`],
        ["vodafone", `${verb} with Vodafone Cash`],
        ["orange", `${verb} with Orange Cash`],
      ]
    );
  });
}

test("Partner hides the payment-method menu", () => {
  const summary = summaryFor(ROWS.partner);
  const payload = buildBillingPanelPayload({
    summary,
    guildName: "Pixy Test Guild",
    guildId: GUILD_ID,
    userId: ADMIN_ID,
  });

  assert.equal(getPaymentVerb(summary), null);
  assert.deepEqual(payload.components, []);
});

test("Trial and Pro show a prominent warning at three days or fewer", () => {
  for (const billing of [
    ROWS.trial,
    {
      guildId: GUILD_ID,
      proStartedAt: new Date(NOW.getTime() - 27 * DAY_MS),
      proEndsAt: new Date(NOW.getTime() + 3 * DAY_MS),
    },
  ]) {
    const embed = getEmbedJson(buildBillingPanelPayload({
      summary: summaryFor(billing),
      guildName: "Pixy Test Guild",
      guildId: GUILD_ID,
      userId: ADMIN_ID,
    }));

    assert.ok(getField(embed, "⚠️ Renewal needed soon"));
  }

  const noWarning = getEmbedJson(buildBillingPanelPayload({
    summary: summaryFor({
      guildId: GUILD_ID,
      proStartedAt: NOW,
      proEndsAt: new Date(NOW.getTime() + 4 * DAY_MS),
    }),
    guildName: "Pixy Test Guild",
    guildId: GUILD_ID,
    userId: ADMIN_ID,
  }));
  assert.equal(getField(noWarning, "⚠️ Renewal needed soon"), undefined);
});

function createCommandInteraction({ guild = true, administrator = true } = {}) {
  const replies = [];
  return {
    replies,
    guild: guild ? { id: GUILD_ID, name: "Pixy Test Guild" } : null,
    user: { id: ADMIN_ID },
    memberPermissions: {
      has(permission) {
        assert.equal(permission, PermissionFlagsBits.Administrator);
        return administrator;
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
  };
}

test("command execution rejects DMs and non-administrators ephemerally", async () => {
  for (const interaction of [
    createCommandInteraction({ guild: false }),
    createCommandInteraction({ administrator: false }),
  ]) {
    let loads = 0;
    await executeBillingCommand(interaction, {
      async loadSummary() {
        loads += 1;
        throw new Error("billing must not load before command permission checks");
      },
    });

    assert.equal(loads, 0);
    assert.equal(interaction.replies.length, 1);
    assert.equal(interaction.replies[0].flags, EPHEMERAL);
  }
});

test("command execution loads current billing and replies ephemerally", async () => {
  const interaction = createCommandInteraction();
  let loadedGuildId = null;

  await executeBillingCommand(interaction, {
    async loadSummary(guildId) {
      loadedGuildId = guildId;
      return summaryFor(ROWS.pro);
    },
  });

  assert.equal(loadedGuildId, GUILD_ID);
  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].flags, EPHEMERAL);
  assert.deepEqual(interaction.replies[0].allowedMentions, { parse: [] });
  assert.equal(getMenuJson(interaction.replies[0]).custom_id, `${PAYMENT_SELECT_PREFIX}${ADMIN_ID}`);
});

function createPaymentInteraction({
  methodKey,
  userId = ADMIN_ID,
  openerId = ADMIN_ID,
  administrator = true,
  appEnv = {
    paypalOwnerId: PAYPAL_OWNER_ID,
    vodafoneOwnerId: VODAFONE_OWNER_ID,
  },
}) {
  const replies = [];
  return {
    replies,
    customId: `${PAYMENT_SELECT_PREFIX}${openerId}`,
    values: [methodKey],
    guild: { id: GUILD_ID, name: "Pixy Test Guild" },
    user: { id: userId },
    client: { appEnv },
    memberPermissions: {
      has(permission) {
        assert.equal(permission, PermissionFlagsBits.Administrator);
        return administrator;
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
  };
}

for (const [methodKey, ownerId, otherOwnerId, label] of [
  ["paypal", PAYPAL_OWNER_ID, VODAFONE_OWNER_ID, "PayPal"],
  ["vodafone", VODAFONE_OWNER_ID, PAYPAL_OWNER_ID, "Vodafone Cash"],
  ["orange", VODAFONE_OWNER_ID, PAYPAL_OWNER_ID, "Orange Cash"],
]) {
  test(`${label} selection routes to its configured owner without automatic activation`, async () => {
    const interaction = createPaymentInteraction({ methodKey });
    await handlePaymentSelection(interaction);

    assert.equal(interaction.replies.length, 1);
    const reply = interaction.replies[0];
    assert.equal(reply.flags, EPHEMERAL);
    assert.deepEqual(reply.allowedMentions, { parse: [] });
    assert.match(reply.content, new RegExp(`<@${ownerId}>`));
    assert.doesNotMatch(reply.content, new RegExp(`<@${otherOwnerId}>`));
    assert.match(reply.content, /Open the owner profile/);
    assert.match(reply.content, /Send the owner a direct message/);
    assert.match(reply.content, /Pixy Test Guild/);
    assert.match(reply.content, new RegExp(GUILD_ID));
    assert.match(reply.content, /desired subscription duration/);
    assert.match(reply.content, /Never send passwords, Discord tokens, AI provider API keys/);
    assert.doesNotMatch(reply.content, /Groq API keys/);
    assert.match(reply.content, /did not send the owner a DM/);
    assert.match(reply.content, /activate\/renew this server automatically/);
  });
}

test("payment controls reject a different administrator without exposing owner routing", async () => {
  const interaction = createPaymentInteraction({
    methodKey: "paypal",
    userId: "567890123456789012",
  });

  await handlePaymentSelection(interaction);

  assert.equal(interaction.replies.length, 1);
  assert.match(interaction.replies[0].content, /Only the administrator who opened/);
  assert.doesNotMatch(interaction.replies[0].content, new RegExp(PAYPAL_OWNER_ID));
});

test("missing payment-owner configuration fails safely", async () => {
  const interaction = createPaymentInteraction({
    methodKey: "vodafone",
    appEnv: { paypalOwnerId: PAYPAL_OWNER_ID, vodafoneOwnerId: null },
  });

  await handlePaymentSelection(interaction);

  assert.equal(interaction.replies.length, 1);
  assert.match(interaction.replies[0].content, /Vodafone Cash contact is not configured/);
  assert.equal(interaction.replies[0].flags, EPHEMERAL);
});
