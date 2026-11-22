"""
Nexus Studio API — the moment layer's HTTP surface.

Rows live here, bytes live in app/studio.py. Everything is namespaced under
/studio/… and mounted on both /api/v1 and /api like the other modular routers.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from .. import studio as studio_svc
from .. import studio_auto, studio_taste
from ..database import Moment, StudioScan, Video, get_db

logger = logging.getLogger(__name__)
router = APIRouter(tags=["studio"])

#: A moment shorter than this is almost always a misclick on the filmstrip.
MIN_MOMENT_SEC = 1.5
#: Above this a "moment" is just the video again — Studio's whole point is the slice.
MAX_MOMENT_SEC = 15 * 60
#: 12 hours. Anything longer in Video.duration is corrupt data, not a long film.
MAX_PLAUSIBLE_DURATION = 12 * 3600


# ------------------------------------------------------------------ serializers

def _split_tags(raw: str) -> list[str]:
    return [t.strip() for t in (raw or "").replace("|", ",").split(",") if t.strip()]


def _video_play_url(video: Optional[Video]) -> str:
    if not video:
        return ""
    return studio_svc.resolve_media(video).play_url


def _moment_dict(m: Moment, video: Optional[Video] = None) -> dict:
    length = max(0.0, (m.end_sec or 0) - (m.start_sec or 0))
    return {
        "id": m.id,
        "video_id": m.video_id,
        "source": m.source or "",
        "origin": m.origin or "manual",
        "status": m.status or "kept",
        "title": m.title or "",
        "start_sec": round(m.start_sec or 0, 2),
        "end_sec": round(m.end_sec or 0, 2),
        "length_sec": round(length, 2),
        "tags": _split_tags(m.tags),
        "collection": m.collection or "",
        "is_favorite": bool(m.is_favorite),
        "heat": int(m.heat or 0),
        "thumb": m.thumb_path or m.thumb_url or "",
        "clip": m.clip_path or "",
        "clip_status": m.clip_status or "",
        "clip_error": m.clip_error or "",
        "clip_size_mb": round(m.clip_size_mb or 0, 2),
        "play_count": int(m.play_count or 0),
        "parent_title": m.parent_title or (video.title if video else ""),
        "parent_source": m.parent_source or "",
        # The wall plays the parent and seeks; only an exported moment has bytes
        # of its own. A hub moment has neither a library file nor a storable CDN
        # URL, so it gets a stable route that re-resolves the stream on demand.
        "play_url": (m.clip_path
                     or (f"/api/v1/studio/moments/{m.id}/stream" if m.source
                         else _video_play_url(video))),
        "seek": not bool(m.clip_path),
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _hydrate(db: Session, moments: list[Moment]) -> list[dict]:
    """Serialize a batch with one videos query instead of one per row."""
    ids = {m.video_id for m in moments if m.video_id}
    parents = {}
    if ids:
        parents = {v.id: v for v in db.query(Video).filter(Video.id.in_(ids)).all()}
    return [_moment_dict(m, parents.get(m.video_id)) for m in moments]


# ------------------------------------------------------------------------- read

def _kept(query):
    """Every listing surface means kept moments; proposals are a separate screen."""
    return query.filter(Moment.status == "kept")


@router.get("/studio/overview")
def studio_overview(db: Session = Depends(get_db)):
    """Header numbers, collection chips and the tag cloud, in one round trip."""
    base = _kept(db.query(func.count(Moment.id)))
    total = base.scalar() or 0
    favs = base.filter(Moment.is_favorite.is_(True)).scalar() or 0
    seconds = (_kept(db.query(func.sum(Moment.end_sec - Moment.start_sec))).scalar() or 0)
    exported = base.filter(Moment.clip_status == "ready").scalar() or 0
    sliced_videos = _kept(db.query(func.count(func.distinct(Moment.video_id)))).scalar() or 0
    proposed = (db.query(func.count(Moment.id))
                .filter(Moment.status == "proposed").scalar() or 0)
    from_hubs = base.filter(Moment.source != "").scalar() or 0

    collections: dict[str, int] = {}
    tags: dict[str, int] = {}
    for coll, tag_str in _kept(db.query(Moment.collection, Moment.tags)).all():
        if coll:
            collections[coll] = collections.get(coll, 0) + 1
        for t in _split_tags(tag_str):
            tags[t] = tags.get(t, 0) + 1

    return {
        "proposed": proposed,
        "from_hubs": from_hubs,
        "total": total,
        "favorites": favs,
        "exported": exported,
        "sliced_videos": sliced_videos,
        "total_minutes": round(float(seconds) / 60, 1),
        "collections": sorted(({"name": k, "count": v} for k, v in collections.items()),
                              key=lambda r: -r["count"]),
        "tags": sorted(({"name": k, "count": v} for k, v in tags.items()),
                       key=lambda r: -r["count"])[:40],
        "library_videos": db.query(func.count(Video.id)).scalar() or 0,
    }


@router.get("/studio/moments")
def list_moments(
    q: str = "",
    collection: str = "",
    tag: str = "",
    video_id: int = 0,
    source: str = "",
    favorites_only: bool = False,
    min_heat: int = 0,
    status: str = "kept",
    sort: str = "recent",
    limit: int = Query(120, le=500),
    offset: int = 0,
    db: Session = Depends(get_db),
):
    query = db.query(Moment).filter(Moment.status == (status or "kept"))
    if source:
        query = query.filter(Moment.source == source)
    if q:
        like = f"%{q}%"
        query = query.filter(or_(Moment.title.ilike(like), Moment.tags.ilike(like),
                                 Moment.parent_title.ilike(like)))
    if collection:
        query = query.filter(Moment.collection == collection)
    if tag:
        query = query.filter(Moment.tags.ilike(f"%{tag}%"))
    if video_id:
        query = query.filter(Moment.video_id == video_id)
    if favorites_only:
        query = query.filter(Moment.is_favorite.is_(True))
    if min_heat:
        query = query.filter(Moment.heat >= min_heat)

    total = query.count()
    orders = {
        "recent": Moment.created_at.desc(),
        "oldest": Moment.created_at.asc(),
        "hottest": Moment.heat.desc(),
        "most_played": Moment.play_count.desc(),
        "longest": (Moment.end_sec - Moment.start_sec).desc(),
        "shortest": (Moment.end_sec - Moment.start_sec).asc(),
        "title": Moment.title.asc(),
    }
    query = query.order_by(orders.get(sort, Moment.created_at.desc()))
    rows = query.offset(max(0, offset)).limit(limit).all()
    return {"total": total, "items": _hydrate(db, rows),
            "has_more": offset + len(rows) < total}


@router.get("/studio/moments/{moment_id}")
def get_moment(moment_id: int, db: Session = Depends(get_db)):
    """One row — what the UI polls while an export renders."""
    moment = db.query(Moment).get(moment_id)
    if not moment:
        raise HTTPException(status_code=404, detail="Moment sa nenašiel")
    video = db.query(Video).get(moment.video_id) if moment.video_id else None
    return _moment_dict(moment, video)


@router.get("/studio/moments/{moment_id}/stream")
async def stream_moment(moment_id: int, db: Session = Depends(get_db)):
    """Stable playback URL for a hub moment — resolves the CDN link on demand.

    A hub stream URL is bound to the resolving IP and expires, so it cannot be
    stored in the row and handed to the browser hours later. This route does the
    resolve at play time and redirects to the source's own stream proxy, which
    is where Range requests need to land for seeking to work.
    """
    moment = db.query(Moment).get(moment_id)
    if not moment:
        raise HTTPException(status_code=404, detail="Moment sa nenašiel")
    if moment.clip_path:
        return RedirectResponse(moment.clip_path, status_code=307)
    if not moment.source:
        video = db.query(Video).get(moment.video_id) if moment.video_id else None
        url = _video_play_url(video)
        if not url:
            raise HTTPException(status_code=404, detail="Zdrojové video už nie je dostupné")
        return RedirectResponse(url, status_code=307)

    media = await studio_svc.resolve_hub_media(moment.source, moment.parent_source or "")
    if media.problem or not media.play_url:
        raise HTTPException(status_code=502, detail=media.problem or "Stream sa nepodarilo získať")
    return RedirectResponse(media.play_url, status_code=307)


@router.get("/studio/reel")
def studio_reel(
    q: str = "",
    collection: str = "",
    tag: str = "",
    favorites_only: bool = False,
    min_heat: int = 0,
    shuffle: bool = True,
    limit: int = Query(80, le=300),
    db: Session = Depends(get_db),
):
    """The same filter set as the wall, ordered for back-to-back playback.

    Shuffling happens here rather than in the client so a reel can be longer
    than one page of the wall — the point of the mode is to surface moments you
    had forgotten, and a client-side shuffle can only reorder what's on screen.
    """
    payload = list_moments(q=q, collection=collection, tag=tag, favorites_only=favorites_only,
                           min_heat=min_heat, sort="recent", limit=limit, offset=0, db=db)
    items = payload["items"]
    if shuffle:
        random.shuffle(items)
    return {"items": items, "total": len(items)}


@router.get("/studio/whats-new")
def whats_new(days: int = 14, limit: int = 24, db: Session = Depends(get_db)):
    """Three answers to "what should I open right now?".

    `fresh` — cards that arrived recently. `unsliced` — cards with no moment yet,
    biased to the longest, because a 50-minute file is where slicing pays off
    most and is exactly the file nobody re-opens. `revisit` — moments saved a
    while ago and never played since, which is the closest thing the library has
    to something new that you already know you like.
    """
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=max(1, days))
    fresh = (db.query(Video).filter(Video.created_at >= since, Video.title != "")
             .order_by(Video.created_at.desc()).limit(limit).all())

    sliced_ids = {r[0] for r in db.query(Moment.video_id).distinct().all() if r[0]}
    # A pile of legacy rows carry a timestamp where the duration should be
    # (values in the millions of seconds). Ordering by duration desc without a
    # ceiling puts every one of them at the top, so the "longest unsliced"
    # rail ends up showing nothing but corrupt rows.
    unsliced_q = db.query(Video).filter(Video.title != "", Video.duration > 120,
                                        Video.duration < MAX_PLAUSIBLE_DURATION)
    if sliced_ids:
        unsliced_q = unsliced_q.filter(~Video.id.in_(sliced_ids))
    unsliced = unsliced_q.order_by(Video.duration.desc()).limit(limit).all()

    revisit = (db.query(Moment).filter(Moment.play_count == 0)
               .order_by(Moment.created_at.asc()).limit(limit).all())

    def vid(v: Video) -> dict:
        return {"id": v.id, "title": v.title or "", "thumb": v.thumbnail_path or "",
                "duration": round(v.duration or 0, 1), "quality": v.quality or "",
                "size_mb": round(v.file_size_mb or 0, 1),
                "created_at": v.created_at.isoformat() if v.created_at else None}

    return {"fresh": [vid(v) for v in fresh],
            "unsliced": [vid(v) for v in unsliced],
            "revisit": _hydrate(db, revisit)}


@router.get("/studio/videos")
def studio_videos(q: str = "", limit: int = Query(60, le=200), offset: int = 0,
                  sort: str = "recent", only_sliceable: bool = False,
                  db: Session = Depends(get_db)):
    """Library cards to slice, annotated with how many moments each already has."""
    query = db.query(Video).filter(Video.title != None, Video.title != "")  # noqa: E711
    if q:
        query = query.filter(Video.title.ilike(f"%{q}%"))
    # Corrupt durations sort to the bottom instead of hijacking "longest", but the
    # rows stay in the list — they are still perfectly sliceable.
    sane_duration = case((Video.duration < MAX_PLAUSIBLE_DURATION, Video.duration), else_=0)
    orders = {"recent": Video.created_at.desc(), "longest": sane_duration.desc(),
              "title": Video.title.asc(), "biggest": Video.file_size_mb.desc()}
    total = query.count()
    rows = (query.order_by(orders.get(sort, Video.created_at.desc()))
            .offset(max(0, offset)).limit(limit).all())

    counts = dict(db.query(Moment.video_id, func.count(Moment.id))
                  .group_by(Moment.video_id).all())
    items = []
    for v in rows:
        media = studio_svc.resolve_media(v)
        if only_sliceable and media.problem:
            continue
        items.append({
            "id": v.id, "title": v.title or "", "thumb": v.thumbnail_path or "",
            "duration": round(v.duration or 0, 1), "quality": v.quality or "",
            "size_mb": round(v.file_size_mb or 0, 1),
            "moments": counts.get(v.id, 0),
            "local": media.is_local, "problem": media.problem,
            "play_url": media.play_url,
        })
    return {"total": total, "items": items, "has_more": offset + len(rows) < total}


@router.get("/studio/video/{video_id}")
async def studio_video(video_id: int, db: Session = Depends(get_db)):
    """Everything the cutter needs for one video: playback, duration, strip, moments."""
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video sa nenašlo")
    media = studio_svc.resolve_media(video)
    duration = float(video.duration or 0)
    if duration <= 1 and media.input:
        duration = await studio_svc.probe_duration(media)
    moments = (db.query(Moment).filter(Moment.video_id == video_id)
               .order_by(Moment.start_sec.asc()).all())

    # ffmpeg reads a transport stream fine, so the filmstrip and scene detection
    # are usable immediately; only the preview player needs the MP4, so start
    # that conversion in the background instead of blocking the cutter on it.
    remux = None
    if media.needs_remux:
        from .. import ts_remux
        remux = ts_remux.status(video_id)
        if remux["state"] == "missing":
            asyncio.create_task(ts_remux.ensure_mp4(
                video_id, video.url or "", video.storage_type or "", duration))
            remux = {"state": "working", "percent": 0.0, "url": ""}

    return {
        "id": video.id, "title": video.title or "", "duration": round(duration, 2),
        "thumb": video.thumbnail_path or "", "quality": video.quality or "",
        "play_url": media.play_url, "local": media.is_local, "problem": media.problem,
        "needs_remux": media.needs_remux, "remux": remux,
        "can_detect_scenes": media.is_local,
        "storyboard": studio_svc.storyboard_meta(video_id),
        "suggested_frames": studio_svc.frame_count_for(duration),
        "moments": [_moment_dict(m, video) for m in moments],
    }


@router.get("/studio/hub-video")
async def studio_hub_video(source: str = Query(..., min_length=2),
                           url: str = Query(..., min_length=8),
                           db: Session = Depends(get_db)):
    """The cutter's other entry point: a hub watch URL instead of a library id.

    Same shape as /studio/video/{id} so the frontend renders one cutter for both.
    Nothing is imported and nothing is written — the video stays where it is and
    only the moments you save end up in the database.
    """
    source = (source or "").strip().lower()
    media = await studio_svc.resolve_hub_media(source, url)
    duration = await studio_svc.probe_duration(media) if media.input else 0.0
    key = studio_svc.storyboard_key(source=source, url=url)
    moments = (db.query(Moment)
               .filter(Moment.source == source, Moment.parent_source == url)
               .order_by(Moment.start_sec.asc()).all())
    return {
        "id": 0, "source": source, "url": url,
        "title": _title_from_url(url), "duration": round(duration, 2),
        "thumb": "", "quality": "",
        "play_url": media.play_url, "local": False, "problem": media.problem,
        # Scene detection needs a real file; over a CDN every keyframe is a range
        # request and the pass would outlast anyone's patience.
        "can_detect_scenes": False,
        "storyboard": studio_svc.storyboard_meta(key),
        "storyboard_key": key,
        "suggested_frames": studio_svc.frame_count_for(duration),
        "moments": [_moment_dict(m, None) for m in moments],
    }


def _title_from_url(url: str) -> str:
    """A readable name from a watch URL — hub pages rarely put one in the path,
    but the slug is better than showing the raw URL in the cutter's header."""
    from urllib.parse import urlparse, unquote
    slug = unquote(urlparse(url).path.rstrip("/").rsplit("/", 1)[-1] or "")
    slug = slug.rsplit(".", 1)[0].replace("-", " ").replace("_", " ").strip()
    return slug[:160].title() if len(slug) > 3 else url


