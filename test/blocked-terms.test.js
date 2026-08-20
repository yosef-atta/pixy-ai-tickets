/**
 * Regression coverage for Pixy's database-backed blocked-term system.
 *
 * The repository test runner owns schema reset/setup. This file intentionally
 * uses the shared isolated MySQL test database instead of creating a second
 * provider-specific database inside the test process.
 */

const assert = require("node:assert/strict");
const { after, before, beforeEach, test } = require("node:test");

const { prisma } = require("../src/config/prisma");
const {
  normalizeText,
  normalizeTerm,
  tokenize,
  compact,
  matchToken,
  matchPhrase,
  matchSubstring,
  checkTextAgainstTerms,
} = require("../src/utils/blockedTerms/normalization");
const {
  addGuildBlockedTerm,
  removeGuildBlockedTerm,
  addGuildAllowedTerm,
  removeGuildAllowedTerm,
  getBlockedTermsStats,
  checkBlockedTerms,
  getUnsafeTicketNameReason,
  isSafeTicketName,
  invalidateGuild,
  invalidateGlobal,
  MAX_GUILD_CUSTOM_TERMS,
} = require("../src/utils/blockedTerms");

const GUILD_ONE = "phase9-blocked-guild-1";
const GUILD_TWO = "phase9-blocked-guild-2";
const GUILDS = [GUILD_ONE, GUILD_TWO];
const GLOBAL_SOURCE = "phase9-test";

const GLOBAL_TERMS = [
  {
    term: "fuck",
    normalizedTerm: "fuck",
    category: "profanity",
    severity: "high",
    matchType: "token",
    source: GLOBAL_SOURCE,
  },
  {
    term: "shit",
    normalizedTerm: "shit",
    category: "profanity",
    severity: "medium",
    matchType: "token",
    source: GLOBAL_SOURCE,
  },
  {
    term: "bitch",
    normalizedTerm: "bitch",
    category: "profanity",
    severity: "high",
    matchType: "token",
    source: GLOBAL_SOURCE,
  },
  {
    term: "nigger",
    normalizedTerm: "nigger",
    category: "slurs",
    severity: "critical",
    matchType: "token",
    source: GLOBAL_SOURCE,
  },
  {
    term: "kill yourself",
    normalizedTerm: "kil-yourself",
    category: "violence",
    severity: "critical",
    matchType: "phrase",
    source: GLOBAL_SOURCE,
  },
  {
    term: "rape",
    normalizedTerm: "rape",
    category: "violence",
    severity: "critical",
    matchType: "token",
    source: GLOBAL_SOURCE,
  },
  {
    term: "pedophile",
    normalizedTerm: "pedophile",
    category: "violence",
    severity: "critical",
    matchType: "token",
    source: GLOBAL_SOURCE,
  },
];

async function clearGuildTerms() {
  await prisma.guildAllowedTerm.deleteMany({ where: { guildId: { in: GUILDS } } });
  await prisma.guildBlockedTerm.deleteMany({ where: { guildId: { in: GUILDS } } });
  for (const guildId of GUILDS) invalidateGuild(guildId);
}

before(async () => {
  await prisma.guildSetting.deleteMany({ where: { guildId: { in: GUILDS } } });
  await prisma.blockedTerm.deleteMany({ where: { source: GLOBAL_SOURCE } });

  await prisma.guildSetting.createMany({
    data: GUILDS.map((guildId) => ({ guildId })),
  });
  await prisma.blockedTerm.createMany({ data: GLOBAL_TERMS });
  invalidateGlobal();
});

beforeEach(async () => {
  await clearGuildTerms();
  invalidateGlobal();
});

after(async () => {
  await clearGuildTerms();
  await prisma.guildSetting.deleteMany({ where: { guildId: { in: GUILDS } } });
  await prisma.blockedTerm.deleteMany({ where: { source: GLOBAL_SOURCE } });
  invalidateGlobal();
  await prisma.$disconnect();
});

// Normalization -------------------------------------------------------------

