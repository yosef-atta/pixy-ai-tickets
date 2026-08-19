const { prisma } = require("../config/prisma");
const { getOrCreateGuildSetting } = require("../config/ai");
const {
  TICKET_OPERATING_MODES,
  getTicketOperatingModePreferences,
  resolveTicketOperatingMode,
} = require("../features/ticketOperatingMode");
const {
  refreshOpenTicketControlsForGuild,
} = require("../billing/ticketControlRefresh");
const {
  preflightFullControlForGuild,
} = require("../utils/tickets/humanSupportPermissions");

const BEHAVIOR_FIELDS = Object.freeze([
  "aiReplyEnabled",
  "closeTicketEnabled",
  "renameReviewEnabled",
  "escalationEnabled",
  "agentActionsEnabled",
]);
const BEHAVIOR_FIELD_SET = new Set(BEHAVIOR_FIELDS);
const CONTROL_FIELDS = new Set([
  "closeTicketEnabled",
  "renameReviewEnabled",
  "escalationEnabled",
]);

function pickBehaviorSettings(settings = {}) {
  return Object.fromEntries(
    BEHAVIOR_FIELDS.map((field) => [field, settings?.[field] === true])
  );
}

function buildProspectiveSettings(current, patch) {
  return {
    ...current,
    ...Object.fromEntries(
      Object.entries(patch || {}).filter(([field]) => BEHAVIOR_FIELD_SET.has(field))
    ),
  };
}

function requiresControlRefresh(patch = {}) {
  return Object.keys(patch).some((field) => CONTROL_FIELDS.has(field));
}

async function withTransaction(client, callback) {
  if (typeof client.$transaction === "function") {
    return client.$transaction(async (tx) => callback(tx));
  }
  return callback(client);
}

async function saveBehaviorPatch(guild, patch, options = {}) {
  const client = options.client || prisma;
  const getSetting = options.getSetting || getOrCreateGuildSetting;
  const preflight = options.preflightFullControl || preflightFullControlForGuild;
  const refresh = options.refreshControls || refreshOpenTicketControlsForGuild;
  if (!guild?.id) return { ok: false, code: "missing_guild" };

  const normalizedPatch = Object.fromEntries(
    Object.entries(patch || {})
      .filter(([field]) => BEHAVIOR_FIELD_SET.has(field))
      .map(([field, value]) => [field, value === true])
  );
  if (!Object.keys(normalizedPatch).length) {
    return { ok: false, code: "empty_behavior_patch" };
  }

  const current = await getSetting(guild.id);
  const prospective = buildProspectiveSettings(current, normalizedPatch);
  const currentMode = resolveTicketOperatingMode(current);
  const nextMode = resolveTicketOperatingMode(prospective);

  if (
    nextMode === TICKET_OPERATING_MODES.FULL &&
    currentMode !== TICKET_OPERATING_MODES.FULL
  ) {
    const permissionCheck = await preflight(guild, { client });
    if (!permissionCheck.ok) {
      return {
        ok: false,
        code: permissionCheck.code || "full_control_preflight_failed",
        preflight: permissionCheck,
        current,
        prospective,
      };
    }
  }

  await withTransaction(client, async (tx) => {
    await tx.guildSetting.update({
      where: { guildId: guild.id },
      data: normalizedPatch,
    });

    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "aiReplyEnabled")) {
      await tx.guildConfig.updateMany({
        where: { guildId: guild.id },
        data: { aiEnabled: normalizedPatch.aiReplyEnabled },
      });
    }
  });

  const saved = {
    ...current,
    ...normalizedPatch,
  };

  let refreshResult = { ok: true, skipped: true };
  if (requiresControlRefresh(normalizedPatch) && options.skipRefresh !== true) {
    refreshResult = await refresh(guild.id, {
      client,
      guild,
      discordClient: options.discordClient,
      logger: options.logger,
    });
  }

  return {
    ok: true,
    settings: saved,
    mode: resolveTicketOperatingMode(saved),
    patch: normalizedPatch,
    refresh: refreshResult,
  };
}

async function setTicketOperatingMode(guild, mode, options = {}) {
  const preferences = getTicketOperatingModePreferences(mode);
  if (!preferences) {
    return { ok: false, code: "unsupported_ticket_operating_mode" };
  }

  if (mode === TICKET_OPERATING_MODES.FULL) {
    const client = options.client || prisma;
    const preflight = options.preflightFullControl || preflightFullControlForGuild;
    const permissionCheck = await preflight(guild, { client });
    if (!permissionCheck.ok) {
      return {
        ok: false,
        code: permissionCheck.code || "full_control_preflight_failed",
        preflight: permissionCheck,
      };
    }
  }

  return saveBehaviorPatch(guild, preferences, {
    ...options,
    // Full mode was checked above; avoid doing the same network-heavy preflight
    // twice while still allowing saveBehaviorPatch to protect direct toggles.
    preflightFullControl: mode === TICKET_OPERATING_MODES.FULL
      ? async () => ({ ok: true, issues: [] })
      : options.preflightFullControl,
  });
}

async function toggleBehaviorField(guild, field, options = {}) {
  if (!BEHAVIOR_FIELD_SET.has(field)) {
    return { ok: false, code: "unsupported_behavior_field" };
  }

  const getSetting = options.getSetting || getOrCreateGuildSetting;
  const current = await getSetting(guild.id);
  return saveBehaviorPatch(guild, { [field]: current[field] !== true }, {
    ...options,
    getSetting: async () => current,
  });
}

module.exports = {
  BEHAVIOR_FIELDS,
  BEHAVIOR_FIELD_SET,
  CONTROL_FIELDS,
  buildProspectiveSettings,
  pickBehaviorSettings,
  requiresControlRefresh,
  saveBehaviorPatch,
  setTicketOperatingMode,
  toggleBehaviorField,
};