@router.get("/studio/storyboard/stream")
async def storyboard_stream(video_id: int = 0, source: str = "", url: str = "",
                            frames: int = 0, rebuild: bool = False,
                            db: Session = Depends(get_db)):
    """NDJSON: one line per filmstrip frame as it is cut, then a `done` line.

    Streamed rather than returned whole because a 60-frame strip over a remote
    source takes tens of seconds — the user watches it fill in instead of
    staring at a spinner with no idea whether it is progressing.

    Accepts either a library id or a hub source+URL; the cache key differs but
    everything downstream is identical.
    """
    if video_id:
        video = db.query(Video).get(video_id)
        if not video:
            raise HTTPException(status_code=404, detail="Video sa nenašlo")
        media = studio_svc.resolve_media(video)
        duration = float(video.duration or 0)
        key = studio_svc.storyboard_key(video_id=video_id)
    elif source and url:
        media = await studio_svc.resolve_hub_media(source.strip().lower(), url)
        duration = 0.0
        key = studio_svc.storyboard_key(source=source.strip().lower(), url=url)
    else:
        raise HTTPException(status_code=400, detail="Chýba video_id alebo source+url")

    if rebuild:
        import shutil as _shutil
        _shutil.rmtree(studio_svc.storyboard_dir(key), ignore_errors=True)

    async def gen():
        cached = None if rebuild else studio_svc.storyboard_meta(key)
        if cached and not frames:
            for f in cached["frames"]:
                yield json.dumps({"type": "frame", "frame": f,
                                  "total": len(cached["frames"])}) + "\n"
            yield json.dumps({"type": "done", "meta": cached, "cached": True}) + "\n"
            return
        try:
            async for ev in studio_svc.build_storyboard(key, media, duration, frames=frames):
                yield json.dumps(ev) + "\n"
        except Exception as exc:  # noqa: BLE001
            logger.exception("studio storyboard failed for %s", key)
            yield json.dumps({"type": "error", "error": str(exc)}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})


