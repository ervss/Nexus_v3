import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import HTTPException

from app import lite_app
from starlette.requests import Request


def stored_video(storage="remote"):
    return SimpleNamespace(id=1, url="https://cdn.example/expired.m3u8?token=old",
                           source_url="https://source.example/watch/1", storage_type=storage)


def database(video):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = video
    return db


def test_expired_hls_resolves_source_and_uses_new_proxy_url(monkeypatch):
    video = stored_video()
    db = database(video)
    resolver = AsyncMock(return_value="https://cdn.example/fresh.m3u8?token=new")
    monkeypatch.setattr(lite_app, "_jit_resolve_stream_url", resolver)
    result = asyncio.run(lite_app.resolve_lite_playback(1, db=db))
    resolver.assert_awaited_once_with(video.source_url, "remote")
    assert result["is_hls"] is True
    query = parse_qs(urlparse(result["stream_url"]).query)
    assert query["url"] == ["https://cdn.example/fresh.m3u8?token=new"]
    assert query["referer"] == [video.source_url]
    assert video.url == query["url"][0]
    db.commit.assert_called_once()


def test_refresh_failure_is_explicit_and_preserves_stored_link(monkeypatch):
    video = stored_video()
    db = database(video)
    monkeypatch.setattr(lite_app, "_jit_resolve_stream_url", AsyncMock(return_value=None))
    with pytest.raises(HTTPException) as error:
        asyncio.run(lite_app.resolve_lite_playback(1, refresh=True, db=db))
    assert error.value.status_code == 502
    assert "prihlásenie" in error.value.detail
    assert "token=old" in video.url
    db.commit.assert_not_called()


@pytest.mark.parametrize("storage", ["local", "local_direct", "mega", "bittorrent"])
def test_local_and_bridge_playback_does_not_extract_remote_source(monkeypatch, storage):
    resolver = AsyncMock()
    monkeypatch.setattr(lite_app, "_jit_resolve_stream_url", resolver)
    result = asyncio.run(lite_app.resolve_lite_playback(1, refresh=True, db=database(stored_video(storage))))
    assert result["stream_url"] == "/api/lite/stream/1"
    resolver.assert_not_awaited()


def test_async_extractor_stream_method_is_awaited(monkeypatch):
    extractor = SimpleNamespace(extract_stream_url=AsyncMock(return_value="https://cdn.example/new.mp4"))
    monkeypatch.setattr(lite_app.ExtractorRegistry, "find_extractor", lambda url: extractor)
    assert asyncio.run(lite_app._jit_resolve_stream_url("https://source.example/watch/1")) == "https://cdn.example/new.mp4"


def test_watch_page_is_not_accepted_as_refreshed_stream(monkeypatch):
    monkeypatch.setattr(lite_app, "_jit_resolve_stream_url", AsyncMock(return_value="https://source.example/watch/1"))
    with pytest.raises(HTTPException) as error:
        asyncio.run(lite_app.resolve_lite_playback(1, db=database(stored_video())))
    assert error.value.status_code == 502


def test_fileditch_pretty_mp4_is_a_viewer_but_signed_cdn_is_direct():
    viewer = "https://fileditchfiles.st/alpha24/hash/video.mp4"
    signed = "https://beta.fileditchstuff5sept.com/alpha24/hash/video.mp4?md5=x&expires=9"

    assert lite_app._is_direct_streamable(viewer) is False
    assert lite_app._is_direct_streamable(signed) is True


@pytest.mark.parametrize("url", [
    "https://www.sxyprn.net/cdn5/token/c5/path/1791747769/video.vid",
    "https://www.sxyprn.com/cdn8/token/video.vid?token=signed",
    "https://c5.trafficdeposit.com/widi/path/video.vid",
])
def test_sxyprn_signed_vid_refresh_is_accepted_and_proxied(monkeypatch, url):
    video = stored_video()
    video.source_url = "https://www.sxyprn.net/post/6acbac240ce31"
    db = database(video)
    resolver = AsyncMock(return_value=url)
    monkeypatch.setattr(lite_app, "_jit_resolve_stream_url", resolver)
    result = asyncio.run(lite_app.resolve_lite_playback(1, db=db))
    assert result["stream_url"] == "/api/lite/stream/1"
    assert result["is_hls"] is False
    assert video.url == url
    db.commit.assert_called_once()
    resolver.assert_awaited_once_with(video.source_url, "remote")


