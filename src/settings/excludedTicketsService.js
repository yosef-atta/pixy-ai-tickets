const { ChannelType } = require("discord.js");
const { prisma } = require("../config/prisma");
const {
  findMatchingSourceForChannel,
  listResolvedTicketSources,
} = require("../config/ticketSources");
const {
  reconcileTicketChannel,
} = require("../tickets/ticketChannelLifecycle");

function cleanReason(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 300) : null;
}

async function getGuildChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  return guild.channels?.cache?.get(channelId) || guild.channels?.fetch?.(channelId).catch(() => null) || null;
}

async function listExcludedTickets(guildId, options = {}) {
  const client = options.client || prisma;
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 200));
  return client.guildIgnoredChannel.findMany({
    where: { guildId },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

async function validateExcludedTicketTarget(guild, channelId, options = {}) {
  const client = options.client || prisma;
  if (!guild?.id) return { ok: false, code: "missing_guild" };

  const sources = options.sources || await listResolvedTicketSources(guild.id, { client });
  if (!sources.length) {
    return { ok: false, code: "ticket_sources_not_configured", sources };
  }

  const channel = options.channel || await getGuildChannel(guild, channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    return { ok: false, code: "invalid_ticket_channel", sources, channel: null };
  }

  const source = findMatchingSourceForChannel(channel, sources);
  if (!source) {
    return { ok: false, code: "outside_ticket_sources", sources, channel };
  }

  return { ok: true, channel, source, sources };
}

async function excludeTicket(guild, channelId, reason, options = {}) {
  const client = options.client || prisma;
  const validation = await validateExcludedTicketTarget(guild, channelId, {
    ...options,
    client,
  });
  if (!validation.ok) return validation;

  const existing = await client.guildIgnoredChannel.findUnique({
    where: {
      guildId_channelId: {
        guildId: guild.id,
        channelId: validation.channel.id,
      },
    },
  });
  if (existing) {
    return {
      ok: false,
      code: "already_excluded",
      entry: existing,
      channel: validation.channel,
      source: validation.source,
    };
  }

  const normalizedReason = cleanReason(reason);
  let entry;
  if (typeof client.$transaction === "function") {
    [entry] = await client.$transaction([
      client.guildIgnoredChannel.create({
        data: {
          guildId: guild.id,
          channelId: validation.channel.id,
          reason: normalizedReason,
        },
      }),
      client.ticketChannel.deleteMany({
        where: { guildId: guild.id, channelId: validation.channel.id },
      }),
    ]);
  } else {
    entry = await client.guildIgnoredChannel.create({
      data: {
        guildId: guild.id,
        channelId: validation.channel.id,
        reason: normalizedReason,
      },
    });
    await client.ticketChannel.deleteMany({
      where: { guildId: guild.id, channelId: validation.channel.id },
    });
  }

  return {
    ok: true,
    entry,
    channel: validation.channel,
    source: validation.source,
  };
}

async function restoreExcludedTicket(guild, channelId, options = {}) {
  const client = options.client || prisma;
  const channel = await getGuildChannel(guild, channelId);
  const removed = await client.guildIgnoredChannel.deleteMany({
    where: { guildId: guild.id, channelId },
  });

  if (!removed?.count) {
    return { ok: false, code: "not_excluded", removed: 0, channel };
  }

  if (!channel) {
    return {
      ok: true,
      removed: Number(removed.count),
      reactivated: false,
      code: "channel_missing",
      channel: null,
    };
  }

  const reconcile = options.reconcile || reconcileTicketChannel;
  const reconciliation = await reconcile(channel, {
    client,
    ensureControls: options.ensureControls !== false,
  }).catch((error) => ({ tracked: false, code: error?.code || "reconcile_failed", error }));

  return {
    ok: true,
    removed: Number(removed.count),
    reactivated: reconciliation?.tracked === true,
    code: reconciliation?.tracked === true ? "reactivated" : reconciliation?.code || "not_reactivated",
    channel,
    reconciliation,
  };
}

module.exports = {
  cleanReason,
  excludeTicket,
  getGuildChannel,
  listExcludedTickets,
  restoreExcludedTicket,
  validateExcludedTicketTarget,
};