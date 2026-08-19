const { Events, Collection } = require("discord.js");
const { prisma } = require("../config/prisma");
const {
  DISABLED_MESSAGES,
  getTicketActionAvailability,
} = require("../features/ticketActionAvailability");

const DEFAULT_ERROR_MESSAGE = "An error occurred while executing this interaction.";
const SETTINGS_COMPONENT_PREFIX = "settings_";
const SETTINGS_TOGGLE_PREFIX = "settings_toggle:";
const TICKET_CONTROL_SETTING_FIELDS = new Set([
  "closeTicketEnabled",
  "renameReviewEnabled",
  "escalationEnabled",
  "agentActionsEnabled",
]);

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getCooldowns(client) {
  if (!client.cooldowns) client.cooldowns = new Collection();
  return client.cooldowns;
}

function getCooldownSeconds(entry) {
  return Number(entry?.cooldown || entry?.cooldownSeconds || 0);
}

function getCooldownId(interaction, entry, fallbackName) {
  return entry?.cooldownId || entry?.name || entry?.customId || entry?.sourceCommand || fallbackName;
}

function getInteractionErrorMessage(error, entry) {
  return DISABLED_MESSAGES[error?.code] || entry?.errorMessage || DEFAULT_ERROR_MESSAGE;
}

async function safeReply(interaction, payload) {
  if (interaction.isAutocomplete?.()) {
    try {
      await interaction.respond([]);
    } catch {
      // Ignore autocomplete response errors.
    }
    return;
  }

  const finalPayload = typeof payload === "string"
    ? { content: payload, flags: 64 }
    : { flags: 64, ...payload };

  try {
    if (interaction.replied || interaction.deferred) await interaction.followUp(finalPayload);
    else await interaction.reply(finalPayload);
  } catch {
    // Prevent crashes if Discord rejects the reply or follow-up.
  }
}

function isSettingsComponent(interaction) {
  return Boolean(
    interaction?.customId &&
    String(interaction.customId).startsWith(SETTINGS_COMPONENT_PREFIX)
  );
}

async function stopUnavailableSettingsInteraction(interaction, options = {}) {
  if (!isSettingsComponent(interaction) || !interaction.guild?.id) return false;

  try {
    const client = options.client || prisma;
    const config = await client.guildConfig.findUnique({
      where: { guildId: interaction.guild.id },
      select: { guildId: true },
    });
    if (config) return false;

    const reply = options.reply || safeReply;
    await reply(
      interaction,
      DISABLED_MESSAGES.setup_required ||
        "Pixy core setup is not configured. Run `/pixy-setup` first."
    );
    return true;
  } catch (error) {
    console.error("Settings setup preflight failed:", error);
    await (options.reply || safeReply)(
      interaction,
      "Pixy could not verify the server setup right now. Please try again."
    );
    return true;
  }
}

function shouldRefreshTicketControlsAfterSettingsChange(interaction) {
  if (!interaction?.guild?.id) return false;
  if (!String(interaction.customId || "").startsWith(SETTINGS_TOGGLE_PREFIX)) return false;
  return TICKET_CONTROL_SETTING_FIELDS.has(interaction.values?.[0]);
}

async function refreshTicketControlsAfterSettingsChange(interaction, options = {}) {
  if (!shouldRefreshTicketControlsAfterSettingsChange(interaction)) {
    return { ok: true, skipped: true };
  }

  const refreshControls = options.refreshControls ||
    require("../billing/ticketControlRefresh").refreshOpenTicketControlsForGuild;
  const result = await refreshControls(interaction.guild.id, {
    guild: interaction.guild,
    discordClient: interaction.client,
  });

  if (!result?.ok) {
    const logger = options.logger || console;
    logger.warn?.("Pixy settings changed but one or more open ticket controls could not be refreshed:", {
      guildId: interaction.guild.id,
      field: interaction.values?.[0],
      code: result?.code || "unknown_refresh_failure",
      attempted: result?.attempted,
      refreshed: result?.refreshed,
      failed: result?.failed,
    });
  }

  return result;
}

async function refreshExpiredTicketControls(interaction, aiEnabled) {
  if (!interaction.channel) return { ok: false, code: "missing_channel" };

  const {
    refreshOpenTicketControlForChannel,
  } = require("../billing/ticketControlRefresh");

  return refreshOpenTicketControlForChannel({
    guildId: interaction.guild?.id,
    channel: interaction.channel,
    aiEnabled,
  });
}

