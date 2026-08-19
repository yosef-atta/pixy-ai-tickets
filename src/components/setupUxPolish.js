const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require("discord.js");

const setup = require("../slash/setup");
const {
  removeSupportRoutes,
  upsertSupportRoute,
} = require("../setup/setupService");
const { createStringSelectMenus } = require("../utils/selectMenuHelper");

const EPHEMERAL = 64;
const DASHBOARD_NAV_PREFIX = "setup12_dashboard_nav:";
const { MODE, PREFIX } = setup;

const DASHBOARD_PAGES = Object.freeze({
  TICKET_SOURCES: "ticket_sources",
  AI_PROVIDER: "ai_provider",
  HUMAN_SUPPORT: "human_support",
  HEALTH: "health",
});

const scoped = (prefix, mode, userId) => `${prefix}${mode}:${userId}`;
const dashboardNavId = (userId) => `${DASHBOARD_NAV_PREFIX}${userId}`;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, max = 100) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3)).trim()}...`;
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

function dashboardMenu(userId) {
  return createStringSelectMenus({
    customId: dashboardNavId(userId),
    placeholder: "Choose a setup section...",
    includeReset: false,
    options: [
      {
        label: "Ticket Sources",
        description: "Categories and Thread Parents where Pixy tracks tickets",
        value: DASHBOARD_PAGES.TICKET_SOURCES,
        emoji: "🎫",
      },
      {
        label: "AI Provider",
        description: "Provider, API credential, and model",
        value: DASHBOARD_PAGES.AI_PROVIDER,
        emoji: "🤖",
      },
      {
        label: "Human Support",
        description: "Escalation destination and support role routes",
        value: DASHBOARD_PAGES.HUMAN_SUPPORT,
        emoji: "🧑‍💻",
      },
      {
        label: "Setup Health",
        description: "Review missing or broken setup resources",
        value: DASHBOARD_PAGES.HEALTH,
        emoji: "🩺",
      },
    ],
  });
}

function dashboardHomeRow(userId, label = "Refresh") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(scoped(PREFIX.HOME, MODE.MANAGE, userId))
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
  );
}

const originalRenderDashboard = setup.renderDashboard.bind(setup);
setup.renderDashboard = async function renderDashboardWithMenu(guild, userId, notice = null) {
  const payload = await originalRenderDashboard(guild, userId, notice);
  return {
    ...payload,
    components: [...dashboardMenu(userId), dashboardHomeRow(userId)],
  };
};

async function renderSetupHealth(guild, userId, notice = null) {
  const overview = await setup.loadSetupOverview(guild);
  const issues = overview.health.length
    ? overview.health.map((issue) => `• ${issue}`).join("\n")
    : "✅ Ready — no setup problems detected.";

  const embed = new EmbedBuilder()
    .setTitle("Setup Health")
    .setDescription([
      "Review the core resources Pixy depends on before changing behavior in `/pixy-settings`.",
      "If a configured Discord category, channel, role, or AI credential disappears later, it will show here.",
    ].join("\n"))
    .addFields(
      {
        name: "Status",
        value: issues,
        inline: false,
      },
      {
        name: "Configured",
        value: [
          `Ticket Sources: **${overview.sources.length}**`,
          `AI Provider: **${overview.ai.providerDefinition.displayName}**`,
          `Human Support Routes: **${overview.routes.length}**`,
          `Plan: **${overview.billing.planLabel}**`,
        ].join("\n"),
        inline: false,
      }
    );

  return {
    content: notice,
    embeds: [embed],
    components: [...dashboardMenu(userId), dashboardHomeRow(userId, "Back to Setup")],
  };
}

const homeHandler = setup.buttonHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.HOME
);
if (!homeHandler) {
  throw new Error("Pixy setup dashboard home handler is missing.");
}

homeHandler.execute = async function executeSetupHome(interaction) {
  const { userId } = setup.parseScoped(interaction.customId, PREFIX.HOME);
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);
  await editPanel(interaction, await setup.renderDashboard(interaction.guild, userId));
};

const originalRenderHumanSupport = setup.renderHumanSupport.bind(setup);
setup.renderHumanSupport = async function renderHumanSupportWithOnboardingRoutes(
  guild,
  userId,
  mode,
  notice = null
) {
  const payload = await originalRenderHumanSupport(guild, userId, mode, notice);
  if (mode !== MODE.ONBOARD) return payload;

  const human = await setup.loadHumanSupport(guild);
  if (payload.embeds?.[0]) {
    const embed = payload.embeds[0];
    const description = String(embed.data?.description || "");
    const guidance = "Add as many support roles as you need. Each role can describe what that team handles; when you're done, press **Finish Setup**.";
    if (!description.includes("Add as many support roles as you need")) {
      embed.setDescription(`${guidance}\n\n${description}`);
    }
  }

  if (!human.routes.length) return payload;

  const options = human.routeDetails.slice(0, 25).map(({ route, role }) => ({
    label: (role?.name || `Missing ${route.roleId.slice(-6)}`).slice(0, 100),
    value: route.id,
    description: truncate(route.description || "Remove this support route", 100),
  }));

  const removeRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(scoped(PREFIX.HUMAN_REMOVE_ROUTE, MODE.ONBOARD, userId))
      .setPlaceholder("Remove support roles from onboarding...")
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(options)
  );

  const components = [...(payload.components || [])];
  const finishRowIndex = Math.max(0, components.length - 1);
  components.splice(finishRowIndex, 0, removeRow);

  return {
    ...payload,
    components,
  };
};

const descriptionModalHandler = setup.modalHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.HUMAN_DESCRIPTION_MODAL
);
if (!descriptionModalHandler) {
  throw new Error("Pixy Human Support description modal handler is missing.");
}

descriptionModalHandler.execute = async function executeHumanDescriptionWithoutAutoFinish(interaction) {
  const { mode, userId, extra } = setup.parseScoped(
    interaction.customId,
    PREFIX.HUMAN_DESCRIPTION_MODAL
  );
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  const roleId = extra[0];
  const role = interaction.guild.roles.cache.get(roleId) ||
    await interaction.guild.roles.fetch(roleId).catch(() => null);
  if (!role || role.id === interaction.guild.id) {
    await editPanel(
      interaction,
      await setup.renderHumanSupport(
        interaction.guild,
        userId,
        mode,
        "That support role no longer exists."
      )
    );
    return;
  }

  const description = cleanText(
    interaction.fields.getTextInputValue("description")
  );

  try {
    await upsertSupportRoute(interaction.guild.id, role.id, description);
  } catch (error) {
    await editPanel(
      interaction,
      await setup.renderHumanSupport(
        interaction.guild,
        userId,
        mode,
        error?.message || "Could not save the support route."
      )
    );
    return;
  }

  const notice = mode === MODE.ONBOARD
    ? `Support route for **${role.name}** saved. Add another role if needed, or press **Finish Setup** when you're done.`
    : `Support route for **${role.name}** saved.`;

  await editPanel(
    interaction,
    await setup.renderHumanSupport(interaction.guild, userId, mode, notice)
  );
};

