const { ChannelType } = require("discord.js");
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

function collectionValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === "function") return Array.from(value.values());
  return [];
}

function isSupportedTicketChannel(channel) {
  return channel?.type === ChannelType.GuildText;
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

  const payload = buildModeAwareTicketControlPayload(ticket.aiEnabled !== false, {
    plan: entitlement.plan,
    settings,
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
    ticket = await client.ticketChannel.create({
      data: {
        guildId,
        channelId,
        closed: false,
        status: "open",
        aiEnabled: true,
      },
    });
    created = true;
  } else if (ticket.closed && options.reactivateClosed !== true) {
    return { tracked: false, code: "ticket_closed", ticket, eligibility };
  } else if (ticket.closed && options.reactivateClosed === true) {
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
    control = await ensureTicketControlMessage(channel, ticket, {
      ...options,
      client,
    });
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
  if (!guildId || !channelId) return { ticketDeleted: 0, blacklistDeleted: 0 };

  const operations = [
    client.ticketChannel.deleteMany({ where: { guildId, channelId } }),
    client.guildIgnoredChannel.deleteMany({ where: { guildId, channelId } }),
  ];
  const results = typeof client.$transaction === "function"
    ? await client.$transaction(operations)
    : await Promise.all(operations);

  return {
    ticketDeleted: Number(results[0]?.count || 0),
    blacklistDeleted: Number(results[1]?.count || 0),
  };
}

async function reconcileGuildTicketChannels(guild, options = {}) {
  const client = options.client || prisma;
  if (!guild?.id) {
    return { guildId: null, eligible: 0, created: 0, removed: 0, skipped: true };
  }

  await guild.channels?.fetch?.().catch(() => null);

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
  const channels = collectionValues(guild.channels?.cache);
  const eligibleChannels = new Map();

  if (config?.enabled && sources.length) {
    for (const channel of channels) {
      if (!isSupportedTicketChannel(channel)) continue;
      const source = findMatchingSourceForChannel(channel, sources);
      if (!source || ignoredChannelIds.has(channel.id)) continue;
      eligibleChannels.set(channel.id, { channel, source });
    }
  }

  const eligibleIds = [...eligibleChannels.keys()];
  const removeWhere = eligibleIds.length
    ? { guildId, channelId: { notIn: eligibleIds } }
    : { guildId };
  const removedResult = await client.ticketChannel.deleteMany({ where: removeWhere });

  const existingIds = new Set(
    existingTickets
      .filter((ticket) => eligibleChannels.has(ticket.channelId))
      .map((ticket) => ticket.channelId)
  );

  let created = 0;
  const [entitlement, settings] = eligibleChannels.size
    ? await Promise.all([
        loadGuildEntitlementState(guildId, { client }),
        client.guildSetting.findUnique({ where: { guildId } }),
      ])
    : [null, null];

  for (const { channel, source } of eligibleChannels.values()) {
    if (existingIds.has(channel.id)) continue;

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
  }

  return {
    guildId,
    eligible: eligibleChannels.size,
    created,
    removed: Number(removedResult?.count || 0),
    skipped: false,
  };
}

module.exports = {
  cleanupDeletedTicketChannel,
  collectionValues,
  ensureTicketControlMessage,
  isSupportedTicketChannel,
  reconcileGuildTicketChannels,
  reconcileTicketChannel,
  resolveTicketChannelEligibility,
  trackTicketChannel,
  untrackTicketChannel,
};
