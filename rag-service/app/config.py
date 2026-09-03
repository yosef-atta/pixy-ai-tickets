import os
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server settings
    HOST: str = "0.0.0.0"
    PORT: int = 8008

    # Qdrant settings
    QDRANT_URL: str = "http://127.0.0.1:6333"
    QDRANT_API_KEY: Optional[str] = None
    QDRANT_COLLECTION: str = "pixy_knowledge"
    VECTOR_SIZE: int = 1024
    DISTANCE_METRIC: str = "Cosine"

    # Model settings
    EMBEDDING_MODEL: str = "intfloat/multilingual-e5-large"
    RERANKER_MODEL: str = "BAAI/bge-reranker-v2-m3"
    LOCAL_FILES_ONLY: bool = True
    TORCH_DEVICE: Optional[str] = None  # None for auto-detection

    # Search & Retrieval defaults
    DEFAULT_TOP_K: int = 20
    DEFAULT_RERANK_TOP_N: int = 5
    DEFAULT_MIN_SCORE: float = 0.0

    # Chunking settings
    CHUNK_SIZE: int = 600
    CHUNK_OVERLAP: int = 100

    @property
    def sanitized_qdrant_api_key(self) -> Optional[str]:
        if self.QDRANT_API_KEY and self.QDRANT_API_KEY.strip():
            return self.QDRANT_API_KEY.strip()
        return None


settings = Settings()
