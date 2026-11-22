"""Lightweight per-domain circuit breaker for extractors and stream resolution."""
from __future__ import annotations

import threading
import time
from typing import Dict, Optional
from urllib.parse import urlparse


def normalize_domain(url_or_domain: str) -> str:
    raw = (url_or_domain or "").strip().lower()
    if "://" in raw:
        raw = urlparse(raw).netloc.lower()
    if raw.startswith("www."):
        raw = raw[4:]
    return raw.split(":")[0]


class DomainCircuitBreaker:
    """Trips after `failure_threshold` consecutive transient failures for `cooldown_seconds`."""

    def __init__(self, failure_threshold: int = 3, cooldown_seconds: float = 90.0):
        self.failure_threshold = max(1, int(failure_threshold))
        self.cooldown_seconds = max(5.0, float(cooldown_seconds))
        self._lock = threading.Lock()
        self._states: Dict[str, dict] = {}

    def allow(self, url_or_domain: str) -> tuple[bool, float]:
        domain = normalize_domain(url_or_domain)
        if not domain:
            return True, 0.0
        now = time.time()
        with self._lock:
            entry = self._states.get(domain)
            if not entry:
                return True, 0.0
            open_until = entry.get("open_until", 0.0)
            if open_until > now:
                return False, round(open_until - now, 1)
            if entry.get("state") == "open":
                # Cooldown elapsed -> allow a single half-open probe
                entry["state"] = "half_open"
            return True, 0.0

    def record_success(self, url_or_domain: str) -> None:
        domain = normalize_domain(url_or_domain)
        if not domain:
            return
        with self._lock:
            self._states.pop(domain, None)

    def record_failure(self, url_or_domain: str, reason: str = "") -> dict:
        domain = normalize_domain(url_or_domain)
        if not domain:
            return {"domain": "", "state": "closed", "failures": 0}
        now = time.time()
        with self._lock:
            entry = self._states.setdefault(
                domain,
                {"failures": 0, "state": "closed", "open_until": 0.0, "last_reason": "", "updated_at": now},
            )
            entry["failures"] += 1
            entry["last_reason"] = (reason or "")[:200]
            entry["updated_at"] = now
            if entry["failures"] >= self.failure_threshold or entry["state"] == "half_open":
                entry["state"] = "open"
                entry["open_until"] = now + self.cooldown_seconds
            return {"domain": domain, **entry}

    def reset(self, domain: Optional[str] = None) -> int:
        with self._lock:
            if domain:
                key = normalize_domain(domain)
                return 1 if self._states.pop(key, None) is not None else 0
            count = len(self._states)
            self._states.clear()
            return count

    def snapshot(self) -> list[dict]:
        now = time.time()
        out = []
        with self._lock:
            for domain, entry in self._states.items():
                open_until = entry.get("open_until", 0.0)
                state = entry.get("state", "closed")
                if state == "open" and open_until <= now:
                    state = "half_open"
                out.append(
                    {
                        "domain": domain,
                        "state": state,
                        "failures": entry.get("failures", 0),
                        "retry_after_s": round(max(0.0, open_until - now), 1),
                        "last_reason": entry.get("last_reason", ""),
                    }
                )
        out.sort(key=lambda item: (item["state"] != "open", -item["failures"], item["domain"]))
        return out


extractor_circuit_breaker = DomainCircuitBreaker(failure_threshold=3, cooldown_seconds=90.0)
