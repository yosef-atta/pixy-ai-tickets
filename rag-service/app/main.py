import logging
from contextlib import asynccontextmanager
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

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("rag-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing Pixy RAG Service...")
    
    # 1. Initialize Qdrant collection and payload indexes
    try:
        qdrant_manager.init_collection()
    except Exception as e:
        logger.warning(f"Could not connect/init Qdrant during startup: {e}. Will retry on requests.")

    # 2. Warm up embedding model
    try:
        embedding_manager.get_model()
        logger.info(f"Embedding model '{settings.EMBEDDING_MODEL}' initialized on device '{embedding_manager.device}'.")
    except Exception as e:
        logger.error(f"Failed to initialize embedding model: {e}")

    # 3. Warm up reranker model
    try:
        reranker_manager.get_model()
        logger.info(f"Reranker model '{settings.RERANKER_MODEL}' initialized on device '{reranker_manager.device}'.")
    except Exception as e:
        logger.error(f"Failed to initialize reranker model: {e}")

    logger.info("Pixy RAG Service is ready to serve requests.")
    yield
    logger.info("Shutting down Pixy RAG Service.")


app = FastAPI(
    title="Pixy AI Tickets RAG Service",
    description="Vector search & reranking microservice using Qdrant and Sentence Transformers",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global Exception Handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled server error on {request.method} {request.url.path}: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "error": str(exc)},
    )

# Include API routes
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
