"""Thumbnail lookup for a torrent card.

Order is deliberate: the infohash source cannot mix up two scenes that share
a title, the indexer poster is the release's own image, and ThePornDB is only
a fuzzy title match used when the first two found nothing.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import re
import socket
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup

from ..url_safety import require_public_http_url
from .settings import load_settings

logger = logging.getLogger("nexus.torrent")

CACHE_DIR = Path("data/torrent_cache/thumbs")
_poster_cache: dict[str, tuple[float, str]] = {}
_IMAGE_TYPES = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"GIF87a": "image/gif",
    b"GIF89a": "image/gif",
}
_NOISE = re.compile(
    r"\b(1080p|720p|2160p|4k|x264|x265|h264|h265|hevc|xxx|webrip|bluray|dvdrip|"
    r"web-dl|proper|repack|aac|mp4|mkv|hdrip)\b",
    re.I,
)
_locks: dict[str, asyncio.Lock] = {}
_gate = asyncio.Semaphore(3)
_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            follow_redirects=False,
            headers={"User-Agent": "Mozilla/5.0 (compatible; NexusTorrent/1.0)"},
        )
    return _client


def _lock(infohash: str) -> asyncio.Lock:
    lock = _locks.get(infohash)
    if lock is None:
        lock = asyncio.Lock()
        _locks[infohash] = lock
    return lock


def remember_poster(key: str, url: str) -> None:
    if key and url:
        _poster_cache[key] = (time.time() + 6 * 3600, url)


def cached_poster(key: str) -> str:
    item = _poster_cache.get(key)
    if not item or item[0] < time.time():
        _poster_cache.pop(key, None)
        return ""
    return item[1]


def sniff_image(blob: bytes) -> str | None:
    if len(blob) < 16:
        return None
    if blob.startswith(b"RIFF") and blob[8:12] == b"WEBP":
        return "image/webp"
    for magic, kind in _IMAGE_TYPES.items():
        if blob.startswith(magic) and kind != "image/webp":
            return kind
    return None


def _host_is_public(hostname: str) -> bool:
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as exc:
        raise ValueError("Thumbnail host did not resolve") from exc
    addresses = []
    for info in infos:
        try:
            addresses.append(ipaddress.ip_address(info[4][0]))
        except ValueError:
            continue
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError("Thumbnail host is not public")
    return True


async def _read_public(url: str, limit: int, headers: dict | None = None) -> tuple[str, bytes]:
    current = require_public_http_url(url)
    async with _gate:
        for _ in range(3):
            parts = urlsplit(current)
            await asyncio.to_thread(_host_is_public, parts.hostname or "")
            timeout = httpx.Timeout(connect=3.0, read=12.0, write=8.0, pool=5.0)
            async with _http().stream("GET", current, timeout=timeout, headers=headers) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location") or ""
                    current = require_public_http_url(urljoin(current, location))
                    continue
                if response.status_code >= 400:
                    raise ValueError(f"HTTP {response.status_code}")
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    chunks.append(chunk)
                    total += len(chunk)
                    if total >= limit:
                        break
                return response.headers.get("content-type", ""), b"".join(chunks)[:limit]
    raise ValueError("Too many redirects")


def extract_screenshot_urls(payload: Any) -> list[str]:
    found: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                folded = str(key).lower()
                if folded in {"screenshot", "image", "url", "src", "poster"} and isinstance(value, str):
                    if value.startswith("http"):
                        found.append(value)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, str) and node.startswith("http") and re.search(r"\.(jpe?g|png|webp)(\?|$)", node, re.I):
            found.append(node)

    walk(payload)
    unique = []
    seen = set()
    for url in found:
        if url not in seen:
            seen.add(url)
            unique.append(url)
    return unique[:6]


def _og_images(html: str, page_url: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    urls: list[str] = []
    for tag in soup.find_all("meta"):
        key = (tag.get("property") or tag.get("name") or "").lower()
        if key in {"og:image", "og:image:url", "twitter:image", "twitter:image:src"}:
            content = (tag.get("content") or "").strip()
            if content:
                urls.append(urljoin(page_url, content))
    for image in soup.find_all("img"):
        src = (image.get("src") or image.get("data-src") or "").strip()
        hint = " ".join([
            src,
            image.get("class") and " ".join(image.get("class")) or "",
            image.get("id") or "",
            image.get("alt") or "",
        ]).lower()
        if not src or any(token in hint for token in ("logo", "icon", "avatar", "sprite", "emoji")):
            continue
        if any(token in hint for token in ("poster", "screenshot", "cover", "thumb", "preview")):
            urls.append(urljoin(page_url, src))
    return urls[:6]


def _title_tokens(title: str) -> set[str]:
    cleaned = _NOISE.sub(" ", title.lower())
    return {token for token in re.findall(r"[a-z0-9]{4,}", cleaned)}


def _tpdb_match(title: str, scenes: list[dict]) -> str:
    wanted = _title_tokens(title)
    if len(wanted) < 2:
        return ""
    best_url = ""
    best_score = 0.0
    for scene in scenes:
        name = str(scene.get("title") or "")
        overlap = wanted & _title_tokens(name)
        score = len(overlap) / max(1, len(wanted))
        if score > best_score:
            best_score = score
            poster = scene.get("poster") or scene.get("image") or ""
            if isinstance(poster, dict):
                poster = poster.get("url") or poster.get("full") or ""
            best_url = str(poster or "")
    if best_score < 0.55:
        return ""
    return best_url


def _cache_paths(infohash: str) -> tuple[Path, Path]:
    return CACHE_DIR / f"{infohash}.json", CACHE_DIR / f"{infohash}.bin"


def _read_cache(infohash: str) -> tuple[str, bytes] | None:
    meta_path, blob_path = _cache_paths(infohash)
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    age = time.time() - float(meta.get("saved_at") or 0)
    settings = load_settings()
    if meta.get("miss"):
        if age < settings.thumb_miss_ttl:
            return ("miss", b"")
        return None
    if age > settings.thumb_ttl or not blob_path.exists():
        return None
    try:
        blob = blob_path.read_bytes()
    except OSError:
        return None
    kind = sniff_image(blob)
    if not kind:
        return None
    return kind, blob


def _write_cache(infohash: str, *, kind: str = "", blob: bytes = b"", source: str = "", miss: bool = False) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    meta_path, blob_path = _cache_paths(infohash)
    meta = {"saved_at": time.time(), "source": source, "content_type": kind, "miss": miss}
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    if blob and not miss:
        temporary = blob_path.with_suffix(".tmp")
        temporary.write_bytes(blob)
        temporary.replace(blob_path)


async def _download_image(url: str, referer: str = "") -> tuple[str, bytes] | None:
    headers = {"Referer": referer} if referer else None
    try:
        _content_type, blob = await _read_public(url, 4 * 1024 * 1024, headers=headers)
    except (ValueError, httpx.HTTPError) as exc:
        logger.debug("thumb image skipped %s: %s", url[:120], exc)
        return None
    kind = sniff_image(blob)
    if not kind:
        return None
    return kind, blob


async def _read_indexer(url: str, limit: int) -> tuple[str, bytes]:
    """Fetch a Jackett or Prowlarr poster. Those URLs are on localhost and carry the API key."""
    from .normalize import _same_origin
    from .settings import load_settings

    settings = load_settings()
    bases = [base for base in (settings.jackett_url, settings.prowlarr_url) if base]
    current = url
    for _ in range(3):
        if not any(_same_origin(current, base) for base in bases):
            return await _read_public(current, limit)
        timeout = httpx.Timeout(connect=3.0, read=12.0, write=8.0, pool=5.0)
        async with _http().stream("GET", current, timeout=timeout) as response:
            if response.status_code in {301, 302, 303, 307, 308}:
                current = urljoin(current, response.headers.get("location") or "")
                continue
            if response.status_code >= 400:
                raise ValueError(f"HTTP {response.status_code}")
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                chunks.append(chunk)
                total += len(chunk)
                if total >= limit:
                    break
            return response.headers.get("content-type", ""), b"".join(chunks)[:limit]
    raise ValueError("Too many redirects")


async def _from_poster(url: str) -> tuple[str, bytes, str] | None:
    if not url:
        return None
    try:
        _content_type, blob = await _read_indexer(url, 4 * 1024 * 1024)
    except (ValueError, httpx.HTTPError) as exc:
        logger.info("indexer poster skipped: %s", exc)
        return None
    kind = sniff_image(blob)
    if not kind:
        return None
    return kind, blob, "indexer-poster"


async def _from_whatslink(infohash: str) -> tuple[str, bytes, str] | None:
    magnet = f"magnet:?xt=urn:btih:{infohash}"
    url = "https://whatslink.info/api/v1/link"
    try:
        response = await _http().get(url, params={"url": magnet}, timeout=httpx.Timeout(12.0))
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("whatslink lookup failed for %s: %s", infohash[:12], exc)
        return None
    if isinstance(payload, dict) and payload.get("error"):
        logger.info("whatslink miss for %s: %s", infohash[:12], payload.get("error"))
        return None
    for shot in extract_screenshot_urls(payload):
        image = await _download_image(shot)
        if image:
            kind, blob = image
            return kind, blob, "whatslink"
    return None


async def _from_mypornclub(details_url: str) -> tuple[str, bytes, str] | None:
    from .mypornclub import media_for

    media = await media_for(details_url)
    for image_url in media.images:
        image = await _download_image(image_url, referer=details_url)
        if image:
            kind, blob = image
            return kind, blob, "mypornclub"
    return None


async def _from_details(details_url: str) -> tuple[str, bytes, str] | None:
    if not details_url:
        return None
    try:
        _content_type, blob = await _read_public(details_url, 1_200_000)
        html = blob.decode("utf-8", errors="ignore")
        images = _og_images(html, details_url)
    except (ValueError, httpx.HTTPError, UnicodeError) as exc:
        logger.info("details thumbnail skipped: %s", exc)
        return None
    for image_url in images:
        image = await _download_image(image_url)
        if image:
            kind, data = image
            return kind, data, "details"
    return None


async def _from_tpdb(title: str) -> tuple[str, bytes, str] | None:
    settings = load_settings()
    if not settings.tpdb_api_key or not title:
        return None
    try:
        response = await _http().get(
            "https://api.theporndb.net/scenes",
            params={"q": title[:180], "per_page": 5},
            headers={"Authorization": f"Bearer {settings.tpdb_api_key}"},
            timeout=httpx.Timeout(12.0),
        )
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("ThePornDB lookup failed: %s", exc)
        return None
    scenes = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(scenes, list):
        return None
    poster = _tpdb_match(title, scenes)
    if not poster:
        return None
    image = await _download_image(poster)
    if not image:
        return None
    kind, blob = image
    return kind, blob, "theporndb"


async def get_thumbnail(
    infohash: str = "",
    title: str = "",
    details_url: str = "",
    cache_key: str = "",
) -> tuple[str, bytes] | None:
    lookup = infohash or cache_key
    if not lookup:
        return None
    disk_key = lookup if re.fullmatch(r"[a-f0-9]{40,64}", lookup) else hashlib.sha1(lookup.encode()).hexdigest()
    from .mypornclub import is_mypornclub

    poster_url = cached_poster(infohash or cache_key)
    fresh_page = is_mypornclub(details_url)
    cached = _read_cache(disk_key)
    if cached is not None and cached[0] != "miss":
        return cached
    if cached is not None and not poster_url and not fresh_page:
        return None

    async with _lock(disk_key):
        poster_url = cached_poster(infohash or cache_key)
        cached = _read_cache(disk_key)
        if cached is not None and cached[0] != "miss":
            return cached
        if cached is not None and not poster_url and not fresh_page:
            return None

        found = await _from_poster(poster_url)
        if found is None and fresh_page:
            found = await _from_mypornclub(details_url)
        if found is None and infohash:
            found = await _from_whatslink(infohash)
        if found is None and not fresh_page:
            found = await _from_details(details_url)
        if found is None:
            found = await _from_tpdb(title)
        if found is None:
            _write_cache(disk_key, miss=True)
            logger.info("thumbnail miss key=%s", disk_key[:12])
            return None
        kind, blob, source = found
        _write_cache(disk_key, kind=kind, blob=blob, source=source)
        logger.info("thumbnail hit key=%s source=%s bytes=%s", disk_key[:12], source, len(blob))
        return kind, blob
