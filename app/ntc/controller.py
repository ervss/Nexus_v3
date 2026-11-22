"""Nexus Traffic Controller: gated, coalesced, cached HTTP fetches."""
from __future__ import annotations

import asyncio
import logging
import time
import json as json_module
import weakref
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Tuple
from urllib.parse import urlparse

from .coalesce import Coalescer
from .domain_gate import DomainGate
from .exit_pool import Exit, ExitPool
from .intent import Priority, RequestIntent

logger = logging.getLogger(__name__)

DEFAULT_CACHE_TTL = 150.0

STRICT = {
    "pornhub.com", "xvideos.com", "xhamster.com", "camwhores.tv",
    "eporner.com", "spankbang.com", "redtube.com", "youporn.com",
}
MEDIUM = {
    "bunkr.cr", "bunkr.si", "bunkr.pk", "bunkr.ru", "bunkrr.su",
    "gofile.io", "cyberdrop.me", "pixeldrain.com",
}


class NTCStatusError(Exception):
    def __init__(self, message: str, status_code: int = 0, url: str = "", text: str = "", cookies: Optional[Dict[str, str]] = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.url = url
        self.text = text
        self.cookies = cookies or {}


@dataclass
class NTCResponse:
    text: str
    status_code: int
    url: str
    headers: Dict[str, str] = field(default_factory=dict)
    cookies: Dict[str, str] = field(default_factory=dict)


class NexusTrafficController:
    def __init__(self, cache_ttl: float = DEFAULT_CACHE_TTL) -> None:
        self.gates: Dict[str, DomainGate] = {}
        self.exits = ExitPool()
        self.coalescer = Coalescer()
        self.cache_ttl = cache_ttl
        self._cache: Dict[Tuple, Tuple[float, NTCResponse]] = {}
        self._bunkr_sessions = weakref.WeakKeyDictionary()

    @asynccontextmanager
    async def _curl_session(self, intent, persona, timeout, proxy):
        from curl_cffi.requests import AsyncSession
        from .bunkr_scheduler import is_bunkr_host
        if not is_bunkr_host(urlparse(intent.url).hostname or ""):
            async with AsyncSession(impersonate=persona, timeout=timeout, verify=False) as session:
                yield session
            return
        pool = self._bunkr_sessions.setdefault(asyncio.get_running_loop(), {})
        key = (persona, proxy, tuple(sorted((intent.cookies or {}).items())))
        session = pool.get(key)
        if session is None:
            session = pool[key] = AsyncSession(impersonate=persona, timeout=timeout, verify=False, max_clients=16)
        yield session

    async def close(self):
        pool = self._bunkr_sessions.pop(asyncio.get_running_loop(), {})
        await asyncio.gather(*(session.close() for session in pool.values()), return_exceptions=True)

    def _gate(self, domain: str) -> DomainGate:
        domain = (domain or "default").lower()
        if domain.startswith("www."):
            domain = domain[4:]
        if domain not in self.gates:
            if domain in STRICT:
                self.gates[domain] = DomainGate(
                    domain, min_concurrency=1, max_concurrency=5,
                    base_rate=1.8, burst=4, circuit_threshold=0.40, circuit_cooldown=30.0,
                )
            elif domain in MEDIUM or domain.startswith("bunkr"):
                self.gates[domain] = DomainGate(
                    domain, min_concurrency=2, max_concurrency=9,
                    base_rate=3.5, burst=7, circuit_threshold=0.35, circuit_cooldown=20.0,
                )
            else:
                self.gates[domain] = DomainGate(
                    domain, min_concurrency=2, max_concurrency=14,
                    base_rate=6.0, burst=12, circuit_threshold=0.30, circuit_cooldown=15.0,
                )
        return self.gates[domain]

    def _domain_from(self, url: str, domain: Optional[str]) -> str:
        if domain:
            return domain.lower().strip()
        host = (urlparse(url).hostname or "default").lower()
        if host.startswith("www."):
            host = host[4:]
        return host or "default"

    def _cache_get(self, key: Tuple) -> Optional[NTCResponse]:
        item = self._cache.get(key)
        if not item:
            return None
        expires, resp = item
        if time.monotonic() >= expires:
            self._cache.pop(key, None)
            return None
        return resp

    def _cache_put(self, key: Tuple, resp: NTCResponse) -> None:
        if self.cache_ttl <= 0:
            return
        self._cache[key] = (time.monotonic() + self.cache_ttl, resp)

    async def _transport(self, intent: RequestIntent, exit: Exit) -> NTCResponse:
        from app.streaming.playback_control import control, interactive
        from .bunkr_scheduler import fetch_priority, retry_after
        token = interactive.set(interactive.get() or intent.priority is Priority.HIGH
                                or fetch_priority.get() == "high")
        try:
            async with control.background(intent.url, lane="network"):
                response = await asyncio.wait_for(self._transport_raw(intent, exit), max(1.0, intent.deadline))
                control.cooldown(intent.url, response.status_code, retry_after(response.headers) or 30)
                return response
        finally:
            interactive.reset(token)

    async def _transport_raw(self, intent: RequestIntent, exit: Exit) -> NTCResponse:
        timeout = max(1.0, float(intent.deadline or 25.0))
        method = (intent.method or "GET").upper()
        headers = dict(intent.headers or {})
        cookies = dict(intent.cookies or {})
        persona = intent.impersonate or exit.persona or "chrome120"
        proxy = exit.proxy

        try:
            from curl_cffi.requests import AsyncSession

            async with self._curl_session(intent, persona, timeout, proxy) as session:
                resp = await session.request(
                    method,
                    intent.url,
                    headers=headers or None,
                    cookies=cookies or None,
                    data=intent.data,
                    json=intent.json,
                    proxy=proxy,
                    timeout=timeout,
                    allow_redirects=True,
                )
                cookie_map = {}
                try:
                    cookie_map = {k: v for k, v in resp.cookies.items()}
                except Exception:
                    cookie_map = {}
                return NTCResponse(
                    text=resp.text or "",
                    status_code=int(resp.status_code or 0),
                    url=str(getattr(resp, "url", None) or intent.url),
                    headers={str(k): str(v) for k, v in dict(resp.headers or {}).items()},
                    cookies=cookie_map,
                )
        except Exception as cffi_exc:
            logger.debug("NTC curl_cffi failed, falling back to httpx: %s", cffi_exc)

        import httpx

        client_kwargs: Dict[str, Any] = {"timeout": timeout, "verify": False, "follow_redirects": True}
        if proxy:
            client_kwargs["proxy"] = proxy
        try:
            client = httpx.AsyncClient(**client_kwargs)
        except TypeError:
            client_kwargs.pop("proxy", None)
            if proxy:
                client_kwargs["proxies"] = proxy
            client = httpx.AsyncClient(**client_kwargs)
        async with client:
            resp = await client.request(
                method,
                intent.url,
                headers=headers or None,
                cookies=cookies or None,
                content=intent.data,
                json=intent.json,
            )
            return NTCResponse(
                text=resp.text or "",
                status_code=int(resp.status_code or 0),
                url=str(resp.url),
                headers={str(k): str(v) for k, v in resp.headers.items()},
                cookies=dict(resp.cookies),
            )

    async def request(
        self,
        url: str,
        *,
        domain: Optional[str] = None,
        priority: Any = "normal",
        deadline: float = 25.0,
        method: str = "GET",
        headers: Optional[Mapping[str, str]] = None,
        cookies: Optional[Mapping[str, str]] = None,
        data: Any = None,
        json: Any = None,
        sticky_key: Optional[str] = None,
        impersonate: Optional[str] = None,
        cache: bool = True,
        idempotent: bool = False,
        **_: Any,
    ) -> NTCResponse:
        from app.streaming.playback_control import interactive
        from .bunkr_scheduler import fetch_priority
        effective_priority = (Priority.HIGH if interactive.get() or fetch_priority.get() == "high"
                              else Priority.parse(priority))
        intent = RequestIntent(
            url=url,
            domain=self._domain_from(url, domain),
            method=method,
            headers=headers,
            cookies=cookies,
            data=data,
            json=json,
            priority=effective_priority,
            deadline=deadline,
            sticky_key=sticky_key,
            impersonate=impersonate,
            cache=cache,
        )
        cache_key = self.coalescer.key(intent.method, intent.url, intent.headers)
        cache_key += (tuple(sorted((intent.cookies or {}).items())),
                      json_module.dumps(json, sort_keys=True, default=str), str(data or ""))
        if intent.cache and intent.method.upper() == "GET":
            hit = self._cache_get(cache_key)
            if hit is not None:
                return hit

        async def _run() -> NTCResponse:
            from .bunkr_scheduler import get_bunkr_scheduler, is_bunkr_host
            # Use the URL host, never a caller's historical bunkr.cr override.
            if is_bunkr_host(urlparse(intent.url).hostname or ""):
                async def transport():
                    exit = self.exits.pick(sticky_key=intent.sticky_key, impersonate=intent.impersonate)
                    try:
                        response = await self._transport(intent, exit)
                        self.exits.report(exit, status=response.status_code,
                                          ok=200 <= response.status_code < 400, timeout=False)
                        return response
                    except Exception:
                        self.exits.report(exit, ok=False, timeout=True)
                        raise
                transport.admission_managed = True
                response = await get_bunkr_scheduler().run(
                    intent, transport, attempts=3 if intent.method.upper() == "GET" or idempotent else 1)
                if intent.cache and intent.method.upper() == "GET" and 200 <= response.status_code < 400:
                    self._cache_put(cache_key, response)
                return response
            gate = self._gate(intent.domain or "default")
            await gate.acquire(intent.domain or "default", intent.priority, deadline=intent.deadline)
            ok = False
            status: Optional[int] = None
            throttled = False
            timed_out = False
            exit = None
            try:
                exit = self.exits.pick(sticky_key=intent.sticky_key, impersonate=intent.impersonate)
                resp = await self._transport(intent, exit)
                status = resp.status_code
                throttled = status in (429, 503)
                ok = 200 <= status < 400
                self.exits.report(exit, status=status, ok=ok, timeout=False)
                if ok and intent.cache and intent.method.upper() == "GET":
                    self._cache_put(cache_key, resp)
                return resp
            except asyncio.TimeoutError:
                timed_out = True
                if exit is not None:
                    self.exits.report(exit, ok=False, timeout=True)
                raise TimeoutError(f"NTC deadline exceeded for {intent.url}")
            except NTCStatusError:
                raise
            except Exception:
                if exit is not None:
                    self.exits.report(exit, ok=False, timeout=False)
                raise
            finally:
                await gate.release(
                    intent.domain or "default",
                    ok=ok,
                    status=status,
                    throttled=throttled or timed_out,
                )

        if intent.method.upper() == "GET" or idempotent:
            # A playback request must not inherit a background subscriber's
            # lower queue priority. The response cache still shares safe hits.
            return await self.coalescer.do(cache_key + (intent.priority,), _run)
        return await _run()

    async def fetch(
        self,
        url: str,
        domain: Optional[str] = None,
        priority: Any = "normal",
        deadline: float = 25.0,
        **kwargs: Any,
    ) -> str:
        resp = await self.request(url, domain=domain, priority=priority, deadline=deadline, **kwargs)
        if not (200 <= resp.status_code < 400):
            raise NTCStatusError(
                f"NTC HTTP {resp.status_code} for {url}",
                status_code=resp.status_code,
                url=url,
                text=resp.text,
                cookies=resp.cookies,
            )
        return resp.text


ntc = NexusTrafficController()
