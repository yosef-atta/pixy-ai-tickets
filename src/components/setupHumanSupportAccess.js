const {
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");

const setup = require("../slash/setup");
const { prisma } = require("../config/prisma");
const {
  configureEscalationCategory,
  createOrFindEscalationCategory,
} = require("../setup/setupService");
const {
  prepareHumanSupportCategoryAccess,
  prepareHumanSupportNotificationAccess,
} = require("../setup/setupPermissionGate");

const EPHEMERAL = 64;
const { MODE, PREFIX } = setup;

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

function errorCode(error, fallback = "unknown_error") {
  return String(error?.code || error?.rawError?.code || fallback);
}

function logAccessFailure(category, result) {
  if (!result || result.ok) return;
  const error = result.error || null;
  console.warn(
    `[Pixy setup] Human Support category ${category?.id || "unknown"} auto-access failed: ${errorCode(error, result.code)}${error?.message ? ` - ${error.message}` : ""}`
  );
}

async function prepareHumanSupportResourcesBestEffort(guild, category, options = {}) {
  const configure = options.configureEscalationCategory || configureEscalationCategory;
  const prepareCategory = options.prepareHumanSupportCategoryAccess || prepareHumanSupportCategoryAccess;
  const prepareNotification = options.prepareHumanSupportNotificationAccess || prepareHumanSupportNotificationAccess;

  // Persist the admin's choice first. A best-effort overwrite must never make the
  // selected category disappear from setup just because Discord blocks the edit.
  let configured = await configure(guild, category.id);
  if (configured.notification?.ok) {
    return {
      ok: true,
      categorySaved: true,
      configured,
      categoryAccess: null,
    };
  }

  const categoryAccess = await prepareCategory(guild, category);
  if (!categoryAccess.ok) {
    logAccessFailure(category, categoryAccess);
    return {
      ok: false,
      code: categoryAccess.code || configured.notification?.code || "human_support_category_access_blocked",
      categorySaved: true,
      configured,
      categoryAccess,
    };
  }

  // Retry creation now that Pixy has attempted to prepare its category overwrite.
  configured = await configure(guild, category.id);
  if (configured.notification?.ok) {
    return {
      ok: true,
      categorySaved: true,
      configured,
      categoryAccess,
    };
  }

  const notificationChannel = configured.notification?.channel || null;
  if (notificationChannel) {
    const notificationAccess = await prepareNotification(
      notificationChannel,
      categoryAccess.member
    );
    if (!notificationAccess.ok) {
      console.warn(
        `[Pixy setup] Human Support notification channel ${notificationChannel.id || "unknown"} auto-access failed: ${errorCode(notificationAccess.error, notificationAccess.code)}`
      );
    } else {
      configured = await configure(guild, category.id);
    }
  }

  return {
    ok: Boolean(configured.notification?.ok),
    code: configured.notification?.code || "human_support_provision_failed",
    categorySaved: true,
    configured,
    categoryAccess,
  };
}

function humanSupportFailureNotice(category, result) {
  const name = category?.name ? `**${category.name}**` : "that category";
  const accessBlocked = result?.categoryAccess && result.categoryAccess.ok === false;

  if (accessBlocked) {
    return [
      `Saved ${name}, but Discord is blocking Pixy from managing that category even though the **6/6 server permission check passed**.`,
      "That means the category has its own permission overrides.",
      "For the quickest setup, choose **Create Automatically / Use Auto Category** so Pixy can create a clean Human Support location.",
      "If you want to keep this category, explicitly Allow Pixy's bot role **View Channel**, **Manage Channels**, and **Manage Roles** on that category, then retry.",
    ].join(" ");
  }

  return [
    `Saved ${name}, but Pixy could not finish the Human Support notification channel automatically.`,
    "Use **Create/Repair Notification Channel**, choose another category, or use **Auto Category**.",
  ].join(" ");
}

async function getSelectedCategory(interaction, categoryId) {
  const resolved = interaction.channels?.get?.(categoryId);
  if (resolved?.type === ChannelType.GuildCategory) return resolved;

  const cached = interaction.guild?.channels?.cache?.get?.(categoryId);
  if (cached?.type === ChannelType.GuildCategory) return cached;

  const fetched = await interaction.guild?.channels?.fetch?.(categoryId).catch(() => null);
  return fetched?.type === ChannelType.GuildCategory ? fetched : null;
}

async function createFreshAutoCategory(guild) {
  return guild.channels.create({
    name: "pixy-human-support",
    type: ChannelType.GuildCategory,
    reason: "Pixy AI Human Support setup fallback",
  });
}

async function getOrCreateWorkingAutoCategory(guild) {
  const first = await createOrFindEscalationCategory(guild);
  if (first.ok && first.category) {
    const prepared = await prepareHumanSupportResourcesBestEffort(guild, first.category);
    if (prepared.ok) {
      return { ok: true, category: first.category, prepared, created: first.created === true };
    }
  }

  try {
    const category = await createFreshAutoCategory(guild);
    const prepared = await prepareHumanSupportResourcesBestEffort(guild, category);
    return {
      ok: prepared.ok,
      category,
      prepared,
      created: true,
    };
  } catch (error) {
    return {
      ok: false,
      category: first?.category || null,
      prepared: first?.prepared || null,
      created: false,
      error,
    };
  }
}

const originalRenderHumanSupport = setup.renderHumanSupport.bind(setup);
setup.renderHumanSupport = async function renderHumanSupportWithSavedInaccessibleCategory(
  guild,
  userId,
  mode,
  notice = null
) {
  const payload = await originalRenderHumanSupport(guild, userId, mode, notice);
  const config = await prisma.guildConfig.findUnique({
    where: { guildId: guild.id },
    select: { escalationCategoryId: true },
  });

  if (!config?.escalationCategoryId || !payload.embeds?.[0]) return payload;

  const embed = payload.embeds[0];
  const description = String(embed.data?.description || "");
  if (!description.includes("Escalation category: Not configured")) return payload;

  embed.setDescription(
    description.replace(
      "Escalation category: Not configured",
      `Escalation category: Selected \`${config.escalationCategoryId}\` — **Pixy cannot currently access it**`
    )
  );
  return payload;
};

setup.prepareHumanSupportResources = prepareHumanSupportResourcesBestEffort;

const categorySelectHandler = setup.selectMenuHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.HUMAN_CATEGORY_SELECT
);
if (!categorySelectHandler) {
  throw new Error("Pixy Human Support category-select handler is missing.");
}