async function stopUnavailableTicketAction(interaction, options = {}) {
  try {
    const getAvailability = options.getAvailability || getTicketActionAvailability;
    const availability = await getAvailability(interaction, options);
    if (!availability || availability.available) return false;

    if (availability.code === "no_support_routes") {
      console.warn("Ticket escalation requested without a valid support route:", {
        guildId: interaction.guild?.id,
        channelId: interaction.channel?.id,
        userId: interaction.user?.id,
      });
    }

    await safeReply(interaction, availability.message);

    if (availability.refreshControls) {
      const refreshControlMessage = options.refreshControlMessage ||
        refreshExpiredTicketControls;
      await refreshControlMessage(
        interaction,
        availability.aiEnabled
      ).catch((error) => {
        console.error("Failed to refresh expired ticket controls:", error);
      });
    }

    return true;
  } catch (error) {
    console.error("Ticket action availability preflight failed:", error);
    return false;
  }
}

function isDisabled(entry) {
  return entry?.disabled === true || entry?.maintenance === true;
}

function getDisabledMessage(entry) {
  return entry?.disabledMessage ||
    entry?.maintenanceMessage ||
    "This interaction is currently disabled or under maintenance.";
}

async function checkGuildOnly(interaction, entry) {
  if (!entry?.guildOnly) return true;
  if (interaction.guild) return true;
  await safeReply(
    interaction,
    entry.guildOnlyMessage || "This interaction can only be used inside a server."
  );
  return false;
}

async function checkUserPermissions(interaction, entry) {
  const permissions = toArray(entry?.userPermissions);
  if (!permissions.length) return true;

  if (!interaction.guild || !interaction.memberPermissions) {
    await safeReply(interaction, "I could not check your permissions here.");
    return false;
  }

  if (!interaction.memberPermissions.has(permissions)) {
    await safeReply(
      interaction,
      entry?.userPermissionsMessage || "You do not have permission to use this interaction."
    );
    return false;
  }

  return true;
}

async function checkBotPermissions(interaction, entry) {
  const permissions = toArray(entry?.botPermissions);
  if (!permissions.length || !interaction.guild) return true;

  const botMember = interaction.guild.members.me;
  if (!botMember) {
    await safeReply(interaction, "I could not check my permissions here.");
    return false;
  }

  const botPermissions = interaction.channel
    ? botMember.permissionsIn(interaction.channel)
    : botMember.permissions;
  if (!botPermissions.has(permissions)) {
    await safeReply(
      interaction,
      entry?.botPermissionsMessage || "I do not have the required permissions to do that."
    );
    return false;
  }

  return true;
}

async function checkCooldown(interaction, entry, fallbackName) {
  const seconds = getCooldownSeconds(entry);
  if (!seconds || seconds <= 0) return true;

  const cooldowns = getCooldowns(interaction.client);
  const key = `interaction:${interaction.user.id}:${getCooldownId(interaction, entry, fallbackName)}`;
  const now = Date.now();
  const expiresAt = cooldowns.get(key);

  if (expiresAt && expiresAt > now) {
    const remaining = ((expiresAt - now) / 1000).toFixed(1);
    await safeReply(
      interaction,
      entry?.cooldownMessage || `Please wait ${remaining}s before using this again.`
    );
    return false;
  }

  cooldowns.set(key, now + seconds * 1000);
  const timer = setTimeout(() => {
    if (cooldowns.get(key) <= Date.now()) cooldowns.delete(key);
  }, seconds * 1000);
  if (typeof timer.unref === "function") timer.unref();
  return true;
}

async function runChecks(interaction, entry, fallbackName) {
  if (!entry) return true;
  if (isDisabled(entry)) {
    await safeReply(interaction, getDisabledMessage(entry));
    return false;
  }
  if (!(await checkGuildOnly(interaction, entry))) return false;
  if (!(await checkUserPermissions(interaction, entry))) return false;
  if (!(await checkBotPermissions(interaction, entry))) return false;
  if (!(await checkCooldown(interaction, entry, fallbackName))) return false;
  return true;
}

async function runInteraction(interaction, label, entry, callback) {
  try {
    if (!(await runChecks(interaction, entry, label))) return;
    await callback();
  } catch (error) {
    console.error(`${label} failed:`, error);
    await safeReply(interaction, getInteractionErrorMessage(error, entry));
  }
}

function matchesCustomId(handler, interaction) {
  if (!handler || !interaction.customId) return false;
  if (typeof handler.matches === "function") {
    return handler.matches(interaction.customId, interaction);
  }
  if (handler.customId instanceof RegExp) return handler.customId.test(interaction.customId);
  if (Array.isArray(handler.customId)) return handler.customId.includes(interaction.customId);
  if (typeof handler.customId === "string") return handler.customId === interaction.customId;
  if (typeof handler.customIdPrefix === "string") {
    return interaction.customId.startsWith(handler.customIdPrefix);
  }
  return false;
}

