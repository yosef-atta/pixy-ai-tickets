import logging
import math
from typing import Any, Dict, List, Optional
import numpy as np
import torch
from sentence_transformers import CrossEncoder
from app.config import settings

logger = logging.getLogger(__name__)


def _sigmoid(x: float) -> float:
    try:
        return 1.0 / (1.0 + math.exp(-x))
    except OverflowError:
        return 0.0 if x < 0 else 1.0


class RerankerManager:
    def __init__(self):
        self._model: Optional[CrossEncoder] = None
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

    def get_model(self) -> CrossEncoder:
        if self._model is None:
            logger.info(f"Loading reranker model '{settings.RERANKER_MODEL}' on device '{self.device}'...")
            try:
                self._model = CrossEncoder(
                    settings.RERANKER_MODEL,
                    device=self.device,
                    local_files_only=settings.LOCAL_FILES_ONLY,
                )
                logger.info("Successfully loaded reranker model from local cache.")
            except Exception as e:
                logger.warning(f"Could not load reranker model with local_files_only=True: {e}. Falling back to default loader...")
                self._model = CrossEncoder(
                    settings.RERANKER_MODEL,
                    device=self.device,
                )
                logger.info("Successfully loaded reranker model.")
        return self._model

    def is_loaded(self) -> bool:
        return self._model is not None

    def score_candidates(
        self,
        query: str,
        candidates: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        if not candidates:
            return []

        model = self.get_model()
        clean_query = query.strip()
        if clean_query.startswith("query:"):
            clean_query = clean_query[6:].strip()

        sentence_pairs = []
        for candidate in candidates:
            text = candidate.get("text", "")
            title = candidate.get("title")
            doc_text = f"{title}\n{text}" if title and not text.startswith(title) else text
            sentence_pairs.append([clean_query, doc_text])

        scores = model.predict(sentence_pairs, show_progress_bar=False)
        if isinstance(scores, (int, float)):
            scores = [scores]
        elif isinstance(scores, np.ndarray):
            scores = scores.tolist()

        for idx, score_val in enumerate(scores):
            if isinstance(score_val, list):
                score_val = score_val[0]
            norm_score = _sigmoid(float(score_val))
            candidates[idx]["rerank_score"] = round(norm_score, 5)
            candidates[idx]["score"] = round(norm_score, 5)

        return sorted(candidates, key=lambda item: item["score"], reverse=True)

    def rerank(
        self,
        query: str,
        candidates: List[Dict[str, Any]],
        top_n: int = settings.DEFAULT_RERANK_TOP_N,
    ) -> List[Dict[str, Any]]:
        if not candidates:
            return []

        if top_n <= 0:
            for candidate in candidates:
                candidate["rerank_score"] = None
                candidate["score"] = candidate.get("vector_score", 0.0)
            return candidates

        ranked = self.score_candidates(query=query, candidates=candidates)
        return ranked[:top_n]


reranker_manager = RerankerManager()
