const { ragConfig } = require("../config/rag");

let lastConnectionFailureAt = 0;
const OFFLINE_COOLDOWN_MS = 15000;

function isTemporarilyOffline() {
  return Date.now() - lastConnectionFailureAt < OFFLINE_COOLDOWN_MS;
}

function recordConnectionFailure(error) {
  const now = Date.now();
  if (now - lastConnectionFailureAt > OFFLINE_COOLDOWN_MS) {
    const detail = error?.cause?.code || error?.code || error?.message || String(error);
    console.warn(`[RAG Client] Python RAG microservice is offline at ${ragConfig.serviceUrl} (${detail}). Falling back to database.`);
  }
  lastConnectionFailureAt = now;
}

function recordConnectionSuccess() {
  lastConnectionFailureAt = 0;
}

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
    recordConnectionSuccess();
    return { ok: true, ...data };
  } catch (error) {
    recordConnectionFailure(error);
    return {
      ok: false,
      error: error?.message || String(error),
    };
  }
}

async function isRagAvailable() {
  if (!ragConfig.enabled || isTemporarilyOffline()) return false;
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

  if (isTemporarilyOffline()) {
    return { ok: false, error: "rag_service_offline", results: [] };
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
      console.warn(`[RAG Client] Search returned status ${response.status}: ${errText}`);
      return { ok: false, error: `HTTP ${response.status}: ${errText}`, results: [] };
    }

    const data = await response.json();
    recordConnectionSuccess();
    return {
      ok: true,
      results: Array.isArray(data.results) ? data.results : [],
      totalCandidates: data.total_candidates || 0,
      query: data.query || query,
      guildId: data.guild_id || guildId,
    };
  } catch (error) {
    recordConnectionFailure(error);
    return {
      ok: false,
      error: error?.message || String(error),
      results: [],
    };
  }
}

async function searchTicketContext({
  guildId,
  query,
  knowledgeCandidateK = ragConfig.candidateK,
  routeCandidateK = ragConfig.routeCandidateK,
  knowledgeTopK = ragConfig.topK,
  routeTopK = ragConfig.routeTopK,
  minScore = ragConfig.minScore,
  timeoutMs = ragConfig.timeoutMs,
}) {
  if (!ragConfig.enabled || !guildId || !query) {
    return {
      ok: false,
      knowledgeResults: [],
      routeResults: [],
      knowledgeCandidates: 0,
      routeCandidates: 0,
    };
  }

  if (isTemporarilyOffline()) {
    return {
      ok: false,
      error: "rag_service_offline",
      knowledgeResults: [],
      routeResults: [],
    };
  }

  const url = `${ragConfig.serviceUrl}/api/search-context`;
  const body = {
    guild_id: String(guildId).trim(),
    query: String(query).trim(),
    knowledge_candidate_k: Number(knowledgeCandidateK),
    route_candidate_k: Number(routeCandidateK),
    knowledge_top_n: Number(knowledgeTopK),
    route_top_n: Number(routeTopK),
    min_score: Number(minScore),
  };

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
      console.warn(`[RAG Client] Ticket context search returned status ${response.status}: ${errText}`);
      return {
        ok: false,
        error: `HTTP ${response.status}: ${errText}`,
        knowledgeResults: [],
        routeResults: [],
      };
    }

    const data = await response.json();
    recordConnectionSuccess();
    return {
      ok: true,
      knowledgeResults: Array.isArray(data.knowledge_results) ? data.knowledge_results : [],
      routeResults: Array.isArray(data.route_results) ? data.route_results : [],
      knowledgeCandidates: data.knowledge_candidates || 0,
      routeCandidates: data.route_candidates || 0,
      query: data.query || query,
      guildId: data.guild_id || guildId,
      timingsMs: data.timings_ms || {},
    };
  } catch (error) {
    recordConnectionFailure(error);
    return {
      ok: false,
      error: error?.message || String(error),
      knowledgeResults: [],
      routeResults: [],
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

  if (isTemporarilyOffline()) {
    return { ok: false, error: "rag_service_offline" };
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
      console.warn(`[RAG Client] Upsert returned status ${response.status}: ${errText}`);
      return { ok: false, error: `HTTP ${response.status}: ${errText}` };
    }

    const data = await response.json();
    recordConnectionSuccess();
    return {
      ok: true,
      upsertedItems: data.upserted_items || 0,
      upsertedChunks: data.upserted_chunks || 0,
    };
  } catch (error) {
    recordConnectionFailure(error);
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

  if (isTemporarilyOffline()) {
    return { ok: false, error: "rag_service_offline" };
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
      console.warn(`[RAG Client] Delete returned status ${response.status}: ${errText}`);
      return { ok: false, error: `HTTP ${response.status}: ${errText}` };
    }

    const data = await response.json();
    recordConnectionSuccess();
    return {
      ok: true,
      deletedItemIds: data.deleted_item_ids || [],
    };
  } catch (error) {
    recordConnectionFailure(error);
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

  if (isTemporarilyOffline()) {
    return { ok: false, error: "rag_service_offline" };
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
      console.warn(`[RAG Client] Sync-all returned status ${response.status}: ${errText}`);
      return { ok: false, error: `HTTP ${response.status}: ${errText}` };
    }

    const data = await response.json();
    recordConnectionSuccess();
    return {
      ok: true,
      syncedItems: data.synced_items || 0,
      syncedChunks: data.synced_chunks || 0,
    };
  } catch (error) {
    recordConnectionFailure(error);
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
  searchTicketContext,
  syncAllKnowledge,
  upsertKnowledge,
};