const removeRouteHandler = setup.selectMenuHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.HUMAN_REMOVE_ROUTE
);
if (!removeRouteHandler) {
  throw new Error("Pixy Human Support remove-route handler is missing.");
}

removeRouteHandler.execute = async function executeHumanRemoveRoutes(interaction) {
  const { mode, userId } = setup.parseScoped(
    interaction.customId,
    PREFIX.HUMAN_REMOVE_ROUTE
  );
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  const result = await removeSupportRoutes(
    interaction.guild.id,
    interaction.values || []
  );

  const notice = `Removed ${result.removed} support route${result.removed === 1 ? "" : "s"}.`;
  await editPanel(
    interaction,
    await setup.renderHumanSupport(interaction.guild, userId, mode, notice)
  );
};

module.exports = {
  selectMenuHandlers: [
    {
      customIdPrefix: DASHBOARD_NAV_PREFIX,
      type: "string",
      async execute(interaction) {
        const userId = String(interaction.customId || "").slice(DASHBOARD_NAV_PREFIX.length);
        if (!(await assertOwner(interaction, userId))) return;
        await deferUpdate(interaction);

        const page = interaction.values?.[0];
        let payload;
        if (page === DASHBOARD_PAGES.TICKET_SOURCES) {
          payload = await setup.renderTicketSourceManager(interaction.guild, userId);
        } else if (page === DASHBOARD_PAGES.AI_PROVIDER) {
          payload = await setup.renderAiProvider(interaction.guild.id, userId, MODE.MANAGE);
        } else if (page === DASHBOARD_PAGES.HUMAN_SUPPORT) {
          payload = await setup.renderHumanSupport(interaction.guild, userId, MODE.MANAGE);
        } else if (page === DASHBOARD_PAGES.HEALTH) {
          payload = await renderSetupHealth(interaction.guild, userId);
        } else {
          payload = await setup.renderDashboard(
            interaction.guild,
            userId,
            "Choose a valid setup section."
          );
        }

        await editPanel(interaction, payload);
      },
    },
  ],
  DASHBOARD_NAV_PREFIX,
  DASHBOARD_PAGES,
  dashboardMenu,
  renderSetupHealth,
};
