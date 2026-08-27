const { ragConfig } = require("../config/rag");

async function checkHealth({ timeoutMs = 2000 } = {}) {
  if (!ragConfig.enabled) {
    return { ok: false, enabled: false, error: "RAG is disabled in configuration" };
  }

  const url = `${ragConfig.serviceUrl}/api/health`;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `RAG health check returned status ${response.status}`,
      };
    }

    const data = await response.json();
    return { ok: true, ...data };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
    };
  }
}

async function isRagAvailable() {
  if (!ragConfig.enabled) return false;
  const health = await checkHealth({ timeoutMs: 1500 });
  return health.ok && health.qdrant_connected;
}

async function searchKnowledge({
  guildId,
  query,
  topK = ragConfig.topK,
  candidateK = ragConfig.candidateK,
  minScore = ragConfig.minScore,
  itemTypes = null,
  timeoutMs = ragConfig.timeoutMs,
}) {
  if (!ragConfig.enabled || !guildId || !query) {
    return { ok: false, results: [], totalCandidates: 0, query: query || "", guildId: guildId || "" };
  }

  const url = `${ragConfig.serviceUrl}/api/search`;
  const body = {
    guild_id: String(guildId).trim(),
    query: String(query).trim(),
    top_k: Number.isFinite(candidateK) ? candidateK : 20,
    rerank_top_n: Number.isFinite(topK) ? topK : 5,
    min_score: Number.isFinite(minScore) ? minScore : 0.0,
  };

  if (Array.isArray(itemTypes) && itemTypes.length > 0) {
    body.item_types = itemTypes;
  }

  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.warn(`RAG search failed [${response.status}]: ${errText}`);
      return { ok: false, error: `HTTP ${response.status}: ${errText}`, results: [] };
    }

    const data = await response.json();
    return {
      ok: true,
      results: Array.isArray(data.results) ? data.results : [],
      totalCandidates: data.total_candidates || 0,
      query: data.query || query,
      guildId: data.guild_id || guildId,
    };
  } catch (error) {
    console.warn(`RAG search error for guild ${guildId}: ${error?.message || error}`);
    return {
      ok: false,
      error: error?.message || String(error),
      results: [],
    };
  }
}

async function upsertKnowledge({
  guildId,
  items,
  timeoutMs = ragConfig.timeoutMs,
}) {
  if (!ragConfig.enabled || !guildId || !Array.isArray(items) || items.length === 0) {
    return { ok: false, upsertedItems: 0, upsertedChunks: 0 };
  }

  const url = `${ragConfig.serviceUrl}/api/upsert`;
  const payloadItems = items.map((item) => ({
    id: item.id || item.itemId || undefined,
    item_id: item.id || item.itemId || undefined,
    type: item.type || item.itemType || "qna",
    item_type: item.type || item.itemType || "qna",
    title: item.title || undefined,
    content: item.content || item.text || undefined,
    text: item.content || item.text || undefined,
    question: item.question || undefined,
    answer: item.answer || undefined,
    role_id: item.roleId || undefined,
    role_name: item.roleName || undefined,
    description: item.description || undefined,
    metadata: item.metadata || {},
    updated_at: item.updatedAt ? new Date(item.updatedAt).toISOString() : undefined,
  }));

  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        guild_id: String(guildId).trim(),
        items: payloadItems,
      }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.warn(`RAG upsert failed [${response.status}]: ${errText}`);
      return { ok: false, error: `HTTP ${response.status}: ${errText}` };
    }

    const data = await response.json();
    return {
      ok: true,
      upsertedItems: data.upserted_items || 0,
      upsertedChunks: data.upserted_chunks || 0,
    };
  } catch (error) {
    console.warn(`RAG upsert error for guild ${guildId}: ${error?.message || error}`);
    return {
      ok: false,
      error: error?.message || String(error),
    };
  }
}

async function deleteKnowledge({
  guildId,
  itemIds,
  timeoutMs = ragConfig.timeoutMs,
}) {
  if (!ragConfig.enabled || !guildId || !Array.isArray(itemIds) || itemIds.length === 0) {
    return { ok: false, deletedItemIds: [] };
  }

  const url = `${ragConfig.serviceUrl}/api/delete`;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        guild_id: String(guildId).trim(),
        item_ids: itemIds.map(String),
      }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.warn(`RAG delete failed [${response.status}]: ${errText}`);
      return { ok: false, error: `HTTP ${response.status}: ${errText}` };
    }

    const data = await response.json();
    return {
      ok: true,
      deletedItemIds: data.deleted_item_ids || [],
    };
  } catch (error) {
    console.warn(`RAG delete error for guild ${guildId}: ${error?.message || error}`);
    return {
      ok: false,
      error: error?.message || String(error),
    };
  }
}

async function syncAllKnowledge({
  guildId = null,
  items = null,
  clearExisting = false,
  timeoutMs = 30000,
}) {
  if (!ragConfig.enabled) {
    return { ok: false, error: "RAG is disabled" };
  }

  const url = `${ragConfig.serviceUrl}/api/sync-all`;
  const body = {
    guild_id: guildId ? String(guildId).trim() : null,
    clear_existing: Boolean(clearExisting),
  };

  if (Array.isArray(items)) {
    body.items = items.map((item) => ({
      id: item.id || item.itemId || undefined,
      item_id: item.id || item.itemId || undefined,
      type: item.type || item.itemType || "qna",
      item_type: item.type || item.itemType || "qna",
      title: item.title || undefined,
      content: item.content || item.text || undefined,
      text: item.content || item.text || undefined,
      question: item.question || undefined,
      answer: item.answer || undefined,
      role_id: item.roleId || undefined,
      role_name: item.roleName || undefined,
      description: item.description || undefined,
      metadata: item.metadata || {},
      updated_at: item.updatedAt ? new Date(item.updatedAt).toISOString() : undefined,
    }));
  }

  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.warn(`RAG sync-all failed [${response.status}]: ${errText}`);
      return { ok: false, error: `HTTP ${response.status}: ${errText}` };
    }

    const data = await response.json();
    return {
      ok: true,
      syncedItems: data.synced_items || 0,
      syncedChunks: data.synced_chunks || 0,
    };
  } catch (error) {
    console.warn(`RAG sync-all error: ${error?.message || error}`);
    return {
      ok: false,
      error: error?.message || String(error),
    };
  }
}

module.exports = {
  checkHealth,
  deleteKnowledge,
  isRagAvailable,
  searchKnowledge,
  syncAllKnowledge,
  upsertKnowledge,
};
