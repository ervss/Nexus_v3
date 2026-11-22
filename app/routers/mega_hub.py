"""Persistent MEGA workspaces and the browser handoff to them."""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import mimetypes
import os
import random
import re
import secrets
import shutil
import tempfile
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import config
from ..database import MegaHubEntry, SessionLocal, TelegramLinkPost, Video, engine, get_db, utcnow
from ..extractors import mega_native as mn
from . import mega
from .extension_bridge import ensure_bridge_token

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/mega/hub", tags=["MEGA Hub"])
_HANDLE = r"[A-Za-z0-9_-]{8}"
_KEY = r"[A-Za-z0-9_-]+"
_CHECK_TTL = 600
_CAPTURE_MIN_SECONDS = 60
_CAPTURE_PROBE_TIMEOUT = 85
_HANDOFF_TTL = 900
_ACTIVE_HANDOFF: dict | None = None
_CHECKS: OrderedDict[str, tuple[float, Share, dict]] = OrderedDict()
_CHECK_LIMIT = asyncio.Semaphore(4)
_IMPORT_LIMIT = asyncio.Lock()
_RETHUMB_LIMIT = asyncio.Semaphore(3)
_RETHUMB_LOCKS: dict[str, asyncio.Lock] = {}
_SCRIPT_DIR = Path(__file__).resolve().parents[2] / "userscripts"
MEGA_HUB_THUMB_DIR = Path(__file__).resolve().parents[1] / "static" / "thumbnails" / "mega_hub"


def mega_hub_thumb_path(video_id: str) -> Path:
    """Vráti cestu k lokálne uloženému zlepšenému náhľadu pre MEGA Hub video."""
    safe_id = re.sub(r"[^a-f0-9]", "", (video_id or "").lower())[:32]
    return MEGA_HUB_THUMB_DIR / f"{safe_id}.jpg"


@dataclass(frozen=True)
class Share:
    url: str
    kind: str
    handle: str
    key: bytes
    folder: str | None = None
    file: str | None = None


def parse_share(value: str) -> Share:
    try:
        url = urlsplit(value.strip())
        if url.scheme not in {"http", "https"} or url.netloc.lower() not in {
            "mega.nz", "www.mega.nz", "mega.co.nz", "www.mega.co.nz",
        }:
            raise ValueError
        path = re.fullmatch(rf"/(file|folder)/({_HANDLE})/?", url.path)
        if path:
            kind, handle = path.groups()
            fragment = re.fullmatch(rf"({_KEY})(?:/folder/({_HANDLE}))?(?:/file/({_HANDLE}))?/?", url.fragment)
            if fragment is None:
                raise ValueError
            encoded, folder, file = fragment.groups()
        elif url.path in {"", "/"}:
            legacy_folder = re.fullmatch(rf"F!({_HANDLE})!({_KEY})(?:!({_HANDLE}))?", url.fragment)
            legacy_file = re.fullmatch(rf"!({_HANDLE})!({_KEY})", url.fragment)
            if legacy_folder:
                kind = "folder"
                handle, encoded, folder = legacy_folder.groups()
                file = None
            elif legacy_file:
                kind = "file"
                handle, encoded = legacy_file.groups()
                folder = file = None
            else:
                raise ValueError
        else:
            raise ValueError
        key = mn.b64url_decode(encoded)
        if len(key) != (16 if kind == "folder" else 32) or (kind == "file" and (folder or file)):
            raise ValueError
    except ValueError:
        raise HTTPException(400, "Neplatný MEGA odkaz alebo kľúč.") from None
    canonical = f"https://mega.nz/{kind}/{handle}#{mn.b64url_encode(key)}"
    if folder:
        canonical += f"/folder/{folder}"
    if file:
        canonical += f"/file/{file}"
    return Share(canonical, "file" if file else kind, handle, key, folder, file)


def ensure_tables() -> None:
    MegaHubEntry.__table__.create(engine, checkfirst=True)


def _is_loopback(host: str | None) -> bool:
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host or "")
        mapped = getattr(address, "ipv4_mapped", None)
        return (mapped or address).is_loopback
    except ValueError:
        return False


def _dashboard_access(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin and origin != f"{request.url.scheme}://{request.url.netloc}":
        raise HTTPException(403, "Otvorte MEGA Hub priamo v dashboarde.")
    session = request.scope.get("session")
    if session is not None and session.get("authenticated"):
        return
    if session is None and request.client and _is_loopback(request.client.host) and _is_loopback(request.url.hostname):
        # The Lite dashboard is a local app without session middleware.
        if request.headers.get("sec-fetch-site") in {"cross-site", "same-site"}:
            raise HTTPException(403, "Otvorte MEGA Hub priamo v dashboarde.")
        return
    raise HTTPException(401, "Prihláste sa do lokálneho dashboardu.")


def _handoff_access(request: Request) -> None:
    if request.headers.get("X-Nexus-Mega-Hub") != "userscript":
        _dashboard_access(request)
        return
    origin = request.headers.get("origin", "")
    if (not request.client or not _is_loopback(request.client.host) or not _is_loopback(request.url.hostname)
            or (origin and not re.fullmatch(r"(?:chrome|moz)-extension://[a-z0-9-]+", origin))):
        raise HTTPException(403, "MEGA Hub bridge je dostupný z lokálneho userscriptu.")
    ensure_bridge_token(request.headers.get("X-Nexus-Token"))


class CheckRequest(BaseModel):
    url: str = Field(max_length=512)
    capture: bool = False


class PageFolder(BaseModel):
    id: str = Field(pattern=_HANDLE + "$", min_length=8, max_length=8)
    parent: str = Field(pattern=_HANDLE + "$", min_length=8, max_length=8)
    name: str = Field(max_length=1024)


class PageVideo(BaseModel):
    ref: str = Field(max_length=90)
    parent: str = Field(pattern=_HANDLE + "$", min_length=8, max_length=8)
    name: str = Field(max_length=1024)
    size: int = Field(default=0, ge=0, le=2**63 - 1)
    timestamp: int = Field(default=0, ge=0, le=2**32 - 1)
    duration: float = Field(default=0, ge=0, le=10**7)
    width: int = Field(default=0, ge=0, le=32768)
    height: int = Field(default=0, ge=0, le=32768)


class PageSnapshot(BaseModel):
    title: str = Field(max_length=1024)
    scope: str = Field(pattern=_HANDLE + "$", min_length=8, max_length=8)
    folders: list[PageFolder] = Field(default_factory=list, max_length=10_000)
    videos: list[PageVideo] = Field(default_factory=list, max_length=10_000)
    partial: bool = False


class AddRequest(BaseModel):
    check_id: str | None = Field(default=None, max_length=40)
    url: str | None = Field(default=None, max_length=512)
    page: PageSnapshot | None = None
    capture: bool = False
    link_post_id: int | None = None
    title_override: str | None = Field(default=None, max_length=256)
    keep_handoff: bool = False


class HandoffHarvestRequest(BaseModel):
    post_id: int | None = None
    source_url: str | None = Field(default=None, max_length=1024)
    mega_urls: list[str] = Field(default_factory=list, max_length=80)
    media_urls: list[str] = Field(default_factory=list, max_length=80)
    container_urls: list[str] = Field(default_factory=list, max_length=20)
    bypass_failed_provider: str | None = Field(default=None, max_length=64)


class ImportRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=100)