function getSelectMenuType(interaction) {
  if (interaction.isStringSelectMenu()) return "string";
  if (interaction.isUserSelectMenu()) return "user";
  if (interaction.isRoleSelectMenu()) return "role";
  if (interaction.isChannelSelectMenu()) return "channel";
  if (interaction.isMentionableSelectMenu()) return "mentionable";
  return "any";
}

function normalizeSelectType(type) {
  const value = String(type || "").toLowerCase();
  if (!value || ["any", "select", "selectmenu", "select-menu", "anyselect", "anyselectmenu"].includes(value)) {
    return "any";
  }
  if (["string", "stringselect", "stringselectmenu"].includes(value)) return "string";
  if (["user", "userselect", "userselectmenu"].includes(value)) return "user";
  if (["role", "roleselect", "roleselectmenu"].includes(value)) return "role";
  if (["channel", "channelselect", "channelselectmenu"].includes(value)) return "channel";
  if (["mentionable", "mentionableselect", "mentionableselectmenu"].includes(value)) {
    return "mentionable";
  }
  return value;
}

function isAnySelectMenu(interaction) {
  return interaction.isStringSelectMenu() ||
    interaction.isUserSelectMenu() ||
    interaction.isRoleSelectMenu() ||
    interaction.isChannelSelectMenu() ||
    interaction.isMentionableSelectMenu();
}

function findButtonHandler(interaction) {
  return interaction.client.buttonHandlers?.find((handler) =>
    matchesCustomId(handler, interaction)
  );
}

function findSelectMenuHandler(interaction) {
  return interaction.client.selectMenuHandlers?.find((handler) => {
    const handlerType = normalizeSelectType(handler?.type || handler?.selectType);
    return (handlerType === "any" || handlerType === getSelectMenuType(interaction)) &&
      matchesCustomId(handler, interaction);
  });
}

function findModalHandler(interaction) {
  return interaction.client.modalHandlers?.find((handler) =>
    matchesCustomId(handler, interaction)
  );
}

function matchesAutocompleteHandler(handler, interaction) {
  if (!handler) return false;
  if (typeof handler.matches === "function") return handler.matches(interaction);
  return toArray(handler.commandName || handler.name || handler.sourceCommand)
    .includes(interaction.commandName);
}

async function handleAutocomplete(interaction) {
  const command = interaction.client.commands.get(interaction.commandName);
  const handler = interaction.client.autocompleteHandlers?.find((entry) =>
    matchesAutocompleteHandler(entry, interaction)
  ) || command;

  if (!handler || typeof handler.execute !== "function") {
    try {
      await interaction.respond([]);
    } catch {
      // Ignore.
    }
    return;
  }

  try {
    if (isDisabled(handler)) return void (await interaction.respond([]));
    await handler.execute(interaction);
  } catch (error) {
    console.error(`Autocomplete ${interaction.commandName} failed:`, error);
    try {
      await interaction.respond([]);
    } catch {
      // Ignore.
    }
  }
}

const interactionCreateEvent = {
  name: Events.InteractionCreate,

  async execute(interaction) {
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction);

    if (interaction.isChatInputCommand()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command) return safeReply(interaction, "Unknown command.");
      await runInteraction(
        interaction,
        `Command ${interaction.commandName}`,
        command,
        () => command.execute(interaction)
      );
      return;
    }

    if (interaction.isButton()) {
      if (await stopUnavailableSettingsInteraction(interaction)) return;
      if (await stopUnavailableTicketAction(interaction)) return;
      const handler = findButtonHandler(interaction);
      if (handler) {
        await runInteraction(
          interaction,
          `Button ${interaction.customId}`,
          handler,
          () => handler.execute(interaction)
        );
      }
      return;
    }

    if (isAnySelectMenu(interaction)) {
      if (await stopUnavailableSettingsInteraction(interaction)) return;
      if (await stopUnavailableTicketAction(interaction)) return;
      const handler = findSelectMenuHandler(interaction);
      if (handler) {
        await runInteraction(
          interaction,
          `Select menu ${interaction.customId}`,
          handler,
          async () => {
            await handler.execute(interaction);
            await refreshTicketControlsAfterSettingsChange(interaction);
          }
        );
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (await stopUnavailableSettingsInteraction(interaction)) return;
      const handler = findModalHandler(interaction);
      if (!handler) return;
      await runInteraction(
        interaction,
        `Modal ${interaction.customId}`,
        handler,
        async () => {
          if (await stopUnavailableTicketAction(interaction)) return;
          await handler.execute(interaction);
        }
      );
    }
  },
};

module.exports = Object.assign(interactionCreateEvent, {
  getInteractionErrorMessage,
  isSettingsComponent,
  refreshExpiredTicketControls,
  refreshTicketControlsAfterSettingsChange,
  safeReply,
  shouldRefreshTicketControlsAfterSettingsChange,
  stopUnavailableSettingsInteraction,
  stopUnavailableTicketAction,
});
