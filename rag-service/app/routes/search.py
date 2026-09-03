import logging
from time import perf_counter
from fastapi import APIRouter, HTTPException, status
from app.embeddings import embedding_manager
from app.models import (
    SearchRequest,
    SearchResponse,
    SearchResultItem,
    TicketContextSearchRequest,
    TicketContextSearchResponse,
)
from app.qdrant import qdrant_manager
from app.reranker import reranker_manager

logger = logging.getLogger(__name__)
router = APIRouter()

KNOWLEDGE_TYPES = {"qna", "freeform"}
ROUTE_TYPES = {"admin_route"}


def _to_response_items(results):
    return [
        SearchResultItem(
            id=result["id"],
            item_id=result["item_id"],
            guild_id=result["guild_id"],
            item_type=result["item_type"],
            title=result.get("title"),
            text=result["text"],
            chunk_index=result.get("chunk_index", 0),
            total_chunks=result.get("total_chunks", 1),
            score=result["score"],
            vector_score=result["vector_score"],
            rerank_score=result.get("rerank_score"),
            metadata=result.get("metadata", {}),
            updated_at=result.get("updated_at"),
        )
        for result in results
    ]


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

        query_vector = embedding_manager.embed_query(query)
        candidates = qdrant_manager.search_candidates(
            guild_id=guild_id,
            query_vector=query_vector,
            top_k=request.top_k,
            item_types=request.item_types,
        )
        total_candidates = len(candidates)

        if request.rerank_top_n > 0 and candidates:
            ranked_results = reranker_manager.rerank(
                query=query,
                candidates=candidates,
                top_n=request.rerank_top_n,
            )
        else:
            ranked_results = candidates

        filtered_results = [
            result
            for result in ranked_results
            if result.get("score", 0.0) >= request.min_score
        ]

        return SearchResponse(
            results=_to_response_items(filtered_results),
            total_candidates=total_candidates,
            query=query,
            guild_id=guild_id,
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            f"Failed to execute search for guild '{request.guild_id}': {exc}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Search failed: {str(exc)}",
        )


@router.post("/search-context", response_model=TicketContextSearchResponse)
async def search_ticket_context(request: TicketContextSearchRequest):
    started = perf_counter()
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

        embed_started = perf_counter()
        query_vector = embedding_manager.embed_query(query)
        embed_ms = (perf_counter() - embed_started) * 1000

        vector_started = perf_counter()
        knowledge_candidates = []
        route_candidates = []
        if request.knowledge_top_n > 0:
            knowledge_candidates = qdrant_manager.search_candidates(
                guild_id=guild_id,
                query_vector=query_vector,
                top_k=request.knowledge_candidate_k,
                item_types=list(KNOWLEDGE_TYPES),
            )
        if request.route_top_n > 0:
            route_candidates = qdrant_manager.search_candidates(
                guild_id=guild_id,
                query_vector=query_vector,
                top_k=request.route_candidate_k,
                item_types=list(ROUTE_TYPES),
            )
        vector_ms = (perf_counter() - vector_started) * 1000

        rerank_started = perf_counter()
        combined_candidates = knowledge_candidates + route_candidates
        ranked_results = (
            reranker_manager.score_candidates(query, combined_candidates)
            if combined_candidates
            else []
        )
        rerank_ms = (perf_counter() - rerank_started) * 1000

        filtered_results = [
            result
            for result in ranked_results
            if result.get("score", 0.0) >= request.min_score
        ]
        knowledge_results = [
            result
            for result in filtered_results
            if str(result.get("item_type", "")).lower() in KNOWLEDGE_TYPES
        ][: request.knowledge_top_n]
        route_results = [
            result
            for result in filtered_results
            if str(result.get("item_type", "")).lower() in ROUTE_TYPES
        ][: request.route_top_n]

        total_ms = (perf_counter() - started) * 1000
        timings = {
            "embedding": round(embed_ms, 2),
            "vector_search": round(vector_ms, 2),
            "rerank": round(rerank_ms, 2),
            "total": round(total_ms, 2),
        }
        logger.info(
            "Ticket context RAG guild=%s knowledge_candidates=%s route_candidates=%s total_ms=%.2f",
            guild_id,
            len(knowledge_candidates),
            len(route_candidates),
            total_ms,
        )

        return TicketContextSearchResponse(
            knowledge_results=_to_response_items(knowledge_results),
            route_results=_to_response_items(route_results),
            knowledge_candidates=len(knowledge_candidates),
            route_candidates=len(route_candidates),
            query=query,
            guild_id=guild_id,
            timings_ms=timings,
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            f"Failed to execute ticket context search for guild '{request.guild_id}': {exc}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Ticket context search failed: {str(exc)}",
        )
