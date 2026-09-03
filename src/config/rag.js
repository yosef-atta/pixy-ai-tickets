const ragConfig = Object.freeze({
  get enabled() {
    return String(process.env.RAG_ENABLED ?? "true").toLowerCase() === "true";
  },
  get serviceUrl() {
    return (
      process.env.RAG_SERVICE_URL ||
      process.env.RAG_INFERENCE_URL ||
      "http://127.0.0.1:8008"
    ).replace(/\/+$/, "");
  },
  get qdrantUrl() {
    return process.env.QDRANT_URL || "http://127.0.0.1:6333";
  },
  get qdrantCollection() {
    return process.env.QDRANT_COLLECTION || "pixy_knowledge";
  },
  get candidateK() {
    const val = Number(process.env.RAG_CANDIDATE_K || 20);
    return Number.isFinite(val) && val > 0 ? Math.floor(val) : 20;
  },
  get topK() {
    const val = Number(process.env.RAG_TOP_K || 5);
    return Number.isFinite(val) && val > 0 ? Math.floor(val) : 5;
  },
  get routeCandidateK() {
    const val = Number(process.env.RAG_ROUTE_CANDIDATE_K || 10);
    return Number.isFinite(val) && val > 0 ? Math.floor(val) : 10;
  },
  get routeTopK() {
    const val = Number(process.env.RAG_ROUTE_TOP_K || 3);
    return Number.isFinite(val) && val > 0 ? Math.floor(val) : 3;
  },
  get minScore() {
    const val = Number(process.env.RAG_MIN_SCORE || 0.0);
    return Number.isFinite(val) ? val : 0.0;
  },
  get timeoutMs() {
    const val = Number(process.env.RAG_REQUEST_TIMEOUT_MS || 10000);
    return Number.isFinite(val) && val > 0 ? Math.floor(val) : 10000;
  },
  get maxContextChars() {
    const val = Number(process.env.RAG_MAX_CONTEXT_CHARS || 10000);
    return Number.isFinite(val) && val > 0 ? Math.floor(val) : 10000;
  },
});

module.exports = {
  ragConfig,
};