categorySelectHandler.execute = async function executeHumanCategorySelect(interaction) {
  const { mode, userId } = setup.parseScoped(interaction.customId, PREFIX.HUMAN_CATEGORY_SELECT);
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  const categoryId = interaction.values?.[0];
  const category = await getSelectedCategory(interaction, categoryId);
  if (!category) {
    await editPanel(
      interaction,
      await setup.renderHumanSupport(
        interaction.guild,
        userId,
        mode,
        "That category could not be resolved by Pixy. Choose another category or use Auto Category."
      )
    );
    return;
  }

  const prepared = await prepareHumanSupportResourcesBestEffort(interaction.guild, category);
  const notice = prepared.ok
    ? `Human Support category **${category.name}** and its notification channel are ready.`
    : humanSupportFailureNotice(category, prepared);

  await editPanel(
    interaction,
    await setup.renderHumanSupport(interaction.guild, userId, mode, notice)
  );
};

const categoryCreateHandler = setup.buttonHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.HUMAN_CATEGORY_CREATE
);
if (!categoryCreateHandler) {
  throw new Error("Pixy Human Support auto-category handler is missing.");
}

categoryCreateHandler.execute = async function executeHumanAutoCategory(interaction) {
  const { mode, userId } = setup.parseScoped(interaction.customId, PREFIX.HUMAN_CATEGORY_CREATE);
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  const result = await getOrCreateWorkingAutoCategory(interaction.guild);
  const notice = result.ok
    ? `Human Support category **${result.category.name}** and its notification channel are ready.`
    : "Pixy could not create a working Human Support category even after the 6/6 server permission check. Check the server audit log for a Discord-level deny, then try again.";

  await editPanel(
    interaction,
    await setup.renderHumanSupport(interaction.guild, userId, mode, notice)
  );
};

const retryHandler = setup.buttonHandlers.find(
  (handler) => handler.customIdPrefix === PREFIX.HUMAN_RETRY_NOTIFICATION
);
if (!retryHandler) {
  throw new Error("Pixy Human Support notification retry handler is missing.");
}

retryHandler.execute = async function executeHumanRetry(interaction) {
  const { mode, userId } = setup.parseScoped(interaction.customId, PREFIX.HUMAN_RETRY_NOTIFICATION);
  if (!(await assertOwner(interaction, userId))) return;
  await deferUpdate(interaction);

  const config = await prisma.guildConfig.findUnique({
    where: { guildId: interaction.guild.id },
    select: { escalationCategoryId: true },
  });
  if (!config?.escalationCategoryId) {
    await editPanel(
      interaction,
      await setup.renderHumanSupport(
        interaction.guild,
        userId,
        mode,
        "Choose a Human Support category first."
      )
    );
    return;
  }

  const category = await getSelectedCategory(interaction, config.escalationCategoryId);
  if (!category) {
    await editPanel(
      interaction,
      await setup.renderHumanSupport(
        interaction.guild,
        userId,
        mode,
        "The selected Human Support category is still inaccessible to Pixy. Choose another category or use Auto Category."
      )
    );
    return;
  }

  const prepared = await prepareHumanSupportResourcesBestEffort(interaction.guild, category);
  await editPanel(
    interaction,
    await setup.renderHumanSupport(
      interaction.guild,
      userId,
      mode,
      prepared.ok ? "Human Support resources are ready." : humanSupportFailureNotice(category, prepared)
    )
  );
};

module.exports = {
  getOrCreateWorkingAutoCategory,
  humanSupportFailureNotice,
  prepareHumanSupportResourcesBestEffort,
};
