"""
MP4 duration probe — reads a video's duration (and total size) WITHOUT
downloading the file.

Bunkr (and similar file hosts) expose no duration anywhere: not in the album
listing, not on the file page, not in /api/vs. The only place it exists is
inside the MP4 container itself — the `moov`→`mvhd` box carries timescale +
duration. Their CDNs support HTTP Range, so two small ranged GETs are enough:

    1. first 128 KB  — covers "fast-start" files (moov at the front)
    2. last  256 KB  — covers everything else (moov appended after encode)

Results are cached persistently keyed by the file PAGE url (stream URLs are
signed and expire); a video's duration never changes, so the TTL is long.

Works for mp4/m4v/mov (ISO-BMFF). mkv/webm use EBML — not handled here; the
caller should just leave duration at 0 for those.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import struct
import time
from pathlib import Path
from threading import RLock
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Concurrent CDN range reads. A fetched gallery probes many files at once;
# 429/503 retries inside _ranged_get still back off a single hot node.
_PROBE_GATE = asyncio.Semaphore(12)

_HEAD_BYTES = 128 * 1024
_TAIL_BYTES = 256 * 1024
_MOOV_BYTES = 1024 * 1024  # moov grows with duration (sample tables); 1 MB covers most
_MAX_DURATION_SEC = 24 * 3600  # sanity bound for a false-positive 'mvhd' match

_CACHE_PATH = Path("data") / "mp4_probe_cache.json"
_CACHE_TTL = 60 * 24 * 3600  # 60 days; durations are immutable
_CACHE_MAX = 20000
_cache: dict[str, dict] = {}
_cache_loaded = False
_cache_dirty = False
_cache_lock = RLock()

PROBEABLE_EXT_RE = re.compile(r"\.(mp4|m4v|mov)(?:[?#]|$)", re.I)


def _load_cache() -> None:
    global _cache_loaded, _cache
    if _cache_loaded:
        return
    with _cache_lock:
        if _cache_loaded:
            return
        try:
            if _CACHE_PATH.exists():
                data = json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    _cache = data
        except Exception as exc:  # noqa: BLE001
            logger.debug("[mp4probe] cache load failed: %s", exc)
            _cache = {}
        _cache_loaded = True


def _save_cache() -> None:
    global _cache_dirty
    with _cache_lock:
        if not _cache_dirty:
            return
        try:
            _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            now = time.time()
            items = [(k, v) for k, v in _cache.items()
                     if now - float(v.get("at") or 0) < _CACHE_TTL]
            items.sort(key=lambda kv: float(kv[1].get("at") or 0), reverse=True)
            compact = dict(items[:_CACHE_MAX])
            _cache.clear()
            _cache.update(compact)
            _CACHE_PATH.write_text(json.dumps(compact, ensure_ascii=False), encoding="utf-8")
            _cache_dirty = False
        except Exception as exc:  # noqa: BLE001
            logger.debug("[mp4probe] cache save failed: %s", exc)


def cache_get(key: str) -> Optional[dict]:
    _load_cache()
    with _cache_lock:
        row = _cache.get(key)
        if not row:
            return None
        if time.time() - float(row.get("at") or 0) > _CACHE_TTL:
            _cache.pop(key, None)
            return None
        return {
            "duration": int(row.get("d") or 0),
            "size": int(row.get("s") or 0),
            "width": int(row.get("w") or 0),
            "height": int(row.get("h") or 0),
        }


def cache_put(key: str, duration: int, size: int, width: int = 0, height: int = 0,
              *, persist: bool = True) -> None:
    global _cache_dirty
    _load_cache()
    with _cache_lock:
        _cache[key] = {
            "at": time.time(), "d": int(duration), "s": int(size),
            "w": int(width), "h": int(height),
        }
        _cache_dirty = True
    if persist:
        _save_cache()


def cache_flush() -> None:
    """Persist batched probe results once after a bulk album fetch."""
    _save_cache()


def parse_mvhd_duration(buf: bytes) -> int:
    """Duration in seconds from the first plausible mvhd box in `buf`, else 0.

    Byte-scans for 'mvhd' rather than walking the box tree, so a moov that is
    only partially inside the fetched window still parses (mvhd is its first
    child). Implausible values (bad timescale / >24h) are treated as noise and
    the scan continues.
    """
    idx = 0
    while True:
        idx = buf.find(b"mvhd", idx)
        if idx < 0:
            return 0
        p = idx + 4  # fullbox: version(1) + flags(3), then the versioned fields
        try:
            if p + 20 <= len(buf) and buf[p] == 0:
                timescale, duration = struct.unpack(">II", buf[p + 12:p + 20])
            elif p + 32 <= len(buf) and buf[p] == 1:
                timescale = struct.unpack(">I", buf[p + 20:p + 24])[0]
                duration = struct.unpack(">Q", buf[p + 24:p + 32])[0]
            else:
                idx = p
                continue
            if timescale > 0:
                sec = duration / timescale
                if 0 < sec < _MAX_DURATION_SEC:
                    return int(round(sec))
        except struct.error:
            pass
        idx = p


def parse_tkhd_dimensions(buf: bytes) -> tuple[int, int]:
    """Return encoded (width, height) from a plausible MP4 ``tkhd`` box.

    ``tkhd`` stores the display dimensions as 16.16 fixed-point values in the
    last eight bytes of the box.  Like ``parse_mvhd_duration`` this deliberately
    scans a bounded range buffer instead of requiring a full MP4 download.
    """
    idx = 0
    while True:
        idx = buf.find(b"tkhd", idx)
        if idx < 0:
            return 0, 0
        box_start = idx - 4
        try:
            if box_start < 0 or box_start + 8 > len(buf):
                idx += 4
                continue
            box_size = struct.unpack(">I", buf[box_start:box_start + 4])[0]
            if box_size == 1:
                if box_start + 16 > len(buf):
                    idx += 4
                    continue
                box_size = struct.unpack(">Q", buf[box_start + 8:box_start + 16])[0]
            box_end = box_start + box_size
            if box_size < 92 or box_end > len(buf):
                idx += 4
                continue
            width_fixed, height_fixed = struct.unpack(">II", buf[box_end - 8:box_end])
            width = int(round(width_fixed / 65536))
            height = int(round(height_fixed / 65536))
            # tkhd's display matrix precedes width/height. Quarter-turn videos
            # are portrait even when the encoded track is landscape.
            matrix = struct.unpack(">9i", buf[box_end - 44:box_end - 8])
            if matrix[0] == 0 and matrix[4] == 0 and abs(matrix[1]) == 65536 and abs(matrix[3]) == 65536:
                width, height = height, width
            if 0 < width < 10000 and 0 < height < 10000:
                return width, height
        except (struct.error, OverflowError):
            pass
        idx += 4


def _find_moov_offset(head: bytes) -> int:
    """Byte offset of the top-level ``moov`` box by walking the box list, or -1.

    Non-fast-start MP4s (common on Bunkr) put a huge ``mdat`` before ``moov``,
    so ``moov`` lands neither in the head window nor in a small tail window.
    But every box header carries its own size, so walking ``ftyp → free → mdat
    → …`` from the front tells us exactly where ``moov`` begins — even when the
    box body itself is hundreds of MB past the fetched buffer. Returns the
    absolute file offset of the ``moov`` box so the caller can fetch it directly.
    """
    off = 0
    # Walk box headers within the buffer. Once we hit a box (typically the big
    # mdat) whose body runs past the buffer, `off` already points at the *next*
    # box — return it as the moov candidate; the caller fetches there directly.
    while off + 8 <= len(head):
        try:
            size = struct.unpack(">I", head[off:off + 4])[0]
        except struct.error:
            return -1
        typ = head[off + 4:off + 8]
        if typ == b"moov":
            return off
        if size == 1:  # 64-bit largesize follows the type
            if off + 16 > len(head):
                return -1
            size = struct.unpack(">Q", head[off + 8:off + 16])[0]
        if size < 8:  # size 0 = "to EOF"; anything <8 is malformed — give up
            return -1
        off += size
    return off if off > len(head) else -1


async def _ranged_get(client: httpx.AsyncClient, url: str, headers: dict,
                      start: int, end_incl: int, *, tries: int = 3) -> tuple[bytes, int, bool]:
    """(body, total_file_size, server_honoured_range). Reads at most the
    requested window even if the server ignores Range and answers 200.

    Retries transient throttle responses (429/5xx/connection drops): Bunkr's CDN
    rate-limits bursts of range reads, and a single blank read used to leave a
    card permanently without duration/quality. A few short backoffs recover it.
    """
    req = {**headers, "Range": f"bytes={start}-{end_incl}", "Connection": "close"}
    limit = end_incl - start + 1
    for attempt in range(tries):
        try:
            async with client.stream("GET", url, headers=req) as r:
                if r.status_code in (429, 500, 502, 503, 504):
                    raise httpx.HTTPError(f"throttled {r.status_code}")
                if r.status_code not in (200, 206):
                    return b"", 0, False
                total = 0
                m = re.search(r"/(\d+)\s*$", r.headers.get("content-range", ""))
                if m:
                    total = int(m.group(1))
                elif r.status_code == 200:
                    total = int(r.headers.get("content-length") or 0)
                chunks: list[bytes] = []
                got = 0
                async for chunk in r.aiter_bytes():
                    chunks.append(chunk)
                    got += len(chunk)
                    if got >= limit:
                        break
                return b"".join(chunks)[:limit], total, r.status_code == 206
        except (httpx.HTTPError, httpx.StreamError) as exc:
            if attempt + 1 >= tries:
                logger.debug("[mp4probe] ranged GET gave up (%s): %s", exc, url[:80])
                return b"", 0, False
            await asyncio.sleep(0.5 * (attempt + 1))
    return b"", 0, False


async def probe_mp4(url: str, *, headers: Optional[dict] = None,
                    timeout: float = 12.0) -> dict:
    """MP4 duration, dimensions and total size via two small ranged GETs.
    Best-effort: any failure returns zeros, never raises."""
    h = dict(headers or {})
    h.setdefault("User-Agent", "Mozilla/5.0")
    try:
        # keepalive OFF: Bunkr's CDN lets the first request on a fresh connection
        # through but 503s follow-ups reusing the same keep-alive socket — the head
        # read would succeed (size arrives) while tail/moov reads silently failed,
        # leaving duration/quality at 0. A new connection per read avoids that.
        async with _PROBE_GATE, httpx.AsyncClient(
                timeout=httpx.Timeout(timeout, connect=5.0),
                limits=httpx.Limits(max_keepalive_connections=0),
                follow_redirects=True, verify=False) as client:
            head, total, ranged = await _ranged_get(client, url, h, 0, _HEAD_BYTES - 1)
            dur = parse_mvhd_duration(head)
            width, height = parse_tkhd_dimensions(head)
            if (not dur or not width or not height) and ranged and total > _HEAD_BYTES:
                tail, _, _ = await _ranged_get(client, url, h,
                                               max(0, total - _TAIL_BYTES), total - 1)
                dur = dur or parse_mvhd_duration(tail)
                tail_width, tail_height = parse_tkhd_dimensions(tail)
                width = width or tail_width
                height = height or tail_height
            # Non-fast-start layout: moov sits after a giant mdat, so it landed
            # in neither window. Walk the box list to find its exact offset and
            # fetch it directly (one more small ranged GET).
            if (not dur or not width or not height) and ranged and total > 0:
                moov_off = _find_moov_offset(head)
                if moov_off >= 0 and moov_off + 8 <= total:
                    span = min(_MOOV_BYTES, total - moov_off)
                    moov, _, _ = await _ranged_get(client, url, h,
                                                   moov_off, moov_off + span - 1)
                    dur = dur or parse_mvhd_duration(moov)
                    moov_width, moov_height = parse_tkhd_dimensions(moov)
                    width = width or moov_width
                    height = height or moov_height
            return {"duration": dur, "size": total, "width": width, "height": height}
    except Exception as exc:  # noqa: BLE001
        logger.debug("[mp4probe] %s failed: %s", url[:80], exc)
        return {"duration": 0, "size": 0, "width": 0, "height": 0}


async def probe_mp4_cached(cache_key: str, url: str, *,
                           headers: Optional[dict] = None,
                           timeout: float = 12.0,
                           persist: bool = True) -> dict:
    """probe_mp4 with a persistent cache keyed by `cache_key` (use the stable
    file-page URL, not the signed/expiring stream URL)."""
    hit = cache_get(cache_key)
    # Older cache rows predate dimension support. Re-probe those once so
    # existing imports can finally receive a reliable quality label.
    if hit and all(hit[key] > 0 for key in ("duration", "size", "width", "height")):
        return hit
    res = await probe_mp4(url, headers=headers, timeout=timeout)
    if res["duration"] or res["size"]:
        cache_put(cache_key, res["duration"], res["size"], res["width"], res["height"], persist=persist)
    return res
