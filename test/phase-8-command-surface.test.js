const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  GUILD_INSTALL_TYPE,
  GUILD_INTERACTION_CONTEXT,
  PUBLIC_SLASH_COMMANDS,
  SLASH_COMMAND_PREFIX,
  applyProductionSlashCommandName,
  commandToJSON,
  getBaseSlashCommandName,
  getProductionSlashCommandName,
  isPublicSlashCommand,
} = require("../src/config/bootstrap");

const EXPECTED_PUBLIC_COMMANDS = [
  "setup",
  "settings",
  "billing",
  "help",
  "reset",
];
const LEGACY_PUBLIC_COMMAND_PATTERN = /pixy-(?:admins|learn|mode|blacklist|clear)\b/i;

function mockCommand(name, options = {}) {
  const data = {
    name,
    setName(next) {
      this.name = next;
      return this;
    },
    toJSON() {
      return {
        name: this.name,
        description: options.description || `${name} command`,
      };
    },
  };

  return {
    data,
    guildOnly: options.guildOnly !== false,
    async execute() {},
  };
}

function listJsFilesRecursively(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJsFilesRecursively(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(fullPath);
  }
  return files;
}

test("Phase 8 exposes only the consolidated Pixy slash command set", () => {
  assert.deepEqual(PUBLIC_SLASH_COMMANDS, EXPECTED_PUBLIC_COMMANDS);

  const slashDir = path.join(__dirname, "../src/slash");
  const files = fs
    .readdirSync(slashDir)
    .filter((file) => file.endsWith(".js"))
    .sort();

  assert.deepEqual(files, [
    "billing.js",
    "help.js",
    "reset.js",
    "settings.js",
    "setup.js",
  ]);
});

test("runtime source no longer references legacy public Pixy slash commands", () => {
  const sourceRoot = path.join(__dirname, "../src");
  for (const file of listJsFilesRecursively(sourceRoot)) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      LEGACY_PUBLIC_COMMAND_PATTERN,
      `legacy public command reference remains in ${path.relative(sourceRoot, file)}`
    );
  }
});

test("legacy slash commands cannot pass the public bootstrap allowlist", () => {
  for (const name of ["admins", "learn", "mode", "blacklist", "clear"]) {
    assert.equal(isPublicSlashCommand(mockCommand(name)), false, name);
  }

  for (const name of EXPECTED_PUBLIC_COMMANDS) {
    assert.equal(isPublicSlashCommand(mockCommand(name)), true, name);
  }
});

test("production command prefixing is deterministic and idempotent", () => {
  const command = mockCommand("setup");

  assert.equal(getBaseSlashCommandName(command), "setup");
  assert.equal(getProductionSlashCommandName(command), `${SLASH_COMMAND_PREFIX}setup`);
  assert.equal(applyProductionSlashCommandName(command), "pixy-setup");
  assert.equal(command.data.name, "pixy-setup");
  assert.equal(getBaseSlashCommandName(command), "setup");
  assert.equal(getProductionSlashCommandName(command), "pixy-setup");
  assert.equal(applyProductionSlashCommandName(command), "pixy-setup");
});

test("global guild-only slash commands are restricted to guild install and guild interaction context", () => {
  const command = mockCommand("help", { guildOnly: true });
  applyProductionSlashCommandName(command);

  const json = commandToJSON(command);
  assert.equal(json.name, "pixy-help");
  assert.deepEqual(json.integration_types, [GUILD_INSTALL_TYPE]);
  assert.deepEqual(json.contexts, [GUILD_INTERACTION_CONTEXT]);
  assert.equal(Object.hasOwn(json, "dm_permission"), false);
});

test("guild-scoped registration does not send global integration/context fields", () => {
  const command = mockCommand("settings", { guildOnly: true });
  applyProductionSlashCommandName(command);

  const json = commandToJSON(command, { globalScope: false });
  assert.equal(json.name, "pixy-settings");
  assert.equal(Object.hasOwn(json, "integration_types"), false);
  assert.equal(Object.hasOwn(json, "contexts"), false);
  assert.equal(Object.hasOwn(json, "dm_permission"), false);
});

test("commandToJSON does not force guild context for non-guild-only modules", () => {
  const command = mockCommand("example", { guildOnly: false });
  const json = commandToJSON(command);
  assert.equal(Object.hasOwn(json, "integration_types"), false);
  assert.equal(Object.hasOwn(json, "contexts"), false);
  assert.equal(Object.hasOwn(json, "dm_permission"), false);
});

test("reset command copy is explicit about destructive operational reset and retained billing", () => {
  const resetSource = fs.readFileSync(
    path.join(__dirname, "../src/slash/reset.js"),
    "utf8"
  );

  assert.match(resetSource, /\.setName\("reset"\)/);
  assert.match(resetSource, /Billing continuity is retained/i);
  assert.match(resetSource, /does not grant another Trial/i);
  assert.doesNotMatch(resetSource, /pixy-clear/);
});
