const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PermissionFlagsBits,
  PermissionsBitField,
} = require("discord.js");

const {
  sendEscalationNotification,
} = require("../src/utils/tickets/escalationNotifications");
const {
  ESCALATION_MENTION_TARGETS,
  getNextEscalationMentionTarget,
  normalizeEscalationMentionTarget,
  setEscalationMentionTarget,
} = require("../src/settings/ticketBehaviorService");

function permissions(...values) {
  return new PermissionsBitField(values);
}

function createGuild(botPermissions) {
  const botMember = { id: "bot-1", permissions: botPermissions };
  const cache = new Map();
  return {
    id: "guild-test-1",
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

test("normalization and cycling of escalation mention targets", () => {
  assert.equal(normalizeEscalationMentionTarget("outside"), "outside");
  assert.equal(normalizeEscalationMentionTarget("inside"), "inside");
  assert.equal(normalizeEscalationMentionTarget("both"), "both");
  assert.equal(normalizeEscalationMentionTarget("invalid"), "outside");
  assert.equal(normalizeEscalationMentionTarget(null), "outside");

  assert.equal(getNextEscalationMentionTarget("outside"), "inside");
  assert.equal(getNextEscalationMentionTarget("inside"), "both");
  assert.equal(getNextEscalationMentionTarget("both"), "outside");
});

test("setEscalationMentionTarget updates GuildSetting", async () => {
  let updatedData = null;
  const mockClient = {
    guildSetting: {
      async update({ where, data }) {
        updatedData = { where, data };
        return { guildId: where.guildId, ...data };
      },
    },
  };

  const result = await setEscalationMentionTarget("guild-123", "inside", {
    client: mockClient,
    getSetting: async () => ({ guildId: "guild-123" }),
  });

  assert.equal(result.escalationMentionTarget, "inside");
  assert.equal(updatedData.where.guildId, "guild-123");
  assert.equal(updatedData.data.escalationMentionTarget, "inside");
});

test("sendEscalationNotification does not ping role when mentionRole is false (inside only mode)", async () => {
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
      return { id: "message-mention-false" };
    },
  };
  const ticketChannel = {
    id: "ticket-1",
    name: "ticket-test",
    messages: { async fetch() { return new Map(); } },
  };
  const role = { id: "role-support", name: "Support Team", mentionable: true };

  const result = await sendEscalationNotification({
    notificationChannel,
    ticketChannel,
    role,
    reason: "Needs human review",
    mentionRole: false,
  });

  assert.equal(result.pixyRolePinged, false);
  assert.deepEqual(sentPayload.allowedMentions.roles, []);
  assert.match(sentPayload.content, /configured to be pinged inside the ticket channel/i);
});

test("sendEscalationNotification pings role when mentionRole is true (outside or both mode)", async () => {
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
      return { id: "message-mention-true" };
    },
  };
  const ticketChannel = {
    id: "ticket-1",
    name: "ticket-test",
    messages: { async fetch() { return new Map(); } },
  };
  const role = { id: "role-support", name: "Support Team", mentionable: true };

  const result = await sendEscalationNotification({
    notificationChannel,
    ticketChannel,
    role,
    reason: "Billing issue",
    mentionRole: true,
  });

  assert.equal(result.pixyRolePinged, true);
  assert.deepEqual(sentPayload.allowedMentions.roles, [role.id]);
});

test("sendTicketEscalationReply mentions support role in ticket when mentionRoleInTicket is true", async () => {
  const guild = createGuild(permissions(
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages
  ));
  let sentPayload = null;
  const channel = {
    id: "channel-ticket-1",
    guild,
    permissionsFor() {
      return permissions(
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages
      );
    },
    async send(payload) {
      sentPayload = payload;
      return { id: "reply-1" };
    },
  };
  const role = { id: "role-support-99", name: "Support Team", mentionable: true };

  const { sendTicketEscalationReply } = require("../src/utils/tickets/actions/ticketActionExecutor");
  const success = await sendTicketEscalationReply({
    message: { channel },
    roleName: "Support Team",
    text: "Escalated for review.",
    role,
    mentionRoleInTicket: true,
  });

  assert.equal(success, true);
  assert.match(sentPayload.content, /<@&role-support-99>/);
  assert.deepEqual(sentPayload.allowedMentions.roles, [role.id]);
});

test("sendTicketEscalationReply does not mention support role in ticket when mentionRoleInTicket is false", async () => {
  const guild = createGuild(permissions(
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages
  ));
  let sentPayload = null;
  const channel = {
    id: "channel-ticket-1",
    guild,
    permissionsFor() {
      return permissions(
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages
      );
    },
    async send(payload) {
      sentPayload = payload;
      return { id: "reply-2" };
    },
  };
  const role = { id: "role-support-99", name: "Support Team", mentionable: true };

  const { sendTicketEscalationReply } = require("../src/utils/tickets/actions/ticketActionExecutor");
  const success = await sendTicketEscalationReply({
    message: { channel },
    roleName: "Support Team",
    text: "Escalated for review.",
    role,
    mentionRoleInTicket: false,
  });

  assert.equal(success, true);
  assert.doesNotMatch(sentPayload.content, /<@&role-support-99>/);
  assert.deepEqual(sentPayload.allowedMentions.roles, []);
});
