from fastapi import APIRouter
from app.config import settings
from app.embeddings import embedding_manager
from app.models import HealthResponse
from app.qdrant import qdrant_manager
from app.reranker import reranker_manager

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
@router.get("/api/health", response_model=HealthResponse)
async def health_check():
    qdrant_info = qdrant_manager.get_info()
    return HealthResponse(
        status="ok" if qdrant_info.get("connected") else "degraded",
        qdrant_connected=bool(qdrant_info.get("connected")),
        collection_exists=bool(qdrant_info.get("collection_exists")),
        collection_name=settings.QDRANT_COLLECTION,
        embedding_model_loaded=embedding_manager.is_loaded(),
        reranker_model_loaded=reranker_manager.is_loaded(),
        device=embedding_manager.device,
        points_count=qdrant_info.get("points_count"),
    )
