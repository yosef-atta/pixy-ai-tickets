const {
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");

const { prisma } = require("../../config/prisma");
const {
  listResolvedTicketSources,
} = require("../../config/ticketSources");
const {
  TICKET_SOURCE_TYPES,
} = require("../../config/productDefaults");
const {
  isFullTicketControlEnabled,
} = require("../../features/ticketOperatingMode");

const PERMISSION_LABELS = new Map([
  [PermissionFlagsBits.ViewChannel, "View Channel"],
  [PermissionFlagsBits.SendMessages, "Send Messages"],
  [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
  [PermissionFlagsBits.ManageChannels, "Manage Channels"],
  [PermissionFlagsBits.ManageRoles, "Manage Roles / Permissions"],
  [PermissionFlagsBits.MentionEveryone, "Mention @everyone, @here, and All Roles"],
]);

function permissionLabel(permission) {
  return PERMISSION_LABELS.get(permission) || String(permission);
}

async function getBotMember(guild) {
  if (!guild) return null;
  if (guild.members?.me) return guild.members.me;
  try {
    return await guild.members.fetchMe();
  } catch {
    return null;
  }
}

function getMissingPermissions(permissions, required = []) {
  if (!permissions) return [...required];
  return required.filter((permission) => !permissions.has(permission));
}

function formatPermissionList(permissions = []) {
  return permissions.map(permissionLabel).join(", ");
}

function buildIssue(scope, missingPermissions) {
  return {
    scope,
    missingPermissions,
    labels: missingPermissions.map(permissionLabel),
  };
}

async function preflightFullControlForTicket({
  guild,
  ticketChannel,
  destinationCategory,
} = {}) {
  const botMember = await getBotMember(guild || ticketChannel?.guild);
  if (!botMember) {
    return {
      ok: false,
      code: "bot_member_unavailable",
      issues: [{ scope: "bot", missingPermissions: [], labels: [] }],
    };
  }

  if (!ticketChannel || ticketChannel.type !== ChannelType.GuildText) {
    return {
      ok: false,
      code: "invalid_full_control_ticket_channel",
      issues: [],
    };
  }

  const issues = [];
  const guildMissing = getMissingPermissions(botMember.permissions, [
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
  ]);
  if (guildMissing.length) issues.push(buildIssue("server", guildMissing));

  const ticketMissing = getMissingPermissions(ticketChannel.permissionsFor(botMember), [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
  ]);
  if (ticketMissing.length) issues.push(buildIssue("ticket", ticketMissing));

  if (ticketChannel.manageable === false) {
    issues.push({
      scope: "ticket",
      code: "channel_not_manageable",
      missingPermissions: [],
      labels: ["Channel is not manageable by Pixy"],
    });
  }

  if (destinationCategory) {
    const destinationMissing = getMissingPermissions(
      destinationCategory.permissionsFor(botMember),
      [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]
    );
    if (destinationMissing.length) {
      issues.push(buildIssue("escalation_category", destinationMissing));
    }
  }

  return {
    ok: issues.length === 0,
    code: issues.length ? "full_control_preflight_failed" : null,
    issues,
  };
}

async function preflightFullControlForGuild(guild, options = {}) {
  const client = options.client || prisma;
  const botMember = await getBotMember(guild);
  if (!botMember) {
    return {
      ok: false,
      code: "bot_member_unavailable",
      issues: [{ scope: "bot", missingPermissions: [], labels: [] }],
    };
  }

  const issues = [];
  const guildMissing = getMissingPermissions(botMember.permissions, [
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
  ]);
  if (guildMissing.length) issues.push(buildIssue("server", guildMissing));

  const canLoadRoutes = Array.isArray(options.routes) || typeof client.adminRoute?.findMany === "function";
  const [sources, config, routes] = await Promise.all([
    options.sources || listResolvedTicketSources(guild.id, { client }),
    options.config || client.guildConfig.findUnique({
      where: { guildId: guild.id },
      select: { escalationCategoryId: true },
    }),
    Array.isArray(options.routes)
      ? Promise.resolve(options.routes)
      : canLoadRoutes
        ? client.adminRoute.findMany({
            where: { guildId: guild.id, enabled: true },
            select: { roleId: true },
            take: 25,
          })
        : Promise.resolve([]),
  ]);

  const [channelsFetched, rolesFetched] = await Promise.all([
    guild.channels.fetch().then(() => true).catch(() => false),
    guild.roles?.fetch?.().then(() => true).catch(() => false) || Promise.resolve(false),
  ]);

  for (const source of sources) {
    if (source.type !== TICKET_SOURCE_TYPES.CATEGORY) continue;
    const category = guild.channels.cache.get(source.sourceId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      if (channelsFetched) {
        issues.push({
          scope: `ticket_source:${source.sourceId}`,
          code: "invalid_ticket_source",
          missingPermissions: [],
          labels: ["Configured Ticket Source is missing"],
          sourceId: source.sourceId,
        });
      }
      continue;
    }

    const missing = getMissingPermissions(category.permissionsFor(botMember), [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
    ]);
    if (missing.length) {
      issues.push({
        ...buildIssue(`ticket_source:${source.sourceId}`, missing),
        sourceId: source.sourceId,
        sourceName: category.name,
      });
    }
  }

  if (!config?.escalationCategoryId) {
    issues.push({
      scope: "escalation_category",
      code: "missing_escalation_category",
      missingPermissions: [],
      labels: ["Human Support escalation category is not configured"],
    });
  } else {
    const destination = guild.channels.cache.get(config.escalationCategoryId);
    if (!destination || destination.type !== ChannelType.GuildCategory) {
      issues.push({
        scope: "escalation_category",
        code: channelsFetched ? "invalid_escalation_category" : "escalation_category_unavailable",
        missingPermissions: [],
        labels: [channelsFetched ? "Human Support escalation category is missing" : "Human Support escalation category could not be verified"],
      });
    } else {
      const destinationMissing = getMissingPermissions(
        destination.permissionsFor(botMember),
        [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]
      );
      if (destinationMissing.length) {
        issues.push({
          ...buildIssue("escalation_category", destinationMissing),
          sourceId: destination.id,
          sourceName: destination.name,
        });
      }
    }
  }

  if (canLoadRoutes) {
    if (!routes.length) {
      issues.push({
        scope: "human_support_routes",
        code: "missing_support_routes",
        missingPermissions: [],
        labels: ["At least one Human Support role route is required"],
      });
    } else if (!rolesFetched) {
      issues.push({
        scope: "human_support_routes",
        code: "support_roles_unavailable",
        missingPermissions: [],
        labels: ["Human Support roles could not be verified"],
      });
    } else {
      const hasValidRoute = routes.some(({ roleId }) =>
        roleId !== guild.id && guild.roles.cache.has(roleId)
      );
      if (!hasValidRoute) {
        issues.push({
          scope: "human_support_routes",
          code: "missing_support_routes",
          missingPermissions: [],
          labels: ["All configured Human Support roles are missing"],
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    code: issues.length ? "full_control_preflight_failed" : null,
    issues,
  };
}

async function getSetupPermissionIssues({
  guild,
  sources = [],
  config = null,
  settings = null,
} = {}) {
  const botMember = await getBotMember(guild);
  if (!botMember) return ["Pixy could not resolve its server member for permission checks."];

  await guild.channels.fetch().catch(() => null);
  const issues = [];
  const fullControl = isFullTicketControlEnabled(settings || {});

  for (const source of sources) {
    if (source.type !== TICKET_SOURCE_TYPES.CATEGORY) continue;
    const category = guild.channels.cache.get(source.sourceId);
    if (!category || category.type !== ChannelType.GuildCategory) continue;

    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ];
    if (fullControl) {
      required.push(PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles);
    }

    const missing = getMissingPermissions(category.permissionsFor(botMember), required);
    if (missing.length) {
      issues.push(
        `Ticket source **${category.name}** is missing: ${formatPermissionList(missing)}.`
      );
    }
  }

  const escalationCategory = config?.escalationCategoryId
    ? guild.channels.cache.get(config.escalationCategoryId)
    : null;
  const notificationChannel = config?.escalationNotificationChannelId
    ? guild.channels.cache.get(config.escalationNotificationChannelId)
    : null;

  if (settings?.escalationEnabled !== false && escalationCategory) {
    if (!notificationChannel) {
      const missing = getMissingPermissions(botMember.permissions, [
        PermissionFlagsBits.ManageChannels,
      ]);
      if (missing.length) {
        issues.push(
          `Human Support notification channel is missing and Pixy cannot recreate it without ${formatPermissionList(missing)}.`
        );
      }
    } else if (notificationChannel.type === ChannelType.GuildText) {
      const missing = getMissingPermissions(notificationChannel.permissionsFor(botMember), [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ]);
      if (missing.length) {
        issues.push(
          `Human Support notification channel is missing: ${formatPermissionList(missing)}.`
        );
      }
    }
  }

  if (fullControl) {
    const guildMissing = getMissingPermissions(botMember.permissions, [
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
    ]);
    if (guildMissing.length) {
      issues.push(`Full Ticket Control is missing: ${formatPermissionList(guildMissing)}.`);
    }

    if (escalationCategory?.type === ChannelType.GuildCategory) {
      const destinationMissing = getMissingPermissions(
        escalationCategory.permissionsFor(botMember),
        [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]
      );
      if (destinationMissing.length) {
        issues.push(
          `Escalation category **${escalationCategory.name}** is missing: ${formatPermissionList(destinationMissing)}.`
        );
      }
    }
  }

  return [...new Set(issues)];
}

module.exports = {
  formatPermissionList,
  getBotMember,
  getMissingPermissions,
  getSetupPermissionIssues,
  permissionLabel,
  preflightFullControlForGuild,
  preflightFullControlForTicket,
};