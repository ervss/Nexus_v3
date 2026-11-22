"""
Studio auto-highlight — the overnight pass that proposes moments for you.

The Studio cutter is fast, but it still needs you to sit down and drive it, and
the videos that would benefit most are exactly the long ones nobody re-opens.
So once a night this walks the un-scanned local files, runs keyframe scene
detection, and leaves a handful of *proposals* behind: real Moment rows with
`status="proposed"`, invisible to the wall and the reel until you say yes.

Three rules keep it honest:

  * It never keeps anything. A proposal you ignore stays a proposal; a proposal
    you reject stays in the table as a tombstone so tomorrow's run does not put
    the same span back in front of you.
  * It scans each video exactly once (StudioScan), including videos where it
    found nothing. "No cuts detected" is an answer, not a reason to retry
    forever.
  * It works to a wall-clock budget and stops mid-list rather than running into
    the morning — the next run just picks up where this one left off.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone

from sqlalchemy import func, or_

from . import studio as svc
from .database import Moment, SessionLocal, StudioScan, Video

logger = logging.getLogger(__name__)

#: Below this a video has one scene and proposing from it is noise.
MIN_DURATION_SEC = 300
#: Same 12-hour sanity ceiling the router uses — corrupt durations are not films.
MAX_DURATION_SEC = 12 * 3600
#: How long each proposal runs. Long enough to tell what it is, short enough to
#: judge in one breath while reviewing thirty of them.
PROPOSAL_SEC = 18.0
#: A new proposal this close to an existing moment is the same moment.
OVERLAP_GUARD_SEC = 25.0


def _pick_spread(times: list[float], count: int) -> list[float]:
    """`count` timestamps spread across the whole list, not the first `count`.

    Scene detection clusters — a fast-cut opening can produce twenty hits in the
    first two minutes. Taking the head would propose twenty variations of the
    intro and never reach the rest of the video.
    """
    if len(times) <= count:
        return list(times)
    stride = len(times) / count
    return [times[int(i * stride)] for i in range(count)]


async def scan_video(video_id: int, *, max_proposals: int = 6,
                     threshold: float = 0.30) -> dict:
    """Detect cuts in one library video and file proposals. Returns a summary."""
    db = SessionLocal()
    try:
        video = db.query(Video).get(video_id)
        if not video:
            return {"video_id": video_id, "found": 0, "error": "video zmizlo"}
        media = svc.resolve_media(video)
        if not media.is_local:
            return {"video_id": video_id, "found": 0,
                    "error": media.problem or "nie je lokálny súbor"}

        duration = float(video.duration or 0)
        if not (MIN_DURATION_SEC <= duration <= MAX_DURATION_SEC):
            duration = await svc.probe_duration(media)
        if not (MIN_DURATION_SEC <= duration <= MAX_DURATION_SEC):
            return {"video_id": video_id, "found": 0, "error": "nepoužiteľná dĺžka"}

        scenes = await svc.detect_scenes(media, duration, threshold=threshold)
        if not scenes:
            return {"video_id": video_id, "found": 0, "error": "žiadne výrazné strihy"}

        # Every span already known for this video — kept, proposed or rejected —
        # so a rerun cannot re-offer something you already answered.
        taken = [(m.start_sec or 0) for m in
                 db.query(Moment).filter(Moment.video_id == video_id).all()]

        created = []
        for start in _pick_spread(scenes, max_proposals):
            if any(abs(start - t) < OVERLAP_GUARD_SEC for t in taken):
                continue
            end = min(start + PROPOSAL_SEC, duration)
            if end - start < 4:
                continue
            moment = Moment(
                video_id=video.id, start_sec=round(start, 2), end_sec=round(end, 2),
                title=(video.title or "")[:300], origin="auto", status="proposed",
                collection="", parent_title=video.title or "",
                parent_source=(video.source_url or video.url or "")[:400],
            )
            db.add(moment)
            created.append(moment)
            taken.append(start)

        if not created:
            return {"video_id": video_id, "found": 0, "error": "všetko už bolo navrhnuté"}

        db.commit()
        for moment in created:
            db.refresh(moment)
            mid = (moment.start_sec + moment.end_sec) / 2
            dest = os.path.join(svc.MOMENT_THUMB_DIR, f"m{moment.id}.jpg")
            if await svc.extract_frame(media, mid, dest):
                moment.thumb_path = f"/static/moments/m{moment.id}.jpg"
        db.commit()
        return {"video_id": video_id, "found": len(created), "error": None}
    finally:
        db.close()


def _record_scan(video_id: int, found: int, error: str | None) -> None:
    db = SessionLocal()
    try:
        row = db.query(StudioScan).filter(StudioScan.video_id == video_id).first()
        if not row:
            row = StudioScan(video_id=video_id)
            db.add(row)
        row.scanned_at, row.found, row.error = datetime.now(timezone.utc).replace(tzinfo=None), found, (error or None)
        db.commit()
    finally:
        db.close()


def pending_video_ids(limit: int) -> list[int]:
    """Longest never-scanned local videos first — biggest payoff per minute spent.

    Local-ness is a SQL filter, not a post-filter: this library is ~98% remote
    rows, so taking the longest N first and *then* discarding the remote ones
    returned an empty list every time — the top of a duration-sorted library is
    all remote (and corrupt-duration) cards.
    """
    db = SessionLocal()
    try:
        scanned = {r[0] for r in db.query(StudioScan.video_id).all()}
        query = (db.query(Video.id)
                 .filter(Video.title != "",
                         Video.duration >= MIN_DURATION_SEC,
                         Video.duration <= MAX_DURATION_SEC,
                         or_(Video.url.like("file://%"),
                             Video.url.like("/static/%"),
                             Video.storage_type == "local_direct")))
        if scanned:
            query = query.filter(~Video.id.in_(scanned))
        return [r[0] for r in query.order_by(Video.duration.desc()).limit(limit).all()]
    finally:
        db.close()


async def run_autoscan(*, videos: int = 5, max_proposals: int = 6,
                       budget_sec: float = 1500) -> dict:
    """Scan up to `videos` un-scanned files, stopping at `budget_sec`."""
    started = time.monotonic()
    ids = pending_video_ids(videos)
    if not ids:
        logger.info("[studio] autoscan: nothing left to scan")
        return {"scanned": 0, "proposals": 0, "videos": [], "exhausted": True}

    results, total = [], 0
    for vid in ids:
        if time.monotonic() - started > budget_sec:
            logger.info("[studio] autoscan: budget spent, %s videos left for next run",
                        len(ids) - len(results))
            break
        try:
            res = await scan_video(vid, max_proposals=max_proposals)
        except Exception as exc:  # noqa: BLE001 — one bad file must not kill the run
            logger.warning("[studio] autoscan failed on video %s: %s", vid, exc)
            res = {"video_id": vid, "found": 0, "error": str(exc)[:200]}
        _record_scan(res["video_id"], res["found"], res.get("error"))
        total += res["found"]
        results.append(res)

    logger.info("[studio] autoscan: %s videos, %s proposals in %.0fs",
                len(results), total, time.monotonic() - started)
    return {"scanned": len(results), "proposals": total, "videos": results,
            "exhausted": False}


def autoscan_status() -> dict:
    """What the review screen shows above the proposals."""
    db = SessionLocal()
    try:
        proposed = db.query(func.count(Moment.id)).filter(Moment.status == "proposed").scalar() or 0
        rejected = db.query(func.count(Moment.id)).filter(Moment.status == "rejected").scalar() or 0
        kept_auto = (db.query(func.count(Moment.id))
                     .filter(Moment.status == "kept", Moment.origin == "auto").scalar() or 0)
        scanned = db.query(func.count(StudioScan.id)).scalar() or 0
        last = db.query(func.max(StudioScan.scanned_at)).scalar()
        # Only files the scanner can actually open — counting the 7000 remote
        # cards would report "0 of 7136 scanned" forever and read as broken.
        eligible = (db.query(func.count(Video.id))
                    .filter(Video.title != "", Video.duration >= MIN_DURATION_SEC,
                            Video.duration <= MAX_DURATION_SEC,
                            or_(Video.url.like("file://%"),
                                Video.url.like("/static/%"),
                                Video.storage_type == "local_direct")).scalar() or 0)
        return {"proposed": proposed, "rejected": rejected, "kept_auto": kept_auto,
                "scanned_videos": scanned, "eligible_videos": eligible,
                "last_scan": last.isoformat() if last else None}
    finally:
        db.close()


async def nightly_job() -> None:
    """Scheduler entry point. Never raises — a scheduler job that throws is noise."""
    try:
        await run_autoscan()
    except Exception:  # noqa: BLE001
        logger.exception("[studio] nightly autoscan crashed")
