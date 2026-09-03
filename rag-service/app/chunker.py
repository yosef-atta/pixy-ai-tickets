import re
from typing import Any, Dict, List
from datetime import datetime
from app.config import settings
from app.models import KnowledgeItemInput


def _split_text_into_chunks(text: str, chunk_size: int = 600, chunk_overlap: int = 100) -> List[str]:
    text = text.strip()
    if not text:
        return []
    if len(text) <= chunk_size:
        return [text]

    # Split by paragraphs first
    paragraphs = [p.strip() for p in re.split(r'\n\s*\n', text) if p.strip()]
    chunks: List[str] = []
    current_chunk = ""

    for paragraph in paragraphs:
        if len(paragraph) > chunk_size:
            # Split long paragraph by sentences
            sentences = [s.strip() for s in re.split(r'(?<=[.?!؟\n])\s+', paragraph) if s.strip()]
            for sentence in sentences:
                if len(sentence) > chunk_size:
                    # Fallback to hard word slice if sentence itself is enormous
                    words = sentence.split()
                    temp_chunk = ""
                    for word in words:
                        if len(temp_chunk) + len(word) + 1 > chunk_size:
                            if temp_chunk:
                                chunks.append(temp_chunk.strip())
                            temp_chunk = word
                        else:
                            temp_chunk = f"{temp_chunk} {word}".strip()
                    if temp_chunk:
                        if current_chunk:
                            chunks.append(current_chunk.strip())
                            current_chunk = ""
                        current_chunk = temp_chunk
                else:
                    if len(current_chunk) + len(sentence) + 1 > chunk_size:
                        if current_chunk:
                            chunks.append(current_chunk.strip())
                            # Keep overlap from the end of current_chunk
                            overlap = current_chunk[-chunk_overlap:] if len(current_chunk) > chunk_overlap else ""
                            current_chunk = f"{overlap} {sentence}".strip()
                        else:
                            current_chunk = sentence
                    else:
                        current_chunk = f"{current_chunk} {sentence}".strip()
        else:
            if len(current_chunk) + len(paragraph) + 2 > chunk_size:
                if current_chunk:
                    chunks.append(current_chunk.strip())
                    overlap = current_chunk[-chunk_overlap:] if len(current_chunk) > chunk_overlap else ""
                    current_chunk = f"{overlap}\n{paragraph}".strip()
                else:
                    current_chunk = paragraph
            else:
                current_chunk = f"{current_chunk}\n\n{paragraph}".strip() if current_chunk else paragraph

    if current_chunk and current_chunk.strip():
        chunks.append(current_chunk.strip())

    return chunks if chunks else [text]


def chunk_item(
    guild_id: str,
    item: KnowledgeItemInput,
    chunk_size: int = settings.CHUNK_SIZE,
    chunk_overlap: int = settings.CHUNK_OVERLAP,
) -> List[Dict[str, Any]]:
    item_id = item.get_id()
    item_type = item.get_item_type()
    title = item.get_title()
    body_text = item.get_body_text()
    meta = item.metadata or {}

    updated_at_str = None
    if item.updated_at:
        if isinstance(item.updated_at, datetime):
            updated_at_str = item.updated_at.isoformat()
        else:
            updated_at_str = str(item.updated_at)

    raw_chunks: List[str] = []

    if item_type == "qna":
        q = (item.question or title or "").strip()
        a = (item.answer or item.content or item.text or "").strip()
        if not a:
            raw_chunks = [f"Question: {q}"] if q else []
        elif len(f"Question: {q}\nAnswer: {a}") <= chunk_size + 200:
            raw_chunks = [f"Question: {q}\nAnswer: {a}"]
        else:
            # Chunk the answer while keeping the question as prefix for semantic grounding
            answer_chunks = _split_text_into_chunks(a, chunk_size=chunk_size - len(q) - 30, chunk_overlap=chunk_overlap)
            raw_chunks = [f"Question: {q}\nAnswer: {c}" for c in answer_chunks]

    elif item_type == "admin_route":
        raw_chunks = [body_text]

    else:
        # freeform or discord_reference
        raw_chunks = _split_text_into_chunks(body_text, chunk_size=chunk_size, chunk_overlap=chunk_overlap)

    if not raw_chunks:
        raw_chunks = [body_text] if body_text else ["(empty)"]

    total_chunks = len(raw_chunks)
    result_chunks: List[Dict[str, Any]] = []

    for idx, chunk_text in enumerate(raw_chunks):
        result_chunks.append({
            "guild_id": guild_id,
            "item_id": item_id,
            "item_type": item_type,
            "title": title,
            "text": chunk_text,
            "chunk_index": idx,
            "total_chunks": total_chunks,
            "metadata": meta,
            "updated_at": updated_at_str,
        })

    return result_chunks
