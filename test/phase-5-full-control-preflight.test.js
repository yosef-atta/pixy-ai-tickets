const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} = require("discord.js");

const {
  preflightFullControlForGuild,
} = require("../src/utils/tickets/humanSupportPermissions");

function permissions(...flags) {
  return new PermissionsBitField(flags);
}

function createGuild() {
  const botMember = {
    id: "bot-1",
    permissions: permissions(
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles
    ),
  };
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
      async fetch() {
        return cache;
      },
    },
  };
}

function category(id, name) {
  return {
    id,
    name,
    type: ChannelType.GuildCategory,
    permissionsFor() {
      return permissions(
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles
      );
    },
  };
}

test("Full Control cannot be enabled without a Human Support destination", async () => {
  const guild = createGuild();
  const ticketCategory = category("ticket-category", "support");
  guild.channels.cache.set(ticketCategory.id, ticketCategory);
  const client = {
    guildConfig: {
      async findUnique() {
        return { escalationCategoryId: null };
      },
    },
  };

  const result = await preflightFullControlForGuild(guild, {
    client,
    sources: [{ type: "category", sourceId: ticketCategory.id }],
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "missing_escalation_category"));
});

test("Full Control guild preflight accepts valid ticket and escalation categories", async () => {
  const guild = createGuild();
  const ticketCategory = category("ticket-category", "support");
  const escalationCategory = category("escalation-category", "human-support");
  guild.channels.cache.set(ticketCategory.id, ticketCategory);
  guild.channels.cache.set(escalationCategory.id, escalationCategory);
  const client = {
    guildConfig: {
      async findUnique() {
        return { escalationCategoryId: escalationCategory.id };
      },
    },
  };

  const result = await preflightFullControlForGuild(guild, {
    client,
    sources: [{ type: "category", sourceId: ticketCategory.id }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});
