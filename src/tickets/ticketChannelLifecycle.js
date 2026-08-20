const { prisma } = require("../config/prisma");
const {
  findMatchingSourceForChannel,
  listResolvedTicketSources,
} = require("../config/ticketSources");
const {
  loadGuildEntitlementState,
} = require("../billing/entitlementService");
const {
  buildModeAwareTicketControlPayload,
  findTicketControlMessage,
} = require("../components/ticketAiControls");
const {
  getTicketSurfaceSettings,
  isSupportedTicketChannel,
} = require("../utils/tickets/ticketSurface");

function collectionValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === "function") return Array.from(value.values());
  return [];
}

async function fetchGuildChannels(guild) {
  if (typeof guild?.channels?.fetch !== "function") return false;
  try {
    await guild.channels.fetch();
    return true;
  } catch {
    return false;
  }
}

async function fetchActiveGuildThreads(guild) {
  if (typeof guild?.channels?.fetchActiveThreads !== "function") {
    return { ok: false, threads: [] };
  }

  try {
    const fetched = await guild.channels.fetchActiveThreads();
    return {
      ok: true,
      threads: collectionValues(fetched?.threads),
    };
  } catch {
    return { ok: false, threads: [] };
  }
}

async function resolveGuildTicketSurface(guild, channelId) {
  const cached = guild?.channels?.cache?.get?.(channelId);
  if (cached) return cached;
  if (typeof guild?.channels?.fetch !== "function") return null;
  try {
    return await guild.channels.fetch(channelId);
  } catch {
    return null;
  }
}

async function resolveTicketChannelEligibility(channel, options = {}) {
  const client = options.client || prisma;
  if (!channel?.guild?.id) {
    return { eligible: false, code: "missing_guild" };
  }
  if (!isSupportedTicketChannel(channel)) {
    return { eligible: false, code: "unsupported_channel_type" };
  }

  const guildId = channel.guild.id;
  const config = options.config || await client.guildConfig.findUnique({
    where: { guildId },
  });

  if (!config?.enabled) {
    return { eligible: false, code: "guild_not_configured", config };
  }

  const sources = options.sources || await listResolvedTicketSources(guildId, { client });
  if (!sources.length) {
    return { eligible: false, code: "ticket_sources_not_configured", config, sources };
  }

  const source = findMatchingSourceForChannel(channel, sources);
  if (!source) {
    return { eligible: false, code: "outside_ticket_sources", config, sources };
  }

  let ignored = false;
  if (options.ignoredChannelIds instanceof Set) {
    ignored = options.ignoredChannelIds.has(channel.id);
  } else {
    ignored = Boolean(await client.guildIgnoredChannel.findUnique({
      where: {
        guildId_channelId: {
          guildId,
          channelId: channel.id,
        },
      },
    }));
  }

  if (ignored) {
    return {
      eligible: false,
      code: "ignored_channel",
      config,
      sources,
      source,
    };
  }

  return {
    eligible: true,
    code: "eligible",
    config,
    sources,
    source,
  };
}

async function ensureTicketControlMessage(channel, ticket, options = {}) {
  if (options.ensureControls === false) {
    return { ok: true, skipped: true, reused: false, message: null };
  }

  const client = options.client || prisma;
  const guildId = channel.guild.id;
  const [entitlement, settings] = await Promise.all([
    options.entitlement
      ? Promise.resolve(options.entitlement)
      : loadGuildEntitlementState(guildId, { client }),
    Object.prototype.hasOwnProperty.call(options, "settings")
      ? Promise.resolve(options.settings)
      : client.guildSetting.findUnique({ where: { guildId } }),
  ]);
  const surfaceSettings = getTicketSurfaceSettings(channel, settings);

  const payload = buildModeAwareTicketControlPayload(ticket.aiEnabled !== false, {
    plan: entitlement.plan,
    settings: surfaceSettings,
    channel,
    escalated: ticket.escalated === true,
  });

  const existing = await findTicketControlMessage(channel).catch(() => null);
  if (existing) {
    await existing.edit(payload);
    return { ok: true, reused: true, message: existing, payload };
  }

  const message = await channel.send(payload);
  return { ok: true, reused: false, message, payload };
}

async function createTicketRecord(client, guildId, channelId) {
  try {
    return {
      ticket: await client.ticketChannel.create({
        data: {
          guildId,
          channelId,
          closed: false,
          status: "open",
          aiEnabled: true,
        },
      }),
      created: true,
    };
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const concurrent = await client.ticketChannel.findUnique({ where: { channelId } });
    if (!concurrent) throw error;
    return { ticket: concurrent, created: false };
  }
}

