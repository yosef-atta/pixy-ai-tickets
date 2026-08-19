const { prisma } = require("./prisma");
const { DEFAULT_AI_PROVIDER } = require("./productDefaults");
const {
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
} = require("../security/credentialEncryption");
const {
  getAiProvider,
  providerRegistry,
} = require("../ai/providers/providerRegistry");

function normalizeGuildId(value) {
  const guildId = String(value || "").trim();
  if (!guildId) throw new TypeError("A guild ID is required to load AI configuration.");
  return guildId;
}

function normalizeProvider(value) {
  return String(value || DEFAULT_AI_PROVIDER).trim().toLowerCase() || DEFAULT_AI_PROVIDER;
}

function getProviderCredentialType(provider) {
  const providerId = normalizeProvider(provider);
  if (providerRegistry.has(providerId)) {
    return getAiProvider(providerId).credentialType;
  }
  return `${providerId}-api-key`;
}

function createCredentialError(provider, credentialStatus) {
  const providerDefinition = getAiProvider(provider);
  const invalid = credentialStatus === "invalid";
  const error = new Error(
    invalid
      ? `This server's ${providerDefinition.displayName} credential must be replaced in /pixy-settings.`
      : `This server must configure a ${providerDefinition.displayName} credential in /pixy-settings.`
  );
  error.code = providerDefinition.id === "groq"
    ? invalid
      ? "invalid_guild_groq_api_key"
      : "missing_guild_groq_api_key"
    : invalid
      ? "invalid_guild_ai_credential"
      : "missing_guild_ai_credential";
  error.provider = providerDefinition.id;
  error.credentialStatus = credentialStatus;
  return error;
}

async function readLegacyAiConfig(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const [config, setting] = await Promise.all([
    client.guildConfig.findUnique({
      where: { guildId: normalizedGuildId },
      select: {
        aiProvider: true,
        aiModel: true,
        aiSystemPrompt: true,
      },
    }),
    client.guildSetting.findUnique({
      where: { guildId: normalizedGuildId },
      select: {
        groqApiKeyEncrypted: true,
        aiModel: true,
      },
    }),
  ]);

  const provider = normalizeProvider(config?.aiProvider);
  return {
    guildId: normalizedGuildId,
    provider,
    model: setting?.aiModel || config?.aiModel || null,
    credentialEncrypted:
      provider === "groq" ? setting?.groqApiKeyEncrypted || null : null,
    credentialType: getProviderCredentialType(provider),
    systemPrompt: config?.aiSystemPrompt || null,
  };
}

async function getOrCreateGuildAiConfig(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const existing = await client.guildAiConfig.findUnique({
    where: { guildId: normalizedGuildId },
  });
  if (existing) return existing;

  const legacy = await readLegacyAiConfig(normalizedGuildId, { client });
  try {
    return await client.guildAiConfig.create({ data: legacy });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    return client.guildAiConfig.findUniqueOrThrow({
      where: { guildId: normalizedGuildId },
    });
  }
}

async function resolveGuildAiConfig(guildId, options = {}) {
  const client = options.client || prisma;
  const record = await getOrCreateGuildAiConfig(guildId, { client });
  const providerDefinition = getAiProvider(record.provider || DEFAULT_AI_PROVIDER);
  const credentialType = String(
    record.credentialType || providerDefinition.credentialType
  ).trim();
  const model = String(record.model || providerDefinition.defaultModel).trim();

  let credential = null;
  let credentialStatus = providerDefinition.requiresCredential ? "missing" : "not_required";

  if (record.credentialEncrypted) {
    if (!isEncryptedCredential(record.credentialEncrypted)) {
      credentialStatus = "invalid";
    } else {
      try {
        credential = decryptCredential(record.credentialEncrypted, {
          guildId: record.guildId,
          credentialType,
        });
        credentialStatus = "configured";
      } catch {
        credentialStatus = "invalid";
      }
    }
  }

  if (options.requireCredential === true && providerDefinition.requiresCredential && !credential) {
    throw createCredentialError(providerDefinition.id, credentialStatus);
  }

  return {
    guildId: record.guildId,
    provider: providerDefinition.id,
    providerDefinition,
    model,
    modelSource: record.model ? "guild" : "provider_default",
    credential,
    credentialType,
    credentialStatus,
    systemPrompt: record.systemPrompt || null,
    record,
  };
}

async function withTransaction(client, callback) {
  if (typeof client.$transaction === "function") {
    return client.$transaction(async (tx) => callback(tx));
  }
  return callback(client);
}

