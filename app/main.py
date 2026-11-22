from fastapi import FastAPI, Depends, UploadFile, File, BackgroundTasks, HTTPException, Request, Response, Body, WebSocket, WebSocketDisconnect, APIRouter, Header, Query
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse, RedirectResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from sqlalchemy.orm import Session, load_only
from sqlalchemy import distinct, desc, asc, or_, and_, text, case, func
import re
import time
import hashlib
import random
import secrets
from typing import Any, List, Optional, Dict
from pydantic import BaseModel
import datetime
import os
import sqlite3
from dotenv import load_dotenv

load_dotenv()
from .config import config
from .logging_setup import configure_logging

configure_logging(config.LOG_LEVEL, config.LOG_JSON)

import aiohttp
import httpx
import json
import base64
import urllib.parse
import requests
import shutil
import subprocess
import tempfile
import yt_dlp
import asyncio
import logging
import socket
import mimetypes
import uuid
from pathlib import Path
import sqlite3 as _sqlite3

from .database import get_db, init_db, Video, VideoSource, SmartPlaylist, SessionLocal, SearchHistory, CBIRSearchCache, DiscoveryProfile, DiscoveryNotification, DiscoveredVideo, DiscoveryDismissedVideo, ImportJob, sanitize_fts_query
# FIX: Odstránené nefunkčné importy (PornOne, JD)
from contextlib import asynccontextmanager
from .services import VIPVideoProcessor, search_videos_by_subtitle, get_batch_stats, get_tags_stats, get_quality_stats, extract_playlist_urls, fetch_eporner_videos, scrape_eporner_discovery
from .camwhores_discovery import CamwhoresSourceError, async_extract_detail_metadata, scrape_camwhores_discovery, enrich_camwhores_discovery_item, scrape_camwhores_playlists, fetch_playlist_videos, fetch_multiple_playlists, scrape_camwhores_categories, scrape_camwhores_models, scrape_camwhores_hub_videos, scrape_camwhores_member_profile, scrape_camwhores_member_videos, enrich_playlist_card, batch_enrich_cards
from .porntrex_discovery import scrape_porntrex_discovery
from .whoreshub_discovery import scrape_whoreshub_discovery
from .sxyprn_discovery import scrape_sxyprn_listing, fetch_post_streams, enrich_sxyprn_posts
from .leakporner_discovery import scrape_leakporner_discovery
from .cyberleaks_discovery import scrape_cyberleaks_discovery
from .search_engine import ExternalSearchEngine
from .meta_enrichment import get_enrichment_service
from .websockets import manager
import collections
import yt_dlp as _yt_dlp
from .telegram_auth import manager as tg_auth_manager
from pydantic import BaseModel
import collections
from scripts.archivist import Archivist
from .scheduler import init_scheduler, get_scheduler, shutdown_scheduler
from .auto_discovery import run_discovery_profile, get_worker
from .streaming import build_proxy_request_headers, load_proxy_cookies
from .proxy_sessions import SESSIONS as _shared_proxy_sessions, TTL as _shared_proxy_session_ttl
from .cookie_jar import load_cookie_dict, resolve_cookiefile
from .scraper_rate_limiter import DomainRateLimiter
from .url_utils import normalize_url_key
from .playlist_history import playlist_history_dir
from .media_match import MediaFacts, looks_like_same_video
from .url_safety import require_public_http_url
from .intake import (
    IntakeCandidate,
    IntakeImportRequest,
    IntakeSearchRequest,
    cancel_job,
    create_import_job,
    intake_worker,
    retry_job,
    reconcile_job_counts,
    search_intake_candidates,
    serialize_job,
    source_capabilities,
)

THUMBNAIL_CACHE_DIR = Path(__file__).resolve().parent / "static" / "thumbnails_cache"
THUMBNAIL_CACHE_LOCKS: dict[str, asyncio.Lock] = {}
THUMBNAIL_CACHE_LOCKS_GUARD = asyncio.Lock()
THUMBNAIL_CACHE_MAX_BYTES = 25 * 1024 * 1024


async def _thumbnail_cache_lock(key: str) -> asyncio.Lock:
    async with THUMBNAIL_CACHE_LOCKS_GUARD:
        return THUMBNAIL_CACHE_LOCKS.setdefault(key, asyncio.Lock())


def _thumbnail_cache_paths(url: str) -> tuple[Path, Path, str]:
    key = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return (
        THUMBNAIL_CACHE_DIR / f"{key}.thumb",
        THUMBNAIL_CACHE_DIR / f"{key}.content-type",
        key,
    )


async def _thumbnail_media_type(metadata_path: Path) -> str:
    try:
        value = await asyncio.to_thread(metadata_path.read_text, "utf-8")
        return value.strip() if value.startswith("image/") else "image/jpeg"
    except OSError:
        return "image/jpeg"


def _require_public_proxy_url(value: str) -> str:
    try:
        return require_public_http_url(value)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

def _save_quantum_search_history(query: str, results_count: int):
    db = SessionLocal()
    try:
        history_entry = SearchHistory(
            query=(query or "").strip(),
            source="Quantum",
            results_count=max(0, int(results_count or 0)),
        )
        db.add(history_entry)
        db.commit()
    except Exception as ex:
        db.rollback()
        logging.warning("Failed to save search history: %s", ex)
    finally:
        db.close()

# Initialize Archivist
archivist = Archivist(download_dir="app/static/local_videos")

LEGACY_GALLERY_SOURCES = {
    "desktop_04052026": {
        "label": "NexusPokrokWorking_04052026",
        "db_path": r"C:\Users\Peto\Desktop\NexusPokrokWorking_04052026\videos.db",
        "root_dir": r"C:\Users\Peto\Desktop\NexusPokrokWorking_04052026",
    },
    "old_copy": {
        "label": "NexusPokrokWorking – kópia",
        "db_path": r"C:\Users\Peto\Desktop\NexusPokrokWorking – kópia\videos.db",
        "root_dir": r"C:\Users\Peto\Desktop\NexusPokrokWorking – kópia",
    },
}

PLAYBACK_EXPIRABLE_DOMAINS = (
    "vk.com",
    "vk.video",
    "vkvideo.ru",
    "okcdn.ru",
    "bigcdn.cc",
    "mydaddy.cc",
    # Faphouse serves the full video only as a signed HLS playlist (~6 h life),
    # and its watch page is the lineage a refresh has to start from.
    "flixcdn.com",
    "faphouse.com",
    # Turbo.cr signs its CDN link with a short-lived ?exp= token (commonly 2-6h);
    # source_url (the turbo.cr/v/<id> watch page) is what a refresh re-resolves.
    "turbocdn.st",
    "turbo.cr",
    # KVS tokens can be invalidated even while the saved get_file URL looks live;
    # refresh from the stable PimpBunny watch page at playback time.
    "pimpbunny.com",
    "redtube.com",
)


def _text_contains_any(value: str, patterns: tuple[str, ...]) -> bool:
    haystack = (value or "").lower()
    return any(pattern in haystack for pattern in patterns)


# Signed CDN links state their own deadline, so expiry is a fact we can read
# rather than a guess from the hostname. Two shapes cover every signing source
# in use here:
#   Faphouse/flixcdn : https://video-nss.flixcdn.com/<sig>,1788490800/media=hls4/...
#   FileDitch/Turbo  : https://.../file.mp4?exp=1788639823&sig=...
_SIGNED_EXPIRY_PATH_RE = re.compile(r"[,/](\d{10})(?=/)")
_SIGNED_EXPIRY_QUERY_RE = re.compile(r"[?&](?:exp|expires|e)=(\d{10})(?:&|$)")


def signed_link_expiry(url: str) -> Optional[datetime.datetime]:
    """UTC deadline embedded in a signed stream URL, or None if it has none."""
    raw = url or ""
    match = _SIGNED_EXPIRY_QUERY_RE.search(raw) or _SIGNED_EXPIRY_PATH_RE.search(raw)
    if not match:
        return None
    try:
        return datetime.datetime.utcfromtimestamp(int(match.group(1)))
    except (ValueError, OverflowError, OSError):
        return None


def signed_link_is_stale(url: str, grace_minutes: int = 15) -> bool:
    """True once a signed link is past (or within `grace_minutes` of) its deadline.

    The grace window matters for playback: a link with two minutes left starts
    fine and then dies mid-stream, which reads as a broken video rather than an
    expired one. Refreshing it early avoids that.
    """
    deadline = signed_link_expiry(url)
    if deadline is None:
        return False
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(minutes=grace_minutes) >= deadline


def _remote_stream_looks_expirable(url: str, source_url: str) -> bool:
    if signed_link_expiry(url) is not None:
        return True
    return _text_contains_any(url, PLAYBACK_EXPIRABLE_DOMAINS) or _text_contains_any(source_url, PLAYBACK_EXPIRABLE_DOMAINS)


_TURBO_CDN_ID_RE = re.compile(r"turbocdn\.[^/]+/turbo/data/([A-Za-z0-9_-]+)\.", re.IGNORECASE)


def _turbo_page_url_from_cdn(url: str) -> Optional[str]:
    """Reconstruct a canonical https://turbo.cr/v/<id> page URL from a turbocdn media URL."""
    m = _TURBO_CDN_ID_RE.search(url or "")
    if m:
        return f"https://turbo.cr/v/{m.group(1)}"
    return None


def _derive_video_playback_health(video: Any) -> dict[str, str]:
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    storage_type = (getattr(video, "storage_type", "") or "").lower()
    status = (getattr(video, "status", "") or "").lower()
    link_status = (getattr(video, "link_status", "") or "unknown").lower()
    url = (getattr(video, "url", "") or "").strip()
    source_url = (getattr(video, "source_url", "") or "").strip()
    created_at = getattr(video, "created_at", None) or now
    last_checked = getattr(video, "last_checked", None)

    if storage_type in {"local", "local_direct", "bittorrent"} and url:
        return {
            "key": "playable",
            "label": "Ready",
            "tone": "good",
            "reason": "Stored locally or streamed from local infrastructure.",
        }

    if not url or link_status == "broken" or status in {"error", "failed"}:
        return {
            "key": "broken",
            "label": "Broken",
            "tone": "bad",
            "reason": "Video has no valid playback URL or previous playback refresh failed.",
        }

    if link_status == "working":
        return {
            "key": "playable",
            "label": "Ready",
            "tone": "good",
            "reason": "Playback URL was previously confirmed as working.",
        }

    if status in {"pending", "processing"}:
        return {
            "key": "checking",
            "label": "Checking",
            "tone": "info",
            "reason": "Metadata or stream processing is still running.",
        }

    is_expirable = _remote_stream_looks_expirable(url, source_url)
    age_hours = max(0.0, (now - created_at).total_seconds() / 3600.0)
    checked_hours = None if not last_checked else max(0.0, (now - last_checked).total_seconds() / 3600.0)

    if is_expirable and (age_hours >= 24 or checked_hours is None or checked_hours >= 12):
        return {
            "key": "refresh",
            "label": "Refresh",
            "tone": "warn",
            "reason": "This source often expires quickly, so a batch refresh is recommended before playback.",
        }

    return {
        "key": "unknown",
        "label": "Check",
        "tone": "muted",
        "reason": "Playback has not been verified yet, but there is no known failure.",
    }

BITTORRENT_WEB_EXE_PATH = os.getenv(
    "BITTORRENT_WEB_EXE_PATH",
    r"C:\Users\Peto\AppData\Roaming\BitTorrent Web\btweb.exe",
)
BITTORRENT_WEB_UI_PORT = int(os.getenv("BITTORRENT_WEB_UI_PORT", "19575"))
BITTORRENT_WEB_UI_URL = f"http://127.0.0.1:{BITTORRENT_WEB_UI_PORT}/gui/index.html"
BITTORRENT_WEB_RESUME_DB = Path(r"C:\Users\Peto\AppData\Roaming\BitTorrent Web\resume.dat")
BITTORRENT_WEB_SETTINGS_PATH = Path(r"C:\Users\Peto\AppData\Roaming\BitTorrent Web\settings.dat")
BITTORRENT_VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v",
                               ".ts", ".m2ts", ".mts"}
BITTORRENT_MIN_READY_BYTES = 64 * 1024 * 1024
BITTORRENT_GROW_WAIT_SECONDS = 12.0
BITTORRENT_GROW_POLL_SECONDS = 0.35
BITTORRENT_META_MIN_BYTES = 24 * 1024 * 1024
BITTORRENT_THUMB_DIR = Path("app/static/thumbnails/bittorrent")
BITTORRENT_META_CACHE: dict[str, dict[str, Any]] = {}
rate_limiter = DomainRateLimiter(max_concurrent=5)
DISCOVERY_METADATA_SEMAPHORE = asyncio.Semaphore(5)


# --- WINDOWS ASYNCIO FIX ---
# Suppress known asyncio error in _ProactorBaseWritePipeTransport._loop_writing
# "AssertionError: assert f is self._write_fut"
import sys
if sys.platform == 'win32':
    try:
        from asyncio.proactor_events import _ProactorBaseWritePipeTransport
        _original_loop_writing = _ProactorBaseWritePipeTransport._loop_writing
        def _safe_loop_writing(self, *args, **kwargs):
            try:
                return _original_loop_writing(self, *args, **kwargs)
            except AssertionError:
                return None
        _ProactorBaseWritePipeTransport._loop_writing = _safe_loop_writing
    except (ImportError, AttributeError):
        pass
# ---------------------------




http_session = None
thumbnail_http_client = None
# Env reload trigger 3

_PLACEHOLDER_JPG_PATH = os.path.join("app", "static", "placeholder.jpg")
_PLACEHOLDER_JPG_B64 = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBAVFRUVFRUVFRUVFRUVFRUVFRUWFhUV"
    "FRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGxAQGy0lICYtLS0tLS0tLS0t"
    "LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/"
    "xAAXAAEBAQEAAAAAAAAAAAAAAAAAAQID/8QAFhEBAQEAAAAAAAAAAAAAAAAAAQAC/9oADAMBAAIQ"
    "AxAAAAHhAqf/xAAbEAADAQEBAQEAAAAAAAAAAAABAhEDEiExQf/aAAgBAQABBQJrM8qS2g1K8VxP"
    "x//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8BP//EABQRAQAAAAAAAAAAAAAAAAAAABD/"
    "2gAIAQIBAT8BP//EABwQAAICAgMBAAAAAAAAAAAAAAECEQMhMUFREv/aAAgBAQAGPwLQ0bA0XJY7"
    "vT//xAAaEAACAwEBAAAAAAAAAAAAAAABEQAhMUFh/9oACAEBAAE/ITqFpnHzV0p2N1cXv//aAAwD"
    "AQACAAMAAAAQ8//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QP//EABQRAQAAAAAAAAAA"
    "AAAAAAAAABD/2gAIAQIBAT8QP//EABwQAQACAgMBAAAAAAAAAAAAAAERIQAxQVFhcf/aAAgBAQAB"
    "PxBklx6wvLhTjD3l0C4i6msYu//Z"
)


def _ensure_static_placeholder_assets() -> None:
    try:
        placeholder_dir = os.path.dirname(_PLACEHOLDER_JPG_PATH)
        os.makedirs(placeholder_dir, exist_ok=True)
        if not os.path.exists(_PLACEHOLDER_JPG_PATH) or os.path.getsize(_PLACEHOLDER_JPG_PATH) == 0:
            with open(_PLACEHOLDER_JPG_PATH, "wb") as handle:
                handle.write(base64.b64decode(_PLACEHOLDER_JPG_B64))
            logging.info("Created missing static placeholder asset at %s", _PLACEHOLDER_JPG_PATH)
    except Exception as exc:
        logging.warning("Failed to ensure static placeholder asset: %s", exc)


def _bdecode(data: bytes):
    def parse(idx: int):
        token = data[idx:idx + 1]
        if token == b"i":
            end = data.index(b"e", idx)
            return int(data[idx + 1:end]), end + 1
        if token == b"l":
            idx += 1
            out = []
            while data[idx:idx + 1] != b"e":
                item, idx = parse(idx)
                out.append(item)
            return out, idx + 1
        if token == b"d":
            idx += 1
            out = {}
            while data[idx:idx + 1] != b"e":
                key, idx = parse(idx)
                value, idx = parse(idx)
                out[key] = value
            return out, idx + 1
        if token.isdigit():
            colon = data.index(b":", idx)
            size = int(data[idx:colon])
            start = colon + 1
            end = start + size
            return data[start:end], end
        raise ValueError(f"Unsupported bencode token at {idx}: {token!r}")

    value, end = parse(0)
    if end != len(data):
        raise ValueError("Trailing data in bencode payload")
    return value


def _bt_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="ignore")
    return str(value or "")


def _load_bittorrent_settings() -> dict[str, Any]:
    if not BITTORRENT_WEB_SETTINGS_PATH.exists():
        return {}
    try:
        raw = BITTORRENT_WEB_SETTINGS_PATH.read_bytes()
        decoded = _bdecode(raw)
        return { _bt_text(k): v for k, v in decoded.items() } if isinstance(decoded, dict) else {}
    except Exception as exc:
        logging.warning("Failed to parse BitTorrent Web settings.dat: %s", exc)
        return {}


def _normalize_windows_path(path: str) -> str:
    if os.name == "nt" and path.startswith("/") and ":" in path:
        return path[1:]
    return path


def _safe_bittorrent_thumb_relpath(file_path: Path) -> str:
    thumb_name = f"bt_{hashlib.sha1(str(file_path).encode('utf-8', errors='ignore')).hexdigest()[:16]}.jpg"
    return f"/static/thumbnails/bittorrent/{thumb_name}"


def _get_bittorrent_media_meta(file_path: Path, file_size_bytes: int) -> dict[str, Any]:
    if file_size_bytes < BITTORRENT_META_MIN_BYTES or not file_path.exists():
        return {}

    try:
        stat = file_path.stat()
    except OSError:
        return {}

    cache_key = str(file_path).lower()
    signature = (int(stat.st_mtime), int(stat.st_size))
    cached = BITTORRENT_META_CACHE.get(cache_key)
    if cached and cached.get("signature") == signature:
        return dict(cached.get("data") or {})

    meta: dict[str, Any] = {}
    try:
        probe = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height:format=duration",
                "-of", "json",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=12,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if probe.returncode == 0 and probe.stdout.strip():
            payload = json.loads(probe.stdout)
            stream = (payload.get("streams") or [{}])[0]
            width = int(float(stream.get("width") or 0))
            height = int(float(stream.get("height") or 0))
            duration = int(float(payload.get("format", {}).get("duration") or 0))
            if width:
                meta["width"] = width
            if height:
                meta["height"] = height
            if duration:
                meta["duration"] = duration
    except Exception as exc:
        logging.debug("BitTorrent ffprobe failed for %s: %s", file_path, exc)

    try:
        BITTORRENT_THUMB_DIR.mkdir(parents=True, exist_ok=True)
        thumb_rel = _safe_bittorrent_thumb_relpath(file_path)
        thumb_path = Path("app") / thumb_rel.lstrip("/").replace("/", os.sep)
        if not thumb_path.exists():
            capture_offset = "00:00:08"
            if meta.get("duration"):
                capture_secs = max(2, min(int(meta["duration"] * 0.12), 45))
                capture_offset = f"00:00:{capture_secs:02d}" if capture_secs < 60 else time.strftime("%H:%M:%S", time.gmtime(capture_secs))
            thumb = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-ss", capture_offset,
                    "-i", str(file_path),
                    "-frames:v", "1",
                    "-vf", "scale=320:-1",
                    str(thumb_path),
                ],
                capture_output=True,
                text=True,
                timeout=18,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            if thumb.returncode == 0 and thumb_path.exists():
                meta["thumbnail_path"] = thumb_rel
        elif thumb_path.exists():
            meta["thumbnail_path"] = thumb_rel
    except Exception as exc:
        logging.debug("BitTorrent thumbnail generation failed for %s: %s", file_path, exc)

    BITTORRENT_META_CACHE[cache_key] = {
        "signature": signature,
        "data": dict(meta),
    }
    return meta


def _pick_bittorrent_video_path(info: dict[str, Any], save_path: Path) -> Optional[Path]:
    info_dict = info.get("info") if isinstance(info.get("info"), dict) else {}
    torrent_name = _bt_text(info_dict.get(b"name") or info_dict.get("name")).strip()
    files = info_dict.get(b"files") or info_dict.get("files")

    candidates: list[Path] = []
    if isinstance(files, list):
        for file_entry in files:
            if not isinstance(file_entry, dict):
                continue
            path_parts = file_entry.get(b"path") or file_entry.get("path") or []
            parts = [_bt_text(part).strip() for part in path_parts if _bt_text(part).strip()]
            if not parts:
                continue
            suffix = Path(*parts)
            direct_path = save_path / suffix
            nested_path = (save_path / torrent_name / suffix) if torrent_name else direct_path
            for candidate in (direct_path, nested_path):
                if candidate.suffix.lower() in BITTORRENT_VIDEO_EXTENSIONS:
                    candidates.append(candidate)
    elif torrent_name:
        direct_path = save_path / torrent_name
        if direct_path.suffix.lower() in BITTORRENT_VIDEO_EXTENSIONS:
            candidates.append(direct_path)

    for candidate in candidates:
        if candidate.exists():
            return candidate

    search_roots = []
    if torrent_name:
        search_roots.extend([save_path / torrent_name, save_path])
    else:
        search_roots.append(save_path)

    seen = set()
    for root in search_roots:
        if not root.exists():
            continue
        root_key = str(root).lower()
        if root_key in seen:
            continue
        seen.add(root_key)
        if root.is_file() and root.suffix.lower() in BITTORRENT_VIDEO_EXTENSIONS:
            return root
        if root.is_dir():
            matches = [p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in BITTORRENT_VIDEO_EXTENSIONS]
            if matches:
                matches.sort(key=lambda p: p.stat().st_size, reverse=True)
                return matches[0]
    return None


def _extract_bittorrent_items(limit: int = 50) -> list[dict[str, Any]]:
    settings = _load_bittorrent_settings()
    default_save_path = _bt_text(settings.get("save_path", "")).strip() or r"E:\mega aug"
    if not BITTORRENT_WEB_RESUME_DB.exists():
        return []

    items: list[dict[str, Any]] = []
    conn = _sqlite3.connect(str(BITTORRENT_WEB_RESUME_DB))
    try:
        rows = conn.execute(
            "SELECT INFOHASH, RESUME, COALESCE(SAVE_PATH, '') AS SAVE_PATH FROM TORRENTS ORDER BY rowid DESC"
        ).fetchall()
    finally:
        conn.close()

    for infohash, resume_blob, row_save_path in rows[:limit]:
        save_path_str = (row_save_path or default_save_path or "").strip()
        if not save_path_str:
            continue
        save_path = Path(save_path_str)
        item: dict[str, Any] = {
            "infohash": infohash,
            "save_path": save_path_str,
            "title": "",
            "progress": 0.0,
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "sequential_download": False,
            "path": None,
            "playable": False,
            "stream_ready": False,
            "status": "downloading",
            "storage_type": "bittorrent",
            "source": "BitTorrent Web",
            "thumbnail_path": "/static/placeholder.jpg",
        }

        parsed_resume: dict[str, Any] = {}
        if isinstance(resume_blob, str):
            item["title"] = resume_blob
        else:
            try:
                raw = bytes(resume_blob)
                decoded = _bdecode(raw)
                if isinstance(decoded, dict):
                    parsed_resume = { _bt_text(k): v for k, v in decoded.items() }
            except Exception as exc:
                logging.warning("Failed to parse BitTorrent resume blob for %s: %s", infohash, exc)

            info_dict = parsed_resume.get("info") if isinstance(parsed_resume.get("info"), dict) else {}
            if isinstance(info_dict, dict):
                info_dict = { _bt_text(k): v for k, v in info_dict.items() }
            torrent_name = _bt_text(info_dict.get("name")).strip()
            item["title"] = torrent_name or item["title"] or infohash
            item["downloaded_bytes"] = int(parsed_resume.get("total_downloaded") or 0)
            item["sequential_download"] = bool(int(parsed_resume.get("sequential_download") or 0))
            if "length" in info_dict:
                item["total_bytes"] = int(info_dict.get("length") or 0)
            elif isinstance(info_dict.get("files"), list):
                item["total_bytes"] = sum(
                    int(file_entry.get("length") or 0)
                    for file_entry in info_dict["files"]
                    if isinstance(file_entry, dict)
                )

            resolved_path = _pick_bittorrent_video_path({"info": info_dict}, save_path)
            if resolved_path:
                item["path"] = str(resolved_path)
                try:
                    item["file_size_bytes"] = resolved_path.stat().st_size
                except OSError:
                    item["file_size_bytes"] = 0
                item["playable"] = True
                media_meta = _get_bittorrent_media_meta(resolved_path, int(item["file_size_bytes"] or 0))
                if media_meta:
                    item.update(media_meta)

        if not item["title"]:
            item["title"] = infohash

        total_bytes = int(item.get("total_bytes") or 0)
        downloaded_bytes = int(item.get("downloaded_bytes") or 0)
        file_size_bytes = int(item.get("file_size_bytes") or 0)
        if total_bytes > 0:
            item["progress"] = round(min(100.0, (downloaded_bytes / total_bytes) * 100.0), 2)
        elif item["playable"]:
            item["progress"] = 100.0

        ready_threshold = BITTORRENT_MIN_READY_BYTES
        if total_bytes > 0:
            ready_threshold = min(BITTORRENT_MIN_READY_BYTES, max(16 * 1024 * 1024, int(total_bytes * 0.03)))
        item["stream_ready"] = bool(item["playable"] and (file_size_bytes >= ready_threshold or item["progress"] >= 15.0))
        if item["playable"] and item["progress"] >= 99.5:
            item["status"] = "ready"
        elif item["stream_ready"]:
            item["status"] = "ready_to_stream"
        elif item["playable"]:
            item["status"] = "buffering"
        else:
            item["status"] = "downloading"
        item["thumbnail_path"] = item.get("thumbnail_path") or "/static/placeholder.jpg"
        items.append(item)

    return items


def _stream_file_response(file_path: str, request: Request, *, allow_growing: bool = False):
    from fastapi.responses import StreamingResponse

    normalized_path = _normalize_windows_path(file_path)
    if not os.path.exists(normalized_path):
        raise HTTPException(status_code=404, detail="Source file not found")

    def current_file_size() -> int:
        return os.path.getsize(normalized_path)

    def wait_for_size(min_size: int, timeout: float = BITTORRENT_GROW_WAIT_SECONDS) -> int:
        deadline = time.time() + timeout
        latest = current_file_size()
        while latest < min_size and time.time() < deadline:
            time.sleep(BITTORRENT_GROW_POLL_SECONDS)
            latest = current_file_size()
        return latest

    file_size = current_file_size()
    mime_type, _ = mimetypes.guess_type(normalized_path)
    mime_type = mime_type or "video/mp4"
    range_header = request.headers.get("range")

    if range_header:
        range_match = range_header.replace("bytes=", "").split("-")
        start = int(range_match[0]) if range_match[0] else 0
        if allow_growing and start >= file_size:
            file_size = wait_for_size(start + 1)
        end = int(range_match[1]) if len(range_match) > 1 and range_match[1] else file_size - 1
        if allow_growing and end >= file_size:
            target_end = min(end, start + (8 * 1024 * 1024) - 1)
            file_size = wait_for_size(target_end + 1, timeout=4.0)
        start = max(0, start)
        end = min(file_size - 1, end)
        if end < start:
            raise HTTPException(status_code=416, detail="Requested range not yet available")
        content_length = max(0, end - start + 1)

        def iterfile():
            with open(normalized_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = f.read(min(1024 * 1024, remaining))
                    if not chunk:
                        if allow_growing and wait_for_size(f.tell() + 1, timeout=3.0) > f.tell():
                            continue
                        break
                    remaining -= len(chunk)
                    yield chunk

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(content_length),
        }
        return StreamingResponse(iterfile(), status_code=206, media_type=mime_type, headers=headers)

    def iterfile():
        with open(normalized_path, "rb") as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    if allow_growing and wait_for_size(f.tell() + 1, timeout=3.0) > f.tell():
                        continue
                    break
                yield chunk

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(file_size),
    }
    return StreamingResponse(iterfile(), media_type=mime_type, headers=headers)


def _is_local_port_open(host: str, port: int, timeout: float = 0.35) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _get_bittorrent_web_status() -> dict[str, Any]:
    installed = os.path.exists(BITTORRENT_WEB_EXE_PATH)
    ui_reachable = _is_local_port_open("127.0.0.1", BITTORRENT_WEB_UI_PORT)
    settings = _load_bittorrent_settings()
    save_path = _bt_text(settings.get("save_path", "")).strip() or r"E:\mega aug"
    return {
        "installed": installed,
        "running": ui_reachable,
        "ui_reachable": ui_reachable,
        "exe_path": BITTORRENT_WEB_EXE_PATH if installed else None,
        "ui_url": BITTORRENT_WEB_UI_URL,
        "ui_port": BITTORRENT_WEB_UI_PORT,
        "save_path": save_path,
    }


def _launch_bittorrent_web() -> dict[str, Any]:
    if not os.path.exists(BITTORRENT_WEB_EXE_PATH):
        raise FileNotFoundError(BITTORRENT_WEB_EXE_PATH)

    if os.name == "nt":
        os.startfile(BITTORRENT_WEB_EXE_PATH)
    else:
        subprocess.Popen([BITTORRENT_WEB_EXE_PATH], cwd=os.path.dirname(BITTORRENT_WEB_EXE_PATH))

    return _get_bittorrent_web_status()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_session, thumbnail_http_client
    from .events import bus
    bus.set_loop(asyncio.get_running_loop())
    tor_monitor_task = None
    tor_monitor_stop = asyncio.Event()

    # --- MANAGED TOR ---
    # EPORNER_USE_TOR installations start their local Tor instance together with
    # Nexus. This runs before background workers so no scraper can accidentally
    # begin while the configured SOCKS proxy is still offline.
    try:
        from .tor_service import tor_service
        if tor_service.auto_start:
            tor_state = await asyncio.to_thread(tor_service.start)
            if tor_state.get("ready"):
                print(f"Managed Tor ready on {tor_state.get('socks')}.")
            else:
                print(f"WARNING: managed Tor is not ready: {tor_state.get('last_error') or 'unknown error'}")

            async def _monitor_managed_tor():
                """Recover a crashed/offline managed Tor without user action."""
                while not tor_monitor_stop.is_set():
                    try:
                        await asyncio.wait_for(tor_monitor_stop.wait(), timeout=20.0)
                        continue
                    except asyncio.TimeoutError:
                        pass
                    state = await asyncio.to_thread(tor_service.status)
                    if not state.get("ready"):
                        recovered = await asyncio.to_thread(tor_service.start)
                        if recovered.get("ready"):
                            logging.info("Managed Tor recovered automatically")
                        else:
                            logging.warning(
                                "Managed Tor recovery failed: %s",
                                recovered.get("last_error") or "unknown error",
                            )

            tor_monitor_task = asyncio.create_task(_monitor_managed_tor())
    except Exception as e:
        print(f"WARNING: managed Tor startup failed: {e}")

    # --- THREAD POOL SIZING ---
    # Sync `def` endpoints (Depends(get_db)) AND asyncio.to_thread(...) scraping
    # calls all share anyio's default thread limiter (default: 40 tokens). Long
    # scraping/discovery jobs used to saturate it, and once every worker was
    # blocked the server stopped answering even /health. Raise the ceiling and
    # keep it >= DB pool capacity so a DB checkout never has to wait behind a
    # scraper for a thread. Tunable via THREAD_POOL_LIMIT.
    try:
        import anyio
        from anyio import to_thread as _anyio_to_thread
        _pool_capacity = config.DB_POOL_SIZE + config.DB_MAX_OVERFLOW
        _thread_limit = int(os.getenv("THREAD_POOL_LIMIT", str(max(120, _pool_capacity + 40))))
        _anyio_to_thread.current_default_thread_limiter().total_tokens = _thread_limit
        print(f"Thread pool limiter set to {_thread_limit} tokens.")
    except Exception as _e:
        print(f"WARNING: could not raise thread pool limiter: {_e}")

    _ensure_static_placeholder_assets()
    # Use system ThreadedResolver on Windows to avoid aiodns/pycares DNS timeouts
    # in the uvicorn event loop; fall back to default connector otherwise.
    try:
        resolver = aiohttp.ThreadedResolver()
        connector = aiohttp.TCPConnector(limit=200, limit_per_host=50, keepalive_timeout=60, resolver=resolver)
    except Exception:
        connector = aiohttp.TCPConnector(limit=200, limit_per_host=50, keepalive_timeout=60)
    timeout = aiohttp.ClientTimeout(total=None, connect=60, sock_read=600)
    http_session = aiohttp.ClientSession(connector=connector, timeout=timeout)
    thumbnail_http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(10.0, connect=5.0),
        follow_redirects=True,
        limits=httpx.Limits(
            max_connections=100,
            max_keepalive_connections=30,
            keepalive_expiry=60.0,
        ),
    )
    print("AIOHTTP ClientSession created with increased limits.")
    
    # --- CLEANUP STUCK TASKS ON STARTUP ---
    try:
        db = SessionLocal()
        stuck_videos = db.query(Video).filter(or_(Video.status == 'processing', Video.status == 'downloading')).all()
        if stuck_videos:
            print(f"Startup: Resetting {len(stuck_videos)} stuck videos to 'error' state.")
            for v in stuck_videos:
                v.status = 'error' # Or 'ready' if we want to be optimistic, but 'error' prompts retry
            db.commit()
        db.close()
    except Exception as e:
        print(f"Startup cleanup error: {e}")
        
    # --- FIX COOMERFANS CDN VIDEOS (set cdn_direct so browser plays directly) ---
    try:
        db = SessionLocal()
        cf_updated = db.query(Video).filter(
            Video.url.like('%img%.coomerfans.com/%'),
            Video.storage_type == 'remote',
        ).update({"storage_type": "cdn_direct"}, synchronize_session=False)
        if cf_updated:
            db.commit()
            print(f"Startup: Marked {cf_updated} Coomerfans CDN videos as cdn_direct.")
        db.close()
    except Exception as e:
        print(f"Startup coomerfans fix error: {e}")

    # --- STARTUP LINK REFRESH (Always Live) ---
    async def refresh_video_link(video_id: int):
        """Refreshes the URL for a single video."""
        db = SessionLocal()
        try:
            v = db.query(Video).filter(Video.id == video_id).first()
            if not v or not v.source_url or v.storage_type != 'remote':
                return
            from .telegram_service import is_telegram_library_video
            if is_telegram_library_video(v):
                return

            # Basic check if link is responsive
            try:
                headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}
                async with http_session.head(v.url, timeout=5, headers=headers, ssl=False) as r:
                    if r.status < 400:
                        v.last_checked = datetime.datetime.now()
                        db.commit()
                        return # Link is still good
            except Exception:
                pass # Link is not responsive, proceed to refresh

            print(f"Refreshing: {v.title} (ID: {v.id})")
            
            # --- ATTEMPT HEALING VIA CUSTOM EXTRACTORS ---
            try:
                from .extractors import init_registry, register_extended_extractors
                from .extractors.registry import ExtractorRegistry
                init_registry()
                register_extended_extractors()

                lookup_target = v.source_url or v.url
                plugin = ExtractorRegistry.find_extractor(lookup_target)
                if not plugin:
                    turbo_page = _turbo_page_url_from_cdn(v.url or "")
                    if turbo_page:
                        lookup_target = turbo_page
                        plugin = ExtractorRegistry.find_extractor(lookup_target)
                if plugin:
                    print(f"Using plugin {plugin.name} to heal {v.id}")
                    res = await plugin.extract(lookup_target)
                    if res and res.get('stream_url'):
                        v.url = res['stream_url']
                        v.last_checked = datetime.datetime.now()
                        db.commit()
                        print(f"Successfully healed via plugin {plugin.name}: {v.title}")
                        return
            except Exception as pe:
                print(f"Plugin healing failed for {v.id}: {pe}")

            # --- FALLBACK TO YT-DLP ---
            try:
                user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                opts = {
                    'quiet': True, 'skip_download': True, 'format': 'best', 
                    'user_agent': user_agent,
                    'ignoreerrors': True,
                    'no_warnings': True,
                    'http_headers': {
                        'User-Agent': user_agent,
                        'Referer': v.source_url or "https://www.google.com/"
                    }
                }
                
                # Apply domain-specific cookies
                src_url = (v.source_url or "").lower()
                if "xvideos.com" in src_url and os.path.exists("xvideos.cookies.txt"):
                    opts['cookiefile'] = 'xvideos.cookies.txt'
                elif "eporner.com" in src_url and os.path.exists("eporner.cookies.txt"):
                    opts['cookiefile'] = 'eporner.cookies.txt'
                
                def get_info():
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        return ydl.extract_info(v.source_url or v.url, download=False)
                info = await asyncio.to_thread(get_info)
                if info and info.get('url'):
                    v.url = info['url']
                    v.last_checked = datetime.datetime.now()
                    db.commit()
                    print(f"Successfully refreshed via yt-dlp: {v.title}")
                else:
                    print(f"Could not get new URL for {v.title}")
            except Exception as e:
                db.rollback()
                print(f"Error refreshing {v.title}: {e}")
        except Exception as e:
            if "has been deleted" not in str(e):
                print(f"Error in refresh_video_link for video {video_id}: {e}")
        finally:
            db.close()

    async def refresh_links_task():
        """A background task that refreshes older links on startup to ensure they work."""
        await asyncio.sleep(5)  # Wait for full startup
        print("Startup: Link refresher started.")
        try:
            db_query = SessionLocal()
            # Get IDs of 100 oldest videos
            video_ids = [v[0] for v in db_query.query(Video.id).order_by(Video.last_checked.asc().nullsfirst()).limit(100).all()]
            db_query.close()
            
            if not video_ids:
                return

            print(f"Startup: Refreshing {len(video_ids)} oldest links...")
            for vid in video_ids:
                try:
                    await refresh_video_link(vid)
                    await asyncio.sleep(0.5) # Slight throttle
                except Exception as e:
                    if "has been deleted" not in str(e):
                        print(f"Error refreshing video {vid}: {e}")
            
            print("Startup: Link refresher finished.")
        except Exception as e:
            print(f"Link refresher loop error: {e}")

    # Disabled to speed up startup - can be manually triggered if needed
    # asyncio.create_task(refresh_links_task())
        
    # --- START WEBSOCKET PULSE ---
    async def pulse_task():
        while True:
            await asyncio.sleep(30)
            await manager.pulse()
    
    asyncio.create_task(pulse_task())
    
    # --- START WAL CHECKPOINT TASK ---
    async def wal_checkpoint_task():
        """Periodically checkpoint WAL to prevent unlimited growth"""
        from .db_maintenance import checkpoint_wal
        await asyncio.sleep(300)  # Wait 5 minutes after startup
        while True:
            try:
                await checkpoint_wal()
            except Exception as e:
                print(f"WAL checkpoint error: {e}")
            await asyncio.sleep(3600)  # Run every hour
    
    asyncio.create_task(wal_checkpoint_task())

    # --- CONFIGURE GOFILE TOKEN ---
    gofile_token = config.GOFILE_TOKEN
    if gofile_token:
        try:
            from app.extractors.gofile import GoFileExtractor
            GoFileExtractor.set_user_token(gofile_token)
            print(f"GoFile user token configured (length: {len(gofile_token)})")
        except Exception as e:
            print(f"Failed to configure GoFile token: {e}")

    # --- INITIALIZE TASK SCHEDULER ---
    try:
        from .extractors import register_extended_extractors
        register_extended_extractors()
        scheduler = init_scheduler()
        print("Task scheduler and all extractors initialized")

        # Repair preview quality continuously in bounded chunks.  The job is
        # intentionally a minimum batch of 100, starts once after boot, then
        # runs every 10 minutes.  Its reservation prevents overlap with the
        # manual Smart Rethumb controls.
        from app.maintenance import auto_smart_rethumb_tick
        scheduler.add_interval_job(
            auto_smart_rethumb_tick,
            job_id="auto_smart_rethumb",
            seconds=10 * 60,
            kwargs={"limit": 100},
            start_now=True,
            description="Auto Smart Rethumb: 100 slabých náhľadov / 10 min",
        )
        print("Auto Smart Rethumb scheduled (100 thumbnails every 10 minutes)")

        # --- MEGA Autopilot: seed/resolve/verify/add do Hubu na pozadí (zapína sa v QS) ---
        try:
            from .mega_autopilot import autopilot_tick as _mega_autopilot_tick
            scheduler.add_interval_job(
                _mega_autopilot_tick, job_id="mega_autopilot", seconds=120,
                description="MEGA Autopilot: Telegram linky -> overenie -> MEGA Hub",
                start_now=False)
        except Exception as e:
            print(f"MEGA Autopilot scheduling error: {e}")
        # --- NEXUS INTEL background jobs ---
        try:
            from . import nexus_intel as _intel
            from . import semantic_search as _sem

            async def _sentinel_job():
                res = await _intel.sentinel_scan(limit=40, mirror=True)
                if res.get("dead"):
                    print(f"[intel] sentinel: {res['dead']} dead, "
                          f"{res['mirrored']} mirrored / {res['checked']} checked")

            async def _reindex_job():
                import asyncio as _a
                await _a.to_thread(_sem.build_index, False)

            # link-rot sentinel + auto-mirror every 6h (saved/favorited only)
            scheduler.add_interval_job(
                _sentinel_job, job_id="intel_sentinel", seconds=6 * 3600,
                description="Link-rot sentinel + auto-mirror")
            # incremental semantic (re)index every hour. NOT start_now: running a
            # full-library embed the instant the server boots used to spike CPU
            # and race the request path on the (CUDA) model, wedging the server.
            # The first run fires one interval in; embeds are incremental anyway
            # (only un-indexed videos), so the short delay costs nothing.
            scheduler.add_interval_job(
                _reindex_job, job_id="intel_reindex", seconds=3600,
                description="Semantic library reindex", start_now=False)

            # B2: gently warm related for FAVORITES only, throttled, and never on
            # boot — the on-demand disk cache already makes re-opens instant, so
            # this just pre-warms a small set the user actually revisits without
            # hammering external sites in the background.
            from .related_recommendations import precompute_related as _precompute_related
            from . import visual_semantic_index as _vsi

            # Okamžite načítame existujúce GPU embeddingy z DB do RAM (<50ms)
            try:
                _vsi.load_index_from_db()
            except Exception:
                pass

            async def _related_precompute_job():
                await _precompute_related(limit_videos=10, per_video_limit=48,
                                          favorites_only=True, throttle_sec=12)

            async def _visual_index_sync_job():
                if _vsi.is_gpu_ready():
                    await asyncio.to_thread(_vsi.sync_library_embeddings, limit=0, batch_size=64)

            scheduler.add_interval_job(
                _related_precompute_job, job_id="related_precompute", seconds=6 * 3600,
                description="Precompute related for favorites (throttled)")
            scheduler.add_interval_job(
                _visual_index_sync_job, job_id="visual_index_sync", seconds=1800,
                description="Inkrementálny GPU SigLIP2 index knižnice", start_now=False)
            print("Nexus Intel jobs scheduled (sentinel 6h, reindex 1h, related 6h/favorites)")
        except Exception as e:
            print(f"Nexus Intel job scheduling error: {e}")

        # Studio auto-highlight: propose moments for un-scanned long local files.
        # Nightly rather than on an interval — it runs ffmpeg scene detection back
        # to back and has no business competing with playback during the day.
        try:
            from .studio_auto import nightly_job as _studio_autoscan
            scheduler.add_cron_job(
                _studio_autoscan, job_id="studio_autoscan",
                cron_expression="20 3 * * *",
                description="Studio: navrhni momenty z nenakrájaných videí")
            print("Studio autoscan scheduled (daily 03:20 UTC)")
        except Exception as e:
            print(f"Studio autoscan scheduling error: {e}")

        # Load and schedule all enabled discovery profiles
        db = SessionLocal()
        try:
            enabled_profiles = db.query(DiscoveryProfile).filter(DiscoveryProfile.enabled == True).all()
            for profile in enabled_profiles:
                try:
                    if profile.schedule_type == "interval":
                        interval_seconds = int(profile.schedule_value)
                        scheduler.add_interval_job(
                            run_discovery_profile,
                            job_id=f"profile_{profile.id}",
                            seconds=interval_seconds,
                            description=f"Discovery: {profile.name}",
                            args=(profile.id,)
                        )
                        print(f"Scheduled profile '{profile.name}' (every {interval_seconds}s)")
                    elif profile.schedule_type == "cron":
                        scheduler.add_cron_job(
                            run_discovery_profile,
                            job_id=f"profile_{profile.id}",
                            cron_expression=profile.schedule_value,
                            description=f"Discovery: {profile.name}",
                            args=(profile.id,)
                        )
                        print(f"Scheduled profile '{profile.name}' (cron: {profile.schedule_value})")
                except Exception as e:
                    print(f"Failed to schedule profile '{profile.name}': {e}")
        finally:
            db.close()
    except Exception as e:
        print(f"Scheduler initialization error: {e}")

    try:
        intake_worker.recover_interrupted()
        intake_worker.start()
        print("Nexus Intake persistent worker started")
    except Exception as e:
        print(f"Nexus Intake worker startup error: {e}")

    # --- RECOVER ORPHANED 'pending' VIDEOS ---
    # Restore interrupted bulk work without blocking startup. Persistent intake
    # items are owned by their separate worker and must not be claimed here.
    async def _recover_orphaned_pending():
        try:
            from .database import ImportJobItem
            db = SessionLocal()
            try:
                # Persistent intake owns its own recovery. Exclude its active
                # items so this startup sweep cannot race the intake worker.
                owned = (db.query(ImportJobItem.video_id)
                    .join(ImportJob, ImportJob.id == ImportJobItem.job_id)
                    .filter(ImportJob.status.in_(["queued", "running"]))
                    .filter(ImportJobItem.status.in_(["pending", "pending_retry", "running"]))
                    .filter(ImportJobItem.video_id.isnot(None)))
                rows = (
                    db.query(Video.id)
                    .filter(or_(
                        Video.status.in_(["pending", "processing"]),
                        and_(Video.status == "error",
                             Video.error_msg == "Deferred after restart; retry manually from the dashboard.",
                             Video.created_at >= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) - datetime.timedelta(hours=24)),
                    ))
                    .filter(~Video.id.in_(owned))
                    .all()
                )
                vid_ids = [r[0] for r in rows]
            finally:
                db.close()
            if not vid_ids:
                return
            if not getattr(config, "AUTO_RECOVER_PENDING_VIDEOS", False):
                db = SessionLocal()
                try:
                    db.query(Video).filter(Video.id.in_(vid_ids), Video.status.in_(["pending", "processing"])).update(
                        {
                            "status": "error",
                            "error_msg": "Processing interrupted by server restart; retry manually from the dashboard.",
                        },
                        synchronize_session=False,
                    )
                    db.commit()
                finally:
                    db.close()
                logging.warning(
                    "[PendingRecovery] marked %s old pending video(s) as retryable errors; automatic recovery is disabled",
                    len(vid_ids),
                )
                return
            logging.info("[PendingRecovery] resuming %s interrupted videos", len(vid_ids))
            # The batch processor limits concurrency and applies a per-item
            # deadline, so recovery cannot hold up startup or stall forever.
            asyncio.create_task(
                VIPVideoProcessor().process_batch(vid_ids),
                name="nexus-pending-recovery",
            )
        except Exception as e:
            logging.warning(f"[PendingRecovery] startup recovery error: {e}")
    try:
        await _recover_orphaned_pending()
    except Exception as e:
        print(f"Pending video recovery error: {e}")

    from .routers.fetch_jobs import runtime as fetch_runtime
    await fetch_runtime.start()
    from .telegram_catalog import worker as telegram_catalog_worker
    await telegram_catalog_worker.start()
    from .telegram_discovery import worker as telegram_discovery_worker
    await telegram_discovery_worker.start()
    from .download_manager import DownloadManagerError, download_manager
    try:
        await download_manager.ensure_started()
    except DownloadManagerError as exc:
        logging.warning("aria2 download manager could not start: %s", exc)
    yield

    # --- SHUTDOWN ---
    await download_manager.close()
    await telegram_catalog_worker.stop()
    await telegram_discovery_worker.stop()
    from .discovery_hub_runtime import close_hub_runtime
    await close_hub_runtime()
    await fetch_runtime.stop()
    from .ntc import ntc
    await ntc.close()
    try:
        await intake_worker.stop()
        print("Nexus Intake worker stopped")
    except Exception as e:
        print(f"Nexus Intake worker shutdown error: {e}")

    try:
        shutdown_scheduler(wait=True)
        print("Task scheduler shutdown")
    except Exception as e:
        print(f"Scheduler shutdown error: {e}")

    if http_session:
        await http_session.close()
        print("AIOHTTP ClientSession closed.")
    if thumbnail_http_client:
        await thumbnail_http_client.aclose()
        print("Thumbnail HTTP client closed.")

    try:
        from .tor_service import tor_service
        tor_monitor_stop.set()
        if tor_monitor_task:
            await tor_monitor_task
        await asyncio.to_thread(tor_service.shutdown)
        print("Managed Tor shutdown complete.")
    except Exception as e:
        print(f"Managed Tor shutdown error: {e}")

app = FastAPI(title="Quantum VIP Dashboard", lifespan=lifespan)
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=500)
init_db()

from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse as _JSONResponse

@app.exception_handler(RequestValidationError)
async def _validation_error_handler(request: Request, exc: RequestValidationError):
    try:
        body = await request.body()
        body_str = body.decode("utf-8", errors="replace")[:2000]
    except Exception:
        body_str = "<unreadable>"
    logging.error("[422] %s %s — errors: %s — body: %s", request.method, request.url.path, exc.errors(), body_str)
    return _JSONResponse(status_code=422, content={"detail": exc.errors(), "body_preview": body_str[:400]})

# --- API ROUTING MODULARIZATION ---
api_v1_router = APIRouter(prefix="/api/v1")
api_legacy_router = APIRouter(prefix="/api")
from .routers.playback import router as _playback_router
api_v1_router.include_router(_playback_router)
from .routers import system_stats as _routes_system_stats
api_v1_router.include_router(_routes_system_stats.router)
api_legacy_router.include_router(_routes_system_stats.router)
app.include_router(_routes_system_stats.router)

from .routers import duplicates as _routes_duplicates
from .routers import library_health as _routes_library_health
from .routers import card_availability as _routes_card_availability
from .routers import maintenance_endpoints as _routes_maintenance
from .routers import smart_playlists as _routes_smart_playlists
from .routers import source_boards as _routes_source_boards
from .routers import discovery_profiles as _routes_discovery_profiles
from .routers import related as _routes_related
from .routers import tnaflix_cache as _routes_tnaflix_cache
from .routers import mega as _routes_mega
from .routers import mega_hub as _routes_mega_hub
from .routers import pornhub_hub as _routes_pornhub_hub
from .routers import nexus_intel as _routes_nexus_intel
from .routers import hub as _routes_hub
from .routers import studio as _routes_studio
from .routers import ts_playback as _routes_ts_playback
from .routers import faphouse as _routes_faphouse
from .routers import quality_hunt as _routes_quality_hunt
from .routers import local_ai as _routes_local_ai
from .routers import omega_search as _routes_omega_search

for _r in (
    _routes_duplicates.router,
    _routes_maintenance.router,
    _routes_library_health.router,
    _routes_card_availability.router,
    _routes_smart_playlists.router,
    _routes_source_boards.router,
    _routes_discovery_profiles.router,
    _routes_related.router,
    _routes_tnaflix_cache.router,
    _routes_mega.router,
    _routes_mega_hub.router,
    _routes_pornhub_hub.router,
    _routes_hub.router,
    _routes_nexus_intel.router,
    _routes_studio.router,
    _routes_ts_playback.router,
    _routes_faphouse.router,
    _routes_quality_hunt.router,
    _routes_local_ai.router,
    _routes_omega_search.router,
):
    api_v1_router.include_router(_r)
    api_legacy_router.include_router(_r)

from .routers import vk as _routes_vk
app.include_router(_routes_vk.router)

from .routers import telegram as _routes_telegram
api_v1_router.include_router(_routes_telegram.router)
api_legacy_router.include_router(_routes_telegram.router)

from .auth import check_auth
from .routers.fetch_jobs import router as fetch_jobs_router
app.include_router(fetch_jobs_router)

from .routers.discovery_ai import router as discovery_ai_router
app.include_router(discovery_ai_router)

from .routers.combined_history import router as combined_history_router
app.include_router(combined_history_router)

from .routers.bulk_import import router as _routes_bulk_import
app.include_router(_routes_bulk_import)

from .routers.downloads import router as _routes_downloads
app.include_router(_routes_downloads)

from .routers import system_health as _routes_system_health
app.include_router(_routes_system_health.router)

from .routers import pages as _routes_pages
app.include_router(_routes_pages.router)

from .routers import radar as _routes_radar
app.include_router(_routes_radar.router)

from .routers import link_tester as _routes_link_tester
app.include_router(_routes_link_tester.router)

from .routers import forum_hub as _routes_forum_hub
app.include_router(_routes_forum_hub.router)

from .routers.extension_bridge import router as _routes_extension_bridge
app.include_router(_routes_extension_bridge)

from .routers import extractor_health as _routes_extractor_health
app.include_router(_routes_extractor_health.router)

from .routers import bittorrent_web as _routes_bittorrent_web
app.include_router(_routes_bittorrent_web.router)

from .routers import torrent as _routes_torrent
app.include_router(_routes_torrent.router)

from .routers import google_search as _routes_google_search
app.include_router(_routes_google_search.router)

from .routers import playlist_probe as _routes_playlist_probe
app.include_router(_routes_playlist_probe.router)

from app.routes.checker_routes import router as checker_routes_router
app.include_router(checker_routes_router)

from .routers import vault as _routes_vault
app.include_router(_routes_vault.router)

from .routers import creator_radar as _routes_creator_radar
app.include_router(_routes_creator_radar.router)

# --- Webshare Search Model ---
class WebshareSearchRequest(BaseModel):
    query: str
    limit: int = 20
    sort: str = "recent"
    min_size: Optional[int] = None
    max_size: Optional[int] = None
    offset: int = 0

@api_v1_router.post("/webshare/search")
@api_legacy_router.post("/webshare/search")
async def search_webshare(req: WebshareSearchRequest, auth: bool = Depends(check_auth)):
    """
    Search Webshare for files and return results sorted by quality (size).
    """
    try:
        from app.extractors.legacy.webshare import WebshareAPI
        # We can eventually load token from .env or DB settings if we want protected files
        ws = WebshareAPI(token=None) 
        
        # Run synchronous request in thread pool
        # Pass sort parameter to search_files
        search_resp = await asyncio.to_thread(ws.search_files, req.query, req.limit, req.sort, req.offset)
        
        results = search_resp.get('results', [])
        total_count = search_resp.get('total', 0)
        
        # Filter results by size if requested
        if req.min_size or req.max_size:
            filtered = []
            for r in results:
                size = r.get('size_bytes', 0)
                if req.min_size and size < req.min_size: continue
                if req.max_size and size > req.max_size: continue
                filtered.append(r)
            results = filtered
            
        return {"status": "success", "results": results, "total": total_count}
    except Exception as e:
        print(f"Webshare API endpoint error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


class VkMetaBatchRequest(BaseModel):
    urls: List[str]


class LegacyGalleryImportRequest(BaseModel):
    source_key: str = "desktop_04052026"
    limit: int = 100
    batch_name: str = "Old Gallery"


def _resolve_legacy_source(source_key: str) -> dict:
    resolved_key = (source_key or "desktop_04052026").strip()
    source = LEGACY_GALLERY_SOURCES.get(resolved_key)
    if not source:
        raise HTTPException(status_code=400, detail=f"Unknown legacy source: {resolved_key}")
    return source

@api_v1_router.post("/meta/vk")
@api_legacy_router.post("/meta/vk")
async def vk_meta_batch(req: VkMetaBatchRequest, x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    """
    Fast VK metadata batch endpoint.
    Accepts up to 20 VK video URLs, calls yt-dlp with cookies and returns
    title/duration/height/width/thumbnail/size_bytes for each URL.
    """
    # Inline token check (ensure_bridge_token is defined later in this file)
    _required_token = getattr(config, 'NEXUS_BRIDGE_TOKEN', None) or ''
    if _required_token and (not x_nexus_token or x_nexus_token.strip() != _required_token):
        raise HTTPException(status_code=401, detail='Invalid bridge token')

    # yt-dlp import moved to top for speed

    # Locate best available cookies file
    _COOKIE_CANDIDATES = [
        "vkvideo.ru_cookies.txt",
        "vk.com_cookies.txt",
        "vk.netscape.txt",
        "vkvideos.ru_cookies.txt",
        os.path.join("app", "vkvideo.ru_cookies.txt"),
        os.path.join("app", "vk.com_cookies.txt"),
        os.path.join("app", "vk.netscape.txt"),
        os.path.join("app", "vkvideos.ru_cookies.txt"),
        os.path.join("app", "cookies.netscape.txt"),
    ]
    _cookie_file = next((p for p in _COOKIE_CANDIDATES if os.path.exists(p)), None)
    
    # Dynamically create vk.com and vkvideos.ru cookies if missing
    if _cookie_file:
        try:
            with open(_cookie_file, "r", encoding="utf-8") as _src:
                _content = _src.read()
            
            # If vkvideo.ru cookie is base, duplicate for others
            if "vkvideo.ru" in _cookie_file:
                for target_domain, filename in [("vk.com", "vk.com_cookies.txt"), ("vkvideos.ru", "vkvideos.ru_cookies.txt")]:
                    _target_path = os.path.join("app", filename)
                    if not os.path.exists(_target_path):
                        _patched = _content.replace("vkvideo.ru", target_domain)
                        with open(_target_path, "w", encoding="utf-8") as _dst:
                            _dst.write(_patched)
                        logging.info(f"[VK meta] Created {filename} from vkvideo.ru_cookies.txt")
            # If vk.com is base, duplicate for others
            elif "vk.com" in _cookie_file:
                for target_domain, filename in [("vkvideo.ru", "vkvideo.ru_cookies.txt"), ("vkvideos.ru", "vkvideos.ru_cookies.txt")]:
                    _target_path = os.path.join("app", filename)
                    if not os.path.exists(_target_path):
                        _patched = _content.replace("vk.com", target_domain)
                        with open(_target_path, "w", encoding="utf-8") as _dst:
                            _dst.write(_patched)
                        logging.info(f"[VK meta] Created {filename} from vk.com_cookies.txt")
        except Exception as _e:
            logging.debug(f"[VK meta] Cookie duplication failed: {_e}")

    user_agent = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )

    def _extract_one(url: str) -> dict:
        ydl_opts: dict = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": False,
            "lazy_extractors": True,
            "no_check_formats": True,
            "no_check_certificate": True,
            "socket_timeout": 12,
            "user_agent": user_agent,
            "http_headers": {
                "User-Agent": user_agent,
                "Referer": "https://vkvideo.ru/",
                "Accept-Language": "en-US,en;q=0.9",
            },
        }
        if _cookie_file:
            ydl_opts["cookiefile"] = _cookie_file

        try:
            with _yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info:
                    return {"url": url, "ok": False, "error": "no info"}

                formats = info.get("formats", [])
                best = None
                best_h = 0
                # First pass: best MP4 by height
                for f in formats:
                    if not f.get("url"):
                        continue
                    if ".m3u8" in (f.get("url") or "").lower():
                        continue
                    h = int(f.get("height") or 0)
                    if h > best_h:
                        best_h = h
                        best = f
                # Second pass: HLS if no MP4
                if not best:
                    for f in formats:
                        if not f.get("url"):
                            continue
                        h = int(f.get("height") or 0)
                        if h > best_h:
                            best_h = h
                            best = f

                stream_url = (best["url"] if best else None) or info.get("url")
                size_bytes = (
                    info.get("filesize")
                    or info.get("filesize_approx")
                    or (best.get("filesize") if best else None)
                    or 0
                )
                duration = int(info.get("duration") or 0)
                title = (info.get("title") or "VK Video").strip()
                thumbnail = info.get("thumbnail") or ""
                height = int(best.get("height") or 0) if best else 0
                width = int(best.get("width") or 0) if best else 0
                uploader = info.get("uploader") or info.get("channel") or ""

                # Quality label
                if height >= 2160:
                    quality = "4K"
                elif height >= 1440:
                    quality = "1440p"
                elif height >= 1080:
                    quality = "1080p"
                elif height >= 720:
                    quality = "720p"
                elif height >= 480:
                    quality = "480p"
                elif height > 0:
                    quality = f"{height}p"
                else:
                    quality = "HD"

                # Estimate size if 0/None because VK streams do not expose content length
                if not size_bytes and duration > 0:
                    h = height if height > 0 else 720
                    if h >= 2160:
                        bitrate_kbps = 12000
                    elif h >= 1440:
                        bitrate_kbps = 6000
                    elif h >= 1080:
                        bitrate_kbps = 3000
                    elif h >= 720:
                        bitrate_kbps = 1500
                    elif h >= 480:
                        bitrate_kbps = 800
                    else:
                        bitrate_kbps = 400
                    size_bytes = int(duration * bitrate_kbps * 125)
                    logging.info(f"[VK meta] Estimated size for {url}: {size_bytes} bytes based on {h}p and {duration}s")

                return {
                    "url": url,
                    "ok": True,
                    "title": title,
                    "duration": duration,
                    "height": height,
                    "width": width,
                    "quality": quality,
                    "thumbnail": thumbnail,
                    "stream_url": stream_url,
                    "size_bytes": int(size_bytes or 0),
                    "uploader": uploader,
                }
        except Exception as exc:
            logging.warning(f"[VK meta] yt-dlp failed for {url}: {exc}")
            return {"url": url, "ok": False, "error": str(exc)}

    urls = list(dict.fromkeys([u.strip() for u in (req.urls or []) if u and u.strip()]))[:50]
    logging.info(f"[VK meta batch] Processing urls: {urls}")
    if not urls:
        return {"results": []}

    # Run extractions in parallel via thread pool (yt-dlp is sync/blocking)
    # Run extractions in parallel via thread pool (yt-dlp is sync/blocking)
    tasks = [asyncio.to_thread(_extract_one, u) for u in urls]
    results = await asyncio.gather(*tasks, return_exceptions=False)
    logging.info(f"[VK meta batch] Results: {results}")
    return {"results": list(results)}





@api_v1_router.get("/webshare/link")
@api_legacy_router.get("/webshare/link")
async def get_webshare_link(ident: str, auth: bool = Depends(check_auth)):
    """Return a fresh direct download URL for a Webshare file ident (used by hover trailer)."""
    try:
        from app.extractors.legacy.webshare import WebshareAPI
        ws = WebshareAPI(token=None)
        url = await asyncio.to_thread(ws.get_vip_link, ident)
        if not url:
            raise HTTPException(404, detail="Could not get Webshare link")
        return {"url": url}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[WS_LINK] {e}")
        raise HTTPException(500, detail=str(e))


@api_v1_router.post("/webshare/import")
@api_legacy_router.post("/webshare/import")
async def import_webshare(
    url: str = Body(..., embed=True),
    title: str = Body(None),
    batch_name: str = Body(None),
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """
    Import a video directly from a Webshare link string, create Video entry, trigger processing, and return status.
    """
    try:
        from app.extractors.legacy.webshare import WebshareAPI, parse_webshare_ident

        stream_url = url
        display_title = (title or "").strip() or "Webshare import"
        ident = parse_webshare_ident(url)
        if ident:
            ws = WebshareAPI()
            vip = await asyncio.to_thread(ws.get_vip_link, ident)
            if vip:
                stream_url = vip
            info = await asyncio.to_thread(ws.get_file_info, ident)
            if info and info.get("name"):
                display_title = info["name"]

        # 1. Create Video entry
        from .database import Video
        video = Video(
            url=stream_url,
            source_url=url,
            title=display_title,
            status="queued",
            batch_name=batch_name or "Webshare Import",
            storage_type="remote"
        )
        db.add(video)
        db.commit()
        db.refresh(video)

        # 2. Trigger processing (VIP link, thumbnail, etc.)
        from .services import VIPVideoProcessor
        processor = VIPVideoProcessor()
        import threading
        def _run_proc(vid_id):
            import asyncio
            try: asyncio.run(processor.process_single_video(vid_id))
            except Exception as e: logging.error(f"Error in bg processing: {e}")
        threading.Thread(target=_run_proc, args=(video.id,)).start()

        return {"status": "success", "video_id": video.id}
    except Exception as e:
        db.rollback()
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


# --- Password & Session ---
DASHBOARD_PASSWORD = config.DASHBOARD_PASSWORD
SECRET_KEY = config.SECRET_KEY

from fastapi.middleware.cors import CORSMiddleware
from .middleware_request_id import RequestIdMiddleware

# Starlette: last add_middleware = outermost = runs first on incoming request.
# RequestId must be added last so request_id is set before Session/CORS run.
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY)
_cors_kw = {
    "allow_origins": config.CORS_ORIGINS,
    "allow_methods": ["*"],
    "allow_headers": ["*"],
}
if getattr(config, "CORS_ORIGIN_REGEX", ""):
    _cors_kw["allow_origin_regex"] = config.CORS_ORIGIN_REGEX
_cors_kw["allow_credentials"] = False if config.CORS_ORIGINS == ["*"] else True
app.add_middleware(CORSMiddleware, **_cors_kw)
app.add_middleware(RequestIdMiddleware)


APP_DIR = os.path.dirname(os.path.abspath(__file__))

# The placeholder thumbnail is requested by every card that lacks an image, and
# Alpine re-binds :src on every reactive re-render (download polling, etc.). Plain
# StaticFiles sends no Cache-Control, so the browser re-fetched placeholder.jpg
# hundreds of times a minute (flooding the access log). Serve it once with an
# immutable long-lived cache so the browser keeps it and stops re-requesting.
# This route is declared BEFORE the /static mount so it wins for this exact path.
_PLACEHOLDER_FILE = os.path.join(APP_DIR, "static", "placeholder.jpg")


@app.get("/static/placeholder.jpg", include_in_schema=False)
async def _cached_placeholder():
    # Served with a long immutable cache so the browser keeps it and stops
    # re-requesting on every Alpine re-render (was flooding the access log).
    # Declared BEFORE the /static mount so it wins for this exact path.
    return FileResponse(
        _PLACEHOLDER_FILE,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )

@app.get("/nexus-universal-splitscreen.user.js", include_in_schema=False)
async def _serve_splitscreen_userscript():
    userscript_path = os.path.join(os.path.dirname(APP_DIR), "userscripts", "nexus-universal-splitscreen.user.js")
    return FileResponse(
        userscript_path,
        media_type="application/javascript; charset=utf-8",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


class CachedStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            # Thumbnail files can be atomically replaced under the same name.
            # Revalidate unversioned requests instead of keeping old pixels for a day.
            response.headers["Cache-Control"] = (
                "no-cache"
                if path.replace("\\", "/").startswith("thumbnails/") or path.lower().endswith((".js", ".css", ".html"))
                else "public, max-age=86400"
            )
        return response

# follow_symlink=True: app/static/{thumbnails,previews,local_videos} are Windows
# junctions into ../NexusPWC_fresh_v2-data. Starlette's default refuses them → 404.
app.mount(
    "/static",
    CachedStaticFiles(directory=os.path.join(APP_DIR, "static"), follow_symlink=True),
    name="static",
)
from .templating import templates
# --- Models ---
class VideoExport(BaseModel):
    id: int
    title: str
    url: str
    duration: float
    width: int
    height: int
    tags: str
    ai_tags: str
    created_at: datetime.datetime
    views: Optional[int] = 0
    upload_date: Optional[str] = None
    download_stats: Optional[dict] = None
    storage_type: Optional[str] = "remote"
    status: Optional[str] = "pending"
    batch_name: Optional[str] = None
    model_config = {"from_attributes": True}

class ImportRequest(BaseModel):
    urls: List[str]
    items: Optional[List[dict]] = None
    batch_name: Optional[str] = None
    parser: Optional[str] = None
    min_quality: Optional[int] = None
    min_duration: Optional[int] = None
    auto_heal: Optional[bool] = True


class QuantumReadyImportRequest(BaseModel):
    batch_name: Optional[str] = None
    source_url: str
    stream_url: str
    title: str = ""
    thumbnail: str = ""
    duration: float = 0
    width: int = 0
    height: int = 0
    quality: str = ""
    size_bytes: int = 0
    upload_date: str = ""
    tags: List[str] = []
    embed_urls: List[str] = []


# Fast Import is intentionally forgiving about paste formats.  Browsers and
# chat apps commonly copy Markdown such as ``[url](url)`` or a whole selection
# of links.  Extract the actual HTTP URLs before validation so that formatting
# characters never become part of an imported URL.
_PASTED_HTTP_URL_RE = re.compile(r"https?://[^\s<>\"'`\[\]\(\)\\]+", re.IGNORECASE)


def _extract_pasted_import_urls(raw_values: List[Any]) -> List[str]:
    """Return unique http(s) URLs found in normal or Markdown-formatted paste text."""
    urls: List[str] = []
    seen = set()
    for raw_value in raw_values or []:
        raw = str(raw_value or "").strip()
        if not raw:
            continue
        # A clean URL is kept as-is; formatted text contributes every embedded
        # URL.  The trailing punctuation trim handles prose like ``https://… .``.
        candidates = _PASTED_HTTP_URL_RE.findall(raw) or [raw]
        for candidate in candidates:
            candidate = candidate.strip().rstrip(".,;:!?")
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            urls.append(candidate)
    return urls


def _is_supported_import_url(raw: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(str(raw or "").strip())
    except Exception:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _sanitize_import_urls(urls: List[str]) -> List[str]:
    cleaned = _extract_pasted_import_urls(urls)
    if not cleaned:
        raise HTTPException(status_code=400, detail="Please provide at least one URL to import.")

    invalid = [url for url in cleaned if not _is_supported_import_url(url)]
    if invalid:
        sample = ", ".join(invalid[:3])
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported import input. Please paste full http(s) URLs only. Invalid: {sample}",
        )

    return cleaned

class XVideosImportRequest(BaseModel):
    url: str

class SpankBangImportRequest(BaseModel):
    url: str

class BatchActionRequest(BaseModel):
    video_ids: List[int]
    action: str

class BatchRefreshRequest(BaseModel):
    batch_name: str

class BatchDeleteRequest(BaseModel):
    batch_name: str

class NonMatchingVideosRequest(BaseModel):
    batch: str = "All"
    batches: str = ""
    source_board_id: Optional[int] = None
    search: str = ""
    favorites_only: bool = False
    no_thumb_only: bool = False
    poor_thumb_only: bool = False
    quality: str = "All"
    source: str = "All"
    qualities: str = ""
    sources: str = ""
    tags: str = ""
    size_ranges: str = ""
    duration_ranges: str = ""
    size_min: float = 0
    size_max: float = 0
    aspect: str = "All"
    duration_min: int = 0
    duration_max: int = 0
    dateMin: Optional[str] = None
    dateMax: Optional[str] = None
    video_ids: Optional[List[int]] = None
    action: str = "count"


class VideoUpdate(BaseModel):
    is_favorite: Optional[bool] = None
    is_watched: Optional[bool] = None
    resume_time: Optional[float] = None
    duration: Optional[float] = None
    height: Optional[int] = None
    width: Optional[int] = None
    tags: Optional[str] = None
    models: Optional[str] = None
    url: Optional[str] = None          # allow extension to push fresh stream URL

class EpornerSearchRequest(BaseModel):
    query: str
    count: int = 50
    min_quality: int = 1080
    batch_name: Optional[str] = None


class CamwhoresDiscoveryRequest(BaseModel):
    keyword: str = ""
    search_mode: str = "auto"
    min_quality: int = 0
    min_duration: int = 0
    max_duration: int = 0
    search_terms: str = ""
    pages: int = 1
    sort_by: str = "newest"
    only_public: bool = True
    auto_skip_low_quality: bool = False
    batch_name: Optional[str] = None

class CamwhoresPlaylistSearchRequest(BaseModel):
    """Search / browse Camwhores playlists by keyword."""
    keyword: str = ""
    sort_by: str = "top_rated"   # top_rated | most_viewed | most_commented | most_videos | recently_updated
    pages: int = 1               # listing pages to fetch (~30 playlists each)
    max_results: int = 60        # hard cap on returned playlists

class CamwhoresPlaylistFetchRequest(BaseModel):
    """Fetch full video list from one or more playlists, with optional batch slicing."""
    playlist_urls: List[str]
    only_public: bool = True     # Only return public (non-locked) videos
    batch_size: int = 200        # Gallery page size: videos returned per batch
    batch_offset: int = 0        # Start index for pagination (0 = first batch)

class CamwhoresCardsEnrichRequest(BaseModel):
    cards: Optional[List[Dict[str, Any]]] = None
    urls: Optional[List[str]] = None

class CamwhoresPlaylistUpdateCardsRequest(BaseModel):
    playlist_urls: Optional[List[str]] = None
    fetch_id: Optional[str] = None
    cards: List[Dict[str, Any]]

class CamwhoresHubLandingRequest(BaseModel):
    """Browse CamWhores categories or models as Hub cards."""
    sort_by: str = "most_videos"  # most_videos | most_viewed | top_rated | newest | title
    pages: int = 1
    max_results: int = 120
    keyword: str = ""             # models only: filter by model name (client-side)

class CamwhoresHubVideosRequest(BaseModel):
    """Fetch videos from a CamWhores category or model URL as a Hub browse."""
    hub_url: str                  # e.g. https://www.camwhores.tv/categories/fansly/ or /models/caylin/
    sort_by: str = "newest"
    min_quality: int = 0
    min_duration: int = 0
    max_duration: int = 0
    pages: int = 1
    only_public: bool = True
    auto_skip_low_quality: bool = False
    deep: bool = True             # True = full detail crawl + size probe; False = fast listing-only

class CamwhoresMemberRequest(BaseModel):
    """Summary of a CamWhores member (uploader/curator): counts + playlists."""
    member_url: str               # full URL, /members/<id>/… or bare numeric id

class CamwhoresMemberVideosRequest(BaseModel):
    """List a member's posted OR favourite videos as a Hub browse."""
    member_url: str
    kind: str = "posted"          # "posted" | "favourites"
    pages: int = 1
    only_public: bool = True
    deep: bool = False
    min_quality: int = 0
    min_duration: int = 0
    max_duration: int = 0
    auto_skip_low_quality: bool = False

class EpornerDiscoveryRequest(BaseModel):
    keyword: str
    min_quality: int = 1080
    min_duration: Optional[int] = 0
    max_duration: Optional[int] = 0
    search_terms: str = ""
    pages: int = 2
    auto_skip_low_quality: bool = True
    batch_name: Optional[str] = None


class PorntrexDiscoveryRequest(BaseModel):
    keyword: str = ""
    min_quality: int = 1080
    pages: int = 5
    category: str = ""
    source_url: str = ""
    upload_type: str = "all"
    auto_skip_low_quality: bool = True
    batch_name: Optional[str] = None


class WhoresHubDiscoveryRequest(BaseModel):
    keyword: str = ""
    tag: str = ""
    min_quality: int = 720
    min_duration: int = 300  # 5 minutes
    pages: int = 10
    upload_type: str = "all"
    auto_skip_low_quality: bool = True
    sort_by: str = "post_date"  # newest-first by upload date (see scrape_whoreshub_discovery)
    batch_name: Optional[str] = None


class SxyPrnDiscoveryRequest(BaseModel):
    mode: str = "latest"     # latest | trending | search | tag | profile
    query: str = ""
    tag: str = ""
    profile_id: str = ""
    pages: int = 2
    resolve_streams: bool = False  # if True, fetch each post page for stream URLs
    batch_name: Optional[str] = None


class LeakPornerDiscoveryRequest(BaseModel):
    keyword: str = ""
    pages: int = 1
    min_duration: int = 0
    sort: str = "latest"
    batch_name: Optional[str] = None


class CyberLeaksDiscoveryRequest(BaseModel):
    keyword: str = ""
    pages: int = 1
    tag: str = "tape"
    batch_name: Optional[str] = None


class TelegramLoginRequest(BaseModel):
    api_id: str
    api_hash: str
    phone: str

class TelegramVerifyRequest(BaseModel):
    code: str
    password: str = None

class RedGifsImportRequest(BaseModel):
    keywords: str
    count: int = 20
    hd_only: bool = False
    min_duration: int = 30
    min_resolution: int = 1080
    only_vertical: bool = False
    disable_rejection: bool = False
    batch_name: Optional[str] = None

class RedGifsSingleImportRequest(BaseModel):
    title: str
    video_url: Optional[str] = None
    page_url: str
    thumbnail: Optional[str] = None
    tags: list[str] = []
    duration: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    batch_name: Optional[str] = None

class RedGifsBulkImportRequest(BaseModel):
    items: list[RedGifsSingleImportRequest]
    batch_name: Optional[str] = None

class RedditImportRequest(BaseModel):
    subreddits: str  # Comma separated
    count: int = 20
    hd_only: bool = False
    min_duration: int = 30
    min_resolution: int = 1080
    only_vertical: bool = False
    disable_rejection: bool = False
    batch_name: Optional[str] = None

class PornOneImportRequest(BaseModel):
    keywords: str
    count: int = 20
    min_duration: int = 30
    min_resolution: int = 1080
    only_vertical: bool = False
    batch_name: Optional[str] = None
    debug: bool = False

class XVideosPlaylistImportRequest(BaseModel):
    url: str
    batch_name: Optional[str] = None

class HQPornerImportRequest(BaseModel):
    keywords: str = ""
    category: Optional[str] = None
    min_quality: str = "1080p"
    added_within: str = "any"
    count: int = 20
    batch_name: Optional[str] = None

class TnaflixImportRequest(BaseModel):
    url: Optional[str] = None
    query: Optional[str] = None
    count: int = 20
    min_duration: int = 0
    min_quality: int = 0
    batch_name: Optional[str] = None



class LeakPornerDiscoveryImportRequest(BaseModel):
    selected_urls: List[str]
    batch_name: Optional[str] = None


class BeegImportRequest(BaseModel):
    query: str
    count: int = 10
    batch_name: Optional[str] = None

# --- Routes ---
# (page routes + login/logout extracted to app/routers/pages.py)

# BitTorrent Web integration routes moved to app/routers/bittorrent_web.py
# (registered via include_router below, near the other router includes).

@app.get("/api/v1/speedtest")
async def speedtest_endpoint():
    """Returns ~2MB of null bytes so the frontend can measure download throughput to this server."""
    SIZE = 2 * 1024 * 1024  # 2 MB
    CHUNK = 64 * 1024
    async def _gen():
        sent = 0
        chunk = b'\x00' * CHUNK
        while sent < SIZE:
            yield chunk
            sent += CHUNK
    return StreamingResponse(
        _gen(),
        media_type="application/octet-stream",
        headers={
            "Content-Length": str(SIZE),
            "Cache-Control": "no-store",
            "X-Speedtest": "nexus",
        },
    )

@app.get("/api/v1/config/supported_hosts")
async def get_supported_hosts():
    """Returns a list of all supported media domains/hosts for Chrome Extension whitelisting."""
    try:
        from app.intake import SEARCH_IMPORT_SOURCES
        sources = list(SEARCH_IMPORT_SOURCES)
    except Exception:
        sources = []
    
    extra_hosts = [
        "recurbate.com", "rec-ur-bate.com", "noodlemagazine.com", "fullporner.com", 
        "whoreshub.com", "thots.tv", "vidara.so", "sxyprn.com", "sxyprn.net", 
        "krakenfiles.com", "xmoviesforyou.com", "beeg.com", "katestube.com", 
        "pimpbunny.com", "porncream.com", "xvideos.com", "xvideos.red", 
        "eporner.com", "pornhoarder.tv", "pornhoarder.net", "pornhoarder.io", 
        "pornhoarder.pictures", "pornhoarder", "xgroovy.com", "xgroovy-fr.com"
    ]
    all_hosts = list(set(sources + extra_hosts))
    return {"ok": True, "hosts": all_hosts}

@app.post("/api/v1/pornhoarder/update_stream")
@app.post("/api/v1/videos/update_stream")
async def pornhoarder_update_stream(payload: dict, db: Session = Depends(get_db), x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    """Receives direct stream URL from PornHoarder browser interceptor content script."""
    ensure_bridge_token(x_nexus_token)
    source_url = (payload.get("source_url") or "").strip()
    stream_url = (payload.get("stream_url") or "").strip()
    source = (payload.get("source") or "pornhoarder").strip().lower()
    title = (payload.get("title") or "").strip()

    def _title_from_source(url: str) -> str:
        try:
            from urllib.parse import urlparse, unquote
            path = urlparse(url or "").path
            # /watch/<slug>/<token>
            parts = [p for p in path.split("/") if p]
            if "watch" in parts:
                i = parts.index("watch")
                if i + 1 < len(parts):
                    return unquote(parts[i + 1]).replace("-", " ").strip().title()
            if parts:
                return unquote(parts[-1]).replace("-", " ").strip().title()
        except Exception:
            pass
        return ""

    if not source_url:
        return {"status": "error", "message": "missing fields"}
    if not stream_url:
        stream_url = source_url

    def _looks_like_stream(url: str) -> bool:
        u = (url or "").strip().lower()
        if not u.startswith(("http://", "https://")):
            return False
        return (
            bool(re.search(r"\.(mp4|m3u8|mpd)(\?|$)", u))
            or "/api/v1/proxy/hls?url=" in u
            or "/hls_proxy?url=" in u
        )

    resolved_stream = stream_url
    resolved_title = title
    resolved_thumbnail = ""
    resolved_duration = 0
    resolved_player_url = ""

    # For browser-captured providers, try extractor once:
    # - resolves non-playable captures/player URLs to direct streams
    # - fills metadata for clean dashboard cards.
    is_known_source = source in ("pornhoarder", "pornfans", "recurbate", "leakporner", "djav", "vidara", "vidsonic", "vidfast", "lulustream", "luluvid", "luluvdo", "lulu.stream", "sxyprn", "krakenfiles")
    is_vidara_stream = any(d in stream_url.lower() for d in ("vidara.so", "vidsonic.net", "vidfast.co"))
    is_lulu_stream = any(d in stream_url.lower() for d in ("lulustream", "luluvid", "luluvdo", "lulu.stream"))

    if is_known_source or is_vidara_stream or is_lulu_stream:
        try:
            extractor = None
            if source == "pornhoarder":
                from .extractors.pornhoarder import PornHoarderExtractor
                extractor = PornHoarderExtractor()
            elif source == "pornfans":
                from .extractors.pornfans import PornFansExtractor
                extractor = PornFansExtractor()
            elif source in ("leakporner", "djav", "pornerleak", "mypornerleak"):
                from .extractors.leakporner import LeakPornerExtractor
                extractor = LeakPornerExtractor()
            elif source in ("vidara", "vidsonic", "vidfast") or is_vidara_stream:
                from .extractors.vidara import VidaraExtractor
                extractor = VidaraExtractor()
            elif source in ("lulustream", "luluvid", "luluvdo", "lulu.stream") or is_lulu_stream:
                from .extractors.lulustream import LuluStreamExtractor
                extractor = LuluStreamExtractor()
            elif source == "krakenfiles" or "krakenfiles.com" in stream_url.lower():
                from .extractors.krakenfiles import KrakenFilesExtractor
                extractor = KrakenFilesExtractor()
            elif source == "sxyprn" or "sxyprn.com" in stream_url.lower():
                from .extractors.sxyprn import SxyPrnExtractor
                extractor = SxyPrnExtractor()
            elif source == "recurbate":
                from .extractors.recurbate import RecurbateExtractor
                extractor = RecurbateExtractor()
            
            if extractor:
                # If title is generic or missing, we MUST extract to get real metadata
                is_generic_title = not resolved_title or any(x in resolved_title.lower() for x in (">external link!<", "krakenfiles.com", "vidara.so", "vidsonic", "vidfast"))
                
                # Use source_url for extraction if available, otherwise stream_url
                extraction_url = source_url or stream_url
                
                # Use source_url if it's from the same domain, otherwise use stream_url
                target_url = source_url if (source in extractor.name.lower() or extractor.can_handle(source_url)) else stream_url
                
                # Special case for Vidara/Lulu embedded on other sites
                if not extractor.can_handle(target_url) and is_vidara_stream:
                    target_url = stream_url
                
                extracted = await extractor.extract(target_url)
                if extracted:
                    candidate = (extracted.get("stream_url") or "").strip()
                    if (
                        candidate and
                        _looks_like_stream(candidate) and
                        "player.php" not in candidate.lower() and
                        (not _looks_like_stream(stream_url) or "player.php" in stream_url.lower())
                    ):
                        resolved_stream = candidate
                    if (is_generic_title or not resolved_title):
                        ext_title = (extracted.get("title") or "").strip()
                        if ext_title: resolved_title = ext_title
                    resolved_thumbnail = (extracted.get("thumbnail") or "").strip()
                    resolved_duration = int(extracted.get("duration") or 0)
                    resolved_player_url = (extracted.get("player_url") or "").strip()

                    # Detect quality
                    if any(x in (resolved_title + stream_url).lower() for x in ("1080", "fhd", "ultra")):
                        quality = "FHD"
                    elif any(x in (resolved_title + stream_url).lower() for x in ("720", "hd")):
                        quality = "HD"
                    elif extracted.get("quality"):
                        quality = extracted.get("quality")
        except Exception as exc:
            logging.warning(f"[StreamCapture] stream resolve failed for {source_url}: {exc}")

    # Server-side smart filter: Reject previews/thumbs
    if any(x in resolved_stream.lower() for x in ("vidthumb", "preview", "small.mp4", "get_preview")):
        logging.info(f"[StreamCapture] Rejected preview stream: {resolved_stream}")
        return {"status": "ignored", "message": "preview_detected"}

    # Final title cleanup
    if resolved_title:
        # Remove common artifacts
        for artifact in (">External Link!<", "krakenfiles.com", "vidara.so", "vidsonic.net", "vidfast.co", "sxyprn.com", "vidfast.co", "vidsonic.net"):
            resolved_title = re.sub(re.escape(artifact), "", resolved_title, flags=re.IGNORECASE)
        resolved_title = resolved_title.strip(" -|")
        if not resolved_title:
            resolved_title = _title_from_source(source_url) or f"{source.capitalize()} Video"

    # Detect quality and try to get file size
    resolved_quality = "SD"
    _low_check = (resolved_title + resolved_stream).lower()
    if any(x in _low_check for x in ("2160", "4k")):
        resolved_quality = "4K"
    elif "1440" in _low_check:
        resolved_quality = "1440p"
    elif any(x in _low_check for x in ("1080", "fhd", "ultra")):
        resolved_quality = "FHD"
    elif any(x in _low_check for x in ("720", "hd")):
        resolved_quality = "HD"

    file_size_mb = 0
    # HLS playlists (.m3u8) report Content-Length of the playlist text, not the actual video.
    # Do NOT use HEAD on HLS streams – it would give a few-KB size instead of the real 500MB+.
    _is_hls_stream = ".m3u8" in resolved_stream.lower()
    if not _is_hls_stream:
        try:
            import httpx
            _head_headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "*/*",
                "Accept-Encoding": "identity",
            }
            with httpx.Client(timeout=8) as client:
                h_resp = client.head(resolved_stream, follow_redirects=True, headers=_head_headers)
                if h_resp.status_code < 400:
                    content_length = int(h_resp.headers.get("Content-Length", 0))
                    # Sanity check: ignore suspiciously small values (< 5 MB) for remote video streams
                    # These are usually redirect pages, error pages or partial responses
                    if content_length >= 5 * 1024 * 1024:
                        file_size_mb = round(content_length / (1024 * 1024), 1)
                        logging.info(f"[StreamCapture] Detected file size: {file_size_mb} MB")
                    elif content_length > 0:
                        logging.info(f"[StreamCapture] Ignoring suspicious Content-Length {content_length} bytes for {resolved_stream[:80]}")
        except Exception:
            pass

    if not _looks_like_stream(resolved_stream):
        logging.warning(f"[PH-Interceptor] Rejected non-playable stream URL: {resolved_stream[:120]}")
        return {"status": "error", "message": "non_playable_stream", "stream_url": resolved_stream[:200]}

    def _queue_thumbnail_processing(video_id: int) -> None:
        try:
            processor = VIPVideoProcessor()
            import threading
            threading.Thread(
                target=lambda vid: asyncio.run(processor.process_single_video(vid)),
                args=(video_id,),
                daemon=True,
            ).start()
        except Exception as exc:
            logging.warning(f"[PH-Interceptor] Failed to queue thumbnail processing for {video_id}: {exc}")

    video = db.query(Video).filter(Video.source_url == source_url).order_by(Video.id.desc()).first()
    if not video:
        video = db.query(Video).filter(Video.url == source_url).order_by(Video.id.desc()).first()
    if video:
        logging.info(f"[PH-Interceptor] Updating stream for video {video.id}: {resolved_stream[:80]}")
        video.url = resolved_stream
        video.status = "ready_to_stream"
        if resolved_quality and (not video.quality or video.quality == "SD"):
            video.quality = resolved_quality
        if file_size_mb > 0:
            video.file_size_mb = file_size_mb
        if resolved_title and (not video.title or any(x in str(video.title).lower() for x in ("untitled", "queued", ">external link!<"))):
            video.title = resolved_title
        if resolved_duration > 0 and not (video.duration or 0):
            video.duration = float(resolved_duration)
        if resolved_thumbnail and not video.thumbnail_path:
            video.thumbnail_path = resolved_thumbnail
        if resolved_player_url:
            stats = video.download_stats or {}
            stats["player_url"] = resolved_player_url
            video.download_stats = stats
            try:
                from sqlalchemy.orm.attributes import flag_modified
                flag_modified(video, "download_stats")
            except Exception:
                pass
        db.commit()
        # Ensure preview thumbnail and technical metadata are generated.
        # Also regenerate if path is set but the file does not exist on disk.
        _tp = video.thumbnail_path or ''
        _thumb_on_disk = False
        if _tp.startswith('/static/thumbnails/'):
            import os as _os
            _tf = _os.path.join('app', _tp.lstrip('/').split('?')[0])
            _thumb_on_disk = _os.path.exists(_tf) and _os.path.getsize(_tf) > 500
        if not _thumb_on_disk or not video.height or not video.duration:
            _queue_thumbnail_processing(video.id)
        return {"status": "ok", "video_id": video.id, "stream_url": resolved_stream}
    logging.info(f"[PH-Interceptor] No video found for source_url, creating new one: {source_url}")
    new_video = Video(
        title=resolved_title or _title_from_source(source_url) or f"{source.capitalize()} Video",
        url=resolved_stream,
        source_url=source_url,
        thumbnail_path=resolved_thumbnail or None,
        duration=float(resolved_duration or 0),
        height=0,
        width=0,
        batch_name=f"{source.capitalize()} Interceptor",
        tags=source,
        storage_type="remote",
        status="ready_to_stream",
        quality=resolved_quality,
        file_size_mb=file_size_mb,
        download_stats=({"player_url": resolved_player_url} if resolved_player_url else None),
    )
    db.add(new_video)
    db.commit()
    db.refresh(new_video)
    _queue_thumbnail_processing(new_video.id)
    return {"status": "created", "video_id": new_video.id, "stream_url": resolved_stream}


@api_v1_router.post("/old-gallery/import")
@api_legacy_router.post("/old-gallery/import")
def import_old_gallery_sample(payload: LegacyGalleryImportRequest, db: Session = Depends(get_db)):
    source_key = (payload.source_key or "desktop_04052026").strip()
    source = _resolve_legacy_source(source_key)

    limit = max(1, min(int(payload.limit or 100), 100))
    batch_name = (payload.batch_name or "Old Gallery").strip() or "Old Gallery"
    db_path = source["db_path"]
    root_dir = source["root_dir"]

    if not os.path.exists(db_path):
        raise HTTPException(status_code=404, detail=f"Legacy database not found: {db_path}")

    existing_urls = {
        (row[0] or "").strip()
        for row in db.query(Video.source_url).filter(Video.source_url.isnot(None)).all()
        if (row[0] or "").strip()
    }
    existing_urls.update(
        (row[0] or "").strip()
        for row in db.query(Video.url).filter(Video.url.isnot(None)).all()
        if (row[0] or "").strip()
    )

    imported = 0
    skipped_existing = 0
    copied_assets = 0
    selected_rows = 0

    def _resolve_legacy_asset(asset_path: Optional[str]) -> Optional[str]:
        if not asset_path:
            return None
        asset_path = str(asset_path).strip()
        if not asset_path:
            return None
        if asset_path.startswith(("http://", "https://")):
            return asset_path

        relative = asset_path.lstrip("/\\").replace("/", os.sep).replace("\\", os.sep)
        candidates = [
            os.path.join(root_dir, relative),
            os.path.join(root_dir, "app", relative),
            os.path.join(root_dir, "app", "static", relative),
        ]
        for candidate in candidates:
            if os.path.exists(candidate):
                return candidate
        return None

    def _copy_legacy_asset(asset_path: Optional[str], subdir: str) -> Optional[str]:
        nonlocal copied_assets
        resolved = _resolve_legacy_asset(asset_path)
        if not resolved:
            return None
        if resolved.startswith(("http://", "https://")):
            return resolved

        filename = os.path.basename(resolved)
        safe_name = f"legacy_{source_key}_{int(time.time() * 1000)}_{filename}"
        target_dir = os.path.join("app", "static", subdir)
        os.makedirs(target_dir, exist_ok=True)
        target_path = os.path.join(target_dir, safe_name)
        shutil.copy2(resolved, target_path)
        copied_assets += 1
        return "/" + target_path.replace("\\", "/")

    select_sql = """
        SELECT id, title, url, source_url, thumbnail_path, gif_preview_path, preview_path,
               duration, width, height, aspect_ratio, tags, ai_tags, subtitle,
               is_favorite, is_watched, status, created_at, upload_date, quality,
               file_size_mb, download_stats, batch_name
        FROM videos
        WHERE status = 'ready_to_stream' AND title IS NOT NULL AND TRIM(title) != ''
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT ?
    """

    legacy = None
    try:
        legacy = sqlite3.connect(db_path)
        legacy.row_factory = sqlite3.Row
        rows = legacy.execute(select_sql, (limit,)).fetchall()
        selected_rows = len(rows)

        for row in rows:
            dedupe_key = (row["source_url"] or row["url"] or "").strip()
            if not dedupe_key or dedupe_key in existing_urls:
                skipped_existing += 1
                continue

            try:
                download_stats = None
                raw_stats = row["download_stats"]
                if raw_stats:
                    if isinstance(raw_stats, str):
                        try:
                            download_stats = json.loads(raw_stats)
                        except json.JSONDecodeError:
                            download_stats = {"legacy_raw_download_stats": raw_stats}
                    elif isinstance(raw_stats, dict):
                        download_stats = dict(raw_stats)
                if not isinstance(download_stats, dict):
                    download_stats = {}

                download_stats["legacy_source_db"] = source["label"]
                if row["batch_name"]:
                    download_stats["legacy_batch_name"] = row["batch_name"]

                created_at = None
                if row["created_at"]:
                    try:
                        created_at = datetime.datetime.fromisoformat(str(row["created_at"]))
                    except ValueError:
                        created_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)

                video = Video(
                    title=row["title"],
                    url=row["url"],
                    source_url=row["source_url"] or row["url"],
                    thumbnail_path=_copy_legacy_asset(row["thumbnail_path"], os.path.join("legacy", "thumbs")),
                    gif_preview_path=_copy_legacy_asset(row["gif_preview_path"], os.path.join("legacy", "gifs")),
                    preview_path=_copy_legacy_asset(row["preview_path"], os.path.join("legacy", "previews")),
                    duration=float(row["duration"] or 0),
                    width=int(row["width"] or 0),
                    height=int(row["height"] or 0),
                    aspect_ratio=row["aspect_ratio"],
                    batch_name=batch_name,
                    tags=row["tags"] or "legacy-import",
                    ai_tags=row["ai_tags"] or "",
                    subtitle=row["subtitle"] or "",
                    storage_type="remote",
                    is_favorite=bool(row["is_favorite"]),
                    is_watched=bool(row["is_watched"]),
                    status="ready_to_stream",
                    created_at=created_at or datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None),
                    upload_date=row["upload_date"],
                    quality=row["quality"] or "SD",
                    file_size_mb=float(row["file_size_mb"] or 0),
                    download_stats=download_stats,
                )
                db.add(video)
                existing_urls.add(dedupe_key)
                imported += 1
            except Exception as exc:
                logging.warning("Legacy import skipped row %s from %s: %s", row["id"], source["label"], exc)

        db.commit()
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Legacy import failed: {exc}")
    finally:
        if legacy is not None:
            legacy.close()

    return {
        "status": "ok",
        "source_key": source_key,
        "source_label": source["label"],
        "batch": batch_name,
        "selected": selected_rows,
        "imported": imported,
        "skipped_existing": skipped_existing,
        "copied_assets": copied_assets,
        "note": "Direct URLs and metadata were imported. Hover preview is best-effort because legacy preview assets are sparse.",
    }


@api_v1_router.get("/old-gallery/videos")
@api_legacy_router.get("/old-gallery/videos")
def get_old_gallery_videos(
    source_key: str = "desktop_04052026",
    page: int = 1,
    limit: int = 10,
    search: str = "",
):
    source = _resolve_legacy_source(source_key)
    db_path = source["db_path"]
    if not os.path.exists(db_path):
        raise HTTPException(status_code=404, detail=f"Legacy database not found: {db_path}")

    page = max(1, int(page or 1))
    limit = max(1, min(int(limit or 10), 100))
    offset = (page - 1) * limit
    search = (search or "").strip()

    sql = """
        SELECT id, title, url, source_url, thumbnail_path, gif_preview_path, preview_path,
               duration, width, height, aspect_ratio, batch_name, tags, ai_tags, subtitle,
               status, created_at, upload_date, quality, file_size_mb, download_stats
        FROM videos
        WHERE status = 'ready_to_stream'
          AND title IS NOT NULL
          AND TRIM(title) != ''
    """
    params = []
    if search:
        sql += " AND (lower(title) LIKE ? OR lower(tags) LIKE ? OR lower(ai_tags) LIKE ?)"
        search_term = f"%{search.lower()}%"
        params.extend([search_term, search_term, search_term])
    sql += " ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    def _legacy_asset_url(asset_path: Optional[str]) -> Optional[str]:
        if not asset_path:
            return None
        asset_path = str(asset_path).strip()
        if not asset_path:
            return None
        if asset_path.startswith(("http://", "https://", "/")):
            return asset_path
        return "/" + asset_path.lstrip("/\\").replace("\\", "/")

    legacy = None
    try:
        legacy = sqlite3.connect(db_path)
        legacy.row_factory = sqlite3.Row
        rows = legacy.execute(sql, params).fetchall()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Legacy gallery read failed: {exc}")
    finally:
        if legacy is not None:
            legacy.close()

    results = []
    for row in rows:
        raw_stats = row["download_stats"]
        if isinstance(raw_stats, str):
            try:
                parsed_stats = json.loads(raw_stats)
            except json.JSONDecodeError:
                parsed_stats = {"legacy_raw_download_stats": raw_stats}
        elif isinstance(raw_stats, dict):
            parsed_stats = dict(raw_stats)
        else:
            parsed_stats = {}

        parsed_stats["legacy_source_db"] = source["label"]
        results.append({
            "id": f"legacy-{source_key}-{row['id']}",
            "legacy_id": row["id"],
            "is_legacy": True,
            "title": row["title"],
            "url": row["url"],
            "source_url": row["source_url"] or row["url"],
            "thumbnail_path": _legacy_asset_url(row["thumbnail_path"]),
            "gif_preview_path": _legacy_asset_url(row["gif_preview_path"]),
            "preview_path": _legacy_asset_url(row["preview_path"]),
            "duration": float(row["duration"] or 0),
            "width": int(row["width"] or 0),
            "height": int(row["height"] or 0),
            "aspect_ratio": row["aspect_ratio"],
            "batch_name": row["batch_name"] or "Legacy Import",
            "tags": row["tags"] or "",
            "ai_tags": row["ai_tags"] or "",
            "subtitle": row["subtitle"] or "",
            "status": row["status"] or "ready_to_stream",
            "created_at": row["created_at"],
            "upload_date": row["upload_date"],
            "quality": row["quality"] or "SD",
            "file_size_mb": float(row["file_size_mb"] or 0),
            "download_stats": parsed_stats,
            "storage_type": "legacy_remote",
            "source": "Old Gallery",
        })

    return results


_GALLERY_CARD_COLUMNS = (
    Video.id,
    Video.title,
    Video.url,
    Video.source_url,
    Video.thumbnail_path,
    Video.gif_preview_path,
    Video.preview_path,
    Video.sprite_path,
    Video.duration,
    Video.width,
    Video.height,
    Video.batch_name,
    Video.tags,
    Video.storage_type,
    Video.is_favorite,
    Video.resume_time,
    Video.status,
    Video.created_at,
    Video.quality,
    Video.file_size_mb,
    Video.link_status,
    Video.last_checked,
    Video.telegram_chat_id,
    Video.telegram_message_id,
)


def _bounded_limit(value: int, maximum: int, default: int) -> int:
    """Keep public list endpoints from turning invalid limits into full scans."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(parsed, maximum))


def _versioned_gallery_thumbnail(thumbnail_path: str) -> str:
    """Version mutable local thumbnails by the file that will be served."""
    from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

    value = str(thumbnail_path or "")
    parts = urlsplit(value)
    if parts.scheme or parts.netloc or not parts.path.startswith("/static/thumbnails/"):
        return value
    relative = parts.path[len("/static/"):]
    static_root = Path(APP_DIR, "static").resolve()
    try:
        file_path = (static_root / relative).resolve()
        # Windows junctions may point outside the static directory, so reject
        # traversal before resolving while still allowing managed thumbnail junctions.
        if ".." in Path(relative).parts or not file_path.is_file():
            return value
        stat = file_path.stat()
    except (OSError, ValueError):
        return value
    query = [(key, val) for key, val in parse_qsl(parts.query, keep_blank_values=True) if key != "v"]
    query.append(("v", f"{stat.st_mtime_ns:x}-{stat.st_size:x}"))
    return urlunsplit(("", "", parts.path, urlencode(query), parts.fragment))


def _gallery_card_payload(
    video: Video,
    source_count: int = 1,
    source_labels: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Lean card JSON — skip error_msg, phash, download_stats, subtitle, etc."""
    status = video.status or "pending"
    storage_type = video.storage_type or "remote"
    source_url = video.source_url or ""
    url = video.url or ""
    if status == "pending" and "redgifs.com/" in source_url.lower() and url.strip():
        status = "ready_to_stream"
        storage_type = "external_direct"
    # Card pages are deliberately small; measuring the local image here gives
    # the browser an honest preview-quality badge without client-side scanning.
    from app.maintenance import thumbnail_quality
    return {
        "id": video.id,
        "title": video.title or "",
        "url": url,
        "source_url": source_url,
        "thumbnail_path": _versioned_gallery_thumbnail(video.thumbnail_path or ""),
        "thumbnail_quality": thumbnail_quality(video),
        "gif_preview_path": video.gif_preview_path or "",
        "preview_path": video.preview_path or "",
        "sprite_path": video.sprite_path or "",
        "duration": video.duration or 0,
        "width": video.width or 0,
        "height": video.height or 0,
        "batch_name": video.batch_name or "",
        "tags": video.tags or "",
        "storage_type": storage_type,
        "is_favorite": bool(video.is_favorite),
        "resume_time": video.resume_time or 0,
        "status": status,
        "created_at": video.created_at,
        "quality": video.quality or "SD",
        "file_size_mb": video.file_size_mb or 0,
        "link_status": video.link_status or "unknown",
        "telegram_chat_id": video.telegram_chat_id or "",
        "telegram_message_id": video.telegram_message_id or 0,
        "playback_health": _derive_video_playback_health(video),
        # One library card may represent the same upload on several hosts.
        # `VideoSource` is deliberately kept out of the regular card query;
        # callers prefetch these tiny aggregates for the current page instead.
        "source_count": max(1, int(source_count or 1)),
        "source_labels": source_labels or [],
    }


def _gallery_source_filter_clause(selected_sources: list[str]):
    """Match gallery sources by hostname label or complete CSV tag token."""
    normalized_url = func.replace(func.lower(Video.source_url), "://www.", "://")
    normalized_tags = func.replace(func.lower(Video.tags), ", ", ",")
    clauses = []

    for source in selected_sources:
        name = str(source or "").strip().lower()
        if not name:
            continue

        # /sources exposes the first hostname label (e.g. t.me -> T).
        scheme_end = func.instr(normalized_url, "://")
        host_start = scheme_end + 3
        host_prefix = func.substr(normalized_url, host_start, len(name) + 1)
        for boundary in (".", "/", ":"):
            clauses.append(and_(scheme_end > 0, host_prefix == f"{name}{boundary}"))
        clauses.append(func.instr("," + normalized_tags + ",", f",{name},") > 0)

    return or_(*clauses) if clauses else None


@api_v1_router.get("/videos")
@api_legacy_router.get("/videos")
def get_videos(
    page: int = 1,
    limit: int = 10,
    per_page: Optional[int] = None,
    search: str = "",
    batch: str = "All",
    batches: str = "",
    source_board_id: Optional[int] = None,
    favorites_only: bool = False,
    no_thumb_only: bool = False,
    poor_thumb_only: bool = False,
    quality: str = "All",
    source: str = "All",
    qualities: str = "",
    sources: str = "",
    tags: str = "",
    size_ranges: str = "",
    duration_ranges: str = "",
    size_min: float = 0,
    size_max: float = 0,
    aspect: str = "All",
    duration_min: int = 0,
    duration_max: int = 99999,
    sort: str = "date_desc",
    dateMin: Optional[str] = None,
    dateMax: Optional[str] = None,
    db: Session = Depends(get_db)
):
    # per_page alias for limit
    if per_page is not None:
        limit = per_page
    # SQLite interprets LIMIT -1 as unlimited, so clamp both ends.
    page = max(1, page)
    limit = _bounded_limit(limit, maximum=1000, default=10)
    
    query = db.query(Video).options(load_only(*_GALLERY_CARD_COLUMNS))
    # Filter out videos without titles to prevent frontend errors
    query = query.filter(Video.title != None, Video.title != "")
    if search:
        # Use FTS5 for ultra-fast search with fallback to slow LIKE
        numeric_search = search.strip()
        try:
            safe_search = sanitize_fts_query(search)
            if safe_search:
                # We try MATCH first. SQLite will handle the subquery efficiently.
                fts_clause = text("id IN (SELECT rowid FROM videos_fts WHERE videos_fts MATCH :search_term)")
                # FTS covers text metadata, but operational batch labels are
                # searched directly so a batch keyword reliably finds its cards.
                search_clauses = [
                    fts_clause,
                    Video.batch_name.contains(search),
                    Video.source_url.contains(search),
                    Video.url.contains(search),
                ]
                if numeric_search.isdigit():
                    search_clauses.append(Video.id == int(numeric_search))
                query = query.filter(or_(*search_clauses))
                query = query.params(search_term=f"{safe_search}*")
        except Exception as e:
            logging.warning(f"FTS5 search failed, falling back to LIKE: {e}")
            fallback_clauses = [
                Video.title.contains(search),
                Video.tags.contains(search),
                Video.ai_tags.contains(search),
                Video.batch_name.contains(search),
                Video.source_url.contains(search),
                Video.url.contains(search),
            ]
            if numeric_search.isdigit():
                fallback_clauses.append(Video.id == int(numeric_search))
            query = query.filter(or_(*fallback_clauses))
    selected_batches = [b.strip() for b in (batches or "").split(",") if b.strip()]
    if source_board_id is not None:
        from app.database import SourceBoard
        from app.routers.source_boards import board_video_ids
        board = db.query(SourceBoard).filter(SourceBoard.id == source_board_id).first()
        query = query.filter(Video.id.in_(board_video_ids(db, board) if board else []))
    elif batch and batch != "All":
        query = query.filter(Video.batch_name == batch)
    elif selected_batches:
        query = query.filter(Video.batch_name.in_(selected_batches))
    if favorites_only: query = query.filter(Video.is_favorite == True)
    if no_thumb_only: query = query.filter(or_(Video.thumbnail_path == None, Video.thumbnail_path == '', Video.thumbnail_path == '/static/placeholder.jpg'))
    if duration_min > 0:
        query = query.filter(Video.duration >= duration_min)
    if duration_max > 0 and duration_max < 99999:
        query = query.filter(Video.duration <= duration_max)
    selected_qualities = [q.strip() for q in (qualities or "").split(",") if q.strip()]
    selected_sources = [s.strip() for s in (sources or "").split(",") if s.strip()]
    selected_tags = [t.strip() for t in (tags or "").split(",") if t.strip()]
    selected_size_ranges = [r.strip().lower() for r in (size_ranges or "").split(",") if r.strip()]
    selected_duration_ranges = [r.strip().lower() for r in (duration_ranges or "").split(",") if r.strip()]

    if quality != "All":
        if quality == "4K": query = query.filter(Video.height >= 2160)
        elif quality == "1440p": query = query.filter(Video.height >= 1440, Video.height < 2160)
        elif quality in ["1080p", "FHD"]: query = query.filter(Video.height >= 1080, Video.height < 1440)
        elif quality in ["720p", "HD"]: query = query.filter(Video.height >= 720, Video.height < 1080)
        elif quality == "SD": query = query.filter(Video.height < 720)
    elif selected_qualities:
        quality_clauses = []
        for q in selected_qualities:
            if q == "4K":
                quality_clauses.append(Video.height >= 2160)
            elif q == "1440p":
                quality_clauses.append(and_(Video.height >= 1440, Video.height < 2160))
            elif q in ("1080p", "FHD"):
                quality_clauses.append(and_(Video.height >= 1080, Video.height < 1440))
            elif q in ("720p", "HD"):
                quality_clauses.append(and_(Video.height >= 720, Video.height < 1080))
            elif q == "SD":
                quality_clauses.append(Video.height < 720)
        if quality_clauses:
            query = query.filter(or_(*quality_clauses))
    
    if source and source != "All":
        # Filter by source domain in source_url or exact tag
        source_clause = _gallery_source_filter_clause([source])
        if source_clause is not None:
            query = query.filter(source_clause)
    elif selected_sources:
        source_clause = _gallery_source_filter_clause(selected_sources)
        if source_clause is not None:
            query = query.filter(source_clause)

    if selected_tags:
        tag_clauses = []
        for t in selected_tags:
            tag_clauses.append(Video.tags.contains(t))
            tag_clauses.append(Video.ai_tags.contains(t))
        query = query.filter(or_(*tag_clauses))

    if size_min > 0:
        query = query.filter(Video.file_size_mb >= size_min)
    if size_max > 0:
        query = query.filter(Video.file_size_mb <= size_max)
    if selected_size_ranges:
        size_clauses = []
        for r in selected_size_ranges:
            if r == "lt500":
                size_clauses.append(Video.file_size_mb < 500)
            elif r == "500_1000":
                size_clauses.append(and_(Video.file_size_mb >= 500, Video.file_size_mb < 1000))
            elif r == "1000_2000":
                size_clauses.append(and_(Video.file_size_mb >= 1000, Video.file_size_mb < 2000))
            elif r == "2000_4000":
                size_clauses.append(and_(Video.file_size_mb >= 2000, Video.file_size_mb < 4000))
            elif r == "gt4000":
                size_clauses.append(Video.file_size_mb >= 4000)
        if size_clauses:
            query = query.filter(or_(*size_clauses))

    if selected_duration_ranges:
        duration_clauses = []
        for r in selected_duration_ranges:
            if r == "lt300":
                duration_clauses.append(Video.duration < 300)
            elif r == "300_600":
                duration_clauses.append(and_(Video.duration >= 300, Video.duration < 600))
            elif r == "600_1200":
                duration_clauses.append(and_(Video.duration >= 600, Video.duration < 1200))
            elif r == "1200_1800":
                duration_clauses.append(and_(Video.duration >= 1200, Video.duration < 1800))
            elif r == "gt1800":
                duration_clauses.append(Video.duration >= 1800)
        if duration_clauses:
            query = query.filter(or_(*duration_clauses))

    if aspect != "All":
        if aspect == "Horizontal":
            query = query.filter(Video.width > Video.height)
        elif aspect == "Vertical":
            query = query.filter(Video.height > Video.width)
        elif aspect == "Square":
            query = query.filter(Video.width == Video.height)
    
    
    if dateMin:
        try: query = query.filter(Video.created_at >= datetime.datetime.fromisoformat(dateMin))
        except ValueError: pass
    if dateMax:
        try: query = query.filter(Video.created_at < datetime.datetime.fromisoformat(dateMax) + datetime.timedelta(days=1))
        except ValueError: pass

    if sort in ("date_desc", "newest"): query = query.order_by(desc(Video.id))
    elif sort in ("date_asc", "oldest"): query = query.order_by(asc(Video.id))
    elif sort in ("title_asc", "a-z"): query = query.order_by(asc(Video.title))
    elif sort in ("title_desc", "z-a"): query = query.order_by(desc(Video.title))
    elif sort in ("longest", "duration_desc"): query = query.order_by(desc(Video.duration))
    elif sort in ("shortest", "duration_asc"): query = query.order_by(case((Video.duration > 0, 0), else_=1), asc(Video.duration))
    elif sort in ("size_desc", "biggest", "size"): query = query.order_by(desc(Video.file_size_mb))
    elif sort in ("size_asc", "smallest"): query = query.order_by(case((Video.file_size_mb > 0, 0), else_=1), asc(Video.file_size_mb))
    
    if poor_thumb_only:
        # Thumbnail quality depends on the actual image, not just database
        # fields. Apply it before pagination so later matches are not hidden.
        from app.maintenance import thumbnail_quality
        videos = []
        matched = 0
        offset = 0
        start = (page - 1) * limit
        while len(videos) < limit:
            chunk = query.offset(offset).limit(256).all()
            if not chunk:
                break
            offset += len(chunk)
            for video in chunk:
                if thumbnail_quality(video)["status"] != "poor":
                    continue
                if matched >= start:
                    videos.append(video)
                matched += 1
                if len(videos) == limit:
                    break
    else:
        videos = query.offset((page - 1) * limit).limit(limit).all()
    
    # Note: Beeg video auto-refresh was removed from GET /videos to prevent thread spam and NameErrors.
    # Link refresh should be handled via a dedicated scheduled task or JIT during playback.
    # Gallery list is read-only: no disk stat, no ORM mutation, no commit.
    # Fetch mirror metadata once for the whole page.  This keeps gallery
    # scrolling O(1) queries per page rather than issuing one query per card.
    video_ids = [v.id for v in videos if v and v.id]
    source_rows = (
        db.query(VideoSource.video_id, VideoSource.label)
        .filter(VideoSource.video_id.in_(video_ids))
        .order_by(VideoSource.video_id.asc(), VideoSource.is_primary.desc(), VideoSource.id.asc())
        .all()
        if video_ids else []
    )
    source_meta: dict[int, list[str]] = {}
    source_counts: dict[int, int] = {}
    for video_id, label in source_rows:
        source_counts[video_id] = source_counts.get(video_id, 0) + 1
        labels = source_meta.setdefault(video_id, [])
        clean_label = str(label or "Unknown").strip() or "Unknown"
        if clean_label not in labels:
            labels.append(clean_label)

    return [
        _gallery_card_payload(v, source_counts.get(v.id, 1), source_meta.get(v.id, []))
        for v in videos if v and v.title
    ]

from pydantic import BaseModel
class DuplicateCheckRequest(BaseModel):
    urls: List[str]

@api_v1_router.post("/videos/exists")
def check_duplicates(req: DuplicateCheckRequest, db: Session = Depends(get_db)):
    normalized_urls = [u.strip() for u in req.urls if u.strip()]
    if not normalized_urls:
        return {"existing": []}
        
    existing = db.query(Video.source_url, Video.url).filter(
        or_(
            Video.source_url.in_(normalized_urls),
            Video.url.in_(normalized_urls)
        )
    ).all()
    
    found_urls = set()
    for e in existing:
        if e.source_url and e.source_url in normalized_urls:
            found_urls.add(e.source_url)
        if e.url and e.url in normalized_urls:
            found_urls.add(e.url)
            
    return {"existing": list(found_urls)}


@api_v1_router.post("/videos/library-status")
def video_library_status(req: DuplicateCheckRequest, db: Session = Depends(get_db)):
    """Return small, extension-safe library badges for exact source/direct URLs."""
    normalized_urls = list(dict.fromkeys(u.strip() for u in req.urls if u and u.strip()))[:500]
    if not normalized_urls:
        return {"matches": {}}

    url_map = {}
    candidates = set()
    tg_lookups = []

    for u in normalized_urls:
        url_map.setdefault(u, set()).add(u)
        candidates.add(u)

        clean_slash = u.rstrip("/")
        slash_variant = clean_slash + "/"
        url_map.setdefault(clean_slash, set()).add(u)
        url_map.setdefault(slash_variant, set()).add(u)
        candidates.add(clean_slash)
        candidates.add(slash_variant)

        if u.startswith("https://"):
            http_var = "http://" + u[8:]
            url_map.setdefault(http_var, set()).add(u)
            candidates.add(http_var)
        elif u.startswith("http://"):
            https_var = "https://" + u[7:]
            url_map.setdefault(https_var, set()).add(u)
            candidates.add(https_var)

        tg_stream = re.search(r"/telegram/stream/(-?\d+)/(\d+)", u)
        tg_web = re.search(r"t\.me/(?:c/)?([a-zA-Z0-9_-]+)/(\d+)", u)
        if tg_stream:
            raw_cid, mid = tg_stream.group(1), int(tg_stream.group(2))
            cids = [raw_cid]
            if raw_cid.startswith("-100"):
                cids.append(raw_cid[4:])
            elif raw_cid.startswith("-"):
                cids.append(raw_cid[1:])
            else:
                cids.append(f"-100{raw_cid}")
                cids.append(f"-{raw_cid}")
            tg_lookups.append((cids, mid, u))
        elif tg_web:
            raw_cid, mid = tg_web.group(1), int(tg_web.group(2))
            cids = [raw_cid]
            if raw_cid.startswith("-100"):
                cids.append(raw_cid[4:])
            elif raw_cid.startswith("-"):
                cids.append(raw_cid[1:])
            else:
                cids.append(f"-100{raw_cid}")
                cids.append(f"-{raw_cid}")
            tg_lookups.append((cids, mid, u))

    conds = [Video.source_url.in_(candidates), Video.url.in_(candidates)]
    for cids, mid, _ in tg_lookups:
        conds.append((Video.telegram_chat_id.in_(cids)) & (Video.telegram_message_id == mid))

    rows = db.query(
        Video.id, Video.source_url, Video.url, Video.telegram_chat_id, Video.telegram_message_id, Video.storage_type
    ).filter(or_(*conds)).all()

    source_rows = db.query(VideoSource.video_id, VideoSource.source_url, VideoSource.url).filter(
        or_(VideoSource.source_url.in_(candidates), VideoSource.url.in_(candidates))
    ).all()

    matches = {}
    local_storage_types = {"local", "local_direct", "bittorrent"}

    def add_match(orig_url, vid_id, storage_type):
        if orig_url in normalized_urls and orig_url not in matches:
            matches[orig_url] = {
                "video_id": vid_id,
                "in_dashboard": True,
                "on_disk": (storage_type or "").lower() in local_storage_types,
                "storage_type": storage_type or "remote",
            }

    for row in rows:
        for val in (row.source_url, row.url):
            if val and val in url_map:
                for orig in url_map[val]:
                    add_match(orig, row.id, row.storage_type)
        if row.telegram_chat_id and row.telegram_message_id:
            for cids, mid, orig in tg_lookups:
                if str(row.telegram_chat_id) in cids and row.telegram_message_id == mid:
                    add_match(orig, row.id, row.storage_type)

    for srow in source_rows:
        for val in (srow.source_url, srow.url):
            if val and val in url_map:
                for orig in url_map[val]:
                    add_match(orig, srow.video_id, "remote")

    return {"matches": matches}


@api_v1_router.post("/discovery-hub/import-status")
def discovery_hub_import_status(req: DuplicateCheckRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Look up exact file URLs; a batch label is not an import identity."""
    from .database import ImportJobItem
    urls = list(dict.fromkeys(u.strip() for u in req.urls if u and u.strip()))[:250]
    if not urls:
        return {"matches": {}}
    requested = set(urls)
    matches = {}
    videos = db.query(Video.id, Video.url, Video.source_url, Video.status).filter(
        or_(Video.url.in_(urls), Video.source_url.in_(urls))
    ).order_by(Video.id.desc()).all()
    for video in videos:
        for url in (video.url, video.source_url):
            if url in requested and url not in matches:
                matches[url] = {"status": "in_library", "video_id": video.id,
                                "video_status": video.status, "in_dashboard": True}
    items = db.query(ImportJobItem).filter(
        or_(ImportJobItem.url.in_(urls), ImportJobItem.source_url.in_(urls))
    ).order_by(ImportJobItem.id.desc()).all()
    item_video_ids = {item.video_id for item in items if item.video_id}
    existing_ids = {row.id for row in db.query(Video.id).filter(Video.id.in_(item_video_ids)).all()} if item_video_ids else set()
    seen = set()
    for item in items:
        for url in (item.url, item.source_url):
            if url not in requested or url in seen:
                continue
            seen.add(url)
            previous = matches.get(url, {})
            in_dashboard = bool(previous.get("in_dashboard") or item.video_id in existing_ids)
            status = "unverified" if item.status in {"imported", "duplicate"} and not in_dashboard else item.status
            matches[url] = {**previous, "status": status, "job_id": item.job_id,
                            "item_id": item.id, "error": item.error or "",
                            "video_id": item.video_id or previous.get("video_id"),
                            "in_dashboard": in_dashboard}
    return {"matches": matches}

class RefreshThumbsByIdsRequest(BaseModel):
    video_ids: List[int] = []
    all_no_thumb: bool = False

@api_v1_router.post("/videos/refresh-thumbnails")
def refresh_thumbnails_by_ids(req: RefreshThumbsByIdsRequest, bg_tasks: BackgroundTasks, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    if req.all_no_thumb:
        rows = db.query(Video.id).filter(
            or_(Video.thumbnail_path == None, Video.thumbnail_path == '', Video.thumbnail_path == '/static/placeholder.jpg')
        ).all()
        ids = [vid for vid, in rows]
    else:
        ids = [i for i in (req.video_ids or []) if isinstance(i, int)]
    if not ids:
        return {"status": "ok", "message": "No videos without thumbnails found.", "count": 0}
    ids = ids[:500]  # cap
    processor = VIPVideoProcessor()

    async def _run():
        for vid_id in ids:
            try:
                await processor.process_single_video(vid_id, force=True, quality_mode="mp4", extractor="auto")
            except Exception as e:
                logging.error(f"Thumbnail refresh failed for video {vid_id}: {e}")

    bg_tasks.add_task(_run)
    return {"status": "ok", "message": f"Thumbnail refresh started for {len(ids)} videos.", "count": len(ids)}

@api_v1_router.get("/videos/continue-watching")
def get_continue_watching(limit: int = 15, db: Session = Depends(get_db)):
    limit = _bounded_limit(limit, maximum=100, default=15)
    videos = db.query(Video).filter(Video.resume_time > 0, Video.duration > 0, Video.resume_time < Video.duration - 10).order_by(Video.last_checked.desc()).limit(limit).all()
    results = []
    for v in videos:
        video_dict = dict(v.__dict__)
        video_dict.pop('_sa_instance_state', None)
        video_dict["playback_health"] = _derive_video_playback_health(v)
        results.append(video_dict)
    return results

@api_v1_router.get("/videos/trending")
def get_trending(limit: int = 15, db: Session = Depends(get_db)):
    limit = _bounded_limit(limit, maximum=100, default=15)
    videos = db.query(Video).order_by(Video.views.desc(), Video.id.desc()).limit(limit).all()
    results = []
    for v in videos:
        video_dict = dict(v.__dict__)
        video_dict.pop('_sa_instance_state', None)
        video_dict["playback_health"] = _derive_video_playback_health(v)
        results.append(video_dict)
    return results

@api_v1_router.get("/videos/recent")
def get_recent(limit: int = 15, db: Session = Depends(get_db)):
    limit = _bounded_limit(limit, maximum=100, default=15)
    videos = db.query(Video).order_by(Video.id.desc()).limit(limit).all()
    results = []
    for v in videos:
        video_dict = dict(v.__dict__)
        video_dict.pop('_sa_instance_state', None)
        video_dict["playback_health"] = _derive_video_playback_health(v)
        results.append(video_dict)
    return results

@api_v1_router.get("/videos/thumbnails")
def get_video_thumbnails(ids: str, db: Session = Depends(get_db)):
    """Lightweight poll endpoint — returns thumbnail_path for a list of video IDs."""
    try:
        id_list = [int(i) for i in ids.split(',') if i.strip().isdigit()]
    except Exception:
        return []
    if not id_list:
        return []
    id_list = list(dict.fromkeys(id_list))[:500]
    rows = db.query(Video.id, Video.thumbnail_path).filter(Video.id.in_(id_list)).all()
    return [{"id": r.id, "thumbnail_path": r.thumbnail_path} for r in rows]


@api_v1_router.get("/creators")
def get_creators(limit: int = 50, db: Session = Depends(get_db)):
    """Fetch unique models/creators and aggregate stats."""
    limit = _bounded_limit(limit, maximum=500, default=50)
    videos = db.query(Video.models, Video.duration, Video.views).filter(Video.models != "").all()
    creators = {}
    for v in videos:
        if not v.models: continue
        model_list = [m.strip() for m in v.models.split(',') if m.strip()]
        for m in model_list:
            if m not in creators:
                creators[m] = {"name": m, "video_count": 0, "total_duration": 0, "total_views": 0, "thumbnail": ""}
            creators[m]["video_count"] += 1
            creators[m]["total_duration"] += (v.duration or 0)
            creators[m]["total_views"] += (v.views or 0)
    
    # Sort by video count descending
    sorted_creators = sorted(creators.values(), key=lambda x: x["video_count"], reverse=True)
    return {"creators": sorted_creators[:limit]}

@api_v1_router.get("/export")
@api_legacy_router.get("/export")
def export_videos(search: str = "", batch: str = "All", favorites_only: bool = False, quality: str = "All", duration_min: int = 0, duration_max: int = 99999, sort: str = "date_desc", dateMin: Optional[str] = None, dateMax: Optional[str] = None, db: Session = Depends(get_db)):
    query = db.query(Video)
    if search:
        # Use FTS5 for ultra-fast search with fallback to slow LIKE
        numeric_search = search.strip()
        try:
            safe_search = sanitize_fts_query(search)
            if safe_search:
                fts_clause = text("id IN (SELECT rowid FROM videos_fts WHERE videos_fts MATCH :search_term)")
                search_clauses = [fts_clause]
                if numeric_search.isdigit():
                    search_clauses.append(Video.id == int(numeric_search))
                query = query.filter(or_(*search_clauses))
                query = query.params(search_term=f"{safe_search}*")
        except Exception as e:
            logging.warning(f"FTS5 search failed, falling back to LIKE: {e}")
            fallback_clauses = [
                Video.title.contains(search),
                Video.tags.contains(search),
                Video.ai_tags.contains(search),
                Video.batch_name.contains(search),
            ]
            if numeric_search.isdigit():
                fallback_clauses.append(Video.id == int(numeric_search))
            query = query.filter(or_(*fallback_clauses))
    if batch and batch != "All": query = query.filter(Video.batch_name == batch)
    if favorites_only: query = query.filter(Video.is_favorite == True)
    if duration_min > 0:
        query = query.filter(Video.duration >= duration_min)
    if duration_max > 0 and duration_max < 99999:
        query = query.filter(Video.duration <= duration_max)
    if quality != "All":
        if quality == "4K": query = query.filter(Video.height >= 2160)
        elif quality == "1440p": query = query.filter(Video.height >= 1440, Video.height < 2160)
        elif quality in ["1080p", "FHD"]: query = query.filter(Video.height >= 1080, Video.height < 1440)
        elif quality in ["720p", "HD"]: query = query.filter(Video.height >= 720, Video.height < 1080)
        elif quality == "SD": query = query.filter(Video.height < 720)
    
    if dateMin:
        try: query = query.filter(Video.created_at >= datetime.datetime.fromisoformat(dateMin))
        except ValueError: pass
    if dateMax:
        try: query = query.filter(Video.created_at < datetime.datetime.fromisoformat(dateMax) + datetime.timedelta(days=1))
        except ValueError: pass

    if sort in ("date_desc", "newest"): query = query.order_by(desc(Video.id))
    elif sort in ("date_asc", "oldest"): query = query.order_by(asc(Video.id))
    elif sort in ("title_asc", "a-z"): query = query.order_by(asc(Video.title))
    elif sort in ("title_desc", "z-a"): query = query.order_by(desc(Video.title))
    elif sort in ("longest", "duration_desc"): query = query.order_by(desc(Video.duration))
    elif sort in ("shortest", "duration_asc"): query = query.order_by(case((Video.duration > 0, 0), else_=1), asc(Video.duration))
    elif sort in ("size_desc", "biggest", "size"): query = query.order_by(desc(Video.file_size_mb))
    elif sort in ("size_asc", "smallest"): query = query.order_by(case((Video.file_size_mb > 0, 0), else_=1), asc(Video.file_size_mb))
    
    videos = query.all()
    content = [VideoExport.from_orm(v).dict() for v in videos]
    return JSONResponse(content=content, headers={'Content-Disposition': f'attachment; filename="export.json"'})

@api_v1_router.get("/search/subtitles")
@api_legacy_router.get("/search/subtitles")
def search_subs(query: str, db: Session = Depends(get_db)):
    return search_videos_by_subtitle(query, db)

@api_v1_router.get("/search/external")
@api_legacy_router.get("/search/external")
async def search_external(
    bg_tasks: BackgroundTasks,
    query: str,
    source: Optional[str] = None,
    result_limit: int = 20,
    max_total: int = 100,
    per_source_limit: Optional[int] = None,
    include_diagnostics: bool = False,
    save_history: bool = True,
    min_quality: int = 0,
    enrich_unknown: bool = True,
    mode: int = 1,
    orientation: str = "any",
    quick: bool = False,
):
    """
    Search external sources (SimpCity, Telegram, etc.) for media content.
    Returns aggregated results from all available sources.
    """
    if not query or len(query.strip()) < 2:
        raise HTTPException(status_code=400, detail="Query must be at least 2 characters")
    
    try:
        engine = ExternalSearchEngine()
        from .search_pipeline import search_catalog
        raw_sources = [part.strip() for part in str(source or "").split(",") if part.strip()]
        source_keys = None if not raw_sources or raw_sources == ["all"] else raw_sources
        payload = await search_catalog(
            engine, query.strip(), source_keys,
            min_quality=min_quality, per_source_limit=per_source_limit or result_limit,
            total_limit=max_total, enrich_unknown=enrich_unknown,
            mode=2 if mode == 2 else 1,
            orientation=orientation,
            **({"quick": True} if quick else {}),
        )
        results = payload["results"]
        diagnostics = payload["diagnostics"]
        source_breakdown = {}
        for item in results:
            key = item.get("source_key") or item.get("source") or "unknown"
            source_breakdown[key] = source_breakdown.get(key, 0) + 1
        
        if save_history:
            bg_tasks.add_task(_save_quantum_search_history, query.strip(), len(results))
        
        return {
            **payload,
            "query": query,
            "total_results": len(results),
            "sources": list(set(r['source'] for r in results)),
            "source_breakdown": source_breakdown,
            "per_source_limit": per_source_limit,
            "diagnostics": diagnostics,
            "results": results
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")
    
class EnrichRequest(BaseModel):
    urls: list[str]
    timeout_s: float = 10.0


class OrientationProbeRequest(BaseModel):
    urls: list[str]
    timeout_s: float = 6.0


@api_v1_router.post("/search/orientation")
@api_legacy_router.post("/search/orientation")
async def search_orientation(req: OrientationProbeRequest):
    """Zistí skutočné rozmery/orientáciu videí (max 40 URL). Vracia {url: patch}."""
    from .orientation import probe_orientation
    urls = [u for u in req.urls if isinstance(u, str)][:40]
    if not urls:
        return {"orientation": {}, "count": 0}
    patches = await probe_orientation(urls, timeout_s=min(max(req.timeout_s, 2.0), 10.0), max_urls=40)
    return {"orientation": patches, "count": len(patches)}

class DiscoveryHubEnrichRequest(BaseModel):
    items: list[Dict[str, Any]] = []
    urls: list[str] = []
    max_items: int = 20
    deep: bool = True
    basic_album_stats: bool = False

@api_v1_router.post("/search/enrich")
@api_legacy_router.post("/search/enrich")
async def search_enrich(req: EnrichRequest):
    """
    Batch-enrich video URLs with full page metadata:
    quality_variants, file_sizes, performers, tags, upload_date, stream_urls.
    Returns {url: enriched_fields_dict} — URLs that failed are omitted.
    Typical latency: 100 URLs ≈ 4–5s.
    """
    if not req.urls:
        return {"enriched": {}, "count": 0, "timing_ms": 0}
    if len(req.urls) > 200:
        raise HTTPException(status_code=400, detail="Max 200 URLs per batch")

    t0 = time.monotonic()
    service = get_enrichment_service()
    enriched = await service.enrich_urls(req.urls, total_timeout_s=min(req.timeout_s, 30.0))
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    return {
        "enriched": enriched,
        "count":    len(enriched),
        "timing_ms": elapsed_ms,
    }

_DISCOVERY_BUNKR_DOMAINS = (
    "balbums.st", "bunkr.la", "bunkr.si", "bunkr.is", "bunkr-albums.io",
    "bunkr.cr", "bunkr.black", "bunkr.su", "bunkr.pk", "bunkrr.su",
    "bunkr.ws", "bunkr.vc", "bunkr.media", "bunkr.ru", "bunkr.to",
    "bunkr.ac", "bunkr.ph", "bunkr.sk", "bunkr.ps", "bunkr.fi",
    "bunkrr.pics", "findr.to",
)

_BUNKR_EXPLORER_DATA_URL = "https://data.u4582180137.workers.dev/data"
_BUNKR_EXPLORER_API_SERVERS = (
    "https://bunkrarchive.pythonanywhere.com",
    "https://bunkrexplorer.pythonanywhere.com",
    "https://bunkrdata.pythonanywhere.com",
)
_BUNKR_EXPLORER_CACHE: Dict[str, Any] = {
    "albums": [],
    "fetched_at": 0.0,
    "etag": "",
    "error": "",
}
_BUNKR_EXPLORER_CACHE_LOCK = asyncio.Lock()
_BUNKR_EXPLORER_CACHE_TTL_SECONDS = 60 * 60

def _dh_parse_size_to_bytes(value: str) -> int:
    match = re.search(r"([\d,.]+)\s*(TB|GB|MB|KB|B)\b", str(value or ""), re.I)
    if not match:
        return 0
    raw_number = match.group(1).strip()
    if "," in raw_number and "." in raw_number:
        raw_number = raw_number.replace(",", "")
    elif "," in raw_number:
        raw_number = raw_number.replace(",", ".")
    try:
        number = float(raw_number)
    except Exception:
        return 0
    unit = match.group(2).upper()
    multiplier = {
        "B": 1,
        "KB": 1024,
        "MB": 1024 ** 2,
        "GB": 1024 ** 3,
        "TB": 1024 ** 4,
    }.get(unit, 0)
    return int(number * multiplier)

def _dh_format_bytes(value: int) -> str:
    size = int(value or 0)
    if size >= 1024 ** 4:
        return f"{size / (1024 ** 4):.1f} TB"
    if size >= 1024 ** 3:
        return f"{size / (1024 ** 3):.1f} GB"
    if size >= 1024 ** 2:
        return f"{size / (1024 ** 2):.0f} MB"
    if size >= 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size} B" if size > 0 else ""

def _dh_iso_date(value: str) -> str:
    raw = re.sub(r"\s+", " ", str(value or "")).strip()
    if not raw:
        return ""
    formats = (
        "%b %d, %Y",
        "%B %d, %Y",
        "%Y-%m-%d",
        "%d.%m.%Y",
        "%d/%m/%Y",
    )
    for fmt in formats:
        try:
            return datetime.datetime.strptime(raw, fmt).date().isoformat()
        except Exception:
            continue
    return raw[:32]

def _dh_extract_date_after(label: str, text: str) -> str:
    pattern = rf"{re.escape(label)}\s*:?\s*(?:on\s+)?([A-Z][a-z]{{2,8}}\s+\d{{1,2}},\s+\d{{4}}|\d{{4}}-\d{{2}}-\d{{2}}|\d{{1,2}}[./]\d{{1,2}}[./]\d{{4}})"
    match = re.search(pattern, str(text or ""), re.I)
    return _dh_iso_date(match.group(1)) if match else ""


def _dh_extract_first_date(text: str, labels: List[str]) -> str:
    for label in labels:
        value = _dh_extract_date_after(label, text)
        if value:
            return value
    return ""

def _dh_pick_first_date(text: str) -> str:
    value = str(text or "")
    match = re.search(r"\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b", value)
    if match:
        return f"{int(match.group(3)):04d}-{int(match.group(2)):02d}-{int(match.group(1)):02d}"
    match = re.search(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b", value)
    if match:
        return f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
    return ""

def _dh_absolute_url(base_url: str, href: str) -> str:
    if not href:
        return ""
    if href.startswith("//"):
        return "https:" + href
    return urllib.parse.urljoin(base_url, href)

def _dh_is_placeholder_thumb(url: str) -> bool:
    low = str(url or "").lower()
    if not low:
        return True
    # Generic SVG placeholder (Bunkr uses image.svg / video.svg / bunkr.svg for missing thumbs)
    if low.endswith(".svg") or ".svg?" in low:
        return True
    if "bunkr.svg" in low or "image.svg" in low or "video.svg" in low or "placeholder" in low:
        return True
    return False

def _dh_bunkr_row_file_type(row: Dict[str, Any]) -> str:
    if row.get("type") in {"video", "image"}:
        return row["type"]
    title_blob = " ".join(str(row.get(k) or "") for k in ("title", "name")).lower()
    title_exts = re.findall(r"\.([a-z0-9]{2,5})(?=[?#&_\s.]|$)", title_blob)
    final_ext = title_exts[-1] if title_exts else ""
    if final_ext in {"jpg", "jpeg", "png", "gif", "webp", "avif", "bmp"}:
        return "image"
    if final_ext in {"mp4", "mkv", "mov", "webm", "m4v", "avi", "flv", "wmv"}:
        return "video"
    url_blob = " ".join(str(row.get(k) or "") for k in ("url", "cdn")).lower()
    if re.search(r"\.(mp4|mkv|mov|webm|m4v|avi|flv|wmv)(?:[?#&_\s.]|$)", url_blob):
        return "video"
    if re.search(r"\.(jpg|jpeg|png|gif|webp|avif|bmp)(?:[?#&_\s.]|$)", url_blob):
        return "image"
    return "file"

def _dh_video_samples(rows: list[dict], limit: int = 6) -> list[dict]:
    """Only real video thumbnails belong in the Discovery Hub preview strip."""
    samples = []
    for row in rows:
        thumb = row.get("thumbnail") or row.get("thumb") or ""
        if _dh_bunkr_row_file_type(row) != "video" or _dh_is_placeholder_thumb(thumb):
            continue
        samples.append({**row, "thumbnail": thumb, "type": "video"})
        if len(samples) >= limit:
            break
    return samples

def _dh_canonical_url(url: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""
    try:
        parsed = urllib.parse.urlparse(raw)
        host = parsed.netloc.lower().lstrip("www.")
        path = re.sub(r"/+", "/", parsed.path or "/")
        parts = [p for p in path.strip("/").split("/") if p]
        if host in {"bunkrr.pics", "findr.to"} and len(parts) >= 2 and parts[0] == "albums":
            return f"bunkrr:album:{parts[1].lower()}"
        if len(parts) >= 2 and parts[0] in {"a", "album", "albums"}:
            return f"bunkr:album:{parts[1].lower()}"
        if len(parts) >= 2 and parts[0] in {"f", "v"}:
            slug = re.sub(r"\.(mp4|mkv|mov|webm|m4v|avi|jpg|jpeg|png|gif)$", "", parts[1], flags=re.I)
            return f"bunkr:file:{slug.lower()}"
        if host == "bunkrr.pics" and len(parts) >= 2 and parts[0] == "files":
            return f"bunkrr:file:{parts[1].lower()}"
        return f"{host}{path}".lower().rstrip("/")
    except Exception:
        return raw.lower()

def _dh_clean_album_title(text: str) -> str:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    value = re.sub(r"^#\d+\s*", "", value)
    value = re.sub(r"^View album\s+", "", value, flags=re.I)
    value = re.sub(r"\s*\d+\s+files(?:\s+\d+\s+views)?\s*(?:→\s*)?Open\s*$", "", value, flags=re.I)
    value = re.sub(r"\s*(?:→\s*)?Open\s*$", "", value, flags=re.I)
    return value.strip()[:180] or "Bunkr album"

# Static headings that leak in when scraping the client-rendered Bunkr Explorer SPA
# (bunkr-explorer.pages.dev serves these in its shell before JS hydration). They are
# NOT real album titles and must never overwrite the feed-provided title.
_DH_JUNK_ALBUM_TITLES = {
    "settings", "bunkr explorer", "matching albums",
    "albums with matching files", "search options", "login", "logout",
    "explorer", "home", "menu", "search", "bunkr", "bunkrr",
    "bunkr album", "bunkrr.pics", "open", "copy link",
}

# Parent-album statistics live in the bounded, loop-owned HubRuntime TTL cache.

def _dh_is_junk_album_title(text: str) -> bool:
    norm = re.sub(r"\s+", " ", str(text or "").strip().lower())
    return (not norm) or norm in _DH_JUNK_ALBUM_TITLES

def _dh_pick_album_title(feed_title: str, scraped_title: str) -> str:
    """Feed title (from the Bunkr Explorer dataset) is authoritative; the scraped
    SPA-shell title is only a last-resort fallback and must pass the junk filter."""
    feed = (feed_title or "").strip()
    if feed and not _dh_is_junk_album_title(feed) and feed.lower() != "bunkr album":
        return feed
    scraped = (scraped_title or "").strip()
    if scraped and not _dh_is_junk_album_title(scraped):
        return scraped
    # Never fall back to a junk/SPA-shell title; use a neutral default instead.
    if feed and not _dh_is_junk_album_title(feed):
        return feed
    return "Bunkr album"

def _dh_make_item(
    *,
    title: str,
    url: str,
    source: str,
    item_type: str = "album",
    thumbnail: str = "",
    detail_url: str = "",
    file_count: int = 0,
    size_text: str = "",
    size_bytes: int = 0,
    views: int = 0,
    rank: int = 0,
    created_at: str = "",
    updated_at: str = "",
    first_upload_at: str = "",
    last_upload_at: str = "",
    provider: str = "",
    sample_files: Optional[List[Dict[str, Any]]] = None,
    diagnostics: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    canonical = _dh_canonical_url(url or detail_url)
    final_size = int(size_bytes or _dh_parse_size_to_bytes(size_text))
    preview_status = "placeholder" if _dh_is_placeholder_thumb(thumbnail) else "ok"
    badges = []
    if file_count:
        badges.append(f"{file_count} files")
    if final_size:
        badges.append(_dh_format_bytes(final_size))
    if views:
        badges.append(f"{views} views")
    if rank:
        badges.append(f"#{rank}")
    return {
        "id": canonical or url,
        "canonical_url": canonical,
        "url": url,
        "detail_url": detail_url,
        "source": source,
        "provider": provider or source,
        "type": item_type,
        "title": title or "Bunkr",
        "thumbnail": "" if _dh_is_placeholder_thumb(thumbnail) else thumbnail,
        "preview_status": preview_status,
        "file_count": int(file_count or 0),
        "video_count": 0,
        "image_count": 0,
        "size_text": size_text or _dh_format_bytes(final_size),
        "size_bytes": final_size,
        "total_size_bytes": final_size,
        "views": int(views or 0),
        "rank": int(rank or 0),
        "created_at": created_at,
        "updated_at": updated_at,
        "first_upload_at": first_upload_at or created_at,
        "last_upload_at": last_upload_at or updated_at,
        "duration": 0,
        "quality": "",
        "height": 0,
        "width": 0,
        "sample_files": sample_files or [],
        "badges": badges,
        "import_plan": {
            "mode": "album" if item_type == "album" else "single",
            "url": url,
            "can_expand": item_type == "album",
            "estimated_items": int(file_count or 1),
        },
        "diagnostics": diagnostics or {},
    }

def _dh_bunkr_explorer_image_url(album_id: str, page: int, index: int = 1) -> str:
    if not album_id or not page:
        return ""
    image_file = urllib.parse.quote(f"{album_id}_{max(1, index)}.jpg")
    return f"https://bunkrarchive.pythonanywhere.com/proxy-image/images/{int(page)}/{image_file}"

def _dh_bunkr_explorer_album_url(album_id: str) -> str:
    return f"https://bunkr.cr/a/{str(album_id or '').strip()}"

def _dh_bunkr_explorer_match_score(title: str, query: str, mode: str = "broad") -> int:
    title_low = re.sub(r"\s+", " ", str(title or "").lower()).strip()
    query_low = re.sub(r"\s+", " ", str(query or "").lower()).strip()
    if not title_low or not query_low:
        return 0

    terms = [term for term in re.split(r"[\s._,\-;|/]+", query_low) if term]
    if not terms:
        return 0

    if mode == "strict":
        pattern = r"[\s._\-]*".join(re.escape(term) for term in terms)
        return 100 if re.search(pattern, title_low, re.I) else 0
    if mode == "whole_word":
        return 90 if all(re.search(rf"(^|[\s.\-,;()[\]{{}}]){re.escape(term)}(?=$|[\s.\-,;()[\]{{}}])", title_low, re.I) for term in terms) else 0
    if mode == "substring":
        return 80 if all(term in title_low for term in terms) else 0
    if mode in {"fuzzy", "ignore_spacing"}:
        compact_title = re.sub(r"[\s._\-;|/,]+", "", title_low)
        compact_query = re.sub(r"[\s._\-;|/,]+", "", query_low)
        return 85 if compact_query in compact_title else 0

    score = 0
    for term in terms:
        if term in title_low:
            score += 12
    if query_low in title_low:
        score += 40
    if title_low.startswith(query_low):
        score += 20
    return score

def _dh_bunkr_explorer_row_to_item(row: Dict[str, Any], *, provider: str, diagnostics: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    album_id = str(row.get("id") or row.get("objectID") or row.get("album_id") or "").strip()
    if not album_id:
        return None
    title = str(row.get("title") or row.get("album_title") or row.get("name") or album_id).strip()
    page = 0
    try:
        page = int(row.get("page") or row.get("_page") or 0)
    except Exception:
        page = 0
    preview_count = 0
    try:
        preview_count = int(row.get("i_c") or row.get("image_count") or row.get("preview_count") or 0)
    except Exception:
        preview_count = 0

    url = str(row.get("url") or row.get("album_url") or row.get("source_url") or "").strip()
    if not url.startswith("http"):
        url = _dh_bunkr_explorer_album_url(album_id)

    size_text = str(row.get("total_size") or row.get("size_text") or "")
    created_at = _dh_iso_date(str(row.get("album_date") or row.get("created_at") or ""))
    updated_at = _dh_iso_date(str(row.get("updated_at") or "")) or created_at
    file_count = 0
    try:
        file_count = int(row.get("file_count") or row.get("files") or 0)
    except Exception:
        file_count = 0

    thumb = str(row.get("thumbnail") or row.get("thumbnail_url") or "")
    if not thumb and page and preview_count > 0:
        thumb = _dh_bunkr_explorer_image_url(album_id, page, 1)

    sample_files = []
    if page and preview_count > 0:
        sample_files = [
            {
                "url": "",
                "title": f"Preview {idx}",
                "thumbnail": _dh_bunkr_explorer_image_url(album_id, page, idx),
                "type": "image",
            }
            for idx in range(1, min(preview_count, 6) + 1)
        ]

    item = _dh_make_item(
        title=_dh_clean_album_title(title),
        url=url,
        detail_url=f"https://bunkr-explorer.pages.dev/explorer/{urllib.parse.quote(album_id)}",
        thumbnail=thumb,
        source="Bunkr Explorer",
        item_type="album",
        file_count=file_count,
        size_text=size_text,
        created_at=created_at,
        updated_at=updated_at,
        first_upload_at=created_at,
        last_upload_at=updated_at,
        provider=provider,
        sample_files=sample_files,
        diagnostics={
            "matched_by": provider,
            "album_id": album_id,
            "explorer_page": page,
            "preview_count": preview_count,
            "metadata_limited": not bool(created_at or file_count or size_text),
            **(diagnostics or {}),
        },
    )
    item["image_count"] = preview_count
    if preview_count and not file_count:
        item["badges"] = [*(item.get("badges") or []), f"{preview_count} previews"]
    if not created_at:
        item["last_upload_at"] = ""
        item["updated_at"] = ""
    return item

async def _dh_fetch_bunkr_explorer_feed(force: bool = False) -> List[Dict[str, Any]]:
    now = time.monotonic()
    cached = _BUNKR_EXPLORER_CACHE.get("albums") or []
    if cached and not force and now - float(_BUNKR_EXPLORER_CACHE.get("fetched_at") or 0) < _BUNKR_EXPLORER_CACHE_TTL_SECONDS:
        return cached

    async with _BUNKR_EXPLORER_CACHE_LOCK:
        now = time.monotonic()
        cached = _BUNKR_EXPLORER_CACHE.get("albums") or []
        if cached and not force and now - float(_BUNKR_EXPLORER_CACHE.get("fetched_at") or 0) < _BUNKR_EXPLORER_CACHE_TTL_SECONDS:
            return cached

        headers = {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Nexus/DiscoveryHub",
        }
        if _BUNKR_EXPLORER_CACHE.get("etag"):
            headers["If-None-Match"] = str(_BUNKR_EXPLORER_CACHE["etag"])

        try:
            from .discovery_hub_runtime import hub_get
            resp = await hub_get(_BUNKR_EXPLORER_DATA_URL, headers=headers, timeout=12, accepted=(200, 304), max_bytes=64 * 1024 * 1024)
            if resp.status_code == 304 and cached:
                _BUNKR_EXPLORER_CACHE["fetched_at"] = now
                return cached
            payload = resp.json()
            albums = []
            if isinstance(payload, list):
                for page in payload:
                    if isinstance(page, dict):
                        albums.extend({**album, "page": page.get("page") or 0} for album in page.get("albums") or [] if isinstance(album, dict))
            _BUNKR_EXPLORER_CACHE.update({"albums": albums, "fetched_at": now, "etag": resp.headers.get("ETag") or "", "error": ""})
            return albums
        except Exception as exc:
            _BUNKR_EXPLORER_CACHE["error"] = str(exc)
            logging.debug("[DISCOVERY_HUB] Bunkr Explorer feed failed: %s", exc)
            return cached

async def _dh_search_bunkr_explorer_api(query: str, sort: str, mode: str, limit: int) -> List[Dict[str, Any]]:
    if not query:
        return []
    params = {
        "q": query,
        "sort": sort if sort in {"latest", "size", "files"} else "latest",
    }
    if mode in {"fuzzy", "ignore_spacing"}:
        params["ignore_spacing"] = "true"
    else:
        params.update({
            "strict": "false",
            "whole_word": "false",
            "substring": "false",
            "ignore_spacing": "false",
        })

    headers = {"Accept": "application/json", "User-Agent": "Mozilla/5.0 Nexus/DiscoveryHub"}
    for server in _BUNKR_EXPLORER_API_SERVERS:
        try:
            from .discovery_hub_runtime import hub_get
            resp = await hub_get(f"{server}/api/search", params=params, headers=headers, timeout=6)
            data = resp.json()
            rows = data.get("album_results") or []
            items = []
            for row in rows[: max(limit * 2, limit)]:
                if not isinstance(row, dict):
                    continue
                item = _dh_bunkr_explorer_row_to_item(
                    row,
                    provider="bunkr_explorer_api",
                    diagnostics={"api_server": server},
                )
                if item:
                    items.append(item)
            if items:
                return items[:limit]
        except Exception as exc:
            logging.debug("[DISCOVERY_HUB] Bunkr Explorer API failed %s: %s", server, exc)
    return []

async def _dh_search_bunkr_explorer_feed(query: str, mode: str, sort: str, limit: int, page: int) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    albums = await _dh_fetch_bunkr_explorer_feed()
    if not albums:
        return [], {
            "bunkr_explorer_total": 0,
            "bunkr_explorer_error": _BUNKR_EXPLORER_CACHE.get("error") or "",
        }

    scored = []
    if query:
        for row in albums:
            score = _dh_bunkr_explorer_match_score(str(row.get("title") or ""), query, mode)
            if score > 0:
                scored.append((score, row))
    else:
        # The public feed does not expose upload dates; page order is only an index order.
        scored = [(1, row) for row in albums[: max(limit * page, limit)]]

    if sort == "files":
        scored.sort(key=lambda pair: int(pair[1].get("file_count") or pair[1].get("i_c") or 0), reverse=True)
    elif sort == "size":
        scored.sort(key=lambda pair: _dh_parse_size_to_bytes(str(pair[1].get("total_size") or "")), reverse=True)
    else:
        scored.sort(key=lambda pair: (pair[0], int(pair[1].get("i_c") or 0)), reverse=True)

    start = max(0, (max(1, page) - 1) * limit)
    rows = scored[start:start + limit]
    items = []
    for score, row in rows:
        item = _dh_bunkr_explorer_row_to_item(
            row,
            provider="bunkr_explorer_feed",
            diagnostics={"score": score, "feed_total": len(albums)},
        )
        if item:
            items.append(item)

    return items, {
        "bunkr_explorer_total": len(scored),
        "bunkr_explorer_feed_total": len(albums),
        "bunkr_explorer_page": page,
        "bunkr_explorer_total_pages": max(1, (len(scored) + limit - 1) // limit),
        "bunkr_explorer_provider": "bunkr_explorer_feed",
    }

async def _dh_fetch_bunkrr_detail_meta(detail_url: str) -> Dict[str, Any]:
    if not detail_url:
        return {}
    try:
        from .discovery_hub_runtime import hub_get
        response = await hub_get(detail_url, timeout=8, headers={"User-Agent": "Mozilla/5.0 Nexus/DiscoveryHub"})
        html = response.text
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        page_text = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))
        created_at = _dh_extract_first_date(page_text, ["Created", "Uploaded", "Added", "First upload"])
        updated_at = _dh_extract_first_date(page_text, ["Last upload", "Last updated", "Updated"])
        title = soup.find(["h1", "h2"])
        raw_title = title.get_text(" ", strip=True) if title else ""
        # bunkr-explorer.pages.dev is a client-rendered SPA; its first heading is the
        # static shell ("Settings"/"Bunkr Explorer"/...), never the real album title.
        if _dh_is_junk_album_title(raw_title):
            raw_title = ""
        source_link = soup.find("a", href=lambda h: h and re.search(r"https?://(?:[^/]*\.)?bunkr", h or "", re.I) and "/a/" in h)
        file_count = 0
        count_match = re.search(r"(\d+)\s+files", page_text, re.I)
        if count_match:
            file_count = int(count_match.group(1))
        return {
            "title": raw_title,
            "url": source_link.get("href", "") if source_link else "",
            "created_at": created_at,
            "updated_at": updated_at,
            "first_upload_at": created_at,
            "last_upload_at": updated_at,
            "file_count": file_count,
        }
    except Exception as exc:
        logging.debug("[DISCOVERY_HUB] bunkrr detail meta failed %s: %s", detail_url, exc)
        return {}

def _dh_cached_album_card(item: Dict[str, Any]) -> Dict[str, Any]:
    """Attach known album listing metadata without waiting for the network."""
    if item.get("type", "album") != "album":
        return item
    from app import bunkr_cache
    url = item.get("url") or item.get("source_url") or ""
    cached = bunkr_cache.album_get(url, ignore_ttl=True)
    snapshot = bunkr_cache.album_snapshot_get(url) or {}
    rows = (cached or {}).get("items") or snapshot.get("items") or []
    if not rows:
        return item
    saved = {row.get("url"): row for row in snapshot.get("items", []) if row.get("url")}
    rows = [{**saved.get(row.get("url"), {}), **{k: v for k, v in row.items() if v not in (None, "", 0)}} for row in rows]
    total = sum(int(row.get("size_bytes") or 0) or _dh_parse_size_to_bytes(row.get("size") or "") for row in rows)
    dates = sorted(date for row in rows if (date := _dh_pick_first_date(str(row.get("date") or row.get("uploaded_at") or ""))))
    thumb = next((row.get("thumbnail") or row.get("thumb") for row in rows if (row.get("thumbnail") or row.get("thumb")) and not _dh_is_placeholder_thumb(row.get("thumbnail") or row.get("thumb"))), "")
    return {**item, "file_count": len(rows),
            "video_count": sum(_dh_bunkr_row_file_type(row) == "video" for row in rows),
            "image_count": sum(_dh_bunkr_row_file_type(row) == "image" for row in rows),
            "total_size_bytes": total or item.get("total_size_bytes") or 0,
            "size_bytes": total or item.get("size_bytes") or 0,
            "size_text": _dh_format_bytes(total) if total else item.get("size_text", ""),
            "thumbnail": thumb or item.get("thumbnail") or "",
            "first_upload_at": dates[0] if dates else item.get("first_upload_at", ""),
            "last_upload_at": dates[-1] if dates else item.get("last_upload_at", ""),
            "sample_files": _dh_video_samples(rows),
            "cache_at": (cached or {}).get("at") or snapshot.get("updated_at"), "cached_album": True}


def _dh_cached_file_card(item: Dict[str, Any]) -> Dict[str, Any]:
    """Restore previously fetched video metadata onto a search result."""
    if item.get("type") not in {"video", "file"}:
        return item
    from app import bunkr_cache
    cached = bunkr_cache.file_meta_get(item.get("url") or item.get("source_url") or "")
    if not cached:
        return item
    merged = dict(item)
    for field in ("duration", "width", "height", "quality", "size", "size_bytes", "size_verified", "metadata_state"):
        value = cached.get(field)
        if value not in (None, "", 0, False) and (field in {"size", "size_bytes"} and cached.get("size_verified") or not merged.get(field)):
            merged[field] = value
    if cached.get("size_bytes") and (cached.get("size_verified") or not item.get("total_size_bytes")):
        merged["total_size_bytes"] = cached["size_bytes"]
        merged["size_text"] = _dh_format_bytes(cached["size_bytes"])
    if _dh_is_placeholder_thumb(merged.get("thumbnail") or "") and not _dh_is_placeholder_thumb(cached.get("thumbnail") or ""):
        merged["thumbnail"] = cached["thumbnail"]
        merged["preview_status"] = "ok"
    merged["cached_file"] = True
    return merged


async def _dh_fetch_bunkr_enrichment(item: Dict[str, Any], semaphore: asyncio.Semaphore, basic_album_stats: bool = False) -> Dict[str, Any]:
    async with semaphore:
        url = str(item.get("url") or item.get("detail_url") or "").strip()
        detail_url = str(item.get("detail_url") or "").strip()
        target_url = url
        path = urllib.parse.urlparse(target_url).path.lower()
        is_album = "/a/" in path or "/album/" in path or "/albums/" in path or item.get("type") == "album"
        try:
            from app.extractors.bunkr import BunkrExtractor
            extractor = BunkrExtractor()
            if is_album:
                provider = str(item.get("provider") or "").lower()
                is_bunkrr_result = "bunkrr" in provider or "bunkrr.pics" in urllib.parse.urlparse(target_url).netloc.lower()
                # Fetch the album's lightweight listing in parallel with the
                # optional detail page. The old path resolved every file page
                # before returning a card, which turned a single search result
                # into N extra HTTP requests.
                detail_task = asyncio.create_task(_dh_fetch_bunkrr_detail_meta(detail_url))
                rows_task = asyncio.create_task(
                    extractor.extract_album(target_url, listing_only=True)
                )
                detail_meta, rows = await asyncio.gather(detail_task, rows_task)
                from app import bunkr_cache
                old_listing = bunkr_cache.album_get(target_url, ignore_ttl=True)
                old_rows = (old_listing or {}).get("items") or []
                def listing_signature(row):
                    return (str(row.get("title") or row.get("name") or ""), str(row.get("size") or row.get("size_bytes") or ""))
                old_by_url = {str(row.get("url")): listing_signature(row) for row in old_rows if row.get("url")}
                new_by_url = {str(row.get("url")): listing_signature(row) for row in rows if row.get("url")}
                added = len(new_by_url.keys() - old_by_url.keys()) if old_listing and rows else 0
                removed = len(old_by_url.keys() - new_by_url.keys()) if old_listing and rows else 0
                changed = sum(old_by_url[key] != new_by_url[key] for key in old_by_url.keys() & new_by_url.keys()) if old_listing and rows else 0
                if rows:
                    bunkr_cache.album_put(target_url, rows, title=item.get("title") or "")
                    bunkr_cache.album_snapshot_put(target_url, rows, title=item.get("title") or "")
                sample_files = []
                total_size = 0
                image_count = 0
                video_count = 0
                for row in rows[:8]:
                    title = row.get("title") or row.get("name") or ""
                    file_url = row.get("url") or ""
                    thumb = row.get("thumb") or ""
                    size_text = row.get("size") or ""
                    size_bytes = _dh_parse_size_to_bytes(size_text)
                    total_size += size_bytes
                    file_type = _dh_bunkr_row_file_type(row)
                    if file_type == "video":
                        video_count += 1
                    elif file_type == "image":
                        image_count += 1
                    sample_files.append({
                        "url": file_url,
                        "title": title,
                        "thumbnail": thumb,
                        "size_text": size_text,
                        "size_bytes": size_bytes,
                        "type": file_type,
                    })
                if len(rows) > len(sample_files):
                    for row in rows[8:]:
                        size_text = row.get("size") or ""
                        total_size += _dh_parse_size_to_bytes(size_text)
                        file_type = _dh_bunkr_row_file_type(row)
                        if file_type == "video":
                            video_count += 1
                        elif file_type == "image":
                            image_count += 1

                # Missing file details stay opt-in in Album Viewer.
                first = sample_files[0] if sample_files else {}

                # Parse file upload dates from .theDate elements (format: "HH:MM:SS DD/MM/YYYY")
                file_dates: list[str] = []
                for row in rows:
                    raw = (row.get("date") or "").strip()
                    if not raw:
                        continue
                    iso = _dh_pick_first_date(raw)
                    if iso:
                        file_dates.append(iso)
                dates_first_upload = min(file_dates) if file_dates else ""
                dates_last_upload = max(file_dates) if file_dates else ""

                video_rows = [row for row in rows if _dh_bunkr_row_file_type(row) == "video"]
                saved_snapshot = bunkr_cache.album_snapshot_get(target_url) or {}
                saved_files = {f.get("url"): f for f in saved_snapshot.get("items", []) if f.get("url")}
                for row in video_rows:
                    saved = saved_files.get(row.get("url"), {})
                    cached = bunkr_cache.file_meta_get(row.get("url") or "") or {}
                    if _dh_is_placeholder_thumb(row.get("thumbnail") or row.get("thumb") or ""):
                        row["thumbnail"] = saved.get("thumbnail") or cached.get("thumbnail") or ""
                sample_files = _dh_video_samples(video_rows)
                # Explicit fetch repairs missing video samples; automatic stats stays lightweight.
                if not basic_album_stats and len(sample_files) < min(6, len(video_rows)):
                    missing_rows = [row for row in video_rows if row.get("url") and
                                    _dh_is_placeholder_thumb(row.get("thumbnail") or row.get("thumb") or "")][:12]
                    sample_gate = asyncio.Semaphore(4)
                    async def resolve_sample(row):
                        try:
                            async with sample_gate:
                                result = await extractor.extract(row["url"], metadata_only=True)
                            thumb = (result or {}).get("thumbnail") or ""
                            if not _dh_is_placeholder_thumb(thumb):
                                row["thumbnail"] = thumb
                                existing_meta = bunkr_cache.file_meta_get(row["url"]) or {}
                                bunkr_cache.file_meta_put(row["url"], {**existing_meta, "thumbnail": thumb})
                        except Exception:
                            pass
                    await asyncio.gather(*(resolve_sample(row) for row in missing_rows))
                    sample_files = _dh_video_samples(video_rows)
                    bunkr_cache.album_snapshot_put(target_url, video_rows, title=item.get("title") or "")
                    bunkr_cache.file_meta_flush()

                # Pick best available thumbnail from actual video rows first. Some Bunkr albums
                # start with archives or screenshots, so their first item only exposes file.svg/image.svg.
                best_thumb = ""
                for row in video_rows:
                    candidate = row.get("thumb") or row.get("thumbnail") or ""
                    if candidate and not _dh_is_placeholder_thumb(candidate):
                        best_thumb = candidate
                        break

                if not best_thumb:
                    for candidate in [first.get("thumbnail")] + [f.get("thumbnail") for f in sample_files] + [item.get("thumbnail")]:
                        if candidate and not _dh_is_placeholder_thumb(candidate):
                            best_thumb = candidate
                            break

                # If still no real thumbnail, open a bounded number of video file pages and use
                # their OG/video cover. This handles albums whose listing starts with archives.
                if not best_thumb and not is_bunkrr_result and not basic_album_stats:
                    candidates_for_thumb = [row for row in video_rows if row.get("url")][:12]
                    for candidate_file in candidates_for_thumb:
                        try:
                            extracted = await extractor.extract(candidate_file["url"])
                            if extracted:
                                t = extracted.get("thumbnail", "")
                                if t and not _dh_is_placeholder_thumb(t):
                                    best_thumb = t
                                    break
                        except Exception:
                            pass

                # Bunkr Explorer feed/API items already carry the canonical preview
                # (bunkrarchive cache, matching the official explorer). bunkr.cr enrichment
                # frequently yields download-arrow placeholders for archived albums, so for
                # explorer items prefer the feed preview over the scraped bunkr.cr thumb.
                is_explorer_item = str(item.get("provider") or "").startswith("bunkr_explorer")
                feed_thumb = item.get("thumbnail") or ""
                if is_explorer_item and feed_thumb and not _dh_is_placeholder_thumb(feed_thumb):
                    final_thumb = feed_thumb
                else:
                    final_thumb = best_thumb or feed_thumb

                has_album_meta = bool(
                    rows
                    and (
                        total_size > 0
                        or dates_first_upload
                        or dates_last_upload
                        or best_thumb
                        or len(rows) > 0
                    )
                )

                return {
                    **item,
                    "title": _dh_pick_album_title(item.get("title"), detail_meta.get("title")),
                    "url": detail_meta.get("url") or item.get("url"),
                    "thumbnail": final_thumb,
                    "preview_status": "ok" if final_thumb else "missing",
                    "file_count": len(rows) or detail_meta.get("file_count") or item.get("file_count") or 0,
                    "video_count": video_count,
                    "image_count": image_count,
                    "size_bytes": total_size or item.get("size_bytes") or 0,
                    "total_size_bytes": total_size or item.get("total_size_bytes") or 0,
                    "size_text": _dh_format_bytes(total_size) if total_size else (item.get("size_text") or ""),
                    "created_at": detail_meta.get("created_at") or item.get("created_at") or "",
                    "updated_at": detail_meta.get("updated_at") or item.get("updated_at") or "",
                    "first_upload_at": dates_first_upload or detail_meta.get("first_upload_at") or item.get("first_upload_at") or item.get("created_at") or "",
                    "last_upload_at": dates_last_upload or detail_meta.get("last_upload_at") or item.get("last_upload_at") or item.get("updated_at") or "",
                    "sample_files": sample_files,
                    "cached_album": bool(rows or old_listing),
                    "album_changes": {"added": added, "removed": removed, "changed": changed},
                    "detail_url": detail_url,
                    "diagnostics": {
                        **(item.get("diagnostics") or {}),
                        "enriched": has_album_meta,
                        "size_resolved_from_files": bool(total_size > 0 and not item.get("size_bytes")),
                    },
                }

            result = await extractor.extract(target_url)
            if not result:
                return {**item, "diagnostics": {**(item.get("diagnostics") or {}), "enriched": False, "error": "extract failed"}}
            stream_url = result.get("stream_url") or ""
            # Size from page HTML (parsed by BunkrExtractor)
            size_from_page = _dh_parse_size_to_bytes(result.get("size") or "")
            size_bytes = 0
            duration = int(result.get("duration") or 0)
            if stream_url:
                from app.mp4_probe import PROBEABLE_EXT_RE, probe_mp4_cached
                bunkr_headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://bunkr.cr/"}
                if PROBEABLE_EXT_RE.search(stream_url):
                    # one ranged GET gives duration (moov/mvhd) AND total size
                    probe = await probe_mp4_cached(target_url, stream_url, headers=bunkr_headers)
                    duration = duration or probe["duration"]
                    size_bytes = probe["size"]
                if not size_bytes:
                    try:
                        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0), follow_redirects=True) as client:
                            head = await client.head(stream_url, headers=bunkr_headers)
                            size_bytes = int(head.headers.get("content-length") or 0)
                            if not size_bytes:
                                rng = await client.get(stream_url, headers={**bunkr_headers, "Range": "bytes=0-0"})
                                m_cr = re.search(r"/(\d+)", rng.headers.get("content-range", ""))
                                if m_cr:
                                    size_bytes = int(m_cr.group(1))
                    except Exception:
                        pass
            final_size = size_bytes or size_from_page or int(item.get("size_bytes") or 0)
            height = int(result.get("height") or 0)
            if not height and stream_url:
                m_res = re.search(r"[/_](2160|1440|1080|720|480|360)p?(?:[/_.-]|$)", stream_url, re.I)
                if m_res:
                    height = int(m_res.group(1))
            quality = "4K" if height >= 2160 else f"{height}p" if height else ""
            return {
                **item,
                "title": result.get("title") or item.get("title"),
                "thumbnail": result.get("thumbnail") or item.get("thumbnail") or "",
                "preview_status": "ok" if (result.get("thumbnail") or item.get("thumbnail")) else "missing",
                "type": "video",
                "file_count": 1,
                "duration": duration,
                "height": height,
                "width": int(result.get("width") or 0),
                "quality": quality,
                "size_bytes": final_size,
                "total_size_bytes": final_size,
                "size_text": _dh_format_bytes(final_size) or item.get("size_text") or "",
                "diagnostics": {**(item.get("diagnostics") or {}), "enriched": True},
            }
        except Exception as exc:
            return {**item, "diagnostics": {**(item.get("diagnostics") or {}), "enriched": False, "error": str(exc)}}


class DiscoveryHubImportRequest(BaseModel):
    item: Dict[str, Any]


@api_v1_router.post("/discovery-hub/import")
async def discovery_hub_import(req: DiscoveryHubImportRequest, auth: bool = Depends(check_auth)):
    from .discovery_hub_import import build_import_request
    try:
        request = await build_import_request(req.item)
    except (ValueError, TimeoutError) as exc:
        raise HTTPException(502, str(exc) or "Album sa nepodarilo načítať včas.") from exc
    except Exception as exc:
        logging.warning("[DiscoveryHub] album import expansion failed: %s", exc)
        raise HTTPException(502, "Zdroj albumu neodpovedá. Skús to znova.") from exc
    # Network expansion is finished before acquiring a DB session.
    with SessionLocal() as db:
        job = create_import_job(request, db)
        payload = serialize_job(job)
    intake_worker.start()
    return {"success": True, "job": payload}


@api_v1_router.post("/discovery-hub/enrich")
@api_legacy_router.post("/discovery-hub/enrich")
async def discovery_hub_enrich(req: DiscoveryHubEnrichRequest):
    raw_items = list(req.items or [])
    for url in req.urls or []:
        raw_items.append(_dh_make_item(title="", url=url, source="Bunkr", item_type="album" if "/a/" in url else "video"))
    # A Discovery Hub page contains up to 100 cards.  Keeping that page in one
    # bounded request lets the UI wait for verified album dates before rendering
    # instead of showing index dates first and reshuffling cards afterwards.
    items = [item for item in raw_items if item.get("url") or item.get("detail_url")][: max(1, min(int(req.max_items or 100), 100))]
    if not items:
        return {"status": "success", "results": [], "count": 0}
    from .discovery_hub_runtime import hub_runtime
    runtime = hub_runtime()
    async def enrich_one(item):
        try:
            async with asyncio.timeout(20):
                return await _dh_fetch_bunkr_enrichment(item, runtime.enrichment, basic_album_stats=req.basic_album_stats)
        except TimeoutError:
            return {**item, "diagnostics": {**(item.get("diagnostics") or {}), "enriched": False, "error": "Metadata timeout"}}
    enriched = await asyncio.gather(*(enrich_one(item) for item in items))
    return {"status": "success", "results": enriched, "count": len(enriched)}



async def _album_files_events(url: str, limit: int = 0):
    """Async generator of Album Viewer events for a Bunkr album:

        {"type": "base",  "items": [...], "total": n,
         "pending": p, "remaining": r}                  listing, available in ~1 request
        {"type": "patch", "url": u, "data": {...}}      one file's enrich result, as it lands
        {"type": "done",  "type_fixes": [urls]}         end; urls whose 'file' type => video
        {"type": "error", "error": "..."}

    `limit` caps how many UNCACHED files get enriched in this call (0 = all).
    Huge albums (hundreds/thousands of files) open with just the first batch;
    the client re-calls with another limit and, because finished files are in
    the disk cache, the enrich window naturally advances to the next batch.

    The blocking endpoint consumes it fully; the streaming endpoint forwards each
    event as an NDJSON line so a 100-file album renders immediately and fills in
    thumbnails/durations progressively instead of blocking for the whole gather.
    """
    def _classify(title: str, file_url: str) -> tuple[str, str]:
        title_exts = re.findall(r"\.([a-z0-9]{2,5})(?=[?#&_\s.]|$)", str(title or "").lower())
        ext = title_exts[-1] if title_exts else ""
        if not ext:
            m = re.search(r"\.([a-z0-9]{2,5})(?:[?#&_\s.]|$)", str(file_url or "").lower())
            ext = m.group(1) if m else ""
        if ext in {"mp4", "mkv", "webm", "mov", "m4v", "avi", "m3u8", "flv", "wmv"}:
            return "video", ext
        if ext in {"jpg", "jpeg", "png", "gif", "webp", "avif", "bmp"}:
            return "image", ext
        return "file", ext

    def _upload_date(raw: str) -> tuple[str, int]:
        m = re.search(r'(?:(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s+)?(\d{1,2})/(\d{1,2})/(\d{4})', str(raw or ""))
        if not m:
            return "", 0
        hh = int(m.group(1) or 0)
        mm = int(m.group(2) or 0)
        ss = int(m.group(3) or 0)
        dd = int(m.group(4))
        mo = int(m.group(5))
        yy = int(m.group(6))
        iso = f"{yy:04d}-{mo:02d}-{dd:02d}T{hh:02d}:{mm:02d}:{ss:02d}"
        return iso, int(f"{yy:04d}{mo:02d}{dd:02d}{hh:02d}{mm:02d}{ss:02d}")

    def _quality(title: str) -> str:
        m = re.search(r"\b(2160|4k|1440|1080|720|480|360)\s*p?\b", title, re.I)
        if not m:
            return ""
        v = m.group(1).lower()
        if v in {"2160", "4k"}:
            return "4K"
        return f"{v}p"

    try:
        from app.extractors.bunkr import BunkrExtractor
        from app import bunkr_cache
        extractor = BunkrExtractor()
        permanent_snapshot = bunkr_cache.album_snapshot_get(url) or {}
        permanent_by_url = {
            str(item.get("url")): dict(item)
            for item in permanent_snapshot.get("items", [])
            if isinstance(item, dict) and item.get("url")
        }
        # The first event is used by the combined Bunkrr workbench.  Do not
        # visit every file page before emitting it: that turns a 300-file merge
        # into hundreds of network requests before the grid can even open.
        raw_items = await extractor.extract_album(url, listing_only=True)
        snapshot_only = False
        if not raw_items:
            # live fetch failed -> serve the last listing we saved to disk
            cached_album = bunkr_cache.album_get(url, ignore_ttl=True)
            if cached_album:
                raw_items = cached_album["items"]
                logging.info("[AlbumFiles] serving cached listing for %s (%d files)",
                             url[:60], len(raw_items))
            elif permanent_by_url:
                # The permanent snapshot is richer than the raw listing and has
                # no expiry. It is the final fallback when Bunkr has renamed or
                # removed the live album page.
                snapshot_only = True
                logging.info("[AlbumFiles] serving permanent snapshot for %s (%d files)",
                             url[:60], len(permanent_by_url))
            else:
                yield {"type": "error", "error": "Album je prázdny alebo nedostupný"}
                return
        else:
            bunkr_cache.album_put(url, raw_items)

        # Build base items from the live/raw listing. When it is unavailable the
        # permanent snapshot already has the exact Album Viewer shape.
        base: list[dict] = []
        if snapshot_only:
            base = [dict(item, stream_url="") for item in permanent_by_url.values()]
        for item in ([] if snapshot_only else raw_items):
            file_url = item.get("url") or ""
            title = item.get("title") or item.get("name") or file_url.rsplit("/", 1)[-1]
            size_text = item.get("size") or ""
            size_bytes = _dh_parse_size_to_bytes(size_text)
            ftype, ext = _classify(title, file_url)
            uploaded_at, uploaded_ts = _upload_date(item.get("date") or "")
            base.append({
                "url": file_url,
                "source_url": item.get("source_url") or url,
                "title": title,
                "thumbnail": item.get("thumb") or "",
                "size": size_text,
                "size_bytes": size_bytes,
                "size_raw": size_bytes,
                "type": ftype,
                "ext": ext,
                "date": item.get("date") or "",
                "uploaded_at": uploaded_at,
                "uploaded_ts": uploaded_ts,
                "quality": _quality(title),
                "stream_url": "",
                "enriched": False,
            })

        # Merge the never-expiring per-album record into the current listing.
        # Live membership remains authoritative when it is available, while a
        # previously learned thumbnail/duration/etc. fills any sparse row.
        for item in base:
            previous = permanent_by_url.get(str(item.get("url") or ""))
            if not previous:
                continue
            for field, value in previous.items():
                if field == "stream_url":
                    continue
                if item.get(field) in (None, "", 0, False, [], {}) and value not in (None, "", 0, False, [], {}):
                    item[field] = value
            if previous.get("enriched"):
                item["enriched"] = True
            # A Bunkr album listing can repeat one stale size across almost every
            # card. A size measured from the CDN range response is authoritative
            # and must replace that listing text on the next open.
            if previous.get("size_verified") and previous.get("size_bytes"):
                for field in ("size", "size_bytes", "size_raw", "size_verified"):
                    if previous.get(field) not in (None, "", 0, False):
                        item[field] = previous[field]

        # Batch check against SQLite history database to prevent re-fetching known items
        from app.database import get_db
        from sqlalchemy import text
        
        db_gen = get_db()
        db = next(db_gen)
        urls = [i["url"] for i in base if i.get("url")]
        db_history_meta = {}
        if urls:
            try:
                for i in range(0, len(urls), 500):
                    chunk = urls[i:i+500]
                    placeholders = ",".join(f":u{idx}" for idx in range(len(chunk)))
                    params = {f"u{idx}": u for idx, u in enumerate(chunk)}
                    def _h_to_q(h: int) -> str:
                        if not h: return ""
                        if h >= 2160: return "4K"
                        if h >= 1440: return "1440p"
                        if h >= 1080: return "FHD"
                        if h >= 720: return "HD"
                        return "SD"
                    
                    # 1. forum_links
                    q_fl = f"SELECT url, duration, size_bytes, quality FROM forum_links WHERE url IN ({placeholders}) AND duration > 0"
                    for row in db.execute(text(q_fl), params).fetchall():
                        url_val, dur_val, size_val, qual_val = row
                        s = int(size_val or 0)
                        db_history_meta[url_val] = {
                            "duration": int(dur_val or 0),
                            "size_bytes": s,
                            "size_raw": s,
                            "size": _dh_format_bytes(s) if s else "",
                            "quality": qual_val or "",
                            "width": 0, "height": 0,
                        }
                    
                    # 2. import_job_items
                    q_iji = f"SELECT url, duration, file_size_mb, quality, width, height FROM import_job_items WHERE url IN ({placeholders}) AND duration > 0"
                    for row in db.execute(text(q_iji), params).fetchall():
                        url_val, dur_val, fs_mb, qual_val, w_val, h_val = row
                        if url_val not in db_history_meta:
                            s = int((fs_mb or 0) * 1024 * 1024)
                            h = int(h_val or 0)
                            db_history_meta[url_val] = {
                                "duration": int(dur_val or 0),
                                "size_bytes": s, "size_raw": s, "size": _dh_format_bytes(s) if s else "",
                                "quality": qual_val or _h_to_q(h),
                                "width": int(w_val or 0), "height": h,
                            }
                            
                    # 3. discovered_videos
                    q_dv = f"SELECT url, duration, file_size_mb, width, height FROM discovered_videos WHERE url IN ({placeholders}) AND duration > 0"
                    for row in db.execute(text(q_dv), params).fetchall():
                        url_val, dur_val, fs_mb, w_val, h_val = row
                        if url_val not in db_history_meta:
                            s = int((fs_mb or 0) * 1024 * 1024)
                            h = int(h_val or 0)
                            db_history_meta[url_val] = {
                                "duration": int(dur_val or 0),
                                "size_bytes": s, "size_raw": s, "size": _dh_format_bytes(s) if s else "",
                                "quality": _h_to_q(h),
                                "width": int(w_val or 0), "height": h,
                            }
                            
                    # 4. videos library
                    q_v = f"SELECT source_url as url, duration, file_size_mb, quality, width, height FROM videos WHERE source_url IN ({placeholders}) AND duration > 0"
                    for row in db.execute(text(q_v), params).fetchall():
                        url_val, dur_val, fs_mb, qual_val, w_val, h_val = row
                        if url_val not in db_history_meta:
                            s = int((fs_mb or 0) * 1024 * 1024)
                            h = int(h_val or 0)
                            db_history_meta[url_val] = {
                                "duration": int(dur_val or 0),
                                "size_bytes": s, "size_raw": s, "size": _dh_format_bytes(s) if s else "",
                                "quality": qual_val or _h_to_q(h),
                                "width": int(w_val or 0), "height": h,
                            }
            except Exception as e:
                logging.debug(f"[AlbumFiles] History DB fetch failed: {e}")
            finally:
                db_gen.close()

        # Merge previously fetched per-file metadata from disk and history DB.
        # those cards are complete in the FIRST event (duration, size, quality)
        # and skip the enrich queue. stream_url is left empty; the player lazy-resolves.
        def _meta_complete(it: dict) -> bool:
            # A video card only counts as "done" once it actually carries the
            # duration + resolution badges; images/other files have none to fetch.
            if it.get("type") != "video" or it.get("metadata_state") == "unsupported":
                return True
            return bool(it.get("duration")) and bool(it.get("height"))

        def _thumbnail_complete(it: dict) -> bool:
            # A missing thumbnail gets one extraction attempt even when duration
            # and resolution were restored from history. Remember a failed
            # attempt so unavailable covers do not keep auto-enrichment looping.
            if it.get("type") not in {"video", "image"}:
                return True
            return bool(it.get("thumbnail")) or bool(it.get("thumbnail_checked"))

        def _viewer_complete(it: dict) -> bool:
            return _meta_complete(it) and _thumbnail_complete(it)

        to_enrich: list[dict] = []
        for item in base:
            # A complete permanent snapshot is already enough to render this
            # card. Mirror it into the fast per-file cache and only spend Bunkr
            # requests on fields that are genuinely still missing.
            if _viewer_complete(item):
                item["enriched"] = True
                if item.get("url"):
                    bunkr_cache.file_meta_put(item["url"], item)
                continue
            cached_meta = bunkr_cache.file_meta_get(item["url"]) if item["url"] else None
            if cached_meta:
                item.update(cached_meta)
                # Cache rows written before the moov-walk probe fix carry size but
                # no duration/height. Re-enrich those instead of trusting them, so
                # previously opened albums recover their badges on next open.
                if _viewer_complete(item):
                    item["enriched"] = True
                else:
                    item["enriched"] = False
                    to_enrich.append(item)
            elif item["url"] in db_history_meta:
                hist = db_history_meta[item["url"]]
                item.update(hist)
                item["enriched"] = _viewer_complete(item)
                if item["enriched"]:
                    bunkr_cache.file_meta_put(item["url"], item)  # sync to bunkr_cache
                else:
                    to_enrich.append(item)
            else:
                item["enriched"] = False
                to_enrich.append(item)

        # Persist membership immediately, even if the browser closes before the
        # probe queue finishes. The final write below adds the newly learned
        # metadata patches.
        bunkr_cache.album_snapshot_put(url, base, title=permanent_snapshot.get("title") or "")

        remaining = 0
        if limit and limit > 0 and len(to_enrich) > limit:
            remaining = len(to_enrich) - limit
            to_enrich = to_enrich[:limit]

        yield {"type": "base", "items": base, "total": len(base),
               "pending": len(to_enrich), "remaining": remaining}

        # Bunkr API and CDN range probes are independent bottlenecks. Bound
        # each separately so a slow MP4 probe does not occupy an API slot.
        # The CDN keeps its own process-wide cap in mp4_probe.
        from app.mp4_probe import PROBEABLE_EXT_RE, probe_mp4_cached, cache_flush as mp4_cache_flush
        resolve_sem = asyncio.Semaphore(12)

        async def _extract_with_retry(file_url: str, tries: int = 2):
            result = None
            for attempt in range(tries):
                async with resolve_sem:
                    result = await extractor.extract(file_url, metadata_only=True)
                if result and result.get("stream_url"):
                    return result
                if attempt + 1 < tries:
                    await asyncio.sleep(0.6 * (attempt + 1))  # back off past the throttle
            return result

        async def _enrich(item: dict) -> dict:
            if not item["url"]:
                return item
            try:
                # A listing already containing the cover needs only the
                # stream API. Fetch the detail HTML when a cover is missing.
                result = await _extract_with_retry(item["url"]) if item.get("thumbnail") else None
                if result is None:
                    async with resolve_sem:
                        result = await extractor.extract(item["url"])
                if result:
                        title = item["title"] if item.get("thumbnail") else (result.get("title") or item["title"])
                        stream_url = result.get("stream_url") or ""
                        if not stream_url:
                            return item
                        ftype, ext = _classify(f"{title} {item.get('title') or ''}", f"{stream_url} {item['url']}")
                        if ftype == "file" and item.get("type") in {"video", "image"}:
                            ftype = item["type"]
                        # Bunkr exposes no duration anywhere — read it from the MP4
                        # itself (moov/mvhd) via two small ranged GETs, cached by the
                        # stable file-page URL. mkv/webm are skipped (EBML, not BMFF).
                        duration = int(result.get("duration") or 0)
                        probed_size = 0
                        probed_width = 0
                        probed_height = 0
                        # A listing can already know duration while still lacking
                        # dimensions. Probe in either case so a full album fetch
                        # always learns the real video quality, not just a title
                        # hint such as "1080p".
                        if ((not duration or not result.get("height")) and ftype == "video" and stream_url
                                and PROBEABLE_EXT_RE.search(stream_url)):
                            probe = await probe_mp4_cached(
                                item["url"], stream_url,
                                headers={"User-Agent": "Mozilla/5.0", "Referer": "https://bunkr.cr/"},
                                persist=False,
                            )
                            duration = probe["duration"]
                            probed_size = probe["size"]
                            probed_width = probe.get("width") or 0
                            probed_height = probe.get("height") or 0
                        
                        w = result.get("width") or probed_width or 0
                        h = result.get("height") or probed_height or 0
                        
                        def _h2q(vh: int) -> str:
                            if not vh: return ""
                            if vh >= 2160: return "4K"
                            if vh >= 1440: return "1440p"
                            if vh >= 1080: return "FHD"
                            if vh >= 720: return "HD"
                            return "SD"

                        measured_size = int(probed_size or 0)
                        listed_size = item.get("size") or ""
                        listed_size_bytes = int(item.get("size_bytes") or _dh_parse_size_to_bytes(listed_size) or 0)
                        return {
                            **item,
                            "title": title,
                            "thumbnail": result.get("thumbnail") or item["thumbnail"],
                            "storyboard_url": result.get("storyboard_url") or item.get("storyboard_url") or "",
                            "thumbnail_checked": True,
                            "stream_url": stream_url,
                            "type": ftype,
                            "ext": ext,
                            "quality": _quality(title) or item.get("quality") or _h2q(h),
                            "duration": duration,
                            "width": w,
                            "height": h,
                            # Prefer Content-Range/Content-Length from this exact
                            # CDN object. The album page occasionally repeats a
                            # stale size for every member.
                            "size": _dh_format_bytes(measured_size) if measured_size else listed_size,
                            "size_bytes": measured_size or listed_size_bytes,
                            "size_raw": measured_size or listed_size_bytes,
                            "size_verified": bool(measured_size),
                            "enriched": True,
                        }
            except Exception as e:
                logging.debug("[AlbumFiles] enrich %s failed: %s", item["url"][:60], e)
            if _meta_complete(item):
                # Technical metadata may already be complete from history while
                # only the cover lookup failed. Do not retry that cover forever.
                return {**item, "thumbnail_checked": True, "enriched": True}
            return item

        # Emit each file's enrichment the moment it completes (not gather-at-end).
        items: list[dict] = [i for i in base if i.get("enriched")]
        try:
            from app.async_work import map_unordered
            async for item in map_unordered(to_enrich, _enrich, workers=12):
                items.append(item)
                if item.get("url"):
                    if item.get("enriched"):
                        bunkr_cache.file_meta_put(item["url"], item)
                    yield {"type": "patch", "url": item["url"], "data": item}
        finally:
            mp4_cache_flush()
            bunkr_cache.file_meta_flush()
            # One batched snapshot write keeps the permanent per-album history
            # current without doing synchronous disk I/O for every card patch.
            saved = {i["url"]: i for i in base if i.get("url")}
            saved.update({i["url"]: i for i in items if i.get("url")})
            bunkr_cache.album_snapshot_put(url, list(saved.values()), title=permanent_snapshot.get("title") or "")

        known_videos = sum(1 for i in items if i.get("type") == "video")
        known_images = sum(1 for i in items if i.get("type") == "image")
        type_fixes: list[str] = []
        if known_videos > 0 and known_images == 0:
            for item in items:
                if item.get("type") == "file":
                    item["type"] = "video"
                    if item.get("url"):
                        type_fixes.append(item["url"])
        yield {"type": "done", "type_fixes": type_fixes}

    except Exception as exc:
        from app.ntc.bunkr_scheduler import fetch_durable
        if fetch_durable.get():
            raise
        logging.warning("[AlbumFiles] failed for %s: %s", url, exc)
        yield {"type": "error", "error": str(exc)}


@api_v1_router.get("/discovery-hub/album-files")
@api_legacy_router.get("/discovery-hub/album-files")
async def discovery_hub_album_files(url: str = ""):
    """Fully-enriched file list of a Bunkr album (blocks until every file is
    resolved). Kept for compatibility; the Album Viewer uses the -stream variant."""
    if not url or not url.startswith("http"):
        return {"items": [], "error": "Invalid URL"}
    items: dict[str, dict] = {}
    error = ""
    async for ev in _album_files_events(url):
        if ev["type"] == "base":
            items = {i["url"]: i for i in ev["items"] if i.get("url")}
        elif ev["type"] == "patch":
            items[ev["url"]] = ev["data"]
        elif ev["type"] == "done":
            for u in ev.get("type_fixes") or []:
                if u in items:
                    items[u]["type"] = "video"
        elif ev["type"] == "error":
            error = ev["error"]
    out = list(items.values())
    if error and not out:
        return {"items": [], "error": error, "album_url": url}
    return {"items": out, "total": len(out), "album_url": url}


@api_v1_router.get("/discovery-hub/album-files-index")
@api_legacy_router.get("/discovery-hub/album-files-index")
async def discovery_hub_album_files_index(url: str = ""):
    """Return only an album's complete file listing.

    This is the fast path for combining several albums into one working grid.
    Unlike ``/album-files`` it stops at the generator's first ``base`` event:
    no per-file stream resolution, thumbnail lookup, or MP4 duration probe is
    queued.  Those expensive operations stay opt-in through deep fetch.
    """
    if not url or not url.startswith("http"):
        return {"items": [], "error": "Invalid URL", "album_url": url}
    async for ev in _album_files_events(url, limit=0):
        if ev["type"] == "base":
            return {
                "items": ev["items"],
                "total": ev["total"],
                "album_url": url,
                "pending_metadata": ev.get("pending", 0),
            }
        if ev["type"] == "error":
            return {"items": [], "error": ev["error"], "album_url": url}
    return {"items": [], "error": "Album listing ended unexpectedly", "album_url": url}


@api_v1_router.get("/discovery-hub/album-files-stream")
@api_legacy_router.get("/discovery-hub/album-files-stream")
async def discovery_hub_album_files_stream(url: str = "", limit: int = 100):
    """NDJSON stream for the Album Viewer: the base listing arrives after a
    single album-page fetch, then per-file enrich patches (thumbnail, stream_url,
    duration, size) land as they resolve — a 100-file album shows its grid in
    ~1-2 s instead of blocking tens of seconds for the full enrich.

    `limit` = max uncached files enriched per call (0 = all); the viewer's
    "+100 / všetky / N" buttons just re-call with a new limit."""
    async def _gen():
        if not url or not url.startswith("http"):
            yield json.dumps({"type": "error", "error": "Invalid URL"}) + "\n"
            return
        async for ev in _album_files_events(url, limit=max(0, int(limit or 0))):
            yield json.dumps(ev, ensure_ascii=False, default=str) + "\n"
    return StreamingResponse(_gen(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class RefetchMetaRequest(BaseModel):
    urls: list[str] = []


@api_v1_router.post("/discovery-hub/refetch-meta")
@api_legacy_router.post("/discovery-hub/refetch-meta")
async def discovery_hub_refetch_meta(req: RefetchMetaRequest):
    """Force a fresh duration/quality/size probe for specific file URLs, bypassing
    the disk cache. Used by the Album Viewer's "Fetch meta znova" action so cards
    that never got their badges (probe throttled, or cached blank from an older
    build) can be recovered on demand. Streams one patch per file as it lands."""
    from app.extractors.bunkr import BunkrExtractor
    from app import bunkr_cache
    from app.mp4_probe import PROBEABLE_EXT_RE, probe_mp4, cache_get as _probe_cache_get

    urls = [u for u in (req.urls or []) if isinstance(u, str) and u.startswith("http")][:400]
    extractor = BunkrExtractor()
    sem = asyncio.Semaphore(4)

    def _classify(title: str, file_url: str) -> tuple[str, str]:
        exts = re.findall(r"\.([a-z0-9]{2,5})(?=[?#&_\s.]|$)", f"{title} {file_url}".lower())
        ext = exts[-1] if exts else ""
        if ext in {"mp4", "mkv", "webm", "mov", "m4v", "avi", "m3u8", "flv", "wmv"}:
            return "video", ext
        if ext in {"jpg", "jpeg", "png", "gif", "webp", "avif", "bmp"}:
            return "image", ext
        return "file", ext

    def _h2q(vh: int) -> str:
        if not vh: return ""
        if vh >= 2160: return "4K"
        if vh >= 1440: return "1440p"
        if vh >= 1080: return "FHD"
        if vh >= 720: return "HD"
        return "SD"

    def _quality(title: str) -> str:
        m = re.search(r"\b(2160|4k|1440|1080|720|480|360)\s*p?\b", title or "", re.I)
        if not m: return ""
        v = m.group(1).lower()
        return "4K" if v in {"2160", "4k"} else f"{v}p"

    async def _one(file_url: str) -> dict:
        async with sem:
            try:
                # drop any stale cache entry so we don't short-circuit on a blank row
                bunkr_cache.file_meta_forget(file_url)
                result = None
                for attempt in range(2):
                    result = await extractor.extract(file_url)
                    if result and result.get("stream_url"):
                        break
                    if attempt == 0:
                        await asyncio.sleep(0.6)
                if not result:
                    return {"url": file_url, "ok": False}
                title = result.get("title") or file_url.rsplit("/", 1)[-1]
                stream_url = result.get("stream_url") or ""
                ftype, ext = _classify(title, f"{stream_url} {file_url}")
                duration = int(result.get("duration") or 0)
                w = int(result.get("width") or 0)
                h = int(result.get("height") or 0)
                size_b = 0
                cdn_status = 0
                if ftype == "video" and stream_url and PROBEABLE_EXT_RE.search(stream_url):
                    # Manual re-fetch is a deliberate action on a small set, so be
                    # patient: a flaky CDN node often serves size but drops the moov
                    # reads on the first try, then succeeds a moment later.
                    probe = {"duration": 0, "size": 0, "width": 0, "height": 0}
                    for _try in range(3):
                        probe = await probe_mp4(
                            stream_url,
                            headers={"User-Agent": "Mozilla/5.0", "Referer": "https://bunkr.cr/"},
                        )
                        if probe.get("duration") or probe.get("height"):
                            break
                        if _try < 2:
                            await asyncio.sleep(0.8 * (_try + 1))
                            # re-resolve in case the token/node rotated
                            fresh = await extractor.extract(file_url)
                            if fresh and fresh.get("stream_url"):
                                stream_url = fresh["stream_url"]
                    duration = duration or probe["duration"]
                    w = w or probe.get("width") or 0
                    h = h or probe.get("height") or 0
                    size_b = probe.get("size") or 0
                    # persist the probe result under the stable page url for next open
                    if duration or w or h:
                        from app.mp4_probe import cache_put as _probe_cache_put
                        _probe_cache_put(file_url, duration, size_b, w, h)
                    else:
                        # Still no duration/resolution — the CDN node is likely down
                        # or flaky (it may serve the size header but drop the moov
                        # reads). One tiny request tells us why, so the UI can say so
                        # instead of "nič sa nedeje".
                        try:
                            async with httpx.AsyncClient(
                                    timeout=httpx.Timeout(8.0, connect=4.0),
                                    follow_redirects=True, verify=False) as _hc:
                                _r = await _hc.get(stream_url, headers={
                                    "User-Agent": "Mozilla/5.0", "Referer": "https://bunkr.cr/",
                                    "Range": "bytes=0-1023"})
                                cdn_status = _r.status_code
                                # 2xx but tiny/HTML body ⇒ node is erroring under the hood
                                if cdn_status in (200, 206):
                                    ctype = _r.headers.get("content-type", "")
                                    if "text/html" in ctype:
                                        cdn_status = 503
                        except Exception:
                            cdn_status = -1  # couldn't even connect
                data = {
                    "url": file_url,
                    "title": title,
                    "thumbnail": result.get("thumbnail") or "",
                    "storyboard_url": result.get("storyboard_url") or "",
                    "type": ftype, "ext": ext,
                    "duration": duration, "width": w, "height": h,
                    "quality": _quality(title) or _h2q(h),
                    "enriched": True,
                }
                # The detail/listing page sometimes supplies one copied size for
                # an entire album. A size measured from this file's CDN response
                # is therefore always preferred when Full Fetch was able to get it.
                if size_b:
                    data["size"] = _dh_format_bytes(size_b)
                    data["size_bytes"] = size_b
                    data["size_raw"] = size_b
                    data["size_verified"] = True
                elif result.get("size"):
                    data["size"] = result["size"]
                    listed_size = _dh_parse_size_to_bytes(result["size"])
                    if listed_size:
                        data["size_bytes"] = listed_size
                        data["size_raw"] = listed_size
                bunkr_cache.file_meta_put(file_url, data)
                ok = bool(duration or h)
                out = {"url": file_url, "ok": ok, "data": data}
                if not ok and cdn_status:
                    if cdn_status == 503 or cdn_status == 502:
                        out["reason"] = "cdn_down"      # Bunkr node offline
                    elif cdn_status in (403, 401):
                        out["reason"] = "cdn_forbidden"  # token/geo/login gate
                    elif cdn_status in (404, 410):
                        out["reason"] = "gone"           # file removed
                    elif cdn_status == -1:
                        out["reason"] = "unreachable"
                    elif cdn_status in (200, 206):
                        # node answers but drops the metadata reads → overloaded/flaky
                        out["reason"] = "cdn_flaky"
                    else:
                        out["reason"] = f"http_{cdn_status}"
                return out
            except Exception as exc:
                logging.debug("[RefetchMeta] %s failed: %s", file_url[:60], exc)
                return {"url": file_url, "ok": False, "reason": "error"}

    async def _gen():
        # Start the work explicitly, then emit a heartbeat while the first CDN
        # probes are running. A cold probe can take tens of seconds, and the old
        # stream made the browser look frozen at 0/N until one had completed.
        tasks = [asyncio.create_task(_one(url)) for url in urls]
        pending = set(tasks)
        try:
            yield json.dumps({
                "type": "start",
                "total": len(urls),
                "active": min(4, len(pending)),
            }) + "\n"
            while pending:
                completed, pending = await asyncio.wait(
                    pending,
                    timeout=2.0,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if not completed:
                    # Status only: completed remains an honest counter while the
                    # UI can still show that probes are actively running.
                    yield json.dumps({
                        "type": "progress",
                        "completed": len(tasks) - len(pending),
                        "active": min(4, len(pending)),
                    }) + "\n"
                    continue
                for task in completed:
                    try:
                        res = task.result()
                    except Exception as exc:
                        logging.debug("[RefetchMeta] worker failed: %s", exc)
                        res = {"url": "", "ok": False, "reason": "error"}
                    yield json.dumps({"type": "patch", **res}, ensure_ascii=False, default=str) + "\n"
        finally:
            # A closed album must not leave dozens of metadata requests running.
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            bunkr_cache.file_meta_flush()
        yield json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(_gen(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


from .discovery_hub_runtime import hub_deadline


class FetchHdThumbsRequest(BaseModel):
    urls: list[str] = []
    force: bool = False


@api_v1_router.post("/discovery-hub/fetch-hd-thumbs")
@api_legacy_router.post("/discovery-hub/fetch-hd-thumbs")
async def discovery_hub_fetch_hd_thumbs(req: FetchHdThumbsRequest):
    """Fetch high-resolution storyboard / cover thumbnails for Bunkr video cards.
    Streams NDJSON patches as each storyboard URL is discovered.
    """
    from app import bunkr_cache
    import html as html_module
    import httpx

    urls = [u for u in (req.urls or []) if isinstance(u, str) and u.startswith("http")][:1000]
    if not urls:
        async def _empty():
            yield json.dumps({"type": "done", "total": 0, "found": 0}) + "\n"
        return StreamingResponse(_empty(), media_type="application/x-ndjson")

    sem = asyncio.Semaphore(12)
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://bunkr.cr/",
    }

    async def _fetch_one(client: httpx.AsyncClient, file_url: str) -> dict:
        if not req.force:
            cached = bunkr_cache.file_meta_get(file_url)
            if cached and cached.get("storyboard_url"):
                return {"url": file_url, "ok": True, "storyboard_url": cached["storyboard_url"], "cached": True}

        async with sem:
            try:
                resp = await client.get(file_url, headers=headers)
                if resp.status_code != 200:
                    return {"url": file_url, "ok": False}
                html = resp.text
                cov = re.search(r'videoCoverUrl\s*=\s*[\'"]([^\'"]+)[\'"]', html)
                og_patterns = (
                    r'<meta\b[^>]*\bproperty\s*=\s*[\'"]og:image[\'"][^>]*\bcontent\s*=\s*[\'"]([^\'"]+)[\'"][^>]*>',
                    r'<meta\b[^>]*\bcontent\s*=\s*[\'"]([^\'"]+)[\'"][^>]*\bproperty\s*=\s*[\'"]og:image[\'"][^>]*>',
                )
                og = next(
                    (match for pattern in og_patterns
                     if (match := re.search(pattern, html, re.IGNORECASE))),
                    None,
                )
                cover_url = ""
                if cov and cov.group(1):
                    cover_url = html_module.unescape(cov.group(1)).replace(r"\/", "/")
                elif og and og.group(1) and "video.svg" not in og.group(1):
                    cover_url = html_module.unescape(og.group(1))

                if cover_url:
                    cover_url = urllib.parse.urljoin(file_url, cover_url)
                    existing = bunkr_cache.file_meta_get(file_url) or {}
                    existing["storyboard_url"] = cover_url
                    existing["storyboard_kind"] = "sprite" if cov else "cover"
                    existing["thumbnail_checked"] = True
                    bunkr_cache.file_meta_put(file_url, existing)
                    return {"url": file_url, "ok": True, "storyboard_url": cover_url, "cached": False}
                return {"url": file_url, "ok": False}
            except Exception as e:
                logging.debug("[FetchHdThumbs] %s failed: %s", file_url, e)
                return {"url": file_url, "ok": False, "error": str(e)}

    async def _gen():
        found = 0
        transport = httpx.AsyncHTTPTransport(retries=1, verify=False)
        async with httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(9.0, connect=5.0), follow_redirects=True) as client:
            tasks = [asyncio.create_task(_fetch_one(client, u)) for u in urls]
            try:
                for fut in asyncio.as_completed(tasks):
                    res = await fut
                    if res.get("ok") and res.get("storyboard_url"):
                        found += 1
                        yield json.dumps({
                            "type": "patch",
                            "url": res["url"],
                            "data": {
                                "storyboard_url": res["storyboard_url"],
                                "hd_ready": True,
                            }
                        }) + "\n"
                    else:
                        yield json.dumps({
                            "type": "patch",
                            "url": res["url"],
                            "data": {
                                "hd_failed": True,
                            }
                        }) + "\n"
            finally:
                for t in tasks:
                    if not t.done():
                        t.cancel()
                bunkr_cache.file_meta_flush()
        yield json.dumps({"type": "done", "total": len(urls), "found": found}) + "\n"

    return StreamingResponse(_gen(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@api_v1_router.get("/discovery-hub/bunkr")
@api_legacy_router.get("/discovery-hub/bunkr")
@hub_deadline(30)
async def discovery_hub_bunkr(
    query: str = "",
    mode: str = "trending",
    page: int = 1,
    limit: int = 60,
    cursor: str = "",
    provider: str = "",
    content: str = "all",
    include_external: bool = False,
    include_explorer: bool = False,
    include_explorer_api: bool = False,
    include_balbums: bool = True,
    include_bunkrr: bool = True,
):
    """Discovery Hub — aggregate Bunkr content from balbums.st + bunkrr.pics + search engine."""
    from .discovery_hub_runtime import hub_get, hub_runtime
    provider_errors = []
    fallback_active = False
    fallback_message = ""

    results = []
    seen_urls = set()
    search_meta = {}
    api_pagination = {}
    limit = max(10, min(int(limit or 60), 100))
    query = query.strip()
    if not query and mode == "search":
        mode = "latest"
    # Balbums' listing order is authoritative for its latest feed. Mixing in
    # an index first can fill the entire page before any Balbums cards survive.
    balbums_latest = mode in {"latest", "search"} and include_balbums
    if balbums_latest:
        include_bunkrr = False
        include_explorer = False
        include_external = False

    if query.startswith("http") and re.search(r"(?:bunkr|bunkrr|scdn|media-files)\.", query, re.I):
        try:
            album_resp = await discovery_hub_album_files(url=query)
            if album_resp and album_resp.get("items"):
                return {
                    "results": album_resp["items"],
                    "items": album_resp["items"],
                    "status": "success", "has_more": False,
                    "total": album_resp.get("total", len(album_resp["items"])),
                    "search_meta": {},
                    "pagination": {"has_more": False, "next_cursor": ""}
                }
        except Exception as e:
            logging.error(f"Failed to auto-parse direct URL in discovery hub: {e}")

    async def _fetch_bunkrr_api(path: str, params: Optional[Dict[str, Any]] = None, timeout: int = 10) -> Optional[Dict[str, Any]]:
        api_key = (os.getenv("BUNKR_API_KEY") or os.getenv("BUNKRR_API_KEY") or "").strip()
        if not api_key:
            return None
        base_url = (os.getenv("BUNKR_API_BASE") or "https://api.bunkrr.pics/v1").rstrip("/")
        url = f"{base_url}/{path.lstrip('/')}"
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "Nexus Discovery Hub/1.0",
        }
        try:
            response = await hub_get(url, params={k: v for k, v in (params or {}).items() if v not in (None, "")}, headers=headers, timeout=timeout)
            return response.json()
        except Exception as exc:
            provider_errors.append({"provider": "bunkrr_api", "error": str(exc) or type(exc).__name__})
            return None

    async def _fetch_findr_api(path: str, params: Optional[Dict[str, Any]] = None, timeout: int = 12) -> Optional[Dict[str, Any]]:
        """Read Findr's public, paginated index API used by its search UI."""
        url = f"https://findr.to/{path.lstrip('/')}"
        try:
            response = await hub_get(url, params={k: v for k, v in (params or {}).items() if v not in (None, "")}, headers={"Accept": "application/json", "Referer": "https://findr.to/", "User-Agent": "Mozilla/5.0 Nexus/DiscoveryHub"}, timeout=timeout)
            payload = response.json()
            return payload if isinstance(payload, dict) else None
        except Exception as exc:
            provider_errors.append({"provider": "findr", "error": str(exc) or type(exc).__name__})
            return None

    def _api_file_to_item(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        href = str(entry.get("source_url") or entry.get("source_link") or entry.get("url") or "").strip()
        if not href:
            return None
        title = str(entry.get("filename") or entry.get("name") or href.rsplit("/", 1)[-1] or "Bunkr file").strip()
        ext = str(entry.get("extension") or entry.get("file_extension") or (title.rsplit(".", 1)[-1] if "." in title else "")).lower()
        item_type = "video" if ext in {"mp4", "mkv", "mov", "webm", "m4v", "avi"} else "file"
        created_at = str(entry.get("created_at") or "")
        item = _dh_make_item(
            title=title[:180],
            url=href,
            thumbnail=str(entry.get("thumbnail_url") or entry.get("thumbnail_path") or entry.get("thumbnail") or ""),
            source="Findr index",
            item_type=item_type,
            file_count=1,
            size_text=str(entry.get("size_human") or entry.get("file_size") or ""),
            size_bytes=int(entry.get("size_bytes") or entry.get("file_size_bytes") or 0),
            created_at=created_at,
            updated_at=created_at,
            first_upload_at=created_at,
            last_upload_at=created_at,
            provider="findr_api_search",
            diagnostics={"matched_by": "findr_api_search", "album_id": entry.get("album_id")},
        )
        item["album_title"] = str(entry.get("album_name") or "")
        item["album_id"] = entry.get("album_id")
        item["video_count"] = 1 if item_type == "video" else 0
        item["import_plan"] = {"mode": "single", "url": href, "can_expand": False, "estimated_items": 1}
        return item

    def _findr_album_to_item(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        album_id = entry.get("id") or entry.get("album_id")
        source_url = str(entry.get("original_url") or entry.get("source_link") or "").strip()
        from app.ntc.bunkr_scheduler import is_bunkr_host
        if not is_bunkr_host(urllib.parse.urlparse(source_url).hostname or ""):
            search_meta["filtered_provider_totals"] = True
            return None
        if not source_url or not album_id:
            return None
        thumbs = entry.get("thumbnails") if isinstance(entry.get("thumbnails"), list) else []
        thumbnail = str(thumbs[0] if thumbs else entry.get("thumbnail_path") or "")
        title = str(entry.get("name") or entry.get("title") or "Bunkr album").strip()
        created_at = str(entry.get("created_at") or "")
        updated_at = str(entry.get("updated_at") or created_at)
        item = _dh_make_item(
            title=title[:180],
            url=source_url,
            detail_url=f"https://findr.to/albums/{album_id}",
            thumbnail=thumbnail,
            source="Findr",
            item_type="album",
            file_count=int(entry.get("file_count") or 0),
            size_bytes=int(entry.get("folder_size_bytes") or entry.get("total_size_bytes") or 0),
            created_at=created_at,
            updated_at=updated_at,
            first_upload_at=created_at,
            last_upload_at=updated_at,
            provider="findr_api",
            diagnostics={"matched_by": "findr_api_albums", "album_id": album_id},
        )
        item["album_id"] = album_id
        item["import_plan"] = {
            "mode": "album", "url": source_url, "detail_url": f"https://findr.to/albums/{album_id}",
            "can_expand": True, "estimated_items": int(entry.get("file_count") or 0),
        }
        return item

    async def _attach_album_stats(items: List[Dict[str, Any]]) -> None:
        """Annotate file results with their parent album's file count + total size.

        A file row from /search only carries `album_id`, so a card could only ever
        say "1 files / 245 MB" (the file itself). The album's real totals come from
        /albums/<id>; we fetch each distinct album once, in parallel, and cache the
        result for the process so paging through a big album costs one call.
        """
        ids = {
            item.get("album_id") for item in items
            if item.get("type") != "album" and item.get("album_id") not in (None, "", 0)
        }
        if not ids:
            return

        cache = hub_runtime().stats
        missing = [aid for aid in ids if cache.get(aid) is None]

        async def load_one(album_id: Any) -> None:
            payload = await _fetch_findr_api(f"api/albums/{album_id}", {"page": 1, "limit": 1})
            data = payload if isinstance(payload, dict) else None
            if not isinstance(data, dict):
                legacy_payload = await _fetch_bunkrr_api(f"albums/{album_id}")
                data = (legacy_payload or {}).get("data") if isinstance(legacy_payload, dict) else None
            if not isinstance(data, dict):
                cache.put(album_id, {}, ttl=15)
                return
            cache.put(album_id, {
                "album_file_count": int(data.get("file_count") or 0),
                "album_size_bytes": int(data.get("folder_size_bytes") or data.get("total_size_bytes") or 0),
                "album_title": str(data.get("name") or ""),
            })

        async def load(album_id):
            async with hub_runtime().stats_slots:
                await load_one(album_id)

        if missing:
            await asyncio.gather(*[load(aid) for aid in missing], return_exceptions=True)

        for item in items:
            stats = cache.get(item.get("album_id")) or {}
            if not stats:
                continue
            file_count = stats.get("album_file_count") or 0
            size_bytes = stats.get("album_size_bytes") or 0
            if file_count:
                item["album_file_count"] = file_count
            if size_bytes:
                item["album_size_bytes"] = size_bytes
                item["album_size_text"] = _dh_format_bytes(size_bytes)
            if stats.get("album_title") and not item.get("album_title"):
                item["album_title"] = stats["album_title"]
            # The card badge itself is built client-side in
            # discoveryHubMetaBadges(), which deliberately ignores this
            # server-side `badges` array — so don't append here or it duplicates.

    async def _search_findr_files() -> tuple[list[dict], dict]:
        if not query:
            return [], {}
        items = []
        seen_item_keys = set()
        requested_limit = min(max(int(limit or 60), 1), 100)
        extensions = {
            "video": "mp4,webm,mkv,mov,m4v,avi,flv,wmv,mpg,mpeg,ts,m2ts",
            "image": "jpg,jpeg,png,gif,webp,bmp,tiff,tif,heic,avif,jfif",
        }.get(content, "")
        payload = await _fetch_findr_api("api/search", {
            "q": query.strip(), "page": page, "limit": requested_limit,
            "sort": "relevance", "provider": "bunkr", "ext": extensions,
        })
        if not payload:
            return [], {}
        rows = payload.get("files") or []
        total = int(payload.get("total") or len(rows) or 0)
        effective_limit = int(payload.get("limit") or requested_limit)
        next_cursor = ""
        has_more = bool(payload.get("has_more"))
        for entry in rows:
            if not isinstance(entry, dict):
                continue
            item = _api_file_to_item(entry)
            if not item:
                continue
            key = item.get("canonical_url") or _dh_canonical_url(item.get("url", ""))
            if key and key in seen_item_keys:
                continue
            if key:
                seen_item_keys.add(key)
            items.append(item)

        # Album stats are attached once on the final merged list (see the call
        # just before the response is built), so nothing to do per-producer here.
        return items, {
            "files_total": int(total or len(items) or 0),
            "files_page": page,
            "files_total_pages": int(payload.get("total_pages") or 1),
            "files_limit": effective_limit,
            "next_cursor": next_cursor,
            "has_more": has_more,
            "provider": "findr_api",
        }

    async def _fetch_html(url: str) -> str:
        parsed_host = urllib.parse.urlparse(url).hostname or ""
        is_balbums = parsed_host == "balbums.st"
        timeout_val = 22 if is_balbums else 12
        for attempt in range(2 if is_balbums else 1):
            try:
                # hub_get provides browser-like headers and resilient caching for balbums.st
                response = await hub_get(url, timeout=timeout_val)
                return response.text
            except Exception as exc:
                if attempt == 0 and is_balbums:
                    await asyncio.sleep(0.5)
                    continue
                provider_errors.append({"provider": parsed_host, "error": str(exc) or type(exc).__name__})
                return ""
        return ""

    def _parse_balbums(html, source_label="balbums.st"):
        items = []
        if not html:
            return items
        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, "html.parser")
            cards = soup.select("article, .card, .album, .item, .thumb, .video-item, .gallery-item")
            if not cards:
                cards = soup.find_all("a", href=True)
            for card in cards:
                link = card if getattr(card, "name", "") == "a" else card.find("a", href=True)
                if not link:
                    continue
                href = link.get("href", "")
                if not href or href in seen_urls:
                    continue
                if not href.startswith("http"):
                    href = f"https://balbums.st/{href.lstrip('/')}"
                if not re.search(r"/(?:a|album|albums|f|v|d|i)/[^/?#]+", href):
                    continue
                seen_urls.add(href)
                # Each card carries a decorative /img/bunkr.svg placeholder *and*
                # the real thumbnail (<img class="thumb-img" src="https://…scdn.st/…">).
                # Prefer the real thumb; fall back to any non-placeholder <img>.
                thumb = ""
                thumb_img = card.select_one("img.thumb-img")
                if not thumb_img:
                    for candidate in card.find_all("img"):
                        cand_src = candidate.get("data-src") or candidate.get("src") or ""
                        if cand_src and "/img/bunkr.svg" not in cand_src and not cand_src.endswith(".svg"):
                            thumb_img = candidate
                            break
                if thumb_img:
                    thumb = _dh_absolute_url("https://balbums.st/", thumb_img.get("data-src") or thumb_img.get("src") or "")
                text = re.sub(r"\s+", " ", card.get_text(" ", strip=True))
                file_count = int(re.search(r"(\d+)\s+files", text, re.I).group(1)) if re.search(r"(\d+)\s+files", text, re.I) else 0
                views = int(re.search(r"(\d+)\s+views", text, re.I).group(1)) if re.search(r"(\d+)\s+views", text, re.I) else 0
                rank = int(re.search(r"#(\d+)", text).group(1)) if re.search(r"#(\d+)", text) else 0
                size_match = re.search(r"([\d,.]+)\s*(TB|GB|MB|KB|B)\b", text, re.I)
                size_text = size_match.group(0) if size_match else ""
                date_matches = re.findall(r"\b(?:\d{1,2}[./]\d{1,2}[./]\d{4}|\d{4}-\d{1,2}-\d{1,2})\b", text)
                first_date = _dh_pick_first_date(date_matches[0]) if date_matches else ""
                last_date = _dh_pick_first_date(date_matches[-1]) if date_matches else first_date
                heading = card.find(["h2", "h3", "h4"])
                title = _dh_clean_album_title(link.get("title") or (heading.get_text(" ", strip=True) if heading else "") or text or "Bunkr Album")
                
                is_album = bool(re.search(r"/(a|album|albums)/", href, re.I))
                
                items.append(_dh_make_item(
                    title=title,
                    url=href,
                    thumbnail=thumb,
                    source=source_label,
                    item_type="album" if is_album else "video",
                    file_count=file_count if is_album else 1,
                    size_text=size_text,
                    views=views,
                    rank=rank,
                    created_at=first_date,
                    updated_at=last_date,
                    first_upload_at=first_date,
                    last_upload_at=last_date,
                    provider="balbums_html",
                    diagnostics={"matched_by": source_label},
                ))
        except Exception as exc:
            logging.debug("[DISCOVERY_HUB] balbums parse error: %s", exc)
        return items

    def _parse_bunkrr_pics(html):
        items = []
        if not html:
            return items
        try:
            items.extend(_parse_bunkrr_next_albums(html))
            if items:
                return items

            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, "html.parser")
            cards = soup.select("article, .card, .album, .item, .result-item, div[class*='border']")
            if not cards:
                cards = soup.find_all("a", href=True)
            for card in cards:
                detail_link = card.find("a", href=lambda h: h and h.startswith("/albums/"))
                source_link = card.find("a", href=lambda h: h and re.search(r"https?://(?:[^/]*\.)?bunkr", h or "", re.I) and re.search(r"/a/", h or "", re.I))
                link = source_link or detail_link or card.find("a", href=True)
                if not link:
                    continue
                href = link.get("href", "")
                detail_url = _dh_absolute_url("https://bunkrr.pics/", detail_link.get("href", "")) if detail_link else ""
                if not href:
                    continue
                if href.startswith("/"):
                    href = _dh_absolute_url("https://bunkrr.pics/", href)
                elif not href.startswith("http"):
                    continue
                if not re.search(r"bunkr|bunkrr|cdn\d*\.", href, re.I):
                    continue
                if href in seen_urls:
                    continue
                seen_urls.add(href)
                img = card.find("img")
                thumb = _dh_absolute_url("https://bunkrr.pics/", (img.get("data-src") or img.get("src") or "")) if img else ""
                text = re.sub(r"\s+", " ", card.get_text(" ", strip=True))
                title_candidates = [
                    detail_link.get_text(" ", strip=True) if detail_link else "",
                    link.get("title") or "",
                    link.get_text(" ", strip=True),
                ]
                for title_el in card.select("h1, h2, h3, [class*='title'], [class*='name']"):
                    title_candidates.append(title_el.get_text(" ", strip=True))
                title_candidates.extend([
                    line.strip()
                    for line in re.split(r"\s{2,}|\n|\r", card.get_text("\n", strip=True))
                    if line.strip()
                ])
                title = ""
                for candidate in title_candidates:
                    cleaned = _dh_clean_album_title(candidate)
                    if not _dh_is_junk_album_title(cleaned):
                        title = cleaned
                        break
                if not title:
                    title = "Bunkr album"
                file_count = int(re.search(r"(\d+)\s+files", text, re.I).group(1)) if re.search(r"(\d+)\s+files", text, re.I) else 0
                size_match = re.search(r"([\d,.]+)\s*(TB|GB|MB|KB|B)\b", text, re.I)
                size_text = size_match.group(0) if size_match else ""
                created_at = _dh_extract_first_date(text, ["Created", "Uploaded", "Added", "First upload"])
                updated_at = _dh_extract_first_date(text, ["Last upload", "Last updated", "Updated"])
                items.append(_dh_make_item(
                    title=title,
                    url=href,
                    detail_url=detail_url,
                    thumbnail=thumb,
                    source="bunkrr.pics",
                    item_type="album" if "/a/" in href or "/album" in href or "/albums/" in href else "video",
                    file_count=file_count,
                    size_text=size_text,
                    created_at=created_at,
                    updated_at=updated_at,
                    first_upload_at=created_at,
                    last_upload_at=updated_at,
                    provider="bunkrr_html",
                    diagnostics={"matched_by": "bunkrr_html"},
                ))
        except Exception as exc:
            logging.debug("[DISCOVERY_HUB] bunkrr.pics parse error: %s", exc)
        return items

    def _dh_next_flight_texts(html: str) -> List[str]:
        texts = [html or ""]
        if not html:
            return texts
        for match in re.finditer(r"self\.__next_f\.push\(\[1,\"(.*?)\"\]\)</script>", html, re.S):
            try:
                texts.append(json.loads('"' + match.group(1) + '"'))
            except Exception:
                continue
        return texts

    def _dh_decode_json_array_after(text: str, marker: str) -> list:
        idx = (text or "").find(marker)
        if idx < 0:
            return []
        arr_idx = text.find("[", idx)
        if arr_idx < 0:
            return []
        try:
            value, _ = json.JSONDecoder().raw_decode(text[arr_idx:])
            return value if isinstance(value, list) else []
        except Exception:
            return []

    def _dh_decode_json_object_after(text: str, marker: str) -> dict:
        idx = (text or "").find(marker)
        if idx < 0:
            return {}
        obj_idx = text.find("{", idx)
        if obj_idx < 0:
            return {}
        try:
            value, _ = json.JSONDecoder().raw_decode(text[obj_idx:])
            return value if isinstance(value, dict) else {}
        except Exception:
            return {}

    def _parse_bunkrr_search_meta(html):
        meta = {}
        if not html:
            return meta
        for text in _dh_next_flight_texts(html):
            album_result = _dh_decode_json_object_after(text, '"albumResult":')
            file_result = _dh_decode_json_object_after(text, '"fileResult":')
            if not album_result:
                album_result = _dh_decode_json_object_after(text, '\\"albumResult\\":')
            if not file_result:
                file_result = _dh_decode_json_object_after(text, '\\"fileResult\\":')
            if album_result:
                meta["albums_total"] = int(album_result.get("total") or 0)
                meta["albums_page"] = int(album_result.get("page") or 1)
                meta["albums_total_pages"] = int(album_result.get("total_pages") or 1)
                meta["albums_limit"] = int(album_result.get("limit") or 60)
            if file_result:
                meta["files_total"] = int(file_result.get("total") or 0)
                meta["files_page"] = int(file_result.get("page") or 1)
                meta["files_total_pages"] = int(file_result.get("total_pages") or 1)
                meta["files_limit"] = int(file_result.get("limit") or 60)
            if meta:
                break
        return meta

    def _parse_bunkrr_next_albums(html):
        items = []
        if not html:
            return items
        try:
            for text in _dh_next_flight_texts(html):
                albums = _dh_decode_json_array_after(text, '"albumResult":{"albums":')
                if not albums:
                    albums = _dh_decode_json_array_after(text, '\\"albumResult\\":{\\"albums\\":')
                if not albums:
                    continue

                for entry in albums:
                    if not isinstance(entry, dict):
                        continue
                    href = str(entry.get("original_url") or entry.get("source_link") or entry.get("url") or "").strip()
                    detail_id = entry.get("id")
                    detail_url = f"https://bunkrr.pics/albums/{detail_id}" if detail_id else ""
                    if not href and not detail_url:
                        continue
                    if href and href in seen_urls:
                        continue
                    if href:
                        seen_urls.add(href)

                    raw_title = str(entry.get("name") or entry.get("title") or "").strip()
                    title = _dh_clean_album_title(raw_title)
                    if _dh_is_junk_album_title(title):
                        title = "Bunkr album"
                    thumbnails = entry.get("thumbnails") if isinstance(entry.get("thumbnails"), list) else []
                    thumbnail = str(thumbnails[0] if thumbnails else entry.get("thumbnail") or "")
                    created_at = str(entry.get("created_at") or "")
                    updated_at = str(entry.get("updated_at") or created_at)
                    size_bytes = int(entry.get("folder_size_bytes") or entry.get("size_bytes") or 0)

                    items.append(_dh_make_item(
                        title=title,
                        url=href or detail_url,
                        detail_url=detail_url,
                        thumbnail=thumbnail,
                        source="bunkrr.pics",
                        item_type="album",
                        file_count=int(entry.get("file_count") or 0),
                        size_bytes=size_bytes,
                        created_at=created_at,
                        updated_at=updated_at,
                        first_upload_at=created_at,
                        last_upload_at=updated_at,
                        provider="bunkrr_payload",
                        diagnostics={"matched_by": "bunkrr_next_album_payload", "album_id": detail_id},
                    ))
                if items:
                    break
        except Exception as exc:
            logging.debug("[DISCOVERY_HUB] bunkrr payload album parse error: %s", exc)
        return items

    def _parse_bunkrr_next_files(html):
        items = []
        if not html:
            return items
        try:
            for text in _dh_next_flight_texts(html):
                files = _dh_decode_json_array_after(text, '"fileResult":{"files":')
                if not files:
                    files = _dh_decode_json_array_after(text, '\\"fileResult\\":{\\"files\\":')
                if not files:
                    continue
                for entry in files:
                    if not isinstance(entry, dict):
                        continue
                    href = (entry.get("source_link") or entry.get("url") or "").strip()
                    if not href:
                        continue
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)

                    title = (entry.get("filename") or entry.get("name") or href.rsplit("/", 1)[-1] or "Bunkr file").strip()
                    ext = str(entry.get("file_extension") or (title.rsplit(".", 1)[-1] if "." in title else "")).lower()
                    item_type = "video" if ext in {"mp4", "mkv", "mov", "webm", "m4v", "avi"} else "file"
                    created_at = str(entry.get("created_at") or "")
                    size_bytes = int(entry.get("file_size_bytes") or entry.get("size_bytes") or 0)
                    size_text = str(entry.get("file_size") or "")

                    item = _dh_make_item(
                        title=title[:180],
                        url=href,
                        thumbnail=str(entry.get("thumbnail_path") or entry.get("thumbnail") or ""),
                        source="bunkrr.pics files",
                        item_type=item_type,
                        file_count=1,
                        size_text=size_text,
                        size_bytes=size_bytes,
                        created_at=created_at,
                        updated_at=created_at,
                        first_upload_at=created_at,
                        last_upload_at=created_at,
                        provider="bunkrr_file_payload",
                        diagnostics={"matched_by": "bunkrr_next_file_payload", "album_id": entry.get("album_id")},
                    )
                    item["album_title"] = str(entry.get("album_name") or "")
                    # Carry album_id so _attach_album_stats can resolve the parent
                    # album's real file count / total size for the card.
                    item["album_id"] = entry.get("album_id")
                    item["video_count"] = 1 if item_type == "video" else 0
                    item["import_plan"] = {"mode": "single", "url": href, "can_expand": False, "estimated_items": 1}
                    items.append(item)
                if items:
                    break
        except Exception as exc:
            logging.debug("[DISCOVERY_HUB] bunkrr payload file parse error: %s", exc)
        return items

    def _parse_bunkrr_files(html):
        items = []
        if not html:
            return items
        try:
            items.extend(_parse_bunkrr_next_files(html))
            if items:
                return items

            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, "html.parser")
            rows = soup.select("div[class*='border-b'][class*='py-3'][class*='px-3']")
            if not rows:
                rows = soup.select(".result-item, .file-item, article, tr")
            for card in rows:
                text = re.sub(r"\s+", " ", card.get_text(" ", strip=True))
                if not re.search(r"\.(mp4|mkv|mov|webm|m4v|avi)\b|/(?:f|v)/|/files/", text, re.I):
                    fileish_link_count = len(card.find_all("a", href=lambda h: h and re.search(r"/(?:files|f|v)/", h, re.I)))
                    if fileish_link_count == 0:
                        continue

                external_file_link = card.find(
                    "a",
                    href=lambda h: h and re.search(r"https?://(?:[^/]*\.)?bunkr", h or "", re.I)
                    and re.search(r"/(?:f|v)/", h or "", re.I),
                )
                internal_file_link = card.find("a", href=lambda h: h and re.search(r"/files/", h or "", re.I))
                generic_file_link = card.find("a", href=lambda h: h and re.search(r"/(?:f|v)/", h or "", re.I))
                link = external_file_link or generic_file_link or internal_file_link
                if not link:
                    continue

                href = link.get("href", "")
                detail_url = ""
                if internal_file_link:
                    detail_url = _dh_absolute_url("https://bunkrr.pics/", internal_file_link.get("href", ""))
                if href.startswith("/"):
                    href = _dh_absolute_url("https://bunkrr.pics/", href)
                if not href.startswith("http"):
                    continue
                if href in seen_urls:
                    continue
                seen_urls.add(href)

                img = card.find("img")
                thumb = _dh_absolute_url("https://bunkrr.pics/", (img.get("data-src") or img.get("src") or "")) if img else ""

                title_link = None
                for candidate in card.find_all("a", href=True):
                    candidate_text = candidate.get_text(" ", strip=True)
                    if candidate_text and candidate_text.lower() not in {"open", "bunkr", "source"}:
                        title_link = candidate
                        break
                raw_title = (title_link.get_text(" ", strip=True) if title_link else link.get_text(" ", strip=True)) or link.get("title") or "Bunkr file"
                title = re.sub(r"\s+", " ", raw_title).strip()[:180] or "Bunkr file"

                size_match = re.search(r"([\d,.]+)\s*(TB|GB|MB|KB|B)\b", text, re.I)
                size_text = size_match.group(0) if size_match else ""

                album_title = ""
                if size_match:
                    tail = text[size_match.end():]
                    tail = re.sub(r"^(?:\s*[·•-]\s*)+", "", tail)
                    tail = re.sub(r"\s*(?:Open|Bunkr|Source|Copy Link).*$", "", tail, flags=re.I)
                    album_title = tail.strip()[:120]

                low = f"{title} {href}".lower()
                item_type = "video" if re.search(r"\.(mp4|mkv|mov|webm|m4v|avi)(?:[?#]|$)", low) or "/v/" in low else "file"
                item = _dh_make_item(
                    title=title,
                    url=href,
                    detail_url=detail_url,
                    thumbnail=thumb,
                    source="bunkrr.pics files",
                    item_type=item_type,
                    file_count=1,
                    size_text=size_text,
                    created_at=_dh_extract_first_date(text, ["Created", "Uploaded", "Added", "First upload"]),
                    updated_at=_dh_extract_first_date(text, ["Last upload", "Last updated", "Updated"]),
                    provider="bunkrr_file_search",
                    diagnostics={"matched_by": "bunkrr_files", "album_title": album_title},
                )
                item["album_title"] = album_title
                item["video_count"] = 1 if item_type == "video" else 0
                item["import_plan"] = {"mode": "single", "url": href, "can_expand": False, "estimated_items": 1}
                items.append(item)
        except Exception as exc:
            logging.debug("[DISCOVERY_HUB] bunkrr files parse error: %s", exc)
        return items

    fetch_targets = []

    if query and mode in {"files", "file", "videos", "video"}:
        if include_bunkrr:
            api_items, api_meta = await _search_findr_files()
            if api_meta:
                results.extend(api_items)
                search_meta.update({k: v for k, v in api_meta.items() if v not in (None, "")})
                api_pagination = {
                    "next_cursor": api_meta.get("next_cursor") or "",
                    "has_more": bool(api_meta.get("has_more")),
                    "provider": api_meta.get("provider") or "findr_api",
                }
    elif query:
        if include_bunkrr:
            payload = await _fetch_findr_api("api/albums/search", {
                "q": query.strip(), "page": page, "limit": limit,
                "sort": "relevance", "provider": "bunkr",
            })
            entries = (payload or {}).get("albums") or []
            results.extend(
                item for entry in entries if isinstance(entry, dict)
                if (item := _findr_album_to_item(entry)) is not None
            )
            if payload:
                search_meta.update({
                    "albums_total": int(payload.get("total") or 0),
                    "albums_page": int(payload.get("page") or page),
                    "albums_total_pages": int(payload.get("total_pages") or 1),
                    "albums_limit": int(payload.get("limit") or limit),
                    "provider": "findr_api",
                })
                api_pagination = {"has_more": bool(payload.get("has_more")), "provider": "findr_api"}
        if include_balbums:
            fetch_targets.append(("balbums", f"https://balbums.st/?search={urllib.parse.quote(query)}&mode=broad&per={min(limit, 100)}&sort=latest&page={page}"))
    elif mode in {"files", "file"}:
        fetch_targets = []
    elif mode == "latest":
        if include_bunkrr:
            payload = await _fetch_findr_api("api/albums", {
                "page": page, "limit": limit, "sort": "latest", "provider": "bunkr",
            })
            entries = (payload or {}).get("albums") or []
            results.extend(
                item for entry in entries if isinstance(entry, dict)
                if (item := _findr_album_to_item(entry)) is not None
            )
            if payload:
                search_meta.update({
                    "albums_total": int(payload.get("total") or 0),
                    "albums_page": int(payload.get("page") or page),
                    "albums_total_pages": int(payload.get("total_pages") or 1),
                    "albums_limit": int(payload.get("limit") or limit),
                    "provider": "findr_api",
                })
                api_pagination = {"has_more": bool(payload.get("next_cursor")) or page < int(payload.get("total_pages") or 1), "provider": "findr_api"}
        if include_balbums:
            fetch_targets.append(("balbums", f"https://balbums.st/?search=&mode=broad&per={min(limit, 100)}&sort=latest&page={page}"))
    elif mode in {"videos", "video"}:
        if include_balbums:
            fetch_targets.append(("balbums", f"https://balbums.st/topvideos?lapse=7d&page={page}"))
        if include_bunkrr:
            payload = await _fetch_findr_api("api/albums", {
                "page": page, "limit": limit, "sort": "latest", "provider": "bunkr",
            })
            entries = (payload or {}).get("albums") or []
            results.extend(
                item for entry in entries if isinstance(entry, dict)
                if (item := _findr_album_to_item(entry)) is not None
            )
            if payload:
                search_meta.update({"albums_total": int(payload.get("total") or 0), "albums_page": page,
                                    "albums_total_pages": int(payload.get("total_pages") or 1), "provider": "findr_api"})
                api_pagination = {"has_more": bool(payload.get("next_cursor")) or page < int(payload.get("total_pages") or 1), "provider": "findr_api"}
    else:
        if include_balbums:
            fetch_targets.append(("balbums", f"https://balbums.st/topalbums?lapse=7d&page={page}"))
            fetch_targets.append(("balbums", f"https://balbums.st/?search=&mode=broad&per={min(limit, 100)}&sort=latest&page={page}"))
        if include_bunkrr:
            payload = await _fetch_findr_api("api/albums", {
                "page": page, "limit": limit, "sort": "latest", "provider": "bunkr",
            })
            entries = (payload or {}).get("albums") or []
            results.extend(
                item for entry in entries if isinstance(entry, dict)
                if (item := _findr_album_to_item(entry)) is not None
            )
            if payload:
                search_meta.update({"albums_total": int(payload.get("total") or 0), "albums_page": page,
                                    "albums_total_pages": int(payload.get("total_pages") or 1), "provider": "findr_api"})
                api_pagination = {"has_more": bool(payload.get("next_cursor")) or page < int(payload.get("total_pages") or 1), "provider": "findr_api"}

    # Pin continuation pages to the same index so recovery of Balbums cannot
    # switch a Findr page-two request to an unrelated Balbums page two.
    skip_primary = balbums_latest and (provider == "findr_api" or hub_runtime().providers.get("balbums") is not None)
    if skip_primary:
        fetch_targets = []

    html_results = await asyncio.gather(
        *[_fetch_html(url) for _, url in fetch_targets],
        return_exceptions=True,
    )

    for i, html in enumerate(html_results):
        if isinstance(html, Exception) or not html:
            continue
        source_type = fetch_targets[i][0]
        results.extend(_parse_balbums(html, "balbums.st"))
        if balbums_latest:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, "html.parser")
            page_match = re.search(r"page\s+(\d+)\s+of\s+([\d,]+)", soup.get_text(" ", strip=True), re.I)
            total_pages = int(page_match.group(2).replace(",", "")) if page_match else 1
            next_page = any(
                int((urllib.parse.parse_qs(urllib.parse.urlparse(a.get("href", "")).query).get("page") or ["0"])[0]) > page
                for a in soup.find_all("a", href=True)
                if (urllib.parse.parse_qs(urllib.parse.urlparse(a.get("href", "")).query).get("page") or ["0"])[0].isdigit()
            )
            search_meta.update({"albums_page": page, "albums_total_pages": total_pages, "provider": "balbums_html"})
            api_pagination = {"has_more": next_page or page < total_pages, "provider": "balbums_html"}

    primary_failed = any(error.get("provider") == "balbums.st" for error in provider_errors)
    if balbums_latest and not results:
        challenge = any(isinstance(html, str) and any(marker in html.lower() for marker in ("cf-chl-", "just a moment", "verify you are human", "checkpoint | sentinel")) for html in html_results)
        if challenge and not primary_failed:
            provider_errors.append({"provider": "balbums.st", "error": "challenge"})
            primary_failed = True
        if primary_failed:
            hub_runtime().providers.put("balbums", {"unavailable": True}, ttl=60)
        if skip_primary or primary_failed:
            fallback_active = True
            fallback_message = "Nexusu sa nepodarilo pripojiť k Balbums. Dočasne zobrazujem náhradný index Findr; poradie a pokrytie sa môžu líšiť."
            params = {"page": page, "limit": limit, "provider": "bunkr", "sort": "relevance" if query else "latest"}
            if cursor and not query:
                params["cursor"] = cursor
            if query:
                params["q"] = query
            payload = await _fetch_findr_api("api/albums/search" if query else "api/albums", params, timeout=6)
            for entry in (payload or {}).get("albums") or []:
                if isinstance(entry, dict) and (item := _findr_album_to_item(entry)) is not None:
                    results.append(item)
            if payload is not None:
                total_pages = int(payload.get("total_pages") or 1)
                search_meta.update({"albums_total": int(payload.get("total") or 0), "albums_page": page,
                                    "albums_total_pages": total_pages, "provider": "findr_api"})
                api_pagination = {"has_more": bool(payload.get("has_more", bool(payload.get("next_cursor")) or page < total_pages)),
                                  "next_cursor": payload.get("next_cursor") or "", "provider": "findr_api"}
                # A valid zero-result response from Findr is not an outage.
                if not results:
                    provider_errors = [error for error in provider_errors if error.get("provider") != "balbums.st"]

    if include_explorer and not (query and mode in {"files", "file", "videos", "video"}):
        explorer_sort = "latest"
        explorer_mode = "broad"
        explorer_items: list[dict] = []
        if query:
            if include_explorer_api:
                explorer_items = await _dh_search_bunkr_explorer_api(query.strip(), explorer_sort, explorer_mode, limit)
            if not explorer_items:
                explorer_items, explorer_meta = await _dh_search_bunkr_explorer_feed(
                    query.strip(),
                    explorer_mode,
                    explorer_sort,
                    limit,
                    page,
                )
                search_meta.update({k: v for k, v in explorer_meta.items() if v not in (None, "")})
            else:
                search_meta["bunkr_explorer_total"] = len(explorer_items)
                search_meta["bunkr_explorer_provider"] = "bunkr_explorer_api"
        elif mode in {"trending", "latest"} and page <= 2:
            # The Explorer feed has no dates in its public fallback payload. Use it only as
            # a light coverage supplement when first-party latest/trending lists are sparse.
            explorer_items, explorer_meta = await _dh_search_bunkr_explorer_feed(
                "",
                explorer_mode,
                explorer_sort,
                min(limit, 30),
                page,
            )
            search_meta.update({k: v for k, v in explorer_meta.items() if v not in (None, "")})

        if explorer_items:
            results.extend(explorer_items)

    # Deduplicate. Keep the position each item had in its source listing:
    # balbums (?sort=latest) and bunkrr (/albums) both serve newest-first, but the
    # listing HTML carries no upload dates, so DOM order is the only freshness
    # signal we get. Preserve it here or it is lost to the ranking sort below.
    final = []
    final_urls = set()
    for r in results:
        key = r.get("canonical_url") or _dh_canonical_url(r.get("url", ""))
        if key and key not in final_urls:
            final_urls.add(key)
            r.setdefault("feed_rank", len(final))
            final.append(r)

    # Also search via existing ExternalSearchEngine for Bunkr, but only when
    # first-party indexes did not provide enough usable results. The fallback is
    # slower and less metadata-rich.
    external_limit = max(20, min(int(limit or 60), 60))
    external_total_cap = max(external_limit, min(external_limit * 2, 120))
    if include_external and query and len(final) < min(external_limit, limit):
        try:
            engine = ExternalSearchEngine()
            ext_results = await engine.search(
                query.strip(),
                source="Bunkr",
                result_limit=external_limit,
                max_total=external_total_cap,
            )
            for r in ext_results:
                url = r.get("url", "")
                key = _dh_canonical_url(url)
                if url and key not in final_urls:
                    final_urls.add(key)
                    item = _dh_make_item(
                        title=r.get("title", ""),
                        url=url,
                        thumbnail=r.get("thumbnail", ""),
                        source=r.get("source", "Bunkr"),
                        item_type="album" if "/a/" in url or "/album" in url else "video",
                        file_count=r.get("video_count", 0) or r.get("file_count", 0) or 0,
                        size_text=r.get("size", ""),
                        size_bytes=r.get("size_bytes", 0) or 0,
                        provider="external_search",
                        diagnostics={"matched_by": "ExternalSearchEngine"},
                    )
                    item["duration"] = r.get("duration", 0) or 0
                    item["quality"] = r.get("quality", "") or ""
                    final.append(item)
        except Exception as exc:
            logging.debug("[DISCOVERY_HUB] engine search failed: %s", exc)

    if balbums_latest or (mode == "latest" and not query):
        # Newest-first: trust the source listing order (feed_rank). Ranking by
        # preview/views/file_count here would silently reorder by popularity and
        # bury the actually-new albums.
        final.sort(key=lambda item: int(item.get("feed_rank") or 0))
    elif not (query and mode in {"files", "file", "videos", "video"}):
        final.sort(key=lambda item: (
            0 if item.get("preview_status") == "ok" else 1,
            -int(item.get("views") or 0),
            -int(item.get("file_count") or 0),
        ))

    active_total = 0
    active_total_pages = 1
    if balbums_latest:
        active_total_pages = int(search_meta.get("albums_total_pages") or 1)
    if mode in {"files", "file", "videos", "video"} and query:
        active_total = int(search_meta.get("files_total") or len(final))
        active_total_pages = int(search_meta.get("files_total_pages") or 1)
    elif query:
        active_total = int(search_meta.get("albums_total") or len(final))
        active_total_pages = int(search_meta.get("albums_total_pages") or 1)
        explorer_total = int(search_meta.get("bunkr_explorer_total") or 0)
        if explorer_total:
            active_total = max(active_total, len(final), explorer_total)
            active_total_pages = max(active_total_pages, int(search_meta.get("bunkr_explorer_total_pages") or 1))
    has_more = bool(api_pagination.get("has_more")) if api_pagination else bool(active_total_pages and page < active_total_pages)

    if search_meta.get("filtered_provider_totals"):
        # Findr's listing currently ignores provider=bunkr. Do not label its
        # all-provider total as a verified count of Bunkr albums.
        active_total = 0

    # Single-file results only know their album_id; resolve the parent album's
    # real file count + total size so a file card can show how big the album it
    # came from actually is (otherwise it reads "1 files · 245 MB" — itself).
    # Done on the final list so it covers every producer path (API + scraped).
    try:
        await asyncio.wait_for(_attach_album_stats(final[:limit]), timeout=2.0)
    except Exception as exc:
        logging.debug("[DISCOVERY_HUB] album stats attach failed: %s", exc)

    # Disk lookups are local and do not delay cards with remote album requests.
    for index, item in enumerate(final):
        try:
            final[index] = _dh_cached_file_card(_dh_cached_album_card(item))
        except Exception as exc:
            logging.debug("[DISCOVERY_HUB] cached album card failed: %s", exc)

    return {
        "status": "partial" if provider_errors and final else ("error" if provider_errors else "success"),
        "errors": provider_errors,
        "fallback": fallback_active,
        "message": fallback_message,
        "pagination_provider": api_pagination.get("provider") or "",
        "query": query,
        "mode": mode,
        "page": page,
        "cursor": cursor,
        "next_cursor": api_pagination.get("next_cursor") or "",
        "total": len(final),
        "available_total": active_total,
        "has_more": has_more,
        "summary": {
            "albums_total": int(search_meta.get("albums_total") or 0),
            "albums_page": int(search_meta.get("albums_page") or 1),
            "albums_total_pages": int(search_meta.get("albums_total_pages") or 1),
            "files_total": int(search_meta.get("files_total") or 0),
            "files_page": int(search_meta.get("files_page") or 1),
            "files_total_pages": int(search_meta.get("files_total_pages") or 1),
            "active_total": active_total,
            "active_total_pages": active_total_pages,
            "provider": api_pagination.get("provider") or search_meta.get("provider") or "",
            "bunkr_explorer_total": int(search_meta.get("bunkr_explorer_total") or 0),
            "bunkr_explorer_feed_total": int(search_meta.get("bunkr_explorer_feed_total") or 0),
            "bunkr_explorer_provider": search_meta.get("bunkr_explorer_provider") or "",
        },
        "results": final[:limit],
    }


@api_v1_router.get("/batches")
@api_legacy_router.get("/batches")
def get_batches(db: Session = Depends(get_db), sort: str = "name", detailed: bool = False):
    """Get all batches with optional sorting

    Args:
        sort: Sorting method - 'name' (alphabetical), 'newest' (most recent video), 'biggest' (video count)
        detailed: If True, return detailed batch info (name, size, import_date)
    """
    from sqlalchemy import func

    if not detailed:
        query = (
            db.query(Video.batch_name)
            .filter(Video.batch_name.isnot(None), Video.batch_name != "")
            .group_by(Video.batch_name)
        )
        name_order = func.lower(Video.batch_name).asc()
        if sort == "newest":
            query = query.order_by(func.max(Video.created_at).desc(), name_order)
        elif sort == "biggest":
            query = query.order_by(func.count(Video.id).desc(), name_order)
        elif sort == "size":
            query = query.order_by(func.coalesce(func.sum(Video.file_size_mb), 0.0).desc(), name_order)
        else:
            query = query.order_by(name_order)
        names = [
            row[0]
            for row in query.all()
            if row[0]
        ]
        return names

    source_expr = func.lower(func.coalesce(Video.source_url, Video.url, ""))
    is_local_expr = Video.storage_type.in_(["local", "local_direct", "bittorrent"])
    is_working_expr = or_(is_local_expr, Video.link_status == "working")
    is_broken_expr = or_(
        Video.link_status == "broken",
        Video.status.in_(["error", "failed"]),
        Video.url.is_(None),
        Video.url == "",
    )
    is_processing_expr = Video.status.in_(["pending", "processing"])
    stale_cutoff = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) - datetime.timedelta(hours=24)
    is_expirable_expr = or_(*[source_expr.like(f"%{domain}%") for domain in PLAYBACK_EXPIRABLE_DOMAINS])
    is_refresh_expr = and_(
        ~is_working_expr,
        ~is_broken_expr,
        ~is_processing_expr,
        is_expirable_expr,
        or_(
            Video.last_checked.is_(None),
            Video.last_checked < stale_cutoff,
            Video.created_at < stale_cutoff,
        ),
    )

    batch_rows = (
        db.query(
            Video.batch_name.label("name"),
            func.count(Video.id).label("video_count"),
            func.coalesce(func.sum(Video.file_size_mb), 0.0).label("total_size_mb"),
            func.min(Video.created_at).label("first_import"),
            func.max(Video.created_at).label("last_import"),
            func.sum(case((is_working_expr, 1), else_=0)).label("healthy_count"),
            func.sum(case((is_broken_expr, 1), else_=0)).label("broken_count"),
            func.sum(case((is_refresh_expr, 1), else_=0)).label("refresh_count"),
            func.sum(case((is_processing_expr, 1), else_=0)).label("checking_count"),
        )
        .filter(Video.batch_name.isnot(None), Video.batch_name != "")
        .group_by(Video.batch_name)
        .all()
    )

    batches_with_info = []
    for row in batch_rows:
        total_mb = round(float(row.total_size_mb or 0.0), 2)
        size = int(row.video_count or 0)
        healthy_count = int(row.healthy_count or 0)
        broken_count = int(row.broken_count or 0)
        refresh_count = int(row.refresh_count or 0)
        checking_count = int(row.checking_count or 0)
        unknown_count = max(0, size - healthy_count - broken_count - refresh_count - checking_count)
        refresh_recommended = refresh_count > 0 or broken_count > 0
        batches_with_info.append({
            'name': row.name,
            'size': size,
            'total_size_mb': total_mb,
            'size_text': f"{total_mb / 1024:.1f} GB" if total_mb > 1024 else f"{int(total_mb)} MB",
            'import_date': row.first_import.isoformat() if row.first_import else None,
            'last_updated': row.last_import.isoformat() if row.last_import else None,
            'healthy_count': healthy_count,
            'broken_count': broken_count,
            'refresh_count': refresh_count,
            'checking_count': checking_count,
            'unknown_count': unknown_count,
            'refresh_recommended': refresh_recommended,
        })

    # Apply sorting
    if sort == "name":
        batches_with_info.sort(key=lambda x: x['name'])
    elif sort == "newest":
        batches_with_info.sort(key=lambda x: x['last_updated'] or '', reverse=True)
    elif sort == "biggest":
        batches_with_info.sort(key=lambda x: x['size'], reverse=True)
    elif sort == "size": # Actual file size
        batches_with_info.sort(key=lambda x: x['total_size_mb'], reverse=True)
    else:
        batches_with_info.sort(key=lambda x: x['name'])

    # Return detailed info if requested, otherwise just names for backwards compatibility
    if detailed:
        return batches_with_info
    else:
        return [b['name'] for b in batches_with_info]

@api_v1_router.get("/tags")
@api_legacy_router.get("/tags")
def get_all_tags(db: Session = Depends(get_db)):
    all_tags = set()
    videos = db.query(Video.tags, Video.ai_tags).filter(or_(Video.tags != None, Video.ai_tags != None)).all()
    for video_tags, video_ai_tags in videos:
        if video_tags: all_tags.update(tag.strip() for tag in video_tags.split(',') if tag.strip())
        if video_ai_tags: all_tags.update(tag.strip() for tag in video_ai_tags.split(',') if tag.strip())
    return sorted(list(all_tags))

@api_v1_router.get("/sources")
@api_legacy_router.get("/sources")
def get_all_sources(db: Session = Depends(get_db)):
    """Get unique sources (domains) from video source_urls and tags."""
    sources = set()
    # Common known sources first for better ordering
    common_sources = ["Pixeldrain", "Eporner", "Spankbang", "XVideos", "Bunkr", "Gofile", "Erome", "HQPorner", "Recurbate", "Webshare", "Reddit", "PornOne"]
    
    # Query for unique tags and source_urls
    # We use a limited query to avoid massive scans on huge DBs
    videos = db.query(Video.source_url, Video.tags).filter(or_(Video.source_url != None, Video.tags != None)).limit(5000).all()
    
    for url, tags in videos:
        if url:
            domain = ""
            if "pixeldrain.com" in url.lower(): domain = "Pixeldrain"
            elif "eporner.com" in url.lower(): domain = "Eporner"
            elif "spankbang.com" in url.lower(): domain = "Spankbang"
            elif "xvideos.com" in url.lower(): domain = "XVideos"
            elif "bunkr" in url.lower(): domain = "Bunkr"
            elif "gofile.io" in url.lower(): domain = "Gofile"
            elif "erome.com" in url.lower(): domain = "Erome"
            elif "hqporner.com" in url.lower(): domain = "HQPorner"
            elif "recurbate.com" in url.lower(): domain = "Recurbate"
            elif "webshare" in url.lower(): domain = "Webshare"
            elif "reddit.com" in url.lower(): domain = "Reddit"
            elif "pornone.com" in url.lower(): domain = "PornOne"
            
            if domain: sources.add(domain)
            else:
                try:
                    from urllib.parse import urlparse
                    parsed = urlparse(url)
                    if parsed.netloc:
                        d = parsed.netloc.replace('www.', '').split('.')[0].capitalize()
                        if d: sources.add(d)
                except: pass
        
        if tags:
            # Sources are often stored in tags by extractors
            for t in tags.split(','):
                t = t.strip()
                if t in common_sources:
                    sources.add(t)

    # Combine with common sources to ensure they are always present if they have entries
    return sorted(list(sources))

# --- Config Endpoints ---
@api_v1_router.get("/config/gofile_token")
@api_legacy_router.get("/config/gofile_token")
async def get_gofile_token(x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    ensure_bridge_token(x_nexus_token)
    """Return the configured GoFile user token so extensions can reuse it."""
    from .extractors.gofile import GoFileExtractor
    token = GoFileExtractor._user_token or (config.GOFILE_TOKEN or "")
    return {"token": token}

# --- Stats Endpoints ---
@api_v1_router.get("/stats/batches")
@api_legacy_router.get("/stats/batches")
def api_get_batch_stats(db: Session = Depends(get_db)):
    from app.stats_cache import stats_cache
    return stats_cache.get_or_compute("stats:batches", lambda: get_batch_stats(db), ttl=30.0)

@api_v1_router.get("/stats/tags")
@api_legacy_router.get("/stats/tags")
def api_get_tags_stats(db: Session = Depends(get_db)):
    from app.stats_cache import stats_cache
    return stats_cache.get_or_compute("stats:tags", lambda: get_tags_stats(db), ttl=30.0)

@api_v1_router.get("/stats/quality")
@api_legacy_router.get("/stats/quality")
def api_get_quality_stats(db: Session = Depends(get_db)):
    from app.stats_cache import stats_cache
    return stats_cache.get_or_compute("stats:quality", lambda: get_quality_stats(db), ttl=30.0)

@api_v1_router.get("/search/history")
@api_legacy_router.get("/search/history")
def get_search_history(limit: int = 10, db: Session = Depends(get_db)):
    return db.query(SearchHistory).order_by(desc(SearchHistory.created_at)).limit(limit).all()


def refresh_video_link(video_id: int):
    """Refresh a single video's link via the shared deduplicated refresh service."""
    from app.services_refresh import refresh_video_link_sync
    return refresh_video_link_sync(video_id)

@api_v1_router.post("/batch-action")
@api_legacy_router.post("/batch-action")
def batch_action(req: BatchActionRequest, bg_tasks: BackgroundTasks, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    query = db.query(Video).filter(Video.id.in_(req.video_ids))
    if req.action == 'delete': query.delete(synchronize_session=False)
    elif req.action == 'favorite': query.update({Video.is_favorite: True}, synchronize_session=False)
    elif req.action == 'unfavorite': query.update({Video.is_favorite: False}, synchronize_session=False)
    elif req.action == 'mark_watched': query.update({Video.is_watched: True}, synchronize_session=False)
    elif req.action == 'refresh_links':
        from app.services_refresh import async_refresh_video_link
        video_ids = req.video_ids.copy()
        async def refresh_batch_links():
            await asyncio.gather(*(async_refresh_video_link(vid) for vid in video_ids), return_exceptions=True)
        bg_tasks.add_task(refresh_batch_links)
        db.commit()
        return {"status": "ok", "message": f"Refreshing links for {len(video_ids)} videos in background"}
    
    db.commit()
    return {"status": "ok"}


@api_v1_router.post("/videos/non-matching")
@api_legacy_router.post("/videos/non-matching")
def non_matching_videos(req: NonMatchingVideosRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    scope_query = db.query(Video).filter(Video.title != None, Video.title != "")
    scope_desc_parts = []

    if req.video_ids and len(req.video_ids) > 0:
        scope_query = scope_query.filter(Video.id.in_(req.video_ids))
        scope_desc_parts.append(f"{len(req.video_ids)} označených videí")
    else:
        if req.source_board_id is not None:
            from app.database import SourceBoard
            from app.routers.source_boards import board_video_ids
            board = db.query(SourceBoard).filter(SourceBoard.id == req.source_board_id).first()
            scope_query = scope_query.filter(Video.id.in_(board_video_ids(db, board) if board else []))
            scope_desc_parts.append(f"Source Board „{board.name if board else req.source_board_id}“")
        selected_batches = [b.strip() for b in (req.batches or "").split(",") if b.strip()]
        if selected_batches:
            scope_query = scope_query.filter(Video.batch_name.in_(selected_batches))
            scope_desc_parts.append(f"Importy: {', '.join(selected_batches)}")
        elif req.batch and req.batch != "All":
            scope_query = scope_query.filter(Video.batch_name == req.batch)
            scope_desc_parts.append(f"Import „{req.batch}“")

        if req.search:
            numeric_search = req.search.strip()
            search_clauses = [
                Video.batch_name.contains(req.search),
                Video.source_url.contains(req.search),
                Video.url.contains(req.search),
                Video.title.contains(req.search),
                Video.tags.contains(req.search),
                Video.ai_tags.contains(req.search),
            ]
            if numeric_search.isdigit():
                search_clauses.append(Video.id == int(numeric_search))
            scope_query = scope_query.filter(or_(*search_clauses))
            scope_desc_parts.append(f"Hľadanie „{req.search}“")

    if not scope_desc_parts:
        scope_desc_parts.append("Celá knižnica")

    matched_query = scope_query
    active_filters_desc = []

    if req.favorites_only:
        matched_query = matched_query.filter(Video.is_favorite == True)
        active_filters_desc.append("len obľúbené")

    if req.no_thumb_only:
        matched_query = matched_query.filter(or_(Video.thumbnail_path == None, Video.thumbnail_path == '', Video.thumbnail_path == '/static/placeholder.jpg'))
        active_filters_desc.append("len bez náhľadu")

    if req.duration_min > 0:
        matched_query = matched_query.filter(Video.duration >= req.duration_min)
        active_filters_desc.append(f"trvanie ≥ {round(req.duration_min / 60, 1)}m")

    if req.duration_max > 0 and req.duration_max < 99999:
        matched_query = matched_query.filter(Video.duration <= req.duration_max)
        active_filters_desc.append(f"trvanie ≤ {round(req.duration_max / 60, 1)}m")

    if req.size_min > 0:
        matched_query = matched_query.filter(Video.file_size_mb >= req.size_min)
        active_filters_desc.append(f"veľkosť ≥ {req.size_min} MB")

    if req.size_max > 0:
        matched_query = matched_query.filter(Video.file_size_mb <= req.size_max)
        active_filters_desc.append(f"veľkosť ≤ {req.size_max} MB")

    selected_qualities = [q.strip() for q in (req.qualities or "").split(",") if q.strip()]
    if req.quality != "All":
        if req.quality == "4K": matched_query = matched_query.filter(Video.height >= 2160)
        elif req.quality == "1440p": matched_query = matched_query.filter(Video.height >= 1440, Video.height < 2160)
        elif req.quality in ["1080p", "FHD"]: matched_query = matched_query.filter(Video.height >= 1080, Video.height < 1440)
        elif req.quality in ["720p", "HD"]: matched_query = matched_query.filter(Video.height >= 720, Video.height < 1080)
        elif req.quality == "SD": matched_query = matched_query.filter(Video.height < 720)
        active_filters_desc.append(f"kvalita {req.quality}")
    elif selected_qualities:
        quality_clauses = []
        for q in selected_qualities:
            if q == "4K": quality_clauses.append(Video.height >= 2160)
            elif q == "1440p": quality_clauses.append(and_(Video.height >= 1440, Video.height < 2160))
            elif q in ("1080p", "FHD"): quality_clauses.append(and_(Video.height >= 1080, Video.height < 1440))
            elif q in ("720p", "HD"): quality_clauses.append(and_(Video.height >= 720, Video.height < 1080))
            elif q == "SD": quality_clauses.append(Video.height < 720)
        if quality_clauses:
            matched_query = matched_query.filter(or_(*quality_clauses))
            active_filters_desc.append(f"kvality: {', '.join(selected_qualities)}")

    selected_sources = [s.strip() for s in (req.sources or "").split(",") if s.strip()]
    if req.source and req.source != "All":
        source_lower = req.source.lower()
        matched_query = matched_query.filter(or_(Video.source_url.contains(source_lower), Video.tags.contains(req.source)))
        active_filters_desc.append(f"zdroj {req.source}")
    elif selected_sources:
        source_clauses = []
        for s in selected_sources:
            sl = s.lower()
            source_clauses.append(Video.source_url.contains(sl))
            source_clauses.append(Video.tags.contains(s))
        matched_query = matched_query.filter(or_(*source_clauses))
        active_filters_desc.append(f"zdroje: {', '.join(selected_sources)}")

    selected_tags = [t.strip() for t in (req.tags or "").split(",") if t.strip()]
    if selected_tags:
        tag_clauses = []
        for t in selected_tags:
            tag_clauses.append(Video.tags.contains(t))
            tag_clauses.append(Video.ai_tags.contains(t))
        matched_query = matched_query.filter(or_(*tag_clauses))
        active_filters_desc.append(f"tagy: {', '.join(selected_tags)}")

    if req.dateMin:
        try:
            matched_query = matched_query.filter(Video.created_at >= datetime.datetime.fromisoformat(req.dateMin))
            active_filters_desc.append(f"dátum od {req.dateMin}")
        except ValueError: pass
    if req.dateMax:
        try:
            matched_query = matched_query.filter(Video.created_at < datetime.datetime.fromisoformat(req.dateMax) + datetime.timedelta(days=1))
            active_filters_desc.append(f"dátum do {req.dateMax}")
        except ValueError: pass

    all_scope_ids = set(r[0] for r in scope_query.with_entities(Video.id).all())

    if not active_filters_desc:
        return {
            "status": "ok",
            "total_in_scope": len(all_scope_ids),
            "matched_count": len(all_scope_ids),
            "non_matching_count": 0,
            "non_matching_ids": [],
            "scope_description": " • ".join(scope_desc_parts),
            "active_filters": "Žiadne aktívne filtre (veľkosť, dĺžka, kvalita...)",
            "message": "Nie je aktívny žiadny filter."
        }

    matched_ids = set(r[0] for r in matched_query.with_entities(Video.id).all())
    non_matching_ids = list(all_scope_ids - matched_ids)

    if req.action == "delete":
        deleted_count = 0
        if non_matching_ids:
            for i in range(0, len(non_matching_ids), 500):
                chunk = non_matching_ids[i:i + 500]
                videos_to_del = db.query(Video).filter(Video.id.in_(chunk)).all()
                for v in videos_to_del:
                    if v.thumbnail_path and not v.thumbnail_path.startswith("http"):
                        thumb_path = f"app{v.thumbnail_path.split('?')[0]}"
                        if os.path.exists(thumb_path):
                            try: os.remove(thumb_path)
                            except Exception: pass
                db.query(Video).filter(Video.id.in_(chunk)).delete(synchronize_session=False)
                deleted_count += len(chunk)
            db.commit()
        return {
            "status": "ok",
            "deleted_count": deleted_count,
            "remaining_count": len(matched_ids),
            "scope_description": " • ".join(scope_desc_parts),
            "active_filters": ", ".join(active_filters_desc)
        }

    return {
        "status": "ok",
        "total_in_scope": len(all_scope_ids),
        "matched_count": len(matched_ids),
        "non_matching_count": len(non_matching_ids),
        "non_matching_ids": non_matching_ids[:200],
        "scope_description": " • ".join(scope_desc_parts),
        "active_filters": ", ".join(active_filters_desc)
    }


@api_v1_router.post("/batch/refresh")
@api_legacy_router.post("/batch/refresh")
def refresh_entire_batch(req: BatchRefreshRequest, bg_tasks: BackgroundTasks, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Refresh all video links for an entire batch in the background.
    """
    if not req.batch_name or req.batch_name == "All":
        raise HTTPException(status_code=400, detail="A specific batch name is required.")
    
    video_ids_query = db.query(Video.id).filter(Video.batch_name == req.batch_name).all()
    video_ids = [v_id for v_id, in video_ids_query]

    if not video_ids:
        return {"status": "ok", "message": "No videos found in this batch."}

    from app.services_refresh import async_refresh_video_link

    async def refresh_batch_links():
        await asyncio.gather(*(async_refresh_video_link(vid) for vid in video_ids), return_exceptions=True)

    bg_tasks.add_task(refresh_batch_links)
    
    logging.info(f"Queued link refresh for {len(video_ids)} videos in batch '{req.batch_name}'.")
    
    return {"status": "ok", "message": f"Refreshing links for {len(video_ids)} videos in batch '{req.batch_name}' in the background."}

@api_v1_router.post("/batch/regenerate-thumbnails")
@api_legacy_router.post("/batch/regenerate-thumbnails")
def regenerate_batch_thumbnails(req: BatchRefreshRequest, bg_tasks: BackgroundTasks, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Regenerate thumbnails/metadata for all videos in a specific batch in the background.
    """
    if not req.batch_name or req.batch_name == "All":
        raise HTTPException(status_code=400, detail="A specific batch name is required.")

    videos = db.query(Video.id).filter(Video.batch_name == req.batch_name).all()
    video_ids = [video_id for video_id, in videos]

    if not video_ids:
        return {"status": "ok", "message": "No videos found in this batch."}

    processor = VIPVideoProcessor()

    async def regenerate_all():
        for video_id in video_ids:
            try:
                await processor.process_single_video(video_id, force=True, quality_mode="mp4", extractor="auto")
            except Exception as e:
                logging.error(f"Batch thumbnail regeneration failed for video {video_id}: {e}")

    bg_tasks.add_task(regenerate_all)
    logging.info(f"Queued thumbnail regeneration for {len(video_ids)} videos in batch '{req.batch_name}'.")
    return {"status": "ok", "message": f"Regenerating thumbnails for {len(video_ids)} videos in batch '{req.batch_name}' in the background."}


@api_v1_router.post("/batch/delete-all")
@api_legacy_router.post("/batch/delete-all")
def delete_entire_batch(req: BatchDeleteRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    if not req.batch_name or req.batch_name == "All": raise HTTPException(400)
    db.query(Video).filter(Video.batch_name == req.batch_name).delete(synchronize_session=False)
    db.commit()
    return {"status": "deleted", "batch": req.batch_name}

@api_v1_router.put("/videos/{video_id}")
@api_legacy_router.put("/videos/{video_id}")
def update_video(video_id: int, update: VideoUpdate, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    v = db.query(Video).get(video_id)
    if not v: raise HTTPException(404)
    if update.is_favorite is not None: v.is_favorite = update.is_favorite
    if update.is_watched is not None: v.is_watched = update.is_watched
    if update.resume_time is not None: v.resume_time = update.resume_time
    if update.duration is not None and update.duration > 0 and not (v.duration and v.duration > 0):
        v.duration = float(update.duration)
    if update.height is not None and update.height > 0 and not (v.height and v.height > 0):
        h = int(update.height)
        v.height = h
        v.quality = "4K" if h >= 2160 else "1440p" if h >= 1440 else "FHD" if h >= 1080 else "HD" if h >= 720 else "SD"
    if update.width is not None and update.width > 0 and not (v.width and v.width > 0):
        v.width = int(update.width)
    if update.tags is not None: v.tags = update.tags
    if update.models is not None: v.models = update.models
    if update.url is not None and update.url.startswith("http"):
        logging.info("[URL-push] video %s url updated by extension: %s", video_id, update.url[:100])
        v.url = update.url
    db.commit()
    return v

class BrowserRefreshStreamRequest(BaseModel):
    stream_url: str
    height: Optional[int] = None
    width: Optional[int] = None

@api_v1_router.post("/videos/{video_id}/browser-refresh-stream")
@api_legacy_router.post("/videos/{video_id}/browser-refresh-stream")
def browser_refresh_stream(
    video_id: int,
    req: BrowserRefreshStreamRequest,
    db: Session = Depends(get_db),
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
):
    """Extension pushes a freshly-resolved stream URL for an IP-banned source (e.g. eporner)."""
    from app.routers.extension_bridge import ensure_bridge_token
    ensure_bridge_token(x_nexus_token)
    v = db.query(Video).get(video_id)
    if not v:
        raise HTTPException(404)
    if not req.stream_url.startswith("http"):
        raise HTTPException(400, "stream_url must be an absolute URL")
    v.url = req.stream_url
    if req.height:
        v.height = req.height
    if req.width:
        v.width = req.width
    # A refreshed link is a working link: without clearing the previous verdict
    # the row keeps whatever "broken"/"error" state the expired URL earned, and
    # the health badge still reads broken after a successful refresh.
    v.link_status = "working"
    v.last_checked = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    if (v.status or "").lower() in {"error", "failed"}:
        v.status = "ready_to_stream"
        v.error_msg = None
    db.commit()
    logging.info(f"[BROWSER-REFRESH] Video {video_id} stream updated via extension: {req.stream_url[:100]}")
    return {"ok": True, "video_id": video_id, "stream_url": req.stream_url}


@api_v1_router.get("/videos/stale-streams")
@api_legacy_router.get("/videos/stale-streams")
def list_stale_streams(
    source: str = "",
    limit: int = 200,
    grace_minutes: int = 15,
    db: Session = Depends(get_db),
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
):
    """Remote videos whose signed stream URL has expired (or is about to).

    The extension polls this to know what to re-resolve: the server cannot
    refresh these itself for sources that gate on a logged-in session, so it
    reports the work rather than attempting it. Expiry is read out of the URL,
    so answering costs no upstream requests.
    """
    from app.routers.extension_bridge import ensure_bridge_token
    ensure_bridge_token(x_nexus_token)

    query = db.query(Video).filter(Video.storage_type == "remote")
    needle = (source or "").strip().lower()
    if needle:
        query = query.filter(
            or_(Video.url.ilike(f"%{needle}%"), Video.source_url.ilike(f"%{needle}%"))
        )

    rows = []
    # Newest first: a link the user just imported is the one they are most
    # likely about to press play on.
    for video in query.order_by(Video.id.desc()).limit(max(1, min(limit, 1000)) * 5):
        if not signed_link_is_stale(video.url or "", grace_minutes=grace_minutes):
            continue
        deadline = signed_link_expiry(video.url or "")
        rows.append({
            "id": video.id,
            "title": video.title,
            "source_url": video.source_url or "",
            "url": video.url or "",
            "height": video.height or 0,
            "expired_at": deadline.isoformat() + "Z" if deadline else None,
        })
        if len(rows) >= limit:
            break

    return {"count": len(rows), "videos": rows}

@api_v1_router.post("/videos/{video_id}/regenerate")
@api_legacy_router.post("/videos/{video_id}/regenerate")
def regenerate_thumbnail(video_id: int, bg_tasks: BackgroundTasks, mode: str = "mp4", extractor: str = "auto", db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    v = db.query(Video).get(video_id)
    if not v: raise HTTPException(404)
    from app.services import _preserve_telegram_video_for_preview
    if _preserve_telegram_video_for_preview(v, video_id):
        db.commit()
        return {
            "status": "skipped",
            "id": video_id,
            "message": "Telegram náhľad sa načítava priamo z Telegramu; všeobecné generovanie sa preskočilo.",
        }
    v.status = "pending"
    v.error_msg = None
    db.commit()
    processor = VIPVideoProcessor()
    bg_tasks.add_task(processor.process_single_video, video_id, force=True, quality_mode=mode, extractor=extractor)
    return {"status": "queued", "id": video_id}

@api_v1_router.post("/videos/{video_id}/refresh")
@api_legacy_router.post("/videos/{video_id}/refresh")
async def refresh_video_url(video_id: int, sync: bool = False, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Refresh video URL via deduplicated async worker (Filester, Turbo, Bunkr, Beeg, etc.)."""
    from app.services_refresh import async_refresh_video_link, schedule_background_refresh

    v = db.query(Video).get(video_id)
    if not v:
        raise HTTPException(404)

    if sync:
        new_url = await async_refresh_video_link(video_id)
        db.expire_all()
        v = db.query(Video).get(video_id)
        return {"status": "refreshed", "id": video_id, "url": new_url or (v.url if v else None)}

    scheduled = schedule_background_refresh(video_id)
    return {
        "status": "refreshing" if scheduled else "already_refreshing",
        "id": video_id,
        "message": "Link refresh started" if scheduled else "Link refresh already in progress",
    }


@api_v1_router.post("/videos/{video_id}/full-refresh")
@api_legacy_router.post("/videos/{video_id}/full-refresh")
def full_refresh_video(video_id: int, bg_tasks: BackgroundTasks, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Full re-extraction: re-runs extractor plugin, updates stream URL, thumbnail, duration, height."""
    v = db.query(Video).get(video_id)
    if not v:
        raise HTTPException(404)

    async def _do_full_refresh():
        _db = SessionLocal()
        try:
            _v = _db.query(Video).get(video_id)
            if not _v:
                return

            from .telegram_service import verify_telegram_library_video
            telegram_refresh = await verify_telegram_library_video(_v)
            if telegram_refresh is not None:
                _v.last_checked = datetime.datetime.now()
                _db.commit()
                logging.info("[full-refresh] telegram stream kept for video %s", video_id)
                return

            # 1. Re-run extractor plugin (covers Filester, fileditchfiles, Camwhores, etc.)
            try:
                from .extractors import ExtractorRegistry
                lookup_url = _v.source_url or _v.url or ""
                plugin = ExtractorRegistry.find_extractor(lookup_url)
                if plugin:
                    meta = await plugin.extract(lookup_url)
                    if meta and meta.get("stream_url"):
                        _v.url = meta["stream_url"]
                        _v.status = "ready_to_stream"
                        if meta.get("title") and (not _v.title or _v.title.lower().startswith("queued")):
                            _v.title = meta["title"]
                        if meta.get("height"):
                            _v.height = int(meta["height"])
                            h = int(meta["height"])
                            _v.quality = "4K" if h >= 2160 else "2K" if h >= 1440 else "FHD" if h >= 1080 else "HD" if h >= 720 else "SD"
                        if meta.get("duration") and not _v.duration:
                            _v.duration = float(meta["duration"])
                        if meta.get("thumbnail") and str(meta["thumbnail"]).startswith("http"):
                            from app.routers.bulk_import import _background_localize_remote_thumbnail
                            _db.commit()
                            await _background_localize_remote_thumbnail(video_id, meta["thumbnail"], lookup_url)
                            return
                        _db.commit()
                        logging.info("[full-refresh] plugin %s refreshed video %s", plugin.name, video_id)
                        return
            except Exception as e:
                logging.warning("[full-refresh] plugin failed for video %s: %s", video_id, e)

            # 2. Fallback: regular refresh_video_link
            import threading
            t = threading.Thread(target=refresh_video_link, args=(video_id,))
            t.start()

        except Exception as e:
            logging.error("[full-refresh] error for video %s: %s", video_id, e)
        finally:
            _db.close()

    bg_tasks.add_task(_do_full_refresh)
    return {"status": "ok", "id": video_id, "message": "Full refresh started"}

import re

# ... existing code ...

active_downloads = {}

@api_v1_router.get("/downloads/active")
@api_legacy_router.get("/downloads/active")
async def get_active_downloads():
    from .download_manager import DownloadManagerError, download_manager

    results = dict(active_downloads)
    try:
        state = await download_manager.status()
    except (DownloadManagerError, OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    for task in state["tasks"]:
        video_id = task.get("videoId")
        if video_id is None or task["status"] not in {"active", "waiting", "paused"}:
            continue
        results[str(video_id)] = {
            "id": task["gid"],
            "video_id": video_id,
            "title": task["filename"],
            "percent": task["progress"],
            "downloaded_mb": task["completedLength"] / (1024 * 1024),
            "total_mb": task["totalLength"] / (1024 * 1024),
            "speed_mb_s": task["downloadSpeed"] / (1024 * 1024),
        }
    return results

async def _download_hls_parallel(playlist_url: str, output_path: str, video_id: int) -> bool:
    """Fetch every .ts segment of an HLS stream concurrently, then remux to MP4.

    `ffmpeg -i <m3u8> -c copy out.mp4` (the previous HLS path here) pulls
    segments through ffmpeg's own HTTP demuxer one at a time — on a stream
    with a short-lived signed URL (e.g. HotContainer's ~1-3h token) that can
    be slower than the token's own lifetime for a long video. Segments are
    independent byte ranges, so fetching many at once and only handing
    ffmpeg the already-local concatenation cuts wall time roughly by the
    concurrency factor, matching a multi-connection downloader like aria2c
    (already used for the direct-mp4 branch below) instead of a strictly
    serial fetch.
    """
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
    }

    async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=headers) as client:
        resp = await client.get(playlist_url)
        resp.raise_for_status()
        playlist_text = resp.text
        base_url = str(resp.url)

        # A master playlist lists variant streams instead of segments — pick
        # the highest-bandwidth one and re-fetch it as the real media playlist.
        if "#EXT-X-STREAM-INF" in playlist_text:
            variants = []
            lines = playlist_text.splitlines()
            for i, line in enumerate(lines):
                if line.startswith("#EXT-X-STREAM-INF"):
                    bw_m = re.search(r"BANDWIDTH=(\d+)", line)
                    bandwidth = int(bw_m.group(1)) if bw_m else 0
                    if i + 1 < len(lines) and lines[i + 1] and not lines[i + 1].startswith("#"):
                        variants.append((bandwidth, lines[i + 1].strip()))
            if variants:
                best_variant = max(variants, key=lambda v: v[0])[1]
                media_url = urllib.parse.urljoin(base_url, best_variant)
                resp = await client.get(media_url)
                resp.raise_for_status()
                playlist_text = resp.text
                base_url = str(resp.url)

        segment_urls = [
            urllib.parse.urljoin(base_url, line.strip())
            for line in playlist_text.splitlines()
            if line.strip() and not line.startswith("#")
        ]
        if not segment_urls:
            return False

        active_downloads[video_id] = {"percent": 0, "downloaded_mb": 0, "total_mb": 0, "speed_mb_s": 0}
        segments: list[Optional[bytes]] = [None] * len(segment_urls)
        done_count = 0
        start_time = time.monotonic()
        sem = asyncio.Semaphore(16)

        async def fetch_one(index: int, seg_url: str) -> None:
            nonlocal done_count
            async with sem:
                seg_resp = await client.get(seg_url)
                seg_resp.raise_for_status()
                segments[index] = seg_resp.content
            done_count += 1
            downloaded_mb = sum(len(s) for s in segments if s) / 1048576
            elapsed = max(time.monotonic() - start_time, 0.01)
            active_downloads[video_id] = {
                "percent": int(done_count / len(segment_urls) * 100),
                "downloaded_mb": round(downloaded_mb, 1),
                "total_mb": 0,
                "speed_mb_s": round(downloaded_mb / elapsed, 1),
            }

        await asyncio.gather(*(fetch_one(i, u) for i, u in enumerate(segment_urls)))

    if any(s is None for s in segments):
        return False

    concat_path = output_path + ".ts.tmp"
    with open(concat_path, "wb") as fh:
        for seg in segments:
            fh.write(seg)

    try:
        from .services import FFMPEG_CMD
    except Exception:  # noqa: BLE001
        FFMPEG_CMD = "ffmpeg"

    remux_cmd = [
        FFMPEG_CMD, "-y", "-hide_banner", "-loglevel", "error",
        "-i", concat_path, "-c", "copy", "-bsf:a", "aac_adtstoasc",
        output_path,
    ]
    proc = await asyncio.create_subprocess_exec(*remux_cmd)
    await proc.wait()
    try:
        os.remove(concat_path)
    except OSError:
        pass
    return proc.returncode == 0 and os.path.exists(output_path)

def run_aria_download(video_id: int):
    db = SessionLocal()
    v = db.query(Video).get(video_id)
    if not v:
        db.close()
        return

    try:
        output_dir = os.path.join("app", "static", "local_videos")
        os.makedirs(output_dir, exist_ok=True)
        
        # Sanitize filename
        safe_title = "".join([c for c in v.title if c.isalnum() or c in (' ','-','_')]).strip().replace(' ', '_')
        safe_filename = f"video_{video_id}_{safe_title[:50]}.mp4"
        
        is_hls = ".m3u8" in v.url.lower()

        if is_hls:
            # Segments fetched concurrently (see _download_hls_parallel) instead
            # of ffmpeg's serial HTTP demuxer — matters most for a short-lived
            # signed URL (HotContainer-style) that can outlive a sequential pull.
            print(f"Starting HLS Download for video {video_id} via parallel segment fetch...")
            output_path = os.path.join(output_dir, safe_filename)
            hls_start = datetime.datetime.now()
            success = asyncio.run(_download_hls_parallel(v.url, output_path, video_id))
            if success:
                end_time = datetime.datetime.now()
                duration_sec = (end_time - hls_start).total_seconds()
                final_total_mb = os.path.getsize(output_path) / (1024 * 1024)
                v.status = "ready"
                v.storage_type = "local"
                v.url = f"/static/local_videos/{safe_filename}"
                v.download_stats = {
                    "avg_speed_mb": round(final_total_mb / duration_sec, 2) if duration_sec > 0 else 0,
                    "time_sec": round(duration_sec, 2),
                    "size_mb": round(final_total_mb, 2),
                    "date": end_time.isoformat(),
                }
            else:
                v.status = "error"
                v.error_msg = "HLS parallel download failed."
            db.commit()
            return
        else:
            aria2c_path = "aria2c.exe"
            if not os.path.isfile(aria2c_path):
                 aria2c_path = os.path.join("app", "aria2c.exe")
            
            # If aria2c is still not found, fall back to Archivist downloader instead of crashing
            if not os.path.isfile(aria2c_path):
                print("aria2c binary not found, falling back to Archivist downloader.")
                v.status = "downloading"
                db.commit()
                batch_folder = Archivist.sanitize_component(v.batch_name or "General", default="General")
                success = asyncio.run(archivist.download_file(v.url, "Legacy", batch_folder, safe_filename))
                if success:
                    v.status = "ready"
                    v.storage_type = "local"
                    v.url = f"/static/local_videos/Legacy/{batch_folder}/{safe_filename}"
                else:
                    v.status = "error"
                    v.error_msg = "aria2c not installed and Archivist fallback failed."
                db.commit()
                return
            
            command = [
                aria2c_path,
                "--file-allocation=none",
                "--continue=true",
                "--max-connection-per-server=16",
                "--split=16",
                "--min-split-size=512K",
                "--dir", output_dir,
                "--out", safe_filename,
                v.url
            ]
            print(f"Starting Turbo Download for video {video_id}: {' '.join(command)}")

        # Init progress
        active_downloads[video_id] = 0
        start_time = datetime.datetime.now()
        speed_samples = []
        final_total_mb = 0

        process = subprocess.Popen(
            command, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.STDOUT, 
            text=True, 
            encoding='utf-8', 
            errors='ignore',
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        )

        # Regex for Aria2c progress: ( 35%)
        # Example output: [#2089b0 10MiB/20MiB(50%) CN:1 DL:1.2MiB]
        progress_pattern = re.compile(r'\((\d+)%\)')
        detailed_pattern = re.compile(
            r'(?P<done>[\d\.]+)(?P<done_unit>[KMG]?i?B)/(?P<total>[\d\.]+)(?P<total_unit>[KMG]?i?B)\('
            r'(?P<percent>\d+)%\).*DL:(?P<speed>[\d\.]+)(?P<speed_unit>[KMG]?i?B)'
        )

        def _to_mb(value: float, unit: str) -> float:
            unit = unit.upper()
            if unit.startswith('K'):
                return value / 1024.0
            if unit.startswith('G'):
                return value * 1024.0
            # default MiB
            return value

        while True:
            line = process.stdout.readline()
            if not line and process.poll() is not None:
                break

            if not line:
                continue

            m_full = detailed_pattern.search(line)
            if m_full:
                try:
                    done = float(m_full.group('done'))
                    done_unit = m_full.group('done_unit')
                    total = float(m_full.group('total'))
                    total_unit = m_full.group('total_unit')
                    percent = int(m_full.group('percent'))
                    speed = float(m_full.group('speed'))
                    speed_unit = m_full.group('speed_unit')

                    done_mb = _to_mb(done, done_unit)
                    total_mb = _to_mb(total, total_unit)
                    speed_mb_s = _to_mb(speed, speed_unit)
                    
                    final_total_mb = total_mb
                    if speed_mb_s > 0:
                        speed_samples.append(speed_mb_s)

                    active_downloads[video_id] = {
                        "percent": percent,
                        "downloaded_mb": round(done_mb, 1),
                        "total_mb": round(total_mb, 1),
                        "speed_mb_s": round(speed_mb_s, 1),
                    }
                except Exception:
                    # Fall back to simple percent parsing below on any error
                    pass

            # Fallback: only percent known or older aria2c formats
            if video_id not in active_downloads or isinstance(active_downloads[video_id], (int, float)):
                m = progress_pattern.search(line)
                if m:
                    try:
                        percent = int(m.group(1))
                        active_downloads[video_id] = percent
                    except Exception:
                        pass

        rc = process.poll()

        if rc == 0:
            v.status = "ready"
            v.storage_type = "local"
            v.url = f"/static/local_videos/{safe_filename}"
            # Calculate and save download stats
            end_time = datetime.datetime.now()
            duration_sec = (end_time - start_time).total_seconds()
            avg_speed = sum(speed_samples) / len(speed_samples) if speed_samples else 0
            max_speed = max(speed_samples) if speed_samples else 0
            
            # If total_mb was not captured correctly, try to get file size
            if final_total_mb == 0 and os.path.exists(output_dir + "/" + safe_filename):
                final_total_mb = os.path.getsize(output_dir + "/" + safe_filename) / (1024 * 1024)
            
            # Recalculate average speed more accurately based on size/time if available
            if duration_sec > 0 and final_total_mb > 0:
                avg_speed = final_total_mb / duration_sec
                
            v.download_stats = {
                "avg_speed_mb": round(avg_speed, 2),
                "max_speed_mb": round(max_speed, 2),
                "time_sec": round(duration_sec, 2),
                "size_mb": round(final_total_mb, 2),
                "date": end_time.isoformat()
            }
        else:
            # Fallback to Archivist if Aria2c fails or for specific streams
            v.status = "downloading"
            db.commit()
            batch_folder = Archivist.sanitize_component(v.batch_name or "General", default="General")
            success = asyncio.run(archivist.download_file(v.url, "Legacy", batch_folder, safe_filename))
            if success:
                v.status = "ready"
                v.storage_type = "local"
                v.url = f"/static/local_videos/Legacy/{batch_folder}/{safe_filename}"
                v.download_stats = {"note": "Downloaded via Legacy Archivist (no stats)"}
            else:
                v.status = "error"
                v.error_msg = f"Aria2c exited with code {rc} and Archivist fallback failed."
        
        db.commit()

    except Exception as e:
        print(f"Error in run_aria_download for video {video_id}: {e}")
        v.status = "error"
        v.error_msg = str(e)
        db.commit()
    finally:
        if video_id in active_downloads:
            del active_downloads[video_id]
        db.close()

@api_v1_router.post("/videos/{video_id}/download")
@api_legacy_router.post("/videos/{video_id}/download")
async def manual_download_video(
    video_id: int,
    request: Request,
    bg_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    v = db.query(Video).get(video_id)
    if not v:
        raise HTTPException(404, "Video not found")

    internal_source = None
    internal_download_url = None
    if (v.telegram_chat_id and v.telegram_message_id) or _routes_mega._is_mega_video(v):
        try:
            if v.telegram_chat_id and v.telegram_message_id:
                internal_source = "telegram"
                stream_route = request.url_for("stream_video", chat_id=int(v.telegram_chat_id),
                                               message_id=int(v.telegram_message_id))
            else:
                internal_source = "mega"
                stream_route = request.url_for("mega_download", video_id=video_id)
            server = request.scope.get("server")
            if not server or not server[1]:
                raise ValueError("The local server port is unavailable")
            internal_download_url = f"http://127.0.0.1:{int(server[1])}{stream_route.path}"
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=503, detail=f"Could not create an internal download URL: {exc}") from exc

    if not internal_download_url and not v.url.startswith("http"):
        return {"status": "already_local", "video_id": video_id}
    
    download_url = internal_download_url or v.url
    if not internal_download_url and ".m3u8" in v.url.lower():
        v.status = "downloading"
        db.commit()
        bg_tasks.add_task(run_aria_download, video_id)
        return {"status": "download_queued", "video_id": video_id, "legacy_hls": True}

    from .download_manager import DownloadManagerError, download_manager
    url_path = urllib.parse.urlsplit(download_url).path
    extension = Path(url_path).suffix
    if not re.fullmatch(r"\.[a-zA-Z0-9]{1,10}", extension or ""):
        extension = ".mp4"
    safe_title = re.sub(r"[^A-Za-z0-9_-]+", "_", (v.title or "").strip())[:60].strip("_")
    filename = f"video_{video_id}_{safe_title or 'download'}{extension}"
    try:
        queued = await download_manager.add_url(
            download_url,
            filename=None if internal_source == "mega" else filename,
            title=v.title,
            video_id=video_id,
            source=internal_source or "gallery",
            referer=(
                v.source_url
                if not internal_download_url and (v.source_url or "").startswith(("http://", "https://"))
                else None
            ),
            allow_localhost=bool(internal_download_url),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (DownloadManagerError, OSError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {"status": "download_queued", "video_id": video_id, **queued}

class ExternalDownloadRequest(BaseModel):
    url: str
    title: Optional[str] = "External Download"

@api_v1_router.post("/download/external")
@api_legacy_router.post("/download/external")
async def download_external_video(req: ExternalDownloadRequest, bg_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    Imports an external URL (if new) and immediately triggers aria2c download.
    """
    if any(ord(character) < 32 or ord(character) == 127 for character in req.url):
        raise HTTPException(status_code=400, detail="Download URL contains invalid control characters")
    try:
        require_public_http_url(req.url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # Check if already exists by source_url or url
    v = db.query(Video).filter(or_(Video.source_url == req.url, Video.url == req.url)).first()
    
    if not v:
        # Create new video entry
        v = Video(
            title=req.title, 
            url=req.url, 
            source_url=req.url, 
            batch_name=f"Download_{datetime.datetime.now().strftime('%d.%m')}", 
            status="pending"
        )
        db.add(v)
        db.commit()
        db.refresh(v)
        VIPVideoProcessor().broadcast_new_video(v)
    else:
        # If it exists but is local, return
        if not v.url.startswith("http"):
             return {"status": "already_local", "video_id": v.id}
    
    v.status = 'ready_to_stream' # Import as metadata only
    db.commit()

    from .download_manager import DownloadManagerError, download_manager
    try:
        queued = await download_manager.add_url(
            req.url,
            title=req.title,
            video_id=v.id,
            source="external",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (DownloadManagerError, OSError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    bg_tasks.add_task(VIPVideoProcessor().process_single_video, v.id)
    return {
        "status": "download_queued",
        "video_id": v.id,
        **queued,
        "message": "Download queued and video metadata imported",
    }

# --- BRIDGE EXTENSION ENDPOINTS ---

class BridgeSyncRequest(BaseModel):
    url: str
    cookies: Optional[str] = None
    user_agent: Optional[str] = None
    html_content: Optional[str] = None

def ensure_bridge_token(x_nexus_token: Optional[str]) -> None:
    """If NEXUS_BRIDGE_TOKEN is configured, require matching X-Nexus-Token header."""
    required_token = config.NEXUS_BRIDGE_TOKEN
    if not required_token:
        return
    if not x_nexus_token or x_nexus_token.strip() != required_token:
        raise HTTPException(status_code=401, detail="Invalid bridge token")

@api_v1_router.get("/bridge/ping")
@api_legacy_router.get("/bridge/ping")
async def bridge_ping(x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    ensure_bridge_token(x_nexus_token)
    return {"status": "ok", "service": "bridge"}

@api_v1_router.post("/bridge/sync")
@api_legacy_router.post("/bridge/sync")
async def bridge_sync(req: BridgeSyncRequest, x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    """
    Receives session data (cookies, ua) from Chrome Extension.
    Saves to domain-specific cookie files.
    """
    domain = urllib.parse.urlparse(req.url).netloc
    
    # Security: whitelist allowed domains to prevent cookie dumping abuse
    # For now allow all, but good to keep in mind
    ensure_bridge_token(x_nexus_token)
    
    if req.cookies:
        # Simple heuristic to map domain to cookie filename
        filename = "cookies.txt" # Default
        if "bunkr" in domain: filename = "bunkr.cookies.txt"
        elif "xvideos" in domain: filename = "xvideos.cookies.txt"
        elif "simpcity" in domain: filename = "simpcity.cookies.txt"
        elif "faphouse" in domain: filename = "faphouse.cookies.txt"
        
        # Save cookies in Netscape format (simplified) or raw header format
        # yt-dlp prefers Netscape, but raw header file also works if passed as --add-header
        # We will save as raw key=value string for requests lib and maybe convert for yt-dlp later
        # Actually, for this prototype, we just save the 'Cookie' header string to a file
        # that our Extractors can read and inject into requests headers.
        
        with open(filename, 'w') as f:
            f.write(req.cookies)
            
        # --- CONVERT TO NETSCAPE FOR YT-DLP ---
        try:
            netscape_name = filename.replace(".cookies.txt", ".netscape.txt") if ".cookies.txt" in filename else "cookies.netscape.txt"
            with open(netscape_name, 'w') as f:
                f.write("# Netscape HTTP Cookie File\n")
                # Domain should start with . for wildcards
                dot_domain = f".{domain}" if not domain.startswith(".") else domain
                # Format: domain, flag, path, secure, expiration, name, value
                # Since we have raw string "a=b; c=d", we split and guess
                pairs = [p.strip() for p in req.cookies.split(';') if '=' in p]
                expiry = str(int(datetime.datetime.now().timestamp()) + 86400 * 30) # +30 days
                for p in pairs:
                    name, val = p.split('=', 1)
                    f.write(f"{dot_domain}\tTRUE\t/\tTRUE\t{expiry}\t{name}\t{val}\n")
            logging.info(f"Bridge: Converted to Netscape: {netscape_name}")
        except Exception as e:
            logging.error(f"Cookie conversion failed: {e}")

        logging.info(f"Bridge: Saved cookies for {domain} to {filename}")

    return {"status": "synced", "domain": domain}

class BridgeImportRequest(BaseModel):
    urls: List[str]
    batch_name: str = "Bridge Import"
    cookies: Optional[str] = None # Optional overriding cookies

@api_v1_router.post("/bridge/import")
@api_legacy_router.post("/bridge/import")
async def bridge_import(req: BridgeImportRequest, bg_tasks: BackgroundTasks, x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    """
    Import URLs specifically from the extension, possibly with fresh cookies.
    """
    ensure_bridge_token(x_nexus_token)
    if req.cookies:
         # If import request comes with cookies (e.g. from Bunkr album page)
         # Save them generically as 'latest_bridge.cookies.txt'
         with open("bridge.cookies.txt", "w") as f:
             f.write(req.cookies)
    
    bg_tasks.add_task(background_import_process, req.urls, req.batch_name, "yt-dlp", None, None, None, True)
    return {"status": "ok", "count": len(req.urls)}


class MegaCaptureChunk(BaseModel):
    url: str
    start: Optional[int] = None
    end: Optional[int] = None
    length: Optional[int] = None

class MegaCaptureImportRequest(BaseModel):
    capture_id: Optional[str] = None
    source_url: str
    title: Optional[str] = None
    duration: Optional[Any] = 0
    thumbnail: Optional[str] = None
    batch_name: Optional[str] = "MEGA Capture"
    total_captured_bytes: Optional[int] = 0
    chunks: List[MegaCaptureChunk]

class FastImportRequest(BaseModel):
    urls: str
    filter_enabled: bool = False

async def _expand_url_to_candidates(url: str) -> list:
    """Expand a single URL (folder/list/album) into a list of candidate dicts.
    Each dict has: url, source_url, title, thumbnail, height, width, size_bytes.
    Single-file URLs return a one-element list.
    """
    candidates = []
    u = url.strip()
    if not u:
        return candidates

    # Pixeldrain /l/ list
    if "pixeldrain.com" in u and ("/l/" in u or "/api/list/" in u):
        try:
            from app.extractors.pixeldrain import PixeldrainExtractor
            for f in await PixeldrainExtractor().extract_album_entries(u):
                stream = f.get("stream_url") or ""
                if stream:
                    candidates.append({
                        "url": stream, "source_url": stream,
                        "title": f.get("title") or stream.rsplit("/", 1)[-1],
                        "thumbnail": f.get("thumbnail") or "",
                        "height": 0, "width": 0,
                        "size_bytes": int(f.get("size_bytes") or 0),
                    })
        except Exception as e:
            logging.warning("fast-import Pixeldrain expand failed for %s: %s", u, e)

    # Filester /f/ folder
    elif "filester." in u.lower() and "/f/" in u.lower():
        try:
            from app.extractors.filester import FilesterExtractor
            for f in await FilesterExtractor().extract_folder(u):
                file_url = f.get("url") or ""
                if file_url:
                    candidates.append({
                        "url": file_url, "source_url": file_url,
                        "title": f.get("title") or file_url.rsplit("/", 1)[-1],
                        "thumbnail": f.get("thumbnail") or "",
                        "height": int(f.get("height") or 0),
                        "width": int(f.get("width") or 0),
                        "size_bytes": int(f.get("size_bytes") or 0),
                    })
        except Exception as e:
            logging.warning("fast-import Filester expand failed for %s: %s", u, e)

    # Erome album
    elif "erome.com" in u.lower():
        try:
            from app.extractors.erome import EromeExtractor
            for f in await EromeExtractor().extract_album_entries(u):
                stream = f.get("stream_url") or ""
                if stream:
                    candidates.append({
                        "url": stream, "source_url": f.get("source_url") or u,
                        "title": f.get("title") or "",
                        "thumbnail": f.get("thumbnail") or "",
                        "height": int(f.get("height") or 0),
                        "width": 0,
                        "size_bytes": 0,
                    })
        except Exception as e:
            logging.warning("fast-import Erome expand failed for %s: %s", u, e)

    # Single file / other — pass through as-is
    if not candidates:
        candidates.append({"url": u, "source_url": u, "title": "Queued...",
                           "thumbnail": "", "height": 0, "width": 0, "size_bytes": 0})
    return candidates


async def _fast_import_via_intake(urls: list, batch: str, filter_enabled: bool) -> None:
    """Expand URLs → create IntakeJob → wake IntakeWorker. Replaces background_import_process
    for fast-import so every import is tracked with real-time progress."""
    from app.intake import IntakeImportRequest, IntakeCandidate, create_import_job, intake_worker
    all_candidates = []
    for u in urls:
        expanded = await _expand_url_to_candidates(u)
        all_candidates.extend(expanded)

    if not all_candidates:
        logging.warning("fast-import: no candidates after expansion for %s", urls)
        return

    request = IntakeImportRequest(
        candidates=[
            IntakeCandidate(
                url=c["url"],
                source_url=c.get("source_url") or c["url"],
                title=c.get("title") or "Queued...",
                thumbnail=c.get("thumbnail") or "",
                height=int(c.get("height") or 0),
                width=int(c.get("width") or 0),
                duration=float(c.get("duration") or 0),
            )
            for c in all_candidates
        ],
        batch_name=batch,
        source_mode="mixed",
        min_quality=1080 if filter_enabled else 0,
        min_duration=600 if filter_enabled else 0,
    )

    db = SessionLocal()
    try:
        job = create_import_job(request, db)
        logging.info("fast-import: created job %s with %s items", job.id, job.total_items)
        await manager.log(f"Import job #{job.id} vytvorený: {job.total_items} videí", "working")
        # Broadcast job created event
        from app.events import bus
        await bus.emit(
            topic="job.progress",
            entity=f"job:{job.id}",
            state="queued",
            message=f"{batch}: 0/{job.total_items}",
            metrics={
                "job_id": job.id,
                "batch_name": batch,
                "status": "queued",
                "total": job.total_items,
                "pending": job.pending_items,
                "running": 0,
                "imported": 0,
                "failed": 0,
                "duplicate": job.duplicate_items,
                "cancelled": 0,
                "done": int(job.duplicate_items or 0),
                "pct": 0,
                "started_at": None,
                "finished_at": None,
            },
        )
    finally:
        db.close()
    intake_worker.start()


@app.post("/api/fast-import")
async def fast_import_endpoint(req: FastImportRequest, bg_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    urls = _sanitize_import_urls([req.urls])
    batch = f"Fast Import {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    bg_tasks.add_task(_fast_import_via_intake, urls, batch, req.filter_enabled)
    return {"count": len(urls), "batch": batch, "message": "Import queued"}


MEGA_CAPTURE_DIR = os.path.join("app", "static", "mega_captures")

def _is_mega_chunk_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(str(url or ""))
        return parsed.scheme in ("http", "https") and parsed.netloc.lower().endswith("userstorage.mega.co.nz") and parsed.path.startswith("/dl/")
    except Exception:
        return False

def _safe_mega_capture_id(raw: Optional[str]) -> str:
    text = str(raw or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{8,80}", text):
        return text[:80]
    seed = text or f"mega-{time.time_ns()}"
    return "mega-" + hashlib.sha256(seed.encode("utf-8", errors="ignore")).hexdigest()[:24]

def _mega_capture_path(capture_id: str) -> str:
    return os.path.join(MEGA_CAPTURE_DIR, f"{_safe_mega_capture_id(capture_id)}.json")

def _normalize_mega_chunks(chunks: List[MegaCaptureChunk]) -> List[dict]:
    normalized = []
    seen = set()
    for chunk in chunks or []:
        url = str(chunk.url or "").strip()
        if not url or url in seen or not _is_mega_chunk_url(url):
            continue
        seen.add(url)
        start = chunk.start
        end = chunk.end
        length = chunk.length
        if start is None or end is None:
            m = re.search(r"/(\d+)-(\d+)(?:[?#]|$)", url)
            if m:
                start = int(m.group(1))
                end = int(m.group(2))
        if length is None and start is not None and end is not None and end >= start:
            length = end - start + 1
        normalized.append({
            "url": url,
            "start": start,
            "end": end,
            "length": int(length or 0),
        })
    normalized.sort(key=lambda c: (c["start"] if c["start"] is not None else 10**18, c["url"]))
    return normalized

def _mega_headers() -> dict:
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Origin": "https://mega.nz",
        "Referer": "https://mega.nz/",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }

def _mega_duration(value: Any) -> float:
    try:
        return float(value or 0)
    except Exception:
        return 0.0

@api_v1_router.post("/import/mega-capture")
@api_legacy_router.post("/import/mega-capture")
async def import_mega_capture(req: MegaCaptureImportRequest, db: Session = Depends(get_db), x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    ensure_bridge_token(x_nexus_token)
    chunks = _normalize_mega_chunks(req.chunks)
    if not chunks:
        raise HTTPException(status_code=400, detail="No valid MEGA chunk URLs captured yet. Open/play the MEGA video and retry.")

    os.makedirs(MEGA_CAPTURE_DIR, exist_ok=True)
    source_url = str(req.source_url or "").strip()
    title = (str(req.title or "").strip() or "MEGA video").replace("\x00", "")
    total_bytes = int(req.total_captured_bytes or 0) or sum(int(c.get("length") or 0) for c in chunks)
    capture_id = _safe_mega_capture_id(req.capture_id or f"{source_url}|{title}|{chunks[0]['url']}|{time.time_ns()}")
    stream_url = f"/api/v1/mega-capture/{capture_id}/stream"
    manifest = {
        "capture_id": capture_id,
        "source_url": source_url,
        "title": title,
        "duration": _mega_duration(req.duration),
        "thumbnail": req.thumbnail,
        "batch_name": req.batch_name or "MEGA Capture",
        "total_captured_bytes": total_bytes,
        "chunks": chunks,
        "created_at": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat(),
    }
    with open(_mega_capture_path(capture_id), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    video = db.query(Video).filter(Video.source_url == source_url, Video.title == title).order_by(Video.id.desc()).first()
    stats = {
        "mega_capture_id": capture_id,
        "mega_chunks": len(chunks),
        "mega_total_captured_bytes": total_bytes,
        "mega_manifest": f"/static/mega_captures/{capture_id}.json",
        "note": "MEGA captured chunk URLs can expire; reopen/play in MEGA and refresh capture if playback fails.",
    }
    if not video:
        video = Video(
            title=title,
            url=stream_url,
            source_url=source_url,
            thumbnail_path=req.thumbnail or None,
            duration=_mega_duration(req.duration),
            height=0,
            width=0,
            batch_name=req.batch_name or "MEGA Capture",
            tags="mega,mega-capture",
            storage_type="remote",
            status="ready_to_stream",
            quality="MEGA",
            file_size_mb=round(total_bytes / (1024 * 1024), 3) if total_bytes > 0 else 0,
            download_stats=stats,
        )
        db.add(video)
    else:
        video.url = stream_url
        video.thumbnail_path = video.thumbnail_path or req.thumbnail or None
        video.duration = video.duration or _mega_duration(req.duration)
        video.batch_name = video.batch_name or req.batch_name or "MEGA Capture"
        video.tags = video.tags or "mega,mega-capture"
        video.storage_type = "remote"
        video.status = "ready_to_stream"
        video.quality = video.quality or "MEGA"
        if total_bytes > 0:
            video.file_size_mb = round(total_bytes / (1024 * 1024), 3)
        video.download_stats = stats
        try:
            from sqlalchemy.orm.attributes import flag_modified
            flag_modified(video, "download_stats")
        except Exception:
            pass
    db.commit()
    db.refresh(video)
    return {
        "status": "ok",
        "video_id": video.id,
        "capture_id": capture_id,
        "stream_url": stream_url,
        "chunks": len(chunks),
        "total_captured_bytes": total_bytes,
        "warning": "MEGA chunk links may expire; reopen/play in MEGA and refresh capture if playback stops.",
    }

def _select_mega_slices(chunks: List[dict], range_header: Optional[str]):
    if not chunks:
        return [], 0, 0, False, 0
    max_end = max((int(c["end"]) for c in chunks if c.get("end") is not None), default=-1)
    sum_len = sum(int(c.get("length") or 0) for c in chunks)
    total_size = max(max_end + 1, sum_len)
    range_start = None
    range_end = None
    if range_header:
        m = re.match(r"bytes=(\d*)-(\d*)", range_header.strip(), re.I)
        if m:
            if m.group(1):
                range_start = int(m.group(1))
            if m.group(2):
                range_end = int(m.group(2))
    is_range = range_start is not None or range_end is not None
    if range_start is None:
        range_start = chunks[0].get("start") if chunks[0].get("start") is not None else 0
    if range_end is None:
        range_end = max_end if max_end >= 0 else sum_len - 1

    selected = []
    content_length = 0
    for chunk in chunks:
        start = chunk.get("start")
        end = chunk.get("end")
        if start is None or end is None:
            start = 0 if not selected else selected[-1]["response_end"] + 1
            end = start + int(chunk.get("length") or 0) - 1
        if end < range_start or start > range_end:
            continue
        slice_start = max(0, range_start - start)
        slice_end = min(end, range_end) - start
        if slice_end < slice_start:
            continue
        item = dict(chunk)
        item["slice_start"] = int(slice_start)
        item["slice_end"] = int(slice_end)
        item["response_start"] = int(start + slice_start)
        item["response_end"] = int(start + slice_end)
        selected.append(item)
        content_length += int(slice_end - slice_start + 1)
    if not selected:
        return [], range_start, range_end, is_range, total_size
    return selected, selected[0]["response_start"], selected[-1]["response_end"], is_range, total_size or content_length

async def _fetch_mega_chunk_bytes(chunk: dict) -> bytes:
    try:
        async with http_session.get(chunk["url"], headers=_mega_headers(), allow_redirects=True, ssl=False) as resp:
            if resp.status not in (200, 206):
                raise HTTPException(status_code=410, detail="MEGA stream expired, reopen/play in MEGA and refresh capture.")
            return await resp.read()
    except HTTPException:
        raise
    except Exception as exc:
        logging.warning(f"[MEGA Capture] chunk fetch failed: {exc}")
        raise HTTPException(status_code=410, detail="MEGA stream expired, reopen/play in MEGA and refresh capture.")

@api_v1_router.api_route("/mega-capture/{capture_id}/stream", methods=["GET", "HEAD"])
@api_legacy_router.api_route("/mega-capture/{capture_id}/stream", methods=["GET", "HEAD"])
async def stream_mega_capture(capture_id: str, request: Request):
    capture_id = _safe_mega_capture_id(capture_id)
    path = _mega_capture_path(capture_id)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="MEGA capture manifest not found")
    with open(path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    chunks = manifest.get("chunks") or []
    selected, response_start, response_end, is_range, total_size = _select_mega_slices(chunks, request.headers.get("Range"))
    if not selected:
        raise HTTPException(status_code=416, detail="Requested range was not captured. Reopen/play in MEGA and refresh capture.")

    headers = {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": "video/mp4",
        "Content-Length": str(sum(int(c["slice_end"] - c["slice_start"] + 1) for c in selected)),
    }
    status_code = 206 if is_range or response_start > 0 else 200
    if status_code == 206:
        headers["Content-Range"] = f"bytes {response_start}-{response_end}/{total_size or '*'}"

    if request.method == "HEAD":
        return Response(status_code=status_code, headers=headers, media_type="video/mp4")

    first = await _fetch_mega_chunk_bytes(selected[0])

    async def iterator():
        first_chunk = selected[0]
        yield first[first_chunk["slice_start"]:first_chunk["slice_end"] + 1]
        for chunk in selected[1:]:
            raw = await _fetch_mega_chunk_bytes(chunk)
            yield raw[chunk["slice_start"]:chunk["slice_end"] + 1]

    return StreamingResponse(iterator(), status_code=status_code, headers=headers, media_type="video/mp4")


async def background_import_process(urls: List[str], batch_name: Optional[str], parser: str, items: Optional[List[dict]] = None, min_quality: Optional[int] = None, min_duration: Optional[int] = None, auto_heal: bool = True):
    """
    Táto funkcia beží na pozadí. Rozoberá URL, pridáva do DB a spúšťa spracovanie.
    Supports filtering by min_quality (height in pixels) and min_duration (seconds).
    """
    db = SessionLocal()
    new_ids = []
    process_ids = []
    filtered_count = 0
    original_item_data_map = {}
    if items:
        for it in items:
            item_url = str(it.get("url") or "").strip()
            if item_url:
                original_item_data_map[item_url] = it

    def _find_fast_import_mirror(
        title_value: str,
        media_url: str,
        source_value: str,
        thumbnail_value: str,
        size_bytes: int,
        duration_value: float,
        height_value: int,
    ) -> Optional[Video]:
        """Return the already-stored card for a cross-host re-upload.

        Fast Import used to bypass the common intake/bulk dedupe path, which
        is why a Filester card and its FileDitch/Gofile equivalent could still
        appear as separate cards.  Keep this check immediately before row
        creation, after provider metadata has been normalized.
        """
        from .media_match import MediaFacts, looks_like_same_video

        candidate = MediaFacts.from_fields(
            title=title_value, url=media_url, thumbnail=thumbnail_value,
            size_bytes=size_bytes, duration=duration_value, height=height_value,
        )
        if not candidate.name and not candidate.thumb_fp and not (candidate.size_bytes and candidate.duration_sec):
            return None

        clauses = []
        clean_title = str(title_value or "").strip()
        if candidate.name and clean_title and clean_title.lower() != "queued...":
            clauses.append(func.lower(Video.title) == clean_title.lower())
        if candidate.size_bytes:
            size_mb = candidate.size_bytes / (1024 * 1024)
            clauses.append(Video.file_size_mb.between(size_mb * 0.97, size_mb * 1.03))
        if candidate.duration_sec:
            clauses.append(Video.duration.between(candidate.duration_sec - 5, candidate.duration_sec + 5))
        if not clauses:
            return None

        # The title clause handles FileDitch rows which initially have 0:00
        # and no known byte size.  The factual matcher below still prevents a
        # same-name but materially different item from being collapsed.
        for row in db.query(Video).filter(Video.status != "error", or_(*clauses)).limit(120).all():
            if row.url in {media_url, source_value} or row.source_url in {media_url, source_value}:
                continue
            row_facts = MediaFacts.from_fields(
                title=row.title or "", url=row.url or "",
                thumbnail=row.original_thumbnail_url or row.thumbnail_path or "",
                size_bytes=(row.file_size_mb or 0) * 1024 * 1024,
                duration=row.duration or 0, height=row.height or 0,
            )
            if looks_like_same_video(candidate, row_facts):
                return row
        return None

    def _attach_fast_import_mirror(existing: Video, media_url: str, source_value: str, height_value: int, size_bytes: int) -> None:
        from .source_catalog import classify_library_source_name

        if not db.query(VideoSource).filter(VideoSource.video_id == existing.id).first() and existing.url:
            db.add(VideoSource(
                video_id=existing.id, url=existing.url, source_url=existing.source_url,
                label=classify_library_source_name(existing.url, existing.source_url),
                quality=existing.quality, height=existing.height or 0,
                size_mb=existing.file_size_mb or 0, is_primary=True,
                link_status=existing.link_status or "unknown",
            ))
        if not db.query(VideoSource).filter(
            VideoSource.video_id == existing.id, VideoSource.url == media_url,
        ).first():
            db.add(VideoSource(
                video_id=existing.id, url=media_url, source_url=source_value or media_url,
                label=classify_library_source_name(media_url, source_value),
                quality=_height_to_quality_label(height_value or 0), height=height_value or 0,
                size_mb=round(size_bytes / (1024 * 1024), 2) if size_bytes else 0,
                is_primary=False,
            ))
        db.commit()

    def _cw_corr_id(u: str, su: str) -> str:
        for raw in (su or "", u or ""):
            try:
                m = re.search(r"/videos/(\d+)(?:/|$)", raw, re.I)
                if m:
                    return f"cw:{m.group(1)}"
            except Exception:
                pass
        return "cw:unknown"
    
    # 1. Expandovanie playlistov (blokujúca operácia, preto je tu)
    await manager.log(f"Fast Import: Expanding {len(urls)} input URLs...", "working")
    final_urls = []
    expanded_item_data_map = {}

    def _make_expanded_item(base_item: Optional[dict], original_url: str, expanded_url: str, idx: int, total: int) -> dict:
        merged = dict(base_item or {})
        merged["url"] = expanded_url
        merged["source_url"] = str(
            merged.get("source_url")
            or merged.get("page_url")
            or original_url
        ).strip()
        title = str(merged.get("title") or merged.get("label") or merged.get("name") or "").strip()
        if (
            total > 1
            and title
            and "erome.com" in (original_url or "").lower()
            and f"[{idx}/{total}]" not in title
        ):
            merged["title"] = f"{title} [{idx}/{total}]"
        elif title:
            merged["title"] = title
        return merged

    for u in urls:
        u = u.strip()
        if not u: continue
        original_item = original_item_data_map.get(u, {})
        from .telegram_service import telegram_import_spec
        if telegram_import_spec(u, original_item):
            final_urls.append(u)
            expanded_item_data_map[u] = _make_expanded_item(original_item, u, u, 1, 1)
            continue
        # Webshare pseudo-URLs are not playlists and must not go through yt-dlp/requests.
        if u.startswith("webshare:") or ("wsfiles.cz" in u) or ("webshare.cz" in u):
            final_urls.append(u)
            if original_item:
                expanded_item_data_map[u] = _make_expanded_item(original_item, u, u, 1, 1)
            continue
        # Pixeldrain nepotrebuje expandovať
        if "pixeldrain.com" in u and "/api/file/" in u:
            final_urls.append(u)
            if original_item:
                expanded_item_data_map[u] = _make_expanded_item(original_item, u, u, 1, 1)
        else:
            erome_entries = []
            if "erome.com" in u.lower():
                try:
                    from app.extractors.erome import EromeExtractor
                    erome_entries = await EromeExtractor().extract_album_entries(u)
                except Exception as erome_exc:
                    logging.warning(f"Erome expansion metadata failed for {u}: {erome_exc}")

            if erome_entries:
                for idx, entry in enumerate(erome_entries, start=1):
                    stream_url = str(entry.get("stream_url") or "").strip()
                    if not stream_url:
                        continue
                    final_urls.append(stream_url)
                    inherited = _make_expanded_item(original_item, u, stream_url, idx, len(erome_entries))
                    inherited["source_url"] = str(entry.get("source_url") or inherited.get("source_url") or u).strip()
                    inherited["thumbnail"] = entry.get("thumbnail") or inherited.get("thumbnail")
                    inherited["duration"] = entry.get("duration") or inherited.get("duration")
                    inherited["duration_seconds"] = entry.get("duration") or inherited.get("duration_seconds")
                    inherited["height"] = entry.get("height") or inherited.get("height")
                    inherited["quality"] = entry.get("quality") or inherited.get("quality")
                    inherited["title"] = entry.get("title") or inherited.get("title") or original_item.get("title") or "Erome"
                    expanded_item_data_map[stream_url] = inherited
            elif "pixeldrain.com" in u.lower() and ("/l/" in u.lower() or "/api/list/" in u.lower()):
                # Pixeldrain list/album: expand with full per-file metadata via the list API
                # (one request returns every file's id/name/size/thumb). The per-file
                # /api/file/{id} URL is directly streamable — no token refresh needed.
                pd_files = []
                try:
                    from app.extractors.pixeldrain import PixeldrainExtractor
                    pd_files = await PixeldrainExtractor().extract_album_entries(u)
                except Exception as pd_exc:
                    logging.warning(f"Pixeldrain list expansion failed for {u}: {pd_exc}")
                if pd_files:
                    for f in pd_files:
                        f_url = str(f.get("stream_url") or "").strip()
                        if not f_url:
                            continue
                        final_urls.append(f_url)
                        merged = dict(original_item or {})
                        merged.update({
                            "url": f_url,
                            "source_url": f_url,
                            "title": f.get("title") or merged.get("title"),
                            "thumbnail": f.get("thumbnail") or merged.get("thumbnail"),
                            "size_bytes": f.get("size_bytes") or merged.get("size_bytes") or 0,
                        })
                        expanded_item_data_map[f_url] = merged
                else:
                    expanded_urls = await extract_playlist_urls(u, parser=parser)
                    final_urls.extend(expanded_urls)
            elif urllib.parse.urlparse(u).hostname in {"fileditchalbums.st", "www.fileditchalbums.st"}:
                from app.routers.source_boards import _extract_fileditch_album
                try:
                    fileditch_files = await _extract_fileditch_album(u)
                except Exception as exc:
                    detail = getattr(exc, "detail", str(exc))
                    logging.warning("FileDitch album expansion failed for %s: %s", u, detail)
                    await manager.log(f"Fast Import: FileDitch album sa nepodarilo načítať: {detail}", "error")
                    fileditch_files = []
                for entry in fileditch_files:
                    file_url = str(entry.get("url") or "").strip()
                    if file_url:
                        final_urls.append(file_url)
                        merged = dict(original_item or {})
                        merged.update(entry)
                        expanded_item_data_map[file_url] = merged
            elif "filester." in u.lower() and "/f/" in u.lower():
                # Filester folder: expand with full per-file metadata (title/thumb/size/height)
                # so the processor does NOT need a per-video re-extract for every file.
                filester_files = []
                try:
                    from app.extractors.filester import FilesterExtractor
                    filester_files = await FilesterExtractor().extract_folder(u)
                except Exception as fl_exc:
                    logging.warning(f"Filester folder expansion failed for {u}: {fl_exc}")
                if filester_files:
                    for f in filester_files:
                        f_url = str(f.get("url") or "").strip()
                        if not f_url:
                            continue
                        final_urls.append(f_url)
                        merged = dict(original_item or {})
                        merged.update({
                            "url": f_url,
                            "source_url": f_url,
                            "title": f.get("title") or merged.get("title"),
                            "thumbnail": f.get("thumbnail") or merged.get("thumbnail"),
                            "height": f.get("height") or merged.get("height") or 0,
                            "width": f.get("width") or merged.get("width") or 0,
                            "size_bytes": f.get("size_bytes") or merged.get("size_bytes") or 0,
                        })
                        if f.get("height"):
                            merged["quality"] = f"{f['height']}p"
                        expanded_item_data_map[f_url] = merged
                else:
                    # Fallback to generic expansion if folder yielded nothing
                    expanded_urls = await extract_playlist_urls(u, parser=parser)
                    final_urls.extend(expanded_urls)
            elif "gofile.io" in u.lower() and ("/d/" in u.lower() or "/c/" in u.lower()):
                # GoFile folder/album expansion with full metadata
                gofile_files = []
                try:
                    from app.extractors.gofile import GofileExtractor
                    gofile_files = await GofileExtractor().extract_album_entries(u)
                except Exception as gf_exc:
                    logging.warning(f"GoFile folder expansion failed for {u}: {gf_exc}")
                if gofile_files:
                    for idx, f in enumerate(gofile_files, start=1):
                        f_url = str(f.get("stream_url") or f.get("url") or "").strip()
                        if not f_url:
                            continue
                        final_urls.append(f_url)
                        merged = dict(original_item or {})
                        merged.update({
                            "url": f_url,
                            "source_url": str(f.get("source_url") or f.get("item_url") or u).strip(),
                            "title": f.get("title") or merged.get("title") or f"GoFile Video {idx}",
                            "thumbnail": f.get("thumbnail") or merged.get("thumbnail"),
                            "duration": f.get("duration") or merged.get("duration") or 0,
                            "duration_seconds": f.get("duration") or merged.get("duration_seconds") or 0,
                            "size_bytes": f.get("size_bytes") or merged.get("size_bytes") or 0,
                            "quality": f.get("quality") or merged.get("quality") or "",
                            # This marker survives the expansion to the per-file
                            # importer.  CDN links themselves usually do not
                            # contain ``gofile.io``, so domain sniffing alone
                            # loses the provider-specific thumbnail/metadata path.
                            "_provider": "gofile",
                            "_gofile_folder_url": u,
                        })
                        expanded_item_data_map[f_url] = merged
                else:
                    final_urls.append(u)
                    if original_item:
                        expanded_item_data_map[u] = _make_expanded_item(original_item, u, u, 1, 1)
            elif "cyberfile.me" in u.lower() and "/folder/" in u.lower():
                # CyberFile's public folder API gives every stable file-page URL,
                # exact byte size and preview. Its signed CDN URL is resolved later
                # while the individual card is processed.
                cyberfile_files = []
                try:
                    from app.extractors.cyberfile import CyberFileExtractor
                    cyberfile_files = await CyberFileExtractor().extract_album_entries(u)
                except Exception as cyberfile_exc:
                    logging.warning(f"CyberFile folder expansion failed for {u}: {cyberfile_exc}")
                if cyberfile_files:
                    for f in cyberfile_files:
                        f_url = str(f.get("url") or f.get("item_url") or "").strip()
                        if not f_url:
                            continue
                        final_urls.append(f_url)
                        merged = dict(original_item or {})
                        merged.update({
                            "url": f_url,
                            "source_url": str(f.get("source_url") or f_url).strip(),
                            "title": f.get("title") or merged.get("title"),
                            "thumbnail": f.get("thumbnail") or merged.get("thumbnail"),
                            "size_bytes": f.get("size_bytes") or merged.get("size_bytes") or 0,
                            "upload_date": f.get("upload_date") or merged.get("upload_date") or "",
                            "_provider": "cyberfile",
                            "_cyberfile_folder_url": u,
                        })
                        expanded_item_data_map[f_url] = merged
                else:
                    final_urls.append(u)
                    if original_item:
                        expanded_item_data_map[u] = _make_expanded_item(original_item, u, u, 1, 1)
            else:
                expanded_urls = await extract_playlist_urls(u, parser=parser)
                final_urls.extend(expanded_urls)
                if original_item:
                    total = max(1, len(expanded_urls))
                    for idx, expanded_url in enumerate(expanded_urls, start=1):
                        expanded_item_data_map.setdefault(
                            expanded_url,
                            _make_expanded_item(original_item, u, expanded_url, idx, total),
                        )
        await asyncio.sleep(0) # Yield control

    # 2. Vloženie do DB
    final_urls = list(dict.fromkeys(final_urls)) # Unikátne URL
    
    # Map for easy lookup of item data if available
    item_data_map = {}
    if items:
        for it in items:
            if it.get('url'):
                item_data_map[it['url']] = it
    item_data_map.update(expanded_item_data_map)

    # Bleskové obohatenie neoverených Camwhores kariet cez paralelný pool pred vložením do DB (odstráni minúty čakania)
    cw_unresolved = [
        it for it in item_data_map.values()
        if ("camwhores.tv" in (it.get("url") or "").lower() or "camwhores.tv" in (it.get("source_url") or "").lower())
        and not it.get("stream_url")
    ]
    if cw_unresolved:
        try:
            await manager.log(f"Fast Import: Rýchle doplnenie metadát pre {len(cw_unresolved)} Camwhores videí...", "working")
            from app.camwhores_discovery import batch_enrich_cards
            enriched_items = await asyncio.to_thread(batch_enrich_cards, cw_unresolved, max_workers=12)
            for en in enriched_items:
                en_u = en.get("url")
                if en_u and en_u in item_data_map:
                    item_data_map[en_u].update(en)
        except Exception as en_err:
            logging.warning(f"[CW_FAST_IMPORT_ENRICH] Error: {en_err}")

    def _parse_extension_duration_seconds(item: dict) -> float:
        """Human-readable duration string or numeric seconds from extension JSON."""
        if not item:
            return 0.0
        ds = item.get("duration_seconds")
        if ds is not None:
            try:
                v = float(ds)
                if v > 0:
                    return v
            except (TypeError, ValueError):
                pass
        d = item.get("duration")
        if isinstance(d, (int, float)):
            try:
                v = float(d)
                return v if v > 0 else 0.0
            except (TypeError, ValueError):
                pass
        if isinstance(d, str) and d.strip():
            parts = [p.strip() for p in d.split(":") if p.strip() != ""]
            try:
                if len(parts) == 3:
                    return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
                if len(parts) == 2:
                    return int(parts[0]) * 60 + float(parts[1])
                return float(d)
            except (TypeError, ValueError):
                return 0.0
        return 0.0

    def _parse_extension_height_px(item: dict) -> int:
        """Best-effort quality px from extension item."""
        if not item:
            return 0
        raw_height = item.get("height") or item.get("resolution")
        try:
            if isinstance(raw_height, (int, float)) and raw_height > 0:
                return int(raw_height)
            height_match = re.search(r"(2160|1440|1080|720|480|360)", str(raw_height or ""))
            if height_match:
                return int(height_match.group(1))
        except (TypeError, ValueError):
            pass
        q = item.get("quality")
        try:
            if isinstance(q, (int, float)) and q > 0:
                qi = int(q)
                if qi >= 100: return 2160
                if qi >= 95: return 1440
                if qi >= 90: return 1080
                if qi >= 80: return 720
                if qi >= 70: return 480
        except (TypeError, ValueError):
            pass
        ql = str(item.get("qualityLabel") or "").lower()
        m = re.search(r"(2160|1440|1080|720|480|360)\s*p", ql)
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                return 0
        if "4k" in ql:
            return 2160
        if "fhd" in ql:
            return 1080
        if "hd" in ql:
            return 720
        return 0

    def _normalize_camwhores_watch_url(u: str) -> Optional[str]:
        if not u:
            return None
        try:
            p = urllib.parse.urlparse(u)
            if "camwhores.tv" not in p.netloc.lower():
                return None
            m = re.search(r"/videos/(\d+)(?:/([^/?#]+))?(?:/|$)", p.path, re.I)
            if not m:
                return None
            video_id = m.group(1)
            slug = (m.group(2) or "").strip()
            if slug:
                return f"{p.scheme or 'https'}://{p.netloc}/videos/{video_id}/{slug}/"
            return f"{p.scheme or 'https'}://{p.netloc}/videos/{video_id}/"
        except Exception:
            return None

    def _height_to_quality_label(h: int) -> str:
        if h >= 2160:
            return "4K"
        if h >= 1440:
            return "1440p"
        if h >= 1080:
            return "FHD"
        if h >= 720:
            return "HD"
        if h > 0:
            return "SD"
        return "Unknown"

    def _is_probably_playable_media_url(u: str) -> bool:
        if not u:
            return False
        ul = u.strip().lower()
        if not ul.startswith(("http://", "https://")):
            return False
        if re.search(r"\.(mp4|m3u8|mpd|webm|mov|mkv)(\?|$)", ul):
            return True
        return any(marker in ul for marker in [
            "/get_file/",
            "/api/file/",
            "/api/filesystem/",
            "googlevideo.com/videoplayback",
            "vkuservideo.net",
            "okcdn.ru",
            "cdn",
        ])

    def _has_strong_extension_metadata(item: dict, resolved_title: str, resolved_thumb: Optional[str], duration_s: float, height_px: int) -> bool:
        clean_title = (resolved_title or "").strip().lower()
        clean_thumb = (resolved_thumb or "").strip()
        if len(clean_title) < 4:
            return False
        if clean_title in {"queued...", "untitled", "video"}:
            return False
        if duration_s <= 0 or height_px <= 0:
            return False
        if not clean_thumb.startswith(("http://", "https://", "/static/")):
            return False
        return True

    total_to_import = len(final_urls)
    await manager.log(f"Fast Import: Processing {total_to_import} unique videos...", "working")
    
    current_idx = 0
    for url in final_urls:
        await asyncio.sleep(0) # Yield control to keep server responsive
        current_idx += 1
        if current_idx % 5 == 0:
            await manager.log(f"Fast Import: Importing video {current_idx}/{total_to_import}...", "working")
        
        url = url.strip()
        if not url: continue
        
        # Check if we have specific item data from extension
        item_data = item_data_map.get(url, {})
        title = item_data.get("title") or item_data.get("label") or item_data.get("name")
        thumbnail = item_data.get("thumbnail")
        source_candidate = item_data.get("source_url") or url
        video_source_url = source_candidate
        # Camwhores: preserve watch page URL as lineage for reliable re-resolve on expired get_file URLs.
        cw_watch_from_source = _normalize_camwhores_watch_url(item_data.get("source_url") or "")
        cw_watch_from_url = _normalize_camwhores_watch_url(url)
        if cw_watch_from_source:
            video_source_url = cw_watch_from_source
        elif cw_watch_from_url:
            video_source_url = cw_watch_from_url
        ext_duration = _parse_extension_duration_seconds(item_data)
        ext_height = _parse_extension_height_px(item_data)
        is_gofile_expanded_stream = item_data.get("_provider") == "gofile"

        # A GoFile folder resolves to signed CDN URLs.  They are individually
        # playable, but GoFile's folder API intentionally omits duration and
        # resolution.  Probe each stream while its signature is fresh, *before*
        # creating the card.  This prevents the generic processor from scraping
        # the folder page for every child (which yielded the first preview on all
        # cards and left their duration at 0:00).
        if is_gofile_expanded_stream and (not ext_duration or not ext_height):
            try:
                gofile_folder_url = str(
                    item_data.get("_gofile_folder_url")
                    or video_source_url
                    or "https://gofile.io/"
                ).strip()
                parsed_folder = urllib.parse.urlparse(gofile_folder_url)
                gofile_referer = (
                    f"{parsed_folder.scheme}://{parsed_folder.netloc}/"
                    if parsed_folder.scheme and parsed_folder.netloc
                    else "https://gofile.io/"
                )
                gofile_probe = await VIPVideoProcessor()._ffprobe_fallback(
                    url,
                    {"duration": ext_duration, "height": ext_height, "width": 0},
                    referer=gofile_referer,
                )
                ext_duration = float(gofile_probe.get("duration") or ext_duration or 0)
                ext_height = int(gofile_probe.get("height") or ext_height or 0)
                item_data["duration"] = ext_duration
                item_data["duration_seconds"] = ext_duration
                item_data["height"] = ext_height
                item_data["width"] = int(gofile_probe.get("width") or item_data.get("width") or 0)
                logging.info(
                    "[GoFile-import] metadata for %s: duration=%.1fs height=%sp",
                    (title or url)[0:90], ext_duration, ext_height,
                )
            except Exception as gofile_probe_exc:
                # Keep the direct stream and its per-file frame usable even when
                # a particular CDN refuses ffprobe.  The normal maintenance path
                # can retry metadata later without replacing the thumbnail.
                logging.warning(
                    "[GoFile-import] metadata probe failed for %s: %s",
                    url[:90], gofile_probe_exc,
                )
        playable_url = url
        is_cw = "camwhores.tv" in (url or "").lower() or "camwhores.tv" in (video_source_url or "").lower()
        if is_cw:
            cw_stream = item_data.get("stream_url")
            if cw_stream and _is_probably_playable_media_url(cw_stream):
                playable_url = cw_stream

        fast_path_ready = (
            bool(item_data)
            and (_is_probably_playable_media_url(url) or (is_cw and _is_probably_playable_media_url(playable_url)))
            and _has_strong_extension_metadata(item_data, title or "", thumbnail, ext_duration, ext_height)
        )
        # Frame endpoints are deliberately per direct URL.  Preserve them for
        # GoFile even when ffprobe cannot read a particular signed stream; the
        # old pending path replaced all of them with the folder's first OG image.
        if is_gofile_expanded_stream and thumbnail:
            fast_path_ready = True

        ext_size_bytes = 0
        try:
            raw_sz = item_data.get("size_bytes")
            if raw_sz is None:
                raw_sz = item_data.get("filesize")
            if raw_sz is not None:
                ext_size_bytes = int(float(raw_sz))
        except (TypeError, ValueError):
            ext_size_bytes = 0
        if ext_size_bytes < 0:
            ext_size_bytes = 0

        # Pixeldrain Title Logic (fallback if no item title)
        if not title:
            title = "Queued..."
            if "pixeldrain.com" in url:
                if "/api/file/" in url or "/api/filesystem/" in url or "/filesystem/" in url:
                     try: 
                         parts = url.split("/")
                         if len(parts) > 5: # .../api/file/ID/Meno or .../api/filesystem/ID/Meno
                             title = urllib.parse.unquote(parts[-1])
                     except: pass

        from .telegram_service import save_telegram_library_video, telegram_import_spec, _chat_id_for_username
        telegram_spec = telegram_import_spec(url, item_data)
        if telegram_spec:
            try:
                if not telegram_spec.get("chat_id"):
                    username = telegram_spec.get("username")
                    if not username:
                        raise ValueError("missing telegram chat")
                    telegram_spec["chat_id"] = await _chat_id_for_username(username)
                telegram_video, _created = save_telegram_library_video(db, telegram_spec, batch_name=batch_name)
                VIPVideoProcessor().broadcast_new_video(telegram_video)
                new_ids.append(telegram_video.id)
                logging.info("Telegram video imported as stream %s", telegram_video.id)
                continue
            except Exception as telegram_exc:
                logging.error("Telegram import failed for %s: %s", url[:120], telegram_exc)

        # VK Video Detection and Metadata Extraction
        # Support all VK domains
        is_vk_video = any(domain in url.lower() for domain in ['vk.com', 'vk.video', 'vkvideo.ru', 'vkvideo.net', 'vkvideo.com', 'vk.ru', 'okcdn.ru'])
        if is_vk_video:
            try:
                from app.extractors.vk import VKExtractor
                vk_extractor = VKExtractor()
                
                if vk_extractor.can_handle(url):
                    logging.info(f"Extracting VK metadata for: {url}")
                    # Use await since this function is now async
                    vk_metadata = await vk_extractor.extract(url)
                    
                    if vk_metadata:
                        # Use VK metadata
                        title = vk_metadata.get('title', title)
                        thumbnail = vk_metadata.get('thumbnail', thumbnail)
                        stream_url = vk_metadata.get('stream_url', url)
                        duration = vk_metadata.get('duration', 0)
                        height = vk_metadata.get('height', 0)
                        width = vk_metadata.get('width', 0)
                        
                        # Create VK video with full metadata
                        v = Video(
                            title=title,
                            url=stream_url,  # Use extracted stream URL
                            source_url=url,  # Keep page URL for refresh
                            thumbnail_path=thumbnail,
                            duration=duration,
                            height=height,
                            width=width,
                            batch_name=batch_name,
                            status="ready_to_stream",  # Skip processing
                            storage_type="remote"
                        )
                        db.add(v)
                        db.commit()
                        
                        processor = VIPVideoProcessor()
                        processor.broadcast_new_video(v)
                        new_ids.append(v.id)
                        
                        logging.info(f"VK video imported successfully: {title}")
                        continue  # Skip normal processing
                    else:
                        logging.warning(f"VK metadata extraction returned None for: {url}")
            except Exception as e:
                logging.error(f"VK metadata extraction failed for {url}: {e}")
                # Fall through to normal processing


        # Tnaflix Video Detection
        if "tnaflix.com" in url:
            try:
                from app.extractors.tnaflix import TnaflixExtractor
                tna_extractor = TnaflixExtractor()
                if tna_extractor.can_handle(url):
                    logging.info(f"Detected Tnaflix URL: {url}")
                    tna_results = await asyncio.to_thread(tna_extractor.extract_from_profile, url) if "/profile/" in url else [await asyncio.to_thread(tna_extractor.extract, url)]
                    
                    tna_handled = False
                    for tna_meta in tna_results:
                        if not tna_meta: continue
                        
                        # FILTER: Skip trailers in backend import
                        if "trailer.mp4" in tna_meta.get("stream_url", "").lower() or "trailer" in tna_meta.get("title", "").lower():
                            logging.info(f"Skipping Tnaflix trailer: {tna_meta.get('title')}")
                            continue
                        
                        v = Video(
                            title=tna_meta["title"],
                            url=tna_meta["stream_url"],
                            source_url=url,
                            thumbnail_path=tna_meta["thumbnail"],
                            duration=tna_meta["duration"],
                            status="ready_to_stream",
                            batch_name=batch_name,
                            storage_type="remote",
                            tags=tna_meta.get("tags", "")
                        )
                        db.add(v)
                        db.commit()
                        
                        processor = VIPVideoProcessor()
                        processor.broadcast_new_video(v)
                        new_ids.append(v.id)
                        logging.info(f"Tnaflix video imported: {tna_meta['title']}")
                        tna_handled = True
                    
                    if tna_handled:
                        continue
            except Exception as e:
                logging.error(f"Tnaflix extraction failed for {url}: {e}")

        # Ukladáme do DB
        if "camwhores.tv" in url.lower():
            # Avoid duplicate rows per same watch-id lineage when URLs differ by rnd/query/signature.
            cw_watch = _normalize_camwhores_watch_url(video_source_url) or _normalize_camwhores_watch_url(url)
            if cw_watch:
                cw_id_match = re.search(r'/videos/(\d+)(?:/|$)', urllib.parse.urlparse(cw_watch).path)
                if cw_id_match:
                    cw_id = cw_id_match.group(1)
                    existing_cw = db.query(Video).filter(or_(
                        Video.source_url.ilike(f'%camwhores.tv/videos/{cw_id}/%'),
                        Video.source_url.ilike(f'%camwhores.tv/videos/{cw_id}'),
                    )).first()
                else:
                    existing_cw = db.query(Video).filter(Video.source_url == cw_watch).first()
                if existing_cw:
                    logging.info(f"Skipping duplicate Camwhores import for watch URL: {cw_watch}")
                    continue
            logging.info(
                "[CW_IMPORT][%s] incoming url=%s source=%s ext_duration=%s ext_height=%s",
                _cw_corr_id(url, video_source_url),
                url[:120],
                (video_source_url or "")[:120],
                int(ext_duration or 0),
                int(ext_height or 0),
            )

        final_video_url = playable_url if (is_cw and playable_url != url) else url
        mirror_of = _find_fast_import_mirror(
            title or "", final_video_url, video_source_url or final_video_url,
            thumbnail or "", ext_size_bytes, ext_duration or 0, ext_height or 0,
        )
        if mirror_of:
            _attach_fast_import_mirror(
                mirror_of, final_video_url, video_source_url or final_video_url,
                ext_height or 0, ext_size_bytes,
            )
            new_ids.append(mirror_of.id)
            logging.info(
                "[Fast Import] attached %s as an alternate source of video_id=%s",
                (title or final_video_url)[:90], mirror_of.id,
            )
            continue
        v = Video(
            title=title, 
            url=final_video_url,
            source_url=video_source_url, 
            batch_name=batch_name, 
            status="ready_to_stream" if fast_path_ready else "pending",
            thumbnail_path=thumbnail,
            duration=ext_duration or 0,
            height=ext_height or 0,
            quality=_height_to_quality_label(ext_height or 0),
            storage_type="remote",
            file_size_mb=round(ext_size_bytes / (1024 * 1024), 2) if ext_size_bytes > 0 else 0,
            download_stats=({"reported_size_bytes": ext_size_bytes} if ext_size_bytes > 0 else None),
            tags=",".join(item_data["tags"]) if isinstance(item_data.get("tags"), list) else str(item_data.get("tags") or ""),
            categories=(", ".join(item_data.get("categories") or []) if isinstance(item_data.get("categories"), list) else str(item_data.get("categories") or "")) if is_cw else "",
            models=(", ".join(item_data.get("models") or []) if isinstance(item_data.get("models"), list) else str(item_data.get("models") or "")) if is_cw else "",
            upload_date=item_data.get("added_date") if is_cw and item_data.get("date_precision") == "exact" else None,
        )
        db.add(v)
        db.commit() # Commit each to get ID and ensure it's in DB for broadcast
        if "camwhores.tv" in (url or "").lower() or "camwhores.tv" in (video_source_url or "").lower():
            logging.info(
                "[CW_IMPORT][%s] persisted video_id=%s status=%s duration=%s height=%s source=%s",
                _cw_corr_id(url, video_source_url),
                v.id,
                v.status,
                int(v.duration or 0),
                int(v.height or 0),
                (v.source_url or "")[:120],
            )
        
        processor = VIPVideoProcessor()
        processor.broadcast_new_video(v)
        # FileDitch viewer URLs normally have no durable poster.  Fast Import
        # intentionally skips the preview dialog, so queue a local frame right
        # after the row is created rather than leaving the card blank.
        from app.extractors.filester import is_fileditch_url
        is_fileditch_viewer = is_fileditch_url(url) or is_fileditch_url(video_source_url)
        if is_fileditch_viewer:
            from app.routers.bulk_import import _background_ffmpeg_thumbnail
            asyncio.create_task(
                _background_ffmpeg_thumbnail(
                    v.id,
                    final_video_url,
                    ext_duration or 0,
                    video_source_url or url,
                    video_source_url or url,
                )
            )
        if fast_path_ready and thumbnail and thumbnail.startswith("http"):
            asyncio.create_task(
                _background_localize_remote_thumbnail(
                    v.id,
                    thumbnail,
                    video_source_url or url,
                    "extension-fast-path",
                )
            )
        
        new_ids.append(v.id)
        if not fast_path_ready:
            process_ids.append(v.id)

    db.close()

    # 3. Spustenie spracovania
    if new_ids:
        await manager.log(f"Fast Import: Completed! Added {len(new_ids)} videos to queue.", "success")
        if process_ids:
            processor = VIPVideoProcessor()
            await processor.process_batch(process_ids)

        # 4. Post-processing filtering if filters are enabled
        if min_quality or min_duration:
            db = SessionLocal()
            try:
                for video_id in new_ids:
                    video = db.query(Video).filter(Video.id == video_id).first()
                    if not video:
                        continue

                    should_filter = False
                    filter_reason = ""

                    # Check quality filter
                    if min_quality and video.height and video.height < min_quality:
                        should_filter = True
                        filter_reason = f"Quality too low ({video.height}p < {min_quality}p)"

                    # Check duration filter
                    if min_duration and video.duration and video.duration < min_duration:
                        should_filter = True
                        filter_reason = f"Duration too short ({int(video.duration)}s < {min_duration}s)"

                    if should_filter:
                        logging.info(f"Filtering out video '{video.title}': {filter_reason}")
                        db.delete(video)
                        filtered_count += 1

                db.commit()

                if filtered_count > 0:
                    logging.info(f"Filtered out {filtered_count} videos that didn't meet criteria (min_quality={min_quality}, min_duration={min_duration})")
            except Exception as e:
                logging.error(f"Error during post-processing filtering: {e}")
                db.rollback()
            finally:
                db.close()

@api_v1_router.post("/import/quantum-ready")
async def import_quantum_ready(data: QuantumReadyImportRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Store a resolved search result as a playable remote library item."""
    source = _require_public_proxy_url(data.source_url.strip())
    stream = _require_public_proxy_url(data.stream_url.strip())
    hostname = (urllib.parse.urlsplit(source).hostname or "").lower()
    allowed = ("porntrex.com", "whoreshub.com", "pornhub.com", "pornhub.org",
               "pornhub.net", "eporner.com", "leakporner.com", "mypornerleak.com",
               "djav.org", "1porn.tv")
    if not any(hostname == domain or hostname.endswith("." + domain) for domain in allowed):
        raise HTTPException(400, detail="Unsupported Quantum Search provider")
    stream_path = urllib.parse.urlsplit(stream).path.lower()
    embed = bool(re.search(r"/(?:e|embed)/[a-z0-9_-]+(?:/|$)", stream_path))
    media = bool(re.search(r"\.(?:mp4|m4v|webm|m3u8)(?:$|/)", stream_path))
    if not (embed or media):
        raise HTTPException(422, detail="Provider did not return a playable media or embed URL")
    video = db.query(Video).filter(or_(Video.source_url == source, Video.url == stream)).first()
    if video and (video.storage_type or "").lower() in {"local", "local_direct"}:
        return {"id": video.id, "status": video.status, "existing": True}
    created = video is None
    if created:
        video = Video(source_url=source, batch_name=(data.batch_name or "Quantum Search")[:255], storage_type="remote")
        db.add(video)
    video.url = stream
    video.source_url = source
    video.title = (data.title or video.title or "Untitled")[:500]
    video.status = "ready_to_stream"
    video.error_msg = None
    video.link_status = "unknown"
    if data.thumbnail:
        thumb = _require_public_proxy_url(data.thumbnail.strip()) if data.thumbnail.startswith(("http://", "https://")) else data.thumbnail
        video.thumbnail_path = thumb
        if thumb.startswith(("http://", "https://")):
            video.original_thumbnail_url = thumb
    video.thumbnail_referer = source
    video.duration = max(0, float(data.duration or 0))
    video.width = max(0, int(data.width or 0))
    video.height = max(0, int(data.height or 0))
    video.quality = (data.quality or (f"{video.height}p" if video.height else "Unknown"))[:30]
    video.file_size_mb = max(0, int(data.size_bytes or 0)) / 1048576
    video.upload_date = (data.upload_date or "")[:100]
    video.tags = ", ".join(str(tag) for tag in data.tags if isinstance(tag, str))[:3000]
    db.commit()
    db.refresh(video)
    if hostname.endswith(("leakporner.com", "mypornerleak.com")):
        primary_source = db.query(VideoSource).filter(
            VideoSource.video_id == video.id, VideoSource.is_primary == True
        ).first()
        if primary_source:
            primary_source.url = stream
            primary_source.source_url = source
            primary_source.quality = video.quality
            primary_source.height = video.height
            primary_source.size_mb = video.file_size_mb
        else:
            db.add(VideoSource(video_id=video.id, url=stream, source_url=source,
                               label=hostname, quality=video.quality, height=video.height,
                               size_mb=video.file_size_mb, is_primary=True))
        for raw_alternative in data.embed_urls[:8]:
            try:
                alternative = _require_public_proxy_url(raw_alternative.strip())
            except HTTPException:
                continue
            if alternative == stream or not re.search(r"/(?:e|embed)/[a-z0-9_-]+(?:/|$)", urllib.parse.urlsplit(alternative).path.lower()):
                continue
            if not db.query(VideoSource).filter(VideoSource.video_id == video.id, VideoSource.url == alternative).first():
                db.add(VideoSource(video_id=video.id, url=alternative, source_url=source,
                                   label=urllib.parse.urlsplit(alternative).hostname or "Embed",
                                   quality=video.quality, height=video.height, size_mb=video.file_size_mb,
                                   is_primary=False))
        db.commit()
    if created:
        VIPVideoProcessor().broadcast_new_video(video)
    return {"id": video.id, "status": video.status, "existing": not created}


@api_v1_router.post("/import/text")
@api_legacy_router.post("/import/text")
async def import_text(bg_tasks: BackgroundTasks, data: ImportRequest, auth: bool = Depends(check_auth)):
    """
    API vráti odpoveď OKAMŽITE. Celý import beží na pozadí.
    """
    batch = data.batch_name or f"Import {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    urls = _sanitize_import_urls(data.urls)
    # The Source Board's top Fast Import box uses this legacy endpoint.  Route
    # a pure Pornhub playlist through Intake too, otherwise the old importer
    # treats /playlist/<id> as one video and stores a non-playable placeholder.
    ph_playlist_urls = [
        url for url in urls
        if re.search(r"https?://(?:www\.)?pornhub\.(?:com|org|net)/playlist/\d+(?:[/?#]|$)", url, re.I)
    ]
    if ph_playlist_urls and len(ph_playlist_urls) == len(urls) and not data.items:
        intake_request = IntakeImportRequest(
            urls=urls,
            batch_name=batch,
            source_mode="pornhub",
            auto_metadata=True,
            playwright_fallback=True,
        )
        await _expand_pornhub_playlist_intake_urls(intake_request)
        db = SessionLocal()
        try:
            job = create_import_job(intake_request, db)
            payload = serialize_job(job)
        finally:
            db.close()
        intake_worker.start()
        return {
            "count": payload["total_items"],
            "batch": batch,
            "job": payload,
            "message": "Pornhub playlist expanded into individual videos",
        }
    # Spustíme prácu na pozadí
    bg_tasks.add_task(background_import_process, urls, batch, data.parser or "yt-dlp", data.items, data.min_quality, data.min_duration, data.auto_heal)
    return {"count": len(data.items) if data.items else len(urls), "batch": batch, "message": "Import started in background"}

@api_v1_router.get("/diagnostics/camwhores-integrity")
@api_legacy_router.get("/diagnostics/camwhores-integrity")
async def camwhores_integrity(limit: int = 20, db: Session = Depends(get_db)):
    """
    Quick integrity snapshot for Camwhores imports/playback lineage.
    Helps identify rows that cannot be re-resolved or have weak metadata.
    """
    rows = db.query(Video).filter(
        or_(
            Video.url.ilike("%camwhores%"),
            Video.source_url.ilike("%camwhores%"),
        )
    ).order_by(desc(Video.id)).all()

    total = len(rows)
    missing_source_watch = 0
    missing_duration = 0
    missing_height = 0
    bad_url_shape = 0
    samples = []
    for v in rows:
        src = (v.source_url or "").lower()
        url = (v.url or "").lower()
        has_watch_source = "camwhores.tv/videos/" in src
        if not has_watch_source:
            missing_source_watch += 1
        if not v.duration or v.duration <= 0:
            missing_duration += 1
        if not v.height or v.height <= 0:
            missing_height += 1
        if "camwhores.tv/get_file/" not in url and "camwhores.tv/videos/" not in url:
            bad_url_shape += 1
        if len(samples) < max(1, min(limit, 100)):
            samples.append({
                "id": v.id,
                "title": v.title,
                "url": v.url,
                "source_url": v.source_url,
                "duration": v.duration,
                "height": v.height,
                "status": v.status,
                "corr_id": (re.search(r"/videos/(\\d+)", v.source_url or "") or re.search(r"/videos/(\\d+)", v.url or "")) and f"cw:{(re.search(r'/videos/(\\d+)', v.source_url or '') or re.search(r'/videos/(\\d+)', v.url or '')).group(1)}" or "cw:unknown",
            })

    return {
        "total": total,
        "missing_source_watch": missing_source_watch,
        "missing_duration": missing_duration,
        "missing_height": missing_height,
        "bad_url_shape": bad_url_shape,
        "samples": samples,
    }

@api_v1_router.post("/import/local-folder")
@api_legacy_router.post("/import/local-folder")
async def import_local_folder(data: dict, bg_tasks: BackgroundTasks, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Scan a local folder and index all video files.
    No copying - just creates DB entries pointing to local files.
    """
    folder_path = data.get('folder_path')
    batch_name = data.get('batch_name', f"Local_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}")
    recursive = data.get('recursive', True)

    if not folder_path or not os.path.exists(folder_path):
        raise HTTPException(status_code=400, detail="Invalid folder path")

    from pathlib import Path
    import mimetypes

    # Transport streams belong here: recordings and capture-card output land as
    # .ts far more often than as .mpg, and the player remuxes them on first play.
    video_extensions = {'.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v',
                        '.mpg', '.mpeg', '.ts', '.m2ts', '.mts', '.m2t'}
    file_paths = []

    # Scan folder for video files
    folder = Path(folder_path)
    pattern = '**/*' if recursive else '*'

    for file_path in folder.glob(pattern):
        if file_path.is_file():
            ext = file_path.suffix.lower()
            if ext in video_extensions:
                file_paths.append(str(file_path))

    if not file_paths:
        return {"count": 0, "message": "No video files found in folder"}

    # Index files using the fast indexing endpoint
    indexed_count = 0
    video_ids = []

    for file_path in file_paths:
        try:
            path_obj = Path(file_path)
            file_url = path_obj.as_uri()
            file_size_mb = round(path_obj.stat().st_size / (1024 * 1024), 2)

            video = Video(
                title=path_obj.name,
                url=file_url,
                source_url=file_url,
                batch_name=batch_name,
                status="ready",
                storage_type="local_direct",
                file_size_mb=file_size_mb,
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            )

            db.add(video)
            db.flush()
            video_ids.append(video.id)
            indexed_count += 1

        except Exception as e:
            logging.warning(f"Failed to index {file_path}: {e}")
            continue

    db.commit()

    # Extract metadata in background
    if video_ids:
        bg_tasks.add_task(extract_local_metadata_batch, video_ids)

    return {
        "count": indexed_count,
        "batch": batch_name,
        "message": f"Indexed {indexed_count} videos from folder",
        "video_ids": video_ids
    }

@api_v1_router.post("/import/local-index")
@api_legacy_router.post("/import/local-index")
async def import_local_index(data: dict, bg_tasks: BackgroundTasks, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Ultra-fast local file indexing - no copying, no upload.
    Indexes local video files directly from disk paths.
    Expected to handle 100 files in ~3 seconds.
    """
    file_paths = data.get('file_paths', [])
    batch_name = data.get('batch_name', f"Local_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}")

    if not file_paths:
        return {"count": 0, "message": "No files provided"}

    import mimetypes
    from pathlib import Path

    indexed_count = 0
    video_ids = []

    # Fast indexing - minimal processing
    for file_path in file_paths:
        try:
            path_obj = Path(file_path)

            # Quick validation
            if not path_obj.exists() or not path_obj.is_file():
                continue

            # Check if it's a video file
            mime_type, _ = mimetypes.guess_type(file_path)
            if not mime_type or not mime_type.startswith('video/'):
                continue

            # Get file size and basic info (very fast)
            file_size = path_obj.stat().st_size
            file_name = path_obj.name
            file_size_mb = round(file_size / (1024 * 1024), 2)

            # Create DB entry with local file:// URL
            # Windows paths: file:///C:/path/to/video.mp4
            # Unix paths: file:///path/to/video.mp4
            file_url = path_obj.as_uri()

            video = Video(
                title=file_name,
                url=file_url,
                source_url=file_url,
                batch_name=batch_name,
                status="ready",  # Mark as ready immediately - no processing needed
                storage_type="local_direct",  # New type for direct local access
                file_size_mb=file_size_mb,
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            )

            db.add(video)
            db.flush()
            video_ids.append(video.id)
            indexed_count += 1

        except Exception as e:
            logging.warning(f"Failed to index {file_path}: {e}")
            continue

    db.commit()

    # Optional: Extract metadata in background (non-blocking)
    if video_ids:
        bg_tasks.add_task(extract_local_metadata_batch, video_ids)

    return {
        "count": indexed_count,
        "batch": batch_name,
        "message": f"Indexed {indexed_count} local videos instantly",
        "video_ids": video_ids
    }

def extract_local_metadata_batch(video_ids: List[int]):
    """
    Background task to extract metadata from local files.
    Uses ffprobe for fast metadata extraction without processing video.
    """
    import subprocess
    from pathlib import Path

    db = SessionLocal()
    try:
        for video_id in video_ids:
            try:
                video = db.query(Video).get(video_id)
                if not video or not video.url:
                    continue

                # Convert file:// URL back to path
                from urllib.parse import urlparse, unquote
                parsed = urlparse(video.url)
                file_path = unquote(parsed.path)

                # On Windows, remove leading slash from /C:/path
                if os.name == 'nt' and file_path.startswith('/') and ':' in file_path:
                    file_path = file_path[1:]

                if not os.path.exists(file_path):
                    continue

                try:
                    size_mb = round(os.path.getsize(file_path) / (1024 * 1024), 2)
                    if size_mb > 0:
                        video.file_size_mb = size_mb
                except Exception:
                    pass

                # Use ffprobe for fast metadata extraction
                cmd = [
                    'ffprobe',
                    '-v', 'quiet',
                    '-print_format', 'json',
                    '-show_format',
                    '-show_streams',
                    file_path
                ]

                result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
                if result.returncode == 0:
                    metadata = json.loads(result.stdout)

                    # Extract duration
                    duration = 0
                    if 'format' in metadata and 'duration' in metadata['format']:
                        duration = float(metadata['format']['duration'])
                        video.duration = duration

                    # Extract resolution from video stream
                    for stream in metadata.get('streams', []):
                        if stream.get('codec_type') == 'video':
                            video.width = stream.get('width', 0)
                            video.height = stream.get('height', 0)
                            break

                    # Generate thumbnail (at 10% of duration or 5 seconds, whichever is smaller)
                    thumb_dir = os.path.join("app", "static", "thumbnails", "local")
                    os.makedirs(thumb_dir, exist_ok=True)

                    thumb_time = min(5, duration * 0.1) if duration > 0 else 5
                    thumb_filename = f"local_{video_id}.jpg"
                    thumb_path = os.path.join(thumb_dir, thumb_filename)

                    thumb_cmd = [
                        'ffmpeg',
                        '-y',  # Overwrite if exists
                        '-ss', str(thumb_time),  # Seek to timestamp
                        '-i', file_path,
                        '-vframes', '1',  # Extract 1 frame
                        '-vf', 'scale=320:-1',  # Scale to 320px width, maintain aspect ratio
                        '-q:v', '2',  # High quality JPEG
                        thumb_path
                    ]

                    try:
                        thumb_result = subprocess.run(
                            thumb_cmd,
                            capture_output=True,
                            text=True,
                            timeout=10,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
                        )

                        if thumb_result.returncode == 0 and os.path.exists(thumb_path):
                            video.thumbnail_path = f"/static/thumbnails/local/{thumb_filename}"
                            logging.info(f"Generated thumbnail for local video {video_id}")
                    except Exception as thumb_err:
                        logging.warning(f"Failed to generate thumbnail for video {video_id}: {thumb_err}")

                    db.commit()
                    logging.info(f"Extracted metadata for local video {video_id}")

            except Exception as e:
                logging.warning(f"Failed to extract metadata for video {video_id}: {e}")
                continue
    finally:
        db.close()

@api_v1_router.get("/videos/{video_id}/preview")
@api_legacy_router.get("/videos/{video_id}/preview")
async def generate_video_preview(video_id: int, db: Session = Depends(get_db)):
    """
    Generate a 5-second preview clip for hover previews.
    Returns the preview video URL or generates it on-demand.
    """
    import subprocess
    from urllib.parse import urlparse, unquote
    from fastapi.responses import FileResponse

    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    # Create previews directory
    preview_dir = os.path.join("app", "static", "previews")
    os.makedirs(preview_dir, exist_ok=True)

    preview_filename = f"preview_{video_id}.mp4"
    preview_path = os.path.join(preview_dir, preview_filename)

    # If preview already exists, return it
    if os.path.exists(preview_path):
        return FileResponse(preview_path, media_type="video/mp4")

    # For local videos, generate preview from file
    if video.storage_type == "local_direct" and video.url:
        try:
            # Convert file:// URL back to path
            parsed = urlparse(video.url)
            file_path = unquote(parsed.path)

            # On Windows, remove leading slash from /C:/path
            if os.name == 'nt' and file_path.startswith('/') and ':' in file_path:
                file_path = file_path[1:]

            if not os.path.exists(file_path):
                raise HTTPException(status_code=404, detail="Source file not found")

            # Generate 5-second preview starting from 10% into video
            duration = video.duration or 30
            start_time = min(5, duration * 0.1) if duration > 0 else 5

            preview_cmd = [
                'ffmpeg',
                '-y',  # Overwrite if exists
                '-ss', str(start_time),  # Start time
                '-i', file_path,
                '-t', '5',  # Duration: 5 seconds
                '-vf', 'scale=480:-1',  # Scale to 480px width
                '-c:v', 'libx264',  # H.264 codec
                '-preset', 'ultrafast',  # Fast encoding
                '-crf', '28',  # Quality (higher = lower quality, smaller file)
                '-an',  # No audio (smaller file)
                preview_path
            ]

            result = subprocess.run(
                preview_cmd,
                capture_output=True,
                text=True,
                timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            )

            if result.returncode == 0 and os.path.exists(preview_path):
                return FileResponse(preview_path, media_type="video/mp4")
            else:
                raise HTTPException(status_code=500, detail="Failed to generate preview")

        except Exception as e:
            logging.error(f"Error generating preview for video {video_id}: {e}")
            raise HTTPException(status_code=500, detail=str(e))
    else:
        raise HTTPException(status_code=400, detail="Preview generation only supported for local videos")

@api_v1_router.get("/videos/{video_id}/stream")
@api_legacy_router.get("/videos/{video_id}/stream")
async def stream_local_video(video_id: int, request: Request, db: Session = Depends(get_db)):
    """
    Stream local video files directly to the browser.
    Supports range requests for seeking.
    """
    from urllib.parse import urlparse, unquote

    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    # Only stream local_direct videos
    if video.storage_type != "local_direct" or not video.url:
        raise HTTPException(status_code=400, detail="Streaming only supported for local videos")

    # Convert file:// URL back to path
    parsed = urlparse(video.url)
    file_path = unquote(parsed.path)
    return _stream_file_response(file_path, request)

def _serialize_video_source(source: VideoSource) -> dict:
    return {
        "id": source.id,
        "video_id": source.video_id,
        "url": source.url,
        "source_url": source.source_url,
        "label": source.label or "Unknown",
        "quality": source.quality or "",
        "height": source.height or 0,
        "size_mb": round(source.size_mb or 0, 1),
        "is_primary": bool(source.is_primary),
        "link_status": source.link_status or "unknown",
        "added_at": source.added_at.isoformat() if source.added_at else None,
    }


@api_v1_router.get("/videos/{video_id}/sources")
@api_legacy_router.get("/videos/{video_id}/sources")
async def get_video_sources(video_id: int, db: Session = Depends(get_db)):
    """List every known host for one library card (its own primary URL plus
    any mirrors matched at import time — see media_match.looks_like_same_video
    and IntakeWorker._find_cross_host_match / bulk_import._find_cross_host_match).

    A card with no recorded mirrors still returns one entry — its own URL — so
    the UI never has to special-case "no sources row exists yet".
    """
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    rows = (
        db.query(VideoSource)
        .filter(VideoSource.video_id == video_id)
        .order_by(VideoSource.is_primary.desc(), VideoSource.id.asc())
        .all()
    )
    if not rows:
        from .source_catalog import classify_library_source_name
        return {
            "video_id": video_id,
            "sources": [{
                "id": None, "video_id": video_id, "url": video.url,
                "source_url": video.source_url,
                "label": classify_library_source_name(video.url, video.source_url),
                "quality": video.quality or "", "height": video.height or 0,
                "size_mb": round(video.file_size_mb or 0, 1), "is_primary": True,
                "link_status": video.link_status or "unknown", "added_at": None,
            }],
        }
    return {"video_id": video_id, "sources": [_serialize_video_source(r) for r in rows]}


@api_v1_router.post("/videos/{video_id}/sources/{source_id}/activate")
@api_legacy_router.post("/videos/{video_id}/sources/{source_id}/activate")
async def activate_video_source(video_id: int, source_id: int, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Make one mirror the primary: its URL becomes the card's playback URL,
    and every VideoSource row for this video is re-flagged so exactly one
    stays is_primary=True. The previous primary is kept as a source (now
    unflagged), not deleted — switching is never destructive.
    """
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
    target = db.query(VideoSource).filter(
        VideoSource.id == source_id, VideoSource.video_id == video_id,
    ).first()
    if not target:
        raise HTTPException(status_code=404, detail="Source not found for this video")

    # If this is the first time a source is activated on a video that has no
    # VideoSource rows at all yet (the "single implicit primary" case), the
    # caller must have created rows first — get_video_sources's synthetic
    # fallback row has id=None and can't be the id in the URL, so reaching
    # here with a real target means rows already exist.
    for row in db.query(VideoSource).filter(VideoSource.video_id == video_id).all():
        row.is_primary = (row.id == target.id)

    video.url = target.url
    video.source_url = target.source_url or target.url
    if target.quality:
        video.quality = target.quality
    if target.height:
        video.height = target.height
    if target.size_mb:
        video.file_size_mb = target.size_mb
    # A source the user is switching TO is being trusted right now; let the
    # next health check confirm it rather than assuming.
    video.link_status = target.link_status or "unknown"
    db.commit()

    return {"success": True, "video_id": video_id, "active_source_id": target.id, "url": video.url}


@api_v1_router.post("/videos/{video_id}/sources/from-video/{source_video_id}/activate")
@api_legacy_router.post("/videos/{video_id}/sources/from-video/{source_video_id}/activate")
async def activate_video_mirror_record(
    video_id: int,
    source_video_id: int,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Attach and activate an older duplicate library row as a mirror."""
    from .source_catalog import classify_library_source_name

    video = db.query(Video).get(video_id)
    source_video = db.query(Video).get(source_video_id)
    if not video or not source_video:
        raise HTTPException(status_code=404, detail="Video not found")
    if video_id == source_video_id:
        raise HTTPException(status_code=400, detail="A video cannot be its own mirror")

    def facts(row: Video) -> MediaFacts:
        return MediaFacts.from_fields(
            title=row.title or "",
            url=row.url or "",
            thumbnail=row.original_thumbnail_url or row.thumbnail_path or "",
            size_bytes=(row.file_size_mb or 0) * 1024 * 1024,
            duration=row.duration or 0,
            height=row.height or 0,
        )

    if not looks_like_same_video(facts(video), facts(source_video)):
        raise HTTPException(status_code=409, detail="Selected video does not match this card")
    if not source_video.url:
        raise HTTPException(status_code=409, detail="Selected video has no playable URL")

    rows = db.query(VideoSource).filter(VideoSource.video_id == video_id).all()
    if not rows and video.url:
        primary = VideoSource(
            video_id=video_id,
            url=video.url,
            source_url=video.source_url,
            label=classify_library_source_name(video.url, video.source_url),
            quality=video.quality,
            height=video.height or 0,
            size_mb=video.file_size_mb or 0,
            is_primary=True,
            link_status=video.link_status or "unknown",
        )
        db.add(primary)
        db.flush()
        rows.append(primary)

    target = next((row for row in rows if row.url == source_video.url), None)
    if target is None:
        target = VideoSource(
            video_id=video_id,
            url=source_video.url,
            source_url=source_video.source_url or source_video.url,
            label=classify_library_source_name(source_video.url, source_video.source_url),
            quality=source_video.quality or "",
            height=source_video.height or 0,
            size_mb=source_video.file_size_mb or 0,
            is_primary=False,
            link_status=source_video.link_status or "unknown",
        )
        db.add(target)
        db.flush()

    for row in rows:
        row.is_primary = row.id == target.id
    target.is_primary = True
    video.url = target.url
    video.source_url = target.source_url or target.url
    if target.quality:
        video.quality = target.quality
    if target.height:
        video.height = target.height
    if target.size_mb:
        video.file_size_mb = target.size_mb
    video.link_status = target.link_status or "unknown"
    db.commit()

    return {"success": True, "video_id": video_id, "active_source_id": target.id, "url": video.url}


@api_v1_router.post("/import/file")
@api_legacy_router.post("/import/file")
async def import_file(bg_tasks: BackgroundTasks, file: UploadFile = File(...), db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    filename = file.filename
    ext = filename.lower().rsplit('.', 1)[-1]

    if ext in ["mp4", "mkv", "avi", "mov", "webm"]:
        save_dir = "app/static/local_videos"
        os.makedirs(save_dir, exist_ok=True)
        save_path = os.path.join(save_dir, os.path.basename(filename))
        with open(save_path, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024 * 10)
                if not chunk: break
                f.write(chunk)
        v = Video(
            title=os.path.basename(filename), 
            url=f"/static/local_videos/{os.path.basename(save_path)}", 
            batch_name=f"Local_{filename}", 
            status="pending",
            storage_type="local"
        )
        db.add(v); db.commit()
        processor = VIPVideoProcessor()
        bg_tasks.add_task(processor.process_single_video, v.id, force=True)
        return {"count": 1, "message": "Video uploaded"}

    # CSV import
    if ext == "csv":
        import csv
        import io
        content = await file.read()
        try:
            text = content.decode('utf-8')
        except:
            text = content.decode('latin-1', errors='ignore')
        reader = csv.DictReader(io.StringIO(text))
        count = 0
        new_ids = []
        for row in reader:
            # Očakávame stĺpce: title, url, prípadne ďalšie (prispôsobiť podľa .csv)
            title = row.get('title') or row.get('name') or row.get('Title') or row.get('Name') or 'Untitled'
            url = row.get('url') or row.get('Url') or row.get('URL')
            if not url:
                continue
            video = Video(
                title=title,
                url=url,
                source_url=url,
                batch_name=f"CSV_{filename}",
                status="pending",
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)
            count += 1
        db.commit()
        processor = VIPVideoProcessor()
        bg_tasks.add_task(processor.process_batch, new_ids)
        return {"count": count, "batch": f"CSV_{filename}", "message": f"Imported {count} videos from CSV"}

    # Text/JSON import - delegujeme na background task
    content = await file.read()
    try: text = content.decode('utf-8')
    except: text = content.decode('latin-1', errors='ignore')
    
    urls = []
    items_to_import = []
    
    if filename.endswith('.json'):
        try:
            j = json.loads(text)
            raw_objects = []
            
            if isinstance(j, list):
                raw_objects = j
            elif isinstance(j, dict):
                if "list" in j:
                    list_val = j["list"]
                    if isinstance(list_val, dict):
                        raw_objects = list(list_val.values())
                    elif isinstance(list_val, list):
                        raw_objects = list_val
                else:
                    if all(isinstance(v, dict) for v in j.values()):
                        raw_objects = list(j.values())
                    else:
                        raw_objects = [j]
            
            for obj in raw_objects:
                if not isinstance(obj, dict):
                    s_url = str(obj).strip()
                    if s_url.startswith('http'):
                        urls.append(s_url)
                        items_to_import.append({"url": s_url})
                    continue
                
                primary_url = obj.get("url") or obj.get("href") or obj.get("video_url") or obj.get("stream_url")
                if primary_url:
                    primary_url = str(primary_url).strip()
                    if primary_url.startswith('http'):
                        urls.append(primary_url)
                        item = {
                            "url": primary_url,
                            "title": obj.get("title") or obj.get("label") or obj.get("name") or "Untitled",
                            "thumbnail": obj.get("thumb") or obj.get("thumbnail") or obj.get("image") or "",
                            "duration": obj.get("duration") or "",
                            "tags": obj.get("tags") or [],
                            "source_url": obj.get("source_url") or obj.get("href") or obj.get("foundAt") or primary_url,
                        }
                        items_to_import.append(item)
            
            urls = list(dict.fromkeys(urls))
            
        except Exception as e:
            print(f"Failed to parse JSON content: {e}")
            urls = []
            items_to_import = []
    else:
        urls = [u.strip() for u in text.splitlines() if u.strip().startswith('http')]

    batch = f"Import_{filename}"
    bg_tasks.add_task(background_import_process, urls, batch, "yt-dlp", items_to_import if items_to_import else None, None, None, True)
    return {"count": len(urls), "batch": batch, "message": "File import started in background"}

@api_v1_router.post("/import/xvideos")
@api_legacy_router.post("/import/xvideos")
async def import_xvideos(data: XVideosImportRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Import single XVideos URL, extract metadata, and save to DB.
    Returns JSON metadata for immediate display.
    Uses regex scraper first (better HLS detection), falls back to yt-dlp.
    """
    processor = VIPVideoProcessor()
    
    # Try the improved yt-dlp extractor first (targeted for VIP quality)
    logging.info(f"Extracting XVideos metadata for {data.url}")
    meta = processor.extract_xvideos_metadata(data.url)
    
    # Fallback to regex scraper if yt-dlp failed
    if not meta:
        logging.info(f"Yt-dlp failed, falling back to regex scraper for {data.url}")
        try:
            xv_meta, xv_stream_url = processor._fetch_xvideos_meta(data.url)
            if xv_stream_url:
                meta_with_quality = await processor._ffprobe_fallback(xv_stream_url, xv_meta, referer=data.url)
                
                video_id = ''
                try:
                    parts = data.url.split('/')
                    for part in parts:
                        if part.startswith('video.'):
                            video_id = part.split('.')[-1] if '.' in part else part
                            break
                except: pass

                meta = {
                    "source": "xvideos",
                    "id": video_id or data.url.split('/')[-1].split('/')[0] if '/' in data.url else '',
                    "title": xv_meta.get('title', ''),
                    "duration": meta_with_quality.get('duration', xv_meta.get('duration', 0)),
                    "thumbnail": xv_meta.get('thumbnail_url', ''),
                    "stream": {
                        "type": "hls" if '.m3u8' in xv_stream_url.lower() else "mp4",
                        "url": xv_stream_url,
                        "height": meta_with_quality.get('height', 0),
                        "width": meta_with_quality.get('width', 0)
                    },
                    "tags": xv_meta.get('tags', '').split(',') if isinstance(xv_meta.get('tags'), str) else []
                }
        except Exception as e:
            logging.error(f"Fallback scraper also failed: {e}")

    if not meta:
        return JSONResponse(status_code=400, content={"error": "EXTRACTION_FAILED"})
    
    # Check if exists
    existing = db.query(Video).filter(Video.source_url == data.url).first()
    if existing:
        # Update existing
        existing.url = meta['stream']['url']
        existing.title = meta['title']
        existing.duration = meta['duration']
        existing.thumbnail_path = meta['thumbnail']
        existing.height = meta['stream'].get('height', 0)
        existing.width = meta['stream'].get('width', 0)
        existing.status = "ready"
        db.commit()
        db.refresh(existing)
        video_id = existing.id
    else:
        # Create new
        video = Video(
            title=meta['title'],
            url=meta['stream']['url'],
            source_url=data.url,
            duration=meta['duration'],
            thumbnail_path=meta['thumbnail'],
            height=meta['stream'].get('height', 0),
            width=meta['stream'].get('width', 0),
            status="ready",
            batch_name=f"Import XVideos {datetime.datetime.now().strftime('%d.%m')}",
            created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
        )
        db.add(video)
        db.commit()
        db.refresh(video)
        video_id = video.id

    # Add DB ID to response if needed, but the prompt specified a specific shape.
    # The prompt asked for: source, id, title, duration, thumbnail, stream object.
    # The extracted meta has this shape.
    # We might want to pass the DB ID as 'id' or keep the source ID?
    # The prompt example: "id": "okchumv725e" (looks like xvideos ID).
    # But for the frontend to work with the player and internal logic, it usually needs the DB ID.
    # However, the frontend "importXVideos" logic will likely map this response to the internal video object.
    # The internal video object needs 'id' (DB ID) for things like favorites/delete etc.
    # But the prompt explicitly defined the response shape.
    # I will stick to the requested response shape, but if the frontend needs to manipulate the video later,
    # it might be tricky if I don't return the DB ID.
    # Wait, the prompt says "BACKEND RESPONSE (JSON SHAPE)... id: okchumv725e". This is the XVideos ID.
    # But the dashboard displays videos from DB.
    # If I implement "Import", I am adding to DB.
    # The frontend will probably reload or add to the list.
    # If the frontend adds to the list using this JSON, it will have the XVideos ID, not DB ID.
    # If the user clicks "Favorite", it sends the ID. If it sends "okchumv725e", the backend won't find it (expects int).
    # This suggests a conflict.
    # Option A: The frontend reloads the list after import (batch load).
    # Option B: The response should include the DB ID, maybe as a separate field or replacing 'id'.
    # The prompt says "BACKEND RESPONSE (JSON SHAPE) ... id: ...".
    # I will modify the response to include `db_id` or just rely on the fact that `id` in the prompt might be flexible or I should just return what is asked.
    # But for a functional dashboard, I'll return the requested shape. The user said "backend spracúva... priebežne renderuje UI".
    # If the user wants full functionality (like delete/fav) immediately on these items, they need DB ID.
    # I will add `db_id` to the response just in case, it doesn't hurt.
    
    meta['db_id'] = video_id
    return meta
    
@api_v1_router.post("/import/spankbang")
@api_legacy_router.post("/import/spankbang")
async def import_spankbang(data: SpankBangImportRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Import single SpankBang URL, extract metadata, and save to DB.
    """
    from app.extractors.legacy.spankbang import SpankBangExtractor
    sb = SpankBangExtractor()
    meta_raw = await sb.extract_metadata(data.url)
    
    if not meta_raw or not meta_raw.get('found'):
         return JSONResponse(status_code=400, content={"error": "EXTRACTION_FAILED"})
         
    # Check if exists
    existing = db.query(Video).filter(Video.source_url == data.url).first()
    if existing:
        existing.url = meta_raw['stream_url']
        existing.status = 'ready'
        db.commit()
        db.refresh(existing)
        video_id = existing.id
    else:
        video = Video(
            title=meta_raw['title'],
            url=meta_raw['stream_url'],
            source_url=data.url,
            thumbnail_path=meta_raw['thumbnail_url'],
            duration=meta_raw['duration'],
            status='ready',
            storage_type='remote',
            tags=",".join(meta_raw.get('tags', []))
        )
        db.add(video)
        db.commit()
        db.refresh(video)
        video_id = video.id

    # Format response for frontend
    response = {
        "source": "spankbang",
        "id": data.url.split('/')[-1],
        "db_id": video_id,
        "title": meta_raw['title'],
        "duration": meta_raw['duration'],
        "thumbnail": meta_raw['thumbnail_url'],
        "stream": {
            "type": "hls" if ".m3u8" in (meta_raw['stream_url'] or "").lower() else "mp4",
            "url": meta_raw['stream_url'],
            "height": 1080 if "1080p" in (meta_raw.get('quality_source') or "").lower() else 0,
            "width": 1920 if "1080p" in (meta_raw.get('quality_source') or "").lower() else 0
        },
        "tags": meta_raw.get('tags', [])
    }
    return response

@api_v1_router.post("/import/eporner_search")
@api_legacy_router.post("/import/eporner_search")
async def import_eporner_search(
    data: EpornerSearchRequest = Body(...),
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """
    Import Eporner search results in a backend-safe way.

    We store the stable watch-page URL in both url/source_url and mark the item
    ready for playback refresh. This avoids forcing backend extraction for a
    source that may be IP-banned unless a proxy/browser-assisted path is used.
    """
    batch = data.batch_name or f"Eporner {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    videos = fetch_eporner_videos(
        query=data.query,
        per_page=data.count,
        hd=1 if data.min_quality >= 720 else 0,
        order="newest",
    )
    new_ids = []

    for v in videos:
        watch_url = (v.get("url") or "").strip()
        if not watch_url.startswith("http"):
            continue

        existing = db.query(Video).filter(
            (Video.url == watch_url) | (Video.source_url == watch_url)
        ).first()
        if existing:
            continue

        video = Video(
            title=(v.get("title") or "Eporner Video").strip() or "Eporner Video",
            url=watch_url,
            source_url=watch_url,
            batch_name=batch,
            status="ready_to_stream",
            storage_type="remote",
            thumbnail_path=v.get("thumbnail"),
            duration=int(v.get("duration") or 0) or None,
            created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None),
        )
        db.add(video)
        db.flush()
        new_ids.append(video.id)

    db.commit()
    logging.info(f"[EPORNER_SEARCH_IMPORT] Imported {len(new_ids)} videos as ready_to_stream")
    return {
        "count": len(new_ids),
        "batch": batch,
        "message": f"Added {len(new_ids)} Eporner videos",
    }

@api_v1_router.post("/import/hqporner")
@api_legacy_router.post("/import/hqporner")
async def import_hqporner(bg_tasks: BackgroundTasks, data: HQPornerImportRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Search and import videos from HQPorner based on keywords, quality, and date filters.
    """
    from app.extractors.legacy.hqporner import HQPornerExtractor
    extractor = HQPornerExtractor()
    
    keywords_list = [k.strip() for k in data.keywords.split(',') if k.strip()] if data.keywords else []
    batch = data.batch_name or f"HQPorner {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    
    total_found = 0
    all_results = []
    
    page = 1
    max_pages = 5
    
    while total_found < data.count and page <= max_pages:
        # Use category search for 4K quality (keyword search doesn't filter properly on HQPorner)
        if data.category or (data.min_quality and data.min_quality.lower() in ['2160p', '4k']):
            category = data.category or '4k-porn'
            # Pass keywords to category search for filtering within category
            results = await asyncio.to_thread(extractor.search_category, category, page, data.min_quality, data.added_within, ' '.join(keywords_list) if keywords_list else '')
        elif keywords_list:
            results = await asyncio.to_thread(extractor.search, ' '.join(keywords_list), data.min_quality, data.added_within, page)
        else:
            break
            
        if not results:
            break
            
        all_results.extend(results)
        total_found = len(all_results)
        page += 1
    
    # Limit to requested count
    all_results = all_results[:data.count]
    
    # Queue background task to process videos
    async def process_hqporner_batch():
        from app.database import SessionLocal
        
        async def process_single_video(video_data):
            db_task = SessionLocal()
            video_id = None
            try:
                # 1. Check if already exists
                existing = db_task.query(Video).filter(Video.source_url == video_data['url']).first()
                if existing:
                    return

                # 2. Create entry in 'processing' status
                video = Video(
                    title=video_data.get('title', 'Untitled'),
                    url="", 
                    source_url=video_data['url'],
                    thumbnail_path=video_data.get('thumbnail', ''),
                    duration=video_data.get('duration', 0),
                    height=video_data.get('height', 1080),
                    width=video_data.get('width', 1920),
                    status="processing",
                    batch_name=batch,
                    storage_type="remote",
                    created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
                )
                db_task.add(video)
                db_task.commit()
                db_task.refresh(video)
                video_id = video.id

                # Notify UI immediately
                await manager.broadcast(json.dumps({
                    "type": "new_video",
                    "video": {
                        "id": video.id,
                        "title": video.title,
                        "thumbnail_path": video.thumbnail_path,
                        "batch_name": video.batch_name,
                        "status": video.status
                    }
                }))

                # 3. Resolve stream URL with timeout
                try:
                    meta = await asyncio.wait_for(extractor.extract(video.source_url), timeout=30)
                    if meta and meta.get('stream_url'):
                        video.url = meta['stream_url']
                        video.status = "ready"
                    else:
                        video.status = "error"
                        video.error_msg = "Could not extract stream URL"
                except asyncio.TimeoutError:
                    video.status = "error"
                    video.error_msg = "Extraction timed out"
                except Exception as e:
                    video.status = "error"
                    video.error_msg = str(e)

                db_task.commit()

                # Notify UI of status change
                await manager.broadcast(json.dumps({
                    "type": "status_update",
                    "video_id": video.id,
                    "status": video.status,
                    "title": video.title,
                    "thumbnail_path": video.thumbnail_path,
                    "duration": video.duration,
                    "height": video.height,
                    "width": video.width,
                    "file_size_mb": float(video.file_size_mb or 0),
                }))

            except Exception as e:
                logging.error(f"Critical error in HQPorner processing for {video_data.get('url')}: {e}")
                if video_id:
                    try:
                        v = db_task.query(Video).get(video_id)
                        if v:
                            v.status = "error"
                            v.error_msg = str(e)
                            db_task.commit()
                    except: pass
                db_task.rollback()
            finally:
                db_task.close()

        # Run all extractions in parallel
        tasks = [process_single_video(vd) for vd in all_results]
        await asyncio.gather(*tasks)

    bg_tasks.add_task(process_hqporner_batch)
    
    return {
        "status": "success",
        "count": len(all_results),
        "batch": batch,
        "message": f"Queued {len(all_results)} videos from HQPorner"
    }

@api_v1_router.post("/import/beeg")
@api_legacy_router.post("/import/beeg")
async def import_beeg(bg_tasks: BackgroundTasks, data: BeegImportRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Crawl and import videos from Beeg.com using the beeg_crawler.py script.
    """
    batch = data.batch_name or f"Beeg {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    
    async def run_beeg_crawler():
        """Background task to run the Beeg crawler and import results"""
        import tempfile
        from .extractors.beeg import BeegExtractor
        db_task = SessionLocal()
        beeg_extractor = BeegExtractor()
        
        try:
            # Create temporary file for crawler output
            with tempfile.NamedTemporaryFile(mode='w+', suffix='.json', delete=False) as tmp_file:
                tmp_path = tmp_file.name
            
            # Run the crawler script
            cmd = [
                sys.executable,
                "beeg_crawler.py",
                "--query", data.query,
                "--max_results", str(data.count),
                "--output", tmp_path
            ]
            
            logging.info(f"Running Beeg crawler: {' '.join(cmd)}")
            result = await asyncio.to_thread(
                subprocess.run,
                cmd,
                capture_output=True,
                text=True,
                timeout=300  # 5 minute timeout
            )
            
            if result.returncode != 0:
                logging.error(f"Beeg crawler failed: {result.stderr}")
                await manager.log(f"Beeg crawl failed: {result.stderr[:200]}", "error")
                return
            
            # Read the results
            with open(tmp_path, 'r', encoding='utf-8') as f:
                crawler_results = json.load(f)
            
            # Clean up temp file
            os.unlink(tmp_path)
            
            if not crawler_results:
                await manager.log("Beeg crawler returned no results", "warning")
                return
            
            # Import each video
            imported_count = 0
            for video_data in crawler_results:
                try:
                    page_url = video_data.get('video_url', '')
                    stream_url = video_data.get('stream_url', '')
                    
                    if not page_url:
                        continue

                    # Check if already exists
                    existing = db_task.query(Video).filter(Video.source_url == page_url).first()
                    if existing:
                        continue

                    resolved = await beeg_extractor.extract(page_url)
                    resolved_stream = str((resolved or {}).get('stream_url') or stream_url or '').strip()
                    if not resolved_stream:
                        logging.warning(f"No playable Beeg stream for {video_data.get('title', 'Unknown')}, skipping")
                        continue
                    stream_url = resolved_stream
                    
                    # Parse duration (format: "MM:SS" or "HH:MM:SS")
                    duration_str = video_data.get('duration', '0:00')
                    duration_parts = duration_str.split(':')
                    if len(duration_parts) == 2:
                        duration = int(duration_parts[0]) * 60 + int(duration_parts[1])
                    elif len(duration_parts) == 3:
                        duration = int(duration_parts[0]) * 3600 + int(duration_parts[1]) * 60 + int(duration_parts[2])
                    else:
                        duration = 0
                    if resolved and resolved.get("duration"):
                        duration = int(float(resolved.get("duration") or 0) or duration or 0)
                    
                    # Download and save thumbnail locally to avoid CORS issues
                    thumbnail_path = ""
                    thumbnail_url = (resolved or {}).get('thumbnail') or video_data.get('thumbnail')
                    if thumbnail_url:
                        try:
                            thumb_url = thumbnail_url
                            # Create thumbnails directory if it doesn't exist
                            thumb_dir = os.path.join("app", "static", "thumbnails")
                            os.makedirs(thumb_dir, exist_ok=True)
                            
                            # Generate filename from video ID or hash
                            import hashlib
                            thumb_hash = hashlib.md5(page_url.encode()).hexdigest()
                            thumb_filename = f"beeg_{thumb_hash}.jpg"
                            thumb_path = os.path.join(thumb_dir, thumb_filename)
                            
                            # Download thumbnail
                            async with http_session.get(thumb_url) as resp:
                                if resp.status == 200:
                                    with open(thumb_path, 'wb') as f:
                                        f.write(await resp.read())
                                    thumbnail_path = f"/static/thumbnails/{thumb_filename}"
                        except Exception as e:
                            logging.error(f"Error downloading thumbnail: {e}")
                            # Use original URL as fallback (will be proxied by frontend)
                            thumbnail_path = thumbnail_url
                    
                    final_video_url = stream_url
                    resolved_title = str((resolved or {}).get('title') or '').strip()
                    resolved_height = int((resolved or {}).get('height') or 0)
                    
                    # Create video entry
                    video = Video(
                        title=resolved_title or video_data.get('title', 'Untitled'),
                        url=final_video_url,  # Use the final URL (parsed from HLS if needed)
                        source_url=page_url,
                        thumbnail_path=thumbnail_path,
                        duration=duration,
                        tags=','.join(video_data.get('tags', [])),
                        batch_name=batch,
                        height=resolved_height,
                        width=int((resolved or {}).get('width') or 0),
                        quality=(resolved or {}).get('quality') or ('FHD' if resolved_height >= 1080 else 'HD' if resolved_height >= 720 else 'SD'),
                        status="ready_to_stream",
                        storage_type="remote",
                        created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
                    )
                    
                    db_task.add(video)
                    db_task.flush()
                    imported_count += 1
                    
                    # Notify UI
                    await manager.broadcast(json.dumps({
                        "type": "new_video",
                        "video": {
                            "id": video.id,
                            "title": video.title,
                            "thumbnail_path": video.thumbnail_path,
                            "batch_name": video.batch_name,
                            "status": video.status
                        }
                    }))
                    
                except Exception as e:
                    logging.error(f"Error importing Beeg video {video_data.get('title')}: {e}")
                    continue
            
            db_task.commit()
            await manager.log(f"✓ Imported {imported_count} videos from Beeg", "success")
            
        except subprocess.TimeoutExpired:
            logging.error("Beeg crawler timed out")
            await manager.log("Beeg crawler timed out after 5 minutes", "error")
        except Exception as e:
            logging.error(f"Beeg import error: {e}")
            await manager.log(f"Beeg import error: {str(e)[:200]}", "error")
            db_task.rollback()
        finally:
            db_task.close()
    
    bg_tasks.add_task(run_beeg_crawler)
    
    return {
        "status": "success",
        "count": data.count,
        "batch": batch,
        "message": f"Started Beeg crawl for '{data.query}'"
    }

@api_v1_router.post("/import/redgifs")
@api_legacy_router.post("/import/redgifs")
async def import_redgifs(bg_tasks: BackgroundTasks, data: RedGifsImportRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Search and import videos from RedGIFs based on keywords.
    """
    from .extractors.redgifs import RedGifsExtractor
    extractor = RedGifsExtractor()
    
    keywords_list = [k.strip() for k in data.keywords.split(',') if k.strip()]
    batch = data.batch_name or f"RedGIFs {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    
    total_found = 0
    all_results = []
    
    for kw in keywords_list:
        results = extractor.search(kw, count=data.count, hd_only=data.hd_only)
        for res in results:
            # Quick check if title/tags contain rejected words
            rejected = ["meme", "edit", "compilation", "remix", "gif", "loop"]
            title_low = res['title'].lower()
            tags_low = [t.lower() for t in res['tags']]
            if any(r in title_low for r in rejected) or any(any(r in t for r in rejected) for t in tags_low):
                continue
                
            # Check if exists
            existing = db.query(Video).filter(Video.source_url == res['page_url']).first()
            if existing: continue
            
            all_results.append(res)
            total_found += 1
            
    if all_results:
        # Move processing to background to allow metadata (FFprobe) checks if needed
        bg_tasks.add_task(process_batch_import_with_filters, all_results, batch, data.min_duration, data.min_resolution, data.only_vertical, data.disable_rejection)
        
    return {"count": total_found, "batch": batch, "message": f"Queued {total_found} candidates from RedGIFs"}

@api_v1_router.get("/redgifs/search")
@api_legacy_router.get("/redgifs/search")
async def search_redgifs(
    query: str = Query(..., min_length=1),
    count: int = Query(20, ge=1, le=50),
    page: int = Query(1, ge=1, le=10),
    hd_only: bool = False,
    auth: bool = Depends(check_auth),
):
    """
    Lightweight RedGIFs browser search for the dashboard.
    Pagination is emulated by fetching a larger recent window and slicing it.
    """
    from .extractors.redgifs import RedGifsExtractor

    extractor = RedGifsExtractor()
    page_items = extractor.search(query, count=count, hd_only=hd_only, page=page)
    normalized = []
    for item in page_items:
        normalized.append({
            "id": item.get("id") or hashlib.sha1(str(item.get("page_url") or item.get("video_url") or "").encode("utf-8", errors="ignore")).hexdigest()[:16],
            "title": item.get("title") or "RedGIFs item",
            "url": item.get("video_url"),
            "external_playback_url": item.get("video_url"),
            "thumbnail_path": item.get("thumbnail"),
            "source_url": item.get("page_url"),
            "page_url": item.get("page_url"),
            "source": "RedGIFs",
            "status": "ready_to_stream" if item.get("video_url") else "pending",
            "storage_type": "external_direct",
            "created_at": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat(),
            "duration": item.get("duration"),
            "width": item.get("width"),
            "height": item.get("height"),
            "tags": ",".join(item.get("tags") or []),
            "has_hd": bool(item.get("has_hd")),
        })

    return {
        "items": normalized,
        "page": page,
        "count": count,
        "has_more": len(page_items) >= count,
        "query": query,
    }

@api_v1_router.post("/import/redgifs-item")
@api_legacy_router.post("/import/redgifs-item")
async def import_redgifs_item(
    bg_tasks: BackgroundTasks,
    data: RedGifsSingleImportRequest,
    db: Session = Depends(get_db),
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
):
    """
    Queue a single RedGIFs result directly from the dashboard browse view.
    """
    ensure_bridge_token(x_nexus_token)
    from .extractors.redgifs import RedGifsExtractor

    existing = db.query(Video).filter(Video.source_url == data.page_url).first()
    if existing:
        return {"count": 0, "batch": existing.batch_name or "", "message": "Already imported"}

    page_url = str(data.page_url or "").strip()
    video_url = str(data.video_url or "").strip()
    title = data.title
    thumbnail = data.thumbnail
    tags = data.tags or []
    duration = data.duration
    width = data.width
    height = data.height

    if page_url and not video_url:
        extractor = RedGifsExtractor()
        gif_id_match = re.search(r"/watch/([^/?#]+)", page_url)
        gif_id = gif_id_match.group(1) if gif_id_match else ""
        details = extractor.get_gif_details(gif_id) if gif_id else None
        if details:
            video_url = details.get("video_url") or video_url
            title = details.get("title") or title
            thumbnail = details.get("thumbnail") or thumbnail
            tags = details.get("tags") or tags
            duration = details.get("duration") or duration
            width = details.get("width") or width
            height = details.get("height") or height

    if not video_url:
        raise HTTPException(status_code=400, detail="RedGIFs item is missing playable video URL")

    batch = data.batch_name or f"RedGIFs {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    payload = [{
        "title": title,
        "video_url": video_url,
        "thumbnail": thumbnail,
        "page_url": page_url,
        "tags": tags,
        "duration": duration,
        "width": width,
        "height": height,
    }]
    bg_tasks.add_task(process_batch_import_with_filters, payload, batch, 0, 0, False, True)
    return {"count": 1, "batch": batch, "message": "Queued RedGIFs item"}

@api_v1_router.post("/import/redgifs-bulk")
@api_legacy_router.post("/import/redgifs-bulk")
async def import_redgifs_bulk(
    bg_tasks: BackgroundTasks,
    data: RedGifsBulkImportRequest,
    db: Session = Depends(get_db),
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
):
    """
    Queue multiple RedGIFs items from browser extension/userscript in one batch.
    """
    ensure_bridge_token(x_nexus_token)
    from .extractors.redgifs import RedGifsExtractor

    batch = data.batch_name or f"RedGIFs {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    payload = []
    extractor = RedGifsExtractor()

    for item in data.items or []:
        page_url = str(item.page_url or "").strip()
        video_url = str(item.video_url or "").strip()
        title = item.title
        thumbnail = item.thumbnail
        tags = item.tags or []
        duration = item.duration
        width = item.width
        height = item.height

        if not page_url:
            continue

        existing = db.query(Video).filter(Video.source_url == page_url).first()
        if existing:
            continue

        if not video_url:
            gif_id_match = re.search(r"/watch/([^/?#]+)", page_url)
            gif_id = gif_id_match.group(1) if gif_id_match else ""
            details = extractor.get_gif_details(gif_id) if gif_id else None
            if details:
                video_url = details.get("video_url") or video_url
                title = details.get("title") or title
                thumbnail = details.get("thumbnail") or thumbnail
                tags = details.get("tags") or tags
                duration = details.get("duration") or duration
                width = details.get("width") or width
                height = details.get("height") or height

        if not video_url:
            continue

        payload.append({
            "title": title,
            "video_url": video_url,
            "thumbnail": thumbnail,
            "page_url": page_url,
            "tags": tags,
            "duration": duration,
            "width": width,
            "height": height,
        })

    if payload:
        bg_tasks.add_task(process_batch_import_with_filters, payload, batch, 0, 0, False, True)
    return {"count": len(payload), "batch": batch, "message": f"Queued {len(payload)} RedGIFs items"}

@api_v1_router.post("/import/reddit")
@api_legacy_router.post("/import/reddit")
async def import_reddit(bg_tasks: BackgroundTasks, data: RedditImportRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Search and import videos from Reddit subreddits.
    """
    from .extractors.reddit import RedditExtractor
    extractor = RedditExtractor()
    
    subs_list = [s.strip() for s in data.subreddits.split(',') if s.strip()]
    batch = data.batch_name or f"Reddit {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    
    total_found = 0
    all_results = []
    
    for s in subs_list:
        candidates = extractor.search_subreddit(s, limit=data.count)
        for c in candidates:
            # Check if exists
            existing = db.query(Video).filter(Video.source_url == c['permalink']).first()
            if existing: continue
            
            all_results.append({
                "title": c['title'],
                "page_url": c['permalink'],
                "reddit_url": c['url'], # v.redd.it url
                "tags": [s] # subreddit as tag
            })
            total_found += 1
            
    if all_results:
        bg_tasks.add_task(process_batch_import_with_filters, all_results, batch, data.min_duration, data.min_resolution, data.only_vertical, data.disable_rejection, is_reddit=True)
        
    return {"count": total_found, "batch": batch, "message": f"Queued {total_found} candidates from Reddit"}

@api_v1_router.post("/import/pornone")
@api_legacy_router.post("/import/pornone")
async def import_pornone(bg_tasks: BackgroundTasks, data: PornOneImportRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Search and import videos from PornOne based on keywords.
    """
    from .extractors.pornone import PornOneExtractor
    extractor = PornOneExtractor()
    
    keywords_list = [k.strip() for k in data.keywords.split(',') if k.strip()]
    batch = data.batch_name or f"PornOne {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    
    total_found = 0
    all_results = []
    
    for kw in keywords_list:
        results = extractor.search(kw, count=data.count)
        for res in results:
            # Check if exists
            existing = db.query(Video).filter(Video.source_url == res['page_url']).first()
            if existing: continue
            
            all_results.append(res)
            total_found += 1
            
    if all_results:
        bg_tasks.add_task(process_batch_import_with_filters, all_results, batch, data.min_duration, data.min_resolution, data.only_vertical, is_pornone=True, debug=data.debug)
        
    return {"count": total_found, "batch": batch, "message": f"Queued {total_found} candidates from PornOne"}

@api_v1_router.post("/import/tnaflix")
@api_legacy_router.post("/import/tnaflix")
async def import_tnaflix(bg_tasks: BackgroundTasks, data: TnaflixImportRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Import videos from Tnaflix profile or video URL.
    """
    from .extractors.tnaflix import TnaflixExtractor
    extractor = TnaflixExtractor()
    
    batch = data.batch_name or f"Tnaflix {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    all_results = []
    
    if data.url:
        if "/profile/" in data.url or "/user/" in data.url:
            # Profile import
            results = await asyncio.to_thread(extractor.extract_from_profile, data.url, max_results=data.count)
            all_results.extend([{
                "title": r['title'],
                "page_url": r.get('source_url') or data.url, # Fallback
                "video_url": r['stream_url'],
                "thumbnail": r['thumbnail'],
                "duration": r['duration'],
                "tags": r['tags'].split(',') if r['tags'] else []
            } for r in results])
        else:
            # Single video import
            meta = await asyncio.to_thread(extractor.extract, data.url)
            if meta and meta.get('stream_url'):
                all_results.append({
                    "title": meta['title'],
                    "page_url": data.url,
                    "video_url": meta['stream_url'],
                    "thumbnail": meta['thumbnail'],
                    "duration": meta['duration'],
                    "tags": meta['tags'].split(',') if meta['tags'] else []
                })
    
    total_found = len(all_results)
    if all_results:
        # Tnaflix extractor doesn't provide resolution, process_batch_import_with_filters will use ffprobe
        # We pass only_vertical=False as it's not requested for Tnaflix specifically in the prompt, but filters are applied.
        bg_tasks.add_task(process_batch_import_with_filters, all_results, batch, data.min_duration, data.min_quality, False)
        
    return {"count": total_found, "batch": batch, "message": f"Queued {total_found} videos from Tnaflix"}

@api_v1_router.post("/import/xvideos_playlist")
@api_legacy_router.post("/import/xvideos_playlist")
async def import_xvideos_playlist(bg_tasks: BackgroundTasks, data: XVideosPlaylistImportRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """
    Import up to 500 videos from an XVideos playlist/favorite URL.
    """
    from .services import extract_playlist_urls
    
    batch = data.batch_name or f"XVideos PL {datetime.datetime.now().strftime('%d.%m %H:%M')}"
    
    # Delegate extraction to background process for immediate return and robustness
    # But for better UX, we can do a quick check here if it's truly a playlist
    if "xvideos.com" not in data.url:
         return JSONResponse(status_code=400, content={"error": "INVALID_URL", "message": "Only XVideos URLs are supported."})
         
    bg_tasks.add_task(background_import_process, [data.url], batch, "yt-dlp", None, None, None, True)
    
    return {"status": "queued", "batch": batch, "message": "XVideos playlist expansion started in background."}




@api_v1_router.get("/import/camwhores/network-status")
async def camwhores_network_status(auth: bool = Depends(check_auth)):
    """Read the local client status; never change network configuration."""
    def read_warp():
        executable = Path(os.environ.get("ProgramFiles", "")) / "Cloudflare" / "Cloudflare WARP" / "warp-cli.exe"
        if os.name != "nt" or not executable.is_file():
            return {"status": "unknown", "message": "WARP klient nie je dostupný"}
        try:
            proc = subprocess.run([str(executable), "-j", "status"], capture_output=True,
                                  text=True, timeout=4, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if proc.returncode:
                raise ValueError("status unavailable")
            raw = json.loads(proc.stdout)
            state = str(raw.get("status", "")).lower()
            return {"status": state if state in {"connected", "disconnected"} else "unknown"}
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return {"status": "unknown", "message": "Stav WARP sa nepodarilo overiť"}
    return await asyncio.to_thread(read_warp)


@api_v1_router.post("/import/camwhores_discovery/stream")
async def camwhores_discovery_stream(data: CamwhoresDiscoveryRequest, auth: bool = Depends(check_auth)):
    async def events():
        report = {}
        try:
            cards = await asyncio.to_thread(
                scrape_camwhores_discovery,
                keyword=data.keyword,
                search_mode=data.search_mode,
                pages=data.pages,
                sort_by=data.sort_by,
                only_public=data.only_public,
                listing_only=True,
                report=report,
            )
        except Exception as exc:
            logging.warning("[CAMWHORES_DISCOVERY] Listing failed: %s", exc)
            yield json.dumps({"type": "error", "message": str(exc), "code": getattr(exc, "code", "source_error")}) + "\n"
            return

        yield json.dumps({"type": "listing", "results": cards, "report": report}) + "\n"
        if not cards:
            return

        # Only two watch pages are fetched at once. A slow detail cannot hold
        # back the already delivered search cards or the other detail updates.
        gate = asyncio.Semaphore(2)

        async def enrich(card):
            async with gate:
                try:
                    return card["url"], await asyncio.to_thread(enrich_camwhores_discovery_item, card)
                except Exception as exc:
                    logging.warning("[CAMWHORES_DISCOVERY] Detail failed for %s: %s", card["url"], exc)
                    return card["url"], None

        tasks = [asyncio.create_task(enrich(card)) for card in cards]
        try:
            for completed in asyncio.as_completed(tasks):
                url, detail = await completed
                yield json.dumps({"type": "detail", "url": url, "video": detail}) + "\n"
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()

    return StreamingResponse(events(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                                      "Content-Encoding": "identity"})


@api_v1_router.post("/import/camwhores_discovery")
@api_legacy_router.post("/import/camwhores_discovery")
async def camwhores_discovery(data: CamwhoresDiscoveryRequest, auth: bool = Depends(check_auth)):
    try:
        results = await asyncio.to_thread(
            scrape_camwhores_discovery,
            keyword=data.keyword,
            search_mode=data.search_mode,
            min_quality=data.min_quality,
            min_duration=data.min_duration,
            max_duration=data.max_duration,
            search_terms=data.search_terms,
            pages=data.pages,
            sort_by=data.sort_by,
            only_public=data.only_public,
            auto_skip_low_quality=data.auto_skip_low_quality
        )
        
        return {
            "status": "success",
            "results": results,
            "total": len(results),
            "matched": sum(1 for v in results if v.get('matched', False)),
            "keyword": data.keyword,
            "min_quality": data.min_quality,
            "min_duration": data.min_duration,
            "max_duration": data.max_duration,
            "search_terms": data.search_terms
        }
    except Exception as e:
        logging.error(f"[CAMWHORES_DISCOVERY] Endpoint error: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )

@api_v1_router.post("/import/camwhores_discovery/import")
@api_legacy_router.post("/import/camwhores_discovery/import")
async def camwhores_discovery_import(
    bg_tasks: BackgroundTasks,
    selected_urls: List[str] = Body(...),
    batch_name: Optional[str] = Body(None),
    items: Optional[List[dict]] = Body(None),
    standalone: bool = Body(False),
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    if not selected_urls:
        raise HTTPException(status_code=400, detail="No URLs provided")
        
    batch = None if standalone else (batch_name or f"Camwhores_Discovery_{datetime.datetime.now().strftime('%Y%m%d_%H%M')}")
    
    bg_tasks.add_task(background_import_process, selected_urls, batch, "camwhores", items, None, None, True)

    return {"status": "queued", "batch": batch, "message": f"{len(selected_urls)} Camwhores videos queued for import."}

@api_v1_router.post("/import/camwhores_discovery/import-standalone")
async def camwhores_discovery_import_standalone(
    bg_tasks: BackgroundTasks,
    selected_urls: List[str] = Body(...),
    items: Optional[List[dict]] = Body(None),
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    return await camwhores_discovery_import(
        bg_tasks, selected_urls, None, items, True, db, auth,
    )

# ─── Camwhores Hub (categories / models browse) ──────────────────────────────

@api_v1_router.post("/import/camwhores/hub/categories")
@api_legacy_router.post("/import/camwhores/hub/categories")
async def camwhores_hub_categories(data: CamwhoresHubLandingRequest, auth: bool = Depends(check_auth)):
    """Hub landing: browse CamWhores categories as cards."""
    try:
        results = await asyncio.to_thread(
            scrape_camwhores_categories,
            sort_by=data.sort_by,
            pages=data.pages,
            max_results=data.max_results,
        )
        return {"status": "success", "kind": "categories", "total": len(results), "results": results}
    except Exception as e:
        logging.error(f"[CW_HUB] categories endpoint error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@api_v1_router.post("/import/camwhores/hub/models")
@api_legacy_router.post("/import/camwhores/hub/models")
async def camwhores_hub_models(data: CamwhoresHubLandingRequest, auth: bool = Depends(check_auth)):
    """Hub landing: browse CamWhores models as cards (optional keyword name filter)."""
    try:
        results = await asyncio.to_thread(
            scrape_camwhores_models,
            sort_by=data.sort_by,
            pages=data.pages,
            max_results=data.max_results,
            keyword=data.keyword,
        )
        return {"status": "success", "kind": "models", "total": len(results),
                "keyword": data.keyword, "results": results}
    except Exception as e:
        logging.error(f"[CW_HUB] models endpoint error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@api_v1_router.post("/import/camwhores/hub/videos")
@api_legacy_router.post("/import/camwhores/hub/videos")
async def camwhores_hub_videos(data: CamwhoresHubVideosRequest, auth: bool = Depends(check_auth)):
    """
    Fetch videos from a CamWhores category or model URL as a Hub browse.
    deep=False returns fast listing rows for instant scrolling; deep=True runs
    the full detail crawl + size probe. Import the selected results via the
    existing /import/camwhores_discovery/import endpoint.
    """
    try:
        results = await asyncio.to_thread(
            scrape_camwhores_hub_videos,
            hub_url=data.hub_url,
            sort_by=data.sort_by,
            min_quality=data.min_quality,
            min_duration=data.min_duration,
            max_duration=data.max_duration,
            pages=data.pages,
            only_public=data.only_public,
            auto_skip_low_quality=data.auto_skip_low_quality,
            deep=data.deep,
        )
        return {"status": "success", "hub_url": data.hub_url, "deep": data.deep,
                "total": len(results), "results": results}
    except Exception as e:
        logging.error(f"[CW_HUB] videos endpoint error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@api_v1_router.post("/import/camwhores/hub/member")
@api_legacy_router.post("/import/camwhores/hub/member")
async def camwhores_hub_member(data: CamwhoresMemberRequest, auth: bool = Depends(check_auth)):
    """
    Member (uploader/curator) summary: name, avatar, posted/favourite counts,
    public/private split, and playlists. One member = 3 content sources —
    drill into posted or favourites via /hub/member/videos, playlists via the
    existing camwhores_playlists endpoints.
    """
    try:
        profile = await asyncio.to_thread(scrape_camwhores_member_profile, data.member_url)
        if not profile:
            return JSONResponse(status_code=404, content={"status": "error", "message": "Member not found or unreadable"})
        return {"status": "success", "profile": profile}
    except Exception as e:
        logging.error(f"[CW_MEMBER] member endpoint error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@api_v1_router.post("/import/camwhores/hub/member/videos")
@api_legacy_router.post("/import/camwhores/hub/member/videos")
async def camwhores_hub_member_videos(data: CamwhoresMemberVideosRequest, auth: bool = Depends(check_auth)):
    """
    List a member's POSTED or FAVOURITE videos (kind=posted|favourites).
    deep=False = fast listing rows; deep=True = detail crawl + size probe.
    Import selected results via /import/camwhores_discovery/import.
    """
    try:
        results = await asyncio.to_thread(
            scrape_camwhores_member_videos,
            member_url=data.member_url,
            kind=data.kind,
            pages=data.pages,
            only_public=data.only_public,
            deep=data.deep,
            min_quality=data.min_quality,
            min_duration=data.min_duration,
            max_duration=data.max_duration,
            auto_skip_low_quality=data.auto_skip_low_quality,
        )
        return {"status": "success", "member_url": data.member_url, "kind": data.kind,
                "deep": data.deep, "total": len(results), "results": results}
    except Exception as e:
        logging.error(f"[CW_MEMBER] member videos endpoint error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

# ─── Camwhores Playlist Discovery ────────────────────────────────────────────

@api_v1_router.post("/import/camwhores_playlists/search")
@api_legacy_router.post("/import/camwhores_playlists/search")
async def camwhores_playlists_search(data: CamwhoresPlaylistSearchRequest, auth: bool = Depends(check_auth)):
    """
    Search / browse Camwhores playlists by keyword and sort order.
    Returns playlist cards with thumbnail, video count, rating, views and age.
    """
    try:
        report = {}
        results = await asyncio.to_thread(
            scrape_camwhores_playlists,
            keyword=data.keyword,
            sort_by=data.sort_by,
            pages=data.pages,
            max_results=data.max_results,
            report=report,
        )
        return {
            "status": "success",
            "total": len(results),
            "keyword": data.keyword,
            "sort_by": data.sort_by,
            "playlists": results,
            "report": report,
        }
    except CamwhoresSourceError as e:
        return JSONResponse(status_code=502, content={"status": "error", "code": e.code, "message": str(e)})
    except Exception as e:
        logging.error(f"[CW_PLAYLISTS_SEARCH] Error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


def save_playlist_fetch_to_history(playlist_urls: list, result_data: dict):
    import hashlib
    import json
    import os
    import datetime
    import logging

    try:
        history_dir = playlist_history_dir()
        os.makedirs(history_dir, exist_ok=True)
        
        # Unikátny hash pre sadu URL adries
        urls_key = ",".join(sorted(playlist_urls))
        playlist_hash = hashlib.md5(urls_key.encode("utf-8")).hexdigest()
        
        # Zistíme názov pre zobrazenie v histórii
        title = "Agregovaný import"
        if len(playlist_urls) == 1:
            if result_data.get("mode") == "single":
                title = result_data.get("playlist", {}).get("playlist_title") or playlist_urls[0]
            else:
                title = playlist_urls[0]
        else:
            titles = []
            if "playlists" in result_data:
                for pl in result_data["playlists"]:
                    t = pl.get("playlist_title")
                    if t: titles.append(t)
            if titles:
                title = ", ".join(titles[:2])
                if len(titles) > 2:
                    title += f" a {len(titles) - 2} ďalšie"
            else:
                title = f"Skupina {len(playlist_urls)} playlistov"
                
        # Zistíme počet videí
        video_count = 0
        if result_data.get("mode") == "single":
            video_count = result_data.get("total_public", 0)
        else:
            video_count = result_data.get("total_fetched", 0)
            
        timestamp = datetime.datetime.now().isoformat()
        detail_path = os.path.join(history_dir, f"fetch_{playlist_hash}.json")
        
        # Zlúčenie (merge) videí pre single playlist, aby sme mali celú stiahnutú sadu pri paginácii
        final_result_data = dict(result_data)
        if result_data.get("mode") == "single" and os.path.exists(detail_path):
            try:
                with open(detail_path, "r", encoding="utf-8") as f:
                    old_data = json.load(f)
                    existing_videos = old_data.get("data", {}).get("playlist", {}).get("videos", [])
                
                new_videos = result_data.get("playlist", {}).get("videos", [])
                merged_videos_map = {v["url"]: v for v in existing_videos}
                for v in new_videos:
                    merged_videos_map[v["url"]] = v
                
                merged_videos = list(merged_videos_map.values())
                
                # Aktualizujeme playlist videos
                final_playlist = dict(result_data.get("playlist", {}))
                final_playlist["videos"] = merged_videos
                final_result_data["playlist"] = final_playlist
                final_result_data["total_public"] = len(merged_videos)
                final_result_data["video_urls"] = list(merged_videos_map.keys())
                video_count = len(merged_videos)
            except Exception as e:
                logging.error(f"[CW_PLAYLISTS_HISTORY_MERGE] Merge failed: {e}")
        
        # Zápis detailného súboru
        with open(detail_path, "w", encoding="utf-8") as f:
            json.dump({
                "id": playlist_hash,
                "title": title,
                "playlist_urls": playlist_urls,
                "video_count": video_count,
                "timestamp": timestamp,
                "data": final_result_data
            }, f, indent=2, ensure_ascii=False)
            
        # Aktualizácia indexu
        index_path = os.path.join(history_dir, "index.json")
        index_data = []
        if os.path.exists(index_path):
            try:
                with open(index_path, "r", encoding="utf-8") as f:
                    index_data = json.load(f)
            except Exception:
                index_data = []
                
        index_data = [item for item in index_data if item.get("id") != playlist_hash]
        index_data.insert(0, {
            "id": playlist_hash,
            "title": title,
            "playlist_urls": playlist_urls,
            "video_count": video_count,
            "timestamp": timestamp
        })
        
        with open(index_path, "w", encoding="utf-8") as f:
            json.dump(index_data[:100], f, indent=2, ensure_ascii=False)
            
    except Exception as e:
        logging.error(f"[CW_PLAYLISTS_SAVE_HISTORY] Error: {e}")


@api_v1_router.post("/import/camwhores_playlists/fetch")
@api_legacy_router.post("/import/camwhores_playlists/fetch")
async def camwhores_playlists_fetch(data: CamwhoresPlaylistFetchRequest, auth: bool = Depends(check_auth)):
    """
    Fetch videos from one or more Camwhores playlists.

    Returns per-playlist breakdown (public_count, private_count, public_ratio)
    plus a windowed batch of video URLs (batch_offset … batch_offset + batch_size).
    Designed for gallery pagination: call repeatedly with increasing batch_offset.
    """
    if not data.playlist_urls:
        raise HTTPException(status_code=400, detail="playlist_urls must not be empty")
    try:
        if len(data.playlist_urls) == 1:
            # Single playlist — use direct fetcher so has_more works correctly
            result = await asyncio.to_thread(
                fetch_playlist_videos,
                data.playlist_urls[0],
                data.only_public,
                data.batch_size,
                data.batch_offset,
            )
            resp = {
                "status": "success",
                "mode": "single",
                "playlist": result,
                "total_public": result.get("public_count", 0),
                "total_private": result.get("private_count", 0),
                "has_more": result.get("has_more", False),
                "video_urls": [v["url"] for v in result.get("videos", [])],
                "videos": result.get("videos", []),
            }
            save_playlist_fetch_to_history(data.playlist_urls, resp)
            return resp
        else:
            # Multiple playlists — concurrent fetch
            result = await asyncio.to_thread(
                fetch_multiple_playlists,
                data.playlist_urls,
                data.only_public,
                data.batch_size,
                data.batch_offset,
            )
            resp = {
                "status": "success",
                "mode": "multi",
                "has_more": result.get("has_more", False),
                **result,
            }
            save_playlist_fetch_to_history(data.playlist_urls, resp)
            return resp
    except Exception as e:
        logging.error(f"[CW_PLAYLISTS_FETCH] Error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@api_v1_router.get("/import/camwhores_playlists/history")
@api_legacy_router.get("/import/camwhores_playlists/history")
async def camwhores_playlists_history_list(auth: bool = Depends(check_auth)):
    import json
    import os
    try:
        history_dir = playlist_history_dir()
        index_path = os.path.join(history_dir, "index.json")
        if not os.path.exists(index_path):
            return []
        with open(index_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logging.error(f"[CW_PLAYLISTS_HISTORY_LIST] Error: {e}")
        return []


@api_v1_router.get("/import/camwhores_playlists/history/{fetch_id}")
@api_legacy_router.get("/import/camwhores_playlists/history/{fetch_id}")
async def camwhores_playlists_history_get(fetch_id: str, auth: bool = Depends(check_auth)):
    import json
    import os
    try:
        history_dir = playlist_history_dir()
        detail_path = os.path.join(history_dir, f"fetch_{fetch_id}.json")
        if not os.path.exists(detail_path):
            raise HTTPException(status_code=404, detail="História pre tento playlist nebola nájdená")
        with open(detail_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[CW_PLAYLISTS_HISTORY_GET] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_v1_router.delete("/import/camwhores_playlists/history/{fetch_id}")
@api_legacy_router.delete("/import/camwhores_playlists/history/{fetch_id}")
async def camwhores_playlists_history_delete(fetch_id: str, auth: bool = Depends(check_auth)):
    import json
    import os
    try:
        history_dir = playlist_history_dir()
        detail_path = os.path.join(history_dir, f"fetch_{fetch_id}.json")
        if os.path.exists(detail_path):
            os.remove(detail_path)
            
        index_path = os.path.join(history_dir, "index.json")
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as f:
                index_data = json.load(f)
            index_data = [item for item in index_data if item.get("id") != fetch_id]
            with open(index_path, "w", encoding="utf-8") as f:
                json.dump(index_data, f, indent=2, ensure_ascii=False)
                
        return {"status": "success", "message": "Záznam histórie bol vymazaný"}
    except Exception as e:
        logging.error(f"[CW_PLAYLISTS_HISTORY_DELETE] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_v1_router.post("/import/camwhores_playlists/history/update_cards")
@api_legacy_router.post("/import/camwhores_playlists/history/update_cards")
async def camwhores_playlists_history_update_cards(data: CamwhoresPlaylistUpdateCardsRequest, auth: bool = Depends(check_auth)):
    import json
    import os
    import hashlib
    try:
        history_dir = playlist_history_dir()
        os.makedirs(history_dir, exist_ok=True)
        target_id = data.fetch_id
        if not target_id and data.playlist_urls:
            urls_key = ",".join(sorted(data.playlist_urls))
            target_id = hashlib.md5(urls_key.encode("utf-8")).hexdigest()

        if not target_id:
            raise HTTPException(status_code=400, detail="fetch_id alebo playlist_urls musia byť zadané")

        detail_path = os.path.join(history_dir, f"fetch_{target_id}.json")
        if not os.path.exists(detail_path):
            return {"status": "skipped", "message": "Záznam histórie neexistuje, karty neboli aktualizované"}

        with open(detail_path, "r", encoding="utf-8") as f:
            record = json.load(f)

        data_block = record.get("data", {})
        cards_map = {c["url"]: c for c in data.cards if c.get("url")}

        if data_block.get("mode") == "single":
            videos = data_block.get("playlist", {}).get("videos", [])
            for v in videos:
                if v.get("url") in cards_map:
                    v.update(cards_map[v["url"]])
            if "videos" in data_block:
                for v in data_block["videos"]:
                    if v.get("url") in cards_map:
                        v.update(cards_map[v["url"]])
        else:
            if "videos" in data_block:
                for v in data_block["videos"]:
                    if v.get("url") in cards_map:
                        v.update(cards_map[v["url"]])
            for pl in data_block.get("playlists", []):
                for v in pl.get("videos", []):
                    if v.get("url") in cards_map:
                        v.update(cards_map[v["url"]])

        with open(detail_path, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, ensure_ascii=False)

        return {"status": "success", "updated_count": len(cards_map), "fetch_id": target_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[CW_PLAYLISTS_HISTORY_UPDATE_CARDS] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_v1_router.post("/import/camwhores_playlists/enrich_cards/stream")
async def camwhores_playlists_enrich_cards_stream(data: CamwhoresCardsEnrichRequest, auth: bool = Depends(check_auth)):
    """High-speed async streaming metadata enrichment with persistent HTTP connection pool (14 parallel workers)."""
    cards = data.cards or []
    if not cards and data.urls:
        cards = [{"url": u, "source_url": u} for u in data.urls]

    async def events():
        if not cards:
            yield json.dumps({"type": "done", "total": 0}) + "\n"
            return

        limits = httpx.Limits(max_connections=40, max_keepalive_connections=25)
        timeout = httpx.Timeout(connect=3.0, read=4.5, write=3.0, pool=5.0)
        from curl_cffi.requests import AsyncSession
        gate = asyncio.Semaphore(14)
        external_gate = asyncio.Semaphore(5)

        async with AsyncSession(impersonate="chrome124", timeout=10, verify=False, max_clients=16) as watch_client, \
                   httpx.AsyncClient(verify=False, timeout=timeout, limits=limits) as client:
            async def worker(card):
                async with gate:
                    url = card.get("url") or card.get("source_url")
                    try:
                        detail = await async_extract_detail_metadata(url, client, fallback_item=card,
                                                                     watch_client=watch_client,
                                                                     external_gate=external_gate)
                        if detail:
                            if card.get("playlist_title") and not detail.get("playlist_title"):
                                detail["playlist_title"] = card["playlist_title"]
                            if card.get("playlist_url") and not detail.get("playlist_url"):
                                detail["playlist_url"] = card["playlist_url"]
                            detail["enriched"] = bool(detail.get("enriched"))
                            return url, detail
                    except Exception as exc:
                        logging.warning("[CW_FAST_ENRICH] Error for %s: %s", url, exc)
                        await asyncio.sleep(0.15)

                    fallback = dict(card)
                    fallback["enriched"] = False
                    return url, fallback

            tasks = [asyncio.create_task(worker(c)) for c in cards]
            try:
                for completed in asyncio.as_completed(tasks):
                    url, detail = await completed
                    yield json.dumps({"type": "detail", "url": url, "video": detail}) + "\n"
            finally:
                for t in tasks:
                    if not t.done():
                        t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        yield json.dumps({"type": "done", "total": len(cards)}) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                                      "Content-Encoding": "identity"})


@api_v1_router.post("/import/camwhores_playlists/enrich_cards")
@api_legacy_router.post("/import/camwhores_playlists/enrich_cards")
async def camwhores_playlists_enrich_cards(data: CamwhoresCardsEnrichRequest, auth: bool = Depends(check_auth)):
    """High-speed batch enrich of Camwhores video cards using async connection pool."""
    cards = data.cards or []
    if not cards and data.urls:
        cards = [{"url": u, "source_url": u} for u in data.urls]
    if not cards:
        return {"status": "success", "results": [], "total": 0}

    limits = httpx.Limits(max_connections=40, max_keepalive_connections=25)
    timeout = httpx.Timeout(connect=3.0, read=4.5, write=3.0, pool=5.0)
    from curl_cffi.requests import AsyncSession
    gate = asyncio.Semaphore(14)
    external_gate = asyncio.Semaphore(5)

    async with AsyncSession(impersonate="chrome124", timeout=10, verify=False, max_clients=16) as watch_client, \
               httpx.AsyncClient(verify=False, timeout=timeout, limits=limits) as client:
        async def worker(card):
            async with gate:
                url = card.get("url") or card.get("source_url")
                try:
                    detail = await async_extract_detail_metadata(url, client, fallback_item=card,
                                                                 watch_client=watch_client,
                                                                 external_gate=external_gate)
                    if detail:
                        if card.get("playlist_title") and not detail.get("playlist_title"):
                            detail["playlist_title"] = card["playlist_title"]
                        if card.get("playlist_url") and not detail.get("playlist_url"):
                            detail["playlist_url"] = card["playlist_url"]
                        detail["enriched"] = bool(detail.get("enriched"))
                        return detail
                except Exception as e:
                    logging.warning("[CW_FAST_ENRICH] Error for %s: %s", url, e)
                    await asyncio.sleep(0.15)
                fallback = dict(card)
                fallback["enriched"] = False
                return fallback

        results = await asyncio.gather(*[worker(c) for c in cards])
        return {"status": "success", "results": results, "total": len(results)}


class CamwhoresResolveRequest(BaseModel):
    url: str

@api_v1_router.post("/import/camwhores_playlists/resolve")
@api_legacy_router.post("/import/camwhores_playlists/resolve")
async def camwhores_playlists_resolve(data: CamwhoresResolveRequest, auth: bool = Depends(check_auth)):
    if not data.url:
        raise HTTPException(status_code=400, detail="url must not be empty")
    # The synchronous scraper is blocked by the watch-page challenge and returns
    # no stream. Playlist playback uses the same browser-impersonation path that
    # already fills card metadata.
    limits = httpx.Limits(max_connections=8, max_keepalive_connections=4)
    timeout = httpx.Timeout(connect=4.0, read=12.0, write=4.0, pool=5.0)
    try:
        from curl_cffi.requests import AsyncSession
        async with AsyncSession(impersonate="chrome124", timeout=12, verify=False) as watch_client, \
                   httpx.AsyncClient(verify=False, timeout=timeout, limits=limits) as client:
            result = await async_extract_detail_metadata(
                data.url, client, watch_client=watch_client,
            )
        if result and result.get("stream_url"):
            return {
                "status": "success",
                "stream_url": result["stream_url"],
                "video": result
            }
        return JSONResponse(status_code=404, content={"status": "error", "message": "Failed to resolve stream URL"})
    except Exception as e:
        logging.error(f"[CW_PLAYLISTS_RESOLVE] Error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

@api_v1_router.post("/import/eporner_discovery")
@api_legacy_router.post("/import/eporner_discovery")
async def eporner_discovery(data: EpornerDiscoveryRequest, auth: bool = Depends(check_auth)):
    """
    Eporner Smart Discovery - Scrapes tag pages directly via HTML parsing.
    Returns preview results for user to select before importing.
    """
    try:
        # Run scraper in thread pool to avoid blocking
        results = await asyncio.to_thread(
            scrape_eporner_discovery,
            keyword=data.keyword,
            min_quality=data.min_quality or 0,
            min_duration=data.min_duration or 0,
            max_duration=data.max_duration or 0,
            search_terms=data.search_terms,
            pages=data.pages,
            auto_skip_low_quality=data.auto_skip_low_quality
        )
        
        return {
            "status": "success",
            "results": results,
            "total": len(results),
            "matched": sum(1 for v in results if v.get('matched', False)),
            "keyword": data.keyword,
            "min_quality": data.min_quality,
            "min_duration": data.min_duration,
            "max_duration": data.max_duration,
            "search_terms": data.search_terms
        }
    except Exception as e:
        logging.error(f"[EPORNER_DISCOVERY] Endpoint error: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )

@api_v1_router.post("/import/eporner_discovery/import")
@api_legacy_router.post("/import/eporner_discovery/import")
async def eporner_discovery_import(
    req: dict = Body(...),
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Import selected Eporner Discovery videos as ready_to_stream.

    Stores the watch-page URL in both url and source_url. Stream resolution
    happens in the browser via the extension (BROWSER_REFRESH_STREAM), which
    runs on the client where VPN/cookies are available. No VIPVideoProcessor
    needed — Eporner is IP-banned on the backend.
    """
    try:
        selected_urls = req.get("selected_urls", [])
        batch_name = req.get("batch_name") or f"Eporner Discovery {datetime.datetime.now().strftime('%d.%m %H:%M')}"
        meta_map = {item["url"]: item for item in req.get("results", []) if item.get("url")}
        new_ids = []

        for url in selected_urls:
            if not url or not url.startswith("http"):
                continue
            existing = db.query(Video).filter(
                (Video.url == url) | (Video.source_url == url)
            ).first()
            if existing:
                continue
            m = meta_map.get(url, {})
            video = Video(
                title=m.get("title") or "Eporner Video",
                url=url,
                source_url=url,
                thumbnail_path=m.get("thumbnail") or None,
                duration=int(m.get("duration") or 0) or None,
                batch_name=batch_name,
                storage_type="remote",
                status="ready_to_stream",
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None),
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)

        db.commit()
        logging.info(f"[EPORNER_DISCOVERY_IMPORT] Imported {len(new_ids)} videos as ready_to_stream")
        return {"status": "success", "count": len(new_ids), "batch": batch_name}
    except Exception as e:
        logging.error(f"[EPORNER_DISCOVERY_IMPORT] Error: {e}")
        db.rollback()
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


class EpornerSearchApiRequest(BaseModel):
    query: str = ""
    category: str = ""
    page: int = 1
    per_page: int = 24
    order: str = "top_rated"
    gay: bool = False


@api_v1_router.post("/eporner/search")
@api_legacy_router.post("/eporner/search")
async def eporner_search_api(data: EpornerSearchApiRequest, auth: bool = Depends(check_auth)):
    """EPorner search/browse using eporner-api library."""
    try:
        from eporner_api import Client, Order, Gay, LowQuality, Category
        client = Client()
        order_map = {
            "latest": Order.latest,
            "longest": Order.longest,
            "shortest": Order.shortest,
            "top_rated": Order.top_rated,
            "most_popular": Order.most_popular,
            "top_weekly": Order.top_weekly,
            "top_monthly": Order.top_monthly,
        }
        order = order_map.get(data.order, Order.top_rated)
        gay_filter = Gay.include_gay_content if data.gay else Gay.exclude_gay_content

        results = []

        if data.category and data.category != "ALL" and not data.query:
            cat = getattr(Category, data.category, None)
            if cat:
                async for v in client.get_videos_by_category(cat, enable_html_scraping=False):
                    results.append({
                        "title": v.title, "url": v.url, "video_id": v.video_id,
                        "thumbnail": v.thumbnail, "duration": int(v.length or 0),
                        "duration_str": v.length_minutes, "views": int(v.views or 0),
                        "rate": float(v.rate or 0), "publish_date": str(v.publish_date or ""),
                    })
                    if len(results) >= data.per_page:
                        break
        else:
            q = data.query or data.category or "hd"
            async for v in client.search_videos(
                query=q, page=data.page, per_page=data.per_page,
                sorting_order=order, sorting_gay=gay_filter,
                sorting_low_quality=LowQuality.exclude_low_quality_content,
                enable_html_scraping=False,
            ):
                results.append({
                    "title": v.title, "url": v.url, "video_id": v.video_id,
                    "thumbnail": v.thumbnail, "duration": int(v.length or 0),
                    "duration_str": v.length_minutes, "views": int(v.views or 0),
                    "rate": float(v.rate or 0), "publish_date": str(v.publish_date or ""),
                })

        return {"results": results, "count": len(results)}
    except Exception as e:
        logging.error("[EPORNER_SEARCH_API] %s", e)
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@api_v1_router.post("/import/porntrex_discovery")
@api_legacy_router.post("/import/porntrex_discovery")
async def porntrex_discovery(data: PorntrexDiscoveryRequest, auth: bool = Depends(check_auth)):
    """
    Porntrex Smart Discovery - Scrapes search/category pages with concurrent video fetching.
    Returns preview results for user to select before importing.
    """
    try:
        # Validate input
        if not data.keyword and not data.category and not data.source_url:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "Keyword, category or PornTrex URL is required"}
            )

        # Run scraper in thread pool to avoid blocking
        results = await asyncio.to_thread(
            scrape_porntrex_discovery,
            keyword=data.keyword,
            min_quality=data.min_quality,
            pages=data.pages,
            category=data.category,
            source_url=data.source_url,
            upload_type=data.upload_type,
            auto_skip_low_quality=data.auto_skip_low_quality
        )

        return {
            "status": "success",
            "results": results,
            "total": len(results),
            "matched": len(results),
            "keyword": data.source_url or data.keyword or data.category,
            "min_quality": data.min_quality
        }
    except Exception as e:
        logging.error(f"[PORNTREX_DISCOVERY] Endpoint error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@api_v1_router.post("/import/porntrex_discovery/import")
@api_legacy_router.post("/import/porntrex_discovery/import")
async def porntrex_discovery_import(
    bg_tasks: BackgroundTasks,
    selected_urls: List[str] = Body(...),
    batch_name: Optional[str] = Body(None),
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """
    Import selected videos from Porntrex Discovery results.
    Accepts a list of video page URLs to import.
    """
    try:
        batch = batch_name or f"Porntrex Discovery {datetime.datetime.now().strftime('%d.%m %H:%M')}"
        new_ids = []

        for url in selected_urls:
            if not url or not url.startswith('http'):
                continue

            # Check if already exists
            existing = db.query(Video).filter(Video.url == url).first()
            if existing:
                logging.info(f"[PORNTREX_DISCOVERY_IMPORT] Skipping duplicate: {url}")
                continue

            # Create video entry with pending status
            video = Video(
                title="Queued...",
                url=url,
                source_url=url,
                batch_name=batch,
                status="pending",
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)

        db.commit()

        # Process videos in background
        if new_ids:
            processor = VIPVideoProcessor()
            bg_tasks.add_task(processor.process_batch, new_ids)

        logging.info(f"[PORNTREX_DISCOVERY_IMPORT] Queued {len(new_ids)} videos for import")

        return {
            "status": "success",
            "count": len(new_ids),
            "batch": batch,
            "message": f"Importing {len(new_ids)} videos from Porntrex Discovery"
        }
    except Exception as e:
        logging.error(f"[PORNTREX_DISCOVERY_IMPORT] Error: {e}", exc_info=True)
        db.rollback()
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@api_v1_router.post("/import/whoreshub_discovery")
@api_legacy_router.post("/import/whoreshub_discovery")
async def whoreshub_discovery(data: WhoresHubDiscoveryRequest, auth: bool = Depends(check_auth)):
    """
    WhoresHub Smart Discovery - Scrapes search/tag/category pages with filtering.
    Returns preview results for user to select before importing.
    """
    try:
        # Run scraper in thread pool to avoid blocking
        results = await asyncio.to_thread(
            scrape_whoreshub_discovery,
            keyword=data.keyword,
            tag=data.tag,
            min_quality=data.min_quality,
            min_duration=data.min_duration,
            pages=data.pages,
            upload_type=data.upload_type,
            auto_skip_low_quality=data.auto_skip_low_quality,
            sort_by=data.sort_by,
        )

        return {
            "status": "success",
            "results": results,
            "total": len(results),
            "matched": len(results),
            "keyword": data.keyword or data.tag or "latest",
            "min_quality": data.min_quality,
            "min_duration": data.min_duration
        }
    except Exception as e:
        logging.error(f"[WHORESHUB_DISCOVERY] Endpoint error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@api_v1_router.post("/import/whoreshub_discovery/import")
@api_legacy_router.post("/import/whoreshub_discovery/import")
async def whoreshub_discovery_import(
    bg_tasks: BackgroundTasks,
    selected_urls: List[str] = Body(...),
    batch_name: Optional[str] = Body(None),
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """
    Import selected videos from WhoresHub Discovery results.
    Accepts a list of video page URLs to import.
    """
    try:
        batch = batch_name or f"WhoresHub Discovery {datetime.datetime.now().strftime('%d.%m %H:%M')}"
        new_ids = []

        for url in selected_urls:
            if not url or not url.startswith('http'):
                continue

            # Check if already exists
            existing = db.query(Video).filter(Video.url == url).first()
            if existing:
                logging.info(f"[WHORESHUB_DISCOVERY_IMPORT] Skipping duplicate: {url}")
                continue

            # Create video entry with pending status
            video = Video(
                title="Queued...",
                url=url,
                source_url=url,
                batch_name=batch,
                status="pending",
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)

        db.commit()

        # Process videos in background
        if new_ids:
            processor = VIPVideoProcessor()
            bg_tasks.add_task(processor.process_batch, new_ids)

        logging.info(f"[WHORESHUB_DISCOVERY_IMPORT] Queued {len(new_ids)} videos for import")

        return {
            "status": "success",
            "count": len(new_ids),
            "batch": batch,
            "message": f"Importing {len(new_ids)} videos from WhoresHub Discovery"
        }
    except Exception as e:
        logging.error(f"[WHORESHUB_DISCOVERY_IMPORT] Error: {e}", exc_info=True)
        db.rollback()
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@api_v1_router.post("/import/sxyprn_discovery")
@api_legacy_router.post("/import/sxyprn_discovery")
async def sxyprn_discovery_endpoint(data: SxyPrnDiscoveryRequest, auth: bool = Depends(check_auth)):
    """SxyPrn Discovery — scrape listing pages and return post previews."""
    try:
        results = await asyncio.to_thread(
            scrape_sxyprn_listing,
            mode=data.mode,
            query=data.query,
            tag=data.tag,
            profile_id=data.profile_id,
            pages=data.pages,
        )

        # Optionally resolve stream URLs for each post (slower, 1 req/post)
        if data.resolve_streams and results:
            async def _resolve(post):
                streams = await asyncio.to_thread(fetch_post_streams, post["post_id"])
                if streams:
                    post["stream_url"] = streams[0]["url"]
                    post["best_host"] = streams[0]["host"]
                return post
            import asyncio as _aio
            results = list(await _aio.gather(*[_resolve(p) for p in results]))

        return {
            "status": "success",
            "results": results,
            "total": len(results),
            "mode": data.mode,
            "query": data.query or data.tag or data.profile_id or "latest",
        }
    except Exception as e:
        logging.error("[SXYPRN_DISCOVERY] %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@api_v1_router.post("/import/sxyprn_discovery/resolve_stream")
@api_legacy_router.post("/import/sxyprn_discovery/resolve_stream")
async def sxyprn_resolve_stream(post_id: str = Body(..., embed=True), auth: bool = Depends(check_auth)):
    """Resolve and rank stream URLs for a single SxyPrn post on demand (best quality/size first)."""
    try:
        from .sxyprn_discovery import fetch_post_detail, probe_best_post_streams
        detail = await asyncio.to_thread(fetch_post_detail, post_id)
        streams = detail.get("streams") or []
        if streams:
            probed = await probe_best_post_streams(
                streams,
                duration_sec=int(detail.get("duration_sec") or 0),
                fallback_quality=detail.get("quality") or "",
                fallback_height=int(detail.get("height") or 0),
                fallback_size_mb=float(detail.get("file_size_mb") or 0.0),
            )
            cands = probed.get("candidates") or []
            if cands:
                streams = [
                    {
                        "url": c["source_url"],
                        "stream_url": c.get("stream_url") or c["source_url"],
                        "host": c["host"],
                        "quality": c.get("quality") or "",
                        "height": c.get("height") or 0,
                        "file_size_mb": c.get("file_size_mb") or 0.0,
                        "size_label": c.get("size_label") or "",
                        "status": c.get("status") or "fallback",
                    }
                    for c in cands
                ]
        return {"status": "success", "streams": streams, "best": streams[0]["url"] if streams else None}
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


class SxyPrnEnrichRequest(BaseModel):
    posts: List[Dict[str, Any]]


@api_v1_router.post("/import/sxyprn_discovery/enrich")
@api_legacy_router.post("/import/sxyprn_discovery/enrich")
async def sxyprn_discovery_enrich(body: SxyPrnEnrichRequest, auth: bool = Depends(check_auth)):
    """Enrich a batch of SxyPrn cards with resolution, file size, and stream links."""
    try:
        items = await enrich_sxyprn_posts(body.posts[:20])
        return {"status": "success", "items": items}
    except Exception as e:
        logging.error("[SXYPRN_ENRICH] %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


class SxyPrnImportRequest(BaseModel):
    selected: List[Dict[str, Any]]
    batch_name: Optional[str] = None


@api_v1_router.post("/import/sxyprn_discovery/import")
@api_legacy_router.post("/import/sxyprn_discovery/import")
async def sxyprn_discovery_import(
    bg_tasks: BackgroundTasks,
    body: SxyPrnImportRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Import selected SxyPrn posts. Each item: {post_url, stream_url?, title?, thumbnail?, duration_sec?, height?, quality?, file_size_mb?}"""
    selected = body.selected
    batch_name = body.batch_name
    try:
        batch = batch_name or f"SxyPrn Discovery {datetime.datetime.now().strftime('%d.%m %H:%M')}"
        new_ids = []

        for item in selected:
            post_url = item.get("post_url", "")
            stream_url = item.get("stream_url") or ""
            if not post_url or not post_url.startswith("http"):
                continue

            existing = db.query(Video).filter(
                (Video.url == post_url) | (Video.source_url == post_url)
            ).first()
            if existing:
                continue

            height = int(item.get("height") or 0)
            raw_quality = str(item.get("quality") or "").strip().upper()
            if height >= 2160 or raw_quality == "4K":
                db_quality = "4K"
            elif height >= 1440:
                db_quality = "1440p"
            elif height >= 1080 or raw_quality in ("1080P", "FHD"):
                db_quality = "FHD"
            elif height >= 720 or raw_quality in ("720P", "HD"):
                db_quality = "HD"
            else:
                db_quality = "SD"

            video = Video(
                title=item.get("title", "SxyPrn Video")[:200] or "SxyPrn Video",
                url=stream_url or post_url,
                source_url=post_url,
                thumbnail_path=item.get("thumbnail") or None,
                duration=float(item.get("duration_sec") or 0),
                height=height,
                quality=db_quality,
                file_size_mb=float(item.get("file_size_mb") or 0),
                batch_name=batch,
                status="ready_to_stream" if stream_url else "pending",
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None),
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)

            # Save all discovered external mirrors to VideoSource (with the winning stream marked primary)
            try:
                ext_streams = item.get("streams") or []
                ext_urls = item.get("ext_urls") or []
                if not ext_streams and ext_urls:
                    ext_streams = [{"url": u} for u in ext_urls if isinstance(u, str)]
                seen_mirror_urls = set()
                for idx_s, s_obj in enumerate(ext_streams[:8]):
                    m_url = (s_obj.get("url") if isinstance(s_obj, dict) else str(s_obj or "")).strip()
                    if not m_url or not m_url.startswith(("http://", "https://")) or m_url in seen_mirror_urls:
                        continue
                    seen_mirror_urls.add(m_url)
                    m_host = (s_obj.get("host") if isinstance(s_obj, dict) else "") or urllib.parse.urlsplit(m_url).hostname or ""
                    m_height = int((s_obj.get("height") if isinstance(s_obj, dict) else 0) or (height if idx_s == 0 else 0))
                    m_qual = (s_obj.get("quality") if isinstance(s_obj, dict) else "") or (raw_quality if idx_s == 0 else "")
                    m_size = float((s_obj.get("file_size_mb") if isinstance(s_obj, dict) else 0.0) or (float(item.get("file_size_mb") or 0) if idx_s == 0 else 0.0))
                    db.add(VideoSource(
                        video_id=video.id,
                        url=m_url,
                        source_url=m_url,
                        label=m_host.replace("www.", "").split(".")[0].capitalize() or "Mirror",
                        quality=str(m_qual),
                        height=m_height,
                        size_mb=m_size,
                        is_primary=(idx_s == 0),
                    ))
            except Exception as vs_err:
                logging.debug("[SXYPRN_IMPORT] VideoSource attach error: %s", vs_err)

        db.commit()

        if new_ids:
            processor = VIPVideoProcessor()
            bg_tasks.add_task(processor.process_batch, new_ids)

        return {
            "status": "success",
            "count": len(new_ids),
            "batch": batch,
            "message": f"Importing {len(new_ids)} SxyPrn posts",
        }
    except Exception as e:
        logging.error("[SXYPRN_IMPORT] %s", e, exc_info=True)
        db.rollback()
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@api_v1_router.post("/import/leakporner_discovery")
@api_legacy_router.post("/import/leakporner_discovery")
async def leakporner_discovery(data: LeakPornerDiscoveryRequest, auth: bool = Depends(check_auth)):
    """
    LeakPorner Discovery - Scrapes listing pages and returns preview results.
    """
    try:
        results = await asyncio.to_thread(
            scrape_leakporner_discovery,
            keyword=data.keyword,
            pages=data.pages,
            min_duration=data.min_duration,
            sort=data.sort,
        )

        return {
            "status": "success",
            "results": results,
            "total": len(results),
            "matched": len(results),
            "keyword": data.keyword or "latest",
            "min_duration": data.min_duration,
            "sort": data.sort,
        }
    except Exception as e:
        logging.error(f"[LEAKPORNER_DISCOVERY] Endpoint error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@api_v1_router.post("/import/leakporner_discovery/import")
@api_legacy_router.post("/import/leakporner_discovery/import")
async def leakporner_discovery_import(
    data: LeakPornerDiscoveryImportRequest,
    bg_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    selected_urls = data.selected_urls
    batch_name = data.batch_name
    """
    Import selected videos from LeakPorner Discovery results.
    Accepts a list of video page URLs to import.
    """
    try:
        batch = batch_name or f"LeakPorner Discovery {datetime.datetime.now().strftime('%d.%m %H:%M')}"
        new_ids = []

        for url in selected_urls:
            if not url or not url.startswith('http'):
                continue

            existing = db.query(Video).filter(Video.url == url).first()
            if existing:
                logging.info(f"[LEAKPORNER_DISCOVERY_IMPORT] Skipping duplicate: {url}")
                continue

            video = Video(
                title="Queued...",
                url=url,
                source_url=url,
                batch_name=batch,
                status="pending",
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)

        db.commit()

        if new_ids:
            processor = VIPVideoProcessor()
            bg_tasks.add_task(processor.process_batch, new_ids)

        logging.info(f"[LEAKPORNER_DISCOVERY_IMPORT] Queued {len(new_ids)} videos for import")

        return {
            "status": "success",
            "count": len(new_ids),
            "batch": batch,
            "message": f"Importing {len(new_ids)} videos from LeakPorner Discovery"
        }
    except Exception as e:
        logging.error(f"[LEAKPORNER_DISCOVERY_IMPORT] Error: {e}", exc_info=True)
        db.rollback()
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


# ── PornOne Smart Discovery ───────────────────────────────────────────

class PornOneDiscoveryRequest(BaseModel):
    keyword: str = ""
    category: str = ""
    min_quality: int = 720
    min_duration: int = 0
    sort_by: str = "newest"
    pages: int = 3


class TnaflixDiscoveryRequest(BaseModel):
    keyword: str = ""
    category: str = ""
    min_quality: int = 720
    min_duration: int = 0
    sort_by: str = "new"
    pages: int = 3


@api_v1_router.post("/discovery/pornone")
async def discover_pornone(req: PornOneDiscoveryRequest, auth: bool = Depends(check_auth)):
    """PornOne Smart Discovery – scrapes search results and returns video cards for preview."""
    from .extractors.pornone import PornOneExtractor
    ext = PornOneExtractor()
    try:
        results = await asyncio.to_thread(
            ext.discover,
            keyword=req.keyword,
            category=req.category,
            min_quality=req.min_quality,
            min_duration=req.min_duration,
            sort_by=req.sort_by,
            pages=req.pages,
        )
        # Detect if CF blocked keyword search (fallback results came from /newest/)
        cf_warning = None
        if req.keyword and results:
            # If CF fallback was used, results come from /newest/ not keyword-specific
            cf_warning = "PornOne blokuje keyword search (Cloudflare). Zobrazujú sa najnovšie videá filtrované podľa titulu."
        return {"results": results, "total": len(results), "cf_warning": cf_warning}
    except Exception as e:
        logging.error(f"[PORNONE_DISCOVERY] Error: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@api_v1_router.post("/discovery/pornone/import")
async def import_pornone_discovery(
    req: dict,
    bg_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Queue selected PornOne Discovery videos for import.

    Videos are stored as ready_to_stream with their watch-page URL preserved in source_url.
    JIT extraction happens at playback time via /stream/pornone/{id}, so there are no dead
    links — a fresh stream URL is resolved on every play from the watch page.
    """
    try:
        urls = req.get("urls", [])
        meta_map = {item["page_url"]: item for item in req.get("results", []) if item.get("page_url")}
        batch = req.get("batch_name", f"PornOne Discovery {datetime.datetime.now().strftime('%d.%m %H:%M')}")
        new_ids = []
        for url in urls:
            if not url or not url.startswith("http"):
                continue
            existing = db.query(Video).filter(
                (Video.url == url) | (Video.source_url == url)
            ).first()
            if existing:
                continue
            m = meta_map.get(url, {})
            video = Video(
                title=m.get("title") or "PornOne Video",
                url=url,
                source_url=url,
                thumbnail_path=m.get("thumbnail") or None,
                duration=int(m.get("duration") or 0) or None,
                batch_name=batch,
                storage_type="remote",
                status="ready_to_stream",
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None),
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)
        db.commit()
        return {"status": "ok", "count": len(new_ids)}
    except Exception as e:
        logging.error(f"[PORNONE_DISCOVERY_IMPORT] Error: {e}", exc_info=True)
        db.rollback()
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


# ── Tnaflix Smart Discovery ───────────────────────────────────────────

@api_v1_router.get("/discovery-hub/stream")
@api_legacy_router.get("/discovery-hub/stream")
async def discovery_hub_stream(url: str = "", auth: bool = Depends(check_auth)):
    """Resolve a Bunkr file URL to a direct stream URL for inline playback in the Discovery Hub."""
    if not url:
        return JSONResponse(status_code=400, content={"error": "url required"})
    from app.extractors.bunkr import BunkrExtractor
    extractor = BunkrExtractor()
    try:
        result = await extractor.extract(url)
        if not result or not result.get("stream_url"):
            return JSONResponse(status_code=502, content={"error": "Stream URL sa nenašiel. Video môže byť zmazané alebo neprístupné."})
        return {
            "stream_url": result.get("stream_url") or "",
            "title": result.get("title") or "",
            "size": result.get("size") or "",
            "duration": result.get("duration") or 0,
        }
    except Exception as e:
        logging.error(f"[DHUB_STREAM] Error resolving {url}: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@api_v1_router.get("/discovery/tnaflix/preview")
async def tnaflix_preview(url: str = "", auth: bool = Depends(check_auth)):
    """Resolve a Tnaflix watch-page URL to a direct stream URL for inline playback."""
    if not url or "tnaflix.com" not in url:
        return JSONResponse(status_code=400, content={"error": "Valid tnaflix.com URL required"})
    from .extractors.tnaflix import TnaflixExtractor
    ext = TnaflixExtractor()
    try:
        result = await asyncio.to_thread(ext.extract, url)
        if not result:
            return JSONResponse(status_code=502, content={"error": "Extraction failed"})
        return {
            "stream_url": result.get("stream_url") or "",
            "title": result.get("title") or "",
            "thumbnail": result.get("thumbnail") or "",
            "duration": result.get("duration") or 0,
            "tags": result.get("tags") or "",
        }
    except Exception as e:
        logging.error(f"[TNAFLIX_PREVIEW] Error: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@api_v1_router.get("/discovery/tnaflix/profile")
async def discover_tnaflix_profile(url: str = "", max_pages: int = 30, auth: bool = Depends(check_auth)):
    """Scrape a Tnaflix profile/user page and return video cards for preview (no stream extraction)."""
    if not url or "tnaflix.com" not in url:
        return JSONResponse(status_code=400, content={"error": "Valid tnaflix.com URL required"})
    from .extractors.tnaflix import TnaflixExtractor
    ext = TnaflixExtractor()
    try:
        result = await asyncio.to_thread(ext.discover_profile, url, max_pages)
        return result
    except Exception as e:
        logging.error(f"[TNAFLIX_PROFILE] Error: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@api_v1_router.get("/discovery/tnaflix/profiles")
async def discover_tnaflix_profiles(
    mode: str = "last_updated",
    limit: int = 50,
    pages: int = 3,
    auth: bool = Depends(check_auth),
):
    """Find Tnaflix profiles, e.g. recently active profiles from latest video pages."""
    from .extractors.tnaflix import TnaflixExtractor
    ext = TnaflixExtractor()
    try:
        return await asyncio.to_thread(ext.discover_profiles, mode, limit, pages)
    except Exception as e:
        logging.error(f"[TNAFLIX_PROFILES] Error: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@api_v1_router.post("/discovery/tnaflix")
async def discover_tnaflix(req: TnaflixDiscoveryRequest, auth: bool = Depends(check_auth)):
    """Tnaflix Smart Discovery – scrapes search results and returns video cards for preview."""
    from .extractors.tnaflix import TnaflixExtractor
    ext = TnaflixExtractor()
    try:
        results = await asyncio.to_thread(
            ext.discover,
            keyword=req.keyword,
            category=req.category,
            min_quality=req.min_quality,
            min_duration=req.min_duration,
            sort_by=req.sort_by,
            pages=req.pages,
        )
        return {"results": results, "total": len(results)}
    except Exception as e:
        logging.error(f"[TNAFLIX_DISCOVERY] Error: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@api_v1_router.post("/discovery/tnaflix/enrich")
async def tnaflix_enrich_cards(req: dict, auth: bool = Depends(check_auth)):
    """Parallel-fetch individual Tnaflix video pages to get size, quality, duration, upload_date."""
    from .extractors.tnaflix import TnaflixExtractor
    urls = [u for u in (req.get("urls") or []) if u and "tnaflix.com" in u]
    if not urls:
        return {"results": []}
    workers = min(int(req.get("workers") or 32), 64)
    ext = TnaflixExtractor()
    try:
        results = await asyncio.to_thread(ext.enrich_cards_batch, urls, workers)
        return {"results": results, "total": len(results)}
    except Exception as e:
        logging.error(f"[TNAFLIX_ENRICH] {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@api_v1_router.post("/discovery/tnaflix/import")
async def import_tnaflix_discovery(
    req: dict,
    bg_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Queue selected Tnaflix Discovery videos for import.

    Videos are stored as ready_to_stream with their watch-page URL preserved in source_url.
    JIT extraction happens at playback time via /stream/tnaflix/{id}, so there are no dead
    links — a fresh stream URL is resolved on every play from the watch page.
    """
    try:
        urls = req.get("urls", [])
        meta_map = {item["page_url"]: item for item in req.get("results", []) if item.get("page_url")}
        batch = req.get("batch_name", f"Tnaflix Discovery {datetime.datetime.now().strftime('%d.%m %H:%M')}")
        new_ids = []
        for url in urls:
            if not url or not url.startswith("http"):
                continue
            existing = db.query(Video).filter(
                (Video.url == url) | (Video.source_url == url)
            ).first()
            if existing:
                continue
            m = meta_map.get(url, {})
            video = Video(
                title=m.get("title") or "Tnaflix Video",
                url=url,
                source_url=url,
                thumbnail_path=m.get("thumbnail") or None,
                duration=int(m.get("duration") or 0) or None,
                batch_name=batch,
                storage_type="remote",
                status="ready_to_stream",
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None),
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)
        db.commit()
        return {"status": "ok", "count": len(new_ids)}
    except Exception as e:
        logging.error(f"[TNAFLIX_DISCOVERY_IMPORT] Error: {e}", exc_info=True)
        db.rollback()
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@api_v1_router.post("/import/cyberleaks_discovery")
@api_legacy_router.post("/import/cyberleaks_discovery")
async def cyberleaks_discovery(data: CyberLeaksDiscoveryRequest, auth: bool = Depends(check_auth)):
    """
    CyberLeaks Discovery - Scrapes listing pages and returns preview results.
    """
    try:
        results = await asyncio.to_thread(
            scrape_cyberleaks_discovery,
            keyword=data.keyword,
            pages=data.pages,
            tag=data.tag
        )

        return {
            "status": "success",
            "results": results,
            "total": len(results),
            "matched": len(results),
            "keyword": data.keyword or "latest",
            "tag": data.tag,
        }
    except Exception as e:
        logging.error(f"[CYBERLEAKS_DISCOVERY] Endpoint error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@api_v1_router.post("/import/cyberleaks_discovery/import")
@api_legacy_router.post("/import/cyberleaks_discovery/import")
async def cyberleaks_discovery_import(
    bg_tasks: BackgroundTasks,
    selected_urls: List[str] = Body(...),
    batch_name: Optional[str] = Body(None),
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """
    Import selected videos from CyberLeaks Discovery results.
    """
    try:
        batch = batch_name or f"CyberLeaks Discovery {datetime.datetime.now().strftime('%d.%m %H:%M')}"
        new_ids = []

        for url in selected_urls:
            if not url or not url.startswith('http'):
                continue

            existing = db.query(Video).filter(Video.url == url).first()
            if existing:
                continue

            video = Video(
                title="Queued...",
                url=url,
                source_url=url,
                batch_name=batch,
                status="pending",
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)

        db.commit()

        if new_ids:
            processor = VIPVideoProcessor()
            bg_tasks.add_task(processor.process_batch, new_ids)

        return {
            "status": "success",
            "count": len(new_ids),
            "batch": batch,
            "message": f"Importing {len(new_ids)} videos from CyberLeaks Discovery"
        }
    except Exception as e:
        logging.error(f"[CYBERLEAKS_DISCOVERY_IMPORT] Error: {e}", exc_info=True)
        db.rollback()
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


async def process_batch_import_with_filters(candidates: List[dict], batch: str, min_dur: int, min_res: int, only_vert: bool, disable_rejection: bool = False, is_reddit: bool = False, is_pornone: bool = False, debug: bool = False):
    """
    Background job to resolve metadata and add to DB with summary reporting.
    """
    db = SessionLocal()
    processor = VIPVideoProcessor()
    
    stats = {
        "scanned": len(candidates),
        "imported": 0,
        "skipped_short": 0,
        "skipped_low_res": 0,
        "skipped_vertical": 0,
        "skipped_keywords": 0,
        "skipped_exists": 0,
        "error": 0,
        "rejected_samples": []  # List of {title, reason}
    }
    
    # Decision trace logger (simple list)
    trace = []

    from .extractors.reddit import RedditExtractor
    from .extractors.pornone import PornOneExtractor
    reddit_ext = RedditExtractor() if is_reddit else None
    pornone_ext = PornOneExtractor() if is_pornone else None
    
    new_ids = []
    import re
    
    for c in candidates:
        decision = {"title": c.get('title', 'Unknown'), "status": "pending", "reason": ""}
        try:
            # 0. Title/Tag Rejection
            if not disable_rejection:
                rejected_terms = ["meme", "edit", "compilation", "remix", "gif", "loop"]
                title_low = c['title'].lower()
                tags_low = [t.lower() for t in c.get('tags', [])]
                
                found_bad = False
                for bad in rejected_terms:
                    # Using word boundary logic
                    if re.search(rf"\b{re.escape(bad)}\b", title_low):
                        found_bad = True; decision["reason"] = f"Keyword Block (Title): {bad}"; break
                    if any(re.search(rf"\b{re.escape(bad)}\b", t) for t in tags_low):
                        found_bad = True; decision["reason"] = f"Keyword Block (Tag): {bad}"; break
                
                if found_bad:
                    decision["status"] = "rejected"
                    stats["skipped_keywords"] += 1
                    trace.append(decision)
                    stats["rejected_samples"].append({"title": c['title'], "reason": decision["reason"]})
                    continue

            # NOTE: PornOne restrictive allowlist has been REMOVED as per audit request.
            # It was causing 95% of valid results to be dropped silently.
            # Use 'disable_rejection' in request if you need to bypass the standard blocklist above.

            video_url = c.get('video_url')
            thumbnail = c.get('thumbnail')
            duration = c.get('duration') or 0
            width = c.get('width') or 0
            height = c.get('height') or 0
            
            if is_reddit:
                # Need to resolve v.redd.it
                dur, w, h, real_url = reddit_ext.get_video_info(c['reddit_url'])
                if not real_url: 
                    decision["status"] = "error"
                    decision["reason"] = "Reddit resolution failed"
                    stats["error"] += 1
                    trace.append(decision)
                    continue
                video_url = real_url
                duration = dur or 0
                width = w or 0
                height = h or 0
            elif is_pornone:
                # Need to resolve detail page
                meta = await pornone_ext.extract(c['page_url'])
                if not meta or not meta.get('stream_url'):
                    decision["status"] = "error"
                    decision["reason"] = "PornOne extraction failed"
                    stats["error"] += 1
                    trace.append(decision)
                    continue
                video_url = meta['stream_url']
                duration = meta.get('duration') or duration # Use search duration if extract fails
                width = meta.get('width') or 0
                height = meta.get('height') or 0
                thumbnail = meta.get('thumbnail') or thumbnail
            else:
                # RedGIFs - optionally check metadata if filters are set
                if min_dur > 0 or min_res > 0 or only_vert:
                    # Quick ffprobe
                    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration", "-of", "json", video_url]
                    res = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
                    if res.returncode == 0:
                        p_data = json.loads(res.stdout)
                        stream = p_data["streams"][0]
                        duration = float(stream.get("duration", 0))
                        width = int(stream.get("width", 0))
                        height = int(stream.get("height", 0))
                    else:
                        decision["status"] = "error"
                        decision["reason"] = "FFProbe failed"
                        stats["error"] += 1
                        trace.append(decision)
                        continue
            
            # Apply "Brutal Tier" Filters
            min_duration_seconds = min_dur # Explicit naming
            if min_duration_seconds > 0 and duration < min_duration_seconds: 
                decision["status"] = "rejected"
                decision["reason"] = f"Too Short ({int(duration)}s < {min_duration_seconds}s)"
                stats["skipped_short"] += 1
                trace.append(decision)
                stats["rejected_samples"].append({"title": c['title'], "reason": decision["reason"]})
                continue
            
            if min_res > 0 and max(width, height) < min_res: 
                decision["status"] = "rejected"
                decision["reason"] = f"Low Res ({max(width, height)}p < {min_res}p)"
                stats["skipped_low_res"] += 1
                trace.append(decision)
                stats["rejected_samples"].append({"title": c['title'], "reason": decision["reason"]})
                continue
                
            if only_vert and height <= width:
                decision["status"] = "rejected"
                decision["reason"] = "Not Vertical"
                stats["skipped_vertical"] += 1
                trace.append(decision)
                stats["rejected_samples"].append({"title": c['title'], "reason": decision["reason"]})
                continue
            
            # Check for Duplicate
            existing = db.query(Video).filter(Video.source_url == c['page_url']).first()
            if existing:
                 decision["status"] = "rejected"
                 decision["reason"] = "Duplicate (Already Imported)"
                 stats["skipped_exists"] += 1
                 trace.append(decision)
                 continue

            is_direct_external_import = not is_reddit and not is_pornone
            initial_status = "ready_to_stream" if is_direct_external_import else "pending"
            initial_storage_type = "external_direct" if is_direct_external_import else "remote"

            video = Video(
                title=c['title'],
                url=video_url,
                source_url=c['page_url'],
                thumbnail_path=thumbnail,
                batch_name=batch,
                status=initial_status,
                tags=",".join(c.get('tags', [])),
                duration=int(duration) if duration else None,
                width=width if width else None,
                height=height if height else None,
                storage_type=initial_storage_type,
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            )
            db.add(video)
            db.flush()
            new_ids.append(video.id)
            stats["imported"] += 1
            decision["status"] = "accepted"
            trace.append(decision)
            
            # Broadcast progress or new video
            processor.broadcast_new_video(video)
            
        except Exception as e:
            print(f"Error processing candidate {c.get('title')}: {e}")
            stats["error"] += 1
            decision["status"] = "error"
            decision["reason"] = str(e)
            trace.append(decision)
            
    db.commit()
    
    if debug:
        print("\n=== IMPORT DECISION TRACE ===")
        for t in trace:
            print(f"[{t['status'].upper()}] {t['title']} -> {t['reason']}")
        print("=============================\n")

    # Send Final Summary via WebSocket
    summary_msg = {
        "type": "import_summary",
        "batch": batch,
        "stats": stats,
        "debug": debug,
        "trace": trace if debug else [] # Only send full trace if debug enabled
    }
    await manager.broadcast(json.dumps(summary_msg))
    
    if new_ids:
        processor.process_batch(new_ids)
    db.close()

@api_v1_router.get("/search_external")
@api_legacy_router.get("/search_external")
async def search_external_endpoint(
    query: str,
    source: Optional[str] = None,
    per_source_limit: int = 5,
    max_total: int = 80,
):
    engine = ExternalSearchEngine()
    results = await engine.search(
        query,
        source=source,
        result_limit=per_source_limit,
        max_total=max_total,
        per_source_limit=per_source_limit,
    )
    return results

@api_v1_router.get("/videos/recommendations")
@api_legacy_router.get("/videos/recommendations")
def get_recommendations(limit: int = 12, db: Session = Depends(get_db)):
    """
    Neural Discovery Engine: Recommends videos based on favorite and watched tags.
    """
    # 1. Get favorite/watched tags
    fav_videos = db.query(Video).filter(or_(Video.is_favorite == True, Video.is_watched == True)).all()
    
    all_tags = []
    for v in fav_videos:
        if v.tags: all_tags.extend([t.strip().lower() for t in v.tags.split(",") if t.strip()])
        if v.ai_tags: all_tags.extend([t.strip().lower() for t in v.ai_tags.split(",") if t.strip()])
    
    if not all_tags:
        # Fallback: Just return newest ready videos
        return db.query(Video).filter(Video.status == 'ready', Video.thumbnail_path.isnot(None)).order_by(desc(Video.id)).limit(limit).all()
    
    # 2. Rank tags by frequency
    tag_counts = collections.Counter(all_tags)
    top_tags = [t for t, count in tag_counts.most_common(5)]
    
    # 3. Find videos with these tags that haven't been watched yet
    watched_ids = [v.id for v in fav_videos if v.is_watched]
    
    recommended = []
    for tag in top_tags:
        videos = db.query(Video).filter(
            Video.status == 'ready',
            Video.thumbnail_path.isnot(None),
            Video.id.notin_(watched_ids),
            or_(Video.tags.contains(tag), Video.ai_tags.contains(tag))
        ).limit(limit).all()
        recommended.extend(videos)
    
    # 4. Mix and deduplicate
    unique_rec = []
    seen = set()
    for v in recommended:
        if v.id not in seen:
            unique_rec.append(v)
            seen.add(v.id)
            if len(unique_rec) >= limit: break
            
    # Final fallback if still too few
    if len(unique_rec) < limit:
        extra = db.query(Video).filter(Video.status == 'ready', Video.thumbnail_path.isnot(None), Video.id.notin_(list(seen))).limit(limit - len(unique_rec)).all()
        unique_rec.extend(extra)
        
    return unique_rec[:limit]

# --- TELEGRAM DEEP SEARCH AUTH ---
@api_v1_router.post("/settings/filester/cookies")
@api_legacy_router.post("/settings/filester/cookies")
async def upload_filester_cookies(request: Request, auth: bool = Depends(check_auth)):
    """Accept a Netscape cookie file upload and save it as filester.me_cookies.txt in the repo root."""
    from pathlib import Path
    import shutil, tempfile
    form = await request.form()
    file = form.get("file")
    if not file:
        # Try plain text body (cookie string pasted directly)
        body = await request.body()
        if not body:
            return JSONResponse(status_code=400, content={"error": "No file or body provided"})
        content = body.decode("utf-8", errors="replace").strip()
    else:
        content = (await file.read()).decode("utf-8", errors="replace").strip()

    if not content:
        return JSONResponse(status_code=400, content={"error": "Empty content"})

    # Validate it looks like a Netscape cookie file or contains auth_token
    if "auth_token" not in content and "filester" not in content.lower():
        return JSONResponse(status_code=400, content={"error": "File does not appear to contain Filester cookies (no auth_token or filester domain found)"})

    repo_root = Path(__file__).resolve().parents[1]
    dest = repo_root / "filester.me_cookies.txt"
    dest.write_text(content, encoding="utf-8")
    logging.info("[Filester] Cookies updated via API, saved to %s", dest)

    # Quick validation — try loading the cookies we just saved
    from app.extractors.filester import _load_cookies_from_paths
    loaded = _load_cookies_from_paths([str(dest)])
    if not loaded:
        return JSONResponse(status_code=422, content={"error": "File saved but no Filester cookies could be parsed from it. Check the format."})

    return {"ok": True, "path": str(dest), "cookies_loaded": list(loaded.keys())}


@api_v1_router.get("/settings/filester/cookies/status")
@api_legacy_router.get("/settings/filester/cookies/status")
async def filester_cookies_status(auth: bool = Depends(check_auth)):
    """Return current Filester cookie status (which file is active, which keys are loaded, expiry)."""
    from pathlib import Path
    import http.cookiejar, datetime
    from app.extractors.filester import _build_cookie_search_paths
    repo_root = Path(__file__).resolve().parents[1]
    search_paths = _build_cookie_search_paths([
        str(repo_root / "filester.me_cookies.txt"),
        str(repo_root / "app" / "filester.me_cookies.txt"),
        str(repo_root / "filester.cookies.txt"),
    ])
    for path in search_paths:
        if not Path(path).exists():
            continue
        try:
            jar = http.cookiejar.MozillaCookieJar(path)
            jar.load(ignore_discard=True, ignore_expires=True)
            cookies_info = []
            for c in jar:
                if "filester" in c.domain.lower():
                    exp = datetime.datetime.fromtimestamp(c.expires).isoformat() if c.expires else "session"
                    expired = c.expires and c.expires < datetime.datetime.now().timestamp()
                    cookies_info.append({"name": c.name, "expires": exp, "expired": bool(expired)})
            if cookies_info:
                return {"active_file": path, "cookies": cookies_info, "any_expired": any(c["expired"] for c in cookies_info)}
        except Exception:
            pass
    return {"active_file": None, "cookies": [], "any_expired": None, "message": "No Filester cookie file found"}


@api_v1_router.get("/settings/telegram/status")
@api_legacy_router.get("/settings/telegram/status")
async def tg_status():
    is_active = await tg_auth_manager.content_status()
    api_id_set = bool(config.TELEGRAM_API_ID)
    return {"is_connected": is_active, "has_creds": api_id_set}

@api_v1_router.post("/settings/telegram/login")
@api_legacy_router.post("/settings/telegram/login")
async def tg_login(req: TelegramLoginRequest):
    try:
        return await tg_auth_manager.send_code(req.api_id, req.api_hash, req.phone)
    except Exception as e:
        raise HTTPException(400, detail=str(e))

@api_v1_router.post("/settings/telegram/verify")
@api_legacy_router.post("/settings/telegram/verify")
async def tg_verify(req: TelegramVerifyRequest):
    try:
        if req.password and not req.code:
             return await tg_auth_manager.verify_password(req.password)
        return await tg_auth_manager.verify_code(req.code, req.password)
    except Exception as e:
        raise HTTPException(400, detail=str(e))

# --- VK STREAMING ENDPOINT ---
# VK URLs expire quickly, so we extract fresh stream URLs on-demand

@api_v1_router.get("/stream/vk/{video_id}")
@api_legacy_router.get("/stream/vk/{video_id}")
async def get_vk_stream(video_id: int, db: Session = Depends(get_db)):
    """
    Extract fresh VK stream URL on-demand.
    VK URLs expire quickly, so we use yt-dlp to get a fresh URL each time.
    Results are cached for 30 minutes to improve performance.
    """
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")
    
    # Check if this is a VK video
    source_url = video.source_url or video.url
    if not any(domain in source_url.lower() for domain in ['vk.com', 'vk.video', 'vkvideo.ru', 'vkvideo.net', 'vkvideo.com', 'vk.ru', 'okcdn.ru']):
        raise HTTPException(400, detail="Not a VK video")
    
    # Extract fresh stream URL using the resilient playback function
    from app.extractors.vk import extract_vk_playback_resilient
    result = await asyncio.to_thread(extract_vk_playback_resilient, source_url)
    
    if not result or not result.get('stream_url'):
        raise HTTPException(500, detail="Failed to extract VK stream URL")
    
    return result

# --- LULU JIT STREAMING ENDPOINT ---
# LuluStream/LuluVDO sign their HLS URLs with short-lived tokens (~1-4 hours).
# The imported URL expires quickly, so we re-extract a fresh one on every Play.

_lulu_stream_cache: dict = {}  # video_id -> {stream_url, ts}
_LULU_CACHE_TTL = 25 * 60  # 25 minutes (tokens last ~1-4h, be conservative)
_LULU_DOMAINS = ("lulustream.com", "luluvid.com", "luluvdo.com", "lulu.stream", "luluvid.net", "luluvids.top", "luluvids.com", "lulust.com")

@api_v1_router.get("/stream/lulu/{video_id}")
@api_legacy_router.get("/stream/lulu/{video_id}")
async def get_lulu_stream(video_id: int, db: Session = Depends(get_db)):
    """
    JIT-resolve a fresh LuluStream/LuluVDO stream URL.
    Called by the frontend player instead of using the stale stored URL.
    Results are cached for 25 minutes per video_id.
    """
    import time

    # Serve from cache if fresh
    cached = _lulu_stream_cache.get(video_id)
    if cached and (time.time() - cached["ts"]) < _LULU_CACHE_TTL:
        logging.info(f"[LuluJIT] Serving cached stream for video {video_id}")
        return {"stream_url": cached["stream_url"], "is_hls": cached.get("is_hls", True), "cached": True}

    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    source_url = video.source_url or video.url or ""
    if not any(d in source_url.lower() for d in _LULU_DOMAINS):
        # Maybe url itself is a lulu domain
        if not any(d in (video.url or "").lower() for d in _LULU_DOMAINS):
            raise HTTPException(400, detail="Not a LuluStream/LuluVDO video")
        source_url = video.url

    logging.info(f"[LuluJIT] Re-extracting stream for video {video_id}: {source_url}")

    try:
        from app.extractors.lulustream import LuluStreamExtractor
        extractor = LuluStreamExtractor()
        result = await extractor.extract(source_url)

        if not result or not result.get("stream_url"):
            # Fallback: try the stored url as embed if source_url failed
            if video.url and video.url != source_url:
                result = await extractor.extract(video.url)

        if not result or not result.get("stream_url"):
            raise HTTPException(502, detail="LuluStream extractor could not find stream URL. The video may be deleted or geo-blocked.")

        stream_url = result["stream_url"]
        is_hls = result.get("is_hls", ".m3u8" in stream_url.lower())

        # Update the stored URL + thumbnail in DB
        try:
            video.url = stream_url
            thumb = result.get("thumbnail") or result.get("thumbnail_url") or ""
            if thumb and not video.thumbnail_path:
                import urllib.parse
                video.thumbnail_path = f"/thumb_proxy?url={urllib.parse.quote(thumb)}&referer=https://luluvid.com/"
            if result.get("title") and result["title"] not in ("lulu", "LuluStream Video", "") and (not video.title or video.title in ("lulu", "")):
                video.title = result["title"]
            db.commit()
        except Exception:
            db.rollback()

        # Cache the fresh URL
        _lulu_stream_cache[video_id] = {"stream_url": stream_url, "is_hls": is_hls, "ts": time.time()}
        logging.info(f"[LuluJIT] Fresh stream extracted for {video_id}: {stream_url[:80]}…")

        return {"stream_url": stream_url, "is_hls": is_hls, "cached": False}

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[LuluJIT] Extraction failed for video {video_id}: {e}")
        raise HTTPException(500, detail=f"LuluStream extraction error: {e}")

# --- LEAKPORNER JIT STREAMING ENDPOINT ---
# cdnvids.top/cdnstream.top sign HLS URLs with short-lived epoch-based tokens (~1h).
# Frontend detects stale tokens and calls this to re-extract a fresh stream URL.

_leakporner_stream_cache: dict = {}  # video_id -> {stream_url, ts}
_LEAKPORNER_CACHE_TTL = 50 * 60  # 50 minutes
_embed_proxy_sessions: dict = _shared_proxy_sessions  # shared with cross-source resolver
_EMBED_PROXY_SESSION_TTL = _shared_proxy_session_ttl

_CDNVIDS_DOMAINS = ("cdnvids.top", "cdnstream.top")
_LEAKPORNER_SOURCE_DOMAINS = ("leakporner.com", "w12.leakporner.com", "djav.org", "hornysimp.com", "hornysimp.com.lv", "hornysimp")

@api_v1_router.get("/stream/leakporner/{video_id}")
@api_legacy_router.get("/stream/leakporner/{video_id}")
async def get_leakporner_stream(video_id: int, db: Session = Depends(get_db)):
    """
    JIT-resolve a fresh LeakPorner/cdnvids stream URL.
    Called by the frontend player when a stored token has expired.
    Results are cached for 50 minutes per video_id.
    """
    import time

    # Serve from cache if fresh
    cached = _leakporner_stream_cache.get(video_id)
    if cached and (time.time() - cached["ts"]) < _LEAKPORNER_CACHE_TTL:
        logging.info(f"[LeakPornerJIT] Serving cached stream for video {video_id}")
        return {"stream_url": cached["stream_url"], "is_hls": True, "cached": True}

    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    source_url = video.source_url or video.url or ""
    is_leakporner_source = any(d in source_url.lower() for d in _LEAKPORNER_SOURCE_DOMAINS)
    if not is_leakporner_source:
        raise HTTPException(400, detail="Not a LeakPorner or HornySimp video")

    logging.info(f"[LeakPornerJIT] Re-extracting stream for video {video_id}: {source_url}")

    try:
        if "hornysimp" in source_url.lower():
            from app.extractors.hornysimp import HornySimpExtractor
            extractor = HornySimpExtractor()
        else:
            from app.extractors.leakporner import LeakPornerExtractor
            extractor = LeakPornerExtractor()

        result = await extractor.extract(source_url)

        if not result or not result.get("stream_url"):
            raise HTTPException(502, detail="Extractor could not find a fresh stream URL.")

        stream_url = result["stream_url"]
        is_hls = result.get("is_hls", True)

        # Update DB so next cold start is faster
        try:
            video.url = stream_url
            db.commit()
        except Exception:
            db.rollback()

        _leakporner_stream_cache[video_id] = {"stream_url": stream_url, "is_hls": is_hls, "ts": time.time()}
        logging.info(f"[LeakPornerJIT] Fresh token for video {video_id}: {stream_url[:80]}")

        return {"stream_url": stream_url, "is_hls": is_hls, "cached": False}

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[LeakPornerJIT] Extraction failed for video {video_id}: {e}")
        raise HTTPException(500, detail=f"LeakPorner extraction error: {e}")

# --- BUNKR JIT STREAMING ENDPOINT ---

_cyberfile_stream_cache: dict[int, dict[str, Any]] = {}


@api_v1_router.get("/stream/cyberfile/{video_id}")
@api_legacy_router.get("/stream/cyberfile/{video_id}")
async def get_cyberfile_stream(video_id: int, force: bool = False, db: Session = Depends(get_db)):
    """Resolve a CyberFile page only when a user asks to play it.

    CyberFile rate-limits its media CDN aggressively.  Folder imports therefore
    retain public file pages and this route serializes the short-lived CDN token
    acquisition instead of eagerly opening every media file.
    """
    import time

    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")
    source_url = video.source_url or video.url or ""
    if "cyberfile.me" not in source_url.lower():
        raise HTTPException(400, detail="Not a CyberFile video")

    cached = _cyberfile_stream_cache.get(video_id)
    if not force and cached and time.time() - float(cached.get("ts") or 0) < 8 * 60:
        return {"stream_url": cached["stream_url"], "cached": True}

    try:
        from app.extractors.cyberfile import CyberFileExtractor
        result = await CyberFileExtractor().extract(source_url)
        stream_url = str((result or {}).get("stream_url") or "").strip()
        if not stream_url:
            raise HTTPException(502, detail="CyberFile did not provide a stream URL")
        video.url = stream_url
        db.commit()
        _cyberfile_stream_cache[video_id] = {"stream_url": stream_url, "ts": time.time()}
        logging.info("[CyberFileJIT] Resolved fresh stream for video %s", video_id)
        return {"stream_url": stream_url, "cached": False}
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        logging.warning("[CyberFileJIT] Stream resolve failed for video %s: %s", video_id, exc)
        raise HTTPException(502, detail="CyberFile stream could not be refreshed")

@api_v1_router.get("/stream/filester/{video_id}")
@api_legacy_router.get("/stream/filester/{video_id}")
async def get_filester_stream(video_id: int, db: Session = Depends(get_db)):
    """JIT-resolve a fresh Filester / FileDitch CDN stream URL from source_url."""
    from app.extractors.filester import FilesterExtractor, is_fileditch_url

    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    page_url = ""
    for candidate in (video.source_url or "", video.url or ""):
        low = candidate.lower()
        if ("filester." in low and "/d/" in low) or is_fileditch_url(candidate):
            page_url = candidate
            break
    if not page_url:
        raise HTTPException(400, detail="Not a Filester or FileDitch video")

    extractor = FilesterExtractor()
    result = await extractor.extract(page_url)
    if not result or not result.get("stream_url"):
        raise HTTPException(502, detail="Filester/FileDitch extractor could not find stream URL")

    stream_url = result["stream_url"]
    try:
        video.url = stream_url
        video.last_checked = datetime.datetime.now()
        db.commit()
    except Exception:
        db.rollback()
    return {"stream_url": stream_url, "cached": False}


@api_v1_router.get("/stream/turbo/{video_id}")
@api_legacy_router.get("/stream/turbo/{video_id}")
async def get_turbo_stream(video_id: int, db: Session = Depends(get_db)):
    """JIT-resolve a fresh Turbo.cr CDN stream URL."""
    from app.extractors.turbo import TurboExtractor

    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    page_url = ""
    for candidate in (video.source_url or "", video.url or ""):
        if "turbo.cr/" in candidate.lower() and "/v/" in candidate.lower():
            page_url = candidate
            break
    if not page_url:
        page_url = _turbo_page_url_from_cdn(video.url or "") or _turbo_page_url_from_cdn(video.source_url or "") or ""
    if not page_url:
        raise HTTPException(400, detail="Not a Turbo video")

    result = await TurboExtractor().extract(page_url)
    if not result or not result.get("stream_url"):
        raise HTTPException(502, detail="Turbo extractor could not find stream URL")

    stream_url = result["stream_url"]
    try:
        video.url = stream_url
        video.last_checked = datetime.datetime.now()
        db.commit()
    except Exception:
        db.rollback()
    return {"stream_url": stream_url, "cached": False}


@api_v1_router.get("/stream/bunkr/{video_id}")
@api_legacy_router.get("/stream/bunkr/{video_id}")
async def get_bunkr_stream(video_id: int, db: Session = Depends(get_db), force: bool = False):
    """
    JIT-resolve a fresh Bunkr stream URL.
    Called by the frontend player when a video has a page URL instead of a direct link,
    or when a token expires.
    """
    import time
    from app.extractors.bunkr import BUNKR_DOMAINS

    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    source_url = video.source_url or video.url or ""
    if not any(d in source_url.lower() for d in BUNKR_DOMAINS):
        if not any(d in (video.url or "").lower() for d in BUNKR_DOMAINS):
            raise HTTPException(400, detail="Not a Bunkr video")
        source_url = video.url

    logging.info(f"[BunkrJIT] Re-extracting stream for video {video_id}: {source_url}")

    try:
        from app.extractors.bunkr import BunkrExtractor
        extractor = BunkrExtractor()
        from app.streaming.resolution import get_resolver
        result, cached = await get_resolver().resolve(
            ("bunkr", video_id, source_url), lambda: extractor.extract(source_url),
            reusable=True, force=force, timeout=15)

        if not result or not result.get("stream_url"):
            raise HTTPException(502, detail="Bunkr extractor could not find stream URL. The video may be deleted.")

        stream_url = result["stream_url"]

        # Update the stored URL in DB
        try:
            video.url = stream_url
            db.commit()
            logging.info(f"[BunkrJIT] Successfully updated video {video_id} URL in DB")
        except Exception as db_err:
            db.rollback()
            logging.error(f"[BunkrJIT] Failed to save updated URL to DB for video {video_id}: {db_err}")

        return {"stream_url": stream_url, "cached": cached}

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[BunkrJIT] Extraction failed for video {video_id}: {e}")
        raise HTTPException(500, detail=f"Bunkr extraction error: {e}")

@api_v1_router.get("/stream/pornone/{video_id}")
@api_legacy_router.get("/stream/pornone/{video_id}")
async def get_pornone_stream(video_id: int, db: Session = Depends(get_db)):
    """JIT-resolve a direct MP4 stream URL from a stored PornOne watch-page URL."""
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    page_url = video.source_url or video.url or ""
    if "pornone.com" not in page_url:
        page_url = video.url or ""
    if "pornone.com" not in page_url:
        raise HTTPException(400, detail="Not a PornOne video")

    logging.info(f"[PornOneJIT] Extracting stream for video {video_id}: {page_url}")
    try:
        from app.extractors.pornone import PornOneExtractor
        ext = PornOneExtractor()
        result = await ext.extract(page_url)

        if not result or not result.get("stream_url"):
            raise HTTPException(502, detail="PornOne extractor could not find stream URL. The video may be deleted or Cloudflare-blocked.")

        stream_url = result["stream_url"]
        try:
            video.url = stream_url
            db.commit()
            logging.info(f"[PornOneJIT] Updated video {video_id} URL in DB")
        except Exception as db_err:
            db.rollback()
            logging.error(f"[PornOneJIT] DB update failed for video {video_id}: {db_err}")

        return {"stream_url": stream_url, "cached": False}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[PornOneJIT] Extraction failed for video {video_id}: {e}")
        raise HTTPException(500, detail=f"PornOne extraction error: {e}")


@api_v1_router.get("/stream/eporner/{video_id}")
@api_legacy_router.get("/stream/eporner/{video_id}")
async def get_eporner_stream_jit(video_id: int, db: Session = Depends(get_db)):
    """JIT-extract a fresh EPorner stream from the watch page.
    CDN URLs (gvideo / vid-s10-...) can be IP-signed or rate-limited — resolve
    from the watch page before each playback session instead of trusting a stale CDN URL.
    """
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    watch_url = video.source_url or ""
    if "eporner.com" not in watch_url:
        watch_url = video.url or ""
    if "eporner.com" not in watch_url:
        raise HTTPException(400, detail="Not an EPorner video")

    # Strip CDN URL down to watch page if needed
    if not any(ext in watch_url for ext in ["/video-", "/hd-porn/"]):
        raise HTTPException(400, detail="No EPorner watch page URL available")

    # Reuse the previously resolved CDN URL while its embedded signature is still
    # valid — eporner dload URLs carry "/{expiry_epoch}_{ip}_{...}/" in the path,
    # so re-scraping the watch page on EVERY play is wasted latency.
    cached = video.url or ""
    if "eporner.com" in cached and "/video-" not in cached:
        m_exp = re.search(r"/(\d{10})_[\d.]+_", cached)
        if m_exp and int(m_exp.group(1)) > time.time() + 300:
            logging.info(f"[EpornerJIT] Reusing signed URL for video {video_id} (valid until {m_exp.group(1)})")
            return {"stream_url": cached, "resolver": "cached"}

    logging.info(f"[EpornerJIT] Re-extracting stream for video {video_id}: {watch_url[:80]}")
    try:
        from .extractors.eporner import EpornerExtractor

        extractor = EpornerExtractor()
        data = await asyncio.wait_for(extractor.extract(watch_url), timeout=25)
        stream_url = str((data or {}).get("stream_url") or "").strip()
        if not stream_url:
            raise HTTPException(502, detail="Eporner extractor could not resolve a playable stream URL")
        logging.info(f"[EpornerJIT] Got fresh URL: {stream_url[:80]}")

        try:
            video.url = stream_url
            if data and data.get("height"):
                video.height = int(data.get("height") or 0)
            if data and data.get("width"):
                video.width = int(data.get("width") or 0)
            if data and data.get("duration") and not video.duration:
                video.duration = float(data.get("duration") or 0)
            db.commit()
        except Exception as db_err:
            db.rollback()
            logging.warning(f"[EpornerJIT] DB update failed: {db_err}")

        return {
            "stream_url": stream_url,
            "resolver": (data or {}).get("_resolver") or "unknown",
        }
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[EpornerJIT] Failed for video {video_id}: {e}")
        raise HTTPException(500, detail=f"EPorner JIT error: {e}")


@api_v1_router.get("/stream/redtube/{video_id}")
@api_legacy_router.get("/stream/redtube/{video_id}")
async def get_redtube_stream_jit(video_id: int, db: Session = Depends(get_db)):
    """Resolve a fresh RedTube stream for a video saved in the library."""
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    watch_url = video.source_url or ""
    if "redtube.com" not in watch_url.lower():
        watch_url = video.url or ""
    if "redtube.com" not in watch_url.lower():
        raise HTTPException(400, detail="Not a RedTube video")

    logging.info("[RedTubeJIT] Resolving stream for video %s: %s", video_id, watch_url[:100])
    try:
        from .extractors.redtube import RedTubeExtractor

        data = await asyncio.wait_for(RedTubeExtractor().extract(watch_url), timeout=40)
        stream_url = str((data or {}).get("stream_url") or "").strip()
        if not stream_url:
            raise HTTPException(502, detail="RedTube extractor could not resolve a playable stream URL")

        try:
            video.url = stream_url
            if data.get("height"):
                video.height = int(data["height"])
            if data.get("width"):
                video.width = int(data["width"])
            if data.get("duration") and not video.duration:
                video.duration = float(data["duration"])
            db.commit()
        except Exception as db_err:
            db.rollback()
            logging.warning("[RedTubeJIT] DB update failed for video %s: %s", video_id, db_err)

        return {"stream_url": stream_url, "is_hls": bool(data.get("is_hls")), "resolver": "redtube"}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("[RedTubeJIT] Extraction failed for video %s: %s", video_id, e)
        raise HTTPException(502, detail=f"RedTube stream extraction failed: {e}")


@api_v1_router.get("/stream/resolve/{video_id}")
@api_legacy_router.get("/stream/resolve/{video_id}")
async def resolve_library_video_stream(video_id: int, db: Session = Depends(get_db), force: bool = False):
    """Refresh a library video's direct stream through its registered extractor.

    The stable source page is authoritative; stored CDN URLs can expire or be
    invalidated while the library card still looks healthy.
    """
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")
    from .telegram_service import verify_telegram_library_video
    telegram_refresh = await verify_telegram_library_video(video)
    if telegram_refresh is not None:
        try:
            video.last_checked = datetime.datetime.now()
            db.commit()
        except Exception:
            db.rollback()
        if not telegram_refresh.get("supported"):
            raise HTTPException(404, detail=telegram_refresh.get("reason") or "Telegram video is no longer available")
        return telegram_refresh
    storage_lower = (video.storage_type or "remote").lower()
    raw_video_url = str(video.url or "").strip()
    if storage_lower == "mega" or raw_video_url.startswith("mega:"):
        return {"supported": True, "stream_url": f"/api/v1/mega/stream/{video.id}", "is_hls": False}
    if storage_lower == "local" and raw_video_url.startswith("/") and not raw_video_url.startswith("//"):
        return {"supported": True, "stream_url": raw_video_url, "is_hls": False}
    if storage_lower not in {"remote", "cdn_direct", ""}:
        return {"supported": False, "reason": "not a remote video"}

    from app.media_urls import media_refresh_source, is_forum_context_url
    source_url = media_refresh_source(video.url, video.source_url).strip()
    if is_forum_context_url(video.source_url):
        # Prefer the durable provider page retained by the original import job.
        from app.database import ImportJobItem
        origin_item = db.query(ImportJobItem).filter(ImportJobItem.video_id == video_id).order_by(ImportJobItem.id.desc()).first()
        if origin_item and origin_item.url and not is_forum_context_url(origin_item.url):
            source_url = origin_item.url
        if not is_forum_context_url(source_url):
            video.source_url = source_url
            db.commit()
    stored_url = str(video.url or "").strip()
    if is_forum_context_url(source_url):
        turbo_page = _turbo_page_url_from_cdn(stored_url)
        if turbo_page:
            source_url = turbo_page
    # Intake album candidates can carry the shared Filester /f/ URL as their
    # source_url while url is the individual /d/ page. The folder cannot
    # resolve a single stream. Keep the per-file page before replacing url
    # with the short-lived CDN token below.
    if (
        "filester." in source_url.lower() and "/f/" in source_url.lower()
        and "filester." in stored_url.lower() and "/d/" in stored_url.lower()
    ):
        source_url = stored_url
        video.source_url = stored_url
        try:
            db.commit()
        except Exception:
            db.rollback()
            logging.warning("[PlaybackJIT] Could not retain Filester file page for video %s", video_id)
    # Webshare search imports keep a stable pseudo-URL instead of a source page.
    # Resolve that ident with Webshare's API, then let playback use the local
    # range proxy so expired download links can be refreshed again on demand.
    if source_url.startswith("webshare:") or "wsfiles.cz" in source_url.lower():
        from app.extractors.legacy.webshare import WebshareAPI, parse_webshare_ident

        ident = parse_webshare_ident(source_url) or parse_webshare_ident(stored_url)
        if not ident:
            return {"supported": False, "reason": "Webshare file ident missing"}
        fresh_url = await asyncio.to_thread(WebshareAPI().get_vip_link, ident)
        if not fresh_url:
            return {"supported": False, "reason": "Webshare link unavailable"}
        video.url = fresh_url
        db.commit()
        return {"supported": True, "stream_url": fresh_url, "is_hls": False}

    if not source_url.startswith(("http://", "https://")):
        return {"supported": False, "reason": "no source page URL"}

    try:
        from .extractors import init_registry, register_extended_extractors
        from .extractors.registry import ExtractorRegistry
        from .extractors.filester import is_fileditch_url

        data = None
        extractor_name = ""
        stored_candidate = str(video.url or "").strip()

        # FileDitch viewer URLs look like MP4s but serve HTML. If a previous
        # resolve already cached a different signed CDN URL, validate that tiny
        # range first and start playback immediately. Re-running the PoW for
        # every click needlessly burns time and can trigger the provider's rate
        # limit; a dead/expired candidate simply falls through to extraction.
        if (
            is_fileditch_url(source_url)
            and stored_candidate.startswith(("http://", "https://"))
            and stored_candidate != source_url
            and not is_fileditch_url(stored_candidate)
        ):
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
                "Range": "bytes=0-1",
                "Referer": source_url,
            }
            try:
                timeout = aiohttp.ClientTimeout(total=8)
                async with aiohttp.ClientSession(timeout=timeout) as probe_session:
                    async with probe_session.get(stored_candidate, headers=headers, ssl=False) as probe:
                        content_type = (probe.headers.get("Content-Type") or "").lower()
                        if probe.status in (200, 206) and (
                            content_type.startswith("video/") or "octet-stream" in content_type
                        ):
                            data = {"stream_url": stored_candidate, "is_hls": False}
                            extractor_name = "FileDitch"
                            logging.info("[PlaybackJIT] Reusing live FileDitch CDN stream for video %s", video_id)
            except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as probe_error:
                logging.info("[PlaybackJIT] Stored FileDitch stream probe failed for video %s: %s", video_id, probe_error)

        init_registry()
        register_extended_extractors()
        extractor = ExtractorRegistry.find_extractor(source_url)
        if not extractor:
            turbo_fallback = _turbo_page_url_from_cdn(stored_candidate)
            if turbo_fallback:
                source_url = turbo_fallback
                extractor = ExtractorRegistry.find_extractor(source_url)
        if data is None and extractor:
            from app.extractors.circuit_breaker import extractor_circuit_breaker
            allowed, retry_after = extractor_circuit_breaker.allow(source_url)
            if not allowed:
                raise HTTPException(
                    503,
                    detail=f"Doména je dočasne utlmená po opakovaných chybách (skús znova o {int(retry_after)} s).",
                    headers={"Retry-After": str(max(1, int(retry_after)))},
                )
            label_for_url = getattr(extractor, "source_label", None)
            extractor_name = label_for_url(source_url) if callable(label_for_url) else extractor.name
            logging.info("[PlaybackJIT] Resolving video %s via %s", video_id, extractor_name)
            from app.streaming.resolution import get_resolver
            reusable_provider = extractor.name.lower() in {"bunkr", "turbo", "filester", "eporner", "sxyprn"}
            try:
                data, _ = await get_resolver().resolve(
                    ("bunkr" if extractor.name.lower() == "bunkr" else extractor.name, video_id, source_url),
                    lambda: extractor.extract(source_url),
                    reusable=reusable_provider,
                    force=force,
                    timeout=40,
                )
            except Exception as ext_exc:
                extractor_circuit_breaker.record_failure(source_url, type(ext_exc).__name__)
                raise
            if isinstance(data, dict) and data.get("stream_url"):
                extractor_circuit_breaker.record_success(source_url)
            else:
                extractor_circuit_breaker.record_failure(source_url, "empty stream_url")

        # DrTuber's player configuration is session-bound and its current
        # yt-dlp response is not a single media record.  Its hub adapter
        # reproduces the provider player flow (watch page -> signed config),
        # so use that specialized resolver before the generic yt-dlp fallback.
        if not str((data or {}).get("stream_url") or "").strip() and "drtuber.com" in source_url.lower():
            from .hubs import registry as hub_registry

            hub_registry.init_hubs()
            drtuber = hub_registry.get("drtuber")
            if drtuber:
                extractor_name = drtuber.label
                logging.info("[PlaybackJIT] Resolving video %s via %s player config", video_id, extractor_name)
                data = await asyncio.wait_for(drtuber.resolve(source_url), timeout=40)

        # Registered extractors cover the known providers. yt-dlp remains the
        # safe fallback for an older card whose site was not registered yet.
        if not str((data or {}).get("stream_url") or "").strip():
            from .extractors.media_router import default_router

            fallback = await asyncio.to_thread(default_router.extract, source_url)
            if fallback:
                data = fallback.to_dict()
                extractor_name = data.get("extractor") or "yt_dlp"

        stream_url = str((data or {}).get("stream_url") or "").strip()
        if not stream_url:
            label = extractor_name or "No available extractor"
            raise HTTPException(502, detail=f"{label} did not return a playable stream")

        # PornhubExtractor has already probed this candidate using requests,
        # the same transport used by the Pornhub manifest and segment proxy.
        # Re-probing with aiohttp here rejected streams that the proxy can play.

        try:
            video.url = stream_url
            if data.get("height"):
                video.height = int(data["height"])
            if data.get("width"):
                video.width = int(data["width"])
            if data.get("duration") and not video.duration:
                video.duration = float(data["duration"])
            db.commit()
        except Exception as db_err:
            db.rollback()
            logging.warning("[PlaybackJIT] Could not cache stream for video %s: %s", video_id, db_err)

        # Some providers bind the signed CDN URL to the cookies that opened
        # their watch page.  Keep that jar only in the local process and give
        # the browser a random, short-lived proxy-session id instead.
        proxy_session = ""
        proxy_cookies = (data or {}).get("proxy_cookies")
        if isinstance(proxy_cookies, dict) and proxy_cookies:
            proxy_session = secrets.token_urlsafe(18)
            _embed_proxy_sessions[proxy_session] = {
                "ts": time.time(),
                "cookies": {str(key): str(value) for key, value in proxy_cookies.items() if value},
                "referer": source_url,
            }

        return {
            "supported": True,
            "stream_url": stream_url,
            "is_hls": bool(data.get("is_hls")) or ".m3u8" in stream_url.lower(),
            "extractor": extractor_name,
            "proxy_session": proxy_session,
            "playback_referer": data.get("playback_referer") or source_url,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logging.warning("[PlaybackJIT] Resolve failed for video %s: %s", video_id, exc)
        raise HTTPException(502, detail=f"Playback refresh failed: {exc}")


@api_v1_router.get("/stream/xhamster/{video_id}")
@api_legacy_router.get("/stream/xhamster/{video_id}")
async def get_xhamster_stream_jit(video_id: int, db: Session = Depends(get_db)):
    """JIT-extract a fresh xHamster stream from the watch page."""
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    watch_url = video.source_url or ""
    if "xhamster.com" not in watch_url:
        watch_url = video.url or ""
    if "xhamster.com" not in watch_url:
        raise HTTPException(400, detail="Not an xHamster video")

    logging.info(f"[xHamsterJIT] Re-extracting stream for video {video_id}: {watch_url[:80]}")
    try:
        from app.extractors.xhamster import XHamsterExtractor

        extractor = XHamsterExtractor()
        data = await asyncio.wait_for(extractor.extract(watch_url), timeout=25)
        stream_url = str((data or {}).get("stream_url") or "").strip()
        if not stream_url:
            raise HTTPException(502, detail="xHamster extractor could not resolve a playable stream URL")
        logging.info(f"[xHamsterJIT] Got fresh URL: {stream_url[:80]}")

        try:
            video.url = stream_url
            if data and data.get("height"):
                video.height = int(data.get("height") or 0)
            if data and data.get("width"):
                video.width = int(data.get("width") or 0)
            if data and data.get("duration") and not video.duration:
                video.duration = float(data.get("duration") or 0)
            db.commit()
        except Exception as db_err:
            db.rollback()
            logging.warning(f"[xHamsterJIT] DB update failed: {db_err}")

        return {
            "stream_url": stream_url,
            "is_hls": bool('.m3u8' in stream_url),
            "resolver": "xhamster_ytdlp",
        }
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[xHamsterJIT] Failed for video {video_id}: {e}")
        raise HTTPException(500, detail=f"xHamster JIT error: {e}")


@api_v1_router.get("/stream/turbo/{video_id}")
@api_legacy_router.get("/stream/turbo/{video_id}")
async def get_turbo_stream_jit(video_id: int, db: Session = Depends(get_db)):
    """JIT-resolve a fresh turbo.cr stream URL.

    The direct `turbo.cr/<hash>.mov` link stored at import time is hotlink-blocked
    (returns 404 server-side), so playback/thumbnail must use a freshly *signed*
    CDN URL from turbo's /api/sign (token expires). We re-run the extractor, which
    fetches the signed URL, and persist it (best-effort; it will be re-signed on
    the next playback when the token lapses)."""
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    watch_url = video.source_url or ""
    if "turbo.cr" not in watch_url:
        watch_url = video.url or ""
    if "turbo.cr" not in watch_url:
        raise HTTPException(400, detail="Not a turbo.cr video")

    logging.info(f"[TurboJIT] Re-signing stream for video {video_id}: {watch_url[:80]}")
    try:
        from .extractors.turbo import TurboExtractor

        data = await asyncio.wait_for(TurboExtractor().extract(watch_url), timeout=25)
        stream_url = str((data or {}).get("stream_url") or "").strip()
        if not stream_url:
            raise HTTPException(502, detail="Turbo extractor could not resolve a signed stream URL")
        logging.info(f"[TurboJIT] Got signed URL: {stream_url[:80]}")

        try:
            video.url = stream_url
            if data and data.get("duration") and not video.duration:
                video.duration = float(data.get("duration") or 0)
            if data and data.get("thumbnail") and (not video.thumbnail_path or "turbo.cr" in (video.thumbnail_path or "")):
                # Keep the og:image only if it actually loads; otherwise leave for ffmpeg.
                pass
            db.commit()
        except Exception as db_err:
            db.rollback()
            logging.warning(f"[TurboJIT] DB update failed: {db_err}")

        return {"stream_url": stream_url}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[TurboJIT] Failed for video {video_id}: {e}")
        raise HTTPException(500, detail=f"Turbo JIT error: {e}")


def _sxyprn_stream_referer(stream_url: str, fallback: str) -> str:
    from .sxyprn_playback import provider_referer
    return provider_referer(stream_url, fallback)


def _sxyprn_proxy_provider_headers(stream_url: str, fallback_referer: str) -> dict[str, str]:
    host = (urllib.parse.urlsplit(str(stream_url or "")).hostname or "").lower()
    if host.endswith(("tnmr.org", "cdn-tnmr.org", "97bf1.com", "vidara.so", "vidara.to")):
        from .sxyprn_playback import provider_headers
        return provider_headers(stream_url, fallback_referer)
    return {}


def _sxyprn_embed_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(str(value or "").strip())
    host = (parsed.hostname or "").lower().removeprefix("www.")
    if not (
        host == "bysesukior.com"
        or host.endswith((".vidara.so", ".vidara.to", ".lulu.stream", ".streamtape.com", ".streamtape.to"))
        or host in {
            "vidara.so", "vidara.to", "lulustream.com", "luluvdo.com", "luluvdo.to",
            "streamtape.com", "streamtape.to",
            "luluvid.com", "luluvid.net", "luluvid.top", "luluvids.com",
            "lulust.com", "lulust.to",
        }
    ):
        return ""
    match = re.search(r"/(?:e|v|watch|d)/([a-zA-Z0-9_-]+)(?:/|$)", parsed.path)
    if not match and host in {"lulustream.com", "luluvdo.com", "luluvdo.to"}:
        match = re.fullmatch(r"/([a-zA-Z0-9_-]+)", parsed.path)
    if not match:
        return ""
    code = match.group(1)
    if host.endswith(("streamtape.com", "streamtape.to")):
        return f"https://streamtape.com/e/{code}"
    if host.endswith(("vidara.so", "vidara.to")):
        return f"https://{host}/e/{code}"
    if host in {"lulustream.com", "luluvdo.com", "luluvdo.to", "luluvid.com", "luluvid.net", "luluvid.top", "luluvids.com", "lulust.com", "lulust.to"} or host.endswith(".lulu.stream"):
        return f"https://luluvdo.com/e/{code}"
    return f"https://{host}/e/{code}"


@api_v1_router.get("/stream/sxyprn/{video_id}")
@api_legacy_router.get("/stream/sxyprn/{video_id}")
async def get_sxyprn_stream(
    video_id: int,
    db: Session = Depends(get_db),
    force_refresh: bool = False,
    prefer_embed: bool = False,
):
    """JIT-resolve a fresh DIRECT stream URL for a SxyPrn video (all the way to CDN MP4).
    Strategy:
    0. In-memory cache: if resolved <18 min ago, return cached direct URL
    1. If DB url is already a raw CDN MP4 (sxyprn cdn8), return it directly
    2. Fetch sxyprn post page → find external host (vidara, lulu…)
    3. Deep-resolve the external host URL via its extractor → direct CDN MP4
    4. Fall back to SxyPrn plugin CDN extraction
    5. Last resort: yt-dlp
    """
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    # --- 0. In-memory TTL cache ---
    import time as _time
    if not hasattr(get_sxyprn_stream, '_cache'):
        get_sxyprn_stream._cache = {}
    _SXYPRN_CACHE: dict = get_sxyprn_stream._cache
    _CACHE_TTL = 10 * 60  # 10 minutes
    _now = _time.time()
    cached = _SXYPRN_CACHE.get(video_id)
    if cached and not force_refresh and (_now - cached['ts']) < _CACHE_TTL:
        # Verify cached URL doesn't have an expired timestamp if it's a SxyPrn .vid token
        from .sxyprn_playback import probe_media
        _is_stale_token = not await probe_media(cached.get('url', ''), cached.get('referer') or video.source_url or '')
        _ts_m = re.search(r"/(\d{10})/", cached.get('url', ''))
        if _ts_m and int(_ts_m.group(1)) < _now:
            _is_stale_token = True
        # Do not use cached URL if it's a slow/broken cdn5 / .vid token
        if any(x in (cached.get('url') or '') for x in ('/cdn5/', '.vid')):
            _is_stale_token = True
        if not _is_stale_token:
            logging.info(f"[SxyPrnJIT] Cache hit for video {video_id}: {cached['url'][:60]}")
            c_url = cached['url']
            return {
                "stream_url": c_url,
                "is_hls": ".m3u8" in c_url.lower(),
                "referer": _sxyprn_stream_referer(
                    c_url, cached.get("referer") or video.source_url or ""
                ),
                "cached": True
            }

    source = video.source_url or ""
    current_url = video.url or ""
    post_url = source if "sxyprn" in source else current_url

    current_embed_url = _sxyprn_embed_url(current_url)
    if current_embed_url:
        return {"embed_url": current_embed_url, "is_hls": False, "referer": post_url}

    # --- 1. Fast path: current URL is already a raw sxyprn CDN8 (cdn8 = already resolved) ---
    _is_sxyprn_cdn8 = "sxyprn" in current_url and "/cdn8/" in current_url
    if _is_sxyprn_cdn8 and not force_refresh:
        from .sxyprn_playback import probe_media
        _is_sxyprn_cdn8 = await probe_media(current_url, post_url)
    if _is_sxyprn_cdn8 and not force_refresh:
        logging.info(f"[SxyPrnJIT] Fast-path: CDN8 URL still in DB for video {video_id}")
        _SXYPRN_CACHE[video_id] = {'url': current_url, 'ts': _now}
        return {"stream_url": current_url, "is_hls": False, "fast_path": True}

    post_id_match = re.search(r"/post/([a-f0-9]+)(?:\.html)?", post_url)
    post_page_url = post_url if "sxyprn" in post_url else None

    if prefer_embed and post_id_match:
        try:
            streams = await asyncio.to_thread(fetch_post_streams, post_id_match.group(1), post_url)
            for stream in streams or []:
                embed_url = _sxyprn_embed_url(stream.get("url", ""))
                if embed_url:
                    return {"embed_url": embed_url, "is_hls": False, "referer": post_url}
        except Exception as ex:
            logging.warning("[SxyPrnJIT] Preferred embed lookup failed for video %s: %s", video_id, ex)

    logging.info(f"[SxyPrnJIT] Re-fetching stream for video {video_id}, post={post_page_url or 'unknown'}")

    best_url = None
    best_is_hls = False

    # --- 2. Primary: Try SxyPrn extractor (which prioritizes Vidara/LuluStream HLS) ---
    if post_page_url:
        try:
            from .extractors.sxyprn import SxyPrnExtractor
            _sx_ext = SxyPrnExtractor()
            logging.info(f"[SxyPrnJIT] Trying SxyPrn extractor on post page: {post_page_url[:60]}")
            sx_result = await _sx_ext.extract(post_page_url)
            if sx_result and sx_result.get("stream_url"):
                best_url = sx_result["stream_url"]
                best_is_hls = sx_result.get("is_hls", False) or (".m3u8" in best_url.lower())
                logging.info(f"[SxyPrnJIT] SxyPrn extractor stream: {best_url[:80]} (is_hls={best_is_hls})")
        except Exception as ex:
            logging.warning(f"[SxyPrnJIT] SxyPrn extractor failed: {ex}")

    # --- 3. Fallback: Fetch external host links directly if extractor didn't find one ---
    if not best_url and post_id_match:
        try:
            streams = await asyncio.to_thread(fetch_post_streams, post_id_match.group(1), post_url)
            # Mirrors saved at import time (post page may expose none)
            try:
                from .database import VideoSource as _VS
                _have = {s.get("url") for s in (streams or [])}
                for _row in db.query(_VS).filter(_VS.video_id == video_id).all():
                    if _row.url and _row.url not in _have and not _row.is_primary:
                        streams = (streams or []) + [{"url": _row.url}]
            except Exception as _ex:
                logging.debug("[SxyPrnJIT] stored mirrors lookup failed: %s", _ex)
            if streams:
                from .sxyprn_discovery import probe_best_post_streams
                probed = await probe_best_post_streams(
                    streams,
                    duration_sec=int(video.duration or 0),
                    fallback_height=int(video.height or 0),
                    fallback_size_mb=float(video.file_size_mb or 0.0),
                )
                best_cand = probed.get("best")
                if best_cand and best_cand.get("is_direct_stream") and best_cand.get("stream_url"):
                    best_url = best_cand["stream_url"]
                    best_is_hls = bool(best_cand.get("is_hls", ".m3u8" in best_url.lower()))
                if not best_url:
                    best_url = streams[0]["url"]
                    best_is_hls = ".m3u8" in best_url.lower()
                logging.info(f"[SxyPrnJIT] Found external fallback: {best_url[:80]}")
        except Exception as ex:
            logging.debug(f"[SxyPrnJIT] External links fetch failed: {ex}")

    # --- 5. Last resort: yt-dlp from post page ---
    if not best_url and post_page_url:
        try:
            def _ydl():
                import yt_dlp
                opts = {
                    "quiet": True, "no_warnings": True,
                    "format": "best",
                    "extract_flat": False,
                    "socket_timeout": 20,
                    "http_headers": {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        "Referer": "https://sxyprn.com/",
                    },
                }
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(post_page_url, download=False)
                    if info:
                        return info.get("url") or (info.get("formats") or [{}])[-1].get("url")
                return None
            best_url = await asyncio.to_thread(_ydl)
            if best_url:
                best_is_hls = ".m3u8" in best_url.lower()
                logging.info(f"[SxyPrnJIT] yt-dlp extracted: {best_url[:80]}")
        except Exception as ex:
            logging.warning(f"[SxyPrnJIT] yt-dlp fallback failed: {ex}")

    if not best_url:
        raise HTTPException(502, detail="Could not extract fresh stream URL for this SxyPrn video")

    from .sxyprn_playback import probe_media
    media_referer = _sxyprn_stream_referer(best_url, post_url)
    if not await probe_media(best_url, media_referer):
        embed_url = ""
        if post_id_match:
            try:
                streams = await asyncio.to_thread(
                    fetch_post_streams, post_id_match.group(1), post_url
                )
                embed_candidates = [
                    _sxyprn_embed_url(stream.get("url", "")) for stream in streams
                ]
                embed_url = next((candidate for candidate in embed_candidates if candidate), "")
            except Exception as ex:
                logging.warning("[SxyPrnJIT] Embed fallback lookup failed for video %s: %s", video_id, ex)
        if embed_url:
            logging.info("[SxyPrnJIT] Returning external embed fallback for video %s", video_id)
            return {"embed_url": embed_url, "is_hls": False, "referer": post_url}
        _SXYPRN_CACHE.pop(video_id, None)
        raise HTTPException(502, detail="Zdroj SxyPrn momentálne neposkytuje prehrateľné video. Stream hostiteľa je nedostupný; prehrávač ani neplatný odkaz neboli uložené ako nový stream.")

    # Update DB with fresh URL
    try:
        video.url = best_url
        db.commit()
    except Exception as db_err:
        db.rollback()
        logging.warning(f"[SxyPrnJIT] DB update failed: {db_err}")

    # Store in cache
    _SXYPRN_CACHE[video_id] = {'url': best_url, 'ts': _now, 'referer': media_referer}
    logging.info(f"[SxyPrnJIT] Final stream for video {video_id}: {best_url[:80]}")

    return {"stream_url": best_url, "is_hls": best_is_hls, "referer": media_referer}






@api_v1_router.get("/stream/tnaflix/{video_id}")
@api_legacy_router.get("/stream/tnaflix/{video_id}")
async def get_tnaflix_stream(video_id: int, db: Session = Depends(get_db)):
    """JIT-resolve a direct MP4/HLS stream URL from a stored Tnaflix watch-page URL."""
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    # Prefer source_url when it looks like a watch page (www.tnaflix.com/category/.../videoNNN)
    def _is_tnaflix_watch_page(u: str) -> bool:
        ul = (u or "").lower()
        return "www.tnaflix.com" in ul and "/video" in ul

    source = video.source_url or ""
    url_field = video.url or ""
    if _is_tnaflix_watch_page(source):
        page_url = source
    elif _is_tnaflix_watch_page(url_field):
        page_url = url_field
    else:
        # Neither looks like a watch page — check if anything contains tnaflix at all
        page_url = source if "tnaflix.com" in source else url_field
        if "tnaflix.com" not in page_url:
            raise HTTPException(400, detail="Not a Tnaflix video")

    logging.info(f"[TnaflixJIT] Extracting stream for video {video_id}: {page_url}")
    try:
        from app.extractors.tnaflix import TnaflixExtractor
        ext = TnaflixExtractor()
        result = await asyncio.to_thread(ext.extract, page_url)

        if not result or not result.get("stream_url"):
            raise HTTPException(502, detail="Tnaflix extractor could not find stream URL. The video may be deleted or geo-blocked.")

        stream_url = result["stream_url"]
        try:
            video.url = stream_url
            if result.get("title") and (not video.title or video.title in ("Queued...", "Tnaflix Video")):
                video.title = result["title"]
            if result.get("thumbnail") and not video.thumbnail_path:
                video.thumbnail_path = result["thumbnail"]
            if result.get("duration") and not video.duration:
                video.duration = result["duration"]
            db.commit()
            logging.info(f"[TnaflixJIT] Updated video {video_id} URL in DB: {stream_url[:80]}")
        except Exception as db_err:
            db.rollback()
            logging.error(f"[TnaflixJIT] DB update failed for video {video_id}: {db_err}")

        return {"stream_url": stream_url, "cached": False}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[TnaflixJIT] Extraction failed for video {video_id}: {e}")
        raise HTTPException(500, detail=f"Tnaflix extraction error: {e}")


@api_v1_router.get("/stream/streamtape/{video_id}")
@api_legacy_router.get("/stream/streamtape/{video_id}")
async def get_streamtape_stream(video_id: int, db: Session = Depends(get_db)):
    """JIT-resolve a direct stream URL from a stored Streamtape watch-page URL."""
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, detail="Video not found")

    page_url = video.source_url or video.url or ""
    if "streamtape.com" not in page_url:
        page_url = video.url or ""
    if "streamtape.com" not in page_url:
        raise HTTPException(400, detail="Not a Streamtape video")

    # If already resolved (url contains get_video), return immediately
    if "get_video" in (video.url or ""):
        return {"stream_url": video.url, "cached": True}

    logging.info(f"[StreamtapeJIT] Extracting stream for video {video_id}: {page_url}")
    try:
        from app.extractors.streamtape import StreamtapeExtractor
        ext = StreamtapeExtractor()
        result = await ext.extract(page_url)

        if not result or not result.get("stream_url"):
            raise HTTPException(502, detail="Streamtape extractor could not find stream URL.")

        stream_url = result["stream_url"]
        needs_thumb = not video.thumbnail_path
        try:
            video.url = stream_url
            if result.get("title") and video.title in ("", "oopps", None):
                video.title = result["title"]
            db.commit()
            logging.info(f"[StreamtapeJIT] Updated video {video_id} URL in DB")
        except Exception as db_err:
            db.rollback()
            logging.error(f"[StreamtapeJIT] DB update failed: {db_err}")

        # Generate thumbnail via fast ffmpeg seek in background if missing
        if needs_thumb:
            def _gen_thumb_fast(vid_id, url, referer):
                try:
                    import subprocess, os, shutil
                    from app.services import THUMB_DIR, FFMPEG_CMD, FFMPEG_NETWORK_ARGS
                    if not shutil.which(FFMPEG_CMD):
                        return
                    thumb_out = os.path.join(THUMB_DIR, f"thumb_{vid_id}.jpg")
                    headers_str = (
                        f"Referer: {referer}\r\n"
                        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\n"
                    )
                    # Input-side seek (-ss before -i) = container seek, no data downloaded before seek point
                    cmd = (
                        [FFMPEG_CMD, '-y', '-hide_banner', '-loglevel', 'error']
                        + FFMPEG_NETWORK_ARGS
                        + ['-headers', headers_str, '-ss', '5', '-i', url,
                           '-vframes', '1', '-vf', 'scale=640:-1', '-q:v', '4', thumb_out]
                    )
                    result = subprocess.run(cmd, timeout=15, capture_output=True)
                    if result.returncode != 0 or not os.path.exists(thumb_out):
                        # Fallback: seek to 0
                        cmd2 = (
                            [FFMPEG_CMD, '-y', '-hide_banner', '-loglevel', 'error']
                            + FFMPEG_NETWORK_ARGS
                            + ['-headers', headers_str, '-i', url,
                               '-vframes', '1', '-vf', 'scale=640:-1', '-q:v', '4', thumb_out]
                        )
                        subprocess.run(cmd2, timeout=15, capture_output=True)
                    if os.path.exists(thumb_out):
                        from app.database import SessionLocal
                        _db = SessionLocal()
                        try:
                            _v = _db.query(Video).get(vid_id)
                            if _v:
                                _v.thumbnail_path = f"/static/thumbnails/thumb_{vid_id}.jpg"
                                _db.commit()
                                logging.info(f"[StreamtapeJIT] Thumbnail generated for video {vid_id}")
                        finally:
                            _db.close()
                except Exception as te:
                    logging.warning(f"[StreamtapeJIT] Thumb gen failed for {vid_id}: {te}")
            import threading
            threading.Thread(target=_gen_thumb_fast, args=(video_id, stream_url, "https://streamtape.com/"), daemon=True).start()

        return {"stream_url": stream_url, "cached": False}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[StreamtapeJIT] Extraction failed for video {video_id}: {e}")
        raise HTTPException(500, detail=f"Streamtape extraction error: {e}")


# --- THUMBNAIL PROXY ---

@app.get("/thumb_proxy")
async def thumb_proxy(url: str, referer: str = ""):
    """Fetch each remote thumbnail once, then serve it from the local disk cache."""
    url = _require_public_proxy_url(url)

    cache_path, metadata_path, cache_key = _thumbnail_cache_paths(url)
    if cache_path.is_file():
        return FileResponse(
            cache_path,
            media_type=await _thumbnail_media_type(metadata_path),
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": referer or url,
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
    }

    lock = await _thumbnail_cache_lock(cache_key)
    try:
        async with lock:
            # Another request may have populated this URL while this request
            # waited on the per-URL lock.
            if cache_path.is_file():
                return FileResponse(
                    cache_path,
                    media_type=await _thumbnail_media_type(metadata_path),
                    headers={"Cache-Control": "public, max-age=31536000, immutable"},
                )

            await asyncio.to_thread(THUMBNAIL_CACHE_DIR.mkdir, parents=True, exist_ok=True)
            temp_path = THUMBNAIL_CACHE_DIR / f"{cache_key}.{uuid.uuid4().hex}.tmp"
            bytes_written = 0

            if thumbnail_http_client is None:
                raise HTTPException(503, detail="Thumbnail client is not ready")
            async with thumbnail_http_client.stream("GET", url, headers=headers) as upstream:
                if upstream.status_code != 200:
                    raise HTTPException(502, detail=f"Upstream returned {upstream.status_code}")

                content_type = upstream.headers.get("content-type", "image/jpeg").split(";", 1)[0].strip().lower()
                if not content_type.startswith("image/"):
                    raise HTTPException(502, detail="Upstream did not return an image")
                if int(upstream.headers.get("content-length", "0") or 0) > THUMBNAIL_CACHE_MAX_BYTES:
                    raise HTTPException(413, detail="Thumbnail exceeds cache size limit")

                try:
                    with temp_path.open("wb") as output:
                        async for chunk in upstream.aiter_bytes(64 * 1024):
                            bytes_written += len(chunk)
                            if bytes_written > THUMBNAIL_CACHE_MAX_BYTES:
                                raise HTTPException(413, detail="Thumbnail exceeds cache size limit")
                            await asyncio.to_thread(output.write, chunk)
                    await asyncio.to_thread(os.replace, temp_path, cache_path)
                    await asyncio.to_thread(metadata_path.write_text, content_type, "utf-8")
                finally:
                    if temp_path.exists():
                        await asyncio.to_thread(temp_path.unlink)

            return FileResponse(
                cache_path,
                media_type=content_type,
                headers={"Cache-Control": "public, max-age=31536000, immutable"},
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, detail=str(e))


# --- PROXY ---

@app.api_route("/stream_proxy/{video_id}.mp4", methods=["GET", "HEAD"])
async def proxy_video(video_id: str, request: Request, url: Optional[str] = None, referer: Optional[str] = None, db: Session = Depends(get_db)):
    v = None
    if url:
        # Generic URL proxying for search previews etc.
        target_url = url
        v_source_url = referer or url
    else:
        v = db.query(Video).get(video_id)
        if not v: raise HTTPException(404)
        from .telegram_service import library_telegram_stream_path
        telegram_stream = library_telegram_stream_path(v)
        if telegram_stream:
            return RedirectResponse(url=telegram_stream, status_code=307)
        target_url = v.url
        v_source_url = v.source_url
    _cw_match = re.search(r"/videos/(\d+)", str(v_source_url or "") + " " + str(target_url or ""), re.I)
    cw_corr = f"cw:{_cw_match.group(1)}" if _cw_match else "cw:unknown"

    if not target_url:
        logging.error(f"Stream proxy requested for video {video_id} but target_url is empty")
        raise HTTPException(400, detail="Video URL is missing in the database. The video might be from a broken source.")

    # --- URL SANITIZATION ---
    # Strip malformed prefixes that can end up in the DB (e.g. "function/0/https://...")
    import re as _re
    _http_match = _re.search(r'https?://', target_url)
    if _http_match and _http_match.start() > 0:
        original_url = target_url
        target_url = target_url[_http_match.start():]
        logging.warning(f"Stripped malformed prefix from video {video_id} URL: '{original_url[:40]}' -> '{target_url[:60]}'")
        if v:
            try:
                v.url = target_url
                db.commit()
                logging.info(f"Auto-healed URL in DB for video {video_id}")
            except Exception as _e:
                logging.warning(f"Could not auto-heal DB URL: {_e}")

    # Resolve webshare pseudo-URLs / refresh wsfiles VIP links before HTTP validation.
    if v and (
        (target_url or "").startswith("webshare:")
        or "wsfiles.cz" in (target_url or "")
        or (v_source_url or "").startswith("webshare:")
    ):
        try:
            from app.extractors.legacy.webshare import WebshareAPI, parse_webshare_ident

            ws = WebshareAPI()
            ident = parse_webshare_ident(v_source_url) or parse_webshare_ident(target_url)
            if ident:
                logging.info(f"Resolving fresh Webshare link for {ident}...")
                fresh_url = await asyncio.to_thread(ws.get_vip_link, ident)
                if fresh_url:
                    target_url = fresh_url
                    try:
                        v.url = fresh_url
                        db.commit()
                    except Exception as _ws_commit_err:
                        logging.warning(f"Could not persist refreshed Webshare URL: {_ws_commit_err}")
        except Exception as e:
            logging.error(f"Failed to resolve Webshare link upfront: {e}")

        if (target_url or "").startswith("webshare:"):
            raise HTTPException(502, detail="Could not resolve Webshare VIP link")

    if v and ((v.storage_type or "").lower() == "mega" or target_url.startswith("mega:")):
        return RedirectResponse(url=f"/api/v1/mega/stream/{v.id}", status_code=307)

    if target_url.startswith("/") and not target_url.startswith("//"):
        return RedirectResponse(url=target_url, status_code=307)

    if not target_url.startswith(('http://', 'https://')):
        logging.error(f"Proxy attempt with non-HTTP URL for video {video_id}: '{target_url}'")
        raise HTTPException(500, detail=f"Invalid protocol or empty URL for proxy. Got: '{target_url}'")
    target_url = _require_public_proxy_url(target_url)

    # PimpBunny requires the watch-page Referer. Do not redirect directly to
    # the CDN: Chrome would send localhost as Referer and the CDN returns 403.
    # The player uses the local video proxy below, which preserves the source
    # page headers while forwarding the browser's Range request.
    _pb_target = target_url.lower()
    _pb_source = (v.source_url if v else referer or '').lower()
    if ('pimpbunny.com' in _pb_target or 'pimpbunny.com' in _pb_source) and (
        '/get_file/' in _pb_target or 'remote_control.php' in _pb_target
    ):
        proxy_url = f"/api/v1/video_proxy?url={urllib.parse.quote(target_url, safe='')}&referer={urllib.parse.quote(v.source_url if v else (referer or 'https://pimpbunny.com/'), safe='')}"
        logging.info(f"[PimpBunny-JIT] Using referer-aware local proxy for video {video_id}")
        return RedirectResponse(url=proxy_url, status_code=307)

    # --- FILESTER / FILEDITCH JIT REFRESH ---
    # Their stable viewer pages must be re-resolved at play time. FileDitch's
    # viewer misleadingly ends in .mp4 but serves HTML + a PoW redirect; it is
    # never the media stream itself.
    from app.extractors.filester import is_fileditch_url as _is_fileditch_url
    if v:
        _fturl = (target_url or "").lower()
        _ftsrc = (v.source_url or "").lower()
        _is_filester_page = "filester." in _fturl and "/d/" in _fturl
        # CDN URLs: cache1.filester.me/v/<token> — no .mp4 extension, just "filester." not under /d/ or /f/
        _is_filester_cdn = (
            "filester." in _fturl
            and "/d/" not in _fturl
            and "/f/" not in _fturl
            and "/manager" not in _fturl
        )
        _is_filester_source_page = bool(
            v.source_url
            and "filester." in (v.source_url or "").lower()
            and "/d/" in (v.source_url or "").lower()
        )
        _is_fileditch_page = _is_fileditch_url(target_url) or _is_fileditch_url(v.source_url or "")
        if _is_filester_page or _is_filester_cdn or _is_filester_source_page or _is_fileditch_page:
            _jit_page = None
            if _is_fileditch_page:
                _jit_page = v.source_url if _is_fileditch_url(v.source_url) else target_url
            elif _is_filester_page:
                _jit_page = target_url
            elif v.source_url and "/d/" in (v.source_url or "").lower() and "filester." in (v.source_url or "").lower():
                _jit_page = v.source_url
            if _jit_page:
                try:
                    from app.extractors.filester import FilesterExtractor as _FilesterExtractor
                    _fe_fresh = _FilesterExtractor()
                    _provider_label = _fe_fresh.source_label(_jit_page)
                    _fe_result = await _fe_fresh.extract(_jit_page)
                    if _fe_result and _fe_result.get("stream_url"):
                        _fresh_cdn = _fe_result["stream_url"]
                        logging.info(f"[{_provider_label}-JIT] Refreshed stream for video {video_id}: {_fresh_cdn[:80]}")
                        # Persist fresh CDN URL and duration if extracted
                        try:
                            v.url = _fresh_cdn
                            if _fe_result.get("duration") and not v.duration:
                                v.duration = float(_fe_result["duration"])
                            db.commit()
                        except Exception:
                            pass
                        # Redirect browser directly to CDN token URL.
                        # Avoids aiohttp Windows WinError 121 (TCP semaphore exhaustion)
                        # on concurrent Filester CDN connections. Token is self-contained.
                        return RedirectResponse(url=_fresh_cdn, status_code=302)
                except Exception as _fe_err:
                    logging.warning(f"[{_provider_label if '_provider_label' in locals() else 'File host'}-JIT] Re-extract failed for video {video_id}: {_fe_err}")

    # --- XXXDBX JIT REFRESH ---
    # xxxdbx.com/view/<id> page is permanent; the d.v1d30.com mp4 token expires.
    # Re-resolve a fresh mp4 from the view page at play time, then redirect.
    if v:
        _xurl = (target_url or "").lower()
        _xsrc = (v.source_url or "").lower()
        _needs_xxxdbx = ("xxxdbx.com/view/" in _xurl or "d.v1d30.com" in _xurl
                         or "xxxdbx.com/view/" in _xsrc)
        if _needs_xxxdbx:
            _view_page = None
            if "xxxdbx.com/view/" in _xurl:
                _view_page = target_url
            elif "xxxdbx.com/view/" in _xsrc:
                _view_page = v.source_url
            if _view_page:
                try:
                    from app.extractors.xxxdbx import XxxdbxExtractor as _XxxdbxExtractor
                    _xe = await _XxxdbxExtractor().extract(_view_page)
                    if _xe and _xe.get("stream_url"):
                        _fresh = _xe["stream_url"]
                        logging.info(f"[Xxxdbx-JIT] Refreshed stream for video {video_id}: {_fresh[:80]}")
                        return RedirectResponse(url=_fresh, status_code=302)
                except Exception as _xe_err:
                    logging.warning(f"[Xxxdbx-JIT] Re-extract failed for video {video_id}: {_xe_err}")

    # --- TURBO.CR / TURBOCDN PROACTIVE JIT REFRESH ---
    # turbocdn.st links embed an `exp=<epoch>` parameter and expire with HTTP 410.
    # Re-resolve from turbo.cr/v/<id> (or reconstruct it from the CDN filename) whenever
    # the URL is a page URL or its token is stale/expired.
    if v:
        _t_page = None
        if "turbo.cr/" in (target_url or "").lower() and "/v/" in (target_url or "").lower():
            _t_page = target_url
        elif "turbo.cr/" in (v.source_url or "").lower() and "/v/" in (v.source_url or "").lower():
            _t_page = v.source_url
        else:
            _t_page = _turbo_page_url_from_cdn(target_url or "") or _turbo_page_url_from_cdn(v.source_url or "")

        if _t_page and (
            "turbo.cr/" in (target_url or "").lower()
            or signed_link_is_stale(target_url or "", grace_minutes=5)
        ):
            try:
                from app.extractors.turbo import TurboExtractor as _TurboExtractor
                _te = await _TurboExtractor().extract(_t_page)
                if _te and _te.get("stream_url"):
                    _fresh_turbo = _te["stream_url"]
                    logging.info(f"[Turbo-JIT] Refreshed stream for video {video_id}: {_fresh_turbo[:80]}")
                    try:
                        v.url = _fresh_turbo
                        db.commit()
                    except Exception:
                        db.rollback()
                    return RedirectResponse(url=_fresh_turbo, status_code=302)
            except Exception as _te_err:
                logging.warning(f"[Turbo-JIT] Re-extract failed for video {video_id}: {_te_err}")

    # --- OPTIMISTIC STREAMING (Fix for single-use tokens) ---
    range_header = request.headers.get('Range')

    def _looks_like_hls_payload(stream_url: str, content_type: str) -> bool:
        low_url = (stream_url or "").lower()
        low_ctype = (content_type or "").lower()
        if ".m3u8" in low_url:
            return True
        return any(
            token in low_ctype
            for token in (
                "application/vnd.apple.mpegurl",
                "application/x-mpegurl",
                "audio/mpegurl",
            )
        )

    # --- CAMWHORES: rnd=<unix_ms> is required for many get_file URLs (extension always includes it).
    # Camvideos/cwvids are the same KVS file host used by older playlist entries.
    if "get_file" in target_url and any(
        host in target_url.lower() for host in ("camwhores", "camvideos.org", "cwvids.com")
    ):
        from .extractors.camwhores import normalize_camwhores_get_file_rnd

        target_url = normalize_camwhores_get_file_rnd(target_url)

    async def get_request_params(v_url, ref_url):
        domain = urllib.parse.urlparse(v_url).netloc
        # Safe default: use the target stream domain as referer.
        # Site-specific branches below can override this when needed.
        referer = f"https://{domain}/"
        origin = None
        sxyprn_provider_headers = _sxyprn_proxy_provider_headers(v_url, ref_url or "")
        if sxyprn_provider_headers:
            referer = sxyprn_provider_headers["Referer"]
            origin = sxyprn_provider_headers.get("Origin")
        elif "webshare.cz" in v_url or "wsfiles.cz" in v_url:
            referer = None
        elif "eporner.com" in v_url or (ref_url and "eporner.com" in ref_url):
            referer = ref_url if (ref_url and "eporner.com" in ref_url) else "https://www.eporner.com/"
        elif "xhamster" in v_url or (ref_url and "xhamster" in ref_url):
            referer = ref_url if (ref_url and "xhamster.com" in ref_url) else "https://xhamster.com/"
        elif "rdtcdn.com" in (v_url or "").lower() or "redtube.com" in (ref_url or "").lower():
            # RedTube's video CDN accepts the media only in the context of the
            # watch page. Its stream hostname is deliberately unrelated to the
            # site hostname, so the generic CDN referer is rejected.
            referer = ref_url if (ref_url and "redtube.com" in ref_url.lower()) else "https://www.redtube.com/"
            origin = "https://www.redtube.com"
        elif "xvideos." in v_url:
            referer = f"https://{domain}/"
        elif "erome.com" in v_url:
            referer = "https://www.erome.com/"
        elif "pornone.com" in (v_url or "").lower() or "th-eu" in (v_url or "").lower() or ".pornone.com" in (v_url or "").lower():
            referer = ref_url if (ref_url and "pornone.com" in ref_url) else "https://www.pornone.com/"
        elif (
            any(host in (v_url or "").lower() for host in ("camwhores", "camvideos.org", "cwvids.com"))
            or (
                "get_file" in (v_url or "").lower()
                and ref_url
                and any(host in ref_url.lower() for host in ("camwhores.tv", "camvideos.org", "cwvids.com"))
            )
        ):
            # The file host rejects the CDN as Referer. Playlist cards often
            # resolve to camvideos.org while the watch page stays on camwhores.tv.
            watch = ref_url or ""
            if any(token in watch.lower() for token in ("/videos/", "camwhores.tv", "camvideos.org", "cwvids.com")):
                referer = watch if watch.endswith("/") else watch + "/"
            else:
                referer = "https://www.camwhores.tv/"
        elif "pimpbunny.com" in (v_url or "").lower() or "pimpbunny.com" in (ref_url or "").lower():
            if ref_url and "pimpbunny.com/videos/" in ref_url.lower():
                referer = ref_url if ref_url.endswith("/") else ref_url + "/"
            else:
                referer = "https://pimpbunny.com/"
            p = urllib.parse.urlparse(referer)
            origin = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else "https://pimpbunny.com"
        elif "bunkr" in v_url or "scdn.st" in v_url or any(
            x in (v_url or "").lower()
            for x in ("media-files", "stream-files", "milkshake", "cdn.", "bunkr.")
        ):
            ref = ref_url or ""
            if ref and ("bunkr" in ref.lower() or "/f/" in ref or "/v/" in ref):
                referer = ref if ref.endswith("/") else ref + "/"
            else:
                parsed_b = urllib.parse.urlparse(v_url)
                referer = f"{parsed_b.scheme}://{parsed_b.netloc}/"
        elif any(host in (v_url or "").lower() for host in ("filester.", "fileditchstuff")) or any(
            host in (ref_url or "").lower() for host in ("filester.",)
        ) or _is_fileditch_url(v_url) or _is_fileditch_url(ref_url):
            filester_ref = ref_url or ""
            if "filester." in filester_ref.lower():
                referer = filester_ref
            else:
                parsed_f = urllib.parse.urlparse(v_url)
                referer = f"{parsed_f.scheme}://{parsed_f.netloc}/"
            if referer:
                p = urllib.parse.urlparse(referer)
                origin = f"{p.scheme}://{p.netloc}"
        elif "gofile.io" in (v_url or "").lower() or ("gofile.io" in (ref_url or "").lower()):
            # GoFile's CDN returns a small HTML redirect unless the API account
            # token and rotating website token are supplied with every range
            # request.  The dashboard always streams through this proxy, so
            # attach the same credentials used for the folder API and ffprobe.
            referer = "https://gofile.io/"
        elif "mydaddy.cc" in v_url:
            referer = "https://hqporner.com/"
        elif any(x in (v_url or "").lower() for x in ("archivebate.com", "mxcontent.net", "mixdrop.", "m1xdrop.")) or (
            ref_url and "archivebate.com" in (ref_url or "").lower()
        ):
            # Archivebate/Mixdrop CDN links often require Archivebate referer context.
            if ref_url and "archivebate.com" in ref_url.lower():
                referer = ref_url if ref_url.endswith("/") else ref_url + "/"
            else:
                referer = "https://archivebate.com/"
            p = urllib.parse.urlparse(referer)
            origin = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else None
        elif any(x in (v_url or "").lower() for x in ("rec-ur-bate.com", "recurbate.com")):
            # Recurbate streams are safest with the watch page or site root as Referer.
            if ref_url and any(x in ref_url.lower() for x in ("rec-ur-bate.com", "recurbate.com")):
                referer = ref_url if ref_url.endswith("/") else ref_url + "/"
            else:
                referer = "https://rec-ur-bate.com/"
            p = urllib.parse.urlparse(referer)
            origin = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else None
        elif "pornonahobka.icu" in v_url or (ref_url and "pornonahobka.icu" in ref_url):
            referer = ref_url if (ref_url and "pornonahobka.icu" in ref_url) else "https://pub.pornonahobka.icu/"
            p = urllib.parse.urlparse(referer)
            origin = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else None
        elif "shareanynudes.com" in v_url or (ref_url and "shareanynudes.com" in ref_url):
            referer = ref_url if (ref_url and "shareanynudes.com" in ref_url) else "https://shareanynudes.com/"
            p = urllib.parse.urlparse(referer)
            origin = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else None
        elif any(host in (v_url or "").lower() for host in ("sxyprn.", "trafficdeposit.")) or any(
            host in (ref_url or "").lower() for host in ("sxyprn.",)
        ):
            referer = ref_url if (ref_url and "sxyprn." in ref_url.lower()) else "https://www.sxyprn.net/"
            p = urllib.parse.urlparse(referer)
            origin = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else None

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': referer,
            'Origin': origin,
            'Accept': '*/*',
            'Connection': 'keep-alive'
        }
        if range_header:
            headers['Range'] = range_header
        if "gofile.io" in (v_url or "").lower() or ("gofile.io" in (ref_url or "").lower()):
            try:
                from .extractors.gofile import GoFileExtractor
                gofile_token = GoFileExtractor._get_token()
                if gofile_token:
                    headers.update({
                        "Cookie": f"accountToken={gofile_token}",
                        "Authorization": f"Bearer {gofile_token}",
                        "X-BL": "en-US",
                        "X-Website-Token": GoFileExtractor._generate_website_token(gofile_token),
                    })
            except Exception as gofile_proxy_header_exc:
                logging.debug("[GoFileProxy] token headers unavailable: %s", gofile_proxy_header_exc)
        return {k: v for k, v in headers.items() if v is not None}

    try:
        if not target_url.startswith(('http://', 'https://')):
             logging.error(f"Proxy attempt with non-HTTP URL: {target_url}")
             raise HTTPException(500, detail=f"Invalid protocol for proxy: {target_url}")

        # Musí byť pred prvým použitím (cookies nižšie), inak UnboundLocalError -> 500 na každom streame
        _combined_lower = f"{target_url or ''} {v_source_url or ''}".lower()
        is_unreliable = any(
            d in _combined_lower
            for d in [
                "vk.com", "vk.video", "vkvideo.ru", "okcdn.ru", "userapi.com",
                "vkvideo.net", "mycdn.me", "vk-cdn.net", "vkay.net", "vk.ru",
                "vkvideo.com", "ok.ru",
                "filester.gg", "filester.me", "cache1.filester.gg",
                "xvideos.com", "xvideos.red", "xv-video.com",
                "bunkr.cr", "bunkr.is", "bunkr.si", "bunkr.black", "bunkr.pk",
                "camwhores.tv", "camvideos.org", "cwvids.com",
                "leakporner.com", "luluvids.com", "luluvids.top",
                "archivebate.com", "mxcontent.net", "mixdrop.", "m1xdrop.",
                "rec-ur-bate.com", "recurbate.com",
                "sxyprn.", "trafficdeposit.",
            ]
        )
        # Keep VK-specific logic strictly for VK/OK domains only.
        is_vk = any(
            d in _combined_lower
            for d in [
                "vk.com", "vk.video", "vkvideo.ru", "okcdn.ru", "userapi.com",
                "vkvideo.net", "mycdn.me", "vk-cdn.net", "vkay.net", "vk.ru",
                "vkvideo.com", "ok.ru",
            ]
        )

        current_headers = await get_request_params(target_url, v_source_url)

        is_shareanynudes = "shareanynudes.com" in _combined_lower

        # Load cookies for VK/OK or Shareanynudes if available
        def load_current_cookies():
            c = {}
            if is_vk or is_shareanynudes:
                _COOKIE_CANDIDATES = [
                    "vkvideo.ru_cookies.txt",
                    "vk.com_cookies.txt",
                    "vk.netscape.txt",
                    "vkvideos.ru_cookies.txt",
                    os.path.join("app", "vkvideo.ru_cookies.txt"),
                    os.path.join("app", "vk.com_cookies.txt"),
                    os.path.join("app", "vk.netscape.txt"),
                    os.path.join("app", "vkvideos.ru_cookies.txt"),
                    os.path.join("app", "cookies.netscape.txt"),
                    "cookies.netscape.txt",
                ]
                _cookie_file = next((p for p in _COOKIE_CANDIDATES if os.path.exists(p)), None)
                if _cookie_file:
                    try:
                        domain_filter = "vk" if is_vk else "shareanynudes"
                        with open(_cookie_file, 'r', encoding="utf-8", errors="ignore") as f:
                            for line in f:
                                if not line.startswith('#') and line.strip():
                                    parts = line.strip().split('\t')
                                    if len(parts) >= 7 and domain_filter in parts[0].lower():
                                        c[parts[5]] = parts[6]
                    except Exception as e:
                        logging.debug(f"[stream_proxy] Failed to load cookies from {_cookie_file}: {e}")
            return c

        cookies = load_current_cookies()

        is_expired = False
        content_len = 0
        try:
            upstream_response = await http_session.get(target_url, headers=current_headers, cookies=cookies if cookies else None, allow_redirects=True, ssl=False)
            status_code = upstream_response.status
            content_len = int(upstream_response.headers.get('Content-Length', 0))
        except aiohttp.ClientError as e:
            logging.warning(f"Connection error proxying {target_url}: {e} - treating as expired.")
            is_expired = True
            status_code = 502
            upstream_response = None
        
        content_type = ""
        if upstream_response is not None:
            content_type = (upstream_response.headers.get("Content-Type") or "").lower()
            is_hls_payload = _looks_like_hls_payload(target_url, content_type)
            if not is_expired:
                is_expired = upstream_response.status in [403, 410, 401, 404]
            if 'na.mp4' in str(upstream_response.url) or (
                upstream_response.status == 200 and content_len < 100000 and not is_hls_payload
                and not any(x in (target_url or "").lower() for x in ("sxyprn.com/cdn", "sxyprn.net/cdn", "trafficdeposit.com"))
            ):
                is_expired = True

            # Eporner-specific expiration detection: 
            if (
                upstream_response.status == 200 
                and "eporner.com" in target_url 
                and (content_len == 5433 or content_type.startswith("text/html"))
            ):
                is_expired = True

            # Pornhub-specific expiration detection (403 Forbidden, 410 Gone, or expired token query params)
            if "phncdn.com" in target_url or "pornhub" in target_url:
                if upstream_response.status in (403, 410, 404):
                    is_expired = True
                else:
                    # Check query params for validto timestamp
                    try:
                        parsed_turl = urllib.parse.urlparse(target_url)
                        qparams = urllib.parse.parse_qs(parsed_turl.query)
                        validto = qparams.get('validto')
                        if validto:
                            import time as _time
                            if int(validto[0]) < int(_time.time()):
                                is_expired = True
                    except Exception:
                        pass

            # Filester /d/<id> page URL or cache CDN can return HTML (200) instead of media URL.
            # Force smart refresh to resolve a direct stream.
            if "filester." in (target_url or "").lower() and (
                "/d/" in (target_url or "").lower()
                or "text/html" in content_type
                or content_len < 100000
            ):
                is_expired = True

            # Bunkr CDN token expiry: check `ex` query param (Unix epoch) proactively.
            # CDN tokens expire in ~6-24 hours; if `ex` is past, treat as expired before wasting bandwidth.
            _tgt_low_bunkr = (target_url or "").lower()
            if re.search(r"(?:bunkr|bunkrr|scdn|media-files|milkshake|stream-files)\.", _tgt_low_bunkr, re.I) and not is_expired:
                try:
                    import time as _time_bunkr
                    _bunkr_parsed_q = urllib.parse.urlparse(target_url)
                    _bunkr_qp = urllib.parse.parse_qs(_bunkr_parsed_q.query)
                    _bunkr_ex = _bunkr_qp.get("ex")
                    if _bunkr_ex:
                        _bunkr_ex_val = int(_bunkr_ex[0], 16) if len(_bunkr_ex[0]) <= 10 and all(c in '0123456789abcdefABCDEF' for c in _bunkr_ex[0]) else int(_bunkr_ex[0])
                        if _bunkr_ex_val < int(_time_bunkr.time()):
                            logging.info(f"[BunkrProxy] Token expired (ex={_bunkr_ex[0]}) for video {video_id}, triggering re-resolve")
                            is_expired = True
                except Exception:
                    pass

            # XVideos/XVideos.red: if target_url is a watch page (not a stream), force refresh
            if any(x in (target_url or "").lower() for x in ["xvideos.com/video", "xvideos.red/video"]) and (
                "text/html" in content_type or not any(target_url.lower().endswith(e) for e in [".mp4", ".m3u8", ".webm", ".flv"])
            ):
                is_expired = True

            # VK/OK: ak je target_url ešte stránka videa, nie priamy súbor — treba refresh (is_vk už nastavené vyššie)
            if is_vk and "/video" in target_url and not ('.mp4' in target_url.lower() or '.m3u8' in target_url.lower()):
                is_expired = True
            
            # VK stream URL validation: Check if it's a valid stream or needs refresh
            if is_vk and not is_expired:
                # Check for content-length mismatch or other VK-specific issues
                if upstream_response.status == 200:
                    # If content-length is suspiciously small or missing, refresh
                    if content_len < 100000 or content_len == 0:
                        logging.warning(f"VK stream URL has suspicious content-length: {content_len}. Refreshing...")
                        is_expired = True

        _src_for_refresh = (v.source_url if v else None) or v_source_url
        # For Bunkr CDN direct URLs, allow refresh even if source_url is the CDN URL itself
        # (the BunkrJIT CDN-slug fallback can reconstruct the page URL from the CDN path)
        _is_bunkr_cdn_url = bool(re.search(r"(?:bunkr|bunkrr|scdn|media-files|milkshake|stream-files)\.", (target_url or "").lower(), re.I))
        if is_expired and (_src_for_refresh or is_vk or (_is_bunkr_cdn_url and v)):
            _status_str = str(upstream_response.status) if upstream_response else "CONNECTION_ERROR"
            logging.info(f"[PROXY][{cw_corr}] Link for video {video_id} appears expired ({_status_str}). Refreshing...")
            
            # For VK videos without source_url, try to use the current URL as source
            if v and is_vk and not v.source_url:
                logging.warning(f"VK video {video_id} missing source_url, using current URL")
                v.source_url = target_url
                db.commit()
            
            async def try_refresh():
                nonlocal upstream_response, current_headers, status_code, target_url, cookies
                if not v:
                    return False

                # 0. Camwhores quick ladder: refresh rnd and retry direct before heavier re-resolve.
                if "camwhores.tv/get_file" in (target_url or "").lower():
                    try:
                        from .extractors.camwhores import normalize_camwhores_get_file_rnd

                        retry_url = normalize_camwhores_get_file_rnd(target_url)
                        logging.info("[CW-L0][%s] rnd retry_url=%s", cw_corr, retry_url[:120])
                        retry_headers = await get_request_params(retry_url, v.source_url)
                        retry_resp = await http_session.get(retry_url, headers=retry_headers, cookies=cookies if cookies else None, allow_redirects=True, ssl=False)
                        retry_len = int(retry_resp.headers.get("Content-Length", "0") or 0)
                        retry_ctype = (retry_resp.headers.get("Content-Type") or "").lower()
                        logging.info("[CW-L0][%s] rnd-retry: status=%s ctype=%s len=%s", cw_corr, retry_resp.status, retry_ctype, retry_len)
                        if retry_resp.status in (200, 206) and (
                            retry_resp.status == 206 or retry_len >= 65536 or "video/" in retry_ctype
                        ):
                            upstream_response.close()
                            upstream_response = retry_resp
                            current_headers = retry_headers
                            status_code = retry_resp.status
                            target_url = retry_url
                            v.url = retry_url
                            db.commit()
                            logging.info("[CW-L0][%s] quick refresh succeeded, v.url committed", cw_corr)
                            return True
                        retry_resp.close()
                        logging.info("[CW-L0][%s] rnd-retry rejected — falling to deep refresh", cw_corr)
                    except Exception as e:
                        logging.warning("[CW-L0][%s] quick refresh exception: %s", cw_corr, e)

                # 1. Webshare Refresh
                if 'webshare.cz' in (v.source_url or "") or 'wsfiles.cz' in (v.source_url or "") or (v.url and "wsfiles.cz" in v.url):
                    try:
                        from app.extractors.legacy.webshare import WebshareAPI
                        ws = WebshareAPI()
                        ident = None
                        src = v.source_url or v.url
                        if src and "webshare:" in src:
                            ident = src.split(":", 2)[1]
                        elif src and "/file/" in src:
                            part = src.split('/file/')[1]
                            ident = part.split('/')[0] if '/' in part else part
                        
                        if not ident and 'wsfiles.cz' in (src or ""):
                            import re
                            match = re.search(r'/([a-zA-Z0-9]{10})/', src)
                            if match: ident = match.group(1)

                        if ident:
                            new_link = await asyncio.to_thread(ws.get_vip_link, ident)
                            if new_link:
                                upstream_response.close()
                                v.url = new_link
                                db.commit()
                                current_headers = await get_request_params(v.url, v.source_url)
                                upstream_response = await http_session.get(v.url, headers=current_headers, allow_redirects=True)
                                status_code = upstream_response.status
                                return True
                    except Exception as e:
                        logging.error(f"Webshare proxy refresh failed: {e}")
                    return False

                # 2. General/VK/Deep Refresh
                async def refresh_link_smart():
                    is_camwhores_source = bool(v.source_url and "camwhores.tv" in v.source_url.lower())
                    refresh_source_url = v.source_url or v.url
                    # Backward-compat for already imported Filester rows with source_url=/f/... .
                    if (
                        "filester." in (refresh_source_url or "").lower()
                        and "/f/" in (refresh_source_url or "").lower()
                        and "filester." in (v.url or "").lower()
                        and "/d/" in (v.url or "").lower()
                    ):
                        refresh_source_url = v.url

                    # --- Camwhores: use the same extractor as import/processing ---
                    if is_camwhores_source:
                        try:
                            from .extractors.camwhores import CamwhoresExtractor

                            logging.info("[CW-L2][%s] extractor refresh: %s", cw_corr, v.source_url)
                            _cw_extractor = CamwhoresExtractor()
                            _cw_result = await _cw_extractor.extract(v.source_url)
                            if _cw_result and _cw_result.get("stream_url"):
                                _resolved = _cw_result["stream_url"]
                                logging.info(
                                    "[CW-L2][%s] extractor(%s)->url=%s",
                                    cw_corr,
                                    _cw_result.get("_resolver") or "unknown",
                                    _resolved[:120],
                                )
                                return {
                                    "url": _resolved,
                                    "height": _cw_result.get("height") or 0,
                                    "_prevalidated": bool(_cw_result.get("_prevalidated")),
                                }
                            logging.warning("[CW-L2][%s] extractor returned no stream", cw_corr)
                        except Exception as _e:
                            logging.warning("[CW-L2][%s] extractor refresh error: %s", cw_corr, _e)
                        return None

                    # --- Bunkr CDN direct URL fallback ---
                    # If source_url is a Bunkr CDN domain (scdn.st, media-files, milkshake, stream-files)
                    # rather than a page URL (/f/ or /v/), reconstruct a page URL from the CDN slug
                    # so BunkrExtractor can re-resolve it.
                    _BUNKR_CDN_DOMAINS = ("scdn.st", "media-files", "stream-files", "milkshake", "cdn.bunkr", "bunkr.cdn")
                    _src_low = (refresh_source_url or "").lower()
                    _is_bunkr_cdn_src = any(d in _src_low for d in _BUNKR_CDN_DOMAINS)
                    if _is_bunkr_cdn_src and not ("/f/" in _src_low or "/v/" in _src_low):
                        try:
                            from .extractors.bunkr import BunkrExtractor as _BunkrExt
                            import urllib.parse as _up_refresh
                            _cdn_parsed = _up_refresh.urlparse(refresh_source_url or "")
                            _cdn_path_raw = (_cdn_parsed.path or "").rstrip("/")
                            _cdn_slug = _cdn_path_raw.rsplit("/", 1)[-1]
                            # Strip file extension from slug (bunkr CDN slug includes .mp4 etc.)
                            _cdn_slug_clean = re.sub(r'\.[a-z0-9]{2,4}$', '', _cdn_slug, flags=re.I)
                            if _cdn_slug_clean:
                                _bunkr_page_url = f"https://bunkr.cr/f/{_cdn_slug_clean}"
                                logging.info(f"[BunkrJIT] CDN-source fallback: slug='{_cdn_slug_clean}' page='{_bunkr_page_url}' (vid={v.id})")
                                _bunkr_ext = _BunkrExt()
                                _bunkr_res = await _bunkr_ext.extract(_bunkr_page_url)
                                if _bunkr_res and _bunkr_res.get("stream_url"):
                                    # Persist bunkr page URL as source_url so future refreshes work
                                    try:
                                        v.source_url = _bunkr_page_url
                                        db.commit()
                                        logging.info(f"[BunkrJIT] Updated source_url to page URL for video {v.id}")
                                    except Exception as _db_e:
                                        logging.warning(f"[BunkrJIT] Could not update source_url: {_db_e}")
                                    return {'url': _bunkr_res['stream_url'], 'height': _bunkr_res.get('height') or 0}
                                logging.warning(f"[BunkrJIT] CDN-slug extraction failed for '{_bunkr_page_url}', will try plugin registry")
                        except Exception as _bunkr_jit_e:
                            logging.warning(f"[BunkrJIT] CDN-slug fallback error: {_bunkr_jit_e}")

                    # --- SxyPrn Refresh ---
                    if any(x in (refresh_source_url or "").lower() for x in ("sxyprn.com", "sxyprn.net")):
                        try:
                            from .extractors.sxyprn import SxyPrnExtractor as _SxExt
                            _sx_inst = _SxExt()
                            _sx_res = await _sx_inst.extract(refresh_source_url)
                            if _sx_res and _sx_res.get("stream_url"):
                                logging.info(f"[SxyPrn-JIT-Refresh] Refreshed stream for video {v.id}: {_sx_res['stream_url'][:80]}")
                                return {
                                    "url": _sx_res["stream_url"],
                                    "height": _sx_res.get("height") or 0,
                                    "_prevalidated": True
                                }
                        except Exception as _sx_e:
                            logging.warning(f"[SxyPrn-JIT-Refresh] Refresh failed: {_sx_e}")

                    # Try Plugin First (Eporner, Bunkr, Filester, XVideos, etc.) - FAST
                    try:
                        from .extractors.registry import ExtractorRegistry
                        from .extractors import init_registry, register_extended_extractors
                        # Ensure ALL extractors (including XVideos, Filester, etc.) are registered
                        init_registry()
                        register_extended_extractors()
                        plugin = ExtractorRegistry.find_extractor(refresh_source_url)
                        _extract_target = refresh_source_url
                        if not plugin:
                            _turbo_fallback = _turbo_page_url_from_cdn(v.url or target_url or "")
                            if _turbo_fallback:
                                plugin = ExtractorRegistry.find_extractor(_turbo_fallback)
                                _extract_target = _turbo_fallback
                        if plugin:
                             logging.info(f"[REFRESH] Using plugin {plugin.name} for refresh of video {v.id}")
                             res = await plugin.extract(_extract_target)
                             if res and res.get('stream_url'):
                                 return {
                                     'url': res['stream_url'],
                                     'height': res.get('height'),
                                     # Lower renditions to fall back to if the top one is
                                     # rejected (e.g. PimpBunny 410s the 1080p under a CDN
                                     # rate-limit while 720p/480p still serve).
                                     'fallback_urls': res.get('fallback_urls') or [],
                                 }
                             logging.warning(f"[REFRESH] Plugin {plugin.name} found no stream for {refresh_source_url}")
                    except Exception as e:
                         logging.warning(f"Plugin smart refresh failed: {e}")

                    # Eporner should rely on extractor/JIT/browser refresh rather than proxy config.
                    if 'eporner.com' in (refresh_source_url or ''):
                        logging.warning(f"[REFRESH] Eporner refresh failed via extractor for video {v.id}; waiting for direct refresh path.")
                        return False

                    # Fallback to yt-dlp for other deep sites (VK, xvideos, etc.)

                    def run_ytdlp():
                        is_deep = any(
                            x in (refresh_source_url or "")
                            for x in [
                                'xvideos.com', 'xvideos.red', 'xv-video.com',
                                'xhamster.com',
                                'eporner.com',
                                'spankbang.com',
                                'vk.com', 'vk.video', 'vkvideo.ru',
                                'pornhub.com',
                            ]
                        )
                        user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                        opts = {
                            'quiet': True, 'skip_download': True,
                            'format': 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best',
                            'extract_flat': False,
                            'socket_timeout': 20,
                            'user_agent': user_agent,
                            'http_headers': {'User-Agent': user_agent, 'Referer': refresh_source_url}
                        }
                        cookie_candidates = [
                            'xvideos.netscape.txt',
                            "vkvideo.ru_cookies.txt",
                            "vk.com_cookies.txt",
                            'vk.netscape.txt',
                            "vkvideos.ru_cookies.txt",
                            os.path.join("app", "vkvideo.ru_cookies.txt"),
                            os.path.join("app", "vk.com_cookies.txt"),
                            os.path.join("app", "vk.netscape.txt"),
                            os.path.join("app", "vkvideos.ru_cookies.txt"),
                            'eporner.netscape.txt',
                            os.path.join("app", "cookies.netscape.txt"),
                            'cookies.netscape.txt',
                        ]
                        for cf in cookie_candidates:
                            if os.path.exists(cf):
                                opts['cookiefile'] = cf
                                break
                        info = None
                        try:
                            with yt_dlp.YoutubeDL(opts) as ydl:
                                info = ydl.extract_info(refresh_source_url, download=False)
                        except (yt_dlp.utils.DownloadError, yt_dlp.utils.UnsupportedError) as e:
                            logging.warning("[CW-L2] yt-dlp cannot handle URL %s: %s", refresh_source_url, e)
                            return None
                        if not info:
                            return None
                        # Pick best video URL from formats list
                        best_url = info.get('url')
                        best_height = info.get('height') or 0
                        formats = info.get('formats', [])
                        if formats:
                            best_score = -1
                            for f in formats:
                                furl = f.get('url')
                                if not furl: continue
                                proto = str(f.get('protocol') or '').lower()
                                fid = str(f.get('format_id') or '').lower()
                                if 'dash' in proto or '.mpd' in furl.lower() or fid.startswith('dash'):
                                    continue
                                if str(f.get('vcodec') or '').lower() == 'none' or str(f.get('acodec') or '').lower() == 'none':
                                    continue
                                h = f.get('height') or 0
                                score = h * 10
                                if f.get('ext') == 'mp4' and 'm3u8' not in proto and '.m3u8' not in furl.lower():
                                    score += 5
                                if score > best_score:
                                    best_score = score
                                    best_url = furl
                                    best_height = h
                        return {'url': best_url, 'height': best_height}

                    return await asyncio.to_thread(run_ytdlp)

                try:
                    info = await refresh_link_smart()
                    cookies = load_current_cookies()
                    if not info:
                        logging.warning("[CW-L2][%s] refresh_link_smart returned None", cw_corr)
                        return False

                    new_url = info.get('url')
                    # VK specific: might be in formats list
                    if not new_url and 'formats' in info:
                        max_h = 0
                        for f in info['formats']:
                            if f.get('url') and (f.get('height') or 0) >= max_h:
                                max_h = f.get('height') or 0
                                new_url = f['url']

                    logging.info("[CW-L2][%s] new_url resolved: %s", cw_corr, (new_url or "None")[:120])

                    if new_url:
                        if upstream_response is not None:
                            upstream_response.close()
                        prevalidated = info.get("_prevalidated", False)

                        if prevalidated:
                            # CamwhoresExtractor already probed the URL internally.
                            # Skip re-probe — make ONE real request with the client's original
                            # Range header so the streamed response is correct.
                            logging.info("[CW-L2][%s] pre-validated -> streaming directly (no re-probe)", cw_corr)
                            current_headers = await get_request_params(new_url, v.source_url)
                            upstream_response = await http_session.get(
                                new_url, headers=current_headers, cookies=cookies if cookies else None, allow_redirects=True, ssl=False
                            )
                            stream_ctype = (upstream_response.headers.get("Content-Type") or "").lower()
                            logging.info(
                                "[CW-L2][%s] stream-start: status=%s ctype=%s",
                                cw_corr, upstream_response.status, stream_ctype,
                            )
                            if upstream_response.status in (200, 206):
                                v.url = new_url
                                target_url = new_url
                                if info.get('height'):
                                    v.height = info['height']
                                db.commit()
                                status_code = upstream_response.status
                                logging.info("[CW-L2][%s] v.url committed -> %s", cw_corr, new_url[:120])
                                # Backfill height/duration via ffprobe if still missing
                                if (not v.height or not v.duration) and v.source_url:
                                    _ffprobe_vid_id = v.id
                                    _ffprobe_url = new_url
                                    _ffprobe_ref = v.source_url
                                    async def _cw_bg_ffprobe():
                                        try:
                                            _proc = VIPVideoProcessor()
                                            _ff = await _proc._ffprobe_fallback(
                                                _ffprobe_url,
                                                {},
                                                referer=_ffprobe_ref,
                                            )
                                            if _ff.get('height') or _ff.get('duration'):
                                                _bdb = SessionLocal()
                                                try:
                                                    _bv = _bdb.query(Video).get(_ffprobe_vid_id)
                                                    if _bv:
                                                        if _ff.get('height') and not _bv.height:
                                                            _bv.height = int(_ff['height'])
                                                        if _ff.get('width') and not _bv.width:
                                                            _bv.width = int(_ff['width'])
                                                        if _ff.get('duration') and not _bv.duration:
                                                            _bv.duration = float(_ff['duration'])
                                                        _bdb.commit()
                                                        logging.info(
                                                            "[CW-L2][%s] bg-ffprobe filled: h=%s dur=%s",
                                                            cw_corr, _ff.get('height'), _ff.get('duration')
                                                        )
                                                finally:
                                                    _bdb.close()
                                        except Exception as _fe:
                                            logging.warning("[CW-L2][%s] bg-ffprobe error: %s", cw_corr, _fe)
                                    asyncio.create_task(_cw_bg_ffprobe())
                                return True
                            upstream_response.close()
                            logging.warning(
                                "[CW-L2][%s] stream-start rejected: status=%s url=%s",
                                cw_corr, upstream_response.status, new_url[:120],
                            )
                        else:
                            # Standard candidate probe for non-extractor sources (VK, yt-dlp, etc.)
                            candidate_headers = await get_request_params(new_url, v.source_url)
                            try:
                                candidate_resp = await http_session.get(
                                    new_url, headers=candidate_headers, cookies=cookies if cookies else None, allow_redirects=True, ssl=False
                                )
                            except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as probe_error:
                                logging.warning(
                                    "[CW-L2][%s] candidate probe connection failed: %s url=%s",
                                    cw_corr, probe_error, new_url[:120],
                                )
                                candidate_resp = None
                            if candidate_resp is None:
                                candidate_len = 0
                                candidate_ctype = ""
                            else:
                                candidate_len = int(candidate_resp.headers.get("Content-Length", "0") or 0)
                                candidate_ctype = (candidate_resp.headers.get("Content-Type") or "").lower()
                            candidate_is_hls = _looks_like_hls_payload(new_url, candidate_ctype)
                            logging.info(
                                "[CW-L2][%s] candidate probe -> status=%s ctype=%s len=%s",
                                cw_corr, candidate_resp.status, candidate_ctype, candidate_len,
                            )
                            probe_ok = candidate_resp.status in (200, 206) and (
                                candidate_resp.status == 206
                                or candidate_len >= 65536
                                or "video/" in candidate_ctype
                                or candidate_is_hls
                            )
                            if probe_ok:
                                v.url = new_url
                                target_url = new_url
                                if info.get('height'):
                                    v.height = info['height']
                                db.commit()
                                current_headers = candidate_headers
                                upstream_response = candidate_resp
                                status_code = upstream_response.status
                                logging.info("[CW-L2][%s] v.url committed -> %s", cw_corr, new_url[:120])
                                return True
                            if candidate_resp is not None:
                                candidate_resp.close()
                            logging.warning(
                                "[CW-L2][%s] candidate rejected: status=%s ctype=%s len=%s url=%s",
                                cw_corr,
                                getattr(candidate_resp, 'status', '?'),
                                candidate_ctype,
                                candidate_len,
                                new_url[:120],
                            )

                            # Fall back to lower renditions: the top one may 410 under a
                            # CDN rate-limit (PimpBunny) while 720p/480p still serve. Try
                            # each in descending order and stream the first that probes OK.
                            for fb_url in (info.get('fallback_urls') or []):
                                if not fb_url or fb_url == new_url:
                                    continue
                                fb_headers = await get_request_params(fb_url, v.source_url)
                                try:
                                    fb_resp = await http_session.get(
                                        fb_url, headers=fb_headers, cookies=cookies if cookies else None,
                                        allow_redirects=True, ssl=False,
                                    )
                                except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as fallback_error:
                                    logging.warning(
                                        "[CW-L2][%s] fallback probe connection failed: %s url=%s",
                                        cw_corr, fallback_error, fb_url[:120],
                                    )
                                    continue
                                fb_len = int(fb_resp.headers.get("Content-Length", "0") or 0)
                                fb_ctype = (fb_resp.headers.get("Content-Type") or "").lower()
                                fb_ok = fb_resp.status in (200, 206) and (
                                    fb_resp.status == 206
                                    or fb_len >= 65536
                                    or "video/" in fb_ctype
                                    or _looks_like_hls_payload(fb_url, fb_ctype)
                                )
                                logging.info(
                                    "[CW-L2][%s] fallback probe -> status=%s ctype=%s url=%s",
                                    cw_corr, fb_resp.status, fb_ctype, fb_url[:120],
                                )
                                if fb_ok:
                                    v.url = fb_url
                                    target_url = fb_url
                                    db.commit()
                                    current_headers = fb_headers
                                    upstream_response = fb_resp
                                    status_code = upstream_response.status
                                    logging.info("[CW-L2][%s] v.url committed (fallback) -> %s", cw_corr, fb_url[:120])
                                    return True
                                fb_resp.close()
                except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
                    logging.warning("[CW-L2][%s] refresh unavailable: %s", cw_corr, e)
                except Exception as e:
                    logging.error("[CW-L2][%s] refresh raised: %s", cw_corr, e, exc_info=True)
                return False

            refresh_success = await try_refresh()
            if not refresh_success and is_vk:
                if upstream_response: upstream_response.close()
                raise HTTPException(500, detail="Failed to refresh VK stream. Check if cookies are needed.")
            if not refresh_success and v and v.source_url and any(x in (v.source_url or "").lower() for x in ("pornhub.com", "pornhub.org", "pornhub.net")):
                if upstream_response: upstream_response.close()
                raise HTTPException(502, detail="Pornhub stream expired and re-resolve failed. Try again or verify Pornhub accessibility.")
            _bunkr_src_low = (v.source_url or "").lower()
            if not refresh_success and v and (
                "bunkr" in _bunkr_src_low
                or any(h in _bunkr_src_low for h in ("scdn.st", "media-files", "stream-files", "milkshake"))
                or any(h in (v.url or "").lower() for h in ("scdn.st", "media-files", "stream-files", "milkshake"))
            ):
                if upstream_response: upstream_response.close()
                raise HTTPException(502, detail="Bunkr stream expired and automatic re-resolve failed. Use Regenerate to force re-fetch, or check if the file was deleted on Bunkr.")
            if (
                not refresh_success
                and v
                and v.source_url
                and "camwhores.tv" in (v.source_url or "").lower()
                and "/videos/" in (v.source_url or "")
            ):
                if upstream_response: upstream_response.close()
                raise HTTPException(
                    502,
                    detail="cw_refresh_failed: Camwhores stream unavailable. Open the watch page while logged in and ensure browser automation can load it, then Regenerate.",
                )
            if (
                not refresh_success
                and v
                and "camwhores.tv/get_file" in str(v.url or "").lower()
                and "camwhores.tv/videos/" not in str(v.source_url or "").lower()
            ):
                if upstream_response: upstream_response.close()
                raise HTTPException(
                    502,
                    detail="cw_source_missing: Camwhores video has no watch-page source_url for re-resolve.",
                )

        if upstream_response is None:
            logging.error(f"[PROXY][{cw_corr}] All refresh attempts failed, and upstream_response is None for video {video_id}")
            raise HTTPException(status_code=502, detail="Video stream unavailable after refresh attempt.")

        if upstream_response.status >= 400:
            error_text = await upstream_response.text()
            logging.error(f"Upstream error ({upstream_response.status}) for video {v.id if v else video_id}: {error_text[:200]}")
            upstream_response.close()
            if "camwhores.tv/get_file" in (target_url or "").lower():
                raise HTTPException(status_code=502, detail=f"cw_upstream_5xx: Camwhores upstream returned {upstream_response.status}")
            raise HTTPException(status_code=upstream_response.status, detail="Upstream link unavailable")

        # --- STREAMING RESPONSE ---
        # 1. Clean up headers. Remove specific ones that can cause proxy loops or mismatch
        excluded_headers = {
            'content-encoding', 'content-length', 'transfer-encoding', 
            'connection', 'keep-alive', 'host', 'server', 'vary',
            'x-frame-options', 'content-security-policy', 'strict-transport-security',
            'x-content-type-options', 'access-control-allow-origin', 'access-control-allow-methods',
            'content-disposition'  # Exclude to prevent Unicode encoding errors (e.g., emojis in filenames)
        }
        response_headers = {k: v for k, v in upstream_response.headers.items() if k.lower() not in excluded_headers}
        
        # 2. Handle Status and Range Headers carefully
        status_code = upstream_response.status

        # Backfill height/duration via bg ffprobe for CW videos that streamed OK but lack metadata
        if (
            v is not None
            and status_code in (200, 206)
            and v.source_url and "camwhores.tv/videos/" in v.source_url
            and (not v.height or not v.duration)
            and "get_file" in (v.url or "")
        ):
            _bfp_vid_id = v.id
            _bfp_url = v.url
            _bfp_ref = v.source_url
            async def _cw_main_bg_ffprobe():
                try:
                    _proc = VIPVideoProcessor()
                    _ff = await _proc._ffprobe_fallback(_bfp_url, {}, referer=_bfp_ref)
                    if _ff.get('height') or _ff.get('duration'):
                        _bdb = SessionLocal()
                        try:
                            _bv = _bdb.query(Video).get(_bfp_vid_id)
                            if _bv:
                                if _ff.get('height') and not _bv.height:
                                    _bv.height = int(_ff['height'])
                                if _ff.get('width') and not _bv.width:
                                    _bv.width = int(_ff['width'])
                                if _ff.get('duration') and not _bv.duration:
                                    _bv.duration = float(_ff['duration'])
                                _bdb.commit()
                                logging.info(
                                    "[CW-meta] bg-ffprobe filled vid=%s h=%s dur=%s",
                                    _bfp_vid_id, _ff.get('height'), _ff.get('duration')
                                )
                        finally:
                            _bdb.close()
                except Exception as _fe:
                    logging.warning("[CW-meta] bg-ffprobe error vid=%s: %s", _bfp_vid_id, _fe)
            asyncio.create_task(_cw_main_bg_ffprobe())

        # If browser sent a Range but we got 200, we must clear Content-Length or the browser
        # might try to match the range it asked for against the full file we are sending.
        # Actually, best is to pass Content-Length only if it matches exactly what we're sending.
        # For unreliable streams, skip Content-Length to avoid mismatch after refresh or upstream interruption
        if 'Content-Length' in upstream_response.headers and not is_unreliable:
            response_headers['Content-Length'] = upstream_response.headers['Content-Length']
        elif 'Content-Range' in upstream_response.headers:
            _crm = re.search(r'bytes\s+(\d+)-(\d+)', upstream_response.headers['Content-Range'])
            if _crm:
                response_headers['Content-Length'] = str(int(_crm.group(2)) - int(_crm.group(1)) + 1)
        if 'Content-Range' in upstream_response.headers:
            response_headers['Content-Range'] = upstream_response.headers['Content-Range']

        # Force these for stability, Range compliance and prevent Starlette GZipMiddleware compression
        response_headers.update({
            "Content-Encoding": "identity",
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
            "X-Video-ID": str(video_id),
        })

        async def content_streamer():
            try:
                # 128KB chunks: fast TTFB on seeks, no lag waiting for 1MB to fill
                async for chunk in upstream_response.content.iter_chunked(128 * 1024):
                    if chunk:
                        yield chunk
            except Exception as e:
                logging.debug(f"Stream finished or interrupted for {video_id}")
            finally:
                upstream_response.close()

        # Webshare serves MP4 files as application/octet-stream with an
        # attachment disposition. Chrome needs a video MIME type for <video>.
        is_webshare_mp4 = "wsfiles.cz" in (target_url or "").lower()
        media_type = "video/mp4" if is_webshare_mp4 else upstream_response.headers.get("Content-Type", "video/mp4")
        if is_webshare_mp4:
            response_headers["Content-Type"] = media_type

        # Allow browser to buffer aggressively in RAM.
        # "no-store" was previously used here but it prevents the browser from buffering
        # more than ~10s of video ahead. "private, max-age=0" lets the browser hold data
        # in its memory cache (for seek/buffer) without writing to disk.
        has_content_length = 'Content-Length' in response_headers
        if has_content_length:
            # Known size: browser can seek and buffer the whole file
            response_headers["Cache-Control"] = "private, max-age=0"
        else:
            # Unknown size: still allow in-memory buffering, just don't cache to disk
            response_headers["Cache-Control"] = "private, no-cache"

        return StreamingResponse(
            content_streamer(),
            status_code=status_code,
            headers=response_headers,
            media_type=media_type
        )

    except HTTPException:
        raise
    except Exception as e:
        if 'upstream_response' in locals() and upstream_response:
            try: upstream_response.close()
            except: pass
        logging.error(f"Proxy error for video {video_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_v1_router.get("/proxy")
@api_legacy_router.get("/proxy")
async def universal_cors_proxy(url: str):
    """
    Universal CORS proxy to bypass external CDN restrictions.
    Usage: /api/proxy?url=https://example.com/image.jpg
    """
    if not url:
        raise HTTPException(status_code=400, detail="URL parameter required")
    
    # Clean up URL (sometimes passed with double protocol or spaces)
    url = url.strip()
    if url.startswith('https//'): url = url.replace('https//', 'https://', 1)
    if url.startswith('http//'): url = url.replace('http//', 'http://', 1)
    url = _require_public_proxy_url(url)
    
    try:
        domain_parts = url.split('/')
        base_domain = domain_parts[0] + '//' + domain_parts[2] if len(domain_parts) > 2 else url
        
        # Pick correct Referer so CDNs don't 403 the thumbnail request
        if "camwhores" in url or "cwvids" in url or "cwstore" in url:
            _referer = "https://www.camwhores.tv/"
        elif "hqporner" in url or "mydaddy" in url:
            _referer = "https://hqporner.com/"
        elif "pixeldrain" in url:
            _referer = "https://pixeldrain.com/"
        elif "eporner" in url:
            _referer = "https://www.eporner.com/"
        elif "1porn.tv" in url or "img.1porn.tv" in url or "fpvcdn.com" in url:
            _referer = "https://www.1porn.tv/"
        elif "xvideos" in url:
            _referer = "https://www.xvideos.com/"
        elif "leakporner" in url or "58img" in url:
            _referer = "https://leakporner.com/"
        elif "mypornerleak" in url:
            _referer = "https://mypornerleak.com/"
        elif "cdntrex" in url or "porntrex" in url:
            _referer = "https://www.porntrex.com/"
        elif "rec-ur-bate" in url or "recurbate" in url:
            _referer = "https://rec-ur-bate.com/"
        elif "filester." in url or any(host in url for host in ("fileditchfiles.", "fileditchvids.", "theditch.", "freakingfileditch.", "blehpooffileditchvidsstuff.", "donotsharethesetemplinksyouidiot.")):
            _referer = "https://filester.me/" if "filester." in url else "https://fileditchvids.st/"
        elif "nsfw247" in url or "nsfwclips" in url:
            _referer = "https://nsfw247.to/"
        elif "coomerfans" in url:
            _referer = "https://coomerfans.com/"
        elif "pimpbunny" in url:
            _referer = "https://www.pimpbunny.com/"
        else:
            _referer = base_domain
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": _referer,
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        }
        
        # Use the global http_session for better performance
        async with http_session.get(url, timeout=15, headers=headers, ssl=False) as resp:
            if resp.status != 200:
                logging.warning(f"Proxy upstream returned {resp.status} for {url}")
                raise HTTPException(status_code=resp.status, detail=f"Upstream returned {resp.status}")
            
            content = await resp.read()
            content_type = resp.headers.get('Content-Type', 'image/jpeg') # Fallback to jpeg
            
            return Response(
                content=content,
                media_type=content_type,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "public, max-age=86400", # Cache for 24h
                    "X-Proxy-Source": "Quantum-CORS"
                }
            )
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Detailed CORS proxy error for {url}: {type(e).__name__}: {e}")
        raise HTTPException(status_code=500, detail=f"Proxy error: {str(e)}")


from collections import OrderedDict as _OrderedDict

_ORIG_HTTPX_ASYNC_CLIENT = httpx.AsyncClient
_SHARED_VIDEO_PROXY_CLIENT = None
_BUNKR_RAM_PREFIX_CACHE = _OrderedDict()
_BUNKR_RAM_CACHE_MAX_ENTRIES = 20
_BUNKR_RAM_CACHE_MAX_BYTES = 4 * 1024 * 1024

def _get_shared_video_proxy_client():
    global _SHARED_VIDEO_PROXY_CLIENT
    if _SHARED_VIDEO_PROXY_CLIENT is None or _SHARED_VIDEO_PROXY_CLIENT.is_closed:
        import ssl
        ssl_ctx = ssl._create_unverified_context()
        _SHARED_VIDEO_PROXY_CLIENT = _ORIG_HTTPX_ASYNC_CLIENT(
            follow_redirects=True,
            verify=ssl_ctx,
            limits=httpx.Limits(max_keepalive_connections=32, max_connections=64, keepalive_expiry=60.0),
        )
    return _SHARED_VIDEO_PROXY_CLIENT

def _store_bunkr_ram_prefix(url: str, data: bytes, total: int, content_type: str):
    if not data or total <= 0:
        return
    _BUNKR_RAM_PREFIX_CACHE[url] = {
        "bytes": data,
        "total": total,
        "content_type": content_type,
        "ts": time.monotonic(),
    }
    _BUNKR_RAM_PREFIX_CACHE.move_to_end(url)
    while len(_BUNKR_RAM_PREFIX_CACHE) > _BUNKR_RAM_CACHE_MAX_ENTRIES:
        _BUNKR_RAM_PREFIX_CACHE.popitem(last=False)

@api_v1_router.get("/video_proxy")
@api_legacy_router.get("/video_proxy")
async def video_stream_proxy(url: str, request: Request, referer: str = "", upstream_timeout: float = 30.0):
    """
    Streaming video proxy with Range request support, Keep-Alive connection pooling,
    and RAM prefix caching for instant Bunkr startup & seeking.
    """
    if not url:
        raise HTTPException(status_code=400, detail="url required")
    url = _require_public_proxy_url(url)

    url_lower = url.lower()
    ref_lower = (referer or "").lower()
    is_filester_proxy = (
        "filester." in url_lower
        or bool(re.search(r"(?:^|[/.])fsc\d*\.cdn\.cr\b", url_lower))
        or "filester." in ref_lower
    )
    is_fileditch_proxy = (
        any(host in url_lower for host in (
            "fileditch", "theditch.", "embedditch.", "staysharpwakesat5am.",
            "freakingfileditch.", "blehpooffileditchvidsstuff.",
            "donotsharethesetemplinksyouidiot.", "boomditching.",
        ))
        or any(host in ref_lower for host in ("fileditch", "theditch.", "embedditch."))
    )
    is_turbo_proxy = (
        "turbo.cr" in url_lower
        or "turbocdn.st" in url_lower
        or "turbo.cr" in ref_lower
    )
    is_bunkr_proxy = (
        not is_filester_proxy
        and not is_fileditch_proxy
        and not is_turbo_proxy
        and (
            any(h in url_lower for h in ("bunkr", "scdn.st", "cdn.cr", "balbums"))
            or "bunkr" in ref_lower
        )
    )

    from app.streaming.playback_control import control
    remaining = control.remaining(url)
    if remaining > 0 and not is_bunkr_proxy:
        raise HTTPException(503, detail="Provider cooling down", headers={"Retry-After": str(max(1, int(remaining)))})

    # Referer map
    _referer = referer or ("https://pixeldrain.com/" if "pixeldrain" in url else \
               "https://gofile.io/" if "gofile.io" in url else \
               "https://filester.me/" if is_filester_proxy else \
               "https://fileditchvids.st/" if is_fileditch_proxy else \
               "https://turbo.cr/" if is_turbo_proxy else \
               "https://bunkr.cr/" if is_bunkr_proxy else \
               "https://www.eporner.com/" if "eporner.com" in url_lower else \
               "https://www.camwhores.tv/" if "camwhores.tv/get_file/" in url else \
               str(request.base_url))

    upstream_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Referer": _referer,
        "Accept": "*/*",
        "Accept-Encoding": "identity",
    }
    if "pimpbunny.com" in url_lower or "pimpbunny.com" in _referer.lower():
        upstream_headers.update({
            "Origin": "https://pimpbunny.com",
            "Sec-Fetch-Dest": "video",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-site",
        })
    if "gofile.io" in url:
        try:
            from .extractors.gofile import GoFileExtractor
            gofile_token = GoFileExtractor._get_token()
            if gofile_token:
                upstream_headers["Authorization"] = f"Bearer {gofile_token}"
                upstream_headers["Cookie"] = f"accountToken={gofile_token}"
                upstream_headers["X-BL"] = "en-US"
                wt = GoFileExtractor._generate_website_token(gofile_token)
                if wt:
                    upstream_headers["X-Website-Token"] = wt
        except Exception as gofile_exc:
            logging.debug(f"[video_proxy] GoFile token injection failed: {gofile_exc}")
    if "camwhores.tv/get_file/" in url:
        try:
            from .extractors.camwhores import CamwhoresExtractor
            cookie_header, _ = CamwhoresExtractor()._cookie_bundle()
            if cookie_header:
                upstream_headers["Cookie"] = cookie_header
        except Exception as cookie_exc:
            logging.debug(f"[video_proxy] Camwhores cookie load failed: {cookie_exc}")
    if is_filester_proxy:
        try:
            from .extractors.filester import _load_cookies_from_paths
            from pathlib import Path
            repo_root = Path(__file__).resolve().parents[1]
            filester_cookies = _load_cookies_from_paths([
                str(repo_root / "filester.me_cookies.txt"),
                str(repo_root / "filester.cookies.txt"),
            ])
            if filester_cookies:
                upstream_headers["Cookie"] = "; ".join(
                    f"{name}={value}" for name, value in filester_cookies.items()
                )
        except Exception as cookie_exc:
            logging.debug(f"[video_proxy] Filester cookie load failed: {cookie_exc}")

    range_header = request.headers.get("range")
    use_shared_pool = (httpx.AsyncClient is _ORIG_HTTPX_ASYNC_CLIENT)

    # Check RAM prefix cache for instant 0ms startup on Bunkr streams
    if is_bunkr_proxy and use_shared_pool and url in _BUNKR_RAM_PREFIX_CACHE:
        cached = _BUNKR_RAM_PREFIX_CACHE[url]
        if time.monotonic() - cached["ts"] < 600 and cached["bytes"] and cached["total"] > 0:
            c_bytes = cached["bytes"]
            c_len = len(c_bytes)
            c_total = cached["total"]
            c_type = cached["content_type"]
            req_start, req_end = 0, None
            range_valid = True
            if range_header:
                m = re.match(r"^bytes=(\d+)-(\d*)$", range_header.strip())
                if m:
                    req_start = int(m.group(1))
                    req_end = int(m.group(2)) if m.group(2) else None
                else:
                    range_valid = False
            if range_valid and 0 <= req_start < c_len:
                # Case 1: Bounded range completely inside cached RAM prefix
                if req_end is not None and req_end < c_len:
                    slice_bytes = c_bytes[req_start : req_end + 1]
                    return Response(
                        content=slice_bytes,
                        status_code=206,
                        media_type=c_type,
                        headers={
                            "Access-Control-Allow-Origin": "*",
                            "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, X-Bunkr-Warm-Cache",
                            "Accept-Ranges": "bytes",
                            "Content-Encoding": "identity",
                            "Content-Range": f"bytes {req_start}-{req_end}/{c_total}",
                            "Content-Length": str(len(slice_bytes)),
                            "X-Bunkr-Warm-Cache": "HIT-FULL",
                        },
                    )
                # Case 2: Open-ended range (bytes=0-) or range extending beyond cached prefix -> yield RAM prefix in 0ms then seamlessly stream remainder!
                final_end = req_end if (req_end is not None and req_end < c_total) else (c_total - 1)
                total_to_send = final_end - req_start + 1
                timeout_seconds = max(0.5, min(30.0, upstream_timeout))

                async def hybrid_ram_then_upstream():
                    # 1. Immediately yield cached prefix from RAM (0ms TTFB!)
                    mv = memoryview(c_bytes)[req_start:]
                    for offset in range(0, len(mv), 65536):
                        yield bytes(mv[offset : offset + 65536])
                    # 2. Continue from c_len if needed
                    if final_end >= c_len:
                        cont_headers = dict(upstream_headers)
                        cont_headers["Range"] = f"bytes={c_len}-{final_end if req_end is not None else ''}"
                        shared_client = _get_shared_video_proxy_client()
                        cont_req = shared_client.build_request(
                            "GET", url, headers=cont_headers,
                            timeout=httpx.Timeout(timeout_seconds, connect=min(10.0, timeout_seconds))
                        )
                        cont_resp = await shared_client.send(cont_req, stream=True)
                        try:
                            if cont_resp.status_code in (200, 206):
                                async for chunk in cont_resp.aiter_bytes(65536):
                                    yield chunk
                        finally:
                            await cont_resp.aclose()

                return StreamingResponse(
                    hybrid_ram_then_upstream(),
                    status_code=206,
                    media_type=c_type,
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, X-Bunkr-Warm-Cache",
                        "Accept-Ranges": "bytes",
                        "Content-Encoding": "identity",
                        "Content-Range": f"bytes {req_start}-{final_end}/{c_total}",
                        "Content-Length": str(total_to_send),
                        "X-Bunkr-Warm-Cache": "HIT-PREFIX",
                    },
                )

    if range_header:
        upstream_headers["Range"] = range_header

    client = None
    resp = None
    try:
        timeout_seconds = max(0.5, min(30.0, upstream_timeout))
        req_timeout = httpx.Timeout(timeout_seconds, connect=min(10.0, timeout_seconds))
        if use_shared_pool:
            client = _get_shared_video_proxy_client()
            req = client.build_request("GET", url, headers=upstream_headers, timeout=req_timeout)
        else:
            import ssl
            if not hasattr(video_stream_proxy, "_ssl_ctx"):
                video_stream_proxy._ssl_ctx = ssl._create_unverified_context()
            client = httpx.AsyncClient(timeout=req_timeout, follow_redirects=True, verify=video_stream_proxy._ssl_ctx)
            req = client.build_request("GET", url, headers=upstream_headers)

        resp = await client.send(req, stream=True)

        # Auto-heal expired Bunkr signed URLs on the fly if referer watch page is known
        if resp.status_code in (403, 410, 429, 502, 503) and is_bunkr_proxy and use_shared_pool and re.search(r"/(?:f|v)/[A-Za-z0-9_-]+", _referer):
            await resp.aclose()
            resp = None
            from app.streaming.resolution import get_resolver
            get_resolver().invalidate_url(url)
            try:
                from app.extractors.bunkr import BunkrExtractor
                fresh_res, _ = await get_resolver().resolve(
                    ("bunkr_autoheal", _referer),
                    lambda: BunkrExtractor().extract(_referer),
                    reusable=True, force=True, timeout=8,
                )
                fresh_url = (fresh_res or {}).get("stream_url")
                if fresh_url and fresh_url != url:
                    logging.info(f"[video_proxy] Auto-healed expired Bunkr URL via {_referer}")
                    url = _require_public_proxy_url(fresh_url)
                    req = client.build_request("GET", url, headers=upstream_headers, timeout=req_timeout)
                    resp = await client.send(req, stream=True)
            except Exception as heal_err:
                logging.warning(f"[video_proxy] Bunkr auto-heal failed for {_referer}: {heal_err}")

        # Auto-heal expired/IP-bound Filester and FileDitch signed URLs on the fly
        if resp is not None and resp.status_code in (403, 410, 429, 502, 503) and (is_filester_proxy or is_fileditch_proxy) and use_shared_pool and _referer:
            try:
                from .extractors.filester import FilesterExtractor
                _fe = FilesterExtractor()
                if _fe.can_handle(_referer) and not _fe._extract_folder_slug(_referer):
                    await resp.aclose()
                    resp = None
                    fresh_res = await _fe.extract(_referer)
                    fresh_url = (fresh_res or {}).get("stream_url")
                    if fresh_url and fresh_url != url:
                        logging.info(f"[video_proxy] Auto-healed expired Filester/FileDitch URL via {_referer}")
                        url = _require_public_proxy_url(fresh_url)
                        req = client.build_request("GET", url, headers=upstream_headers, timeout=req_timeout)
                        resp = await client.send(req, stream=True)
            except Exception as heal_err:
                logging.warning(f"[video_proxy] Filester/FileDitch auto-heal failed for {_referer}: {heal_err}")

        # Auto-heal expired Turbo signed CDN URLs on the fly
        if resp is not None and resp.status_code in (403, 404, 410, 429, 502, 503) and is_turbo_proxy and use_shared_pool and _referer:
            try:
                from .extractors.turbo import TurboExtractor
                _te = TurboExtractor()
                if _te.can_handle(_referer):
                    await resp.aclose()
                    resp = None
                    fresh_res = await _te.extract(_referer)
                    fresh_url = (fresh_res or {}).get("stream_url")
                    if fresh_url and fresh_url != url:
                        logging.info(f"[video_proxy] Auto-healed expired Turbo URL via {_referer}")
                        url = _require_public_proxy_url(fresh_url)
                        req = client.build_request("GET", url, headers=upstream_headers, timeout=req_timeout)
                        resp = await client.send(req, stream=True)
            except Exception as heal_err:
                logging.warning(f"[video_proxy] Turbo auto-heal failed for {_referer}: {heal_err}")

        if resp is None:
            raise HTTPException(status_code=503, detail="Upstream 503")

        if resp.status_code in (403, 410, 429, 503):
            from app.ntc.bunkr_scheduler import retry_after
            from app.streaming.resolution import get_resolver
            get_resolver().invalidate_url(url)
            if resp.status_code in (429, 503):
                cd_sec = min(1, retry_after(resp.headers) or 1) if is_bunkr_proxy else (retry_after(resp.headers) or 30)
                control.cooldown(url, resp.status_code, cd_sec)
        if resp.status_code >= 400:
            await resp.aclose()
            if not use_shared_pool and client is not None:
                await client.aclose()
            raise HTTPException(status_code=resp.status_code, detail=f"Upstream {resp.status_code}")

        content_type = resp.headers.get("content-type", "video/mp4")
        if content_type.split(";", 1)[0].strip().lower() == "application/octet-stream":
            from mimetypes import guess_type
            guessed_type, _ = guess_type(urllib.parse.urlsplit(url).path)
            if guessed_type and guessed_type.startswith("video/"):
                content_type = guessed_type
            elif is_filester_proxy or is_fileditch_proxy or is_turbo_proxy:
                content_type = "video/mp4"
        status_code = resp.status_code  # 200 or 206

        forward_headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, X-Bunkr-Warm-Cache",
            "Accept-Ranges": resp.headers.get("accept-ranges", "bytes"),
            "Content-Encoding": "identity",
        }
        if "content-range" in resp.headers:
            forward_headers["Content-Range"] = resp.headers["content-range"]
        if "content-length" in resp.headers:
            forward_headers["Content-Length"] = resp.headers["content-length"]

        # Parse total bytes and check if this starts at byte 0 so we can populate RAM prefix cache
        cache_eligible = False
        total_file_bytes = 0
        if is_bunkr_proxy and use_shared_pool:
            cr_val = resp.headers.get("content-range", "")
            m_cr = re.search(r"bytes\s+0-(\d+)/(\d+)", cr_val)
            if m_cr:
                cache_eligible = True
                total_file_bytes = int(m_cr.group(2))

        async def stream_chunks():
            prefix_buf = bytearray() if cache_eligible else None
            try:
                async for chunk in resp.aiter_bytes(65536):
                    if prefix_buf is not None and len(prefix_buf) < _BUNKR_RAM_CACHE_MAX_BYTES:
                        needed = _BUNKR_RAM_CACHE_MAX_BYTES - len(prefix_buf)
                        prefix_buf.extend(chunk[:needed])
                        if len(prefix_buf) >= min(_BUNKR_RAM_CACHE_MAX_BYTES, total_file_bytes):
                            _store_bunkr_ram_prefix(url, bytes(prefix_buf), total_file_bytes, content_type)
                            prefix_buf = None
                    yield chunk
                if prefix_buf is not None and len(prefix_buf) >= 262144:
                    _store_bunkr_ram_prefix(url, bytes(prefix_buf), total_file_bytes, content_type)
            finally:
                await resp.aclose()
                if not use_shared_pool and client is not None:
                    await client.aclose()

        return StreamingResponse(
            stream_chunks(),
            status_code=status_code,
            media_type=content_type,
            headers=forward_headers,
        )
    except HTTPException:
        raise
    except BaseException as e:
        if resp is not None:
            await resp.aclose()
        if not use_shared_pool and client is not None:
            await client.aclose()
        if not isinstance(e, Exception):
            raise
        logging.error(f"[video_proxy] error for {url}: {e}")
        raise HTTPException(status_code=502, detail=f"Proxy error: {e}")

@api_v1_router.get("/stream/cache")
@api_legacy_router.get("/stream/cache")
async def stream_cached_chunk(url: str, request: Request):
    """
    High-Performance LRU Disk Cache for Split-Screen Video Streaming.
    Serves Range chunks (e.g. bytes=X-Y) with instant 0ms latency from local disk
    if previously cached; otherwise fetches from CDN upstream, writes to disk, and streams.
    """
    if not url:
        raise HTTPException(status_code=400, detail="url required")
    url = _require_public_proxy_url(url)
    from .stream_cache import stream_cache

    range_header = request.headers.get("range")
    # Cache only a small, explicit byte interval. Open/suffix/full requests
    # must start streaming immediately, never buffer an entire movie in RAM.
    match = re.fullmatch(r"bytes=(\d+)-(\d+)", range_header or "")
    if not match:
        return await video_stream_proxy(url, request, referer=request.query_params.get("referer", ""))
    start, end = map(int, match.groups())
    if end < start:
        raise HTTPException(status_code=416, detail="Invalid byte range")
    if end - start + 1 > 4 * 1024 * 1024:
        return await video_stream_proxy(url, request, referer=request.query_params.get("referer", ""))

    # If full chunk range requested, check disk cache
    if end is not None and end > start:
        cached_data = await stream_cache.get_chunk(url, start, end)
        if cached_data:
            content_len = len(cached_data)
            headers = {
                "Access-Control-Allow-Origin": "*",
                "Accept-Ranges": "bytes",
                "Content-Range": f"bytes {start}-{end}/*",
                "Content-Length": str(content_len),
                "X-Cache-Lookup": "HIT",
            }
            return Response(content=cached_data, status_code=206, media_type="video/mp4", headers=headers)

    # Cache MISS - stream from upstream & cache in background
    upstream_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Referer": "https://bunkr.cr/",
        "Accept": "*/*",
    }
    if range_header:
        upstream_headers["Range"] = range_header

    client = None
    resp = None
    try:
        client = httpx.AsyncClient(timeout=httpx.Timeout(12.0, connect=5.0), follow_redirects=True, verify=False)
        upstream_headers["Accept-Encoding"] = "identity"
        if request.query_params.get("referer"):
            upstream_headers["Referer"] = request.query_params["referer"]
        req = client.build_request("GET", url, headers=upstream_headers)
        resp = await client.send(req, stream=True)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail="Upstream CDN error")
        content_range = resp.headers.get("content-range", "")
        returned_range = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+|\*)", content_range)
        if resp.status_code != 206 or not returned_range:
            raise HTTPException(status_code=502, detail="Upstream did not honor the requested byte range")
        returned_start, returned_end = map(int, returned_range.groups()[:2])
        total = returned_range.group(3)
        # A range extending past EOF is legitimately clamped by the origin.
        valid_end = end if total == "*" else min(end, int(total) - 1)
        if returned_start != start or returned_end != valid_end or returned_end < start:
            raise HTTPException(status_code=502, detail="Upstream returned a different byte range")
        expected = returned_end - start + 1
        chunks = bytearray()
        async for chunk in resp.aiter_bytes(65536):
            chunks.extend(chunk)
            if len(chunks) > expected:
                raise HTTPException(status_code=502, detail="Upstream exceeded the requested byte range")
        if len(chunks) != expected:
            raise HTTPException(status_code=502, detail="Incomplete upstream byte range")
        data = bytes(chunks)
        await stream_cache.put_chunk(url, start, returned_end, data)

        forward_headers = {
            "Access-Control-Allow-Origin": "*",
            "Accept-Ranges": "bytes",
            "X-Cache-Lookup": "MISS",
        }
        if "content-range" in resp.headers:
            forward_headers["Content-Range"] = resp.headers["content-range"]
        if "content-length" in resp.headers:
            forward_headers["Content-Length"] = resp.headers["content-length"]

        return Response(content=data, status_code=resp.status_code, media_type="video/mp4", headers=forward_headers)
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[stream/cache] error for {url}: {e}")
        raise HTTPException(status_code=502, detail=str(e))
    finally:
        if resp is not None:
            await resp.aclose()
        if client is not None:
            await client.aclose()


def _proxy_content_disposition(filename: str) -> str:
    """Build a safe download filename for a locally proxied media response."""
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', '_', (filename or '').strip())
    cleaned = cleaned.strip(' .') or 'video.mp4'
    if not cleaned.lower().endswith('.mp4'):
        cleaned = f'{cleaned}.mp4'
    ascii_fallback = re.sub(r'[^A-Za-z0-9._ -]+', '_', cleaned).strip(' .') or 'video.mp4'
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{urllib.parse.quote(cleaned)}"


_LULU_CDN_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def _is_lulu_cdn_url(url: str) -> bool:
    host = (urllib.parse.urlparse(url or "").hostname or "").lower()
    return host.endswith("tnmr.org") or "tnmr.org" in host


def _lulu_cdn_headers(extra: Optional[dict] = None) -> dict:
    # Lulu's nginx edge rejects several live Chrome majors (e.g. 154) and any
    # Accept-Language header. Pin a known-good desktop Chrome build and always
    # speak as the Lulu player origin for both manifests and media segments.
    headers = {
        "User-Agent": _LULU_CDN_UA,
        "Accept": "*/*",
        "Referer": "https://luluvdo.com/",
        "Origin": "https://luluvdo.com",
        "Connection": "keep-alive",
    }
    if extra:
        for key, value in extra.items():
            if value is None or key.lower() in {"accept-language", "user-agent", "referer", "origin"}:
                continue
            headers[key] = value
    return headers


async def _hls_proxy_stream_segment(url: str, headers: dict, cookies: dict, filename: str = ''):
    """Strict Range-preserving upstream stream; never buffer media in RAM."""
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=20, sock_read=60)

    async def _open(hdrs):
        if _is_pornhub_cdn(url):
            response = await asyncio.to_thread(requests.get, url, headers=hdrs,
                                               cookies=cookies or None, stream=True, timeout=(20, 60))
            return _ThreadedMediaResponse(response)
        if _is_oneporn_media(url):
            try:
                from curl_cffi import requests as _creq
                from .oneporn_client import get_1porn_cookies, UA as ONEPORN_UA
                op_cookies = get_1porn_cookies()
                cookie_str = "; ".join(f"{k}={v}" for k, v in op_cookies.items())
                cffi_headers = dict(hdrs)
                cffi_headers["User-Agent"] = ONEPORN_UA
                if cookie_str:
                    cffi_headers["Cookie"] = cookie_str
                if not cffi_headers.get("Referer"):
                    cffi_headers["Referer"] = "https://www.1porn.tv/"
                response = await asyncio.to_thread(
                    _creq.get, url, headers=cffi_headers, impersonate="chrome124", allow_redirects=True, stream=True, timeout=30
                )
                return _CffiThreadedMediaResponse(response)
            except Exception as e:
                logging.warning(f"[hls_proxy] 1porn media stream error: {e}")
        return await http_session.get(url, headers=hdrs, cookies=cookies or None,
                                      timeout=timeout, ssl=False)

    resp = await _open(headers)
    if resp.status == 403:
        resp.release()
        if _is_lulu_cdn_url(url):
            h2 = _lulu_cdn_headers({"Range": headers.get("Range")})
        elif headers.get("Referer"):
            h2 = {k: v for k, v in headers.items() if k not in ("Referer", "Origin")}
        else:
            h2 = None
        if h2 is not None:
            resp = await _open(h2)

    if resp.status not in (200, 206):
        status = resp.status
        resp.release()
        logging.error(f"[hls_proxy] segment upstream {status} for {url}")
        raise HTTPException(status, f"Upstream error {status}")

    out_headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
        "Accept-Ranges": resp.headers.get("Accept-Ranges", "bytes"),
        "Content-Encoding": "identity",
    }
    # Preserve upstream range metadata exactly; never calculate content length
    # from a buffered body because that breaks seeks and 206 responses.
    for h in ("Content-Range", "Content-Length", "ETag", "Last-Modified"):
        if h in resp.headers:
            out_headers[h] = resp.headers[h]
    if filename:
        out_headers["Content-Disposition"] = _proxy_content_disposition(filename)
    raw_content_type = (resp.headers.get("Content-Type") or "").lower()
    low_url = (url or "").lower()
    png_transport_segment = ('tiktokcdn.com/' in low_url and '.image' in low_url and not headers.get('Range'))
    if png_transport_segment:
        for key in ('Content-Length', 'Content-Range', 'ETag', 'Last-Modified'):
            out_headers.pop(key, None)
        media_type = 'video/MP2T'
    elif ".css" in low_url or "text/css" in raw_content_type:
        media_type = "text/css"
    elif ".js" in low_url or ".mjs" in low_url or "javascript" in raw_content_type:
        media_type = "application/javascript"
    elif ".woff2" in low_url or "woff2" in raw_content_type:
        media_type = "font/woff2"
    elif ".woff" in low_url or "font/woff" in raw_content_type:
        media_type = "font/woff"
    elif ".svg" in low_url or "svg" in raw_content_type:
        media_type = "image/svg+xml"
    elif any(ext in low_url for ext in (".jpg", ".jpeg")) or "jpeg" in raw_content_type:
        media_type = "image/jpeg"
    elif ".png" in low_url or "png" in raw_content_type:
        media_type = "image/png"
    elif ".webp" in low_url or "webp" in raw_content_type:
        media_type = "image/webp"
    elif ".mp4" in low_url or ".m4v" in low_url or "video/mp4" in raw_content_type:
        media_type = "video/mp4"
    elif ".m3u8" in low_url or "mpegurl" in raw_content_type:
        media_type = "application/vnd.apple.mpegurl"
    elif ".mpd" in low_url or "dash+xml" in raw_content_type:
        media_type = "application/dash+xml"
    elif ".ts" in low_url or "mp2t" in raw_content_type:
        media_type = "video/MP2T"
    elif raw_content_type and "octet-stream" not in raw_content_type:
        media_type = resp.headers.get("Content-Type")
    else:
        media_type = "video/MP2T"
    status_code = resp.status

    async def _body():
        try:
            # 64KB chunks: immediate TTFB on seeking without waiting for 1MB buffer fill
            prefix = b''
            checking_png = png_transport_segment
            async for chunk in resp.content.iter_chunked(64 * 1024):
                if checking_png:
                    prefix += chunk
                    marker = prefix.find(b'IEND')
                    if marker < 0 and len(prefix) < 65536:
                        continue
                    end = marker + 8
                    if prefix.startswith(b'\x89PNG\r\n\x1a\n') and marker >= 0 and prefix[end:end + 1] == b'\x47':
                        chunk = prefix[end:]
                    else:
                        chunk = prefix
                    checking_png = False
                yield chunk
            if checking_png and prefix:
                yield prefix
        finally:
            resp.release()

    return StreamingResponse(_body(), status_code=status_code,
                             media_type=media_type, headers=out_headers)


_leakedzone_manifest_cache: dict = {}


def _is_pornhub_cdn(url: str) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or '').lower()
    return host == 'phncdn.com' or host.endswith('.phncdn.com')


def _is_oneporn_media(url: str) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or '').lower()
    return any(d in host for d in ('1porn.tv', 'ahcdn.com', 'fpvcdn.com'))


class _CffiThreadedMediaResponse:
    def __init__(self, response):
        self.response = response
        self.status = response.status_code
        self.headers = response.headers
        self.content = self

    async def iter_chunked(self, size):
        for chunk in self.response.iter_content(chunk_size=size):
            yield chunk

    def release(self):
        self.response.close()


class _ThreadedMediaResponse:
    """Expose bounded requests reads to the async streaming proxy."""
    def __init__(self, response):
        self.response = response
        self.status = response.status_code
        self.headers = response.headers
        self.content = self

    async def iter_chunked(self, size):
        while True:
            chunk = await asyncio.to_thread(self.response.raw.read, size, decode_content=True)
            if not chunk:
                break
            yield chunk

    def release(self):
        self.response.close()


@app.get("/hls_proxy")
@app.get("/hls_proxy.m3u8")
@app.get("/media_proxy.mp4")
async def hls_proxy(request: Request, url: str = "", referer: str = "", session: str = "", filename: str = ""):
    """
    HLS rewriting proxy — rewrites m3u8 playlists so .ts segments are fetched
    through this proxy with the correct headers (fixes 404s/403s).
    """
    if "leakedzone.com" in url.lower():
        cached_entry = _leakedzone_manifest_cache.get(url)
        if cached_entry and (time.time() - cached_entry.get("ts", 0)) < 7200:
            return Response(
                content=cached_entry["content"],
                media_type="application/vnd.apple.mpegurl",
                headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"},
            )

    def _origin_from_urlish(value: str) -> str:
        parsed = urllib.parse.urlparse((value or "").strip())
        if parsed.scheme in ("http", "https") and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
        return ""

    def _get_embed_session(session_id: str) -> Optional[dict]:
        if not session_id:
            return None
        entry = _embed_proxy_sessions.get(session_id)
        if not entry:
            return None
        if (time.time() - entry.get("ts", 0)) > _EMBED_PROXY_SESSION_TTL:
            _embed_proxy_sessions.pop(session_id, None)
            return None
        return entry

    session_entry = _get_embed_session(session)
    if session_entry:
        if not referer:
            referer = session_entry.get("referer") or referer
        if (not url or url == "session") and session_entry.get("url"):
            url = session_entry["url"]

    url = _require_public_proxy_url(url)
    parsed_target = urllib.parse.urlparse(url)
    target_origin = f"{parsed_target.scheme}://{parsed_target.netloc}"

    # JW Player ping URL extraction
    if "ping.gif" in url.lower() and "mu=" in url.lower():
        try:
            parsed_query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            if 'mu' in parsed_query:
                url = parsed_query['mu'][0]
        except: pass

    # Mirror headers from the browser for maximum compatibility
    browser_ua = request.headers.get("User-Agent")
    browser_accept = request.headers.get("Accept")
    browser_lang = request.headers.get("Accept-Language")
    
    headers = {
        "User-Agent": browser_ua or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": browser_accept or "*/*",
        "Accept-Language": browser_lang or "en-US,en;q=0.9",
        "Connection": "keep-alive",
    }
    
    if "redgifs.com" in url:
        headers["Referer"] = "https://www.redgifs.com/"
    elif "camwhores.tv" in url:
        headers["Referer"] = "https://www.camwhores.tv/"
    
    incoming_range = request.headers.get("Range")
    if incoming_range:
        headers["Range"] = incoming_range
    
    # Domain-specific header logic
    if "tiktokcdn.com" in url.lower():
        # TikTok is extremely sensitive to Referer/Origin mismatch
        if referer and "tiktok.com" not in referer.lower():
            headers["Referer"] = referer
        else:
            headers["Referer"] = "https://www.tiktok.com/"
        # DO NOT send Origin for TikTok CDN
    elif "cdnvids.top" in url.lower() or "cdnstream.top" in url.lower() or "luluvids.top" in url.lower():
        headers["Referer"] = referer or "https://leakporner.com/"
        headers["Origin"] = _origin_from_urlish(referer) or "https://leakporner.com"
    elif _is_lulu_cdn_url(url):
        # Forwarding the live browser UA (Chrome 154+) or Accept-Language makes
        # Lulu's nginx edge answer 403 for both the master playlist and .ts
        # segments. Always speak as a known-good Lulu player origin.
        headers.clear()
        headers.update(_lulu_cdn_headers({"Range": incoming_range} if incoming_range else None))
    elif "xhamster.com" in url.lower() or "xhcdn.com" in url.lower():
        headers["Referer"] = referer if (referer and "xhamster.com" in referer.lower()) else "https://xhamster.com/"
        headers["Origin"] = "https://xhamster.com"
    elif "flixcdn.com" in url.lower():
        # FapHouse uses signed HLS links but validates the page context for
        # both the manifest and each media segment.  JDownloader reaches this
        # local proxy rather than the CDN, so restore the browser headers here.
        headers["Referer"] = referer if (referer and "faphouse.com" in referer.lower()) else "https://faphouse.com/"
        headers["Origin"] = "https://faphouse.com"
    elif "phncdn.com" in url.lower():
        # Pornhub's CDN validates the watch-page context for a session-bound
        # manifest and its child segments.
        headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
        headers["Accept"] = "application/vnd.apple.mpegurl, application/x-mpegURL, video/*;q=0.9, */*;q=0.8"
        headers["Accept-Language"] = "en-US,en;q=0.9"
        headers["Referer"] = referer if (referer and "pornhub." in referer.lower()) else "https://www.pornhub.com/"
        headers["Origin"] = "https://www.pornhub.com"
    elif any(d in url.lower() for d in ("97bf1.com", "vidara.so", "vidara.to", "vidsonic.net", "vidfast.co")):
        headers["Referer"] = "https://vidara.to/" if "vidara.to" in url.lower() else "https://vidara.so/"
        headers["Origin"] = "https://vidara.to" if "vidara.to" in url.lower() else "https://vidara.so"
    elif "leakedzone.com" in url.lower() or "b-cdn.net" in url.lower():
        headers["Referer"] = referer if (referer and "leakedzone.com" in referer.lower()) else "https://leakedzone.com/"
        headers["Origin"] = "https://leakedzone.com"
    elif "xvix.eu" in url.lower():
        headers["Referer"] = referer or "https://djav.org/"
        headers["Origin"] = "https://djav.org"
    elif any(d in url.lower() for d in ("1porn.tv", "fpvcdn.com", "ahcdn.com")):
        headers["Referer"] = referer or "https://www.1porn.tv/"
        headers["Origin"] = "https://www.1porn.tv"
    else:
        headers["Referer"] = referer or f"{target_origin}/"
        headers["Origin"] = _origin_from_urlish(referer) or target_origin

    is_m3u8 = ".m3u8" in url.lower() or "mpegurl" in request.query_params.get("url", "").lower()

    # VK/OK Cookies
    cookies = {}
    if session_entry and session_entry.get("cookies"):
        cookies.update(session_entry["cookies"])
    if any(d in url.lower() for d in ['vk.com', 'vk.video', 'vkvideo.ru', 'okcdn.ru', 'vkvideo.net', 'vk.ru']):
        # (Cookie loading logic remains same but optimized)
        _candidates = ["vkvideo.ru_cookies.txt", "vk.com_cookies.txt", "vk.netscape.txt", "vkvideos.ru_cookies.txt", os.path.join("app", "vkvideo.ru_cookies.txt"), os.path.join("app", "vk.com_cookies.txt"), os.path.join("app", "vk.netscape.txt"), os.path.join("app", "vkvideos.ru_cookies.txt"), "cookies.netscape.txt"]
        _cf = next((p for p in _candidates if os.path.exists(p)), None)
        if _cf:
            try:
                with open(_cf, 'r', encoding="utf-8") as f:
                    for l in f:
                        if not l.startswith('#') and l.strip():
                            p = l.strip().split('\t')
                            if len(p) >= 7: cookies[p[5]] = p[6]
            except: pass
    elif "flixcdn.com" in url.lower():
        # A signed Faphouse manifest alone is not sufficient on all CDN edges:
        # replay the same logged-in cookie jar that resolved the watch page for
        # both the manifest and its rewritten media segments.
        from .hubs.faphouse import COOKIE_CANDIDATES
        cookies.update(load_cookie_dict(resolve_cookiefile(*COOKIE_CANDIDATES)))

    try:
        # A Range request must stay byte-for-byte passthrough: rewriting an
        # m3u8 body would invalidate its Content-Range. Media is always streamed.
        looks_like_segment = not (is_m3u8 or url.lower().endswith(".m3u8"))

        if incoming_range or looks_like_segment:
            return await _hls_proxy_stream_segment(url, headers, cookies, filename)

        timeout = aiohttp.ClientTimeout(total=35)

        async def _read_upstream(hdrs: dict):
            if _is_pornhub_cdn(url):
                def read_manifest():
                    with requests.get(url, headers=hdrs, cookies=cookies or None, timeout=(10, 25)) as response:
                        return response.status_code, response.content, response.headers.get('Content-Type', ''), dict(response.headers)
                return await asyncio.to_thread(read_manifest)
            async with http_session.get(
                url,
                headers=hdrs,
                cookies=cookies if cookies else None,
                timeout=timeout,
                ssl=False,
            ) as upstream:
                payload = await upstream.read()
                return (
                    upstream.status,
                    payload,
                    upstream.headers.get("Content-Type", ""),
                    {k: v for k, v in upstream.headers.items()},
                )

        status, raw, content_type, upstream_headers = await _read_upstream(headers)
        if status == 403:
            if _is_lulu_cdn_url(url):
                logging.warning(f"[hls_proxy] 403 for {url}. Retrying with pinned Lulu CDN headers...")
                headers = _lulu_cdn_headers({"Range": incoming_range} if incoming_range else None)
                status, raw, content_type, upstream_headers = await _read_upstream(headers)
            elif "leakedzone.com" in url.lower() and referer and "leakedzone.com" in referer.lower():
                logging.warning(f"[hls_proxy] 403 for {url}. Re-extracting fresh playlist from {referer}...")
                try:
                    from .extractors.leakedzone import LeakedzoneExtractor
                    ext_data = await LeakedzoneExtractor().extract(referer)
                    if ext_data and ext_data.get("stream_url"):
                        url = ext_data["stream_url"]
                        if ext_data.get("proxy_cookies"):
                            cookies.update(ext_data["proxy_cookies"])
                        headers["Referer"] = referer
                        headers["Origin"] = "https://leakedzone.com"
                        status, raw, content_type, upstream_headers = await _read_upstream(headers)
                except Exception as lz_err:
                    logging.warning(f"[hls_proxy] Leakedzone re-extract failed: {lz_err}")
            elif headers.get("Referer"):
                logging.warning(f"[hls_proxy] 403 for {url}. Retrying without Referer...")
                headers.pop("Referer", None)
                headers.pop("Origin", None)
                status, raw, content_type, upstream_headers = await _read_upstream(headers)

        if status not in (200, 206):
            logging.error(f"[hls_proxy] Upstream {status} for {url} | Headers: {headers}")
            raise HTTPException(status, f"Upstream error {status}")

        upstream_status = status

        # If a non-m3u8 URL turned out to be a playlist (served as mpegurl),
        # fall through to rewriting; otherwise it's a tiny key/text blob.
        if is_m3u8 or "mpegurl" in content_type.lower() or url.endswith(".m3u8"):
            body = raw.decode("utf-8", errors="replace")
            encoded_referer = urllib.parse.quote(referer, safe="")
            encoded_session = f"&session={urllib.parse.quote(session, safe='')}" if session else ""
            lines = []
            for line in body.splitlines():
                stripped = line.strip()
                if stripped and not stripped.startswith("#"):
                    seg_url = urllib.parse.urljoin(url, stripped)
                    if not ('tiktokcdn.com/' in seg_url.lower() and '.image' in seg_url.lower()) and any(token in seg_url.lower() for token in ("tiktokcdn", ".image", "ad-site")):
                        lines.append(seg_url)
                    else:
                        encoded_seg = urllib.parse.quote(seg_url, safe="")
                        lines.append(f"/hls_proxy?url={encoded_seg}&referer={encoded_referer}{encoded_session}")
                elif stripped.startswith("#EXT-X-") and 'URI="' in stripped:
                    def rewrite_key_uri(m):
                        key_url = urllib.parse.urljoin(url, m.group(1))
                        encoded_key = urllib.parse.quote(key_url, safe="")
                        return f'URI="/hls_proxy?url={encoded_key}&referer={encoded_referer}{encoded_session}"'
                    lines.append(re.sub(r'URI="([^"]+)"', rewrite_key_uri, stripped))
                else:
                    lines.append(line)
            rewritten_playlist = "\n".join(lines)
            if "leakedzone.com" in url.lower():
                _leakedzone_manifest_cache[url] = {
                    "content": rewritten_playlist,
                    "ts": time.time(),
                }
            return Response(
                content=rewritten_playlist,
                media_type="application/vnd.apple.mpegurl",
                headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"},
            )

        # Raw segment
        response_headers = {
            "Access-Control-Allow-Origin": "*", 
            "Cache-Control": "public, max-age=3600",
            "Accept-Ranges": "bytes"
        }
        if "Content-Range" in upstream_headers: response_headers["Content-Range"] = upstream_headers["Content-Range"]
        response_headers["Content-Length"] = str(len(raw))
            
        return Response(
            content=raw,
            status_code=upstream_status,
            media_type=content_type or "video/MP2T",
            headers=response_headers,
        )
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"[hls_proxy] Error: {e}")
        raise HTTPException(500, str(e))


def _resolve_proxy_target_from_referer(referer: str) -> tuple[str, str]:
    """
    Resolve the original upstream URL/domain from nested local proxy referers.
    This lets iframe child requests such as `/frontPagesBundle-*.js` or
    `/api/dashboard` find their real source even when the browser referer points
    to `/embed_proxy?...` or `/hls_proxy?...` instead of the remote site.
    """
    fallback_domain = "https://bysezoxexe.com"
    current = (referer or "").strip()
    visited = set()

    for _ in range(4):
        if not current or current in visited:
            break
        visited.add(current)
        try:
            parsed = urllib.parse.urlparse(current)
        except Exception:
            break

        if parsed.scheme in ("http", "https") and parsed.netloc and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            return f"{parsed.scheme}://{parsed.netloc}", current

        query_params = urllib.parse.parse_qs(parsed.query)
        nested = (query_params.get("url") or [None])[0]
        if not nested:
            break
        current = urllib.parse.unquote(nested)

    return fallback_domain, ""


def _resolve_proxy_target_url_from_referer(referer: str) -> str:
    current = (referer or "").strip()
    visited = set()

    for _ in range(5):
        if not current or current in visited:
            break
        visited.add(current)
        try:
            parsed = urllib.parse.urlparse(current)
        except Exception:
            break

        query_params = urllib.parse.parse_qs(parsed.query)
        nested = (query_params.get("url") or [None])[0]
        if nested:
            current = urllib.parse.unquote(nested)
            continue

        if parsed.scheme in ("http", "https") and parsed.netloc and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            return current
        break

    return ""


def _extract_embed_proxy_session(request: Request) -> str:
    direct = (request.query_params.get("session") or "").strip()
    if direct:
        return direct

    referer = (request.headers.get("Referer") or "").strip()
    if not referer:
        return ""

    try:
        parsed = urllib.parse.urlparse(referer)
        query_params = urllib.parse.parse_qs(parsed.query)
        nested_session = (query_params.get("session") or [None])[0]
        return (nested_session or "").strip()
    except Exception:
        return ""


def _get_embed_proxy_session_entry(session_id: str) -> Optional[dict]:
    if not session_id:
        return None
    entry = _embed_proxy_sessions.get(session_id)
    if not entry:
        return None
    if (time.time() - entry.get("ts", 0)) > _EMBED_PROXY_SESSION_TTL:
        _embed_proxy_sessions.pop(session_id, None)
        return None
    return entry


@app.get("/download/{video_id}")
async def download_direct(video_id: int, request: Request, db: Session = Depends(get_db)):
    v = db.query(Video).get(video_id)
    if not v: raise HTTPException(404)
    if _routes_mega._is_mega_video(v):
        return await _routes_mega.mega_download(video_id, request, db)
    async def iter_file():
        async with aiohttp.ClientSession() as session:
            async with session.get(v.url) as resp:
                async for chunk in resp.content.iter_chunked(64*1024): yield chunk
    
    # Create ASCII-safe filename for compatibility
    safe = "".join([c for c in v.title if c.isalnum() or c in (' ','-','_')]).strip()
    if not safe:
        safe = f"video_{video_id}"
    
    # Use RFC 5987 encoding for Unicode support (filename* parameter)
    import urllib.parse
    encoded_title = urllib.parse.quote(v.title.encode('utf-8'))
    
    # Provide both ASCII fallback and UTF-8 encoded filename
    content_disposition = f'attachment; filename="{safe}.mp4"; filename*=UTF-8\'\'{encoded_title}.mp4'
    
    return StreamingResponse(iter_file(), headers={"Content-Disposition": content_disposition})

def get_stream_url(video_id: int):
    return f"/stream_proxy/{video_id}.mp4"

# --- UTILITY ENDPOINTS ---

@api_v1_router.get("/export-library")
@api_legacy_router.get("/export-library")
def export_library(db: Session = Depends(get_db)):
    """Export entire library as JSON"""
    videos = db.query(Video).all()
    results = []
    for v in videos:
        video_dict = v.__dict__
        video_dict.pop('_sa_instance_state', None)
        # Convert datetime to ISO format
        if video_dict.get('created_at'):
            video_dict['created_at'] = video_dict['created_at'].isoformat()
        if video_dict.get('last_checked'):
            video_dict['last_checked'] = video_dict['last_checked'].isoformat()
        results.append(video_dict)
    
    return JSONResponse(content={
        "export_date": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat(),
        "total_videos": len(results),
        "videos": results
    })

@api_v1_router.post("/batch/tag")
@api_legacy_router.post("/batch/tag")
def batch_tag_videos(video_ids: List[int] = Body(...), tags: str = Body(...), db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Add tags to multiple videos"""
    for vid_id in video_ids:
        video = db.query(Video).get(vid_id)
        if video:
            existing_tags = set(video.tags.split(',')) if video.tags else set()
            new_tags = set(tags.split(','))
            combined = existing_tags.union(new_tags)
            video.tags = ','.join(filter(None, combined))
    db.commit()
    return {"success": True, "updated": len(video_ids)}

@api_v1_router.post("/batch/delete")
@api_legacy_router.post("/batch/delete")
def batch_delete_videos(video_ids: List[int] = Body(...), db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Delete multiple videos"""
    for vid_id in video_ids:
        video = db.query(Video).get(vid_id)
        if video:
            # Delete thumbnail files
            if video.thumbnail_path:
                thumb_path = f"app{video.thumbnail_path.split('?')[0]}"
                if os.path.exists(thumb_path):
                    os.remove(thumb_path)
            db.delete(video)
    db.commit()
    return {"success": True, "deleted": len(video_ids)}

# ...napr. v get_videos alebo export_videos môžete pridať do výsledku:
# video['stream_url'] = get_stream_url(video.id)


# ===== DISCOVERY PROFILES API =====

# (DiscoveryProfileCreate/Update moved to app/routers/discovery_profiles.py)

class ProbeUrlBody(BaseModel):
    url: str

@api_v1_router.get("/discovery/search-sources")
@api_legacy_router.get("/discovery/search-sources")
async def discovery_search_sources_list():
    """Catalog of discovery search keys for dashboard UI."""
    from .compliant_discovery import COMPLIANT_DISCOVERY_PRESETS
    from .source_catalog import DISCOVERY_SOURCE_OPTIONS, EXTRACT_ONLY_SOURCE_NOTES
    return {
        "discovery_sources": DISCOVERY_SOURCE_OPTIONS,
        "extract_only_sources": EXTRACT_ONLY_SOURCE_NOTES,
        "presets": COMPLIANT_DISCOVERY_PRESETS,
    }


@api_v1_router.get("/intake/sources")
@api_legacy_router.get("/intake/sources")
async def intake_sources(auth: bool = Depends(check_auth)):
    return source_capabilities()


@api_v1_router.post("/intake/search")
@api_legacy_router.post("/intake/search")
async def intake_search(request: IntakeSearchRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    return await search_intake_candidates(request, db)


async def _intake_import_auth(request: Request, x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")) -> bool:
    """Dashboard session OR a bridge token — lets browser extensions/userscripts
    (Bunkr Helper, MEGA Helper, ...) create real ImportJob rows with live
    progress/event visibility instead of writing straight to the Video table."""
    if request.session.get("authenticated"):
        return True
    ensure_bridge_token(x_nexus_token)
    return True


async def _expand_pornhub_playlist_intake_urls(request: IntakeImportRequest) -> None:
    """Turn pasted public Pornhub playlists into watch-page candidates.

    Source Board's "Add links" uses the generic Intake endpoint.  Without this
    guard it queued the playlist page as one video and the processor had no
    playable source.  Keep the expansion here so every caller gets the same
    behaviour, not just the Source Board sync button.
    """
    playlist_urls = [
        str(url or "").strip() for url in (request.urls or [])
        if re.search(r"https?://(?:www\.)?pornhub\.(?:com|org|net)/playlist/\d+(?:[/?#]|$)", str(url or ""), re.I)
    ]
    if not playlist_urls:
        return

    from . import pornhub_hub as _pornhub_hub
    passthrough = [url for url in request.urls if str(url or "").strip() not in playlist_urls]
    expanded: list[IntakeCandidate] = []
    for playlist_url in playlist_urls:
        try:
            playlist = await _pornhub_hub.playlist_videos(playlist_url, all_pages=True)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Pornhub playlist sa nepodaril načítať: {exc}") from exc
        playlist_id = str(playlist.get("playlist_id") or "")
        for tile in playlist.get("items") or []:
            watch_url = str(tile.get("url") or "").strip()
            if not watch_url:
                continue
            expanded.append(IntakeCandidate(
                title=str(tile.get("title") or "Pornhub video"),
                url=watch_url,
                source_url=watch_url,
                thumbnail=str(tile.get("thumb") or ""),
                duration=float(tile.get("duration_sec") or 0),
                source="pornhub",
                tags=["pornhub", "playlist", f"playlist:{playlist_id}"] if playlist_id else ["pornhub", "playlist"],
                warnings=["pornhub_playlist"],
                confidence=0.96,
            ))
        if not any(candidate.url for candidate in expanded):
            raise HTTPException(status_code=502, detail="Pornhub playlist nevrátil žiadne videá; skús to znova.")
    request.urls = passthrough
    request.candidates = [*(request.candidates or []), *expanded]
    if request.source_mode in {"", "auto", "generic", "mixed"}:
        request.source_mode = "pornhub"


@api_v1_router.post("/intake/import")
@api_legacy_router.post("/intake/import")
async def intake_import(request: IntakeImportRequest, db: Session = Depends(get_db), auth: bool = Depends(_intake_import_auth)):
    await _expand_pornhub_playlist_intake_urls(request)
    job = create_import_job(request, db)
    # Log the moment the request lands, before the worker picks it up. Clients
    # (Bunkr Helper, Import Desk) only say "Queued N items" and then go quiet,
    # so without this line there is no way to tell a slow job from a stuck one.
    logging.info(
        "[Intake] job #%s QUEUED batch=%r mode=%s items=%s",
        job.id, job.batch_name, job.source_mode, job.total_items,
    )
    intake_worker.start()
    return {"success": True, "job": serialize_job(job)}


@api_v1_router.get("/dashboard/import-monitor")
@api_legacy_router.get("/dashboard/import-monitor")
async def get_dashboard_import_monitor(limit: int = 16, db: Session = Depends(get_db), auth: bool = Depends(_intake_import_auth)):
    # This is a read-only progress view. It used to require a full dashboard
    # session (check_auth), which 401'd for the same extension/userscript
    # callers that ARE allowed to create the jobs via /import/bulk and
    # /intake/import. Mirror those endpoints' auth (session OR bridge token) so
    # the importer can poll live progress instead of appearing to "not work".
    try:
        from .database import ImportJobItem
        
        # Query recent jobs and their sample item in two bounded queries.  The
        # former implementation issued an extra SELECT for every job shown in
        # the dashboard, making a 16-job monitor a classic N+1 query pattern.
        jobs = db.query(ImportJob).order_by(desc(ImportJob.id)).limit(max(1, min(limit, 100))).all()
        reconcile_job_counts(db, jobs)
        job_ids = [job.id for job in jobs]
        samples_by_job = {}
        if job_ids:
            sample_ids = (
                db.query(func.min(ImportJobItem.id))
                .filter(ImportJobItem.job_id.in_(job_ids))
                .group_by(ImportJobItem.job_id)
            )
            samples_by_job = {
                sample.job_id: sample
                for sample in db.query(ImportJobItem)
                .filter(ImportJobItem.id.in_(sample_ids))
                .all()
            }

        now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
        stale_after = datetime.timedelta(minutes=20)
        
        items = []
        for job in jobs:
            sample_item = samples_by_job.get(job.id)
            sample_title = sample_item.title if sample_item else "No items"
            source_label = sample_item.normalized_source if sample_item else "unknown"
            
            # Map database status to frontend status
            db_status = job.status
            if db_status == "completed":
                status = "done"
            elif db_status == "completed_with_errors":
                status = "warning"
            elif db_status == "failed":
                status = "error"
            elif db_status == "cancelled":
                status = "error"
            elif db_status in ("processing", "running"):
                status = "processing"
            elif db_status in ("pending", "queued"):
                status = "pending"
            else:
                status = "pending"
                
            total = job.total_items or 0
            done = job.imported_items or 0
            failed = job.failed_items or 0
            dup = job.duplicate_items or 0
            cancelled = job.cancelled_items or 0
            remaining = max(0, total - done - failed - dup - cancelled)
            last_activity_at = job.updated_at or job.started_at or job.created_at
            stalled = bool(
                status in ("processing", "pending")
                and remaining > 0
                and last_activity_at
                and (now - last_activity_at) >= stale_after
            )
            if stalled:
                # Do not silently retry or cancel a source job.  It may need a
                # user decision, but it must no longer masquerade as live work.
                status = "needs_attention"
            
            # Calculate progress percent
            percent = 0
            if total > 0:
                percent = int(((done + failed + dup + cancelled) / total) * 100)
                
            items.append({
                "key": str(job.id),
                "status": status,
                "source_label": source_label,
                "sample_title": sample_title,
                "batch_name": job.batch_name or "Import",
                "total_items": total,
                "done_items": done,
                "pending_items": job.pending_items or 0,
                "running_items": job.running_items or 0,
                "failed_items": failed,
                "duplicate_items": dup,
                "cancelled_items": cancelled,
                "remaining_items": remaining,
                "stalled": stalled,
                "attention_reason": "Bez zaznamenaného postupu viac ako 20 minút" if stalled else None,
                "percent": percent,
                "created_at": job.created_at.isoformat() + "Z" if job.created_at else None,
                "started_at": job.started_at.isoformat() + "Z" if job.started_at else None,
                "finished_at": job.finished_at.isoformat() + "Z" if job.finished_at else None,
                "updated_at": job.updated_at.isoformat() + "Z" if job.updated_at else None,
                "last_activity_at": last_activity_at.isoformat() + "Z" if last_activity_at else None,
            })
            
        # Processing queue — real-time Video table status (covers VIPVideoProcessor imports)
        proc_count = db.query(Video).filter(Video.status == "processing").count()
        pend_count = db.query(Video).filter(Video.status == "pending").count()
        cutoff = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) - datetime.timedelta(minutes=10)
        recent_done = db.query(Video).filter(
            Video.status.in_(["ready", "ready_to_stream", "error"]),
            Video.created_at >= cutoff,
        ).count()
        # Sample batch name from most recent pending/processing
        sample_vid = db.query(Video).filter(
            Video.status.in_(["pending", "processing"])
        ).order_by(desc(Video.id)).first()
        queue_batch = sample_vid.batch_name if sample_vid else None

        total_in_queue = proc_count + pend_count + recent_done
        queue_pct = int(recent_done / total_in_queue * 100) if total_in_queue > 0 else 100

        return {
            "items": items,
            "queue": {
                "processing": proc_count,
                "pending": pend_count,
                "recent_done": recent_done,
                "total": total_in_queue,
                "percent": queue_pct,
                "batch_name": queue_batch,
                "active": (proc_count + pend_count) > 0,
            },
            "generated_at": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat() + "Z"
        }
    except Exception as e:
        logging.exception("Failed to load dashboard import monitor")
        return {
            "items": [],
            "queue": {"processing": 0, "pending": 0, "recent_done": 0, "total": 0, "percent": 0, "active": False},
            "generated_at": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat() + "Z"
        }


@api_v1_router.get("/dashboard/pending-videos")
@api_legacy_router.get("/dashboard/pending-videos")
async def get_pending_videos(db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """List all pending videos for the queue widget.

    Returns enough context for the UI to explain *why* an item is still waiting:
    how long it has been sitting there, whether a stream URL was already
    resolved, and a short human-readable reason. Without this the widget could
    only show "N čaká" with no way to tell a stuck item from a slow one.
    """
    videos = (
        db.query(Video)
        .filter(Video.status.in_(["pending", "processing"]))
        .order_by(desc(Video.id))
        .all()
    )
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)

    def _describe(v):
        has_stream = bool(v.url)
        age_s = int((now - v.created_at).total_seconds()) if v.created_at else None
        if v.status == "processing":
            reason = "Spracúva sa (extrakcia / náhľad)"
        elif not has_stream:
            reason = "Čaká na rozbalenie odkazu (zdroj ešte nevrátil video)"
        elif age_s is not None and age_s > 300:
            reason = "Zaseknuté — odkaz je hotový, ale spracovanie nebeží"
        else:
            reason = "Čaká vo fronte na spracovanie"
        source = v.source_url or v.url or ""
        return {
            "id": v.id,
            "title": v.title or "(bez názvu)",
            "source": source,
            "source_host": urllib.parse.urlparse(source).netloc if source else "",
            "batch": v.batch_name,
            "status": v.status,
            "has_stream": has_stream,
            "age_seconds": age_s,
            "reason": reason,
            "stuck": v.status == "pending" and has_stream and age_s is not None and age_s > 300,
        }

    return {"videos": [_describe(v) for v in videos]}


@api_v1_router.delete("/dashboard/pending-videos")
@api_legacy_router.delete("/dashboard/pending-videos")
async def clear_pending_videos(db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Delete all pending videos from the queue."""
    count = db.query(Video).filter(Video.status == "pending").count()
    db.query(Video).filter(Video.status == "pending").delete()
    db.commit()
    return {"deleted": count}


@api_v1_router.get("/intake/jobs")
@api_legacy_router.get("/intake/jobs")
async def intake_jobs(limit: int = 25, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    rows = db.query(ImportJob).order_by(desc(ImportJob.id)).limit(max(1, min(limit, 100))).all()
    reconcile_job_counts(db, rows)
    return {"jobs": [serialize_job(job) for job in rows]}


@api_v1_router.get("/intake/jobs/{job_id}")
@api_legacy_router.get("/intake/jobs/{job_id}")
async def intake_job_detail(job_id: int, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    job = db.query(ImportJob).filter(ImportJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Import job not found")
    return {"job": serialize_job(job, include_items=True, db=db)}


@api_v1_router.post("/intake/jobs/{job_id}/retry")
@api_legacy_router.post("/intake/jobs/{job_id}/retry")
async def intake_job_retry(job_id: int, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    try:
        job = retry_job(job_id, db)
        intake_worker.start()
        return {"success": True, "job": serialize_job(job)}
    except ValueError:
        raise HTTPException(status_code=404, detail="Import job not found")


@api_v1_router.post("/intake/jobs/{job_id}/cancel")
@api_legacy_router.post("/intake/jobs/{job_id}/cancel")
async def intake_job_cancel(job_id: int, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    try:
        # Cancellation must reach the live worker task as well as the DB.
        # Calling the old synchronous helper left running processors alive,
        # allowing a stale Fusion/Camwhores result to commit after cancel.
        job = await intake_worker.cancel_job(job_id)
        return {"success": True, "job": serialize_job(job)}
    except ValueError:
        raise HTTPException(status_code=404, detail="Import job not found")


@api_v1_router.post("/intake/jobs/{job_id}/items/{item_id}/skip")
@api_legacy_router.post("/intake/jobs/{job_id}/items/{item_id}/skip")
async def intake_job_skip_item(job_id: int, item_id: int, auth: bool = Depends(check_auth)):
    """Skip one stuck/queued item while leaving the rest of the job running."""
    try:
        job, item = await intake_worker.skip_item(job_id, item_id)
        return {
            "success": True,
            "job": serialize_job(job),
            "item_id": item.id,
            "status": item.status,
        }
    except ValueError:
        raise HTTPException(status_code=404, detail="Import item not found")
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

@api_v1_router.post("/tools/probe-url")
@api_legacy_router.post("/tools/probe-url")
async def tools_probe_url(body: ProbeUrlBody):
    """Try plugin extractors then yt-dlp to see if a URL is supported."""
    url = (body.url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL must start with http:// or https://")

    from .extractors import init_registry, register_extended_extractors
    from .extractors.registry import ExtractorRegistry

    init_registry()
    register_extended_extractors()

    plugin = ExtractorRegistry.find_extractor(url)
    if plugin:
        try:
            res = await plugin.extract(url)
            if res and res.get("stream_url"):
                return {
                    "supported": True,
                    "method": "extractor",
                    "extractor": plugin.name,
                    "title": res.get("title"),
                    "has_stream": True,
                    "is_hls": bool(res.get("is_hls")),
                }
            return {
                "supported": bool(res),
                "method": "extractor",
                "extractor": plugin.name,
                "title": (res or {}).get("title"),
                "has_stream": bool(res and res.get("stream_url")),
                "is_hls": bool((res or {}).get("is_hls")),
                "error": None if (res and res.get("stream_url")) else "Extractor returned no stream_url",
            }
        except Exception as e:
            return {
                "supported": False,
                "method": "extractor",
                "extractor": plugin.name,
                "error": str(e),
            }

    def _ytdlp_probe():
        ydl_opts = {"quiet": True, "no_warnings": True, "skip_download": True}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        info = await asyncio.to_thread(_ytdlp_probe)
        if info:
            ie = info.get("extractor") or info.get("ie_key") or "yt-dlp"
            has_stream = bool(info.get("url") or info.get("formats"))
            return {
                "supported": True,
                "method": "yt-dlp",
                "extractor": ie,
                "title": info.get("title"),
                "has_stream": has_stream,
            }
    except Exception as e:
        return {
            "supported": False,
            "method": "none",
            "extractor": None,
            "error": str(e),
        }

    return {"supported": False, "method": "none", "extractor": None}


class ExtractStreamBody(BaseModel):
    url: str


@api_v1_router.post("/tools/extract-stream")
@api_legacy_router.post("/tools/extract-stream")
async def tools_extract_stream(body: ExtractStreamBody):
    """Extract direct playable stream URL from a supported video host URL."""
    url = (body.url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL must start with http:// or https://")

    from .extractors import init_registry, register_extended_extractors
    from .extractors.registry import ExtractorRegistry

    init_registry()
    register_extended_extractors()

    plugin = ExtractorRegistry.find_extractor(url)
    if plugin:
        try:
            res = await plugin.extract(url)
            if res and res.get("stream_url"):
                raw_stream = res["stream_url"]
                is_hls = bool(res.get("is_hls")) or ".m3u8" in raw_stream
                from urllib.parse import quote as _quote
                proxy_url = (
                    f"/api/v1/tools/stream-proxy?url={_quote(raw_stream, safe='')}"
                    if is_hls else raw_stream
                )
                return {
                    "status": "ok",
                    "stream_url": proxy_url,
                    "raw_stream_url": raw_stream,
                    "is_hls": is_hls,
                    "title": res.get("title"),
                    "thumbnail": res.get("thumbnail"),
                    "duration": res.get("duration"),
                    "extractor": plugin.name,
                }
            return {"status": "error", "message": f"{plugin.name} returned no stream URL"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    return {"status": "unsupported", "message": f"No extractor for: {url}"}


_PROXY_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
_PROXY_ALLOWED_HOSTS = re.compile(
    r"^https?://[^/]*\.(cdn-tnmr|trafficdeposit|lulustream|luluvdo|luluvid|luluvids|lulu\.stream"
    r"|vidara|streamtape|bunkr|doodstream|voe|filemoon|ok\.xxx)[^/]*/",
    re.I,
)

def _make_proxy_url(raw_url: str, base: str) -> str:
    from urllib.parse import quote
    return f"{base}/api/v1/tools/stream-proxy?url={quote(raw_url, safe='')}"

def _rewrite_m3u8(body: str, original_url: str, base: str) -> str:
    """Rewrite segment / key / playlist URLs in m3u8 to go through proxy."""
    from urllib.parse import urljoin, quote
    lines = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith('#'):
            # Rewrite URI= attributes inside tags (EXT-X-KEY, EXT-X-MAP, etc.)
            def _replace_uri(m):
                uri = m.group(1)
                abs_uri = urljoin(original_url, uri)
                return f'URI="{_make_proxy_url(abs_uri, base)}"'
            line = re.sub(r'URI="([^"]+)"', _replace_uri, line)
            lines.append(line)
        elif stripped and not stripped.startswith('#'):
            abs_url = urljoin(original_url, stripped)
            lines.append(_make_proxy_url(abs_url, base))
        else:
            lines.append(line)
    return "\n".join(lines)


@api_v1_router.get("/image-proxy")
@api_legacy_router.get("/image-proxy")
async def image_proxy(url: str, referer: str = ""):
    """Proxy an image URL with a custom Referer header (for hotlink-protected CDNs)."""
    import urllib.parse
    decoded = urllib.parse.unquote(url)
    decoded = _require_public_proxy_url(decoded)
    ref = urllib.parse.unquote(referer) if referer else ""
    headers = {"User-Agent": "Mozilla/5.0", "Referer": ref or decoded}
    try:
        upstream = urllib.parse.urlsplit(decoded)
        if (
            upstream.scheme == "https"
            and upstream.netloc.lower() in {"pimpbunny.com", "www.pimpbunny.com"}
            and upstream.path.startswith("/contents/videos_screenshots/")
        ):
            from curl_cffi.requests import AsyncSession

            async with AsyncSession(impersonate="chrome") as session:
                image = await session.get(
                    decoded, headers={"Referer": ref or "https://pimpbunny.com/"},
                    timeout=10, allow_redirects=False,
                )
            ct = image.headers.get("Content-Type", "")
            if image.status_code != 200 or not ct.lower().startswith("image/"):
                raise HTTPException(502, detail="PimpBunny image unavailable")
            return Response(content=image.content, media_type=ct, headers={"Cache-Control": "public, max-age=86400"})

        async with aiohttp.ClientSession() as sess:
            async with sess.get(decoded, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as r:
                if r.status != 200:
                    raise HTTPException(r.status, detail="Upstream image error")
                ct = r.headers.get("Content-Type", "image/jpeg")
                data = await r.read()
        return Response(content=data, media_type=ct, headers={"Cache-Control": "public, max-age=86400"})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, detail=str(e))


@api_v1_router.get("/tools/stream-proxy")
@api_legacy_router.get("/tools/stream-proxy")
async def stream_proxy(request: Request, url: str):
    """
    Proxy a video CDN URL through the server to bypass browser CORS.
    Supports m3u8 manifests (rewrites segment URLs) and binary TS/MP4 segments.
    """
    import urllib.parse as _up

    decoded = _up.unquote(url)
    decoded = _require_public_proxy_url(decoded)

    referer_map = {
        "lulustream": "https://luluvdo.com/",
        "luluvdo": "https://luluvdo.com/",
        "luluvid": "https://luluvid.com/",
        "cdn-tnmr": "https://luluvdo.com/",
        "trafficdeposit": "https://sxyprn.com/",
        "vidara": "https://vidara.so/",
        "streamtape": "https://streamtape.com/",
    }
    referer = "https://sxyprn.com/"
    for key, ref in referer_map.items():
        if key in decoded:
            referer = ref
            break

    headers = {
        "User-Agent": _PROXY_UA,
        "Referer": referer,
        "Origin": referer.rstrip("/"),
        "Accept": "*/*",
    }
    if _is_lulu_cdn_url(decoded):
        headers = _lulu_cdn_headers()

    try:
        timeout = aiohttp.ClientTimeout(total=60, connect=10)
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(decoded, timeout=timeout, allow_redirects=True) as resp:
                ct = resp.headers.get("Content-Type", "application/octet-stream")
                is_m3u8 = "mpegurl" in ct.lower() or decoded.endswith(".m3u8") or "m3u8" in decoded

                if is_m3u8:
                    body_text = await resp.text(errors="replace")
                    # Build base URL for rewriting (scheme + host + port)
                    base = str(request.base_url).rstrip("/")
                    rewritten = _rewrite_m3u8(body_text, decoded, base)
                    return Response(
                        content=rewritten,
                        media_type="application/vnd.apple.mpegurl",
                        headers={
                            "Access-Control-Allow-Origin": "*",
                            "Cache-Control": "no-cache",
                        },
                    )
                else:
                    # Stream binary (TS segments, MP4, etc.)
                    body_bytes = await resp.read()
                    return Response(
                        content=body_bytes,
                        media_type=ct,
                        headers={
                            "Access-Control-Allow-Origin": "*",
                            "Cache-Control": "public, max-age=3600",
                        },
                    )
    except Exception as e:
        logging.warning("[stream-proxy] fetch failed for %s: %s", decoded[:80], e)
        raise HTTPException(status_code=502, detail=f"Proxy fetch failed: {e}")


# (discovery profiles CRUD + notifications moved to app/routers/discovery_profiles.py)

@api_v1_router.get("/scheduler/jobs")
async def get_scheduler_jobs():
    """Get all scheduled jobs."""
    try:
        scheduler = get_scheduler()
        jobs = scheduler.get_jobs()

        result = []
        for job_id, metadata in jobs.items():
            result.append({
                "job_id": job_id,
                **metadata,
                "next_run": metadata.get('next_run').isoformat() if metadata.get('next_run') else None,
                "last_run": metadata.get('last_run').isoformat() if metadata.get('last_run') else None,
                "added_at": metadata.get('added_at').isoformat() if metadata.get('added_at') else None
            })

        return {"jobs": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ===== DISCOVERED VIDEOS (REVIEW) API =====

class DiscoveryIdsRequest(BaseModel):
    video_ids: List[int] = []


class DiscoveryMetadataRequest(BaseModel):
    video_ids: List[int] = []
    all_missing: bool = False  # Backward compatibility
    batch_size: int = 5
    only_missing: bool = True
    max_items: Optional[int] = None


def _norm_discovery_url(value: Optional[str]) -> str:
    return normalize_url_key(value, lowercase_query=False)


def _discovery_missing_fields(vid: DiscoveredVideo) -> List[str]:
    missing = []
    if not vid.duration:
        missing.append("duration")
    if not (vid.width and vid.height):
        missing.append("quality")
    if not vid.file_size_mb:
        missing.append("size")
    if not (vid.thumbnail or "").strip():
        missing.append("thumbnail")
    return missing


def _discovery_quality_label(vid: DiscoveredVideo) -> str:
    if vid.height:
        return f"{vid.height}p"
    if vid.width and vid.height:
        return f"{vid.width}x{vid.height}"
    return "Unknown"


def _serialize_discovered_video(vid: DiscoveredVideo) -> Dict[str, Any]:
    missing = _discovery_missing_fields(vid)
    
    duplicate_title = ""
    if getattr(vid, "duplicate_of", None):
        try:
            from sqlalchemy.orm import Session as SessionClass
            from app.database import Video
            session = SessionClass.object_session(vid)
            if session:
                dup = session.query(Video).filter(Video.id == vid.duplicate_of).first()
                if dup:
                    duplicate_title = dup.title
        except Exception:
            pass

    return {
        "id": vid.id,
        "profile_id": vid.profile_id,
        "profile_name": vid.profile_name,
        "title": vid.title,
        "url": vid.url,
        "source_url": vid.source_url,
        "thumbnail": vid.thumbnail,
        "duration": vid.duration,
        "width": vid.width,
        "height": vid.height,
        "file_size_mb": round(float(vid.file_size_mb or 0), 2),
        "quality_label": _discovery_quality_label(vid),
        "missing_metadata": missing,
        "metadata_complete": len(missing) == 0,
        "source": vid.source,
        "imported": vid.imported,
        "video_id": vid.video_id,
        "discovered_at": vid.discovered_at.isoformat(),
        "imported_at": vid.imported_at.isoformat() if vid.imported_at else None,
        "categories": getattr(vid, "categories", "") or "",
        "models": getattr(vid, "models", "") or "",
        "related_src": getattr(vid, "related_src", "") or "",
        "preview_mp4_url": getattr(vid, "preview_mp4_url", "") or "",
        "phash": getattr(vid, "phash", "") or "",
        "duplicate_of": getattr(vid, "duplicate_of", None),
        "duplicate_title": duplicate_title
    }


def _remember_discovery_dismissal(db: Session, discovered: DiscoveredVideo):
    url = _norm_discovery_url(discovered.url)
    source_url = _norm_discovery_url(discovered.source_url)
    existing = db.query(DiscoveryDismissedVideo).filter(
        DiscoveryDismissedVideo.profile_id == discovered.profile_id,
        or_(
            DiscoveryDismissedVideo.url == url,
            DiscoveryDismissedVideo.source_url == source_url
        )
    ).first()

    if existing:
        return

    db.add(DiscoveryDismissedVideo(
        profile_id=discovered.profile_id,
        url=url,
        source_url=source_url,
        title=discovered.title,
    ))


def _extract_filesize_mb_from_info(info: Dict[str, Any]) -> float:
    candidates = []
    for key in ("filesize", "filesize_approx"):
        value = info.get(key)
        if value:
            candidates.append(value)
    for fmt in info.get("formats") or []:
        for key in ("filesize", "filesize_approx"):
            value = fmt.get(key)
            if value:
                candidates.append(value)
    if not candidates:
        return 0.0
    return round(max(candidates) / (1024 * 1024), 2)


def _extract_dimensions_from_info(info: Dict[str, Any]) -> tuple[int, int]:
    width = int(info.get("width") or 0)
    height = int(info.get("height") or 0)
    if width and height:
        return width, height

    best_width = 0
    best_height = 0
    for fmt in info.get("formats") or []:
        fmt_width = int(fmt.get("width") or 0)
        fmt_height = int(fmt.get("height") or 0)
        if fmt_height > best_height or (fmt_height == best_height and fmt_width > best_width):
            best_width = fmt_width
            best_height = fmt_height
    return best_width, best_height


def _extract_discovery_info_sync(candidate_url: str, referer: Optional[str] = None) -> Dict[str, Any]:
    headers = {}
    if referer:
        headers["Referer"] = referer

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "socket_timeout": 15,
        "extract_flat": False,
    }
    if headers:
        opts["http_headers"] = headers

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(candidate_url, download=False)
        if isinstance(info, dict) and info.get("entries"):
            entries = [entry for entry in info.get("entries") or [] if entry]
            if entries:
                info = entries[0]
        return info or {}


async def _probe_content_length_mb(url: str, referer: Optional[str] = None) -> float:
    headers = {}
    if referer:
        headers["Referer"] = referer

    async with httpx.AsyncClient(timeout=12, follow_redirects=True, verify=False, headers=headers) as client:
        try:
            response = await client.head(url)
            content_length = response.headers.get("content-length")
            if content_length and content_length.isdigit():
                return round(int(content_length) / (1024 * 1024), 2)
        except Exception:
            pass

        try:
            response = await client.get(url, headers={**headers, "Range": "bytes=0-0"})
            content_range = response.headers.get("content-range", "")
            if "/" in content_range:
                tail = content_range.split("/")[-1]
                if tail.isdigit():
                    return round(int(tail) / (1024 * 1024), 2)
            content_length = response.headers.get("content-length")
            if content_length and content_length.isdigit():
                return round(int(content_length) / (1024 * 1024), 2)
        except Exception:
            return 0.0

    return 0.0


async def _enrich_discovered_video_metadata(discovered: DiscoveredVideo) -> bool:
    changed = False
    candidates = []
    for candidate in [discovered.source_url, discovered.url]:
        candidate = (candidate or "").strip()
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    for candidate in candidates:
        domain = rate_limiter.normalize_domain(candidate)
        info: Dict[str, Any] = {}
        max_retries = 3
        for attempt in range(1, max_retries + 1):
            acquired = False
            try:
                async with DISCOVERY_METADATA_SEMAPHORE:
                    _, waited = await rate_limiter.acquire(candidate)
                    acquired = True
                    logging.info(
                        "[DiscoveryMetadata] domain=%s candidate=%s wait=%.2fs retry=%s/%s",
                        domain,
                        candidate[:120],
                        waited,
                        attempt,
                        max_retries,
                    )
                    info = await asyncio.to_thread(
                        _extract_discovery_info_sync,
                        candidate,
                        discovered.source_url or discovered.url
                    )
                await rate_limiter.report_success(domain)
                break
            except Exception as exc:
                err = str(exc).lower()
                is_rate_limited = ("429" in err) or ("509" in err) or ("too many requests" in err)
                is_timeout = ("timed out" in err) or ("timeout" in err)
                if is_rate_limited:
                    await rate_limiter.penalize_domain(domain, extra_seconds=6.0)
                elif is_timeout:
                    await rate_limiter.penalize_domain(domain, extra_seconds=2.0)

                backoff = min(25.0, (2 ** (attempt - 1)) + random.uniform(0.6, 2.2))
                logging.warning(
                    "[DiscoveryMetadata] enrich retry domain=%s attempt=%s/%s backoff=%.2fs rate_limited=%s timeout=%s error=%s",
                    domain,
                    attempt,
                    max_retries,
                    backoff,
                    is_rate_limited,
                    is_timeout,
                    str(exc)[:260],
                )
                if attempt < max_retries:
                    await asyncio.sleep(backoff)
            finally:
                if acquired:
                    rate_limiter.release()

        if info:
            title = (info.get("title") or "").strip()
            if title and (not discovered.title or discovered.title.strip().lower() in {"untitled", "unknown"}):
                discovered.title = title
                changed = True

            if not discovered.duration and info.get("duration"):
                discovered.duration = float(info.get("duration") or 0)
                changed = True

            width, height = _extract_dimensions_from_info(info)
            if width and height and (not discovered.width or not discovered.height):
                discovered.width = width
                discovered.height = height
                changed = True

            thumb = (info.get("thumbnail") or "").strip()
            if thumb and not (discovered.thumbnail or "").strip():
                discovered.thumbnail = thumb
                changed = True

            if not discovered.file_size_mb:
                size_mb = _extract_filesize_mb_from_info(info)
                if size_mb:
                    discovered.file_size_mb = size_mb
                    changed = True

        if len(_discovery_missing_fields(discovered)) == 0:
            break

    if not discovered.file_size_mb:
        direct_url = (discovered.url or "").strip()
        if direct_url.startswith("http://") or direct_url.startswith("https://"):
            size_mb = await _probe_content_length_mb(direct_url, discovered.source_url or direct_url)
            if size_mb:
                discovered.file_size_mb = size_mb
                changed = True

    # Calculate visual pHash and check for visual duplicates
    if discovered.thumbnail and not getattr(discovered, "phash", None):
        from app.duplicate_detector import compute_discovered_video_phash_and_check_duplicate
        phash_changed = await asyncio.to_thread(
            compute_discovered_video_phash_and_check_duplicate,
            db,
            discovered
        )
        if phash_changed:
            changed = True

    return changed

@api_v1_router.get("/discovery/review/{profile_id}")
async def get_discovered_videos(profile_id: int, imported: Optional[bool] = None, db: Session = Depends(get_db)):
    """Get discovered videos for a profile for review."""
    query = db.query(DiscoveredVideo).filter(DiscoveredVideo.profile_id == profile_id)

    if imported is not None:
        query = query.filter(DiscoveredVideo.imported == imported)

    discovered = query.order_by(desc(DiscoveredVideo.discovered_at)).all()

    result = [_serialize_discovered_video(vid) for vid in discovered]
    metadata_complete = sum(1 for item in result if item["metadata_complete"])
    metadata_total = len(result)
    metadata_percent = int(round((metadata_complete / metadata_total) * 100)) if metadata_total else 100

    return {
        "discovered_videos": result,
        "metadata_summary": {
            "complete": metadata_complete,
            "total": metadata_total,
            "percent": metadata_percent,
            "missing": max(metadata_total - metadata_complete, 0),
            "missing_quality": sum(1 for item in result if "quality" in item["missing_metadata"]),
            "missing_size": sum(1 for item in result if "size" in item["missing_metadata"]),
            "missing_duration": sum(1 for item in result if "duration" in item["missing_metadata"]),
            "missing_thumbnail": sum(1 for item in result if "thumbnail" in item["missing_metadata"]),
        }
    }

_CBIR_VIDEO_SITES = re.compile(
    r"(pornhub|xvideos|xhamster|bunkr|erome|camwhores|eporner|redgifs|"
    r"tnaflix|spankbang|hqporner|beeg|xnxx|nhentai|kemono|coomer|rule34|"
    r"leakporner|pornone|turbo\.cr|lulustream|filester|simpcity|coomer\.party|"
    r"onlyfans|fapello|scrolller|newgrounds|motherless|txxx|porntube|homemoviestube|"
    r"boyfriendtv|empflix|moviesand|youporn|tube8|redtube|xtube|nudevista|imagefap)",
    re.I,
)
_CBIR_COLLECTION_RE = re.compile(
    r"/(album|collection|playlist|favorites|gallery|a|set|serie|series|folder)/[^/?#]{2,}",
    re.I,
)
_CBIR_SKIP = re.compile(
    r"(yandex\.|yastatic\.|yastat\.|google\.|bing\.|yahoo\.|amazon\.|wikipedia\.|"
    r"twitter\.|facebook\.|instagram\.|tiktok\.|linkedin\.|cloudflare\.|gstatic\.|"
    r"doubleclick\.|mc\.yandex\.|counter\.yadro\.|an\.yandex\.)",
    re.I,
)
# Extensions that indicate a static asset, not a page
_CBIR_ASSET_EXT = re.compile(r'\.(css|js|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|webp|ico|map|json)([?#]|$)', re.I)
_CBIR_CDN_PATH = re.compile(r'/(fiji-static|_static|chunks|static|node_modules)/', re.I)
_CBIR_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


async def _fetch_thumb_bytes(thumbnail: str) -> Optional[bytes]:
    """Return raw JPEG bytes — handles local /static paths and remote URLs."""
    if not thumbnail:
        return None
    if not thumbnail.startswith("http"):
        local = thumbnail.lstrip("/")
        for p in [os.path.join("app", local), local, os.path.join("app", "static", os.path.basename(thumbnail))]:
            if os.path.exists(p):
                with open(p, "rb") as f:
                    return f.read()
        return None
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as cl:
            r = await cl.get(thumbnail, headers={"User-Agent": _CBIR_UA})
            if r.status_code == 200 and len(r.content) > 500:
                return r.content
    except Exception:
        pass
    return None


def _parse_cbir_page(page: str) -> List[Dict]:
    """Parse Yandex CBIR results page, return raw result dicts."""
    import html as _html
    from urllib.parse import urlparse as _up

    results: List[Dict] = []
    seen: set = set()

    def _classify(url: str) -> str:
        """Return 'collection', 'video', or 'other'."""
        if _CBIR_COLLECTION_RE.search(url):
            return "collection"
        if _CBIR_VIDEO_SITES.search(url):
            return "video"
        return "other"

    def _add(url: str, title: str, reason: str, priority: int = 5) -> None:
        url = url.replace("\\u002F", "/").replace("\\/", "/").replace("%2F", "/")
        try:
            parsed = _up(url)
            host = parsed.netloc.lower().lstrip("www.")
        except Exception:
            return
        if not host or len(url) > 500 or url in seen:
            return
        if _CBIR_SKIP.search(host):
            return
        if _CBIR_ASSET_EXT.search(url) or _CBIR_CDN_PATH.search(url):
            return
        seen.add(url)
        kind = _classify(url)
        results.append({
            "url": url,
            "title": _html.unescape(title).strip() if title else host,
            "thumbnail": "",
            "source": "yandex_cbir",
            "reason": reason,
            "kind": kind,
            "is_video_site": kind in ("video", "collection"),
            "_priority": priority,
        })

    # 1. "Sites with this image" — highest priority hits
    for m in re.finditer(r'class="CbirSites-ItemTitle[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<', page):
        _add(m.group(1), m.group(2), "Rovnaký obrázok nájdený na stránke", priority=1)

    # Also grab the domain line that sometimes follows
    for m in re.finditer(r'class="CbirSites-ItemUrl[^"]*"[^>]*>([^<]+)<', page):
        pass  # just domain labels, skip

    # 2. JSON-embedded url+title pairs (Yandex embeds structured data)
    urls_json  = re.findall(r'"url"\s*:\s*"(https?://[^"\\]{10,400})"', page)
    titles_json = re.findall(r'"title"\s*:\s*"([^"]{2,250})"', page) + [""] * 9999
    for url, title in zip(urls_json[:300], titles_json):
        _add(url, title, "Vizuálna zhoda", priority=3)

    # 3. origUrl / pageUrl patterns
    for m in re.finditer(r'"(?:origUrl|pageUrl|sourceUrl)"\s*:\s*"(https?://[^"\\]{10,400})"', page):
        _add(m.group(1), "", "Zdroj obrázka", priority=2)

    # 4. href fallback — only URLs with a real path (skip bare domains and asset URLs)
    for m in re.finditer(r'href="(https?://[^"]{15,400})"', page):
        url = m.group(1)
        # Must have a path segment beyond just "/"
        try:
            path = _up(url).path
        except Exception:
            continue
        if path in ("", "/", "//"):
            continue
        _add(url, "", "Odkaz na stránke", priority=6)

    # Sort: collections first → video sites → priority score → others
    _KIND_ORDER = {"collection": 0, "video": 1, "other": 2}
    results.sort(key=lambda x: (_KIND_ORDER.get(x.get("kind", "other"), 2), x.get("_priority", 9)))
    for r in results:
        r.pop("_priority", None)
    return results[:50]


async def _enrich_cbir_results(results: List[Dict]) -> None:
    """Fetch OG title + thumbnail for top video/collection results (in-place, best-effort)."""
    targets = [r for r in results if r.get("is_video_site") and not r.get("thumbnail")][:8]
    if not targets:
        return

    async def _fetch_meta(item: Dict) -> None:
        try:
            async with httpx.AsyncClient(
                timeout=6, follow_redirects=True,
                headers={"User-Agent": _CBIR_UA, "Accept-Language": "en-US,en;q=0.8"},
            ) as cl:
                resp = await cl.get(item["url"])
                chunk = resp.text[:40000]
        except Exception:
            return
        # OG title
        for pat in [
            r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']{3,200})["\']',
            r'<meta[^>]+content=["\']([^"\']{3,200})["\'][^>]+property=["\']og:title["\']',
            r'<title>([^<]{3,200})</title>',
        ]:
            m = re.search(pat, chunk, re.I)
            if m:
                item["title"] = m.group(1).strip()
                break
        # OG image
        for pat in [
            r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']{10,500})["\']',
            r'<meta[^>]+content=["\']([^"\']{10,500})["\'][^>]+property=["\']og:image["\']',
        ]:
            m = re.search(pat, chunk, re.I)
            if m:
                item["thumbnail"] = m.group(1).strip()
                break

    await asyncio.gather(*[_fetch_meta(t) for t in targets], return_exceptions=True)


def _clean_scraped_title(t: str) -> str:
    """Decode HTML entities (&#039; etc.) and normalise whitespace in scraped titles."""
    import html as _html
    return re.sub(r'\s+', ' ', _html.unescape(str(t or ""))).strip()


def _build_vid_search_queries(title: str, tags: str = "", models: str = "", keywords: Optional[List[str]] = None) -> List[str]:
    """Build effective search queries from video metadata — model names first, then title.

    When the user hand-picks *keywords* in the Related Search modal, those drive
    the queries: model name + keywords combined, then keywords alone.
    """
    queries: List[str] = []
    # Model names (most specific)
    model_names: List[str] = []
    for m in (models or "").split(","):
        m = m.strip()
        if len(m) > 3 and m not in model_names:
            model_names.append(m)
    # Capitalised multi-word names from title ("Sarah Harlow", "Angela White")
    for m in re.finditer(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b', title or ""):
        name = m.group(1)
        if name not in model_names:
            model_names.append(name)

    kw = [k.strip() for k in (keywords or []) if k and k.strip()]
    if kw:
        joined = " ".join(kw[:4])
        if model_names and model_names[0].lower() not in joined.lower():
            queries.append(f"{model_names[0]} {joined}")
        queries.append(joined)
        for name in model_names[:2]:
            if name not in queries:
                queries.append(name)
    else:
        queries.extend(model_names)

    # Clean title as last resort
    if not queries:
        words = re.sub(r'[^\w\s]', ' ', title or "").split()[:7]
        q = ' '.join(words).strip()
        if len(q) > 4:
            queries.append(q)
    return queries[:3]


async def _search_eporner(cl: "httpx.AsyncClient", query: str, limit: int = 10) -> List[Dict]:
    """Query eporner public JSON API for videos matching *query*."""
    try:
        r = await cl.get(
            "https://www.eporner.com/api/v2/video/search/",
            params={"query": query, "per_page": min(limit, 20), "format": "json", "thumbsize": "medium"},
        )
        if r.status_code != 200:
            return []
        data = r.json()
        out = []
        for v in data.get("videos", []):
            thumb = (v.get("default_thumb") or {}).get("src", "")
            out.append({
                "url": v.get("url", ""),
                "title": _clean_scraped_title(v.get("title", "")),
                "thumbnail": thumb,
                "duration": v.get("length_sec", 0),
                "source": "eporner",
                "kind": "video",
                "tags": v.get("keywords", ""),
                "views": v.get("views", 0),
                "rating": v.get("rate", ""),
                "reason": f"eporner · {v.get('length_min', '')}",
            })
        return out
    except Exception as e:
        logging.warning("[VidSearch/eporner] %s: %s", query, e)
        return []


async def _search_xhamster(cl: "httpx.AsyncClient", query: str, limit: int = 10) -> List[Dict]:
    """Scrape xHamster search results for videos matching *query*."""
    try:
        slug = re.sub(r'[^\w\s-]', '', query.lower()).strip().replace(' ', '-')
        r = await cl.get(f"https://xhamster.com/search/{slug}")
        if r.status_code != 200:
            return []
        html_txt = r.text
        out = []
        for m in re.finditer(r'"pageURL"\s*:\s*"(https:\\/\\/xhamster\.com\\/videos\\/[^"]+)"', html_txt):
            url = m.group(1).replace('\\/', '/')
            start = max(0, m.start() - 600)
            ctx = html_txt[start:m.end() + 200]
            title_m = re.search(r'"title"\s*:\s*"([^"]{5,150})"', ctx)
            thumb_m = re.search(r'"thumbURL"\s*:\s*"([^"]{20,400})"', ctx)
            dur_m   = re.search(r'"duration"\s*:\s*(\d+)', ctx)
            views_m = re.search(r'"views"\s*:\s*(\d+)', ctx)
            title = _clean_scraped_title(title_m.group(1)) if title_m else url.split('/')[-1].replace('-', ' ').title()
            # Skip page-level nav titles
            if 'Porn Videos' in title and len(title) < 50:
                continue
            out.append({
                "url": url,
                "title": title,
                "thumbnail": thumb_m.group(1).replace('\\/', '/') if thumb_m else '',
                "duration": int(dur_m.group(1)) if dur_m else 0,
                "source": "xhamster",
                "kind": "video",
                "views": int(views_m.group(1)) if views_m else 0,
                "reason": "xHamster",
            })
            if len(out) >= limit:
                break
        return out
    except Exception as e:
        logging.warning("[VidSearch/xhamster] %s: %s", query, e)
        return []


async def _search_xvideos(cl: "httpx.AsyncClient", query: str, limit: int = 10) -> List[Dict]:
    """Scrape xvideos search results for videos matching *query*."""
    try:
        r = await cl.get("https://www.xvideos.com/", params={"k": query})
        if r.status_code != 200:
            return []
        out = []
        # each result lives in a thumb-block div; slice the html into chunks
        chunks = re.split(r'class="[^"]*thumb-block', r.text)[1:]
        for chunk in chunks[:limit * 2]:
            chunk = chunk[:2500]
            url_m   = re.search(r'<a href="(/video[^"]+)"', chunk)
            title_m = re.search(r'title="([^"]{3,180})"', chunk)
            thumb_m = re.search(r'data-src="([^"]+)"', chunk)
            dur_m   = re.search(r'class="duration"[^>]*>\s*([\d]+)\s*(sec|min|h)', chunk)
            if not url_m:
                continue
            dur = 0
            if dur_m:
                n, unit = int(dur_m.group(1)), dur_m.group(2)
                dur = n if unit == "sec" else n * 60 if unit == "min" else n * 3600
            out.append({
                "url": "https://www.xvideos.com" + url_m.group(1),
                "title": _clean_scraped_title(title_m.group(1)) if title_m else url_m.group(1).split('/')[-1].replace('_', ' '),
                "thumbnail": thumb_m.group(1) if thumb_m else "",
                "duration": dur,
                "source": "xvideos",
                "kind": "video",
                "reason": "xvideos",
            })
            if len(out) >= limit:
                break
        return out
    except Exception as e:
        logging.warning("[VidSearch/xvideos] %s: %s", query, e)
        return []


async def _search_spankbang(cl: "httpx.AsyncClient", query: str, limit: int = 10) -> List[Dict]:
    """Vyhľadávanie na SpankBang cez curl_cffi (bez zastaralého cloudscraperu)."""
    from .related_unified import _search_spankbang_fast
    return await _search_spankbang_fast(cl, query, limit=limit)


def _find_sites_list(obj, depth: int = 0):
    """Recursively find the first `sites` list of dicts with URLs (Yandex nests it
    under initialState.cbirSites.sites)."""
    if depth > 6:
        return None
    if isinstance(obj, dict):
        s = obj.get("sites")
        if isinstance(s, list) and s and isinstance(s[0], dict) and s[0].get("url"):
            return s
        for v in obj.values():
            r = _find_sites_list(v, depth + 1)
            if r:
                return r
    elif isinstance(obj, list):
        for v in obj[:3]:
            r = _find_sites_list(v, depth + 1)
            if r:
                return r
    return None


async def _search_erome(cl: "httpx.AsyncClient", query: str, limit: int = 10) -> List[Dict]:
    """Scrape erome album search results matching *query*."""
    try:
        r = await cl.get("https://www.erome.com/search", params={"q": query})
        if r.status_code != 200:
            return []
        out = []
        chunks = re.split(r'<a class="album-link"', r.text)[1:]
        for chunk in chunks[:limit * 2]:
            chunk = chunk[:2000]
            url_m   = re.search(r'href="(https://www\.erome\.com/a/[^"]+)"', chunk)
            title_m = re.search(r'alt="([^"]{3,180})"', chunk)
            thumb_m = re.search(r'src="(https://[^"]+/thumbs/[^"]+)"', chunk)
            vids_m  = re.search(r'album-videos[^>]*>.*?</svg>(\d+)', chunk, re.S)
            if not url_m:
                continue
            n_vids = int(vids_m.group(1)) if vids_m else 0
            out.append({
                "url": url_m.group(1),
                "title": _clean_scraped_title(title_m.group(1)) if title_m else url_m.group(1).split('/')[-1],
                "thumbnail": thumb_m.group(1) if thumb_m else "",
                "duration": 0,
                "source": "erome",
                "kind": "collection",
                "reason": f"erome album · {n_vids} videí" if n_vids else "erome album",
            })
            if len(out) >= limit:
                break
        return out
    except Exception as e:
        logging.warning("[VidSearch/erome] %s: %s", query, e)
        return []


def _extract_data_state_sites(html_txt: str) -> List[Dict]:
    """Pull the CBIR `sites` array out of any Yandex data-state attribute."""
    import html as _html
    import json as _json
    out: List[Dict] = []
    for m in re.finditer(r'data-state="([^"]{500,})"', html_txt):
        try:
            state = _json.loads(_html.unescape(m.group(1)))
        except Exception:
            continue
        sites = _find_sites_list(state)
        if not sites:
            continue
        for s in sites:
            try:
                url = s.get("url") or ""
                if not url.startswith("http"):
                    continue
                thumb = ((s.get("thumb") or {}).get("url") or "")
                if thumb.startswith("//"):
                    thumb = "https:" + thumb
                out.append({
                    "url": url,
                    "title": (s.get("title") or s.get("domain") or url)[:180],
                    "thumbnail": thumb,
                    "duration": 0,
                    "source": "yandex",
                    "kind": "video",
                    "reason": f"Yandex vizuál · {s.get('domain', '')}",
                })
            except Exception:
                continue
        if out:
            break
    return out


async def _yandex_cbir_search(image_bytes: bytes, limit: int = 16, text: str = "") -> List[Dict]:
    """Upload the thumbnail to Yandex Images and return the 'sites' visual matches inline.

    *text* refines the visual search with keywords or operators like `site:vk.com`
    (image + words combined — same as typing into the Yandex smart-camera box)."""
    async with httpx.AsyncClient(
        timeout=20, follow_redirects=True,
        headers={"User-Agent": _CBIR_UA, "Accept-Language": "en-US,en;q=0.8"},
    ) as cl:
        up = await cl.post(
            "https://yandex.com/images/search",
            params={
                "rpt": "imageview",
                "format": "json",
                "request": '{"blocks":[{"block":"b-page_type_search-by-image__link"}]}',
            },
            files={"upfile": ("thumb.jpg", image_bytes, "image/jpeg")},
        )
        if up.status_code != 200:
            raise RuntimeError(f"upload HTTP {up.status_code}")
        blocks = (up.json() or {}).get("blocks") or []
        params0 = (blocks[0].get("params") or {}) if blocks else {}
        cbir_id = params0.get("cbirId") or ""
        if not cbir_id:
            # older response shape carries a ready-made query string instead
            cbir_qs = params0.get("url") or ""
            m = re.search(r'cbir_id=([^&]+)', cbir_qs)
            cbir_id = m.group(1) if m else ""
        if not cbir_id:
            raise RuntimeError("no cbir_id in upload response (captcha?)")

        page_params = {"rpt": "imageview", "cbir_id": cbir_id, "cbir_page": "sites"}
        if (text or "").strip():
            page_params["text"] = text.strip()
        page = await cl.get("https://yandex.com/images/search", params=page_params)
        if page.status_code != 200:
            raise RuntimeError(f"sites HTTP {page.status_code}")
        results = _extract_data_state_sites(page.text)
        if not results:
            # fallback: similar-images tab entries with page links
            for m in re.finditer(r'"img_href":"([^"]+)"[^}]*?"text":"([^"]{3,180})"', page.text):
                results.append({
                    "url": m.group(1).replace('\\/', '/'),
                    "title": m.group(2),
                    "thumbnail": "",
                    "duration": 0,
                    "source": "yandex",
                    "kind": "video",
                    "reason": "Yandex vizuál",
                })
        return results[:limit]


async def _google_reverse_image_search(image_bytes: bytes, limit: int = 12) -> List[Dict]:
    """Best-effort Google reverse-image search — upload thumb, parse organic result links."""
    async with httpx.AsyncClient(
        timeout=20, follow_redirects=True,
        headers={"User-Agent": _CBIR_UA, "Accept-Language": "en-US,en;q=0.8"},
        cookies={"CONSENT": "YES+cb.20240101-01-p0.en+FX+410", "SOCS": "CAESHAgBEhJnd3NfMjAyNDAxMDEtMF9SQzIaAmVuIAEaBgiAo-2sBg"},
    ) as cl:
        up = await cl.post(
            "https://www.google.com/searchbyimage/upload",
            data={"image_content": "", "sbisrc": "cr_1"},
            files={"encoded_image": ("thumb.jpg", image_bytes, "image/jpeg")},
        )
        if up.status_code != 200:
            raise RuntimeError(f"upload HTTP {up.status_code}")
        html_txt = up.text
        out: List[Dict] = []
        seen: set = set()
        # organic results: <a href="https://..."><h3>Title</h3>  (and /url?q= variants)
        for m in re.finditer(r'<a[^>]+href="(https?://[^"]+|/url\?q=[^"&]+)[^"]*"[^>]*>(?:<br>)?<h3[^>]*>(.*?)</h3>', html_txt, re.S):
            url = m.group(1)
            if url.startswith("/url?q="):
                from urllib.parse import unquote
                url = unquote(url[7:])
            if "google." in url or url in seen:
                continue
            seen.add(url)
            title = re.sub(r'<[^>]+>', '', m.group(2)).strip()
            out.append({
                "url": url,
                "title": title[:180] or url,
                "thumbnail": "",
                "duration": 0,
                "source": "google",
                "kind": "video",
                "reason": "Google Lens",
            })
            if len(out) >= limit:
                break
        if not out:
            raise RuntimeError("Google blokuje server-side hľadanie — použi tlačidlo Google Lens (nový tab)")
        return out


_CBIR_KEYWORD_SEARCHERS = {
    "eporner":   _search_eporner,
    "xhamster":  _search_xhamster,
    "xvideos":   _search_xvideos,
    "spankbang": _search_spankbang,
    "erome":     _search_erome,
}


async def _search_same_video(
    title: str,
    tags: str = "",
    models: str = "",
    limit: int = 24,
    keywords: Optional[List[str]] = None,
    sources: Optional[List[str]] = None,
) -> List[Dict]:
    """Search selected keyword sources (eporner/xhamster/xvideos/spankbang/erome)
    using metadata queries. *sources* None/empty = all."""
    queries = _build_vid_search_queries(title, tags, models, keywords)
    if not queries:
        logging.info("[VidSearch] no queries could be built for title=%r", title[:60])
        return []

    per_q = max(6, limit // max(1, len(queries)))
    tasks = []
    logging.info("[VidSearch] queries=%s per_q=%d", queries, per_q)

    async with httpx.AsyncClient(
        timeout=12, follow_redirects=True,
        headers={"User-Agent": _CBIR_UA, "Accept-Language": "en-US,en;q=0.8"},
    ) as cl:
        wanted = [s for s in (sources or []) if s in _CBIR_KEYWORD_SEARCHERS] or list(_CBIR_KEYWORD_SEARCHERS)
        for q in queries[:2]:
            for name in wanted:
                tasks.append(_CBIR_KEYWORD_SEARCHERS[name](cl, q, per_q))
        batches = await asyncio.gather(*tasks, return_exceptions=True)

    results: List[Dict] = []
    seen: set = set()
    for batch in batches:
        if not isinstance(batch, list):
            continue
        for item in batch:
            url = item.get("url", "")
            if url and url not in seen:
                seen.add(url)
                results.append(item)

    # round-robin interleave sources so the limit slice doesn't starve any site
    by_source: Dict[str, List[Dict]] = {}
    for item in results:
        by_source.setdefault(item.get("source", "?"), []).append(item)
    # eporner first within each round (has structured metadata)
    order = sorted(by_source, key=lambda s: 0 if s == "eporner" else 1)
    interleaved: List[Dict] = []
    i = 0
    while len(interleaved) < len(results):
        added = False
        for s in order:
            if i < len(by_source[s]):
                interleaved.append(by_source[s][i])
                added = True
        if not added:
            break
        i += 1
    logging.info("[VidSearch] total=%d by_source=%s", len(interleaved), {k: len(v) for k, v in by_source.items()})
    return interleaved[:limit]


class ReverseImageSearchRequest(BaseModel):
    keywords: Optional[List[str]] = None      # user-picked tags/keywords from the modal
    visual_match: bool = True                 # rank results by thumbnail similarity
    sources: Optional[List[str]] = None       # which engines to use; None/empty = all
    yandex_text: Optional[str] = None         # refine Yandex visual search (keywords or site:vk.com)
    visual_only: bool = False                 # skip keyword porn-site search — thumbnail engines only
    frame_count: int = 1                      # fast=1, deep=up to 3 diverse points
    mode: str = "fast"                       # fast | deep
    force_refresh: bool = False               # bypass Nexus' persistent result cache
    # Album Viewer cards are external files, not yet library Videos.  These
    # two fields let them use the same CBIR pipeline without creating a DB row.
    image_url: Optional[str] = None
    title: Optional[str] = None


def _thumb_fetch_headers(referer: str = "") -> Dict[str, str]:
    """Browser-like headers for hotlink-protected thumbnail CDNs.

    Several providers (58img.top and friends) answer a bare request with a
    403 HTML page instead of the image.  They only serve the JPEG when the
    request looks like an <img> load coming from the source page, so send the
    stored ``thumbnail_referer`` — falling back to the image's own origin.
    """
    headers = {
        "User-Agent": _CBIR_UA,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
    }
    if referer.startswith(("http://", "https://")):
        headers["Referer"] = referer
    return headers


def _looks_like_image(response: httpx.Response) -> bool:
    """Reject hotlink-block pages that are served with a 200/403 HTML body."""
    content_type = (response.headers.get("content-type") or "").lower()
    if content_type and not content_type.startswith("image/"):
        return False
    return bool(response.content) and len(response.content) > 500


def _video_thumb_referer(video: Any) -> str:
    """Best referer for a video's thumbnail CDN: stored value, else its page."""
    for candidate in (
        getattr(video, "thumbnail_referer", "") or "",
        getattr(video, "source_url", "") or "",
    ):
        candidate = str(candidate).strip()
        if candidate.startswith(("http://", "https://")):
            return candidate
    return ""


async def _load_video_thumb_bytes(thumbnail_path: str, referer: str = "") -> Optional[bytes]:
    """Načíta bajty náhľadu vrátane Telegram diskovej keše (data/telegram_thumbs) a vzdialených URL."""
    from .related_media import resolve_video_thumb_bytes
    return await resolve_video_thumb_bytes(thumbnail_path, referer=referer)


async def _public_image_url(video: Video) -> str:
    """Find a public image URL even when Nexus stores a local thumbnail copy."""
    stored_original = str(getattr(video, "original_thumbnail_url", "") or "").strip()
    stored_expired = False
    if stored_original and "phncdn.com" in stored_original.lower():
        try:
            parsed_query = urllib.parse.parse_qs(urllib.parse.urlparse(stored_original).query)
            expiry = int((parsed_query.get("validto") or [0])[0] or 0)
            if not expiry:
                expiry_match = re.search(r"(?:^|[~&])exp=(\d+)", stored_original)
                expiry = int(expiry_match.group(1)) if expiry_match else 0
            stored_expired = bool(expiry and expiry <= int(time.time()) + 300)
        except Exception:
            stored_expired = False
    if stored_original.startswith(("https://", "http://")) and not stored_expired:
        return stored_original
    thumb = str(video.thumbnail_path or "").strip()
    if thumb.startswith(("https://", "http://")):
        return thumb

    source_url = str(video.source_url or video.url or "").strip()
    # Eporner's API exposes the original public thumbnail directly.  This is
    # the common case for imported Eporner records, whose Nexus thumbnail is a
    # local cache despite the source itself being public.
    match = re.search(r"eporner\.com/video-([A-Za-z0-9]+)", source_url, re.I)
    if match:
        try:
            async with httpx.AsyncClient(timeout=10, headers={"User-Agent": _CBIR_UA}) as cl:
                response = await cl.get("https://www.eporner.com/api/v2/video/get/", params={
                    "id": match.group(1), "thumbsize": "big", "format": "json",
                })
            data = response.json() if response.status_code == 200 else {}
            public_thumb = (data.get("default_thumb") or {}).get("src") or ""
            if public_thumb.startswith("//"):
                public_thumb = "https:" + public_thumb
            if public_thumb.startswith(("https://", "http://")):
                return public_thumb
        except Exception as exc:
            logging.debug("[CBIR] Eporner thumbnail lookup failed: %s", exc)

    # Pornhub imports also cache thumbnails locally.  Its hub listing endpoint
    # still exposes the original public phncdn URL, so find the exact tile by
    # viewkey instead of treating the local cache path as the source image.
    viewkey_match = re.search(r"[?&]viewkey=([A-Za-z0-9]+)", source_url, re.I)
    if viewkey_match:
        try:
            from . import pornhub_hub as _pornhub
            # Pornhub search treats punctuation as part of the query and can
            # miss an exact title such as "Studio - title".  Search a clean
            # word-only form, then require an exact viewkey match.
            query = re.sub(r"[^\w\s]", " ", str(video.title or ""), flags=re.UNICODE)
            query = re.sub(r"\s+", " ", query).strip()[:180]
            listing = await _pornhub.search(query=query)
            wanted = viewkey_match.group(1).lower()
            for item in listing.get("items") or []:
                item_key = re.search(r"[?&]viewkey=([A-Za-z0-9]+)", str(item.get("url") or ""), re.I)
                if not item_key or item_key.group(1).lower() != wanted:
                    continue
                public_thumb = str(item.get("thumb") or "")
                if public_thumb.startswith("//"):
                    public_thumb = "https:" + public_thumb
                if public_thumb.startswith(("https://", "http://")):
                    return public_thumb
        except Exception as exc:
            logging.debug("[CBIR] Pornhub thumbnail lookup failed: %s", exc)

    # Other providers commonly expose an OpenGraph image on their public page.
    if source_url.startswith(("https://", "http://")):
        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=True, headers={"User-Agent": _CBIR_UA}) as cl:
                response = await cl.get(source_url)
            page = response.text[:100_000] if response.status_code == 200 else ""
            patterns = (
                r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)',
                r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
            )
            for pattern in patterns:
                found = re.search(pattern, page, re.I)
                if found:
                    candidate = urllib.parse.urljoin(source_url, found.group(1).strip())
                    if candidate.startswith(("https://", "http://")):
                        return candidate
        except Exception:
            pass

    # Some sources render their thumbnail only in player metadata (without an
    # OG tag).  yt-dlp can often expose that original remote thumbnail without
    # downloading video content, which keeps SerpApi usable for cached records.
    def _yt_dlp_thumbnail() -> str:
        for candidate_url in (source_url, str(video.url or "").strip()):
            if not candidate_url.startswith(("https://", "http://")):
                continue
            try:
                options = {
                    "quiet": True, "no_warnings": True, "skip_download": True,
                    "socket_timeout": 10,
                    "logger": type("_SilentYtdlp", (), {"debug": lambda *_: None, "warning": lambda *_: None, "error": lambda *_: None})(),
                }
                with yt_dlp.YoutubeDL(options) as ydl:
                    info = ydl.extract_info(candidate_url, download=False) or {}
                public_thumb = str(info.get("thumbnail") or "")
                if not public_thumb:
                    thumbs = info.get("thumbnails") or []
                    public_thumb = str((thumbs[-1] or {}).get("url") or "") if thumbs else ""
                if public_thumb.startswith(("https://", "http://")):
                    return public_thumb
            except Exception:
                continue
        return ""

    try:
        public_thumb = await asyncio.wait_for(asyncio.to_thread(_yt_dlp_thumbnail), timeout=15)
        if public_thumb:
            return public_thumb
    except Exception:
        pass
    return ""


async def _extract_search_frames(video: Video, count: int = 5) -> List[bytes]:
    """Vytiahne aktuálny náhľad a pri Deep režime aj snímky cez opravený pipeline."""
    from .related_media import extract_search_frames
    return await extract_search_frames(video, count=count)


async def _remote_image_matches_reference(
    image_url: str,
    reference_bytes: bytes,
    referer: str = "",
) -> bool:
    """Return True only when a public image still represents the current thumb.

    Provider imports keep ``original_thumbnail_url`` for provenance.  After a
    Smart Rethumb that URL can still point at a generic/error placeholder.  A
    small perceptual-hash check prevents Google Lens API from searching that
    stale image while the dashboard is showing a newly generated real frame.
    """
    if not image_url or not reference_bytes:
        return False
    try:
        # Hotlink-protected CDNs answer a bare request with a 403 HTML page, so
        # reuse the referer-aware loader instead of a plain GET.  Without it a
        # thumbnail was compared against an error page and always looked stale.
        candidate_bytes = await _load_video_thumb_bytes(image_url, referer)
        if not candidate_bytes or len(candidate_bytes) > 12_000_000:
            return False

        def _distance() -> int:
            from io import BytesIO
            from PIL import Image
            import imagehash
            with Image.open(BytesIO(reference_bytes)) as reference:
                reference_hash = imagehash.phash(reference.convert("RGB"))
            with Image.open(BytesIO(candidate_bytes)) as candidate:
                candidate_hash = imagehash.phash(candidate.convert("RGB"))
            return int(reference_hash - candidate_hash)

        # Re-encoding and modest resizing stay well below this threshold; a
        # text placeholder versus a real video frame does not.
        return await asyncio.to_thread(_distance) <= 10
    except Exception as exc:
        logging.debug("[CBIR] public thumbnail verification failed: %s", exc)
        return False


def _prepare_serpapi_image_bytes(raw_bytes: bytes, max_bytes: int = 490_000) -> bytes:
    """Adaptívne zmenší a zakóduje obrázok pod 500 KB limit SerpApi Image API."""
    if not raw_bytes:
        return b""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(raw_bytes)) as im:
            rgb = im.convert("RGB")
            for max_dim in (1280, 960, 720):
                cur = rgb
                if max(cur.size) > max_dim:
                    cur = cur.copy()
                    cur.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
                for q in (88, 78, 68, 56, 44):
                    buf = io.BytesIO()
                    cur.save(buf, format="JPEG", quality=q, optimize=True)
                    data = buf.getvalue()
                    if len(data) <= max_bytes:
                        return data
            return data
    except Exception:
        return raw_bytes[:max_bytes]


async def _serpapi_upload_image_id(cl: "httpx.AsyncClient", api_key: str, raw_bytes: bytes) -> str:
    """Nahrá lokálny náhľad priamo cez SerpApi Image API (POST /image) a vráti image_id."""
    jpg_bytes = await asyncio.to_thread(_prepare_serpapi_image_bytes, raw_bytes)
    if not jpg_bytes or len(jpg_bytes) > 500_000:
        raise RuntimeError("Náhľad sa nepodarilo zmenšiť pod 500 KB limit SerpApi")
    resp = await cl.post(
        "https://serpapi.com/image",
        data={"api_key": api_key},
        files={"image": ("reference.jpg", jpg_bytes, "image/jpeg")},
        timeout=httpx.Timeout(20.0, connect=10.0),
    )
    if resp.status_code != 200:
        raise RuntimeError(f"SerpApi Image upload HTTP {resp.status_code}: {resp.text[:200]}")
    payload = resp.json() or {}
    image_id = str(payload.get("image_id") or "").strip()
    if not image_id:
        raise RuntimeError(str(payload.get("error") or "SerpApi nevrátilo image_id"))
    return image_id


async def _serpapi_google_lens_search(
    image_url: str = "",
    limit: int = 32,
    query: str = "",
    image_bytes: Optional[bytes] = None,
) -> List[Dict]:
    """Fetch exact and visual Lens matches via direct image upload (preferred) or public URL.

    SerpApi's ``type=all`` response can contain both dedicated exact-match
    items and visual items annotated with ``exact_matches=true``.
    """
    api_key = config.SERPAPI_API_KEY
    if not api_key:
        raise RuntimeError("SERPAPI_API_KEY nie je nastavený")
    if not image_bytes and not image_url:
        raise RuntimeError("SerpApi potrebuje obrázok alebo verejnú URL náhľadu")

    params: Dict[str, Any] = {
        "engine": "google_lens",
        "type": "all",
        "api_key": api_key,
        "safe": "off",
        "auto_crop": "false",
        "hl": "en",
    }
    if query.strip():
        params["q"] = query.strip()[:240]

    timeout = httpx.Timeout(75.0, connect=10.0, write=15.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as cl:
            if image_bytes:
                try:
                    params["image_id"] = await _serpapi_upload_image_id(cl, api_key, image_bytes)
                except Exception as up_exc:
                    if image_url:
                        logging.warning("[CBIR/SerpApi] priamy upload zlyhal, skúšam URL fallback: %s", up_exc)
                        params["url"] = image_url
                    else:
                        raise RuntimeError(str(up_exc)) from up_exc
            else:
                params["url"] = image_url
            response = await cl.get("https://serpapi.com/search.json", params=params)
    except httpx.TimeoutException as exc:
        raise RuntimeError("SerpApi timeout po 75 s — skús hľadanie znova") from exc
    except httpx.HTTPError as exc:
        detail = str(exc).strip() or exc.__class__.__name__
        raise RuntimeError(f"SerpApi sieťová chyba: {detail}") from exc
    request_id = response.headers.get("x-request-id", "")
    if response.status_code != 200:
        body = response.text[:240].replace("\n", " ")
        raise RuntimeError(f"SerpApi HTTP {response.status_code}: {body}")
    try:
        data = response.json() or {}
    except Exception as exc:
        raise RuntimeError(f"SerpApi nevrátil JSON: {response.text[:160]}") from exc
    metadata = data.get("search_metadata") or {}
    search_id = str(metadata.get("id") or request_id or "")
    if data.get("error"):
        message = str(data["error"])
        if "hasn't returned any results" in message.lower():
            return []
        suffix = f" (search {search_id})" if search_id else ""
        raise RuntimeError(f"SerpApi: {message[:220]}{suffix}")

    groups = (
        ("exact", data.get("exact_matches") or []),
        ("visual", data.get("visual_matches") or []),
    )
    out: List[Dict] = []
    seen: set[str] = set()
    for group_type, items in groups:
        for index, item in enumerate(items):
            url = str(item.get("link") or item.get("url") or "")
            if not url.startswith("http") or url in seen:
                continue
            seen.add(url)
            is_exact = group_type == "exact" or bool(item.get("exact_matches"))
            match_type = "exact" if is_exact else "visual"
            out.append({
                "url": url,
                "title": str(item.get("title") or item.get("source") or url)[:180],
                "thumbnail": str(item.get("thumbnail") or item.get("image") or ""),
                "duration": 0,
                "source": "serpapi",
                "kind": "video",
                "match_type": match_type,
                "engine_rank": index,
                "reason": "Google Lens · " + ("presná zhoda" if is_exact else "vizuálna zhoda"),
                "search_id": search_id,
            })
            if len(out) >= limit:
                return out
    return out


def _r2_is_configured() -> bool:
    return all((
        config.R2_ACCOUNT_ID,
        config.R2_ACCESS_KEY_ID,
        config.R2_SECRET_ACCESS_KEY,
        config.R2_BUCKET,
    ))


def _r2_client():
    try:
        import boto3
    except ImportError as exc:
        raise RuntimeError("R2 je nastavené, ale chýba balík boto3") from exc
    return boto3.client(
        "s3",
        endpoint_url=f"https://{config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=config.R2_ACCESS_KEY_ID,
        aws_secret_access_key=config.R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )


async def _r2_publish_frames(frames: List[bytes]) -> List[Dict[str, str]]:
    """Upload private frames and return short-lived signed GET URLs."""
    if not frames or not _r2_is_configured():
        return []

    def _upload() -> List[Dict[str, str]]:
        client = _r2_client()
        published: List[Dict[str, str]] = []
        for index, frame in enumerate(frames):
            key = f"nexus-cbir/{datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):%Y/%m/%d}/{uuid.uuid4().hex}-{index}.jpg"
            client.put_object(
                Bucket=config.R2_BUCKET,
                Key=key,
                Body=frame,
                ContentType="image/jpeg",
                CacheControl="private, no-store",
            )
            url = client.generate_presigned_url(
                "get_object",
                Params={"Bucket": config.R2_BUCKET, "Key": key},
                ExpiresIn=config.R2_PRESIGN_TTL_SECONDS,
            )
            published.append({"key": key, "url": url})
        return published

    return await asyncio.to_thread(_upload)


async def _r2_delete_frames(published: List[Dict[str, str]]) -> None:
    if not published or not _r2_is_configured():
        return

    def _delete() -> None:
        client = _r2_client()
        for item in published:
            try:
                client.delete_object(Bucket=config.R2_BUCKET, Key=item["key"])
            except Exception as exc:
                logging.warning("[CBIR/R2] cleanup failed for %s: %s", item.get("key"), exc)

    await asyncio.to_thread(_delete)


async def _google_vision_web_search(frames: List[bytes], limit: int = 36) -> List[Dict]:
    """Use Google's supported Web Detection API with local image bytes."""
    if not config.GOOGLE_VISION_API_KEY:
        raise RuntimeError("GOOGLE_VISION_API_KEY nie je nastavený")
    if not frames:
        raise RuntimeError("Google Vision nemá žiadny náhľad")

    body = {
        "requests": [{
            "image": {"content": base64.b64encode(frame).decode("ascii")},
            "features": [
                {"type": "WEB_DETECTION", "maxResults": min(limit, 50)},
                {"type": "TEXT_DETECTION", "maxResults": 5},
            ],
        } for frame in frames[:3]],
    }
    async with httpx.AsyncClient(timeout=40, follow_redirects=True) as cl:
        response = await cl.post(
            "https://vision.googleapis.com/v1/images:annotate",
            headers={"X-goog-api-key": config.GOOGLE_VISION_API_KEY},
            json=body,
        )
    if response.status_code != 200:
        raise RuntimeError(f"Google Vision HTTP {response.status_code}: {response.text[:220]}")
    data = response.json() or {}
    out: List[Dict] = []
    seen_urls: set[str] = set()
    errors: List[str] = []
    from .related_media import classify_cbir_url

    for frame_index, annotation in enumerate(data.get("responses") or []):
        if annotation.get("error"):
            errors.append(str((annotation.get("error") or {}).get("message") or "unknown error"))
            continue
        text_anns = annotation.get("textAnnotations") or []
        ocr_text = str((text_anns[0] or {}).get("description") or "").strip() if text_anns else ""
        web = annotation.get("webDetection") or {}
        guesses = web.get("bestGuessLabels") or []
        best_guess = str((guesses[0] or {}).get("label") or "") if guesses else ""
        web_entities = [
            str(ent.get("description") or "").strip()
            for ent in (web.get("webEntities") or [])
            if str(ent.get("description") or "").strip() and float(ent.get("score") or 0.0) >= 0.45
        ][:6]

        # 1. Stránky s odpovedajúcim obrázkom (najvyššia informačná hodnota)
        for rank, page in enumerate(web.get("pagesWithMatchingImages") or []):
            url = str(page.get("url") or "")
            if not url.startswith("http") or url in seen_urls:
                continue
            cls_info = classify_cbir_url(url, str(page.get("pageTitle") or ""), "google_vision")
            if cls_info.get("blocked"):
                continue
            seen_urls.add(url)
            full = page.get("fullMatchingImages") or []
            partial = page.get("partialMatchingImages") or []
            thumb_item = (full or partial or [{}])[0] or {}
            match_type = "exact" if full else "partial" if partial else "visual"
            label = "presná webová zhoda" if match_type == "exact" else "čiastočná webová zhoda" if match_type == "partial" else "webová zhoda"
            out.append({
                "url": url,
                "title": str(page.get("pageTitle") or best_guess or (web_entities[0] if web_entities else "") or url)[:180],
                "thumbnail": str(thumb_item.get("url") or ""),
                "duration": 0,
                "source": "google_vision",
                "match_type": match_type,
                "web_entities": web_entities,
                "ocr_text": ocr_text,
                "engine_rank": frame_index * 100 + rank,
                "frame_index": frame_index,
                "reason": f"Google Web Detection · {label}",
            })
            if len(out) >= limit:
                return out

        # 2. Priame obrazové zhody (fullMatchingImages, partialMatchingImages, visuallySimilarImages)
        direct_groups = (
            ("fullMatchingImages", "exact", "presný obrázok", 30),
            ("partialMatchingImages", "partial", "čiastočný obrázok", 50),
            ("visuallySimilarImages", "visual", "podobný obrázok", 70),
        )
        for group_key, m_type, m_label, base_rank in direct_groups:
            for idx_img, img_obj in enumerate((web.get(group_key) or [])[:12]):
                img_url = str((img_obj or {}).get("url") or "")
                if not img_url.startswith("http") or img_url in seen_urls:
                    continue
                cls_info = classify_cbir_url(img_url, "", "google_vision", explicit_kind="image")
                if cls_info.get("blocked"):
                    continue
                seen_urls.add(img_url)
                host_label = urllib.parse.urlparse(img_url).hostname or img_url
                out.append({
                    "url": img_url,
                    "title": str(best_guess or (web_entities[0] if web_entities else "") or f"Obrázok ({host_label})")[:180],
                    "thumbnail": img_url,
                    "duration": 0,
                    "source": "google_vision",
                    "kind": "image",
                    "match_type": m_type,
                    "web_entities": web_entities,
                    "ocr_text": ocr_text,
                    "engine_rank": frame_index * 100 + base_rank + idx_img,
                    "frame_index": frame_index,
                    "reason": f"Google Web Detection · {m_label}",
                })
                if len(out) >= limit:
                    return out
    if not out and errors:
        raise RuntimeError("Google Vision: " + "; ".join(errors)[:220])
    return out


async def _timed_cbir_engine(name: str, operation) -> Dict[str, Any]:
    started = time.perf_counter()
    try:
        results = await operation
        return {
            "name": name,
            "status": "ok" if results else "empty",
            "count": len(results or []),
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "results": results or [],
            "error": "",
        }
    except Exception as exc:
        logging.warning("[CBIR/%s] failed: %s", name, exc)
        return {
            "name": name,
            "status": "unavailable" if "nie je nastaven" in str(exc).lower() else "error",
            "count": 0,
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "results": [],
            "error": str(exc)[:260] or exc.__class__.__name__,
        }


async def _probe_cbir_results(results: List[Dict], limit: int = 5) -> int:
    """Use yt-dlp only on the best candidates to enrich playback metadata."""
    targets = [item for item in results if item.get("url")][:limit]
    if not targets:
        return 0
    semaphore = asyncio.Semaphore(3)

    def _probe(url: str) -> Dict:
        silent_logger = type("_SilentProbeLogger", (), {
            "debug": lambda *_: None, "warning": lambda *_: None, "error": lambda *_: None,
        })()
        opts = {
            "quiet": True, "no_warnings": True, "skip_download": True,
            "socket_timeout": 10, "logger": silent_logger,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False) or {}

    async def _one(item: Dict) -> bool:
        try:
            async with semaphore:
                info = await asyncio.wait_for(asyncio.to_thread(_probe, item["url"]), timeout=15)
            item["duration"] = int(info.get("duration") or item.get("duration") or 0)
            item["height"] = int(info.get("height") or item.get("height") or 0)
            item["width"] = int(info.get("width") or item.get("width") or 0)
            item["file_size"] = int(info.get("filesize") or info.get("filesize_approx") or item.get("file_size") or 0)
            item["probe_ok"] = True
            return True
        except Exception:
            item["probe_ok"] = False
            return False

    checked = await asyncio.gather(*[_one(item) for item in targets])
    return sum(checked)


def _dedupe_and_score_cbir_results(
    results: List[Dict],
    keywords: Optional[List[str]] = None,
) -> List[Dict]:
    """Merge Lens matches and use tags only as a local ranking signal.

    Google Lens must remain an image-first search.  Sending a long list of
    gallery tags as its ``q`` parameter can turn useful visual matches into an
    empty response.  Tags therefore influence ordering here, after retrieval,
    without filtering candidates out.
    """
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

    ranking_keywords = []
    for keyword in keywords or []:
        clean = re.sub(r"\s+", " ", str(keyword).strip().casefold())
        if len(clean) >= 3 and clean not in ranking_keywords:
            ranking_keywords.append(clean)

    def _normalise(url: str) -> tuple[str, str]:
        parts = urlsplit(url)
        query = urlencode([(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not k.lower().startswith(("utm_", "fbclid", "gclid"))])
        host = re.sub(r"^www\.", "", (parts.hostname or "").lower())
        return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/") or "/", query, "")), host

    merged: Dict[str, Dict] = {}
    for item in results:
        url = str(item.get("url") or "")
        if not url.startswith("http"):
            continue
        key, domain = _normalise(url)
        if not domain:
            continue
        candidate = dict(item)
        candidate["url"] = key
        candidate["domain"] = domain
        candidate["match_types"] = {str(candidate.get("match_type") or candidate.get("source") or "other")}
        haystack = " ".join((
            str(candidate.get("title") or ""),
            str(candidate.get("url") or ""),
            str(candidate.get("reason") or ""),
            domain,
        )).casefold()
        candidate["tag_matches"] = [keyword for keyword in ranking_keywords if keyword in haystack]
        old = merged.get(key)
        if old:
            old["match_types"].update(candidate["match_types"])
            if candidate.get("thumbnail") and not old.get("thumbnail"):
                old["thumbnail"] = candidate["thumbnail"]
            if len(candidate["tag_matches"]) > len(old.get("tag_matches") or []):
                old["tag_matches"] = candidate["tag_matches"]
            continue
        merged[key] = candidate

    def _strength(item: Dict) -> float:
        base = 88 if "exact" in item["match_types"] else 76 if item.get("source") == "google_vision" else 74 if item.get("source") == "serpapi" else 72 if item.get("source") == "browser_lens" else 70 if item.get("source") == "yandex" else 67 if item.get("source") == "google" else 42
        tag_bonus = min(12, len(item.get("tag_matches") or []) * 4)
        return base + min(12, float(item.get("visual_score") or 0) * .12) + tag_bonus - min(10, int(item.get("engine_rank") or 0))

    # Keep every unique URL for the review grid.  Repeated domains get a small
    # ranking penalty instead of being discarded, so the user can inspect and
    # select all useful matches without one domain flooding the first row.
    final = sorted(merged.values(), key=_strength, reverse=True)
    domain_positions: Dict[str, int] = {}
    for item in final:
        domain = item["domain"]
        domain_positions[domain] = domain_positions.get(domain, 0) + 1
        item["domain_rank"] = domain_positions[domain]
        confidence = _strength(item) - min(6, (item["domain_rank"] - 1) * 2)
        confidence += min(10, (len(item["match_types"]) - 1) * 5)
        item["confidence"] = int(max(1, min(99, round(confidence))))
        item["match_types"] = sorted(item["match_types"])
    final.sort(key=lambda item: item["confidence"], reverse=True)
    return final


async def _visual_rank_results(results: List[Dict], ref_bytes: bytes) -> int:
    """Annotate *results* with visual_score (0-100, phash similarity to the local
    thumbnail) and re-sort best match first. Returns how many candidates scored."""
    try:
        from io import BytesIO
        from PIL import Image
        import imagehash
    except ImportError:
        return 0

    try:
        ref_hash = imagehash.phash(Image.open(BytesIO(ref_bytes)))
    except Exception:
        return 0

    scored = 0

    async def _score(cl: "httpx.AsyncClient", item: Dict):
        nonlocal scored
        # Yandex/Google hits already come from visual matching — their engine
        # order IS the visual relevance; phash across different frames of the
        # same video would only punish them.
        if item.get("source") in ("yandex", "google", "google_vision", "namethatporn"):
            return
        thumb = item.get("thumbnail") or ""
        if thumb.startswith("//"):
            thumb = "https:" + thumb
        if not thumb.startswith("http"):
            return
        try:
            r = await cl.get(thumb)
            if r.status_code != 200:
                return
            dist = ref_hash - imagehash.phash(Image.open(BytesIO(r.content)))  # 0..64
            item["visual_score"] = round(max(0.0, 1 - dist / 24) * 100)
            scored += 1
        except Exception:
            pass

    async with httpx.AsyncClient(
        timeout=8, follow_redirects=True,
        headers={"User-Agent": _CBIR_UA, "Accept-Language": "en-US,en;q=0.8"},
    ) as cl:
        await asyncio.gather(*[_score(cl, item) for item in results[:48]], return_exceptions=True)

    # Tiered ordering (stable sort keeps engine order within a tier):
    #   0 — phash-confirmed same frame (very likely the same video)
    #   1 — Yandex/Google visual matches in their engine order
    #   2 — keyword hits by descending phash score
    def _tier(item: Dict):
        vs = item.get("visual_score") or 0
        if vs >= 55:
            return (0, -vs)
        if item.get("source") in ("yandex", "google", "google_vision", "namethatporn"):
            return (1, 0)
        return (2, -vs)
    results.sort(key=_tier)
    return scored


@api_v1_router.post("/videos/{video_id}/reverse-image-search")
@api_legacy_router.post("/videos/{video_id}/reverse-image-search")
async def reverse_image_search_video(
    video_id: int,
    payload: Optional[ReverseImageSearchRequest] = Body(default=None),
    db: Session = Depends(get_db),
):
    """Orchestrate keyword, Lens, Vision and Yandex matching with cache/fallbacks."""
    settings = payload or ReverseImageSearchRequest()
    external_thumbnail = str(settings.image_url or "").strip()
    is_external_thumb = bool(external_thumbnail) or video_id <= 0
    if is_external_thumb:
        if external_thumbnail:
            from .related_media import validate_public_http_url
            url_ok, url_reason = await asyncio.to_thread(validate_public_http_url, external_thumbnail)
            if not url_ok:
                raise HTTPException(status_code=422, detail=url_reason or "Náhľad musí byť verejná HTTP(S) URL")
        # A deliberately tiny object is enough for the shared frame/keyword
        # helpers.  It never reaches the database or import pipeline.
        video = type("ExternalAlbumThumbnail", (), {
            "thumbnail_path": external_thumbnail,
            "title": str(settings.title or ""),
            "tags": "",
            "models": "",
            "url": "",
            "source_url": "",
            "original_thumbnail_url": external_thumbnail,
            "thumbnail_referer": "",
        })()
    else:
        video = db.query(Video).filter(Video.id == video_id).first()
        if not video:
            raise HTTPException(status_code=404, detail="Video not found")
    mode = "deep" if str(settings.mode or "fast").lower() == "deep" else "fast"
    keywords = [str(k).strip() for k in (settings.keywords or []) if str(k).strip()][:16]
    sources_explicit = settings.sources is not None
    sources = [s.strip().lower() for s in (settings.sources or []) if s and s.strip()]
    yandex_text = str(settings.yandex_text or "").strip()
    visual_only = bool(settings.visual_only)

    if sources_explicit and not sources:
        return {
            "status": "no_sources",
            "results": [],
            "count": 0,
            "video_sites": 0,
            "collections": 0,
            "visual_scored": 0,
            "frames_used": 0,
            "probes_completed": 0,
            "keywords_used": keywords,
            "engines": {},
            "engine_details": {},
            "image_broker": {"status": "not_needed", "provider": "none", "count": 0, "error": ""},
            "browser_assist_recommended": False,
            "mode": mode,
            "cached": False,
            "cache_age_seconds": 0,
        }

    requested_frames = 3 if mode == "deep" else 1
    frame_count = min(3, max(1, int(settings.frame_count or requested_frames)))
    frames = await _extract_search_frames(video, frame_count)
    ref_bytes = frames[0] if frames else None

    def _wants(name: str) -> bool:
        # Rozlíšenie explicitného zoznamu vs. None (= predvolené zdroje bez Google scrapera).
        if sources_explicit:
            return name in sources
        return name != "google"

    request_options = {
        "video_id": video_id,
        "external_thumbnail": is_external_thumb,
        "keywords": keywords,
        "sources": sorted(sources),
        "yandex_text": yandex_text,
        "visual_only": visual_only,
        "visual_match": bool(settings.visual_match),
        "frame_count": frame_count,
        "mode": mode,
    }
    image_hash = hashlib.sha256(b"".join(frames) if frames else str(video.thumbnail_path or "").encode()).hexdigest()
    cache_material = json.dumps(
        {"pipeline_version": 6, "image_hash": image_hash, **request_options},
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    cache_key = hashlib.sha256(cache_material.encode("utf-8")).hexdigest()
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    # External album cards are intentionally not persisted in cbir_search_cache:
    # that table is tied to a real library video_id.  Album snapshot caching
    # remains separate from user-library state.
    if not is_external_thumb and not settings.force_refresh:
        cached_row = db.query(CBIRSearchCache).filter(CBIRSearchCache.cache_key == cache_key).first()
        if cached_row and cached_row.expires_at > now:
            cached = json.loads(json.dumps(cached_row.response_json or {}))
            cached["cached"] = True
            cached["cache_age_seconds"] = max(0, int((now - cached_row.created_at).total_seconds()))
            return cached
        if cached_row:
            db.delete(cached_row)
            db.commit()

    engine_tasks: Dict[str, "asyncio.Task"] = {}
    kw_sources = [s for s in sources if s in _CBIR_KEYWORD_SEARCHERS]
    if not visual_only and (not sources or kw_sources):
        engine_tasks["keyword"] = asyncio.create_task(_timed_cbir_engine(
            "keyword",
            _search_same_video(
                title=str(video.title or ""),
                tags=str(video.tags or ""),
                models=str(getattr(video, "models", "") or ""),
                limit=40 if mode == "deep" else 24,
                keywords=keywords,
                sources=kw_sources,
            ),
        ))

    async def _search_yandex_frames() -> List[Dict]:
        batches = await asyncio.gather(*[
            _yandex_cbir_search(frame, limit=12, text=yandex_text) for frame in frames
        ], return_exceptions=True)
        successful = [batch for batch in batches if isinstance(batch, list)]
        if not successful and batches:
            first_error = next((batch for batch in batches if isinstance(batch, Exception)), None)
            raise RuntimeError(str(first_error or "Yandex nevrátil výsledky"))
        return [item for batch in successful for item in batch]

    if frames and _wants("namethatporn"):
        from .related_creator_discovery import namethatporn_cbir_search
        engine_tasks["namethatporn"] = asyncio.create_task(
            _timed_cbir_engine("namethatporn", namethatporn_cbir_search(frames[:2], image_url=external_thumbnail, limit=20))
        )
    if frames and _wants("yandex"):
        engine_tasks["yandex"] = asyncio.create_task(_timed_cbir_engine("yandex", _search_yandex_frames()))
    if ref_bytes and _wants("google"):
        engine_tasks["google"] = asyncio.create_task(_timed_cbir_engine("google", _google_reverse_image_search(ref_bytes)))

    broker_detail: Dict[str, Any] = {
        "status": "not_needed",
        "provider": "source_url",
        "count": 0,
        "error": "",
    }
    published_frames: List[Dict[str, str]] = []
    browser_assist_recommended = False
    if _wants("serpapi"):
        async def _search_serpapi_direct() -> List[Dict]:
            nonlocal broker_detail
            fallback_url = external_thumbnail if external_thumbnail.startswith(("http://", "https://")) else ""
            if frames:
                broker_detail = {
                    "status": "ok",
                    "provider": "serpapi_direct_upload",
                    "count": len(frames[:frame_count]),
                    "latency_ms": 0,
                    "error": "",
                }
                batches = await asyncio.gather(*[
                    _serpapi_google_lens_search(image_url=fallback_url, image_bytes=frame, limit=32)
                    for frame in frames[:frame_count]
                ], return_exceptions=True)
            else:
                serpapi_image_url = fallback_url or await _public_image_url(video)
                if not serpapi_image_url:
                    raise RuntimeError("Aktuálny náhľad sa nepodarilo načítať; použije sa Browser Assist")
                batches = await asyncio.gather(
                    _serpapi_google_lens_search(image_url=serpapi_image_url, limit=32),
                    return_exceptions=True,
                )
            successful = [batch for batch in batches if isinstance(batch, list)]
            if not successful:
                first_error = next((batch for batch in batches if isinstance(batch, Exception)), None)
                if first_error:
                    error_text = str(first_error).strip() or first_error.__class__.__name__
                    raise RuntimeError(error_text) from first_error
                raise RuntimeError("SerpApi nevrátil výsledky")
            return [item for batch in successful for item in batch]

        engine_tasks["serpapi"] = asyncio.create_task(_timed_cbir_engine("serpapi", _search_serpapi_direct()))

    if frames and _wants("vision"):
        engine_tasks["vision"] = asyncio.create_task(_timed_cbir_engine(
            "vision",
            _google_vision_web_search(frames[:3], limit=36),
        ))

    engine_outcomes = await asyncio.gather(*engine_tasks.values()) if engine_tasks else []
    if published_frames:
        await _r2_delete_frames(published_frames)

    results: List[Dict] = []
    seen_urls: set = set()
    engines: Dict[str, Any] = {}
    engine_details: Dict[str, Dict[str, Any]] = {}
    for outcome in engine_outcomes:
        name = str(outcome["name"])
        batch = outcome.pop("results", []) or []
        engine_details[name] = outcome
        engines[name] = len(batch) if outcome["status"] == "ok" else f"chyba: {outcome['error']}"
        for item in batch:
            u = item.get("url", "")
            if u and u not in seen_urls:
                seen_urls.add(u)
                # annotate a clean domain for the UI (e.g. "vk.com", "eporner.com")
                try:
                    from urllib.parse import urlparse
                    item["domain"] = re.sub(r"^www\.", "", (urlparse(u).hostname or "")).lower()
                except Exception:
                    item["domain"] = ""
                results.append(item)
    if not frames:
        if _wants("yandex"):
            engines["yandex"] = "bez náhľadu — preskočené"
            engine_details["yandex"] = {"name": "yandex", "status": "unavailable", "count": 0, "latency_ms": 0, "error": "Video nemá použiteľný náhľad"}
        if _wants("google"):
            engines["google"] = "bez náhľadu — preskočené"
            engine_details["google"] = {"name": "google", "status": "unavailable", "count": 0, "latency_ms": 0, "error": "Video nemá použiteľný náhľad"}
        if _wants("vision"):
            engines["vision"] = "bez náhľadu — preskočené"
            engine_details["vision"] = {"name": "vision", "status": "unavailable", "count": 0, "latency_ms": 0, "error": "Video nemá použiteľný náhľad"}

    from .related_media import classify_cbir_url as _classify_cbir_url
    from . import visual_semantic_index as _vsi

    # Odfiltrujeme YouTube/e-shopy/SEO spamové domény pred skórovaním
    cleaned_results: List[Dict] = []
    for item in results:
        cls_info = _classify_cbir_url(item.get("url", ""), item.get("title", ""), item.get("source", ""))
        if cls_info["blocked"]:
            continue
        item["kind"] = item.get("kind") or cls_info["kind"]
        item["is_video_site"] = cls_info["is_video_site"]
        cleaned_results.append(item)
    results = cleaned_results

    visual_scored = 0
    if results and settings.visual_match and ref_bytes:
        if _vsi.is_gpu_ready():
            visual_scored = await _vsi.score_candidate_thumbnails(ref_bytes, results, max_fetch=36)
        else:
            visual_scored = await _visual_rank_results(results, ref_bytes)

    results = _dedupe_and_score_cbir_results(results, keywords=keywords)
    # Probing už neblokuje hlavnú odpoveď — spúšťa sa on-demand cez /api/v1/related/probe
    probes_completed = 0
    results.sort(key=lambda item: item.get("confidence", 0), reverse=True)

    videos      = sum(1 for r in results if r.get("kind") == "video")
    collections = sum(1 for r in results if r.get("kind") == "collection")
    response_payload = {
        "results": results,
        "count": len(results),
        "video_sites": videos,
        "collections": collections,
        "visual_scored": visual_scored,
        "frames_used": len(frames),
        "probes_completed": probes_completed,
        "keywords_used": keywords,
        "engines": engines,
        "engine_details": engine_details,
        "image_broker": broker_detail,
        "browser_assist_recommended": browser_assist_recommended,
        "mode": mode,
        "cached": False,
        "cache_age_seconds": 0,
    }
    # Do not keep empty searches for 24 hours.  A temporary upstream miss
    # should be retried normally on the next click.
    has_engine_error = any(detail.get("status") == "error" for detail in engine_details.values())
    if (not is_external_thumb and results and not has_engine_error
            and any(detail.get("status") == "ok" for detail in engine_details.values())):
        expires_at = now + datetime.timedelta(hours=config.CBIR_CACHE_TTL_HOURS)
        cache_row = db.query(CBIRSearchCache).filter(CBIRSearchCache.cache_key == cache_key).first()
        if not cache_row:
            cache_row = CBIRSearchCache(
                cache_key=cache_key,
                video_id=video_id,
                image_hash=image_hash,
                request_json=request_options,
                response_json=response_payload,
                created_at=now,
                expires_at=expires_at,
            )
            db.add(cache_row)
        else:
            cache_row.request_json = request_options
            cache_row.response_json = response_payload
            cache_row.created_at = now
            cache_row.expires_at = expires_at
        try:
            db.commit()
        except Exception as exc:
            db.rollback()
            logging.warning("[CBIR/cache] save failed: %s", exc)
    return response_payload


@api_v1_router.post("/cbir/thumbnail-search")
@api_legacy_router.post("/cbir/thumbnail-search")
async def reverse_image_search_external_thumbnail(
    payload: ReverseImageSearchRequest,
    db: Session = Depends(get_db),
):
    """Related Search for a non-imported Album Viewer card.

    The request is image-first by default.  When the UI supplies tags it sends
    only keyword engines, so a tag search never mixes in title-derived matches.
    """
    if not str(payload.image_url or "").strip() and not payload.keywords:
        raise HTTPException(status_code=422, detail="Vyber náhľad alebo zadaj tag")
    return await reverse_image_search_video(video_id=0, payload=payload, db=db)


class CBIRBrowserJobRequest(BaseModel):
    background: bool = False


class CBIRBrowserResultsRequest(BaseModel):
    status: str = "complete"
    results: Optional[List[Dict[str, Any]]] = None
    error: str = ""


_CBIR_BROWSER_JOBS: Dict[str, Dict[str, Any]] = {}


def _cleanup_cbir_browser_jobs() -> None:
    now_ts = time.time()
    expired = [job_id for job_id, job in _CBIR_BROWSER_JOBS.items() if float(job.get("expires_ts") or 0) <= now_ts]
    for job_id in expired:
        _CBIR_BROWSER_JOBS.pop(job_id, None)


def _public_cbir_browser_job(job: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "job_id": job["job_id"],
        "video_id": job["video_id"],
        "status": job["status"],
        "background": job["background"],
        "created_at": job["created_at"],
        "expires_at": job["expires_at"],
        "result_count": len(job.get("results") or []),
        "results": job.get("results") or [],
        "error": job.get("error") or "",
    }


@api_v1_router.get("/cbir/status")
async def cbir_status():
    from . import visual_semantic_index as _vsi
    return {
        "serpapi": {"configured": bool(config.SERPAPI_API_KEY), "role": "visual"},
        "vision": {"configured": bool(config.GOOGLE_VISION_API_KEY), "role": "optional"},
        "r2": {"configured": _r2_is_configured(), "role": "image_broker"},
        "browser_bridge": {"configured": True, "role": "assisted_fallback"},
        "direct_google": {"configured": False, "role": "disabled"},
        "visual_index": _vsi.get_status(),
        "cache_ttl_hours": config.CBIR_CACHE_TTL_HOURS,
    }


@api_v1_router.post("/videos/{video_id}/cbir/browser-job")
async def create_cbir_browser_job(
    video_id: int,
    payload: Optional[CBIRBrowserJobRequest] = Body(default=None),
    db: Session = Depends(get_db),
):
    """Create a short-lived one-image job for the local Lens Bridge extension."""
    _cleanup_cbir_browser_jobs()
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
    frames = await _extract_search_frames(video, 1)
    if not frames:
        raise HTTPException(status_code=422, detail="Video nemá použiteľný náhľad")
    job_id = uuid.uuid4().hex
    token = secrets.token_urlsafe(32)
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    expires = now + datetime.timedelta(seconds=config.CBIR_BROWSER_JOB_TTL_SECONDS)
    job = {
        "job_id": job_id,
        "video_id": video_id,
        "status": "waiting_for_extension",
        "background": bool(payload.background) if payload else False,
        "created_at": now.isoformat() + "Z",
        "expires_at": expires.isoformat() + "Z",
        # ``expires`` is a naive UTC value for JSON compatibility; using its
        # timestamp on a non-UTC Windows timezone would expire the job early.
        "expires_ts": time.time() + config.CBIR_BROWSER_JOB_TTL_SECONDS,
        "token": token,
        "image_bytes": frames[0],
        "results": [],
        "error": "",
    }
    _CBIR_BROWSER_JOBS[job_id] = job
    return {
        **_public_cbir_browser_job(job),
        "token": token,
        "image_path": f"/api/v1/cbir/browser-jobs/{job_id}/image?token={urllib.parse.quote(token)}",
        "results_path": f"/api/v1/cbir/browser-jobs/{job_id}/results",
    }


@api_v1_router.get("/cbir/browser-jobs/{job_id}")
async def get_cbir_browser_job(job_id: str):
    _cleanup_cbir_browser_jobs()
    job = _CBIR_BROWSER_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Browser Assist job expired or not found")
    return _public_cbir_browser_job(job)


@api_v1_router.get("/cbir/browser-jobs/{job_id}/image")
async def get_cbir_browser_job_image(job_id: str, token: str = Query(default="")):
    _cleanup_cbir_browser_jobs()
    job = _CBIR_BROWSER_JOBS.get(job_id)
    if not job or not secrets.compare_digest(str(job.get("token") or ""), str(token or "")):
        raise HTTPException(status_code=404, detail="Browser Assist image expired or not found")
    job["status"] = "extension_connected"
    return Response(
        content=job["image_bytes"],
        media_type="image/jpeg",
        headers={"Cache-Control": "private, no-store, max-age=0"},
    )


@api_v1_router.post("/cbir/browser-jobs/{job_id}/results")
async def save_cbir_browser_job_results(
    job_id: str,
    payload: CBIRBrowserResultsRequest,
    x_cbir_job_token: Optional[str] = Header(default=None, alias="X-CBIR-Job-Token"),
):
    _cleanup_cbir_browser_jobs()
    job = _CBIR_BROWSER_JOBS.get(job_id)
    if not job or not x_cbir_job_token or not secrets.compare_digest(str(job.get("token") or ""), x_cbir_job_token):
        raise HTTPException(status_code=401, detail="Invalid or expired Browser Assist token")
    normalized: List[Dict[str, Any]] = []
    for index, raw in enumerate((payload.results or [])[:80]):
        url = str(raw.get("url") or raw.get("link") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        host = (urllib.parse.urlparse(url).hostname or "").lower()
        if host.endswith("google.com") or host.endswith("google.sk") or host.endswith("gstatic.com"):
            continue
        normalized.append({
            "url": url,
            "title": str(raw.get("title") or raw.get("text") or host or url)[:180],
            "thumbnail": str(raw.get("thumbnail") or raw.get("image") or ""),
            "duration": 0,
            "source": "browser_lens",
            "kind": "video",
            "match_type": "visual",
            "engine_rank": index,
            "reason": "Google Lens · Browser Assist",
        })
    job["results"] = _dedupe_and_score_cbir_results(normalized)
    requested_status = str(payload.status or "complete").lower()
    job["status"] = requested_status if requested_status in {"complete", "needs_user", "error"} else "complete"
    job["error"] = str(payload.error or "")[:260]
    return _public_cbir_browser_job(job)


@api_v1_router.post("/videos/{video_id}/auto-tag")
@api_legacy_router.post("/videos/{video_id}/auto-tag")
async def auto_tag_video(
    video_id: int,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Extract model names and keywords from title/batch/URL/models, merge into video tags."""
    from app.ai_tagger_batch import _apply_vision_tags_to_video_obj, extract_nlp_tags_and_models

    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    nlp_parsed = extract_nlp_tags_and_models(
        title=str(video.title or ""),
        batch_name=str(getattr(video, "batch_name", "") or ""),
        source_url=str(getattr(video, "source_url", "") or getattr(video, "url", "") or ""),
        existing_models=str(getattr(video, "models", "") or ""),
        existing_categories=str(getattr(video, "categories", "") or ""),
    )
    new_tags = _apply_vision_tags_to_video_obj(video, nlp_parsed, overwrite=False) or []
    if new_tags:
        db.commit()

    return {
        "video_id": video_id,
        "new_tags": new_tags,
        "all_tags": video.tags or "",
        "added": len(new_tags),
    }


def _loads_first_json_object(text: str) -> dict:
    """Parse the first complete JSON object in `text`, ignoring anything after it."""
    import json as _json

    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.I | re.S).strip()

    start = cleaned.find("{")
    if start == -1:
        raise ValueError(f"no JSON object in model output: {cleaned[:120]!r}")

    obj, _end = _json.JSONDecoder().raw_decode(cleaned, start)
    if not isinstance(obj, dict):
        raise ValueError(f"model returned {type(obj).__name__}, expected object")
    return obj


@api_v1_router.post("/videos/{video_id}/ai-tag-thumbnail")
@api_legacy_router.post("/videos/{video_id}/ai-tag-thumbnail")
async def ai_tag_thumbnail(
    video_id: int,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Local GPU SigLIP 2 Zero-Shot + Visual k-NN + NLP auto-tagger (zero API cost, no quota limits)."""
    from app.ai_tagger_batch import _apply_vision_tags_to_video_obj, call_gemini_vision

    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    img = await _load_video_thumb_bytes(
        str(video.thumbnail_path or ""),
        _video_thumb_referer(video),
    )

    try:
        parsed = await call_gemini_vision(
            img_bytes=img or b"",
            api_key="",
            title_hint=str(video.title or ""),
            video_id=video_id,
            batch_name=str(getattr(video, "batch_name", "") or ""),
            source_url=str(getattr(video, "source_url", "") or getattr(video, "url", "") or ""),
        )
    except Exception as e:
        logging.warning("[AI-Tag] video %s failed: %s", video_id, e)
        raise HTTPException(status_code=502, detail=f"AI tagger zlyhal: {str(e)[:200]}")

    new_tags = _apply_vision_tags_to_video_obj(video, parsed, overwrite=False) or []
    model_guess = str(parsed.get("model_guess") or "").strip()
    if new_tags or model_guess:
        db.commit()

    return {
        "video_id": video_id,
        "new_tags": new_tags,
        "model_guess": model_guess,
        "all_tags": video.tags or "",
        "added": len(new_tags),
    }


@api_v1_router.post("/discovery/import-selected")
async def import_selected_videos(
    video_ids: List[int] = Body(...),
    background_tasks: BackgroundTasks = None,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Import selected discovered videos to main library."""
    imported_count = 0

    for vid_id in video_ids:
        discovered = db.query(DiscoveredVideo).filter(DiscoveredVideo.id == vid_id).first()

        if not discovered or discovered.imported:
            continue

        # Check if URL already exists in main videos
        existing = db.query(Video).filter(Video.url == discovered.url).first()
        if existing:
            # Mark as imported with existing video_id
            discovered.imported = True
            discovered.video_id = existing.id
            discovered.imported_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            continue

        # Create new video entry
        models_str = getattr(discovered, "models", "") or ""
        categories_str = getattr(discovered, "categories", "") or ""
        extra_tags = []
        if models_str:
            extra_tags.append(models_str)
        if categories_str:
            extra_tags.append(categories_str)
        tags_str = ",".join(extra_tags) if extra_tags else ""

        video = Video(
            title=discovered.title,
            url=discovered.url,
            source_url=discovered.source_url,
            thumbnail_path=discovered.thumbnail,
            duration=discovered.duration,
            width=discovered.width,
            height=discovered.height,
            file_size_mb=discovered.file_size_mb,
            batch_name=f"{discovered.profile_name}-{datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).strftime('%Y%m%d')}",
            storage_type='remote',
            status='pending',
            categories=categories_str,
            models=models_str,
            preview_mp4_url=getattr(discovered, "preview_mp4_url", "") or "",
            tags=tags_str
        )

        db.add(video)
        db.flush()

        # Mark discovered video as imported
        discovered.imported = True
        discovered.video_id = video.id
        discovered.imported_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)

        # Queue for processing in background
        if background_tasks:
            background_tasks.add_task(VIPVideoProcessor().process_single_video, video.id)

        imported_count += 1

    db.commit()

    return {"success": True, "imported_count": imported_count}

@api_v1_router.delete("/discovery/review/{discovered_id}")
async def delete_discovered_video(discovered_id: int, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Delete a discovered video from review list."""
    discovered = db.query(DiscoveredVideo).filter(DiscoveredVideo.id == discovered_id).first()

    if not discovered:
        raise HTTPException(status_code=404, detail="Discovered video not found")

    _remember_discovery_dismissal(db, discovered)
    db.delete(discovered)
    db.commit()

    return {"success": True}


@api_v1_router.post("/discovery/remove-selected")
async def remove_selected_discovered_videos(
    request: DiscoveryIdsRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Remove selected discovered videos and remember them as dismissed for the profile."""
    if not request.video_ids:
        return {"success": True, "removed_count": 0}

    discovered_rows = db.query(DiscoveredVideo).filter(
        DiscoveredVideo.id.in_(request.video_ids)
    ).all()

    removed_count = 0
    for discovered in discovered_rows:
        _remember_discovery_dismissal(db, discovered)
        db.delete(discovered)
        removed_count += 1

    db.commit()
    return {"success": True, "removed_count": removed_count}


@api_v1_router.post("/discovery/review/{profile_id}/metadata")
async def fetch_discovery_review_metadata(
    profile_id: int,
    request: DiscoveryMetadataRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Fetch missing metadata for selected discovery review videos."""
    query = db.query(DiscoveredVideo).filter(DiscoveredVideo.profile_id == profile_id)
    effective_batch_size = max(1, min(int(request.batch_size or 6), 8))
    only_missing = bool(request.only_missing)
    max_items = int(request.max_items) if request.max_items else None

    if request.video_ids:
        query = query.filter(DiscoveredVideo.id.in_(request.video_ids))
    elif request.all_missing or only_missing:
        query = query.filter(
            or_(
                DiscoveredVideo.duration == 0,
                DiscoveredVideo.height == 0,
                DiscoveredVideo.width == 0,
                DiscoveredVideo.file_size_mb == 0,
                DiscoveredVideo.thumbnail == "",
                DiscoveredVideo.thumbnail.is_(None)
            )
        )

    rows = query.order_by(desc(DiscoveredVideo.discovered_at)).all()
    if max_items is not None and max_items > 0:
        rows = rows[:max_items]

    updated_count = 0
    processed_count = 0

    total = len(rows)
    for chunk_start in range(0, total, effective_batch_size):
        chunk = rows[chunk_start:chunk_start + effective_batch_size]
        results = await asyncio.gather(
            *[_enrich_discovered_video_metadata(discovered) for discovered in chunk],
            return_exceptions=True,
        )
        for discovered, result in zip(chunk, results):
            processed_count += 1
            if isinstance(result, Exception):
                logging.warning(
                    "[DiscoveryMetadata] failed discovered_id=%s title=%s error=%s",
                    discovered.id,
                    (discovered.title or "")[:80],
                    str(result)[:260],
                )
                continue
            if result:
                updated_count += 1

            try:
                await manager.broadcast(json.dumps({
                    "type": "discovery_metadata_progress",
                    "profile_id": profile_id,
                    "processed": processed_count,
                    "total": total,
                    "updated": updated_count,
                }))
            except Exception:
                # Progress events are best-effort.
                pass

    touched = [_serialize_discovered_video(discovered) for discovered in rows]

    db.commit()

    return {
        "success": True,
        "processed_count": processed_count,
        "updated_count": updated_count,
        "batch_size": effective_batch_size,
        "only_missing": only_missing,
        "max_items": max_items,
        "videos": touched,
    }

@api_v1_router.post("/discovery/clear-imported/{profile_id}")
async def clear_imported_discoveries(profile_id: int, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Clear all imported discovered videos for a profile."""
    deleted_count = db.query(DiscoveredVideo).filter(
        DiscoveredVideo.profile_id == profile_id,
        DiscoveredVideo.imported == True
    ).delete()

    db.commit()

    return {"success": True, "deleted_count": deleted_count}


# ============================================
# QUANTUM UX BACKEND API ENDPOINTS
# Supporting 10 powerful UX features
# ============================================

# ========== TAG CLOUD & AUTOCOMPLETE ==========
@api_v1_router.get("/tags/cloud")
@api_legacy_router.get("/tags/cloud")
async def get_tag_cloud(db: Session = Depends(get_db)):
    """Get tag cloud with frequency counts."""
    from sqlalchemy import func

    # Get all tags and count their frequency
    all_tags = db.query(Video.tags, Video.ai_tags).filter(
        or_(Video.tags != "", Video.ai_tags != "")
    ).all()

    tag_counts = {}
    for tags, ai_tags in all_tags:
        for tag_str in [tags, ai_tags]:
            if tag_str:
                for tag in tag_str.split(','):
                    tag = tag.strip()
                    if tag:
                        tag_counts[tag] = tag_counts.get(tag, 0) + 1

    # Convert to sorted list
    tag_list = [{"tag": tag, "count": count} for tag, count in tag_counts.items()]
    tag_list.sort(key=lambda x: x['count'], reverse=True)

    return {"tags": tag_list[:50]}  # Top 50 tags

@api_v1_router.get("/tags/search")
@api_legacy_router.get("/tags/search")
async def search_tags(q: str, db: Session = Depends(get_db)):
    """Search for tags matching query."""
    all_tags = db.query(Video.tags, Video.ai_tags).filter(
        or_(Video.tags.contains(q), Video.ai_tags.contains(q))
    ).limit(100).all()

    matching_tags = set()
    for tags, ai_tags in all_tags:
        for tag_str in [tags, ai_tags]:
            if tag_str:
                for tag in tag_str.split(','):
                    tag = tag.strip()
                    if tag and q.lower() in tag.lower():
                        matching_tags.add(tag)

    tag_list = [{"tag": tag} for tag in sorted(matching_tags)]
    return {"tags": tag_list[:20]}


@api_v1_router.get("/health/sources")
@api_legacy_router.get("/health/sources")
async def get_health_by_source(db: Session = Depends(get_db)):
    """Get health statistics grouped by source plus Unknown domain backlog (cached + projected)."""
    from collections import Counter

    from .source_catalog import classify_library_source_name, unknown_domain_from_urls
    from .stats_cache import stats_cache

    def _compute():
        rows = db.query(Video.url, Video.source_url, Video.link_status).yield_per(2000)

        sources = {}
        domain_counts: Counter = Counter()

        for v_url, v_src, v_status in rows:
            label = classify_library_source_name(v_url, v_src)
            if label == "Unknown":
                host = unknown_domain_from_urls(v_url, v_src)
                if host:
                    domain_counts[host] += 1

            if label not in sources:
                sources[label] = {"total": 0, "working": 0, "broken": 0, "unknown": 0}

            sources[label]["total"] += 1
            status = v_status or 'unknown'
            sources[label][status] = sources[label].get(status, 0) + 1

        source_list = []
        for name, stats in sources.items():
            score = (stats['working'] / stats['total'] * 100) if stats['total'] > 0 else 0
            source_list.append({
                "name": name,
                "score": round(score, 1),
                "stats": stats
            })

        source_list.sort(key=lambda x: x['score'], reverse=True)

        unknown_domains = [
            {"host": host, "count": count}
            for host, count in domain_counts.most_common(50)
        ]

        return {"sources": source_list, "unknown_domains": unknown_domains}

    return stats_cache.get_or_compute("health_sources", _compute, ttl=30.0)

@api_v1_router.post("/health/refresh-broken")
@api_legacy_router.post("/health/refresh-broken")
async def refresh_broken_links(background_tasks: BackgroundTasks, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Refresh all broken links in the background."""
    broken_videos = db.query(Video).filter(Video.link_status == 'broken').all()

    async def refresh_all():
        for video in broken_videos:
            try:
                # Use existing refresh logic from services
                pass  # TODO: Call refresh_video_link
            except Exception as e:
                print(f"Failed to refresh {video.id}: {e}")

    background_tasks.add_task(refresh_all)

    return {"status": "started", "count": len(broken_videos)}


# ========== DISCOVERY DASHBOARD ENHANCEMENTS ==========
@api_v1_router.get("/discovery/profiles/{profile_id}/stats")
async def get_discovery_profile_stats(profile_id: int, db: Session = Depends(get_db)):
    """Get statistics for a specific discovery profile."""
    profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()

    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Get match counts
    total_found = db.query(DiscoveredVideo).filter(DiscoveredVideo.profile_id == profile_id).count()
    imported = db.query(DiscoveredVideo).filter(
        DiscoveredVideo.profile_id == profile_id,
        DiscoveredVideo.imported == True
    ).count()
    pending = total_found - imported

    # Calculate progress
    progress = (imported / total_found * 100) if total_found > 0 else 0

    return {
        "profile_id": profile_id,
        "total_found": total_found,
        "imported": imported,
        "pending": pending,
        "progress": round(progress, 1),
        "last_run": profile.last_run.isoformat() if profile.last_run else None,
        "status": "running" if False else "idle"  # TODO: Check actual running status
    }


@api_v1_router.get("/discovery/profiles/{profile_id}/matches")
async def get_discovery_matches(profile_id: int, db: Session = Depends(get_db)):
    """Get pending matches for a discovery profile."""
    matches = db.query(DiscoveredVideo).filter(
        DiscoveredVideo.profile_id == profile_id,
        DiscoveredVideo.imported == False
    ).order_by(DiscoveredVideo.discovered_at.desc()).limit(50).all()

    return {"matches": [
        {
            "id": m.id,
            "title": m.title,
            "url": m.url,
            "thumbnail": m.thumbnail,
            "duration": m.duration,
            "width": m.width,
            "height": m.height,
            "source": m.source,
            "discovered_at": m.discovered_at.isoformat()
        }
        for m in matches
    ]}


# ========== SESSION & PROGRESS TRACKING ==========
class VideoProgressUpdate(BaseModel):
    video_id: int
    current_time: float
    duration: float

@api_v1_router.post("/session/progress")
@api_legacy_router.post("/session/progress")
async def update_video_progress(progress: VideoProgressUpdate, db: Session = Depends(get_db)):
    """Update video playback progress."""
    video = db.query(Video).filter(Video.id == progress.video_id).first()

    if video:
        video.resume_time = progress.current_time
        db.commit()

    return {"success": True}

@api_v1_router.get("/session/state")
@api_legacy_router.get("/session/state")
async def get_session_state(db: Session = Depends(get_db)):
    """Get current session state for restoration."""
    # Get recent videos
    recent = db.query(Video).order_by(Video.created_at.desc()).limit(10).all()

    return {
        "recent_videos": [v.id for v in recent],
        "timestamp": datetime.datetime.now().isoformat()
    }


# ========== BATCH OPERATIONS ==========
@api_v1_router.post("/batch/execute")
@api_legacy_router.post("/batch/execute")
async def execute_batch_action(request: BatchActionRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Execute batch actions on multiple videos."""
    results = {"success": 0, "failed": 0, "errors": []}

    for video_id in request.video_ids:
        try:
            video = db.query(Video).filter(Video.id == video_id).first()
            if not video:
                results["failed"] += 1
                results["errors"].append(f"Video {video_id} not found")
                continue

            if request.action == 'favorite':
                video.is_favorite = not video.is_favorite
            elif request.action == 'delete':
                db.delete(video)
            elif request.action == 'download':
                # TODO: Trigger download
                pass
            elif request.action == 'refresh':
                # TODO: Refresh link
                pass

            results["success"] += 1
        except Exception as e:
            results["failed"] += 1
            results["errors"].append(str(e))

    db.commit()

    return results


@api_v1_router.get("/meta-preview")
async def meta_preview_url(url: str = "", auth: bool = Depends(check_auth)):
    """Fast metadata preview for a URL before import — fetches title, thumbnail, duration, quality."""
    url = url.strip()
    if not url or not url.startswith(("http://", "https://")):
        return {"ok": False, "message": "invalid_url"}
    try:
        from app.extractors.registry import ExtractorRegistry
        from app.extractors import init_registry, register_extended_extractors
        from app.extractors.filester import is_fileditch_url
        init_registry()
        register_extended_extractors()
        plugin = ExtractorRegistry.find_extractor(url)
        if not plugin:
            return {"ok": False, "message": "no_extractor", "url": url}
        from app.ntc.bunkr_scheduler import fetch_priority
        priority_token = fetch_priority.set("high")
        try:
            result = await plugin.extract(url)
        finally:
            fetch_priority.reset(priority_token)
        if not result:
            return {"ok": False, "message": "extract_failed", "url": url}
        height = int(result.get("height") or 0)
        quality = (
            "4K" if height >= 2160
            else f"{height}p" if height >= 480
            else ("HD" if height > 0 else "")
        )
        video_count = int(result.get("video_count") or result.get("item_count") or 1)
        raw_title = result.get("title") or ""
        if video_count > 1 and f"({video_count}" not in raw_title:
            preview_title = f"{raw_title} ({video_count} videí)"
        else:
            preview_title = raw_title
        return {
            "ok": True,
            "title": preview_title,
            "thumbnail": result.get("thumbnail") or "",
            "duration": float(result.get("duration") or 0),
            "quality": quality,
            "height": height,
            "uploader": result.get("uploader") or "",
            "is_hls": bool(result.get("is_hls")),
            "stream_url": result.get("stream_url") or "",
            "video_count": video_count,
            # FileDitch is resolved by the shared Filester extractor, but it is
            # a distinct host. Do not surface the extractor implementation name
            # as the user-facing source label.
            "source_type": (
                "fileditch"
                if is_fileditch_url(url)
                else (plugin.name or "").lower().replace(" ", "_")
            ),
            "url": url,
        }
    except Exception as exc:
        logging.error("meta_preview_url failed for %s: %s", url, exc)
        return {"ok": False, "message": str(exc)[:120], "url": url}


app.include_router(api_v1_router)
app.include_router(api_legacy_router)


# Direct aliases for late-added related endpoints. This avoids router/reload edge cases
# where the UI sees the path in source code but the running app misses the mounted copy.
@app.get("/api/v1/discovery/video/{video_id}/related")
async def app_get_discovered_video_related_v1(
    video_id: int,
    limit: int = Query(48, ge=1, le=300),
    sources: Optional[str] = Query(None),
    refresh: bool = Query(False),
    min_score: float = Query(5.0, ge=0.0, le=100.0),
    search_depth: int = Query(1, ge=1, le=4),
    db: Session = Depends(get_db),
):
    return await _routes_related.get_discovered_video_related(
        video_id=video_id,
        limit=limit,
        sources=sources,
        refresh=refresh,
        min_score=min_score,
        search_depth=search_depth,
        db=db,
    )


@app.get("/api/discovery/video/{video_id}/related")
async def app_get_discovered_video_related_legacy(
    video_id: int,
    limit: int = Query(48, ge=1, le=300),
    sources: Optional[str] = Query(None),
    refresh: bool = Query(False),
    min_score: float = Query(5.0, ge=0.0, le=100.0),
    search_depth: int = Query(1, ge=1, le=4),
    db: Session = Depends(get_db),
):
    return await _routes_related.get_discovered_video_related(
        video_id=video_id,
        limit=limit,
        sources=sources,
        refresh=refresh,
        min_score=min_score,
        search_depth=search_depth,
        db=db,
    )


@app.get("/api/v1/discovery/video/{video_id}/related/stream")
async def app_get_discovered_video_related_stream_v1(
    video_id: int,
    limit: int = Query(48, ge=1, le=300),
    sources: Optional[str] = Query(None),
    refresh: bool = Query(False),
    min_score: float = Query(5.0, ge=0.0, le=100.0),
    search_depth: int = Query(1, ge=1, le=4),
    db: Session = Depends(get_db),
):
    return await _routes_related.get_discovered_video_related_stream(
        video_id=video_id, limit=limit, sources=sources, refresh=refresh,
        min_score=min_score, search_depth=search_depth, db=db,
    )


@app.get("/api/discovery/video/{video_id}/related/stream")
async def app_get_discovered_video_related_stream_legacy(
    video_id: int,
    limit: int = Query(48, ge=1, le=300),
    sources: Optional[str] = Query(None),
    refresh: bool = Query(False),
    min_score: float = Query(5.0, ge=0.0, le=100.0),
    search_depth: int = Query(1, ge=1, le=4),
    db: Session = Depends(get_db),
):
    return await _routes_related.get_discovered_video_related_stream(
        video_id=video_id, limit=limit, sources=sources, refresh=refresh,
        min_score=min_score, search_depth=search_depth, db=db,
    )


@app.get("/api/v1/videos/{video_id}/related")
async def app_get_library_video_related_v1(
    video_id: int,
    limit: int = Query(48, ge=1, le=300),
    sources: Optional[str] = Query(None),
    refresh: bool = Query(False),
    min_score: float = Query(5.0, ge=0.0, le=100.0),
    search_depth: int = Query(1, ge=1, le=4),
    db: Session = Depends(get_db),
):
    return await _routes_related.get_library_video_related(
        video_id=video_id,
        limit=limit,
        sources=sources,
        refresh=refresh,
        min_score=min_score,
        search_depth=search_depth,
        db=db,
    )


@app.get("/api/videos/{video_id}/related")
async def app_get_library_video_related_legacy(
    video_id: int,
    limit: int = Query(48, ge=1, le=300),
    sources: Optional[str] = Query(None),
    refresh: bool = Query(False),
    min_score: float = Query(5.0, ge=0.0, le=100.0),
    search_depth: int = Query(1, ge=1, le=4),
    db: Session = Depends(get_db),
):
    return await _routes_related.get_library_video_related(
        video_id=video_id,
        limit=limit,
        sources=sources,
        refresh=refresh,
        min_score=min_score,
        search_depth=search_depth,
        db=db,
    )


@app.get("/api/v1/videos/{video_id}/related/stream")
async def app_get_library_video_related_stream_v1(
    video_id: int,
    limit: int = Query(48, ge=1, le=300),
    sources: Optional[str] = Query(None),
    refresh: bool = Query(False),
    min_score: float = Query(5.0, ge=0.0, le=100.0),
    search_depth: int = Query(1, ge=1, le=4),
    db: Session = Depends(get_db),
):
    return await _routes_related.get_library_video_related_stream(
        video_id=video_id, limit=limit, sources=sources, refresh=refresh,
        min_score=min_score, search_depth=search_depth, db=db,
    )


@app.get("/api/videos/{video_id}/related/stream")
async def app_get_library_video_related_stream_legacy(
    video_id: int,
    limit: int = Query(48, ge=1, le=300),
    sources: Optional[str] = Query(None),
    refresh: bool = Query(False),
    min_score: float = Query(5.0, ge=0.0, le=100.0),
    search_depth: int = Query(1, ge=1, le=4),
    db: Session = Depends(get_db),
):
    return await _routes_related.get_library_video_related_stream(
        video_id=video_id, limit=limit, sources=sources, refresh=refresh,
        min_score=min_score, search_depth=search_depth, db=db,
    )


@app.post("/api/v1/videos/{video_id}/reverse-image-search")
async def app_reverse_image_search_v1(video_id: int, payload: Optional[ReverseImageSearchRequest] = Body(default=None), db: Session = Depends(get_db)):
    return await reverse_image_search_video(video_id=video_id, payload=payload, db=db)


@app.post("/api/videos/{video_id}/reverse-image-search")
async def app_reverse_image_search_legacy(video_id: int, payload: Optional[ReverseImageSearchRequest] = Body(default=None), db: Session = Depends(get_db)):
    return await reverse_image_search_video(video_id=video_id, payload=payload, db=db)


@app.post("/api/v1/videos/{video_id}/auto-tag")
async def app_auto_tag_video_v1(video_id: int, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    return await auto_tag_video(video_id=video_id, db=db, auth=auth)


@app.post("/api/videos/{video_id}/auto-tag")
async def app_auto_tag_video_legacy(video_id: int, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    return await auto_tag_video(video_id=video_id, db=db, auth=auth)


@app.websocket("/ws/status")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=25.0)
                await manager.handle_client_message(websocket, raw)
            except asyncio.TimeoutError:
                await websocket.send_text(json.dumps({
                    "type": "pulse",
                    "timestamp": time.time(),
                }))
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)


@app.get("/embed_proxy")
async def embed_proxy(url: str, request: Request, referer: Optional[str] = None, session: Optional[str] = None):
    """
    HTML Embed Proxy — proxies embed pages (like bysezoxexe.com/e/...) and rewrites all
    relative paths to absolute paths. Injects custom scripts to bypass Adblock detection
    and disable popups/popunders globally inside the iframe.
    """
    url = url.strip()
    url = _require_public_proxy_url(url)

    # Get base domain
    from urllib.parse import urlparse
    parsed = urlparse(url)
    base_domain = f"{parsed.scheme}://{parsed.netloc}"

    session_id = (session or "").strip()
    session_entry = _get_embed_proxy_session_entry(session_id)

    effective_referer = (referer or "").strip() or url or base_domain

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": effective_referer,
    }

    try:
        html = ""
        if session_entry and session_entry.get("html"):
            html = session_entry["html"]
        else:
            import httpx
            async with httpx.AsyncClient(timeout=15, follow_redirects=True, verify=False) as client:
                resp = await client.get(
                    url,
                    headers=headers,
                    cookies=(session_entry.get("cookies") if session_entry else None),
                )
                if resp.status_code != 200:
                    raise HTTPException(resp.status_code, f"Failed to fetch embed: {resp.status_code}")
                html = resp.text
                if not session_id:
                    session_id = uuid.uuid4().hex
                _embed_proxy_sessions[session_id] = {
                    "cookies": dict(client.cookies),
                    "referer": effective_referer,
                    "base_domain": base_domain,
                    "html": html,
                    "ts": time.time(),
                }
        if session_id and not session:
            redirect_params = dict(request.query_params)
            redirect_params["session"] = session_id
            if request.url.path == "/embed_proxy":
                redirect_params["url"] = url
                redirect_params["referer"] = referer or ""
            redirect_url = f"{request.url.path}?{urllib.parse.urlencode(redirect_params)}"
            return RedirectResponse(url=redirect_url, status_code=307)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Error fetching embed: {e}")

    import re

    # Rewrite all absolute-relative paths (starting with /) to go through our hls_proxy,
    # completely bypassing browser cross-origin (CORS) blocks on JS modules and CSS stylesheets!
    encoded_ref = urllib.parse.quote(effective_referer, safe="")

    def rewrite_src(m):
        rel_path = m.group(1)  # starts with /
        abs_url = f"{base_domain}{rel_path}"
        encoded = urllib.parse.quote(abs_url, safe="")
        return f'src="/hls_proxy?url={encoded}&referer={encoded_ref}&session={session_id}"'

    def rewrite_href(m):
        rel_path = m.group(1)  # starts with /
        abs_url = f"{base_domain}{rel_path}"
        encoded = urllib.parse.quote(abs_url, safe="")
        return f'href="/hls_proxy?url={encoded}&referer={encoded_ref}&session={session_id}"'

    html = re.sub(r'src="(/[^"]+)"', rewrite_src, html)
    html = re.sub(r'href="(/[^"]+)"', rewrite_href, html)

    # Bypass Adblock checks and block popups natively
    bypass_script = """
<script>
    (function() {
        var stub = {
            onDetected: function(cb) { return this; },
            onNotDetected: function(cb) { if(cb) { try { cb(); } catch(e){} } return this; },
            check: function() { return false; },
            setOption: function() { return this; },
            clearEvent: function() { return this; }
        };
        window.fuckAdBlock = stub;
        window.FuckAdBlock = stub;
        window.sniffAdBlock = stub;
        window.SniffAdBlock = stub;
        window.adsbygoogle = { push: function() {} };
        
        // Disable window.open to block popunder ads entirely inside our dashboard
        var originalOpen = window.open;
        window.open = function(url, name, specs) {
            console.log('Blocked popunder opening:', url);
            return {
                focus: function() {},
                close: function() {},
                closed: false
            };
        };
    })();
</script>
    """

    if "<head>" in html:
        html = html.replace("<head>", f"<head>{bypass_script}", 1)
    elif "<html>" in html:
        html = html.replace("<html>", f"<html>{bypass_script}", 1)
    else:
        html = bypass_script + html

    return Response(content=html, media_type="text/html", headers={
        "Access-Control-Allow-Origin": "*",
        "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-presentation allow-same-origin;",
        "Cache-Control": "private, no-store, no-cache, must-revalidate",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Content-Type-Options": "nosniff",
    })


@app.get("/e/{embed_code}")
async def embed_proxy_byse_alias(
    embed_code: str,
    request: Request,
    upstream: str = "",
    referer: str = "",
    session: Optional[str] = None,
):
    """
    Local alias for Byse-style `/e/<code>` embed routes.
    Keeping the path shape intact allows the remote SPA router to render the
    player page instead of staying blank on `/embed_proxy?...`.
    """
    upstream_url = (upstream or "").strip()
    if not upstream_url:
        upstream_url = f"https://bysezoxexe.com/e/{embed_code}"
    return await embed_proxy(url=upstream_url, request=request, referer=referer, session=session)


@app.get("/assets/{path:path}")
async def proxy_iframe_assets(path: str, request: Request):
    """
    Catch-all proxy for absolute-relative assets (/assets/...) loaded inside
    the iframe. Dynamically resolves the source base domain from the Referer
    header to bypass CORS restrictions!
    """
    referer = request.headers.get("Referer", "")
    session_id = _extract_embed_proxy_session(request)
    target_domain, target_referer = _resolve_proxy_target_from_referer(referer)
    asset_url = f"{target_domain}/assets/{path}"
    logging.info(f"[proxy_iframe_assets] Routing asset via hls_proxy: {asset_url}")
    return await hls_proxy(url=asset_url, request=request, referer=target_referer or referer, session=session_id)


@app.get("/api/dashboard")
async def proxy_iframe_api_dashboard(request: Request):
    """
    Proxy `/api/dashboard` requests loaded inside the iframe to the dynamic target domain.
    """
    referer = request.headers.get("Referer", "")
    session_id = _extract_embed_proxy_session(request)
    target_domain, target_referer = _resolve_proxy_target_from_referer(referer)
    api_url = f"{target_domain}/api/dashboard"
    logging.info(f"[proxy_iframe_api_dashboard] Routing API via hls_proxy: {api_url}")
    return await hls_proxy(url=api_url, request=request, referer=target_referer or referer, session=session_id)


@app.get("/{chunk_name}.js")
async def proxy_iframe_root_js_chunk(chunk_name: str, request: Request):
    """
    Proxy root-level Vite chunk requests (e.g. `/videoPagesBundle-xxx.js`) that
    some embed pages request without the `/assets/` prefix.
    """
    referer = request.headers.get("Referer", "")
    session_id = _extract_embed_proxy_session(request)
    target_domain, target_referer = _resolve_proxy_target_from_referer(referer)
    asset_url = f"{target_domain}/assets/{chunk_name}.js"
    if request.url.query:
        asset_url = f"{asset_url}?{request.url.query}"
    logging.info(f"[proxy_iframe_root_js_chunk] Routing root JS chunk via hls_proxy: {asset_url}")
    return await hls_proxy(url=asset_url, request=request, referer=target_referer or referer, session=session_id)


@app.get("/{chunk_name}.css")
async def proxy_iframe_root_css_chunk(chunk_name: str, request: Request):
    """
    Proxy root-level CSS chunk requests without `/assets/` prefix.
    """
    referer = request.headers.get("Referer", "")
    session_id = _extract_embed_proxy_session(request)
    target_domain, target_referer = _resolve_proxy_target_from_referer(referer)
    asset_url = f"{target_domain}/assets/{chunk_name}.css"
    if request.url.query:
        asset_url = f"{asset_url}?{request.url.query}"
    logging.info(f"[proxy_iframe_root_css_chunk] Routing root CSS chunk via hls_proxy: {asset_url}")
    return await hls_proxy(url=asset_url, request=request, referer=target_referer or referer, session=session_id)


@app.api_route("/api/videos/{subpath:path}", methods=["GET", "POST", "HEAD", "OPTIONS"])
async def proxy_iframe_api_videos(subpath: str, request: Request):
    """
    Proxy player-internal `/api/videos/...` requests loaded inside the iframe
    to the dynamically resolved upstream embed domain.
    """
    referer = request.headers.get("Referer", "")
    session_id = _extract_embed_proxy_session(request)
    target_domain, target_referer = _resolve_proxy_target_from_referer(referer)
    api_url = f"{target_domain}/api/videos/{subpath}"
    if request.url.query:
        api_url = f"{api_url}?{request.url.query}"
    logging.info(f"[proxy_iframe_api_videos] Routing API via hls_proxy: {api_url}")
    return await hls_proxy(url=api_url, request=request, referer=target_referer or referer, session=session_id)


@app.exception_handler(404)
async def custom_404_handler(request: Request, exc: Exception):
    """
    Catch-all exception handler for unmatched routes (404s).
    If the request originated from an embed_proxy iframe, we dynamically proxy the
    request to its corresponding source base domain to bypass CORS/404 blocks cleanly!
    """
    referer = request.headers.get("Referer", "")
    session_id = _extract_embed_proxy_session(request)
    target_domain, target_referer = _resolve_proxy_target_from_referer(referer)
    target_url = _resolve_proxy_target_url_from_referer(referer)
    if target_referer:
        try:
            path_and_query = request.url.path
            if request.url.query:
                path_and_query += f"?{request.url.query}"

            upstream_url = f"{target_domain}{path_and_query}"
            if target_url and referer.startswith((
                "http://localhost:8000/hls_proxy",
                "http://127.0.0.1:8000/hls_proxy",
            )):
                parsed_target_url = urllib.parse.urlparse(target_url)
                target_dir = target_url.rsplit("/", 1)[0] + "/"
                if request.url.path.startswith("/") and request.url.path.count("/") == 1 and "." in request.url.path:
                    upstream_url = urllib.parse.urljoin(target_dir, request.url.path.lstrip("/"))
                elif request.url.path.startswith("/assets/"):
                    upstream_url = urllib.parse.urljoin(
                        f"{parsed_target_url.scheme}://{parsed_target_url.netloc}/",
                        request.url.path.lstrip("/"),
                    )

            logging.info(f"[custom_404_handler] Dynamically proxying 404 fallback request: {request.url.path} -> {upstream_url}")
            return await hls_proxy(url=upstream_url, request=request, referer=target_referer, session=session_id)
        except Exception as e:
            logging.error(f"[custom_404_handler] Error routing fallback request: {e}")

    # Standard fallback if not originated from embed_proxy iframe
    if request.url.path.startswith("/api/"):
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    return HTMLResponse(content="<h1>404 Not Found</h1>", status_code=404)


if __name__ == "__main__":
    import uvicorn
    # Keep direct starts consistent with the project .env configuration.
    # In particular, reload is opt-in: watching the whole workspace can restart
    # the server while imports or generated files are being written.
    uvicorn.run(
        app,
        host=config.SERVER_HOST,
        port=config.SERVER_PORT,
        reload=config.SERVER_RELOAD,
    )
