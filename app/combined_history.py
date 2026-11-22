"""Saved Discovery Hub combined albums and their fetched cards.

The live viewer is temporary. This store keeps one record per session so a
finished fetch can be opened again with the same keyword, date and cards.
"""
from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

_DIR = Path("data") / "combined_history"
_MAX = 80
_ID = re.compile(r"^[a-f0-9]{8,32}$")


def _root(directory: Path | None) -> Path:
    return Path(directory) if directory is not None else _DIR


def _read(path: Path, fallback):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback
    return data


def _summaries(root: Path) -> list[dict]:
    raw = _read(root / "index.json", {"items": []})
    items = raw.get("items") if isinstance(raw, dict) else None
    return [row for row in items or [] if isinstance(row, dict) and row.get("id")]


def _counts(items: list[dict]) -> tuple[int, int, int]:
    videos = [item for item in items if item.get("type") == "video"]
    fetched = [
        item for item in videos
        if item.get("metadata_state") == "unsupported" or (item.get("duration") and item.get("height"))
    ]
    return len(items), len(videos), len(fetched)


def _clean_item(item: dict) -> dict:
    return {key: value for key, value in item.items() if key not in {"stream_url", "_refetching", "_enriching"}}


def sync_fetch_metadata(entry: dict) -> None:
    """Persist learned file metadata and associate it only with its actual source albums."""
    if entry.get("kind") in {"search", "collection"}:
        return
    from app import bunkr_cache
    albums = {str(a.get("url")): str(a.get("title") or "") for a in entry.get("source_albums", [])
              if isinstance(a, dict) and a.get("url")}
    groups = {url: [] for url in albums}
    for item in entry.get("items", []):
        if not isinstance(item, dict) or not item.get("url"):
            continue
        if not (item.get("duration") or item.get("height") or item.get("metadata_state") == "unsupported"):
            continue
        clean = _clean_item(item)
        bunkr_cache.file_meta_put(str(item["url"]), clean)
        sources = item.get("source_album_urls") or []
        if not isinstance(sources, list):
            sources = []
        sources = set(sources)
        sources.add(item.get("source_album_url") or "")
        for source in sources:
            if source in groups:
                groups[source].append(clean)
    for url, items in groups.items():
        if items:
            bunkr_cache.album_snapshot_put(url, items, title=albums[url])
    bunkr_cache.file_meta_flush()


def save(entry: dict, *, directory: Path | None = None) -> dict:
    root = _root(directory)
    root.mkdir(parents=True, exist_ok=True)
    raw_id = str(entry.get("id") or "")
    record_id = raw_id if _ID.match(raw_id) else uuid.uuid4().hex
    path = root / f"{record_id}.json"
    previous = _read(path, {}) if path.exists() else {}
    items = [_clean_item(item) for item in (entry.get("items") or []) if isinstance(item, dict) and item.get("url")]
    file_count, video_count, fetched_count = _counts(items)
    now = time.time()
    keyword = str(entry.get("keyword") or "").strip()[:200]
    if previous.get("keyword") and not keyword:
        keyword = previous["keyword"]
    albums = []
    for album in entry.get("source_albums") or []:
        if not isinstance(album, dict) or not album.get("url"):
            continue
        albums.append({
            "url": str(album.get("url") or "")[:2048],
            "title": str(album.get("title") or "")[:300],
            "first_upload_at": album.get("first_upload_at") or "",
            "last_upload_at": album.get("last_upload_at") or "",
        })
    record = {
        "id": record_id,
        "created_at": float(previous.get("created_at") or now),
        "updated_at": now,
        "day": str(previous.get("day") or entry.get("day") or "")[:10],
        "keyword": keyword,
        "title": str(entry.get("title") or previous.get("title") or "")[:300],
        "source_albums": albums or previous.get("source_albums") or [],
        "file_count": file_count,
        "video_count": video_count,
        "fetched_count": fetched_count,
        "kind": entry.get("kind") if entry.get("kind") in {"search", "collection"} else previous.get("kind", "fetch"),
        "search_state": entry.get("search_state") or {},
        "items": items,
    }
    path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    summary = {key: record[key] for key in (
        "id", "created_at", "updated_at", "day", "keyword", "title",
        "file_count", "video_count", "fetched_count", "kind")}
    summary["album_count"] = len(record["source_albums"])
    rows = [summary] + [row for row in _summaries(root) if row.get("id") != record_id]
    regular = [row for row in rows if row.get("kind") != "collection"]
    dropped = regular[_MAX:]
    dropped_ids = {row["id"] for row in dropped}
    rows = [row for row in rows if row["id"] not in dropped_ids]
    (root / "index.json").write_text(json.dumps({"items": rows}, ensure_ascii=False), encoding="utf-8")
    for row in dropped:
        try:
            (root / f"{row['id']}.json").unlink(missing_ok=True)
        except OSError:
            pass
    return summary