async function saveGuildAiCredential(guildId, credential, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const existing = await getOrCreateGuildAiConfig(normalizedGuildId, { client });
  const providerId = normalizeProvider(options.provider || existing.provider);
  const providerDefinition = getAiProvider(providerId);
  const plaintext = String(credential || "").trim();
  if (providerDefinition.requiresCredential && !plaintext) {
    throw new TypeError(`${providerDefinition.displayName} credential cannot be empty.`);
  }

  const credentialType = providerDefinition.credentialType;
  const encrypted = plaintext
    ? encryptCredential(plaintext, {
        guildId: normalizedGuildId,
        credentialType,
      })
    : null;
  const nextModel = Object.prototype.hasOwnProperty.call(options, "model")
    ? options.model || null
    : existing.model || null;

  await withTransaction(client, async (tx) => {
    await tx.guildAiConfig.update({
      where: { guildId: normalizedGuildId },
      data: {
        provider: providerId,
        credentialEncrypted: encrypted,
        credentialType,
        model: nextModel,
      },
    });

    // Transitional dual-write for the current Groq UI and rollback safety.
    // GuildAiConfig is authoritative; these fields can be removed in a later cleanup migration.
    if (providerId === "groq" && tx.guildSetting?.upsert) {
      await tx.guildSetting.upsert({
        where: { guildId: normalizedGuildId },
        create: {
          guildId: normalizedGuildId,
          groqApiKeyEncrypted: encrypted,
          aiModel: nextModel,
        },
        update: {
          groqApiKeyEncrypted: encrypted,
          aiModel: nextModel,
        },
      });
    }
  });

  return resolveGuildAiConfig(normalizedGuildId, { client });
}

async function removeGuildAiCredential(guildId, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const existing = await getOrCreateGuildAiConfig(normalizedGuildId, { client });
  const clearModel = options.clearModel !== false;

  await withTransaction(client, async (tx) => {
    await tx.guildAiConfig.update({
      where: { guildId: normalizedGuildId },
      data: {
        credentialEncrypted: null,
        ...(clearModel ? { model: null } : {}),
      },
    });

    if (existing.provider === "groq" && tx.guildSetting?.upsert) {
      await tx.guildSetting.upsert({
        where: { guildId: normalizedGuildId },
        create: {
          guildId: normalizedGuildId,
          groqApiKeyEncrypted: null,
          ...(clearModel ? { aiModel: null } : {}),
        },
        update: {
          groqApiKeyEncrypted: null,
          ...(clearModel ? { aiModel: null } : {}),
        },
      });
    }
  });

  return resolveGuildAiConfig(normalizedGuildId, { client });
}

async function saveGuildAiModel(guildId, model, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const existing = await getOrCreateGuildAiConfig(normalizedGuildId, { client });
  const normalizedModel = String(model || "").trim() || null;

  await withTransaction(client, async (tx) => {
    await tx.guildAiConfig.update({
      where: { guildId: normalizedGuildId },
      data: { model: normalizedModel },
    });

    if (existing.provider === "groq" && tx.guildSetting?.upsert) {
      await tx.guildSetting.upsert({
        where: { guildId: normalizedGuildId },
        create: {
          guildId: normalizedGuildId,
          aiModel: normalizedModel,
        },
        update: {
          aiModel: normalizedModel,
        },
      });
    }
  });

  return resolveGuildAiConfig(normalizedGuildId, { client });
}

async function setGuildAiProvider(guildId, provider, options = {}) {
  const client = options.client || prisma;
  const normalizedGuildId = normalizeGuildId(guildId);
  const providerDefinition = getAiProvider(provider);
  const existing = await getOrCreateGuildAiConfig(normalizedGuildId, { client });
  if (existing.provider === providerDefinition.id) {
    return resolveGuildAiConfig(normalizedGuildId, { client });
  }

  await withTransaction(client, async (tx) => {
    await tx.guildAiConfig.update({
      where: { guildId: normalizedGuildId },
      data: {
        provider: providerDefinition.id,
        model: null,
        credentialEncrypted: null,
        credentialType: providerDefinition.credentialType,
      },
    });

    if (tx.guildSetting?.upsert) {
      await tx.guildSetting.upsert({
        where: { guildId: normalizedGuildId },
        create: {
          guildId: normalizedGuildId,
          groqApiKeyEncrypted: null,
          aiModel: null,
        },
        update: {
          groqApiKeyEncrypted: null,
          aiModel: null,
        },
      });
    }
  });

  return resolveGuildAiConfig(normalizedGuildId, { client });
}

async function syncGuildAiConfigFromLegacy(guildId, options = {}) {
  const client = options.client || prisma;
  const legacy = await readLegacyAiConfig(guildId, { client });

  return client.guildAiConfig.upsert({
    where: { guildId: legacy.guildId },
    create: legacy,
    update: {
      provider: legacy.provider,
      model: legacy.model,
      credentialEncrypted: legacy.credentialEncrypted,
      credentialType: legacy.credentialType,
      systemPrompt: legacy.systemPrompt,
    },
  });
}

module.exports = {
  createCredentialError,
  getOrCreateGuildAiConfig,
  getProviderCredentialType,
  normalizeGuildId,
  normalizeProvider,
  readLegacyAiConfig,
  removeGuildAiCredential,
  resolveGuildAiConfig,
  saveGuildAiCredential,
  saveGuildAiModel,
  setGuildAiProvider,
  syncGuildAiConfigFromLegacy,
};
