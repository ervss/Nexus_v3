import asyncio
import random
import time
from collections import defaultdict
from urllib.parse import urlparse


class DomainRateLimiter:
    """Global rate limiter for scraper requests across discovery metadata enrichment."""

    def __init__(self, max_concurrent: int = 5) -> None:
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._last_request_ts = defaultdict(float)
        self._extra_penalty = defaultdict(float)
        self._lock = asyncio.Lock()
        self._base_delays = {
            "eporner.com": 6.0,
            "porntrex.com": 7.0,
            "whoreshub.com": 7.0,
            "ixxx.com": 7.0,
        }
        self._default_delay = 4.0

    def normalize_domain(self, url: str) -> str:
        host = (urlparse(url or "").hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        return host or "unknown"

    def get_min_delay(self, domain: str) -> float:
        if not domain or domain == "unknown":
            return self._default_delay
        if domain in self._base_delays:
            return self._base_delays[domain]
        # Subdomain handling (e.g. cdn.eporner.com)
        for key, value in self._base_delays.items():
            if domain.endswith(f".{key}"):
                return value
        return self._default_delay

    async def acquire(self, url: str) -> tuple[str, float]:
        """
        Reserve one request slot and wait until per-domain delay window passes.
        Returns (domain, slept_seconds).
        """
        domain = self.normalize_domain(url)
        await self._semaphore.acquire()
        waited = 0.0
        try:
            async with self._lock:
                now = time.monotonic()
                base = self.get_min_delay(domain)
                penalty = self._extra_penalty[domain]
                jitter = random.uniform(0.5, 2.5)
                min_gap = base + penalty + jitter
                delta = now - self._last_request_ts[domain]
                sleep_for = max(0.0, min_gap - delta)
                if sleep_for > 0:
                    waited = sleep_for
            if waited > 0:
                await asyncio.sleep(waited)
            async with self._lock:
                self._last_request_ts[domain] = time.monotonic()
            return domain, waited
        except Exception:
            self._semaphore.release()
            raise

    def release(self) -> None:
        self._semaphore.release()

    async def penalize_domain(self, domain: str, extra_seconds: float = 4.0) -> None:
        """
        Increase delay for domain after rate-limit/overload response.
        """
        if not domain:
            return
        async with self._lock:
            self._extra_penalty[domain] = min(30.0, self._extra_penalty[domain] + max(0.0, extra_seconds))

    async def report_success(self, domain: str, decay: float = 0.5) -> None:
        """
        Multiplicative decrease of the accumulated penalty after a clean request
        (AIMD: additive increase on failure via penalize_domain, multiplicative
        decrease here). Lets a domain recover speed once its CDN cools down,
        instead of staying slow forever after a single 429/509.

        main.py and system_health.py already call report_success()/snapshot();
        they were previously missing here and raised AttributeError at runtime.
        """
        if not domain:
            return
        async with self._lock:
            current = self._extra_penalty.get(domain, 0.0)
            if current <= 0.01:
                self._extra_penalty[domain] = 0.0
            else:
                self._extra_penalty[domain] = max(0.0, current * max(0.0, min(1.0, decay)))

    def snapshot(self) -> dict:
        """Point-in-time view of per-domain limiter state for the health UI."""
        now = time.monotonic()
        out = {}
        for domain, last_ts in self._last_request_ts.items():
            out[domain] = {
                "min_delay": round(self.get_min_delay(domain), 2),
                "penalty": round(self._extra_penalty.get(domain, 0.0), 2),
                "since_last_request_s": round(now - last_ts, 2) if last_ts else None,
            }
        for domain, penalty in self._extra_penalty.items():
            if domain not in out:
                out[domain] = {
                    "min_delay": round(self.get_min_delay(domain), 2),
                    "penalty": round(penalty, 2),
                    "since_last_request_s": None,
                }
        return out

    async def run(self, url: str, coro_factory, *, retries: int = 3, base_backoff: float = 2.0):
        """
        Centralized acquire → run → retry wrapper for scraper calls.

        `coro_factory` is a zero-arg callable returning a fresh awaitable each
        attempt (so retries re-issue the request). On a rate-limit style error
        (429/509/"too many requests") the domain is penalized and the attempt is
        retried with exponential backoff; a clean result reports success so the
        penalty decays. Raises the last error if all attempts fail. Guarantees
        release() runs even on error.
        """
        domain = self.normalize_domain(url)
        last_err = None
        for attempt in range(1, max(1, retries) + 1):
            await self.acquire(url)
            try:
                result = await coro_factory()
                await self.report_success(domain)
                return result
            except Exception as e:  # noqa: BLE001 - classify then re-raise if terminal
                last_err = e
                msg = str(e).lower()
                is_rate_limited = ("429" in msg) or ("509" in msg) or ("too many requests" in msg)
                await self.penalize_domain(domain, extra_seconds=6.0 if is_rate_limited else 2.0)
                if attempt >= retries:
                    break
                backoff = base_backoff * (2 ** (attempt - 1)) + random.uniform(0, 1.0)
                await asyncio.sleep(backoff)
            finally:
                self.release()
        if last_err:
            raise last_err
        return None
