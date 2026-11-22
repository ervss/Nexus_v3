"""Loop-owned, bounded HTTP resources for Discovery Hub index requests."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field
import json
import time
import weakref
from functools import wraps
from urllib.parse import urlsplit

import aiohttp

from .ntc.bunkr_scheduler import get_bunkr_scheduler
from .ntc.intent import RequestIntent


class TTLCache:
    def __init__(self, capacity=2048):
        self.capacity = capacity
        self.entries = OrderedDict()

    def get(self, key):
        entry = self.entries.get(key)
        if entry is None:
            return None
        expires, value = entry
        if expires <= time.monotonic():
            del self.entries[key]
            return None
        self.entries.move_to_end(key)
        return value

    def put(self, key, value, ttl=900):
        now = time.monotonic()
        for stale in [k for k, (expires, _) in self.entries.items() if expires <= now]:
            del self.entries[stale]
        self.entries[key] = (now + ttl, value)
        self.entries.move_to_end(key)
        while len(self.entries) > self.capacity:
            self.entries.popitem(last=False)


@dataclass
class HubResponse:
    status_code: int
    text: str
    headers: dict = field(default_factory=dict)

    def json(self):
        return json.loads(self.text)


DEFAULT_BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}


class HubRuntime:
    def __init__(self):
        self.session = None
        self.stats = TTLCache()
        self.providers = TTLCache(capacity=16)
        self.balbums_pages = TTLCache(capacity=64)
        self.balbums_stale = {}
        self.enrichment = asyncio.Semaphore(4)
        self.stats_slots = asyncio.Semaphore(4)
        self.pending_http = 0
        # The pass cookie is ignored on aiohttp's TLS fingerprint. Keep the
        # browser client that earned it, and prefer it until the cookie ages out.
        self.balbums_browser = None
        self.balbums_browser_until = 0.0
        self.balbums_pass_lock = None

    def _remember_balbums(self, cache_key, response, max_bytes):
        from .balbums_checkpoint import is_blocked_listing
        if cache_key is None or response.status_code != 200:
            return
        if len(response.text.encode("utf-8")) > max_bytes or "</html>" not in response.text.lower():
            return
        if is_blocked_listing(response.text):
            return
        self.balbums_pages.put(cache_key, response, ttl=600)
        self.balbums_stale[cache_key] = response

    def _pass_lock(self):
        if self.balbums_pass_lock is None:
            self.balbums_pass_lock = asyncio.Lock()
        return self.balbums_pass_lock

    def _browser_session(self):
        if self.balbums_browser is None:
            from curl_cffi.requests import AsyncSession
            self.balbums_browser = AsyncSession(impersonate="chrome131")
        return self.balbums_browser

    async def _browser_send(self, session, method, url, referer, timeout, max_bytes, payload=None):
        async def transport():
            headers = {"Referer": referer}
            if method == "POST":
                headers["Origin"] = "https://balbums.st"
                headers["Accept"] = "*/*"
                response = await session.post(url, json=payload, headers=headers, timeout=timeout)
            else:
                headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                response = await session.get(url, headers=headers, timeout=timeout)
            text = response.text or ""
            if len(text.encode("utf-8")) > max_bytes:
                raise ValueError("Index response exceeds size limit")
            return HubResponse(response.status_code, text, {key: value for key, value in response.headers.items()})

        return await get_bunkr_scheduler().run(RequestIntent(url=url, deadline=timeout), transport)

    async def _recover_balbums(self, url, timeout, max_bytes, seed_html):
        from .balbums_checkpoint import captcha_png, is_sentinel, parse_challenge, read_captcha, retry_challenge, solution
        async with self._pass_lock():
            session = self._browser_session()
            current = await self._browser_send(session, "GET", url, url, timeout, max_bytes)
            if current.status_code == 200 and not is_sentinel(current.text):
                self.balbums_browser_until = time.monotonic() + 3500
                return current
            challenge = parse_challenge(current.text if is_sentinel(current.text) else seed_html)
            for _ in range(4):
                if not challenge:
                    return None
                png = captcha_png(challenge)
                typed = await asyncio.to_thread(read_captcha, png) if png else None
                if png and not typed:
                    return None
                posted = await self._browser_send(
                    session, "POST", "https://balbums.st/.well-known/checkpoint",
                    url, timeout, max_bytes, solution(challenge, typed),
                )
                if posted.status_code == 204:
                    break
                challenge = retry_challenge(posted.text)
            else:
                return None
            listing = await self._browser_send(session, "GET", url, url, timeout, max_bytes)
            if listing.status_code == 200 and not is_sentinel(listing.text):
                self.balbums_browser_until = time.monotonic() + 3500
                return listing
            return None

    async def get(self, url, *, params=None, headers=None, timeout=12, accepted=(200,), max_bytes=8 * 1024 * 1024):
        # Public listings only: avoid repeatedly downloading the same slow page.
        is_balbums = urlsplit(url).hostname == "balbums.st"
        cache_key = (url, tuple(sorted((str(k), str(v)) for k, v in (params or {}).items()))) if is_balbums else None
        cached = self.balbums_pages.get(cache_key) if cache_key is not None else None
        if cached is not None and cached.status_code in accepted and len(cached.text.encode("utf-8")) <= max_bytes:
            return cached

        if is_balbums:
            req_headers = dict(DEFAULT_BROWSER_HEADERS)
            if headers:
                for k, v in headers.items():
                    if k.lower() == "user-agent" and "Nexus" in str(v):
                        continue
                    req_headers[k] = v
        else:
            req_headers = headers

        if self.pending_http >= 128:
            raise RuntimeError("Discovery Hub je vyťažený; skús to znova.")
        self.pending_http += 1
        try:
            async with asyncio.timeout(timeout):
                if self.session is None or self.session.closed:
                    self.session = aiohttp.ClientSession(
                        connector=aiohttp.TCPConnector(limit=16, limit_per_host=4, ttl_dns_cache=300),
                        cookie_jar=aiohttp.DummyCookieJar(),
                    )

                async def transport():
                    async with self.session.get(
                        url, params=params, headers=req_headers,
                        # Fail stalled connection establishment early so the
                        # scheduler can retry within the outer total deadline.
                        timeout=aiohttp.ClientTimeout(total=timeout, sock_connect=min(5, timeout)),
                    ) as response:
                        if response.content_length and response.content_length > max_bytes:
                            raise ValueError("Index response exceeds size limit")
                        chunks = bytearray()
                        async for chunk in response.content.iter_chunked(65536):
                            chunks.extend(chunk)
                            if len(chunks) > max_bytes:
                                raise ValueError("Index response exceeds size limit")
                        return HubResponse(response.status, chunks.decode(response.charset or "utf-8", errors="replace"), dict(response.headers))

                # Share admission/rate/cooldown with existing Bunkr traffic.
                # A live pass cookie still draws a checkpoint from this client, so
                # skip it while the browser session that solved the check is valid.
                if is_balbums and time.monotonic() < self.balbums_browser_until:
                    response = await self._recover_balbums(url, timeout, max_bytes, "")
                    if response is None:
                        self.balbums_browser_until = 0.0
                        raise RuntimeError(f"{urlsplit(url).hostname}: HTTP 403")
                else:
                    response = await get_bunkr_scheduler().run(RequestIntent(url=url, deadline=timeout), transport)
                    if is_balbums and response.status_code == 403:
                        from .balbums_checkpoint import is_sentinel
                        if is_sentinel(response.text):
                            response = await self._recover_balbums(url, timeout, max_bytes, response.text)
                            if response is None:
                                raise RuntimeError(f"{urlsplit(url).hostname}: HTTP 403")
                if response.status_code not in accepted:
                    raise RuntimeError(f"{urlsplit(url).hostname}: HTTP {response.status_code}")
                self._remember_balbums(cache_key, response, max_bytes)
                return response
        except Exception:
            if cache_key is not None and cache_key in self.balbums_stale:
                return self.balbums_stale[cache_key]
            raise
        finally:
            self.pending_http -= 1

    async def close(self):
        if self.session is not None:
            await self.session.close()
            self.session = None
        browser = self.balbums_browser
        self.balbums_browser = None
        if browser is not None:
            result = browser.close()
            if asyncio.iscoroutine(result):
                await result


_runtimes = weakref.WeakKeyDictionary()


def hub_runtime():
    loop = asyncio.get_running_loop()
    if loop not in _runtimes:
        _runtimes[loop] = HubRuntime()
    return _runtimes[loop]


async def hub_get(url, **kwargs):
    return await hub_runtime().get(url, **kwargs)


async def close_hub_runtime():
    runtime = _runtimes.pop(asyncio.get_running_loop(), None)
    if runtime:
        await runtime.close()


def hub_deadline(seconds):
    def decorate(fn):
        @wraps(fn)
        async def wrapped(*args, **kwargs):
            from fastapi import HTTPException
            try:
                async with asyncio.timeout(seconds):
                    return await fn(*args, **kwargs)
            except TimeoutError as exc:
                raise HTTPException(504, "Zdroj nestihol odpovedať. Skús to znova.") from exc
        return wrapped
    return decorate
