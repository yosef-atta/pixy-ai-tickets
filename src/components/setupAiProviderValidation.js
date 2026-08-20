const { PermissionFlagsBits } = require("discord.js");

const setup = require("../slash/setup");
const { getGuildAiConfig } = require("../config/ai");
const {
  saveGuildAiCredential,
  saveGuildAiModel,
} = require("../config/guildAiConfig");
const {
  validateProviderCredential,
  validateProviderModel,
} = require("../ai/providers/providerRegistry");
const {
  SETUP_VALIDATION_FAILED,
  SETUP_VALIDATION_SUCCESS,
  buildProviderHealthIssue,
  cleanText,
  getLatestProviderHealthEvent,
  recordProviderSetupValidation,
} = require("../ai/providerValidationHealth");

const EPHEMERAL = 64;
const { PREFIX } = setup;

async function assertOwner(interaction, userId) {
  const allowed =
    interaction.guild &&
    interaction.user.id === userId &&
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  if (allowed) return true;

  await interaction.reply({
    content: "Only the administrator who opened `/pixy-setup` can use this control.",
    flags: EPHEMERAL,
  });
  return false;
}

async function deferUpdate(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate();
  }
}

async function editPanel(interaction, payload) {
  const next = {
    ...payload,
    allowedMentions: payload.allowedMentions || { parse: [] },
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(next);
  } else {
    await interaction.update(next);
  }
}

function providerErrorMessage(error, providerName) {
  const detail = cleanText(error?.message || error || "Provider live validation failed.", 850);
  return `Live validation failed for **${providerName}**: ${detail} The credential/model was not saved.`;
}

async function recordValidationSafe(payload) {
  try {
    return await recordProviderSetupValidation(payload);
  } catch (error) {
    console.error("Failed to record AI provider setup validation:", error);
    return null;
  }
}

function formatValidationField(event) {
  if (!event) return "Not tested yet";

  const when = event.createdAt ? new Date(event.createdAt) : null;
  const unix = when && !Number.isNaN(when.getTime())
    ? Math.floor(when.getTime() / 1000)
    : null;
  const suffix = unix ? ` • <t:${unix}:R>` : "";

  if ([SETUP_VALIDATION_SUCCESS, "success"].includes(event.status)) {
    return `✅ Passed${event.model ? ` on \`${event.model}\`` : ""}${suffix}`;
  }

  if (event.status === "rate_limited") {
    return `⚠️ Rate limited${suffix}`;
  }

  if (event.status === SETUP_VALIDATION_FAILED) {
    return `❌ Setup live test failed${suffix}\n${cleanText(event.error || "Provider request failed.", 500)}`;
  }

  if (event.status === "provider_error") {
    return `❌ Latest ticket request failed${suffix}\n${cleanText(event.error || "Provider request failed.", 500)}`;
  }

  if (event.status === "empty_response") {
    return `⚠️ Latest request returned no usable text${suffix}`;
  }

  return `Last status: \`${event.status}\`${suffix}`;
}

const originalLoadSetupOverview = setup.loadSetupOverview.bind(setup);
setup.loadSetupOverview = async function loadSetupOverviewWithProviderHealth(guild) {
  const overview = await originalLoadSetupOverview(guild);
  const latest = await getLatestProviderHealthEvent(guild.id, overview.ai.provider)
    .catch(() => null);
  const issue = buildProviderHealthIssue(latest, overview.ai.providerDefinition);

  if (issue && !overview.health.includes(issue)) {
    overview.health.push(issue);
  }

  return {
    ...overview,
    providerHealthEvent: latest,
  };
};

