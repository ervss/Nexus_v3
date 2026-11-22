"""Screenshots and the short trailer embedded in a MyPornClub release page.

Jackett does not receive a poster for this indexer. The still and the preview
video live in the ``torrent_links`` data attribute as protocol-relative URLs.
Those CDN links expire, so callers should read the page again rather than
store them for long.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import socket
import time
from dataclasses import dataclass, field
from html import unescape
from urllib.parse import urlsplit

import httpx
from bs4 import BeautifulSoup
from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse

from ..url_safety import require_public_http_url

logger = logging.getLogger("nexus.torrent")

_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif")
_VIDEO_EXT = (".mp4", ".webm", ".m4v")
_CACHE: dict[str, tuple[float, "MpcMedia"]] = {}
_CACHE_TTL = 10 * 60


@dataclass
class MpcMedia:
    images: list[str] = field(default_factory=list)
    trailer: str = ""


def is_mypornclub(url: str) -> bool:
    host = (urlsplit(url or "").hostname or "").lower()
    return host == "myporn.club" or host.endswith(".myporn.club")


def _decode_blob(raw: str):
    text = unescape(raw or "").strip()
    if not text:
        return None
    if '\\"' in text:
        text = text.replace('\\"', '"')
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        try:
            return json.loads(text.replace("\\/", "/"))
        except json.JSONDecodeError:
            return None


def _absolute(url: str) -> str:
    value = (url or "").strip()
    if value.startswith("//"):
        value = "https:" + value
    if not value.startswith(("http://", "https://")):
        return ""
    try:
        return require_public_http_url(value)
    except ValueError:
        return ""


def _kind(url: str) -> str:
    path = urlsplit(url).path.lower()
    if path.endswith(_IMAGE_EXT):
        return "image"
    if path.endswith(_VIDEO_EXT):
        return "video"
    return ""


def parse_mypornclub_html(html: str) -> MpcMedia:
    soup = BeautifulSoup(html or "", "html.parser")
    images: list[str] = []
    videos: list[str] = []
    seen: set[str] = set()
    for tag in soup.select("[data-content]"):
        payload = _decode_blob(tag.get("data-content") or "")
        if isinstance(payload, dict):
            values = list(payload.values())
        elif isinstance(payload, list):
            values = payload
        else:
            continue
        for item in values:
            if not isinstance(item, str):
                continue
            url = _absolute(item.replace("\\/", "/"))
            kind = _kind(url)
            if not url or not kind or url in seen:
                continue
            seen.add(url)
            if kind == "image":
                images.append(url)
            else:
                videos.append(url)
    trailer = ""
    for video in videos:
        if "thumb" in video.lower() or "preview" in video.lower():
            trailer = video
            break
    if not trailer and videos:
        trailer = videos[0]
    return MpcMedia(images=images, trailer=trailer)


async def media_for(details_url: str) -> MpcMedia:
    """Fetch a release page and return its stills and trailer. Empty when absent."""
    if not is_mypornclub(details_url):
        return MpcMedia()
    now = time.time()
    cached = _CACHE.get(details_url)
    if cached and cached[0] > now:
        return cached[1]
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(15.0)) as client:
            response = await client.get(
                details_url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; NexusTorrent/1.0)"},
            )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.info("mypornclub page skipped: %s", exc)
        return MpcMedia()
    media = parse_mypornclub_html(response.text)
    _CACHE[details_url] = (now + _CACHE_TTL, media)
    logger.info(
        "mypornclub media images=%s trailer=%s",
        len(media.images),
        bool(media.trailer),
    )
    return media


def _public_host(hostname: str) -> None:
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as exc:
        raise HTTPException(status_code=502, detail="Trailer host did not resolve") from exc
    addresses = []
    for info in infos:
        try:
            addresses.append(ipaddress.ip_address(info[4][0]))
        except ValueError:
            continue
    if not addresses or any(not address.is_global for address in addresses):
        raise HTTPException(status_code=502, detail="Trailer host is not public")


async def proxy_trailer(url: str, request: Request, referer: str) -> StreamingResponse:
    """Stream the short preview. The signed CDN link is not sent to the page."""
    try:
        current = require_public_http_url(url)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Trailer URL is not public") from exc
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; NexusTorrent/1.0)",
        "Referer": referer,
    }
    if request.headers.get("range"):
        headers["Range"] = request.headers["range"]
    await asyncio.to_thread(_public_host, urlsplit(current).hostname or "")
    client = httpx.AsyncClient(follow_redirects=False, timeout=httpx.Timeout(20.0))
    stream = client.stream("GET", current, headers=headers)
    upstream = await stream.__aenter__()
    if upstream.status_code >= 400:
        await stream.__aexit__(None, None, None)
        await client.aclose()
        logger.info("mypornclub trailer upstream HTTP %s", upstream.status_code)
        raise HTTPException(status_code=502, detail="Trailer is not available anymore")

    async def body():
        try:
            async for chunk in upstream.aiter_bytes(256 * 1024):
                if await request.is_disconnected():
                    break
                yield chunk
        finally:
            await stream.__aexit__(None, None, None)
            await client.aclose()

    forwarded = {
        "Cache-Control": "no-store",
        "Accept-Ranges": upstream.headers.get("accept-ranges", "bytes"),
    }
    if upstream.headers.get("content-length"):
        forwarded["Content-Length"] = upstream.headers["content-length"]
    if upstream.headers.get("content-range"):
        forwarded["Content-Range"] = upstream.headers["content-range"]
    media_type = (upstream.headers.get("content-type") or "video/mp4").split(";")[0]
    return StreamingResponse(
        body(),
        status_code=upstream.status_code,
        media_type=media_type,
        headers=forwarded,
    )