class RemoveEntryRequest(BaseModel):
    updated_at: str


class RemoveVideosRequest(RemoveEntryRequest):
    ids: list[str] = Field(min_length=1, max_length=10_000)


def _video_id(ref: str) -> str:
    return hashlib.sha256(ref.encode()).hexdigest()[:32]


def _without_removed(snapshot: dict, removed: set[str]) -> dict:
    if not removed:
        return snapshot
    return {**snapshot, "removed_video_ids": sorted(removed),
            "videos": [video for video in snapshot["videos"] if _video_id(video["ref"]) not in removed]}


def _verified_page(share: Share, page: PageSnapshot) -> dict:
    if share.kind != "folder" or (share.folder and share.folder != page.scope):
        raise HTTPException(400, "Odoslaný obsah nepatrí do tohto MEGA priečinka.")
    children: dict[str, list[PageFolder]] = {}
    for folder in page.folders:
        children.setdefault(folder.parent, []).append(folder)
    scope = {page.scope}
    folders = []
    pending = [page.scope]
    while pending:
        for folder in children.get(pending.pop(), []):
            if folder.id not in scope:
                folders.append(folder.model_dump())
                scope.add(folder.id)
                pending.append(folder.id)
    videos = {}
    for video in page.videos:
        match = re.fullmatch(rf"mega:n:({_HANDLE}):({_HANDLE}):([A-Za-z0-9_-]{{43}})", video.ref)
        if not match or match[1] != share.handle or video.parent not in scope:
            continue
        if not video.name.lower().endswith(mn.VIDEO_EXTS):
            continue
        ref = mn.parse_compact(video.ref).to_compact()
        videos[ref] = {**video.model_dump(), "ref": ref}
    return {"status": "available" if videos else "open_in_mega", "title": page.title or "MEGA priečinok",
            "scope": page.scope, "folders": folders, "videos": list(videos.values()), "from_page": True,
            "partial": page.partial or len(videos) < len(page.videos) or len(folders) < len(page.folders)}


async def _public_snapshot(share: Share) -> dict:
    if len(share.key) == 16:
        return await mn.list_tree(share.handle, share.key, share.folder, share.file)
    ref = mn.MegaRef("file", share.handle, mn.str_to_a32(share.key))
    info = await mn.resolve_cdn(ref)
    name = info["name"]
    if not name:
        return {"status": "unavailable"}
    videos = ([{"name": name, "size": info["size"], "ref": ref.to_compact()}]
              if name.lower().endswith(mn.VIDEO_EXTS) else [])
    return {"status": "available" if videos else "empty", "title": name,
            "scope": "", "folders": [], "videos": videos, "partial": False}


def _mega_error_reason(code: int) -> str:
    """Vráti čitateľný dôvod pre chybový kód MEGA API."""
    if code == -2:
        return "Neplatné parametre alebo kľúč MEGA odkazu (kód -2)."
    if code == -9:
        return "MEGA priečinok alebo súbor už neexistuje (kód -9)."
    if code in {-8, -11, -14, -16}:
        return f"Prístup k MEGA odkazu bol zablokovaný alebo zrušený (kód {code})."
    return f"Dočasná chyba MEGA API (kód {code}). Skúste znova."


async def _inspect(share: Share) -> dict:
    async with _CHECK_LIMIT:
        try:
            return await asyncio.wait_for(_public_snapshot(share), timeout=12)
        except mn.MegaAPIError as exc:
            status = "unavailable" if exc.code in {-2, -8, -9, -11, -14, -16} else "retry"
            return {"status": status, "reason": _mega_error_reason(exc.code)}
        except TimeoutError:
            return {"status": "retry", "reason": "Vypršal časový limit spojenia s MEGA (12 s)."}
        except httpx.HTTPError:
            return {"status": "retry", "reason": "Sieťová chyba pri komunikácii s MEGA."}
        except (ValueError, RuntimeError):
            return {"status": "retry", "reason": "Nepodarilo sa spracovať odpoveď z MEGA."}


async def _capture_snapshot(snapshot: dict, previous: dict | None = None) -> dict:
    if snapshot.get("capture_min_seconds") and previous is None:
        return snapshot
    if snapshot["status"] not in {"available", "empty"}:
        return snapshot
    original = snapshot["videos"]
    known = {video["ref"]: video for video in (previous or {}).get("videos", []) if video.get("duration", 0) > 0}

    async def measure(video: dict) -> None:
        ref = video["ref"]
        try:
            known[ref] = await mega.mega_card_metadata(mega.MegaMetadataRequest(ref=ref))
        except HTTPException:
            return

    try:
        await asyncio.wait_for(asyncio.gather(*(measure(video) for video in original
                                               if not video.get("duration") and video["ref"] not in known)),
                               timeout=_CAPTURE_PROBE_TIMEOUT)
    except TimeoutError:
        pass

    videos = []
    short = unknown = 0
    for video in original:
        metadata = known.get(video["ref"], {})
        duration = video.get("duration") or metadata.get("duration") or 0
        if duration >= _CAPTURE_MIN_SECONDS:
            videos.append({**video, "duration": duration, "width": video.get("width") or metadata.get("width", 0),
                           "height": video.get("height") or metadata.get("height", 0)})
        elif duration > 0:
            short += 1
        else:
            unknown += 1
    status = "available" if videos else "duration_unknown" if unknown else "below_minimum" if short else "empty"
    return {**snapshot, "status": status, "videos": videos, "capture_min_seconds": _CAPTURE_MIN_SECONDS,
            "short_count": short, "unknown_duration_count": unknown}


