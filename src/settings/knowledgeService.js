const { prisma } = require("../config/prisma");
const { DEFAULT_MAX_LEARNED_ITEMS } = require("../config/productDefaults");

const KNOWLEDGE_TYPE_QNA = "qna";
const KNOWLEDGE_TYPE_FREEFORM = "freeform";
const DEFAULT_PAGE_SIZE = 8;
const MAX_PAGE_SIZE = 20;
const MAX_BULK_QNA_ITEMS = 20;

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForCompare(value) {
  return cleanText(value).toLowerCase();
}

function getKnowledgeLimit(config) {
  const configured = Number(config?.maxLearnedItems ?? DEFAULT_MAX_LEARNED_ITEMS);
  if (!Number.isFinite(configured)) return DEFAULT_MAX_LEARNED_ITEMS;
  return Math.max(0, Math.floor(configured));
}

function clampPageSize(value) {
  const numeric = Number(value || DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(numeric)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(Math.floor(numeric), MAX_PAGE_SIZE));
}

function parseBulkQnaText(value, options = {}) {
  const maxItems = Math.max(
    1,
    Math.min(Number(options.maxItems || MAX_BULK_QNA_ITEMS), MAX_BULK_QNA_ITEMS)
  );
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const entries = [];
  const incomplete = [];
  let current = null;
  let mode = null;
  let truncated = false;

  function flush() {
    if (!current) return;
    const question = cleanText(current.question);
    const answer = cleanText(current.answer);
    if (question && answer) {
      if (entries.length < maxItems) entries.push({ question, answer });
      else truncated = true;
    } else if (question || answer) {
      incomplete.push({ question, answer });
    }
    current = null;
    mode = null;
  }

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;

    const questionMatch = line.match(/^(?:q|question|س|سؤال)\s*[:：]\s*(.*)$/iu);
    if (questionMatch) {
      flush();
      current = { question: questionMatch[1] || "", answer: "" };
      mode = "question";
      continue;
    }

    const answerMatch = line.match(/^(?:a|answer|ج|جواب|إجابة|اجابة)\s*[:：]\s*(.*)$/iu);
    if (answerMatch) {
      if (!current) current = { question: "", answer: "" };
      current.answer = answerMatch[1] || "";
      mode = "answer";
      continue;
    }

    if (!current) {
      incomplete.push({ question: line, answer: "" });
      continue;
    }

    if (mode === "answer") current.answer = `${current.answer} ${line}`.trim();
    else current.question = `${current.question} ${line}`.trim();
  }

  flush();
  return {
    entries,
    incomplete,
    truncated,
    maxItems,
  };
}

async function getKnowledgeOverview(guildId, options = {}) {
  const client = options.client || prisma;
  const [config, total, qna, freeform] = await Promise.all([
    client.guildConfig.findUnique({
      where: { guildId },
      select: { maxLearnedItems: true },
    }),
    client.learnedAnswer.count({ where: { guildId } }),
    client.learnedAnswer.count({ where: { guildId, type: KNOWLEDGE_TYPE_QNA } }),
    client.learnedAnswer.count({ where: { guildId, type: KNOWLEDGE_TYPE_FREEFORM } }),
  ]);

  return {
    total,
    qna,
    freeform,
    limit: getKnowledgeLimit(config),
    configured: Boolean(config),
  };
}

async function listKnowledgeItems(guildId, options = {}) {
  const client = options.client || prisma;
  const pageSize = clampPageSize(options.pageSize);
  const total = await client.learnedAnswer.count({ where: { guildId } });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requestedPage = Number(options.page || 0);
  const page = Math.min(
    Math.max(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0, 0),
    totalPages - 1
  );

  const items = await client.learnedAnswer.findMany({
    where: { guildId },
    orderBy: { createdAt: "desc" },
    skip: page * pageSize,
    take: pageSize,
  });

  return {
    items,
    total,
    page,
    pageSize,
    totalPages,
  };
}

async function assertWriteCapacity(guildId, options = {}) {
  const client = options.client || prisma;
  const config = await client.guildConfig.findUnique({
    where: { guildId },
  });
  if (!config) {
    return { ok: false, code: "setup_required", limit: 0, total: 0 };
  }

  const limit = getKnowledgeLimit(config);
  if (limit <= 0) {
    return { ok: false, code: "knowledge_disabled", limit, total: 0 };
  }

  const total = await client.learnedAnswer.count({ where: { guildId } });
  if (total >= limit) {
    return { ok: false, code: "knowledge_limit_reached", limit, total };
  }

  return { ok: true, limit, total };
}

