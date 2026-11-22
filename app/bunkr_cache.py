"""
Persistent disk cache for Bunkr metadata (Discovery Hub / Album Viewer).

Two stores under data/bunkr_cache/:

  files.json          per-FILE metadata keyed by the stable file-page URL:
                      title, thumbnail, duration, width/height, size, quality,
                      type, ext. Deliberately NO stream_url — those are signed
                      and expire; the player lazy-resolves via /meta-preview.

  albums/<id>.json    the raw album listing (base items) keyed by album id, so
                      a previously opened album still renders instantly (and
                      even when Bunkr is down/renamed the listing survives).

  album_snapshots/<id>.json
                      permanent Album Viewer records. Each file member keeps
                      every stable field the viewer has learned (title, dates,
                      thumbnail, size, type, duration and dimensions). These
                      records intentionally never expire or get compacted.

Everything is best-effort: cache failures must never break the live path.
"""
from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from threading import RLock
from typing import Any, Optional

logger = logging.getLogger(__name__)

_DIR = Path("data") / "bunkr_cache"
_FILES_PATH = _DIR / "files.json"
_ALBUMS_DIR = _DIR / "albums"
_ALBUM_SNAPSHOTS_DIR = _DIR / "album_snapshots"

_FILE_TTL = 60 * 24 * 3600     # durations/sizes are immutable
_FILE_MAX = 50000
_ALBUM_TTL = 14 * 24 * 3600    # listings can gain files; refreshed on every live open

_files: dict[str, dict] = {}
_files_loaded = False
_files_dirty = False
_lock = RLock()

# meta fields worth persisting for a file (stream_url intentionally excluded)
_META_KEYS = ("title", "thumbnail", "thumbnail_checked", "storyboard_url", "storyboard_kind", "metadata_state", "duration", "width", "height",
              "size", "size_bytes", "size_verified", "quality", "type", "ext")


