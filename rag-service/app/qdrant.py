import logging
import uuid
from typing import Any, Dict, List, Optional
from qdrant_client import QdrantClient
from qdrant_client.http import models
from qdrant_client.http.exceptions import UnexpectedResponse
from app.config import settings

logger = logging.getLogger(__name__)


def generate_point_id(guild_id: str, item_id: str, chunk_index: int) -> str:
    seed = f"{guild_id}:{item_id}:{chunk_index}"
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, seed))


class QdrantManager:
    def __init__(self):
        self._client: Optional[QdrantClient] = None
        self._initialized_collections = set()

    def get_client(self) -> QdrantClient:
        if self._client is None:
            logger.info(f"Connecting to Qdrant at {settings.QDRANT_URL}...")
            client_kwargs: Dict[str, Any] = {
                "url": settings.QDRANT_URL,
                "timeout": 10.0,
            }
            if settings.sanitized_qdrant_api_key:
                client_kwargs["api_key"] = settings.sanitized_qdrant_api_key
            self._client = QdrantClient(**client_kwargs)
        return self._client

    def ensure_collection(self) -> None:
        collection_name = settings.QDRANT_COLLECTION
        if collection_name in self._initialized_collections:
            return

        client = self.get_client()
        try:
            collections_resp = client.get_collections()
            existing_names = [c.name for c in collections_resp.collections]
            distance_enum = getattr(models.Distance, settings.DISTANCE_METRIC.upper(), models.Distance.COSINE)

            if collection_name not in existing_names:
                logger.info(f"Creating Qdrant collection '{collection_name}' with size {settings.VECTOR_SIZE}, metric {settings.DISTANCE_METRIC}...")
                client.create_collection(
                    collection_name=collection_name,
                    vectors_config=models.VectorParams(
                        size=settings.VECTOR_SIZE,
                        distance=distance_enum,
                    ),
                )
                logger.info(f"Collection '{collection_name}' created.")
            
            # Ensure payload keyword indexes exist for fast multi-tenant filtering
            self._create_payload_indexes(collection_name)
            self._initialized_collections.add(collection_name)

        except Exception as e:
            logger.error(f"Failed to ensure Qdrant collection '{collection_name}': {e}", exc_info=True)
            raise

    def init_collection(self) -> None:
        self._initialized_collections.clear()
        self.ensure_collection()

    def _create_payload_indexes(self, collection_name: str) -> None:
        client = self.get_client()
        indexed_fields = ["guild_id", "item_type", "item_id"]
        for field in indexed_fields:
            try:
                client.create_payload_index(
                    collection_name=collection_name,
                    field_name=field,
                    field_schema=models.PayloadSchemaType.KEYWORD,
                )
                logger.info(f"Indexed payload field '{field}' as KEYWORD in collection '{collection_name}'.")
            except Exception as e:
                # May fail if index already exists, which is normal
                logger.debug(f"Payload index creation for '{field}' returned: {e}")

    def search_candidates(
        self,
        guild_id: str,
        query_vector: List[float],
        top_k: int = settings.DEFAULT_TOP_K,
        item_types: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        self.ensure_collection()
        client = self.get_client()
        collection_name = settings.QDRANT_COLLECTION

        must_conditions: List[models.Condition] = [
            models.FieldCondition(
                key="guild_id",
                match=models.MatchValue(value=guild_id),
            )
        ]

        if item_types:
            normalized_types = [t.strip().lower() for t in item_types if t.strip()]
            if normalized_types:
                must_conditions.append(
                    models.FieldCondition(
                        key="item_type",
                        match=models.MatchAny(any=normalized_types),
                    )
                )

        search_filter = models.Filter(must=must_conditions)

        try:
            if hasattr(client, "query_points"):
                response = client.query_points(
                    collection_name=collection_name,
                    query=query_vector,
                    query_filter=search_filter,
                    limit=top_k,
                    with_payload=True,
                )
                scored_points = response.points
            else:
                scored_points = client.search(
                    collection_name=collection_name,
                    query_vector=query_vector,
                    query_filter=search_filter,
                    limit=top_k,
                    with_payload=True,
                )

            candidates: List[Dict[str, Any]] = []
            for point in scored_points:
                payload = point.payload or {}
                candidates.append({
                    "id": str(point.id),
                    "item_id": str(payload.get("item_id", "")),
                    "guild_id": str(payload.get("guild_id", guild_id)),
                    "item_type": str(payload.get("item_type", "freeform")),
                    "title": payload.get("title"),
                    "text": str(payload.get("text", "")),
                    "chunk_index": int(payload.get("chunk_index", 0)),
                    "total_chunks": int(payload.get("total_chunks", 1)),
                    "vector_score": float(point.score),
                    "score": float(point.score),
                    "metadata": payload.get("metadata", {}),
                    "updated_at": payload.get("updated_at"),
                })
            return candidates

        except Exception as e:
            logger.error(f"Error executing Qdrant search in '{collection_name}' for guild '{guild_id}': {e}", exc_info=True)
            raise

    def upsert_chunks(
        self,
        guild_id: str,
        chunks: List[Dict[str, Any]],
        vectors: List[List[float]],
        batch_size: int = 100,
    ) -> int:
        if not chunks or not vectors:
            return 0
        if len(chunks) != len(vectors):
            raise ValueError(f"Chunks count ({len(chunks)}) does not match vectors count ({len(vectors)})")

        self.ensure_collection()
        client = self.get_client()
        collection_name = settings.QDRANT_COLLECTION

        points: List[models.PointStruct] = []
        for chunk, vector in zip(chunks, vectors):
            point_id = generate_point_id(
                guild_id=guild_id,
                item_id=chunk["item_id"],
                chunk_index=chunk["chunk_index"],
            )
            points.append(
                models.PointStruct(
                    id=point_id,
                    vector=vector,
                    payload=chunk,
                )
            )

        total_upserted = 0
        for i in range(0, len(points), batch_size):
            batch = points[i : i + batch_size]
            client.upsert(
                collection_name=collection_name,
                points=batch,
                wait=True,
            )
            total_upserted += len(batch)

        return total_upserted

    def delete_by_item_ids(self, guild_id: str, item_ids: List[str]) -> bool:
        if not item_ids:
            return True

        self.ensure_collection()
        client = self.get_client()
        collection_name = settings.QDRANT_COLLECTION

        filter_condition = models.Filter(
            must=[
                models.FieldCondition(
                    key="guild_id",
                    match=models.MatchValue(value=guild_id),
                ),
                models.FieldCondition(
                    key="item_id",
                    match=models.MatchAny(any=item_ids),
                ),
            ]
        )

        try:
            client.delete(
                collection_name=collection_name,
                points_selector=models.FilterSelector(filter=filter_condition),
                wait=True,
            )
        except UnexpectedResponse as e:
            if e.status_code == 404:
                return True
            raise
        return True

    def delete_guild_points(self, guild_id: str) -> bool:
        self.ensure_collection()
        client = self.get_client()
        collection_name = settings.QDRANT_COLLECTION

        filter_condition = models.Filter(
            must=[
                models.FieldCondition(
                    key="guild_id",
                    match=models.MatchValue(value=guild_id),
                ),
            ]
        )

        try:
            client.delete(
                collection_name=collection_name,
                points_selector=models.FilterSelector(filter=filter_condition),
                wait=True,
            )
        except UnexpectedResponse as e:
            if e.status_code == 404:
                return True
            raise
        return True

    def clear_collection(self) -> bool:
        client = self.get_client()
        collection_name = settings.QDRANT_COLLECTION
        try:
            client.delete_collection(collection_name=collection_name)
        except Exception:
            pass
        self._initialized_collections.discard(collection_name)
        self.init_collection()
        return True

    def get_info(self) -> Dict[str, Any]:
        client = self.get_client()
        collection_name = settings.QDRANT_COLLECTION
        try:
            self.ensure_collection()
            info = client.get_collection(collection_name=collection_name)
            return {
                "connected": True,
                "collection_exists": True,
                "points_count": info.points_count,
                "status": str(info.status),
            }
        except Exception as e:
            return {
                "connected": True,
                "collection_exists": False,
                "error": str(e),
            }


qdrant_manager = QdrantManager()
