"""
Faphouse-only API surface — playlists, watch history, model/studio follows,
the "For You" feed, and Mashup Studio jobs.

Generic Fusion Hub browsing (search/feed/categories/resolve/related/media)
is NOT duplicated here — FaphouseHub is a registered hub adapter, so those
already work via the existing /api/v1/hub/faphouse/* routes in
app/routers/hub.py. This router only covers the state that's specific to the
standalone Faphouse page: DB-backed collections the generic hub system has
no concept of.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..cookie_jar import cookiejar_mtime, resolve_cookiefile

from ..database import (
    FaphouseCommunityPlaylist,
    FaphouseFollow,
    FaphouseMashupJob,
    FaphousePlaylist,
    FaphousePlaylistCrawlState,
    FaphousePlaylistItem,
    FaphouseWatchHistory,
    SessionLocal,
    get_db,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/faphouse", tags=["faphouse"])


# --------------------------------------------------------------------------- #
# Playlists
# --------------------------------------------------------------------------- #

class PlaylistPayload(BaseModel):
    name: str
    description: str = ""


class PlaylistItemPayload(BaseModel):
    video_url: str
    title: str = ""
    thumbnail: str = ""
    duration_sec: int = 0


def _serialize_playlist(playlist: FaphousePlaylist, db: Session) -> dict:
    count = db.query(FaphousePlaylistItem).filter(
        FaphousePlaylistItem.playlist_id == playlist.id
    ).count()
    return {
        "id": playlist.id,
        "name": playlist.name,
        "description": playlist.description or "",
        "item_count": count,
        "created_at": playlist.created_at.isoformat() if playlist.created_at else None,
        "updated_at": playlist.updated_at.isoformat() if playlist.updated_at else None,
    }


@router.get("/playlists")
def list_playlists(db: Session = Depends(get_db)):
    rows = db.query(FaphousePlaylist).order_by(FaphousePlaylist.updated_at.desc()).all()
    return {"playlists": [_serialize_playlist(p, db) for p in rows]}


@router.post("/playlists")
def create_playlist(payload: PlaylistPayload, db: Session = Depends(get_db)):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, detail="Playlist name is required.")
    playlist = FaphousePlaylist(name=name, description=payload.description or "")
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    return {"success": True, "playlist": _serialize_playlist(playlist, db)}


@router.put("/playlists/{playlist_id}")
def update_playlist(playlist_id: int, payload: PlaylistPayload, db: Session = Depends(get_db)):
    playlist = db.query(FaphousePlaylist).filter(FaphousePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(404, detail="Playlist not found.")
    playlist.name = (payload.name or playlist.name).strip()
    playlist.description = payload.description or ""
    playlist.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(playlist)
    return {"success": True, "playlist": _serialize_playlist(playlist, db)}


@router.delete("/playlists/{playlist_id}")
def delete_playlist(playlist_id: int, db: Session = Depends(get_db)):
    playlist = db.query(FaphousePlaylist).filter(FaphousePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(404, detail="Playlist not found.")
    db.query(FaphousePlaylistItem).filter(FaphousePlaylistItem.playlist_id == playlist_id).delete()
    db.delete(playlist)
    db.commit()
    return {"success": True}


@router.get("/playlists/{playlist_id}/items")
def list_playlist_items(playlist_id: int, db: Session = Depends(get_db)):
    playlist = db.query(FaphousePlaylist).filter(FaphousePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(404, detail="Playlist not found.")
    items = (
        db.query(FaphousePlaylistItem)
        .filter(FaphousePlaylistItem.playlist_id == playlist_id)
        .order_by(FaphousePlaylistItem.position.asc(), FaphousePlaylistItem.added_at.asc())
        .all()
    )
    return {
        "playlist": _serialize_playlist(playlist, db),
        "items": [
            {
                "id": i.id, "video_url": i.video_url, "title": i.title,
                "thumbnail": i.thumbnail, "duration_sec": i.duration_sec,
                "position": i.position,
                "added_at": i.added_at.isoformat() if i.added_at else None,
            }
            for i in items
        ],
    }


@router.post("/playlists/{playlist_id}/items")
def add_playlist_item(playlist_id: int, payload: PlaylistItemPayload, db: Session = Depends(get_db)):
    playlist = db.query(FaphousePlaylist).filter(FaphousePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(404, detail="Playlist not found.")
    video_url = (payload.video_url or "").strip()
    if not video_url:
        raise HTTPException(400, detail="video_url is required.")
    existing = db.query(FaphousePlaylistItem).filter(
        FaphousePlaylistItem.playlist_id == playlist_id,
        FaphousePlaylistItem.video_url == video_url,
    ).first()
    if existing:
        return {"success": True, "item_id": existing.id, "duplicate": True}
    max_pos = db.query(FaphousePlaylistItem).filter(
        FaphousePlaylistItem.playlist_id == playlist_id
    ).count()
    item = FaphousePlaylistItem(
        playlist_id=playlist_id, video_url=video_url, title=payload.title or "",
        thumbnail=payload.thumbnail or "", duration_sec=payload.duration_sec or 0,
        position=max_pos,
    )
    db.add(item)
    playlist.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(item)
    return {"success": True, "item_id": item.id}


@router.delete("/playlists/{playlist_id}/items/{item_id}")
def remove_playlist_item(playlist_id: int, item_id: int, db: Session = Depends(get_db)):
    item = db.query(FaphousePlaylistItem).filter(
        FaphousePlaylistItem.id == item_id, FaphousePlaylistItem.playlist_id == playlist_id
    ).first()
    if not item:
        raise HTTPException(404, detail="Playlist item not found.")
    db.delete(item)
    db.commit()
    return {"success": True}


class ReorderPayload(BaseModel):
    item_ids: list[int]  # full ordered list of item ids for this playlist


@router.put("/playlists/{playlist_id}/reorder")
def reorder_playlist(playlist_id: int, payload: ReorderPayload, db: Session = Depends(get_db)):
    items = {
        i.id: i for i in db.query(FaphousePlaylistItem).filter(
            FaphousePlaylistItem.playlist_id == playlist_id
        ).all()
    }
    for position, item_id in enumerate(payload.item_ids):
        item = items.get(item_id)
        if item:
            item.position = position
    db.commit()
    return {"success": True}


# --------------------------------------------------------------------------- #
# Watch history / continue watching
# --------------------------------------------------------------------------- #

class HistoryUpdatePayload(BaseModel):
    video_url: str
    title: str = ""
    thumbnail: str = ""
    duration_sec: int = 0
    position_sec: float = 0
    tags: str = ""       # CSV
    categories: str = ""  # CSV


@router.get("/history")
def list_history(limit: int = 60, db: Session = Depends(get_db)):
    rows = (
        db.query(FaphouseWatchHistory)
        .order_by(FaphouseWatchHistory.last_watched_at.desc())
        .limit(max(1, min(limit, 500)))
        .all()
    )
    return {"history": [_serialize_history(r) for r in rows]}


@router.get("/history/continue")
def continue_watching(limit: int = 24, db: Session = Depends(get_db)):
    """Resumable videos only — position > 0 and not essentially finished."""
    rows = (
        db.query(FaphouseWatchHistory)
        .filter(FaphouseWatchHistory.position_sec > 5)
        .order_by(FaphouseWatchHistory.last_watched_at.desc())
        .limit(max(1, min(limit, 100)))
        .all()
    )
    out = []
    for r in rows:
        if r.duration_sec and r.position_sec >= r.duration_sec * 0.95:
            continue  # finished — not "continue watching" material
        out.append(_serialize_history(r))
    return {"items": out}


def _serialize_history(row: FaphouseWatchHistory) -> dict:
    return {
        "id": row.id, "video_url": row.video_url, "title": row.title,
        "thumbnail": row.thumbnail, "duration_sec": row.duration_sec,
        "position_sec": row.position_sec, "tags": row.tags, "categories": row.categories,
        "last_watched_at": row.last_watched_at.isoformat() if row.last_watched_at else None,
        "watch_count": row.watch_count,
    }


@router.post("/history")
def update_history(payload: HistoryUpdatePayload, db: Session = Depends(get_db)):
    video_url = (payload.video_url or "").strip()
    if not video_url:
        raise HTTPException(400, detail="video_url is required.")
    row = db.query(FaphouseWatchHistory).filter(FaphouseWatchHistory.video_url == video_url).first()
    if row is None:
        row = FaphouseWatchHistory(video_url=video_url, watch_count=0)
        db.add(row)
    row.title = payload.title or row.title or ""
    row.thumbnail = payload.thumbnail or row.thumbnail or ""
    row.duration_sec = payload.duration_sec or row.duration_sec or 0
    row.position_sec = max(0.0, payload.position_sec or 0.0)
    if payload.tags:
        row.tags = payload.tags
    if payload.categories:
        row.categories = payload.categories
    row.watch_count = (row.watch_count or 0) + 1
    row.last_watched_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    return {"success": True}


@router.delete("/history/{history_id}")
def delete_history_row(history_id: int, db: Session = Depends(get_db)):
    row = db.query(FaphouseWatchHistory).filter(FaphouseWatchHistory.id == history_id).first()
    if not row:
        raise HTTPException(404, detail="History entry not found.")
    db.delete(row)
    db.commit()
    return {"success": True}


@router.delete("/history")
def clear_history(db: Session = Depends(get_db)):
    db.query(FaphouseWatchHistory).delete()
    db.commit()
    return {"success": True}


# --------------------------------------------------------------------------- #
# Follows (models / studios)
# --------------------------------------------------------------------------- #

class FollowPayload(BaseModel):
    kind: str  # "model" | "studio"
    ref: str
    display_name: str = ""
    thumbnail: str = ""


def _serialize_follow(row: FaphouseFollow) -> dict:
    return {
        "id": row.id, "kind": row.kind, "ref": row.ref,
        "display_name": row.display_name, "thumbnail": row.thumbnail,
        "followed_at": row.followed_at.isoformat() if row.followed_at else None,
        "last_seen_video_url": row.last_seen_video_url,
        "last_seen_at": row.last_seen_at.isoformat() if row.last_seen_at else None,
    }


@router.get("/follows")
def list_follows(db: Session = Depends(get_db)):
    rows = db.query(FaphouseFollow).order_by(FaphouseFollow.followed_at.desc()).all()
    return {"follows": [_serialize_follow(r) for r in rows]}


@router.post("/follows")
def add_follow(payload: FollowPayload, db: Session = Depends(get_db)):
    kind = (payload.kind or "").strip().lower()
    ref = (payload.ref or "").strip()
    if kind not in ("model", "studio") or not ref:
        raise HTTPException(400, detail="kind must be 'model' or 'studio', and ref is required.")
    existing = db.query(FaphouseFollow).filter(
        FaphouseFollow.kind == kind, FaphouseFollow.ref == ref
    ).first()
    if existing:
        return {"success": True, "follow": _serialize_follow(existing), "duplicate": True}
    row = FaphouseFollow(
        kind=kind, ref=ref, display_name=payload.display_name or ref,
        thumbnail=payload.thumbnail or "",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"success": True, "follow": _serialize_follow(row)}


@router.delete("/follows/{follow_id}")
def remove_follow(follow_id: int, db: Session = Depends(get_db)):
    row = db.query(FaphouseFollow).filter(FaphouseFollow.id == follow_id).first()
    if not row:
        raise HTTPException(404, detail="Follow not found.")
    db.delete(row)
    db.commit()
    return {"success": True}


@router.get("/follows/check-new")
async def check_new_from_follows(db: Session = Depends(get_db)):
    """For every followed model/studio, fetch their latest page and report
    whether the newest tile is one the user hasn't seen yet.

    Doesn't mutate last_seen_video_url itself — that happens when the user
    actually opens the model/studio page (see POST /follows/{id}/seen), so a
    background poll can call this repeatedly without silently clearing badges
    the user hasn't looked at yet. A follow with no prior last_seen_video_url
    (just followed, never opened) is never flagged "new" — there is nothing
    to diff against yet, and every video would falsely show as new.
    """
    from ..hubs import registry
    registry.init_hubs()
    hub = registry.get("faphouse")
    if hub is None:
        raise HTTPException(503, detail="Faphouse hub not available.")

    rows = db.query(FaphouseFollow).all()
    out = []
    for row in rows:
        try:
            if row.kind == "model":
                page = await hub.pornstar_videos(row.ref, page=1)
            else:
                page = await hub.member_videos(row.ref, page=1)
            latest_url = page.items[0]["url"] if page.items else None
        except Exception as exc:  # noqa: BLE001 — one dead follow shouldn't break the poll
            logger.warning("[faphouse] check-new failed for %s/%s: %s", row.kind, row.ref, exc)
            latest_url = None
        out.append({
            "id": row.id, "kind": row.kind, "ref": row.ref,
            "has_new": bool(latest_url) and bool(row.last_seen_video_url) and latest_url != row.last_seen_video_url,
            "latest_url": latest_url,
        })
    return {"follows": out}


@router.post("/follows/{follow_id}/seen")
async def mark_follow_seen(follow_id: int, db: Session = Depends(get_db)):
    row = db.query(FaphouseFollow).filter(FaphouseFollow.id == follow_id).first()
    if not row:
        raise HTTPException(404, detail="Follow not found.")
    from ..hubs import registry
    registry.init_hubs()
    hub = registry.get("faphouse")
    if hub is not None:
        try:
            page = await (hub.pornstar_videos(row.ref, page=1) if row.kind == "model"
                          else hub.member_videos(row.ref, page=1))
            if page.items:
                row.last_seen_video_url = page.items[0]["url"]
        except Exception as exc:  # noqa: BLE001
            logger.warning("[faphouse] mark-seen fetch failed for %s/%s: %s", row.kind, row.ref, exc)
    row.last_seen_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    return {"success": True}


# --------------------------------------------------------------------------- #
# For You feed
# --------------------------------------------------------------------------- #

@router.get("/for-you")
async def for_you_feed(limit: int = 40, db: Session = Depends(get_db)):
    """Followed creators first, then tag/category affinity from watch history.

    MVP scope (per spec §5.3): (a) latest from follows, (b) watch-history
    affinity. Broader library-wide tag affinity is deferred.
    """
    from collections import Counter

    from ..hubs import registry
    registry.init_hubs()
    hub = registry.get("faphouse")
    if hub is None:
        raise HTTPException(503, detail="Faphouse hub not available.")

    items: list[dict] = []
    seen_urls: set[str] = set()

    follows = db.query(FaphouseFollow).order_by(FaphouseFollow.followed_at.desc()).limit(10).all()
    for follow in follows:
        try:
            page = await (hub.pornstar_videos(follow.ref, page=1) if follow.kind == "model"
                          else hub.member_videos(follow.ref, page=1))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[faphouse] for-you follow fetch failed for %s: %s", follow.ref, exc)
            continue
        for tile in page.items[:6]:
            if tile["url"] not in seen_urls:
                seen_urls.add(tile["url"])
                items.append({**tile, "_reason": f"Sleduješ {follow.display_name or follow.ref}"})

    # Tag/category affinity from recent watch history
    history = (
        db.query(FaphouseWatchHistory)
        .order_by(FaphouseWatchHistory.last_watched_at.desc())
        .limit(50)
        .all()
    )
    tag_counter: Counter[str] = Counter()
    for row in history:
        for t in (row.tags or "").split(","):
            t = t.strip().lower()
            if t:
                tag_counter[t] += row.watch_count or 1
    top_tags = [t for t, _ in tag_counter.most_common(3)]

    for tag in top_tags:
        if len(items) >= limit:
            break
        try:
            page = await hub.search("", category=tag, page=1)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[faphouse] for-you tag fetch failed for %s: %s", tag, exc)
            continue
        for tile in page.items[:8]:
            if tile["url"] not in seen_urls and len(items) < limit:
                seen_urls.add(tile["url"])
                items.append({**tile, "_reason": f"Pretože pozeráš {tag}"})

    return {"items": items[:limit]}


# --------------------------------------------------------------------------- #
# Mashup Studio jobs
# --------------------------------------------------------------------------- #

class MashupCreatePayload(BaseModel):
    source_spec: dict  # {"layout": str, "tracks": [...], "audio_track_keyframes": [...]}


def _serialize_job(job: FaphouseMashupJob) -> dict:
    return {
        "id": job.id, "status": job.status, "progress_pct": job.progress_pct,
        "output_path": job.output_path, "error": job.error,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
    }


@router.get("/mashup/jobs")
def list_mashup_jobs(db: Session = Depends(get_db)):
    rows = db.query(FaphouseMashupJob).order_by(FaphouseMashupJob.created_at.desc()).limit(50).all()
    return {"jobs": [_serialize_job(j) for j in rows]}


@router.get("/mashup/jobs/{job_id}")
def get_mashup_job(job_id: int, db: Session = Depends(get_db)):
    job = db.query(FaphouseMashupJob).filter(FaphouseMashupJob.id == job_id).first()
    if not job:
        raise HTTPException(404, detail="Mashup job not found.")
    return {"job": _serialize_job(job)}


@router.post("/mashup/jobs")
def create_mashup_job(payload: MashupCreatePayload, background_tasks: BackgroundTasks,
                      db: Session = Depends(get_db)):
    tracks = payload.source_spec.get("tracks") or []
    if not (2 <= len(tracks) <= 4):
        raise HTTPException(400, detail="Mashup needs 2-4 source tracks.")
    job = FaphouseMashupJob(status="queued", progress_pct=0, source_spec=payload.source_spec)
    db.add(job)
    db.commit()
    db.refresh(job)

    from ..faphouse_mashup import render_mashup_job
    background_tasks.add_task(render_mashup_job, job.id)

    return {"success": True, "job": _serialize_job(job)}


@router.delete("/mashup/jobs/{job_id}")
def delete_mashup_job(job_id: int, db: Session = Depends(get_db)):
    job = db.query(FaphouseMashupJob).filter(FaphouseMashupJob.id == job_id).first()
    if not job:
        raise HTTPException(404, detail="Mashup job not found.")
    if job.status == "rendering":
        raise HTTPException(409, detail="Cannot delete a job while it is rendering.")
    db.delete(job)
    db.commit()
    return {"success": True}


# --------------------------------------------------------------------------- #
# Cookie auto-refresh — pushed by the Nexus_Gallery browser extension
# (background.js's chrome.cookies.getAll on a timer + on-change listener),
# same pattern as /api/forum/cookies/sync but writing the Netscape file
# app/hubs/faphouse.py's COOKIE_CANDIDATES reads instead of a JSON dict store.
# --------------------------------------------------------------------------- #

class CookieRow(BaseModel):
    name: str
    value: str
    domain: str = ""
    path: str = "/"
    secure: bool = False
    expirationDate: Optional[float] = None


class CookieSyncPayload(BaseModel):
    cookies: list[CookieRow] = []


@router.post("/cookies/sync")
async def sync_cookies(payload: CookieSyncPayload):
    """Extension push: keeps faphouse_cookies.txt current without a manual
    DevTools export. Silently accepts an empty/partial batch (returns
    success=False rather than an error) so a transient extension glitch can't
    make the sync loop back off — the next timer tick just tries again.
    Verifies the incoming batch against Faphouse itself before overwriting a
    currently-signed-in file with a signed-out one (see write_faphouse_cookies)."""
    from ..faphouse_cookie_sync import write_faphouse_cookies

    rows = [row.model_dump() for row in payload.cookies]
    result = await write_faphouse_cookies(rows)
    return result


@router.get("/cookies/status")
async def cookies_status(check_signed_in: bool = False):
    """What the hub adapter actually sees right now — the extension (or the
    user, debugging why auth looks stale) can poll this instead of guessing
    from file-manager timestamps. `check_signed_in=true` adds one live
    request to Faphouse to report whether the file's session actually
    authenticates — off by default so a routine status poll doesn't cost a
    network round-trip every time."""
    from ..hubs.faphouse import COOKIE_CANDIDATES

    cookie_file = resolve_cookiefile(*COOKIE_CANDIDATES)
    mtime = cookiejar_mtime(cookie_file)
    out = {
        "cookie_file": cookie_file,
        "cookie_present": bool(cookie_file),
        "cookie_mtime": mtime,
        # time.time(), not datetime.now(timezone.utc).replace(tzinfo=None).timestamp() — the latter treats a
        # naive UTC datetime AS IF it were local time on .timestamp(), which on
        # a non-UTC host produces a bogus (here: negative) age.
        "age_seconds": (time.time() - mtime) if mtime else None,
    }
    if check_signed_in and cookie_file:
        from ..cookie_jar import build_cookie_header
        from ..faphouse_cookie_sync import _looks_signed_in

        out["signed_in"] = await _looks_signed_in(build_cookie_header(cookie_file))
    return out


# --------------------------------------------------------------------------- #
# Community playlist index — a local, searchable copy of Faphouse's own
# /playlists directory (OTHER users' public playlists, unrelated to the
# FaphousePlaylist table above). Faphouse has no server-side keyword search
# over that directory — a `?q=` there silently redirects to /search/videos —
# so this crawls the ~90k listed playlists once into
# faphouse_community_playlists and answers keyword search from local SQL.
# --------------------------------------------------------------------------- #

import re as _re

_PLAYLIST_CARD_RE = _re.compile(
    r"^([\d,]+)\s+videos\s+(.+?)\s+Published by:?\s*(.+)$"
)


def _parse_playlist_page(page_html: str) -> list[dict]:
    """[{code, name, published_by, video_count}] from one /playlists listing page.

    Each card's own anchor text is "N videos <Name> Published by <User>" in
    one run (confirmed live 2026-09-06) — simpler and more reliable than
    trying to scope separate title/count/author sub-elements, whose class
    names aren't guaranteed stable.
    """
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(page_html or "", "html.parser")
    seen: set[str] = set()
    rows: list[dict] = []
    for a in soup.select('a[href*="/playlists/"]'):
        href = (a.get("href") or "").strip()
        if href.count("/") != 2:
            continue
        code = href.rstrip("/").split("/")[-1]
        if not code or code in seen:
            continue
        seen.add(code)
        text = a.get_text(" ", strip=True)
        m = _PLAYLIST_CARD_RE.match(text)
        if not m:
            continue
        try:
            count = int(m.group(1).replace(",", ""))
        except ValueError:
            count = 0
        rows.append({"code": code, "name": m.group(2).strip(), "published_by": m.group(3).strip(), "video_count": count})
    return rows


async def _crawl_community_playlists(sort_mode: str, resume_from_page: int) -> None:
    """Background task: walk every /playlists page for one sort mode, upserting
    each row as it goes so a killed/restarted crawl loses at most one page of
    progress rather than the whole run. Both sort_mode passes ("popular" then
    "new") are needed because Faphouse serves a different ORDER for each —
    running only one would still miss playlists that only rank highly under
    the other ranking.
    """
    import asyncio as _asyncio

    from ..hubs.faphouse import FaphouseHub

    hub = FaphouseHub()
    db = SessionLocal()
    try:
        state = db.query(FaphousePlaylistCrawlState).get(1)
        if state is None:
            state = FaphousePlaylistCrawlState(id=1)
            db.add(state)
        state.status = "running"
        state.sort_mode = sort_mode
        state.started_at = state.started_at or datetime.now(timezone.utc).replace(tzinfo=None)
        state.error = None
        db.commit()

        page = max(1, resume_from_page)
        while True:
            url = f"https://faphouse.com/playlists?sort={sort_mode}&page={page}"
            try:
                # An outer deadline on top of _get_html's own 20s curl timeout:
                # that inner timeout only starts once the request actually
                # begins executing, but asyncio.to_thread hands work to a
                # shared default thread pool this server also uses for many
                # other blocking HTTP calls (video refresh, link testing,
                # etc.) — under contention a submission can sit queued
                # indefinitely with no timeout of its own, silently stalling
                # this crawl forever with no error ever raised. This bounds
                # the wait regardless of queueing.
                status, html = await _asyncio.wait_for(hub._get_html(url), timeout=45)
            except _asyncio.TimeoutError:
                state.status = "error"
                state.error = f"Timed out fetching page {page} ({sort_mode})"
                db.commit()
                return
            if status == 404:
                break
            if status != 200:
                state.status = "error"
                state.error = f"HTTP {status} on page {page} ({sort_mode})"
                db.commit()
                return

            rows = _parse_playlist_page(html)
            if not rows:
                break

            for row in rows:
                existing = db.query(FaphouseCommunityPlaylist).filter(
                    FaphouseCommunityPlaylist.url_code == row["code"]
                ).first()
                if existing:
                    existing.name = row["name"]
                    existing.published_by = row["published_by"]
                    existing.video_count = row["video_count"]
                    existing.crawled_at = datetime.now(timezone.utc).replace(tzinfo=None)
                else:
                    db.add(FaphouseCommunityPlaylist(
                        url_code=row["code"], name=row["name"],
                        published_by=row["published_by"], video_count=row["video_count"],
                    ))
            state.current_page = page
            state.playlists_found = db.query(FaphouseCommunityPlaylist).count()
            db.commit()

            # NOT "len(rows) < 60" — per-page card counts on this listing
            # genuinely vary well before the real last page (live-verified:
            # sort=new page 1 already has only 31 rows), so the only
            # trustworthy end-of-list signals are the 404 / empty-page checks
            # above. A short page here means nothing.
            page += 1
            # A polite pace, not a rate-limit workaround: this crawl covers
            # ~1500 pages per sort mode, so even a small per-request delay
            # keeps it from hammering Faphouse for the better part of an hour.
            await _asyncio.sleep(1.0)

        if sort_mode == "popular":
            state.popular_done = True
        else:
            state.new_done = True
        state.status = "done"
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.exception("[faphouse community playlist crawl] failed")
        state = db.query(FaphousePlaylistCrawlState).get(1)
        if state:
            state.status = "error"
            state.error = str(exc)
            db.commit()
    finally:
        db.close()


@router.post("/community-playlists/crawl/start")
async def start_playlist_crawl(bg_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Kicks off (or resumes) the community-playlist crawl in the background.
    Manual trigger only — this is a ~1 hour, ~3000-page scrape, not something
    that should run silently on a schedule the user didn't ask for.

    Two full passes are needed (popular, then new — see
    _crawl_community_playlists), tracked independently so a completed
    "popular" pass is never re-walked once "new" is what's left to do, and an
    error mid-pass resumes that SAME pass from its last successful page
    instead of losing progress or silently skipping to the other one.
    """
    state = db.query(FaphousePlaylistCrawlState).get(1)
    if state and state.status == "running":
        return {"status": "already_running", "current_page": state.current_page}

    if state and state.popular_done and state.new_done:
        return {"status": "already_complete", "playlists_found": state.playlists_found}

    # Resume the in-progress/errored pass at its last page; otherwise start
    # whichever pass hasn't completed yet, popular first.
    if state and state.status == "error" and not (state.sort_mode == "popular" and state.popular_done) \
            and not (state.sort_mode == "new" and state.new_done):
        sort_mode = state.sort_mode
        resume_page = state.current_page or 1
    elif state and state.popular_done and not state.new_done:
        sort_mode = "new"
        resume_page = 1
    else:
        sort_mode = "popular"
        resume_page = 1

    bg_tasks.add_task(_crawl_community_playlists, sort_mode, resume_page)
    return {"status": "started", "sort_mode": sort_mode, "resume_page": resume_page}


