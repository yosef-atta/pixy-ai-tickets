const { prisma } = require("../config/prisma");
const { ensureGuildConfig } = require("../config/guildConfigFoundation");
const { DEFAULT_MAX_LEARNED_ITEMS } = require("../config/productDefaults");

const KNOWLEDGE_TYPE_QNA = "qna";
const KNOWLEDGE_TYPE_FREEFORM = "freeform";
const DEFAULT_PAGE_SIZE = 8;
const MAX_PAGE_SIZE = 20;

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
  const config = await ensureGuildConfig(guildId, { client });
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
  addKnowledgeFreeform,
  addKnowledgeQna,
  assertWriteCapacity,
  cleanText,
  clearKnowledge,
  deleteKnowledgeItem,
  getKnowledgeLimit,
  getKnowledgeOverview,
  listKnowledgeItems,
  normalizeForCompare,
};