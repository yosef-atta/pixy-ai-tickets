const assert = require("node:assert/strict");
const test = require("node:test");
const { ChannelType } = require("discord.js");

const {
  findMatchingSourceForChannel,
  replaceCategoryTicketSources,
} = require("../src/config/ticketSources");
const {
  cleanupDeletedTicketChannel,
  reconcileGuildTicketChannels,
  reconcileTicketChannel,
  resolveTicketChannelEligibility,
  trackTicketChannel,
} = require("../src/tickets/ticketChannelLifecycle");

const GUILD_ID = "123456789012345678";
const CATEGORY_A = "200000000000000001";
const CATEGORY_B = "200000000000000002";
const CATEGORY_OTHER = "200000000000000003";

function source(sourceId) {
  return {
    id: `source-${sourceId}`,
    guildId: GUILD_ID,
    type: "category",
    sourceId,
    enabled: true,
  };
}

function makeGuild(channels = []) {
  const guild = {
    id: GUILD_ID,
    channels: {
      cache: new Map(),
      async fetch() {
        return this.cache;
      },
    },
  };

  for (const channel of channels) {
    channel.guild = guild;
    guild.channels.cache.set(channel.id, channel);
  }
  return guild;
}

function makeChannel(id, parentId) {
  return {
    id,
    parentId,
    type: ChannelType.GuildText,
    guild: null,
  };
}

test("multi-category source matching accepts any configured category", () => {
  const guild = makeGuild();
  const channelA = makeChannel("channel-a", CATEGORY_A);
  const channelB = makeChannel("channel-b", CATEGORY_B);
  const outside = makeChannel("channel-c", CATEGORY_OTHER);
  channelA.guild = guild;
  channelB.guild = guild;
  outside.guild = guild;

  const sources = [source(CATEGORY_A), source(CATEGORY_B)];
  assert.equal(findMatchingSourceForChannel(channelA, sources).sourceId, CATEGORY_A);
  assert.equal(findMatchingSourceForChannel(channelB, sources).sourceId, CATEGORY_B);
  assert.equal(findMatchingSourceForChannel(outside, sources), null);
});

test("ticket eligibility respects multi-category sources and per-channel exclusions", async () => {
  const guild = makeGuild();
  const channel = makeChannel("channel-b", CATEGORY_B);
  channel.guild = guild;

  const client = {
    guildConfig: {
      async findUnique() {
        return { guildId: GUILD_ID, enabled: true, ticketCategoryId: CATEGORY_A };
      },
    },
    ticketSource: {
      async findMany() {
        return [source(CATEGORY_A), source(CATEGORY_B)];
      },
    },
    guildIgnoredChannel: {
      async findUnique() {
        return null;
      },
    },
  };

  const eligible = await resolveTicketChannelEligibility(channel, { client });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.source.sourceId, CATEGORY_B);

  client.guildIgnoredChannel.findUnique = async () => ({ channelId: channel.id });
  const ignored = await resolveTicketChannelEligibility(channel, { client });
  assert.equal(ignored.eligible, false);
  assert.equal(ignored.code, "ignored_channel");
});

test("a message or event can self-heal an untracked eligible ticket", async () => {
  const guild = makeGuild();
  const channel = makeChannel("channel-new", CATEGORY_A);
  channel.guild = guild;
  let createdData = null;

  const client = {
    guildConfig: {
      async findUnique() {
        return { guildId: GUILD_ID, enabled: true };
      },
    },
    ticketSource: {
      async findMany() {
        return [source(CATEGORY_A), source(CATEGORY_B)];
      },
    },
    guildIgnoredChannel: {
      async findUnique() {
        return null;
      },
    },
    ticketChannel: {
      async findUnique() {
        return null;
      },
      async create({ data }) {
        createdData = data;
        return { id: "ticket-1", ...data, escalated: false };
      },
    },
  };

  const result = await trackTicketChannel(channel, {
    client,
    ensureControls: false,
  });

  assert.equal(result.tracked, true);
  assert.equal(result.created, true);
  assert.equal(result.source.sourceId, CATEGORY_A);
  assert.deepEqual(createdData, {
    guildId: GUILD_ID,
    channelId: channel.id,
    closed: false,
    status: "open",
    aiEnabled: true,
  });
});

