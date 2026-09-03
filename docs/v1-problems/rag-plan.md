# RAG Implementation Plan (Pixy AI Tickets)

## 1. Executive Summary & Objectives
We are upgrading Pixy's knowledge retrieval mechanism from raw static database queries (`take: 50-100` prompt dumps) to a scalable, high-accuracy **RAG (Retrieval-Augmented Generation)** architecture.

### Key Technologies & Assets
- **Python Package & Environment Management**: `uv` (fast, deterministic virtual environment & dependency management).
- **Embedding Model**: `intfloat/multilingual-e5-large` (1024-dimension embeddings, multi-lingual support, loaded directly from local Hugging Face Hub cache).
- **Reranker Model**: `BAAI/bge-reranker-v2-m3` (Cross-encoder reranking for maximum precision over top-$k$ retrieved candidates).
- **Vector Database**: **Qdrant** running via Docker on `localhost:6333` with payload filtering for guild isolation.
- **Node.js Bot Integration**: Fast inter-process communication / microservice API or direct Python service integration for document ingestion and semantic search queries.

---

## 2. Architecture & Workflow

```
[Discord Ticket / User Query]
              │
              ▼
[Node.js Ticket Pipeline] ──(Query: message + ticket context)──► [Python RAG Service (FastAPI / Uvicorn)]
                                                                           │
                                                    1. Embed Query (multilingual-e5-large)
                                                    2. Qdrant Vector Search (top-20 filtered by guild_id)
                                                    3. Cross-Encoder Rerank (bge-reranker-v2-m3 -> top-3 to top-5)
                                                                           │
[Augmented System Prompt] ◄────(Relevant Knowledge Chunks + Scores)────────┘
              │
              ▼
[LLM Provider (Groq / Gemini / etc.)] ──► [Discord Ticket Reply]
```

### Knowledge Synchronization Flow:
- When an admin creates/updates/deletes a `LearnedAnswer` or `AdminRoute`:
  1. MySQL persists the raw record.
  2. A sync event triggers vectorization in the Python RAG service.
  3. Python chunks text, computes embeddings via `multilingual-e5-large`, and upserts/deletes points in Qdrant with payload metadata (`guildId`, `itemId`, `type`, `title`, `updatedAt`).

---

## 3. Detailed Component Plan

### 3.1 Python RAG Service (`rag-service/`)
- Managed with **`uv`**:
  - `pyproject.toml`
  - Dependencies: `fastapi`, `uvicorn`, `qdrant-client`, `sentence-transformers`, `torch`, `pydantic`.
- **Cache-Optimized Model Loading**:
  - Models load directly from local Hugging Face Hub cache (`~/.cache/huggingface/hub`) without re-downloading.
  - Prefix convention: `query: ` for user search queries and `passage: ` for knowledge text chunks with `multilingual-e5-large`.
- **Qdrant Collection Setup**:
  - Collection name: `pixy_knowledge` (Vector size: `1024`, Distance metric: `Cosine`).
  - Indexed payload fields: `guild_id` (Keyword index for fast multi-tenant filtering), `item_type` (`qna` | `freeform` | `admin_route` | `discord_reference`).
- **Endpoints / API Surface**:
  1. `POST /api/search`:
     - Input: `{ "guild_id": string, "query": string, "top_k": int, "rerank_top_n": int, "min_score": float }`
     - Output: Ranked and scored snippets with original metadata.
  2. `POST /api/upsert`:
     - Input: `{ "guild_id": string, "items": [...] }`
     - Chunks text, generates embeddings with `passage: ` prefix, upserts vectors into Qdrant.
  3. `POST /api/delete`:
     - Input: `{ "guild_id": string, "item_ids": [...] }`
     - Deletes points matching `guild_id` & `item_id`.
  4. `POST /api/sync-all`:
     - Batch re-indexes entire guild or database records.

### 3.2 Docker & Environment Setup
- **Existing Qdrant Container Configuration**:
  - Image: `qdrant/qdrant:latest`
  - Container Name: `qdrant`
  - Port Mappings:
    - HTTP API: `127.0.0.1:6333` -> `6333/tcp`
    - gRPC API: `127.0.0.1:6334` -> `6334/tcp`
  - Storage Volume: `C:\qdrant\storage` -> `/qdrant/storage` (Persistent local storage)
- **Environment variables in `.env`**:
  - `QDRANT_URL=http://127.0.0.1:6333`
  - `RAG_SERVICE_URL=http://127.0.0.1:8000`
  - `RAG_ENABLED=true`


### 3.3 Node.js Integration (`src/ai/ragClient.js` & `src/ai/buildTicketContext.js`)
- Replace the unranked `findMany({ take: 50-100 })` with hybrid / semantic retrieval:
  - If `RAG_ENABLED=true`, query the Python RAG microservice with the ticket query + recent user messages.
  - Fallback gracefully to MySQL if RAG service is unreachable or disabled.
  - Inject only top-$N$ (e.g. 3-7) highly relevant knowledge chunks into prompt tokens, saving context tokens and increasing response quality.

### 3.4 UX & Response Generation Enhancements (Thinking State & Token Expansion)
- **Immediate "Thinking" Feedback State**:
  - Immediately send a reply message to the user upon receiving a ticket message:
    ```
    Pixy is **thinking**
    <t:UNIX_TIMESTAMP:R>
    ```
    *(where `<t:UNIX_TIMESTAMP:R>` is Discord's dynamic relative timestamp format, rendering as "a few seconds ago").*
  - **Minimum Thinking Hold Window**:
    - Enforce a minimum display duration of **3,000ms (3 seconds)** before editing the thinking message with the final AI response.
    - If the RAG retrieval + LLM generation completes in under 3s, the bot waits out the remainder of the 3s window before editing.
    - If the generation takes longer than 3s, the message remains in the thinking state dynamically until the generation finishes, then edits smoothly.
- **Expanded Token Capacity & Long Message Handling**:
  - Increase LLM `maxOutputTokens` from `500` to `2000+` in `src/config/ai.js` to allow detailed, thorough ticket resolutions without truncation.
  - If the generated response exceeds Discord's 2,000-character limit:
    - Edit the initial "thinking" message with the first chunk (up to 2,000 characters).
    - Send subsequent chunks as follow-up reply messages using the message splitter (`splitDiscordMessage`).

---

## 4. Verification & Testing Plan

1. **Python Environment Verification**:
   - Verify `uv` environment creation and load tests for `intfloat/multilingual-e5-large` and `BAAI/bge-reranker-v2-m3` directly from local HF cache.
2. **Qdrant Integration Test**:
   - Verify collection creation, multi-tenant payload filtering by `guild_id`, and vector insertion.
3. **Retrieval & Reranking Quality Test**:
   - Seed sample Q&A articles and Discord domain knowledge.
   - Run benchmark queries and verify top-1 accuracy after reranking.
4. **UX & Timing Verification**:
   - Test thinking message rendering (`Pixy is **thinking** \n <t:...:R>`).
   - Validate that the 3-second minimum duration is respected and long replies (>2,000 chars) are cleanly split.
5. **End-to-End Bot Test**:
   - Test ticket interaction in Discord / local integration scripts to ensure seamless context augmentation and smooth UX.
