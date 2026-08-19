const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");

const { prisma } = require("../config/prisma");
const { aiConfig } = require("../config/ai");
const { generateAiReply } = require("../ai/aiClient");
const { parseAiOutput } = require("../ai/parseAiAction");

const {
  validateTicketAction,
  sanitizeTicketName,
} = require("../utils/tickets/actions/ticketActionValidator");

const {
  executeTicketAction,
} = require("../utils/tickets/actions/ticketActionExecutor");

const {
  TICKET_ACTIONS,
} = require("../utils/tickets/actions/ticketActionTypes");
const { createStringSelectMenus } = require("../utils/selectMenuHelper");

const EPHEMERAL = 64;

const ACTION_SELECT_ID = "ticket_control_action";

const CLOSE_CONFIRM_PREFIX = "ticket_control_close_confirm:";
const CLOSE_CANCEL_PREFIX = "ticket_control_close_cancel:";

const ESCALATE_AI_PREFIX = "ticket_control_escalate_ai:";
const ESCALATE_CHOOSE_PREFIX = "ticket_control_escalate_choose:";
const ESCALATE_ROLE_SELECT_PREFIX = "ticket_control_escalate_role_select:";

const RENAME_MODAL_PREFIX = "ticket_control_rename_modal:";
const ESCALATE_AI_MODAL_PREFIX = "ticket_control_escalate_ai_modal:";
const ESCALATE_ROLE_MODAL_PREFIX = "ticket_control_escalate_role_modal:";

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value, maxLength = 90) {
  const text = cleanText(value);

  if (text.length <= maxLength) return text;

  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function parseScopedCustomId(customId, prefix) {
  const rest = String(customId || "").slice(prefix.length);
  const parts = rest.split(":");

  return {
    userId: parts[0],
    channelId: parts[1],
    roleId: parts[2],
  };
}

// Helper to respond to deferred interactions safely
function createResponder(interaction) {
  return (payload) => {
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(payload);
    }
    return interaction.update(payload);
  };
}

function createPseudoMessage(interaction) {
  return {
    guild: interaction.guild,
    channel: interaction.channel,
    author: interaction.user,

    async reply(payload) {
      if (typeof payload === "string") {
        return interaction.channel.send({
          content: payload,
        });
      }

      return interaction.channel.send(payload);
    },
  };
}

function buildScopedId(prefix, interaction, extra = "") {
  const base = `${prefix}${interaction.user.id}:${interaction.channel.id}`;

  if (!extra) return base;

  return `${base}:${extra}`;
}

function buildTicketControlPanelComponents() {
  return createStringSelectMenus({
    customId: ACTION_SELECT_ID,
    placeholder: "Select a ticket action...",
    options: [
      {
        label: "Escalate to Human",
        description: "Ask a support role to review this ticket.",
        value: "escalate",
        emoji: "🤝",
      },
      {
        label: "Rename Ticket",
        description: "Set a clearer name for this ticket.",
        value: "rename",
        emoji: "✏️",
      },
      {
        label: "Close Ticket",
        description: "Close and delete this ticket after confirmation.",
        value: "close",
        emoji: "🔒",
      },
    ],
  });
}

function buildCloseConfirmComponents(interaction) {
  const confirmButton = new ButtonBuilder()
    .setCustomId(buildScopedId(CLOSE_CONFIRM_PREFIX, interaction))
    .setLabel("Close Ticket")
    .setStyle(ButtonStyle.Danger);

  const cancelButton = new ButtonBuilder()
    .setCustomId(buildScopedId(CLOSE_CANCEL_PREFIX, interaction))
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);

  return [new ActionRowBuilder().addComponents(confirmButton, cancelButton)];
}

function buildEscalateChoiceComponents(interaction) {
  const aiButton = new ButtonBuilder()
    .setCustomId(buildScopedId(ESCALATE_AI_PREFIX, interaction))
    .setLabel("Let Pixy Decide")
    .setEmoji("🤖")
    .setStyle(ButtonStyle.Primary);

  const chooseButton = new ButtonBuilder()
    .setCustomId(buildScopedId(ESCALATE_CHOOSE_PREFIX, interaction))
    .setLabel("Choose Support Role")
    .setEmoji("👤")
    .setStyle(ButtonStyle.Secondary);

  return [new ActionRowBuilder().addComponents(aiButton, chooseButton)];
}

function buildRenameModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(buildScopedId(RENAME_MODAL_PREFIX, interaction))
    .setTitle("Rename Ticket");

  const nameInput = new TextInputBuilder()
    .setCustomId("ticket_name")
    .setLabel("New ticket name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(90)
    .setPlaceholder("Example: billing-refund");

  modal.addComponents(new ActionRowBuilder().addComponents(nameInput));

  return modal;
}

function buildAiEscalationModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(buildScopedId(ESCALATE_AI_MODAL_PREFIX, interaction))
    .setTitle("Escalate Ticket");

  const issueInput = new TextInputBuilder()
    .setCustomId("issue")
    .setLabel("Explain your issue")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(5)
    .setMaxLength(1000)
    .setPlaceholder("Example: I need help with a refund for a failed payment.");

  modal.addComponents(new ActionRowBuilder().addComponents(issueInput));

  return modal;
}

function buildRoleEscalationModal(interaction, roleId) {
  const modal = new ModalBuilder()
    .setCustomId(buildScopedId(ESCALATE_ROLE_MODAL_PREFIX, interaction, roleId))
    .setTitle("Escalate Ticket");

  const issueInput = new TextInputBuilder()
    .setCustomId("issue")
    .setLabel("Explain your issue for the support team")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(5)
    .setMaxLength(1000)
    .setPlaceholder("Write what happened so the team understands the issue quickly.");

  modal.addComponents(new ActionRowBuilder().addComponents(issueInput));

  return modal;
}

async function assertScopedInteraction(interaction, userId, channelId) {
  if (!interaction.guild || !interaction.channel) {
    await interaction.reply({
      content: "This can only be used inside a server ticket channel.",
      flags: EPHEMERAL,
    });
    return false;
  }

  if (interaction.user.id !== userId) {
    await interaction.reply({
      content: "Only the user who opened this menu can use this interaction.",
      flags: EPHEMERAL,
    });
    return false;
  }

  if (interaction.channel.id !== channelId) {
    await interaction.reply({
      content: "This interaction belongs to another ticket channel.",
      flags: EPHEMERAL,
    });
    return false;
  }

  return true;
}

async function getOpenTicket(interaction) {
  if (!interaction.guild || !interaction.channel) return null;

  if (interaction.channel.type !== ChannelType.GuildText) return null;

  const ticket = await prisma.ticketChannel.findUnique({
    where: {
      channelId: interaction.channel.id,
    },
  });

  if (!ticket || ticket.closed) return null;

  return ticket;
}

async function getConfiguredAdminRoutes(guild) {
  if (!guild) return [];

  await guild.roles.fetch().catch(() => null);

  const routes = await prisma.adminRoute.findMany({
    where: {
      guildId: guild.id,
      enabled: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
    take: 25,
  });

  return routes
    .map((route) => {
      const role = guild.roles.cache.get(route.roleId);

      if (!role || role.id === guild.id) return null;

      return {
        ...route,
        role,
      };
    })
    .filter(Boolean);
}

function buildConfiguredRoleSelectComponents(interaction, routes) {
  const options = routes.map((route) => ({
    label: truncateText(route.role.name, 100),
    description: truncateText(route.description, 100),
    value: route.roleId,
  }));

  return createStringSelectMenus({
    customId: buildScopedId(ESCALATE_ROLE_SELECT_PREFIX, interaction),
    placeholder: "Choose the support role...",
    options,
  });
}

async function runValidatedActionFromInteraction({
  interaction,
  actionRequest,
  ticket,
}) {
  const pseudoMessage = createPseudoMessage(interaction);

  const validation = await validateTicketAction({
    actionRequest,
    message: pseudoMessage,
    ticket,
  });

  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
    };
  }

  const execution = await executeTicketAction({
    actionRequest,
    validation,
    message: pseudoMessage,
  });

  return {
    ok: true,
    validation,
    execution,
  };
}

