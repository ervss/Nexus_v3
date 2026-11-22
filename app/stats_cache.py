"""Short-lived TTL cache for heavy library statistics and source-health aggregations."""
from __future__ import annotations

import threading
import time
from typing import Any, Callable, Optional


class TTLCache:
    def __init__(self, default_ttl: float = 30.0):
        self.default_ttl = default_ttl
        self._lock = threading.Lock()
        self._store: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Optional[Any]:
        now = time.monotonic()
        with self._lock:
            item = self._store.get(key)
            if not item:
                return None
            expires_at, value = item
            if expires_at <= now:
                self._store.pop(key, None)
                return None
            return value

    def set(self, key: str, value: Any, ttl: Optional[float] = None) -> Any:
        ttl_s = self.default_ttl if ttl is None else max(0.5, float(ttl))
        with self._lock:
            self._store[key] = (time.monotonic() + ttl_s, value)
        return value

    def get_or_compute(self, key: str, factory: Callable[[], Any], ttl: Optional[float] = None) -> Any:
        cached = self.get(key)
        if cached is not None:
            return cached
        value = factory()
        return self.set(key, value, ttl=ttl)

    def invalidate(self, prefix: Optional[str] = None) -> None:
        with self._lock:
            if not prefix:
                self._store.clear()
                return
            for k in [k for k in self._store if k.startswith(prefix)]:
                self._store.pop(k, None)


stats_cache = TTLCache(default_ttl=30.0)
