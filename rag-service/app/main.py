import logging
from contextlib import asynccontextmanager
from time import perf_counter
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

from app.config import settings
from app.embeddings import embedding_manager
from app.qdrant import qdrant_manager
from app.reranker import reranker_manager
from app.routes.delete import router as delete_router
from app.routes.health import router as health_router
from app.routes.search import router as search_router
from app.routes.sync_all import router as sync_all_router
from app.routes.upsert import router as upsert_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("rag-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing Pixy RAG Service...")

    try:
        qdrant_manager.init_collection()
    except Exception as exc:
        logger.warning(
            f"Could not connect/init Qdrant during startup: {exc}. Will retry on requests."
        )

    warmup_started = perf_counter()
    try:
        embedding_manager.embed_query("Pixy RAG startup warmup")
        logger.info(
            "Embedding model '%s' warmed with real inference on device '%s'.",
            settings.EMBEDDING_MODEL,
            embedding_manager.device,
        )
    except Exception as exc:
        logger.error(f"Failed to warm embedding model: {exc}", exc_info=True)

    try:
        reranker_manager.score_candidates(
            "Pixy RAG startup warmup",
            [
                {
                    "id": "warmup",
                    "item_id": "warmup",
                    "guild_id": "warmup",
                    "item_type": "freeform",
                    "title": "Warmup",
                    "text": "Pixy RAG startup warmup",
                    "vector_score": 1.0,
                    "score": 1.0,
                    "metadata": {},
                }
            ],
        )
        logger.info(
            "Reranker model '%s' warmed with real inference on device '%s'.",
            settings.RERANKER_MODEL,
            reranker_manager.device,
        )
    except Exception as exc:
        logger.error(f"Failed to warm reranker model: {exc}", exc_info=True)

    logger.info(
        "Pixy RAG Service is ready to serve requests after %.2f ms startup warmup.",
        (perf_counter() - warmup_started) * 1000,
    )
    yield
    logger.info("Shutting down Pixy RAG Service.")


app = FastAPI(
    title="Pixy AI Tickets RAG Service",
    description="Vector search & reranking microservice using Qdrant and Sentence Transformers",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(
        f"Unhandled server error on {request.method} {request.url.path}: {exc}",
        exc_info=True,
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "error": str(exc)},
    )


app.include_router(health_router)
app.include_router(search_router, prefix="/api", tags=["Search"])
app.include_router(upsert_router, prefix="/api", tags=["Upsert"])
app.include_router(delete_router, prefix="/api", tags=["Delete"])
app.include_router(sync_all_router, prefix="/api", tags=["Sync"])


def start():
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=False,
    )


if __name__ == "__main__":
    start()