def _summary(entry: MegaHubEntry) -> dict:
    return {"id": entry.id, "kind": entry.kind, "title": entry.title,
            "count": len(entry.snapshot["videos"]), "partial": entry.snapshot.get("partial", False),
            "from_page": entry.snapshot.get("from_page", False),
            "updated_at": entry.updated_at.isoformat() + "Z"}


def _entry(db: Session, entry_id: int) -> MegaHubEntry:
    entry = db.get(MegaHubEntry, entry_id)
    if entry is None:
        raise HTTPException(404, "Položka sa v MEGA Hube nenašla.")
    return entry


def _current_entry(db: Session, entry_id: int, updated_at: str) -> MegaHubEntry:
    entry = _entry(db, entry_id)
    if updated_at != _summary(entry)["updated_at"]:
        raise HTTPException(409, "Položka sa medzitým zmenila. Otvorte ju znova.")
    return entry


def _card(entry_id: int, video: dict, library: dict) -> dict:
    video_id = _video_id(video["ref"])
    media = f"/api/v1/mega/hub/entries/{entry_id}/videos/{video_id}"
    duration, width, height, quality = mega._apply_meta(video, video["name"])
    if quality == "MEGA":
        quality = ""
    thumb_url = f"{media}/thumb"
    cached_thumb = mega_hub_thumb_path(video_id)
    if cached_thumb.is_file() and cached_thumb.stat().st_size > 0:
        thumb_url = f"{thumb_url}?v={int(cached_thumb.stat().st_mtime)}"
    return {"id": video_id, "name": video["name"], "parent": video.get("parent", ""),
            "size": video["size"], "timestamp": video.get("timestamp", 0),
            "duration": duration, "width": width, "height": height, "quality": quality,
            "library_id": library.get(video["ref"]), "stream": f"{media}/stream", "thumb": thumb_url,
            "metadata": f"{media}/metadata", "download": f"{media}/download", "rethumb": f"{media}/rethumb"}


@router.get("/ping")
async def ping():
    return {"service": "nexus-mega-hub", "token_required": bool(config.NEXUS_BRIDGE_TOKEN),
            "capture_min_seconds": _CAPTURE_MIN_SECONDS}


def register_link_handoff(
    post_id: int,
    title: str,
    raw_url: str,
    *,
    keyless_mega_url: str | None = None,
    keyless_mega_kind: str | None = None,
) -> dict:
    """Zapíše aktívny browser handoff pre spárovanie výsledného MEGA odkazu (alebo samotného kľúča) z prehliadača."""
    global _ACTIVE_HANDOFF
    _ACTIVE_HANDOFF = {
        "post_id": int(post_id),
        "title": (title or "").strip()[:180],
        "raw_url": (raw_url or "").strip()[:512],
        "keyless_mega_url": (keyless_mega_url or "").strip()[:256] or None,
        "keyless_mega_kind": (keyless_mega_kind or "").strip() or None,
        "created_at": time.time(),
        "expires_at": time.monotonic() + _HANDOFF_TTL,
    }
    return {
        "post_id": _ACTIVE_HANDOFF["post_id"],
        "title": _ACTIVE_HANDOFF["title"],
        "raw_url": _ACTIVE_HANDOFF["raw_url"],
        "keyless_mega_url": _ACTIVE_HANDOFF["keyless_mega_url"],
        "keyless_mega_kind": _ACTIVE_HANDOFF["keyless_mega_kind"],
    }


def get_active_handoff() -> dict | None:
    """Vráti aktívny neexspirovaný handoff alebo None."""
    global _ACTIVE_HANDOFF
    if not _ACTIVE_HANDOFF:
        return None
    if _ACTIVE_HANDOFF["expires_at"] <= time.monotonic():
        _ACTIVE_HANDOFF = None
        return None
    return {
        "post_id": _ACTIVE_HANDOFF["post_id"],
        "title": _ACTIVE_HANDOFF["title"],
        "raw_url": _ACTIVE_HANDOFF["raw_url"],
        "keyless_mega_url": _ACTIVE_HANDOFF.get("keyless_mega_url"),
        "keyless_mega_kind": _ACTIVE_HANDOFF.get("keyless_mega_kind"),
    }


def clear_active_handoff(post_id: int | None = None) -> None:
    """Vymaže čakajúci browser handoff."""
    global _ACTIVE_HANDOFF
    if not _ACTIVE_HANDOFF:
        return
    if post_id is None or _ACTIVE_HANDOFF["post_id"] == int(post_id):
        _ACTIVE_HANDOFF = None


def _has_link_posts_table(db: Session) -> bool:
    try:
        bind = db.get_bind()
        return bind is not None and inspect(bind).has_table(TelegramLinkPost.__tablename__)
    except Exception:
        return False


def _merge_entry_title(current_title: str, label: str) -> str:
    clean_label = (label or "").strip()[:180]
    if not clean_label:
        return current_title
    base = (current_title or "").strip()
    if base.lower() in {"", "mega priečinok", "cloud drive", "mega folder"}:
        return clean_label
    if clean_label.lower() in base.lower():
        return base
    return f"{clean_label} · {base}"[:240]


@router.get("/handoff", dependencies=[Depends(_handoff_access)])
async def handoff_status():
    return {"handoff": get_active_handoff()}


