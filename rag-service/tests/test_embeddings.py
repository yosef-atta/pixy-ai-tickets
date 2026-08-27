from app.embeddings import embedding_manager
from app.reranker import reranker_manager


def test_embedding_prefix_formatting():
    # Regular text gets prefix
    assert embedding_manager.format_query("what is my balance") == "query: what is my balance"
    assert embedding_manager.format_passage("your balance is $50") == "passage: your balance is $50"

    # Already formatted text is not double-prefixed
    assert embedding_manager.format_query("query: what is my balance") == "query: what is my balance"
    assert embedding_manager.format_passage("passage: your balance is $50") == "passage: your balance is $50"


def test_embedding_dimensions_and_normalization():
    vec = embedding_manager.embed_query("test search query")
    assert len(vec) == 1024
    
    # Verify unit length (normalized embedding)
    import numpy as np
    norm = np.linalg.norm(vec)
    assert abs(norm - 1.0) < 1e-3


def test_reranker_relevance_ranking():
    query = "How to refund a payment"
    candidates = [
        {"id": "1", "title": "Server Rules", "text": "Do not spam in public channels.", "vector_score": 0.5},
        {"id": "2", "title": "Refund Policy", "text": "To request a refund for an order, contact billing support within 14 days.", "vector_score": 0.7},
        {"id": "3", "title": "Nitro Boosts", "text": "Boost our server to get extra roles and perks.", "vector_score": 0.4},
    ]

    reranked = reranker_manager.rerank(query=query, candidates=candidates, top_n=3)
    assert len(reranked) == 3
    # Top reranked candidate MUST be the refund document
    assert reranked[0]["id"] == "2"
    assert reranked[0]["score"] > reranked[1]["score"]