def list_history(*, keyword: str = "", day: str = "", directory: Path | None = None) -> list[dict]:
    needle = keyword.strip().lower()
    day = day.strip()
    rows = []
    for row in _summaries(_root(directory)):
        if day and row.get("day") != day:
            continue
        haystack = f"{row.get('keyword') or ''} {row.get('title') or ''}".lower()
        if needle and needle not in haystack:
            continue
        rows.append(row)
    return rows


def get_history(record_id: str, *, directory: Path | None = None) -> dict | None:
    if not _ID.match(record_id or ""):
        return None
    path = _root(directory) / f"{record_id}.json"
    data = _read(path, None)
    return data if isinstance(data, dict) and data.get("id") == record_id else None


def canonical_stash_item_key(item: dict) -> str:
    """Vypočíta stabilnú identitu výskytu položky naprieč všetkými 4 povrchmi (Quantum, Related, Telegram, Discovery/Album)."""
    if not isinstance(item, dict):
        return ""
    explicit = str(item.get("canonical_key") or "").strip()
    if explicit:
        return explicit
    chat_id = item.get("chat_id")
    msg_id = item.get("message_id") or item.get("msg_id")
    if chat_id not in (None, "") and msg_id not in (None, ""):
        return f"tg:{chat_id}:{msg_id}"
    url = str(item.get("url") or item.get("source_url") or "").strip()
    if url:
        return url
    vid = item.get("video_id") or item.get("id")
    if vid not in (None, ""):
        return f"lib:{vid}"
    return ""


def build_share_metadata(item: dict) -> dict:
    """Zostaví informácie pre zdieľanie vrátane upozornenia na súkromný prístup (napr. Telegram chat)."""
    if not isinstance(item, dict):
        return {"share_url": "", "requires_private_access": False, "access_warning": ""}
    chat_id = item.get("chat_id")
    msg_id = item.get("message_id") or item.get("msg_id")
    raw_url = str(item.get("source_url") or item.get("url") or "").strip()
    source = str(item.get("source") or item.get("surface") or "").lower()

    is_tg = (
        (chat_id not in (None, "") and msg_id not in (None, ""))
        or source == "telegram"
        or raw_url.startswith("tg://")
        or "/api/v1/telegram/" in raw_url
        or "t.me/c/" in raw_url
    )
    share_url = raw_url
    if is_tg and chat_id not in (None, "") and msg_id not in (None, ""):
        if not raw_url.startswith("http") or "/api/v1/telegram/" in raw_url:
            cid_str = str(abs(int(chat_id))) if str(chat_id).lstrip("-").isdigit() else str(chat_id)
            if cid_str.startswith("100") and len(cid_str) > 5:
                cid_str = cid_str[3:]
            share_url = f"https://t.me/c/{cid_str}/{msg_id}"

    requires_private = bool(is_tg)
    access_warning = (
        "Odkaz vyžaduje členstvo v súkromnom Telegram kanáli alebo skupine."
        if requires_private
        else ""
    )
    return {
        "share_url": share_url,
        "requires_private_access": requires_private,
        "access_warning": access_warning,
    }


def normalize_stash_item(item: dict) -> dict:
    """Normalizuje položku pre uloženie do kolekcie/stash z ľubovoľného povrchu."""
    if not isinstance(item, dict):
        return {}
    clean = _clean_item(item)
    key = canonical_stash_item_key(clean)
    if not key:
        return {}
    url = str(clean.get("url") or clean.get("source_url") or "").strip()
    if not url:
        chat_id = clean.get("chat_id")
        msg_id = clean.get("message_id") or clean.get("msg_id")
        if chat_id not in (None, "") and msg_id not in (None, ""):
            url = f"tg://{chat_id}/{msg_id}"
        else:
            url = key

    share_meta = build_share_metadata({**clean, "url": url})
    now = time.time()
    normalized = {
        **clean,
        "canonical_key": key,
        "url": url,
        "source_url": str(clean.get("source_url") or url),
        "title": str(clean.get("title") or clean.get("name") or url)[:300],
        "type": str(clean.get("type") or "video"),
        "surface": str(clean.get("surface") or clean.get("source") or "discovery"),
        "source": str(clean.get("source") or clean.get("surface") or "external"),
        "save_status": str(clean.get("save_status") or ("imported" if clean.get("in_library") else "stashed")),
        "saved_at": float(clean.get("saved_at") or now),
        "requires_private_access": share_meta["requires_private_access"],
        "share_url": share_meta["share_url"],
        "access_warning": share_meta["access_warning"],
    }
    return normalized


def list_collections(*, directory: Path | None = None) -> list[dict]:
    """Vráti zoznam všetkých uložených kolekcií (kind == 'collection')."""
    return [row for row in _summaries(_root(directory)) if row.get("kind") == "collection"]


