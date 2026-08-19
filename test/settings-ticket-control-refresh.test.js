const assert = require("node:assert/strict");
const test = require("node:test");

const {
  refreshTicketControlsAfterSettingsChange,
  shouldRefreshTicketControlsAfterSettingsChange,
} = require("../src/events/interactionCreate");

function interactionFor(field) {
  return {
    customId: "settings_toggle:user-1",
    values: [field],
    guild: { id: "guild-1" },
    client: { user: { id: "pixy" } },
  };
}

test("ticket control settings trigger open-ticket control refresh", () => {
  for (const field of [
    "closeTicketEnabled",
    "renameReviewEnabled",
    "escalationEnabled",
    "agentActionsEnabled",
  ]) {
    assert.equal(
      shouldRefreshTicketControlsAfterSettingsChange(interactionFor(field)),
      true,
      `${field} should refresh open ticket controls`
    );
  }
});

test("settings that do not change ticket control options skip refresh", () => {
  assert.equal(
    shouldRefreshTicketControlsAfterSettingsChange(interactionFor("aiReplyEnabled")),
    false
  );
  assert.equal(
    shouldRefreshTicketControlsAfterSettingsChange({
      ...interactionFor("closeTicketEnabled"),
      customId: "other_control:user-1",
    }),
    false
  );
});

test("settings refresh uses the guild and Discord client after the toggle succeeds", async () => {
  const calls = [];
  const interaction = interactionFor("renameReviewEnabled");

  const result = await refreshTicketControlsAfterSettingsChange(interaction, {
    async refreshControls(guildId, options) {
      calls.push({ guildId, options });
      return {
        ok: true,
        attempted: 2,
        refreshed: 2,
        failed: 0,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].guildId, "guild-1");
  assert.equal(calls[0].options.guild, interaction.guild);
  assert.equal(calls[0].options.discordClient, interaction.client);
});

test("unrelated settings skip refresh entirely", async () => {
  let called = false;
  const result = await refreshTicketControlsAfterSettingsChange(
    interactionFor("aiReplyEnabled"),
    {
      async refreshControls() {
        called = true;
        return { ok: true };
      },
    }
  );

  assert.equal(called, false);
  assert.deepEqual(result, { ok: true, skipped: true });
});