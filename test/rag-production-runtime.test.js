const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("production RAG runtime keeps the validated CPU performance contract", () => {
  const config = read("rag-service/app/config.py");
  const models = read("rag-service/app/models.py");
  const searchRoute = read("rag-service/app/routes/search.py");
  const envExample = read(".env.example");

  assert.match(
    config,
    /RERANKER_MODEL:\s*str\s*=\s*"cross-encoder\/mmarco-mMiniLMv2-L12-H384-v1"/,
    "production must default to the validated CPU-suitable multilingual reranker"
  );

  assert.match(
    envExample,
    /^RAG_REQUEST_TIMEOUT_MS=10000$/m,
    "the Node RAG timeout must remain exactly 10 seconds"
  );

  assert.match(models, /knowledge_candidate_k:\s*int\s*=\s*Field\(default=20,/);
  assert.match(models, /route_candidate_k:\s*int\s*=\s*Field\(default=10,/);
  assert.match(models, /knowledge_top_n:\s*int\s*=\s*Field\(default=5,/);
  assert.match(models, /route_top_n:\s*int\s*=\s*Field\(default=3,/);

  const rerankIndex = searchRoute.indexOf(
    "combined_candidates = knowledge_candidates + route_candidates"
  );
  const knowledgeSplitIndex = searchRoute.indexOf("knowledge_results = [");
  const routeSplitIndex = searchRoute.indexOf("route_results = [");

  assert.ok(rerankIndex >= 0, "search-context must rerank the combined candidate set");
  assert.ok(
    knowledgeSplitIndex > rerankIndex,
    "knowledge results must be selected after the shared rerank"
  );
  assert.ok(
    routeSplitIndex > rerankIndex,
    "admin routes must be selected after the shared rerank"
  );
  assert.match(
    searchRoute,
    /if str\(result\.get\("item_type", ""\)\)\.lower\(\) in KNOWLEDGE_TYPES/
  );
  assert.match(
    searchRoute,
    /if str\(result\.get\("item_type", ""\)\)\.lower\(\) in ROUTE_TYPES/
  );
});