test("normalization handles case, unicode, diacritics, and whitespace", () => {
  assert.equal(normalizeText("FUCK"), "fuck");
  assert.equal(normalizeText("ﬁsh"), "fish");
  assert.equal(normalizeText("café"), "cafe");
  assert.equal(normalizeText("  résumé  "), "resume");
});

test("normalization handles leet speak and separators", () => {
  assert.equal(normalizeText("f4ck"), "fack");
  assert.equal(normalizeText("sh1t"), "shit");
  assert.equal(normalizeText("b1tch"), "bitch");
  assert.equal(normalizeText("f_u.c k"), "f-u-c-k");
});

test("normalization collapses repeated characters", () => {
  assert.equal(normalizeText("fuuck"), "fuck");
  assert.equal(normalizeText("shiiit"), "shit");
  assert.equal(normalizeText("hello"), "helo");
});

test("normalization helpers expose stable normalized forms", () => {
  assert.equal(normalizeTerm(" Kill Yourself "), "kil-yourself");
  assert.deepEqual(tokenize(normalizeText("hello world")), ["helo", "world"]);
  assert.equal(compact(normalizeText("hello world")), "heloworld");
});

// Matching ------------------------------------------------------------------

test("token matching requires a complete token", () => {
  assert.equal(matchToken(["fuck", "you"], "fuck"), true);
  assert.equal(matchToken(["fucking"], "fuck"), false);
  assert.equal(matchToken(["truck"], "fuck"), false);
});

test("phrase matching requires consecutive normalized tokens", () => {
  assert.equal(
    matchPhrase(normalizeText("please kill yourself now").split("-"), "kil-yourself"),
    true
  );
  assert.equal(
    matchPhrase(normalizeText("kill me yourself").split("-"), "kil-yourself"),
    false
  );
});

test("substring matching avoids unrelated words", () => {
  assert.equal(matchSubstring("mypornographysite", "pornography"), true);
  assert.equal(matchSubstring("truck", "fuck"), false);
});

test("checkTextAgainstTerms ignores disabled and allowed matches", () => {
  const enabled = {
    term: "rape",
    normalizedTerm: "rape",
    category: "violence",
    severity: "critical",
    matchType: "token",
    enabled: true,
  };
  const disabled = { ...enabled, enabled: false };

  assert.equal(checkTextAgainstTerms("rape", [disabled]), null);
  assert.equal(checkTextAgainstTerms("rape", [enabled], new Set(["rape"])), null);
  assert.equal(checkTextAgainstTerms("grape", [enabled]), null);
});

// Guild isolation and management -------------------------------------------

test("guild custom blocked terms stay isolated", async () => {
  assert.equal((await addGuildBlockedTerm(GUILD_ONE, "custombad")).ok, true);
  assert.equal((await addGuildBlockedTerm(GUILD_TWO, "anotherbad")).ok, true);

  const first = await getBlockedTermsStats(GUILD_ONE);
  const second = await getBlockedTermsStats(GUILD_TWO);

  assert.ok(first.guildBlockedTerms.includes("custombad"));
  assert.ok(!first.guildBlockedTerms.includes("anotherbad"));
  assert.ok(second.guildBlockedTerms.includes("anotherbad"));
  assert.ok(!second.guildBlockedTerms.includes("custombad"));
});

test("guild allowlist overrides a global blocked term", async () => {
  assert.equal((await addGuildAllowedTerm(GUILD_ONE, "rape", "Known false positive")).ok, true);
  assert.equal(await checkBlockedTerms(GUILD_ONE, "rape"), null);
  assert.equal((await removeGuildAllowedTerm(GUILD_ONE, "rape")).ok, true);
});

test("duplicate custom terms are rejected after normalization", async () => {
  assert.equal((await addGuildBlockedTerm(GUILD_ONE, "CaseTest")).ok, true);

  const duplicate = await addGuildBlockedTerm(GUILD_ONE, "casetest");
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "already_exists");
});