@router.get("/community-playlists/crawl/status")
def playlist_crawl_status(db: Session = Depends(get_db)):
    state = db.query(FaphousePlaylistCrawlState).get(1)
    if not state:
        return {"status": "idle", "current_page": 0, "playlists_found": 0}
    return {
        "status": state.status,
        "sort_mode": state.sort_mode,
        "current_page": state.current_page,
        "playlists_found": state.playlists_found,
        "popular_done": state.popular_done,
        "new_done": state.new_done,
        "started_at": state.started_at.isoformat() if state.started_at else None,
        "updated_at": state.updated_at.isoformat() if state.updated_at else None,
        "error": state.error,
    }


@router.get("/community-playlists/search")
def search_community_playlists(q: str = "", limit: int = 60, favorites_only: bool = False,
                               db: Session = Depends(get_db)):
    """Keyword search over the local playlist-name index. Empty `q` returns
    the most recently crawled playlists rather than an error — a reasonable
    default view before the user has typed anything.

    `favorites_only=true` ignores `q` entirely and lists every playlist the
    user has starred (see toggle_community_playlist_favorite) — this is what
    backs the "Len obľúbené" switch, so a playlist found once stays easy to
    find again without re-typing the search that surfaced it.
    """
    query = db.query(FaphouseCommunityPlaylist)
    if favorites_only:
        query = query.filter(FaphouseCommunityPlaylist.is_favorite.is_(True))
    else:
        needle = q.strip()
        if needle:
            query = query.filter(FaphouseCommunityPlaylist.name.ilike(f"%{needle}%"))
    rows = query.order_by(FaphouseCommunityPlaylist.video_count.desc()).limit(max(1, min(limit, 200))).all()
    total_indexed = db.query(FaphouseCommunityPlaylist).count()
    return {
        "results": [
            {
                "code": r.url_code, "name": r.name, "published_by": r.published_by,
                "video_count": r.video_count, "url": f"https://faphouse.com/playlists/{r.url_code}",
                "is_favorite": bool(r.is_favorite),
                # Cached Fast fetch result from a previous probe, if any — lets
                # the card show its badge immediately without a click. None of
                # these fields exist until probe_community_playlist() has run
                # for this code at least once.
                "probe": ({
                    "quality_rating": r.probe_quality_rating,
                    "avg_duration_sec": r.probe_avg_duration_sec,
                    "avg_size_mb": r.probe_avg_size_mb,
                    "total_size_mb": r.probe_total_size_mb,
                    "size_estimated": True,
                } if r.probed_at else None),
            }
            for r in rows
        ],
        "total_indexed": total_indexed,
    }