@router.post("/handoff/harvest", dependencies=[Depends(_handoff_access)])
async def handoff_harvest(req: HandoffHarvestRequest, db: Session = Depends(get_db)):
    """Userscript bridge: uloží celú zozbieranú stránku (všetky MEGA + media + paste URL) na aktívnu Telegram kartu a do URL cache."""
    from ..mega_link_extractor import classify_media_url, extract_mega_urls, is_paste_container_url
    from ..telegram_links import (
        merge_discovered_links,
        parse_discovered_links,
        save_cached_resolution,
        save_post_discovered_links,
        serialize_link_post,
        summarize_discovered_links,
    )

    active = get_active_handoff()
    target_id = req.post_id if (req.post_id and req.post_id > 0) else (active["post_id"] if active else None)
    post = db.get(TelegramLinkPost, target_id) if (target_id and _has_link_posts_table(db)) else None

    clean_megas = extract_mega_urls("", extra_urls=req.mega_urls)
    clean_medias: list[dict] = []
    seen_media: set[str] = set()
    for u in req.media_urls:
        info = classify_media_url(u)
        if info and info["url"] not in seen_media:
            seen_media.add(info["url"])
            clean_medias.append(info)
    clean_conts: list[dict] = []
    seen_cont: set[str] = set()
    for u in [*(req.container_urls or ()), *([req.source_url] if req.source_url else ())]:
        u_clean = (u or "").strip()
        if u_clean and is_paste_container_url(u_clean):
            key = u_clean.rstrip("/")
            if key not in seen_cont:
                seen_cont.add(key)
                clean_conts.append({"url": u_clean, "domain": urlsplit(u_clean).netloc.lower(), "crawled": True})

    if post is None:
        if req.source_url and (clean_megas or clean_medias):
            save_cached_resolution(
                db,
                req.source_url,
                final_url=clean_megas[0] if clean_megas else req.source_url,
                mega_urls=clean_megas,
                media_urls=clean_medias,
                container_urls=clean_conts,
                provider="userscript",
            )
        return {
            "ok": True,
            "linked_post_id": None,
            "mega_count": len(clean_megas),
            "media_count": len(clean_medias),
            "container_count": len(clean_conts),
        }

    bag = merge_discovered_links(
        parse_discovered_links(post),
        mega_urls=clean_megas,
        media_urls=clean_medias,
        container_urls=clean_conts,
    )
    save_post_discovered_links(post, bag)
    if clean_megas and not post.resolved_mega_url:
        post.resolved_mega_url = clean_megas[0]
        post.final_url = clean_megas[0]
        post.domain = "mega.nz"
        if post.link_kind == "external":
            post.link_kind = "resolved_mega"
    post.updated_at = utcnow()
    db.commit()

    # Zapíšeme výsledok do lokálnej URL cache pre raw_url aj final_url (šetrí budúce bypass volania!)
    for cache_key in dict.fromkeys(u for u in (post.raw_url, post.final_url, req.source_url) if u and "mega.nz" not in u.lower()):
        save_cached_resolution(
            db,
            cache_key,
            final_url=clean_megas[0] if clean_megas else (req.source_url or cache_key),
            mega_urls=clean_megas,
            media_urls=clean_medias,
            container_urls=clean_conts,
            provider="userscript",
        )

    db.refresh(post)
    return {
        "ok": True,
        "linked_post_id": post.id,
        "summary": summarize_discovered_links(bag),
        "item": serialize_link_post(post),
    }


@router.get("/scripts/{name}", include_in_schema=False)
async def install_script(name: str):
    if name not in {"mega-hub-capture.user.js", "mega-folder-enhancer.user.js"}:
        raise HTTPException(404)
    return FileResponse(_SCRIPT_DIR / name, media_type="application/javascript", headers={"Cache-Control": "no-cache"})


@router.post("/check", dependencies=[Depends(_handoff_access)])
async def check(req: CheckRequest):
    share = parse_share(req.url)
    snapshot = await _inspect(share)
    if req.capture:
        snapshot = await _capture_snapshot(snapshot)
    result = {"status": snapshot["status"], "title": snapshot.get("title"),
              "count": len(snapshot.get("videos", [])), "kind": share.kind}
    if snapshot.get("reason"):
        result["reason"] = snapshot["reason"]
    if req.capture:
        result.update(short_count=snapshot.get("short_count", 0), unknown_duration_count=snapshot.get("unknown_duration_count", 0))
    if result["status"] == "available":
        now = time.monotonic()
        while _CHECKS and (len(_CHECKS) >= 128 or next(iter(_CHECKS.values()))[0] <= now):
            _CHECKS.popitem(last=False)
        check_id = secrets.token_urlsafe(18)
        _CHECKS[check_id] = (now + _CHECK_TTL, share, snapshot)
        result["check_id"] = check_id
    return result


