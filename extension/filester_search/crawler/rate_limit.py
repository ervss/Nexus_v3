from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field


@dataclass
class AdaptiveLimiter:
    """
    Token-bucket RPS + adaptive concurrency.
    Increases concurrency when healthy; shrinks on 429 / high latency / errors.
    """
    max_rps: float = 1.5
    min_rps: float = 0.3
    concurrency: int = 2
    min_concurrency: int = 1
    max_concurrency: int = 6
    latency_high_ms: float = 2500.0
    window: int = 20

    _tokens: float = field(default=0.0, init=False)
    _last: float = field(default_factory=time.monotonic, init=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False)
    _sema: asyncio.Semaphore = field(init=False)
    _latencies: deque = field(default_factory=lambda: deque(maxlen=20), init=False)
    _outcomes: deque = field(default_factory=lambda: deque(maxlen=20), init=False)  # 1 ok, 0 fail
    _current_rps: float = field(init=False)

    def __post_init__(self) -> None:
        self._tokens = float(self.max_rps)
        self._current_rps = self.max_rps
        self._sema = asyncio.Semaphore(self.concurrency)

    async def acquire(self) -> None:
        await self._sema.acquire()
        async with self._lock:
            while True:
                now = time.monotonic()
                elapsed = now - self._last
                self._tokens = min(self._current_rps, self._tokens + elapsed * self._current_rps)
                self._last = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                wait = (1.0 - self._tokens) / max(self._current_rps, 0.01)
                await asyncio.sleep(min(wait, 1.0))

    def release(self) -> None:
        self._sema.release()

    def report(self, *, ok: bool, latency_ms: float, status: int | None = None) -> None:
        self._latencies.append(latency_ms)
        self._outcomes.append(1 if ok else 0)

        # hard signals
        if status == 429 or status == 503:
            self._shrink(hard=True)
            return
        if status == 403 or status == 401:
            self._shrink(hard=True)
            return

        if len(self._outcomes) < 5:
            return

        err_rate = 1.0 - (sum(self._outcomes) / len(self._outcomes))
        avg_lat = sum(self._latencies) / max(1, len(self._latencies))

        if err_rate > 0.25 or avg_lat > self.latency_high_ms:
            self._shrink(hard=False)
        elif err_rate < 0.05 and avg_lat < self.latency_high_ms * 0.5:
            self._grow()

    def _shrink(self, hard: bool) -> None:
        if hard:
            self.concurrency = self.min_concurrency
            self._current_rps = max(self.min_rps, self._current_rps * 0.4)
        else:
            self.concurrency = max(self.min_concurrency, self.concurrency - 1)
            self._current_rps = max(self.min_rps, self._current_rps * 0.7)
        self._rebuild_sema()

    def _grow(self) -> None:
        if self.concurrency < self.max_concurrency:
            self.concurrency += 1
            self._rebuild_sema()
        self._current_rps = min(self.max_rps, self._current_rps * 1.1)

    def _rebuild_sema(self) -> None:
        # best-effort: new semaphore; inflight holders still release old one
        self._sema = asyncio.Semaphore(self.concurrency)

    @property
    def stats(self) -> dict:
        avg_lat = (sum(self._latencies) / len(self._latencies)) if self._latencies else 0.0
        ok_rate = (sum(self._outcomes) / len(self._outcomes)) if self._outcomes else 1.0
        return {
            "concurrency": self.concurrency,
            "rps_target": round(self._current_rps, 2),
            "avg_latency_ms": round(avg_lat, 1),
            "ok_rate": round(ok_rate, 3),
        }
