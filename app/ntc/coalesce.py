"""Collapse identical in-flight GET requests onto one future."""
from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Dict, Hashable, Tuple


class Coalescer:
    def __init__(self) -> None:
        self._inflight: Dict[Hashable, asyncio.Future] = {}
        self._waiters: Dict[Hashable, int] = {}

    def key(self, method: str, url: str, headers: Any = None) -> Tuple:
        method = (method or "GET").upper()
        hdrs = ()
        if headers:
            hdrs = tuple(sorted((str(k).lower(), str(v)) for k, v in dict(headers).items()))
        return (method, url, hdrs)

    async def do(self, key: Hashable, factory: Callable[[], Awaitable[Any]]) -> Any:
        fut = self._inflight.get(key)
        if fut is None:
            fut = asyncio.create_task(factory())
            # Retrieve failures even when the last subscriber disconnects.
            fut.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
            self._inflight[key] = fut
            self._waiters[key] = 0
        self._waiters[key] += 1
        try:
            return await asyncio.shield(fut)
        finally:
            self._waiters[key] -= 1
            if self._waiters[key] == 0 and self._inflight.get(key) is fut:
                self._inflight.pop(key, None)
                self._waiters.pop(key, None)
                if not fut.done():
                    fut.cancel()
                    await asyncio.gather(fut, return_exceptions=True)
