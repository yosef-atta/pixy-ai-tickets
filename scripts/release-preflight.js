const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const failures = [];
const notes = [];

const EXPECTED_SLASH_FILES = [
  "billing.js",
  "help.js",
  "reset.js",
  "settings.js",
  "setup.js",
];
const REQUIRED_ENV_KEYS = [
  "NODE_ENV",
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "PREFIX",
  "OWNERS",
  "PAYPAL_OWNER_ID",
  "VODAFONE_OWNER_ID",
  "DATABASE_URL",
  "PIXY_CREDENTIAL_ENCRYPTION_KEY",
];
const REQUIRED_RELEASE_FILES = [
  ".github/workflows/ci.yml",
  "docs/RELEASE_CHECKLIST.md",
  "PRIVACY_POLICY.md",
  "README.md",
  "prisma/mysql-migrations/20260819163000_phase_1_data_foundation/migration.sql",
  "src/ai/providers/groqProvider.js",
  "src/ai/providers/googleProvider.js",
  "src/ai/providers/mistralProvider.js",
  "src/ai/providers/providerRegistry.js",
  "test/phase-10-providers.test.js",
  "test/phase-10-knowledge.test.js",
];

function fail(message) {
  failures.push(message);
}

function note(message) {
  notes.push(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function listJsFiles(directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];

  const results = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...listJsFiles(relative));
    else if (entry.isFile() && entry.name.endsWith(".js")) results.push(relative);
  }
  return results;
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 20) {
    fail(`Node.js 20+ is required; current runtime is ${process.version}.`);
  }
}

function checkRequiredFiles() {
  for (const relativePath of REQUIRED_RELEASE_FILES) {
    if (!exists(relativePath)) fail(`Missing release file: ${relativePath}`);
  }
}

function checkPackage() {
  const pkg = JSON.parse(read("package.json"));
  if (pkg.engines?.node !== ">=20") {
    fail(`package.json engines.node must remain >=20; found ${pkg.engines?.node || "missing"}.`);
  }
  if (pkg.scripts?.check !== "node scripts/release-preflight.js") {
    fail("package.json must expose `npm run check` for the release preflight.");
  }
  if (pkg.scripts?.test !== "node test/run-tests.js") {
    fail("package.json test script must continue to use the isolated Pixy test runner.");
  }
  if (!exists("package-lock.json")) fail("package-lock.json is required for deterministic npm ci installs.");
}

function checkEnvExample() {
  const envExample = read(".env.example");
  for (const key of REQUIRED_ENV_KEYS) {
    if (!new RegExp(`^${key}=`, "m").test(envExample)) {
      fail(`.env.example is missing ${key}.`);
    }
  }

  const secretKeys = [
    "DISCORD_TOKEN",
    "OWNERS",
    "PAYPAL_OWNER_ID",
    "VODAFONE_OWNER_ID",
    "PIXY_CREDENTIAL_ENCRYPTION_KEY",
  ];
  for (const key of secretKeys) {
    const match = envExample.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (match && match[1].trim()) {
      fail(`.env.example must not contain a real or example value for ${key}.`);
    }
  }
}

function checkSlashSurface() {
  const slashPath = path.join(root, "src/slash");
  const files = fs.readdirSync(slashPath)
    .filter((file) => file.endsWith(".js"))
    .sort();

  if (JSON.stringify(files) !== JSON.stringify(EXPECTED_SLASH_FILES)) {
    fail(`Unexpected public slash files: ${files.join(", ")}`);
  }

  if (exists("src/features/learnSubscription.js")) {
    fail("Legacy learnSubscription runtime layer must not return.");
  }
}

function checkReleaseCopy() {
  const readme = read("README.md");
  const privacy = read("PRIVACY_POLICY.md");
  const checklist = read("docs/RELEASE_CHECKLIST.md");
  const help = read("src/slash/help.js");
  const settings = read("src/slash/settings.js");
  const billing = read("src/slash/billing.js");

  for (const [label, text] of [["README", readme], ["Privacy Policy", privacy]]) {
    if (!/Thread Parent/i.test(text)) fail(`${label} must describe Thread Parent sources.`);
    if (!/\/pixy-reset/.test(text)) fail(`${label} must describe /pixy-reset.`);
    for (const provider of ["Groq", "Google Gemini", "Mistral"]) {
      if (!text.includes(provider)) fail(`${label} must describe the ${provider} provider.`);
    }
  }

  if (!/not an exact FAQ/i.test(readme)) {
    fail("README must explain that Knowledge is reusable AI context, not exact FAQ matching.");
  }
  if (!/Quick Import/i.test(readme) || !/Quick Import/i.test(settings)) {
    fail("README and Settings must describe the Knowledge Quick Import flow.");
  }
  if (!/not exact FAQ matching/i.test(help)) {
    fail("/pixy-help must explain the semantic Knowledge behavior.");
  }
  if (!/AI provider usage/i.test(billing) || /name:\s*"Groq usage"/.test(billing)) {
    fail("/pixy-billing must use provider-neutral AI usage copy.");
  }
  if (!/npm test/.test(checklist)) fail("Release checklist must require the full npm test suite.");
  if (!/billing/i.test(checklist) || !/reset/i.test(checklist) || !/thread/i.test(checklist)) {
    fail("Release checklist must cover billing, reset, and Thread smoke tests.");
  }
  for (const provider of ["Groq", "Google Gemini", "Mistral"]) {
    if (!checklist.includes(provider)) fail(`Release checklist must include a ${provider} smoke test.`);
  }
  if (!/Fresh-install end-to-end pass/i.test(checklist)) {
    fail("Release checklist must include the fresh-install end-to-end pass before partner rollout.");
  }
}

function checkWorkflow() {
  const workflow = read(".github/workflows/ci.yml");
  const requirements = [
    [/mysql:8\.4/, "MySQL 8.4 service"],
    [/3307:3306/, "isolated test port 3307"],
    [/TEST_DATABASE_URL:/, "TEST_DATABASE_URL"],
    [/run: npm ci/, "npm ci"],
    [/run: npm run check/, "release preflight"],
    [/npm test/, "full test suite"],
  ];
  for (const [pattern, label] of requirements) {
    if (!pattern.test(workflow)) fail(`CI workflow is missing ${label}.`);
  }
}

function checkJavaScriptSyntax() {
  const directories = ["src", "scripts", "test", "prisma"];
  const files = directories.flatMap(listJsFiles).sort();
  let checked = 0;

  for (const relativePath of files) {
    const result = spawnSync(process.execPath, ["--check", path.join(root, relativePath)], {
      cwd: root,
      encoding: "utf8",
    });
    checked += 1;
    if (result.status !== 0) {
      fail(`Syntax check failed: ${relativePath}\n${String(result.stderr || result.stdout || "").trim()}`);
    }
  }

  note(`Syntax checked ${checked} JavaScript files.`);
}

checkNodeVersion();
checkRequiredFiles();
checkPackage();
checkEnvExample();
checkSlashSurface();
checkReleaseCopy();
checkWorkflow();
checkJavaScriptSyntax();

if (failures.length) {
  console.error("Pixy release preflight failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Pixy release preflight passed.");
for (const message of notes) console.log(`- ${message}`);
console.log(`- Public slash surface: ${EXPECTED_SLASH_FILES.map((file) => `/pixy-${file.replace(/\.js$/, "")}`).join(", ")}`);
