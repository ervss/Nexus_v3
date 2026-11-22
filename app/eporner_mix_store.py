"""Short-lived handoff snapshots for Eporner Playlist Studio."""
from __future__ import annotations

import json
import re
import secrets
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

STORE_DIR = Path(__file__).resolve().parents[1] / ".tmp" / "eporner_mixes"
TTL_SECONDS = 24 * 60 * 60
MAX_PLAYLISTS = 200
MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024
_ID_RE = re.compile(r"^[0-9a-f]{24}$")
_PLAYLIST_RE = re.compile(r"/playlist/[A-Za-z0-9]+(?:/|$)")


def _valid_playlist_url(value: str) -> bool:
    parsed = urlparse(value or "")
    host = (parsed.hostname or "").lower()
    return parsed.scheme in {"http", "https"} and (
        host == "eporner.com" or host.endswith(".eporner.com")
    ) and bool(_PLAYLIST_RE.search(parsed.path))


def _path(mix_id: str) -> Path:
    if not _ID_RE.fullmatch(mix_id or ""):
        raise ValueError("invalid mix id")
    return STORE_DIR / f"{mix_id}.json"


def _write(payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        raise ValueError("mix snapshot is too large")
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    path = _path(payload["mix_id"])
    temporary = path.with_suffix(f".{secrets.token_hex(4)}.tmp")
    temporary.write_text(encoded, encoding="utf-8")
    temporary.replace(path)


def _prune_expired() -> None:
    if not STORE_DIR.exists():
        return
    cutoff = time.time() - TTL_SECONDS
    for path in STORE_DIR.glob("*.json"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass


def create_mix(playlists: list[dict[str, Any]], name: str = "", snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
    if not playlists or len(playlists) > MAX_PLAYLISTS:
        raise ValueError("provide 1 to 200 playlists")
    _prune_expired()
    normalized = []
    seen = set()
    for raw in playlists:
        url = str(raw.get("url") or "").strip()
        if not _valid_playlist_url(url):
            raise ValueError("only Eporner playlist URLs are accepted")
        playlist_id = _PLAYLIST_RE.search(url).group(0).split("/")[2].lower()
        if playlist_id in seen:
            continue
        seen.add(playlist_id)
        normalized.append({
            "url": url,
            "title": str(raw.get("title") or "Eporner playlist").strip()[:500],
            "thumbnail": str(raw.get("thumbnail") or raw.get("thumb") or "").strip()[:2000],
            "count": max(0, int(raw.get("count") or 0)),
            "complete": bool(raw.get("complete") if "complete" in raw else raw.get("scan_complete")),
        })
    now = time.time()
    payload = {
        "mix_id": secrets.token_hex(12),
        "name": (name or "Eporner Playlist Mix").strip()[:200],
        "created_at": now,
        "updated_at": now,
        "expires_at": now + TTL_SECONDS,
        "playlists": normalized,
        "snapshot": snapshot if isinstance(snapshot, dict) else {},
    }
    _write(payload)
    return payload


def get_mix(mix_id: str) -> dict[str, Any] | None:
    try:
        path = _path(mix_id)
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if float(payload.get("expires_at") or 0) <= time.time():
        try:
            path.unlink()
        except OSError:
            pass
        return None
    return payload


def get_latest_mix() -> dict[str, Any] | None:
    """Return the newest live handoff without exposing a full mix directory."""
    _prune_expired()
    if not STORE_DIR.exists():
        return None
    newest: dict[str, Any] | None = None
    newest_at = -1.0
    for path in STORE_DIR.glob("*.json"):
        mix_id = path.stem
        if not _ID_RE.fullmatch(mix_id):
            continue
        payload = get_mix(mix_id)
        if payload is None:
            continue
        updated_at = float(payload.get("updated_at") or payload.get("created_at") or 0)
        if updated_at > newest_at:
            newest, newest_at = payload, updated_at
    return newest


def update_mix(mix_id: str, snapshot: dict[str, Any]) -> dict[str, Any] | None:
    payload = get_mix(mix_id)
    if payload is None:
        return None
    payload["snapshot"] = snapshot if isinstance(snapshot, dict) else {}
    payload["updated_at"] = time.time()
    _write(payload)
    return payload
