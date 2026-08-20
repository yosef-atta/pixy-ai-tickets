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
  replaceThreadParentTicketSources,
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
const {
  isThreadParentChannel,
} = require("../utils/tickets/ticketSurface");

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

function normalizeSourceRefs(values) {
  const seen = new Set();
  const result = [];

  for (const value of values || []) {
    const type = String(value?.type || "").trim().toLowerCase();
    const sourceId = String(value?.sourceId || "").trim();
    if (!Object.values(TICKET_SOURCE_TYPES).includes(type) || !sourceId) continue;
    const key = `${type}:${sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ type, sourceId });
  }

  return result;
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

async function validateThreadParentIds(guild, parentIds) {
  const ids = normalizeIds(parentIds);
  if (!guild || !ids.length) return [];

  await guild.channels?.fetch?.().catch(() => null);
  const parents = [];
  for (const id of ids) {
    const cached = guild.channels?.cache?.get(id);
    const channel = cached || await guild.channels?.fetch?.(id).catch(() => null);
    if (isThreadParentChannel(channel)) parents.push(channel);
  }
  return parents;
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
  const activate = options.activate === true;

  const result = await withTransaction(client, async (tx) => {
    await ensureGuildConfig(guildId, { client: tx });
    const sources = await replaceCategoryTicketSources(guildId, ids, {
      client: tx,
      useTransaction: false,
    });
    await tx.guildConfig.update({
      where: { guildId },
      data: {
        enabled: activate,
        ticketCategoryId: ids[0],
      },
    });
    return sources;
  });

  if (activate && options.guild) {
    await (options.reconcileTickets || reconcileGuildTicketChannels)(options.guild, {
      client,
      ensureControls: options.ensureControls !== false,
      logger: options.logger,
    });
  }
  return result;
}

async function setThreadParents(guildId, parentIds, options = {}) {
  const client = options.client || prisma;
  const ids = normalizeIds(parentIds);
  if (!ids.length) throw new TypeError("At least one thread parent is required.");
  const activate = options.activate === true;

  const result = await withTransaction(client, async (tx) => {
    await ensureGuildConfig(guildId, { client: tx });
    const sources = await replaceThreadParentTicketSources(guildId, ids, {
      client: tx,
      useTransaction: false,
    });
    await tx.guildConfig.update({
      where: { guildId },
      data: { enabled: activate },
    });
    return sources;
  });

  if (activate && options.guild) {
    await (options.reconcileTickets || reconcileGuildTicketChannels)(options.guild, {
      client,
      ensureControls: options.ensureControls !== false,
      logger: options.logger,
    });
  }
  return result;
}

async function addTicketSources(guildId, refs, options = {}) {
  const client = options.client || prisma;
  const sourcesToAdd = normalizeSourceRefs(refs);
  if (!sourcesToAdd.length) return [];
  const activate = options.activate !== false;

  const result = await withTransaction(client, async (tx) => {
    const config = await ensureGuildConfig(guildId, { client: tx });
    for (const source of sourcesToAdd) {
      await upsertTicketSource({
        guildId,
        type: source.type,
        sourceId: source.sourceId,
        enabled: true,
      }, { client: tx });
    }

    const sources = await tx.ticketSource.findMany({
      where: { guildId, enabled: true },
      orderBy: [{ type: "asc" }, { createdAt: "asc" }],
    });
    const categorySources = sources.filter((source) =>
      source.type === TICKET_SOURCE_TYPES.CATEGORY
    );
    const activeCategoryIds = new Set(categorySources.map((source) => source.sourceId));
    const primaryCategoryId = activeCategoryIds.has(config.ticketCategoryId)
      ? config.ticketCategoryId
      : categorySources[0]?.sourceId || null;

    await tx.guildConfig.update({
      where: { guildId },
      data: {
        enabled: activate,
        ticketCategoryId: primaryCategoryId,
      },
    });
    return sources;
  });

  if (activate && options.guild) {
    await (options.reconcileTickets || reconcileGuildTicketChannels)(options.guild, {
      client,
      ensureControls: options.ensureControls !== false,
      logger: options.logger,
    });
  }
  return result;
}

async function addTicketCategories(guildId, categoryIds, options = {}) {
  return addTicketSources(
    guildId,
    normalizeIds(categoryIds).map((sourceId) => ({
      type: TICKET_SOURCE_TYPES.CATEGORY,
      sourceId,
    })),
    options
  );
}

async function addThreadParents(guildId, parentIds, options = {}) {
  return addTicketSources(
    guildId,
    normalizeIds(parentIds).map((sourceId) => ({
      type: TICKET_SOURCE_TYPES.THREAD_PARENT,
      sourceId,
    })),
    options
  );
}

async function removeTicketSources(guildId, refs, options = {}) {
  const client = options.client || prisma;
  const sourcesToRemove = normalizeSourceRefs(refs);
  if (!sourcesToRemove.length) return [];

  const remaining = await withTransaction(client, async (tx) => {
    await ensureGuildConfig(guildId, { client: tx });
    for (const source of sourcesToRemove) {
      await tx.ticketSource.deleteMany({
        where: {
          guildId,
          type: source.type,
          sourceId: source.sourceId,
        },
      });
    }

    const sources = await tx.ticketSource.findMany({
      where: { guildId, enabled: true },
      orderBy: [{ type: "asc" }, { createdAt: "asc" }],
    });
    const firstCategory = sources.find((source) =>
      source.type === TICKET_SOURCE_TYPES.CATEGORY
    );
    await tx.guildConfig.update({
      where: { guildId },
      data: {
        ticketCategoryId: firstCategory?.sourceId || null,
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

async function removeTicketCategories(guildId, categoryIds, options = {}) {
  return removeTicketSources(
    guildId,
    normalizeIds(categoryIds).map((sourceId) => ({
      type: TICKET_SOURCE_TYPES.CATEGORY,
      sourceId,
    })),
    options
  );
}

async function removeThreadParents(guildId, parentIds, options = {}) {
  return removeTicketSources(
    guildId,
    normalizeIds(parentIds).map((sourceId) => ({
      type: TICKET_SOURCE_TYPES.THREAD_PARENT,
      sourceId,
    })),
    options
  );
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
  const categoryChanged = config.escalationCategoryId !== categoryId;
  await client.guildConfig.update({
    where: { guildId: guild.id },
    data: {
      escalationCategoryId: categoryId,
      ...(categoryChanged ? { escalationNotificationChannelId: null } : {}),
    },
  });

  const ensureNotification = options.ensureNotification || getOrCreateEscalationNotificationChannel;
  const notification = await ensureNotification({
    guild,
    categoryId,
    existingChannelId: categoryChanged
      ? null
      : config.escalationNotificationChannelId || null,
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
  const reconcileTickets = options.reconcileTickets || reconcileGuildTicketChannels;

  const billing = await startTrial(guildId, {
    client,
    actorUserId: options.actorUserId,
    now: options.now,
  });

  await ensureGuildConfig(guildId, { client });
  await client.guildConfig.update({
    where: { guildId },
    data: { enabled: true },
  });

  if (options.guild) {
    await reconcileTickets(options.guild, {
      client,
      ensureControls: true,
      logger: options.logger,
    }).catch((error) => {
      (options.logger || console).error?.(
        "Failed to reconcile tickets after onboarding completion:",
        error
      );
    });
  }

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

async function listSetupTicketSources(guildId, options = {}) {
  return listTicketSources(guildId, options);
}

async function listCategoryTicketSources(guildId, options = {}) {
  const sources = await listTicketSources(guildId, options);
  return sources.filter((source) => source.type === TICKET_SOURCE_TYPES.CATEGORY);
}

async function listThreadParentTicketSources(guildId, options = {}) {
  const sources = await listTicketSources(guildId, options);
  return sources.filter((source) => source.type === TICKET_SOURCE_TYPES.THREAD_PARENT);
}

module.exports = {
  AUTO_ESCALATION_CATEGORY_NAMES,
  AUTO_TICKET_CATEGORY_NAMES,
  addThreadParents,
  addTicketCategories,
  addTicketSources,
  completeOnboarding,
  configureEscalationCategory,
  createOrFindEscalationCategory,
  createOrFindTicketCategory,
  getMaxAdminRoutes,
  listCategoryTicketSources,
  listSetupTicketSources,
  listThreadParentTicketSources,
  moveSetupToAiProvider,
  moveSetupToHumanSupport,
  normalizeIds,
  normalizeSourceRefs,
  removeSupportRoutes,
  removeThreadParents,
  removeTicketCategories,
  removeTicketSources,
  setEscalationEnabled,
  setThreadParents,
  setTicketCategories,
  skipHumanSupportAndComplete,
  upsertSupportRoute,
  validateCategoryIds,
  validateThreadParentIds,
};