test("moving a tracked ticket outside every configured source removes tracking", async () => {
  const guild = makeGuild();
  const channel = makeChannel("channel-moved", CATEGORY_OTHER);
  channel.guild = guild;
  let deletedWhere = null;

  const client = {
    guildConfig: {
      async findUnique() {
        return { guildId: GUILD_ID, enabled: true };
      },
    },
    ticketSource: {
      async findMany() {
        return [source(CATEGORY_A), source(CATEGORY_B)];
      },
    },
    guildIgnoredChannel: {
      async findUnique() {
        throw new Error("ignored lookup should not run outside ticket sources");
      },
    },
    ticketChannel: {
      async deleteMany({ where }) {
        deletedWhere = where;
        return { count: 1 };
      },
    },
  };

  const result = await reconcileTicketChannel(channel, { client });
  assert.equal(result.tracked, false);
  assert.equal(result.code, "outside_ticket_sources");
  assert.equal(result.removed, 1);
  assert.deepEqual(deletedWhere, {
    guildId: GUILD_ID,
    channelId: channel.id,
  });
});

test("guild reconciliation imports missed tickets, skips exclusions, and removes stale tracking", async () => {
  const channelA = makeChannel("channel-a", CATEGORY_A);
  const channelB = makeChannel("channel-b", CATEGORY_B);
  const ignored = makeChannel("channel-ignored", CATEGORY_A);
  const outside = makeChannel("channel-outside", CATEGORY_OTHER);
  const guild = makeGuild([channelA, channelB, ignored, outside]);
  const created = [];
  let cleanupWhere = null;

  const client = {
    guildConfig: {
      async findUnique() {
        return { guildId: GUILD_ID, enabled: true };
      },
    },
    ticketSource: {
      async findMany() {
        return [source(CATEGORY_A), source(CATEGORY_B)];
      },
    },
    guildIgnoredChannel: {
      async findMany() {
        return [{ channelId: ignored.id }];
      },
    },
    ticketChannel: {
      async findMany() {
        return [
          { guildId: GUILD_ID, channelId: channelA.id, closed: false, aiEnabled: true },
          { guildId: GUILD_ID, channelId: "stale-channel", closed: false, aiEnabled: true },
        ];
      },
      async deleteMany({ where }) {
        cleanupWhere = where;
        return { count: 1 };
      },
      async create({ data }) {
        created.push(data);
        return { id: `ticket-${data.channelId}`, ...data, escalated: false };
      },
    },
  };

  const result = await reconcileGuildTicketChannels(guild, {
    client,
    ensureControls: false,
  });

  assert.equal(result.eligible, 2);
  assert.equal(result.created, 1);
  assert.equal(result.removed, 1);
  assert.equal(created[0].channelId, channelB.id);
  assert.deepEqual(cleanupWhere, {
    guildId: GUILD_ID,
    channelId: { in: ["stale-channel"] },
  });
});

test("deleting a Discord ticket channel clears tracking and its stale exclusion", async () => {
  const channel = makeChannel("channel-deleted", CATEGORY_A);
  const guild = makeGuild([channel]);
  const calls = [];

  const client = {
    ticketChannel: {
      async deleteMany(args) {
        calls.push(["ticket", args.where]);
        return { count: 1 };
      },
    },
    guildIgnoredChannel: {
      async deleteMany(args) {
        calls.push(["ignored", args.where]);
        return { count: 1 };
      },
    },
    async $transaction(operations) {
      return Promise.all(operations);
    },
  };

  const result = await cleanupDeletedTicketChannel(channel, { client });
  assert.deepEqual(result, {
    ticketDeleted: 1,
    ignoredDeleted: 1,
    blacklistDeleted: 1,
  });
  assert.deepEqual(calls, [
    ["ticket", { guildId: GUILD_ID, channelId: channel.id }],
    ["ignored", { guildId: GUILD_ID, channelId: channel.id }],
  ]);
});

test("legacy single-category setup replacement keeps the new source table consistent", async () => {
  const deleted = [];
  const upserts = [];
  const client = {
    ticketSource: {
      async deleteMany(args) {
        deleted.push(args.where);
        return { count: 1 };
      },
      async upsert(args) {
        upserts.push(args);
        return { id: "saved-source", ...args.create };
      },
    },
    async $transaction(callback) {
      return callback(this);
    },
  };

  const saved = await replaceCategoryTicketSources(GUILD_ID, [CATEGORY_B], { client });
  assert.equal(saved.length, 1);
  assert.deepEqual(deleted[0], {
    guildId: GUILD_ID,
    type: "category",
    sourceId: { notIn: [CATEGORY_B] },
  });
  assert.equal(upserts[0].create.sourceId, CATEGORY_B);
});
