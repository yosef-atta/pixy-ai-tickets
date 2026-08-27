const {
  ActionRowBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const setup = require("../slash/setup");
const { getGuildAiConfig } = require("../config/ai");
const {
  saveGuildAiCredential,
} = require("../config/guildAiConfig");
const {
  validateProviderCredential,
} = require("../ai/providers/providerRegistry");
const {
  WORKSPACE_AGENT_PROVIDER_ID,
  getWorkspaceAgentMcpUrl,
  serializeWorkspaceAgentCredential,
} = require("../ai/workspaceAgentBridge");
const {
  providerErrorMessage,
  recordValidationSafe,
} = require("./setupAiProviderValidation");

const EPHEMERAL = 64;
const { PREFIX } = setup;

function isWorkspaceAgent(ai) {
  return ai?.provider === WORKSPACE_AGENT_PROVIDER_ID;
}

function configuredMcpUrl() {
  return getWorkspaceAgentMcpUrl(process.env.PIXY_PUBLIC_BASE_URL);
}

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

function buildWorkspaceAgentModal(userId, mode) {
  const token = new TextInputBuilder()
    .setCustomId("workspace_agent_access_token")
    .setLabel("Workspace Agent access token")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(4000)
    .setPlaceholder("Token with the Workspace Agents scope");

  const trigger = new TextInputBuilder()
    .setCustomId("workspace_agent_trigger_id")
    .setLabel("API Trigger ID")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(191)
    .setPlaceholder("agtch_...");

  return new ModalBuilder()
    .setCustomId(`${PREFIX.AI_CREDENTIAL_MODAL}${mode}:${userId}`)
    .setTitle("Connect ChatGPT Workspace Agent")
    .addComponents(
      new ActionRowBuilder().addComponents(token),
      new ActionRowBuilder().addComponents(trigger)
    );
}

function removeWorkspaceModelControls(payload, ai) {
  if (!isWorkspaceAgent(ai)) return payload;

  const nextRows = [];
  for (const row of payload.components || []) {
    if (!Array.isArray(row.components)) {
      nextRows.push(row);
      continue;
    }

    const kept = [];
    for (const component of row.components) {
      const customId = String(component?.data?.custom_id || "");
      if (
        customId.startsWith(PREFIX.AI_MODEL) ||
        customId.startsWith(PREFIX.AI_MODEL_RESET)
      ) {
        continue;
      }
      if (customId.startsWith(PREFIX.AI_CREDENTIAL)) {
        component.setLabel(
          ai.credentialStatus === "configured"
            ? "Replace Connection"
            : "Connect Workspace Agent"
        );
      }
      kept.push(component);
    }

    if (kept.length) {
      nextRows.push(new ActionRowBuilder().addComponents(...kept));
    }
  }

  payload.components = nextRows;
  return payload;
}

const originalRenderAiProvider = setup.renderAiProvider.bind(setup);
setup.renderAiProvider = async function renderWorkspaceAgentProvider(
  guildId,
  userId,
  mode,
  notice = null
) {
  const payload = await originalRenderAiProvider(guildId, userId, mode, notice);
  const ai = await getGuildAiConfig(guildId);
  if (!isWorkspaceAgent(ai)) return payload;

  const mcpUrl = configuredMcpUrl();
  const embed = payload.embeds?.[0];
  if (embed) {
    embed.setDescription([
      "Pixy will trigger this server's own **ChatGPT Workspace Agent** and receive the final reply back through Pixy's MCP bridge.",
      "The Workspace Agent owns its model and ChatGPT-side tools; Pixy only handles Discord context, secure trigger delivery, and the reply callback.",
    ].join("\n"));

    const fields = (embed.data?.fields || [])
      .filter((field) => field.name !== "Model")
      .map((field) => ({ ...field }));
    fields.push(
      {
        name: "Model",
        value: "Managed inside the ChatGPT Workspace Agent",
        inline: false,
      },
      {
        name: "Pixy MCP endpoint",
        value: mcpUrl
          ? `\`${mcpUrl}\``
          : "Unavailable — the Pixy operator must configure `PIXY_PUBLIC_BASE_URL` first.",
        inline: false,
      },
      {
        name: "Before connecting",
        value: [
          "1. Publish the Workspace Agent with an **API** channel.",
          "2. Add the Pixy MCP endpoint above to the agent and make `send_ticket_reply` available.",
          "3. Tell the agent to call `send_ticket_reply` exactly once with the delivery token from each Pixy trigger.",
          "4. Create a Workspace Agent access token, then connect it here with the `agtch_...` API Trigger ID.",
        ].join("\n"),
        inline: false,
      }
    );
    embed.setFields(fields);
  }

  return removeWorkspaceModelControls(payload, ai);
};

const credentialButtonHandler = setup.buttonHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.AI_CREDENTIAL
);
if (!credentialButtonHandler) {
  throw new Error("Pixy AI credential button handler is missing.");
}
const originalCredentialButtonExecute = credentialButtonHandler.execute.bind(credentialButtonHandler);
credentialButtonHandler.execute = async function executeWorkspaceAgentConnect(interaction) {
  const { mode, userId } = setup.parseScoped(interaction.customId, PREFIX.AI_CREDENTIAL);
  const ai = await getGuildAiConfig(interaction.guild.id);
  if (!isWorkspaceAgent(ai)) return originalCredentialButtonExecute(interaction);
  if (!(await assertOwner(interaction, userId))) return;

  if (!configuredMcpUrl()) {
    await interaction.reply({
      content:
        "The ChatGPT Workspace Agent bridge is not publicly reachable yet. The Pixy operator must set `PIXY_PUBLIC_BASE_URL` to the public HTTPS origin and route `/mcp` to the Pixy MCP port before this provider can be connected.",
      flags: EPHEMERAL,
    });
    return;
  }

  await interaction.showModal(buildWorkspaceAgentModal(userId, mode));
};

