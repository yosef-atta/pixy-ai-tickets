const assert = require("node:assert/strict");
const test = require("node:test");

const {
  APPLICATION_EMOJI_ITEM_ROUTE,
  BILLING_APPLICATION_EMOJIS,
  APPLICATION_EMOJI_ROUTE,
  formatBillingEmoji,
  getBillingEmoji,
  getVersionedEmojiName,
  readEmojiDataUri,
  syncBillingApplicationEmojis,
} = require("../src/config/applicationEmojis");
const { buildBillingSummary } = require("../src/billing/billingService");
const { buildBillingPanelPayload } = require("../src/slash/billing");

const CLIENT_ID = "1523331687713607783";
const GUILD_ID = "123456789012345678";
const USER_ID = "234567890123456789";

function getMenu(payload) {
  return payload.components[0].toJSON().components[0];
}

test("billing logo assets are valid Discord application-emoji data URIs", () => {
  assert.match(readEmojiDataUri(BILLING_APPLICATION_EMOJIS.paypal.filePath), /^data:image\/png;base64,/);
  assert.match(readEmojiDataUri(BILLING_APPLICATION_EMOJIS.vodafone.filePath), /^data:image\/jpeg;base64,/);
  assert.match(readEmojiDataUri(BILLING_APPLICATION_EMOJIS.orange.filePath), /^data:image\/png;base64,/);
});

test("application emoji sync keys managed emojis by asset content and removes stale versions", async () => {
  const calls = [];
  let nextId = 1000;
  const paypalName = getVersionedEmojiName(BILLING_APPLICATION_EMOJIS.paypal);
  const vodafoneName = getVersionedEmojiName(BILLING_APPLICATION_EMOJIS.vodafone);
  const orangeName = getVersionedEmojiName(BILLING_APPLICATION_EMOJIS.orange);
  const rest = {
    async get(route) {
      calls.push(["get", route]);
      return {
        items: [
          { id: "900", name: paypalName, animated: false },
          { id: "901", name: "pixy_paypal", animated: false },
          { id: "902", name: "pixy_vodafone_cash_deadbeef", animated: false },
        ],
      };
    },
    async post(route, options) {
      calls.push(["post", route, options.body.name]);
      return {
        id: String(nextId++),
        name: options.body.name,
        animated: false,
      };
    },
    async delete(route) {
      calls.push(["delete", route]);
    },
  };

  const synced = await syncBillingApplicationEmojis({
    token: "test-token",
    clientId: CLIENT_ID,
    rest,
  });

  assert.deepEqual(
    calls.filter((entry) => entry[0] === "post").map((entry) => entry[2]),
    [vodafoneName, orangeName]
  );
  assert.deepEqual(
    calls.filter((entry) => entry[0] === "delete").map((entry) => entry[1]),
    [
      APPLICATION_EMOJI_ITEM_ROUTE(CLIENT_ID, "901"),
      APPLICATION_EMOJI_ITEM_ROUTE(CLIENT_ID, "902"),
    ]
  );
  assert.equal(synced.paypal.id, "900");
  assert.equal(synced.paypal.name, paypalName);
  assert.equal(synced.vodafone.name, vodafoneName);
  assert.equal(synced.orange.name, orangeName);
  assert.deepEqual(getBillingEmoji(synced, "paypal"), synced.paypal);
  assert.equal(
    formatBillingEmoji(synced, "orange"),
    `<:${orangeName}:${synced.orange.id}>`
  );
});

test("changing an emoji file creates a new application emoji and retires the previous asset version", async () => {
  const calls = [];
  const definition = {
    name: "pixy_test_logo",
    filePath: "test-logo.png",
    fallbackEmoji: "💳",
  };
  const oldName = getVersionedEmojiName(definition, () => Buffer.from("old-image"));
  const newName = getVersionedEmojiName(definition, () => Buffer.from("new-image"));
  const rest = {
    async get() {
      return {
        items: [{ id: "700", name: oldName, animated: false }],
      };
    },
    async post(route, options) {
      calls.push(["post", route, options.body.name]);
      return { id: "701", name: options.body.name, animated: false };
    },
    async delete(route) {
      calls.push(["delete", route]);
    },
  };

  const synced = await syncBillingApplicationEmojis({
    token: "test-token",
    clientId: CLIENT_ID,
    rest,
    definitions: { test: definition },
    readFileSync: () => Buffer.from("new-image"),
  });

  assert.notEqual(oldName, newName);
  assert.deepEqual(calls, [
    ["post", APPLICATION_EMOJI_ROUTE(CLIENT_ID), newName],
    ["delete", APPLICATION_EMOJI_ITEM_ROUTE(CLIENT_ID, "700")],
  ]);
  assert.equal(synced.test.id, "701");
  assert.equal(synced.test.name, newName);
});

test("stale emoji cleanup failures do not discard the active synced emoji", async () => {
  const warnings = [];
  const definition = {
    name: "pixy_test_logo",
    filePath: "test-logo.png",
    fallbackEmoji: "💳",
  };
  const activeName = getVersionedEmojiName(definition, () => Buffer.from("current-image"));
  const rest = {
    async get() {
      return {
        items: [
          { id: "800", name: activeName, animated: false },
          { id: "801", name: "pixy_test_logo_old", animated: false },
        ],
      };
    },
    async delete() {
      throw new Error("Discord cleanup unavailable");
    },
  };

  const synced = await syncBillingApplicationEmojis({
    token: "test-token",
    clientId: CLIENT_ID,
    rest,
    definitions: { test: definition },
    readFileSync: () => Buffer.from("current-image"),
    onWarning: (message) => warnings.push(message),
  });

  assert.equal(synced.test.id, "800");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not delete stale application emoji/);
});

test("pixy-billing select options use the synced PayPal, Vodafone Cash, and Orange Cash logos", () => {
  const appEmojis = {
    paypal: { id: "111111111111111111", name: "pixy_paypal_a1b2c3d4", animated: false },
    vodafone: { id: "222222222222222222", name: "pixy_vodafone_cash_a1b2c3d4", animated: false },
    orange: { id: "333333333333333333", name: "pixy_orange_cash_a1b2c3d4", animated: false },
  };
  const summary = buildBillingSummary({
    guildId: GUILD_ID,
    trialStartedAt: new Date("2026-08-25T12:00:00.000Z"),
    trialEndsAt: new Date("2026-09-01T12:00:00.000Z"),
  }, { now: new Date("2026-08-25T13:00:00.000Z") });

  const menu = getMenu(buildBillingPanelPayload({
    summary,
    guildName: "Pixy Test Guild",
    guildId: GUILD_ID,
    userId: USER_ID,
    appEmojis,
  }));

  assert.deepEqual(
    menu.options.map((option) => [option.value, option.emoji.id, option.emoji.name]),
    [
      ["paypal", appEmojis.paypal.id, appEmojis.paypal.name],
      ["vodafone", appEmojis.vodafone.id, appEmojis.vodafone.name],
      ["orange", appEmojis.orange.id, appEmojis.orange.name],
    ]
  );
});
