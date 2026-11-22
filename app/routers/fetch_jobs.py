"""Short-lived control/replay API for durable Bunkr fetch batches."""
import asyncio
import json
import re
from contextlib import aclosing
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from app.auth import check_auth
from app.database import engine
from app.fetch_jobs import FetchStore, FetchRuntime
from app.ntc.bunkr_scheduler import is_bunkr_host, get_bunkr_scheduler

router = APIRouter(prefix="/api/v1/fetch-jobs", dependencies=[Depends(check_auth)])


async def execute(row):
    if row["operation"] == "album":
        from app.main import _album_files_events
        async with aclosing(_album_files_events(row["url"], limit=0)) as stream:
            async for event in stream:
                if event["type"] == "base":
                    return {"items": event["items"]}
                if event["type"] == "error":
                    raise RuntimeError(event["error"])
        raise RuntimeError("Album listing ended without results")

    from app.extractors.bunkr import BunkrExtractor
    from app import bunkr_cache
    from app.mp4_probe import probe_mp4_cached, probe_mp4
    seed = json.loads(row["seed"])
    if seed.get("type") in {"image", "file"}:
        from app.extractors.base import ntc_get
        parsed = BunkrExtractor()._parse_file_page(await ntc_get(row["url"], priority="low"), row["url"])
        data = {**seed, "title": seed.get("title") or parsed.get("title"),
                "thumbnail": seed.get("thumbnail") or parsed.get("thumb"),
                "size": seed.get("size") or parsed.get("size"),
                "enriched": True, "thumbnail_checked": True}
        bunkr_cache.file_meta_put(row["url"], data)
        return data
    cached = bunkr_cache.file_meta_get(row["url"])
    if (row["mode"] == "files_cached" and cached and cached.get("duration") and cached.get("height")
            and cached.get("thumbnail") and (cached.get("size_bytes") or cached.get("size"))):
        return {**cached, "url": row["url"], "enriched": True, "metadata_from_cache": True}
    if row["mode"] != "files" and cached and cached.get("duration") and cached.get("height") and cached.get("thumbnail"):
        if row["mode"] != "files_cached":
            return cached
    extractor = BunkrExtractor()
    result = await extractor.extract(row["url"], metadata_only=bool(seed.get("thumbnail")))
    if not result or not result.get("stream_url"):
        raise RuntimeError("Bunkr file unavailable: stream resolution failed")
    stream_url = result["stream_url"]
    data = {**seed, "url": row["url"], "title": seed.get("title") or result.get("title") or "",
            "thumbnail": seed.get("thumbnail") or result.get("thumbnail") or ""}
    if re.search(r"\.(mp4|m4v|mov)(?:[?#]|$)", stream_url, re.I):
        if row["mode"] == "files":
            meta = await probe_mp4(stream_url, headers={"Referer": row["url"]})
        else:
            meta = await probe_mp4_cached(row["url"], stream_url, headers={"Referer": row["url"]})
        if not meta.get("duration") or not meta.get("height"):
            raise RuntimeError("CDN metadata incomplete; duration/resolution unavailable")
        size = int(meta.get("size") or 0)
        height = int(meta.get("height") or 0)
        from app.main import _dh_format_bytes
        data.update(duration=int(meta["duration"]), height=height, width=int(meta.get("width") or 0),
            type="video", size_bytes=size, size_raw=size, size=_dh_format_bytes(size),
            size_verified=bool(size), quality="4K" if height >= 2160 else f"{height}p")
        if row["mode"] == "files":
            from app.mp4_probe import cache_put
            cache_put(row["url"], data["duration"], size, data["width"], height, persist=False)
    elif re.search(r"\.(mkv|webm|avi|m3u8)(?:[?#]|$)", stream_url, re.I):
        data["metadata_state"] = "unsupported"
    data.update(enriched=True, thumbnail_checked=True)
    data.pop("stream_url", None)
    bunkr_cache.file_meta_put(row["url"], data)
    return data


store = FetchStore(engine)
runtime = FetchRuntime(store, execute)


class StartFetch(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=1000)
    mode: str = "index"
    limit: int = Field(default=0, ge=0, le=100000)
    request_key: str | None = Field(default=None, max_length=100)


@router.post("")
async def start(req: StartFetch):
    if req.mode not in {"index", "enrich", "files", "files_cached"}:
        raise HTTPException(422, "Unknown fetch mode")
    for url in req.urls:
        try:
            parsed = urlsplit(url)
            valid = (parsed.scheme == "https" and is_bunkr_host(parsed.hostname or "")
                     and not parsed.username and not parsed.password and parsed.port in (None, 443)
                     and len(url) <= 2048)
        except ValueError:
            valid = False
        pattern = r"^/(f|v)/[^/]+/?$" if req.mode in {"files", "files_cached"} else r"^/(a|album|albums)/[^/]+/?$"
        if not valid or not re.match(pattern, parsed.path):
            raise HTTPException(422, "Expected a supported HTTPS Bunkr album/file URL")
    await runtime.start()
    try:
        try:
            job_id = await asyncio.to_thread(store.submit, req.urls, req.mode,
                                            limit=req.limit, request_key=req.request_key)
        except IntegrityError:
            # A concurrent identical submission won the unique-key race.
            job_id = await asyncio.to_thread(store.submit, req.urls, req.mode,
                                            limit=req.limit, request_key=req.request_key)
    except ValueError as exc:
        raise HTTPException(422 if "Idempotency" in str(exc) else 429, str(exc)) from exc
    return {"job_id": job_id, "status": "accepted"}


@router.get("/traffic")
async def traffic():
    return get_bunkr_scheduler().snapshot()


@router.get("/{job_id}")
async def snapshot(job_id: str, after: int = 0, limit: int = 200):
    result = await asyncio.to_thread(store.snapshot, job_id, after=max(0, after), limit=max(1, min(limit, 200)))
    if result is None:
        raise HTTPException(404, "Fetch job not found")
    return result


@router.get("/{job_id}/items")
async def items(job_id: str, after: int = 0, limit: int = 200):
    if await asyncio.to_thread(store.snapshot, job_id, limit=1) is None:
        raise HTTPException(404, "Fetch job not found")
    return await asyncio.to_thread(store.results, job_id, after=max(0, after), limit=max(1, min(limit, 200)))


@router.post("/{job_id}/cancel")
async def cancel(job_id: str):
    if await asyncio.to_thread(store.snapshot, job_id, limit=1) is None:
        raise HTTPException(404, "Fetch job not found")
    await runtime.cancel(job_id)
    return {"job_id": job_id, "status": "cancelled"}