@router.get("/studio/scenes")
async def studio_scenes(video_id: int, threshold: float = 0.28,
                        db: Session = Depends(get_db)):
    """Auto-detected cut points for the cutter's "nájdi scény" button."""
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video sa nenašlo")
    media = studio_svc.resolve_media(video)
    if not media.is_local:
        return {"scenes": [], "reason": "Detekcia scén funguje len pri lokálnych súboroch."}
    duration = float(video.duration or 0) or await studio_svc.probe_duration(media)
    scenes = await studio_svc.detect_scenes(media, duration, threshold=threshold)
    return {"scenes": scenes, "duration": round(duration, 2), "reason": ""}


# ------------------------------------------------------------------------ write

class MomentIn(BaseModel):
    #: Exactly one of these identifies the parent: a library id, or a hub
    #: source + watch URL for something that was never imported.
    video_id: int = 0
    source: str = ""
    source_url: str = ""
    start_sec: float = Field(ge=0)
    end_sec: float = Field(gt=0)
    title: str = ""
    tags: str = ""
    collection: str = ""
    heat: int = 0
    is_favorite: bool = False
    #: Tile poster to fall back on when ffmpeg can't reach the hub's stream.
    thumb_url: str = ""


class MomentPatch(BaseModel):
    title: Optional[str] = None
    tags: Optional[str] = None
    collection: Optional[str] = None
    heat: Optional[int] = None
    is_favorite: Optional[bool] = None
    start_sec: Optional[float] = None
    end_sec: Optional[float] = None


