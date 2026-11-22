"""Rýchla Range cesta: reálny HTTP server s Range, 429 injekciou a kontrolou, že sa nesťahuje celý súbor."""
import asyncio
import os
import shutil
import subprocess
import threading

import pytest
from aiohttp import web

from app import fast_thumb

FFMPEG = shutil.which("ffmpeg")
pytestmark = pytest.mark.skipif(not FFMPEG, reason="ffmpeg chýba")


@pytest.fixture(scope="module")
def video_bytes(tmp_path_factory):
    out = tmp_path_factory.mktemp("vid") / "t.mp4"
    # moov na konci (bez faststart) = najhorší prípad; šum -> veľký súbor
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", "testsrc2=size=1280x720:rate=25:duration=60",
                    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "60",
                    "-c:v", "libx264", "-b:v", "6M", "-g", "50", "-c:a", "aac", str(out)], check=True)
    return out.read_bytes()


class Server:
    def __init__(self, data: bytes, throttle_first: int = 0):
        self.data = data
        self.throttle_left = throttle_first
        self.bytes_sent = 0
        self.requests = 0
        self.port = 0
        self.loop = None

    async def handle(self, request: web.Request):
        self.requests += 1
        if self.throttle_left > 0:
            self.throttle_left -= 1
            return web.Response(status=429, headers={"Retry-After": "1"})
        rng = request.headers.get("Range")
        if not rng:
            self.bytes_sent += len(self.data)
            return web.Response(body=self.data)
        start, _, end = rng.split("=")[1].partition("-")
        start = int(start)
        end = min(int(end) if end else len(self.data) - 1, len(self.data) - 1)
        body = self.data[start:end + 1]
        self.bytes_sent += len(body)
        return web.Response(status=206, body=body, headers={
            "Content-Range": f"bytes {start}-{end}/{len(self.data)}", "Accept-Ranges": "bytes"})

    def start(self):
        ready = threading.Event()

        def run():
            self.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.loop)
            app = web.Application()
            app.router.add_get("/v.mp4", self.handle)
            self.runner = web.AppRunner(app)
            self.loop.run_until_complete(self.runner.setup())
            site = web.TCPSite(self.runner, "127.0.0.1", 0)
            self.loop.run_until_complete(site.start())
            self.port = site._server.sockets[0].getsockname()[1]
            ready.set()
            self.loop.run_forever()

        threading.Thread(target=run, daemon=True).start()
        ready.wait()
        return f"http://127.0.0.1:{self.port}/v.mp4"


def _extract(url, tmp_path, **kw):
    os.makedirs(tmp_path / "out", exist_ok=True)
    return asyncio.run(fast_thumb.extract_candidates(
        url, {"User-Agent": "t"}, 60, fast_thumb.fractions_for(None), str(tmp_path / "out")))


def test_extracts_frames_without_full_download(video_bytes, tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_FAST_THUMB", "1")
    srv = Server(video_bytes)
    paths = _extract(srv.start(), tmp_path)
    assert len(paths) == 5 and all(os.path.getsize(p) > 2000 for p in paths)
    assert srv.bytes_sent < len(video_bytes) * 0.5, (srv.bytes_sent, len(video_bytes))
    assert fast_thumb.metrics_snapshot()["bytes_total"] > 0


def test_second_run_uses_frame_cache_without_network(video_bytes, tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_FAST_THUMB", "1")
    srv = Server(video_bytes)
    url = srv.start()
    _extract(url, tmp_path)
    before = srv.requests
    assert len(_extract(url, tmp_path)) == 5
    assert srv.requests == before


def test_429_short_host_cooldown_then_success(video_bytes, tmp_path, monkeypatch):
    import time
    monkeypatch.setenv("NEXUS_FAST_THUMB", "1")
    srv = Server(video_bytes, throttle_first=3)
    started = time.monotonic()
    paths = _extract(srv.start(), tmp_path)
    assert len(paths) == 5
    assert time.monotonic() - started < 25  # krátky cooldown, žiadne 30-60 s
    assert fast_thumb.metrics_snapshot()["throttled"] >= 1


def test_server_without_range_is_unsupported(tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_FAST_THUMB", "1")

    class NoRange(Server):
        async def handle(self, request):
            return web.Response(body=b"x" * 5000)
    with pytest.raises(fast_thumb.FastThumbUnsupported):
        _extract(NoRange(b"").start(), tmp_path)


def test_job_store_recovers_running_jobs(tmp_path):
    store = fast_thumb.JobStore(str(tmp_path / "j.db"))
    store.enqueue([1, 2, 3])
    store.mark(1, "running")
    store.mark(2, "done")
    assert sorted(store.recover()) == [1, 3]
    assert store.counts() == {"pending": 2, "done": 1}


def test_limiter_grows_and_penalty_halves():
    async def run():
        lim = fast_thumb.AdaptiveLimiter(4, 8, grow_every=2, grow_step=2)
        for _ in range(4):
            async with lim:
                pass
        grown = lim.limit
        lim.penalize()
        return grown, lim.limit
    assert asyncio.run(run()) == (8, 4)
