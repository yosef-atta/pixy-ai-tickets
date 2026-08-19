const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");

const { prisma } = require("../src/config/prisma");
const {
  deleteGuildOperationalData,
} = require("../src/data/guildOperationalCleanup");

const ALPHA = "phase9-isolation-alpha";
const BETA = "phase9-isolation-beta";
const GUILDS = [ALPHA, BETA];

const OPERATIONAL_MODELS = [
  "aiUsageLog",
  "ticketChannel",
  "learnedAnswer",
  "adminRoute",
  "guildIgnoredChannel",
  "guildBlockedTerm",
  "guildAllowedTerm",
  "ticketSource",
  "guildAiConfig",
  "guildSetupState",
  "guildSetting",
  "guildConfig",
];

async function clearFixtureData() {
  for (const guildId of GUILDS) {
    await deleteGuildOperationalData(guildId, { client: prisma });
  }
  await prisma.billingEvent.deleteMany({ where: { guildId: { in: GUILDS } } });
  await prisma.guildBilling.deleteMany({ where: { guildId: { in: GUILDS } } });
}

async function createGuildFixture(guildId, suffix) {
  await prisma.guildConfig.create({
    data: {
      guildId,
      ticketCategoryId: `category-${suffix}`,
      escalationCategoryId: `escalation-${suffix}`,
    },
  });
  await prisma.guildSetting.create({
    data: {
      guildId,
      groqApiKeyEncrypted: `v1:${suffix}-placeholder:tag:ciphertext`,
      aiModel: "openai/gpt-oss-20b",
    },
  });

  await Promise.all([
    prisma.ticketSource.create({
      data: {
        guildId,
        type: "category",
        sourceId: `category-${suffix}`,
      },
    }),
    prisma.guildAiConfig.create({
      data: {
        guildId,
        provider: "groq",
        model: "openai/gpt-oss-20b",
        credentialEncrypted: `v1:${suffix}-provider:tag:ciphertext`,
      },
    }),
    prisma.guildSetupState.create({
      data: {
        guildId,
        setupVersion: 2,
        lastStep: "complete",
        completedAt: new Date("2026-08-19T12:00:00.000Z"),
      },
    }),
    prisma.learnedAnswer.create({
      data: {
        guildId,
        type: "qna",
        question: `${suffix} question`,
        answer: `${suffix} answer`,
      },
    }),
    prisma.adminRoute.create({
      data: {
        guildId,
        roleId: `role-${suffix}`,
        description: `${suffix} support route`,
      },
    }),
    prisma.guildIgnoredChannel.create({
      data: {
        guildId,
        channelId: `ignored-${suffix}`,
        reason: "Isolation fixture",
      },
    }),
    prisma.guildBlockedTerm.create({
      data: {
        guildId,
        term: `blocked-${suffix}`,
        normalizedTerm: `blocked-${suffix}`,
      },
    }),
    prisma.guildAllowedTerm.create({
      data: {
        guildId,
        term: `allowed-${suffix}`,
        normalizedTerm: `alowed-${suffix}`,
        reason: "Isolation fixture",
      },
    }),
    prisma.ticketChannel.create({
      data: {
        guildId,
        channelId: `ticket-${suffix}`,
      },
    }),
    prisma.aiUsageLog.create({
      data: {
        guildId,
        channelId: `ticket-${suffix}`,
        provider: "groq",
        model: "openai/gpt-oss-20b",
        status: "success",
      },
    }),
    prisma.guildBilling.create({
      data: {
        guildId,
        trialStartedAt: new Date("2026-08-12T12:00:00.000Z"),
        trialEndsAt: new Date("2026-08-19T12:00:00.000Z"),
      },
    }),
    prisma.billingEvent.create({
      data: {
        guildId,
        actorUserId: `actor-${suffix}`,
        action: "trial_started",
      },
    }),
  ]);
}

before(async () => {
  await clearFixtureData();
  await createGuildFixture(ALPHA, "alpha");
  await createGuildFixture(BETA, "beta");
});

after(async () => {
  await clearFixtureData();
  await prisma.$disconnect();
});

test("operational reset deletes exactly one guild while preserving another guild and billing continuity", async () => {
  const result = await deleteGuildOperationalData(ALPHA, { client: prisma });

  assert.equal(result.guildId, ALPHA);
  assert.equal(result.billingPreserved, true);
  assert.ok(result.totalDeleted >= OPERATIONAL_MODELS.length);

  for (const modelName of OPERATIONAL_MODELS) {
    assert.equal(
      await prisma[modelName].count({ where: { guildId: ALPHA } }),
      0,
      `${modelName} should be deleted for alpha`
    );
    assert.equal(
      await prisma[modelName].count({ where: { guildId: BETA } }),
      1,
      `${modelName} should remain for beta`
    );
  }

  assert.equal(await prisma.guildBilling.count({ where: { guildId: ALPHA } }), 1);
  assert.equal(await prisma.billingEvent.count({ where: { guildId: ALPHA } }), 1);
  assert.equal(await prisma.guildBilling.count({ where: { guildId: BETA } }), 1);
  assert.equal(await prisma.billingEvent.count({ where: { guildId: BETA } }), 1);
});
