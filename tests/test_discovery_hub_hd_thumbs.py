import pytest
import httpx
from httpx import AsyncClient, ASGITransport
from app.main import app
from app import bunkr_cache

@pytest.mark.asyncio
async def test_fetch_hd_thumbs_endpoint():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Pre-seed cache with one URL to verify fast cache path
        test_url = "https://bunkr.cr/f/test_storyboard_url_123"
        bunkr_cache.file_meta_put(test_url, {
            "title": "Test Video.mp4",
            "storyboard_url": "https://static.scdn.st/thumbs/test_grid.png",
            "type": "video"
        })
        bunkr_cache.file_meta_flush()

        resp = await client.post("/api/v1/discovery-hub/fetch-hd-thumbs", json={"urls": [test_url]})
        assert resp.status_code == 200
        text = resp.text
        assert "patch" in text
        assert "https://static.scdn.st/thumbs/test_grid.png" in text
        assert '"hd_ready": true' in text.lower()
        assert "done" in text


@pytest.mark.asyncio
async def test_fetch_hd_thumbs_reads_og_image_when_content_attribute_comes_first(monkeypatch):
    test_url = "https://bunkr.cr/f/test_og_image_attribute_order"
    cover_url = "https://bunkr.cr/thumbs/test_grid.png?token=one&size=2"

    class FakeResponse:
        status_code = 200
        text = '<meta content="/thumbs/test_grid.png?token=one&amp;size=2" property="og:image">'

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url, headers):
            assert url == test_url
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/v1/discovery-hub/fetch-hd-thumbs",
            json={"urls": [test_url], "force": True},
        )

    assert resp.status_code == 200
    assert cover_url in resp.text
    assert '"hd_ready": true' in resp.text.lower()
