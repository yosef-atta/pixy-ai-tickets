const assert = require("node:assert/strict");
const test = require("node:test");

const {
  importKnowledgeQnaBulk,
  parseBulkQnaText,
} = require("../src/settings/knowledgeService");

const GUILD_ID = "123456789012345678";

function createKnowledgeClient({ limit = 50, existing = [] } = {}) {
  const rows = existing.map((item, index) => ({
    id: item.id || `existing-${index + 1}`,
    guildId: GUILD_ID,
    type: "qna",
    question: item.question,
    answer: item.answer || "answer",
  }));

  return {
    guildConfig: {
      async findUnique() {
        return { guildId: GUILD_ID, maxLearnedItems: limit };
      },
    },
    learnedAnswer: {
      async count({ where } = {}) {
        return rows.filter((row) => {
          if (where?.guildId && row.guildId !== where.guildId) return false;
          if (where?.type && row.type !== where.type) return false;
          return true;
        }).length;
      },
      async findMany({ where } = {}) {
        return rows
          .filter((row) => {
            if (where?.guildId && row.guildId !== where.guildId) return false;
            if (where?.type && row.type !== where.type) return false;
            return true;
          })
          .map((row) => ({ question: row.question }));
      },
      async create({ data }) {
        const row = { id: `created-${rows.length + 1}`, ...data };
        rows.push(row);
        return { ...row };
      },
    },
    snapshot() {
      return rows.map((row) => ({ ...row }));
    },
  };
}

test("quick import parses English and Arabic Q/A markers with multiline answers", () => {
  const parsed = parseBulkQnaText(`
Q: What is included in Gold?
A: Priority advertising
and one featured slot.

س: مدة باقة الجولد كام؟
ج: الباقة مدتها شهر كامل.
`);

  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries[0], {
    question: "What is included in Gold?",
    answer: "Priority advertising and one featured slot.",
  });
  assert.deepEqual(parsed.entries[1], {
    question: "مدة باقة الجولد كام؟",
    answer: "الباقة مدتها شهر كامل.",
  });
  assert.equal(parsed.incomplete.length, 0);
});

test("quick import skips duplicate questions and respects the guild knowledge limit", async () => {
  const client = createKnowledgeClient({
    limit: 3,
    existing: [{ question: "What is included in Gold?" }],
  });

  const result = await importKnowledgeQnaBulk(
    GUILD_ID,
    `
Q: What is included in Gold?
A: Duplicate wording should be skipped.
Q: How much is Gold?
A: 100 credits.
Q: How long is Gold?
A: One month.
Q: Can Gold be renewed?
A: Yes.
`,
    { client }
  );

  assert.equal(result.ok, true);
  assert.equal(result.duplicates, 1);
  assert.equal(result.added, 2);
  assert.equal(result.skippedForLimit, 1);
  assert.equal(result.total, 3);
  assert.deepEqual(
    client.snapshot().map((row) => row.question),
    ["What is included in Gold?", "How much is Gold?", "How long is Gold?"]
  );
});

test("quick import reports incomplete pairs instead of inventing missing knowledge", async () => {
  const client = createKnowledgeClient();
  const result = await importKnowledgeQnaBulk(
    GUILD_ID,
    `
Q: Complete question
A: Complete answer
Q: Missing answer
`,
    { client }
  );

  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.equal(result.incomplete, 1);
  assert.equal(client.snapshot().length, 1);
});
