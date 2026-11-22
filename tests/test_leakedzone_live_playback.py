import asyncio
import time
import httpx
import aiohttp
import pytest

from app.extractors.leakedzone import LeakedzoneExtractor
from app.main import _leakedzone_manifest_cache


@pytest.mark.asyncio
async def test_leakedzone_playback_live_end_to_end():
    url = "https://leakedzone.com/kassiewallis/video/25595707"
    ext = LeakedzoneExtractor()
    data = await ext.extract(url)

    assert data is not None, "Extraction failed"
    assert data["stream_url"].startswith("https://leakedzone.com/m3u8/")
    assert data["proxy_cookies"], "proxy_cookies must be captured from the session"
    assert "leakedzone_leak2_main_session" in data["proxy_cookies"]

    stream_url = data["stream_url"]
    cookies = data["proxy_cookies"]
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Referer": url,
        "Origin": "https://leakedzone.com",
        "Accept": "*/*",
    }

    # Simulate /hls_proxy upstream fetch
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
        async with session.get(stream_url, headers=headers, cookies=cookies, ssl=False) as resp:
            assert resp.status == 200, f"Expected 200, got {resp.status}"
            content = await resp.text()
            assert "#EXTM3U" in content
            assert ".b-cdn.net" in content

    # Test cache insertion & retrieval
    _leakedzone_manifest_cache[stream_url] = {"content": content, "ts": time.time()}
    assert stream_url in _leakedzone_manifest_cache
    assert _leakedzone_manifest_cache[stream_url]["content"] == content
