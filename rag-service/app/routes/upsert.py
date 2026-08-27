import logging
from typing import List
from fastapi import APIRouter, HTTPException, status
from app.chunker import chunk_item
from app.embeddings import embedding_manager
from app.models import UpsertRequest, UpsertResponse
from app.qdrant import qdrant_manager

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/upsert", response_model=UpsertResponse)
async def upsert_knowledge(request: UpsertRequest):
    try:
        guild_id = request.guild_id.strip()
        if not guild_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="guild_id must not be empty",
            )
        if not request.items:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="items list must not be empty",
            )

        # 1. Collect item IDs and purge any existing chunks in Qdrant to avoid orphan chunks
        item_ids = list(set([item.get_id() for item in request.items if item.get_id()]))
        if item_ids:
            qdrant_manager.delete_by_item_ids(guild_id=guild_id, item_ids=item_ids)

        # 2. Chunk all items
        all_chunks: List[dict] = []
        for item in request.items:
            chunks = chunk_item(guild_id=guild_id, item=item)
            all_chunks.extend(chunks)

        if not all_chunks:
            return UpsertResponse(
                success=True,
                guild_id=guild_id,
                upserted_items=len(request.items),
                upserted_chunks=0,
            )

        # 3. Generate passage embeddings for each chunk
        passage_texts = [c["text"] for c in all_chunks]
        vectors = embedding_manager.embed_passages(passage_texts)

        # 4. Upsert vectors and payloads into Qdrant
        upserted_chunks = qdrant_manager.upsert_chunks(
            guild_id=guild_id,
            chunks=all_chunks,
            vectors=vectors,
        )

        return UpsertResponse(
            success=True,
            guild_id=guild_id,
            upserted_items=len(request.items),
            upserted_chunks=upserted_chunks,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upsert items for guild '{request.guild_id}': {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Upsert failed: {str(e)}",
        )