def _validate_span(start: float, end: float) -> tuple[float, float]:
    start, end = max(0.0, float(start)), float(end)
    if end - start < MIN_MOMENT_SEC:
        raise HTTPException(status_code=400,
                            detail=f"Moment musí trvať aspoň {MIN_MOMENT_SEC} s.")
    if end - start > MAX_MOMENT_SEC:
        raise HTTPException(status_code=400,
                            detail=f"Moment môže mať najviac {MAX_MOMENT_SEC // 60} minút.")
    return start, end


async def _moment_media(moment: Moment, video: Optional[Video]) -> studio_svc.Media:
    """Where this moment's frames come from, library or hub."""
    if moment.source:
        return await studio_svc.resolve_hub_media(moment.source, moment.parent_source or "")
    if video:
        return studio_svc.resolve_media(video)
    return studio_svc.Media("", "", False, "Zdroj momentu už nie je dostupný.")


async def _make_thumb(moment: Moment, video: Optional[Video]) -> None:
    """Cover frame from the middle of the span. Best-effort: a moment without a
    thumbnail still works, the wall just falls back to the parent's poster."""
    media = await _moment_media(moment, video)
    if not media.input:
        return
    mid = (moment.start_sec + moment.end_sec) / 2
    dest = os.path.join(studio_svc.MOMENT_THUMB_DIR, f"m{moment.id}.jpg")
    if await studio_svc.extract_frame(media, mid, dest):
        moment.thumb_path = f"/static/moments/m{moment.id}.jpg"


