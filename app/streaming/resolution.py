"""Share extraction, never database sessions or mutable response dictionaries."""
from __future__ import annotations

import asyncio
import copy
import time
import weakref
from collections import OrderedDict
from urllib.parse import parse_qs, urlsplit

from app.ntc.coalesce import Coalescer
from app.ntc.bunkr_scheduler import fetch_priority
from .playback_control import interactive


class PlaybackResolver:
    def __init__(self, clock=time.time):
        self.clock = clock
        self.coalescer = Coalescer()
        self.cache = OrderedDict()
        self.hits = 0
        self.extractions = 0

    def _ttl(self, result):
        query = parse_qs(urlsplit(str(result.get("stream_url") or "")).query)
        ttl = 15.0  # short reuse only for Bunkr, whose API returns reusable URLs
        for key in ("ex", "expires", "exp"):
            if key in query:
                try:
                    expiry = float(query[key][0])
                    if expiry > 1e12:
                        expiry /= 1000
                    ttl = min(60.0, expiry - self.clock() - 60.0)
                except (ValueError, TypeError):
                    return 0.0
                break
        return max(0.0, ttl)

    async def resolve(self, key, factory, *, reusable=False, force=False, timeout=40):
        if force:
            self.cache.pop(key, None)
        entry = self.cache.get(key)
        if entry and entry[0] > self.clock():
            self.hits += 1
            self.cache.move_to_end(key)
            return copy.deepcopy(entry[1]), True
        self.cache.pop(key, None)

        async def run():
            token = interactive.set(True)
            priority_token = fetch_priority.set("high")
            try:
                self.extractions += 1
                result = await asyncio.wait_for(factory(), timeout)
                if reusable and isinstance(result, dict) and result.get("stream_url"):
                    ttl = self._ttl(result)
                    if ttl > 0:
                        self.cache[key] = (self.clock() + ttl, copy.deepcopy(result))
                        while len(self.cache) > 256:
                            self.cache.popitem(last=False)
                return result
            finally:
                fetch_priority.reset(priority_token)
                interactive.reset(token)

        return copy.deepcopy(await self.coalescer.do(key, run)), False

    def invalidate_url(self, url):
        for key, entry in list(self.cache.items()):
            if entry[1].get("stream_url") == url:
                self.cache.pop(key, None)


_resolvers = weakref.WeakKeyDictionary()


def get_resolver():
    loop = asyncio.get_running_loop()
    if loop not in _resolvers:
        _resolvers[loop] = PlaybackResolver()
    return _resolvers[loop]