def _sync_linked_posts(
    db: Session,
    entry: MegaHubEntry,
    share_url: str,
    *,
    target_post_id: int | None = None,
    title_override: str | None = None,
    enrich_title: bool = False,
    keep_handoff: bool = False,
) -> int | None:
    """Prepojí pridanú položku MEGA Hubu s TelegramLinkPost kartami, zapíše do discovered bagu aj URL cache."""
    if not _has_link_posts_table(db):
        return None

    from ..telegram_links import (
        merge_discovered_links,
        parse_discovered_links,
        save_cached_resolution,
        save_post_discovered_links,
    )

    linked_post_id: int | None = None
    video_count = len((entry.snapshot or {}).get("videos", []))
    now = utcnow()
    post = db.get(TelegramLinkPost, target_post_id) if target_post_id and target_post_id > 0 else None

    if post is not None:
        raw_before = post.raw_url
        final_before = post.final_url
        bag = merge_discovered_links(
            parse_discovered_links(post),
            mega_entries=[{
                "url": share_url,
                "status": "in_hub",
                "title": entry.title or post.title or "",
                "video_count": video_count,
                "hub_entry_id": entry.id,
            }],
        )
        save_post_discovered_links(post, bag)
        if not post.resolved_mega_url:
            post.resolved_mega_url = share_url
        if post.link_kind == "external":
            post.link_kind = "resolved_mega"
        post.status = "in_hub"
        post.mega_hub_entry_id = entry.id
        total_in_hub_vids = sum(int(m.get("video_count") or 0) for m in bag["mega"] if m.get("status") == "in_hub")
        post.mega_video_count = total_in_hub_vids or video_count
        post.updated_at = now
        linked_post_id = post.id
        if not keep_handoff:
            clear_active_handoff(post.id)
        for cache_key in dict.fromkeys(u for u in (raw_before, final_before) if u and "mega.nz" not in u.lower()):
            save_cached_resolution(
                db,
                cache_key,
                final_url=share_url,
                mega_urls=[share_url],
                provider="handoff",
            )

    label = (title_override or (post.title if post is not None else "") or "").strip()
    if label and (enrich_title or (entry.title or "").strip().lower() in {"", "mega priečinok", "cloud drive", "mega folder"}):
        merged_title = _merge_entry_title(entry.title, label)
        if merged_title != entry.title:
            entry.title = merged_title
            entry.updated_at = now

    matching = (
        db.query(TelegramLinkPost)
        .filter((TelegramLinkPost.resolved_mega_url == share_url) | (TelegramLinkPost.raw_url == share_url))
        .all()
    )
    for item in matching:
        item.resolved_mega_url = share_url
        item.status = "in_hub"
        item.mega_hub_entry_id = entry.id
        item.mega_video_count = video_count
        item_bag = merge_discovered_links(
            parse_discovered_links(item),
            mega_entries=[{
                "url": share_url,
                "status": "in_hub",
                "title": entry.title or item.title or "",
                "video_count": video_count,
                "hub_entry_id": entry.id,
            }],
        )
        save_post_discovered_links(item, item_bag)
        item.updated_at = now

    db.commit()
    return linked_post_id


async def add_share_to_hub(
    db: Session,
    *,
    url: str | None = None,
    check_id: str | None = None,
    page: PageSnapshot | None = None,
    capture: bool = False,
    title_override: str | None = None,
    link_post_id: int | None = None,
    from_userscript: bool = False,
    keep_handoff: bool = False,
) -> dict:
    """Pridá alebo aktualizuje položku v MEGA Hube a spáruje ju s Telegram link kartami."""
    if check_id:
        if url or page:
            raise HTTPException(400, "Vyberte jeden spôsob odoslania.")
        checked = _CHECKS.get(check_id)
        if not checked or checked[0] <= time.monotonic():
            raise HTTPException(409, "Platnosť výsledku vypršala. Overte odkaz znova.")
        _, share, snapshot = checked
    elif url:
        share = parse_share(url)
        snapshot = await _inspect(share)
        if page:
            verified_page = _verified_page(share, page)
            if verified_page["videos"] and (snapshot["status"] != "available" or snapshot.get("partial")):
                # Preserve public nodes that the tab has not loaded yet.
                if snapshot["status"] == "available" and snapshot["scope"] == verified_page["scope"]:
                    for key, identity in (("folders", "id"), ("videos", "ref")):
                        verified_page[key] = list({node[identity]: node for node in snapshot[key] + verified_page[key]}.values())
                    verified_page["partial"] = True
                snapshot = verified_page
    else:
        raise HTTPException(400, "Chýba MEGA odkaz.")

    if capture:
        snapshot = await _capture_snapshot(snapshot)
        if snapshot["status"] != "available":
            return {"status": snapshot["status"], "short_count": snapshot.get("short_count", 0),
                    "unknown_duration_count": snapshot.get("unknown_duration_count", 0)}

    target_post_id: int | None = None
    if link_post_id is not None:
        target_post_id = link_post_id if link_post_id > 0 else None
    elif from_userscript:
        active = get_active_handoff()
        if active:
            target_post_id = active["post_id"]

    entry = db.query(MegaHubEntry).filter_by(url=share.url).first()
    if snapshot["status"] != "available" and not (snapshot["status"] == "empty" and share.kind == "folder"):
        if entry:
            linked_post_id = _sync_linked_posts(
                db, entry, share.url, target_post_id=target_post_id, title_override=title_override,
                enrich_title=False, keep_handoff=keep_handoff,
            )
            payload = {"status": "exists", "entry": _summary(entry)}
            if linked_post_id is not None:
                payload["linked_post_id"] = linked_post_id
            return payload
        return {"status": snapshot["status"]}

    if entry:
        if snapshot.get("from_page") and (entry.snapshot.get("partial") or entry.snapshot.get("from_page")):
            minimum = entry.snapshot.get("capture_min_seconds")
            if minimum:
                snapshot = {**snapshot, "capture_min_seconds": minimum,
                            "videos": [video for video in snapshot["videos"] if (video.get("duration") or 0) >= minimum]}
            if entry.snapshot["scope"] == snapshot["scope"]:
                for key, identity in (("folders", "id"), ("videos", "ref")):
                    snapshot[key] = list({node[identity]: node for node in entry.snapshot[key] + snapshot[key]}.values())
            entry.snapshot = _without_removed(snapshot, set(entry.snapshot.get("removed_video_ids", [])))
            entry.updated_at = utcnow()
            db.commit()
        linked_post_id = _sync_linked_posts(
            db, entry, share.url, target_post_id=target_post_id, title_override=title_override,
            enrich_title=False, keep_handoff=keep_handoff,
        )
        payload = {"status": "exists", "entry": _summary(entry)}
        if linked_post_id is not None:
            payload["linked_post_id"] = linked_post_id
        return payload

    entry = MegaHubEntry(url=share.url, kind=share.kind, title=snapshot["title"], snapshot=snapshot)
    db.add(entry)
    try:
        db.commit()
        result_status = "added"
    except IntegrityError:
        db.rollback()
        entry = db.query(MegaHubEntry).filter_by(url=share.url).one()
        result_status = "exists"

    linked_post_id = _sync_linked_posts(
        db,
        entry,
        share.url,
        target_post_id=target_post_id,
        title_override=title_override,
        enrich_title=(result_status == "added"),
        keep_handoff=keep_handoff,
    )
    payload = {"status": result_status, "entry": _summary(entry)}
    if linked_post_id is not None:
        payload["linked_post_id"] = linked_post_id
    return payload


