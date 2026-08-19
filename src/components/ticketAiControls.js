const { PermissionFlagsBits } = require("discord.js");

const { BILLING_PLANS } = require("../billing/constants");
const { hasPremiumEntitlement } = require("../billing/billingService");
const {
  loadGuildEntitlementState,
} = require("../billing/entitlementService");
const { prisma } = require("../config/prisma");
const {
  TICKET_OPERATING_MODES,
  resolveTicketOperatingMode,
} = require("../features/ticketOperatingMode");
const {
  getTicketSurfaceSettings,
} = require("../utils/tickets/ticketSurface");
const ticketControls = require("./ticketControls");
const {
  buildSmartOverlayPayload,
} = require("./smartOverlayControls");
const {
  ACTION_SELECT_ID,
  AI_ON_VALUE,
  AI_OFF_VALUE,
  buildAiOnlyTicketControlComponents,
  buildTicketAiOption,
} = require("./ticketAiToggle");

const EPHEMERAL = 64;

function resolveTicketControlRenderState(options = {}) {
  let plan = options.plan || null;

  if (!plan && options.premiumEntitled === false) {
    plan = BILLING_PLANS.EXPIRED;
  } else if (!plan && options.premiumEntitled === true) {
    plan = BILLING_PLANS.TRIAL;
  }

  const premiumEntitled = plan
    ? hasPremiumEntitlement(plan)
    : options.premiumEntitled !== false;

  return {
    plan: plan || (premiumEntitled ? BILLING_PLANS.TRIAL : BILLING_PLANS.EXPIRED),
    premiumEntitled,
  };
}

function buildTicketControlContent(aiEnabled = true, options = {}) {
  const { premiumEntitled } = resolveTicketControlRenderState(options);
  const mode = resolveTicketOperatingMode(options.settings);

  return [
    "Hello 👋 I'm Pixy AI. Ask your question here and I'll try to help while the support team reviews your ticket.",
    "",
    premiumEntitled
      ? mode === TICKET_OPERATING_MODES.CUSTOM
        ? "**Custom Ticket Controls**"
        : "**Ticket Actions**"
      : "**Pixy AI Control**",
    premiumEntitled
      ? "Use the menu below for the ticket actions enabled by this server and to pause or resume Pixy AI."
      : "Pixy Pro ticket actions are unavailable, but server staff can still pause or resume automatic AI replies.",
    options.escalated === true
      ? "🤝 **Human support requested** — this ticket has already been handed off for review."
      : null,
    "",
    aiEnabled
      ? "🤖 **Pixy AI is ON** — staff can pause or resume automatic replies at any time."
      : "⏸️ **Pixy AI is OFF** — staff can pause or resume automatic replies at any time.",
  ].filter((line) => line !== null).join("\n");
}

function filterTicketActionOptions(selectMenu, options = {}) {
  if (!selectMenu || !Array.isArray(selectMenu.options)) return;

  const settings = options.settings;
  const hasSettings = settings && typeof settings === "object";
  const agentActionsEnabled = !hasSettings || settings.agentActionsEnabled !== false;
  const allowed = {
    escalate:
      agentActionsEnabled &&
      options.escalated !== true &&
      (!hasSettings || settings.escalationEnabled === true),
    rename:
      agentActionsEnabled &&
      (!hasSettings || settings.renameReviewEnabled === true),
    close:
      agentActionsEnabled &&
      (!hasSettings || settings.closeTicketEnabled === true),
  };

  for (let index = selectMenu.options.length - 1; index >= 0; index -= 1) {
    const value = selectMenu.options[index]?.data?.value;
    if (Object.prototype.hasOwnProperty.call(allowed, value) && !allowed[value]) {
      if (typeof selectMenu.spliceOptions === "function") {
        selectMenu.spliceOptions(index, 1);
      }
    }
  }
}

function buildCombinedTicketControlComponents(aiEnabled = true, options = {}) {
  const { premiumEntitled } = resolveTicketControlRenderState(options);

  if (!premiumEntitled) {
    return buildAiOnlyTicketControlComponents(aiEnabled);
  }

  const rows = ticketControls.buildTicketControlPanelComponents();
  const selectMenu = rows?.[0]?.components?.[0];
  const aiOption = buildTicketAiOption(aiEnabled);

  if (!selectMenu) return buildAiOnlyTicketControlComponents(aiEnabled);

  filterTicketActionOptions(selectMenu, options);

  const resetIndex = Array.isArray(selectMenu.options)
    ? selectMenu.options.findIndex((option) => option?.data?.value === "reset")
    : -1;

  if (typeof selectMenu.spliceOptions === "function") {
    selectMenu.spliceOptions(
      resetIndex >= 0 ? resetIndex : selectMenu.options.length,
      0,
      aiOption
    );
  } else {
    selectMenu.addOptions(aiOption);
  }

  return rows;
}

