import pytest
from fastapi.testclient import TestClient
from app.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_arabic_search_and_retrieval(client):
    guild_id = "arabic_guild_101"
    
    # Ingest Arabic QnA and freeform docs
    upsert_payload = {
        "guild_id": guild_id,
        "items": [
            {
                "id": "ar-qna-1",
                "type": "qna",
                "question": "كيف أقوم بفتح تذكرة دعم فني؟",
                "answer": "اضغط على زر فتح تذكرة في روم الدعم الفني وسيتم إنشاء قناة خاصة بك فوراً.",
            },
            {
                "id": "ar-qna-2",
                "type": "qna",
                "question": "ما هي طرق الدفع المتاحة؟",
                "answer": "نقبل الدفع عن طريق بايبال وفودافون كاش والبطاقات البنكية.",
            },
            {
                "id": "ar-route-1",
                "type": "admin_route",
                "role_name": "فريق الدعم المالي",
                "description": "مسؤول عن مشاكل التحويلات المالية والدفع واسترجاع الأموال.",
            }
        ]
    }
    upsert_res = client.post("/api/upsert", json=upsert_payload)
    assert upsert_res.status_code == 200

    # Search for payment methods in Arabic
    search_res = client.post("/api/search", json={
        "guild_id": guild_id,
        "query": "عايز ادفع عن طريق فودافون كاش ازاي؟",
        "top_k": 3,
        "rerank_top_n": 2,
    })
    assert search_res.status_code == 200
    results = search_res.json()["results"]
    assert len(results) > 0
    # The top result should be the payment method QnA or Financial team route
    assert results[0]["item_id"] in ("ar-qna-2", "ar-route-1")

    # Cleanup
    client.post("/api/delete", json={
        "guild_id": guild_id,
        "item_ids": ["ar-qna-1", "ar-qna-2", "ar-route-1"]
    })
