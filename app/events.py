"""
NexusEvent bus — typed, topic-based system events (A1).

Subsystems (rate limiter, scheduler, health monitor, importers, extractors)
emit structured NexusEvents instead of free-text logs. Sinks (the WebSocket
ConnectionManager) fan them out to subscribed clients; a ring buffer keeps
recent history so a freshly connected dashboard can render state immediately.

Topics (dot-separated, fnmatch patterns supported by subscribers):
    ratelimit.state   — adaptive limiter delay changes per domain
    job.state         — scheduler job lifecycle (executed/error/missed)
    health.progress   — link health sweep progress + summary
    pipeline.flow     — import/extraction flow events
    log               — legacy free-text log lines (bridged from manager.log)
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from fnmatch import fnmatch
from typing import Any, Awaitable, Callable, Deque, Dict, List, Optional

logger = logging.getLogger(__name__)

EventSink = Callable[["NexusEvent"], Awaitable[None]]


@dataclass
class NexusEvent:
    topic: str
    entity: str = ""            # e.g. "domain:eporner.com", "job:profile_3", "video:123"
    state: str = ""             # e.g. "throttled", "recovering", "executed", "error"
    message: str = ""
    metrics: Dict[str, Any] = field(default_factory=dict)
    ts: float = field(default_factory=time.time)

    def to_payload(self) -> Dict[str, Any]:
        return {
            "type": "event",
            "topic": self.topic,
            "entity": self.entity,
            "state": self.state,
            "message": self.message,
            "metrics": self.metrics,
            "ts": self.ts,
        }


class EventBus:
    """Process-wide event bus. Thread-safe emit via emit_sync()."""

    def __init__(self, history_size: int = 400):
        self._history: Deque[NexusEvent] = deque(maxlen=history_size)
        self._sinks: List[EventSink] = []
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._history_lock = threading.Lock()

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Called once from the app lifespan so sync threads can emit."""
        self._loop = loop

    def add_sink(self, sink: EventSink) -> None:
        self._sinks.append(sink)

    def history(self, patterns: Optional[List[str]] = None, limit: int = 200) -> List[Dict[str, Any]]:
        with self._history_lock:
            events = list(self._history)
        if patterns:
            events = [e for e in events if any(fnmatch(e.topic, p) for p in patterns)]
        return [e.to_payload() for e in events[-limit:]]

    def record(self, event: NexusEvent) -> None:
        """Append to history without notifying sinks (for pre-broadcast frames)."""
        with self._history_lock:
            self._history.append(event)

    async def emit(
        self,
        topic: str,
        entity: str = "",
        state: str = "",
        message: str = "",
        metrics: Optional[Dict[str, Any]] = None,
    ) -> NexusEvent:
        event = NexusEvent(topic=topic, entity=entity, state=state,
                           message=message, metrics=metrics or {})
        with self._history_lock:
            self._history.append(event)
        for sink in self._sinks:
            try:
                await sink(event)
            except Exception:
                logger.debug("Event sink failed for topic %s", topic, exc_info=True)
        return event

    def emit_sync(
        self,
        topic: str,
        entity: str = "",
        state: str = "",
        message: str = "",
        metrics: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Emit from sync/threaded code. Falls back to history-only when no loop runs."""
        loop = self._loop
        if loop is None or loop.is_closed():
            event = NexusEvent(topic=topic, entity=entity, state=state,
                               message=message, metrics=metrics or {})
            with self._history_lock:
                self._history.append(event)
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        coro = self.emit(topic, entity=entity, state=state, message=message, metrics=metrics)
        if running is loop:
            loop.create_task(coro)
        else:
            asyncio.run_coroutine_threadsafe(coro, loop)


bus = EventBus()