const credentialModalHandler = setup.modalHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.AI_CREDENTIAL_MODAL
);
if (!credentialModalHandler) {
  throw new Error("Pixy AI credential modal handler is missing.");
}
const originalCredentialModalExecute = credentialModalHandler.execute.bind(credentialModalHandler);
credentialModalHandler.execute = async function executeWorkspaceAgentConnection(interaction) {
  const ai = await getGuildAiConfig(interaction.guild.id);
  if (!isWorkspaceAgent(ai)) return originalCredentialModalExecute(interaction);

  const { mode, userId } = setup.parseScoped(
    interaction.customId,
    PREFIX.AI_CREDENTIAL_MODAL
  );
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  let credential;
  try {
    credential = serializeWorkspaceAgentCredential({
      accessToken: interaction.fields.getTextInputValue("workspace_agent_access_token"),
      triggerId: interaction.fields.getTextInputValue("workspace_agent_trigger_id"),
    });
  } catch (error) {
    await editPanel(
      interaction,
      await setup.renderAiProvider(
        interaction.guild.id,
        userId,
        mode,
        providerErrorMessage(error, ai.providerDefinition.displayName)
      )
    );
    return;
  }

  await editPanel(
    interaction,
    await setup.renderAiProvider(
      interaction.guild.id,
      userId,
      mode,
      "Running an end-to-end Workspace Agent test. Pixy is waiting for the agent to call `send_ticket_reply` through the MCP bridge..."
    )
  );

  let validation = null;
  try {
    validation = await validateProviderCredential(ai.provider, credential, {
      guildId: interaction.guild.id,
      modelId: ai.model,
    });

    await saveGuildAiCredential(interaction.guild.id, credential, {
      provider: ai.provider,
      model: null,
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
        "Workspace Agent round-trip passed. The access token and API Trigger ID were encrypted and saved as one server-owned connection."
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

for (const prefix of [PREFIX.AI_MODEL, PREFIX.AI_MODEL_RESET]) {
  const handler = setup.buttonHandlers.find((entry) => entry.customIdPrefix === prefix);
  if (!handler) continue;
  const original = handler.execute.bind(handler);
  handler.execute = async function rejectWorkspaceAgentModelControl(interaction) {
    const ai = await getGuildAiConfig(interaction.guild.id);
    if (!isWorkspaceAgent(ai)) return original(interaction);

    const { userId } = setup.parseScoped(interaction.customId, prefix);
    if (!(await assertOwner(interaction, userId))) return;
    await interaction.reply({
      content: "ChatGPT Workspace Agent model selection is managed inside ChatGPT, not in Pixy.",
      flags: EPHEMERAL,
    });
  };
}

const modelModalHandler = setup.modalHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.AI_MODEL_MODAL
);
if (modelModalHandler) {
  const originalModelModalExecute = modelModalHandler.execute.bind(modelModalHandler);
  modelModalHandler.execute = async function rejectStaleWorkspaceAgentModelModal(interaction) {
    const ai = await getGuildAiConfig(interaction.guild.id);
    if (!isWorkspaceAgent(ai)) return originalModelModalExecute(interaction);

    const { userId } = setup.parseScoped(interaction.customId, PREFIX.AI_MODEL_MODAL);
    if (!(await assertOwner(interaction, userId))) return;
    await interaction.reply({
      content: "This Workspace Agent does not expose model selection through Pixy.",
      flags: EPHEMERAL,
    });
  };
}

module.exports = {
  buildWorkspaceAgentModal,
  configuredMcpUrl,
  isWorkspaceAgent,
  removeWorkspaceModelControls,
};
