"""Služba pre indexáciu, vyhľadávanie a správu Telegram príspevkov s MEGA/externými odkazmi."""
from __future__ import annotations

import asyncio
import json
import logging
import math
from collections import defaultdict
from typing import Any, Iterable

from sqlalchemy import func, inspect, or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .database import (
    MegaHubEntry,
    ResolvedLinkCache,
    TelegramLinkPost,
    TelegramMediaIndex,
    ensure_telegram_links_tables,
    sanitize_fts_query,
    utcnow,
)
from .mega_link_extractor import (
    _domain_of,
    classify_media_url,
    decode_local_wrapper_url,
    extract_keyless_mega_urls,
    extract_mega_urls,
    extract_message_links,
    extract_pack_size,
    extract_pack_tags,
    extract_pack_title,
    extract_text_links,
    has_message_preview,
    is_paste_container_url,
)
from .telegram_stream import peer_id, public_chat_id

logger = logging.getLogger(__name__)

VALID_LINK_STATUSES = frozenset({"new", "opened", "in_hub", "dead", "skipped"})
_PRESERVED_USER_STATUSES = frozenset({"in_hub", "dead", "skipped", "opened"})


def _empty_discovered_bag() -> dict[str, list[dict[str, Any]]]:
    return {"mega": [], "media": [], "containers": []}


def _safe_json_loads(raw: str | None, default: Any) -> Any:
    if not raw:
        return default
    try:
        parsed = json.loads(raw)
        return parsed if type(parsed) is type(default) else default
    except (TypeError, ValueError):
        return default


def parse_extracted_links(row: TelegramLinkPost) -> list[dict[str, Any]]:
    """Vráti uložené linky zo správy (text + entities + inline tlačidlá), s fallbackom na caption."""
    stored = _safe_json_loads(getattr(row, "extracted_links_json", None), [])
    if stored:
        return [item for item in stored if isinstance(item, dict) and item.get("url")]
    caption = row.caption or ""
    parsed = extract_text_links(caption, extra_urls=[row.raw_url] if row.raw_url else ())
    if parsed and parsed.get("extracted_links"):
        return list(parsed["extracted_links"])
    if row.raw_url:
        decoded = decode_local_wrapper_url(row.raw_url)
        eff = decoded or row.raw_url
        return [{
            "url": eff,
            "raw_url": row.raw_url,
            "decoded_url": decoded,
            "domain": _domain_of(eff),
            "label": "",
            "source": "raw",
            "category": "paste" if is_paste_container_url(eff) else ("media_host" if classify_media_url(eff) else "external"),
        }]
    return []


def parse_discovered_links(row: TelegramLinkPost) -> dict[str, list[dict[str, Any]]]:
    """Vráti normalizovaný slovník všetkých objavených odkazov po ceste (mega, media, containers)."""
    raw = _safe_json_loads(getattr(row, "discovered_links_json", None), {})
    bag = _empty_discovered_bag()
    if isinstance(raw, dict):
        if isinstance(raw.get("mega"), list):
            bag["mega"] = [dict(x) for x in raw["mega"] if isinstance(x, dict) and x.get("url")]
        if isinstance(raw.get("media"), list):
            bag["media"] = [dict(x) for x in raw["media"] if isinstance(x, dict) and x.get("url")]
        if isinstance(raw.get("containers"), list):
            bag["containers"] = [dict(x) for x in raw["containers"] if isinstance(x, dict) and x.get("url")]
    # Zaručíme, že priamy/rozbalený MEGA link karty je vždy prítomný aj v bag["mega"].
    primary_mega = (row.resolved_mega_url or "").strip() or (row.raw_url if row.link_kind == "direct_mega" else "")
    if primary_mega and not any(m.get("url") == primary_mega for m in bag["mega"]):
        bag["mega"].insert(0, {
            "url": primary_mega,
            "status": "in_hub" if row.status == "in_hub" else ("dead" if row.status == "dead" else ("available" if (row.mega_video_count or 0) > 0 else "unchecked")),
            "title": row.title or "",
            "video_count": row.mega_video_count,
            "hub_entry_id": row.mega_hub_entry_id,
        })
    return bag


