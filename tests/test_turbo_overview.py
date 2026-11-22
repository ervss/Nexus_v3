import asyncio
import json
import struct

import httpx
import pytest

from app.mp4_probe import parse_tkhd_dimensions
from app.turbo_overview import RateLimited, allowed_url, bounded_get, read_metadata, turbo_id


@pytest.mark.parametrize("url", ["https://evil.test/turbo.cr/v/a", "https://turbo.cr.evil.test/v/a", "https://turbo.cr/a/album", "http://turbo.cr/v/a", "https://user@turbo.cr/v/a", "https://turbo.cr:8000/v/a"])
def test_reject_non_video_and_impostor_urls(url):
    assert not turbo_id(url)


def test_stable_identity_and_case():
    assert turbo_id("https://turbo.cr/embed/Ab-c_D?expires=123") == "Ab-c_D"
    assert turbo_id("https://turbo.cr/d/Ab-c_D") == "Ab-c_D"
    with pytest.raises(ValueError):
        allowed_url("https://turbocdn.st.evil.test/video", True)


def tkhd(width=1920, height=1080, rotate=False):
    payload = bytearray(84)
    matrix = (0, 65536, 0, -65536, 0, 0, 0, 0, 1 << 30) if rotate else (65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30)
    payload[-44:-8] = struct.pack(">9i", *matrix)
    payload[-8:] = struct.pack(">II", width << 16, height << 16)
    return struct.pack(">I4s", 92, b"tkhd") + payload


def test_rotation_uses_display_dimensions():
    assert parse_tkhd_dimensions(tkhd()) == (1920, 1080)
    assert parse_tkhd_dimensions(tkhd(rotate=True)) == (1080, 1920)


def test_range_total_and_html_rejection():
    async def run():
        def handler(request):
            if request.url.path == "/html":
                return httpx.Response(200, headers={"content-type": "text/html", "content-length": "100000000"}, content=b"error")
            return httpx.Response(206, headers={"content-type": "video/mp4", "content-range": "bytes 0-15/987654", "content-length": "16"}, content=b"0" * 16)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            body, size, ranged = await bounded_get(client, "https://cdn1.turbocdn.st/video", 16, media=True, start=0)
            assert size == 987654 and ranged and len(body) == 16
            with pytest.raises(ValueError):
                await bounded_get(client, "https://cdn1.turbocdn.st/html", 16, media=True, start=0)
    asyncio.run(run())


def test_redirect_is_checked_before_private_destination_fetch():
    calls = []
    async def run():
        def handler(request):
            calls.append(str(request.url))
            return httpx.Response(302, headers={"location": "http://127.0.0.1:8000/secrets"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(ValueError):
                await bounded_get(client, "https://turbo.cr/v/a", 100)
    asyncio.run(run())
    assert calls == ["https://turbo.cr/v/a"]


def test_ignored_range_stops_reading_at_budget_and_skips_tail():
    class HugeBody(httpx.AsyncByteStream):
        consumed = 0
        async def __aiter__(self):
            for _ in range(1000):
                self.consumed += 1
                yield b"x" * 16384
    body = HugeBody()
    calls = []
    async def run():
        def handler(request):
            calls.append(str(request.url))
            if request.url.host == "turbo.cr":
                if request.url.path == "/api/sign":
                    return httpx.Response(200, json={"url": "https://cdn1.turbocdn.st/file?token=secret"})
                return httpx.Response(200, text='<title>1080p filename | turbo.cr</title>')
            return httpx.Response(200, headers={"content-type": "video/mp4", "content-length": "999999999"}, stream=body)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await read_metadata("https://turbo.cr/v/a", client)
            assert result["size_bytes"] == 999999999
            assert result["width"] == result["height"] == 0
            assert "secret" not in json.dumps(result)
    asyncio.run(run())
    assert body.consumed == 8
    assert len(calls) == 3


def test_rate_limit_returns_retry_after_without_hidden_retry():
    calls = []
    async def run():
        def handler(request):
            calls.append(str(request.url))
            return httpx.Response(429, headers={"Retry-After": "120"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(RateLimited) as exc:
                await bounded_get(client, "https://turbo.cr/v/a", 100)
            assert exc.value.seconds == 120
    asyncio.run(run())
    assert len(calls) == 1
