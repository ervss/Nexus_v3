"""Environment-backed settings for the torrent pipeline."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _text(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip().strip('"').strip("'")


def _float(name: str, default: float) -> float:
    raw = _text(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    raw = _text(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class TorrentSettings:
    jackett_url: str
    jackett_api_key: str
    jackett_timeout: float
    prowlarr_url: str
    prowlarr_api_key: str
    qbit_url: str
    qbit_user: str
    qbit_pass: str
    tpdb_api_key: str
    category: int
    search_cache_ttl: float
    thumb_ttl: float
    thumb_miss_ttl: float

    @property
    def prowlarr_configured(self) -> bool:
        return bool(self.prowlarr_url and self.prowlarr_api_key)

    @property
    def jackett_configured(self) -> bool:
        return bool(self.jackett_url and self.jackett_api_key)

    @property
    def qbit_configured(self) -> bool:
        return bool(self.qbit_url and self.qbit_user)


def load_settings() -> TorrentSettings:
    return TorrentSettings(
        jackett_url=_text("JACKETT_URL", "http://127.0.0.1:9117").rstrip("/"),
        jackett_api_key=_text("JACKETT_API_KEY"),
        jackett_timeout=max(5.0, _float("JACKETT_TIMEOUT", 40.0)),
        prowlarr_url=_text("PROWLARR_URL").rstrip("/"),
        prowlarr_api_key=_text("PROWLARR_API_KEY"),
        qbit_url=_text("QBIT_URL", "http://127.0.0.1:8080").rstrip("/"),
        qbit_user=_text("QBIT_USER", "admin"),
        qbit_pass=_text("QBIT_PASS"),
        tpdb_api_key=_text("TPDB_API_KEY"),
        category=_int("TORRENT_CATEGORY", 6000),
        search_cache_ttl=max(0.0, _float("TORRENT_SEARCH_CACHE_TTL", 90.0)),
        thumb_ttl=max(60.0, _float("TORRENT_THUMB_TTL", 7 * 24 * 3600)),
        thumb_miss_ttl=max(60.0, _float("TORRENT_THUMB_MISS_TTL", 6 * 3600)),
    )
