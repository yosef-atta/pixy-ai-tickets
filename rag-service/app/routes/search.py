import logging
from fastapi import APIRouter, HTTPException, status
from app.config import settings
from app.embeddings import embedding_manager
from app.models import SearchRequest, SearchResponse, SearchResultItem
from app.qdrant import qdrant_manager
from app.reranker import reranker_manager

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/search", response_model=SearchResponse)
async def search_knowledge(request: SearchRequest):
    try:
        guild_id = request.guild_id.strip()
        query = request.query.strip()
        if not guild_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="guild_id must not be empty",
            )
        if not query:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="query must not be empty",
            )

        # 1. Generate query embedding with 'query: ' prefix
        query_vector = embedding_manager.embed_query(query)

        # 2. Vector search in Qdrant (filtered by guild_id and optional item_types)
        candidates = qdrant_manager.search_candidates(
            guild_id=guild_id,
            query_vector=query_vector,
            top_k=request.top_k,
            item_types=request.item_types,
        )

        total_candidates = len(candidates)

        # 3. Cross-encoder reranking
        if request.rerank_top_n > 0 and candidates:
            ranked_results = reranker_manager.rerank(
                query=query,
                candidates=candidates,
                top_n=request.rerank_top_n,
            )
        else:
            ranked_results = candidates

        # 4. Filter by min_score
        filtered_results = [
            r for r in ranked_results
            if r.get("score", 0.0) >= request.min_score
        ]

        # 5. Format to response models
        response_items = [
            SearchResultItem(
                id=r["id"],
                item_id=r["item_id"],
                guild_id=r["guild_id"],
                item_type=r["item_type"],
                title=r.get("title"),
                text=r["text"],
                chunk_index=r.get("chunk_index", 0),
                total_chunks=r.get("total_chunks", 1),
                score=r["score"],
                vector_score=r["vector_score"],
                rerank_score=r.get("rerank_score"),
                metadata=r.get("metadata", {}),
                updated_at=r.get("updated_at"),
            )
            for r in filtered_results
        ]

        return SearchResponse(
            results=response_items,
            total_candidates=total_candidates,
            query=query,
            guild_id=guild_id,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to execute search for guild '{request.guild_id}': {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Search failed: {str(e)}",
        )
