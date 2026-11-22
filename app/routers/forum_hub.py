"""Forum Hub API — watched threads + tag channels as one reviewable link gallery.

Nothing here downloads anything on its own. A refresh only ever produces
`status="new"` rows; `/resolve` inspects a link, `/import` is the explicit
hand-off to the existing intake worker.
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import (
    ForumLink,
    ForumPost,
    ForumSavedQuery,
    ForumSyncJob,
    ForumTag,
    ForumThread,
    SessionLocal,
    get_db,
    utcnow,
)
from ..forums import service
from ..forums.boards import (
    BOARDS,
    board_status,
    get_board,
    load_cookies,
    merge_cookie_rows,
    missing_auth_cookies,
    write_cookie_rows,
    write_cookies,
)
from ..forums.client import ForumAuthError, ForumChallengeError, ForumRateLimitError, auth_health, cooldown_remaining
from ..forums.parser import SUPPORTED_PLATFORMS
from ..intake import IntakeCandidate, IntakeImportRequest, create_import_job, intake_worker, serialize_job

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/forum", tags=["forum-hub"])


def _update_refresh_job(db: Session, job_id: str, **updates: Any) -> None:
    job = db.get(ForumSyncJob, job_id)
    if job is None:
        raise RuntimeError(f"Refresh job {job_id} no longer exists.")
    for key, value in updates.items():
        setattr(job, key, value)
    job.updated_at = utcnow()
    db.commit()


def _prune_refresh_jobs(db: Session) -> None:
    now = utcnow()
    cutoff = now - timedelta(hours=2)
    db.query(ForumSyncJob).filter(ForumSyncJob.completed_at < cutoff).delete(synchronize_session=False)
    stale_before = now - timedelta(minutes=30)
    stale_jobs = db.query(ForumSyncJob).filter(
        ForumSyncJob.status.in_(("queued", "running")),
        ForumSyncJob.updated_at < stale_before,
    ).all()
    for job in stale_jobs:
        job.status = "failed"
        job.error = "Refresh prestal hlásiť priebeh; spusti ho znova."
        job.completed_at = now
        job.updated_at = now
    completed = (
        db.query(ForumSyncJob)
        .filter(ForumSyncJob.completed_at.is_not(None))
        .order_by(ForumSyncJob.completed_at.desc())
        .offset(100)
        .all()
    )
    for job in completed:
        db.delete(job)
    db.commit()


async def _run_refresh_job(job_id: str, boards: list[str], unread_only: bool = False) -> None:
    db = SessionLocal()
    try:
        _update_refresh_job(
            db,
            job_id,
            status="running",
            progress={"message": "Synchronizácia sa spúšťa.", "completed": 0, "total": 0},
        )
        result = await service.refresh_all(
            db,
            boards,
            progress=lambda progress: _update_refresh_job(db, job_id, progress=dict(progress)),
            unread_only=unread_only,
        )
        _update_refresh_job(
            db,
            job_id,
            status="completed",
            result=result,
            completed_at=utcnow(),
        )
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("[ForumHub] background refresh %s failed", job_id)
        _update_refresh_job(
            db,
            job_id,
            status="failed",
            error=str(exc),
            completed_at=utcnow(),
        )
    finally:
        db.close()


# ─── payloads ─────────────────────────────────────────────────────────────────

class RefreshRequest(BaseModel):
    boards: list[str] = Field(default_factory=lambda: ["simpcity"])
    unread_only: bool = False


class DiscoverRequest(BaseModel):
    board: str = "simpcity"
    tags: list[str] = Field(default_factory=list)
    window_days: int = 7
    platforms: list[str] = Field(default_factory=list)


class TagGroup(BaseModel):
    name: str
    #: Any ONE of these tags qualifies a THREAD for this group (OR, not AND —
    #: SimpCity's own multi-tag search ANDs and returns 0 for real combinations
    #: like fake-tits+blowjob, so each tag is discovered separately and merged).
    tags: list[str] = Field(default_factory=list)
    #: Optional second filter applied to individual LINKS within a qualifying
    #: thread (any ONE of these words in the link's hashtags/title). A thread's
    #: own tag ("big-tits") describes the model, not every scene posted in it —
    #: a deepthroat clip can live in a thread never tagged "deepthroat" at all,
    #: so this catches it by what the *post* actually says instead of what the
    #: thread as a whole was filed under.
    content_filter: list[str] = Field(default_factory=list)


class GroupDiscoverRequest(BaseModel):
    board: str = "simpcity"
    groups: list[TagGroup] = Field(default_factory=list)
    window_days: int = 30


class SavedQueryPayload(BaseModel):
    name: str = ""
    board: str = "simpcity"
    tags: list[str] = Field(default_factory=list)
    window_days: int = 7
    platforms: list[str] = Field(default_factory=list)


class LinkIdsRequest(BaseModel):
    link_ids: list[int] = Field(default_factory=list)


class PurgeRequest(BaseModel):
    """Wipe every matching card in the current board/mode — not just the 24 visible per thread."""
    status: str = "dead"
    board: str = ""
    origin: str = ""


class CookieSyncRequest(BaseModel):
    board: str
    # Kept for older extension builds. New builds send cookie_rows so expiry,
    # domain, path and secure are retained exactly as Chrome reports them.
    cookies: dict[str, str] = Field(default_factory=dict)
    cookie_rows: list[dict[str, Any]] = Field(default_factory=list)


class ImportRequest(BaseModel):
    link_ids: list[int] = Field(default_factory=list)
    batch_name: Optional[str] = None


# ─── serialization ────────────────────────────────────────────────────────────

def _serialize_link(link: ForumLink) -> dict[str, Any]:
    payload = link.resolved_payload or {}
    return {
        "id": link.id,
        "url": link.url,
        "platform": link.platform,
        "link_type": link.link_type,
        "title": link.title,
        "thumbnail": link.thumbnail,
        "quality": link.quality or payload.get("quality") or "",
        "duration": link.duration or payload.get("duration") or 0,
        "size_bytes": link.size_bytes or payload.get("size_bytes") or 0,
        "tags": link.tags or [],
        "author": link.author,
        "posted_at": link.posted_at.isoformat() if link.posted_at else None,
        "status": link.status,
        # Only a full meta pass counts. An early build stored the resolver's
        # stream-only payload here, which has no `ok` key and no size/duration —
        # those must be re-probed, not treated as done.
        "resolved": bool((link.resolved_payload or {}).get("ok")),
        "stream_url": payload.get("stream_url") or "",
        "is_hls": bool(payload.get("is_hls")),
        "item_count": payload.get("item_count") or payload.get("video_count") or 0,
        "album_thumbnails": payload.get("album_thumbnails") or [],
    }


def _serialize_thread(thread: ForumThread, links: list[ForumLink]) -> dict[str, Any]:
    board = BOARDS.get(thread.board)
    return {
        "id": thread.id,
        "board": thread.board,
        "board_label": board.label if board else thread.board,
        "board_color": board.color if board else "#22d3ee",
        "url": thread.url,
        "title": thread.title,
        "origin": thread.origin,
        "discovered_via": thread.discovered_via,
        "tags": thread.tags or [],
        "last_post_at": thread.last_post_at.isoformat() if thread.last_post_at else None,
        "last_checked_at": thread.last_checked_at.isoformat() if thread.last_checked_at else None,
        "new_count": sum(1 for l in links if l.status == "new"),
        "links": [_serialize_link(l) for l in links],
    }


# ─── boards & tags ────────────────────────────────────────────────────────────

@router.get("/boards")
def list_boards():
    def _status(board):
        status = board_status(board, expose_cookie_details=False)
        return {
            **status,
            **auth_health(board.key, status["authenticated"]),
            "cooldown_seconds": round(cooldown_remaining(board.key)),
        }

    return {
        "boards": [_status(board) for board in BOARDS.values()],
        "platforms": list(SUPPORTED_PLATFORMS),
    }


@router.post("/cookies/sync")
def sync_cookies(request: CookieSyncRequest):
    """Extension push: `chrome.cookies.getAll()` sees HttpOnly cookies a page never could.

    Called on a timer from the browser so the jar self-heals after every login,
    without a manual DevTools copy-paste. Silently ignored if the board is unknown
    so a stale/renamed board in the extension can't 500 the sync loop.
    """
    try:
        board = get_board(request.board)
    except KeyError:
        return {"success": False, "reason": "unknown board"}

    if not request.cookies and not request.cookie_rows:
        return {"success": False, "reason": "no cookies sent"}

    incoming = ({str(row.get("name")): str(row.get("value")) for row in request.cookie_rows
                 if row.get("name") and row.get("value") is not None}
                if request.cookie_rows else
                {str(name): str(value) for name, value in request.cookies.items() if name and value})
    # A partial browser export (for example one without HttpOnly cookies) must
    # not erase a working manually exported session. Keep the old auth pair and
    # only merge harmless freshness cookies such as the CSRF/DDG values.
    existing = load_cookies(board)
    merged = {**existing, **incoming}
    incoming_missing = missing_auth_cookies(incoming)
    if request.cookie_rows and incoming_missing:
        written = merge_cookie_rows(board, request.cookie_rows)
    elif request.cookie_rows:
        written = write_cookie_rows(board, request.cookie_rows)
    elif incoming_missing:
        written = write_cookies(board, merged)
    else:
        written = write_cookies(board, incoming)
    if not written:
        return {"success": False, "reason": "no valid cookies were written", "auth_state": "unchecked"}
    merged = load_cookies(board)
    missing = missing_auth_cookies(merged)
    return {
        "success": True,
        "authenticated": not missing,
        "missing_cookies": missing,
        "preserved_existing_auth": bool(incoming_missing and not missing),
        "written": written,
        "auth_state": "unchecked",
    }


@router.get("/tags")
def list_tags(board: str = "simpcity", q: str = "", limit: int = 60, db: Session = Depends(get_db)):
    query = db.query(ForumTag).filter(ForumTag.board == board)
    if q:
        query = query.filter(ForumTag.tag.ilike(f"%{q.strip().lower()}%"))
    rows = query.order_by(ForumTag.weight.desc(), ForumTag.tag.asc()).limit(limit).all()
    return {"tags": [{"tag": r.tag, "weight": r.weight} for r in rows]}


@router.post("/tags/refresh")
async def refresh_tags(board: str = "simpcity", db: Session = Depends(get_db)):
    try:
        count = await service.refresh_tag_cloud(db, board)
    except ForumAuthError as exc:
        raise HTTPException(401, detail=str(exc))
    except ForumChallengeError as exc:
        raise HTTPException(503, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"Tag cloud refresh failed: {exc}")
    return {"success": True, "tags": count}


# ─── feed ─────────────────────────────────────────────────────────────────────

_QUALITY_RANK = {"4k": 2160, "2160p": 2160, "1440p": 1440, "1080p": 1080, "720p": 720, "480p": 480, "360p": 360}


def _height_of(link: ForumLink) -> int:
    """Quality is stored as a label; rank it by pixel height so it can be compared."""
    rank = _QUALITY_RANK.get((link.quality or "").strip().lower())
    if rank:
        return rank
    return int((link.resolved_payload or {}).get("height") or 0)


def _sort_key(sort: str):
    if sort == "size":
        return lambda l: (l.size_bytes or 0)
    if sort == "duration":
        return lambda l: (l.duration or 0)
    if sort == "quality":
        return lambda l: (_height_of(l), l.size_bytes or 0)
    if sort == "oldest":
        return lambda l: (-(l.posted_at.timestamp() if l.posted_at else 0), -l.id)
    return lambda l: ((l.posted_at.timestamp() if l.posted_at else 0), l.id)  # newest


@router.get("/feed")
def feed(
    board: str = "",
    origin: str = "",
    status: str = "new",
    platform: str = "",
    q: str = "",
    sort: str = "newest",
    min_size_mb: float = 0,
    min_duration: int = 0,
    min_height: int = 0,
    only_complete: bool = False,
    limit_per_thread: int = Query(24, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """Links grouped by thread — exactly the gallery shape the UI renders.

    Sorting and the size/duration/quality filters run in Python: quality is a label
    (`1080p`, `4K`), not a sortable number, and an unresolved link legitimately has
    zeros everywhere until the enrich queue reaches it.
    """
    links_q = db.query(ForumLink)
    if status == "active":
        # Verifying a card must not make it vanish from the working view — being
        # resolved is a property of the card, not a reason to hide it. Only the
        # user hides things (dismiss/import).
        links_q = links_q.filter(ForumLink.status.in_(("new", "resolved", "dead")))
    elif status and status != "all":
        links_q = links_q.filter(ForumLink.status == status)
    if platform:
        links_q = links_q.filter(ForumLink.platform == platform)
    if q:
        links_q = links_q.filter(ForumLink.title.ilike(f"%{q.strip()}%"))

    links = links_q.all()

    if min_size_mb:
        threshold = int(min_size_mb * 1024 * 1024)
        links = [l for l in links if (l.size_bytes or 0) >= threshold]
    if min_duration:
        links = [l for l in links if (l.duration or 0) >= min_duration]
    if min_height:
        links = [l for l in links if _height_of(l) >= min_height]
    if only_complete:
        links = [l for l in links if l.size_bytes and l.duration and l.quality]

    if not links:
        return {"threads": [], "total_links": 0, "counts": {
            "dead": 0, "new": 0, "resolved": 0, "imported": 0, "dismissed": 0,
        }}

    thread_ids = {l.thread_id for l in links}
    threads_q = db.query(ForumThread).filter(ForumThread.id.in_(thread_ids))
    if board:
        threads_q = threads_q.filter(ForumThread.board == board)
    if origin:
        threads_q = threads_q.filter(ForumThread.origin == origin)
    threads = {t.id: t for t in threads_q.all()}

    key = _sort_key(sort)
    grouped: dict[int, list[ForumLink]] = {}
    for link in links:
        if link.thread_id in threads:
            grouped.setdefault(link.thread_id, []).append(link)

    payload = []
    for tid, rows in grouped.items():
        rows.sort(key=key, reverse=True)
        payload.append(_serialize_thread(threads[tid], rows[:limit_per_thread]))

    if sort in ("size", "duration", "quality"):
        # Thread order follows its strongest card, so the heaviest scenes float up.
        best = {tid: key(rows[0]) for tid, rows in grouped.items() if rows}
        payload.sort(key=lambda t: best.get(t["id"], 0), reverse=True)
    else:
        payload.sort(key=lambda t: (t["last_post_at"] or ""), reverse=(sort != "oldest"))

    all_rows = [link for rows in grouped.values() for link in rows]
    counts = {
        "dead": sum(1 for l in all_rows if l.status == "dead"),
        "new": sum(1 for l in all_rows if l.status == "new"),
        "resolved": sum(1 for l in all_rows if l.status == "resolved"),
        "imported": sum(1 for l in all_rows if l.status == "imported"),
        "dismissed": sum(1 for l in all_rows if l.status == "dismissed"),
    }
    return {
        "threads": payload,
        "total_links": len(all_rows),
        "counts": counts,
    }


@router.get("/summary")
def forum_summary(board: str = "simpcity", db: Session = Depends(get_db)):
    """Counts and latest successful thread checks for honest empty/sync states."""
    get_board(board)
    rows = (
        db.query(ForumLink.status, func.count(ForumLink.id))
        .join(ForumThread, ForumThread.id == ForumLink.thread_id)
        .filter(ForumThread.board == board)
        .group_by(ForumLink.status)
        .all()
    )
    latest = (
        db.query(func.max(ForumThread.last_checked_at))
        .filter(ForumThread.board == board)
        .scalar()
    )
    return {
        "board": board,
        "counts": {status: count for status, count in rows},
        "total_links": sum(count for _, count in rows),
        "thread_count": db.query(ForumThread).filter(ForumThread.board == board).count(),
        "last_checked_at": latest.isoformat() if latest else None,
    }


@router.get("/threads")
def list_threads(board: str = "", db: Session = Depends(get_db)):
    query = db.query(ForumThread)
    if board:
        query = query.filter(ForumThread.board == board)
    threads = query.order_by(ForumThread.last_post_at.desc().nullslast()).all()
    return {
        "threads": [{
            "id": t.id,
            "board": t.board,
            "title": t.title,
            "url": t.url,
            "origin": t.origin,
            "discovered_via": t.discovered_via,
            "new_count": db.query(ForumLink).filter(
                ForumLink.thread_id == t.id, ForumLink.status == "new"
            ).count(),
            "last_post_at": t.last_post_at.isoformat() if t.last_post_at else None,
        } for t in threads]
    }


@router.post("/threads/{thread_id}/seen")
def mark_thread_seen(thread_id: int, db: Session = Depends(get_db)):
    thread = db.query(ForumThread).filter(ForumThread.id == thread_id).first()
    if not thread:
        raise HTTPException(404, detail="Thread not found")
    updated = (
        db.query(ForumLink)
        .filter(ForumLink.thread_id == thread_id, ForumLink.status == "new")
        .update({ForumLink.status: "dismissed"}, synchronize_session=False)
    )
    thread.unread_count = 0
    db.commit()
    return {"success": True, "dismissed": updated}


# ─── refresh & discover ───────────────────────────────────────────────────────

@router.post("/refresh/jobs", status_code=202)
async def start_refresh(
    request: RefreshRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    boards = list(dict.fromkeys(request.boards or ["simpcity"]))
    try:
        for board in boards:
            get_board(board)
    except KeyError as exc:
        raise HTTPException(400, detail=str(exc))

    _prune_refresh_jobs(db)
    active_jobs = db.query(ForumSyncJob).filter(
        ForumSyncJob.status.in_(("queued", "running")),
    ).all()
    active_boards = {
        board
        for job in active_jobs
        for board in job.boards or []
    }
    busy = sorted(active_boards.intersection(boards))
    if busy:
        raise HTTPException(409, detail=f"Refresh už beží pre: {', '.join(busy)}.")
    job_id = uuid4().hex
    now = utcnow()
    db.add(ForumSyncJob(
        id=job_id,
        boards=boards,
        unread_only=request.unread_only,
        status="queued",
        progress={"message": "Čaká sa na synchronizáciu.", "completed": 0, "total": 0},
        created_at=now,
        updated_at=now,
    ))
    db.commit()
    background_tasks.add_task(_run_refresh_job, job_id, boards, request.unread_only)
    return {"job_id": job_id, "status": "queued"}


@router.get("/refresh/jobs/{job_id}")
def refresh_job_status(job_id: str, db: Session = Depends(get_db)):
    job = db.get(ForumSyncJob, job_id)
    if job is None:
        raise HTTPException(404, detail="Refresh job not found or expired.")
    if job.status in {"queued", "running"} and job.updated_at < utcnow() - timedelta(minutes=30):
        job.status = "failed"
        job.error = "Refresh prestal hlásiť priebeh; spusti ho znova."
        job.completed_at = utcnow()
        job.updated_at = job.completed_at
        db.commit()
    return {
        "job_id": job.id,
        "boards": job.boards or [],
        "unread_only": bool(job.unread_only),
        "status": job.status,
        "progress": job.progress or {},
        "result": job.result,
        "error": job.error or "",
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
    }


@router.post("/refresh")
async def refresh(request: RefreshRequest, db: Session = Depends(get_db)):
    try:
        return await service.refresh_all(db, request.boards, unread_only=request.unread_only)
    except ForumAuthError as exc:
        raise HTTPException(401, detail=str(exc))
    except ForumChallengeError as exc:
        raise HTTPException(503, detail=str(exc))
    except ForumRateLimitError as exc:
        raise HTTPException(429, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("[ForumHub] refresh failed")
        raise HTTPException(502, detail=f"Refresh failed: {exc}")


@router.post("/discover")
async def discover(request: DiscoverRequest, db: Session = Depends(get_db)):
    if not request.tags:
        raise HTTPException(400, detail="Select at least one tag.")
    try:
        get_board(request.board)
    except KeyError as exc:
        raise HTTPException(400, detail=str(exc))

    try:
        return await service.discover_by_tags(
            db, request.board, request.tags,
            window_days=request.window_days,
            platforms=request.platforms or None,
        )
    except ForumAuthError as exc:
        raise HTTPException(401, detail=str(exc))
    except ForumChallengeError as exc:
        raise HTTPException(503, detail=str(exc))
    except ForumRateLimitError as exc:
        raise HTTPException(429, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        # A tag page that doesn't exist 404s; that's a typo, not a server fault.
        if "HTTP 404" in str(exc):
            raise HTTPException(404, detail=f"Tag '{', '.join(request.tags)}' na tomto fóre neexistuje.")
        logger.exception("[ForumHub] discover failed")
        raise HTTPException(502, detail=f"Tag discovery failed: {exc}")


@router.post("/groups/discover")
async def discover_groups(request: GroupDiscoverRequest, db: Session = Depends(get_db)):
    """Discover several named tag groups in one call, each an OR of its own tags.

    Built for a curated grid (e.g. "deepthroat" / "fake tits" / "bimbo") where
    each group is really one-or-more single-tag lookups merged, not a single
    AND query — see `TagGroup.tags`.
    """
    if not request.groups:
        raise HTTPException(400, detail="Select at least one group.")
    try:
        get_board(request.board)
    except KeyError as exc:
        raise HTTPException(400, detail=str(exc))

    results = []
    for group in request.groups:
        tags = [t.strip().lower() for t in group.tags if t and t.strip()]
        if not tags:
            results.append({"name": group.name, "tags": [], "new_links": 0, "errors": ["no tags"]})
            continue
        merged = {"threads_matched": 0, "threads_scanned": 0, "threads_with_links": 0,
                   "new_links": 0, "errors": []}
        for tag in tags:
            try:
                r = await service.discover_by_tags(
                    db, request.board, [tag],
                    window_days=request.window_days,
                    platforms=None,
                    discovered_via=f"group:{group.name}",
                    # The tag listing sorts by activity, not upload date, so a
                    # quiet thread with one fresh post can sit past page 1 —
                    # walk a few pages so "last month" isn't capped at whatever
                    # 20 threads happen to be most-active right now.
                    tag_pages=3,
                )
                merged["threads_matched"] += r["threads_matched"]
                merged["threads_scanned"] += r["threads_scanned"]
                merged["threads_with_links"] += r["threads_with_links"]
                merged["new_links"] += r["new_links"]
                merged["errors"].extend(r["errors"])
            except ForumAuthError as exc:
                raise HTTPException(401, detail=str(exc))
            except ForumChallengeError as exc:
                raise HTTPException(503, detail=str(exc))
            except ForumRateLimitError as exc:
                merged["errors"].append(f"{tag}: {exc}")
                break
            except Exception as exc:  # noqa: BLE001
                merged["errors"].append(f"{tag}: {exc}")
        results.append({"name": group.name, "tags": tags, **merged})

    return {"board": request.board, "groups": results}


def _post_hashtag_hit(link: ForumLink, post_by_id: dict[int, ForumPost], words: list[str]) -> bool:
    """Does this link's own post actually mention one of `words`?

    A thread's tag ("big-tits") describes the model discussed there, not every
    scene anyone ever posted in it — checking the post is what lets a
    deepthroat clip surface even in a thread the tag system never labelled
    "deepthroat" at all. Hashtags/title alone miss most of it: a poster far
    more often writes "Sloppy Blowjob" or "Artful Sloppy Head" in plain prose
    than as a #hashtag, so body_text has to be in the haystack too — a scene
    description naming the act is exactly the signal this filter exists for.
    """
    haystack: list[str] = list(link.tags or [])
    post = post_by_id.get(link.post_id)
    if post:
        if post.hashtags:
            haystack.extend(post.hashtags)
        if post.body_text:
            haystack.append(post.body_text)
    haystack.append(link.title or "")
    blob = " ".join(haystack).lower()
    return any(w in blob for w in words)


@router.get("/groups/feed")
def groups_feed(
    board: str = "simpcity",
    content_filters: str = Query("", description='JSON {"group_name": ["word", ...]}'),
    window_days: int = Query(30, ge=0, description="0 = no date limit"),
    db: Session = Depends(get_db),
):
    """Video-only cards for every thread discovered via a `group:*` tag query,
    bucketed by the group that surfaced them (a thread can appear in more than
    one group if its tags overlap).

    `content_filters` narrows a group past "thread carries this tag" down to
    "this specific post/link mentions one of these words" — see TagGroup.content_filter.

    The DB accumulates every link a discover run ever found (nothing is ever
    pruned), so without a date filter here "last month's tag" quietly serves
    up everything back to whenever discovery first ran — `window_days` is what
    actually keeps the grid meaning "posledný mesiac" on every later visit,
    not just on the run that first populated it.
    """
    import json as _json
    try:
        filters: dict[str, list[str]] = _json.loads(content_filters) if content_filters else {}
    except Exception:  # noqa: BLE001
        filters = {}

    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=window_days) if window_days > 0 else None

    tag_discovered = (
        db.query(ForumThread)
        # discovered_via can accumulate other labels before this one
        # ("deepthroat, facefuck, group:deepthroat" — a bare tag name from an
        # older non-group discover call, followed by this one) so the marker
        # can land anywhere in the string, not just at the start.
        .filter(ForumThread.board == board, ForumThread.discovered_via.like("%group:%"))
        .all()
    )
    # A group with a content_filter checks the POST, not the thread's tag, so
    # it's safe (and the whole point) to widen its thread pool past "tagged
    # big-tits/fake-tits/…" to every watched thread too — a deepthroat clip
    # can live in a thread the tag system filed under something unrelated,
    # and a watched thread never even goes through tag discovery otherwise.
    filtered_group_names = {name for name, words in filters.items() if words}
    watched = (
        db.query(ForumThread)
        .filter(ForumThread.board == board, ForumThread.origin == "watched")
        .all()
        if filtered_group_names else []
    )

    by_group: dict[str, list[dict[str, Any]]] = {}
    seen_thread_ids: set[int] = set()
    for thread in tag_discovered:
        seen_thread_ids.add(thread.id)
        # discovered_via accumulates as "group:a, group:b" when a thread's tags
        # match more than one group — surface it under every one, not just the
        # first (a naive split(", ")[-1] would silently drop it from group "a").
        group_names = [
            v.strip()[len("group:"):] for v in (thread.discovered_via or "").split(",")
            if v.strip().startswith("group:")
        ]
        if not group_names:
            continue
        link_q = (
            db.query(ForumLink)
            .filter(ForumLink.thread_id == thread.id, ForumLink.link_type == "video")
            .filter(ForumLink.status.in_(("new", "resolved")))
        )
        if since is not None:
            link_q = link_q.filter(ForumLink.posted_at.is_(None) | (ForumLink.posted_at >= since))
        links = link_q.order_by(ForumLink.posted_at.desc()).all()
        if not links:
            continue
        # ForumLink.url is the *media* link (bunkr/filester/...); the thread it
        # was posted in — and the exact post, when we still have it — is what
        # lets a user go back to the source discussion, not just the file.
        post_ids = {l.post_id for l in links if l.post_id}
        posts_by_id = {
            p.id: p for p in db.query(ForumPost).filter(ForumPost.id.in_(post_ids)).all()
        } if post_ids else {}
        permalinks = {pid: p.permalink for pid, p in posts_by_id.items()}
        serialized = []
        for l in links:
            row = _serialize_link(l)
            row["thread_title"] = thread.title
            row["thread_url"] = thread.url
            row["post_url"] = permalinks.get(l.post_id) or thread.url
            serialized.append((l, row))
        for group_name in group_names:
            words = filters.get(group_name)
            for link, row in serialized:
                if words and not _post_hashtag_hit(link, posts_by_id, words):
                    continue
                by_group.setdefault(group_name, []).append(row)

    for thread in watched:
        if thread.id in seen_thread_ids:
            continue  # already covered as a tag-discovered thread above
        link_q = (
            db.query(ForumLink)
            .filter(ForumLink.thread_id == thread.id, ForumLink.link_type == "video")
            .filter(ForumLink.status.in_(("new", "resolved")))
        )
        if since is not None:
            link_q = link_q.filter(ForumLink.posted_at.is_(None) | (ForumLink.posted_at >= since))
        links = link_q.order_by(ForumLink.posted_at.desc()).all()
        if not links:
            continue
        post_ids = {l.post_id for l in links if l.post_id}
        posts_by_id = {
            p.id: p for p in db.query(ForumPost).filter(ForumPost.id.in_(post_ids)).all()
        } if post_ids else {}
        permalinks = {pid: p.permalink for pid, p in posts_by_id.items()}
        for group_name in filtered_group_names:
            words = filters[group_name]
            for l in links:
                if not _post_hashtag_hit(l, posts_by_id, words):
                    continue
                row = _serialize_link(l)
                row["thread_title"] = thread.title
                row["thread_url"] = thread.url
                row["post_url"] = permalinks.get(l.post_id) or thread.url
                by_group.setdefault(group_name, []).append(row)

    return {"groups": [{"name": name, "links": links} for name, links in by_group.items()]}


# ─── V2: one merged "what's new" feed ─────────────────────────────────────────
#
# The grouped feed above answers "show me group X". In practice the question is
# almost always "what's new that I'd care about" — and the grouped view answers
# that badly: it hides everything that doesn't match one of the hand-written tag
# sets (measured live: 236 fresh videos in the last month, of which the groups
# surfaced ~87), and it makes you click through tabs to find out. V2 inverts it:
# one date-sorted feed of everything recent, with each card *labelled* by the
# topics it hits, so the topics become a lens on the feed instead of a gate in
# front of it.

#: name -> words that mark a video as belonging to that topic. Server-side so
#: the labels on a card and any filtering agree by construction; the client
#: renders whatever this returns instead of keeping its own copy.
#: Words are matched against post text, the link title, the thread's own tags
#: AND its `discovered_via` marker — which spells tags with hyphens
#: ("group:fake-tits"), so every multi-word entry needs its hyphenated twin or
#: it silently misses the thread-level signal entirely (measured live: without
#: "fake-tits" the topic found 3 videos instead of 56).
TOPICS: dict[str, list[str]] = {
    "deepthroat": [
        "deepthroat", "deep throat", "throat", "facefuck", "face fuck",
        "sloppy blowjob", "sloppy bj", "pov blowjob", "bbc blowjob", "bbc sucking",
    ],
    "fake tits": [
        "fake tits", "fake-tits", "fake boobs", "fake-boobs", "faketits",
        "big tits", "big-tits", "bigtits", "busty",
    ],
    "bimbo": ["bimbo", "bimbofication", "barbie"],
    "b/g": ["b/g", " bg ", "boy girl", "boy-girl", "boygirl", "sextape"],
    "anal": ["anal", "buttfuck", "butt fuck", "assfuck"],
    "4k": ["4k", "2160p"],
}


def _topics_for(link: ForumLink, posts_by_id: dict[int, ForumPost],
                thread: Optional[ForumThread] = None) -> list[str]:
    """Topics this video belongs to, from the post AND the thread it lives in.

    Both signals are needed and neither is sufficient: the post text is what
    catches a deepthroat clip in a thread tagged only "onlyfans", while the
    thread's own tags are what keep a "fake tits" model's uploads labelled even
    when the post itself is just a bare filename (most of them are — measured
    live, post-text alone found 3 of the 56 the thread tag knows about).
    """
    thread_blob = " ".join((thread.tags or []) + [thread.discovered_via or ""]).lower() if thread else ""
    return [
        name for name, words in TOPICS.items()
        if _post_hashtag_hit(link, posts_by_id, words)
        or any(w in thread_blob for w in words)
    ]


@router.get("/v2/feed")
def v2_feed(
    board: str = "simpcity",
    window_days: int = Query(30, ge=0, description="0 = no date limit"),
    topic: str = Query("", description="optional single-topic narrowing"),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """Every recent video across watched + tag-discovered threads, newest first.

    Unlike /groups/feed this does not require a video to match a curated tag
    group at all — a fresh upload in a thread you watch is news whether or not
    it happens to carry one of the group tags. Topics come back as labels on
    each card (and as counts), so the client can colour/narrow without a second
    round-trip or a second source of truth for what "deepthroat" means.
    """
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=window_days) if window_days > 0 else None

    get_board(board)
    thread_ids = select(ForumThread.id).where(ForumThread.board == board)
    if not db.execute(thread_ids.limit(1)).first():
        return {"items": [], "topics": {}, "total": 0, "has_more": False, "offset": offset, "next_offset": offset, "page_count": 0}

    link_q = (
        db.query(ForumLink)
        .filter(ForumLink.thread_id.in_(thread_ids))
        .filter(ForumLink.link_type == "video")
        .filter(ForumLink.status.in_(("new", "resolved")))
    )
    if since is not None:
        link_q = link_q.filter(ForumLink.posted_at.is_(None) | (ForumLink.posted_at >= since))
    total = link_q.count()
    page = (
        link_q.order_by(ForumLink.posted_at.desc().nullslast(), ForumLink.id.desc())
        .offset(offset)
        .limit(limit + 1)
        .all()
    )
    has_more = len(page) > limit
    links = page[:limit]
    if not links:
        return {
            "items": [], "topics": {}, "total": total, "has_more": False,
            "offset": offset, "next_offset": offset, "page_count": 0,
        }

    post_ids = {l.post_id for l in links if l.post_id}
    posts_by_id = {
        p.id: p for p in db.query(ForumPost).filter(ForumPost.id.in_(post_ids)).all()
    } if post_ids else {}
    thread_ids_in_page = {l.thread_id for l in links}
    threads_by_id = {
        thread.id: thread for thread in db.query(ForumThread)
        .filter(ForumThread.id.in_(thread_ids_in_page)).all()
    }

    wanted = topic.strip().lower()
    items: list[dict[str, Any]] = []
    topic_counts: dict[str, int] = {name: 0 for name in TOPICS}
    for link in links:
        thread = threads_by_id.get(link.thread_id)
        topics = _topics_for(link, posts_by_id, thread)
        for name in topics:
            topic_counts[name] += 1
        if wanted and wanted not in topics:
            continue
        row = _serialize_link(link)
        row["topics"] = topics
        row["thread_title"] = thread.title if thread else ""
        row["thread_url"] = thread.url if thread else ""
        post = posts_by_id.get(link.post_id)
        row["post_url"] = (post.permalink if post else "") or (thread.url if thread else "")
        row["watched"] = bool(thread and thread.origin == "watched")
        items.append(row)

    return {
        "items": items,
        "topics": topic_counts,
        "total": total,
        "filtered_total": len(items) if offset == 0 and not has_more else None,
        "has_more": has_more,
        "offset": offset,
        "page_count": len(links),
        "next_offset": offset + len(links),
    }


# ─── saved tag channels ───────────────────────────────────────────────────────

@router.get("/queries")
def list_queries(db: Session = Depends(get_db)):
    rows = db.query(ForumSavedQuery).order_by(ForumSavedQuery.created_at.desc()).all()
    return {"queries": [{
        "id": r.id,
        "name": r.name,
        "board": r.board,
        "tags": r.tags or [],
        "window_days": r.window_days,
        "platforms": r.platforms or [],
        "last_run_at": r.last_run_at.isoformat() if r.last_run_at else None,
    } for r in rows]}


@router.post("/queries")
def create_query(payload: SavedQueryPayload, db: Session = Depends(get_db)):
    if not payload.tags:
        raise HTTPException(400, detail="A saved channel needs at least one tag.")
    row = ForumSavedQuery(
        name=payload.name or " + ".join(payload.tags),
        board=payload.board,
        tags=[t.strip().lower() for t in payload.tags],
        window_days=payload.window_days,
        platforms=payload.platforms,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"success": True, "id": row.id}


@router.delete("/queries/{query_id}")
def delete_query(query_id: int, db: Session = Depends(get_db)):
    row = db.query(ForumSavedQuery).filter(ForumSavedQuery.id == query_id).first()
    if not row:
        raise HTTPException(404, detail="Saved channel not found")
    db.delete(row)
    db.commit()
    return {"success": True}


# ─── link actions ─────────────────────────────────────────────────────────────

def _is_placeholder_title(link: ForumLink) -> bool:
    """Titles the parser invented because the post said nothing useful."""
    return link.title in ("", f"{link.platform.capitalize()} {link.link_type}")


# Probe failures (timeouts, rate-limits, Filester cookie storms) are not proof
# the file is gone. Only host answers that explicitly say 404/deleted may flip
# a card to `dead` — otherwise Overiť permanently greys out live videos.
_CONFIRMED_DEAD_RE = re.compile(
    r"(?:^|\b)(?:HTTP\s*)?404\b"
    r"|not found"
    r"|no longer (?:available|exists)"
    r"|(?:file|link|video|album)\s+(?:has been\s+)?(?:deleted|removed)"
    r"|does not exist",
    re.I,
)


def _is_confirmed_dead(meta: Any) -> bool:
    if not isinstance(meta, dict) or meta.get("ok"):
        return False
    return bool(_CONFIRMED_DEAD_RE.search(str(meta.get("error") or "")))


def _apply_resolve_meta(link: ForumLink, meta: Any) -> dict[str, Any]:
    """Write one probe result onto a ForumLink. Transient fails leave status as-is."""
    if isinstance(meta, Exception) or not isinstance(meta, dict) or not meta.get("ok"):
        if isinstance(meta, Exception):
            reason = str(meta) or type(meta).__name__
        else:
            reason = str((meta or {}).get("error") or "overenie zlyhalo")
        if _is_confirmed_dead(meta):
            link.status = "dead"
        elif link.status == "dead":
            # An earlier burst marked this dead without proof. Don't keep it grey
            # just because this attempt also failed to reach the host.
            link.status = "new"
        return {**_serialize_link(link), "message": reason}

    link.resolved_payload = meta
    link.resolved_at = datetime.now(timezone.utc).replace(tzinfo=None)
    if link.status in ("new", "dead"):
        link.status = "resolved"

    link.quality = meta.get("quality") or link.quality
    link.duration = int(meta.get("duration") or link.duration or 0)
    link.size_bytes = int(meta.get("size_bytes") or link.size_bytes or 0)
    if meta.get("thumbnail"):
        link.thumbnail = meta["thumbnail"]
    title = (meta.get("title") or "").strip()
    if title and title != "Bez názvu" and _is_placeholder_title(link):
        link.title = title

    return {**_serialize_link(link), "message": ""}


def _quality_from_height(height: int) -> str:
    if height >= 2160:
        return "4K"
    if height >= 1080:
        return "1080p"
    if height >= 720:
        return "720p"
    if height >= 480:
        return "480p"
    return f"{height}p" if height > 0 else ""


async def _backfill_from_mp4(meta: dict, client) -> dict:
    """Some hosts (Filester) report size but never duration or resolution.

    Their stream is a plain MP4, so a Range-read of the `moov` atom fills both for
    a few hundred KB. Only runs when the meta pass left a gap.
    """
    from .link_tester import _probe_mp4_http

    stream = (meta.get("stream_url") or "").strip()
    size = int(meta.get("size_bytes") or 0)
    if not stream or size <= 0:
        return meta
    if meta.get("duration") and meta.get("height"):
        return meta
    if ".m3u8" in stream.lower():
        return meta

    referer = f"{urlparse(stream).scheme}://{urlparse(stream).netloc}/"
    try:
        probed = await _probe_mp4_http(client, stream, size, referer)
    except Exception:  # noqa: BLE001 — a missing duration must never fail a resolve
        return meta

    if probed.get("duration") and not meta.get("duration"):
        meta["duration"] = probed["duration"]
    if probed.get("height") and not meta.get("height"):
        meta["height"] = probed["height"]
        meta["width"] = probed.get("width") or meta.get("width") or 0
    if not meta.get("quality"):
        meta["quality"] = _quality_from_height(int(meta.get("height") or 0))
    return meta


@router.post("/links/resolve")
async def resolve_links(request: LinkIdsRequest, db: Session = Depends(get_db)):
    """Fill in real size / duration / quality / thumbnail, and a playable stream.

    Uses the tester's `_fetch_any_meta` rather than `resolve_single_url`: the latter
    only yields a stream URL, while the former runs the per-host meta fetchers
    (Bunkr mp4 moov probe, Filester/Cyberdrop APIs, HLS segment sum) that actually
    know the file size and duration.
    """
    import httpx

    from .link_tester import _fetch_any_meta

    if not request.link_ids:
        raise HTTPException(400, detail="No links selected.")

    links = db.query(ForumLink).filter(ForumLink.id.in_(request.link_ids)).all()
    if not links:
        raise HTTPException(404, detail="No matching links.")

    semaphore = asyncio.Semaphore(24)
    bunkr_semaphore = asyncio.Semaphore(6)  # Bunkr is rate-sensitive
    filester_semaphore = asyncio.Semaphore(3)  # Filester drops /d/ pages when hammered

    async def _one(url: str, client) -> dict:
        meta = await _fetch_any_meta(
            url, client, semaphore, bunkr_semaphore,
            filester_semaphore=filester_semaphore,
        )
        if isinstance(meta, dict) and meta.get("ok"):
            meta = await _backfill_from_mp4(meta, client)
        return meta

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(20.0, connect=8.0),
        follow_redirects=True,
        verify=False,
        limits=httpx.Limits(max_connections=40, max_keepalive_connections=30),
    ) as client:
        results = await asyncio.gather(
            *(_one(link.url, client) for link in links),
            return_exceptions=True,
        )

    out = []
    for link, meta in zip(links, results):
        out.append(_apply_resolve_meta(link, meta))

    db.commit()
    return {"results": out}


@router.post("/links/import")
def import_links(request: ImportRequest, db: Session = Depends(get_db)):
    """Explicit hand-off to the intake worker — the only path that downloads."""
    if not request.link_ids:
        raise HTTPException(400, detail="No links selected.")

    links = db.query(ForumLink).filter(ForumLink.id.in_(request.link_ids)).all()
    if not links:
        raise HTTPException(404, detail="No matching links.")

    threads = {t.id: t for t in db.query(ForumThread).filter(
        ForumThread.id.in_({l.thread_id for l in links})
    ).all()}

    candidates = []
    for link in links:
        payload = link.resolved_payload or {}
        thread = threads.get(link.thread_id)
        post = db.query(ForumPost).filter(ForumPost.id == link.post_id).first()
        candidates.append(IntakeCandidate(
            title=link.title or "Queued...",
            url=link.url,
            source_url=link.url,
            thumbnail=link.thumbnail or "",
            duration=float(link.duration or 0),
            width=int(payload.get("width") or 0),
            height=int(payload.get("height") or 0),
            file_size_mb=round((link.size_bytes or 0) / (1024 * 1024), 1),
            tags=list(link.tags or []),
            source=link.platform,
            confidence=0.9 if link.resolved_payload else 0.6,
            warnings=["forum_hub", f"forum_link_id:{link.id}",
                      f"forum_context:{post.permalink if post else (thread.url if thread else '')}"],
        ))

    batch = request.batch_name or (
        f"Forum - {threads[links[0].thread_id].title}" if links[0].thread_id in threads else "Forum Hub"
    )
    job = create_import_job(IntakeImportRequest(
        candidates=candidates,
        batch_name=batch,
        source_mode="mixed",
        auto_metadata=True,
        playwright_fallback=True,
    ), db)

    for link in links:
        link.status = "imported"
    db.commit()
    intake_worker.start()
    return {"success": True, "imported": len(candidates), "job": serialize_job(job)}


@router.post("/links/dismiss")
def dismiss_links(request: LinkIdsRequest, db: Session = Depends(get_db)):
    """Hide from the default feed but keep the row, so a refresh won't re-add it."""
    if not request.link_ids:
        raise HTTPException(400, detail="No links selected.")
    updated = (
        db.query(ForumLink)
        .filter(ForumLink.id.in_(request.link_ids))
        .update({ForumLink.status: "dismissed"}, synchronize_session=False)
    )
    db.commit()
    return {"success": True, "dismissed": updated}


