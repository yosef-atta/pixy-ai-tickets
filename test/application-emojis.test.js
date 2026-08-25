const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BILLING_APPLICATION_EMOJIS,
  APPLICATION_EMOJI_ROUTE,
  formatBillingEmoji,
  getBillingEmoji,
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

test("application emoji sync reuses existing logos and creates only missing logos", async () => {
  const calls = [];
  let nextId = 1000;
  const rest = {
    async get(route) {
      calls.push(["get", route]);
      return {
        items: [
          { id: "900", name: "pixy_paypal", animated: false },
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
  };

  const synced = await syncBillingApplicationEmojis({
    token: "test-token",
    clientId: CLIENT_ID,
    rest,
  });

  assert.deepEqual(calls.map((entry) => entry.slice(0, 2)), [
    ["get", APPLICATION_EMOJI_ROUTE(CLIENT_ID)],
    ["post", APPLICATION_EMOJI_ROUTE(CLIENT_ID)],
    ["post", APPLICATION_EMOJI_ROUTE(CLIENT_ID)],
  ]);
  assert.equal(synced.paypal.id, "900");
  assert.equal(synced.vodafone.name, "pixy_vodafone_cash");
  assert.equal(synced.orange.name, "pixy_orange_cash");
  assert.deepEqual(getBillingEmoji(synced, "paypal"), synced.paypal);
  assert.equal(
    formatBillingEmoji(synced, "orange"),
    `<:pixy_orange_cash:${synced.orange.id}>`
  );
});

test("pixy-billing select options use the synced PayPal, Vodafone Cash, and Orange Cash logos", () => {
  const appEmojis = {
    paypal: { id: "111111111111111111", name: "pixy_paypal", animated: false },
    vodafone: { id: "222222222222222222", name: "pixy_vodafone_cash", animated: false },
    orange: { id: "333333333333333333", name: "pixy_orange_cash", animated: false },
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
