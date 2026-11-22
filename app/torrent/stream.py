"""Serve a qBittorrent download while it is still growing.

MP4, M4V and WebM are sent as the file qBittorrent is writing. Range requests
that have not reached disk yet wait a few seconds, which is what lets the
browser play the opening seconds and then keep up with sequential pieces.

Other containers are remuxed with ffmpeg into fragmented MP4. Video is copied.
Audio is encoded to AAC so Chrome can play the result without a second player.
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import shutil
import subprocess
import time
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse

from .files import NATIVE_EXT, contiguous_end
from .qbittorrent import QbitError, get_client

logger = logging.getLogger("nexus.torrent")

_GROW_WAIT = 15.0
_POLL = 0.35


async def _playback(infohash: str) -> dict:
    try:
        media = await get_client().playback(infohash)
    except QbitError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc
    if media.get("path") is None:
        raise HTTPException(status_code=409, detail="The video file is not on disk yet")
    return media


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


async def _wait_for(path: Path, minimum: int, timeout: float) -> int:
    deadline = time.monotonic() + timeout
    latest = _size(path)
    while latest < minimum and time.monotonic() < deadline:
        await asyncio.sleep(_POLL)
        latest = _size(path)
    return latest


async def _iter_file(path: Path, start: int, length: int, request: Request):
    def read_at(offset: int, count: int) -> bytes:
        with open(path, "rb") as handle:
            handle.seek(offset)
            return handle.read(count)

    cursor = start
    remaining = length
    try:
        while remaining > 0:
            if await request.is_disconnected():
                break
            chunk = await asyncio.to_thread(read_at, cursor, min(256 * 1024, remaining))
            if not chunk:
                grown = await _wait_for(path, cursor + 1, 3.0)
                if grown > cursor:
                    continue
                break
            cursor += len(chunk)
            remaining -= len(chunk)
            yield chunk
    except OSError as exc:
        logger.info("torrent stream read stopped: %s", exc)


def _mime(path: Path) -> str:
    if path.suffix.lower() == ".webm" or path.name.lower().endswith(".webm.!qb"):
        return "video/webm"
    guessed = mimetypes.guess_type(path.name.removesuffix(".!qB"))[0]
    return guessed or "video/mp4"


async def _ready_end(media: dict, infohash: str, start: int, hard_end: int) -> tuple[int, int]:
    """Return (inclusive_end, total_size) for a range that contains real bytes."""
    path: Path = media["path"]
    declared = int(media.get("final_size") or 0)
    piece_size = int(media.get("piece_size") or 0)
    deadline = time.monotonic() + _GROW_WAIT
    while True:
        on_disk = _size(path)
        total = declared or on_disk
        states = media.get("states") or []
        piece_end = contiguous_end(
            states,
            piece_size,
            int(media.get("file_offset") or 0),
            start,
            hard_end,
            total,
        )
        if piece_end is not None and piece_end >= start:
            return piece_end, total
        if (not states or piece_size <= 0) and on_disk > start:
            return min(hard_end, on_disk - 1), max(total, on_disk)
        if time.monotonic() >= deadline:
            break
        await asyncio.sleep(_POLL)
        try:
            media["states"] = await get_client().piece_states(infohash)
        except QbitError:
            media["states"] = []
    raise HTTPException(status_code=416, detail="Requested range is not downloaded yet")


async def _native_response(media: dict, infohash: str, request: Request) -> StreamingResponse:
    path: Path = media["path"]
    if _size(path) <= 0:
        await _wait_for(path, 1, 8.0)
    if _size(path) <= 0:
        raise HTTPException(status_code=409, detail="The video file is not on disk yet")
    mime = _mime(path)
    final_hint = int(media.get("final_size") or 0) or _size(path)
    range_header = request.headers.get("range")
    start = 0
    if range_header:
        units = range_header.replace("bytes=", "", 1)
        start_text, _, end_text = units.partition("-")
        try:
            start = int(start_text) if start_text else 0
            requested_end = int(end_text) if end_text else final_hint - 1
        except ValueError as exc:
            raise HTTPException(status_code=416, detail="Invalid range") from exc
    else:
        requested_end = min(final_hint - 1, (8 * 1024 * 1024) - 1)
    requested_end = min(requested_end, start + (8 * 1024 * 1024) - 1)
    if requested_end < start:
        requested_end = start
    end, total = await _ready_end(media, infohash, start, requested_end)
    length = end - start + 1
    status = 206 if range_header else 200
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Cache-Control": "no-store",
    }
    if range_header:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    return StreamingResponse(
        _iter_file(path, start, length, request),
        status_code=status,
        media_type=mime,
        headers=headers,
    )


async def _iter_ffmpeg(path: Path, start: float, request: Request):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start > 0.2:
        command += ["-ss", f"{start:.3f}"]
    command += [
        "-i", str(path),
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "160k",
        "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "pipe:1",
    ]
    extra: dict = {}
    if os.name == "nt":
        extra["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        **extra,
    )
    if process.stdout is None:
        return
    try:
        while True:
            if await request.is_disconnected():
                break
            chunk = await process.stdout.read(256 * 1024)
            if not chunk:
                break
            yield chunk
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
        if process.stderr is not None:
            error = await process.stderr.read()
            if error:
                logger.info("ffmpeg remux note: %s", error.decode("utf-8", errors="replace")[:400])


async def stream_torrent(infohash: str, request: Request, start: float = 0.0) -> StreamingResponse:
    media = await _playback(infohash)
    path: Path = media["path"]
    suffix = path.suffix.lower()
    native = suffix in NATIVE_EXT or path.name.lower().endswith(tuple(f"{ext}.!qb" for ext in NATIVE_EXT))
    logger.info("torrent stream hash=%s mode=%s native=%s", infohash, media.get("mode"), native)
    if native:
        return await _native_response(media, infohash, request)
    if not shutil.which("ffmpeg"):
        raise HTTPException(status_code=415, detail="ffmpeg is required to play this container while it downloads")
    return StreamingResponse(
        _iter_ffmpeg(path, start, request),
        media_type="video/mp4",
        headers={"Cache-Control": "no-store"},
    )