@router.post("/studio/moments")
async def create_moment(body: MomentIn, db: Session = Depends(get_db)):
    start, end = _validate_span(body.start_sec, body.end_sec)
    source = (body.source or "").strip().lower()

    video = db.query(Video).get(body.video_id) if body.video_id else None
    if not video and not (source and body.source_url):
        raise HTTPException(status_code=404,
                            detail="Treba buď video z knižnice, alebo zdroj + odkaz.")

    moment = Moment(
        video_id=video.id if video else None,
        source="" if video else source,
        start_sec=start, end_sec=end,
        title=(body.title or (video.title if video else "") or "").strip()[:300],
        tags=body.tags or "", collection=(body.collection or "").strip(),
        heat=max(0, min(3, int(body.heat or 0))), is_favorite=bool(body.is_favorite),
        thumb_url=(body.thumb_url or "")[:600],
        parent_title=(video.title if video else body.title or "")[:300],
        parent_source=((video.source_url or video.url) if video else body.source_url)[:400],
    )
    db.add(moment)
    db.commit()
    db.refresh(moment)

    await _make_thumb(moment, video)
    studio_taste.invalidate()
    db.commit()
    db.refresh(moment)
    return _moment_dict(moment, video)


@router.patch("/studio/moments/{moment_id}")
async def patch_moment(moment_id: int, body: MomentPatch, db: Session = Depends(get_db)):
    moment = db.query(Moment).get(moment_id)
    if not moment:
        raise HTTPException(status_code=404, detail="Moment sa nenašiel")

    span_changed = False
    if body.start_sec is not None or body.end_sec is not None:
        start = moment.start_sec if body.start_sec is None else body.start_sec
        end = moment.end_sec if body.end_sec is None else body.end_sec
        moment.start_sec, moment.end_sec = _validate_span(start, end)
        span_changed = True
    if body.title is not None:
        moment.title = body.title.strip()[:300]
    if body.tags is not None:
        moment.tags = body.tags
    if body.collection is not None:
        moment.collection = body.collection.strip()
    if body.heat is not None:
        moment.heat = max(0, min(3, int(body.heat)))
    if body.is_favorite is not None:
        moment.is_favorite = bool(body.is_favorite)

    video = db.query(Video).get(moment.video_id) if moment.video_id else None
    if span_changed:
        # The old cover frame now points outside the selection — and an exported
        # clip is of the old span, so it stops being this moment's clip.
        await _make_thumb(moment, video)
        if moment.clip_path:
            studio_svc.delete_clip(moment.id)
            moment.clip_path, moment.clip_status, moment.clip_size_mb = None, "", 0
    studio_taste.invalidate()
    db.commit()
    db.refresh(moment)
    return _moment_dict(moment, video)


