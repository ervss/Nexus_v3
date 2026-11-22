"""Per-domain token bucket, leaky spacing, AIMD concurrency, circuit breaker."""
from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from typing import Optional

from .intent import Priority


@dataclass
class _Bucket:
    tokens: float
    capacity: float
    refill_per_sec: float
    last: float


class DomainGate:
    def __init__(
        self,
        domain: str = "default",
        *,
        min_concurrency: int = 2,
        max_concurrency: int = 8,
        base_rate: float = 4.0,
        burst: float = 8.0,
        circuit_threshold: float = 0.35,
        circuit_cooldown: float = 20.0,
        leak_gap: float = 0.08,
        rate: Optional[float] = None,
        min_conc: Optional[int] = None,
        max_conc: Optional[int] = None,
        start_conc: Optional[int] = None,
        fail_threshold: Optional[int] = None,
        open_seconds: Optional[float] = None,
    ) -> None:
        self.domain = (domain or "default").lower()
        refill = float(base_rate if rate is None else rate)
        self._rate = max(0.2, refill)
        self._burst = max(1.0, float(burst))
        self._leak_gap = max(0.0, leak_gap)
        self._min_conc = max(1, int(min_concurrency if min_conc is None else min_conc))
        self._max_conc = max(self._min_conc, int(max_concurrency if max_conc is None else max_conc))
        self._open_seconds = float(circuit_cooldown if open_seconds is None else open_seconds)
        # A circuit opens only after a sustained run of failures.  Do not use
        # the instantaneous failure rate here: after the first failed request
        # it is always 100%, which used to trip the circuit immediately and
        # made all queued requests expire at the gate.
        derived_fails = max(3, int(round(1.0 / max(0.15, float(circuit_threshold)))))
        self._fail_threshold = int(fail_threshold if fail_threshold is not None else derived_fails)
        self._lock = threading.Lock()
        now = time.monotonic()
        self._bucket = _Bucket(tokens=self._burst, capacity=self._burst, refill_per_sec=self._rate, last=now)
        self._last_leak = 0.0
        start = start_conc if start_conc is not None else min(self._max_conc, max(self._min_conc, 2))
        self._conc = max(self._min_conc, min(int(start), self._max_conc))
        self._inflight = 0
        self._fails = 0
        self._successes = 0
        self._open_until = 0.0
        self._half_open = False

    def _now(self) -> float:
        return time.monotonic()

    async def acquire(self, domain: str = "", priority: Priority = Priority.NORMAL, deadline: Optional[float] = None) -> None:
        loop = asyncio.get_running_loop()
        hard = loop.time() + (deadline if deadline is not None else 25.0)
        cost = 0.5 if priority is Priority.HIGH else (1.0 if priority is Priority.NORMAL else 1.4)

        while True:
            remaining = hard - loop.time()
            if remaining <= 0:
                raise TimeoutError(f"NTC domain gate timeout for {self.domain}")

            with self._lock:
                now = self._now()
                wait_open = max(0.0, self._open_until - now)
                if wait_open <= 0 and self._half_open and self._inflight > 0:
                    wait_open = 0.05

                elapsed = now - self._bucket.last
                self._bucket.tokens = min(self._bucket.capacity, self._bucket.tokens + elapsed * self._bucket.refill_per_sec)
                self._bucket.last = now
                token_wait = 0.0
                if self._bucket.tokens < cost:
                    token_wait = (cost - self._bucket.tokens) / self._bucket.refill_per_sec

                leak_wait = max(0.0, self._leak_gap - (now - self._last_leak))
                if priority is Priority.HIGH:
                    leak_wait *= 0.4

                from app.streaming.playback_control import control
                pressure = control.snapshot()
                reserve = priority is not Priority.HIGH and pressure["enabled"] and pressure["active_players"] > 0
                capacity = max(1, self._conc - 1) if reserve else self._conc
                blocked_conc = self._inflight >= capacity

                if wait_open <= 0 and token_wait <= 0 and leak_wait <= 0 and not blocked_conc:
                    self._bucket.tokens -= cost
                    self._last_leak = now
                    self._inflight += 1
                    return

            wait = max(wait_open, token_wait, leak_wait, 0.02 if blocked_conc else 0.0)
            await asyncio.sleep(min(wait, remaining))

    async def release(self, domain: str = "", *, ok: bool, status: Optional[int] = None, throttled: bool = False) -> None:
        with self._lock:
            self._inflight = max(0, self._inflight - 1)
            if throttled or status in (429, 503) or not ok:
                self._fails += 1
                self._conc = max(self._min_conc, int(self._conc / 2) or self._min_conc)
                if self._fails >= self._fail_threshold:
                    self._open_until = self._now() + self._open_seconds
                    self._half_open = True
            else:
                self._successes += 1
                self._fails = 0
                self._open_until = 0.0
                self._half_open = False
                self._conc = min(self._max_conc, self._conc + 1)
