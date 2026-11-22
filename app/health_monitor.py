"""
Link Health Monitoring Module (A3 — parallelized)

Validates stream URLs and refreshes broken links. The full sweep runs
concurrently over one shared aiohttp session (bounded by a semaphore),
writes results in bulk batches instead of row-by-row commits, and emits
"health.progress" events so the dashboard can render the sweep live.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import aiohttp
from sqlalchemy import and_, case, func, or_
from sqlalchemy.orm import Session

from app.database import Video
from app.events import bus

DEFAULT_CONCURRENCY = 20
PROGRESS_EVERY = 25     # emit a progress event every N checked links


async def check_link_health(
    url: str,
    timeout: int = 10,
    session: Optional[aiohttp.ClientSession] = None,
) -> bool:
    """Check if a stream URL is accessible. Reuses `session` when provided."""

    async def _check(sess: aiohttp.ClientSession) -> bool:
        try:
            # Use HEAD request for efficiency
            async with sess.head(url, timeout=aiohttp.ClientTimeout(total=timeout),
                                 allow_redirects=True, ssl=False) as response:
                return response.status < 400
        except Exception:
            # Fallback to GET with range header
            try:
                headers = {'Range': 'bytes=0-1024'}
                async with sess.get(url, headers=headers,
                                    timeout=aiohttp.ClientTimeout(total=timeout),
                                    ssl=False) as response:
                    return response.status in [200, 206]
            except Exception:
                return False

    if session is not None:
        return await _check(session)
    async with aiohttp.ClientSession() as own_session:
        return await _check(own_session)


async def check_video_health(db: Session, video_id: int) -> dict:
    """Check health of a single video"""
    video = db.query(Video).get(video_id)
    if not video:
        return {'success': False, 'error': 'Video not found'}

    is_healthy = await check_link_health(video.url)

    video.last_checked = datetime.now(timezone.utc).replace(tzinfo=None)
    video.check_count = (video.check_count or 0) + 1
    video.link_status = "working" if is_healthy else "broken"
    db.commit()

    return {
        'success': True,
        'video_id': video_id,
        'status': video.link_status,
        'url': video.url
    }


async def check_all_videos_health(
    db: Session,
    max_age_hours: int = 24,
    concurrency: int = DEFAULT_CONCURRENCY,
):
    """Check health of all videos that haven't been checked recently.

    Runs up to `concurrency` link checks in parallel over a shared session
    and persists results in bulk after the sweep.
    """
    cutoff_time = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=max_age_hours)

    # Load only what the checks need; ORM rows stay out of the hot loop
    candidates = db.query(Video.id, Video.url, Video.check_count).filter(
        (Video.last_checked.is_(None)) | (Video.last_checked < cutoff_time),
        Video.status == "ready_to_stream"
    ).all()

    results = {
        'total': len(candidates),
        'working': 0,
        'broken': 0,
        'checked': 0
    }
    if not candidates:
        return results

    await bus.emit("health.progress", state="started",
                   metrics={"total": results['total']})

    semaphore = asyncio.Semaphore(concurrency)
    connector = aiohttp.TCPConnector(limit=concurrency, ssl=False)

    async def check_one(video_id: int, url: str, check_count: int, session):
        async with semaphore:
            healthy = await check_link_health(url, session=session)
        return video_id, check_count, healthy

    updates = []
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [
            asyncio.ensure_future(check_one(c.id, c.url, c.check_count or 0, session))
            for c in candidates
        ]
        for future in asyncio.as_completed(tasks):
            video_id, check_count, healthy = await future
            updates.append({
                'id': video_id,
                'last_checked': now,
                'check_count': check_count + 1,
                'link_status': "working" if healthy else "broken",
            })
            if healthy:
                results['working'] += 1
            else:
                results['broken'] += 1
            results['checked'] += 1
            if results['checked'] % PROGRESS_EVERY == 0:
                await bus.emit("health.progress", state="running", metrics=dict(results))

    # Bulk persist in batches to keep transactions short
    for start in range(0, len(updates), 500):
        db.bulk_update_mappings(Video, updates[start:start + 500])
        db.commit()

    await bus.emit("health.progress", state="completed", metrics=dict(results))
    logging.info(f"Health check complete: {results}")
    return results


def get_library_health_stats(db: Session) -> dict:
    """Return mutually exclusive playback-health buckets for eligible videos.

    A previous version counted ``working`` and ``broken`` across the entire
    library but used only ready-to-stream videos for ``total``.  It also treated
    only the literal ``unknown`` value as unknown.  The resulting dashboard
    could therefore report more unknown videos than its total.  These buckets
    are deliberately disjoint and always add up to ``total``.
    """
    eligible = Video.status == "ready_to_stream"
    is_local = Video.storage_type.in_(("local", "local_direct", "bittorrent"))
    is_broken = or_(
        Video.link_status == "broken",
        Video.status.in_(("error", "failed")),
        Video.url.is_(None),
        Video.url == "",
    )
    is_playable = and_(~is_broken, or_(is_local, Video.link_status == "working"))
    is_checking = and_(~is_broken, ~is_playable, Video.link_status == "checking")
    is_unverified = and_(~is_broken, ~is_playable, ~is_checking)

    row = db.query(
        func.count(Video.id).label("total"),
        func.coalesce(func.sum(case((is_playable, 1), else_=0)), 0).label("playable"),
        func.coalesce(func.sum(case((is_broken, 1), else_=0)), 0).label("broken"),
        func.coalesce(func.sum(case((is_checking, 1), else_=0)), 0).label("checking"),
        func.coalesce(func.sum(case((is_unverified, 1), else_=0)), 0).label("unverified"),
        func.coalesce(func.sum(case((Video.last_checked.is_(None), 1), else_=0)), 0).label("never_checked"),
    ).filter(eligible).one()

    total = int(row.total or 0)
    playable = int(row.playable or 0)
    broken = int(row.broken or 0)
    checking = int(row.checking or 0)
    unverified = int(row.unverified or 0)
    checked = playable + broken

    return {
        'total': total,
        # ``working`` remains for compatibility with existing clients.
        'working': playable,
        'playable': playable,
        'broken': broken,
        'checking': checking,
        'unknown': unverified,
        'unverified': unverified,
        'never_checked': int(row.never_checked or 0),
        'checked': checked,
        # Health measures known outcomes; coverage tells users how much is
        # actually known instead of treating an untested item as broken.
        'health_percentage': round((playable / checked * 100) if checked else 0, 1),
        'coverage_percentage': round((checked / total * 100) if total else 0, 1),
    }


async def refresh_broken_links(db: Session):
    """Attempt to refresh all broken links by re-extracting from source_url"""
    from app.services import VIPVideoProcessor

    broken_videos = db.query(Video).filter(
        Video.link_status == "broken",
        Video.source_url.isnot(None)
    ).all()

    processor = VIPVideoProcessor()
    refreshed = 0

    for video in broken_videos:
        try:
            # Re-process the video to get fresh stream URL
            await processor.process_single_video(video.id, force=True)
            refreshed += 1
        except Exception as e:
            logging.error(f"Failed to refresh video {video.id}: {e}")

    return {
        'total_broken': len(broken_videos),
        'refreshed': refreshed
    }
