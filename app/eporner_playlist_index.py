"""Progressive, listing-only Eporner title index; never resolves watch streams."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from pathlib import Path
from urllib.parse import urlparse

from .extractors.eporner import EpornerExtractor

logger = logging.getLogger(__name__)
CACHE_DIR = Path(__file__).resolve().parents[1] / "data" / "eporner_playlist_title_cache"
CACHE_TTL_SECONDS = 12 * 60 * 60
INDEX_CONCURRENCY = 4  # overlap slow responses; transport still spaces starts
_MEM_CACHE_MAX = 256
_KEEP_ITEM_KEYS = (
    "url", "source_url", "title", "thumbnail", "duration", "height",
    "views", "rating", "upload_date", "uploader", "stream_url",
    "size_mb", "size_bytes",
)
_VIDEO_META_KEYS = ("size_mb", "size_bytes", "upload_date", "uploader", "height", "duration")
_MEM_CACHE: dict[str, dict] = {}
_VIDEO_META: dict[str, dict] = {}
VIDEO_META_DIR = Path(__file__).resolve().parents[1] / "data" / "eporner_video_meta_cache"
VIDEO_META_TTL_SECONDS = 30 * 24 * 60 * 60
_BITRATE_RANGES_KBPS = {
    2160: (10_000, 22_000), 1440: (7_000, 14_000), 1080: (3_500, 8_000),
    720: (1_800, 4_500), 480: (900, 2_200), 360: (500, 1_200), 0: (1_200, 4_000),
}


def _height_bucket(value) -> int:
    try:
        height = int(value or 0)
    except (TypeError, ValueError):
        height = 0
    return next((level for level in (2160, 1440, 1080, 720, 480, 360) if height >= level), 0)


def summarize_playlist_items(items: list[dict], *, complete: bool) -> dict:
    """Aggregate listing metadata and label storage as an estimate."""
    histogram: dict[str, int] = {}
    duration = low_bytes = high_bytes = views = 0
    ratings: list[float] = []
    for item in items or []:
        seconds = max(0, int(item.get("duration") or 0))
        bucket = _height_bucket(item.get("height"))
        histogram[str(bucket)] = histogram.get(str(bucket), 0) + 1
        bitrate_low, bitrate_high = _BITRATE_RANGES_KBPS[bucket]
        duration += seconds
        low_bytes += seconds * bitrate_low * 125
        high_bytes += seconds * bitrate_high * 125
        views += max(0, int(item.get("views") or 0))
        try:
            rating = float(str(item.get("rating") or "").rstrip("%"))
            if rating > 0:
                ratings.append(rating)
        except (TypeError, ValueError):
            pass
    return {
        "video_count": len(items or []),
        "total_duration": duration,
        "quality_histogram": dict(sorted(histogram.items(), key=lambda row: int(row[0]))),
        "total_views": views,
        "average_rating": round(sum(ratings) / len(ratings), 1) if ratings else 0,
        "estimated_size_low_bytes": int(low_bytes),
        "estimated_size_high_bytes": int(high_bytes),
        "size_estimated": True,
        "estimate_confidence": "listing",
        "complete": bool(complete),
    }


def playlist_key(url: str) -> str:
    # www/non-www and different slug aliases share a playlist's cached titles.
    import re

    match = re.search(r"/playlist/([A-Za-z0-9]+)(?:/|$)", urlparse(url).path)
    return match.group(1) if match else url.split("?")[0].rstrip("/")


def video_key(url: str) -> str:
    import re

    match = re.search(r"/(?:video-|hd-porn/)([A-Za-z0-9]+)", urlparse(url or "").path)
    return match.group(1) if match else (url or "").split("?")[0].rstrip("/")


def _cache_path(url: str) -> Path:
    return CACHE_DIR / (hashlib.sha256(playlist_key(url).encode()).hexdigest() + ".json")


def _slim_items(items: list[dict]) -> list[dict]:
    slim = []
    for item in items or []:
        row = {}
        for key in _KEEP_ITEM_KEYS:
            value = item.get(key)
            if value in ("", None, [], False):
                continue
            if value == 0 and key not in {"duration", "height", "views"}:
                continue
            row[key] = value
        if row.get("url") or row.get("source_url"):
            _overlay_video_meta(row)
            slim.append(row)
    return slim


def _video_meta_path(key: str) -> Path:
    return VIDEO_META_DIR / (hashlib.sha256(key.encode()).hexdigest() + ".json")


def _overlay_video_meta(item: dict) -> dict:
    key = video_key(item.get("source_url") or item.get("url") or "")
    extra = _VIDEO_META.get(key)
    if extra is None:
        extra = _load_video_meta(key)
    if not extra:
        return item
    for field in _VIDEO_META_KEYS:
        value = extra.get(field)
        if value in ("", None, [], False):
            continue
        if not item.get(field):
            item[field] = value
    return item


def _load_video_meta(key: str):
    if not key:
        return None
    row = _VIDEO_META.get(key)
    if isinstance(row, dict) and time.time() - float(row.get("at") or 0) <= VIDEO_META_TTL_SECONDS:
        return row
    try:
        path = _video_meta_path(key)
        if time.time() - path.stat().st_mtime > VIDEO_META_TTL_SECONDS:
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data["at"] = time.time()
            _VIDEO_META[key] = data
            return data
    except (OSError, ValueError, TypeError):
        pass
    return None


def remember_video_meta(url: str, payload: dict | None) -> None:
    """Keep fetched size/date for later listing-only scans."""
    key = video_key(url)
    if not key or not isinstance(payload, dict):
        return
    row = dict(_VIDEO_META.get(key) or {})
    changed = False
    for field in _VIDEO_META_KEYS:
        value = payload.get(field)
        if value in ("", None, [], False, 0):
            continue
        if row.get(field) != value:
            row[field] = value
            changed = True
    if not changed and row.get("at"):
        return
    row["at"] = time.time()
    _VIDEO_META[key] = row
    try:
        VIDEO_META_DIR.mkdir(parents=True, exist_ok=True)
        path = _video_meta_path(key)
        import uuid

        temporary = path.with_suffix("." + uuid.uuid4().hex + ".tmp")
        temporary.write_text(json.dumps({k: row[k] for k in row if k != "at"}, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
    except OSError:
        logger.warning("[Eporner titles] Could not save video meta", exc_info=True)


def _clone_items(items: list[dict]) -> list[dict]:
    return [_overlay_video_meta(dict(item)) for item in items or []]


def _cache_row(items: list[dict], pages: int) -> dict:
    return {"items": _slim_items(items), "pages": pages, "complete": True, "at": time.time()}


def _remember(key: str, row: dict) -> dict:
    _MEM_CACHE.pop(key, None)
    _MEM_CACHE[key] = row
    while len(_MEM_CACHE) > _MEM_CACHE_MAX:
        _MEM_CACHE.pop(next(iter(_MEM_CACHE)))
    return row


def _load_cache(url: str):
    key = playlist_key(url)
    row = _MEM_CACHE.get(key)
    if isinstance(row, dict) and row.get("complete") is True and isinstance(row.get("items"), list):
        if time.time() - float(row.get("at") or 0) <= CACHE_TTL_SECONDS:
            return _remember(key, row)
        _MEM_CACHE.pop(key, None)
    try:
        path = _cache_path(url)
        if time.time() - path.stat().st_mtime > CACHE_TTL_SECONDS:
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("complete") is True and isinstance(data.get("items"), list):
            data["at"] = time.time()
            return _remember(key, data)
    except (OSError, ValueError, TypeError):
        pass
    return None


def _save_cache(url: str, items: list[dict], pages: int) -> None:
    row = _cache_row(items, pages)
    _remember(playlist_key(url), row)
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path = _cache_path(url)
        import uuid

        temporary = path.with_suffix("." + uuid.uuid4().hex + ".tmp")
        payload = {"items": row["items"], "pages": pages, "complete": True}
        temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
    except OSError:
        logger.warning("[Eporner titles] Could not save playlist cache", exc_info=True)


class _ScanClock:
    def __init__(self) -> None:
        self.t0 = time.perf_counter()
        self.ttfv_ms = None
        self.search_pages = 0
        self.playlists = 0
        self.videos = 0
        self.cache_hits = 0
        self.cache_misses = 0

    def note_videos(self, count: int, *, cached: bool, ttfv: bool = False) -> None:
        self.videos += count
        if cached:
            self.cache_hits += 1
        else:
            self.cache_misses += 1
        if ttfv and self.ttfv_ms is None and count:
            self.ttfv_ms = round((time.perf_counter() - self.t0) * 1000, 1)

    def snapshot(self) -> dict:
        elapsed = max(time.perf_counter() - self.t0, 1e-6)
        hits = self.cache_hits
        misses = self.cache_misses
        return {
            "ttfv_ms": self.ttfv_ms,
            "elapsed_ms": round(elapsed * 1000, 1),
            "search_pages": self.search_pages,
            "search_pages_per_sec": round(self.search_pages / elapsed, 2),
            "playlists": self.playlists,
            "playlists_per_sec": round(self.playlists / elapsed, 2),
            "videos": self.videos,
            "videos_per_sec": round(self.videos / elapsed, 2),
            "cache_hits": hits,
            "cache_misses": misses,
            "cache_hit_rate": round(hits / max(hits + misses, 1), 3),
        }


async def stream_playlist_titles(urls: list[str]):
    """Yield pages as they arrive, cache hits first, plus explicit completeness.

    Only three page requests run concurrently; the semaphore is released after
    each page so all playlists get their first page before deep pagination.
    GETs use the existing paced transport/cooldown; disconnect cancels work.
    """
    cached, pending = [], []
    for url in urls:
        row = await asyncio.to_thread(_load_cache, url)
        (cached if row is not None else pending).append((url, row))

    done = failed = 0
    for url, row in cached:
        done += 1
        yield {"type": "page", "url": url, "items": _clone_items(row["items"]), "page": row.get("pages", 1), "cached": True}
        yield {"type": "playlist", "url": url, "count": len(row["items"]), "complete": True, "cached": True,
               "summary": summarize_playlist_items(row["items"], complete=True), "done": done, "total": len(urls)}

    queue = asyncio.Queue()
    semaphore = asyncio.Semaphore(INDEX_CONCURRENCY)

    async def worker(url):
        pages = 0
        has_more = False
        collected: list[dict] = []

        async def page_ready(items, page, more):
            nonlocal pages, has_more
            pages, has_more = page, more
            slim = _slim_items(items)
            collected.extend(slim)
            await queue.put({"type": "page", "url": url, "items": slim, "page": page, "cached": False})

        try:
            entries = await EpornerExtractor().extract_album_entries(
                url, on_page=page_ready, strict=True, page_semaphore=semaphore)
            complete = bool(entries) and not has_more
            if complete:
                await asyncio.to_thread(_save_cache, url, entries, pages)
            await queue.put({"type": "playlist", "url": url, "count": len(entries), "complete": complete, "cached": False,
                             "summary": summarize_playlist_items(_slim_items(entries) or collected, complete=complete),
                             "error": "" if complete else "Playlist je prázdny alebo zoznam nie je celý načítaný."})
        except Exception as exc:
            await queue.put({"type": "playlist", "url": url, "complete": False, "error": str(exc), "cached": False,
                             "summary": summarize_playlist_items(collected, complete=False)})

    tasks = [asyncio.create_task(worker(url)) for url, _ in pending]
    try:
        while done < len(urls):
            event = await queue.get()
            if event["type"] == "playlist":
                done += 1
                failed += not event["complete"]
                event.update(done=done, total=len(urls))
            yield event
        yield {"type": "done", "done": done, "total": len(urls), "failed": failed, "cached": len(cached)}
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def stream_playlist_scan(
    keyword: str,
    max_pages: int,
    result_limit: int = 0,
    sort_mode: str = "newest",
    video_keyword: str = "",
):
    """Search playlists and index their titles as soon as each match appears."""
    from app.eporner_playlist_search import iter_search_playlists

    queue: asyncio.Queue = asyncio.Queue()
    semaphore = asyncio.Semaphore(INDEX_CONCURRENCY)
    tasks: list[asyncio.Task] = []
    found: list[dict] = []
    indexed = failed = 0
    pending_index = 0
    first_remaining = 0
    first_pages_done = asyncio.Event()
    first_pages_done.set()
    first_index_progress = asyncio.Event()
    search_finished = False
    clock = _ScanClock()
    needle = (video_keyword or "").strip().casefold()

    def attach_metrics(event: dict) -> dict:
        event["metrics"] = clock.snapshot()
        return event

    def matches_keyword(item: dict) -> bool:
        return not needle or needle in str(item.get("title") or "").casefold()

    def prefer_matches(items: list[dict]) -> list[dict]:
        if not needle or len(items) < 2:
            return items
        hits = [item for item in items if matches_keyword(item)]
        if not hits or len(hits) == len(items):
            return items
        rest = [item for item in items if not matches_keyword(item)]
        return hits + rest

    def is_match_page(items: list[dict]) -> bool:
        if not items:
            return False
        if not needle:
            return True
        return any(matches_keyword(item) for item in items)

    def mark_first_pending():
        nonlocal first_remaining
        first_remaining += 1
        first_pages_done.clear()

    def mark_first_done():
        nonlocal first_remaining
        first_remaining = max(0, first_remaining - 1)
        if first_remaining == 0:
            first_pages_done.set()

    mark_first_pending()  # hold deep pagination until search has finished spawning

    async def worker(url: str):
        nonlocal first_remaining
        cached_row = _load_cache(url)
        if cached_row is not None:
            items = prefer_matches(_clone_items(cached_row["items"]))
            clock.note_videos(len(items), cached=True, ttfv=is_match_page(items))
            mark_first_done()
            await queue.put(attach_metrics({
                "type": "page", "url": url, "items": items,
                "page": cached_row.get("pages", 1), "cached": True,
            }))
            first_index_progress.set()
            await queue.put({
                "type": "indexed", "url": url, "count": len(items),
                "complete": True, "cached": True,
                "summary": summarize_playlist_items(items, complete=True),
            })
            return

        pages = 0
        has_more = False
        saw_first = False
        collected: list[dict] = []

        async def page_ready(items, page, more):
            nonlocal pages, has_more, saw_first
            pages, has_more = page, more
            slim = prefer_matches(_slim_items(items))
            collected.extend(slim)
            if page == 1 and not saw_first:
                saw_first = True
                mark_first_done()
            clock.note_videos(len(slim), cached=False, ttfv=is_match_page(slim))
            await queue.put(attach_metrics({
                "type": "page", "url": url, "items": slim, "page": page, "cached": False,
            }))
            first_index_progress.set()

        async def between_pages(_page: int):
            await first_pages_done.wait()

        try:
            entries = await EpornerExtractor().extract_album_entries(
                url, on_page=page_ready, between_pages=between_pages,
                strict=True, page_semaphore=semaphore)
            complete = bool(entries) and not has_more
            if complete:
                await asyncio.to_thread(_save_cache, url, entries, pages)
            if not saw_first:
                mark_first_done()
            await queue.put({
                "type": "indexed", "url": url, "count": len(entries),
                "complete": complete, "cached": False,
                "summary": summarize_playlist_items(_slim_items(entries) or collected, complete=complete),
                "error": "" if complete else "Playlist je prázdny alebo zoznam nie je celý načítaný.",
            })
        except Exception as exc:
            if not saw_first:
                mark_first_done()
                first_index_progress.set()
            await queue.put({
                "type": "indexed", "url": url, "complete": False, "error": str(exc), "cached": False,
                "summary": summarize_playlist_items(collected, complete=False),
            })

    def spawn(item: dict):
        nonlocal pending_index
        pending_index += 1
        mark_first_pending()
        clock.playlists += 1
        tasks.append(asyncio.create_task(worker(item["url"])))

    async def flush_batch(batch: list[dict]):
        batch.sort(key=lambda item: (
            needle not in str(item.get("title") or "").casefold() if needle else False,
            -int(item.get("count") or 0),
        ))
        for item in batch:
            found.append(item)
            await queue.put(attach_metrics({
                "type": "playlist", "item": item, "found": len(found),
            }))
            spawn(item)
            await asyncio.sleep(0)
        if batch:
            await first_index_progress.wait()
            first_index_progress.clear()

    async def searcher():
        nonlocal search_finished
        batch: list[dict] = []
        try:
            async for event in iter_search_playlists(
                keyword, max_pages, result_limit=result_limit, sort_mode=sort_mode,
            ):
                if event["type"] == "playlist":
                    batch.append(event["item"])
                elif event["type"] == "search_page":
                    await flush_batch(batch)
                    batch = []
                    clock.search_pages = int(event.get("page") or 0)
                elif event["type"] == "done":
                    await flush_batch(batch)
                    batch = []
                    clock.search_pages = int(event.get("pages_scanned") or 0)
                    await queue.put({
                        "type": "_search_meta",
                        "stopped_by_rate_limit": bool(event.get("stopped_by_rate_limit")),
                    })
        except Exception as exc:
            await flush_batch(batch)
            await queue.put({"type": "error", "error": str(exc)})
        finally:
            await queue.put({"type": "_search_done"})

    search_task = asyncio.create_task(searcher())
    stopped_by_rate_limit = False
    try:
        while not (search_finished and pending_index == 0):
            event = await queue.get()
            if event["type"] == "_search_done":
                search_finished = True
                mark_first_done()
                continue
            if event["type"] == "_search_meta":
                stopped_by_rate_limit = bool(event.get("stopped_by_rate_limit"))
                continue
            if event["type"] == "indexed":
                indexed += 1
                pending_index -= 1
                failed += not event.get("complete")
                event = {
                    **event,
                    "done": indexed,
                    "total": max(len(found), indexed),
                    "found": len(found),
                }
            yield attach_metrics(event) if "metrics" not in event else event
        yield attach_metrics({
            "type": "done",
            "playlists": len(found),
            "done": indexed,
            "total": len(found),
            "failed": failed,
            "cached": clock.cache_hits,
            "pages_scanned": clock.search_pages,
            "stopped_by_rate_limit": stopped_by_rate_limit,
        })
    finally:
        if not search_task.done():
            search_task.cancel()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(search_task, *tasks, return_exceptions=True)
