const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PermissionFlagsBits,
  PermissionsBitField,
} = require("discord.js");

const {
  SETUP_REQUIRED_PERMISSIONS,
  checkSetupPermissions,
  clearSetupPermissionVerification,
} = require("../src/setup/setupPermissionGate");
const {
  CHECK_PREFIX,
  renderChecking,
  renderPermissionResult,
  renderPermissionStart,
} = require("../src/components/setupPermissionCheck");

function permissions(...values) {
  return new PermissionsBitField(values);
}

function fullPermissionSet() {
  return permissions(...SETUP_REQUIRED_PERMISSIONS.map(({ flag }) => flag));
}

function createGuild(memberPermissions) {
  let fetchCount = 0;
  const member = {
    id: "bot-member",
    user: { id: "bot-user" },
    permissions: memberPermissions,
  };

  const guild = {
    id: "guild-permission-start",
    client: { user: { id: member.user.id } },
    members: {
      me: member,
      async fetch() {
        fetchCount += 1;
        return member;
      },
    },
  };

  return {
    guild,
    get fetchCount() {
      return fetchCount;
    },
  };
}

test("setup permission intro waits for Start Checks instead of running a check immediately", () => {
  const payload = renderPermissionStart("admin-user");
  const json = payload.embeds[0].toJSON();
  const button = payload.components[0].components[0].toJSON();

  assert.match(json.title, /Permission Check/);
  assert.match(json.description, /Nothing is being checked yet/i);
  assert.equal(button.label, "Start Checks");
  assert.equal(button.custom_id, `${CHECK_PREFIX}admin-user`);
});

test("checking screen acknowledges the long Discord lookup with visible progress", () => {
  const payload = renderChecking();
  const json = payload.embeds[0].toJSON();
  const progress = json.fields.find((field) => field.name === "Progress");

  assert.match(json.title, /Checking Permissions/);
  assert.match(progress.value, new RegExp(`0 / ${SETUP_REQUIRED_PERMISSIONS.length}`));
  assert.equal(payload.components[0].components[0].toJSON().disabled, true);
});

test("permission result shows ready/missing counts and a Recheck button", () => {
  const missing = SETUP_REQUIRED_PERMISSIONS.slice(-2);
  const payload = renderPermissionResult({
    ok: false,
    code: "missing_setup_permissions",
    missing,
  }, "admin-user");
  const json = payload.embeds[0].toJSON();
  const result = json.fields.find((field) => field.name === "Result");
  const missingField = json.fields.find((field) => field.name.startsWith("Missing Permissions"));
  const button = payload.components[0].components[0].toJSON();

  assert.match(result.value, /4 \/ 6 ready/);
  assert.match(result.value, /2 missing/);
  assert.match(missingField.value, /Manage Channels/);
  assert.match(missingField.value, /Manage Roles/);
  assert.equal(button.label, "Recheck Permissions");
});

test("successful Start Checks result is cached for later setup steps until a forced recheck", async () => {
  const fixture = createGuild(fullPermissionSet());
  clearSetupPermissionVerification(fixture.guild.id);

  const initial = await checkSetupPermissions(fixture.guild, { force: true });
  assert.equal(initial.ok, true);
  assert.equal(initial.cached, false);
  assert.equal(fixture.fetchCount, 1);

  const laterStep = await checkSetupPermissions(fixture.guild);
  assert.equal(laterStep.ok, true);
  assert.equal(laterStep.cached, true);
  assert.equal(fixture.fetchCount, 1);

  const explicitRecheck = await checkSetupPermissions(fixture.guild, { force: true });
  assert.equal(explicitRecheck.ok, true);
  assert.equal(explicitRecheck.cached, false);
  assert.equal(fixture.fetchCount, 2);
});

test("failed forced checks never cache a partial permission set", async () => {
  const fixture = createGuild(permissions(
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages
  ));
  clearSetupPermissionVerification(fixture.guild.id);

  const first = await checkSetupPermissions(fixture.guild, { force: true });
  assert.equal(first.ok, false);
  assert.equal(fixture.fetchCount, 1);

  const second = await checkSetupPermissions(fixture.guild);
  assert.equal(second.ok, false);
  assert.equal(fixture.fetchCount, 2);
});