async function trackTicketChannel(channel, options = {}) {
  const client = options.client || prisma;
  const eligibility = options.eligibility || await resolveTicketChannelEligibility(channel, { client });
  if (!eligibility.eligible) {
    return { tracked: false, code: eligibility.code, eligibility };
  }

  const guildId = channel.guild.id;
  const channelId = channel.id;
  const hasExistingOverride = Object.prototype.hasOwnProperty.call(options, "existingTicket");
  let ticket = hasExistingOverride
    ? options.existingTicket
    : await client.ticketChannel.findUnique({ where: { channelId } });

  if (ticket && ticket.guildId !== guildId) {
    return { tracked: false, code: "channel_owned_by_other_guild", ticket, eligibility };
  }

  let created = false;
  if (!ticket) {
    const createdResult = await createTicketRecord(client, guildId, channelId);
    ticket = createdResult.ticket;
    created = createdResult.created;
  }

  if (ticket.guildId !== guildId) {
    return { tracked: false, code: "channel_owned_by_other_guild", ticket, eligibility };
  }

  if (ticket.closed && options.reactivateClosed !== true) {
    return { tracked: false, code: "ticket_closed", ticket, eligibility };
  }
  if (ticket.closed && options.reactivateClosed === true) {
    ticket = await client.ticketChannel.update({
      where: { channelId },
      data: {
        closed: false,
        status: "open",
        aiEnabled: true,
        closedByAi: false,
        closedAt: null,
      },
    });
  }

  let control = null;
  if (created || options.ensureControls === "always") {
    try {
      control = await ensureTicketControlMessage(channel, ticket, {
        ...options,
        client,
      });
    } catch (error) {
      if (created) {
        await client.ticketChannel.deleteMany({
          where: { guildId, channelId },
        }).catch(() => null);
      }
      throw error;
    }
  }

  return {
    tracked: true,
    code: created ? "tracked_new" : "already_tracked",
    created,
    ticket,
    source: eligibility.source,
    eligibility,
    control,
  };
}

async function untrackTicketChannel(guildId, channelId, options = {}) {
  const client = options.client || prisma;
  if (!guildId || !channelId) return { count: 0 };
  return client.ticketChannel.deleteMany({
    where: {
      guildId: String(guildId),
      channelId: String(channelId),
    },
  });
}

async function reconcileTicketChannel(channel, options = {}) {
  const client = options.client || prisma;
  const eligibility = await resolveTicketChannelEligibility(channel, { client });

  if (!eligibility.eligible) {
    const guildId = channel?.guild?.id;
    const channelId = channel?.id;
    const removed = guildId && channelId
      ? await untrackTicketChannel(guildId, channelId, { client })
      : { count: 0 };
    return {
      tracked: false,
      code: eligibility.code,
      removed: Number(removed?.count || 0),
      eligibility,
    };
  }

  return trackTicketChannel(channel, {
    ...options,
    client,
    eligibility,
  });
}

async function cleanupDeletedTicketChannel(channel, options = {}) {
  const client = options.client || prisma;
  const guildId = channel?.guild?.id;
  const channelId = channel?.id;
  if (!guildId || !channelId) {
    return { ticketDeleted: 0, ignoredDeleted: 0, blacklistDeleted: 0 };
  }

  const operations = [
    client.ticketChannel.deleteMany({ where: { guildId, channelId } }),
    client.guildIgnoredChannel.deleteMany({ where: { guildId, channelId } }),
  ];
  const results = typeof client.$transaction === "function"
    ? await client.$transaction(operations)
    : await Promise.all(operations);
  const ignoredDeleted = Number(results[1]?.count || 0);

  return {
    ticketDeleted: Number(results[0]?.count || 0),
    ignoredDeleted,
    // Compatibility alias for older tests/callers.
    blacklistDeleted: ignoredDeleted,
  };
}