@router.post("/community-playlists/{code}/favorite")
def toggle_community_playlist_favorite(code: str, db: Session = Depends(get_db)):
    """Star/unstar a community playlist so it can be found again later via
    the favorites_only filter above without re-searching for it."""
    row = db.query(FaphouseCommunityPlaylist).filter(FaphouseCommunityPlaylist.url_code == code).first()
    if not row:
        raise HTTPException(status_code=404, detail="Playlist nie je v indexe")
    row.is_favorite = not bool(row.is_favorite)
    db.commit()
    return {"code": code, "is_favorite": row.is_favorite}


# Same bitrate-by-resolution assumption used by app/routers/playlist_probe.py
# for the xvideos "related playlists" fast fetch — Faphouse's own listing
# cards never carry a file size (only duration + quality badge), so any size
# figure here is necessarily an estimate derived from duration and height.
def _estimate_size_mb(duration_sec: int, height: int) -> float:
    bits_per_sec = 2_500_000 * (max(height, 360) / 1080) ** 1.4
    return round(bits_per_sec * duration_sec / 8 / 1_048_576, 1)


def _quality_rating(avg_height: float) -> str:
    if avg_height >= 2160:
        return "4K"
    if avg_height >= 720:
        return "HD"
    return "LQ"


@router.get("/community-playlists/{code}/probe")
async def probe_community_playlist(code: str, refresh: bool = False, db: Session = Depends(get_db)):
    """Fast fetch: sample this playlist's own first page (already scraped by
    FaphouseHub.playlist_videos — no new scraping here) and turn its per-card
    duration/height into a quality rating (4K/HD/LQ) and an estimated size,
    without walking every page of the playlist.

    Result is cached on the FaphouseCommunityPlaylist row (see probe_* columns
    in app/database.py) so a later search for the same playlist returns the
    badge instantly via /community-playlists/search instead of re-fetching —
    pass `?refresh=true` to force a fresh sample (e.g. the playlist may have
    grown since it was last probed).
    """
    row = db.query(FaphouseCommunityPlaylist).filter(FaphouseCommunityPlaylist.url_code == code).first()
    if row and row.probed_at and not refresh:
        video_count = row.video_count
        total_size_mb = round(row.probe_avg_size_mb * video_count, 1) if row.probe_avg_size_mb and video_count else None
        return {
            "code": code,
            "video_count": video_count,
            "avg_duration_sec": row.probe_avg_duration_sec,
            "quality_rating": row.probe_quality_rating or "",
            "avg_size_mb": row.probe_avg_size_mb,
            "total_size_mb": total_size_mb,
            "size_estimated": True,
            "cached": True,
        }

    from ..hubs.faphouse import FaphouseHub

    hub = FaphouseHub()
    try:
        sample_page = await hub.playlist_videos(code, page=1)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Nepodarilo sa načítať playlist: {exc}") from exc

    tiles = sample_page.items or []
    durations = [t["duration_sec"] for t in tiles if t.get("duration_sec")]
    heights = [t["height"] for t in tiles if t.get("height")]

    avg_duration_sec = round(sum(durations) / len(durations)) if durations else 0
    avg_height = round(sum(heights) / len(heights)) if heights else 0
    avg_size_mb = _estimate_size_mb(avg_duration_sec, avg_height) if avg_duration_sec and avg_height else None
    quality_rating = _quality_rating(avg_height) if avg_height else ""

    video_count = row.video_count if row else len(tiles)
    total_size_mb = round(avg_size_mb * video_count, 1) if avg_size_mb and video_count else None

    if row:
        row.probe_quality_rating = quality_rating or None
        row.probe_avg_duration_sec = avg_duration_sec or None
        row.probe_avg_size_mb = avg_size_mb
        row.probe_total_size_mb = total_size_mb
        row.probed_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()

    return {
        "code": code,
        "sampled_count": len(tiles),
        "video_count": video_count,
        "avg_duration_sec": avg_duration_sec,
        "avg_height": avg_height,
        "quality_rating": quality_rating,
        "avg_size_mb": avg_size_mb,
        "total_size_mb": total_size_mb,
        "size_estimated": True,
        "cached": False,
    }


