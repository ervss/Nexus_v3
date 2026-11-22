"""Generate durable Telegram thumbnails from bounded stream seeks."""
from __future__ import annotations

import asyncio
import os
import random
import shutil
import tempfile
from pathlib import Path
from typing import AsyncIterator, Iterable

from .telegram_stream import thumb_path, public_chat_id

_gate = asyncio.Semaphore(5)
_locks: dict[tuple[int, int], asyncio.Lock] = {}


def _pick_points(duration: float, reroll: bool = False) -> list[float]:
    """Pick seek timestamps that skip common studio intros/logos on the 1st try."""
    duration = max(0.0, float(duration or 0))
    if reroll:
        if duration >= 30.0:
            return [
                round(duration * random.uniform(0.14, 0.38), 2),
                round(duration * random.uniform(0.42, 0.68), 2),
                round(duration * random.uniform(0.72, 0.88), 2),
            ]
        if duration > 0.0:
            return [
                round(max(0.2, duration * random.uniform(0.20, 0.45)), 2),
                round(max(0.2, duration * random.uniform(0.50, 0.85)), 2),
                round(max(0.2, duration * random.uniform(0.10, 0.25)), 2),
            ]
        return [
            round(random.uniform(18.0, 55.0), 2),
            round(random.uniform(60.0, 120.0), 2),
            round(random.uniform(6.0, 17.0), 2),
        ]
    if duration >= 120.0:
        first = min(180.0, max(45.0, duration * 0.25))
        return [first, duration * 0.55, duration * 0.12]
    if duration >= 20.0:
        return [duration * 0.35, duration * 0.65, duration * 0.15]
    if duration > 0.0:
        return [max(0.1, duration * 0.4), max(0.1, duration * 0.75), max(0.1, duration * 0.15)]
    return [35.0, 12.0, 75.0]


def inspect_thumbnail(chat_id: int, message_id: int, has_thumbnail: bool = True) -> dict:
    """Conservative visual heuristic, not a semantic logo/scene classifier."""
    path = thumb_path(public_chat_id(chat_id), message_id)
    if not path.is_file():
        return {"status": "unchecked" if has_thumbnail else "missing"}
    try:
        from PIL import Image, ImageStat
        from .maintenance import _image_score
        with Image.open(path) as image:
            image.thumbnail((192, 192))
            gray = image.convert("L")
            stats = ImageStat.Stat(gray)
            dark = sum(gray.histogram()[:30]) / max(1, gray.width * gray.height)
        if _image_score(str(path)) <= 0:
            return {"status": "poor", "reason": "tmavý alebo prázdny"}
        if dark > .78 and stats.stddev[0] < 48:
            return {"status": "suspect", "reason": "tmavý, možné logo alebo text"}
        return {"status": "ok"}
    except Exception:
        return {"status": "poor", "reason": "nečitateľný"}


async def repair_thumbnail(chat_id: int, message_id: int, duration: float = 0, *, reroll: bool = False) -> Path:
    """Read short seeks via the local Telegram Range endpoint; keep old on failure."""
    from .maintenance import _image_score, _run_thumb_process
    from .config import config
    chat_id = public_chat_id(int(chat_id))
    message_id = int(message_id)
    if not chat_id or message_id <= 0:
        raise ValueError("Chýba Telegram identifikátor videa")
    pair = (chat_id, message_id)
    lock = _locks.setdefault(pair, asyncio.Lock())
    async with _gate, lock:
        dest = thumb_path(*pair)
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = f"http://127.0.0.1:{config.SERVER_PORT}/api/v1/telegram/stream/{chat_id}/{message_id}?preview=1"
        points = _pick_points(duration, reroll=reroll)
        ffmpeg_bin = shutil.which("ffmpeg") or "ffmpeg"
        with tempfile.TemporaryDirectory(prefix="tg_frame_", dir=dest.parent) as temp:
            candidates: list[tuple[int, str]] = []
            for i, position in enumerate(points):
                output = str(Path(temp) / f"{i}.jpg")
                cmd = [
                    ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error",
                    "-threads", "2",
                    "-probesize", "1M", "-analyzeduration", "1000000",
                    "-noaccurate_seek", "-ss", str(round(position, 2)),
                    "-i", url,
                    "-frames:v", "1",
                    "-vf", "scale=w='min(iw,560)':h='min(ih,320)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p",
                    "-q:v", "4",
                    output,
                ]
                try:
                    ok, _ = await _run_thumb_process(cmd, 25)
                except Exception:
                    ok = False
                score = await asyncio.to_thread(_image_score, output) if ok and os.path.isfile(output) else 0
                if score > 0:
                    candidates.append((score, output))
                    if score >= (65 if reroll else 55):
                        break
            if not candidates:
                raise RuntimeError("Nepodarilo sa získať použiteľnú snímku z Telegram videa")
            os.replace(max(candidates)[1], dest)
        return dest


async def repair_thumbnails_iter(
    items: Iterable[tuple[int, int, float]],
    *,
    concurrency: int = 5,
) -> AsyncIterator[dict]:
    """Repair a batch of (chat_id, message_id, duration) concurrently and yield results."""
    sem = asyncio.Semaphore(max(1, min(8, concurrency)))

    async def _one(raw_cid: int, msg_id: int, dur: float) -> dict:
        cid = public_chat_id(int(raw_cid))
        async with sem:
            try:
                await repair_thumbnail(cid, msg_id, dur)
                return {
                    "raw_chat_id": int(raw_cid),
                    "chat_id": cid,
                    "message_id": int(msg_id),
                    "ok": True,
                    "thumbnail": f"/api/v1/telegram/thumb/{cid}/{int(msg_id)}",
                }
            except Exception as exc:  # noqa: BLE001
                return {
                    "raw_chat_id": int(raw_cid),
                    "chat_id": cid,
                    "message_id": int(msg_id),
                    "ok": False,
                    "error": str(exc)[:180],
                }

    tasks = [asyncio.create_task(_one(cid, mid, dur)) for cid, mid, dur in items]
    try:
        for fut in asyncio.as_completed(tasks):
            yield await fut
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()
