const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "../src/components/setupUxPolish.js"),
  "utf8"
);

test("setup dashboard uses one section select menu instead of the old three-button navigation", () => {
  assert.match(source, /Choose a setup section/);
  assert.match(source, /Ticket Sources/);
  assert.match(source, /AI Provider/);
  assert.match(source, /Human Support/);
  assert.match(source, /Setup Health/);
  assert.match(source, /DASHBOARD_NAV_PREFIX/);
});

test("saving an onboarding support role returns to Human Support instead of completing onboarding", () => {
  assert.match(source, /executeHumanDescriptionWithoutAutoFinish/);
  assert.match(source, /upsertSupportRoute/);
  assert.match(source, /Add another role if needed, or press \*\*Finish Setup\*\*/);

  const modalOverride = source.slice(
    source.indexOf("descriptionModalHandler.execute"),
    source.indexOf("const removeRouteHandler")
  );
  assert.doesNotMatch(modalOverride, /completeOnboarding/);
  assert.match(modalOverride, /setup\.renderHumanSupport/);
});

test("onboarding can remove support routes before Finish Setup", () => {
  assert.match(source, /Remove support roles from onboarding/);
  assert.match(source, /PREFIX\.HUMAN_REMOVE_ROUTE/);
  assert.match(source, /executeHumanRemoveRoutes/);
  assert.match(source, /setup\.renderHumanSupport\(interaction\.guild, userId, mode, notice\)/);
});

test("multi-role onboarding keeps Finish Setup as an explicit administrator action", () => {
  assert.match(source, /Add as many support roles as you need/);
  assert.match(source, /press \*\*Finish Setup\*\*/);
  assert.doesNotMatch(source, /skipHumanSupportAndComplete/);
});