@router.delete("/studio/moments/{moment_id}")
def delete_moment(moment_id: int, db: Session = Depends(get_db)):
    moment = db.query(Moment).get(moment_id)
    if not moment:
        raise HTTPException(status_code=404, detail="Moment sa nenašiel")
    studio_svc.delete_clip(moment.id)
    db.delete(moment)
    db.commit()
    studio_taste.invalidate()
    return {"ok": True}


@router.post("/studio/moments/{moment_id}/played")
def mark_played(moment_id: int, db: Session = Depends(get_db)):
    moment = db.query(Moment).get(moment_id)
    if not moment:
        raise HTTPException(status_code=404, detail="Moment sa nenašiel")
    moment.play_count = (moment.play_count or 0) + 1
    moment.last_played_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    return {"ok": True, "play_count": moment.play_count}


class ExportBody(BaseModel):
    precise: bool = False


@router.post("/studio/moments/{moment_id}/export")
async def export_moment(moment_id: int, body: ExportBody, db: Session = Depends(get_db)):
    """Render the moment to a real mp4. Runs in the background; poll the moment."""
    moment = db.query(Moment).get(moment_id)
    if not moment:
        raise HTTPException(status_code=404, detail="Moment sa nenašiel")
    if moment.clip_status == "rendering":
        return {"ok": True, "status": "rendering"}
    video = db.query(Video).get(moment.video_id) if moment.video_id else None
    if not video and not moment.source:
        raise HTTPException(status_code=400, detail="Pôvodné video už v knižnici nie je")

    # A hub export re-resolves here, at render time — that link is the shortest-
    # lived thing in the system and must not be older than the ffmpeg call.
    media = await _moment_media(moment, video)
    if media.problem:
        raise HTTPException(status_code=400, detail=media.problem)

    moment.clip_status, moment.clip_error = "rendering", None
    db.commit()

    mid, start, end = moment.id, moment.start_sec, moment.end_sec
    precise = body.precise

    async def render():
        from ..database import SessionLocal
        ok, result, size = await studio_svc.export_clip(mid, media, start, end, precise=precise)
        session = SessionLocal()
        try:
            row = session.query(Moment).get(mid)
            if not row:
                return
            if ok:
                row.clip_path, row.clip_status, row.clip_size_mb = result, "ready", size
                row.clip_error = None
            else:
                row.clip_status, row.clip_error = "error", result[:400]
            session.commit()
        finally:
            session.close()

    asyncio.create_task(render())
    return {"ok": True, "status": "rendering"}