function getStrictTicketNameValidation(rawName) {
  const cleaned = cleanText(rawName);
  const sanitized = sanitizeTicketName(cleaned);

  if (!cleaned || cleaned.length < 2) {
    return {
      ok: false,
      code: "too_short",
    };
  }

  if (!sanitized || sanitized.length < 2) {
    return {
      ok: false,
      code: "invalid",
    };
  }

  if (cleaned !== sanitized) {
    return {
      ok: false,
      code: "not_discord_friendly",
      sanitized,
    };
  }

  return {
    ok: true,
    name: sanitized,
  };
}

async function getRecentTicketMessages(channel) {
  try {
    const fetched = await channel.messages.fetch({
      limit: Math.max(5, Number(aiConfig.recentMessagesLimit || 8)),
    });

    return Array.from(fetched.values())
      .filter((msg) => !msg.author?.bot)
      .filter((msg) => cleanText(msg.content).length > 0)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-8)
      .map((msg) => {
        const authorName = msg.member?.displayName || msg.author?.username || "User";
        return `${authorName}: ${cleanText(msg.content).slice(0, 500)}`;
      })
      .join("\n");
  } catch {
    return "No recent messages available.";
  }
}

function formatRoutesForAi(routes) {
  if (!routes.length) {
    return "No configured escalation roles.";
  }

  return routes
    .map((route, index) => {
      return [
        `${index + 1}.`,
        `Role ID: ${route.roleId}`,
        `Role name: ${route.role.name}`,
        `Handles: ${truncateText(route.description, 500)}`,
      ].join("\n");
    })
    .join("\n\n");
}

function normalizeParsedEscalationAction(parsed) {
  if (
    !parsed ||
    parsed.kind !== "action_request" ||
    parsed.action !== TICKET_ACTIONS.ESCALATE_TICKET
  ) {
    return {
      ok: false,
      code: "not_escalation_action",
    };
  }

  const text = cleanText(parsed.text);
  const data = parsed.data && typeof parsed.data === "object" ? parsed.data : {};

  const name = sanitizeTicketName(data.name);
  const reason = cleanText(data.reason);

  if (!text || text.length < 20) {
    return {
      ok: false,
      code: "missing_ai_user_message",
    };
  }

  if (!reason || reason.length < 3) {
    return {
      ok: false,
      code: "missing_escalation_reason",
    };
  }

  if (!name || name.length < 2) {
    return {
      ok: false,
      code: "missing_ticket_name",
    };
  }

  return {
    ok: true,
    actionRequest: {
      ...parsed,
      text,
      data: {
        ...data,
        reason: reason.slice(0, 500),
        name,
      },
    },
  };
}