function buildTicketControlPayload(aiEnabled = true, options = {}) {
  return {
    content: buildTicketControlContent(aiEnabled, options),
    components: buildCombinedTicketControlComponents(aiEnabled, options),
    allowedMentions: { parse: [] },
  };
}

function buildModeAwareTicketControlPayload(aiEnabled = true, options = {}) {
  const surfaceOptions = {
    ...options,
    settings: getTicketSurfaceSettings(options.channel, options.settings),
  };
  const mode = resolveTicketOperatingMode(surfaceOptions.settings);

  if (mode === TICKET_OPERATING_MODES.OVERLAY) {
    return buildSmartOverlayPayload(aiEnabled, surfaceOptions);
  }

  return buildTicketControlPayload(aiEnabled, surfaceOptions);
}

function buildTicketAiStateMessage({ enabled, previousEnabled, changed }) {
  if (!changed) {
    return enabled
      ? "ℹ️ **Pixy AI is already ON** — automatic replies are active in this ticket."
      : "ℹ️ **Pixy AI is already OFF** — Pixy will not reply automatically in this ticket.";
  }

  return enabled
    ? "✅ **Pixy AI was OFF and is now ON** — automatic replies have resumed."
    : "✅ **Pixy AI was ON and is now OFF** — staff and users can continue without automatic AI replies.";
}

async function canControlTicketAi(subject) {
  if (!subject?.guild || !subject?.member) return false;

  if (subject.member.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return true;
  }

  const routes = await prisma.adminRoute.findMany({
    where: {
      guildId: subject.guild.id,
      enabled: true,
    },
    select: { roleId: true },
  });

  return routes.some((route) => subject.member.roles?.cache?.has(route.roleId));
}

async function setTicketAiState({ guildId, channelId, enabled }) {
  const ticket = await prisma.ticketChannel.findUnique({
    where: { channelId },
  });

  if (!ticket || ticket.guildId !== guildId || ticket.closed) {
    return { ok: false, code: "ticket_not_open" };
  }

  const previousEnabled = ticket.aiEnabled !== false;
  const nextEnabled = typeof enabled === "boolean" ? enabled : !previousEnabled;
  const changed = nextEnabled !== previousEnabled;

  if (!changed) {
    return {
      ok: true,
      ticket,
      previousEnabled,
      enabled: nextEnabled,
      changed: false,
    };
  }

  const updated = await prisma.ticketChannel.update({
    where: { channelId },
    data: { aiEnabled: nextEnabled },
  });

  return {
    ok: true,
    ticket: updated,
    previousEnabled,
    enabled: nextEnabled,
    changed: true,
  };
}

function isTicketControlMessage(message) {
  if (!message?.author?.bot) return false;

  const hasActionSelect = message.components?.some((row) =>
    row.components?.some((component) => component.customId === ACTION_SELECT_ID)
  );
  if (hasActionSelect) return true;

  const content = String(message.content || "");
  if (/\*\*Smart Overlay\*\*/.test(content) && /Pixy AI is (?:ON|OFF)/i.test(content)) {
    return true;
  }
  if (/\*\*(?:Ticket Actions|Custom Ticket Controls|Pixy AI Control)\*\*/.test(content) && /Pixy AI is (?:ON|OFF)/i.test(content)) {
    return true;
  }
  if (content.startsWith("🤝 **Pixy handed this ticket to human support.**")) {
    return true;
  }
  if (/🤝 \*\*Human support requested\*\*/.test(content) && /Pixy AI is (?:ON|OFF)/i.test(content)) {
    return true;
  }

  return false;
}

async function findTicketControlMessage(channel) {
  if (!channel?.messages?.fetch) return null;

  let before;

  for (let page = 0; page < 10; page += 1) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });

    const found = batch.find(isTicketControlMessage);
    if (found) return found;
    if (batch.size < 100) break;

    const oldest = Array.from(batch.values()).reduce((current, message) => {
      if (!current || message.createdTimestamp < current.createdTimestamp) {
        return message;
      }
      return current;
    }, null);

    before = oldest?.id;
    if (!before) break;
  }

  return null;
}

