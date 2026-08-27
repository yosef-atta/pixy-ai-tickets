# Pixy V1 Analysis: Missing Features & Requirements (Roadmap to V2)

This document provides a comprehensive, prioritized list of missing capabilities, technical limitations, and critical feature gaps identified in the Pixy codebase to guide evolution into V2.

---

## 1. Top Critical Limitations & Missing Requirements (Highest Priority)

### 1.1 Lack of Retrieval-Augmented Generation (RAG) & Vector Semantic Search
- **Current State**:
  - `buildTicketContext.js` fetches raw learned items directly from MySQL (`prisma.learnedAnswer.findMany`) with a hard cap of `take: 50-100` (`DEFAULT_MAX_LEARNED_ITEMS = 50`) and dumps them unranked into the model's system context prompt via `formatLearnedQna` and `formatLearnedFreeform`.
  - Admin routes are similarly hard-capped at 10-25 routes (`DEFAULT_MAX_ADMIN_ROUTES = 10`) and injected directly into the prompt.
- **Problem**:
  - Scales poorly. Large servers cannot store 500–1000+ custom FAQs, knowledge base articles, staff handbooks, or route maps without blowing through token limits, increasing API latency, driving up token costs, and degrading LLM attention/recall.
- **Requirement for V2**:
  - Implement RAG (Retrieval-Augmented Generation) pipeline:
    - Text chunking & vector embedding generation on creation/edit of Knowledge and Admin routes.
    - Vector database / similarity indexing (e.g., pgvector, Qdrant, Pinecone, or SQLite/MySQL vector extensions).
    - Dynamic top-k semantic retrieval based on the user's active ticket query and recent conversation context.
    - Scale capacity to 1,000+ items per server with minimal prompt overhead.

---

### 1.2 No Real-Time Web Search / Live Internet Grounding
- **Current State**:
  - AI prompt and provider callers only rely on static LLM weights and locally provided prompt strings. No external tool calling / function calling for search is present.
- **Problem**:
  - Cannot answer questions requiring current real-time data, newly released Discord updates, external service status (e.g., Discord API status outages), current exchange rates, game server statuses, or live store inventories.
- **Requirement for V2**:
  - Integrate a Web Search tool / function calling capability (e.g., Tavily, Serper, Brave Search, or provider-native search grounding where available).
  - Define clear tool execution guardrails so web search triggers only when internal server knowledge cannot resolve the query or when real-time information is explicitly requested.

---

### 1.3 Missing General Discord Domain Knowledge Base (Discord Basics & Ecosystem)
- **Current State**:
  - Prompt instructions in `buildTicketPrompt.js` tell the bot it can explain general Discord features, but only relies on whatever base training the underlying LLM has (which can be hallucinated, outdated, or lacking local pricing/nuance).
  - No dedicated reference dataset exists for Discord features, Nitro pricing tiers (Nitro Basic vs Nitro Full, annual vs monthly pricing, regional pricing variations), HypeSquad House badges and applications, Quests system, Server Boost perks/levels, Stage channels, Server Subscriptions, Onboarding flows, AutoMod configurations, etc.
- **Problem**:
  - Users frequently ask tickets about general Discord mechanics (e.g., "Why didn't I get my Quest reward?", "How much is Nitro in Egypt/US?", "How do I join HypeSquad Bravery?"). The bot may give vague, outdated, or hallucinated replies.
- **Requirement for V2**:
  - Create a curated, continuously updated built-in Discord Knowledge Base / Reference Catalog.
  - Automatically incorporate Discord ecosystem concepts into RAG or system grounding without requiring server admins to manually write Q&As for standard Discord features.

---

## 2. Important Architectural & Operational Enhancements (Medium Priority)

### 2.1 Multi-Modal Support (Image & Attachment Analysis)
- **Current State**:
  - Message handling (`src/events/tickets/messageCreate.js`) extracts only text (`message.content`). Any screenshots attached by users (error popups, payment transaction receipts, Discord crash logs) are ignored.
- **Problem**:
  - Support tickets often begin with a screenshot ("Look at this error"). The bot currently sees empty or minimal text and fails to provide contextual assistance.
- **Requirement for V2**:
  - Support vision/multimodal capabilities for compatible models (e.g., Gemini Flash Vision, GPT-4o, Claude 3.5 Sonnet).
  - Extract OCR / pass image URLs to vision-capable providers during ticket context construction.

---

### 2.2 Rich Interactive Actions & Form Workflows
- **Current State**:
  - Bot can only suggest simple text replies and 3 basic atomic actions (`close_ticket`, `rename_ticket`, `escalate_ticket`).
- **Problem**:
  - Complex support scenarios need structured intake forms, modal inputs, button confirmations, dropdown selections, and verification flows.
- **Requirement for V2**:
  - Expand agent actions to include interactive UI components (Buttons, Select Menus, Modals) dynamically requested by the AI.

---

### 2.3 Comprehensive Analytics & Performance Feedback Loop
- **Current State**:
  - Simple token logging in `AiUsageLog`. No user satisfaction rating (CSAT), answer accuracy feedback (thumbs up/down), or automatic identification of recurring unanswered questions.
- **Problem**:
  - Admins cannot easily know what their users are asking that the bot failed to answer, making knowledge base expansion a guessing game.
- **Requirement for V2**:
  - Add automated Knowledge Gap detection (identifying tickets where Pixy escalated or lacked information).
  - Add inline feedback mechanisms (e.g., reaction or button rating on AI replies).

---

## 3. Prioritized Execution Matrix

| Priority | Feature / Requirement | Impact | Complexity | Target Version |
| :--- | :--- | :--- | :--- | :--- |
| **P1** | **RAG & Vector Embeddings** (Scale knowledge to 1000+ items) | High (Core Scalability) | High | V2.0 |
| **P1** | **Discord Ecosystem Knowledge Base** (Nitro, HypeSquad, Quests) | High (Quality of Experience) | Medium | V2.0 |
| **P1** | **Live Web Search Grounding** (Real-time data access) | High (Accuracy & Scope) | Medium | V2.0 |
| **P2** | **Vision / Image Attachment Inspection** | Medium (UX & Support) | Medium | V2.1 |
| **P2** | **Knowledge Gap Discovery & Admin Suggestions** | Medium (Automation) | Medium | V2.1 |
| **P3** | **Interactive Form Actions & Dynamic Discord UI Components** | Medium (Workflow Power) | High | V2.2 |
