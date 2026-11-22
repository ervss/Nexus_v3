"""
Extension Bridge Router
=======================
Endpointy pre komunikáciu Chrome extension ↔ backend:
  - GET  /bridge/ping
  - POST /bridge/sync
  - POST /bridge/import
  - POST /api/v1/pornhoarder/update_stream   (alias)
  - POST /api/v1/videos/update_stream

Tento router sa registruje v app/main.py cez include_router.
URL prefix /api/v1 a /api/legacy/v1 sú pridané v main.py rovnako ako pri ostatných routeroch.
update_stream je zámerne registrovaný priamo na app (nie cez api_v1_router), pretože používa
absolútnu cestu /api/v1/... – rovnaký prístup zostal zachovaný aj v tomto routeri:
router má prefix="" a plné URL cesty sú definované tu.
"""

import asyncio
import datetime
import logging
import os
import re
import threading
import urllib.parse
from typing import Any, List, Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import config
from ..database import SessionLocal, Video, get_db

# Lazy-loaded on first use so Lite server startup avoids importing heavy services.
VIPVideoProcessor = None

# ---------------------------------------------------------------------------
# Router – bez prefixu, pretože update_stream má absolútne cesty
# ---------------------------------------------------------------------------
router = APIRouter(tags=["Extension Bridge"])

# ---------------------------------------------------------------------------
# Shared helper – používa sa aj z main.py (importovaná naspäť)
# ---------------------------------------------------------------------------

def ensure_bridge_token(x_nexus_token: Optional[str]) -> None:
    """If NEXUS_BRIDGE_TOKEN is configured, require matching X-Nexus-Token header."""
    required_token = config.NEXUS_BRIDGE_TOKEN
    if not required_token:
        return
    if not x_nexus_token or x_nexus_token.strip() != required_token:
        raise HTTPException(status_code=401, detail="Invalid bridge token")


# ---------------------------------------------------------------------------
# Pydantic modely
# ---------------------------------------------------------------------------

class BridgeSyncRequest(BaseModel):
    url: str
    cookies: Optional[str] = None
    user_agent: Optional[str] = None
    html_content: Optional[str] = None


class BridgeImportRequest(BaseModel):
    urls: List[str]
    batch_name: str = "Bridge Import"
    cookies: Optional[str] = None  # Optional overriding cookies


class FilesterResolveRequest(BaseModel):
    url: str


# ---------------------------------------------------------------------------
# Hunter session models & in-memory store
# ---------------------------------------------------------------------------

class HunterLink(BaseModel):
    url: str
    host: str = ""
    text: str = ""
    context: str = ""
    quality: str = ""
    postAuthor: str = ""
    postId: str = ""
    timestamp: str = ""
    threadId: str = ""
    threadTitle: str = ""
    threadUrl: str = ""
    threadForum: str = ""
    threadTags: List[str] = Field(default_factory=list)
    threadLabels: List[str] = Field(default_factory=list)
    postUrl: str = ""
    thumbnail: str = ""
    occurrences: List[dict] = Field(default_factory=list)
    # Server-enriched fields
    file_size_mb: float = 0
    duration: int = 0
    stream_url: str = ""
    # Local collector provenance is handed through unchanged so Tester can make
    # an older discovery visible instead of presenting it as a fresh result.
    collector_seen_before: bool = False
    collector_first_seen_at: str = ""
    collector_previous_seen_at: str = ""
    collector_seen_count: int = 0


class HunterPushRequest(BaseModel):
    thread_title: str = ""
    thread_url: str = ""
    threads: List[dict] = Field(default_factory=list)
    links: List[HunterLink] = []


# Legacy "latest" session is kept for the existing Thread Hunter extension.
# New clients use a concrete session id so a second scan cannot silently replace
# the batch already open in Link Tester.
_hunter_session: dict = {
    "links": [],
    "thread_title": "",
    "thread_url": "",
    "timestamp": None,
    "count": 0,
    "enriching": False,
}
_hunter_sessions: dict[str, dict] = {}
_HUNTER_SESSION_LIMIT = 24


def _public_hunter_session(session: dict) -> dict:
    """Return only browser-facing fields from a stored Hunter session."""
    return {key: value for key, value in session.items() if not key.startswith("_")}