def _load_files() -> None:
    global _files_loaded, _files
    if _files_loaded:
        return
    with _lock:
        if _files_loaded:
            return
        try:
            if _FILES_PATH.exists():
                data = json.loads(_FILES_PATH.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    _files = data
        except Exception as exc:  # noqa: BLE001
            logger.debug("[bunkr_cache] files load failed: %s", exc)
            _files = {}
        _files_loaded = True


def file_meta_get(url: str) -> Optional[dict]:
    if not url:
        return None
    _load_files()
    with _lock:
        row = _files.get(url)
        if not row:
            return None
        if time.time() - float(row.get("at") or 0) > _FILE_TTL:
            _files.pop(url, None)
            return None
        meta = row.get("meta")
        return dict(meta) if isinstance(meta, dict) else None


def file_meta_put(url: str, item: dict) -> None:
    """Store one file's metadata (call file_meta_flush() when the batch ends)."""
    global _files_dirty
    if not url or not isinstance(item, dict):
        return
    meta = {k: item[k] for k in _META_KEYS if item.get(k) not in (None, "", 0)}
    if not meta:
        return
    _load_files()
    with _lock:
        previous = _files.get(url, {}).get("meta") or {}
        if previous.get("size_verified") and not meta.get("size_verified"):
            meta.pop("size", None)
            meta.pop("size_bytes", None)
        if meta.get("duration") and meta.get("height") and meta.get("metadata_state") != "unsupported":
            previous = {k: v for k, v in previous.items() if k != "metadata_state"}
        _files[url] = {"at": time.time(), "meta": {**previous, **meta}}
        _files_dirty = True


def file_meta_forget(url: str) -> None:
    """Drop one file's cached metadata so the next probe runs fresh (used by the
    Album Viewer's manual 'Fetch meta znova')."""
    global _files_dirty
    if not url:
        return
    _load_files()
    with _lock:
        if url in _files:
            _files.pop(url, None)
            _files_dirty = True


def file_meta_flush() -> None:
    global _files_dirty
    with _lock:
        if not _files_dirty:
            return
        try:
            _DIR.mkdir(parents=True, exist_ok=True)
            now = time.time()
            items = [(k, v) for k, v in _files.items()
                     if now - float(v.get("at") or 0) < _FILE_TTL]
            items.sort(key=lambda kv: float(kv[1].get("at") or 0), reverse=True)
            compact = dict(items[:_FILE_MAX])
            _files.clear()
            _files.update(compact)
            _FILES_PATH.write_text(json.dumps(compact, ensure_ascii=False), encoding="utf-8")
            _files_dirty = False
        except Exception as exc:  # noqa: BLE001
            logger.debug("[bunkr_cache] files save failed: %s", exc)


def _album_key(url: str) -> str:
    """Domain-independent album id ('2968SopD' from https://bunkr.site/a/2968SopD)."""
    m = re.search(r"/(?:a|album|albums)/([A-Za-z0-9_-]+)", url or "")
    key = m.group(1) if m else re.sub(r"[^A-Za-z0-9_-]", "_", (url or "")[-60:])
    return key[:80]


def album_put(url: str, items: list[dict], title: str = "") -> None:
    if not url or not items:
        return
    try:
        _ALBUMS_DIR.mkdir(parents=True, exist_ok=True)
        payload = {"at": time.time(), "url": url, "title": title, "items": items}
        (_ALBUMS_DIR / f"{_album_key(url)}.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.debug("[bunkr_cache] album save failed: %s", exc)


def album_get(url: str, *, ignore_ttl: bool = False) -> Optional[dict]:
    """{'at', 'url', 'title', 'items'} or None. ignore_ttl serves stale listings
    as a fallback when the live fetch fails entirely."""
    try:
        path = _ALBUMS_DIR / f"{_album_key(url)}.json"
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not data.get("items"):
            return None
        if not ignore_ttl and time.time() - float(data.get("at") or 0) > _ALBUM_TTL:
            return None
        return data
    except Exception as exc:  # noqa: BLE001
        logger.debug("[bunkr_cache] album load failed: %s", exc)
        return None


def album_snapshot_get(url: str) -> Optional[dict]:
    """Return the permanent Album Viewer snapshot for an album.

    Unlike ``album_get`` this store deliberately has no TTL: it is the local
    historical record of who was in the album and all stable metadata learned
    for every member. Signed CDN ``stream_url`` values are excluded by callers
    because Bunkr invalidates them.
    """
    try:
        path = _ALBUM_SNAPSHOTS_DIR / f"{_album_key(url)}.json"
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            return None
        return data
    except Exception as exc:  # noqa: BLE001
        logger.debug("[bunkr_cache] album snapshot load failed: %s", exc)
        return None


def album_snapshot_put(url: str, items: list[dict], title: str = "") -> None:
    """Merge stable Album Viewer fields into a permanent per-album snapshot.

    A later live listing may omit an old member or temporarily omit a field;
    neither condition is allowed to erase history. The snapshot grows by URL
    and only overwrites a stored field when the new value is meaningful.
    """
    if not url or not isinstance(items, list):
        return
    try:
        _ALBUM_SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
        path = _ALBUM_SNAPSHOTS_DIR / f"{_album_key(url)}.json"
        previous = album_snapshot_get(url) or {}
        by_url = {
            str(item.get("url")): dict(item)
            for item in previous.get("items", [])
            if isinstance(item, dict) and item.get("url")
        }
        for item in items:
            if not isinstance(item, dict) or not item.get("url"):
                continue
            key = str(item["url"])
            old = by_url.get(key, {})
            merged = dict(old)
            for field, value in item.items():
                if field == "stream_url":  # signed and intentionally transient
                    continue
                if value not in (None, "", 0, False, [], {}):
                    merged[field] = value
                elif field not in merged:
                    merged[field] = value
            # A successful probe is meaningful even though it is boolean.
            if item.get("enriched"):
                merged["enriched"] = True
            by_url[key] = merged
        now = time.time()
        payload = {
            "created_at": previous.get("created_at") or now,
            "updated_at": now,
            "url": url,
            "title": title or previous.get("title") or "",
            "items": list(by_url.values()),
        }
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.debug("[bunkr_cache] album snapshot save failed: %s", exc)
