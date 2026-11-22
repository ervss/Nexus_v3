"""
tests/test_ai_tagger_batch.py — Unit and integration tests for AI Tag Batch worker and API.
"""

import json
import pytest
from unittest.mock import AsyncMock, patch

from app.database import SessionLocal, Video
from app.ai_tagger_batch import (
    AITagBatchRequest,
    cancel_ai_tag_batch,
    find_ai_tag_candidates,
    format_duration_human,
    get_ai_tag_batch_status,
    run_ai_tag_batch_job,
    _load_first_json_object,
)


def test_format_duration_human():
    assert format_duration_human(15) == "~15s"
    assert format_duration_human(59) == "~59s"
    assert format_duration_human(65) == "~1m 05s"
    assert format_duration_human(135) == "~2m 15s"


def test_load_first_json_object():
    # Plain JSON
    assert _load_first_json_object('{"tags": ["anal", "pov"], "model_guess": "Eva"}') == {
        "tags": ["anal", "pov"],
        "model_guess": "Eva",
    }
    # Markdown fenced JSON
    fenced = '```json\n{"tags": ["outdoor"], "model_guess": ""}\n```'
    assert _load_first_json_object(fenced) == {"tags": ["outdoor"], "model_guess": ""}
    # Trailing garbage
    trailing = '{"tags": ["bikini"], "model_guess": "Mia"} extra text }'
    assert _load_first_json_object(trailing) == {"tags": ["bikini"], "model_guess": "Mia"}


def test_find_ai_tag_candidates_and_state():
    db = SessionLocal()
    try:
        # Create a test video missing tags
        v = Video(
            title="AI Batch Test Video",
            url="https://example.com/video.mp4",
            thumbnail_path="/static/thumbnails/test_thumb.jpg",
            batch_name="TestBatchAI",
            tags="",
            ai_tags="",
        )
        db.add(v)
        db.commit()
        db.refresh(v)

        candidates = find_ai_tag_candidates(db, batch_name="TestBatchAI", only_missing=True, limit=10)
        assert any(c.id == v.id for c in candidates)

        status = get_ai_tag_batch_status()
        assert isinstance(status, dict)
        assert "running" in status
        assert "percent" in status

        # Cleanup test video
        db.delete(v)
        db.commit()
    finally:
        db.close()


@pytest.mark.asyncio
async def test_run_ai_tag_batch_job_mocked():
    db = SessionLocal()
    try:
        # Create 2 test videos
        v1 = Video(
            title="Beach Party Bikini 1080p",
            url="https://example.com/v1.mp4",
            thumbnail_path="/static/thumbnails/v1.jpg",
            batch_name="TestBatchRunner",
            tags="",
            ai_tags="",
        )
        v2 = Video(
            title="Studio Session Model",
            url="https://example.com/v2.mp4",
            thumbnail_path="/static/thumbnails/v2.jpg",
            batch_name="TestBatchRunner",
            tags="",
            ai_tags="",
        )
        db.add_all([v1, v2])
        db.commit()
        db.refresh(v1)
        db.refresh(v2)

        # Mock loading bytes and calling Gemini API
        mock_thumb_bytes = b"fake_jpeg_image_bytes_12345"
        mock_gemini_resp = {
            "tags": ["beach", "bikini", "sunny", "swimsuit"],
            "model_guess": "Elena Vega",
        }

        with patch("app.ai_tagger_batch.load_video_thumb_bytes", new=AsyncMock(return_value=mock_thumb_bytes)), \
             patch("app.ai_tagger_batch.call_gemini_vision", new=AsyncMock(return_value=mock_gemini_resp)), \
             patch("app.ai_tagger_batch.broadcast_ws", new=AsyncMock()):

            cfg = AITagBatchRequest(
                limit=10,
                batch_name="TestBatchRunner",
                only_missing=True,
                concurrency=2,
            )

            result = await run_ai_tag_batch_job(cfg)
            assert result["total"] == 2
            assert result["done"] == 2
            assert result["improved"] == 2
            assert result["percent"] == 100.0

            # Verify videos in database have updated tags and models
            db.refresh(v1)
            db.refresh(v2)
            assert "beach" in v1.tags
            assert "bikini" in v1.tags
            assert "Elena Vega" in (v1.models or "")
            assert "tag:beach" in v1.ai_tags

        # Cleanup
        db.delete(v1)
        db.delete(v2)
        db.commit()
    finally:
        db.close()



def test_maintenance_endpoints_registered():
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    resp = client.get("/api/maintenance/ai-tag-batch/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "running" in data
    assert "percent" in data
    assert "status_text" in data


def test_local_nlp_and_batch_extraction():
    from app.ai_tagger_batch import clean_batch_name_for_signals, extract_nlp_tags_and_models

    cleaned_batch = clean_batch_name_for_signals(
        "Rebecca More bbc british milf uk 37gb 54vids bunkr · job #97"
    )
    assert "Rebecca More" in cleaned_batch
    assert "bunkr" not in cleaned_batch.lower()
    assert "job" not in cleaned_batch.lower()

    res = extract_nlp_tags_and_models(
        title="1080P_4000K_202751311",
        batch_name="Rebecca More bbc british milf uk 37gb 54vids bunkr · job #97",
    )
    assert res["model_guess"] == "Rebecca More"
    assert "bbc" in res["tags"]
    assert "milf" in res["tags"]
    assert "british" in res["tags"]

    res2 = extract_nlp_tags_and_models(
        title="VID_2026_01.mp4",
        batch_name="Filester · lisaevans · job #149",
    )
    assert res2["model_guess"] == "Lisa Evans"

