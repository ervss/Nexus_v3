"""Nexus Playback Engine — Unified playback contract, caching, DRM check, and proxy routing."""

from __future__ import annotations

import logging
import re
import secrets
import time
import urllib.parse
from typing import Any, Dict, List, Optional

from .proxy_sessions import SESSIONS as _shared_proxy_sessions, TTL as _shared_session_ttl
from .url_safety import require_public_http_url

logger = logging.getLogger(__name__)

# In-memory cache for playback contracts
# key -> (timestamp, contract, expires_at)
_PLAYBACK_CACHE: Dict[str, tuple[float, Dict[str, Any], Optional[float]]] = {}
_DEFAULT_CACHE_TTL = 300.0  # 5 minutes


def get_cached_playback(url: str) -> Optional[Dict[str, Any]]:
    """Retrieve non-expired playback contract from memory cache."""
    clean_url = (url or "").strip()
    if not clean_url or clean_url not in _PLAYBACK_CACHE:
        return None
    ts, contract, expires_at = _PLAYBACK_CACHE[clean_url]
    now = time.time()
    if expires_at and now >= expires_at:
        _PLAYBACK_CACHE.pop(clean_url, None)
        return None
    if (now - ts) > _DEFAULT_CACHE_TTL:
        _PLAYBACK_CACHE.pop(clean_url, None)
        return None
    return contract


def set_cached_playback(url: str, contract: Dict[str, Any], ttl: Optional[float] = None) -> None:
    """Store playback contract in memory cache."""
    clean_url = (url or "").strip()
    if not clean_url or not contract:
        return
    now = time.time()
    effective_ttl = ttl if ttl is not None else _DEFAULT_CACHE_TTL
    expires_at = contract.get("expires_at")
    if expires_at:
        expires_ts = float(expires_at)
    else:
        expires_ts = now + effective_ttl
    _PLAYBACK_CACHE[clean_url] = (now, contract, expires_ts)


def clear_cache() -> None:
    """Clear playback cache (useful for testing)."""
    _PLAYBACK_CACHE.clear()


def is_drm_protected(stream_url: str, data: Dict[str, Any]) -> bool:
    """Check if the media stream indicates DRM encryption (Widevine, PlayReady, FairPlay)."""
    text_to_check = f"{stream_url} {data.get('content_type', '')} {data.get('extra', '')}".lower()
    drm_keywords = ("widevine", "playready", "fairplay", "cenc", "urn:mpeg:dash:mp4protection")
    return any(kw in text_to_check for kw in drm_keywords) or bool(data.get("is_drm"))


def _is_byse_embed_url(url: str) -> bool:
    if not url:
        return False
    try:
        parsed = urllib.parse.urlparse(url)
        host = parsed.netloc.lower()
        if host.startswith("www."):
            host = host[4:]
        return host == "bysezoxexe.com" or host.endswith(".bysezoxexe.com") or "byse" in host
    except Exception:
        return bool(re.search(r"bysezoxexe\.com", url, re.I))


def _format_embed_url(url: str, referer: str, session: Optional[str] = None) -> str:
    target = (url or "").strip()
    session_arg = f"&session={urllib.parse.quote(session)}" if session else ""
    encoded_ref = urllib.parse.quote(referer or "", safe="")
    if _is_byse_embed_url(target):
        try:
            parsed = urllib.parse.urlparse(target)
            m = re.match(r"^/(?:e|kpw)/([a-zA-Z0-9_-]+)", parsed.path)
            if m:
                code = urllib.parse.quote(m.group(1), safe="")
                encoded_up = urllib.parse.quote(target, safe="")
                return f"/e/{code}?upstream={encoded_up}&referer={encoded_ref}{session_arg}"
        except Exception:
            pass
    encoded_embed = urllib.parse.quote(target, safe="")
    return f"/embed_proxy?url={encoded_embed}&referer={encoded_ref}{session_arg}"


def _is_leak_family_url(url: str) -> bool:
    low = (url or "").lower()
    return any(d in low for d in ("leakporner.com", "leakporner", "hornysimp.com", "hornysimp", "bysezoxexe.com"))


