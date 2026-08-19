const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("public and operator documentation describes implemented billing behavior", () => {
  const readme = read("README.md");
  const privacy = read("PRIVACY_POLICY.md");
  for (const expected of [
    "/pixy-billing",
    "Expired",
    "Partner",
    "PAYPAL_OWNER_ID",
    "VODAFONE_OWNER_ID",
    "^partner add <guild-id>",
    "30-day months",
    "365-day years",
    "Groq, Google Gemini, and Mistral",
  ]) {
    assert.match(readme, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const expected of [
    /Billing audit events/i,
    /Trial-abuse prevention/i,
    /PayPal/i,
    /Vodafone Cash/i,
    /does not collect payment/i,
    /Last updated: August 19, 2026/i,
  ]) {
    assert.match(privacy, expected);
  }
});

test("reset and guild-removal code explicitly retain billing continuity", () => {
  const cleanup = read("src/data/guildOperationalCleanup.js");
  const reset = read("src/slash/reset.js");
  const guildDelete = read("src/events/guildDelete.js");

  assert.doesNotMatch(cleanup, /guildBilling\.delete/i);
  assert.doesNotMatch(cleanup, /billingEvent\.delete/i);
  assert.match(reset, /billing audit records were retained/i);
  assert.match(reset, /will not start another Trial/i);
  assert.match(guildDelete, /billing continuity records were retained/i);
});

test("public help, settings, and lock copy point administrators to billing", () => {
  const help = read("src/slash/help.js");
  const settings = read("src/slash/settings.js");
  const entitlement = read("src/billing/entitlementService.js");

  assert.match(help, /Plans & Billing/);
  assert.match(help, /generic AI replies/i);
  assert.match(settings, /New additions are currently locked/);
  assert.match(settings, /\/pixy-billing/);
  assert.match(entitlement, /\/pixy-billing/);
});

test("owner billing code documents row locking and avoids payment-secret fields", () => {
  const service = read("src/billing/ownerBillingService.js");
  const concurrency = read("docs/payments/CONCURRENCY.md");

  assert.match(service, /FOR UPDATE/);
  assert.match(service, /Serializable/);
  assert.match(concurrency, /prevents two near-simultaneous renewals/i);
  assert.doesNotMatch(service, /password|paypal.*credential|vodafone.*pin/i);
});
