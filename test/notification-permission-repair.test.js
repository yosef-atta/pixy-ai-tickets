const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ChannelType,
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
} = require("discord.js");

const {
  getOrCreateEscalationNotificationChannel,
} = require("../src/utils/tickets/escalationNotifications");
const {
  formatNotificationSetupFailure,
} = require("../src/slash/setup");

function permissions(...values) {
  return new PermissionsBitField(values);
}

function createNotificationFixture(initialPermissions) {
  const botMember = {
    id: "bot-1",
    permissions: permissions(PermissionFlagsBits.ManageChannels),
  };
  let channelPermissions = initialPermissions;
  let roleRefreshes = 0;
  let onRoleRefresh = null;
  const updates = [];
  const cache = new Collection();

  const guild = {
    id: "guild-1",
    members: {
      me: botMember,
      async fetchMe() {
        return botMember;
      },
    },
    roles: {
      async fetch() {
        roleRefreshes += 1;
        if (onRoleRefresh) onRoleRefresh(roleRefreshes);
        return new Collection();
      },
    },
    channels: {
      cache,
      async fetch(id) {
        if (id) return cache.get(id) || null;
        return cache;
      },
    },
  };

  const channel = {
    id: "notification-1",
    name: "pixy-notifications",
    type: ChannelType.GuildText,
    parentId: "category-1",
    guild,
    permissionsFor() {
      return channelPermissions;
    },
  };
  cache.set(channel.id, channel);

  const client = {
    guildConfig: {
      async update(args) {
        updates.push(args);
        return { guildId: guild.id, ...args.data };
      },
    },
  };

  return {
    guild,
    channel,
    client,
    updates,
    get roleRefreshes() {
      return roleRefreshes;
    },
    setPermissions(next) {
      channelPermissions = next;
    },
    setRoleRefreshHandler(handler) {
      onRoleRefresh = handler;
    },
  };
}

test("notification setup reports the exact missing View Channel permission", async () => {
  const fixture = createNotificationFixture(
    permissions(PermissionFlagsBits.SendMessages)
  );

  const result = await getOrCreateEscalationNotificationChannel({
    guild: fixture.guild,
    categoryId: "category-1",
    existingChannelId: fixture.channel.id,
    client: fixture.client,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "missing_notification_channel_permissions");
  assert.deepEqual(result.missingPermissionLabels, ["View Channel"]);
  assert.equal(fixture.updates.length, 0);
  assert.ok(fixture.roleRefreshes >= 1);
});

test("Repair succeeds after permissions are granted following an earlier failure", async () => {
  const current = permissions(PermissionFlagsBits.SendMessages);
  const fixture = createNotificationFixture(current);

  const first = await getOrCreateEscalationNotificationChannel({
    guild: fixture.guild,
    categoryId: "category-1",
    existingChannelId: fixture.channel.id,
    client: fixture.client,
  });
  assert.equal(first.ok, false);
  assert.deepEqual(first.missingPermissionLabels, ["View Channel"]);

  fixture.setRoleRefreshHandler(() => {
    current.add(PermissionFlagsBits.ViewChannel);
  });

  const repaired = await getOrCreateEscalationNotificationChannel({
    guild: fixture.guild,
    categoryId: "category-1",
    existingChannelId: fixture.channel.id,
    client: fixture.client,
  });

  assert.equal(repaired.ok, true);
  assert.equal(repaired.channel.id, fixture.channel.id);
  assert.equal(fixture.updates.length, 1);
  assert.equal(
    fixture.updates[0].data.escalationNotificationChannelId,
    fixture.channel.id
  );
});

test("Human Support setup turns permission failures into actionable UI copy", () => {
  const message = formatNotificationSetupFailure({
    ok: false,
    code: "missing_notification_channel_permissions",
    missingPermissionLabels: ["View Channel", "Send Messages"],
  });

  assert.match(message, /View Channel/);
  assert.match(message, /Send Messages/);
  assert.match(message, /Create\/Repair Notification Channel/);
  assert.doesNotMatch(message, /missing_notification_channel_permissions/);
});