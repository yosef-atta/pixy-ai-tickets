import logging
from typing import List, Optional
import numpy as np
import torch
from sentence_transformers import SentenceTransformer
from app.config import settings

logger = logging.getLogger(__name__)


class EmbeddingManager:
    def __init__(self):
        self._model: Optional[SentenceTransformer] = None
        self._device: Optional[str] = None

    @property
    def device(self) -> str:
        if self._device is None:
            if settings.TORCH_DEVICE:
                self._device = settings.TORCH_DEVICE
            elif torch.cuda.is_available():
                self._device = "cuda"
            else:
                self._device = "cpu"
        return self._device

    def get_model(self) -> SentenceTransformer:
        if self._model is None:
            logger.info(f"Loading embedding model '{settings.EMBEDDING_MODEL}' on device '{self.device}'...")
            try:
                # Attempt loading from local cache first
                self._model = SentenceTransformer(
                    settings.EMBEDDING_MODEL,
                    device=self.device,
                    local_files_only=settings.LOCAL_FILES_ONLY,
                )
                logger.info("Successfully loaded embedding model from local cache.")
            except Exception as e:
                logger.warning(f"Could not load embedding model with local_files_only=True: {e}. Falling back to default loader...")
                self._model = SentenceTransformer(
                    settings.EMBEDDING_MODEL,
                    device=self.device,
                )
                logger.info("Successfully loaded embedding model.")
        return self._model

    def is_loaded(self) -> bool:
        return self._model is not None

    def format_query(self, query: str) -> str:
        query = query.strip()
        if not (query.startswith("query:") or query.startswith("passage:")):
            return f"query: {query}"
        return query

    def format_passage(self, passage: str) -> str:
        passage = passage.strip()
        if not (passage.startswith("passage:") or passage.startswith("query:")):
            return f"passage: {passage}"
        return passage

    def embed_query(self, query: str) -> List[float]:
        model = self.get_model()
        formatted_query = self.format_query(query)
        embedding = model.encode(
            formatted_query,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        if isinstance(embedding, np.ndarray):
            return embedding.tolist()
        return list(embedding)

    def embed_passages(self, passages: List[str], batch_size: int = 32) -> List[List[float]]:
        if not passages:
            return []
        model = self.get_model()
        formatted_passages = [self.format_passage(p) for p in passages]
        embeddings = model.encode(
            formatted_passages,
            batch_size=batch_size,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        if isinstance(embeddings, np.ndarray):
            return embeddings.tolist()
        return [list(e) for e in embeddings]


embedding_manager = EmbeddingManager()