# A generous but bounded walk: at ~30-40 cards/page this covers playlists up
# to roughly 1500-2000 videos. Bounded (not "until empty" forever) so one
# pathological/misbehaving playlist page can't hang the request indefinitely
# — the same reasoning as the community-playlist crawl's own page loop, just
# synchronous here since a single playlist is a much smaller walk than the
# ~3000-page full-directory crawl.
_IMPORT_MAX_PAGES = 50


@router.post("/community-playlists/{code}/import")
async def import_community_playlist(code: str, db: Session = Depends(get_db)):
    """Walk every page of this (someone else's) public Faphouse playlist and
    queue all of its videos as one Nexus import job — the "Import celý
    playlist" button next to Fast fetch. Reuses the exact same intake pipeline
    (IntakeCandidate -> ImportJob -> intake_worker) the frontend's own
    importSelected()/importItem() already POST to, so progress shows up in
    the normal Import Monitor instead of a bespoke tracker.
    """
    from ..hubs.faphouse import FaphouseHub
    from ..intake import IntakeCandidate, IntakeImportRequest, create_import_job, intake_worker

    hub = FaphouseHub()
    candidates: list[IntakeCandidate] = []
    seen_urls: set[str] = set()
    page = 1
    while page <= _IMPORT_MAX_PAGES:
        try:
            result = await hub.playlist_videos(code, page=page)
        except Exception as exc:  # noqa: BLE001
            if page == 1:
                raise HTTPException(status_code=502, detail=f"Nepodarilo sa načítať playlist: {exc}") from exc
            break  # a later page failing shouldn't lose everything already collected
        tiles = result.items or []
        if not tiles:
            break
        for tile in tiles:
            url = str(tile.get("url") or "").strip()
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            candidates.append(IntakeCandidate(
                title=str(tile.get("title") or "Faphouse video"),
                url=url,
                source_url=url,
                thumbnail=str(tile.get("thumb") or ""),
                duration=float(tile.get("duration_sec") or 0),
                height=int(tile.get("height") or 0),
                source="faphouse",
                tags=["faphouse", "playlist", f"playlist:{code}"],
                confidence=0.9,
            ))
        if not result.has_more:
            break
        page += 1

    if not candidates:
        raise HTTPException(status_code=502, detail="Playlist neobsahuje žiadne videá alebo sa nepodarilo načítať.")

    row = db.query(FaphouseCommunityPlaylist).filter(FaphouseCommunityPlaylist.url_code == code).first()
    playlist_name = row.name if row else code
    batch_name = f"Faphouse PL: {playlist_name}"[:120]

    job = create_import_job(
        IntakeImportRequest(candidates=candidates, batch_name=batch_name, source_mode="faphouse"),
        db,
    )
    intake_worker.start()
    return {"queued": len(candidates), "pages_walked": page, "batch_name": batch_name, "job_id": job.id}
