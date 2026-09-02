require("dotenv").config({ quiet: true });

const { prisma } = require("../src/config/prisma");
const { syncGuildRagData } = require("../src/ai/ragSyncService");

async function main() {
  const guildId = String(process.argv[2] || "").trim();
  if (!guildId) {
    throw new Error("Usage: npm run rag:sync -- <guild-id>");
  }

  const result = await syncGuildRagData(guildId);
  if (!result.ok) {
    throw new Error(result.error || "RAG sync failed.");
  }

  console.log(
    `RAG sync complete for guild ${guildId}: ${result.sourceItems} source item(s), ${result.syncedChunks} chunk(s).`
  );
}

main()
  .catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => null);
  });