@router.post("/entries", dependencies=[Depends(_handoff_access)])
async def add(req: AddRequest, request: Request, db: Session = Depends(get_db)):
    return await add_share_to_hub(
        db,
        url=req.url,
        check_id=req.check_id,
        page=req.page,
        capture=req.capture,
        title_override=req.title_override,
        link_post_id=req.link_post_id,
        from_userscript=(request.headers.get("X-Nexus-Mega-Hub") == "userscript"),
        keep_handoff=req.keep_handoff,
    )


@router.get("/entries", dependencies=[Depends(_dashboard_access)])
def entries(db: Session = Depends(get_db)):
    return {"entries": [_summary(entry) for entry in db.query(MegaHubEntry).order_by(MegaHubEntry.id.desc())]}


@router.get("/entries/{entry_id}", dependencies=[Depends(_dashboard_access)])
def detail(entry_id: int, db: Session = Depends(get_db)):
    entry = _entry(db, entry_id)
    snapshot = entry.snapshot
    refs = [video["ref"] for video in snapshot["videos"]]
    library = {}
    for i in range(0, len(refs), 500):
        for ref, video_id in db.query(Video.url, Video.id).filter(Video.url.in_(refs[i:i + 500])):
            library[ref] = video_id
    return {**_summary(entry), "scope": snapshot["scope"], "folders": snapshot["folders"],
            "videos": [_card(entry.id, video, library) for video in snapshot["videos"]]}


@router.get("/entries/{entry_id}/source", dependencies=[Depends(_dashboard_access)])
def source(entry_id: int, folder: str | None = None, video: str | None = None, db: Session = Depends(get_db)):
    entry = _entry(db, entry_id)
    url = entry.url
    if entry.kind == "folder" and (video or folder):
        root_url = url.split("/folder/", 2)
        root_url = "/folder/".join(root_url[:2])
        if video:
            ref = mn.parse_compact(_media(entry_id, video, db)["ref"])
            url = f"{root_url}/file/{ref.file_handle}"
        elif any(item["id"] == folder for item in entry.snapshot["folders"]):
            url = f"{root_url}/folder/{folder}"
    return RedirectResponse(url, headers={"Referrer-Policy": "no-referrer"})


@router.post("/entries/{entry_id}/refresh", dependencies=[Depends(_dashboard_access)])
async def refresh(entry_id: int, db: Session = Depends(get_db)):
    entry = _entry(db, entry_id)
    source_url = entry.url
    snapshot = await _inspect(parse_share(source_url))
    if entry.snapshot.get("capture_min_seconds"):
        snapshot = await _capture_snapshot(snapshot, entry.snapshot)
    db.expire_all()
    entry = _entry(db, entry_id)
    if entry.url != source_url:
        raise HTTPException(409, "Položka sa medzitým zmenila. Otvorte ju znova.")
    if snapshot["status"] == "duration_unknown":
        return {"status": "retry"}
    if snapshot["status"] not in {"available", "empty", "below_minimum"}:
        return {"status": snapshot["status"]}
    if entry.snapshot.get("from_page") and (snapshot["status"] == "empty" or snapshot.get("partial")):
        return {"status": "open_in_mega"}
    entry.title = snapshot["title"]
    entry.snapshot = _without_removed(snapshot, set(entry.snapshot.get("removed_video_ids", [])))
    entry.updated_at = utcnow()
    db.commit()
    return {"status": "updated", "entry": _summary(entry)}


@router.post("/entries/{entry_id}/videos/remove", dependencies=[Depends(_dashboard_access)])
async def remove_videos(entry_id: int, req: RemoveVideosRequest, db: Session = Depends(get_db)):
    entry = _current_entry(db, entry_id, req.updated_at)
    current = {_video_id(video["ref"]) for video in entry.snapshot["videos"]}
    removed = set(entry.snapshot.get("removed_video_ids", []))
    wanted = set(req.ids)
    if not wanted <= current | removed:
        raise HTTPException(409, "Niektoré videá nepatria do tejto položky Hubu. Obnovte priečinok.")
    count = len(current & wanted)
    if count:
        entry.snapshot = _without_removed(entry.snapshot, removed | wanted)
        entry.updated_at = utcnow()
        db.commit()
    return {"removed": count, "entry": _summary(entry)}


@router.post("/entries/{entry_id}/remove", dependencies=[Depends(_dashboard_access)])
async def remove_entry(entry_id: int, req: RemoveEntryRequest, db: Session = Depends(get_db)):
    entry = _current_entry(db, entry_id, req.updated_at)
    if _has_link_posts_table(db):
        linked = db.query(TelegramLinkPost).filter(TelegramLinkPost.mega_hub_entry_id == entry_id).all()
        now = utcnow()
        for post in linked:
            post.mega_hub_entry_id = None
            if post.status == "in_hub":
                post.status = "opened" if post.link_kind != "direct_mega" else "new"
            post.updated_at = now
    db.delete(entry)
    db.commit()
    return {"removed": True}


@router.post("/entries/{entry_id}/import", dependencies=[Depends(_dashboard_access)])
async def import_selection(entry_id: int, req: ImportRequest, db: Session = Depends(get_db)):
    entry = _entry(db, entry_id)
    wanted = set(req.ids)
    catalog = entry.snapshot["videos"]
    selected = [video for video in catalog if _video_id(video["ref"]) in wanted]
    if len(selected) != len(wanted):
        raise HTTPException(409, "Niektoré videá už v tomto zobrazení nie sú. Obnovte priečinok.")
    seq = {video["ref"]: i for i, video in enumerate(catalog, start=1)}
    async with _IMPORT_LIMIT:
        return await mega._ingest_videos(db, selected, source_url=entry.url, batch=f"MEGA · {entry.title}",
                                         album_title=entry.title, seq_by_ref=seq, fast=True)


def _media(entry_id: int, video_id: str, db: Session) -> dict:
    entry = _entry(db, entry_id)
    for video in entry.snapshot["videos"]:
        if _video_id(video["ref"]) == video_id:
            return video
    raise HTTPException(404, "Video sa v MEGA Hube nenašlo.")


