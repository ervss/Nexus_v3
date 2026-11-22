"""In-process rate limit and short TTL cache. One Nexus process is enough."""

from __future__ import annotations

import threading
import time
from typing import Any


class WindowLimiter:
    def __init__(self, limit: int, window: float):
        self.limit = limit
        self.window = window
        self._hits: list[float] = []
        self._lock = threading.Lock()

    def allow(self) -> tuple[bool, float]:
        now = time.monotonic()
        with self._lock:
            self._hits = [stamp for stamp in self._hits if now - stamp < self.window]
            if len(self._hits) >= self.limit:
                retry = max(1.0, self.window - (now - self._hits[0]))
                return False, retry
            self._hits.append(now)
            return True, 0.0


class TtlCache:
    def __init__(self, max_items: int = 64):
        self._max = max_items
        self._data: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Any | None:
        now = time.monotonic()
        with self._lock:
            item = self._data.get(key)
            if not item or item[0] <= now:
                self._data.pop(key, None)
                return None
            return item[1]

    def set(self, key: str, value: Any, ttl: float) -> None:
        if ttl <= 0:
            return
        with self._lock:
            self._data[key] = (time.monotonic() + ttl, value)
            if len(self._data) <= self._max:
                return
            expired = [k for k, (exp, _) in self._data.items() if exp <= time.monotonic()]
            for key_to_drop in expired:
                self._data.pop(key_to_drop, None)
            while len(self._data) > self._max:
                oldest = min(self._data, key=lambda k: self._data[k][0])
                self._data.pop(oldest, None)


search_limiter = WindowLimiter(limit=12, window=60.0)
thumb_limiter = WindowLimiter(limit=40, window=60.0)
add_limiter = WindowLimiter(limit=20, window=60.0)
search_cache = TtlCache(max_items=48)
