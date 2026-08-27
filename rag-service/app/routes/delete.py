import logging
from fastapi import APIRouter, HTTPException, status
from app.models import DeleteRequest, DeleteResponse
from app.qdrant import qdrant_manager

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/delete", response_model=DeleteResponse)
async def delete_knowledge(request: DeleteRequest):
    try:
        guild_id = request.guild_id.strip()
        if not guild_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="guild_id must not be empty",
            )
        if not request.item_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="item_ids must not be empty",
            )

        cleaned_item_ids = [str(i).strip() for i in request.item_ids if str(i).strip()]
        if not cleaned_item_ids:
            return DeleteResponse(
                success=True,
                guild_id=guild_id,
                deleted_item_ids=[],
            )

        qdrant_manager.delete_by_item_ids(guild_id=guild_id, item_ids=cleaned_item_ids)

        return DeleteResponse(
            success=True,
            guild_id=guild_id,
            deleted_item_ids=cleaned_item_ids,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete items for guild '{request.guild_id}': {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Delete failed: {str(e)}",
        )