@router.head("/entries/{entry_id}/videos/{video_id}/stream", include_in_schema=False,
             dependencies=[Depends(_dashboard_access)])
@router.get("/entries/{entry_id}/videos/{video_id}/stream", dependencies=[Depends(_dashboard_access)])
async def stream(entry_id: int, video_id: str, request: Request, db: Session = Depends(get_db)):
    video = _media(entry_id, video_id, db)
    mime = mimetypes.guess_type(video["name"])[0] or "video/mp4"
    try:
        return await mega._stream_mega_ref(video["ref"], request, video_id, content_type=mime)
    except HTTPException as exc:
        detail = "MEGA dosiahla limit prenosu. Skúste neskôr." if exc.status_code == 509 else exc.detail
        raise HTTPException(exc.status_code, detail, headers=exc.headers) from None
    except (httpx.HTTPError, RuntimeError):
        raise HTTPException(502, "MEGA video sa nepodarilo načítať.") from None


@router.get("/entries/{entry_id}/videos/{video_id}/download", dependencies=[Depends(_dashboard_access)])
async def download(entry_id: int, video_id: str, request: Request, db: Session = Depends(get_db)):
    video = _media(entry_id, video_id, db)
    return await mega.download_mega_ref(video["ref"], request, video_id, video["name"])


class RethumbSingleRequest(BaseModel):
    reroll: bool = True


class RethumbBatchRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)
    reroll: bool = False


def _pick_rethumb_points(duration: float, reroll: bool = False) -> list[float]:
    """Vyberie časové pozície vo videu, ktoré preskočia čierne úvody a logá."""
    dur = max(0.0, float(duration or 0))
    if reroll:
        if dur >= 30.0:
            return [
                round(dur * random.uniform(0.14, 0.38), 2),
                round(dur * random.uniform(0.42, 0.68), 2),
                round(dur * random.uniform(0.72, 0.88), 2),
            ]
        if dur > 0.0:
            return [
                round(max(0.2, dur * random.uniform(0.20, 0.48)), 2),
                round(max(0.2, dur * random.uniform(0.52, 0.85)), 2),
                round(max(0.2, dur * random.uniform(0.08, 0.22)), 2),
            ]
        return [
            round(random.uniform(18.0, 55.0), 2),
            round(random.uniform(60.0, 120.0), 2),
            round(random.uniform(6.0, 17.0), 2),
        ]
    if dur >= 120.0:
        first = min(180.0, max(45.0, dur * 0.25))
        return [round(first, 2), round(dur * 0.55, 2), round(dur * 0.12, 2)]
    if dur >= 20.0:
        return [round(dur * 0.30, 2), round(dur * 0.62, 2), round(dur * 0.14, 2)]
    if dur > 0.0:
        return [round(max(0.2, dur * 0.38), 2), round(max(0.2, dur * 0.72), 2), round(max(0.2, dur * 0.15), 2)]
    return [30.0, 10.0, 65.0]


def _sync_library_thumb(video_ref: str, improved_path: Path) -> None:
    """Ak už bolo video uložené do hlavnej galérie, zosynchronizuje mu vylepšený náhľad."""
    if not improved_path.is_file():
        return
    try:
        lib_thumb_dir = Path(__file__).resolve().parents[1] / "static" / "thumbnails"
        lib_thumb_dir.mkdir(parents=True, exist_ok=True)
        with SessionLocal() as db:
            rows = db.query(Video).filter(Video.url == video_ref).all()
            if not rows:
                return
            now = utcnow()
            for row in rows:
                dst = lib_thumb_dir / f"thumb_{row.id}.jpg"
                tmp = dst.with_suffix(".tmp.jpg")
                shutil.copyfile(improved_path, tmp)
                os.replace(tmp, dst)
                row.thumbnail_path = f"/static/thumbnails/thumb_{row.id}.jpg"
                row.smart_rethumb_at = now
                row.smart_rethumb_error = None
                row.preview_retry_needed = False
            db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.debug("MEGA Hub sync library thumb preskočený: %s", exc)