def test_sxyprn_vid_proxy_preserves_range_referer_and_media_bytes(monkeypatch):
    video = stored_video()
    video.url = "https://www.sxyprn.net/cdn5/token/video.vid"
    video.source_url = "https://www.sxyprn.net/post/6acbac240ce31"
    video.thumbnail_referer = None
    upstream = SimpleNamespace(status_code=206,
        headers={"content-type": "video/mp4", "content-range": "bytes 0-7/200", "content-length": "8"},
        aclose=AsyncMock())
    async def chunks(**kwargs):
        yield b"mp4bytes"
    upstream.aiter_bytes = chunks
    client = MagicMock()
    client.send = AsyncMock(return_value=upstream)
    client.aclose = AsyncMock()
    monkeypatch.setattr(lite_app.httpx, "AsyncClient", lambda **kwargs: client)
    resolver = AsyncMock()
    monkeypatch.setattr(lite_app, "_jit_resolve_stream_url", resolver)
    request = Request({"type": "http", "headers": [(b"range", b"bytes=0-7")]})
    async def consume():
        result = await lite_app.stream_lite_video(1, request, db=database(video))
        assert result.status_code == 206
        assert result.headers["content-type"] == "video/mp4"
        assert result.headers["content-range"] == "bytes 0-7/200"
        assert result.headers["content-encoding"] == "identity"
        return b"".join([chunk async for chunk in result.body_iterator])
    assert asyncio.run(consume()) == b"mp4bytes"
    assert client.build_request.call_args.kwargs["headers"]["Range"] == "bytes=0-7"
    assert client.build_request.call_args.kwargs["headers"]["Accept-Encoding"] == "identity"
    assert client.build_request.call_args.kwargs["headers"]["Referer"] == video.source_url
    resolver.assert_not_awaited()
    upstream.aclose.assert_awaited_once()
    client.aclose.assert_awaited_once()


@pytest.mark.parametrize("url", [
    "https://www.sxyprn.net/post/6acbac240ce31",
    "https://unrelated.example/video.vid",
    "https://sxyprn.net.evil.example/video.vid",
    "https://evil.example/watch?file=video.vid&source=sxyprn.net",
])
def test_sxyprn_vid_detection_rejects_watch_pages_and_unrelated_hosts(url):
    assert lite_app._is_direct_streamable(url) is False


def test_hls_manifest_rewrites_each_segment_once_and_respects_redirect_base(monkeypatch):
    upstream = SimpleNamespace(
        status_code=200, headers={"content-type": "application/vnd.apple.mpegurl"},
        url="https://cdn.example/redirected/master.m3u8",
        aread=AsyncMock(return_value=b'#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:5,\nsegment.ts\n'),
        aclose=AsyncMock(),
    )
    client = MagicMock()
    client.send = AsyncMock(return_value=upstream)
    client.aclose = AsyncMock()
    monkeypatch.setattr(lite_app.httpx, "AsyncClient", lambda **kwargs: client)
    request = Request({"type": "http", "headers": []})
    result = asyncio.run(lite_app.lite_hls_proxy("https://cdn.example/old/master.m3u8", request, "https://source.example/watch/1"))
    lines = result.body.decode().splitlines()
    segments = [line for line in lines if line and not line.startswith("#")]
    assert len(segments) == 1
    assert parse_qs(urlparse(segments[0]).query)["url"] == ["https://cdn.example/redirected/segment.ts"]
    assert 'URI="/api/lite/hls?' in lines[1]
    assert 'URI="/api/lite/hls?' in lines[2]
    assert "segment.ts" not in lines
    upstream.aclose.assert_awaited_once()
    client.aclose.assert_awaited_once()