async function buildAiRoutingMessages({ interaction, issue, routes }) {
  const recentMessages = await getRecentTicketMessages(interaction.channel);

  return [
    {
      role: "system",
      content: [
        "You are Pixy AI, a Discord ticket escalation router.",
        "Your job is to choose the best configured support role for a user's ticket issue and prepare a complete escalation action.",
        "",
        "Role selection rules:",
        "- Return JSON only when you can clearly choose one configured role.",
        "- If the issue is unclear or does not match any configured role, return normal text asking the user to clarify or choose a role manually.",
        "- Only choose a roleId from the configured roles.",
        "- Never invent role IDs.",
        "- Do not include role mentions in your text.",
        "",
        "Language rules:",
        "- Write the text field in the same language as the user's issue/explanation.",
        "- Also use recent ticket messages to detect the user's language.",
        "- If the user's language is unclear, use English.",
        "- You can write Arabic, English, Japanese, and other user languages when they are clear from the issue or recent messages.",
        "",
        "Ticket name rules:",
        "- The ticket name must be short, clear, English, lowercase, and Discord-channel friendly.",
        "- Use only English letters, numbers, hyphens, and underscores.",
        "- The ticket name should describe the actual issue, not filler words.",
        "- Remove filler words like i, want, need, help, please, a, an, the, to, for, with.",
        "- Good names: billing-refund, failed-payment, chargeback-review, ban-appeal, account-access.",
        "- Bad names: i-want-a, please-help-me, user-needs-help.",
        "",
        "User-facing message rules:",
        "- The text field must be written by you. Do not use a generic fallback sentence.",
        "- The text must reassure the user and explain what happened.",
        "- Mention that the ticket has been escalated to the selected support team by name.",
        "- Mention the escalation reason briefly.",
        "- Mention that the ticket was moved to the escalation category.",
        "- Mention that the ticket was renamed to the same name you put in data.name.",
        "- Do not include role mentions. The application handles mentions safely.",
        "- Keep it concise: 2 to 4 short sentences.",
        "- Do not claim that a human has already replied.",
        "",
        "Escalation JSON schema:",
        "{",
        '  "type": "action_request",',
        '  "action": "escalate_ticket",',
        '  "text": "AI-written user-facing escalation confirmation in the same language as the user. Include team, reason, move, and rename. Do not include role mentions.",',
        '  "data": {',
        '    "roleId": "configured_role_id_here",',
        '    "reason": "Short reason for escalation.",',
        '    "name": "billing-refund"',
        "  }",
        "}",
      ].join("\n"),
    },
    {
      role: "system",
      content: [
        `Server: ${interaction.guild?.name || "Unknown server"}`,
        `Ticket channel before escalation: ${interaction.channel?.name || "Unknown channel"}`,
        "",
        "Configured escalation roles:",
        formatRoutesForAi(routes),
        "",
        "Recent ticket messages:",
        recentMessages,
      ].join("\n"),
    },
    {
      role: "user",
      content: `Escalation request:\n${issue}`,
    },
  ];
}

async function handleAiEscalationModal(interaction) {
  await interaction.deferReply({
    flags: EPHEMERAL,
  });

  const ticket = await getOpenTicket(interaction);

  if (!ticket) {
    await interaction.editReply({
      content: "This ticket is no longer open or is not tracked by Pixy AI.",
    });
    return;
  }

  const routes = await getConfiguredAdminRoutes(interaction.guild);

  if (!routes.length) {
    await interaction.editReply({
      content:
        "No support roles are configured yet. Ask an admin to open `/pixy-setup` → **Human Support** and add a support route.",
    });
    return;
  }

  const issue = cleanText(interaction.fields.getTextInputValue("issue"));

  if (!issue) {
    await interaction.editReply({
      content: "Please explain the issue first.",
    });
    return;
  }

  let aiResult;

  try {
    const messages = await buildAiRoutingMessages({
      interaction,
      issue,
      routes,
    });

    aiResult = await generateAiReply({
      messages,
      guildId: interaction.guild.id,
    });
  } catch (error) {
    console.error("Manual AI escalation routing failed:", error);

    await interaction.editReply({
      content:
        "Pixy could not choose a support role right now. You can try again or choose a support role manually.",
      components: buildEscalateChoiceComponents(interaction),
    });
    return;
  }

  const parsed = parseAiOutput(aiResult.text);

  if (
    parsed.kind !== "action_request" ||
    parsed.action !== TICKET_ACTIONS.ESCALATE_TICKET
  ) {
    await interaction.editReply({
      content:
        parsed.text ||
        "Pixy could not clearly choose the best support role. You can explain the issue again or choose a support role manually.",
      components: buildEscalateChoiceComponents(interaction),
    });
    return;
  }

  const normalized = normalizeParsedEscalationAction(parsed);

  if (!normalized.ok) {
    console.warn("AI escalation returned incomplete action:", {
      guildId: interaction.guild.id,
      channelId: interaction.channel.id,
      userId: interaction.user.id,
      code: normalized.code,
      raw: aiResult.text,
    });

    await interaction.editReply({
      content:
        "Pixy could not prepare a complete escalation message. Please try again with more details or choose a support role manually.",
      components: buildEscalateChoiceComponents(interaction),
    });
    return;
  }

  const result = await runValidatedActionFromInteraction({
    interaction,
    ticket,
    actionRequest: normalized.actionRequest,
  });

  if (!result.ok) {
    console.warn("Manual AI escalation rejected:", {
      guildId: interaction.guild.id,
      channelId: interaction.channel.id,
      userId: interaction.user.id,
      code: result.code,
    });

    await interaction.editReply({
      content:
        "Pixy could not complete the escalation automatically. Please choose a support role manually.",
      components: buildEscalateChoiceComponents(interaction),
    });
    return;
  }

  await interaction.editReply({
    content: "Done. This ticket has been escalated.",
    components: [],
  });
}

