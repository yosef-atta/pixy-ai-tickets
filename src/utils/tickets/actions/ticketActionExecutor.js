const { PermissionFlagsBits } = require("discord.js");

const { prisma } = require("../../../config/prisma");
const { aiConfig } = require("../../../config/ai");
const { TICKET_ACTIONS } = require("./ticketActionTypes");
const { getGuildActionRejection } = require("../../../features/guildFeatureGate");
const {
  isFullTicketControlEnabled,
} = require("../../../features/ticketOperatingMode");
const {
  getOrCreateEscalationNotificationChannel,
  sendEscalationNotification,
} = require("../escalationNotifications");
const {
  preflightFullControlForTicket,
} = require("../humanSupportPermissions");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const limitReplyText = (text) => String(text || "").trim().slice(0, Math.max(1, Number(aiConfig.actionMaxReplyChars || 1000)));

function createActionError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

async function sendActionReply(message, text) {
  const content = limitReplyText(text);
  if (!content) return false;
  await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
  return true;
}

async function sendTicketEscalationReply({ message, roleName, text }) {
  const content = limitReplyText(text) || `This ticket has been escalated to ${roleName}. Please wait for them to respond here.`;
  await message.channel.send({ content, allowedMentions: { parse: [] } });
  return true;
}

function buildOverlayHandoffReply(actionRequest, roleName) {
  const source = String(actionRequest?.text || "");
  const isArabic = /[\u0600-\u06FF]/.test(source);

  if (isArabic) {
    return `حوّلت التذكرة لفريق **${roleName}** للمراجعة البشرية. أوقفت ردود Pixy التلقائية علشان فريق الدعم يقدر يكمل معاك هنا من غير ما أغيّر أو أنقل التذكرة.`;
  }

  return `I've handed this ticket off to **${roleName}** for human review. Pixy automatic replies are now paused so the support team can continue with you here without moving or renaming the ticket.`;
}

async function refreshEscalatedTicketControls(channel, settings) {
  const {
    refreshTicketControlMessage,
  } = require("../../../components/ticketAiControls");

  const result = await refreshTicketControlMessage(channel, false, {
    settings,
    escalated: true,
  });

  if (!result.ok) {
    throw new Error(result.code || "control_message_not_found");
  }
}

async function executeRenameTicket({ message, validation }) {
  await message.channel.setName(validation.data.name, `Pixy AI safe action: rename_ticket requested by ${message.author?.tag || "user"}`);
  await prisma.ticketChannel.update({
    where: { channelId: message.channel.id },
    data: { renamedByAiAt: new Date(), lastAiAction: TICKET_ACTIONS.RENAME_TICKET, lastAiActionAt: new Date() },
  });
  return { ok: true, replySent: false, channelDeleted: false };
}

function snapshotRoleAccessOverwrite(overwrite) {
  if (!overwrite) return null;
  const tracked = [
    ["ViewChannel", PermissionFlagsBits.ViewChannel],
    ["SendMessages", PermissionFlagsBits.SendMessages],
    ["ReadMessageHistory", PermissionFlagsBits.ReadMessageHistory],
  ];
  const snapshot = {};
  for (const [name, flag] of tracked) {
    if (overwrite.allow?.has(flag)) snapshot[name] = true;
    else if (overwrite.deny?.has(flag)) snapshot[name] = false;
    else snapshot[name] = null;
  }
  return snapshot;
}

async function applyFullControlEscalation({ message, role, categoryId, name, auditReason }) {
  const originalOverwrite = message.channel.permissionOverwrites.cache.get(role.id) || null;
  const state = {
    originalParentId: message.channel.parentId,
    originalName: message.channel.name,
    roleOverwriteCreated: !originalOverwrite,
    originalRoleAccess: snapshotRoleAccessOverwrite(originalOverwrite),
  };

  await message.channel.permissionOverwrites.edit(
    role,
    { ViewChannel: true, SendMessages: true, ReadMessageHistory: true },
    { reason: auditReason }
  );

  if (message.channel.parentId !== categoryId) {
    await message.channel.setParent(categoryId, {
      lockPermissions: false,
      reason: auditReason,
    });
  }

  if (name && name !== message.channel.name) {
    await message.channel.setName(name, auditReason);
  }

  return state;
}

