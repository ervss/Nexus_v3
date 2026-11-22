"""
MPEG-TS playback support.

Browsers cannot play MPEG transport streams. Not "badly" — at all: Chromium's
`canPlayType` returns "" for every TS mime type and the demuxer refuses to open
the file, so a `.ts` card in the dashboard fails with DEMUXER_ERROR_COULD_NOT_OPEN
no matter what Content-Type the server sends.

The fix is to remux to MP4. Two shapes were possible:

  * pipe a *fragmented* MP4 out of ffmpeg on every request — instant start, but
    the browser gets no duration and no byte ranges, so the scrubber is a live
    ticker and seeking needs a bespoke shim over the native controls;
  * remux once into a real MP4 next to the cache, then serve that file with the
    normal Range handler.

This module does the second. A `-c copy` remux is I/O-bound (no re-encoding —
the exact same H.264/AAC packets get a new container), so the one-off wait is
roughly a file copy, and afterwards the card behaves like any other MP4:
seeking, duration, Studio slicing, thumbnails and clip export all work with no
special cases anywhere else in the app.

Remote `.ts` URLs work too — ffmpeg reads http input directly, so the remux
doubles as the download.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import time
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import unquote, urlparse

logger = logging.getLogger(__name__)

REMUX_DIR = os.path.join("app", "static", "remux")
os.makedirs(REMUX_DIR, exist_ok=True)

#: Container extensions that hold an MPEG transport stream. `.ts` also means
#: TypeScript, but nothing in a video library is a TypeScript file, and the
#: probe below settles it anyway before ffmpeg is asked to do any work.
TS_EXTENSIONS = (".ts", ".m2ts", ".mts", ".tp", ".trp", ".m2t")

#: The cache is a convenience, not storage: evict oldest-used past this.
CACHE_BUDGET_BYTES = 20 * 1024 * 1024 * 1024   # 20 GB

_NETWORK_ARGS = [
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
    "-user_agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]


def _ffmpeg() -> str:
    try:
        from .services import FFMPEG_CMD
        return FFMPEG_CMD
    except Exception:  # noqa: BLE001
        return shutil.which("ffmpeg") or "ffmpeg"


def is_ts_url(url: str) -> bool:
    """True when a library URL points at a transport stream.

    Only the path is inspected — a query string on a CDN link routinely ends in
    something that looks like an extension and would otherwise decide this.
    """
    if not url:
        return False
    path = urlparse(url).path if "://" in url else url.split("?", 1)[0]
    return path.lower().endswith(TS_EXTENSIONS)


def local_input_for(url: str, storage_type: str = "") -> Optional[str]:
    """Filesystem path behind a library URL, or None when it is remote."""
    url = (url or "").strip()
    if url.startswith("file://") or storage_type == "local_direct":
        raw = urlparse(url).path if url.startswith("file://") else url
        path = unquote(raw)
        if os.name == "nt" and path.startswith("/") and ":" in path[:4]:
            path = path[1:]
        return path if os.path.exists(path) else None
    if url.startswith("/static/"):
        path = os.path.join("app", url.lstrip("/").replace("/", os.sep))
        return path if os.path.exists(path) else None
    return None


def ffmpeg_input_for(url: str, storage_type: str = "") -> tuple[str, bool]:
    """(what to hand ffmpeg, is_local). Remote URLs are passed through as-is."""
    local = local_input_for(url, storage_type)
    if local:
        return local, True
    if url.startswith(("http://", "https://")):
        return url, False
    return "", False


def cache_path(video_id: int) -> str:
    return os.path.join(REMUX_DIR, f"v{int(video_id)}.mp4")


def cache_url(video_id: int) -> str:
    return f"/static/remux/v{int(video_id)}.mp4"


# ------------------------------------------------------------------- job state

@dataclass
class RemuxJob:
    video_id: int
    state: str = "working"          # working | ready | error
    percent: float = 0.0
    error: str = ""
    started_at: float = field(default_factory=time.monotonic)
    out_mb: float = 0.0


#: One job per video id. Two tabs hitting play on the same .ts must share a
#: single ffmpeg, not race each other writing the same output file.
_JOBS: dict[int, RemuxJob] = {}
_LOCKS: dict[int, asyncio.Lock] = {}


def _lock_for(video_id: int) -> asyncio.Lock:
    lock = _LOCKS.get(video_id)
    if lock is None:
        lock = _LOCKS[video_id] = asyncio.Lock()
    return lock


def status(video_id: int) -> dict:
    """What the player polls: ready / working+percent / error / missing."""
    path = cache_path(video_id)
    if os.path.exists(path) and os.path.getsize(path) > 1024:
        job = _JOBS.get(video_id)
        if not job or job.state == "ready":
            os.utime(path, None)      # touch: keeps a rewatched file out of eviction
            return {"state": "ready", "percent": 100.0,
                    "url": cache_url(video_id),
                    "size_mb": round(os.path.getsize(path) / 1_048_576, 1)}
    job = _JOBS.get(video_id)
    if not job:
        return {"state": "missing", "percent": 0.0, "url": ""}
    return {"state": job.state, "percent": round(job.percent, 1),
            "error": job.error, "url": cache_url(video_id) if job.state == "ready" else "",
            "size_mb": round(job.out_mb, 1)}


# ---------------------------------------------------------------------- remux

_PROGRESS_TIME_RE = re.compile(rb"out_time_ms=(\d+)")


async def _run_remux(video_id: int, source: str, is_local: bool,
                     duration: float, job: RemuxJob, *, reencode: bool) -> bool:
    """One ffmpeg pass. Returns True on a usable output file."""
    dest = cache_path(video_id)
    tmp = dest + ".part"
    net = [] if is_local else _NETWORK_ARGS
    codec = (["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac"]
             if reencode else ["-c", "copy"])
    cmd = [_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
           "-fflags", "+genpts",          # TS timestamps are routinely broken/rolling
           *net, "-i", source,
           *codec, "-movflags", "+faststart",
           # `-f mp4` is not optional: the output is written to a `.part` file so
           # a half-finished remux can never be served, and ffmpeg cannot guess a
           # container from that suffix ("Unable to find a suitable output format").
           "-f", "mp4", "-progress", "pipe:1", "-nostats", tmp]

    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            match = _PROGRESS_TIME_RE.search(line)
            if match and duration > 0:
                secs = int(match.group(1)) / 1_000_000
                job.percent = max(job.percent, min(99.0, secs / duration * 100))
            if os.path.exists(tmp):
                job.out_mb = os.path.getsize(tmp) / 1_048_576
        await proc.wait()
        err = (await proc.stderr.read() or b"").decode(errors="ignore").strip()
    except asyncio.CancelledError:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        raise

    ok = proc.returncode == 0 and os.path.exists(tmp) and os.path.getsize(tmp) > 64_000
    if ok:
        os.replace(tmp, dest)
        return True
    try:
        os.remove(tmp)
    except OSError:
        pass
    job.error = err[-300:] or f"ffmpeg skončil s kódom {proc.returncode}"
    return False


async def ensure_mp4(video_id: int, url: str, storage_type: str = "",
                     duration: float = 0.0) -> dict:
    """Remux this video into the cache if it isn't there. Single-flight.

    Falls back to a real re-encode if stream copy produces nothing usable —
    some capture cards write TS with codecs MP4 cannot carry (MPEG-2 video,
    AC-3 in older recordings), and copying those into an MP4 fails outright.
    """
    async with _lock_for(video_id):
        current = status(video_id)
        if current["state"] == "ready":
            return current

        source, is_local = ffmpeg_input_for(url, storage_type)
        if not source:
            return {"state": "error", "percent": 0.0,
                    "error": "Súbor sa nenašiel na disku ani to nie je odkaz.", "url": ""}

        job = _JOBS[video_id] = RemuxJob(video_id=video_id)
        try:
            ok = await _run_remux(video_id, source, is_local, duration, job, reencode=False)
            if not ok:
                logger.info("[ts] stream copy failed for %s (%s) — re-encoding",
                            video_id, job.error[:120])
                job.percent, job.error = 0.0, ""
                ok = await _run_remux(video_id, source, is_local, duration, job, reencode=True)
            job.state = "ready" if ok else "error"
        except Exception as exc:  # noqa: BLE001
            job.state, job.error = "error", str(exc)[:300]
            logger.exception("[ts] remux crashed for video %s", video_id)

        if job.state == "ready":
            job.percent = 100.0
            _evict_cache()
        return status(video_id)


def _evict_cache(budget: int = CACHE_BUDGET_BYTES) -> None:
    """Drop least-recently-served remuxes once the cache passes its budget."""
    try:
        files = [(os.path.getatime(os.path.join(REMUX_DIR, f)),
                  os.path.getsize(os.path.join(REMUX_DIR, f)),
                  os.path.join(REMUX_DIR, f))
                 for f in os.listdir(REMUX_DIR) if f.endswith(".mp4")]
    except OSError:
        return
    total = sum(size for _, size, _ in files)
    for _, size, path in sorted(files):          # oldest access first
        if total <= budget:
            break
        try:
            os.remove(path)
            total -= size
            logger.info("[ts] evicted remux cache file %s", os.path.basename(path))
        except OSError:
            pass


def forget(video_id: int) -> bool:
    """Drop one cached remux — the "it converted wrong, do it again" path."""
    _JOBS.pop(video_id, None)
    try:
        os.remove(cache_path(video_id))
        return True
    except OSError:
        return False


def cache_summary() -> dict:
    try:
        files = [os.path.join(REMUX_DIR, f) for f in os.listdir(REMUX_DIR) if f.endswith(".mp4")]
    except OSError:
        files = []
    total = sum(os.path.getsize(f) for f in files if os.path.exists(f))
    return {"files": len(files), "size_mb": round(total / 1_048_576, 1),
            "budget_mb": round(CACHE_BUDGET_BYTES / 1_048_576),
            "working": [j.video_id for j in _JOBS.values() if j.state == "working"]}
