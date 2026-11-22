"""Process-local playback pressure, shared across asyncio and thumbnail loops.

Leases expire when a tab disappears. Admission never cancels running work and
never holds a threading lock across an await. Existing provider gates still apply.
"""
from __future__ import annotations

import asyncio
import os
import threading
import time
from contextlib import asynccontextmanager
from contextvars import ContextVar
from urllib.parse import urlsplit

interactive = ContextVar("playback_interactive", default=False)
_background_owner = ContextVar("playback_background_owner", default=None)
_network_owner = ContextVar("playback_network_owner", default=None)


class PlaybackControl:
    def __init__(self, *, clock=time.monotonic, lease_seconds=20.0):
        self.clock = clock
        self.lease_seconds = lease_seconds
        self.lock = threading.Lock()
        self.leases = {}
        self.cooldowns = {}
        self.active = 0
        self.network_active = 0
        self.waiting = 0
        self.admitted = 0
        self.wait_ms = 0.0

    @staticmethod
    def host(url):
        return (urlsplit(url).hostname or "").lower().removeprefix("www.")

    def _prune(self):
        now = self.clock()
        self.leases = {key: row for key, row in self.leases.items()
                       if now - row["seen"] < self.lease_seconds}
        self.cooldowns = {host: until for host, until in self.cooldowns.items() if until > now}

    def _limit(self):
        if os.getenv("NEXUS_PLAYBACK_PRIORITY", "1") == "0":
            return 8
        phases = {row["phase"] for row in self.leases.values()}
        if phases & {"loading", "buffering", "recovering"}:
            return 1
        return 2 if "playing" in phases else 8

    def report(self, key, phase, video_id=0):
        with self.lock:
            self._prune()
            if phase in {"paused", "stopped", "ended", "error"}:
                self.leases.pop(key, None)
            else:
                if key not in self.leases and len(self.leases) >= 128:
                    self.leases.pop(min(self.leases, key=lambda k: self.leases[k]["seen"]))
                self.leases[key] = {"seen": self.clock(), "phase": phase, "video_id": video_id}
            return self._snapshot()

    def cooldown(self, url, status, seconds=30.0):
        if status not in (429, 503):
            return
        host = self.host(url)
        if not host:
            return
        with self.lock:
            self._prune()
            if len(self.cooldowns) >= 1024 and host not in self.cooldowns:
                self.cooldowns.pop(min(self.cooldowns, key=self.cooldowns.get))
            self.cooldowns[host] = max(self.cooldowns.get(host, 0),
                                       self.clock() + max(1, min(3600, seconds)))

    def remaining(self, url):
        with self.lock:
            return max(0.0, self.cooldowns.get(self.host(url), 0) - self.clock())

    async def wait_host(self, url, timeout=65.0):
        deadline = self.clock() + timeout
        while (delay := self.remaining(url)) > 0:
            if self.clock() + delay > deadline:
                raise TimeoutError("Provider cooldown exceeds request budget")
            await asyncio.sleep(min(delay, 0.25))

    def _snapshot(self):
        return {"enabled": os.getenv("NEXUS_PLAYBACK_PRIORITY", "1") != "0",
                "active_players": len(self.leases), "background_limit": self._limit(),
                "background_active": self.active, "background_waiting": self.waiting,
                "network_background_active": self.network_active,
                "admitted": self.admitted, "queue_wait_ms": round(self.wait_ms),
                "cooldown_hosts": len(self.cooldowns)}

    def snapshot(self):
        with self.lock:
            self._prune()
            return self._snapshot()

    @asynccontextmanager
    async def background(self, url="", *, lane="work"):
        # Nested extractor calls belong to the same admitted work unit. The
        # token is invalidated on exit so detached children cannot bypass forever.
        owner_var = _network_owner if lane == "network" else _background_owner
        counter = "network_active" if lane == "network" else "active"
        owner = owner_var.get()
        if interactive.get() or (owner is not None and owner[0]):
            await self.wait_host(url)
            yield
            return
        started = self.clock()
        admitted = False
        with self.lock:
            self.waiting += 1
        try:
            while True:
                with self.lock:
                    self._prune()
                    if getattr(self, counter) < self._limit() and self.remaining_unlocked(url) <= 0:
                        setattr(self, counter, getattr(self, counter) + 1)
                        self.admitted += 1
                        self.wait_ms += (self.clock() - started) * 1000
                        admitted = True
                        break
                await asyncio.sleep(0.1)
        finally:
            with self.lock:
                self.waiting -= 1
        marker = [True]
        token = owner_var.set(marker)
        try:
            yield
        finally:
            marker[0] = False
            owner_var.reset(token)
            if admitted:
                with self.lock:
                    setattr(self, counter, getattr(self, counter) - 1)

    def remaining_unlocked(self, url):
        return self.cooldowns.get(self.host(url), 0) - self.clock()


control = PlaybackControl()
