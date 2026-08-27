from app.chunker import chunk_item, _split_text_into_chunks
from app.models import KnowledgeItemInput


def test_qna_chunking():
    item = KnowledgeItemInput(
        id="qna-1",
        type="qna",
        question="How do I reset my password?",
        answer="Click on forgot password and follow the instructions sent to your email.",
    )
    chunks = chunk_item(guild_id="12345", item=item)
    assert len(chunks) == 1
    assert chunks[0]["guild_id"] == "12345"
    assert chunks[0]["item_id"] == "qna-1"
    assert chunks[0]["item_type"] == "qna"
    assert "Question: How do I reset my password?" in chunks[0]["text"]
    assert "Answer: Click on forgot password" in chunks[0]["text"]


def test_admin_route_chunking():
    item = KnowledgeItemInput(
        id="route-1",
        type="admin_route",
        role_name="Billing Support",
        description="Handles all payment disputes and refunds.",
    )
    chunks = chunk_item(guild_id="12345", item=item)
    assert len(chunks) == 1
    assert chunks[0]["item_type"] == "admin_route"
    assert "Billing Support" in chunks[0]["text"]
    assert "Handles all payment disputes" in chunks[0]["text"]


def test_freeform_long_text_chunking():
    long_text = "\n\n".join([f"Paragraph {i}: This is detailed server documentation about feature #{i}." for i in range(20)])
    item = KnowledgeItemInput(
        id="doc-1",
        type="freeform",
        title="Server Rules & Guides",
        content=long_text,
    )
    chunks = chunk_item(guild_id="12345", item=item, chunk_size=200, chunk_overlap=50)
    assert len(chunks) > 1
    for chunk in chunks:
        assert chunk["guild_id"] == "12345"
        assert chunk["item_id"] == "doc-1"
        assert chunk["total_chunks"] == len(chunks)


def test_arabic_text_chunking():
    item = KnowledgeItemInput(
        id="ar-1",
        type="qna",
        question="كيف يمكنني تجديد الاشتراك؟",
        answer="يمكنك تجديد الاشتراك عبر زيارة لوحة التحكم والضغط على تجديد.",
    )
    chunks = chunk_item(guild_id="12345", item=item)
    assert len(chunks) == 1
    assert "تجديد الاشتراك" in chunks[0]["text"]