def _remember_hunter_session(session_id: str, session: dict) -> None:
    """Keep a compact recent-session cache for the Tester handoff."""
    _hunter_sessions[session_id] = session
    if len(_hunter_sessions) <= _HUNTER_SESSION_LIMIT:
        return
    oldest_ids = sorted(
        _hunter_sessions,
        key=lambda key: str(_hunter_sessions[key].get("timestamp") or ""),
    )[:-_HUNTER_SESSION_LIMIT]
    for old_id in oldest_ids:
        _hunter_sessions.pop(old_id, None)

# ---------------------------------------------------------------------------
# Turbo enrichment helpers
# ---------------------------------------------------------------------------

_QUALITY_RE = re.compile(r'(2160p?|4k|1080p?|720p?|480p?|360p?)', re.I)


def _quality_from_text(text: str) -> str:
    m = _QUALITY_RE.search(text or "")
    if not m:
        return ""
    raw = m.group(1).lower().rstrip("p")
    mapping = {"4k": "4K", "2160": "4K", "1080": "1080P", "720": "720P", "480": "480P", "360": "360P"}
    return mapping.get(raw, raw.upper() + "P")


async def _enrich_turbo_links(links: list, session_id: str) -> None:
    """Background: enrich turbo.cr links with file_size_mb, duration, quality via TurboExtractor."""
    global _hunter_session
    from ..extractors.turbo import TurboExtractor
    extractor = TurboExtractor()
    semaphore = asyncio.Semaphore(3)

    async def _enrich_one(link: dict) -> dict:
        async with semaphore:
            return await _enrich_one_limited(link)

    async def _enrich_one_limited(link: dict) -> dict:
        try:
            result = await asyncio.wait_for(extractor.extract(link["url"]), timeout=15)
            if not result:
                return link

            stream = result.get("stream_url", "")
            if stream:
                link["stream_url"] = stream

            if result.get("duration"):
                link["duration"] = int(result["duration"])

            if result.get("title") and result["title"] not in ("Turbo video", ""):
                link["text"] = link["text"] or result["title"]

            # Quality: try stream URL first, then title
            if not link.get("quality") or link["quality"].lower().startswith("unknown"):
                link["quality"] = (
                    _quality_from_text(stream)
                    or _quality_from_text(result.get("title", ""))
                    or ""
                )

            # File size via HEAD on stream URL
            if stream and not link.get("file_size_mb"):
                try:
                    async with httpx.AsyncClient(timeout=8, follow_redirects=True) as cl:
                        head = await cl.head(stream, headers={"User-Agent": "Mozilla/5.0"})
                        size = int(head.headers.get("Content-Length", 0))
                        if size >= 5 * 1024 * 1024:
                            link["file_size_mb"] = round(size / (1024 * 1024), 1)
                except Exception:
                    pass
        except Exception as e:
            logging.warning(f"[Hunter] Turbo enrich failed for {link.get('url')}: {e}")
        return link

    turbo_links = [(i, l) for i, l in enumerate(links) if l.get("host") == "turbo"]
    if not turbo_links:
        return

    results = await asyncio.gather(*[_enrich_one(l) for _, l in turbo_links], return_exceptions=True)

    session = _hunter_sessions.get(session_id)
    if not session:
        return

    for (idx, _), enriched in zip(turbo_links, results):
        if isinstance(enriched, dict):
            links[idx] = enriched

    session["links"] = links
    session["enriching"] = False
    if _hunter_session.get("_session_id") == session_id:
        _hunter_session["links"] = links
        _hunter_session["enriching"] = False
    logging.info(f"[Hunter] Turbo enrichment done for session {session_id}")


# ---------------------------------------------------------------------------
# Bridge ping / sync / import
# ---------------------------------------------------------------------------

