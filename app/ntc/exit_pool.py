"""Scored proxy / fingerprint exits with sticky sessions."""
from __future__ import annotations

import os
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional


PERSONAS = ("chrome120", "chrome124", "chrome", "safari")


@dataclass
class Exit:
    id: str
    proxy: Optional[str]
    persona: str = "chrome120"
    score: float = 100.0
    sticky_keys: set = field(default_factory=set)


def _normalize_proxy(line: str) -> Optional[str]:
    raw = (line or "").strip()
    if not raw or raw.startswith("#"):
        return None
    if "://" in raw:
        return raw
    parts = raw.split(":")
    if len(parts) == 4:
        host, port, user, password = parts
        return f"http://{user}:{password}@{host}:{port}"
    if len(parts) == 2:
        host, port = parts
        return f"http://{host}:{port}"
    return raw


def _proxy_lines() -> List[str]:
    raw = (os.getenv("WEBSHARE_PROXY_LIST") or os.getenv("NTC_PROXY_LIST") or "").strip()
    if not raw:
        return []
    path = Path(raw)
    if len(raw) < 4096 and path.is_file():
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            pass
    chunks: List[str] = []
    for piece in raw.replace(",", "\n").splitlines():
        item = piece.strip()
        if item and not item.startswith("#"):
            chunks.append(item)
    return chunks


class ExitPool:
    def __init__(self) -> None:
        self._exits: List[Exit] = []
        self._by_id: Dict[str, Exit] = {}
        self._sticky: Dict[str, str] = {}
        self.reload()

    def reload(self) -> None:
        exits = [Exit(id="direct", proxy=None, persona="chrome120", score=100.0)]
        for i, line in enumerate(_proxy_lines()):
            proxy = _normalize_proxy(line)
            if not proxy:
                continue
            persona = PERSONAS[i % len(PERSONAS)]
            exits.append(Exit(id=f"proxy-{i}", proxy=proxy, persona=persona, score=100.0))
        self._exits = exits
        self._by_id = {e.id: e for e in exits}

    def pick(self, *, sticky_key: Optional[str] = None, impersonate: Optional[str] = None) -> Exit:
        if not self._exits:
            self.reload()
        if sticky_key:
            eid = self._sticky.get(sticky_key)
            chosen = self._by_id.get(eid) if eid else None
            if chosen is not None:
                if impersonate:
                    chosen.persona = impersonate
                return chosen
        # Weighted by score with a little jitter so a dead exit cannot monopolize.
        weights = [max(1.0, e.score) + random.random() for e in self._exits]
        chosen = max(zip(weights, self._exits), key=lambda x: x[0])[1]
        if impersonate:
            chosen.persona = impersonate
        if sticky_key:
            self._sticky[sticky_key] = chosen.id
            chosen.sticky_keys.add(sticky_key)
        return chosen

    def report(self, exit: Exit, *, status: Optional[int] = None, ok: bool = True, timeout: bool = False) -> None:
        if timeout:
            exit.score = max(1.0, exit.score - 15.0)
            return
        if status in (403, 429, 503):
            exit.score = max(1.0, exit.score - 25.0)
            return
        if not ok or (status is not None and status >= 500):
            exit.score = max(1.0, exit.score - 10.0)
            return
        if ok and status is not None and 200 <= status < 400:
            exit.score = min(100.0, exit.score + 2.0)