def merge_extracted_links(
    existing: Iterable[dict[str, Any]] | None,
    incoming: Iterable[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Zlúči vyťažené Telegram linky bez straty skrytých entít/tlačidiel."""
    by_url: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for src in (incoming or (), existing or ()):
        for item in src:
            if not isinstance(item, dict):
                continue
            u = str(item.get("url") or "").strip()
            if not u:
                continue
            key = u.rstrip("/")
            if key not in by_url:
                order.append(key)
                by_url[key] = {
                    "url": u,
                    "raw_url": str(item.get("raw_url") or u),
                    "decoded_url": item.get("decoded_url") or None,
                    "domain": str(item.get("domain") or _domain_of(u)),
                    "label": str(item.get("label") or "")[:80],
                    "source": str(item.get("source") or "text"),
                    "category": str(item.get("category") or "external"),
                }
            else:
                cur = by_url[key]
                if not cur.get("label") and item.get("label"):
                    cur["label"] = str(item["label"])[:80]
                if not cur.get("decoded_url") and item.get("decoded_url"):
                    cur["decoded_url"] = item["decoded_url"]
    return [by_url[k] for k in order[:40]]


def merge_discovered_links(
    existing_bag: dict[str, list[dict[str, Any]]] | None,
    *,
    mega_entries: Iterable[dict[str, Any]] | None = None,
    mega_urls: Iterable[str] | None = None,
    media_urls: Iterable[dict[str, Any] | str] | None = None,
    container_urls: Iterable[dict[str, Any] | str] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Zlúči objavené MEGA, media a kontajnerové linky so zachovaním už overených metadát."""
    base = _empty_discovered_bag()
    if isinstance(existing_bag, dict):
        base["mega"] = [dict(x) for x in (existing_bag.get("mega") or []) if isinstance(x, dict) and x.get("url")]
        base["media"] = [dict(x) for x in (existing_bag.get("media") or []) if isinstance(x, dict) and x.get("url")]
        base["containers"] = [dict(x) for x in (existing_bag.get("containers") or []) if isinstance(x, dict) and x.get("url")]

    mega_by_url: dict[str, dict[str, Any]] = {m["url"]: m for m in base["mega"]}
    mega_order: list[str] = [m["url"] for m in base["mega"]]

    def _upsert_mega(entry: dict[str, Any]) -> None:
        u = str(entry.get("url") or "").strip()
        if not u:
            return
        cur = mega_by_url.get(u)
        if cur is None:
            norm_entry = {
                "url": u,
                "status": str(entry.get("status") or "unchecked"),
                "title": str(entry.get("title") or "")[:180],
                "video_count": entry.get("video_count"),
                "hub_entry_id": entry.get("hub_entry_id"),
                "source_url": str(entry.get("source_url") or "")[:300] or None,
            }
            mega_by_url[u] = norm_entry
            mega_order.append(u)
            return
        # Aktualizuj len známejším/bohatším stavom (nezahoď in_hub ani overený počet videí)
        new_status = str(entry.get("status") or "")
        if new_status and (new_status != "unchecked" or cur.get("status") == "unchecked"):
            if cur.get("status") != "in_hub" or new_status == "in_hub":
                cur["status"] = new_status
        if entry.get("title") and (not cur.get("title") or cur["title"].lower() in {"mega priečinok", "mega folder"}):
            cur["title"] = str(entry["title"])[:180]
        if entry.get("video_count") is not None:
            cur["video_count"] = int(entry["video_count"])
        if entry.get("hub_entry_id"):
            cur["hub_entry_id"] = int(entry["hub_entry_id"])
            cur["status"] = "in_hub"
        if entry.get("source_url") and not cur.get("source_url"):
            cur["source_url"] = str(entry["source_url"])[:300]

    for m_url in mega_urls or ():
        for canonical in extract_mega_urls(str(m_url)):
            _upsert_mega({"url": canonical, "status": "unchecked"})
    for m_entry in mega_entries or ():
        if isinstance(m_entry, dict) and m_entry.get("url"):
            _upsert_mega(m_entry)

    media_by_url: dict[str, dict[str, Any]] = {m["url"]: m for m in base["media"]}
    media_order: list[str] = [m["url"] for m in base["media"]]
    for item in media_urls or ():
        info: dict[str, Any] | None = None
        if isinstance(item, str):
            info = classify_media_url(item)
        elif isinstance(item, dict) and item.get("url"):
            classified = classify_media_url(str(item["url"]))
            if classified:
                info = {**classified, **{k: v for k, v in item.items() if v is not None}}
        if not info or not info.get("url"):
            continue
        u = str(info["url"])
        if u not in media_by_url:
            media_by_url[u] = {
                "url": u,
                "raw_url": str(info.get("raw_url") or u),
                "host": str(info.get("host") or _domain_of(u)),
                "kind": str(info.get("kind") or "file"),
                "label": str(info.get("label") or _domain_of(u)),
            }
            media_order.append(u)

    cont_by_url: dict[str, dict[str, Any]] = {c["url"].rstrip("/"): c for c in base["containers"]}
    cont_order: list[str] = [c["url"].rstrip("/") for c in base["containers"]]
    for item in container_urls or ():
        if isinstance(item, str):
            u = item.strip()
            crawled = False
        elif isinstance(item, dict) and item.get("url"):
            u = str(item["url"]).strip()
            crawled = bool(item.get("crawled"))
        else:
            continue
        if not u:
            continue
        key = u.rstrip("/")
        if key not in cont_by_url:
            cont_by_url[key] = {"url": u, "domain": _domain_of(u), "crawled": crawled}
            cont_order.append(key)
        elif crawled:
            cont_by_url[key]["crawled"] = True

    return {
        "mega": [mega_by_url[u] for u in mega_order[:60]],
        "media": [media_by_url[u] for u in media_order[:40]],
        "containers": [cont_by_url[k] for k in cont_order[:15]],
    }


def summarize_discovered_links(bag: dict[str, list[dict[str, Any]]]) -> dict[str, int]:
    megas = bag.get("mega") or []
    medias = bag.get("media") or []
    containers = bag.get("containers") or []
    mega_in_hub = sum(1 for m in megas if m.get("status") == "in_hub" or m.get("hub_entry_id"))
    mega_alive = sum(1 for m in megas if m.get("status") in {"available", "in_hub"})
    mega_dead = sum(1 for m in megas if m.get("status") in {"unavailable", "dead", "empty", "invalid"})
    mega_unchecked = sum(1 for m in megas if m.get("status") in {"unchecked", "retry", ""})
    return {
        "mega_total": len(megas),
        "mega_alive": mega_alive,
        "mega_dead": mega_dead,
        "mega_in_hub": mega_in_hub,
        "mega_unchecked": mega_unchecked,
        "media_total": len(medias),
        "containers_total": len(containers),
    }


def save_post_discovered_links(post: TelegramLinkPost, bag: dict[str, list[dict[str, Any]]]) -> None:
    post.discovered_links_json = json.dumps(bag, ensure_ascii=False)


def save_post_extracted_links(post: TelegramLinkPost, links: list[dict[str, Any]]) -> None:
    post.extracted_links_json = json.dumps(links, ensure_ascii=False)


def normalize_cache_url(url: str) -> str:
    return (url or "").strip().rstrip("/")


def get_cached_resolution(db: Session, url: str) -> dict[str, Any] | None:
    """Vyhľadá už rozbalenú URL v lokálnej tabuľke resolved_link_cache."""
    norm = normalize_cache_url(url)
    if not norm or db is None:
        return None
    bind = db.get_bind()
    if bind is None or not inspect(bind).has_table(ResolvedLinkCache.__tablename__):
        return None
    row = db.query(ResolvedLinkCache).filter(ResolvedLinkCache.source_url == norm).first()
    if row is None:
        return None
    payload = _safe_json_loads(row.result_json, {})
    if not isinstance(payload, dict):
        return None
    row.hits = int(row.hits or 0) + 1
    row.updated_at = utcnow()
    try:
        db.commit()
    except Exception:
        db.rollback()
    return {
        "source_url": row.source_url,
        "final_url": row.final_url or payload.get("final_url") or url,
        "provider": row.provider or "cache",
        "mega_urls": list(payload.get("mega_urls") or []),
        "media_urls": list(payload.get("media_urls") or []),
        "container_urls": list(payload.get("container_urls") or []),
    }


def save_cached_resolution(
    db: Session,
    source_url: str,
    *,
    final_url: str | None = None,
    mega_urls: Iterable[str] = (),
    media_urls: Iterable[dict[str, Any]] = (),
    container_urls: Iterable[dict[str, Any]] = (),
    provider: str = "clean_http",
) -> None:
    """Uloží rozbalený výsledok skracovača/paste stránky do lokálnej cache pre budúce reposty."""
    norm = normalize_cache_url(source_url)
    if not norm or db is None:
        return
    megas = [u for u in dict.fromkeys(str(x).strip() for x in (mega_urls or ()) if x)]
    medias = [dict(x) for x in (media_urls or ()) if isinstance(x, dict) and x.get("url")]
    conts = [dict(x) for x in (container_urls or ()) if isinstance(x, dict) and x.get("url")]
    final_clean = (final_url or "").strip()
    # Neukladáme bezvýsledné brány (kde sa nič nezmenilo ani nenašlo)
    if not megas and not medias and not conts and (not final_clean or normalize_cache_url(final_clean) == norm):
        return

    bind = db.get_bind()
    if bind is None:
        return
    if not inspect(bind).has_table(ResolvedLinkCache.__tablename__):
        ensure_telegram_links_tables(bind)

    now = utcnow()
    existing = db.query(ResolvedLinkCache).filter(ResolvedLinkCache.source_url == norm).first()
    if existing is not None:
        old = _safe_json_loads(existing.result_json, {})
        merged_megas = list(dict.fromkeys([*(old.get("mega_urls") or []), *megas]))[:60]
        media_map = {m["url"]: m for m in (old.get("media_urls") or []) if isinstance(m, dict) and m.get("url")}
        for m in medias:
            media_map.setdefault(m["url"], m)
        cont_map = {c["url"].rstrip("/"): c for c in (old.get("container_urls") or []) if isinstance(c, dict) and c.get("url")}
        for c in conts:
            cont_map[c["url"].rstrip("/")] = c
        existing.final_url = final_clean or existing.final_url
        existing.provider = provider or existing.provider
        existing.result_json = json.dumps({
            "final_url": existing.final_url,
            "mega_urls": merged_megas,
            "media_urls": list(media_map.values())[:40],
            "container_urls": list(cont_map.values())[:15],
        }, ensure_ascii=False)
        existing.updated_at = now
    else:
        db.add(ResolvedLinkCache(
            source_url=norm,
            final_url=final_clean or (megas[0] if megas else norm),
            provider=provider or "clean_http",
            result_json=json.dumps({
                "final_url": final_clean or (megas[0] if megas else norm),
                "mega_urls": megas[:60],
                "media_urls": medias[:40],
                "container_urls": conts[:15],
            }, ensure_ascii=False),
            hits=1,
            created_at=now,
            updated_at=now,
        ))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()


def _lookup_media_video_map(db: Session | None, pairs: Iterable[tuple[int, int]]) -> dict[tuple[int, int], str]:
    """Vráti mapu (chat_id, message_id) -> duration pre príspevky, ktoré majú v DB ukážkové video."""
    if db is None:
        return {}
    bind = db.get_bind()
    if bind is None or not inspect(bind).has_table(TelegramMediaIndex.__tablename__):
        return {}
    pair_list = list({(public_chat_id(int(c)), int(m)) for c, m in pairs if c and m})
    if not pair_list:
        return {}
    chat_set = list({c for c, _ in pair_list})
    msg_set = list({m for _, m in pair_list})
    rows = (
        db.query(TelegramMediaIndex.chat_id, TelegramMediaIndex.message_id, TelegramMediaIndex.duration)
        .filter(
            TelegramMediaIndex.chat_id.in_(chat_set),
            TelegramMediaIndex.message_id.in_(msg_set),
        )
        .all()
    )
    wanted = set(pair_list)
    out: dict[tuple[int, int], str] = {}
    for cid, mid, dur in rows:
        key = (public_chat_id(int(cid)), int(mid))
        if key in wanted:
            out[key] = str(dur or "")
    return out


def serialize_link_post(
    row: TelegramLinkPost,
    *,
    video_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Serializuje DB riadok TelegramLinkPost do odpovede pre API (so všetkými vyťaženými aj objavenými linkami)."""
    caption = row.caption or ""
    raw_url = row.raw_url or ""
    final_url = row.final_url or raw_url
    parsed_links = extract_text_links(caption) if caption else None

    clean_title = extract_pack_title(caption, fallback=row.title or "") if caption else (row.title or "")
    if not clean_title:
        clean_title = row.title or f"Telegram #{row.message_id}"

    pack_size = parsed_links.get("pack_size", "") if parsed_links else extract_pack_size(caption)
    tags = parsed_links.get("tags", []) if parsed_links else extract_pack_tags(caption)

    extracted_links = parse_extracted_links(row)
    discovered = parse_discovered_links(row)
    harvest_summary = summarize_discovered_links(discovered)

    alt_urls: list[dict[str, str]] = []
    seen_urls = {raw_url.rstrip("/"), final_url.rstrip("/")}
    if row.resolved_mega_url:
        seen_urls.add(row.resolved_mega_url.rstrip("/"))
    for ext_item in extracted_links:
        cand = str(ext_item.get("url") or "").strip()
        norm_c = cand.rstrip("/")
        if norm_c and norm_c not in seen_urls and ext_item.get("category") != "mega":
            seen_urls.add(norm_c)
            alt_urls.append({
                "url": cand,
                "domain": str(ext_item.get("domain") or _domain_of(cand)),
            })
    if parsed_links:
        for candidate in parsed_links.get("external_urls", []):
            norm_c = candidate.rstrip("/")
            if norm_c and norm_c not in seen_urls:
                seen_urls.add(norm_c)
                alt_urls.append({
                    "url": candidate,
                    "domain": _domain_of(candidate),
                })

    thumb = row.thumbnail or ""
    has_video = bool(
        (video_meta and video_meta.get("has_video_preview"))
        or thumb.startswith("/api/v1/telegram/thumb/")
        or "video=1" in thumb
    )
    video_duration = str((video_meta or {}).get("video_duration") or "")
    if not video_duration and "dur=" in thumb:
        from urllib.parse import parse_qs, urlsplit
        try:
            video_duration = (parse_qs(urlsplit(thumb).query).get("dur") or [""])[0]
        except Exception:
            video_duration = ""
    chat_id_int = int(row.chat_id)
    msg_id_int = int(row.message_id)

    keyless_info = None
    if not row.resolved_mega_url and (row.link_kind or "external") == "external":
        keyless_list = extract_keyless_mega_urls(caption, extra_urls=(raw_url,))
        if keyless_list:
            keyless_info = keyless_list[0]

    is_paste_free = bool(
        is_paste_container_url(final_url)
        or is_paste_container_url(raw_url)
        or discovered["containers"]
        or discovered["media"]
        or any(e.get("category") in {"paste", "media_host"} for e in extracted_links)
    )
    has_hidden_links = bool(
        len(extracted_links) > 1
        or harvest_summary["mega_total"] > 1
        or harvest_summary["media_total"] > 0
        or len(alt_urls) > 0
    )

    return {
        "id": int(row.id),
        "chat_id": chat_id_int,
        "message_id": msg_id_int,
        "channel": row.channel or "",
        "channel_title": row.channel_title or row.channel or "",
        "title": clean_title,
        "caption": caption,
        "post_url": row.post_url or "",
        "raw_url": raw_url,
        "final_url": final_url,
        "domain": row.domain or _domain_of(final_url),
        "link_kind": row.link_kind or "external",
        "resolved_mega_url": row.resolved_mega_url,
        "keyless_mega_url": keyless_info["url"] if keyless_info else None,
        "keyless_mega_kind": keyless_info["kind"] if keyless_info else None,
        "keyless_mega_handle": keyless_info["handle"] if keyless_info else None,
        "alt_urls": alt_urls,
        "extracted_links": extracted_links,
        "extracted_count": len(extracted_links),
        "discovered_mega_urls": discovered["mega"],
        "discovered_media_urls": discovered["media"],
        "discovered_containers": discovered["containers"],
        "harvest_summary": harvest_summary,
        "is_paste_free": is_paste_free,
        "has_hidden_links": has_hidden_links,
        "needs_entity_backfill": getattr(row, "extracted_links_json", None) is None,
        "pack_size": pack_size,
        "tags": tags,
        "has_photo": bool(row.has_photo or has_video),
        "thumbnail": thumb,
        "has_video_preview": has_video,
        "video_duration": video_duration,
        "video_stream_url": f"/api/v1/telegram/stream/{chat_id_int}/{msg_id_int}?preview=1" if has_video else "",
        "date": row.date or "",
        "views": int(row.views or 0),
        "reactions": int(row.reactions or 0),
        "status": row.status or "new",
        "mega_hub_entry_id": row.mega_hub_entry_id,
        "mega_video_count": row.mega_video_count,
        "indexed_at": row.indexed_at.isoformat() + "Z" if row.indexed_at else None,
        "updated_at": row.updated_at.isoformat() + "Z" if row.updated_at else None,
    }


def _sync_hub_entries_state(db: Session) -> bool:
    """Zosynchronizuje stav in_hub a počty videí voči aktuálnym položkám v mega_hub_entries (vrátane multi-MEGA bagu)."""
    bind = db.get_bind()
    if bind is None:
        return False
    inspector = inspect(bind)
    if not (inspector.has_table(TelegramLinkPost.__tablename__) and inspector.has_table(MegaHubEntry.__tablename__)):
        return False

    hub_rows = db.query(MegaHubEntry.id, MegaHubEntry.url, MegaHubEntry.snapshot).all()
    by_url: dict[str, tuple[int, int]] = {}
    by_id: dict[int, int] = {}
    for entry_id, url, snapshot in hub_rows:
        video_count = len((snapshot or {}).get("videos", [])) if isinstance(snapshot, dict) else 0
        by_url[url] = (int(entry_id), video_count)
        by_id[int(entry_id)] = video_count

    posts = (
        db.query(TelegramLinkPost)
        .filter(
            or_(
                TelegramLinkPost.resolved_mega_url.isnot(None),
                TelegramLinkPost.mega_hub_entry_id.isnot(None),
                TelegramLinkPost.discovered_links_json.isnot(None),
            )
        )
        .all()
    )
    changed = False
    now = utcnow()
    for post in posts:
        post_changed = False
        bag = parse_discovered_links(post)
        bag_changed = False
        first_hub_hit: tuple[int, int, str] | None = None
        for m in bag["mega"]:
            m_url = m.get("url") or ""
            hit = by_url.get(m_url)
            if hit is not None:
                entry_id, video_count = hit
                if first_hub_hit is None:
                    first_hub_hit = (entry_id, video_count, m_url)
                if m.get("status") != "in_hub" or m.get("hub_entry_id") != entry_id or m.get("video_count") != video_count:
                    m["status"] = "in_hub"
                    m["hub_entry_id"] = entry_id
                    m["video_count"] = video_count
                    bag_changed = True
            elif m.get("hub_entry_id") and int(m["hub_entry_id"]) not in by_id:
                m["hub_entry_id"] = None
                if m.get("status") == "in_hub":
                    m["status"] = "available" if (m.get("video_count") or 0) > 0 else "unchecked"
                bag_changed = True
        if bag_changed:
            save_post_discovered_links(post, bag)
            post_changed = True

        hub_hit = by_url.get(post.resolved_mega_url or "")
        if hub_hit is None and first_hub_hit is not None:
            hub_hit = (first_hub_hit[0], first_hub_hit[1])
            if not post.resolved_mega_url:
                post.resolved_mega_url = first_hub_hit[2]
        if hub_hit is not None:
            entry_id, video_count = hub_hit
            total_in_hub_videos = sum(int(m.get("video_count") or 0) for m in bag["mega"] if m.get("status") == "in_hub") or video_count
            if post.status != "in_hub" or post.mega_hub_entry_id != entry_id or post.mega_video_count != total_in_hub_videos:
                post.status = "in_hub"
                post.mega_hub_entry_id = entry_id
                post.mega_video_count = total_in_hub_videos
                post_changed = True
        elif post.mega_hub_entry_id is not None and post.mega_hub_entry_id not in by_id:
            post.mega_hub_entry_id = None
            if post.status == "in_hub":
                post.status = "opened" if post.link_kind != "direct_mega" else "new"
            post_changed = True

        if post_changed:
            post.updated_at = now
            changed = True

    if changed:
        db.commit()
    return changed


def upsert_telegram_link_posts(db: Session, items: Iterable[dict[str, Any]], *, commit: bool = True) -> dict[str, Any]:
    """Bezpečne uloží alebo aktualizuje Telegram link posty bez prepísania používateľského stavu."""
    bind = db.get_bind()
    if bind is not None and not inspect(bind).has_table(TelegramLinkPost.__tablename__):
        ensure_telegram_links_tables(bind)

    hub_by_url: dict[str, tuple[int, int]] = {}
    if bind is not None and inspect(bind).has_table(MegaHubEntry.__tablename__):
        for entry_id, url, snapshot in db.query(MegaHubEntry.id, MegaHubEntry.url, MegaHubEntry.snapshot).all():
            video_count = len((snapshot or {}).get("videos", [])) if isinstance(snapshot, dict) else 0
            hub_by_url[url] = (int(entry_id), video_count)

    deduped: list[dict[str, Any]] = []
    seen_keys: set[tuple[int, int, str]] = set()
    for raw in items or ():
        try:
            chat_id = int(raw["chat_id"])
            message_id = int(raw["message_id"])
        except (KeyError, TypeError, ValueError):
            continue
        raw_url = str(raw.get("raw_url") or "").strip()
        if not raw_url:
            continue
        key = (chat_id, message_id, raw_url)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        deduped.append({**raw, "chat_id": chat_id, "message_id": message_id, "raw_url": raw_url})

    added = 0
    updated = 0
    rows_out: list[TelegramLinkPost] = []
    now = utcnow()

    # Prednačítame existujúce záznamy jedným dopytom (O(1) lookup namiesto 2×N dopytov v slučke).
    existing_by_key: dict[tuple[int, int, str], TelegramLinkPost] = {}
    existing_ext_by_msg: dict[tuple[int, int], TelegramLinkPost] = {}
    if deduped:
        batch_chats = list({item["chat_id"] for item in deduped})
        batch_msgs = list({item["message_id"] for item in deduped})
        # SQLite má limit parametrov (999/32766) -> ak je správ veľa, načítame podľa chat_id.
        q_existing = db.query(TelegramLinkPost).filter(TelegramLinkPost.chat_id.in_(batch_chats))
        if len(batch_msgs) <= 500:
            q_existing = q_existing.filter(TelegramLinkPost.message_id.in_(batch_msgs))
        for ex in q_existing.all():
            existing_by_key[(int(ex.chat_id), int(ex.message_id), ex.raw_url)] = ex
            if ex.link_kind == "external":
                existing_ext_by_msg.setdefault((int(ex.chat_id), int(ex.message_id)), ex)

    for item in deduped:
        chat_id = item["chat_id"]
        message_id = item["message_id"]
        raw_url = item["raw_url"]
        resolved_mega_url = (item.get("resolved_mega_url") or "").strip() or None
        hub_hit = hub_by_url.get(resolved_mega_url or "")

        existing = existing_by_key.get((chat_id, message_id, raw_url))
        if existing is None and item.get("link_kind", "external") == "external":
            # Jeden príspevok s 2 externými mirrormi (napr. onlyshare.info + link-center.net) držíme ako 1 kartu.
            existing = existing_ext_by_msg.get((chat_id, message_id))
        if existing is not None:
            old_raw = existing.raw_url
            if item.get("channel"):
                existing.channel = str(item["channel"])
            if item.get("channel_title"):
                existing.channel_title = str(item["channel_title"])
            if item.get("title"):
                existing.title = str(item["title"])[:180]
            new_caption = str(item.get("caption") or "")
            if len(new_caption) >= len(existing.caption or "") and new_caption:
                existing.caption = new_caption
            if item.get("post_url") and not existing.post_url:
                existing.post_url = str(item["post_url"])
            if item.get("has_photo"):
                existing.has_photo = True
            if item.get("thumbnail") and not existing.thumbnail:
                existing.thumbnail = str(item["thumbnail"])
            if item.get("date") and not existing.date:
                existing.date = str(item["date"])
            existing.views = max(int(existing.views or 0), int(item.get("views") or 0))
            existing.reactions = max(int(existing.reactions or 0), int(item.get("reactions") or 0))

            if existing.raw_url != raw_url and not existing.resolved_mega_url:
                existing_by_key.pop((chat_id, message_id, old_raw), None)
                existing.raw_url = raw_url
                existing.final_url = str(item.get("final_url") or raw_url)
                existing.domain = str(item.get("domain") or _domain_of(raw_url))
                existing_by_key[(chat_id, message_id, raw_url)] = existing

            if resolved_mega_url and not existing.resolved_mega_url:
                existing.resolved_mega_url = resolved_mega_url
                existing.final_url = str(item.get("final_url") or resolved_mega_url)
                existing.domain = "mega.nz"
                if existing.link_kind == "external":
                    existing.link_kind = str(item.get("link_kind") or "direct_mega")

            # Zlúčenie všetkých vyťažených odkazov (text + entities + inline tlačidlá) a objaveného bagu
            incoming_ext = item.get("extracted_links")
            if incoming_ext:
                merged_ext = merge_extracted_links(parse_extracted_links(existing), incoming_ext)
                save_post_extracted_links(existing, merged_ext)
            inc_mega = item.get("mega_urls") or ([resolved_mega_url] if resolved_mega_url else ())
            inc_media = item.get("media_urls") or ()
            inc_cont = item.get("container_urls") or ()
            if inc_mega or inc_media or inc_cont or item.get("discovered_links"):
                cur_bag = parse_discovered_links(existing)
                inc_bag = item.get("discovered_links") if isinstance(item.get("discovered_links"), dict) else {}
                merged_bag = merge_discovered_links(
                    cur_bag,
                    mega_entries=inc_bag.get("mega"),
                    mega_urls=inc_mega,
                    media_urls=[*(inc_bag.get("media") or []), *inc_media],
                    container_urls=[*(inc_bag.get("containers") or []), *inc_cont],
                )
                save_post_discovered_links(existing, merged_bag)

            if hub_hit is not None:
                existing.status = "in_hub"
                existing.mega_hub_entry_id = hub_hit[0]
                existing.mega_video_count = hub_hit[1]
            elif existing.status not in _PRESERVED_USER_STATUSES:
                existing.status = "new"

            existing.updated_at = now
            rows_out.append(existing)
            updated += 1
            continue

        init_ext_json = (
            json.dumps(merge_extracted_links(None, item.get("extracted_links")), ensure_ascii=False)
            if item.get("extracted_links")
            else None
        )
        inc_mega = item.get("mega_urls") or ([resolved_mega_url] if resolved_mega_url else ())
        inc_media = item.get("media_urls") or ()
        inc_cont = item.get("container_urls") or ()
        inc_bag = item.get("discovered_links") if isinstance(item.get("discovered_links"), dict) else {}
        init_bag = merge_discovered_links(
            None,
            mega_entries=inc_bag.get("mega"),
            mega_urls=inc_mega,
            media_urls=[*(inc_bag.get("media") or []), *inc_media],
            container_urls=[*(inc_bag.get("containers") or []), *inc_cont],
        )
        init_disc_json = (
            json.dumps(init_bag, ensure_ascii=False)
            if (init_bag["mega"] or init_bag["media"] or init_bag["containers"])
            else None
        )

        row = TelegramLinkPost(
            chat_id=chat_id,
            message_id=message_id,
            channel=str(item.get("channel") or ""),
            channel_title=str(item.get("channel_title") or item.get("channel") or ""),
            title=str(item.get("title") or "")[:180],
            caption=str(item.get("caption") or ""),
            post_url=str(item.get("post_url") or ""),
            raw_url=raw_url,
            final_url=str(item.get("final_url") or resolved_mega_url or raw_url),
            domain=str(item.get("domain") or ""),
            link_kind=str(item.get("link_kind") or ("direct_mega" if resolved_mega_url else "external")),
            resolved_mega_url=resolved_mega_url,
            has_photo=bool(item.get("has_photo")),
            thumbnail=str(item.get("thumbnail") or ""),
            date=str(item.get("date") or ""),
            views=int(item.get("views") or 0),
            reactions=int(item.get("reactions") or 0),
            status="in_hub" if hub_hit is not None else "new",
            mega_hub_entry_id=hub_hit[0] if hub_hit is not None else None,
            mega_video_count=hub_hit[1] if hub_hit is not None else item.get("mega_video_count"),
            extracted_links_json=init_ext_json,
            discovered_links_json=init_disc_json,
            indexed_at=now,
            updated_at=now,
        )
        db.add(row)
        existing_by_key[(chat_id, message_id, raw_url)] = row
        if row.link_kind == "external":
            existing_ext_by_msg[(chat_id, message_id)] = row
        rows_out.append(row)
        added += 1

    if commit:
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise
    else:
        db.flush()

    return {
        "added": added,
        "updated": updated,
        "total_processed": added + updated,
        "rows": rows_out,
    }


def seed_links_from_media_index(
    db: Session,
    limit: int = 5000,
    chat_ids: list[int] | None = None,
) -> dict[str, int]:
    """Extrahuje priame MEGA odkazy aj externé balíčkové odkazy (s video ukážkou) z Telegram video indexu."""
    bind = db.get_bind()
    if bind is None:
        return {"scanned": 0, "found_links": 0, "added": 0, "updated": 0}
    ensure_telegram_links_tables(bind)
    if not inspect(bind).has_table(TelegramMediaIndex.__tablename__):
        return {"scanned": 0, "found_links": 0, "added": 0, "updated": 0}

    capped = max(1, min(int(limit or 5000), 25000))
    low_cap = func.lower(func.coalesce(TelegramMediaIndex.caption, ""))
    query = db.query(
        TelegramMediaIndex.chat_id,
        TelegramMediaIndex.message_id,
        TelegramMediaIndex.channel,
        TelegramMediaIndex.channel_title,
        TelegramMediaIndex.title,
        TelegramMediaIndex.file_name,
        TelegramMediaIndex.caption,
        TelegramMediaIndex.url,
        TelegramMediaIndex.thumbnail,
        TelegramMediaIndex.has_thumb,
        TelegramMediaIndex.date,
        TelegramMediaIndex.views,
        TelegramMediaIndex.reactions,
    ).filter(
        or_(
            low_cap.like("%mega.nz%"),
            low_cap.like("%mega.co.nz%"),
            low_cap.like("%onlyshare.info/%"),
            low_cap.like("%speedy-links.com/%"),
            low_cap.like("%megadropz.com/%"),
            low_cap.like("%megadropz.net/%"),
            low_cap.like("%links2megas.com/%"),
            low_cap.like("%link-to.net/%"),
            low_cap.like("%link-center.net/%"),
            low_cap.like("%link-hub.net/%"),
            low_cap.like("%link-target.net/%"),
            low_cap.like("%direct-link.net/%"),
            low_cap.like("%linkvertise.com/%"),
            low_cap.like("%bstlar.com/%"),
            low_cap.like("%rentry.org/%"),
            low_cap.like("%rentry.co/%"),
            low_cap.like("%pastebin.com/%"),
            low_cap.like("%bunkr%/%"),
            low_cap.like("%gofile.io/%"),
            low_cap.like("%pixeldrain.com/%"),
        )
    )
    if chat_ids:
        norm_ids = list({public_chat_id(int(cid)) for cid in chat_ids} | {int(cid) for cid in chat_ids})
        query = query.filter(TelegramMediaIndex.chat_id.in_(norm_ids))

    media_rows = query.order_by(TelegramMediaIndex.id.desc()).limit(capped).all()

    collected: list[dict[str, Any]] = []
    for (
        row_chat_id,
        row_msg_id,
        row_channel,
        row_channel_title,
        row_title,
        row_file_name,
        row_caption,
        row_url,
        row_thumbnail,
        row_has_thumb,
        row_date,
        row_views,
        row_reactions,
    ) in media_rows:
        caption = row_caption or ""
        parsed = extract_text_links(caption)
        if not parsed:
            continue
        fallback = row_title or row_file_name or f"Telegram #{row_msg_id}"
        title = extract_pack_title(caption, fallback=fallback)
        cid = public_chat_id(int(row_chat_id))
        thumb = row_thumbnail or (f"/api/v1/telegram/thumb/{cid}/{row_msg_id}" if row_has_thumb else f"/api/v1/telegram/post-thumb/{cid}/{row_msg_id}")
        channel_clean = str(row_channel or "").lstrip("@")
        post_url = row_url or (
            f"https://t.me/{channel_clean}/{row_msg_id}"
            if channel_clean and not channel_clean.lstrip("-").isdigit()
            else f"https://t.me/c/{cid}/{row_msg_id}"
        )
        mega_urls = parsed.get("mega_urls") or []
        if mega_urls:
            for mega_url in mega_urls:
                collected.append({
                    "chat_id": cid,
                    "message_id": int(row_msg_id),
                    "channel": row_channel or "",
                    "channel_title": row_channel_title or row_channel or "",
                    "title": title,
                    "caption": caption,
                    "post_url": post_url,
                    "raw_url": mega_url,
                    "final_url": mega_url,
                    "domain": "mega.nz",
                    "link_kind": "direct_mega",
                    "resolved_mega_url": mega_url,
                    "has_photo": True,
                    "thumbnail": thumb,
                    "date": row_date or "",
                    "views": int(row_views or 0),
                    "reactions": int(row_reactions or 0),
                    "extracted_links": parsed.get("extracted_links") or [],
                    "mega_urls": mega_urls,
                    "media_urls": parsed.get("media_urls") or [],
                    "container_urls": parsed.get("container_urls") or [],
                })
        elif parsed.get("primary_url"):
            primary_url = parsed["primary_url"]
            collected.append({
                "chat_id": cid,
                "message_id": int(row_msg_id),
                "channel": row_channel or "",
                "channel_title": row_channel_title or row_channel or "",
                "title": title,
                "caption": caption,
                "post_url": post_url,
                "raw_url": primary_url,
                "final_url": primary_url,
                "domain": parsed.get("domain") or _domain_of(primary_url),
                "link_kind": "external",
                "resolved_mega_url": None,
                "has_photo": True,
                "thumbnail": thumb,
                "date": row_date or "",
                "views": int(row_views or 0),
                "reactions": int(row_reactions or 0),
                "extracted_links": parsed.get("extracted_links") or [],
                "media_urls": parsed.get("media_urls") or [],
                "container_urls": parsed.get("container_urls") or [],
            })

    total_added = 0
    total_updated = 0
    chunk_size = 1500
    for start in range(0, len(collected), chunk_size):
        res = upsert_telegram_link_posts(db, collected[start:start + chunk_size])
        total_added += int(res["added"])
        total_updated += int(res["updated"])

    return {
        "scanned": len(media_rows),
        "found_links": len(collected),
        "added": total_added,
        "updated": total_updated,
    }


def _fts_prefix_expr(raw_query: str) -> str:
    sanitized = sanitize_fts_query(raw_query)
    if not sanitized:
        return ""
    tokens = [tok for tok in sanitized.split() if tok]
    return " AND ".join(f"{tok}*" for tok in tokens)


def search_telegram_links_local(
    db: Session,
    query: str = "",
    *,
    channel: str = "",
    chat_ids: list[int] | None = None,
    status: str = "active",
    link_kind: str = "all",
    sort: str = "newest",
    limit: int = 60,
    offset: int = 0,
) -> dict[str, Any]:
    """Vyhľadá uložené Telegram link príspevky cez FTS5 s filtrami stavu a typu odkazu."""
    bind = db.get_bind()
    if bind is not None and not inspect(bind).has_table(TelegramLinkPost.__tablename__):
        return {
            "items": [],
            "total": 0,
            "has_more": False,
            "counts": {"all": 0, "active": 0, "new": 0, "opened": 0, "in_hub": 0, "dead": 0, "mega": 0, "external": 0},
        }

    _sync_hub_entries_state(db)

    base = db.query(TelegramLinkPost)
    cleaned_channel = (channel or "").strip().lstrip("@").lower()
    if cleaned_channel:
        pat = f"%{cleaned_channel}%"
        base = base.filter(
            or_(
                func.lower(func.coalesce(TelegramLinkPost.channel, "")).like(pat),
                func.lower(func.coalesce(TelegramLinkPost.channel_title, "")).like(pat),
            )
        )
    if chat_ids:
        norm_ids = list({public_chat_id(int(cid)) for cid in chat_ids} | {int(cid) for cid in chat_ids})
        base = base.filter(TelegramLinkPost.chat_id.in_(norm_ids))

    raw_query = (query or "").strip()
    if raw_query:
        has_fts = bind is not None and inspect(bind).has_table("telegram_links_fts")
        fts_expr = _fts_prefix_expr(raw_query) if has_fts else ""
        used_fts = False
        if fts_expr:
            try:
                fts_subquery = text(
                    "SELECT rowid FROM telegram_links_fts WHERE telegram_links_fts MATCH :expr"
                ).bindparams(expr=fts_expr)
                base = base.filter(TelegramLinkPost.id.in_(fts_subquery))
                used_fts = True
            except Exception:
                used_fts = False
        if not used_fts:
            like_pat = f"%{raw_query.lower()}%"
            base = base.filter(
                or_(
                    func.lower(func.coalesce(TelegramLinkPost.title, "")).like(like_pat),
                    func.lower(func.coalesce(TelegramLinkPost.caption, "")).like(like_pat),
                    func.lower(func.coalesce(TelegramLinkPost.channel, "")).like(like_pat),
                    func.lower(func.coalesce(TelegramLinkPost.channel_title, "")).like(like_pat),
                    func.lower(func.coalesce(TelegramLinkPost.domain, "")).like(like_pat),
                    func.lower(func.coalesce(TelegramLinkPost.raw_url, "")).like(like_pat),
                )
            )

    grouped_counts = (
        base.with_entities(TelegramLinkPost.status, TelegramLinkPost.link_kind, func.count(TelegramLinkPost.id))
        .group_by(TelegramLinkPost.status, TelegramLinkPost.link_kind)
        .all()
    )
    counts = {
        "all": 0,
        "active": 0,
        "new": 0,
        "opened": 0,
        "in_hub": 0,
        "dead": 0,
        "mega": 0,
        "external": 0,
        "paste": 0,
        "multi": 0,
        "missing_entities": 0,
    }
    for st_val, kind_val, cnt in grouped_counts:
        n = int(cnt or 0)
        counts["all"] += n
        if st_val in {"dead", "skipped"}:
            counts["dead"] += n
        else:
            counts["active"] += n
            if st_val in {"new", "opened", "in_hub"}:
                counts[st_val] += n
        if kind_val in {"direct_mega", "resolved_mega"}:
            counts["mega"] += n
        elif kind_val == "external":
            counts["external"] += n

    from .mega_link_extractor import _PASTE_CONTAINER_HOSTS

    paste_expr = or_(
        func.lower(func.coalesce(TelegramLinkPost.domain, "")).in_(tuple(_PASTE_CONTAINER_HOSTS)),
        func.coalesce(TelegramLinkPost.extracted_links_json, "").like('%"category": "paste"%'),
        func.coalesce(TelegramLinkPost.extracted_links_json, "").like('%"category": "media_host"%'),
        func.coalesce(TelegramLinkPost.discovered_links_json, "").like('%"containers": [{%'),
        func.coalesce(TelegramLinkPost.discovered_links_json, "").like('%"media": [{%'),
    )
    multi_expr = or_(
        func.coalesce(TelegramLinkPost.extracted_links_json, "").like('%{%}, {%'),
        func.coalesce(TelegramLinkPost.discovered_links_json, "").like('%"mega": [{%}, {%'),
        func.coalesce(TelegramLinkPost.discovered_links_json, "").like('%"media": [{%'),
    )
    active_base = base.filter(~TelegramLinkPost.status.in_(("dead", "skipped")))
    counts["paste"] = int(active_base.filter(paste_expr).count() or 0)
    counts["multi"] = int(active_base.filter(multi_expr).count() or 0)
    counts["missing_entities"] = int(
        active_base.filter(
            TelegramLinkPost.extracted_links_json.is_(None),
            TelegramLinkPost.link_kind == "external",
        ).count()
        or 0
    )

    filtered = base
    status_norm = (status or "active").strip().lower()
    if status_norm == "active":
        filtered = filtered.filter(~TelegramLinkPost.status.in_(("dead", "skipped")))
    elif status_norm == "dead":
        filtered = filtered.filter(TelegramLinkPost.status.in_(("dead", "skipped")))
    elif status_norm in VALID_LINK_STATUSES:
        filtered = filtered.filter(TelegramLinkPost.status == status_norm)

    kind_norm = (link_kind or "all").strip().lower()
    if kind_norm == "mega":
        filtered = filtered.filter(TelegramLinkPost.link_kind.in_(("direct_mega", "resolved_mega")))
    elif kind_norm == "paste":
        filtered = filtered.filter(paste_expr)
    elif kind_norm == "multi":
        filtered = filtered.filter(multi_expr)
    elif kind_norm == "external":
        filtered = filtered.filter(TelegramLinkPost.link_kind == "external")

    total = filtered.count()
    capped_limit = max(1, min(int(limit or 60), 500))
    safe_offset = max(0, int(offset or 0))
    sort_norm = (sort or "newest").strip().lower()
    if sort_norm == "reactions":
        order_cols = (func.coalesce(TelegramLinkPost.reactions, 0).desc(), TelegramLinkPost.id.desc())
    elif sort_norm == "views":
        order_cols = (func.coalesce(TelegramLinkPost.views, 0).desc(), TelegramLinkPost.id.desc())
    elif sort_norm == "videos":
        order_cols = (func.coalesce(TelegramLinkPost.mega_video_count, -1).desc(), TelegramLinkPost.id.desc())
    else:
        order_cols = (func.coalesce(TelegramLinkPost.date, "").desc(), TelegramLinkPost.id.desc())
    rows = (
        filtered.order_by(*order_cols)
        .offset(safe_offset)
        .limit(capped_limit)
        .all()
    )

    video_map = _lookup_media_video_map(db, [(r.chat_id, r.message_id) for r in rows])
    return {
        "items": [
            serialize_link_post(
                r,
                video_meta=(
                    {"has_video_preview": True, "video_duration": video_map[(public_chat_id(int(r.chat_id)), int(r.message_id))]}
                    if (public_chat_id(int(r.chat_id)), int(r.message_id)) in video_map
                    else None
                ),
            )
            for r in rows
        ],
        "total": total,
        "has_more": (safe_offset + len(rows)) < total,
        "counts": counts,
    }


def _message_reactions_count(message: Any) -> int:
    reactions = getattr(message, "reactions", None)
    if not reactions or not hasattr(reactions, "results"):
        return 0
    return sum(int(getattr(r, "count", 0) or 0) for r in reactions.results)


async def scan_telegram_links_live(
    db: Session,
    *,
    query: str = "",
    channel: str = "",
    chat_ids: list[int] | None = None,
    limit: int = 80,
) -> dict[str, Any]:
    """Naživo prehľadá Telegram správy cez InputMessagesFilterUrl a uloží odkazy do katalógu."""
    from telethon.errors import FloodWaitError
    from telethon.tl.types import InputMessagesFilterUrl

    from .telegram_service import (
        _GLOBAL_PAUSE,
        _entity_for,
        _open_channel,
        _search_semaphore,
        client,
        normalize_channel_name,
    )

    bind = db.get_bind()
    if bind is not None:
        ensure_telegram_links_tables(bind)

    scan_limit = max(10, min(int(limit or 80), 400))
    cleaned_query = (query or "").strip()
    cleaned_channel = normalize_channel_name(channel or "")

    connection = await client()
    targets: list[tuple[Any, str, int]] = []

    if cleaned_channel:
        connection, entity, norm_name = await _open_channel(cleaned_channel)
        targets.append((entity, norm_name, scan_limit))
    elif chat_ids:
        selected = [int(cid) for cid in chat_ids[:20]]
        per_peer = max(15, -(-scan_limit // len(selected)))
        for cid in selected:
            target_id = cid if cid < 0 else peer_id(cid)
            entity = await connection.get_entity(target_id)
            targets.append((entity, str(getattr(entity, "username", None) or public_chat_id(cid)), per_peer))
    else:
        targets.append((None, "", scan_limit))

    collected: list[dict[str, Any]] = []
    scanned = 0
    flood_wait = 0

    try:
        async with _search_semaphore():
            for target_entity, fallback_label, target_limit in targets:
                iter_kwargs: dict[str, Any] = {
                    "limit": target_limit,
                    "filter": InputMessagesFilterUrl,
                    "wait_time": _GLOBAL_PAUSE,
                }
                if target_entity is None:
                    iter_kwargs["search"] = cleaned_query or "mega"
                elif cleaned_query:
                    iter_kwargs["search"] = cleaned_query

                async for message in connection.iter_messages(target_entity, **iter_kwargs):
                    scanned += 1
                    links = extract_message_links(message)
                    if not links:
                        continue
                    msg_entity = target_entity or await _entity_for(connection, message)
                    if msg_entity is None:
                        continue
                    raw_id = int(getattr(msg_entity, "id", 0) or 0)
                    cid = public_chat_id(raw_id)
                    msg_id = int(getattr(message, "id", 0) or 0)
                    if not msg_id:
                        continue
                    username = getattr(msg_entity, "username", None) or fallback_label or str(cid)
                    channel_title = getattr(msg_entity, "title", None) or username
                    caption = (getattr(message, "message", None) or getattr(message, "raw_text", None) or "").strip()
                    title = extract_pack_title(caption, fallback=f"{channel_title} #{msg_id}")
                    has_photo = has_message_preview(message)
                    has_video = bool(links.get("has_video_preview"))
                    vid_dur = str(links.get("video_duration") or "")
                    if has_photo:
                        thumb = f"/api/v1/telegram/post-thumb/{cid}/{msg_id}"
                        if has_video:
                            thumb = f"{thumb}?video=1" + (f"&dur={vid_dur}" if vid_dur else "")
                    else:
                        thumb = ""
                    post_url = (
                        f"https://t.me/{username}/{msg_id}"
                        if getattr(msg_entity, "username", None)
                        else f"https://t.me/c/{cid}/{msg_id}"
                    )
                    date = getattr(message, "date", None)
                    date_str = date.isoformat() if date else ""

                    collected.append({
                        "chat_id": cid,
                        "message_id": msg_id,
                        "channel": str(username),
                        "channel_title": str(channel_title),
                        "title": title,
                        "caption": caption,
                        "post_url": post_url,
                        "raw_url": links["primary_url"],
                        "final_url": links["primary_url"],
                        "domain": links["domain"],
                        "link_kind": links["link_kind"],
                        "resolved_mega_url": links["resolved_mega_url"],
                        "has_photo": has_photo,
                        "thumbnail": thumb,
                        "date": date_str,
                        "views": int(getattr(message, "views", 0) or 0),
                        "reactions": _message_reactions_count(message),
                        "extracted_links": links.get("extracted_links") or [],
                        "mega_urls": links.get("mega_urls") or [],
                        "media_urls": links.get("media_urls") or [],
                        "container_urls": links.get("container_urls") or [],
                    })
                    if len(collected) >= scan_limit:
                        break
                if len(collected) >= scan_limit:
                    break
    except FloodWaitError as exc:
        flood_wait = int(getattr(exc, "seconds", 0) or 0)
        logger.warning("Telegram link scan narazil na FloodWait %ss", flood_wait)
    except asyncio.CancelledError:
        raise

    upsert_res = upsert_telegram_link_posts(db, collected) if collected else {"added": 0, "updated": 0, "rows": []}
    video_map = _lookup_media_video_map(db, [(r.chat_id, r.message_id) for r in upsert_res["rows"]])
    return {
        "items": [
            serialize_link_post(
                row,
                video_meta=(
                    {"has_video_preview": True, "video_duration": video_map[(public_chat_id(int(row.chat_id)), int(row.message_id))]}
                    if (public_chat_id(int(row.chat_id)), int(row.message_id)) in video_map
                    else None
                ),
            )
            for row in upsert_res["rows"]
        ],
        "scanned": scanned,
        "saved": len(upsert_res["rows"]),
        "added": int(upsert_res["added"]),
        "updated": int(upsert_res["updated"]),
        "flood_wait": flood_wait,
    }



_SPAM_CHANNEL_HINT_RE = (
    "mostbet",
    "spinbetter",
    "spinbet",
    "casino",
    "goatspins",
    "betting",
)


def get_telegram_link_channels_stats(db: Session) -> dict[str, Any]:
    """Vypočíta kvalitatívny rebríček Telegram kanálov (priame MEGA, rentry/paste bez brány, skryté entity, mŕtve)."""
    bind = db.get_bind()
    if bind is None or not inspect(bind).has_table(TelegramLinkPost.__tablename__):
        return {"channels": [], "total_channels": 0, "total_posts": 0, "total_missing_entities": 0}

    from .mega_link_extractor import _PASTE_CONTAINER_HOSTS

    rows = (
        db.query(
            TelegramLinkPost.chat_id,
            TelegramLinkPost.channel,
            TelegramLinkPost.channel_title,
            TelegramLinkPost.status,
            TelegramLinkPost.link_kind,
            TelegramLinkPost.domain,
            TelegramLinkPost.caption,
            TelegramLinkPost.mega_video_count,
            TelegramLinkPost.extracted_links_json,
            TelegramLinkPost.discovered_links_json,
        )
        .all()
    )

    stats_by_chat: dict[int, dict[str, Any]] = {}
    for (
        cid_raw,
        ch,
        ch_title,
        st,
        kind,
        dom,
        cap,
        vcount,
        ext_json,
        disc_json,
    ) in rows:
        cid = public_chat_id(int(cid_raw))
        rec = stats_by_chat.get(cid)
        if rec is None:
            rec = {
                "chat_id": cid,
                "channel": ch or "",
                "channel_title": ch_title or ch or str(cid),
                "total": 0,
                "active": 0,
                "direct_mega": 0,
                "paste_free": 0,
                "multi_link": 0,
                "in_hub": 0,
                "dead": 0,
                "external_gate": 0,
                "missing_entities": 0,
                "hidden_hint_count": 0,
                "total_videos": 0,
                "top_domains": defaultdict(int),
            }
            stats_by_chat[cid] = rec
        if ch_title and (not rec["channel_title"] or rec["channel_title"].lstrip("-").isdigit()):
            rec["channel_title"] = ch_title
        if ch and not rec["channel"]:
            rec["channel"] = ch

        rec["total"] += 1
        dom_low = str(dom or "").lower()
        if dom_low:
            rec["top_domains"][dom_low] += 1

        is_dead = st in {"dead", "skipped"}
        if is_dead:
            rec["dead"] += 1
        else:
            rec["active"] += 1
        if st == "in_hub":
            rec["in_hub"] += 1
        if vcount and int(vcount) > 0:
            rec["total_videos"] += int(vcount)

        is_mega = kind in {"direct_mega", "resolved_mega"}
        ext_s = ext_json or ""
        disc_s = disc_json or ""
        is_paste = bool(
            dom_low in _PASTE_CONTAINER_HOSTS
            or '"category": "paste"' in ext_s
            or '"category": "media_host"' in ext_s
            or '"containers": [{' in disc_s
            or '"media": [{' in disc_s
        )
        is_multi = bool(
            "}, {" in ext_s
            or '"mega": [{' in disc_s and "}, {" in disc_s
            or '"media": [{' in disc_s
        )

        if is_mega:
            rec["direct_mega"] += 1
        elif is_paste:
            rec["paste_free"] += 1
        elif not is_dead:
            rec["external_gate"] += 1

        if is_multi and not is_dead:
            rec["multi_link"] += 1

        if ext_json is None and not is_dead and kind == "external":
            rec["missing_entities"] += 1
            cap_low = (cap or "").lower()
            if "mega link" in cap_low or "alt link" in cap_low or "backup" in cap_low:
                rec["hidden_hint_count"] += 1

    out: list[dict[str, Any]] = []
    total_missing = 0
    for rec in stats_by_chat.values():
        active = max(1, rec["active"])
        free_count = rec["direct_mega"] + rec["paste_free"]
        free_rate = round((free_count / active) * 100.0, 1) if rec["active"] > 0 else 0.0
        dead_rate = (rec["dead"] / max(1, rec["total"])) * 100.0
        hidden_ratio = rec["hidden_hint_count"] / active if rec["active"] > 0 else 0.0

        score = 0.0
        score += free_rate * 0.58
        score += min(22.0, rec["direct_mega"] * 0.65 + rec["paste_free"] * 0.35 + rec["in_hub"] * 1.8)
        score += min(12.0, math.log10(max(1, rec["active"])) * 4.5)
        score += min(18.0, hidden_ratio * 22.0)  # Vysoký potenciál skrytých MEGA LINK entít (napr. Segavideo)
        score -= min(20.0, dead_rate * 0.25)

        label_low = f"{rec['channel']} {rec['channel_title']}".lower()
        top_doms = [d for d, _ in sorted(rec["top_domains"].items(), key=lambda x: x[1], reverse=True)[:3]]
        if any(tok in label_low for tok in _SPAM_CHANNEL_HINT_RE) or any(
            any(tok in d for tok in _SPAM_CHANNEL_HINT_RE) for d in top_doms
        ):
            score = min(score, 8.0)

        quality_score = max(0, min(100, int(round(score))))
        if quality_score >= 60 or rec["direct_mega"] >= 15 or rec["paste_free"] >= 20:
            tier = "S"
        elif quality_score >= 36 or rec["hidden_hint_count"] >= 20 or rec["direct_mega"] >= 5:
            tier = "A"
        elif quality_score >= 18:
            tier = "B"
        else:
            tier = "C"

        total_missing += rec["missing_entities"]
        out.append({
            "chat_id": rec["chat_id"],
            "channel": rec["channel"],
            "channel_title": rec["channel_title"],
            "total": rec["total"],
            "active": rec["active"],
            "direct_mega": rec["direct_mega"],
            "paste_free": rec["paste_free"],
            "multi_link": rec["multi_link"],
            "in_hub": rec["in_hub"],
            "dead": rec["dead"],
            "external_gate": rec["external_gate"],
            "missing_entities": rec["missing_entities"],
            "hidden_hint_count": rec["hidden_hint_count"],
            "total_videos": rec["total_videos"],
            "free_rate": free_rate,
            "quality_score": quality_score,
            "tier": tier,
            "top_domains": top_doms,
        })

    out.sort(
        key=lambda x: (
            x["quality_score"],
            x["direct_mega"] + x["paste_free"],
            x["hidden_hint_count"],
            x["active"],
        ),
        reverse=True,
    )
    return {
        "channels": out,
        "total_channels": len(out),
        "total_posts": len(rows),
        "total_missing_entities": total_missing,
    }


async def backfill_telegram_link_entities(
    db: Session,
    *,
    chat_ids: list[int] | None = None,
    query: str = "",
    limit: int = 300,
    only_missing: bool = True,
    resolve_pastes: bool = True,
    max_paste_crawls: int = 40,
) -> dict[str, Any]:
    """Hromadne doplní skryté Telegram entity (MessageEntityTextUrl + inline tlačidlá) pre staršie karty.

    Používa dávkové get_messages(ids=100) — veľmi rýchle a šetrné k Telegram limitom.
    Voliteľne rovno precrawluje novo objavené rentry.org / paste odkazy a povýši karty na priame/multi-MEGA.
    """
    from telethon.errors import FloodWaitError

    from .mega_link_extractor import resolve_clean_redirect
    from .telegram_service import _search_semaphore, client

    bind = db.get_bind()
    if bind is not None:
        ensure_telegram_links_tables(bind)

    capped_limit = max(10, min(int(limit or 300), 2000))
    q = db.query(TelegramLinkPost).filter(
        ~TelegramLinkPost.status.in_(("dead", "skipped")),
    )
    if only_missing:
        q = q.filter(TelegramLinkPost.extracted_links_json.is_(None))
    if chat_ids:
        norm_ids = list({public_chat_id(int(cid)) for cid in chat_ids} | {int(cid) for cid in chat_ids})
        q = q.filter(TelegramLinkPost.chat_id.in_(norm_ids))
    raw_q = (query or "").strip()
    if raw_q:
        pat = f"%{raw_q.lower()}%"
        q = q.filter(
            or_(
                func.lower(func.coalesce(TelegramLinkPost.title, "")).like(pat),
                func.lower(func.coalesce(TelegramLinkPost.caption, "")).like(pat),
                func.lower(func.coalesce(TelegramLinkPost.channel, "")).like(pat),
                func.lower(func.coalesce(TelegramLinkPost.channel_title, "")).like(pat),
            )
        )

    # Prioritizujeme príspevky, ktoré v popise explicitne naznačujú skrytý MEGA LINK / ALT Link
    low_cap = func.lower(func.coalesce(TelegramLinkPost.caption, ""))
    hint_priority = (
        low_cap.like("%mega link%").cast(text("INTEGER").type if False else None)  # fallback nižšie v Pythone
    ) if False else None
    del hint_priority

    candidates = (
        q.order_by(TelegramLinkPost.date.desc(), TelegramLinkPost.id.desc())
        .limit(min(capped_limit * 3, 4000))
        .all()
    )
    candidates.sort(
        key=lambda r: (
            1 if ("mega link" in (r.caption or "").lower() or "alt link" in (r.caption or "").lower()) else 0,
            1 if r.link_kind == "external" else 0,
            r.date or "",
            r.id,
        ),
        reverse=True,
    )
    selected = candidates[:capped_limit]
    if not selected:
        return {
            "scanned": 0,
            "updated": 0,
            "upgraded_to_mega": 0,
            "upgraded_to_paste": 0,
            "upgraded_to_media": 0,
            "pastes_crawled": 0,
            "mega_discovered": 0,
            "media_discovered": 0,
            "remaining_missing": 0,
            "flood_wait": 0,
        }

    by_chat: dict[int, list[TelegramLinkPost]] = defaultdict(list)
    for row in selected:
        by_chat[public_chat_id(int(row.chat_id))].append(row)

    connection = await client()
    scanned = 0
    updated = 0
    upgraded_to_mega = 0
    upgraded_to_paste = 0
    upgraded_to_media = 0
    flood_wait = 0
    paste_posts_to_crawl: list[TelegramLinkPost] = []
    now = utcnow()

    try:
        async with _search_semaphore():
            for cid, post_list in by_chat.items():
                try:
                    entity = await connection.get_entity(peer_id(cid))
                except Exception as exc:  # noqa: BLE001
                    logger.debug("backfill get_entity %s zlyhalo: %s", cid, exc)
                    continue

                # Prednačítame existujúce (message_id, raw_url) v tomto chate kvôli UniqueConstraint
                msg_ids = list({int(p.message_id) for p in post_list})
                existing_pairs = {
                    (int(mid), ru)
                    for mid, ru in db.query(TelegramLinkPost.message_id, TelegramLinkPost.raw_url)
                    .filter(TelegramLinkPost.chat_id == cid, TelegramLinkPost.message_id.in_(msg_ids))
                    .all()
                }
                posts_by_mid: dict[int, list[TelegramLinkPost]] = defaultdict(list)
                for p in post_list:
                    posts_by_mid[int(p.message_id)].append(p)

                for i in range(0, len(msg_ids), 100):
                    chunk_ids = msg_ids[i:i + 100]
                    try:
                        messages = await connection.get_messages(entity, ids=chunk_ids)
                    except FloodWaitError as exc:
                        flood_wait = int(getattr(exc, "seconds", 0) or 0)
                        raise
                    if not isinstance(messages, list):
                        messages = [messages]

                    for mid, msg in zip(chunk_ids, messages):
                        scanned += 1
                        targets = posts_by_mid.get(mid) or []
                        if msg is None:
                            for post in targets:
                                if post.extracted_links_json is None:
                                    save_post_extracted_links(post, parse_extracted_links(post))
                                    post.updated_at = now
                            continue

                        links = extract_message_links(msg)
                        if not links:
                            for post in targets:
                                if post.extracted_links_json is None:
                                    save_post_extracted_links(post, parse_extracted_links(post))
                                    post.updated_at = now
                            continue

                        for post in targets:
                            merged_ext = merge_extracted_links(parse_extracted_links(post), links.get("extracted_links") or [])
                            save_post_extracted_links(post, merged_ext)

                            cur_bag = parse_discovered_links(post)
                            merged_bag = merge_discovered_links(
                                cur_bag,
                                mega_urls=links.get("mega_urls") or (),
                                media_urls=links.get("media_urls") or (),
                                container_urls=links.get("container_urls") or (),
                            )
                            if merged_bag["mega"] or merged_bag["media"] or merged_bag["containers"]:
                                save_post_discovered_links(post, merged_bag)

                            new_primary = str(links.get("primary_url") or "").strip()
                            if links.get("resolved_mega_url") and not post.resolved_mega_url:
                                mega_u = links["resolved_mega_url"]
                                post.resolved_mega_url = mega_u
                                post.final_url = mega_u
                                post.domain = "mega.nz"
                                if post.link_kind == "external":
                                    post.link_kind = "direct_mega"
                                upgraded_to_mega += 1
                            elif new_primary and not post.resolved_mega_url:
                                is_new_paste = is_paste_container_url(new_primary)
                                is_new_media = classify_media_url(new_primary) is not None
                                if is_new_paste or is_new_media:
                                    if new_primary != post.raw_url and (mid, new_primary) not in existing_pairs:
                                        existing_pairs.discard((mid, post.raw_url))
                                        post.raw_url = new_primary
                                        existing_pairs.add((mid, new_primary))
                                    post.final_url = new_primary
                                    post.domain = _domain_of(new_primary)
                                    if is_new_paste:
                                        upgraded_to_paste += 1
                                        paste_posts_to_crawl.append(post)
                                    elif is_new_media:
                                        upgraded_to_media += 1
                            elif merged_bag["containers"] and not post.resolved_mega_url:
                                paste_posts_to_crawl.append(post)

                            post.updated_at = now
                            updated += 1
                    db.commit()
                    await asyncio.sleep(0.15)
    except FloodWaitError as exc:
        flood_wait = int(getattr(exc, "seconds", 0) or 0)
        logger.warning("backfill_telegram_link_entities narazil na FloodWait %ss", flood_wait)
        db.commit()

    # Voliteľný okamžitý crawl novo objavených paste stránok (napr. rentry.org/raw)
    pastes_crawled = 0
    mega_discovered = 0
    media_discovered = 0
    if resolve_pastes and paste_posts_to_crawl:
        dedup_crawl: list[TelegramLinkPost] = []
        seen_ids: set[int] = set()
        for p in paste_posts_to_crawl:
            if p.id not in seen_ids:
                seen_ids.add(p.id)
                dedup_crawl.append(p)

        sem = asyncio.Semaphore(4)

        async def _crawl_one(post_obj: TelegramLinkPost):
            target_u = post_obj.final_url or post_obj.raw_url
            cached = get_cached_resolution(db, target_u)
            if cached and (cached["mega_urls"] or cached["media_urls"]):
                return post_obj, target_u, cached, True
            async with sem:
                try:
                    res = await resolve_clean_redirect(target_u, timeout=7.0)
                    return post_obj, target_u, res, False
                except Exception:  # noqa: BLE001
                    return post_obj, target_u, None, False

        crawl_results = await asyncio.gather(*(_crawl_one(p) for p in dedup_crawl[:max_paste_crawls]))
        for post_obj, target_u, res, from_cache in crawl_results:
            if not res:
                continue
            megas = list(res.get("mega_urls") or [])
            if res.get("resolved_mega_url") and res["resolved_mega_url"] not in megas:
                megas.insert(0, res["resolved_mega_url"])
            medias = list(res.get("media_urls") or [])
            conts = list(res.get("container_urls") or [])
            if not megas and not medias:
                continue
            pastes_crawled += 1
            mega_discovered += len(megas)
            media_discovered += len(medias)
            bag = merge_discovered_links(
                parse_discovered_links(post_obj),
                mega_urls=megas,
                media_urls=medias,
                container_urls=conts,
            )
            save_post_discovered_links(post_obj, bag)
            if megas and not post_obj.resolved_mega_url:
                post_obj.resolved_mega_url = megas[0]
                post_obj.final_url = megas[0]
                post_obj.domain = "mega.nz"
                if post_obj.link_kind == "external":
                    post_obj.link_kind = "resolved_mega"
                upgraded_to_mega += 1
            post_obj.updated_at = utcnow()
            if not from_cache:
                save_cached_resolution(
                    db,
                    target_u,
                    final_url=megas[0] if megas else target_u,
                    mega_urls=megas,
                    media_urls=medias,
                    container_urls=conts,
                    provider=str(res.get("resolved_via") or "paste_crawl"),
                )
        db.commit()

    remaining_missing = int(
        db.query(TelegramLinkPost.id)
        .filter(
            ~TelegramLinkPost.status.in_(("dead", "skipped")),
            TelegramLinkPost.extracted_links_json.is_(None),
            TelegramLinkPost.link_kind == "external",
        )
        .count()
        or 0
    )

    return {
        "scanned": scanned,
        "updated": updated,
        "upgraded_to_mega": upgraded_to_mega,
        "upgraded_to_paste": upgraded_to_paste,
        "upgraded_to_media": upgraded_to_media,
        "pastes_crawled": pastes_crawled,
        "mega_discovered": mega_discovered,
        "media_discovered": media_discovered,
        "remaining_missing": remaining_missing,
        "flood_wait": flood_wait,
    }