@router.post("/studio/moments/{moment_id}/to-library")
def clip_to_library(moment_id: int, db: Session = Depends(get_db)):
    """Promote an exported clip to a first-class library card.

    Only offered once the clip exists: the library's contract is that a card
    points at playable bytes, and a moment that has never been exported has none.
    """
    moment = db.query(Moment).get(moment_id)
    if not moment:
        raise HTTPException(status_code=404, detail="Moment sa nenašiel")
    if moment.clip_status != "ready" or not moment.clip_path:
        raise HTTPException(status_code=400, detail="Najprv moment vyexportuj (Export mp4).")

    existing = db.query(Video).filter(Video.url == moment.clip_path).first()
    if existing:
        return {"ok": True, "video_id": existing.id, "already": True}

    parent = db.query(Video).get(moment.video_id) if moment.video_id else None
    video = Video(
        title=(moment.title or "Studio klip")[:300],
        url=moment.clip_path,
        source_url=moment.parent_source or (parent.source_url if parent else None),
        thumbnail_path=moment.thumb_path or (parent.thumbnail_path if parent else None),
        duration=max(0.0, (moment.end_sec or 0) - (moment.start_sec or 0)),
        storage_type="local",
        status="ready_to_stream",
        batch_name="Studio klipy",
        tags=moment.tags or "",
        quality=(parent.quality if parent else "") or "",
        width=(parent.width if parent else 0) or 0,
        height=(parent.height if parent else 0) or 0,
        file_size_mb=moment.clip_size_mb or 0,
    )
    db.add(video)
    db.commit()
    db.refresh(video)
    return {"ok": True, "video_id": video.id, "already": False}


class BulkMomentsIn(BaseModel):
    video_id: int
    #: start times; each becomes a moment of `length` seconds
    starts: list[float]
    length: float = 20.0
    collection: str = ""
    tags: str = ""


