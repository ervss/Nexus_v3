"""Small, cached, best-effort checks for links shown in the library."""
import asyncio
import ipaddress
import socket
import time
from urllib.parse import urlsplit

import aiohttp
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import Video, get_db

router = APIRouter(tags=["library-health"])
_cache = {}
_inflight = {}
_slots = None
TTL = 1800


class CardIds(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=24)


class PublicResolver(aiohttp.abc.AbstractResolver):
    async def resolve(self, host, port=0, family=socket.AF_UNSPEC):
        records = await asyncio.get_running_loop().getaddrinfo(host, port, family=family, type=socket.SOCK_STREAM)
        addresses = {record[4][0] for record in records}
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
            raise OSError("Non-public address")
        return [{"hostname": host, "host": address, "port": port, "family": socket.AF_INET6 if ':' in address else socket.AF_INET, "proto": 0, "flags": socket.AI_NUMERICHOST} for address in addresses]

    async def close(self):
        pass


async def _probe(url):
    global _slots
    if _slots is None:
        _slots = asyncio.Semaphore(3)
    try:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
            return "unknown"
        # Literal addresses bypass aiohttp's resolver, so validate them here.
        try:
            if not ipaddress.ip_address(parts.hostname).is_global:
                return "unknown"
        except ValueError:
            pass
        async with _slots:
            connector = aiohttp.TCPConnector(resolver=PublicResolver())
            async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=6), trust_env=False) as session:
                async with session.head(url, allow_redirects=False) as response:
                    code = response.status
                if code in (405, 501):
                    async with session.get(url, headers={"Range": "bytes=0-0"}, allow_redirects=False) as response:
                        code = response.status
        if 200 <= code < 300:
            return "online"
        if code in (404, 410) or 500 <= code < 600:
            return "offline"
    except Exception:
        pass
    return "unknown"


async def _cached_probe(url):
    now = time.monotonic()
    cached = _cache.get(url)
    if cached and cached[0] > now:
        return cached[1]
    if url not in _inflight:
        if len(_inflight) >= 24:
            return "unknown"
        async def run():
            try:
                result = await _probe(url)
                if len(_cache) >= 2000:
                    _cache.clear()
                _cache[url] = (time.monotonic() + (TTL if result != "unknown" else 300), result)
                return result
            finally:
                _inflight.pop(url, None)
        _inflight[url] = asyncio.create_task(run())
    return await asyncio.shield(_inflight[url])


@router.post("/health/card-status")
async def card_status(body: CardIds, db: Session = Depends(get_db)):
    rows = db.query(Video.id, Video.url, Video.storage_type).filter(Video.id.in_(body.ids)).all()
    async def check(row):
        if not row.url or row.storage_type in ("local", "local_direct", "bittorrent"):
            return str(row.id), "unknown"
        return str(row.id), await _cached_probe(row.url)
    return dict(await asyncio.gather(*(check(row) for row in rows)))
