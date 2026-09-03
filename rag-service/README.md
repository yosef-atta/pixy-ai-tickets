# Pixy AI Tickets - Python RAG Service (`rag-service/`)

FastAPI-based microservice providing semantic vector search, chunking, and cross-encoder reranking for **Pixy AI Tickets** using **Qdrant**, **`multilingual-e5-large`**, and **`bge-reranker-v2-m3`**.

---

## 🚀 Overview

- **Package & Environment Manager**: Managed with [`uv`](https://github.com/astral-sh/uv).
- **Embedding Model**: `intfloat/multilingual-e5-large` (1024-dimension vector embeddings with local Hugging Face Hub cache loading).
  - Search queries prefixed with: `query: `
  - Document passages prefixed with: `passage: `
- **Cross-Encoder Reranker**: `BAAI/bge-reranker-v2-m3` for high-precision 2-stage retrieval.
- **Vector Database**: **Qdrant** with multi-tenant filtering on `guild_id` and `item_type`.

---

## 📦 Installation & Setup

### 1. Install Dependencies with `uv`
```bash
# In rag-service/ directory
uv sync --extra dev
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` or configure root `.env`:
```env
HOST=0.0.0.0
PORT=8008
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=pixy_knowledge
EMBEDDING_MODEL=intfloat/multilingual-e5-large
RERANKER_MODEL=BAAI/bge-reranker-v2-m3
LOCAL_FILES_ONLY=true
DEFAULT_TOP_K=20
DEFAULT_RERANK_TOP_N=5
```

---

## 🏃 Running the Service

```bash
# Start server with uv
uv run python -m app.main

# Or with uvicorn directly
uv run uvicorn app.main:app --host 0.0.0.0 --port 8008 --reload
```

---

## 🧪 Testing

Run full pytest test suite:
```bash
uv run pytest
```

---

## 🔌 API Reference

### 1. `POST /api/search`
Perform hybrid / semantic search with optional cross-encoder reranking.

**Request Body:**
```json
{
  "guild_id": "1234567890",
  "query": "How do I claim my nitro rewards?",
  "top_k": 20,
  "rerank_top_n": 5,
  "min_score": 0.0,
  "item_types": ["qna", "freeform"]
}
```

**Response:**
```json
{
  "results": [
    {
      "id": "uuid",
      "item_id": "item-123",
      "guild_id": "1234567890",
      "item_type": "qna",
      "title": "Nitro Rewards",
      "text": "Question: How do I claim nitro rewards?\nAnswer: Booster perks are granted automatically.",
      "chunk_index": 0,
      "total_chunks": 1,
      "score": 0.9821,
      "vector_score": 0.8643,
      "rerank_score": 0.9821,
      "metadata": {},
      "updated_at": "2026-08-27T19:00:00"
    }
  ],
  "total_candidates": 1,
  "query": "How do I claim my nitro rewards?",
  "guild_id": "1234567890"
}
```

---

### 2. `POST /api/upsert`
Chunk text, compute `multilingual-e5-large` passage embeddings, and store in Qdrant with payload metadata.

**Request Body:**
```json
{
  "guild_id": "1234567890",
  "items": [
    {
      "id": "qna-1",
      "type": "qna",
      "question": "What is the return policy?",
      "answer": "Returns are accepted within 30 days."
    },
    {
      "id": "route-1",
      "type": "admin_route",
      "role_name": "Moderators",
      "description": "Handles member disputes and rule infractions."
    }
  ]
}
```

---

### 3. `POST /api/delete`
Delete points from Qdrant matching `guild_id` and specific `item_ids`.

**Request Body:**
```json
{
  "guild_id": "1234567890",
  "item_ids": ["qna-1", "doc-2"]
}
```

---

### 4. `POST /api/sync-all`
Batch sync or purge guild / global records.

**Request Body:**
```json
{
  "guild_id": "1234567890",
  "clear_existing": true,
  "items": [...]
}
```

---

### 5. `GET /health` & `GET /api/health`
Check service health, model statuses, and Qdrant connectivity.
