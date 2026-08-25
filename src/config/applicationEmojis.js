const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");
const { REST } = require("discord.js");

const MAX_APPLICATION_EMOJI_BYTES = 256 * 1024;
const APPLICATION_EMOJI_ROUTE = (clientId) => `/applications/${clientId}/emojis`;
const APPLICATION_EMOJI_ITEM_ROUTE = (clientId, emojiId) =>
  `/applications/${clientId}/emojis/${emojiId}`;
const EMOJI_ASSET_HASH_LENGTH = 8;

const BILLING_APPLICATION_EMOJIS = Object.freeze({
  paypal: Object.freeze({
    name: "pixy_paypal",
    filePath: path.join(__dirname, "../../assets/emojis/billing/paypal.png"),
    fallbackEmoji: "💳",
  }),
  vodafone: Object.freeze({
    name: "pixy_vodafone_cash",
    filePath: path.join(__dirname, "../../assets/emojis/billing/vodafone-cash.jpg"),
    fallbackEmoji: "📱",
  }),
  orange: Object.freeze({
    name: "pixy_orange_cash",
    filePath: path.join(__dirname, "../../assets/emojis/billing/orange-cash.png"),
    fallbackEmoji: "📱",
  }),
});

function getImageMimeType(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".avif") return "image/avif";
  throw new Error(`Unsupported application emoji image type: ${extension || "unknown"}`);
}

function readEmojiAsset(filePath, readFileSync = fs.readFileSync) {
  const buffer = readFileSync(filePath);
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("Application emoji asset reader must return a Buffer.");
  }
  if (buffer.length === 0) {
    throw new Error(`Application emoji asset is empty: ${filePath}`);
  }
  if (buffer.length > MAX_APPLICATION_EMOJI_BYTES) {
    throw new Error(`Application emoji asset exceeds Discord's 256 KiB limit: ${filePath}`);
  }
  return buffer;
}

function readEmojiDataUri(filePath, readFileSync = fs.readFileSync) {
  const buffer = readEmojiAsset(filePath, readFileSync);
  return `data:${getImageMimeType(filePath)};base64,${buffer.toString("base64")}`;
}

function getEmojiAssetHash(filePath, readFileSync = fs.readFileSync) {
  return crypto
    .createHash("sha256")
    .update(readEmojiAsset(filePath, readFileSync))
    .digest("hex")
    .slice(0, EMOJI_ASSET_HASH_LENGTH);
}

function getVersionedEmojiName(definition, readFileSync = fs.readFileSync) {
  const baseName = String(definition?.name || "").trim();
  if (!baseName) {
    throw new Error("Application emoji definition requires a name.");
  }

  const suffix = getEmojiAssetHash(definition.filePath, readFileSync);
  const maxBaseLength = 32 - suffix.length - 1;
  return `${baseName.slice(0, maxBaseLength)}_${suffix}`;
}

function normalizeApplicationEmoji(emoji, fallbackName) {
  const id = String(emoji?.id || "").trim();
  const name = String(emoji?.name || fallbackName || "").trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    animated: Boolean(emoji?.animated),
  };
}

function getApplicationEmojiItems(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.items) ? payload.items : [];
}

function isManagedEmojiName(name, baseName) {
  const normalizedName = String(name || "");
  const normalizedBase = String(baseName || "");
  return (
    normalizedName === normalizedBase ||
    normalizedName.startsWith(`${normalizedBase}_`)
  );
}

async function deleteStaleManagedEmojis({
  api,
  clientId,
  listedItems,
  baseName,
  activeEmojiId,
  onWarning = console.warn,
}) {
  const staleItems = listedItems.filter(
    (item) =>
      item?.id &&
      String(item.id) !== String(activeEmojiId) &&
      isManagedEmojiName(item.name, baseName)
  );

  for (const stale of staleItems) {
    try {
      await api.delete(APPLICATION_EMOJI_ITEM_ROUTE(clientId, stale.id));
    } catch (error) {
      onWarning(
        `Could not delete stale application emoji ${stale.name || stale.id}: ${error?.message || error}`
      );
    }
  }
}

async function syncBillingApplicationEmojis({
  token,
  clientId,
  rest = null,
  readFileSync = fs.readFileSync,
  definitions = BILLING_APPLICATION_EMOJIS,
  onWarning = console.warn,
} = {}) {
  const normalizedToken = String(token || "").trim();
  const normalizedClientId = String(clientId || "").trim();
  if (!normalizedToken || !normalizedClientId) {
    throw new Error("Discord token and client ID are required to sync application emojis.");
  }

  const api = rest || new REST({ version: "10" }).setToken(normalizedToken);
  const route = APPLICATION_EMOJI_ROUTE(normalizedClientId);
  const listed = getApplicationEmojiItems(await api.get(route));
  const byName = new Map(
    listed
      .filter((emoji) => emoji?.name)
      .map((emoji) => [String(emoji.name), emoji])
  );
  const synced = {};

  for (const [key, definition] of Object.entries(definitions)) {
    const versionedName = getVersionedEmojiName(definition, readFileSync);
    let emoji = normalizeApplicationEmoji(byName.get(versionedName), versionedName);

    if (!emoji) {
      const created = await api.post(route, {
        body: {
          name: versionedName,
          image: readEmojiDataUri(definition.filePath, readFileSync),
        },
      });
      emoji = normalizeApplicationEmoji(created, versionedName);
      if (emoji) byName.set(versionedName, created);
    }

    if (!emoji) {
      throw new Error(`Discord did not return a usable application emoji for ${definition.name}.`);
    }

    synced[key] = emoji;

    await deleteStaleManagedEmojis({
      api,
      clientId: normalizedClientId,
      listedItems: listed,
      baseName: definition.name,
      activeEmojiId: emoji.id,
      onWarning,
    });
  }

  return Object.freeze(synced);
}

function getBillingEmoji(appEmojis, methodKey) {
  const custom = normalizeApplicationEmoji(
    appEmojis?.[methodKey],
    BILLING_APPLICATION_EMOJIS[methodKey]?.name
  );
  return custom || BILLING_APPLICATION_EMOJIS[methodKey]?.fallbackEmoji || null;
}

function formatBillingEmoji(appEmojis, methodKey) {
  const custom = normalizeApplicationEmoji(
    appEmojis?.[methodKey],
    BILLING_APPLICATION_EMOJIS[methodKey]?.name
  );
  if (custom) {
    return `<${custom.animated ? "a" : ""}:${custom.name}:${custom.id}>`;
  }
  return BILLING_APPLICATION_EMOJIS[methodKey]?.fallbackEmoji || "";
}

module.exports = {
  APPLICATION_EMOJI_ITEM_ROUTE,
  APPLICATION_EMOJI_ROUTE,
  BILLING_APPLICATION_EMOJIS,
  EMOJI_ASSET_HASH_LENGTH,
  MAX_APPLICATION_EMOJI_BYTES,
  deleteStaleManagedEmojis,
  formatBillingEmoji,
  getApplicationEmojiItems,
  getBillingEmoji,
  getEmojiAssetHash,
  getImageMimeType,
  getVersionedEmojiName,
  isManagedEmojiName,
  normalizeApplicationEmoji,
  readEmojiAsset,
  readEmojiDataUri,
  syncBillingApplicationEmojis,
};
