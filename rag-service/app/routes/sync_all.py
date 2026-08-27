import logging
from collections import defaultdict
from typing import Dict, List
from fastapi import APIRouter, HTTPException, status
from app.chunker import chunk_item
from app.embeddings import embedding_manager
from app.models import SyncAllRequest, SyncAllResponse
from app.qdrant import qdrant_manager

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/sync-all", response_model=SyncAllResponse)
async def sync_all_knowledge(request: SyncAllRequest):
    try:
        target_guild_id = request.guild_id.strip() if request.guild_id else None

        # 1. Clear existing data if requested
        if request.clear_existing:
            if target_guild_id:
                logger.info(f"Clearing existing Qdrant records for guild '{target_guild_id}'...")
                qdrant_manager.delete_guild_points(guild_id=target_guild_id)
            else:
                logger.info("Clearing entire Qdrant knowledge collection...")
                qdrant_manager.clear_collection()

        if not request.items:
            return SyncAllResponse(
                success=True,
                guild_id=target_guild_id,
                synced_items=0,
                synced_chunks=0,
            )

        # 2. Group items by guild_id
        items_by_guild: Dict[str, list] = defaultdict(list)
        for item in request.items:
            gid = target_guild_id or (item.metadata and item.metadata.get("guild_id")) or "default"
            items_by_guild[gid].append(item)

        total_synced_chunks = 0
        total_synced_items = len(request.items)

        # 3. Process items per guild
        for gid, guild_items in items_by_guild.items():
            if not request.clear_existing:
                # Delete individual items being updated
                item_ids = list(set([it.get_id() for it in guild_items if it.get_id()]))
                if item_ids:
                    qdrant_manager.delete_by_item_ids(guild_id=gid, item_ids=item_ids)

            all_chunks: List[dict] = []
            for item in guild_items:
                chunks = chunk_item(guild_id=gid, item=item)
                all_chunks.extend(chunks)

            if all_chunks:
                passage_texts = [c["text"] for c in all_chunks]
                vectors = embedding_manager.embed_passages(passage_texts)
                upserted = qdrant_manager.upsert_chunks(
                    guild_id=gid,
                    chunks=all_chunks,
                    vectors=vectors,
                )
                total_synced_chunks += upserted

        return SyncAllResponse(
            success=True,
            guild_id=target_guild_id,
            synced_items=total_synced_items,
            synced_chunks=total_synced_chunks,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to sync knowledge: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Sync all failed: {str(e)}",
        )