async function buildAssistedRoleEscalationMessages({ interaction, issue, route }) {
  const recentMessages = await getRecentTicketMessages(interaction.channel);

  return [
    {
      role: "system",
      content: [
        "You are Pixy AI, a Discord ticket escalation assistant.",
        "The user already selected the support role. Your job is to prepare a complete safe escalation action.",
        "",
        "Role rules:",
        "- You must use the selected roleId only.",
        "- Do not choose another role.",
        "- Return one valid JSON object only.",
        "- Do not include markdown fences.",
        "- Do not include role mentions in text.",
        "",
        "Language rules:",
        "- Write the text field in the same language as the user's issue/explanation.",
        "- Also use recent ticket messages to detect the user's language.",
        "- If the user's language is unclear, use English.",
        "- You can write Arabic, English, Japanese, and other user languages when they are clear from the issue or recent messages.",
        "",
        "Ticket name rules:",
        "- Create a short, clear, English, lowercase Discord-channel-friendly ticket name.",
        "- Use only English letters, numbers, hyphens, and underscores for the ticket name.",
        "- The ticket name should describe the actual issue, not filler words.",
        "- Remove filler words like i, want, need, help, please, a, an, the, to, for, with.",
        "- Use the selected role context to make the name better.",
        "- Good names: billing-refund, failed-payment, chargeback-review, account-access, ban-appeal.",
        "- Bad names: i-want-a, please-help-me, user-needs-help.",
        "",
        "User-facing message rules:",
        "- The text field must be written by you. Do not use a generic fallback sentence.",
        "- The text must reassure the user and explain what happened.",
        "- Mention that the ticket has been escalated to the selected support team by name.",
        "- Mention the escalation reason briefly.",
        "- Mention that the ticket was moved to the escalation category.",
        "- Mention that the ticket was renamed to the same name you put in data.name.",
        "- Do not include role mentions. The application handles mentions safely.",
        "- Keep it concise: 2 to 4 short sentences.",
        "- Do not claim that a human has already replied.",
        "",
        "JSON schema:",
        "{",
        '  "type": "action_request",',
        '  "action": "escalate_ticket",',
        '  "text": "AI-written user-facing escalation confirmation in the same language as the user. Include team, reason, move, and rename. Do not include role mentions.",',
        '  "data": {',
        `    "roleId": "${route.roleId}",`,
        '    "reason": "Short reason for escalation.",',
        '    "name": "billing-refund"',
        "  }",
        "}",
      ].join("\n"),
    },
    {
      role: "system",
      content: [
        `Server: ${interaction.guild?.name || "Unknown server"}`,
        `Ticket channel before escalation: ${interaction.channel?.name || "Unknown channel"}`,
        "",
        "Selected support role:",
        `Role ID: ${route.roleId}`,
        `Role name: ${route.role.name}`,
        `Role handles: ${route.description}`,
        "",
        "Recent ticket messages:",
        recentMessages,
      ].join("\n"),
    },
    {
      role: "user",
      content: `User explanation for escalation:\n${issue}`,
    },
  ];
}