const originalRenderAiProvider = setup.renderAiProvider.bind(setup);
setup.renderAiProvider = async function renderAiProviderWithLiveHealth(
  guildId,
  userId,
  mode,
  notice = null
) {
  const payload = await originalRenderAiProvider(guildId, userId, mode, notice);
  const ai = await getGuildAiConfig(guildId);
  const latest = await getLatestProviderHealthEvent(guildId, ai.provider)
    .catch(() => null);

  if (payload.embeds?.[0]) {
    payload.embeds[0].addFields({
      name: "Live Validation",
      value: formatValidationField(latest),
      inline: false,
    });
  }

  return payload;
};

const credentialModalHandler = setup.modalHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.AI_CREDENTIAL_MODAL
);
if (!credentialModalHandler) {
  throw new Error("Pixy AI credential modal handler is missing.");
}

credentialModalHandler.execute = async function executeCredentialWithLiveValidation(interaction) {
  const { mode, userId } = setup.parseScoped(
    interaction.customId,
    PREFIX.AI_CREDENTIAL_MODAL
  );
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  const credential = cleanText(
    interaction.fields.getTextInputValue("provider_credential"),
    10000
  );
  const ai = await getGuildAiConfig(interaction.guild.id);
  let validation = null;

  try {
    validation = await validateProviderCredential(ai.provider, credential, {
      modelId: ai.model,
    });

    const currentOverride = ai.modelSource === "guild"
      ? ai.aiConfigRecord?.model || ai.record?.model || null
      : null;

    await saveGuildAiCredential(interaction.guild.id, credential, {
      provider: ai.provider,
      model: currentOverride,
    });

    await recordValidationSafe({
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      provider: ai.provider,
      model: validation.probe?.model || ai.model,
      ok: true,
      probe: validation.probe,
    });

    await editPanel(
      interaction,
      await setup.renderAiProvider(
        interaction.guild.id,
        userId,
        mode,
        `${ai.providerDefinition.displayName} live test passed on \`${validation.probe?.model || ai.model}\`. Credential validated, encrypted, and saved.`
      )
    );
  } catch (error) {
    if (!validation) {
      await recordValidationSafe({
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        provider: ai.provider,
        model: ai.model,
        ok: false,
        error,
      });
    }

    await editPanel(
      interaction,
      await setup.renderAiProvider(
        interaction.guild.id,
        userId,
        mode,
        providerErrorMessage(error, ai.providerDefinition.displayName)
      )
    );
  }
};

const modelModalHandler = setup.modalHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.AI_MODEL_MODAL
);
if (!modelModalHandler) {
  throw new Error("Pixy AI model modal handler is missing.");
}

modelModalHandler.execute = async function executeModelWithLiveValidation(interaction) {
  const { mode, userId } = setup.parseScoped(
    interaction.customId,
    PREFIX.AI_MODEL_MODAL
  );
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  const modelId = cleanText(
    interaction.fields.getTextInputValue("provider_model"),
    191
  );
  let ai = null;
  let validation = null;

  try {
    ai = await getGuildAiConfig(interaction.guild.id, { requireCredential: true });
    validation = await validateProviderModel(ai.provider, {
      credential: ai.credential,
      modelId,
    });

    await saveGuildAiModel(interaction.guild.id, modelId);
    await recordValidationSafe({
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      provider: ai.provider,
      model: modelId,
      ok: true,
      probe: validation.probe,
    });

    await editPanel(
      interaction,
      await setup.renderAiProvider(
        interaction.guild.id,
        userId,
        mode,
        `Model live test passed and was saved: \`${modelId}\`.`
      )
    );
  } catch (error) {
    if (ai && !validation) {
      await recordValidationSafe({
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        provider: ai.provider,
        model: modelId || ai.model,
        ok: false,
        error,
      });
    }

    const providerName = ai?.providerDefinition?.displayName || "AI provider";
    await editPanel(
      interaction,
      await setup.renderAiProvider(
        interaction.guild.id,
        userId,
        mode,
        providerErrorMessage(error, providerName)
      )
    );
  }
};

module.exports = {
  formatValidationField,
  providerErrorMessage,
  recordValidationSafe,
};
