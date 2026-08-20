const assert = require("node:assert/strict");
const test = require("node:test");

const {
  toggleBehaviorField,
} = require("../src/settings/ticketBehaviorService");
const {
  addKnowledgeQna,
  getKnowledgeOverview,
} = require("../src/settings/knowledgeService");
const {
  DISABLED_MESSAGES,
} = require("../src/features/ticketActionAvailability");
const {
  isSettingsComponent,
  stopUnavailableSettingsInteraction,
} = require("../src/events/interactionCreate");

function missingSetupKnowledgeClient() {
  let creates = 0;
  return {
    guildConfig: {
      async findUnique() {
        return null;
      },
    },
    learnedAnswer: {
      async count() {
        return 0;
      },
      async findMany() {
        return [];
      },
      async create() {
        creates += 1;
        throw new Error("knowledge must not be created without setup");
      },
    },
    getCreates() {
      return creates;
    },
  };
}

test("knowledge summary is side-effect free after Pixy operational data was cleared", async () => {
  const client = missingSetupKnowledgeClient();
  const overview = await getKnowledgeOverview("guild-cleared", { client });

  assert.equal(overview.configured, false);
  assert.equal(overview.total, 0);
  assert.equal(client.getCreates(), 0);
});

test("knowledge writes cannot recreate GuildConfig after Pixy was cleared", async () => {
  const client = missingSetupKnowledgeClient();
  const result = await addKnowledgeQna(
    "guild-cleared",
    "Can this bypass setup?",
    "No.",
    { client }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "setup_required");
  assert.equal(client.getCreates(), 0);
});

test("behavior changes cannot recreate operational config after Pixy was cleared", async () => {
  let settingReads = 0;
  let settingWrites = 0;
  const client = {
    guildConfig: {
      async findUnique() {
        return null;
      },
    },
    guildSetting: {
      async update() {
        settingWrites += 1;
      },
    },
  };

  const result = await toggleBehaviorField(
    { id: "guild-cleared" },
    "aiReplyEnabled",
    {
      client,
      getSetting: async () => {
        settingReads += 1;
        return { aiReplyEnabled: true };
      },
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "setup_required");
  assert.equal(settingReads, 0);
  assert.equal(settingWrites, 0);
});

test("stale settings components are blocked after clear before their handlers can mutate data", async () => {
  const replies = [];
  const interaction = {
    customId: "settings_safety_add_blocked:user-1",
    guild: { id: "guild-cleared" },
  };
  const client = {
    guildConfig: {
      async findUnique() {
        return null;
      },
    },
  };

  assert.equal(isSettingsComponent(interaction), true);
  const stopped = await stopUnavailableSettingsInteraction(interaction, {
    client,
    async reply(subject, payload) {
      replies.push({ subject, payload });
    },
  });

  assert.equal(stopped, true);
  assert.equal(replies.length, 1);
  assert.match(String(replies[0].payload), /\/pixy-setup/);
});

test("current settings components remain usable while core setup exists", async () => {
  const interaction = {
    customId: "settings_toggle:user-1",
    guild: { id: "guild-live" },
  };
  const stopped = await stopUnavailableSettingsInteraction(interaction, {
    client: {
      guildConfig: {
        async findUnique() {
          return { guildId: "guild-live" };
        },
      },
    },
    async reply() {
      throw new Error("should not reply when setup exists");
    },
  });

  assert.equal(stopped, false);
});

test("interaction error map tells cleared servers to run setup again", () => {
  assert.match(DISABLED_MESSAGES.setup_required, /\/pixy-setup/);
  assert.match(DISABLED_MESSAGES.setup_required, /\/pixy-settings/);
});