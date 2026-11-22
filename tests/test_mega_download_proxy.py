import asyncio
import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import httpx
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.routers import mega
from app.extractors import mega_native as mn
from app.tor_service import tor_service


@contextmanager
def fixture_proxy(payload, ref, *, fail_status=None, truncate_bytes=None):
    requests = []
    ciphertext = mn.MegaCTRDecryptor(ref.key_a32, 0).decrypt(payload)

    class Proxy(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            requests.append((self.command, urlsplit(self.path).hostname, None))
            self.rfile.read(int(self.headers["Content-Length"]))
            body = json.dumps([{"g": "http://mega-download-fixture.invalid/video", "s": len(payload)}]).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            requested_range = self.headers["Range"]
            requests.append((self.command, urlsplit(self.path).hostname, requested_range))
            if fail_status:
                self.send_response(fail_status)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            start, end = map(int, requested_range.removeprefix("bytes=").split("-"))
            body = ciphertext[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(payload)}")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body[:truncate_bytes])

    with ThreadingHTTPServer(("127.0.0.1", 0), Proxy) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", requests
        finally:
            server.shutdown()
            worker.join()


@pytest.mark.parametrize("attachment", [True, False])
def test_media_routes_api_and_encrypted_range_through_configured_proxy(monkeypatch, attachment):
    payload = b"abcdefghijklmnopqrstuvwxyz" * 20
    ref = mn.MegaRef("file", "FILE0001", (1, 2, 3, 4, 5, 6, 7, 8))
    monkeypatch.setattr(mn, "MEGA_API", "http://mega-api-fixture.invalid/cs")
    monkeypatch.setattr(mega, "_CDN_CACHE", {})

    async def download():
        request = Request({"type": "http", "method": "GET", "headers": [(b"range", b"bytes=33-80")]})
        if attachment:
            response = await mega.download_mega_ref(ref.to_compact(), request, 1, "Test video.mp4")
            assert response.headers["content-disposition"] == "attachment; filename*=UTF-8''Test%20video.mp4"
        else:
            response = await mega._stream_mega_ref(ref.to_compact(), request, 1)
            assert response.headers["content-type"] == "video/mp4"
            assert "content-disposition" not in response.headers
        assert response.status_code == 206
        assert b"".join([chunk async for chunk in response.body_iterator]) == payload[33:81]

    with fixture_proxy(payload, ref) as (proxy, requests):
        monkeypatch.setattr(mega.config, "MEGA_PROXY_URL", proxy)
        asyncio.run(download())
    assert requests == [("POST", "mega-api-fixture.invalid", None), ("GET", "mega-download-fixture.invalid", "bytes=33-80")]


def test_download_rejects_invalid_proxy_configuration(monkeypatch):
    monkeypatch.setattr(mega.config, "MEGA_PROXY_URL", "file:///etc/invalid")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(mega.download_mega_ref("", None, 1, "Test.mp4"))
    assert exc.value.status_code == 503


def test_stream_never_retries_without_proxy_if_proxy_fails(monkeypatch):
    calls = []
    proxy = "http://127.0.0.1:3128"
    monkeypatch.setattr(mega.config, "MEGA_PROXY_URL", proxy)
    monkeypatch.setattr(mega, "_CDN_CACHE", {})

    async def blocked(_ref, *, proxy=""):
        calls.append(proxy)
        raise httpx.ProxyError("unavailable")

    monkeypatch.setattr(mn, "resolve_cdn", blocked)
    ref = mn.MegaRef("file", "FILE0001", tuple(range(8))).to_compact()
    with pytest.raises(HTTPException) as exc:
        asyncio.run(mega._stream_mega_ref(ref, None, 1))
    assert exc.value.status_code == 502
    assert calls == [proxy]


def test_tor_mode_reuses_isolation_identity_for_one_file_only(monkeypatch):
    monkeypatch.setattr(mega.config, "MEGA_PROXY_URL", "")
    monkeypatch.setattr(mega.config, "MEGA_PROXY_MODE", "tor")
    monkeypatch.setattr(mega, "_tor_ready_until", 0.0)
    monkeypatch.setattr(mega, "_TOR_FILE_GENERATIONS", mega.OrderedDict())
    monkeypatch.setenv("TOR_SOCKS_HOST", "127.0.0.1")
    monkeypatch.setenv("TOR_SOCKS_PORT", "9050")
    starts = []

    def start(**kwargs):
        starts.append(kwargs)
        return {"ready": True}

    monkeypatch.setattr(tor_service, "start", start)

    async def check_routes():
        first = urlsplit(await mega._media_proxy("file-one"))
        repeat = urlsplit(await mega._media_proxy("file-one"))
        other = urlsplit(await mega._media_proxy("file-two"))
        assert first == repeat
        assert first.password != other.password
        assert (first.scheme, first.hostname, first.port) == ("socks5h", "127.0.0.1", 9050)
        rotated = await mega._rotate_media_proxy("file-one", first.geturl())
        assert rotated != first.geturl()
        assert await mega._rotate_media_proxy("file-one", first.geturl()) == rotated
        assert await mega._media_proxy("file-two") == other.geturl()

    asyncio.run(check_routes())
    assert len(starts) == 1


def test_tor_mode_fails_closed_when_tor_is_unavailable(monkeypatch):
    monkeypatch.setattr(mega.config, "MEGA_PROXY_URL", "")
    monkeypatch.setattr(mega.config, "MEGA_PROXY_MODE", "tor")
    monkeypatch.setattr(mega, "_tor_ready_until", 0.0)
    monkeypatch.setattr(tor_service, "start", lambda **_: {"ready": False})
    with pytest.raises(HTTPException) as caught:
        asyncio.run(mega._media_proxy("file-one"))
    assert caught.value.status_code == 503


@pytest.mark.parametrize("quota_status, truncate, resume_from", [(509, None, 33), (None, 148, 161)])
def test_tor_rotation_resumes_exact_range(monkeypatch, quota_status, truncate, resume_from):
    payload = b"abcdefghijklmnopqrstuvwxyz" * 24
    ref = mn.MegaRef("file", "FILE0001", tuple(range(8)))
    monkeypatch.setattr(mega.config, "MEGA_PROXY_URL", "")
    monkeypatch.setattr(mega.config, "MEGA_PROXY_MODE", "tor")
    monkeypatch.setattr(mega, "_CDN_CACHE", {})
    monkeypatch.setattr(mega, "_CHUNK", 64)
    monkeypatch.setattr(mn, "MEGA_API", "http://mega-api-fixture.invalid/cs")

    with fixture_proxy(payload, ref, fail_status=quota_status, truncate_bytes=truncate) as (first, attempts):
        with fixture_proxy(payload, ref) as (second, resumed):
            async def initial_proxy(_compact):
                return first

            async def rotate(_compact, failed):
                assert failed == first
                return second

            async def download():
                request = Request({"type": "http", "method": "GET", "headers": [(b"range", b"bytes=33-334")]})
                response = await mega._stream_mega_ref(ref.to_compact(), request, 1)
                assert response.status_code == 206
                assert response.headers["content-range"] == f"bytes 33-334/{len(payload)}"
                assert b"".join([chunk async for chunk in response.body_iterator]) == payload[33:335]

            monkeypatch.setattr(mega, "_media_proxy", initial_proxy)
            monkeypatch.setattr(mega, "_rotate_media_proxy", rotate)
            asyncio.run(download())
            assert attempts[-1] == ("GET", "mega-download-fixture.invalid", "bytes=33-334")
            assert resumed == [("POST", "mega-api-fixture.invalid", None),
                               ("GET", "mega-download-fixture.invalid", f"bytes={resume_from}-334")]
