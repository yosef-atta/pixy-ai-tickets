const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PermissionFlagsBits,
  PermissionsBitField,
} = require("discord.js");

const {
  SETUP_REQUIRED_PERMISSIONS,
  clearSetupPermissionVerification,
  prepareTicketSourceAccess,
} = require("../src/setup/setupPermissionGate");

function fullPermissions() {
  return new PermissionsBitField(
    SETUP_REQUIRED_PERMISSIONS.map(({ flag }) => flag)
  );
}

function createGuild() {
  const user = { id: "bot-user" };
  const botRole = { id: "bot-role" };
  const member = {
    id: "bot-user",
    user,
    permissions: fullPermissions(),
  };
  const guild = {
    id: "guild-best-effort",
    client: { user },
    members: {
      me: member,
      async fetch() {
        return member;
      },
    },
    roles: {
      botRoleFor(value) {
        return value?.id === user.id ? botRole : null;
      },
    },
  };
  member.guild = guild;
  return { guild, member, botRole };
}

test("Ticket Source auto-access targets Pixy's managed bot role when available", async () => {
  const { guild, botRole } = createGuild();
  let target = null;
  const channel = {
    id: "category-role-target",
    guild,
    permissionOverwrites: {
      async edit(value) {
        target = value;
      },
    },
  };

  clearSetupPermissionVerification(guild.id);
  const result = await prepareTicketSourceAccess(guild, [channel], "category");

  assert.equal(result.ok, true);
  assert.equal(result.accessPrepared, true);
  assert.equal(target, botRole);
});

test("Ticket Source selection stays allowed when Discord rejects the best-effort overwrite", async () => {
  const { guild } = createGuild();
  const channel = {
    id: "category-overwrite-rejected",
    guild,
    permissionOverwrites: {
      async edit() {
        const error = new Error("Missing Access");
        error.code = 50001;
        throw error;
      },
    },
  };

  clearSetupPermissionVerification(guild.id);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await prepareTicketSourceAccess(guild, [channel], "category");

    assert.equal(result.ok, true);
    assert.equal(result.accessPrepared, false);
    assert.equal(result.warningCode, "ticket_source_access_not_prepared");
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].channel.id, channel.id);
  } finally {
    console.warn = originalWarn;
  }
});