async function handleAssistedRoleEscalationModal(interaction, roleId) {
  await interaction.deferReply({
    flags: EPHEMERAL,
  });

  const ticket = await getOpenTicket(interaction);

  if (!ticket) {
    await interaction.editReply({
      content: "This ticket is no longer open or is not tracked by Pixy AI.",
    });
    return;
  }

  const routes = await getConfiguredAdminRoutes(interaction.guild);
  const route = routes.find((item) => item.roleId === roleId);

  if (!route) {
    await interaction.editReply({
      content:
        "This support role is no longer configured. Ask an admin to open `/pixy-setup` → **Human Support** and review the configured routes.",
    });
    return;
  }

  const issue = cleanText(interaction.fields.getTextInputValue("issue"));

  if (!issue) {
    await interaction.editReply({
      content: "Please explain the issue first.",
    });
    return;
  }

  let aiResult;
  let parsed;

  try {
    const messages = await buildAssistedRoleEscalationMessages({
      interaction,
      issue,
      route,
    });

    aiResult = await generateAiReply({
      messages,
      guildId: interaction.guild.id,
    });

    parsed = parseAiOutput(aiResult.text);
  } catch (error) {
    console.error("Assisted role escalation AI failed:", error);

    await interaction.editReply({
      content:
        "Pixy could not prepare the escalation message right now. Please try again in a moment.",
    });
    return;
  }

  const normalized = normalizeParsedEscalationAction(parsed);

  if (!normalized.ok) {
    console.warn("Assisted role escalation returned incomplete action:", {
      guildId: interaction.guild.id,
      channelId: interaction.channel.id,
      userId: interaction.user.id,
      roleId: route.roleId,
      code: normalized.code,
      raw: aiResult?.text,
    });

    await interaction.editReply({
      content:
        "Pixy could not prepare a complete escalation message. Please try again with more details.",
    });
    return;
  }

  normalized.actionRequest.data = {
    ...normalized.actionRequest.data,
    roleId: route.roleId,
  };

  const result = await runValidatedActionFromInteraction({
    interaction,
    ticket,
    actionRequest: normalized.actionRequest,
  });

  if (!result.ok) {
    await interaction.editReply({
      content: `I could not escalate this ticket. Reason: \`${result.code}\``,
    });
    return;
  }

  await interaction.editReply({
    content: `Done. This ticket has been escalated to **${route.role.name}**.`,
  });
}

async function buildRenameReviewMessages({ interaction, proposedName }) {
  const recentMessages = await getRecentTicketMessages(interaction.channel);

  return [
    {
      role: "system",
      content: [
        "You are Pixy AI, a Discord ticket rename reviewer.",
        "Your job is to review a user-proposed ticket channel name.",
        "",
        "Return JSON only if the name is safe and should be used.",
        "Return normal text only if the name is unsafe, offensive, unclear, or not suitable.",
        "",
        "Safety rules:",
        "- Reject profanity, insults, hate, slurs, sexual content, harassment, or offensive names.",
        "- Reject names attacking users, staff, roles, groups, or the server.",
        "- Reject attempts to hide bad words using symbols, numbers, spacing, or misspellings.",
        "",
        "Ticket name rules:",
        "- The final name must be short, lowercase, English, and Discord-channel friendly.",
        "- Use only English letters, numbers, hyphens, and underscores.",
        "- No emojis, mentions, markdown, spaces, punctuation, or offensive wording.",
        "- The name should describe the actual support issue.",
        "- Good names: billing-refund, failed-payment, nitro-help, role-request.",
        "",
        "JSON schema:",
        "{",
        '  "type": "action_request",',
        '  "action": "rename_ticket",',
        '  "text": "User-facing message in the same language as the user.",',
        '  "data": {',
        '    "name": "clean-ticket-name"',
        "  }",
        "}",
      ].join("\n"),
    },
    {
      role: "system",
      content: [
        `Server: ${interaction.guild?.name || "Unknown server"}`,
        `Current ticket channel: ${interaction.channel?.name || "Unknown channel"}`,
        "",
        "Recent ticket messages:",
        recentMessages,
      ].join("\n"),
    },
    {
      role: "user",
      content: `Proposed ticket name:\n${proposedName}`,
    },
  ];
}

