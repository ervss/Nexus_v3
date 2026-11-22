"""Bounded, read-only metadata for the selector's current-page Turbo overview.

Reuse the Turbo page parser and MP4 parsers; never accept arbitrary probe URLs.
Signed streams stay on the server and are resolved again by the import pipeline.
"""
import asyncio
import json
import re
from urllib.parse import urljoin, urlsplit

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from .extractors.turbo import TurboExtractor
from .mp4_probe import parse_mvhd_duration, parse_tkhd_dimensions, _find_moov_offset
from .routers.extension_bridge import ensure_bridge_token

router = APIRouter()
_gate = asyncio.Semaphore(3)
_parser = TurboExtractor()
_headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://turbo.cr/"}


def turbo_id(value: str) -> str:
    try:
        u = urlsplit(value)
        if (u.scheme != "https" or u.hostname != "turbo.cr" or u.port not in (None, 443)
                or u.username is not None or u.password is not None):
            return ""
        m = re.fullmatch(r"/(?:v|d|embed)/([A-Za-z0-9_-]{1,128})/?", u.path)
        return m[1] if m else ""
    except ValueError:
        return ""


def allowed_url(value: str, media: bool = False) -> str:
    u = urlsplit(value)
    host = u.hostname or ""
    allowed = host == "turbo.cr" if not media else (host == "turbocdn.st" or host.endswith(".turbocdn.st"))
    if (u.scheme != "https" or not allowed or u.port not in (None, 443)
            or u.username is not None or u.password is not None):
        raise ValueError("Nepovolený cieľ resolvera")
    return value


class RateLimited(Exception):
    def __init__(self, seconds):
        self.seconds = seconds


async def bounded_get(client, url, limit, *, media=False, start=None):
    """Check every redirect before fetching it, read only the requested budget."""
    headers = dict(_headers)
    if start is not None:
        headers["Range"] = f"bytes={start}-{start + limit - 1}"
        headers["Accept-Encoding"] = "identity"
    for _ in range(4):
        allowed_url(url, media)
        async with client.stream("GET", url, headers=headers, follow_redirects=False) as r:
            if r.status_code in (301, 302, 303, 307, 308):
                url = urljoin(url, r.headers.get("location", ""))
                continue
            if r.status_code == 429:
                retry = r.headers.get("retry-after", "60")
                try:
                    seconds = max(1, int(retry))
                except ValueError:
                    from email.utils import parsedate_to_datetime
                    from datetime import datetime, timezone
                    try:
                        seconds = max(1, int((parsedate_to_datetime(retry) - datetime.now(timezone.utc)).total_seconds()))
                    except (ValueError, TypeError):
                        seconds = 60
                raise RateLimited(seconds)
            r.raise_for_status()
            content_type = r.headers.get("content-type", "").lower()
            if media and (r.status_code not in (200, 206) or re.search(r"text/|json|xml", content_type)):
                raise ValueError("Zdroj nevrátil video")
            if media and start and r.status_code != 206:
                return b"", 0, False
            total = 0
            if media:
                m = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", r.headers.get("content-range", ""))
                if r.status_code == 206:
                    if not m or int(m[1]) != start or int(m[3]) <= int(m[2]):
                        raise ValueError("Neplatný Content-Range")
                    total = int(m[3])
                else:
                    total = int(r.headers.get("content-length", "0"))
            body = bytearray()
            async for chunk in r.aiter_bytes(chunk_size=min(16384, limit)):
                body.extend(chunk[:limit - len(body)])
                if len(body) >= limit:
                    break
            return bytes(body), total, r.status_code == 206
    raise ValueError("Príliš veľa presmerovaní")


async def read_metadata(url: str, client):
    ident = turbo_id(url)
    watch = f"https://turbo.cr/v/{ident}"
    page, _, _ = await bounded_get(client, watch, 512 * 1024)
    parsed = _parser._parse_page(page.decode("utf-8", errors="replace"), watch)
    stream = parsed.get("stream_url") or ""
    if not stream:
        sign, _, _ = await bounded_get(client, f"https://turbo.cr/api/sign?v={ident}", 16 * 1024)
        stream = str(json.loads(sign).get("url") or "")
    allowed_url(stream, True)
    head, size, ranged = await bounded_get(client, stream, 128 * 1024, media=True, start=0)
    duration = parse_mvhd_duration(head)
    width, height = parse_tkhd_dimensions(head)
    if ranged and size > len(head) and not all((duration, width, height)):
        tail, _, _ = await bounded_get(client, stream, min(size, 256 * 1024), media=True, start=max(0, size - 256 * 1024))
        duration = duration or parse_mvhd_duration(tail)
        w, h = parse_tkhd_dimensions(tail)
        if not width or not height:
            width, height = w, h
        offset = _find_moov_offset(head)
        if not all((duration, width, height)) and 0 <= offset < size:
            moov, _, _ = await bounded_get(client, stream, min(1024 * 1024, size - offset), media=True, start=offset)
            duration = duration or parse_mvhd_duration(moov)
            w, h = parse_tkhd_dimensions(moov)
            if not width or not height:
                width, height = w, h
    return {"ok": True, "id": ident, "title": parsed.get("title") or "",
            "duration": duration or parsed.get("duration") or 0,
            "width": width, "height": height, "size_bytes": size,
            "metadata_source": "turbo-page+bounded-mp4", "variants": []}


class TurboMetaRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


@router.post("/turbo-meta")
async def turbo_metadata(payload: TurboMetaRequest, x_nexus_token: str | None = Header(default=None)):
    ensure_bridge_token(x_nexus_token)
    if not turbo_id(payload.url):
        raise HTTPException(400, "Povolené sú iba Turbo video odkazy /v/, /d/ a /embed/.")
    async def resolve():
        async with _gate:
            async with httpx.AsyncClient(timeout=httpx.Timeout(8, connect=5), follow_redirects=False) as client:
                return await read_metadata(payload.url, client)
    try:
        # Includes waiting for the shared slot, so a second extension/client
        # cannot leave an unbounded queue running after closing its panel.
        return await asyncio.wait_for(resolve(), 22)
    except RateLimited as exc:
        return {"ok": False, "error": "Turbo obmedzil počet požiadaviek. Skús obnoviť údaje neskôr.", "retry_after": exc.seconds}
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        return {"ok": False, "unavailable": code in (404, 410),
                "error": "Video je nedostupné" if code in (404, 410) else f"Hosting vyžaduje prístup alebo neodpovedá (HTTP {code})"}
    except (ValueError, httpx.HTTPError, asyncio.TimeoutError):
        # Do not echo signed URLs, cookies or arbitrary upstream exception text.
        return {"ok": False, "error": "Metadáta sa nepodarilo overiť v časovom alebo dátovom limite."}
