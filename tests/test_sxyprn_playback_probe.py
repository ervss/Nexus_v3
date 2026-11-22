import asyncio
import httpx
import pytest
from app import sxyprn_playback


@pytest.mark.parametrize('status,body,expected', [
    (404, b'Not found', False),
    (200, b'<html>Video player</html>', False),
    (200, b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nvideo.m3u8', True),
    (206, b'\x00\x00\x00\x20ftypisom', True),
])
def test_only_real_media_is_accepted(monkeypatch, status, body, expected):
    original = httpx.AsyncClient
    def handler(request):
        assert request.headers['Range'] == 'bytes=0-4095'
        assert request.headers['Referer'] == 'https://sxyprn.com/post/123.html'
        return httpx.Response(status, content=body)
    monkeypatch.setattr(sxyprn_playback.httpx, 'AsyncClient',
                        lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    assert asyncio.run(sxyprn_playback.probe_media(
        'https://cdn.example/master.m3u8', 'https://sxyprn.com/post/123.html')) is expected


def test_tnmr_probe_uses_lulu_origin_and_supported_user_agent(monkeypatch):
    original = httpx.AsyncClient

    def handler(request):
        assert request.headers["referer"] == "https://luluvdo.com/"
        assert request.headers["origin"] == "https://luluvdo.com"
        assert "Chrome/131.0.0.0" in request.headers["user-agent"]
        assert "accept-language" not in request.headers
        return httpx.Response(200, content=b"#EXTM3U\n#EXT-X-VERSION:3\n")

    monkeypatch.setattr(sxyprn_playback.httpx, "AsyncClient",
                        lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))

    assert asyncio.run(sxyprn_playback.probe_media(
        "https://cdn1004.cdn-tnmr.org/hls/video/master.m3u8",
        "https://www.sxyprn.net/post/123.html",
    ))


def test_failed_host_page_never_replaces_import_stream(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import MagicMock, AsyncMock
    from fastapi import HTTPException
    from app import main
    from app.extractors.sxyprn import SxyPrnExtractor
    original = 'https://cdn.example/original.m3u8'
    video = SimpleNamespace(url=original, source_url='https://sxyprn.com/post/123abc.html')
    db = MagicMock()
    db.query.return_value.get.return_value = video
    monkeypatch.setattr(SxyPrnExtractor, 'extract', AsyncMock(return_value={
        'stream_url': 'https://vidara.so/e/dead-host-player', 'is_hls': False}))
    monkeypatch.setattr(sxyprn_playback, 'probe_media', AsyncMock(return_value=False))
    monkeypatch.setattr(main, "fetch_post_streams", lambda *_args: [])
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.get_sxyprn_stream(999999, db, force_refresh=True))
    assert error.value.status_code == 502
    assert video.url == original
    db.commit.assert_not_called()


@pytest.mark.parametrize("stream_url, expected_referer", [
    ("https://cdn1018.cdn-tnmr.org/hls/video/master.m3u8?token=expired",
     "https://luluvdo.com/"),
    ("https://s8-s251765.97bf1.com/hls/video/master.m3u8?token=fresh",
     "https://vidara.so/"),
    ("https://cdn.vidara.to/hls/video/master.m3u8",
     "https://vidara.to/"),
    ("https://cdn.luluvdo.com/hls/video/master.m3u8",
     "https://luluvdo.com/"),
    ("https://bysesukior.com/video/master.m3u8",
     "https://bysesukior.com/"),
    ("https://cdn.example/video/master.m3u8", "https://www.sxyprn.net/post/123abc.html"),
])
def test_sxyprn_jit_probes_media_with_provider_referer(monkeypatch, stream_url, expected_referer):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, MagicMock
    from app import main
    from app.extractors.sxyprn import SxyPrnExtractor

    video = SimpleNamespace(url="https://expired.example/old.m3u8",
                            source_url="https://www.sxyprn.net/post/123abc.html")
    db = MagicMock()
    db.query.return_value.get.return_value = video

    async def probe(url, referer):
        assert url == stream_url
        assert referer == expected_referer
        return True

    monkeypatch.setattr(SxyPrnExtractor, "extract", AsyncMock(return_value={
        "stream_url": stream_url, "is_hls": True,
    }))
    monkeypatch.setattr(sxyprn_playback, "probe_media", probe)

    result = asyncio.run(main.get_sxyprn_stream(6438, db, force_refresh=True))

    assert result["stream_url"] == stream_url
    assert result["referer"] == expected_referer
    assert video.url == stream_url
    db.commit.assert_called_once()


def test_sxyprn_cached_stream_keeps_provider_referer(monkeypatch):
    import time
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    from app import main

    video = SimpleNamespace(
        url="https://cdn1018.cdn-tnmr.org/hls/video/master.m3u8",
        source_url="https://www.sxyprn.net/post/123abc.html",
    )
    db = MagicMock()
    db.query.return_value.get.return_value = video
    main.get_sxyprn_stream._cache = {
        6438: {"url": video.url, "ts": time.time()},
    }

    async def probe(*_args):
        return True

    monkeypatch.setattr(sxyprn_playback, "probe_media", probe)

    result = asyncio.run(main.get_sxyprn_stream(6438, db))

    assert result["cached"] is True
    assert result["referer"] == "https://luluvdo.com/"


@pytest.mark.parametrize(("url", "now", "expected"), [
    ("https://cdn.example/master.m3u8?e=28800", 1_800_000_000, False),
    ("https://cdn.example/master.m3u8?e=1790000000", 1_800_000_000, True),
    ("https://cdn.example/master.m3u8?e=1800000100", 1_800_000_000, False),
    ("https://cdn.example/master.m3u8?expires=1800000000000", 1_800_000_000, False),
])
def test_thumbnail_expiry_detection_only_accepts_expired_epoch_values(url, now, expected):
    from app.routers.bulk_import import _has_expired_epoch_parameter

    assert _has_expired_epoch_parameter(url, now) is expected


@pytest.mark.parametrize(("url", "expected"), [
    ("https://cdn1004.cdn-tnmr.org/hls/video/master.m3u8", "https://luluvdo.com/"),
    ("https://s8-s251765.97bf1.com/hls/video/master.m3u8", "https://vidara.so/"),
    ("https://bysesukior.com/video/master.m3u8", "https://bysesukior.com/"),
])
def test_provider_referer_is_shared_with_thumbnail_generation(url, expected):
    assert sxyprn_playback.provider_referer(
        url, "https://www.sxyprn.net/post/123.html"
    ) == expected


@pytest.mark.parametrize(("url", "expected_referer", "expected_origin"), [
    ("https://cdn1004.cdn-tnmr.org/hls/video/master.m3u8",
     "https://luluvdo.com/", "https://luluvdo.com"),
    ("https://s8-s251765.97bf1.com/hls/video/master.m3u8",
     "https://vidara.so/", None),
])
def test_sxyprn_hls_proxy_uses_provider_headers(url, expected_referer, expected_origin):
    from app.main import _sxyprn_proxy_provider_headers

    headers = _sxyprn_proxy_provider_headers(url, "https://www.sxyprn.net/post/123.html")

    assert headers["Referer"] == expected_referer
    assert headers.get("Origin") == expected_origin
    assert "Chrome/131.0.0.0" in headers["User-Agent"]


def test_sxyprn_poster_fallback_downloads_image_with_open_client(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, MagicMock
    from app import services
    from app.database import Video
    from app.extractors.sxyprn import SxyPrnExtractor
    from app.routers import bulk_import

    source_url = "https://www.sxyprn.net/post/123abc.html"
    video = SimpleNamespace(id=1, source_url=source_url, thumbnail_path="")
    db = MagicMock()
    db.query.return_value.get.return_value = video
    db.get.return_value = video
    monkeypatch.setattr(bulk_import, "SessionLocal", lambda: db)
    monkeypatch.setattr(bulk_import, "_has_expired_epoch_parameter", lambda *_args: True)
    monkeypatch.setattr(services, "THUMB_DIR", str(tmp_path))
    monkeypatch.setattr(SxyPrnExtractor, "extract", AsyncMock(return_value={}))

    class Response:
        def __init__(self, status_code, text="", content=b""):
            self.status_code = status_code
            self.text = text
            self.content = content

    class Client:
        closed = False

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            self.closed = True

        async def get(self, url, headers=None):
            assert not self.closed
            if url == source_url:
                return Response(
                    200,
                    '<meta property="og:image" content="https://cdn.example/poster.jpg">',
                )
            assert url == "https://cdn.example/poster.jpg"
            return Response(200, content=b"poster image")

    monkeypatch.setattr(bulk_import.httpx, "AsyncClient", lambda **_kwargs: Client())

    asyncio.run(bulk_import._ffmpeg_thumbnail_limited(
        video.id, "https://dead.example/video.m3u8", source_url=source_url
    ))

    assert (tmp_path / "thumb_1.jpg").read_bytes() == b"poster image"
    assert video.thumbnail_path == "/static/thumbnails/thumb_1.jpg"
    db.commit.assert_called_once()


@pytest.mark.parametrize(("url", "expected"), [
    ("https://vidara.so/v/abc123", "https://vidara.so/e/abc123"),
    ("https://bysesukior.com/e/abc123", "https://bysesukior.com/e/abc123"),
    ("https://lulustream.com/mkekjudihdmp", "https://luluvdo.com/e/mkekjudihdmp"),
    ("https://streamtape.com/v/abc123", "https://streamtape.com/e/abc123"),
    ("https://untrusted.example/e/abc123", ""),
])
def test_sxyprn_embed_fallback_only_accepts_supported_hosts(url, expected):
    from app.main import _sxyprn_embed_url

    assert _sxyprn_embed_url(url) == expected


def test_sxyprn_jit_returns_safe_embed_when_direct_media_is_unavailable(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, MagicMock
    from app import main
    from app.extractors.sxyprn import SxyPrnExtractor

    video = SimpleNamespace(
        url="https://expired.example/old.m3u8",
        source_url="https://www.sxyprn.net/post/123abc.html",
    )
    db = MagicMock()
    db.query.return_value.get.return_value = video
    main.get_sxyprn_stream._cache = {}
    monkeypatch.setattr(SxyPrnExtractor, "extract", AsyncMock(return_value={
        "stream_url": "https://sxyprn.net/cdn/expired.vid",
        "is_hls": False,
    }))
    monkeypatch.setattr(sxyprn_playback, "probe_media", AsyncMock(return_value=False))
    monkeypatch.setattr(main, "fetch_post_streams", lambda *_args: [
        {"url": "https://vidara.so/v/abc123"},
    ])

    result = asyncio.run(main.get_sxyprn_stream(6438, db, force_refresh=True))

    assert result["embed_url"] == "https://vidara.so/e/abc123"
    assert video.url == "https://expired.example/old.m3u8"
    db.commit.assert_not_called()


def test_sxyprn_jit_preserves_supported_imported_embed():
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    from app.main import get_sxyprn_stream

    video = SimpleNamespace(
        url="https://luluvdo.com/e/abc123",
        source_url="https://www.sxyprn.net/post/123abc.html",
    )
    db = MagicMock()
    db.query.return_value.get.return_value = video

    result = asyncio.run(get_sxyprn_stream(6438, db, force_refresh=True))

    assert result["embed_url"] == "https://luluvdo.com/e/abc123"


def test_sxyprn_jit_prefers_provider_embed_when_browser_cannot_play_hls(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    from app import main

    video = SimpleNamespace(
        url="https://expired.example/master.m3u8",
        source_url="https://www.sxyprn.net/post/6a279ee835da9",
    )
    db = MagicMock()
    db.query.return_value.get.return_value = video
    monkeypatch.setattr(main, "fetch_post_streams", lambda *_args: [
        {"url": "https://Vidara.so/v/as76HFERKAOR3"},
    ])

    result = asyncio.run(main.get_sxyprn_stream(6494, db, force_refresh=True, prefer_embed=True))

    assert result["embed_url"] == "https://vidara.so/e/as76HFERKAOR3"
