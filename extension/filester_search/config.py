from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Config:
    """v2 config — graph-aware public discovery, polite adaptive crawl."""

    base_url: str = "https://filester.me"
    mirror_hosts: tuple[str, ...] = (
        "filester.me",
        "filester.sh",
        "filester.si",
        "filester.gg",
    )
    db_path: str = "filester_index.db"

    max_workers: int = 3
    max_rps: float = 1.5
    min_rps: float = 0.25
    connect_timeout: float = 12.0
    read_timeout: float = 28.0
    max_retries: int = 3
    backoff_base: float = 1.6
    backoff_cap: float = 90.0

    start_concurrency: int = 2
    min_concurrency: int = 1
    max_concurrency: int = 5
    latency_high_ms: float = 2800.0
    error_window: int = 20

    max_pages: int = 0
    max_depth: int = 12
    max_pages_per_folder: int = 30
    user_agent: str = (
        "FilesterPublicIndexer/2.0 (+local recon index; polite; respects 401/403/429)"
    )

    default_seeds: list[str] = field(default_factory=lambda: [
        "https://filester.me/",
        "https://filester.me/blog",
        "https://filester.me/changelog",
        "https://filester.me/proxy",
        "https://filester.me/faq",
    ])

    @classmethod
    def from_env(cls) -> "Config":
        c = cls()
        if v := os.getenv("FILESTER_DB"):
            c.db_path = v
        if v := os.getenv("FILESTER_WORKERS"):
            c.max_workers = int(v)
            c.max_concurrency = max(c.max_concurrency, c.max_workers)
        if v := os.getenv("FILESTER_MAX_RPS"):
            c.max_rps = float(v)
        return c

    def resolve_db(self) -> Path:
        return Path(self.db_path).expanduser().resolve()

    def allowed_hosts(self) -> set[str]:
        return {h.lower() for h in self.mirror_hosts} | {"www.filester.me"}
