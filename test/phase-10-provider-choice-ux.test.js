const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildInitialProviderChoice,
  getSavedAiProviderRecord,
  orderedProviders,
} = require("../src/slash/setup");

const PROVIDERS = [
  { id: "groq", displayName: "Groq", defaultModel: "groq-default" },
  { id: "google", displayName: "Google Gemini", defaultModel: "gemini-default" },
  { id: "mistral", displayName: "Mistral", defaultModel: "mistral-default" },
];

test("fresh onboarding AI Provider step is neutral and does not preselect Groq", () => {
  const payload = buildInitialProviderChoice("admin-user", "Saved 1 Ticket Source.", PROVIDERS);
  const embed = payload.embeds[0].toJSON();
  const menu = payload.components[0].toJSON().components[0];

  assert.equal(payload.content, "Saved 1 Ticket Source.");
  assert.match(embed.title, /2\/3 AI Provider/);
  assert.match(embed.description, /does \*\*not\*\* preselect or prefer one provider/i);
  assert.match(embed.fields[0].value, /Not selected yet/i);
  assert.equal(menu.placeholder, "Choose an AI provider...");
  assert.deepEqual(menu.options.map((option) => option.value), [
    "google",
    "groq",
    "mistral",
  ]);
  assert.equal(menu.options.some((option) => option.default === true), false);
  assert.equal(payload.components.length, 1);
});

test("provider choices use a stable neutral alphabetical order", () => {
  assert.deepEqual(
    orderedProviders(PROVIDERS).map((provider) => provider.displayName),
    ["Google Gemini", "Groq", "Mistral"]
  );
});

test("saved-provider detection distinguishes fresh onboarding from an explicit choice", async () => {
  const missingClient = {
    guildAiConfig: {
      async findUnique() {
        return null;
      },
    },
  };
  const savedClient = {
    guildAiConfig: {
      async findUnique() {
        return { guildId: "guild-1", provider: "google" };
      },
    },
  };

  assert.equal(await getSavedAiProviderRecord("guild-1", { client: missingClient }), null);
  assert.deepEqual(
    await getSavedAiProviderRecord("guild-1", { client: savedClient }),
    { guildId: "guild-1", provider: "google" }
  );
});
