"""One admission budget for Bunkr HTML and read-only stream API requests.

Queue time is not network time. Family/host permits are acquired together and
held until transport ends. No per-album semaphore can multiply this budget.
"""
from __future__ import annotations

import asyncio
import random
import time
import weakref
from contextvars import ContextVar
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

from .intent import Priority

BUNKR_HOSTS = frozenset({
    "balbums.st", "bunkr.site", "bunkr.red", "bunkr.la", "bunkr.si",
    "bunkr.is", "bunkr-albums.io", "bunkr.cr", "bunkr.black", "bunkr.su",
    "bunkr.pk", "bunkrr.su", "bunkr.ws", "bunkr.vc", "bunkr.media",
    "bunkr.ru", "bunkr.to", "bunkr.ac", "bunkr.ph", "bunkr.sk",
    "bunkr.ps", "bunkr.fi", "bunkrr.pics",
})
fetch_priority: ContextVar[str] = ContextVar("bunkr_fetch_priority", default="normal")
fetch_durable: ContextVar[bool] = ContextVar("bunkr_fetch_durable", default=False)


class DeferredFetch(Exception):
    def __init__(self, retry_at, message="Provider cooling down"):
        super().__init__(message)
        self.retry_at = retry_at


def is_bunkr_host(host: str) -> bool:
    return str(host or "").lower().removeprefix("www.") in BUNKR_HOSTS


def retry_after(headers: dict) -> float:
    raw = next((str(v) for k, v in headers.items() if k.lower() == "retry-after"), "")
    try:
        return max(0.0, min(3600.0, float(raw)))
    except ValueError:
        try:
            return max(0.0, min(3600.0, parsedate_to_datetime(raw).timestamp() - time.time()))
        except (ValueError, TypeError, OverflowError):
            return 0.0


@dataclass
class _Host:
    limit: int = 2
    active: int = 0
    cooldown: float = 0.0
    successes: int = 0