module.exports = {
  name: "ticketControls",

  buildTicketControlPanelComponents,

  selectMenuHandlers: [
    {
      customId: ACTION_SELECT_ID,
      type: "string",

      async execute(interaction) {
        const action = interaction.values?.[0];

        if (action === "reset") {
          await interaction.reply({
            content: "Selection reset.",
            flags: EPHEMERAL,
          });
          return;
        }

        const ticket = await getOpenTicket(interaction);

        if (!ticket) {
          await interaction.reply({
            content: "This ticket is no longer open or is not tracked by Pixy AI.",
            flags: EPHEMERAL,
          });
          return;
        }

        if (action === "close") {
          await interaction.reply({
            content: "Are you sure you want to close this ticket?",
            components: buildCloseConfirmComponents(interaction),
            flags: EPHEMERAL,
          });
          return;
        }

        if (action === "rename") {
          await interaction.showModal(buildRenameModal(interaction));
          return;
        }

        if (action === "escalate") {
          await interaction.reply({
            content: "How would you like to escalate this ticket?",
            components: buildEscalateChoiceComponents(interaction),
            flags: EPHEMERAL,
          });
          return;
        }

        await interaction.reply({
          content: "Unknown ticket action.",
          flags: EPHEMERAL,
        });
      },
    },
    {
      customIdPrefix: ESCALATE_ROLE_SELECT_PREFIX,
      type: "string",

      async execute(interaction) {
        const { userId, channelId } = parseScopedCustomId(
          interaction.customId,
          ESCALATE_ROLE_SELECT_PREFIX
        );

        if (!(await assertScopedInteraction(interaction, userId, channelId))) return;

        const roleId = interaction.values?.[0];

        if (roleId === "reset") {
          await interaction.reply({
            content: "Support role selection reset.",
            flags: EPHEMERAL,
          });
          return;
        }

        const routes = await getConfiguredAdminRoutes(interaction.guild);
        const route = routes.find((item) => item.roleId === roleId);

        if (!route) {
          await interaction.reply({
            content:
              "This support role is no longer configured. Ask an admin to open `/pixy-setup` → **Human Support** and review the configured routes.",
            flags: EPHEMERAL,
          });
          return;
        }

        await interaction.showModal(buildRoleEscalationModal(interaction, roleId));
      },
    },
  ],

  buttonHandlers: [
    {
      customIdPrefix: CLOSE_CONFIRM_PREFIX,

      async execute(interaction) {
        const { userId, channelId } = parseScopedCustomId(
          interaction.customId,
          CLOSE_CONFIRM_PREFIX
        );

        if (!(await assertScopedInteraction(interaction, userId, channelId))) return;

        // Defer before async work
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate();
        }

        const respond = createResponder(interaction);
        const ticket = await getOpenTicket(interaction);

        if (!ticket) {
          await respond({
            content: "This ticket is no longer open or is not tracked by Pixy AI.",
            components: [],
          });
          return;
        }

        await respond({
          content: "Closing this ticket...",
          components: [],
        });

        const result = await runValidatedActionFromInteraction({
          interaction,
          ticket,
          actionRequest: {
            kind: "action_request",
            action: TICKET_ACTIONS.CLOSE_TICKET,
            text: `Ticket close requested by ${interaction.user}. Closing this ticket now.`,
            data: {},
          },
        });

        if (!result.ok) {
          await interaction.followUp({
            content: `I could not close this ticket. Reason: \`${result.code}\``,
            flags: EPHEMERAL,
          });
        }
      },
    },
    {
      customIdPrefix: CLOSE_CANCEL_PREFIX,

      async execute(interaction) {
        const { userId, channelId } = parseScopedCustomId(
          interaction.customId,
          CLOSE_CANCEL_PREFIX
        );

        if (!(await assertScopedInteraction(interaction, userId, channelId))) return;

        const respond = createResponder(interaction);
        await respond({
          content: "Cancelled. This ticket was not closed.",
          components: [],
        });
      },
    },
    {
      customIdPrefix: ESCALATE_AI_PREFIX,

      async execute(interaction) {
        const { userId, channelId } = parseScopedCustomId(
          interaction.customId,
          ESCALATE_AI_PREFIX
        );

        if (!(await assertScopedInteraction(interaction, userId, channelId))) return;

        await interaction.showModal(buildAiEscalationModal(interaction));
      },
    },
    {
      customIdPrefix: ESCALATE_CHOOSE_PREFIX,

      async execute(interaction) {
        const { userId, channelId } = parseScopedCustomId(
          interaction.customId,
          ESCALATE_CHOOSE_PREFIX
        );

        if (!(await assertScopedInteraction(interaction, userId, channelId))) return;

        // Defer before async work
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate();
        }

        const respond = createResponder(interaction);
        const routes = await getConfiguredAdminRoutes(interaction.guild);

        if (!routes.length) {
          await respond({
            content:
              "No support roles are configured yet. Ask an admin to open `/pixy-setup` → **Human Support** and add a support route.",
            components: [],
          });
          return;
        }

        await respond({
          content: "Choose the support role that best matches this ticket:",
          components: buildConfiguredRoleSelectComponents(interaction, routes),
        });
      },
    },
  ],

  modalHandlers: [
    {
      customIdPrefix: RENAME_MODAL_PREFIX,

      async execute(interaction) {
        const { userId, channelId } = parseScopedCustomId(
          interaction.customId,
          RENAME_MODAL_PREFIX
        );

        if (!(await assertScopedInteraction(interaction, userId, channelId))) return;

        const ticket = await getOpenTicket(interaction);

        if (!ticket) {
          await interaction.reply({
            content: "This ticket is no longer open or is not tracked by Pixy AI.",
            flags: EPHEMERAL,
          });
          return;
        }

        const rawName = interaction.fields.getTextInputValue("ticket_name");
        const cleanedName = cleanText(rawName);

        const messages = await buildRenameReviewMessages({
          interaction,
          proposedName: cleanedName,
        });

        const aiResult = await generateAiReply({
          messages,
          guildId: interaction.guild.id,
        });

        const parsed = parseAiOutput(aiResult.text);

        if (
          parsed.kind !== "action_request" ||
          parsed.action !== TICKET_ACTIONS.RENAME_TICKET
        ) {
          await interaction.reply({
            content:
              parsed.text ||
              "This ticket name was not approved. Please use a clean, support-related name like `billing-refund`.",
            flags: EPHEMERAL,
          });
          return;
        }

        const result = await runValidatedActionFromInteraction({
          interaction,
          ticket,
          actionRequest: parsed,
        });

        if (!result.ok) {
          const messageByCode = {
            unsafe_ticket_name:
              "That ticket name was rejected because it looks unsafe or offensive. Please choose a clean support-related name.",
            invalid_ticket_name:
              "Invalid ticket name. Use lowercase English letters, numbers, hyphens, or underscores.",
            same_ticket_name:
              "This ticket already has that name.",
          };

          await interaction.reply({
            content:
              messageByCode[result.code] ||
              `I could not rename this ticket. Reason: \`${result.code}\``,
            flags: EPHEMERAL,
          });
          return;
        }

        await interaction.reply({
          content: `Done. Ticket renamed to **${result.validation.data.name}**.`,
          flags: EPHEMERAL,
        });
      },
    },
    {
      customIdPrefix: ESCALATE_AI_MODAL_PREFIX,

      async execute(interaction) {
        const { userId, channelId } = parseScopedCustomId(
          interaction.customId,
          ESCALATE_AI_MODAL_PREFIX
        );

        if (!(await assertScopedInteraction(interaction, userId, channelId))) return;

        await handleAiEscalationModal(interaction);
      },
    },
    {
      customIdPrefix: ESCALATE_ROLE_MODAL_PREFIX,

      async execute(interaction) {
        const { userId, channelId, roleId } = parseScopedCustomId(
          interaction.customId,
          ESCALATE_ROLE_MODAL_PREFIX
        );

        if (!(await assertScopedInteraction(interaction, userId, channelId))) return;

        await handleAssistedRoleEscalationModal(interaction, roleId);
      },
    },
  ],
};
