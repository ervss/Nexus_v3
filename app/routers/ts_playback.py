"""
MPEG-TS playback endpoints.

The player asks `ts-status` whether a `.ts` card is playable yet, kicks off
`ts-prepare` if it isn't, and then points `<video src>` at the remuxed MP4.
Everything heavy lives in app/ts_remux.py.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from .. import ts_remux
from ..database import Video, get_db

logger = logging.getLogger(__name__)
router = APIRouter(tags=["ts"])


def _ts_video(video_id: int, db: Session) -> Video:
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video sa nenašlo")
    if not ts_remux.is_ts_url(video.url or ""):
        raise HTTPException(status_code=400, detail="Toto video nie je .ts stream")
    return video


@router.get("/videos/{video_id}/ts-status")
def ts_status(video_id: int, db: Session = Depends(get_db)):
    """ready / working+percent / error / missing — what the progress bar reads."""
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video sa nenašlo")
    payload = ts_remux.status(video_id)
    payload["is_ts"] = ts_remux.is_ts_url(video.url or "")
    return payload


@router.post("/videos/{video_id}/ts-prepare")
async def ts_prepare(video_id: int, wait: float = 0, db: Session = Depends(get_db)):
    """Start (or join) the remux for this card.

    Returns immediately by default so the UI can show progress. `wait` blocks up
    to that many seconds first — short files finish inside it and the player
    never has to render a progress bar at all.
    """
    video = _ts_video(video_id, db)
    current = ts_remux.status(video_id)
    if current["state"] == "ready":
        return current

    coro = ts_remux.ensure_mp4(video_id, video.url or "",
                               video.storage_type or "", float(video.duration or 0))
    task = asyncio.create_task(coro)
    if wait and wait > 0:
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=min(float(wait), 30))
        except asyncio.TimeoutError:
            pass       # still running — the caller polls ts-status from here
    return ts_remux.status(video_id)


@router.get("/videos/{video_id}/ts-stream")
def ts_stream(video_id: int, db: Session = Depends(get_db)):
    """Redirect to the remuxed MP4 so the static handler serves it.

    Deliberately a redirect and not a proxy: the point of remuxing to a real
    file was to get byte ranges and a duration back, and the static route
    already does both properly.
    """
    _ts_video(video_id, db)
    state = ts_remux.status(video_id)
    if state["state"] != "ready":
        raise HTTPException(status_code=409,
                            detail="Video sa ešte pripravuje — skús o chvíľu.")
    return RedirectResponse(state["url"], status_code=307)


@router.delete("/videos/{video_id}/ts-cache")
def ts_forget(video_id: int):
    """Throw away this card's remux so the next play rebuilds it."""
    return {"ok": ts_remux.forget(video_id)}


@router.get("/ts-cache")
def ts_cache_summary():
    return ts_remux.cache_summary()