async function reconcileGuildTicketChannels(guild, options = {}) {
  const client = options.client || prisma;
  if (!guild?.id) {
    return { guildId: null, eligible: 0, created: 0, removed: 0, failed: 0, skipped: true };
  }

  const [channelsFetched, activeThreadResult] = await Promise.all([
    fetchGuildChannels(guild),
    fetchActiveGuildThreads(guild),
  ]);

  const guildId = guild.id;
  const [config, sources, ignoredEntries, existingTickets] = await Promise.all([
    client.guildConfig.findUnique({ where: { guildId } }),
    listResolvedTicketSources(guildId, { client }),
    client.guildIgnoredChannel.findMany({
      where: { guildId },
      select: { channelId: true },
    }),
    client.ticketChannel.findMany({ where: { guildId } }),
  ]);

  const ignoredChannelIds = new Set(ignoredEntries.map((entry) => entry.channelId));
  const visibleSurfaces = new Map();
  for (const channel of collectionValues(guild.channels?.cache)) {
    if (isSupportedTicketChannel(channel)) visibleSurfaces.set(channel.id, channel);
  }
  for (const thread of activeThreadResult.threads) {
    if (isSupportedTicketChannel(thread)) visibleSurfaces.set(thread.id, thread);
  }

  const eligibleChannels = new Map();
  if (config?.enabled && sources.length) {
    for (const channel of visibleSurfaces.values()) {
      const source = findMatchingSourceForChannel(channel, sources);
      if (!source || ignoredChannelIds.has(channel.id)) continue;
      eligibleChannels.set(channel.id, { channel, source, discovered: true });
    }
  }

  const removeIds = [];
  if (!config?.enabled || !sources.length) {
    removeIds.push(...existingTickets.map((ticket) => ticket.channelId));
  } else {
    for (const ticket of existingTickets) {
      if (eligibleChannels.has(ticket.channelId)) continue;

      const channel = visibleSurfaces.get(ticket.channelId) ||
        await resolveGuildTicketSurface(guild, ticket.channelId);
      if (!channel || !isSupportedTicketChannel(channel)) {
        removeIds.push(ticket.channelId);
        continue;
      }

      const source = findMatchingSourceForChannel(channel, sources);
      if (!source || ignoredChannelIds.has(channel.id)) {
        removeIds.push(ticket.channelId);
        continue;
      }

      // Archived threads are not returned by fetchActiveThreads(). Resolve
      // existing ticket IDs individually so an archived-but-valid thread is not
      // mistaken for a deleted ticket during startup reconciliation.
      eligibleChannels.set(channel.id, { channel, source, discovered: false });
    }
  }

  let removed = 0;
  if (removeIds.length) {
    const removedResult = await client.ticketChannel.deleteMany({
      where: {
        guildId,
        channelId: { in: [...new Set(removeIds)] },
      },
    });
    removed = Number(removedResult?.count || 0);
  }

  const existingIds = new Set(
    existingTickets
      .filter((ticket) => !removeIds.includes(ticket.channelId))
      .map((ticket) => ticket.channelId)
  );
  const missingChannels = [...eligibleChannels.values()]
    .filter(({ channel, discovered }) => discovered && !existingIds.has(channel.id));

  let created = 0;
  let failed = 0;
  let entitlement = null;
  let settings = null;
  if (missingChannels.length && options.ensureControls !== false) {
    [entitlement, settings] = await Promise.all([
      loadGuildEntitlementState(guildId, { client }),
      client.guildSetting.findUnique({ where: { guildId } }),
    ]);
  }

  for (const { channel, source } of missingChannels) {
    try {
      const result = await trackTicketChannel(channel, {
        client,
        existingTicket: null,
        entitlement,
        settings,
        ensureControls: options.ensureControls === false ? false : true,
        eligibility: {
          eligible: true,
          code: "eligible",
          config,
          sources,
          source,
        },
      });
      if (result.created) created += 1;
    } catch (error) {
      failed += 1;
      const logger = options.logger || console;
      logger.error?.(`Failed to reconcile Pixy ticket ${channel.id} in guild ${guildId}:`, error);
    }
  }

  return {
    guildId,
    eligible: eligibleChannels.size,
    created,
    removed,
    failed,
    skipped: false,
    channelsFetched,
    activeThreadsFetched: activeThreadResult.ok,
  };
}

module.exports = {
  cleanupDeletedTicketChannel,
  collectionValues,
  createTicketRecord,
  ensureTicketControlMessage,
  fetchActiveGuildThreads,
  fetchGuildChannels,
  isSupportedTicketChannel,
  reconcileGuildTicketChannels,
  reconcileTicketChannel,
  resolveGuildTicketSurface,
  resolveTicketChannelEligibility,
  trackTicketChannel,
  untrackTicketChannel,
};
