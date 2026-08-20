const assert = require("node:assert/strict");
const test = require("node:test");

const { attachSource } = require("../src/config/bootstrap");

test("registered interaction handlers delegate to later execute overrides", async () => {
  const calls = [];
  const handler = {
    customIdPrefix: "setup-test:",
    async execute(value) {
      calls.push(["original", value]);
      return "original";
    },
  };

  const attached = attachSource(handler, "pixy-setup");

  handler.execute = async function executeOverride(value) {
    calls.push(["override", value]);
    return "override";
  };

  const result = await attached.execute("interaction");

  assert.equal(result, "override");
  assert.deepEqual(calls, [["override", "interaction"]]);
  assert.equal(attached.sourceCommand, "pixy-setup");
  assert.equal(attached.customIdPrefix, "setup-test:");
});