async function resolveRenderOptionsForChannel(channel, options = {}) {
  const guildId = channel?.guild?.id;
  if (!guildId) return { ...options, channel };

  const hasSettings = Object.prototype.hasOwnProperty.call(options, "settings");
  const hasEscalated = Object.prototype.hasOwnProperty.call(options, "escalated");

  const [entitlement, settings, ticketState] = await Promise.all([
    options.plan
      ? Promise.resolve(null)
      : loadGuildEntitlementState(guildId),
    hasSettings
      ? Promise.resolve(null)
      : prisma.guildSetting.findUnique({ where: { guildId } }),
    hasEscalated
      ? Promise.resolve(null)
      : prisma.ticketChannel.findUnique({
          where: { channelId: channel.id },
          select: { escalated: true },
        }),
  ]);

  return {
    ...options,
    channel,
    plan: options.plan || entitlement?.plan,
    settings: hasSettings ? options.settings : settings,
    escalated: hasEscalated ? options.escalated : ticketState?.escalated === true,
  };
}

async function refreshTicketControlMessage(channel, aiEnabled, options = {}) {
  const controlMessage = await findTicketControlMessage(channel);
  if (!controlMessage) return { ok: false, code: "control_message_not_found" };

  const renderOptions = await resolveRenderOptionsForChannel(channel, options);
  await controlMessage.edit(buildModeAwareTicketControlPayload(aiEnabled, renderOptions));

  return { ok: true, message: controlMessage };
}

function installTicketAiSelectHandler() {
  const actionHandler = ticketControls.selectMenuHandlers?.find(
    (handler) => handler.customId === ACTION_SELECT_ID
  );

  if (!actionHandler || actionHandler.__pixyAiToggleWrapped) return;

  const originalExecute = actionHandler.execute.bind(actionHandler);

  actionHandler.execute = async function executeWithAiToggle(interaction) {
    const action = interaction.values?.[0];

    if (action !== AI_ON_VALUE && action !== AI_OFF_VALUE) {
      return originalExecute(interaction);
    }

    if (!interaction.guild || !interaction.channel) {
      await interaction.reply({
        content: "This control only works inside a server ticket channel.",
        flags: EPHEMERAL,
      });
      return;
    }

    if (!(await canControlTicketAi(interaction))) {
      await interaction.reply({
        content: "Only server staff configured for Pixy support can change the AI state in this ticket.",
        flags: EPHEMERAL,
      });
      return;
    }

    const result = await setTicketAiState({
      guildId: interaction.guild.id,
      channelId: interaction.channel.id,
      enabled: action === AI_ON_VALUE,
    });

    if (!result.ok) {
      await interaction.reply({
        content: "This ticket is no longer open or is not tracked by Pixy AI.",
        flags: EPHEMERAL,
      });
      return;
    }

    const [entitlement, settings] = await Promise.all([
      loadGuildEntitlementState(interaction.guild.id),
      prisma.guildSetting.findUnique({
        where: { guildId: interaction.guild.id },
      }),
    ]);

    await interaction.update(
      buildModeAwareTicketControlPayload(result.enabled, {
        plan: entitlement.plan,
        settings,
        channel: interaction.channel,
        escalated: result.ticket?.escalated === true,
      })
    );

    await interaction.followUp({
      content: buildTicketAiStateMessage(result),
      allowedMentions: { parse: [] },
    });
  };

  actionHandler.__pixyAiToggleWrapped = true;
}

installTicketAiSelectHandler();

module.exports = {
  name: "ticketAiControls",
  ACTION_SELECT_ID,
  AI_ON_VALUE,
  AI_OFF_VALUE,
  buildAiOnlyTicketControlComponents,
  buildTicketAiOption,
  buildTicketControlContent,
  buildCombinedTicketControlComponents,
  buildTicketControlPayload,
  buildModeAwareTicketControlPayload,
  buildTicketAiStateMessage,
  canControlTicketAi,
  filterTicketActionOptions,
  findTicketControlMessage,
  isTicketControlMessage,
  refreshTicketControlMessage,
  resolveRenderOptionsForChannel,
  resolveTicketControlRenderState,
  setTicketAiState,
};