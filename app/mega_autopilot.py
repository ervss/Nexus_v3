"""MEGA Autopilot – automatické spracovanie Telegram link kariet na pozadí.

Pipeline (každý tick plánovača):
  1. SEED   – (raz za hodinu) lokálne vytiahne MEGA linky z už zaindexovaných Telegram videí.
  2. SCAN   – (voliteľne) živý sken vybraných kanálov, ak je zapnutý `auto_scan`.
  3. RESOLVE – externé skracovače/brány, ktoré sa dajú rozbaliť čistým HTTP redirectom.
  4. VERIFY + ADD – každý MEGA link sa overí cez MEGA API:
        * reálny album (>= min_videos videí)  -> pridá sa do MEGA Hubu, karta = in_hub
        * zmazaný/neplatný                    -> karta = dead
        * príliš malý (fake/teaser pack)      -> karta = skipped
        * dočasná chyba                       -> exponenciálny backoff, skúsi sa znova
Linky za captcha/bránou (nedá sa rozbaliť redirectom) ostanú ručne cez handoff.
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from pathlib import Path
from typing import Any

from sqlalchemy import or_

from .database import SessionLocal, TelegramLinkPost, utcnow

logger = logging.getLogger(__name__)

_STATE_PATH = Path(__file__).resolve().parent.parent / "data" / "mega_autopilot.json"
_LOCK = asyncio.Lock()

BATCH_VERIFY = 10          # koľko MEGA linkov overiť v jednom ticku
BATCH_RESOLVE = 8          # koľko externých linkov rozbaliť v jednom ticku
SEED_EVERY_SEC = 3600
SCAN_EVERY_SEC = 1800
MAX_ATTEMPTS = 5

_DEFAULT_STATE: dict[str, Any] = {
    "enabled": False,
    "min_videos": 2,
    "auto_add": False,
    "auto_scan": False,
    "scan_chat_ids": [],
    "last_run": None,
    "last_seed": 0,
    "last_scan": 0,
    "last_stats": {},
    "totals": {"verified": 0, "added": 0, "dead": 0, "skipped": 0, "resolved": 0, "scanned_new": 0},
    "running": False,
}

_state: dict[str, Any] | None = None
# post_id -> (pokusy, najskôr_znova_monotonic)
_attempts: dict[int, tuple[int, float]] = {}


def _load_state() -> dict[str, Any]:
    global _state
    if _state is not None:
        return _state
    data: dict[str, Any] = {}
    try:
        data = json.loads(_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    merged = {**_DEFAULT_STATE, **{k: v for k, v in data.items() if k in _DEFAULT_STATE}}
    merged["totals"] = {**_DEFAULT_STATE["totals"], **(merged.get("totals") or {})}
    merged["running"] = False
    _state = merged
    return _state


def _save_state() -> None:
    try:
        _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _STATE_PATH.write_text(json.dumps(_load_state(), ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        logger.warning("MEGA autopilot: stav sa nepodarilo uložiť: %s", exc)


def get_status(db=None) -> dict[str, Any]:
    st = _load_state()
    out = {k: st[k] for k in _DEFAULT_STATE}
    out["pending"] = _pending_counts(db) if db is not None else None
    return out


def configure(*, enabled: bool | None = None, min_videos: int | None = None,
              auto_scan: bool | None = None, scan_chat_ids: list[int] | None = None,
              auto_add: bool | None = None) -> dict[str, Any]:
    st = _load_state()
    if enabled is not None:
        st["enabled"] = bool(enabled)
    if min_videos is not None:
        st["min_videos"] = max(1, min(int(min_videos), 500))
    if auto_add is not None:
        st["auto_add"] = bool(auto_add)
    if auto_scan is not None:
        st["auto_scan"] = bool(auto_scan)
    if scan_chat_ids is not None:
        st["scan_chat_ids"] = [int(x) for x in scan_chat_ids][:20]
    _save_state()
    return get_status()


def _is_mega_candidate():
    return or_(TelegramLinkPost.resolved_mega_url.isnot(None), TelegramLinkPost.link_kind == "direct_mega")


def _pending_counts(db) -> dict[str, int]:
    open_status = TelegramLinkPost.status.in_(("new", "opened"))
    mega = db.query(TelegramLinkPost.id).filter(open_status, _is_mega_candidate(), TelegramLinkPost.mega_video_count.is_(None)).count()
    ext = (
        db.query(TelegramLinkPost.id)
        .filter(open_status, TelegramLinkPost.link_kind == "external", TelegramLinkPost.resolved_mega_url.is_(None))
        .count()
    )
    return {"mega_to_verify": mega, "external_unresolved": ext}


def _due(post_id: int) -> bool:
    entry = _attempts.get(post_id)
    if not entry:
        return True
    tries, next_at = entry
    return tries < MAX_ATTEMPTS and time.monotonic() >= next_at


def _fail(post_id: int) -> None:
    tries = _attempts.get(post_id, (0, 0.0))[0] + 1
    _attempts[post_id] = (tries, time.monotonic() + min(3600, 60 * (2 ** tries)))


def _set_status(db, post: TelegramLinkPost, status: str) -> None:
    post.status = status
    post.updated_at = utcnow()
    db.commit()


async def resolve_post_candidates(
    db,
    post: TelegramLinkPost,
    *,
    target_url: str | None = None,
) -> dict[str, Any]:
    """Rozbalí kartu cez cache, lokálne Base64 wrappery a HTTP/paste crawler naprieč všetkými uloženými linkami."""
    from .mega_link_extractor import _domain_of, decode_local_wrapper_url, resolve_clean_redirect
    from .telegram_links import (
        get_cached_resolution,
        merge_discovered_links,
        parse_discovered_links,
        parse_extracted_links,
        save_cached_resolution,
        save_post_discovered_links,
    )

    candidates: list[str] = []
    seen_cands: set[str] = set()

    def _push_cand(u: str | None) -> None:
        val = (u or "").strip()
        if not val:
            return
        norm = val.rstrip("/")
        if norm not in seen_cands:
            seen_cands.add(norm)
            candidates.append(val)

    if target_url:
        _push_cand(target_url)
    else:
        # Najprv preferujeme paste kontajnery a lokálne dekódovateľné linky zo všetkých uložených entít
        extracted = parse_extracted_links(post)
        priority_order = {"mega": 0, "paste": 1, "media_host": 2, "shortener": 3, "external": 4}
        extracted_sorted = sorted(extracted, key=lambda x: priority_order.get(str(x.get("category") or "external"), 4))
        for item in extracted_sorted:
            if item.get("decoded_url"):
                _push_cand(item["decoded_url"])
            _push_cand(item.get("url"))
        bag_cur = parse_discovered_links(post)
        for cont in bag_cur.get("containers") or []:
            if not cont.get("crawled"):
                _push_cand(cont.get("url"))
        _push_cand(post.raw_url)
        if post.final_url and post.final_url != post.raw_url:
            _push_cand(post.final_url)

    bag = parse_discovered_links(post)
    total_hops = 0
    best_final_url = post.final_url or post.raw_url
    best_domain = post.domain or _domain_of(best_final_url)
    resolved_via = "external_gate"
    found_any_mega = False
    found_any_media = False
    last_error: Exception | None = None

    for cand in candidates[:6]:
        # 1) Cache lookup (šetrí opakované HTTP/bypass volania pri repostoch rovnakého linku)
        cached = get_cached_resolution(db, cand)
        if cached and (cached["mega_urls"] or cached["media_urls"] or cached["container_urls"]):
            bag = merge_discovered_links(
                bag,
                mega_urls=cached["mega_urls"],
                media_urls=cached["media_urls"],
                container_urls=cached["container_urls"],
            )
            best_final_url = cached["final_url"] or best_final_url
            best_domain = _domain_of(best_final_url) or best_domain
            resolved_via = f"cache:{cached['provider']}"
            if cached["mega_urls"]:
                found_any_mega = True
            if cached["media_urls"]:
                found_any_media = True
            if found_any_mega:
                break
            continue

        # 2) Lokálne + čisté HTTP + paste crawl rozbalenie
        try:
            res = await resolve_clean_redirect(cand)
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            logger.debug("resolve_post_candidates %s (%s): %s", post.id, cand, exc)
            continue

        total_hops += int(res.get("hops") or 0)
        res_megas = list(res.get("mega_urls") or [])
        if res.get("resolved_mega_url") and res["resolved_mega_url"] not in res_megas:
            res_megas.insert(0, res["resolved_mega_url"])
        res_medias = list(res.get("media_urls") or [])
        res_conts = list(res.get("container_urls") or [])
        res_final = res.get("final_url") or cand

        if res_megas or res_medias or res_conts:
            bag = merge_discovered_links(
                bag,
                mega_urls=res_megas,
                media_urls=res_medias,
                container_urls=res_conts,
            )
            save_cached_resolution(
                db,
                cand,
                final_url=res_final,
                mega_urls=res_megas,
                media_urls=res_medias,
                container_urls=res_conts,
                provider=str(res.get("resolved_via") or "clean_http"),
            )
            # Uložíme aj pre lokálne dekódovaný variant (napr. rentry.org), ak bol odlišný
            dec = decode_local_wrapper_url(cand)
            if dec and dec != cand:
                save_cached_resolution(
                    db,
                    dec,
                    final_url=res_final,
                    mega_urls=res_megas,
                    media_urls=res_medias,
                    container_urls=res_conts,
                    provider=str(res.get("resolved_via") or "paste_crawl"),
                )
            best_final_url = res_final
            best_domain = res.get("domain") or _domain_of(res_final) or best_domain
            resolved_via = str(res.get("resolved_via") or "clean_http")
            if res_megas:
                found_any_mega = True
                break
            if res_medias:
                found_any_media = True
        elif res_final and res_final != cand:
            best_final_url = res_final
            best_domain = res.get("domain") or _domain_of(res_final) or best_domain

    if bag["mega"] or bag["media"] or bag["containers"]:
        save_post_discovered_links(post, bag)
    if bag["mega"]:
        primary_mega = bag["mega"][0]["url"]
        if not post.resolved_mega_url:
            post.resolved_mega_url = primary_mega
        post.final_url = post.resolved_mega_url
        post.domain = "mega.nz"
        if post.link_kind == "external":
            post.link_kind = "resolved_mega"
    elif best_final_url and (not target_url or target_url == post.raw_url):
        post.final_url = best_final_url
        if best_domain:
            post.domain = best_domain
    post.updated_at = utcnow()
    db.commit()

    return {
        "bag": bag,
        "hops": total_hops,
        "final_url": post.final_url or best_final_url,
        "domain": post.domain or best_domain,
        "resolved_via": resolved_via,
        "found_mega": bool(bag["mega"]),
        "found_media": bool(bag["media"]),
        "last_error": last_error if not (found_any_mega or found_any_media) else None,
    }


async def verify_discovered_megas(
    db,
    post: TelegramLinkPost,
    *,
    max_verify: int = 24,
) -> dict[str, Any]:
    """Paralelne overí objavené MEGA priečinky v karte (napr. 13 linkov z rentry.org) a aktualizuje ich stavy."""
    from .database import MegaHubEntry
    from .routers import mega_hub
    from .telegram_links import parse_discovered_links, save_post_discovered_links, summarize_discovered_links

    bag = parse_discovered_links(post)
    megas = bag["mega"]
    if not megas:
        return {"bag": bag, "summary": summarize_discovered_links(bag), "total_videos": 0}

    # Najprv spárujeme s už existujúcimi položkami v MEGA Hube (0 requestov na MEGA)
    hub_by_url: dict[str, tuple[int, int, str]] = {}
    for eid, u, title, snap in db.query(MegaHubEntry.id, MegaHubEntry.url, MegaHubEntry.title, MegaHubEntry.snapshot).all():
        vcount = len((snap or {}).get("videos", [])) if isinstance(snap, dict) else 0
        hub_by_url[u] = (int(eid), vcount, str(title or ""))

    to_check: list[dict[str, Any]] = []
    for entry in megas:
        hit = hub_by_url.get(entry["url"])
        if hit is not None:
            entry["status"] = "in_hub"
            entry["hub_entry_id"] = hit[0]
            entry["video_count"] = hit[1]
            if not entry.get("title") and hit[2]:
                entry["title"] = hit[2]
            continue
        if entry.get("status") in {"unchecked", "retry", ""}:
            to_check.append(entry)

    sem = asyncio.Semaphore(4)

    async def _check_one(entry: dict[str, Any]) -> None:
        async with sem:
            try:
                share = mega_hub.parse_share(entry["url"])
                snap = await mega_hub._inspect(share)
            except Exception:  # noqa: BLE001
                entry["status"] = "invalid"
                entry["video_count"] = 0
                return
            st = str(snap.get("status") or "retry")
            vids = snap.get("videos") or []
            entry["status"] = st
            entry["video_count"] = len(vids) if st in {"available", "empty"} else (0 if st == "unavailable" else entry.get("video_count"))
            if snap.get("title"):
                entry["title"] = str(snap["title"])[:180]

    if to_check:
        await asyncio.gather(*(_check_one(e) for e in to_check[:max_verify]))

    # Nastavíme primárny MEGA link na prvý živý (nie mŕtvy!)
    alive_entries = [m for m in megas if m.get("status") in {"available", "in_hub"} and (m.get("video_count") or 0) > 0]
    total_videos = sum(int(m.get("video_count") or 0) for m in alive_entries)
    if alive_entries:
        post.resolved_mega_url = alive_entries[0]["url"]
        post.final_url = alive_entries[0]["url"]
        post.domain = "mega.nz"
        if post.link_kind == "external":
            post.link_kind = "resolved_mega"
        post.mega_video_count = total_videos

    save_post_discovered_links(post, bag)
    post.updated_at = utcnow()
    db.commit()

    return {
        "bag": bag,
        "summary": summarize_discovered_links(bag),
        "total_videos": total_videos,
        "alive_entries": alive_entries,
    }


async def _resolve_phase(db, stats: dict[str, int]) -> None:
    from .extractors import mega_native as mn
    from .mega_link_extractor import extract_keyless_mega_urls

    rows = (
        db.query(TelegramLinkPost)
        .filter(
            TelegramLinkPost.status.in_(("new", "opened")),
            TelegramLinkPost.link_kind == "external",
            TelegramLinkPost.resolved_mega_url.is_(None),
        )
        .order_by(TelegramLinkPost.reactions.desc(), TelegramLinkPost.id.desc())
        .limit(BATCH_RESOLVE * 6)
        .all()
    )
    rows = [r for r in rows if _due(r.id)][:BATCH_RESOLVE]
    sem = asyncio.Semaphore(3)

    async def one(post: TelegramLinkPost):
        async with sem:
            keyless = extract_keyless_mega_urls(post.caption or "", extra_urls=(post.raw_url or "",))
            if keyless:
                kl = keyless[0]
                probe = await mn.inspect_keyless(kl["kind"], kl["handle"])
                if probe.get("status") in {"unavailable", "empty"}:
                    return post, {"_keyless_probe": probe}
            try:
                return post, await resolve_post_candidates(db, post)
            except Exception as exc:  # noqa: BLE001 – sieť/SSRF/neplatná URL
                logger.debug("autopilot resolve %s: %s", post.id, exc)
                return post, None

    for post, res in await asyncio.gather(*(one(p) for p in rows)):
        probe = (res or {}).get("_keyless_probe") if isinstance(res, dict) else None
        if probe:
            if probe.get("status") == "unavailable":
                _set_status(db, post, "dead")
                stats["dead"] += 1
            else:
                post.mega_video_count = 0
                _set_status(db, post, "skipped")
                stats["skipped"] += 1
            _attempts.pop(post.id, None)
            continue
        if res and (res.get("found_mega") or res.get("found_media")):
            stats["resolved"] += 1
            _attempts.pop(post.id, None)
        else:
            _fail(post.id)


async def process_post(db, post: TelegramLinkPost, *, add: bool, min_videos: int = 1) -> dict[str, Any]:
    """Spracuje jednu kartu: rozbalí všetky kandidáty -> overí v MEGA -> (voliteľne) pridá do Hubu.

    outcome: added | exists | verified | multi_mega | media_only | small | empty | dead | needs_key | gate | retry | invalid
    Používa ho autopilot aj tlačidlá na kartách (jedna karta / výber).
    """
    from .extractors import mega_native as mn
    from .mega_link_extractor import extract_keyless_mega_urls
    from .routers import mega_hub
    from .telegram_links import parse_discovered_links, serialize_link_post

    def out(outcome: str, **extra) -> dict[str, Any]:
        db.refresh(post)
        return {"outcome": outcome, "item": serialize_link_post(post), **extra}

    if post.status == "in_hub" and len(parse_discovered_links(post)["mega"]) <= 1:
        return out("exists", count=post.mega_video_count or 0)

    # 1) Rozbalenie (vyskúša cache, lokálne Base64 wrappery, paste kontajnery aj alt linky)
    bag = parse_discovered_links(post)
    url = (post.resolved_mega_url or "").strip()
    if not url and post.link_kind == "direct_mega":
        url = (post.raw_url or "").strip()
    if not url:
        # 1a) Split MEGA (príspevok má mega.nz/folder/ID bez kľúča + druhý link na odomknutie kľúča)
        keyless_list = extract_keyless_mega_urls(post.caption or "", extra_urls=(post.raw_url or "",))
        if keyless_list:
            kl = keyless_list[0]
            probe = await mn.inspect_keyless(kl["kind"], kl["handle"])
            pst = probe.get("status")
            if pst == "unavailable":
                _set_status(db, post, "dead")
                return out("dead", reason=probe.get("reason") or "MEGA priečinok z príspevku už neexistuje (netreba riešiť kľúč).")
            if pst == "empty":
                post.mega_video_count = 0
                _set_status(db, post, "skipped")
                return out("empty", count=0, reason=probe.get("reason") or "MEGA priečinok je prázdny (0 súborov).")
            if pst == "locked_alive":
                res = await resolve_post_candidates(db, post)
                bag = res["bag"]
                if bag["mega"]:
                    url = bag["mega"][0]["url"]
                else:
                    return out(
                        "needs_key",
                        keyless_mega_url=kl["url"],
                        files=probe.get("files", 0),
                        folders=probe.get("folders", 0),
                        bytes=probe.get("bytes", 0),
                        reason="MEGA album je živý — chýba už len dešifrovací kľúč z brány.",
                    )

    if not url:
        res = await resolve_post_candidates(db, post)
        bag = res["bag"]
        if bag["mega"]:
            url = bag["mega"][0]["url"]
        elif bag["media"]:
            return out(
                "media_only",
                media_count=len(bag["media"]),
                reason=f"Nájdených {len(bag['media'])} priamych media odkazov (Bunkr/Gofile/Pixeldrain…) pripravených pre Link Tester alebo Intake.",
            )
        elif res.get("last_error") is not None and not res.get("final_url"):
            return out("retry", reason=str(res["last_error"]) or "Cieľ neodpovedá.")
        else:
            return out("gate", reason="Odkaz vedie cez bránu/captchu – použi rotátor Bypass alebo otvor ručne.")

    # 2) Multi-MEGA prípad (napr. 13 MEGA priečinkov z rentry.org)
    if len(bag["mega"]) > 1:
        v_res = await verify_discovered_megas(db, post)
        summary = v_res["summary"]
        alive_count = summary["mega_alive"]
        total_videos = int(v_res["total_videos"])
        media_count = summary["media_total"]
        if alive_count > 0:
            return out(
                "multi_mega",
                count=total_videos,
                alive_count=alive_count,
                total_count=summary["mega_total"],
                media_count=media_count,
                ready_to_pick=True,
                reason=f"Nájdených {alive_count}/{summary['mega_total']} živých MEGA priečinkov ({total_videos} videí)" + (f" + {media_count} media linkov" if media_count else ""),
            )
        if media_count > 0:
            return out(
                "media_only",
                media_count=media_count,
                reason=f"MEGA linky sú mŕtve, ale karta má {media_count} ďalších media odkazov.",
            )
        _set_status(db, post, "dead")
        return out("dead", reason=f"Všetkých {summary['mega_total']} MEGA odkazov z balíčka je mŕtvych alebo prázdnych.")

    # 3) Štandardné overenie jedného MEGA linku
    try:
        share = mega_hub.parse_share(url)
    except Exception:  # noqa: BLE001
        return out("invalid", reason="Neplatný MEGA odkaz.")
    snap = await mega_hub._inspect(share)
    status = snap.get("status")
    # Zosynchronizujeme stav aj v discovered_links_json
    from .telegram_links import merge_discovered_links, save_post_discovered_links

    bag = merge_discovered_links(
        bag,
        mega_entries=[{
            "url": url,
            "status": status or "retry",
            "title": str(snap.get("title") or post.title or "")[:180],
            "video_count": len(snap.get("videos", [])) if status in {"available", "empty"} else 0,
        }],
    )
    save_post_discovered_links(post, bag)

    if status == "unavailable":
        if bag["media"]:
            db.commit()
            return out("media_only", media_count=len(bag["media"]), reason="MEGA link je mŕtvy, ale k dispozícii sú ďalšie media odkazy.")
        _set_status(db, post, "dead")
        return out("dead", reason=snap.get("reason") or "Odkaz už na MEGA neexistuje.")
    if status == "empty":
        post.mega_video_count = 0
        if bag["media"]:
            db.commit()
            return out("media_only", media_count=len(bag["media"]), reason="MEGA priečinok je prázdny, ale k dispozícii sú ďalšie media odkazy.")
        _set_status(db, post, "skipped")
        return out("empty", count=0, reason="Priečinok je živý, ale nie sú v ňom žiadne videá (prázdny alebo vymazaný obsah).")
    if status == "open_in_mega":
        db.commit()
        return out("gate", reason="Obsah sa nedá prečítať cez API – otvor odkaz priamo v MEGA.")
    if status != "available":
        db.commit()
        return out("retry", reason=snap.get("reason") or "MEGA zatiaľ neodpovedá alebo obsah nie je čitateľný.",
                   mega_status=status)

    count = len(snap.get("videos", []))
    post.mega_video_count = count
    post.updated_at = utcnow()
    db.commit()
    if not add:
        return out("small" if count < min_videos else "verified", count=count)
    if count < min_videos:
        return out("small", count=count)

    # 4) Pridanie do Hubu
    check_id = secrets.token_urlsafe(18)
    mega_hub._CHECKS[check_id] = (time.monotonic() + mega_hub._CHECK_TTL, share, snap)
    try:
        res = await mega_hub.add_share_to_hub(db, check_id=check_id, title_override=post.title, link_post_id=post.id)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        return out("retry", reason=f"Pridanie do Hubu zlyhalo: {exc}")
    finally:
        mega_hub._CHECKS.pop(check_id, None)
    if res.get("status") in {"added", "exists"}:
        return out(res["status"], count=count)
    return out("retry", reason="Hub odkaz neprijal.")


def _candidates(db, *, need_count: bool | None, limit: int):
    q = db.query(TelegramLinkPost).filter(TelegramLinkPost.status.in_(("new", "opened")), _is_mega_candidate())
    if need_count is True:       # ešte neoverené
        q = q.filter(TelegramLinkPost.mega_video_count.is_(None))
    elif need_count is False:    # už overené
        q = q.filter(TelegramLinkPost.mega_video_count.isnot(None))
    rows = q.order_by(TelegramLinkPost.reactions.desc(), TelegramLinkPost.id.desc()).limit(limit * 6).all()
    return [r for r in rows if _due(r.id)][:limit]


async def _verify_phase(db, stats: dict[str, int], st: dict[str, Any]) -> None:
    min_videos = int(st["min_videos"])
    # a) pripraviť: overiť všetky neoverené
    for post in _candidates(db, need_count=True, limit=BATCH_VERIFY):
        res = await process_post(db, post, add=False, min_videos=min_videos)
        outcome = res["outcome"]
        if outcome == "dead":
            stats["dead"] += 1
        elif outcome == "empty":
            stats["skipped"] += 1
            _attempts.pop(post.id, None)
        elif outcome == "invalid":
            _set_status(db, post, "skipped")
            stats["skipped"] += 1
            _attempts.pop(post.id, None)
        elif outcome in {"retry", "gate"}:
            _fail(post.id)
        else:
            stats["verified"] += 1
            _attempts.pop(post.id, None)
    # b) voliteľne rovno pridať reálne albumy
    if not st.get("auto_add"):
        return
    for post in _candidates(db, need_count=False, limit=BATCH_VERIFY):
        if (post.mega_video_count or 0) < min_videos:
            _set_status(db, post, "skipped")
            stats["skipped"] += 1
            continue
        res = await process_post(db, post, add=True, min_videos=min_videos)
        outcome = res["outcome"]
        if outcome in {"added", "exists"}:
            stats["added"] += 1
            _attempts.pop(post.id, None)
        elif outcome == "dead":
            stats["dead"] += 1
        elif outcome == "empty":
            stats["skipped"] += 1
            _attempts.pop(post.id, None)
        else:
            _fail(post.id)

async def _seed_phase(db, st: dict[str, Any]) -> None:
    if time.time() - float(st.get("last_seed") or 0) < SEED_EVERY_SEC:
        return
    from .telegram_links import seed_links_from_media_index

    await asyncio.to_thread(seed_links_from_media_index, db, limit=3000, chat_ids=None)
    st["last_seed"] = time.time()


async def _scan_phase(db, st: dict[str, Any], stats: dict[str, int]) -> None:
    if not st.get("auto_scan") or not st.get("scan_chat_ids"):
        return
    if time.time() - float(st.get("last_scan") or 0) < SCAN_EVERY_SEC:
        return
    from .telegram_links import scan_telegram_links_live

    st["last_scan"] = time.time()  # aj pri chybe, aby sme nespamovali Telegram
    try:
        res = await scan_telegram_links_live(db, chat_ids=list(st["scan_chat_ids"]), limit=120)
        stats["scanned_new"] += int(res.get("added") or 0)
    except Exception as exc:  # noqa: BLE001 – Telegram nie je prihlásený / FloodWait
        logger.info("autopilot scan preskočený: %s", exc)


async def autopilot_tick(force: bool = False) -> dict[str, Any]:
    """Jeden beh pipeline. Bezpečné volať súbežne – druhé volanie sa preskočí."""
    st = _load_state()
    if not (st["enabled"] or force):
        return {"skipped": "disabled"}
    if _LOCK.locked():
        return {"skipped": "busy"}

    async with _LOCK:
        st["running"] = True
        stats = {"resolved": 0, "verified": 0, "added": 0, "dead": 0, "skipped": 0, "scanned_new": 0}
        db = SessionLocal()
        try:
            await _seed_phase(db, st)
            await _scan_phase(db, st, stats)
            await _resolve_phase(db, stats)
            await _verify_phase(db, stats, st)
            try:
                from .telegram_links import _sync_hub_entries_state
                _sync_hub_entries_state(db)
            except Exception:  # noqa: BLE001
                pass
        except Exception:  # noqa: BLE001
            logger.exception("MEGA autopilot tick zlyhal")
            db.rollback()
        finally:
            for key, value in stats.items():
                st["totals"][key] = int(st["totals"].get(key, 0)) + value
            st["last_run"] = utcnow().isoformat()
            st["last_stats"] = stats
            st["running"] = False
            _save_state()
            db.close()
        if stats["added"]:
            logger.info("MEGA autopilot: +%s albumov do Hubu (%s)", stats["added"], stats)
        return stats
