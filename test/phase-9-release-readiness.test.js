const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("release candidate exposes a deterministic preflight command", () => {
  const pkg = JSON.parse(read("package.json"));

  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.scripts.check, "node scripts/release-preflight.js");
  assert.equal(pkg.scripts.test, "node test/run-tests.js");
  assert.ok(fs.existsSync(path.join(root, "scripts/release-preflight.js")));
});

test("CI uses the same MySQL generation as local Pixy and the isolated test database", () => {
  const workflow = read(".github/workflows/ci.yml");
  const runner = read("test/run-tests.js");
  const compose = read("docker-compose.yml");

  assert.match(compose, /image:\s*mysql:8\.4/);
  assert.match(workflow, /image:\s*mysql:8\.4/);
  assert.match(workflow, /3307:3306/);
  assert.match(workflow, /TEST_DATABASE_URL:\s*mysql:\/\/pixy:pixy_test_password@127\.0\.0\.1:3307\/pixy_test/);
  assert.match(runner, /127\.0\.0\.1:3307\/pixy_test/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*npm run check/);
  assert.match(workflow, /npm test/);
});

test("release documentation covers migration, channel/thread smoke tests, billing, and reset", () => {
  const checklist = read("docs/RELEASE_CHECKLIST.md");

  assert.match(checklist, /prisma:migrate/);
  assert.match(checklist, /Fresh-server onboarding smoke test/i);
  assert.match(checklist, /Existing-server migration smoke test/i);
  assert.match(checklist, /Channel-ticket runtime smoke test/i);
  assert.match(checklist, /Thread/i);
  assert.match(checklist, /Billing/i);
  assert.match(checklist, /pixy-reset/i);
  assert.match(checklist, /npm test/);
});

test("production env template declares required runtime inputs without embedding secrets", () => {
  const env = read(".env.example");
  const required = [
    "DISCORD_TOKEN",
    "DISCORD_CLIENT_ID",
    "OWNERS",
    "PAYPAL_OWNER_ID",
    "VODAFONE_OWNER_ID",
    "DATABASE_URL",
    "PIXY_CREDENTIAL_ENCRYPTION_KEY",
  ];

  for (const key of required) {
    assert.match(env, new RegExp(`^${key}=`, "m"), key);
  }

  for (const key of [
    "DISCORD_TOKEN",
    "OWNERS",
    "PAYPAL_OWNER_ID",
    "VODAFONE_OWNER_ID",
    "PIXY_CREDENTIAL_ENCRYPTION_KEY",
  ]) {
    const match = env.match(new RegExp(`^${key}=(.*)$`, "m"));
    assert.ok(match, key);
    assert.equal(match[1].trim(), "", `${key} must remain empty in .env.example`);
  }
});

test("release candidate keeps the expected public slash command surface", () => {
  const slashFiles = fs
    .readdirSync(path.join(root, "src/slash"))
    .filter((file) => file.endsWith(".js"))
    .sort();

  assert.deepEqual(slashFiles, [
    "billing.js",
    "help.js",
    "reset.js",
    "settings.js",
    "setup.js",
  ]);
});