class BunkrScheduler:
    def __init__(self, *, concurrency=14, rate=10.0, burst=10, host_cap=8,
                 queue_timeout=600.0, max_waiters=512):
        self.concurrency = concurrency
        self.rate = rate
        self.burst = burst
        self.host_cap = host_cap
        self.queue_timeout = queue_timeout
        self.max_waiters = max_waiters
        self.active = 0
        self.peak_active = 0
        self.starts = 0
        self.retries = 0
        self.tokens = float(burst)
        self.refilled = time.monotonic()
        self.hosts: dict[str, _Host] = {}
        self.waiters: list[tuple] = []
        self.changed = asyncio.Condition()
        self.sequence = 0

    def _host_state(self, host: str) -> _Host:
        state = self.hosts.get(host)
        if state is None:
            # Start near the cap. A 429/503 still halves the host and cools it
            # down, so a gallery fetch does not crawl at 2-wide until 20 successes.
            state = self.hosts[host] = _Host(limit=min(6, self.host_cap))
        return state

    async def acquire(self, host: str, priority: Priority) -> None:
        host = host.lower().removeprefix("www.")
        rank = {Priority.HIGH: 0, Priority.NORMAL: 1, Priority.LOW: 2}[priority]
        async with self.changed:
            if len(self.waiters) >= self.max_waiters:
                raise TimeoutError("Bunkr queue capacity reached; retry later")
            self.sequence += 1
            queued = time.monotonic()
            ticket = (rank, self.sequence, queued, host)
            self.waiters.append(ticket)
            try:
                while True:
                    now = time.monotonic()
                    if now - queued >= self.queue_timeout:
                        raise TimeoutError("Bunkr admission wait exceeded")
                    self.tokens = min(self.burst, self.tokens + (now - self.refilled) * self.rate)
                    self.refilled = now
                    state = self._host_state(host)
                    from app.streaming.playback_control import control
                    pressure = control.snapshot()
                    playback_active = pressure["enabled"] and pressure["active_players"] > 0
                    background_cap = max(1, self.concurrency - 2) if playback_active else self.concurrency
                    if fetch_durable.get() and state.cooldown > now:
                        raise DeferredFetch(time.time() + state.cooldown-now)
                    # Blocked hosts cannot prevent another host from using a slot.
                    eligible = [t for t in self.waiters
                                if self.active < (self.concurrency if t[0] == 0 else background_cap)
                                and self._host_state(t[3]).active < (
                                    self._host_state(t[3]).limit if t[0] == 0 or not playback_active
                                    else max(1, self._host_state(t[3]).limit - 1))
                                and self._host_state(t[3]).cooldown <= now]
                    first = min(eligible, key=lambda t: (max(0, t[0] - int((now-t[2])/15)), t[1])) if eligible else None
                    if first == ticket and self.active < self.concurrency and self.tokens >= 1:
                        self.tokens -= 1
                        self.active += 1
                        state.active += 1
                        self.starts += 1
                        self.peak_active = max(self.peak_active, self.active)
                        return
                    delay = min(0.5, max(0.01, (1-self.tokens)/self.rate))
                    try:
                        await asyncio.wait_for(self.changed.wait(), delay)
                    except asyncio.TimeoutError:
                        pass
            finally:
                self.waiters.remove(ticket)
                self.changed.notify_all()

    async def release(self, host: str, *, status=0, failed=False, cooldown=0.0):
        async with self.changed:
            state = self.hosts[host.lower().removeprefix("www.")]
            self.active -= 1
            state.active -= 1
            if failed or status in (429, 503):
                state.limit = max(1, state.limit // 2)
                state.successes = 0
                state.cooldown = max(state.cooldown, time.monotonic() + max(1.0, cooldown))
            elif 200 <= status < 400:
                state.successes += 1
                if state.successes >= 20:
                    state.limit = min(self.host_cap, state.limit + 1)
                    state.successes = 0
            self.changed.notify_all()

    async def run(self, intent, transport, *, attempts=3):
        host = urlsplit(intent.url).hostname or ""
        priority = intent.priority
        if priority is Priority.NORMAL:
            priority = Priority.parse(fetch_priority.get())
        if fetch_durable.get():
            attempts = 1
        for attempt in range(attempts):
            # Admission may wait, but attempt timeout starts only after admission.
            await self.acquire(host, priority)
            response = None
            failed = False
            cooldown = 0.0
            try:
                if getattr(transport, "admission_managed", False) is True:
                    response = await transport()
                else:
                    response = await asyncio.wait_for(transport(), max(0.01, intent.deadline))
                cooldown = retry_after(response.headers) if response.status_code in (429, 503) else 0.0
            except asyncio.CancelledError:
                raise
            except Exception:
                failed = True
                if attempt + 1 == attempts:
                    raise
            finally:
                await self.release(host, status=response.status_code if response else 0,
                                   failed=failed, cooldown=cooldown)
            if response is not None and response.status_code not in (429, 500, 502, 503, 504):
                return response
            if fetch_durable.get() and response is not None and response.status_code in (429, 503):
                raise DeferredFetch(time.time()+max(1.0, cooldown), f"Bunkr HTTP {response.status_code}; cooling down")
            if attempt + 1 == attempts:
                return response
            self.retries += 1
            await asyncio.sleep(max(cooldown, random.uniform(0.2, min(8.0, 2 ** (attempt+1)))))

    def snapshot(self):
        return {"active": self.active, "queued": len(self.waiters), "starts": self.starts,
                "retries": self.retries, "peak_active": self.peak_active,
                "hosts": {k: {"active": v.active, "limit": v.limit,
                              "cooldown_seconds": max(0, v.cooldown-time.monotonic())}
                          for k, v in self.hosts.items()}}


# Event-loop owned primitives: tests and auxiliary loops must not reuse locks
# bound to a previously closed loop. Production runs one fetch-owning loop.
_schedulers = weakref.WeakKeyDictionary()


def get_bunkr_scheduler():
    loop = asyncio.get_running_loop()
    if loop not in _schedulers:
        _schedulers[loop] = BunkrScheduler()
    return _schedulers[loop]