def add_to_collection(
    items: list[dict],
    *,
    collection_id: str = "",
    title: str = "Odložené na neskôr",
    keyword: str = "stash",
    directory: Path | None = None,
) -> dict:
    """Idempotentne pridá položky z ľubovoľného povrchu do kolekcie bez vytvárania duplikátov."""
    root = _root(directory)
    root.mkdir(parents=True, exist_ok=True)
    target_record = None
    if collection_id and _ID.match(collection_id):
        target_record = get_history(collection_id, directory=directory)
    if target_record is None:
        wanted_title = (title or "Odložené na neskôr").strip().lower()
        for row in list_collections(directory=directory):
            if str(row.get("title") or "").strip().lower() == wanted_title:
                target_record = get_history(row["id"], directory=directory)
                break

    existing_items = list(target_record.get("items") or []) if target_record else []
    by_key: dict[str, int] = {}
    merged: list[dict] = []
    for raw in existing_items:
        norm = normalize_stash_item(raw)
        if not norm:
            continue
        k = norm["canonical_key"]
        if k not in by_key:
            by_key[k] = len(merged)
            merged.append(norm)

    added_count = 0
    duplicate_count = 0
    for raw in items or []:
        norm = normalize_stash_item(raw)
        if not norm:
            continue
        k = norm["canonical_key"]
        if k in by_key:
            idx = by_key[k]
            prev = merged[idx]
            merged[idx] = {
                **prev,
                **{mk: mv for mk, mv in norm.items() if mv not in (None, "", 0)},
                "saved_at": prev.get("saved_at") or norm.get("saved_at"),
            }
            duplicate_count += 1
        else:
            by_key[k] = len(merged)
            merged.append(norm)
            added_count += 1

    day_str = time.strftime("%Y-%m-%d", time.gmtime())
    summary = save(
        {
            "id": target_record["id"] if target_record else (collection_id if _ID.match(collection_id or "") else ""),
            "kind": "collection",
            "title": (target_record.get("title") if target_record else "") or title or "Odložené na neskôr",
            "keyword": (target_record.get("keyword") if target_record else "") or keyword or "stash",
            "day": (target_record.get("day") if target_record else "") or day_str,
            "items": merged,
        },
        directory=directory,
    )
    return {
        "summary": summary,
        "added_count": added_count,
        "duplicate_count": duplicate_count,
        "total_count": len(merged),
        "items": merged,
    }


def remove_from_collection(
    collection_id: str,
    canonical_keys: list[str],
    *,
    directory: Path | None = None,
) -> dict | None:
    """Odstráni položky z kolekcie podľa ich canonical_key alebo URL."""
    record = get_history(collection_id, directory=directory)
    if not record:
        return None
    drop = {str(k).strip() for k in (canonical_keys or []) if str(k).strip()}
    kept = []
    removed_count = 0
    for raw in record.get("items") or []:
        norm = normalize_stash_item(raw)
        if not norm:
            continue
        if norm["canonical_key"] in drop or norm.get("url") in drop:
            removed_count += 1
            continue
        kept.append(norm)
    summary = save(
        {
            "id": record["id"],
            "kind": "collection",
            "title": record.get("title") or "Odložené na neskôr",
            "keyword": record.get("keyword") or "stash",
            "day": record.get("day") or "",
            "items": kept,
        },
        directory=directory,
    )
    return {
        "summary": summary,
        "removed_count": removed_count,
        "total_count": len(kept),
        "items": kept,
    }