async function rollbackFullControlEscalation({ message, role, state }) {
  if (!state) return;

  if (message.channel.name !== state.originalName) {
    await message.channel
      .setName(state.originalName, "Rollback failed Pixy escalation")
      .catch(() => null);
  }

  if (
    state.originalParentId &&
    message.channel.parentId !== state.originalParentId
  ) {
    await message.channel
      .setParent(state.originalParentId, {
        lockPermissions: false,
        reason: "Rollback failed Pixy escalation",
      })
      .catch(() => null);
  }

  if (state.roleOverwriteCreated) {
    await message.channel.permissionOverwrites
      .delete(role, "Rollback failed Pixy escalation")
      .catch(() => null);
  } else if (state.originalRoleAccess) {
    await message.channel.permissionOverwrites
      .edit(role, state.originalRoleAccess, {
        reason: "Rollback failed Pixy escalation",
      })
      .catch(() => null);
  }
}

async function persistEscalationState({
  message,
  roleId,
  reason,
  notificationMessage,
}) {
  return prisma.ticketChannel.update({
    where: { channelId: message.channel.id },
    data: {
      escalated: true,
      escalatedAt: new Date(),
      escalatedRoleId: roleId,
      escalationReason: reason || null,
      escalationNotificationMessageId: notificationMessage.id,
      aiEnabled: false,
      lastAiAction: TICKET_ACTIONS.ESCALATE_TICKET,
      lastAiActionAt: new Date(),
      lastAiReplyAt: new Date(),
    },
  });
}

async function performOverlayHandoff({
  actionRequest,
  message,
  role,
  roleId,
  roleName,
  reason,
  routeId,
  notificationChannel,
  settings,
  notificationMessage = null,
  degradationCode = null,
}) {
  const sentNotification = notificationMessage || await sendEscalationNotification({
    notificationChannel,
    ticketChannel: message.channel,
    role,
    reason,
    routeId,
    requestedBy: message.author,
    newName: message.channel.name,
    summary: actionRequest.data?.summary,
  });

  await persistEscalationState({
    message,
    roleId,
    reason,
    notificationMessage: sentNotification,
  });

  let replySent = false;
  try {
    replySent = await sendTicketEscalationReply({
      message,
      roleName: roleName || role.name,
      text: buildOverlayHandoffReply(actionRequest, roleName || role.name),
    });
  } catch (error) {
    console.error("Failed to send overlay handoff reply:", error);
  }

  await refreshEscalatedTicketControls(message.channel, settings).catch((error) => {
    console.error("Failed to refresh ticket controls after escalation:", error);
  });

  return {
    ok: true,
    replySent,
    channelDeleted: false,
    fullControl: false,
    degraded: Boolean(degradationCode),
    degradationCode,
    rolePinged: sentNotification.pixyRolePinged ?? null,
  };
}

