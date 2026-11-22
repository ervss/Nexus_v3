"""
MEGA Native Bridge API.

Endpoints
    POST /mega/add            body {url}            -> import one public file link
    POST /mega/add-folder     body {url}           -> import every video in a folder
    GET  /mega/preview        ?url=                 -> list a folder without importing
    GET  /mega/stream/{id}                          -> range-aware decrypted stream
    GET  /mega/thumb/{id}                           -> decrypted MEGA thumbnail (jpg)

Saved videos store the permanent mega.nz link as the source of truth, so they
always replay: the short-lived CDN URL is re-resolved on demand at stream time.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import logging
import secrets
import time
from collections import OrderedDict
from contextlib import AsyncExitStack
from typing import Optional
from urllib.parse import quote, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import config
from ..database import Video, get_db
from ..extractors import mega_native as mn

logger = logging.getLogger(__name__)
router = APIRouter(tags=["mega"])

# Resolved CDN URLs are valid for a while; cache briefly to avoid re-hitting the
# MEGA API on every range request the browser makes while scrubbing.
_CDN_CACHE: dict[tuple[str, bytes], tuple[float, dict]] = {}
_TOR_ISOLATION_KEY = secrets.token_bytes(32)
_TOR_FILE_GENERATIONS: OrderedDict[str, str] = OrderedDict()
_TOR_TRANSFER_RETRIES = 3
_RETRYABLE_CDN = {429, 502, 503, 504, 509}
_TOR_START_LOCK = asyncio.Lock()
_tor_ready_until = 0.0
_CDN_TTL = 240  # seconds
_CHUNK = 1 << 18  # 256 KiB pull size from the CDN


def _is_mega_video(video: Video | None) -> bool:
    """Recognise native MEGA rows, including older generic imports.

    The extension can import a decrypted compact ``mega:n:...`` reference via
    the generic importer.  Older rows from that path have ``storage_type`` set
    to ``remote`` despite being fully valid MEGA files.  The compact URL is the
    authoritative identity, so use it as a backwards-compatible fallback.
    """
    return bool(video and (
        video.storage_type == "mega"
        or str(video.url or "").lower().startswith("mega:")
    ))


class MegaAddRequest(BaseModel):
    url: str
    batch_name: Optional[str] = None


class MegaMetadataRequest(BaseModel):
    ref: str


_METADATA_CACHE: dict[str, tuple[float, dict]] = {}
_METADATA_LIMIT = asyncio.Semaphore(4)


@router.post("/mega/metadata")
async def mega_card_metadata(req: MegaMetadataRequest):
    """Read-only bounded card probe; never imports a video or returns CDN URLs."""
    try:
        if not req.ref.startswith(("mega:n:", "mega:f:")):
            raise ValueError("Invalid prefix")
        ref = mn.parse_compact(req.ref)
        if len(ref.key_a32) != 8 or len(ref.file_handle) != 8:
            raise ValueError("Invalid key or handle")
    except Exception:
        raise HTTPException(400, detail="Invalid MEGA reference") from None
    hit = _METADATA_CACHE.get(req.ref)
    if hit and time.monotonic() - hit[0] < 3600:
        return hit[1]
    async with _METADATA_LIMIT:
        hit = _METADATA_CACHE.get(req.ref)
        if hit and time.monotonic() - hit[0] < 3600:
            return hit[1]
        try:
            meta = await asyncio.wait_for(mn.probe_metadata(ref, fast=True), timeout=8)
        except asyncio.TimeoutError:
            meta = {"width": 0, "height": 0, "duration": 0}
        meta["quality"] = mn.quality_from_height(min(meta["width"], meta["height"]))
        if meta["quality"] or meta["duration"]:
            if len(_METADATA_CACHE) >= 2000:
                _METADATA_CACHE.pop(next(iter(_METADATA_CACHE)))
            _METADATA_CACHE[req.ref] = (time.monotonic(), meta)
        return meta


class MegaAddSelectedRequest(BaseModel):
    url: str                          # the folder link (source_url + nested-key resolution)
    refs: list[str]                   # compact mega:n:... refs to import
    batch_name: Optional[str] = None
    title: Optional[str] = None       # album title, used for the default batch name


class MegaKeyedVideo(BaseModel):
    ref: str                          # compact mega:n:root:handle:keyb64 built client-side
    name: str
    size: int = 0
    seq: Optional[int] = None         # 1-based position in the full folder (stable numbering)


class MegaAddKeyedRequest(BaseModel):
    """Client-supplied, already-decrypted video refs.

    For *relinked* MEGA shares the file keys are encrypted under a foreign share
    that an anonymous folder-link reader cannot decrypt server-side — but the
    logged-in MEGA web page already holds the decrypted keys. The userscript
    reads them from MEGA's in-page node store and posts ready-to-use refs here,
    so we never need to (and cannot) re-list the folder ourselves.
    """
    url: str                          # source folder link (stored as source_url)
    videos: list[MegaKeyedVideo]
    batch_name: Optional[str] = None
    title: Optional[str] = None


async def _cached_resolve(compact_ref: str, *, proxy: str = "", refresh: bool = False) -> dict:
    key = (compact_ref, hashlib.sha256(proxy.encode()).digest() if proxy else b"")
    hit = _CDN_CACHE.get(key)
    if not refresh and hit and (time.time() - hit[0]) < _CDN_TTL:
        return hit[1]
    options = {"proxy": proxy} if proxy else {}
    info = await mn.resolve_cdn(mn.parse_compact(compact_ref), **options)
    _CDN_CACHE[key] = (time.time(), info)
    return info


def _mega_ref_for(video: Video) -> str:
    """Pull the compact mega ref out of a stored Video row."""
    if video.url and video.url.startswith("mega:"):
        return video.url
    # Fall back to re-parsing the original public link from source_url.
    ref = mn.parse_public_file_link(video.source_url or "")
    if not ref:
        raise HTTPException(400, detail="Video has no usable MEGA reference")
    return ref.to_compact()


# --------------------------------------------------------------------------- #
# ingest
# --------------------------------------------------------------------------- #
def _quality_from_name(name: str) -> str:
    low = name.lower()
    for tag, label in (("2160", "4K"), ("4k", "4K"), ("1440", "1440p"),
                       ("1080", "1080p"), ("720", "720p"), ("480", "480p")):
        if tag in low:
            return label
    return "MEGA"


async def _probe_safe(ref, timeout: float = 25, *, fast: bool = False) -> dict:
    try:
        return await asyncio.wait_for(mn.probe_metadata(ref, fast=fast), timeout)
    except Exception:  # noqa: BLE001
        return {"duration": 0.0, "width": 0, "height": 0}


def _apply_meta(meta: dict, fallback_name: str) -> tuple[float, int, int, str]:
    """-> (duration, width, height, quality). Real resolution wins over name."""
    w, h = meta.get("width", 0), meta.get("height", 0)
    short_side = min(w, h) if w and h else 0
    quality = mn.quality_from_height(short_side) or _quality_from_name(fallback_name)
    return meta.get("duration", 0.0) or 0.0, w, h, quality


@router.post("/mega/add")
async def mega_add_file(req: MegaAddRequest, db: Session = Depends(get_db)):
    ref = mn.parse_public_file_link(req.url)
    if not ref:
        raise HTTPException(400, detail="Not a valid MEGA file link (mega.nz/file/...#key)")
    try:
        info = await mn.resolve_cdn(ref)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"MEGA resolve failed: {exc}")

    compact = ref.to_compact()
    existing = db.query(Video).filter(Video.url == compact).first()
    if existing:
        return {"status": "exists", "video_id": existing.id}

    title = info["name"] or f"MEGA {ref.file_handle}"
    duration, width, height, quality = _apply_meta(await _probe_safe(ref), title)
    video = Video(
        title=title,
        url=compact,
        source_url=req.url,
        storage_type="mega",
        status="ready_to_stream",
        quality=quality,
        duration=duration,
        width=width,
        height=height,
        batch_name=req.batch_name or "MEGA",
        tags="mega",
        file_size_mb=round(info["size"] / (1024 * 1024), 2) if info["size"] else 0,
    )
    db.add(video)
    db.commit()
    db.refresh(video)
    video.thumbnail_path = f"/api/v1/mega/thumb/{video.id}"
    db.commit()
    return {"status": "ok", "video_id": video.id, "title": title,
            "duration": duration, "quality": quality}


@router.get("/mega/preview")
async def mega_preview_folder(url: str):
    try:
        data = await mn.list_folder(url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"MEGA folder read failed: {exc}")
    return {
        "title": data["title"],
        "count": len(data["videos"]),
        "videos": [
            {"handle": v["handle"], "name": v["name"], "size": v["size"],
             "ref": v["ref"], "thumb_fa": v["thumb_fa"]}
            for v in data["videos"]
        ],
    }


@router.post("/mega/add-folder")
async def mega_add_folder(req: MegaAddRequest, db: Session = Depends(get_db)):
    try:
        data = await mn.list_folder(req.url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"MEGA folder read failed: {exc}")

    videos = data["videos"]
    if not videos:
        raise HTTPException(404, detail="No video files found in this MEGA folder")

    batch = req.batch_name or f"MEGA · {data['title']}"
    return await _ingest_videos(db, videos, source_url=req.url, batch=batch,
                                album_title=data["title"])


import re as _re

# Promo/spam markers commonly stuffed into MEGA leak-album file names. When a
# name matches, it carries no real identity, so we rename it "{album} {N}".
_SPAM_NAME_RE = _re.compile(
    r"(telegram|onlyfans|insta(?:gram|hoes)?|more at|join|t\.me/|@\w|"
    r"\b\w+\.(?:net|com|org|io|tv|xxx|cc)\b)",
    _re.IGNORECASE,
)


def _normalize_fancy(text: str) -> str:
    """Map Unicode 'mathematical/styled' letters (e.g. 𝗧𝗲𝗹𝗲𝗴𝗿𝗮𝗺) back to ASCII so
    spam detection works. Uses NFKD which folds most styled-letter variants."""
    import unicodedata
    if not text:
        return ""
    return unicodedata.normalize("NFKD", text)


def _strip_ext(name: str) -> str:
    base = name.rsplit(".", 1)[0] if "." in name[-6:] else name
    return base.strip()


def _is_spammy_name(name: str, strip_ext: bool = True) -> bool:
    # For file names we strip the extension first; for album titles we don't
    # (so a bare-domain title like "robinhoodcenter.net" still reads as spam).
    base = _strip_ext(name) if strip_ext else (name or "").strip()
    if not base:
        return True
    if _SPAM_NAME_RE.search(_normalize_fancy(base)):
        return True
    # "Bare" names that are just digits / generic (e.g. "1593", "VID_0001").
    if _re.fullmatch(r"(vid|video|img|file|clip)?[\W_]*\d{1,6}", base, _re.IGNORECASE):
        return True
    return False


def _clean_album_name(title: str) -> str:
    """Derive a short, human album prefix from the folder title.

    'Lily Lou - LilyLouOfficial{Telegram @InstaHoesHub}'   -> 'Lily Lou'
    '@ltsOnly on Telegram - Tameeka'                        -> 'Tameeka'
    """
    t = _normalize_fancy((title or "").strip()).strip()
    if not t:
        return "MEGA"
    # If the part before the first separator is itself spammy (e.g. starts with
    # "@x on Telegram"), prefer the trailing segment after the last " - ".
    head = _re.split(r"\s*[-(\[{@]", t, maxsplit=1)[0].strip()
    if (not head or _is_spammy_name(head, strip_ext=False)) and " - " in t:
        tail = t.rsplit(" - ", 1)[-1].strip()
        head = _re.split(r"\s*[(\[{@]", tail, maxsplit=1)[0].strip() or head
    head = head.strip(" -_·")
    # If even the cleaned head is promo/junk, fall back to a neutral prefix.
    if not head or _is_spammy_name(head, strip_ext=False):
        return "MEGA"
    return head


async def _ingest_videos(db: Session, videos: list[dict], source_url: str, batch: str,
                         album_title: str = "", seq_by_ref: Optional[dict] = None, *, fast: bool = False) -> dict:
    """Probe (parallel) then insert a list of folder video dicts {name,size,ref}.

    Skips refs already in the library. Shared by add-folder and add-selected.
    Spam/promo file names are replaced with "{clean album} {N}". `seq_by_ref`
    maps ref -> 1-based position in the FULL folder so numbering stays stable
    across selective imports; falls back to local order when omitted.
    """
    album_prefix = _clean_album_name(album_title)
    if seq_by_ref is None:
        seq_by_ref = {v["ref"]: i + 1 for i, v in enumerate(videos)}

    # Keep only not-yet-imported files, then probe them all in parallel.
    unique = {v["ref"]: v for v in videos}
    fresh = [v for v in unique.values() if not db.query(Video.id).filter(Video.url == v["ref"]).first()]
    skipped = len(videos) - len(fresh)

    sem = asyncio.Semaphore(8)

    async def _probe(v):
        if fast and v.get("duration") and v.get("width") and v.get("height"):
            return v, v
        async with sem:
            meta = await _probe_safe(mn.parse_compact(v["ref"]), timeout=8 if fast else 25, fast=fast)
            return v, {**v, **{key: value for key, value in meta.items() if value}}

    probed = await asyncio.gather(*[_probe(v) for v in fresh]) if fresh else []

    added = 0
    first_id = None
    for v, meta in probed:
        if db.query(Video.id).filter(Video.url == v["ref"]).first():
            skipped += 1
            continue
        duration, width, height, quality = _apply_meta(meta, v["name"])
        title = v["name"]
        if _is_spammy_name(title):
            title = f"{album_prefix} {seq_by_ref.get(v['ref'], added + 1)}"
        row = Video(
            title=title,
            url=v["ref"],
            source_url=source_url,
            storage_type="mega",
            status="ready_to_stream",
            quality=quality,
            duration=duration,
            width=width,
            height=height,
            batch_name=batch,
            tags="mega,mega-album",
            file_size_mb=round(v["size"] / (1024 * 1024), 2) if v["size"] else 0,
        )
        db.add(row)
        db.flush()
        row.thumbnail_path = f"/api/v1/mega/thumb/{row.id}"
        first_id = first_id or row.id
        added += 1
    db.commit()
    return {"status": "ok", "batch_name": batch, "added": added,
            "skipped": skipped, "total": len(videos), "first_video_id": first_id}


@router.post("/mega/add-selected")
async def mega_add_selected(req: MegaAddSelectedRequest, db: Session = Depends(get_db)):
    """Import only the chosen videos from a folder, identified by compact refs.

    The userscript filters/selects client-side and posts the surviving refs here,
    so we re-list the folder (cheap, no video bytes) to recover authoritative
    name + size for each ref, then ingest just the matching subset.
    """
    wanted = {r for r in (req.refs or []) if isinstance(r, str) and r.startswith("mega:")}
    if not wanted:
        raise HTTPException(400, detail="No MEGA refs provided to import")

    try:
        data = await mn.list_folder(req.url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"MEGA folder read failed: {exc}")

    videos = [v for v in data["videos"] if v["ref"] in wanted]
    if not videos:
        raise HTTPException(404, detail="None of the selected refs were found in this folder")

    album = req.title or data["title"]
    batch = req.batch_name or f"MEGA · {album}"
    # Number by position in the FULL folder so "Tameeka 5" stays 5 even when
    # imported alone in a later selective batch.
    seq_by_ref = {v["ref"]: i + 1 for i, v in enumerate(data["videos"])}
    result = await _ingest_videos(db, videos, source_url=req.url, batch=batch,
                                  album_title=album, seq_by_ref=seq_by_ref)
    result["requested"] = len(wanted)
    result["matched"] = len(videos)
    return result


@router.post("/mega/add-keyed")
async def mega_add_keyed(req: MegaAddKeyedRequest, db: Session = Depends(get_db)):
    """Import videos whose refs were built client-side (relinked-share fallback).

    Used when /mega/preview returns nothing because the share's file keys are not
    derivable from the public link. The userscript supplies decrypted refs; we
    validate they parse, then probe + ingest exactly like add-selected.
    """
    videos: list[dict] = []
    seq_by_ref: dict[str, int] = {}
    for v in req.videos:
        ref = (v.ref or "").strip()
        if not ref.startswith("mega:"):
            continue
        try:
            mn.parse_compact(ref)  # reject malformed/truncated refs early
        except Exception:  # noqa: BLE001
            continue
        videos.append({"name": v.name or "", "size": int(v.size or 0), "ref": ref})
        if v.seq:
            seq_by_ref[ref] = int(v.seq)
    if not videos:
        raise HTTPException(400, detail="No valid MEGA refs supplied")

    album = req.title or "MEGA Album"
    batch = req.batch_name or f"MEGA · {album}"
    result = await _ingest_videos(db, videos, source_url=req.url, batch=batch,
                                  album_title=album, seq_by_ref=seq_by_ref or None)
    result["requested"] = len(req.videos)
    result["matched"] = len(videos)
    return result


# --------------------------------------------------------------------------- #
# thumbnail regeneration (replace the small MEGA preview with a real frame)
# --------------------------------------------------------------------------- #
class MegaRegenThumbsRequest(BaseModel):
    """Pick what to regenerate. Provide a batch_name OR explicit ids; if neither,
    every MEGA video that still uses the small /mega/thumb preview is processed."""
    batch_name: Optional[str] = None
    ids: Optional[list[int]] = None
    only_missing: bool = True         # skip videos that already have a local thumb
    force: bool = False               # regenerate even if a local thumb exists


def _select_regen_videos(db: Session, req: MegaRegenThumbsRequest) -> list[Video]:
    # Do not strand previously imported compact MEGA refs just because their
    # generic-import record says "remote".  See _is_mega_video().
    q = db.query(Video).filter(
        (Video.storage_type == "mega") | Video.url.like("mega:%")
    )
    if req.ids:
        q = q.filter(Video.id.in_(req.ids))
    elif req.batch_name:
        q = q.filter(Video.batch_name == req.batch_name)
    vids = q.order_by(Video.id).all()
    if req.force:
        return vids
    # Default: only videos whose thumbnail is still the MEGA preview (or missing).
    import os
    out = []
    for v in vids:
        tp = v.thumbnail_path or ""
        has_local = tp.startswith("/static/thumbnails/") and os.path.exists(f"app{tp}")
        if req.only_missing and has_local:
            continue
        out.append(v)
    return out


@router.post("/mega/regenerate-thumbs")
async def mega_regenerate_thumbs(req: MegaRegenThumbsRequest, request: Request,
                                 db: Session = Depends(get_db)):
    """Generate one real-frame thumbnail for MEGA videos.

    This deliberately does *not* create the hover sprite used by full imports.
    A MEGA stream is decrypted on demand and generating the sprite can require
    multiple long reads of the remote file; Smart Rethumb only promises a better
    card image, so one seeked frame is both faster and more reliable.
    """
    from ..services import FFMPEG_CMD, run_subprocess_capture

    videos = _select_regen_videos(db, req)
    # Build a loopback base URL ffmpeg can actually dial. request.base_url may
    # report the bind host (0.0.0.0), which is not connectable — force 127.0.0.1
    # but keep the real port the request came in on.
    port = request.url.port or (443 if request.url.scheme == "https" else 80)
    base = f"http://127.0.0.1:{port}"
    import json as _json
    import os

    async def _generate_one_frame(stream_url: str, video: Video) -> tuple[bool, str]:
        thumb_rel = f"/static/thumbnails/thumb_{video.id}.jpg"
        thumb_abs = f"app{thumb_rel}"
        os.makedirs(os.path.dirname(thumb_abs), exist_ok=True)
        try:
            duration = float(video.duration or 0)
        except (TypeError, ValueError):
            duration = 0.0
        # Seek before input lets ffmpeg request only the useful MEGA byte range.
        seek_s = max(3.0, min(duration * 0.10, 45.0)) if duration else 8.0
        cmd = [
            FFMPEG_CMD, "-y", "-threads", "2", "-hide_banner", "-loglevel", "error",
            "-ss", str(round(seek_s, 2)), "-i", stream_url,
            "-vf", "scale=640:-1", "-frames:v", "1", "-q:v", "5", thumb_abs,
        ]
        rc, _out, err = await run_subprocess_capture(cmd, timeout=65)
        # Some MP4s finish writing the requested JPEG but ffmpeg still exits
        # non-zero while closing a slow range-backed input.  The on-disk JPEG is
        # the authoritative result here; rejecting it left a valid MEGA frame
        # unused and made the UI report a false failure.
        if os.path.exists(thumb_abs) and os.path.getsize(thumb_abs) > 1_000:
            return True, thumb_rel
        return False, (err or b"ffmpeg did not produce a frame").decode("utf-8", errors="ignore")[:240]

    async def run():
        total = len(videos)
        yield _json.dumps({"event": "start", "total": total}) + "\n"
        done = ok = 0
        for v in videos:
            stream_url = f"{base}/api/v1/mega/stream/{v.id}"
            try:
                generated, detail = await _generate_one_frame(stream_url, v)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[MEGA regen] %s failed: %s", v.id, exc)
                generated, detail = False, str(exc)
            if generated:
                thumb_rel = f"/static/thumbnails/thumb_{v.id}.jpg"
                v.thumbnail_path = thumb_rel
                db.commit()
                ok += 1
                status = "ok"
            else:
                logger.warning("[MEGA regen] %s did not produce a frame: %s", v.id, detail)
                status = "failed"
            done += 1
            yield _json.dumps({"event": "progress", "id": v.id, "title": v.title,
                               "status": status, "done": done, "total": total,
                               "ok": ok}) + "\n"
        yield _json.dumps({"event": "done", "total": total, "ok": ok}) + "\n"

    return StreamingResponse(run(), media_type="application/x-ndjson")


# --------------------------------------------------------------------------- #
# streaming  (the heart of the bridge)
# --------------------------------------------------------------------------- #
def _parse_range(header: Optional[str], size: int) -> tuple[int, int]:
    start, end = 0, size - 1
    if header:
        import re
        m = re.match(r"bytes=(\d*)-(\d*)", header.strip(), re.I)
        if m:
            if m.group(1):
                start = int(m.group(1))
            if m.group(2):
                end = int(m.group(2))
    start = max(0, start)
    end = min(end, size - 1)
    return start, end


@router.get("/mega/stream/{video_id}")
async def mega_stream(video_id: int, request: Request, db: Session = Depends(get_db)):
    video = db.query(Video).get(video_id)
    if not _is_mega_video(video):
        raise HTTPException(404, detail="MEGA video not found")
    compact = _mega_ref_for(video)
    return await _stream_mega_ref(compact, request, video_id)


@router.head("/mega/download/{video_id}", include_in_schema=False)
@router.get("/mega/download/{video_id}")
async def mega_download(video_id: int, request: Request, db: Session = Depends(get_db)):
    client = request.client
    try:
        address = ipaddress.ip_address(client.host) if client else None
        loopback = address and (getattr(address, "ipv4_mapped", None) or address).is_loopback
    except ValueError:
        loopback = False
    if not loopback and not request.scope.get("session", {}).get("authenticated"):
        raise HTTPException(401, "Prihláste sa do Nexusu.")
    video = db.get(Video, video_id)
    if not _is_mega_video(video):
        raise HTTPException(404, "MEGA video not found")
    return await download_mega_ref(_mega_ref_for(video), request, video_id, video.title)


async def _media_proxy(compact: str) -> str:
    proxy = config.MEGA_PROXY_URL
    if proxy:
        try:
            parsed = urlsplit(proxy)
            if parsed.scheme not in {"http", "https", "socks5", "socks5h"} or not parsed.hostname or parsed.port == 0:
                raise ValueError
        except ValueError:
            raise HTTPException(503, "MEGA_PROXY_URL musí byť platná adresa HTTP, HTTPS alebo SOCKS5 proxy.") from None
        return proxy
    if not config.MEGA_PROXY_MODE:
        return ""
    if config.MEGA_PROXY_MODE != "tor":
        raise HTTPException(503, "Neznámy režim MEGA proxy.")

    from ..tor_service import tor_service

    global _tor_ready_until
    if time.monotonic() >= _tor_ready_until:
        async with _TOR_START_LOCK:
            if time.monotonic() >= _tor_ready_until:
                state = await asyncio.to_thread(tor_service.start, wait_seconds=30)
                if not state.get("ready"):
                    raise HTTPException(503, "Tor nie je pripravený na prenos z MEGA.")
                _tor_ready_until = time.monotonic() + 15
    host, port = tor_service.socks_address
    if ":" in host:
        host = f"[{host}]"
    # Tor isolates streams with distinct SOCKS authentication. Keep the same
    # credentials for API lookup and every Range request for this file.
    generation = _TOR_FILE_GENERATIONS.get(compact, "")
    if generation:
        _TOR_FILE_GENERATIONS.move_to_end(compact)
    token = hmac.new(_TOR_ISOLATION_KEY, f"{compact}:{generation}".encode(), hashlib.sha256).hexdigest()[:32]
    return f"socks5h://nexus-mega:{token}@{host}:{port}"


async def _rotate_media_proxy(compact: str, failed_proxy: str) -> str:
    current = await _media_proxy(compact)
    if current == failed_proxy:
        _TOR_FILE_GENERATIONS[compact] = secrets.token_hex(8)
        _TOR_FILE_GENERATIONS.move_to_end(compact)
        if len(_TOR_FILE_GENERATIONS) > 4096:
            _TOR_FILE_GENERATIONS.popitem(last=False)
        current = await _media_proxy(compact)
    return current


def _retryable_resolve_error(error: Exception) -> bool:
    return (isinstance(error, httpx.TransportError)
            or isinstance(error, httpx.HTTPStatusError) and error.response.status_code in _RETRYABLE_CDN
            or isinstance(error, mn.MegaAPIError) and error.code in {-3, -4, -17, -18})


async def download_mega_ref(compact: str, request: Request, video_id, filename: str | None):
    return await _stream_mega_ref(compact, request, video_id, content_type="application/octet-stream",
                                  attachment=filename or "MEGA video")


@router.get("/mega/stream-ref")
async def mega_stream_ref(ref: str, request: Request):
    """Play a keyed folder item without creating a library record."""
    try:
        if not ref.startswith(("mega:n:", "mega:f:")):
            raise ValueError("Invalid prefix")
        parsed = mn.parse_compact(ref)
        if len(parsed.key_a32) != 8 or len(parsed.file_handle) != 8:
            raise ValueError("Invalid key or handle")
    except Exception:
        raise HTTPException(400, detail="Invalid MEGA reference") from None
    return await _stream_mega_ref(ref, request, "preview")


@router.head("/mega/stream-ref")
async def mega_stream_ref_head(ref: str, request: Request):
    return await mega_stream_ref(ref, request)


async def _stream_mega_ref(compact: str, request: Request, video_id, *, content_type="video/mp4",
                           attachment: str = ""):
    proxy = await _media_proxy(compact)
    validate_range = bool(attachment or proxy)
    rotate_tor = not config.MEGA_PROXY_URL and config.MEGA_PROXY_MODE == "tor"
    retries = _TOR_TRANSFER_RETRIES if rotate_tor else 0

    async def change_route() -> bool:
        nonlocal proxy, retries
        if not retries:
            return False
        retries -= 1
        proxy = await _rotate_media_proxy(compact, proxy)
        return True

    async def resolve(*, refresh: bool = False) -> dict:
        while True:
            try:
                return await _cached_resolve(compact, proxy=proxy, refresh=refresh)
            except Exception as error:  # noqa: BLE001
                if _retryable_resolve_error(error) and await change_route():
                    refresh = False
                    continue
                if isinstance(error, mn.MegaAPIError) and error.code == -17:
                    raise HTTPException(509, "MEGA dosiahla limit prenosu. Skúste neskôr.") from None
                detail = "MEGA sa nepodarilo kontaktovať cez nastavenú proxy." if proxy else "MEGA odkaz sa nepodarilo načítať."
                raise HTTPException(502, detail=detail) from None

    info = await resolve()

    size = info["size"]
    range_header = request.headers.get("Range")
    start, end = _parse_range(range_header, size)
    suffix = _re.fullmatch(r"bytes=-(\d+)", range_header or "", _re.I) if validate_range else None
    if suffix:
        start, end = max(0, size - int(suffix[1])), size - 1
    length = end - start + 1
    is_range = range_header is not None
    if validate_range and length <= 0:
        raise HTTPException(416, "MEGA neposkytuje požadovaný rozsah.", headers={"Content-Range": f"bytes */{size}"})

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": content_type,
        "Content-Length": str(length),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        # A Range body must stay raw bytes. GZipMiddleware otherwise compresses
        # video/mp4, drops Content-Length, and the player cannot find moov.
        "Content-Encoding": "identity",
    }
    if is_range:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    if attachment:
        filename = (info.get("name") or attachment).replace("\\", "/").rsplit("/", 1)[-1]
        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(filename, safe='')}"

    if request.method == "HEAD":
        return Response(status_code=206 if is_range else 200, headers=headers)

    key_a32 = mn.parse_compact(compact).key_a32

    async def open_upstream(offset: int, resolved: dict):
        refreshed = False
        while True:
            if resolved["size"] != size:
                raise HTTPException(502, "Veľkosť súboru na MEGA sa zmenila.")
            options = {"proxy": proxy, "trust_env": False} if proxy else {}
            async with AsyncExitStack() as stack:
                try:
                    timeout = httpx.Timeout(45, connect=15) if validate_range else None
                    client = await stack.enter_async_context(httpx.AsyncClient(timeout=timeout, **options))
                    response = await stack.enter_async_context(client.stream(
                        "GET", resolved["url"], headers={"Range": f"bytes={offset}-{end}", "Accept-Encoding": "identity"},
                    ))
                    status = response.status_code
                except httpx.TransportError:
                    status = 502
                else:
                    if status < 400:
                        if validate_range and not (
                            status == 206 and response.headers.get("Content-Range", "").lower() == f"bytes {offset}-{end}/{size}"
                            or status == 200 and offset == 0 and end == size - 1
                        ):
                            raise HTTPException(502, "MEGA neposkytla správny rozsah dát na stiahnutie.")
                        return stack.pop_all(), response
            if status in {403, 410, 503} and not refreshed:
                refreshed = True
                resolved = await resolve(refresh=True)
            elif status in _RETRYABLE_CDN and await change_route():
                refreshed = False
                resolved = await resolve()
            elif status == 509:
                raise HTTPException(509, "MEGA dosiahla limit prenosu. Skúste neskôr.")
            else:
                raise HTTPException(502, f"MEGA prenos zlyhal ({status}).")

    initial_stack, initial_response = await open_upstream(start, info)

    async def body():
        offset = start
        stack, response = initial_stack, initial_response
        while offset <= end:
            decryptor = mn.MegaCTRDecryptor(key_a32, offset)
            async with stack:
                try:
                    async for chunk in response.aiter_bytes(_CHUNK):
                        chunk = chunk[:end - offset + 1]
                        offset += len(chunk)
                        yield decryptor.decrypt(chunk)
                        if offset > end:
                            return
                except httpx.TransportError:
                    pass
            if not await change_route():
                logger.warning("[MEGA stream] %s interrupted at byte %s", video_id, offset)
                raise httpx.ReadError("MEGA stream ended before the requested range was complete")
            # Resume with a new CTR decryptor at the first byte we haven't sent.
            try:
                stack, response = await open_upstream(offset, await resolve())
            except HTTPException:
                logger.warning("[MEGA stream] %s could not resume at byte %s", video_id, offset)
                raise httpx.ReadError("MEGA stream could not resume") from None

    return StreamingResponse(body(), status_code=206 if is_range else 200, headers=headers)


@router.head("/mega/stream/{video_id}")
async def mega_stream_head(video_id: int, request: Request, db: Session = Depends(get_db)):
    return await mega_stream(video_id, request, db)


# --------------------------------------------------------------------------- #
# thumbnails  (decrypted from MEGA's stored file-attribute, no full download)
# --------------------------------------------------------------------------- #
@router.get("/mega/thumb/{video_id}")
async def mega_thumb(video_id: int, db: Session = Depends(get_db)):
    video = db.query(Video).get(video_id)
    if not _is_mega_video(video):
        raise HTTPException(404, detail="MEGA video not found")
    try:
        ref_str = _mega_ref_for(video)
        from .mega_hub import _video_id as _hub_video_id, mega_hub_thumb_path
        cached = mega_hub_thumb_path(_hub_video_id(ref_str))
        if cached.is_file() and cached.stat().st_size > 0:
            from fastapi.responses import FileResponse
            return FileResponse(cached, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=3600"})
        parsed = mn.parse_compact(ref_str)
        jpg = await mn.fetch_thumbnail(parsed, type_=1)
        if not jpg:
            jpg = await mn.fetch_thumbnail(parsed, type_=0)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, detail=f"No MEGA thumbnail: {exc}")
    if not jpg:
        raise HTTPException(404, detail="No MEGA thumbnail")
    return Response(content=jpg, media_type=mn.thumbnail_mime(jpg),
                    headers={"Cache-Control": "public, max-age=86400"})