@router.get("/api/v1/bridge/ping")
@router.get("/api/legacy/v1/bridge/ping")
async def bridge_ping(x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    ensure_bridge_token(x_nexus_token)
    return {"status": "ok", "service": "bridge"}


@router.post("/api/v1/bridge/filester/resolve")
@router.post("/api/legacy/v1/bridge/filester/resolve")
async def bridge_filester_resolve(
    req: FilesterResolveRequest,
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
):
    """Resolve a public Filester file page for the Gallery player.

    Gallery runs on a chrome-extension:// origin and therefore cannot use the
    dashboard's session-authenticated ``/meta-preview`` route.  This narrowly
    scoped bridge route uses the existing extension token instead and accepts
    only Filester ``/d/<slug>`` pages.
    """
    ensure_bridge_token(x_nexus_token)
    url = (req.url or "").strip()
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    if not (
        parsed.scheme in ("http", "https")
        and re.fullmatch(r"(?:[a-z0-9-]+\.)*filester\.(?:me|gg|net|co|org|io)", host)
        and re.match(r"^/d/[A-Za-z0-9_-]+/?$", parsed.path or "")
    ):
        raise HTTPException(status_code=400, detail="Only Filester /d/<slug> URLs are allowed")

    try:
        from ..extractors.filester import FilesterExtractor

        result = await FilesterExtractor().extract(url)
    except Exception as exc:
        logging.warning("[Filester bridge] resolve failed for %s: %s", url, exc)
        result = None

    stream_url = str((result or {}).get("stream_url") or "").strip()
    if not stream_url:
        return {"ok": False, "error": "Filester stream is not available", "source_url": url}

    height = int((result or {}).get("height") or 0)
    quality = "4K" if height >= 2160 else (f"{height}p" if height >= 240 else "")
    size_bytes = int(
        (result or {}).get("filesize")
        or (result or {}).get("size_bytes")
        or (result or {}).get("size")
        or 0
    )
    return {
        "ok": True,
        "source_url": url,
        "stream_url": stream_url,
        "title": (result or {}).get("title") or "",
        "thumbnail": (result or {}).get("thumbnail") or "",
        "duration": float((result or {}).get("duration") or 0),
        "height": height,
        "width": int((result or {}).get("width") or 0),
        "quality": quality,
        "size_bytes": size_bytes,
    }



# ---------------------------------------------------------------------------
# Hunter endpoints
# ---------------------------------------------------------------------------

def _thread_id_from_url(url: str) -> str:
    match = re.search(r"/threads/[^/]*\.(\d+)(?:/|$)", str(url or ""), re.I)
    return match.group(1) if match else ""


def _normalize_hunter_threads(req: HunterPushRequest, links: list[dict]) -> list[dict]:
    """Merge explicit thread metadata with thread origins found on links."""
    is_single_thread_url = "/threads/" in str(req.thread_url or "").lower()
    fallback_tid = _thread_id_from_url(req.thread_url) if is_single_thread_url else ""
    fallback_title = req.thread_title if is_single_thread_url else ""
    fallback_url = req.thread_url if is_single_thread_url else ""

    threads_by_key: dict[str, dict] = {}
    alias_to_key: dict[str, str] = {}

    def _register_thread(
        tid: str = "",
        title: str = "",
        url: str = "",
        forum: str = "",
        labels: Optional[list] = None,
        tags: Optional[list] = None,
        replies: int = 0,
    ) -> Optional[str]:
        tid_clean = str(tid or _thread_id_from_url(url) or "").strip()
        url_clean = str(url or "").strip()
        title_clean = str(title or "").strip()
        if not (tid_clean or url_clean or title_clean):
            return None
        aliases = [
            f"id:{tid_clean}" if tid_clean else "",
            f"url:{url_clean.rstrip('/').lower()}" if url_clean else "",
            f"title:{title_clean.lower()}" if title_clean else "",
        ]
        existing_key = next((alias_to_key[a] for a in aliases if a and a in alias_to_key), None)
        key = existing_key or next((a for a in aliases if a), "")
        entry = threads_by_key.setdefault(key, {
            "id": tid_clean,
            "title": title_clean or (f"Thread {tid_clean}" if tid_clean else url_clean),
            "url": url_clean,
            "forum": forum or "",
            "labels": list(labels or []),
            "tags": list(tags or []),
            "replies": int(replies or 0),
            "linkCount": 0,
        })
        if tid_clean and not entry["id"]:
            entry["id"] = tid_clean
        if title_clean and (not entry["title"] or entry["title"].startswith("Thread ")):
            entry["title"] = title_clean
        if url_clean and not entry["url"]:
            entry["url"] = url_clean
        if forum and not entry["forum"]:
            entry["forum"] = forum
        if labels and not entry["labels"]:
            entry["labels"] = list(labels)
        if tags and not entry["tags"]:
            entry["tags"] = list(tags)
        if replies and not entry["replies"]:
            entry["replies"] = int(replies)
        for a in aliases:
            if a:
                alias_to_key[a] = key
        return key

    for raw in req.threads:
        if not isinstance(raw, dict):
            continue
        _register_thread(
            tid=str(raw.get("id") or raw.get("threadId") or ""),
            title=str(raw.get("title") or raw.get("threadTitle") or ""),
            url=str(raw.get("url") or raw.get("threadUrl") or ""),
            forum=str(raw.get("forum") or raw.get("threadForum") or ""),
            labels=raw.get("labels") or raw.get("threadLabels") or [],
            tags=raw.get("tags") or raw.get("threadTags") or [],
            replies=int(raw.get("replies") or 0),
        )

    for link in links:
        occs = link.get("occurrences") if isinstance(link.get("occurrences"), list) else []
        first_occ = occs[0] if occs and isinstance(occs[0], dict) else {}
        if not link.get("threadTitle"):
            link["threadTitle"] = first_occ.get("threadTitle") or fallback_title
        if not link.get("threadUrl"):
            link["threadUrl"] = first_occ.get("threadUrl") or fallback_url
        if not link.get("threadId"):
            link["threadId"] = str(first_occ.get("threadId") or _thread_id_from_url(link.get("threadUrl", "")) or fallback_tid)
        if not link.get("postId") and first_occ.get("postId"):
            link["postId"] = str(first_occ.get("postId"))
        if not link.get("postUrl") and first_occ.get("postUrl"):
            link["postUrl"] = str(first_occ.get("postUrl"))

        counted: set[str] = set()
        link_origins = occs if occs else [{
            "threadId": link.get("threadId", ""),
            "threadTitle": link.get("threadTitle", ""),
            "threadUrl": link.get("threadUrl", ""),
            "threadForum": link.get("threadForum", ""),
            "threadLabels": link.get("threadLabels", []),
        }]
        for occ in link_origins:
            if not isinstance(occ, dict):
                continue
            key = _register_thread(
                tid=str(occ.get("threadId") or link.get("threadId") or ""),
                title=str(occ.get("threadTitle") or link.get("threadTitle") or ""),
                url=str(occ.get("threadUrl") or link.get("threadUrl") or ""),
                forum=str(occ.get("threadForum") or link.get("threadForum") or ""),
                labels=occ.get("threadLabels") or link.get("threadLabels") or [],
                tags=link.get("threadTags") or [],
            )
            if key and key not in counted:
                counted.add(key)
                threads_by_key[key]["linkCount"] += 1

    return list(threads_by_key.values())


@router.post("/api/v1/hunter/push")
async def hunter_push(req: HunterPushRequest, bg: BackgroundTasks):
    """Receive a scraped thread session from the Chrome extension."""
    import uuid
    global _hunter_session
    links = [lnk.model_dump() if hasattr(lnk, "model_dump") else lnk.dict() for lnk in req.links]
    threads = _normalize_hunter_threads(req, links)
    has_turbo = any(l.get("host") == "turbo" for l in links)
    session_id = str(uuid.uuid4())
    stored_session = {
        "links": links,
        "threads": threads,
        "thread_title": req.thread_title,
        "thread_url": req.thread_url,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(links),
        "enriching": has_turbo,
        "_session_id": session_id,
    }
    _hunter_session = stored_session
    _remember_hunter_session(session_id, stored_session)
    logging.info(f"[Hunter] Session stored: {len(links)} links across {len(threads)} threads from '{req.thread_title}' (turbo_enrich={has_turbo})")
    if has_turbo:
        bg.add_task(_enrich_turbo_links, links, session_id)
    return {
        "status": "ok",
        "session_id": session_id,
        "count": len(links),
        "thread_count": len(threads),
        "enriching": has_turbo,
    }


@router.get("/api/v1/hunter/latest")
async def hunter_latest():
    """Return the most recent hunter session for the tester to display."""
    return _public_hunter_session(_hunter_session)


@router.get("/api/v1/hunter/session/{session_id}")
async def hunter_session(session_id: str):
    """Return one exact captured thread batch for a Tester handoff."""
    session = _hunter_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Hunter session nenájdená alebo už vypršala.")
    return _public_hunter_session(session)


@router.get("/api/v1/hunter/status")
async def hunter_status():
    """Check if turbo enrichment is still running."""
    return {"enriching": _hunter_session.get("enriching", False), "count": _hunter_session.get("count", 0)}


@router.get("/api/v1/hunter/session/{session_id}/status")
async def hunter_session_status(session_id: str):
    session = _hunter_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Hunter session nenájdená alebo už vypršala.")
    return {"enriching": session.get("enriching", False), "count": session.get("count", 0)}


@router.post("/api/v1/bridge/sync")
@router.post("/api/legacy/v1/bridge/sync")
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
        filename = "cookies.txt"  # Default
        if "bunkr" in domain:
            filename = "bunkr.cookies.txt"
        elif "xvideos" in domain:
            filename = "xvideos.cookies.txt"
        elif "xnxx" in domain:
            filename = "xnxx.cookies.txt"
        elif "simpcity" in domain:
            filename = "simpcity.cookies.txt"
        elif "faphouse" in domain:
            filename = "faphouse.cookies.txt"

        # Save cookies in Netscape format (simplified) or raw header format
        # yt-dlp prefers Netscape, but raw header file also works if passed as --add-header
        # We will save as raw key=value string for requests lib and maybe convert for yt-dlp later
        # Actually, for this prototype, we just save the 'Cookie' header string to a file
        # that our Extractors can read and inject into requests headers.

        with open(filename, "w") as f:
            f.write(req.cookies)

        # --- CONVERT TO NETSCAPE FOR YT-DLP ---
        try:
            netscape_name = (
                filename.replace(".cookies.txt", ".netscape.txt")
                if ".cookies.txt" in filename
                else "cookies.netscape.txt"
            )
            with open(netscape_name, "w") as f:
                f.write("# Netscape HTTP Cookie File\n")
                # Domain should start with . for wildcards
                dot_domain = f".{domain}" if not domain.startswith(".") else domain
                # Format: domain, flag, path, secure, expiration, name, value
                # Since we have raw string "a=b; c=d", we split and guess
                pairs = [p.strip() for p in req.cookies.split(";") if "=" in p]
                expiry = str(int(datetime.datetime.now().timestamp()) + 86400 * 30)  # +30 days
                for p in pairs:
                    name, val = p.split("=", 1)
                    f.write(f"{dot_domain}\tTRUE\t/\tTRUE\t{expiry}\t{name}\t{val}\n")
            logging.info(f"Bridge: Converted to Netscape: {netscape_name}")
        except Exception as e:
            logging.error(f"Cookie conversion failed: {e}")

        logging.info(f"Bridge: Saved cookies for {domain} to {filename}")

    return {"status": "synced", "domain": domain}


@router.post("/api/v1/bridge/import")
@router.post("/api/legacy/v1/bridge/import")
async def bridge_import(
    req: BridgeImportRequest,
    bg_tasks: BackgroundTasks,
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
):
    """
    Import URLs specifically from the extension, possibly with fresh cookies.
    """
    ensure_bridge_token(x_nexus_token)
    if req.cookies:
        # If import request comes with cookies (e.g. from Bunkr album page)
        # Save them generically as 'latest_bridge.cookies.txt'
        with open("bridge.cookies.txt", "w") as f:
            f.write(req.cookies)

    # background_import_process žije v main.py – importujeme lazy, aby sme sa vyhli
    # kruhovému importu (main importuje router, router importuje main).
    # Lazy import funguje pretože v čase volania endpointu je main.py už načítaný.
    from app.main import background_import_process  # noqa: PLC0415

    bg_tasks.add_task(background_import_process, req.urls, req.batch_name, "yt-dlp", None, None, None, True)
    return {"status": "ok", "count": len(req.urls)}


# ---------------------------------------------------------------------------
# update_stream – hlavný vstupný bod pre zachytené streamy z extension
# ---------------------------------------------------------------------------

def _looks_like_stream(url: str) -> bool:
    u = (url or "").strip().lower()
    if not u.startswith(("http://", "https://")):
        return False
    return (
        bool(re.search(r"\.(mp4|m3u8|mpd)(\?|$)", u))
        or "/api/v1/proxy/hls?url=" in u
        or "/hls_proxy?url=" in u
    )


def _title_from_source_url(url: str) -> str:
    """Odvodí title z URL slash-segmentov (fallback pri chýbajúcom title)."""
    try:
        from urllib.parse import unquote, urlparse
        path = urlparse(url or "").path
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


def _queue_thumbnail_processing(video_id: int) -> None:
    """Spustí thumbnail processing v background threade."""
    try:
        proc_cls = VIPVideoProcessor
        if proc_cls is None:
            from ..services import VIPVideoProcessor as proc_cls
        processor = proc_cls()
        threading.Thread(
            target=lambda vid: asyncio.run(processor.process_single_video(vid)),
            args=(video_id,),
            daemon=True,
        ).start()
    except Exception as exc:
        logging.warning(f"[PH-Interceptor] Failed to queue thumbnail processing for {video_id}: {exc}")


@router.post("/api/v1/pornhoarder/update_stream")
@router.post("/api/v1/videos/update_stream")
async def pornhoarder_update_stream(
    payload: dict,
    db: Session = Depends(get_db),
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
):
    """Receives direct stream URL from PornHoarder browser interceptor content script."""
    ensure_bridge_token(x_nexus_token)
    source_url = (payload.get("source_url") or "").strip()
    stream_url = (payload.get("stream_url") or "").strip()
    source = (payload.get("source") or "pornhoarder").strip().lower()
    title = (payload.get("title") or "").strip()

    if not source_url:
        return {"status": "error", "message": "missing fields"}
    if not stream_url:
        stream_url = source_url

    resolved_stream = stream_url
    resolved_title = title
    resolved_thumbnail = ""
    resolved_duration = 0
    resolved_player_url = ""
    resolved_quality = "SD"

    # For browser-captured providers, try extractor once:
    # - resolves non-playable captures/player URLs to direct streams
    # - fills metadata for clean dashboard cards.
    is_known_source = source in (
        "pornhoarder", "recurbate", "leakporner", "djav", "vidara", "vidsonic",
        "vidfast", "lulustream", "luluvid", "luluvdo", "lulu.stream", "sxyprn", "krakenfiles", "vtbe",
    )
    is_vidara_stream = any(d in stream_url.lower() for d in ("vidara.so", "vidsonic.net", "vidfast.co"))
    is_lulu_stream = any(d in stream_url.lower() for d in ("lulustream", "luluvid", "luluvdo", "lulu.stream"))
    is_vtbe_stream = "vtbe.to" in stream_url.lower()

    if is_known_source or is_vidara_stream or is_lulu_stream or is_vtbe_stream:
        try:
            extractor = None
            if source == "pornhoarder":
                from ..extractors.pornhoarder import PornHoarderExtractor
                extractor = PornHoarderExtractor()
            elif source in ("leakporner", "djav"):
                from ..extractors.leakporner import LeakPornerExtractor
                extractor = LeakPornerExtractor()
            elif source in ("vidara", "vidsonic", "vidfast") or is_vidara_stream:
                from ..extractors.vidara import VidaraExtractor
                extractor = VidaraExtractor()
            elif source in ("lulustream", "luluvid", "luluvdo", "lulu.stream") or is_lulu_stream:
                from ..extractors.lulustream import LuluStreamExtractor
                extractor = LuluStreamExtractor()
            elif source == "vtbe" or is_vtbe_stream:
                from ..extractors.vtbe import VtbeExtractor
                extractor = VtbeExtractor()
            elif source == "krakenfiles" or "krakenfiles.com" in stream_url.lower():
                from ..extractors.krakenfiles import KrakenFilesExtractor
                extractor = KrakenFilesExtractor()
            elif source == "sxyprn" or "sxyprn.com" in stream_url.lower():
                from ..extractors.sxyprn import SxyPrnExtractor
                extractor = SxyPrnExtractor()
            elif source == "recurbate":
                from ..extractors.recurbate import RecurbateExtractor
                extractor = RecurbateExtractor()

            if extractor:
                # If title is generic or missing, we MUST extract to get real metadata
                is_generic_title = not resolved_title or any(
                    x in resolved_title.lower()
                    for x in (">external link!<", "krakenfiles.com", "vidara.so", "vidsonic", "vidfast")
                )

                # Use source_url if it's from the same domain, otherwise use stream_url
                target_url = (
                    source_url
                    if (source in extractor.name.lower() or extractor.can_handle(source_url))
                    else stream_url
                )

                # Special case for Vidara/Lulu embedded on other sites
                if not extractor.can_handle(target_url) and is_vidara_stream:
                    target_url = stream_url

                extracted = await extractor.extract(target_url)
                if extracted:
                    candidate = (extracted.get("stream_url") or "").strip()
                    if (
                        candidate
                        and _looks_like_stream(candidate)
                        and "player.php" not in candidate.lower()
                        and (not _looks_like_stream(stream_url) or "player.php" in stream_url.lower())
                    ):
                        resolved_stream = candidate
                    if is_generic_title or not resolved_title:
                        ext_title = (extracted.get("title") or "").strip()
                        if ext_title:
                            resolved_title = ext_title
                    resolved_thumbnail = (extracted.get("thumbnail") or "").strip()
                    resolved_duration = int(extracted.get("duration") or 0)
                    resolved_player_url = (extracted.get("player_url") or "").strip()

                    # Detect quality
                    if any(x in (resolved_title + stream_url).lower() for x in ("1080", "fhd", "ultra")):
                        resolved_quality = "FHD"
                    elif any(x in (resolved_title + stream_url).lower() for x in ("720", "hd")):
                        resolved_quality = "HD"
                    elif extracted.get("quality"):
                        resolved_quality = extracted.get("quality")
        except Exception as exc:
            logging.warning(f"[StreamCapture] stream resolve failed for {source_url}: {exc}")

    # Server-side smart filter: Reject previews/thumbs
    if any(x in resolved_stream.lower() for x in ("vidthumb", "preview", "small.mp4", "get_preview")):
        logging.info(f"[StreamCapture] Rejected preview stream: {resolved_stream}")
        return {"status": "ignored", "message": "preview_detected"}

    # Final title cleanup
    if resolved_title:
        for artifact in (
            ">External Link!<", "krakenfiles.com", "vidara.so", "vidsonic.net",
            "vidfast.co", "sxyprn.com", "vidfast.co", "vidsonic.net",
        ):
            resolved_title = re.sub(re.escape(artifact), "", resolved_title, flags=re.IGNORECASE)
        resolved_title = resolved_title.strip(" -|")
        if not resolved_title:
            resolved_title = _title_from_source_url(source_url) or f"{source.capitalize()} Video"

    # Detect quality and try to get file size
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
                        logging.info(
                            f"[StreamCapture] Ignoring suspicious Content-Length {content_length} bytes"
                            f" for {resolved_stream[:80]}"
                        )
        except Exception:
            pass

    if not _looks_like_stream(resolved_stream):
        logging.warning(f"[PH-Interceptor] Rejected non-playable stream URL: {resolved_stream[:120]}")
        return {"status": "error", "message": "non_playable_stream", "stream_url": resolved_stream[:200]}

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
        if resolved_title and (
            not video.title
            or any(x in str(video.title).lower() for x in ("untitled", "queued", ">external link!<"))
        ):
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
        _tp = video.thumbnail_path or ""
        _thumb_on_disk = False
        if _tp.startswith("/static/thumbnails/"):
            _tf = os.path.join("app", _tp.lstrip("/").split("?")[0])
            _thumb_on_disk = os.path.exists(_tf) and os.path.getsize(_tf) > 500
        if not _thumb_on_disk or not video.height or not video.duration:
            _queue_thumbnail_processing(video.id)
        return {"status": "ok", "video_id": video.id, "stream_url": resolved_stream}

    logging.info(f"[PH-Interceptor] No video found for source_url, creating new one: {source_url}")
    new_video = Video(
        title=resolved_title or _title_from_source_url(source_url) or f"{source.capitalize()} Video",
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