test("global terms cannot be duplicated as guild custom terms", async () => {
  const result = await addGuildBlockedTerm(GUILD_ONE, "fuck");
  assert.equal(result.ok, false);
  assert.equal(result.code, "already_global");
});

test("empty custom terms are rejected and missing removals return not_found", async () => {
  assert.deepEqual(await addGuildBlockedTerm(GUILD_ONE, ""), {
    ok: false,
    code: "empty_term",
  });
  assert.equal((await addGuildBlockedTerm(GUILD_ONE, "   ")).code, "empty_term");
  assert.equal((await removeGuildBlockedTerm(GUILD_ONE, "missing-term")).code, "not_found");
});

test("custom blocked term limit remains enforced", async () => {
  assert.equal(MAX_GUILD_CUSTOM_TERMS, 100);

  const data = Array.from({ length: MAX_GUILD_CUSTOM_TERMS }, (_, index) => ({
    guildId: GUILD_ONE,
    term: `custom-${index}`,
    normalizedTerm: `custom-${index}`,
    category: "custom",
    severity: "medium",
    matchType: "token",
    enabled: true,
  }));
  await prisma.guildBlockedTerm.createMany({ data });
  invalidateGuild(GUILD_ONE);

  const result = await addGuildBlockedTerm(GUILD_ONE, "one-too-many");
  assert.equal(result.ok, false);
  assert.equal(result.code, "max_reached");
  assert.equal(result.max, MAX_GUILD_CUSTOM_TERMS);
});

test("stats report global, blocked, allowed, and remaining counts", async () => {
  await addGuildBlockedTerm(GUILD_ONE, "stats-test");
  await addGuildAllowedTerm(GUILD_ONE, "allowed-test");

  const stats = await getBlockedTermsStats(GUILD_ONE);
  assert.ok(stats.globalCount >= GLOBAL_TERMS.length);
  assert.equal(stats.guildBlockedCount, 1);
  assert.equal(stats.guildAllowedCount, 1);
  assert.equal(stats.remaining, MAX_GUILD_CUSTOM_TERMS - 1);
});

// Service integration -------------------------------------------------------

test("service returns global token and phrase matches", async () => {
  const tokenMatch = await checkBlockedTerms(GUILD_ONE, "you are a fuck");
  assert.equal(tokenMatch?.term, "fuck");
  assert.equal(tokenMatch?.category, "profanity");

  const phraseMatch = await checkBlockedTerms(GUILD_ONE, "go kill yourself now");
  assert.equal(phraseMatch?.term, "kill yourself");
  assert.equal(phraseMatch?.matchType, "phrase");

  assert.equal(await checkBlockedTerms(GUILD_ONE, "kill me yourself"), null);
  assert.equal(await checkBlockedTerms(GUILD_ONE, "hello world"), null);
});

test("leet-normalized service matching remains deterministic", async () => {
  assert.equal(await checkBlockedTerms(GUILD_ONE, "f4ck"), null);

  const match = await checkBlockedTerms(GUILD_ONE, "sh1t");
  assert.equal(match?.term, "shit");
});

test("substring terms work through the database-backed service", async () => {
  await prisma.blockedTerm.create({
    data: {
      term: "pornography",
      normalizedTerm: "pornography",
      category: "sexual",
      severity: "medium",
      matchType: "substring",
      source: GLOBAL_SOURCE,
    },
  });
  invalidateGlobal();

  const match = await checkBlockedTerms(GUILD_ONE, "mypornographysite");
  assert.equal(match?.term, "pornography");
});

test("ticket-name validators use the shared blocked-term service", async () => {
  const reason = await getUnsafeTicketNameReason(GUILD_ONE, "fuck-ticket");
  assert.equal(reason?.reason, "blocked_word");
  assert.equal(await getUnsafeTicketNameReason(GUILD_ONE, "help-ticket"), null);
  assert.equal(await isSafeTicketName(GUILD_ONE, "fuck-ticket"), false);
  assert.equal(await isSafeTicketName(GUILD_ONE, "help-ticket"), true);
});
