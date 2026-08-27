import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.config import settings


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["qdrant_connected"] is True
    assert data["collection_exists"] is True
    assert data["collection_name"] == settings.QDRANT_COLLECTION


def test_upsert_search_and_delete_workflow(client):
    test_guild_id = "test_guild_999"

    # 1. Upsert test items
    upsert_payload = {
        "guild_id": test_guild_id,
        "items": [
            {
                "id": "qna-refund",
                "type": "qna",
                "question": "What is the refund policy?",
                "answer": "Refunds are processed within 14 days of purchase if requested through a support ticket.",
            },
            {
                "id": "qna-nitro",
                "type": "qna",
                "question": "How to claim Discord Nitro boost reward?",
                "answer": "Server boosters receive a VIP badge and 500 bonus credits automatically upon boosting.",
            },
            {
                "id": "route-billing",
                "type": "admin_route",
                "role_name": "Billing Admin",
                "description": "Handles escalated billing issues and payment refunds.",
            },
            {
                "id": "doc-rules",
                "type": "freeform",
                "title": "General Server Rules",
                "content": "Be respectful to staff and other members. No spam or advertising in public channels.",
            },
        ],
    }

    upsert_resp = client.post("/api/upsert", json=upsert_payload)
    assert upsert_resp.status_code == 200
    upsert_data = upsert_resp.json()
    assert upsert_data["success"] is True
    assert upsert_data["upserted_items"] == 4
    assert upsert_data["upserted_chunks"] >= 4

    # 2. Search for refund information
    search_payload = {
        "guild_id": test_guild_id,
        "query": "Can I get my money back for my order?",
        "top_k": 5,
        "rerank_top_n": 3,
        "min_score": 0.0,
    }

    search_resp = client.post("/api/search", json=search_payload)
    assert search_resp.status_code == 200
    search_data = search_resp.json()
    assert len(search_data["results"]) > 0
    top_result = search_data["results"][0]
    assert top_result["item_id"] in ("qna-refund", "route-billing")
    assert "score" in top_result
    assert top_result["rerank_score"] is not None

    # 3. Search with item_types filter
    filter_search_payload = {
        "guild_id": test_guild_id,
        "query": "Who handles payment issues?",
        "top_k": 5,
        "rerank_top_n": 2,
        "item_types": ["admin_route"],
    }
    filter_resp = client.post("/api/search", json=filter_search_payload)
    assert filter_resp.status_code == 200
    filter_data = filter_resp.json()
    assert len(filter_data["results"]) > 0
    assert all(r["item_type"] == "admin_route" for r in filter_data["results"])
    assert filter_data["results"][0]["item_id"] == "route-billing"

    # 4. Delete specific items
    delete_payload = {
        "guild_id": test_guild_id,
        "item_ids": ["qna-refund", "doc-rules"],
    }
    del_resp = client.post("/api/delete", json=delete_payload)
    assert del_resp.status_code == 200
    del_data = del_resp.json()
    assert del_data["success"] is True
    assert "qna-refund" in del_data["deleted_item_ids"]

    # 5. Verify deleted items no longer return in search
    search_after_del = client.post("/api/search", json=search_payload)
    assert search_after_del.status_code == 200
    after_results = search_after_del.json()["results"]
    returned_ids = [r["item_id"] for r in after_results]
    assert "qna-refund" not in returned_ids


def test_sync_all_endpoint(client):
    sync_guild_id = "test_sync_guild_1"
    sync_payload = {
        "guild_id": sync_guild_id,
        "clear_existing": True,
        "items": [
            {
                "id": "sync-item-1",
                "type": "qna",
                "question": "How to contact developer?",
                "answer": "Reach out in the #dev channel or open an issue on GitHub.",
            }
        ],
    }

    sync_resp = client.post("/api/sync-all", json=sync_payload)
    assert sync_resp.status_code == 200
    sync_data = sync_resp.json()
    assert sync_data["success"] is True
    assert sync_data["synced_items"] == 1
    assert sync_data["synced_chunks"] == 1

    # Cleanup after test
    client.post("/api/delete", json={"guild_id": sync_guild_id, "item_ids": ["sync-item-1"]})