@router.post("/links/delete")
def delete_links(request: LinkIdsRequest, db: Session = Depends(get_db)):
    """Drop the rows entirely.

    A refresh won't resurrect them: the thread's `last_seen_post_id` has already
    moved past the posts they came from, so those posts are never re-parsed.
    """
    if not request.link_ids:
        raise HTTPException(400, detail="No links selected.")
    deleted = (
        db.query(ForumLink)
        .filter(ForumLink.id.in_(request.link_ids))
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"success": True, "deleted": deleted}


_PURGEABLE_STATUSES = frozenset({"dead", "imported", "dismissed"})


def _purgeable_or_400(status: str) -> str:
    key = (status or "").strip().lower()
    if key not in _PURGEABLE_STATUSES:
        raise HTTPException(
            400,
            detail="Hromadne zmazať sa dajú len mŕtve, importované alebo skryté odkazy.",
        )
    return key


def _link_ids_for_status(
    db: Session, *, status: str, board: str = "", origin: str = "",
) -> list[int]:
    query = db.query(ForumLink.id).filter(ForumLink.status == status)
    if board or origin:
        query = query.join(ForumThread, ForumLink.thread_id == ForumThread.id)
        if board:
            query = query.filter(ForumThread.board == board)
        if origin:
            query = query.filter(ForumThread.origin == origin)
    return [row[0] for row in query.all()]


@router.post("/links/purge")
def purge_links(request: PurgeRequest, db: Session = Depends(get_db)):
    """Delete every card of one status in the current board/mode.

    Selecting thread-by-thread cannot reach cards past the 24-per-thread feed cap.
    """
    status = _purgeable_or_400(request.status)
    ids = _link_ids_for_status(db, status=status, board=request.board, origin=request.origin)
    if not ids:
        return {"success": True, "deleted": 0}
    deleted = (
        db.query(ForumLink)
        .filter(ForumLink.id.in_(ids))
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"success": True, "deleted": deleted}