async def _improve_hub_video_thumb(video: dict, *, reroll: bool = False) -> dict:
    """Vygeneruje ostrý HD náhľad z reálneho streamu MEGA videa (alebo HD preview) a uloží ho na disk."""
    from ..maintenance import _image_score, _run_thumb_process

    ref_str = video["ref"]
    video_id = _video_id(ref_str)
    dest = mega_hub_thumb_path(video_id)
    dest.parent.mkdir(parents=True, exist_ok=True)

    lock = _RETHUMB_LOCKS.setdefault(video_id, asyncio.Lock())
    try:
        async with _RETHUMB_LIMIT, lock:
            parsed_ref = mn.parse_compact(ref_str)
            duration = float(video.get("duration") or 0)
            width = int(video.get("width") or 0)
            height = int(video.get("height") or 0)

            if duration <= 0:
                try:
                    probed = await asyncio.wait_for(mn.probe_metadata(parsed_ref, fast=True), timeout=10)
                    duration = float(probed.get("duration") or 0)
                    width = width or int(probed.get("width") or 0)
                    height = height or int(probed.get("height") or 0)
                except Exception:
                    pass

            stream_url = f"http://127.0.0.1:{config.SERVER_PORT}/api/v1/mega/stream-ref?ref={quote(ref_str, safe='')}"
            points = _pick_rethumb_points(duration, reroll=reroll)
            ffmpeg_bin = shutil.which("ffmpeg") or "ffmpeg"
            last_err = ""

            with tempfile.TemporaryDirectory(prefix="mega_hub_frame_", dir=dest.parent) as temp:
                candidates: list[tuple[int, str]] = []
                for idx, pos in enumerate(points):
                    output = str(Path(temp) / f"{idx}.jpg")
                    cmd = [
                        ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error",
                        "-threads", "2",
                        "-probesize", "2M", "-analyzeduration", "1500000",
                        "-noaccurate_seek", "-ss", str(pos),
                        "-i", stream_url,
                        "-frames:v", "1",
                        "-vf", "scale=w='min(iw,720)':h='min(ih,720)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p",
                        "-q:v", "3",
                        output,
                    ]
                    try:
                        ok, stderr = await _run_thumb_process(cmd, 30)
                        if not ok and stderr:
                            last_err = stderr.strip()
                    except Exception as exc:  # noqa: BLE001
                        ok = False
                        last_err = str(exc)

                    score = await asyncio.to_thread(_image_score, output) if ok and os.path.isfile(output) else 0
                    if score > 0:
                        candidates.append((score, output))
                        if score >= (65 if reroll else 55):
                            break
                    elif "509" in last_err:
                        raise RuntimeError("MEGA dosiahla limit prenosu. Skúste neskôr.")

                if candidates:
                    best_path = max(candidates, key=lambda item: item[0])[1]
                    os.replace(best_path, dest)
                else:
                    # Fallback na MEGA HD preview (type_=1), ak FFmpeg nedokázal prečítať stream.
                    hd_preview = await mn.fetch_thumbnail(parsed_ref, type_=1)
                    if hd_preview:
                        tmp_fb = dest.with_suffix(".fb.tmp")
                        tmp_fb.write_bytes(hd_preview)
                        os.replace(tmp_fb, dest)
                    else:
                        msg = "MEGA dosiahla limit prenosu. Skúste neskôr." if "509" in last_err else "Nepodarilo sa získať kvalitnú snímku z MEGA videa."
                        raise RuntimeError(msg)

            await asyncio.to_thread(_sync_library_thumb, ref_str, dest)
            ts = int(time.time() * 1000)
            _, w_out, h_out, q_out = mega._apply_meta(
                {**video, "duration": duration, "width": width, "height": height},
                video["name"],
            )
            if q_out == "MEGA":
                q_out = ""
            return {
                "id": video_id,
                "ts": ts,
                "duration": duration,
                "width": w_out,
                "height": h_out,
                "quality": q_out,
            }
    finally:
        if not lock.locked():
            _RETHUMB_LOCKS.pop(video_id, None)


@router.get("/entries/{entry_id}/videos/{video_id}/thumb", dependencies=[Depends(_dashboard_access)])
async def thumb(entry_id: int, video_id: str, db: Session = Depends(get_db)):
    video = _media(entry_id, video_id, db)
    cached = mega_hub_thumb_path(video_id)
    if cached.is_file() and cached.stat().st_size > 0:
        return FileResponse(cached, media_type="image/jpeg", headers={"Cache-Control": "private, no-cache"})
    parsed = mn.parse_compact(video["ref"])
    image = await mn.fetch_thumbnail(parsed, type_=1)
    if not image:
        image = await mn.fetch_thumbnail(parsed, type_=0)
    if not image:
        raise HTTPException(404, "MEGA náhľad nie je dostupný.")
    return Response(content=image, media_type=mn.thumbnail_mime(image), headers={"Cache-Control": "private, max-age=3600"})


@router.post("/entries/{entry_id}/videos/{video_id}/rethumb", dependencies=[Depends(_dashboard_access)])
async def rethumb_video(
    entry_id: int,
    video_id: str,
    req: RethumbSingleRequest | None = None,
    db: Session = Depends(get_db),
):
    video = _media(entry_id, video_id, db)
    reroll = True if req is None else bool(req.reroll)
    try:
        info = await _improve_hub_video_thumb(video, reroll=reroll)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)[:220]) from None
    return {
        "ok": True,
        "id": video_id,
        "thumb": f"/api/v1/mega/hub/entries/{entry_id}/videos/{video_id}/thumb?v={info['ts']}",
        "duration": info["duration"],
        "width": info["width"],
        "height": info["height"],
        "quality": info["quality"],
    }


@router.post("/entries/{entry_id}/rethumb", dependencies=[Depends(_dashboard_access)])
async def rethumb_batch(entry_id: int, req: RethumbBatchRequest, db: Session = Depends(get_db)):
    """Hromadne zlepší náhľady vybraných/zobrazených videí v MEGA Hube a streamuje priebeh cez NDJSON."""
    entry = _entry(db, entry_id)
    by_id = {_video_id(v["ref"]): v for v in entry.snapshot["videos"]}
    targets: list[dict] = []
    seen: set[str] = set()
    for vid in req.ids:
        if vid in by_id and vid not in seen:
            seen.add(vid)
            targets.append(by_id[vid])
    if not targets:
        raise HTTPException(404, "V zadanom výbere sa nenašli žiadne videá.")

    total = len(targets)

    async def _gen():
        done = 0
        failed = 0

        async def _one(video: dict) -> dict:
            vid = _video_id(video["ref"])
            try:
                info = await _improve_hub_video_thumb(video, reroll=req.reroll)
                return {
                    "id": vid,
                    "ok": True,
                    "thumb": f"/api/v1/mega/hub/entries/{entry_id}/videos/{vid}/thumb?v={info['ts']}",
                    "duration": info["duration"],
                    "width": info["width"],
                    "height": info["height"],
                    "quality": info["quality"],
                }
            except Exception as exc:  # noqa: BLE001
                return {"id": vid, "ok": False, "error": str(exc)[:180]}

        tasks = [asyncio.create_task(_one(video)) for video in targets]
        try:
            for fut in asyncio.as_completed(tasks):
                ev = await fut
                if ev.get("ok"):
                    done += 1
                else:
                    failed += 1
                yield json.dumps({"type": "progress", "done": done, "failed": failed, "total": total, **ev}, ensure_ascii=False) + "\n"
            yield json.dumps({"type": "done", "done": done, "failed": failed, "total": total}, ensure_ascii=False) + "\n"
        finally:
            for t in tasks:
                if not t.done():
                    t.cancel()

    return StreamingResponse(
        _gen(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/entries/{entry_id}/videos/{video_id}/metadata", dependencies=[Depends(_dashboard_access)])
async def metadata(entry_id: int, video_id: str, db: Session = Depends(get_db)):
    video = _media(entry_id, video_id, db)
    return await mega.mega_card_metadata(mega.MegaMetadataRequest(ref=video["ref"]))
