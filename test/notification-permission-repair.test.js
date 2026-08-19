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
  let memberFetches = 0;
  let channelFetches = 0;
  let lastMemberFetchOptions = null;
  let onRoleRefresh = null;
  const updates = [];
  const cache = new Collection();

  const guild = {
    id: "guild-1",
    members: {
      me: botMember,
      async fetchMe(options) {
        memberFetches += 1;
        lastMemberFetchOptions = options || null;
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
    async fetch(force) {
      channelFetches += 1;
      assert.equal(force, true);
      return this;
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
    botMember,
    client,
    updates,
    get roleRefreshes() {
      return roleRefreshes;
    },
    get memberFetches() {
      return memberFetches;
    },
    get channelFetches() {
      return channelFetches;
    },
    get lastMemberFetchOptions() {
      return lastMemberFetchOptions;
    },
    setPermissions(next) {
      channelPermissions = next;
    },
    setRoleRefreshHandler(handler) {
      onRoleRefresh = handler;
    },
  };
}

test("notification permission diagnostics report the exact missing View Channel permission", async () => {
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
  assert.deepEqual(result.missingBasePermissionLabels, ["View Channel"]);
  assert.deepEqual(result.blockedByOverwritePermissionLabels, []);
  assert.equal(fixture.updates.length, 0);
  assert.ok(fixture.roleRefreshes >= 1);
  assert.ok(fixture.memberFetches >= 1);
  assert.equal(fixture.lastMemberFetchOptions?.force, true);
  assert.ok(fixture.channelFetches >= 1);
});

test("notification diagnostics read a freshly fetched bot member instead of stale cached permissions", async () => {
  const staleMember = {
    id: "bot-1",
    permissions: permissions(PermissionFlagsBits.ManageChannels),
    notificationPermissions: permissions(),
  };
  const freshMember = {
    id: "bot-1",
    permissions: permissions(
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ViewChannel
    ),
    notificationPermissions: permissions(PermissionFlagsBits.ViewChannel),
  };
  const cache = new Collection();
  let fetchOptions = null;

  const guild = {
    id: "guild-fresh",
    members: {
      me: staleMember,
      async fetchMe(options) {
        fetchOptions = options;
        return freshMember;
      },
    },
    roles: {
      async fetch() {
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
    id: "notification-fresh",
    name: "pixy-notifications",
    type: ChannelType.GuildText,
    parentId: "category-fresh",
    guild,
    permissionsFor(member) {
      return member.notificationPermissions;
    },
    async fetch() {
      return this;
    },
  };
  cache.set(channel.id, channel);

  const result = await getOrCreateEscalationNotificationChannel({
    guild,
    categoryId: "category-fresh",
    existingChannelId: channel.id,
    client: {
      guildConfig: {
        async update() {
          throw new Error("should not save until Send Messages is granted");
        },
      },
    },
  });

  assert.equal(fetchOptions?.force, true);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingPermissionLabels, ["Send Messages"]);
});

test("notification setup succeeds after effective permissions are repaired", async () => {
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
    fixture.botMember.permissions.add(PermissionFlagsBits.ViewChannel);
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

test("notification diagnostics distinguish missing base access from a blocking channel overwrite", async () => {
  const fixture = createNotificationFixture(
    permissions(PermissionFlagsBits.SendMessages)
  );
  fixture.botMember.permissions.add(PermissionFlagsBits.ViewChannel);

  const result = await getOrCreateEscalationNotificationChannel({
    guild: fixture.guild,
    categoryId: "category-1",
    existingChannelId: fixture.channel.id,
    client: fixture.client,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingPermissionLabels, ["View Channel"]);
  assert.deepEqual(result.missingBasePermissionLabels, []);
  assert.deepEqual(result.blockedByOverwritePermissionLabels, ["View Channel"]);
});
