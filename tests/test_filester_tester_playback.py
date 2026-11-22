import asyncio
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app import main
from app.extractors import filester as filester_mod
from app.routers import link_tester


class _FakeStreamResponse:
    def __init__(self, status_code: int, headers: dict, chunks: list[bytes]):
        self.status_code = status_code
        self.headers = headers
        self._chunks = chunks
        self.closed = False

    async def aiter_bytes(self, _size=65536):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self):
        self.closed = True


class _FakeRequest:
    def __init__(self, headers=None):
        self.headers = headers or {"range": "bytes=0-3"}
        self.base_url = "http://localhost:8000/"


def test_video_proxy_does_not_treat_fsc_cdn_cr_as_bunkr_and_autoheals_filester(monkeypatch):
    seen_requests = []

    class FakeSharedClient:
        def build_request(self, method, url, headers=None, timeout=None):
            return SimpleNamespace(method=method, url=url, headers=dict(headers or {}), timeout=timeout)

        async def send(self, req, stream=False):
            seen_requests.append((req.url, req.headers))
            if "token=expired" in req.url:
                return _FakeStreamResponse(403, {}, [])
            return _FakeStreamResponse(
                206,
                {
                    "content-type": "application/octet-stream",
                    "content-range": "bytes 0-3/100",
                    "content-length": "4",
                    "accept-ranges": "bytes",
                },
                [b"ftyp"],
            )

    monkeypatch.setattr(main, "_get_shared_video_proxy_client", lambda: FakeSharedClient())
    monkeypatch.setattr(main, "_require_public_proxy_url", lambda u: u)
    monkeypatch.setattr(filester_mod, "_load_cookies_from_paths", lambda _paths: {})
    monkeypatch.setattr(
        filester_mod.FilesterExtractor,
        "extract",
        AsyncMock(return_value={"stream_url": "https://fsc2.cdn.cr/v2/clip_no_ext?token=fresh"}),
    )

    resp = asyncio.run(
        main.video_stream_proxy(
            url="https://fsc1.cdn.cr/v2/clip_no_ext?token=expired",
            request=_FakeRequest(),
            referer="https://filester.me/d/Fa4cik1",
        )
    )

    assert resp.status_code == 206
    assert resp.media_type == "video/mp4"
    assert seen_requests[0][0] == "https://fsc1.cdn.cr/v2/clip_no_ext?token=expired"
    assert seen_requests[0][1]["Referer"] == "https://filester.me/d/Fa4cik1"
    assert seen_requests[1][0] == "https://fsc2.cdn.cr/v2/clip_no_ext?token=fresh"


def test_video_proxy_defaults_fsc_cdn_cr_referer_to_filester_when_omitted(monkeypatch):
    seen_requests = []

    class FakeSharedClient:
        def build_request(self, method, url, headers=None, timeout=None):
            return SimpleNamespace(method=method, url=url, headers=dict(headers or {}), timeout=timeout)

        async def send(self, req, stream=False):
            seen_requests.append((req.url, req.headers))
            return _FakeStreamResponse(200, {"content-type": "video/mp4", "content-length": "4"}, [b"data"])

    monkeypatch.setattr(main, "_get_shared_video_proxy_client", lambda: FakeSharedClient())
    monkeypatch.setattr(main, "_require_public_proxy_url", lambda u: u)
    monkeypatch.setattr(filester_mod, "_load_cookies_from_paths", lambda _paths: {})

    resp = asyncio.run(
        main.video_stream_proxy(
            url="https://fsc1.cdn.cr/v2/clip.mp4?token=live",
            request=_FakeRequest(headers={}),
            referer="",
        )
    )

    assert resp.status_code == 200
    assert seen_requests[0][1]["Referer"] == "https://filester.me/"


def test_stream_frame_allows_fsc_cdn_cr_with_filester_referer(monkeypatch):
    commands = []

    def fake_run(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout=b"jpeg", stderr=b"")

    monkeypatch.setenv("FFMPEG_PATH", "ffmpeg-test")
    monkeypatch.setattr(link_tester.os.path, "isfile", lambda _p: True)
    monkeypatch.setattr(link_tester.subprocess, "run", fake_run)
    monkeypatch.setattr(link_tester, "_require_public_proxy_url", lambda value: value)
    link_tester._STREAM_FRAME_CACHE.clear()

    result = asyncio.run(
        link_tester.stream_frame_proxy("https://fsc1.cdn.cr/v2/clip.mp4?token=live", at=5, width=640)
    )

    assert result.body == b"jpeg"
    assert "Referer: https://filester.me/\r\n" in commands[0]
    link_tester._STREAM_FRAME_CACHE.clear()


def test_fetch_filester_meta_includes_content_type_and_is_hls(monkeypatch):
    monkeypatch.setattr(
        link_tester._filester_extractor,
        "extract",
        AsyncMock(return_value={
            "title": "Clip",
            "thumbnail": "https://filester.me/t/thumb",
            "duration": 42,
            "size_bytes": 1048576,
            "width": 1920,
            "height": 1080,
            "stream_url": "https://fsc1.cdn.cr/v2/clip.mp4?token=live",
            "content_type": "video/mp4",
            "is_hls": False,
            "uploaded_at": "2026-10-01T00:00:00+00:00",
        }),
    )

    result = asyncio.run(
        link_tester._fetch_filester_meta("https://filester.me/d/Fa4cik1", asyncio.Semaphore(1))
    )

    assert result["ok"] is True
    assert result["content_type"] == "video/mp4"
    assert result["is_hls"] is False
    assert result["stream_url"] == "https://fsc1.cdn.cr/v2/clip.mp4?token=live"


def test_video_proxy_autoheals_expired_turbo_url_and_defaults_turbocdn_referer(monkeypatch):
    from app.extractors import turbo as turbo_mod

    seen_requests = []

    class FakeSharedClient:
        def build_request(self, method, url, headers=None, timeout=None):
            return SimpleNamespace(method=method, url=url, headers=dict(headers or {}), timeout=timeout)

        async def send(self, req, stream=False):
            seen_requests.append((req.url, req.headers))
            if "token=expired" in req.url:
                return _FakeStreamResponse(403, {}, [])
            return _FakeStreamResponse(
                206,
                {
                    "content-type": "application/octet-stream",
                    "content-range": "bytes 0-3/100",
                    "content-length": "4",
                    "accept-ranges": "bytes",
                },
                [b"ftyp"],
            )

    monkeypatch.setattr(main, "_get_shared_video_proxy_client", lambda: FakeSharedClient())
    monkeypatch.setattr(main, "_require_public_proxy_url", lambda u: u)
    monkeypatch.setattr(
        turbo_mod.TurboExtractor,
        "extract",
        AsyncMock(return_value={"stream_url": "https://cdn2.turbocdn.st/turbo/data/abc?token=fresh"}),
    )

    resp = asyncio.run(
        main.video_stream_proxy(
            url="https://cdn1.turbocdn.st/turbo/data/abc?token=expired",
            request=_FakeRequest(),
            referer="https://turbo.cr/v/abc123",
        )
    )

    assert resp.status_code == 206
    assert resp.media_type == "video/mp4"
    assert seen_requests[0][1]["Referer"] == "https://turbo.cr/v/abc123"
    assert seen_requests[1][0] == "https://cdn2.turbocdn.st/turbo/data/abc?token=fresh"