async function executeEscalateTicket({ actionRequest, message, validation }) {
  const { categoryId, roleId, reason, name, routeId, roleName } = validation.data;
  const auditReason = `Pixy AI safe action: escalate_ticket requested by ${message.author?.tag || "user"}`.slice(0, 512);

  const [config, role, settings, category] = await Promise.all([
    prisma.guildConfig.findUnique({
      where: { guildId: message.guild.id },
      select: { escalationNotificationChannelId: true },
    }),
    message.guild.roles.fetch(roleId).catch(() => null),
    prisma.guildSetting.findUnique({
      where: { guildId: message.guild.id },
    }),
    message.guild.channels.fetch(categoryId).catch(() => null),
  ]);

  if (!role) {
    throw createActionError(
      "escalation_role_missing",
      "The configured support role no longer exists."
    );
  }
  if (!category) {
    throw createActionError(
      "escalation_category_missing",
      "The configured escalation category no longer exists."
    );
  }

  const notificationResult = await getOrCreateEscalationNotificationChannel({
    guild: message.guild,
    categoryId,
    existingChannelId: config?.escalationNotificationChannelId,
  });
  if (!notificationResult.ok) {
    throw createActionError(notificationResult.code, notificationResult.code);
  }

  const common = {
    actionRequest,
    message,
    role,
    roleId,
    roleName,
    reason,
    routeId,
    notificationChannel: notificationResult.channel,
    settings,
  };

  const fullControlRequested = isFullTicketControlEnabled(settings);
  if (!fullControlRequested) {
    return performOverlayHandoff(common);
  }

  const preflight = await preflightFullControlForTicket({
    guild: message.guild,
    ticketChannel: message.channel,
    destinationCategory: category,
  });

  if (!preflight.ok) {
    return performOverlayHandoff({
      ...common,
      degradationCode: preflight.code || "full_control_preflight_failed",
    });
  }

  let mutationState = null;
  try {
    mutationState = await applyFullControlEscalation({
      message,
      role,
      categoryId,
      name,
      auditReason,
    });
  } catch (error) {
    await rollbackFullControlEscalation({ message, role, state: mutationState });
    return performOverlayHandoff({
      ...common,
      degradationCode: error?.code || "full_control_mutation_failed",
    });
  }

  let notificationMessage = null;
  try {
    notificationMessage = await sendEscalationNotification({
      notificationChannel: notificationResult.channel,
      ticketChannel: message.channel,
      role,
      reason,
      routeId,
      requestedBy: message.author,
      newName: name || message.channel.name,
      summary: actionRequest.data?.summary,
    });
  } catch (error) {
    await rollbackFullControlEscalation({ message, role, state: mutationState });
    try {
      return await performOverlayHandoff({
        ...common,
        degradationCode: "full_control_notification_failed",
      });
    } catch (fallbackError) {
      throw createActionError(
        "escalation_notification_failed",
        "Pixy could not deliver the human-support notification.",
        { cause: fallbackError || error }
      );
    }
  }

  try {
    await persistEscalationState({
      message,
      roleId,
      reason,
      notificationMessage,
    });
  } catch (error) {
    await rollbackFullControlEscalation({ message, role, state: mutationState });
    try {
      return await performOverlayHandoff({
        ...common,
        notificationMessage,
        degradationCode: "full_control_state_persist_failed",
      });
    } catch (fallbackError) {
      throw createActionError(
        "escalation_state_persist_failed",
        "Pixy notified human support but could not persist the escalation state.",
        { cause: fallbackError || error }
      );
    }
  }

  let replySent = false;
  try {
    replySent = await sendTicketEscalationReply({
      message,
      roleName: roleName || role.name,
      text: actionRequest.text,
    });
  } catch (error) {
    console.error("Failed to send full-control escalation reply:", error);
  }

  await refreshEscalatedTicketControls(message.channel, settings).catch((error) => {
    console.error("Failed to refresh ticket controls after escalation:", error);
  });

  return {
    ok: true,
    replySent,
    channelDeleted: false,
    fullControl: true,
    degraded: false,
    degradationCode: null,
    rolePinged: notificationMessage.pixyRolePinged ?? null,
  };
}

async function executeCloseTicket({ actionRequest, message }) {
  const replySent = await sendActionReply(message, actionRequest.text);
  await prisma.ticketChannel.update({
    where: { channelId: message.channel.id },
    data: {
      closed: true,
      status: "closed",
      closedByAi: true,
      closedAt: new Date(),
      lastAiAction: TICKET_ACTIONS.CLOSE_TICKET,
      lastAiActionAt: new Date(),
    },
  });

  try {
    const delayMs = Math.max(0, Math.min(Number(aiConfig.ticketCloseDeleteDelayMs || 2500), 10000));
    if (delayMs > 0) await sleep(delayMs);
    await message.channel.delete(`Pixy AI safe action: close_ticket requested by ${message.author?.tag || "user"}`);
    return { ok: true, replySent, channelDeleted: true };
  } catch (error) {
    await prisma.ticketChannel.update({
      where: { channelId: message.channel.id },
      data: {
        closed: false,
        status: "open",
        closedByAi: false,
        closedAt: null,
        lastAiAction: "close_ticket_failed",
        lastAiActionAt: new Date(),
      },
    }).catch((dbError) => console.error("Failed to revert ticket close state:", dbError));
    throw error;
  }
}

async function executeTicketAction({
  actionRequest,
  validation,
  message,
  getActionRejection = getGuildActionRejection,
}) {
  const rejectionCode = await getActionRejection(
    message.guild?.id,
    validation.action
  );
  if (rejectionCode) {
    const error = new Error(`Ticket action is unavailable: ${rejectionCode}`);
    error.code = rejectionCode;
    throw error;
  }
  if (validation.action === TICKET_ACTIONS.RENAME_TICKET) return executeRenameTicket({ message, validation });
  if (validation.action === TICKET_ACTIONS.CLOSE_TICKET) return executeCloseTicket({ actionRequest, message });
  if (validation.action === TICKET_ACTIONS.ESCALATE_TICKET) return executeEscalateTicket({ actionRequest, message, validation });
  throw new Error(`Unsupported ticket action executor: ${validation.action}`);
}

module.exports = {
  applyFullControlEscalation,
  buildOverlayHandoffReply,
  executeTicketAction,
  performOverlayHandoff,
  rollbackFullControlEscalation,
  snapshotRoleAccessOverwrite,
};
