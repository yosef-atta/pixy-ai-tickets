const dotenv = require("dotenv");

const DISCORD_SNOWFLAKE_PATTERN = /^[1-9]\d{16,19}$/;
const DEFAULT_PIXY_MCP_PORT = 3100;

function isDiscordSnowflake(value) {
  return DISCORD_SNOWFLAKE_PATTERN.test(String(value || "").trim());
}

function parseOwners(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((ownerId) => ownerId.trim())
      .filter(Boolean)
  );
}

function getOwnerConfiguration(env) {
  const owners = parseOwners(env.OWNERS);
  const paypalOwnerId = String(env.PAYPAL_OWNER_ID || "").trim() || null;
  const vodafoneOwnerId = String(env.VODAFONE_OWNER_ID || "").trim() || null;
  const errors = [];

  if (owners.size === 0) {
    errors.push("OWNERS must contain at least one Discord user ID");
  }

  const invalidOwners = [...owners].filter((ownerId) => !isDiscordSnowflake(ownerId));
  if (invalidOwners.length > 0) {
    errors.push("OWNERS contains invalid Discord user IDs");
  }

  if (!isDiscordSnowflake(paypalOwnerId)) {
    errors.push("PAYPAL_OWNER_ID must be a valid Discord user ID");
  }

  if (!isDiscordSnowflake(vodafoneOwnerId)) {
    errors.push("VODAFONE_OWNER_ID must be a valid Discord user ID");
  }

  return {
    owners,
    paypalOwnerId,
    vodafoneOwnerId,
    errors,
  };
}

function parseMcpPort(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return DEFAULT_PIXY_MCP_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PIXY_MCP_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function normalizePublicBaseUrl(value, { isProduction = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("PIXY_PUBLIC_BASE_URL must be a valid absolute URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("PIXY_PUBLIC_BASE_URL must use http or https");
  }
  if (isProduction && parsed.protocol !== "https:") {
    throw new Error("PIXY_PUBLIC_BASE_URL must use https in production");
  }

  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function loadEnv(env = process.env) {
  dotenv.config({ quiet: true });

  const token = env.DISCORD_TOKEN;
  const clientId = env.DISCORD_CLIENT_ID;
  const guildId = env.DISCORD_GUILD_ID;
  const prefix = env.PREFIX || "!";
  const nodeEnv = String(env.NODE_ENV || "development").toLowerCase();
  const isProduction = nodeEnv === "production";
  const ownerConfiguration = getOwnerConfiguration(env);
  const publicBaseUrl = normalizePublicBaseUrl(env.PIXY_PUBLIC_BASE_URL, { isProduction });
  const mcpPort = parseMcpPort(env.PIXY_MCP_PORT);

  const missing = [];
  if (!token) {
    missing.push("DISCORD_TOKEN");
  }
  if (!clientId) {
    missing.push("DISCORD_CLIENT_ID");
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  if (isProduction && ownerConfiguration.errors.length > 0) {
    throw new Error(
      `Invalid owner environment configuration: ${ownerConfiguration.errors.join("; ")}`
    );
  }

  return {
    token,
    clientId,
    guildId,
    prefix,
    nodeEnv,
    isProduction,
    owners: ownerConfiguration.owners,
    paypalOwnerId: ownerConfiguration.paypalOwnerId,
    vodafoneOwnerId: ownerConfiguration.vodafoneOwnerId,
    publicBaseUrl,
    mcpPort,
    workspaceAgentMcpEnabled: Boolean(publicBaseUrl),
  };
}

module.exports = {
  DEFAULT_PIXY_MCP_PORT,
  DISCORD_SNOWFLAKE_PATTERN,
  getOwnerConfiguration,
  isDiscordSnowflake,
  loadEnv,
  normalizePublicBaseUrl,
  parseMcpPort,
  parseOwners,
};
