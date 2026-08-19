const {
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");
const { startTrialOnce } = require("../billing/billingService");
const {
  refreshOpenTicketControlsAfterBillingMutation,
} = require("../billing/ticketControlRefresh");
const { prisma } = require("../config/prisma");
const {
  ensureGuildConfig,
} = require("../config/guildConfigFoundation");
const {
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_MAX_ADMIN_ROUTES,
  SETUP_STEPS,
  TICKET_SOURCE_TYPES,
} = require("../config/productDefaults");
const {
  listTicketSources,
  replaceCategoryTicketSources,
  upsertTicketSource,
} = require("../config/ticketSources");
const {
  markSetupComplete,
  markSetupStep,
} = require("../config/setupState");
const {
  getOrCreateEscalationNotificationChannel,
} = require("../utils/tickets/escalationNotifications");
const {
  reconcileGuildTicketChannels,
} = require("../tickets/ticketChannelLifecycle");

const AUTO_TICKET_CATEGORY_NAMES = Object.freeze([
  "pixy-tickets",
  "pixy-support-tickets",
  "pixy-help-tickets",
]);
const AUTO_ESCALATION_CATEGORY_NAMES = Object.freeze([
  "pixy-escalated-tickets",
  "pixy-human-support",
  "pixy-admin-review",
]);

function normalizeIds(values) {
  return [...new Set((values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

async function withTransaction(client, callback) {
  if (typeof client.$transaction === "function") {
    return client.$transaction(async (tx) => callback(tx));
  }
  return callback(client);
}

async function getBotMember(guild) {
  if (!guild) return null;
  if (guild.members?.me) return guild.members.me;
  return guild.members?.fetchMe?.().catch(() => null) || null;
}

async function validateCategoryIds(guild, categoryIds) {
  const ids = normalizeIds(categoryIds);
  if (!guild || !ids.length) return [];

  await guild.channels?.fetch?.().catch(() => null);
  const categories = [];
  for (const id of ids) {
    const cached = guild.channels?.cache?.get(id);
    const channel = cached || await guild.channels?.fetch?.(id).catch(() => null);
    if (channel?.type === ChannelType.GuildCategory) categories.push(channel);
  }
  return categories;
}

async function createOrFindCategory(guild, names, reason) {
  if (!guild) return { ok: false, code: "missing_guild", category: null };
  await guild.channels?.fetch?.().catch(() => null);

  const wanted = new Set(names.map((name) => String(name).toLowerCase()));
  const existing = guild.channels?.cache?.find?.((channel) =>
    channel.type === ChannelType.GuildCategory &&
    wanted.has(String(channel.name || "").toLowerCase())
  );
  if (existing) return { ok: true, category: existing, created: false };

  const botMember = await getBotMember(guild);
  if (!botMember?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return {
      ok: false,
      code: "missing_manage_channels_permission",
      category: null,
    };
  }

  try {
    const category = await guild.channels.create({
      name: names[0],
      type: ChannelType.GuildCategory,
      reason,
    });
    return { ok: true, category, created: true };
  } catch {
    return { ok: false, code: "category_create_failed", category: null };
  }
}

async function createOrFindTicketCategory(guild) {
  return createOrFindCategory(
    guild,
    AUTO_TICKET_CATEGORY_NAMES,
    "Pixy AI ticket source setup"
  );
}

async function createOrFindEscalationCategory(guild) {
  return createOrFindCategory(
    guild,
    AUTO_ESCALATION_CATEGORY_NAMES,
    "Pixy AI human support setup"
  );
}

async function setTicketCategories(guildId, categoryIds, options = {}) {
  const client = options.client || prisma;
  const ids = normalizeIds(categoryIds);
  if (!ids.length) throw new TypeError("At least one ticket category is required.");

  const result = await withTransaction(client, async (tx) => {
    await ensureGuildConfig(guildId, { client: tx });
    const sources = await replaceCategoryTicketSources(guildId, ids, {
      client: tx,
      useTransaction: false,
    });
    await tx.guildConfig.update({
      where: { guildId },
      data: {
        enabled: true,
        ticketCategoryId: ids[0],
      },
    });
    return sources;
  });

  if (options.guild) {
    await (options.reconcileTickets || reconcileGuildTicketChannels)(options.guild, {
      client,
      ensureControls: options.ensureControls !== false,
      logger: options.logger,
    });
  }
  return result;
}

async function addTicketCategories(guildId, categoryIds, options = {}) {
  const client = options.client || prisma;
  const ids = normalizeIds(categoryIds);
  if (!ids.length) return [];

  const result = await withTransaction(client, async (tx) => {
    const config = await ensureGuildConfig(guildId, { client: tx });
    for (const sourceId of ids) {
      await upsertTicketSource({
        guildId,
        type: TICKET_SOURCE_TYPES.CATEGORY,
        sourceId,
        enabled: true,
      }, { client: tx });
    }

    const sources = await tx.ticketSource.findMany({
      where: {
        guildId,
        type: TICKET_SOURCE_TYPES.CATEGORY,
        enabled: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const activeIds = new Set(sources.map((source) => source.sourceId));
    const primary = activeIds.has(config.ticketCategoryId)
      ? config.ticketCategoryId
      : sources[0]?.sourceId || ids[0];

    await tx.guildConfig.update({
      where: { guildId },
      data: { enabled: true, ticketCategoryId: primary },
    });
    return sources;
  });

  if (options.guild) {
    await (options.reconcileTickets || reconcileGuildTicketChannels)(options.guild, {
      client,
      ensureControls: options.ensureControls !== false,
      logger: options.logger,
    });
  }
  return result;
}

async function removeTicketCategories(guildId, categoryIds, options = {}) {
  const client = options.client || prisma;
  const ids = normalizeIds(categoryIds);
  if (!ids.length) return [];

  const remaining = await withTransaction(client, async (tx) => {
    await ensureGuildConfig(guildId, { client: tx });
    await tx.ticketSource.deleteMany({
      where: {
        guildId,
        type: TICKET_SOURCE_TYPES.CATEGORY,
        sourceId: { in: ids },
      },
    });
    const sources = await tx.ticketSource.findMany({
      where: {
        guildId,
        type: TICKET_SOURCE_TYPES.CATEGORY,
        enabled: true,
      },
      orderBy: { createdAt: "asc" },
    });
    await tx.guildConfig.update({
      where: { guildId },
      data: {
        ticketCategoryId: sources[0]?.sourceId || null,
      },
    });
    return sources;
  });

  if (options.guild) {
    await (options.reconcileTickets || reconcileGuildTicketChannels)(options.guild, {
      client,
      ensureControls: options.ensureControls !== false,
      logger: options.logger,
    });
  }
  return remaining;
}

async function setEscalationEnabled(guildId, enabled, options = {}) {
  const client = options.client || prisma;
  return client.guildSetting.upsert({
    where: { guildId },
    create: {
      guildId,
      ...DEFAULT_GUILD_SETTINGS,
      escalationEnabled: enabled === true,
    },
    update: {
      escalationEnabled: enabled === true,
    },
  });
}

async function configureEscalationCategory(guild, categoryId, options = {}) {
  const client = options.client || prisma;
  if (!guild?.id) throw new TypeError("A guild is required to configure human support.");

  const config = await ensureGuildConfig(guild.id, { client });
  await client.guildConfig.update({
    where: { guildId: guild.id },
    data: { escalationCategoryId: categoryId },
  });

  const ensureNotification = options.ensureNotification || getOrCreateEscalationNotificationChannel;
  const notification = await ensureNotification({
    guild,
    categoryId,
    existingChannelId: config.escalationNotificationChannelId || null,
  });

  return {
    categoryId,
    notification,
  };
}

function getMaxAdminRoutes(config) {
  return Math.max(
    1,
    Math.min(Number(config?.maxAdminRoutes || DEFAULT_MAX_ADMIN_ROUTES), 25)
  );
}

async function upsertSupportRoute(guildId, roleId, description, options = {}) {
  const client = options.client || prisma;
  const normalizedRoleId = String(roleId || "").trim();
  const normalizedDescription = String(description || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedRoleId) throw new TypeError("A support role is required.");
  if (!normalizedDescription) throw new TypeError("A support role description is required.");

  const config = await ensureGuildConfig(guildId, { client });
  const maxRoutes = getMaxAdminRoutes(config);
  const [existing, totalRoutes] = await Promise.all([
    client.adminRoute.findUnique({
      where: { guildId_roleId: { guildId, roleId: normalizedRoleId } },
    }),
    client.adminRoute.count({ where: { guildId } }),
  ]);

  if (!existing && totalRoutes >= maxRoutes) {
    const error = new Error(`This server reached the support route limit: ${maxRoutes}.`);
    error.code = "support_route_limit_reached";
    error.maxRoutes = maxRoutes;
    throw error;
  }

  const route = await client.adminRoute.upsert({
    where: { guildId_roleId: { guildId, roleId: normalizedRoleId } },
    create: {
      guildId,
      roleId: normalizedRoleId,
      description: normalizedDescription,
      enabled: true,
    },
    update: {
      description: normalizedDescription,
      enabled: true,
    },
  });

  await setEscalationEnabled(guildId, true, { client });
  return {
    route,
    existing: Boolean(existing),
    totalRoutes: existing ? totalRoutes : totalRoutes + 1,
    maxRoutes,
  };
}

async function removeSupportRoutes(guildId, routeIds, options = {}) {
  const client = options.client || prisma;
  const ids = normalizeIds(routeIds);
  if (!ids.length) return { removed: 0, remaining: 0 };

  const removed = await client.adminRoute.deleteMany({
    where: {
      guildId,
      id: { in: ids },
    },
  });
  const remaining = await client.adminRoute.count({
    where: { guildId, enabled: true },
  });
  if (remaining === 0) {
    await setEscalationEnabled(guildId, false, { client });
  }
  return { removed: Number(removed?.count || 0), remaining };
}

async function completeOnboarding(guildId, options = {}) {
  const client = options.client || prisma;
  const startTrial = options.startTrial || startTrialOnce;
  const refreshControls = options.refreshControls || refreshOpenTicketControlsAfterBillingMutation;

  // Billing is initialized only after the required onboarding steps are ready.
  const billing = await startTrial(guildId, {
    client,
    actorUserId: options.actorUserId,
    now: options.now,
  });
  const state = await markSetupComplete(guildId, {
    client,
    now: options.now,
  });

  if (options.guild || options.discordClient) {
    await refreshControls(guildId, {
      client,
      guild: options.guild,
      discordClient: options.discordClient,
      logger: options.logger,
    }).catch((error) => {
      (options.logger || console).error?.(
        "Failed to refresh ticket controls after onboarding completion:",
        error
      );
    });
  }

  return { billing, state };
}

async function skipHumanSupportAndComplete(guildId, options = {}) {
  const client = options.client || prisma;
  await setEscalationEnabled(guildId, false, { client });
  return completeOnboarding(guildId, options);
}

async function moveSetupToAiProvider(guildId, options = {}) {
  return markSetupStep(guildId, SETUP_STEPS.AI_PROVIDER, options);
}

async function moveSetupToHumanSupport(guildId, options = {}) {
  return markSetupStep(guildId, SETUP_STEPS.HUMAN_SUPPORT, options);
}

async function listCategoryTicketSources(guildId, options = {}) {
  const sources = await listTicketSources(guildId, options);
  return sources.filter((source) => source.type === TICKET_SOURCE_TYPES.CATEGORY);
}

module.exports = {
  AUTO_ESCALATION_CATEGORY_NAMES,
  AUTO_TICKET_CATEGORY_NAMES,
  addTicketCategories,
  completeOnboarding,
  configureEscalationCategory,
  createOrFindEscalationCategory,
  createOrFindTicketCategory,
  getMaxAdminRoutes,
  listCategoryTicketSources,
  moveSetupToAiProvider,
  moveSetupToHumanSupport,
  normalizeIds,
  removeSupportRoutes,
  removeTicketCategories,
  setEscalationEnabled,
  setTicketCategories,
  skipHumanSupportAndComplete,
  upsertSupportRoute,
  validateCategoryIds,
};