def compute_album_delta(
    album_url: str,
    current_items: list[dict],
    *,
    library_urls: set[str] | list[str] | None = None,
    mark_visited: bool = False,
    directory: Path | None = None,
) -> dict:
    """
    Oddeľuje dva stavy pre otvorený album alebo zdroj:
    1. Nové od poslednej návštevy (new_since_last_visit)
    2. Ešte nie je v knižnici (not_in_library)
    """
    root = _root(directory)
    root.mkdir(parents=True, exist_ok=True)
    seen_path = root / "album_visits.json"
    visits = _read(seen_path, {})
    if not isinstance(visits, dict):
        visits = {}

    norm_album = str(album_url or "").strip()
    prev_entry = visits.get(norm_album) if norm_album else None
    has_previous_visit = isinstance(prev_entry, dict) and isinstance(prev_entry.get("seen_keys"), list)
    seen_keys = set(prev_entry.get("seen_keys") or []) if has_previous_visit else set()

    lib_set = {str(u).strip() for u in (library_urls or []) if str(u).strip()}
    annotated = []
    delta_new_keys = []
    not_in_lib_keys = []
    in_lib_count = 0
    current_keys = []

    for raw in current_items or []:
        if not isinstance(raw, dict):
            continue
        key = canonical_stash_item_key(raw)
        url = str(raw.get("url") or "").strip()
        if key:
            current_keys.append(key)
        in_lib = bool(raw.get("in_library")) or (key in lib_set) or (url in lib_set)
        is_new_visit = (key not in seen_keys and url not in seen_keys) if has_previous_visit else True

        if in_lib:
            in_lib_count += 1
        else:
            if key or url:
                not_in_lib_keys.append(key or url)
        if is_new_visit and (key or url):
            delta_new_keys.append(key or url)

        annotated.append({
            **raw,
            "canonical_key": key or url,
            "in_library": in_lib,
            "not_in_library": not in_lib,
            "is_new_since_visit": is_new_visit,
        })

    if mark_visited and norm_album:
        merged_seen = sorted(seen_keys | set(current_keys))
        visits[norm_album] = {
            "album_url": norm_album,
            "last_visited_at": time.time(),
            "seen_keys": merged_seen,
            "last_total_count": len(annotated),
        }
        seen_path.write_text(json.dumps(visits, ensure_ascii=False), encoding="utf-8")

    return {
        "album_url": norm_album,
        "has_previous_visit": has_previous_visit,
        "last_visited_at": prev_entry.get("last_visited_at") if isinstance(prev_entry, dict) else None,
        "delta_new_count": len(delta_new_keys),
        "not_in_library_count": len(not_in_lib_keys),
        "in_library_count": in_lib_count,
        "total_count": len(annotated),
        "delta_new_keys": delta_new_keys,
        "not_in_library_keys": not_in_lib_keys,
        "items": annotated,
    }


def list_watchlist(*, directory: Path | None = None) -> list[dict]:
    """Vráti zoznam sledovaných tvorcov, zdrojov, Telegram kanálov/tém a uložených dopytov."""
    root = _root(directory)
    data = _read(root / "watchlist.json", {"items": []})
    items = data.get("items") if isinstance(data, dict) else []
    return [row for row in (items or []) if isinstance(row, dict) and row.get("id")]


def upsert_watchlist_item(entry: dict, *, directory: Path | None = None) -> dict:
    """Pridá alebo aktualizuje položku vo Watchliste (sledovaný tvorca, kanál, album alebo dopyt)."""
    root = _root(directory)
    root.mkdir(parents=True, exist_ok=True)
    path = root / "watchlist.json"
    existing = list_watchlist(directory=directory)

    kind = str(entry.get("kind") or "creator").strip().lower()
    target = str(entry.get("target") or entry.get("url") or entry.get("query") or "").strip()
    title = str(entry.get("title") or target or "Sledovaný zdroj").strip()[:200]
    surface = str(entry.get("surface") or "discovery").strip()
    reason = str(entry.get("reason") or f"Sledovaný {kind}: {title}").strip()[:300]

    raw_id = str(entry.get("id") or "").strip()
    matched = None
    for row in existing:
        if (raw_id and row.get("id") == raw_id) or (
            target and row.get("kind") == kind and str(row.get("target") or "").lower() == target.lower()
        ):
            matched = row
            break

    now = time.time()
    seen_keys = list(dict.fromkeys((matched.get("seen_keys") if matched else []) or entry.get("seen_keys") or []))
    if entry.get("seen_keys") is not None:
        seen_keys = list(dict.fromkeys(entry.get("seen_keys") or []))

    record = {
        "id": matched["id"] if matched else (raw_id if _ID.match(raw_id) else uuid.uuid4().hex[:16]),
        "kind": kind,
        "target": target,
        "title": title,
        "surface": surface,
        "reason": reason,
        "filters": entry.get("filters") if isinstance(entry.get("filters"), dict) else (matched.get("filters", {}) if matched else {}),
        "delta_new_count": int(entry.get("delta_new_count", matched.get("delta_new_count", 0) if matched else 0)),
        "not_in_library_count": int(entry.get("not_in_library_count", matched.get("not_in_library_count", 0) if matched else 0)),
        "seen_keys": seen_keys[:5000],
        "created_at": float(matched.get("created_at") if matched else now),
        "updated_at": now,
    }
    updated_rows = [record] + [r for r in existing if r.get("id") != record["id"]]
    path.write_text(json.dumps({"items": updated_rows}, ensure_ascii=False), encoding="utf-8")
    return record


def remove_watchlist_item(sub_id: str, *, directory: Path | None = None) -> bool:
    """Odstráni položku z Watchlistu podľa ID."""
    root = _root(directory)
    path = root / "watchlist.json"
    existing = list_watchlist(directory=directory)
    kept = [r for r in existing if r.get("id") != sub_id]
    if len(kept) == len(existing):
        return False
    root.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"items": kept}, ensure_ascii=False), encoding="utf-8")
    return True

