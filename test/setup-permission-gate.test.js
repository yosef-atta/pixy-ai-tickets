const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PermissionFlagsBits,
  PermissionsBitField,
} = require("discord.js");

const {
  ACCESS_PROFILES,
  SETUP_REQUIRED_PERMISSIONS,
  checkSetupPermissions,
  prepareHumanSupportCategoryAccess,
  prepareTicketSourceAccess,
} = require("../src/setup/setupPermissionGate");

function permissions(...values) {
  return new PermissionsBitField(values);
}

function createGuild(memberPermissions) {
  const member = {
    id: "bot-member",
    user: { id: "bot-user" },
    permissions: memberPermissions,
  };
  let fetchOptions = null;
  return {
    guild: {
      id: "guild-1",
      client: { user: { id: member.user.id } },
      members: {
        me: member,
        async fetch(options) {
          fetchOptions = options;
          return member;
        },
      },
    },
    member,
    get fetchOptions() {
      return fetchOptions;
    },
  };
}

function fullPermissionSet() {
  return permissions(...SETUP_REQUIRED_PERMISSIONS.map(({ flag }) => flag));
}

test("setup permission gate lists every missing full-feature permission in one check", async () => {
  const fixture = createGuild(permissions(
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages
  ));

  const status = await checkSetupPermissions(fixture.guild);

  assert.equal(status.ok, false);
  assert.deepEqual(
    status.missing.map(({ label }) => label),
    [
      "Send Messages in Threads",
      "Read Message History",
      "Manage Channels",
      "Manage Roles",
    ]
  );
  assert.equal(fixture.fetchOptions?.force, true);
  assert.equal(fixture.fetchOptions?.user, "bot-user");
});

test("setup permission gate passes only when the full Pixy permission set is ready", async () => {
  const fixture = createGuild(fullPermissionSet());
  const status = await checkSetupPermissions(fixture.guild);

  assert.equal(status.ok, true);
  assert.deepEqual(status.missing, []);
});

test("category Ticket Sources receive Pixy's full channel-access overwrite automatically", async () => {
  const fixture = createGuild(fullPermissionSet());
  const edits = [];
  const category = {
    id: "category-1",
    permissionOverwrites: {
      async edit(target, profile, options) {
        edits.push({ target, profile, options });
        return category;
      },
    },
  };

  const result = await prepareTicketSourceAccess(
    fixture.guild,
    [category],
    "category"
  );

  assert.equal(result.ok, true);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].target.id, "bot-user");
  assert.deepEqual(edits[0].profile, ACCESS_PROFILES.CATEGORY_SOURCE);
  assert.match(edits[0].options.reason, /Ticket Source/i);
});

test("Thread Parent sources receive thread-specific access without destructive lifecycle permissions", async () => {
  const fixture = createGuild(fullPermissionSet());
  const edits = [];
  const parent = {
    id: "thread-parent-1",
    permissionOverwrites: {
      async edit(target, profile) {
        edits.push({ target, profile });
        return parent;
      },
    },
  };

  const result = await prepareTicketSourceAccess(
    fixture.guild,
    [parent],
    "thread_parent"
  );

  assert.equal(result.ok, true);
  assert.deepEqual(edits[0].profile, ACCESS_PROFILES.THREAD_PARENT);
  assert.equal(edits[0].profile.SendMessagesInThreads, true);
  assert.equal("ManageChannels" in edits[0].profile, false);
  assert.equal("ManageRoles" in edits[0].profile, false);
});

test("Human Support categories are prepared automatically after the upfront permission gate", async () => {
  const fixture = createGuild(fullPermissionSet());
  let edit = null;
  const category = {
    id: "human-category",
    permissionOverwrites: {
      async edit(target, profile, options) {
        edit = { target, profile, options };
        return category;
      },
    },
  };

  const result = await prepareHumanSupportCategoryAccess(fixture.guild, category);

  assert.equal(result.ok, true);
  assert.equal(edit.target.id, "bot-user");
  assert.deepEqual(edit.profile, ACCESS_PROFILES.HUMAN_SUPPORT_CATEGORY);
  assert.match(edit.options.reason, /Human Support/i);
});
