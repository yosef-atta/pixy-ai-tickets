const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} = require("discord.js");

const {
  sendEscalationNotification,
} = require("../src/utils/tickets/escalationNotifications");
const {
  getSetupPermissionIssues,
  preflightFullControlForTicket,
} = require("../src/utils/tickets/humanSupportPermissions");
const {
  applyFullControlEscalation,
  snapshotRoleAccessOverwrite,
} = require("../src/utils/tickets/actions/ticketActionExecutor");
const {
  getHumanSupportAvailability,
} = require("../src/features/ticketActionAvailability");

function permissions(...values) {
  return new PermissionsBitField(values);
}

function createGuild(botPermissions) {
  const botMember = { id: "bot-1", permissions: botPermissions };
  const cache = new Map();
  return {
    id: "guild-1",
    members: {
      me: botMember,
      async fetchMe() {
        return botMember;
      },
    },
    channels: {
      cache,
      async fetch(id) {
        if (id) return cache.get(id) || null;
        return cache;
      },
    },
    roles: {
      cache: new Map(),
      async fetch() {
        return this.cache;
      },
    },
  };
}

test("non-mentionable support roles do not block escalation notifications", async () => {
  const guild = createGuild(permissions(
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages
  ));
  let sentPayload = null;
  const notificationChannel = {
    id: "notification-1",
    guild,
    permissionsFor() {
      return permissions(
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages
      );
    },
    async send(payload) {
      sentPayload = payload;
      return { id: "message-1" };
    },
  };
  const ticketChannel = {
    id: "ticket-1",
    name: "ticket-one",
    messages: {
      async fetch() {
        return new Map();
      },
    },
  };
  const role = {
    id: "role-1",
    name: "Support",
    mentionable: false,
  };

  const result = await sendEscalationNotification({
    notificationChannel,
    ticketChannel,
    role,
    reason: "Needs human review",
  });

  assert.equal(result.id, "message-1");
  assert.equal(result.pixyRolePinged, false);
  assert.deepEqual(sentPayload.allowedMentions.roles, []);
  assert.match(sentPayload.content, /handoff still completed/i);
});

test("mentionable support roles are pinged when Discord allows it", async () => {
  const guild = createGuild(permissions(
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages
  ));
  let sentPayload = null;
  const notificationChannel = {
    id: "notification-1",
    guild,
    permissionsFor() {
      return permissions(
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages
      );
    },
    async send(payload) {
      sentPayload = payload;
      return { id: "message-2" };
    },
  };
  const ticketChannel = {
    id: "ticket-1",
    name: "ticket-one",
    messages: { async fetch() { return new Map(); } },
  };
  const role = { id: "role-2", name: "Billing", mentionable: true };

  const result = await sendEscalationNotification({
    notificationChannel,
    ticketChannel,
    role,
    reason: "Billing issue",
  });

  assert.equal(result.pixyRolePinged, true);
  assert.deepEqual(sentPayload.allowedMentions.roles, [role.id]);
});

test("Full Ticket Control preflight requires Manage Channels and Manage Roles", async () => {
  const guild = createGuild(permissions(
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageChannels
  ));
  const ticketPermissions = permissions(
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageChannels
  );
  const ticketChannel = {
    type: ChannelType.GuildText,
    guild,
    manageable: true,
    permissionsFor() {
      return ticketPermissions;
    },
  };
  const category = {
    permissionsFor() {
      return permissions(
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageChannels
      );
    },
  };

  const failed = await preflightFullControlForTicket({
    guild,
    ticketChannel,
    destinationCategory: category,
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.issues.some((issue) =>
    issue.labels.includes("Manage Roles / Permissions")
  ));

  guild.members.me.permissions.add(PermissionFlagsBits.ManageRoles);
  ticketPermissions.add(PermissionFlagsBits.ManageRoles);
  const passed = await preflightFullControlForTicket({
    guild,
    ticketChannel,
    destinationCategory: category,
  });
  assert.equal(passed.ok, true);
});

test("Smart Overlay health does not demand destructive permissions", async () => {
  const guild = createGuild(permissions(
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory
  ));
  const category = {
    id: "category-1",
    name: "support",
    type: ChannelType.GuildCategory,
    permissionsFor() {
      return permissions(
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      );
    },
  };
  guild.channels.cache.set(category.id, category);
  const sources = [{ type: "category", sourceId: category.id }];

  const overlayIssues = await getSetupPermissionIssues({
    guild,
    sources,
    config: null,
    settings: {
      escalationEnabled: true,
      closeTicketEnabled: false,
      renameReviewEnabled: false,
    },
  });
  assert.deepEqual(overlayIssues, []);

  const fullIssues = await getSetupPermissionIssues({
    guild,
    sources,
    config: null,
    settings: {
      escalationEnabled: true,
      closeTicketEnabled: true,
      renameReviewEnabled: true,
    },
  });
  assert.ok(fullIssues.some((issue) => /Manage Channels/i.test(issue)));
  assert.ok(fullIssues.some((issue) => /Manage Roles/i.test(issue)));
});

test("rollback snapshots preserve existing role access instead of deleting it", () => {
  const overwrite = {
    allow: permissions(PermissionFlagsBits.ViewChannel),
    deny: permissions(PermissionFlagsBits.SendMessages),
  };

  assert.deepEqual(snapshotRoleAccessOverwrite(overwrite), {
    ViewChannel: true,
    SendMessages: false,
    ReadMessageHistory: null,
  });
});

test("partial Full Control mutations carry rollback state on failure", async () => {
  const role = { id: "role-1" };
  const channel = {
    parentId: "old-category",
    name: "old-name",
    permissionOverwrites: {
      cache: new Map(),
      async edit() {
        return true;
      },
    },
    async setParent() {
      const error = new Error("move failed");
      error.code = "move_failed";
      throw error;
    },
    async setName() {
      throw new Error("should not reach rename");
    },
  };

  await assert.rejects(
    () => applyFullControlEscalation({
      message: { channel },
      role,
      categoryId: "new-category",
      name: "new-name",
      auditReason: "test",
    }),
    (error) => {
      assert.equal(error.code, "move_failed");
      assert.equal(error.pixyMutationState.originalParentId, "old-category");
      assert.equal(error.pixyMutationState.roleOverwriteCreated, true);
      return true;
    }
  );
});

test("human support availability rejects deleted categories and missing roles cleanly", async () => {
  const guild = createGuild(permissions());
  const client = {
    guildConfig: {
      async findUnique() {
        return { escalationCategoryId: "category-1" };
      },
    },
    adminRoute: {
      async findMany() {
        return [{ roleId: "missing-role" }];
      },
    },
  };

  const missingCategory = await getHumanSupportAvailability(guild, { client });
  assert.equal(missingCategory.available, false);
  assert.equal(missingCategory.code, "invalid_escalation_category");

  guild.channels.cache.set("category-1", {
    id: "category-1",
    type: ChannelType.GuildCategory,
  });
  const missingRole = await getHumanSupportAvailability(guild, { client });
  assert.equal(missingRole.available, false);
  assert.equal(missingRole.code, "no_support_routes");
});