@router.post("/studio/moments/bulk")
async def create_moments_bulk(body: BulkMomentsIn, db: Session = Depends(get_db)):
    """Turn a set of detected scenes into moments in one go.

    Thumbnails are cut sequentially afterwards rather than per-row inside the
    loop, so a 30-scene batch commits immediately and the covers fill in behind
    it instead of holding the request open for a minute.
    """
    video = db.query(Video).get(body.video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video sa nenašlo")
    length = max(MIN_MOMENT_SEC, min(float(body.length or 20), MAX_MOMENT_SEC))
    duration = float(video.duration or 0)

    created: list[Moment] = []
    for start in sorted({round(float(s), 2) for s in body.starts})[:80]:
        end = start + length
        if duration and end > duration:
            end = duration
        if end - start < MIN_MOMENT_SEC:
            continue
        moment = Moment(video_id=video.id, start_sec=start, end_sec=end,
                        title=(video.title or "")[:300], tags=body.tags or "",
                        collection=(body.collection or "").strip(),
                        parent_title=video.title or "",
                        parent_source=(video.source_url or video.url or "")[:400])
        db.add(moment)
        created.append(moment)
    if not created:
        raise HTTPException(status_code=400, detail="Žiadny z časov nedáva použiteľný moment.")
    db.commit()
    for moment in created:
        db.refresh(moment)
        await _make_thumb(moment, video)
    db.commit()
    studio_taste.invalidate()
    return {"ok": True, "created": len(created),
            "items": [_moment_dict(m, video) for m in created]}


# ------------------------------------------------------- auto-highlight review

@router.get("/studio/proposals")
def list_proposals(limit: int = Query(60, le=200), offset: int = 0,
                   db: Session = Depends(get_db)):
    """The overnight scan's output, oldest first — review it like an inbox.

    Grouped counts come along so the screen can say "12 proposals across 3
    videos" instead of dumping an undifferentiated wall of near-identical frames.
    """
    query = db.query(Moment).filter(Moment.status == "proposed")
    total = query.count()
    rows = (query.order_by(Moment.video_id.asc(), Moment.start_sec.asc())
            .offset(max(0, offset)).limit(limit).all())
    videos = len({m.video_id for m in rows if m.video_id})
    return {"total": total, "videos_in_page": videos,
            "items": _hydrate(db, rows), "has_more": offset + len(rows) < total,
            "status": studio_auto.autoscan_status()}


class ProposalVerdict(BaseModel):
    #: ids to keep; everything listed in `reject` becomes a tombstone
    keep: list[int] = []
    reject: list[int] = []


@router.post("/studio/proposals/verdict")
def proposals_verdict(body: ProposalVerdict, db: Session = Depends(get_db)):
    """Accept and/or reject proposals in one call.

    Rejections are *not* deleted. The row stays with status="rejected" (its
    cover frame is dropped, so it costs a few dozen bytes) purely so tonight's
    scan can see that this span was already offered and turned down.
    """
    kept = rejected = 0
    if body.keep:
        for m in db.query(Moment).filter(Moment.id.in_(body.keep),
                                         Moment.status == "proposed").all():
            m.status = "kept"
            kept += 1
    if body.reject:
        for m in db.query(Moment).filter(Moment.id.in_(body.reject),
                                         Moment.status == "proposed").all():
            m.status = "rejected"
            studio_svc.delete_clip(m.id)
            m.thumb_path, m.clip_path, m.clip_status = None, None, ""
            rejected += 1
    db.commit()
    studio_taste.invalidate()
    remaining = db.query(func.count(Moment.id)).filter(Moment.status == "proposed").scalar() or 0
    return {"ok": True, "kept": kept, "rejected": rejected, "remaining": remaining}


@router.post("/studio/proposals/reject-all")
def proposals_reject_all(video_id: int = 0, db: Session = Depends(get_db)):
    """Clear the inbox (or just one video's worth of it)."""
    query = db.query(Moment).filter(Moment.status == "proposed")
    if video_id:
        query = query.filter(Moment.video_id == video_id)
    n = 0
    for m in query.all():
        m.status = "rejected"
        studio_svc.delete_clip(m.id)
        m.thumb_path = None
        n += 1
    db.commit()
    return {"ok": True, "rejected": n}


class AutoscanBody(BaseModel):
    videos: int = 2
    max_proposals: int = 6


@router.post("/studio/autoscan/run")
async def autoscan_run(body: AutoscanBody):
    """Run the nightly pass now, on a couple of videos, and wait for it.

    Kept small and synchronous on purpose: this is the "show me what it does"
    button, and a background task that finishes silently teaches nobody anything.
    The scheduled 03:20 run is the one that works through the whole library.
    """
    videos = max(1, min(int(body.videos or 1), 5))
    result = await studio_auto.run_autoscan(videos=videos,
                                            max_proposals=max(1, min(body.max_proposals, 12)),
                                            budget_sec=420)
    studio_taste.invalidate()
    result["status"] = studio_auto.autoscan_status()
    return result


@router.get("/studio/autoscan/status")
def autoscan_status():
    return studio_auto.autoscan_status()


@router.post("/studio/autoscan/forget")
def autoscan_forget(db: Session = Depends(get_db)):
    """Wipe the scan log so the next run re-examines everything.

    Rejected moments survive this on purpose — forgetting *which files* were
    scanned is a different thing from forgetting *what you already said no to*.
    """
    n = db.query(StudioScan).delete()
    db.commit()
    return {"ok": True, "forgotten": n}


# --------------------------------------------------------------- taste + daily

@router.get("/studio/taste")
def studio_taste_profile():
    """What your heat ratings say you're into. Derived live, never stored."""
    return studio_taste.get_profile()


@router.get("/studio/daily")
def studio_daily(limit: int = Query(40, le=120), day: str = "",
                 db: Session = Depends(get_db)):
    """Today's reel: your own moments, ordered by affinity with a per-day shuffle."""
    rows = studio_taste.daily_reel(limit=limit, day=day or None)
    profile = studio_taste.get_profile()
    return {"items": _hydrate(db, rows), "total": len(rows),
            "day": day or None, "confident": profile.get("confident", False),
            "terms": [r["name"] for r in profile.get("tags", [])[:6]]
                     or [r["name"] for r in profile.get("terms", [])[:6]]}


@router.get("/studio/taste-picks")
async def studio_taste_picks(per_source: int = 6, sources: int = 5):
    """New material from the hub sources, chosen by the same signal as the reel."""
    return await studio_taste.taste_picks(per_source=max(1, min(per_source, 12)),
                                          sources=max(1, min(sources, 8)))
