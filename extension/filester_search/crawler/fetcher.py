from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

import httpx

from .rate_limit import AdaptiveLimiter


@dataclass
class FetchResult:
    url: str
    status: int
    text: str
    headers: dict
    latency_ms: float
    error: Optional[str] = None


class Fetcher:
    def __init__(
        self,
        limiter: AdaptiveLimiter,
        user_agent: str,
        connect_timeout: float = 12.0,
        read_timeout: float = 25.0,
        max_retries: int = 3,
        backoff_base: float = 1.5,
        backoff_cap: float = 60.0,
    ):
        self.limiter = limiter
        self.user_agent = user_agent
        self.timeout = httpx.Timeout(read_timeout, connect=connect_timeout)
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.backoff_cap = backoff_cap
        self._client: Optional[httpx.AsyncClient] = None

    async def start(self) -> None:
        self._client = httpx.AsyncClient(
            headers={
                "User-Agent": self.user_agent,
                "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.8",
            },
            timeout=self.timeout,
            follow_redirects=True,
            http2=False,
            limits=httpx.Limits(max_connections=12, max_keepalive_connections=6),
        )

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def get(self, url: str, etag: str | None = None, last_mod: str | None = None) -> FetchResult:
        assert self._client is not None
        headers = {}
        if etag:
            headers["If-None-Match"] = etag
        if last_mod:
            headers["If-Modified-Since"] = last_mod

        last_err = None
        for attempt in range(self.max_retries + 1):
            await self.limiter.acquire()
            t0 = time.perf_counter()
            try:
                resp = await self._client.get(url, headers=headers)
                latency = (time.perf_counter() - t0) * 1000.0
                status = resp.status_code

                if status == 429:
                    ra = resp.headers.get("Retry-After")
                    wait = float(ra) if ra and ra.isdigit() else min(self.backoff_cap, self.backoff_base ** (attempt + 2))
                    self.limiter.report(ok=False, latency_ms=latency, status=429)
                    self.limiter.release()
                    await asyncio.sleep(wait)
                    continue

                if status in (401, 403):
                    self.limiter.report(ok=False, latency_ms=latency, status=status)
                    self.limiter.release()
                    return FetchResult(url, status, "", dict(resp.headers), latency, error=f"forbidden:{status}")

                if status >= 500:
                    self.limiter.report(ok=False, latency_ms=latency, status=status)
                    self.limiter.release()
                    await asyncio.sleep(min(self.backoff_cap, self.backoff_base ** (attempt + 1)))
                    continue

                # 304 or 2xx
                text = "" if status == 304 else resp.text
                ok = status == 304 or (200 <= status < 400)
                self.limiter.report(ok=ok, latency_ms=latency, status=status)
                self.limiter.release()
                return FetchResult(url, status, text, dict(resp.headers), latency)

            except (httpx.TimeoutException, httpx.TransportError) as exc:
                latency = (time.perf_counter() - t0) * 1000.0
                last_err = str(exc)
                self.limiter.report(ok=False, latency_ms=latency, status=None)
                self.limiter.release()
                await asyncio.sleep(min(self.backoff_cap, self.backoff_base ** (attempt + 1)))
            except Exception as exc:
                latency = (time.perf_counter() - t0) * 1000.0
                last_err = str(exc)
                self.limiter.report(ok=False, latency_ms=latency, status=None)
                self.limiter.release()
                break

        return FetchResult(url, 0, "", {}, 0.0, error=last_err or "fetch_failed")
