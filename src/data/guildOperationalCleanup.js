function normalizeGuildId(value) {
  const guildId = String(value || "").trim();
  if (!guildId) throw new TypeError("A guild ID is required for operational cleanup.");
  return guildId;
}

function getDefaultPrisma() {
  return require("../config/prisma").prisma;
}

function buildOperationalDeleteOperations(client, guildId) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const operations = [];

  if (client.workspaceAgentDelivery?.deleteMany) {
    operations.push(
      client.workspaceAgentDelivery.deleteMany({ where: { guildId: normalizedGuildId } })
    );
  }

  operations.push(
    client.aiUsageLog.deleteMany({ where: { guildId: normalizedGuildId } }),
    client.ticketChannel.deleteMany({ where: { guildId: normalizedGuildId } }),
    client.learnedAnswer.deleteMany({ where: { guildId: normalizedGuildId } }),
    client.adminRoute.deleteMany({ where: { guildId: normalizedGuildId } }),
    client.guildIgnoredChannel.deleteMany({ where: { guildId: normalizedGuildId } }),
    client.guildBlockedTerm.deleteMany({ where: { guildId: normalizedGuildId } }),
    client.guildAllowedTerm.deleteMany({ where: { guildId: normalizedGuildId } }),
    client.ticketSource.deleteMany({ where: { guildId: normalizedGuildId } }),
    client.guildAiConfig.deleteMany({ where: { guildId: normalizedGuildId } }),
    client.guildSetupState.deleteMany({ where: { guildId: normalizedGuildId } }),
    client.guildSetting.deleteMany({ where: { guildId: normalizedGuildId } }),
    client.guildConfig.deleteMany({ where: { guildId: normalizedGuildId } })
  );

  return operations;
}

async function deleteGuildOperationalData(guildId, options = {}) {
  const client = options.client || getDefaultPrisma();
  const normalizedGuildId = normalizeGuildId(guildId);
  const results = await client.$transaction(
    buildOperationalDeleteOperations(client, normalizedGuildId)
  );
  const totalDeleted = results.reduce(
    (sum, result) => sum + Number(result?.count || 0),
    0
  );

  return {
    guildId: normalizedGuildId,
    results,
    totalDeleted,
    billingPreserved: true,
  };
}

module.exports = {
  buildOperationalDeleteOperations,
  deleteGuildOperationalData,
  normalizeGuildId,
};