def build_playback_contract(
    page_url: str,
    data: Dict[str, Any],
    extractor_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Construct a normalized, secure, and performant playback contract."""
    stream_url = str(data.get("stream_url") or "").strip()
    embed_urls = [
        val for val in (data.get("embed_urls") or [])
        if isinstance(val, str) and val.startswith(("https://", "http://"))
    ]
    source_name = extractor_name or data.get("extractor") or data.get("source") or "unknown"
    referer = str(data.get("playback_referer") or page_url or "")

    # 1. DRM Protection Gate
    if stream_url and is_drm_protected(stream_url, data):
        return {
            "type": "unsupported",
            "format": "drm",
            "playback_url": "",
            "fallback_url": None,
            "requires_proxy": False,
            "iframe": False,
            "session_id": None,
            "expires_at": None,
            "source_name": source_name,
            "status": "unsupported",
            "reason": "drm_protected",
            "message": "Stream je chránený DRM (Widevine/PlayReady) a nemožno ho prehrať.",
        }

    # 2. Tokenized session registration
    proxy_session = data.get("proxy_session")
    proxy_cookies = data.get("proxy_cookies")
    if not proxy_session and isinstance(proxy_cookies, dict) and proxy_cookies:
        session_id = secrets.token_urlsafe(18)
        now = time.time()
        _shared_proxy_sessions[session_id] = {
            "ts": now,
            "cookies": {str(k): str(v) for k, v in proxy_cookies.items() if v},
            "referer": referer,
            "url": stream_url,
        }
        proxy_session = session_id
    elif proxy_session and stream_url:
        entry = _shared_proxy_sessions.get(proxy_session)
        if entry:
            entry["url"] = stream_url

    # 3. Detect format
    is_telegram = "/telegram/stream/" in stream_url.lower() or "telesco.pe" in stream_url.lower()
    is_dash = not is_telegram and (
        ".mpd" in stream_url.lower() or "dash+xml" in str(data.get("content_type", "")).lower()
    )
    is_hls = (
        not is_telegram
        and not is_dash
        and (
            bool(data.get("is_hls"))
            or ".m3u8" in stream_url.lower()
            or "/hls/" in stream_url.lower()
            or "mpegurl" in str(data.get("content_type", "")).lower()
            or "/cdnstream.top/stream/" in stream_url.lower()
            or "/cdnvids.top/stream/" in stream_url.lower()
        )
    )

    if is_dash:
        format_type = "dash"
    elif is_hls:
        format_type = "hls"
    else:
        format_type = "mp4"

    # 4. Check if embed player is required
    is_stream_byse = _is_byse_embed_url(stream_url)
    is_byse = is_stream_byse or any(_is_byse_embed_url(e) for e in embed_urls)
    has_embed = bool(embed_urls) or is_byse
    has_direct_stream = (
        bool(stream_url)
        and (
            urllib.parse.urlsplit(stream_url).path.lower().rstrip("/").endswith((".mp4", ".m4v", ".mkv", ".webm", ".m3u8", ".mpd"))
            or is_telegram
            or is_hls
            or is_dash
        )
        and not is_stream_byse
    )

    # 5. Direct vs Proxy vs Embed determination
    low_page = page_url.lower()
    low_stream = stream_url.lower()

    needs_proxy_always = (
        is_hls
        or is_dash
        or bool(proxy_session)
        or _is_leak_family_url(low_page)
        or _is_leak_family_url(low_stream)
        or any(d in low_stream for d in (
            "phncdn.com", "xvideos-cdn.com", "xhcdn.com", "flixcdn.com",
            "camwhores.tv", "pixeldrain.com", "coomerfans.com", "turbocr",
            "drtuber.com", "spankbang.com", "whoreshub.com", "fpo.xxx", "cdntrex.com",
        ))
        or any(d in low_page for d in (
            "pornhub", "xvideos", "camwhores", "hornysimp", "leakporner", "noodlemagazine", "fpo.xxx", "eporner.com", "porntrex.com"
        ))
    )

    if not has_direct_stream and has_embed:
        # Embed player route
        target_embed = (
            next((e for e in embed_urls if _is_byse_embed_url(e)), None)
            or (stream_url if _is_byse_embed_url(stream_url) else None)
            or (embed_urls[0] if embed_urls else stream_url)
        )
        playback_url = _format_embed_url(target_embed, referer, proxy_session)

        players = [
            _format_embed_url(e, referer, proxy_session)
            for e in embed_urls
        ] if len(embed_urls) > 1 else [playback_url]

        contract = {
            "type": "embed",
            "format": "mp4",
            "playback_url": playback_url,
            "fallback_url": None,
            "requires_proxy": True,
            "iframe": True,
            "session_id": proxy_session,
            "expires_at": int(time.time() + 600) if proxy_session else None,
            "source_name": source_name,
            "players": players,
        }
        set_cached_playback(page_url, contract)
        return contract

    # Direct media stream route
    session_arg = f"&session={urllib.parse.quote(proxy_session)}" if proxy_session else ""
    encoded_ref = urllib.parse.quote(referer, safe="")

    # Fast-path safe direct URLs (e.g., local telegram stream, direct Bunkr/Eporner if direct)
    if stream_url.startswith("/") or is_telegram:
        contract = {
            "type": "direct",
            "format": format_type,
            "playback_url": stream_url,
            "fallback_url": None,
            "requires_proxy": False,
            "iframe": False,
            "session_id": None,
            "expires_at": None,
            "source_name": source_name,
        }
        set_cached_playback(page_url, contract)
        return contract

    # Fallback proxy URL (one-shot fallback if direct playback fails)
    fallback_url = f"/hls_proxy?url={urllib.parse.quote(stream_url, safe='')}&referer={encoded_ref}{session_arg}"

    if needs_proxy_always:
        playback_url = fallback_url
        requires_proxy = True
    else:
        # Client tries direct stream first (<0.5s TTFF); on error falls back once to fallback_url
        playback_url = stream_url
        requires_proxy = False

    contract = {
        "type": "proxy" if requires_proxy else "direct",
        "format": format_type,
        "playback_url": playback_url,
        "fallback_url": fallback_url if not requires_proxy else None,
        "requires_proxy": requires_proxy,
        "iframe": False,
        "session_id": proxy_session,
        "expires_at": int(time.time() + 600) if proxy_session else None,
        "source_name": source_name,
    }
    set_cached_playback(page_url, contract)
    return contract