async function addKnowledgeQna(guildId, question, answer, options = {}) {
  const client = options.client || prisma;
  const normalizedQuestion = cleanText(question);
  const normalizedAnswer = cleanText(answer);
  if (!normalizedQuestion || !normalizedAnswer) {
    return { ok: false, code: "missing_qna_fields" };
  }

  const capacity = await assertWriteCapacity(guildId, { client });
  if (!capacity.ok) return capacity;

  const existing = await client.learnedAnswer.findMany({
    where: { guildId, type: KNOWLEDGE_TYPE_QNA },
    select: { id: true, question: true },
  });
  const duplicate = existing.find(
    (item) => normalizeForCompare(item.question) === normalizeForCompare(normalizedQuestion)
  );
  if (duplicate) {
    return {
      ok: false,
      code: "duplicate_question",
      existingId: duplicate.id,
      limit: capacity.limit,
      total: capacity.total,
    };
  }

  const item = await client.learnedAnswer.create({
    data: {
      guildId,
      type: KNOWLEDGE_TYPE_QNA,
      question: normalizedQuestion,
      answer: normalizedAnswer,
    },
  });

  return {
    ok: true,
    item,
    total: capacity.total + 1,
    limit: capacity.limit,
  };
}

async function importKnowledgeQnaBulk(guildId, value, options = {}) {
  const client = options.client || prisma;
  const parsed = parseBulkQnaText(value, options);
  if (!parsed.entries.length) {
    return {
      ok: false,
      code: "bulk_no_valid_qna",
      parsed: 0,
      incomplete: parsed.incomplete.length,
      truncated: parsed.truncated,
    };
  }

  const capacity = await assertWriteCapacity(guildId, { client });
  if (!capacity.ok) return { ...capacity, parsed: parsed.entries.length };

  const existing = await client.learnedAnswer.findMany({
    where: { guildId, type: KNOWLEDGE_TYPE_QNA },
    select: { question: true },
  });
  const knownQuestions = new Set(
    existing.map((item) => normalizeForCompare(item.question)).filter(Boolean)
  );
  const remainingCapacity = Math.max(0, capacity.limit - capacity.total);
  const accepted = [];
  let duplicates = 0;

  for (const entry of parsed.entries) {
    const key = normalizeForCompare(entry.question);
    if (!key || knownQuestions.has(key)) {
      duplicates += 1;
      continue;
    }
    knownQuestions.add(key);
    accepted.push(entry);
  }

  const toCreate = accepted.slice(0, remainingCapacity);
  const skippedForLimit = Math.max(0, accepted.length - toCreate.length);
  for (const entry of toCreate) {
    await client.learnedAnswer.create({
      data: {
        guildId,
        type: KNOWLEDGE_TYPE_QNA,
        question: entry.question,
        answer: entry.answer,
      },
    });
  }

  return {
    ok: true,
    added: toCreate.length,
    duplicates,
    incomplete: parsed.incomplete.length,
    skippedForLimit,
    truncated: parsed.truncated,
    parsed: parsed.entries.length,
    total: capacity.total + toCreate.length,
    limit: capacity.limit,
  };
}

async function addKnowledgeFreeform(guildId, title, content, options = {}) {
  const client = options.client || prisma;
  const normalizedTitle = cleanText(title);
  const normalizedContent = cleanText(content);
  if (!normalizedTitle || !normalizedContent) {
    return { ok: false, code: "missing_freeform_fields" };
  }

  const capacity = await assertWriteCapacity(guildId, { client });
  if (!capacity.ok) return capacity;

  const item = await client.learnedAnswer.create({
    data: {
      guildId,
      type: KNOWLEDGE_TYPE_FREEFORM,
      title: normalizedTitle,
      content: normalizedContent,
    },
  });

  return {
    ok: true,
    item,
    total: capacity.total + 1,
    limit: capacity.limit,
  };
}

async function deleteKnowledgeItem(guildId, itemId, options = {}) {
  const client = options.client || prisma;
  const id = String(itemId || "").trim();
  if (!id) return { ok: false, code: "missing_item_id" };

  const item = await client.learnedAnswer.findFirst({
    where: { id, guildId },
  });
  if (!item) return { ok: false, code: "knowledge_item_not_found" };

  await client.learnedAnswer.delete({ where: { id: item.id } });
  return { ok: true, item };
}

async function clearKnowledge(guildId, options = {}) {
  const client = options.client || prisma;
  const result = await client.learnedAnswer.deleteMany({ where: { guildId } });
  return { ok: true, deleted: Number(result?.count || 0) };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  KNOWLEDGE_TYPE_FREEFORM,
  KNOWLEDGE_TYPE_QNA,
  MAX_BULK_QNA_ITEMS,
  addKnowledgeFreeform,
  addKnowledgeQna,
  assertWriteCapacity,
  cleanText,
  clearKnowledge,
  deleteKnowledgeItem,
  getKnowledgeLimit,
  getKnowledgeOverview,
  importKnowledgeQnaBulk,
  listKnowledgeItems,
  normalizeForCompare,
  parseBulkQnaText,
};
