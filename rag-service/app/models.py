from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union
import uuid
from pydantic import BaseModel, Field


KnowledgeItemType = Literal["qna", "freeform", "admin_route", "discord_reference"]


class KnowledgeItemInput(BaseModel):
    id: Optional[str] = None
    item_id: Optional[str] = None
    type: Optional[str] = None
    item_type: Optional[str] = None
    title: Optional[str] = None
    content: Optional[str] = None
    text: Optional[str] = None
    question: Optional[str] = None
    answer: Optional[str] = None
    role_id: Optional[str] = None
    role_name: Optional[str] = None
    description: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    updated_at: Optional[Union[str, datetime]] = None

    def get_id(self) -> str:
        if self.item_id and self.item_id.strip():
            return self.item_id.strip()
        if self.id and self.id.strip():
            return self.id.strip()
        return str(uuid.uuid4())

    def get_item_type(self) -> str:
        raw_type = (self.item_type or self.type or "freeform").strip().lower()
        if raw_type in ("qna", "faq", "question_answer"):
            return "qna"
        if raw_type in ("admin_route", "route", "escalation_route"):
            return "admin_route"
        if raw_type in ("discord_reference", "reference", "doc", "channel_ref"):
            return "discord_reference"
        return "freeform"

    def get_title(self) -> Optional[str]:
        if self.title and self.title.strip():
            return self.title.strip()
        if self.get_item_type() == "qna" and self.question:
            return self.question.strip()
        if self.get_item_type() == "admin_route":
            name = self.role_name or self.role_id or "Route"
            return f"Route: {name}"
        return None

    def get_body_text(self) -> str:
        itype = self.get_item_type()
        if itype == "qna":
            q = (self.question or self.title or "").strip()
            a = (self.answer or self.content or self.text or "").strip()
            if q and a:
                return f"Question: {q}\nAnswer: {a}"
            return q or a

        if itype == "admin_route":
            role_desc = self.role_name or self.role_id or "Admin Role"
            desc = (self.description or self.content or self.text or "").strip()
            return f"Admin Route: {role_desc}\nDescription: {desc}"

        # freeform or discord_reference
        body = (self.content or self.text or self.answer or "").strip()
        title = (self.title or self.question or "").strip()
        if title and body and not body.startswith(title):
            return f"{title}\n\n{body}"
        return body or title


class SearchRequest(BaseModel):
    guild_id: str = Field(..., description="Discord Guild ID for multi-tenant payload filtering")
    query: str = Field(..., min_length=1, description="Search query string")
    top_k: int = Field(default=20, ge=1, le=100, description="Vector search candidate retrieval count from Qdrant")
    rerank_top_n: int = Field(default=5, ge=0, le=50, description="Number of top reranked results to return. Set 0 to disable reranker.")
    min_score: float = Field(default=0.0, description="Minimum score threshold for returned results")
    item_types: Optional[List[str]] = Field(default=None, description="Optional filter by item_type (e.g. ['qna', 'admin_route'])")


class SearchResultItem(BaseModel):
    id: str
    item_id: str
    guild_id: str
    item_type: str
    title: Optional[str] = None
    text: str
    chunk_index: int = 0
    total_chunks: int = 1
    score: float
    vector_score: float
    rerank_score: Optional[float] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    updated_at: Optional[str] = None


class SearchResponse(BaseModel):
    results: List[SearchResultItem]
    total_candidates: int
    query: str
    guild_id: str


class UpsertRequest(BaseModel):
    guild_id: str = Field(..., description="Discord Guild ID for multi-tenant isolation")
    items: List[KnowledgeItemInput] = Field(..., min_length=1, description="List of knowledge items to index")


class UpsertResponse(BaseModel):
    success: bool = True
    guild_id: str
    upserted_items: int
    upserted_chunks: int


class DeleteRequest(BaseModel):
    guild_id: str = Field(..., description="Discord Guild ID for multi-tenant isolation")
    item_ids: List[str] = Field(..., min_length=1, description="List of item IDs to remove from Qdrant")


class DeleteResponse(BaseModel):
    success: bool = True
    guild_id: str
    deleted_item_ids: List[str]


class SyncAllRequest(BaseModel):
    guild_id: Optional[str] = Field(default=None, description="Optional guild ID. If omitted, applies globally or across supplied items.")
    items: Optional[List[KnowledgeItemInput]] = Field(default=None, description="List of items to sync")
    clear_existing: bool = Field(default=False, description="Whether to purge existing records for the guild before indexing")


class SyncAllResponse(BaseModel):
    success: bool = True
    guild_id: Optional[str] = None
    synced_items: int
    synced_chunks: int


class HealthResponse(BaseModel):
    status: str
    qdrant_connected: bool
    collection_exists: bool
    collection_name: str
    embedding_model_loaded: bool
    reranker_model_loaded: bool
    device: str
    points_count: Optional[int] = None
