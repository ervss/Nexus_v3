from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import datetime
import logging
import os
import random
import re
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse, urlunparse

from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified, set_committed_value

from .database import (
    DiscoveredVideo,
    ImportJob,
    ImportJobEvent,
    ImportJobItem,
    SessionLocal,
    Video,
    VideoSource,
)
from .config import config
from .events import bus
from .media_match import MediaFacts, looks_like_same_video
from .source_catalog import (
    DISCOVERY_SOURCE_OPTIONS,
    EXTRACT_ONLY_SOURCE_NOTES,
    classify_library_source_name,
    filter_valid_discovery_sources,
    normalize_search_source_key,
)

logger = logging.getLogger("nexus.intake")

# Lazy-loaded symbols exposed at module level so tests can monkeypatch them
# without paying their heavy import cost on server startup.
ExternalSearchEngine = None
search_catalog = None
VIPVideoProcessor = None

# Statuses after which a job never runs again — used to log the finish once.
_TERMINAL_JOB_STATUSES = {"completed", "completed_with_errors", "failed", "cancelled"}


def _fmt_secs(value: Optional[float]) -> str:
    """Render a duration for the log, tolerating a missing timestamp."""
    return "?" if value is None else f"{value:.1f}"


_PLAYABLE_MEDIA = re.compile(r"\.(mp4|webm|mov|mkv|m3u8|mpd)(\?|$)", re.I)


def domain_concurrency(domain: str) -> int:
    """How many items from one host may be resolved at once.

    Tube sites stay serial. Album hosts are the large-import case and can
    overlap a few page fetches without the old one-at-a-time lock.
    """
    host = (domain or "").lower()
    if any(token in host for token in ("eporner", "whoreshub", "porntrex", "pornhub")):
        return 1
    if any(token in host for token in ("bunkr", "bunkrr", "scdn.st", "cdn.cr")):
        return 4
    if any(token in host for token in ("filester", "fileditch", "gofile.io")):
        return 3
    return 2


def intake_item_already_playable(url: str, duration: float, title: str) -> bool:
    """True when the client already handed us a file we can store as-is."""
    if not _PLAYABLE_MEDIA.search(url or ""):
        return False
    if float(duration or 0) < 10:
        return False
    clean = (title or "").strip().lower()
    return bool(clean) and not clean.startswith("queued")


SEARCH_IMPORT_SOURCES = {
    "eporner",
    "whoreshub",
    "porntrex",
    "leakporner",
    "cyberleaks",
    "xvideos",
    "pornhub",
    "spankbang",
    "xhamster",
    "ixxx",
    "noodlemagazine",
    "beeg",
    "erome",
    "kemono",
    "simpcity",
    "hqporner",
    "mypornerleak",
    "slutvids",
    "pimpbunny",
    "hornysimp",
    "camwhores",
    "nsfw247",
    "pornfans",
}

METADATA_LIMITED_SOURCES = {
    "bunkr",
    "gofile",
    "pixeldrain",
    "filester",
    "krakenfiles",
    "lulustream",
    "turbo",
}

# Noodle's public pages can advertise a full movie but resolve to a very small
# teaser file.  Probing every import would make the intake queue needlessly
# slow, so this is intentionally limited to long Noodle candidates and runs
# after the normal import path has returned to the worker.
NOODLE_PROBE_MIN_DECLARED_DURATION = 60
NOODLE_PREVIEW_MAX_DURATION = 15


def _is_xhamster_cdn_only(url: str, source_url: str = "") -> bool:
    value = (url or "").strip().lower()
    source = (source_url or "").strip().lower()
    is_cdn = "xhcdn.com/key=" in value or re.search(r"https?://video\d+\.xhcdn\.com/key=", value) is not None
    has_watch_page = bool(
        re.search(r"https?://([^/]+\.)?xhamster(?:-fr)?\.com/videos/", source)
        or "xhamster.desi/videos/" in source
    )
    return bool(is_cdn and not has_watch_page)


def _is_noodlemagazine_source(value: str) -> bool:
    host = urlparse(value or "").netloc.lower().removeprefix("www.")
    return host in {"noodlemagazine.com", "adult.noodlemagazine.com", "ukdevilz.com"}


def _needs_noodlemagazine_duration_probe(video: Video) -> bool:
    """Whether a newly imported card needs an off-path trailer sanity check."""
    return bool(
        _is_noodlemagazine_source(getattr(video, "source_url", ""))
        and float(getattr(video, "duration", 0) or 0) >= NOODLE_PROBE_MIN_DECLARED_DURATION
        and str(getattr(video, "url", "") or "").startswith(("http://", "https://"))
    )


class IntakeCandidate(BaseModel):
    title: str = "Untitled"
    url: str
    source_url: Optional[str] = None
    thumbnail: Optional[str] = ""
    discovery_sprite: Optional[str] = ""
    duration: float = 0
    width: int = 0
    height: int = 0
    quality: str = ""
    file_size_mb: float = 0
    upload_date: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    actors: List[str] = Field(default_factory=list)
    categories: List[str] = Field(default_factory=list)
    source: Optional[str] = ""
    confidence: float = 0.5
    warnings: List[str] = Field(default_factory=list)


class IntakeSearchRequest(BaseModel):
    query: str
    sources: List[str] = Field(default_factory=list)
    min_quality: int = 0
    min_duration: int = 0
    limit: int = 100
    per_source_limit: int = 20
    enrich_unknown: bool = True
    playwright_fallback: bool = True


class IntakeImportRequest(BaseModel):
    urls: List[str] = Field(default_factory=list)
    candidates: List[IntakeCandidate] = Field(default_factory=list)
    batch_name: Optional[str] = None
    source_mode: str = "mixed"
    min_quality: int = 0
    min_duration: int = 0
    auto_metadata: bool = True
    playwright_fallback: bool = True


def normalize_intake_url(value: Optional[str]) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlparse(raw)
        if not parsed.scheme or not parsed.netloc:
            return raw.rstrip("/")
        path = re.sub(r"/+", "/", parsed.path or "/").rstrip("/")
        netloc = parsed.netloc.lower()
        if netloc.startswith("www."):
            netloc = netloc[4:]
        return urlunparse((parsed.scheme.lower(), netloc, path or "/", "", parsed.query, ""))
    except Exception:
        return raw.rstrip("/")


def _quality_from_height(height: int) -> str:
    if height >= 2160:
        return "4K"
    if height >= 1440:
        return "1440p"
    if height >= 1080:
        return "1080p"
    if height >= 720:
        return "720p"
    if height > 0:
        return "SD"
    return "Unknown"


def _source_key_from_candidate(url: str, explicit_source: Optional[str] = None) -> str:
    explicit = normalize_search_source_key(explicit_source or "")
    if explicit:
        return explicit
    label = classify_library_source_name(url, url)
    key = normalize_search_source_key(label)
    if key:
        return key
    try:
        host = urlparse(url).netloc.lower().removeprefix("www.")
        return host.split(".")[0] if host else "unknown"
    except Exception:
        return "unknown"


def _as_csv(values: List[str]) -> str:
    return ",".join([str(v).strip() for v in values if str(v).strip()])


def _coerce_int(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    if not text:
        return default
    match = re.search(r"-?\d+", text)
    return int(match.group(0)) if match else default


def _coerce_duration(value: Any, default: float = 0.0) -> float:
    def _finalize(seconds: float) -> float:
        try:
            n = int(float(seconds))
        except Exception:
            return default
        if n <= 0:
            return default
        # Avoid polluted values that decode into multi-day runtimes.
        if n > 7 * 24 * 3600:
            fallback = n % 3600
            if 10 <= fallback < 3600:
                return float(fallback)
            return default
        return float(n)

    if value is None:
        return default
    if isinstance(value, bool):
        return _finalize(float(int(value)))
    if isinstance(value, (int, float)):
        return _finalize(float(value))
    text = str(value).strip().lower()
    if not text:
        return default
    if ":" in text:
        match = re.search(r"(\d+):([0-5]?\d)(?::([0-5]\d))?$", text)
        if match:
            left = int(match.group(1))
            mid = int(match.group(2))
            right = match.group(3)
            if right is not None:
                sec = int(right)
                # If the left part is implausibly large, treat it as polluted HH and keep MM:SS.
                if left > 99:
                    return _finalize(mid * 60 + sec)
                return _finalize(left * 3600 + mid * 60 + sec)
            return _finalize(left * 60 + mid)

        parts = [part.strip() for part in text.split(":") if part.strip()]
        try:
            numbers = [int(part) for part in parts]
            if len(numbers) == 3:
                if numbers[0] > 99:
                    return _finalize(numbers[1] * 60 + numbers[2])
                return _finalize(numbers[0] * 3600 + numbers[1] * 60 + numbers[2])
            if len(numbers) == 2:
                return _finalize(numbers[0] * 60 + numbers[1])
            if len(numbers) == 1:
                return _finalize(numbers[0])
        except ValueError:
            return default
    unit_matches = re.findall(r"(\d+(?:\.\d+)?)\s*([hms])", text)
    if unit_matches:
        total = 0.0
        for amount, unit in unit_matches:
            number = float(amount)
            if unit == "h":
                total += number * 3600
            elif unit == "m":
                total += number * 60
            else:
                total += number
        return _finalize(total)
    try:
        return _finalize(float(text))
    except ValueError:
        digits = re.search(r"\d+(?:\.\d+)?", text)
        return _finalize(float(digits.group(0))) if digits else default


def _candidate_from_raw(raw: Dict[str, Any]) -> Dict[str, Any]:
    url = (raw.get("url") or raw.get("source_url") or "").strip()
    source_url = (raw.get("source_url") or url).strip()
    height = _coerce_int(raw.get("height"), 0)
    # Listing badges are useful evidence, but must not become measured dimensions.
    reported_quality = str(raw.get("quality") or "").strip()
    quality_height = height
    if not quality_height:
        label = reported_quality.lower()
        if re.search(r"\b(4k|uhd|2160p?)\b", label):
            quality_height = 2160
        else:
            match = re.search(r"\b(4320|2160|1440|1080|720|576|480|360|240)p?\b", label)
            quality_height = int(match.group(1)) if match else 0
    source_key = _source_key_from_candidate(source_url or url, raw.get("source"))
    warnings = list(raw.get("warnings") or [])
    if source_key in METADATA_LIMITED_SOURCES:
        warnings.append("metadata_limited")
    return {
        "title": (raw.get("title") or "Untitled").strip(),
        "url": url,
        "source_url": source_url,
        "thumbnail": (raw.get("thumbnail") or raw.get("thumbnail_path") or "").strip(),
        "duration": _coerce_duration(raw.get("duration"), 0.0),
        "width": _coerce_int(raw.get("width"), 0),
        "height": height,
        "quality": _quality_from_height(quality_height) if quality_height else (reported_quality or "Unknown"),
        "quality_height": quality_height,
        "quality_evidence": "dimensions" if height else ("source_badge" if quality_height else "unknown"),
        "tags": raw.get("tags") if isinstance(raw.get("tags"), list) else [],
        "actors": raw.get("actors") if isinstance(raw.get("actors"), list) else [],
        "categories": raw.get("categories") if isinstance(raw.get("categories"), list) else [],
        "source": source_key,
        "confidence": float(raw.get("confidence") or (0.85 if raw.get("thumbnail") else 0.55)),
        "warnings": sorted(set(warnings)),
        "status": "ready",
    }


def source_capabilities() -> Dict[str, Any]:
    options: List[Dict[str, Any]] = []
    seen = set()
    for item in DISCOVERY_SOURCE_OPTIONS:
        sid = item["id"]
        seen.add(sid)
        options.append({
            "id": sid,
            "label": item.get("label", sid),
            "search": bool(item.get("has_search")),
            "import": True,
            "metadata": sid not in METADATA_LIMITED_SOURCES,
            "playwright_fallback": sid not in METADATA_LIMITED_SOURCES,
            "taxonomies": sid not in METADATA_LIMITED_SOURCES,
            "class": "search_import" if item.get("has_search") else "metadata_limited",
        })
    for item in EXTRACT_ONLY_SOURCE_NOTES:
        sid = item["id"]
        if sid in seen:
            continue
        seen.add(sid)
        limited = sid in METADATA_LIMITED_SOURCES
        options.append({
            "id": sid,
            "label": item.get("label", sid),
            "search": False,
            "import": True,
            "metadata": not limited,
            "playwright_fallback": not limited,
            "taxonomies": not limited,
            "class": "metadata_limited" if limited else "import_only",
        })
    return {
        "sources": sorted(options, key=lambda x: (x["class"], x["label"].lower())),
        "classes": {
            "search_import": sorted(x["id"] for x in options if x["search"]),
            "import_only": sorted([x["id"] for x in options if x["class"] == "import_only"]),
            "metadata_limited": sorted(METADATA_LIMITED_SOURCES),
        },
    }


async def search_intake_candidates(request: IntakeSearchRequest, db: Session) -> Dict[str, Any]:
    query = (request.query or "").strip()
    if not query:
        return {"candidates": [], "total": 0, "warnings": ["empty_query"]}

    engine_cls = ExternalSearchEngine
    if engine_cls is None:
        from .search_engine import ExternalSearchEngine as engine_cls
    catalog_fn = search_catalog
    if catalog_fn is None:
        from .search_pipeline import search_catalog as catalog_fn

    payload = await catalog_fn(
        engine_cls(), query, request.sources,
        min_quality=request.min_quality, min_duration=request.min_duration,
        per_source_limit=request.per_source_limit, total_limit=request.limit,
        enrich_unknown=request.enrich_unknown,
    )
    candidates = [_candidate_from_raw(raw) for raw in payload["results"]]
    for candidate, raw in zip(candidates, payload["results"]):
        candidate["source"] = raw["source_key"]
        candidate["quality_evidence"] = raw.get("quality_evidence", "source_metadata")
        candidate["quality_height"] = raw["quality_height"]
        if not candidate["thumbnail"] or not candidate["duration"]:
            candidate["status"] = "missing_metadata"
    if candidates:
        existing = _existing_normalized_urls(db)
        for candidate in candidates:
            if normalize_intake_url(candidate["url"]) in existing:
                candidate["status"] = "duplicate"
                candidate["warnings"] = sorted(set(candidate["warnings"] + ["duplicate"]))
    # A browser crawl for thumbnails must not hold every selected source hostage.
    return {**payload, "candidates": candidates, "total": len(candidates), "warnings": []}



async def _playwright_enrich_candidates(candidates: List[Dict[str, Any]]) -> None:
    targets = [c for c in candidates if c.get("status") == "missing_metadata" and c.get("source_url")]
    if not targets:
        return
    try:
        from playwright.async_api import async_playwright
    except Exception:
        for candidate in targets:
            candidate["warnings"] = sorted(set((candidate.get("warnings") or []) + ["playwright_unavailable"]))
        return
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True)
            page = await browser.new_page()
            for candidate in targets:
                try:
                    await page.goto(candidate["source_url"], wait_until="domcontentloaded", timeout=12000)
                    title = await page.title()
                    if title and candidate.get("title") in ("", "Untitled"):
                        candidate["title"] = title.strip()
                    og_locator = page.locator('meta[property="og:image"], meta[name="twitter:image"]').first
                    og_image = await og_locator.get_attribute("content", timeout=2500)
                    if og_image and not candidate.get("thumbnail"):
                        candidate["thumbnail"] = og_image
                    if candidate.get("thumbnail") and candidate.get("title") != "Untitled":
                        candidate["status"] = "ready"
                    candidate["warnings"] = sorted(set((candidate.get("warnings") or []) + ["browser_checked"]))
                except Exception as exc:
                    candidate["warnings"] = sorted(set((candidate.get("warnings") or []) + [f"browser_skip:{type(exc).__name__}"]))
            await browser.close()
    except Exception:
        for candidate in targets:
            candidate["warnings"] = sorted(set((candidate.get("warnings") or []) + ["browser_fallback_failed"]))


def _existing_normalized_urls(db: Session) -> set[str]:
    urls = set()
    # Stream scalar columns in bounded chunks. The previous two ``.all()``
    # calls retained every SQLAlchemy row plus a combined copy before doing any
    # normalization, causing needless memory spikes on large libraries.
    for model in (Video, DiscoveredVideo):
        rows = db.query(model.url, model.source_url).yield_per(1000)
        for row in rows:
            for value in row:
                norm = normalize_intake_url(value)
                if norm:
                    urls.add(norm)
    return urls


def _log_event(db: Session, job_id: int, event_type: str, message: str, level: str = "info", item_id: Optional[int] = None, payload: Optional[dict] = None) -> None:
    db.add(ImportJobEvent(
        job_id=job_id,
        item_id=item_id,
        level=level,
        event_type=event_type,
        message=message,
        payload=payload or {},
    ))


def _refresh_job_counts(db: Session, job: ImportJob, status_counts=None, log_finish=True) -> None:
    # SessionLocal disables autoflush. Publish the item's new status inside
    # this transaction before counting; otherwise every transition lags by one.
    if status_counts is None:
        db.flush()
    # Counting in SQL avoids hydrating every item (including its JSON/text
    # payloads) each time a worker changes one status. Large import jobs call
    # this function repeatedly, so the old implementation became quadratic.
    status_rows = status_counts if status_counts is not None else (
        db.query(ImportJobItem.status, func.count(ImportJobItem.id))
        .filter(ImportJobItem.job_id == job.id)
        .group_by(ImportJobItem.status)
        .all()
    )
    counts = {status: count for status, count in status_rows}
    job.total_items = sum(counts.values())
    job.pending_items = counts.get("pending", 0) + counts.get("pending_retry", 0)
    job.running_items = counts.get("running", 0)
    job.imported_items = counts.get("imported", 0)
    job.failed_items = counts.get("failed", 0)
    job.duplicate_items = counts.get("duplicate", 0)
    job.cancelled_items = counts.get("cancelled", 0)
    if job.cancelled_items and job.pending_items == 0 and job.running_items == 0:
        job.status = "cancelled"
    elif job.running_items:
        job.status = "running"
    elif job.pending_items:
        job.status = "queued"
    elif job.failed_items:
        job.status = "completed_with_errors" if job.imported_items or job.duplicate_items else "failed"
        job.finished_at = job.finished_at or datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    else:
        job.status = "completed"
        job.finished_at = job.finished_at or datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    if job.status in ("queued", "running"):
        job.finished_at = None
    elif job.status == "cancelled":
        job.finished_at = job.finished_at or datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    job.updated_at = datetime.datetime.now(datetime.UTC)

    # Log the finish exactly once, with the wall-clock cost split into queue
    # wait vs actual work. "Queued N items" in the client says nothing about
    # which of the two is slow; this line answers it without a DB query.
    if log_finish and job.status in _TERMINAL_JOB_STATUSES and not getattr(job, "_finish_logged", False):
        job._finish_logged = True
        created, started, finished = job.created_at, job.started_at, job.finished_at
        waited = (started - created).total_seconds() if (created and started) else None
        worked = (finished - started).total_seconds() if (started and finished) else None
        total = (finished - created).total_seconds() if (created and finished) else None
        logger.info(
            "[Intake] job #%s %s in %ss (queue wait %ss, work %ss) — "
            "imported=%s duplicate=%s failed=%s of %s | batch=%r",
            job.id, job.status.upper(),
            _fmt_secs(total), _fmt_secs(waited), _fmt_secs(worked),
            job.imported_items, job.duplicate_items, job.failed_items,
            job.total_items, job.batch_name,
        )

def reconcile_job_counts(db: Session, jobs, persist=False) -> None:
    """Read authoritative item counts in one query, including old stale jobs.

    Keep activity timestamps intact: polling is not worker progress. Callers
    may commit this at startup; read endpoints only use the refreshed view.
    """
    jobs = list(jobs)
    if not jobs:
        return
    db.flush()
    rows = (db.query(ImportJobItem.job_id, ImportJobItem.status,
                     func.count(ImportJobItem.id), func.max(ImportJobItem.updated_at))
            .filter(ImportJobItem.job_id.in_([job.id for job in jobs]))
            .group_by(ImportJobItem.job_id, ImportJobItem.status).all())
    grouped = {}
    latest = {}
    for job_id, status, count, updated in rows:
        grouped.setdefault(job_id, []).append((status, count))
        if updated and (job_id not in latest or updated > latest[job_id]):
            latest[job_id] = updated
    for job in jobs:
        activity = job.updated_at
        _refresh_job_counts(db, job, grouped.get(job.id, []), log_finish=False)
        job.updated_at = activity
        # Include the old value in UPDATE, preventing the column's onupdate
        # default from turning reconciliation into artificial worker activity.
        if persist:
            flag_modified(job, "updated_at")
        if job.status in _TERMINAL_JOB_STATUSES and job.id in latest:
            job.finished_at = latest[job.id]
        if not persist:
            # Read endpoints must not acquire a write lock during polling.
            for field in ("total_items", "pending_items", "running_items", "imported_items",
                          "failed_items", "duplicate_items", "cancelled_items", "status",
                          "updated_at", "finished_at"):
                set_committed_value(job, field, getattr(job, field))


def _store_discovery_sprite(data: str) -> str:
    """Persist a validated, browser-generated 16-frame strip for the queued item."""
    if not data or len(data) > 4_000_000 or not data.startswith("data:image/jpeg;base64,"):
        return ""
    try:
        from PIL import Image
        raw = base64.b64decode(data.split(",", 1)[1], validate=True)
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "JPEG" or image.width != 5120 or not 1 <= image.height <= 2560:
                return ""
            image.verify()
        name = "discovery_sprite_" + hashlib.sha256(raw).hexdigest() + ".jpg"
        directory = os.path.join("app", "static", "thumbnails")
        os.makedirs(directory, exist_ok=True)
        path = os.path.join(directory, name)
        if not os.path.exists(path):
            with open(path, "wb") as output:
                output.write(raw)
        return "/static/thumbnails/" + name
    except (ValueError, OSError, TypeError):
        logger.warning("Invalid Discovery Hub preview ignored")
        return ""


def create_import_job(request: IntakeImportRequest, db: Session) -> ImportJob:
    batch = (request.batch_name or f"Nexus Intake {datetime.datetime.now().strftime('%d.%m %H:%M')}").strip()
    job = ImportJob(
        batch_name=batch,
        source_mode=request.source_mode or "mixed",
        status="queued",
        options={
            "min_quality": request.min_quality,
            "min_duration": request.min_duration,
            "auto_metadata": request.auto_metadata,
            "playwright_fallback": request.playwright_fallback,
        },
    )
    db.add(job)
    db.flush()
    # A label such as "Fusion Hub" is a user-facing grouping, not a job
    # identity.  Reusing it made rows from later runs indistinguishable from
    # an older/stuck run in the library and in terminal output.  Keep the
    # readable label while making every import batch stable and unique.
    job.batch_name = f"{batch} · job #{job.id}"

    candidates: List[IntakeCandidate] = list(request.candidates or [])
    for url in request.urls or []:
        clean = (url or "").strip()
        if clean:
            candidates.append(IntakeCandidate(url=clean, source_url=clean, title="Queued..."))

    # Do not scan the whole library for an empty request.
    existing = _existing_normalized_urls(db) if candidates else set()
    seen_in_job = set()
    for candidate in candidates:
        url = (candidate.url or "").strip()
        source_url = (candidate.source_url or candidate.url or "").strip()
        norm = normalize_intake_url(url or source_url)
        if not url or not norm or norm in seen_in_job:
            continue
        seen_in_job.add(norm)
        source = _source_key_from_candidate(source_url or url, candidate.source)
        height = int(candidate.height or 0)
        if request.source_mode == "search" and request.min_quality:
            facts = _candidate_from_raw(candidate.model_dump())
            if facts["quality_height"] < request.min_quality:
                # Enforce the search contract again at the import boundary.
                continue
        status = "duplicate" if norm in existing else "pending"
        warnings = list(candidate.warnings or [])
        if source in METADATA_LIMITED_SOURCES and "metadata_limited" not in warnings:
            warnings.append("metadata_limited")
        is_unrefreshable_xhamster_cdn = _is_xhamster_cdn_only(url, source_url)
        if is_unrefreshable_xhamster_cdn and "unrefreshable_direct_cdn" not in warnings:
            warnings.append("unrefreshable_direct_cdn")
        item = ImportJobItem(
            job_id=job.id,
            url=url,
            source_url=source_url,
            normalized_url=norm,
            normalized_source=source,
            title=(candidate.title or "Queued...").strip(),
            thumbnail=(candidate.thumbnail or "").strip(),
            duration=float(candidate.duration or 0),
            width=int(candidate.width or 0),
            height=height,
            quality=candidate.quality or _quality_from_height(height),
            file_size_mb=float(candidate.file_size_mb or 0),
            upload_date=(candidate.upload_date or "").strip() or None,
            tags=_as_csv(candidate.tags or []),
            actors=_as_csv(candidate.actors or []),
            categories=_as_csv(candidate.categories or []),
            status="failed" if is_unrefreshable_xhamster_cdn else status,
            error=(
                "xHamster CDN-only URL cannot be refreshed; import the original xHamster video page instead."
                if is_unrefreshable_xhamster_cdn
                else None
            ),
            warnings=warnings,
            confidence=float(candidate.confidence or 0.5),
        )
        db.add(item)
        db.flush()
        if status == "pending" and candidate.discovery_sprite:
            sprite_path = _store_discovery_sprite(candidate.discovery_sprite)
            if sprite_path:
                _log_event(db, job.id, "discovery_sprite", "Discovery preview saved", item_id=item.id,
                           payload={"sprite_path": sprite_path})
        _log_event(db, job.id, "item_created", f"Queued {item.title or item.url}", item_id=item.id)
        if status == "duplicate":
            _log_event(db, job.id, "duplicate", f"Duplicate skipped: {item.url}", "warning", item.id)
        if is_unrefreshable_xhamster_cdn:
            _log_event(
                db,
                job.id,
                "item_rejected",
                "Rejected xHamster CDN-only URL without a watch-page source_url.",
                "error",
                item.id,
            )

    _refresh_job_counts(db, job)
    _log_event(db, job.id, "job_created", f"Created import job with {job.total_items} items")
    db.commit()
    db.refresh(job)
    return job


def serialize_job(job: ImportJob, include_items: bool = False, db: Optional[Session] = None) -> Dict[str, Any]:
    if db is not None:
        reconcile_job_counts(db, [job])
    payload = {
        "id": job.id,
        "batch_name": job.batch_name,
        "source_mode": job.source_mode,
        "status": job.status,
        "total_items": job.total_items,
        "pending_items": job.pending_items,
        "running_items": job.running_items,
        "imported_items": job.imported_items,
        "failed_items": job.failed_items,
        "duplicate_items": job.duplicate_items,
        "cancelled_items": job.cancelled_items,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
    }
    if include_items and db is not None:
        items = db.query(ImportJobItem).filter(ImportJobItem.job_id == job.id).order_by(ImportJobItem.id.asc()).all()
        events = db.query(ImportJobEvent).filter(ImportJobEvent.job_id == job.id).order_by(ImportJobEvent.id.desc()).limit(120).all()
        latest_events: Dict[int, ImportJobEvent] = {}
        for event in events:
            if event.item_id and event.item_id not in latest_events:
                latest_events[event.item_id] = event
        video_ids = [item.video_id for item in items if item.video_id]
        videos = (
            db.query(Video).filter(Video.id.in_(video_ids)).all()
            if video_ids
            else []
        )
        videos_by_id = {video.id: video for video in videos}
        payload["items"] = [
            serialize_item(
                item,
                latest_event=latest_events.get(item.id),
                video=videos_by_id.get(item.video_id),
            )
            for item in items
        ]
        payload["events"] = [serialize_event(event) for event in events]
    return payload


def _utc_iso(value: Optional[datetime.datetime]) -> Optional[str]:
    if not value:
        return None
    suffix = "" if value.tzinfo else "Z"
    return value.isoformat() + suffix


def _friendly_item_error(error: str) -> str:
    raw = re.sub(r"^[A-Za-z]+Error:\s*", "", str(error or "")).strip()
    lowered = raw.lower()
    if not raw:
        return ""
    if "timeout" in lowered or "timed out" in lowered:
        return "Zdroj neodpovedal v časovom limite."
    if "404" in lowered or "not found" in lowered:
        return "Zdroj alebo video sa nenašlo."
    if "403" in lowered or "forbidden" in lowered:
        return "Zdroj odmietol prístup."
    if "no extractor" in lowered or "unsupported" in lowered:
        return "Pre tento zdroj nemáme funkčný extraktor."
    if "no stream" in lowered or "stream_url" in lowered:
        return "Zdroj neposkytol prehrateľný stream."
    return raw[:240]


def _item_phase(
    item: ImportJobItem,
    latest_event: Optional[ImportJobEvent] = None,
    video: Optional[Video] = None,
) -> Dict[str, str]:
    status = str(item.status or "pending").lower()
    video_status = str(getattr(video, "status", "") or "").lower()
    latest_type = str(getattr(latest_event, "event_type", "") or "").lower()
    error_detail = _friendly_item_error(item.error or getattr(video, "error_msg", "") or "")

    if status == "pending":
        return {
            "phase": "queue",
            "phase_label": "Čaká na worker",
            "status_detail": "Položka je v rade a čaká na voľné spracovanie.",
        }
    if status == "pending_retry":
        return {
            "phase": "retry",
            "phase_label": "Čaká na ďalší pokus",
            "status_detail": error_detail or "Predošlý pokus zlyhal; Nexus ju automaticky skúsi znova.",
        }
    if status == "running":
        if video_status == "processing":
            label = "Extrahujem stream a metadata"
            detail = "Zdroj je otvorený; zisťujem prehrateľný odkaz, náhľad, dĺžku a kvalitu."
        elif video_status == "pending" or latest_type == "video_created":
            label = "Pripravujem extrakciu"
            detail = "Zdroj bol rozpoznaný a položka čaká na extrakciu metadát."
        else:
            label = "Overujem zdroj"
            detail = "Kontrolujem URL, typ zdroja a či už video v knižnici neexistuje."
        return {"phase": "extract", "phase_label": label, "status_detail": detail}
    if status == "imported":
        return {
            "phase": "done",
            "phase_label": "Importované",
            "status_detail": "Video aj dostupné metadata sú uložené v knižnici.",
        }
    if status == "duplicate":
        return {
            "phase": "duplicate",
            "phase_label": "Duplicitné",
            "status_detail": "Rovnaké video už v knižnici existuje; import bol preskočený.",
        }
    if status == "failed":
        return {
            "phase": "error",
            "phase_label": "Import zlyhal",
            "status_detail": error_detail or "Zdroj sa nepodarilo spracovať.",
        }
    if status == "cancelled":
        skipped = "skip" in str(item.error or "").lower() or "presko" in str(item.error or "").lower()
        return {
            "phase": "skipped",
            "phase_label": "Preskočené" if skipped else "Zrušené",
            "status_detail": "Položku si manuálne preskočil." if skipped else "Položka bola zrušená.",
        }
    return {
        "phase": status or "unknown",
        "phase_label": status or "Neznámy stav",
        "status_detail": error_detail,
    }


def serialize_item(
    item: ImportJobItem,
    latest_event: Optional[ImportJobEvent] = None,
    video: Optional[Video] = None,
) -> Dict[str, Any]:
    phase = _item_phase(item, latest_event=latest_event, video=video)
    source_host = urlparse(item.source_url or item.url or "").netloc.lower().removeprefix("www.")
    return {
        "id": item.id,
        "job_id": item.job_id,
        "url": item.url,
        "source_url": item.source_url,
        "normalized_source": item.normalized_source,
        "title": item.title,
        "thumbnail": item.thumbnail,
        "duration": item.duration,
        "width": item.width,
        "height": item.height,
        "quality": item.quality,
        "status": item.status,
        "error": item.error,
        "attempts": item.attempts,
        "max_attempts": item.max_attempts,
        "video_id": item.video_id,
        "video_status": getattr(video, "status", None),
        "warnings": item.warnings or [],
        "confidence": item.confidence,
        "source_host": source_host or item.normalized_source or "unknown",
        "created_at": _utc_iso(item.created_at),
        "updated_at": _utc_iso(item.updated_at),
        "last_event": serialize_event(latest_event) if latest_event else None,
        **phase,
    }


def serialize_event(event: ImportJobEvent) -> Dict[str, Any]:
    return {
        "id": event.id,
        "job_id": event.job_id,
        "item_id": event.item_id,
        "level": event.level,
        "event_type": event.event_type,
        "message": event.message,
        "payload": event.payload or {},
        # created_at is stored as naive UTC (datetime.now(timezone.utc).replace(tzinfo=None)) — mark it explicitly
        # so the frontend's `new Date(iso)` doesn't misread it as local time.
        "created_at": event.created_at.isoformat() + "Z" if event.created_at else None,
    }


class IntakeWorker:
    def __init__(self) -> None:
        self._tasks: List[asyncio.Task] = []
        self._active_item_tasks: Dict[int, asyncio.Task] = {}
        self._background_probe_tasks: set[asyncio.Task] = set()
        self._stop = asyncio.Event()
        self._processor_instance = None
        self._domain_last_seen: Dict[str, float] = {}
        self._domain_gates: Dict[str, asyncio.Semaphore] = {}
        self._delay_lock = asyncio.Lock()
        self._claim_lock = asyncio.Lock()
        # Remote extraction is much heavier and less predictable than ordinary
        # processing.  Its own cap avoids starving request handlers when a host
        # is slow or its DNS fails.
        self._parallel_workers = int(getattr(config, "INTAKE_MAX_WORKERS", 4) or 4)
        self._item_timeout_seconds = int(getattr(config, "INTAKE_ITEM_TIMEOUT_SECONDS", 90) or 90)

    @property
    def _processor(self):
        if self._processor_instance is None:
            proc_cls = VIPVideoProcessor
            if proc_cls is None:
                from .services import VIPVideoProcessor as proc_cls
            self._processor_instance = proc_cls()
        return self._processor_instance

    @_processor.setter
    def _processor(self, value) -> None:
        self._processor_instance = value

    def start(self) -> None:
        active = [task for task in self._tasks if not task.done()]
        if active:
            self._tasks = active
            return
        self._stop = asyncio.Event()
        self._tasks = [
            asyncio.create_task(self._run_worker(idx + 1), name=f"nexus-intake-worker-{idx + 1}")
            for idx in range(self._parallel_workers)
        ]

    async def stop(self) -> None:
        self._stop.set()
        # Workers can be blocked inside a provider extractor while their
        # outer loop is waiting for an item task.  Waiting for the worker
        # alone used to leave those item tasks alive after shutdown, which is
        # why an apparently stopped server kept printing Camwhores progress.
        active_items = [task for task in self._active_item_tasks.values() if not task.done()]
        for task in active_items:
            task.cancel()
        if active_items:
            await asyncio.gather(*active_items, return_exceptions=True)
        workers = [task for task in self._tasks if not task.done()]
        for task in workers:
            task.cancel()
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)
        self._tasks = []
        for task in list(self._background_probe_tasks):
            task.cancel()
        if self._background_probe_tasks:
            await asyncio.gather(*self._background_probe_tasks, return_exceptions=True)
        self._background_probe_tasks.clear()

    def _schedule_noodlemagazine_duration_probe(
        self,
        video_id: int,
        expected_duration: float,
        source_url: str,
    ) -> None:
        """Validate an imported Noodle stream without blocking the intake queue."""
        task = asyncio.create_task(
            self._probe_noodlemagazine_duration(video_id, expected_duration, source_url),
            name=f"nexus-noodle-probe-{video_id}",
        )
        self._background_probe_tasks.add(task)
        task.add_done_callback(self._background_probe_tasks.discard)

    async def _probe_noodlemagazine_duration(
        self,
        video_id: int,
        expected_duration: float,
        source_url: str,
    ) -> None:
        """Mark a long Noodle card failed when its media is only a teaser."""
        db = SessionLocal()
        try:
            video = db.get(Video, video_id)
            if not video or not _needs_noodlemagazine_duration_probe(video):
                return
            stream_url = str(video.url or "")
        finally:
            db.close()

        try:
            probe = await self._processor._ffprobe_fallback(
                stream_url,
                {"duration": 0},
                referer=source_url or "https://noodlemagazine.com/",
            )
            actual_duration = float(probe.get("duration") or 0)
        except Exception as exc:
            logger.info(
                "[Intake][Noodle probe] skipped video_id=%s: %s",
                video_id,
                exc,
            )
            return

        # A failed/blocked probe is inconclusive.  Only reject when ffprobe
        # positively reports the tiny teaser duration.
        if not (0 < actual_duration <= NOODLE_PREVIEW_MAX_DURATION):
            return

        message = (
            "NoodleMagazine returned only a "
            f"{actual_duration:.1f}s preview instead of the declared "
            f"{expected_duration:.0f}s video."
        )
        db = SessionLocal()
        try:
            video = db.get(Video, video_id)
            if not video or str(video.url or "") != stream_url:
                return
            video.status = "error"
            video.error_msg = message

            item = (
                db.query(ImportJobItem)
                .filter(ImportJobItem.video_id == video_id)
                .order_by(ImportJobItem.id.desc())
                .first()
            )
            if item and item.status == "imported":
                item.status = "failed"
                item.error = message
                job = db.get(ImportJob, item.job_id)
                if job:
                    _log_event(db, job.id, "preview_only", message, "error", item.id)
                    _refresh_job_counts(db, job)
            db.commit()
            logger.warning("[Intake][Noodle probe] rejected video_id=%s: %s", video_id, message)
        finally:
            db.close()

    def recover_interrupted(self) -> None:
        db = SessionLocal()
        try:
            db.query(ImportJobItem).filter(ImportJobItem.status == "running").update(
                {"status": "pending_retry", "error": "Recovered after server restart"},
                synchronize_session=False,
            )
            reconcile_job_counts(db, db.query(ImportJob).all(), persist=True)
            db.commit()
        finally:
            db.close()

    async def _run_worker(self, worker_index: int) -> None:
        while not self._stop.is_set():
            try:
                item_id = await self._claim_next_item()
                if item_id:
                    item_task = asyncio.create_task(
                        self._process_item(item_id),
                        name=f"nexus-intake-item-{item_id}",
                    )
                    self._active_item_tasks[item_id] = item_task
                    try:
                        await item_task
                    except asyncio.CancelledError:
                        if self._stop.is_set():
                            raise
                    finally:
                        self._active_item_tasks.pop(item_id, None)
                else:
                    await asyncio.sleep(0.35)
            except Exception:
                logger.exception("intake_worker_loop_error worker=%s", worker_index)
                await asyncio.sleep(1.2)

    async def _claim_next_item(self) -> Optional[int]:
        async with self._claim_lock:
            return self._claim_next_item_sync()

    def _claim_next_item_sync(self) -> Optional[int]:
        db = SessionLocal()
        try:
            item = (
                db.query(ImportJobItem)
                .join(ImportJob, ImportJob.id == ImportJobItem.job_id)
                # A completed job is terminal.  Only an explicit retry moves
                # it back to queued; otherwise an old pending_retry item could
                # be claimed while a new Fusion/Camwhores job is running.
                .filter(ImportJob.status.in_(["queued", "running"]))
                .filter(ImportJobItem.status.in_(["pending", "pending_retry"]))
                .order_by(ImportJobItem.id.asc())
                .first()
            )
            if not item:
                return None
            job = db.query(ImportJob).filter(ImportJob.id == item.job_id).first()
            item.status = "running"
            item.attempts = int(item.attempts or 0) + 1
            item.updated_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            if job:
                job.status = "running"
                if not job.started_at:
                    job.started_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
                    waited = (job.started_at - job.created_at).total_seconds() if job.created_at else None
                    logger.info(
                        "[Intake] job #%s STARTED after %ss in queue — %s item(s) | batch=%r",
                        job.id, _fmt_secs(waited), job.total_items, job.batch_name,
                    )
                job.updated_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
                _log_event(db, job.id, "item_running", f"Processing {item.title or item.url}", item_id=item.id)
                _refresh_job_counts(db, job)
            db.commit()
            return item.id
        finally:
            db.close()

    async def skip_item(self, job_id: int, item_id: int) -> tuple[ImportJob, ImportJobItem]:
        """Cancel one queued/running item without stopping the rest of its import."""
        active_task = self._active_item_tasks.get(item_id)
        if active_task and not active_task.done():
            active_task.cancel()
            try:
                await asyncio.wait_for(active_task, timeout=4)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        db = SessionLocal()
        try:
            item = db.query(ImportJobItem).filter(
                ImportJobItem.id == item_id,
                ImportJobItem.job_id == job_id,
            ).first()
            job = db.query(ImportJob).filter(ImportJob.id == job_id).first()
            if not job or not item:
                raise ValueError("Import item not found")
            if item.status not in {"pending", "pending_retry", "running"}:
                raise RuntimeError(f"Item can no longer be skipped (status: {item.status})")

            if item.video_id:
                video = db.query(Video).filter(Video.id == item.video_id).first()
                if video and video.status in {"pending", "processing"}:
                    video.status = "cancelled"
                    video.error_msg = "Skipped by user from Import Desk"

            item.status = "cancelled"
            item.error = "Skipped by user"
            item.updated_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            _log_event(
                db,
                job.id,
                "item_skipped",
                f"Skipped item: {item.title or item.url}",
                "warning",
                item.id,
            )
            _refresh_job_counts(db, job)
            db.commit()
            db.refresh(job)
            db.refresh(item)
        finally:
            db.close()

        await self._emit_progress(job_id)
        return job, item

    async def cancel_job(self, job_id: int) -> ImportJob:
        """Cancel a whole job and stop its in-flight item tasks.

        The old synchronous helper only changed pending rows.  A running
        processor could therefore finish after cancellation and commit an old
        result into the library.  Mark the DB rows first (the worker checks
        this fence after every processor call), then cancel the matching
        asyncio tasks and refresh the terminal counts.
        """
        db = SessionLocal()
        try:
            job = db.query(ImportJob).filter(ImportJob.id == job_id).first()
            if not job:
                raise ValueError("Job not found")
            running_ids = {
                row[0] for row in db.query(ImportJobItem.id).filter(
                    ImportJobItem.job_id == job_id,
                    ImportJobItem.status == "running",
                ).all()
            }
            items = db.query(ImportJobItem).filter(
                ImportJobItem.job_id == job_id,
                ImportJobItem.status.in_(["pending", "pending_retry", "running"]),
            ).all()
            for item in items:
                item.status = "cancelled"
                item.error = "Cancelled by user"
                item.updated_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
                if item.video_id:
                    video = db.query(Video).filter(Video.id == item.video_id).first()
                    if video and video.status in {"pending", "processing"}:
                        video.status = "cancelled"
                        video.error_msg = "Cancelled with import job"
            job.status = "cancelled"
            job.finished_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
            _log_event(db, job.id, "job_cancelled", "Cancel requested", "warning")
            _refresh_job_counts(db, job)
            db.commit()
        finally:
            db.close()

        tasks = [
            task for item_id, task in self._active_item_tasks.items()
            if item_id in running_ids and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        db = SessionLocal()
        try:
            job = db.query(ImportJob).filter(ImportJob.id == job_id).first()
            if not job:
                raise ValueError("Job not found")
            _refresh_job_counts(db, job)
            db.commit()
            db.refresh(job)
            return job
        finally:
            db.close()

    async def _process_item(self, item_id: int) -> None:
        """Run one item behind a per-host concurrency cap and a finite watchdog.

        Polite hosts stay at one in-flight request. File hosts that show up as
        large albums (Bunkr, Filester, GoFile) may run a few at once. The old
        exclusive lock made every 4-worker job serial as soon as the album
        shared one domain.
        """
        domain = self._item_domain(item_id)
        gate = self._domain_gates.get(domain)
        if gate is None:
            gate = asyncio.Semaphore(self._domain_concurrency(domain))
            self._domain_gates[domain] = gate
        try:
            async with gate:
                from app.streaming.playback_control import control
                # Queue time is outside the item's extraction watchdog.
                async with control.background(f"https://{domain}/"):
                    await self._respect_domain_delay(domain)
                    await asyncio.wait_for(
                        self._process_item_inner(item_id),
                        timeout=self._item_timeout_seconds,
                    )
        except asyncio.TimeoutError:
            message = f"Import timed out after {self._item_timeout_seconds}s"
            logger.warning("intake_item_timeout item_id=%s domain=%s", item_id, domain)
            self._mark_failed_or_retry(item_id, TimeoutError(message))
            await self._emit_item_progress(item_id)

    def _item_domain(self, item_id: int) -> str:
        db = SessionLocal()
        try:
            item = db.query(ImportJobItem).filter(ImportJobItem.id == item_id).first()
            url = (item.source_url or item.url) if item else ""
            return urlparse(url or "").netloc.lower() or "local"
        finally:
            db.close()

    async def _emit_item_progress(self, item_id: int) -> None:
        db = SessionLocal()
        try:
            item = db.query(ImportJobItem).filter(ImportJobItem.id == item_id).first()
            job_id = item.job_id if item else None
        finally:
            db.close()
        if job_id:
            await self._emit_progress(job_id)

    async def _process_item_inner(self, item_id: int) -> None:
        db = SessionLocal()
        try:
            item = db.query(ImportJobItem).filter(ImportJobItem.id == item_id).first()
            if not item:
                return
            job = db.query(ImportJob).filter(ImportJob.id == item.job_id).first()
            if not job or job.status == "cancelled" or item.status == "cancelled":
                item.status = "cancelled"
                db.commit()
                return

            if (job.options or {}).get("process_existing_video") and item.video_id:
                video = db.get(Video, item.video_id)
                if not video:
                    raise RuntimeError(f"Video {item.video_id} no longer exists")
                await self._processor.process_single_video(video.id, force=True)
                db.refresh(video)
                db.refresh(item)
                if item.status == "cancelled":
                    return
                if video.status in {"pending", "processing", "error", "failed"}:
                    raise RuntimeError(video.error_msg or "Video processing did not complete")
                item.status = "imported"
                item.error = None
                _log_event(db, job.id, "item_imported", f"Processed existing video {video.id}", item_id=item.id)
                _refresh_job_counts(db, job)
                db.commit()
                await self._emit_progress(job.id)
                return

            existing = self._find_existing_video(db, item)
            if existing:
                item.status = "duplicate"
                item.video_id = existing.id
                item.error = None
                _log_event(db, job.id, "duplicate", f"Existing video matched: {existing.id}", "warning", item.id)
                _refresh_job_counts(db, job)
                db.commit()
                await self._emit_progress(job.id)
                return

            # Same upload, different host: not an exact URL repeat, but the
            # title/thumbnail/size+duration say it's the same file. Attach it
            # as a fallback source on the existing card instead of importing a
            # near-duplicate — this is what lets a card survive one host dying.
            mirror_of = self._find_cross_host_match(db, item)
            if mirror_of:
                self._attach_mirror(db, mirror_of, item)
                item.status = "duplicate"
                item.video_id = mirror_of.id
                item.error = None
                _log_event(
                    db, job.id, "mirror_attached",
                    f"Added as alternate source on video {mirror_of.id}", "info", item.id,
                )
                _refresh_job_counts(db, job)
                db.commit()
                await self._emit_progress(job.id)
                return

            # Filester's /f/ link identifies the album, but playback refresh
            # needs each file's stable /d/ page after its CDN token expires.
            from app.media_urls import media_refresh_source
            playback_source_url = media_refresh_source(item.url, item.source_url)
            if (
                "filester." in playback_source_url.lower()
                and "/f/" in playback_source_url.lower()
                and "filester." in (item.url or "").lower()
                and "/d/" in (item.url or "").lower()
            ):
                playback_source_url = item.url

            from .related_query_planner import sanitize_video_tags_csv
            video = Video(
                title=item.title or "Queued...",
                url=item.url,
                source_url=playback_source_url,
                thumbnail_path=item.thumbnail or "",
                original_thumbnail_url=item.thumbnail if str(item.thumbnail or "").startswith(("http://", "https://")) else "",
                thumbnail_referer=item.source_url or item.url,
                duration=float(item.duration or 0),
                width=int(item.width or 0),
                height=int(item.height or 0),
                quality=item.quality or _quality_from_height(int(item.height or 0)),
                upload_date=item.upload_date,
                file_size_mb=float(item.file_size_mb or 0),
                batch_name=job.batch_name,
                status="pending",
                storage_type="remote",
                models=_as_csv([item.actors]) if item.actors else "",
                categories=_as_csv([item.categories]) if item.categories else "",
                tags=sanitize_video_tags_csv(_as_csv([item.tags, item.categories])),
                created_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None),
            )
            sprite_event = db.query(ImportJobEvent).filter(
                ImportJobEvent.item_id == item.id,
                ImportJobEvent.event_type == "discovery_sprite",
            ).first()
            if sprite_event:
                video.sprite_path = (sprite_event.payload or {}).get("sprite_path") or None
            db.add(video)
            db.flush()
            item.video_id = video.id
            db.commit()
            _log_event(db, job.id, "video_created", f"Created video row {video.id}", item_id=item.id)
            db.commit()

            job_options = job.options or {}
            skip_metadata = job_options.get("auto_metadata") is False
            if skip_metadata:
                # Shell-only import for large folders/boards: keep the listing
                # metadata (title/thumbnail/size) we already have and leave the
                # heavy per-video resolve (direct URL, real thumbnail) for a
                # later on-demand refetch instead of doing it for every item now.
                item.status = "imported"
                item.error = None
                _log_event(db, job.id, "item_imported", f"Queued (shell-only) video {video.id}", item_id=item.id)
                _refresh_job_counts(db, job)
                db.commit()
                await self._emit_progress(job.id)
                return

            # Fusion cards already carry useful listing metadata. Pornhub CDN
            # links expire, so resolving them serially during import is slow
            # and the result must be refreshed again at playback anyway.
            from urllib.parse import urlparse as _urlparse
            host = (_urlparse(video.source_url or video.url or "").hostname or "").lower()
            if (job.source_mode == "fusion"
                    and any(host == d or host.endswith("." + d) for d in ("pornhub.com", "pornhub.org", "pornhub.net"))
                    and video.title and video.title != "Queued..." and video.thumbnail_path):
                video.status = "ready_to_stream"
                item.status = "imported"
                item.error = None
                _log_event(db, job.id, "item_imported", f"Stored Pornhub listing for on-demand playback {video.id}", item_id=item.id)
                _refresh_job_counts(db, job)
                db.commit()
                await self._emit_progress(job.id)
                return

            if intake_item_already_playable(video.url or "", float(video.duration or 0), video.title or ""):
                video.status = "ready_to_stream"
                item.status = "imported"
                item.error = None
                _log_event(
                    db, job.id, "item_imported",
                    f"Stored playable video {video.id} without a second probe",
                    item_id=item.id,
                )
                _refresh_job_counts(db, job)
                db.commit()
                await self._emit_progress(job.id)
                return

            await self._processor.process_single_video(video.id)

            db.refresh(item)
            if item.status == "cancelled":
                return
            processed = db.query(Video).filter(Video.id == video.id).first()
            if processed and processed.status in ("error", "failed"):
                raise RuntimeError(processed.error_msg or "Video processor failed")

            item.status = "imported"
            item.error = None
            _log_event(db, job.id, "item_imported", f"Imported video {video.id}", item_id=item.id)
            _refresh_job_counts(db, job)
            db.commit()
            if _needs_noodlemagazine_duration_probe(processed):
                self._schedule_noodlemagazine_duration_probe(
                    video.id,
                    float(processed.duration or item.duration or 0),
                    processed.source_url or item.source_url or "",
                )
            await self._emit_progress(job.id)
        except Exception as exc:
            db.rollback()
            self._mark_failed_or_retry(item_id, exc)
            # Emit progress even on failure so UI updates
            db2 = SessionLocal()
            try:
                item2 = db2.query(ImportJobItem).filter(ImportJobItem.id == item_id).first()
                if item2:
                    await self._emit_progress(item2.job_id)
            finally:
                db2.close()
        finally:
            db.close()

    async def _emit_progress(self, job_id: int) -> None:
        """Broadcast job progress over the event bus → WebSocket clients."""
        db = SessionLocal()
        try:
            job = db.query(ImportJob).filter(ImportJob.id == job_id).first()
            if not job:
                return
            reconcile_job_counts(db, [job])
            total = int(job.total_items or 0)
            done = int(job.imported_items or 0) + int(job.duplicate_items or 0) + int(job.failed_items or 0) + int(job.cancelled_items or 0)
            pct = round(done / total * 100) if total else 0
            await bus.emit(
                topic="job.progress",
                entity=f"job:{job_id}",
                state=job.status,
                message=f"{job.batch_name}: {done}/{total}",
                metrics={
                    "job_id": job_id,
                    "batch_name": job.batch_name,
                    "status": job.status,
                    "total": total,
                    "pending": int(job.pending_items or 0),
                    "running": int(job.running_items or 0),
                    "imported": int(job.imported_items or 0),
                    "failed": int(job.failed_items or 0),
                    "duplicate": int(job.duplicate_items or 0),
                    "cancelled": int(job.cancelled_items or 0),
                    "done": done,
                    "pct": pct,
                    "started_at": job.started_at.isoformat() if job.started_at else None,
                    "finished_at": job.finished_at.isoformat() if job.finished_at else None,
                },
            )
        except Exception:
            logger.debug("_emit_progress failed for job %s", job_id, exc_info=True)
        finally:
            db.close()

    def _domain_concurrency(self, domain: str) -> int:
        return domain_concurrency(domain)

    async def _respect_domain_delay(self, domain: str) -> None:
        if not domain:
            return
        if "bunkr" in domain or "bunkrr" in domain or "scdn.st" in domain:
            delay = 0.06
        elif any(k in domain for k in ("eporner", "whoreshub", "porntrex")):
            delay = 1.2
        elif "pornhub.com" in domain:
            delay = 1.5
        else:
            delay = 0.2
        async with self._delay_lock:
            now = time.time()
            last = self._domain_last_seen.get(domain, 0)
            wait = max(0, delay - (now - last))
            # Reserve the next start so concurrent workers stagger instead of
            # bursting the same host on the same millisecond.
            self._domain_last_seen[domain] = now + wait
        if wait:
            await asyncio.sleep(wait + random.uniform(0.01, 0.06))

    def _find_existing_video(self, db: Session, item: ImportJobItem) -> Optional[Video]:
        # Match on the per-file URL only. The source_url of album items is the shared
        # album page link (identical for every file in the album), so matching against it
        # would flag every sibling file as a duplicate of the first imported one.
        file_norm = normalize_intake_url(item.url) or (item.normalized_url or "")
        if not file_norm:
            return None
        rows = db.query(Video).filter(or_(Video.url == item.url, Video.url == file_norm)).all()
        for row in rows:
            if normalize_intake_url(row.url) == file_norm:
                return row
        return None

    def _find_cross_host_match(self, db: Session, item: ImportJobItem) -> Optional[Video]:
        """Second-pass check for "same upload, different host" — a bunkr link
        pointing at the same file a pixeldrain/filester card already brought
        in. _find_existing_video only catches an exact URL repeat; this catches
        the case the user actually asked for: a mirror worth attaching as a
        fallback source rather than importing as a second, near-identical card.

        Scoped to candidates whose title/size/duration are already in the same
        ballpark (SQL-level filter) before running the Python comparison, so
        this stays cheap against a library that can hold thousands of rows.
        """
        title = (item.title or "").strip()
        size_mb = float(item.file_size_mb or 0)
        duration = float(item.duration or 0)
        if not title and not size_mb and not duration:
            return None  # nothing to compare against

        candidate = MediaFacts.from_fields(
            title=title, url=item.url, thumbnail=item.thumbnail or "",
            size_bytes=size_mb * 1024 * 1024, duration=duration, height=item.height,
        )
        if not candidate.name and not candidate.thumb_fp and not (candidate.size_bytes and candidate.duration_sec):
            return None  # no usable signal — don't scan the whole table for nothing

        query = db.query(Video).filter(Video.status != "error")
        if size_mb > 0:
            # ±3% in SQL is deliberately loose (the exact 0.3% cutoff is applied
            # in Python below) — this is only a cheap prefilter, not the verdict.
            query = query.filter(
                Video.file_size_mb.between(size_mb * 0.97, size_mb * 1.03)
            )
        elif duration > 0:
            query = query.filter(Video.duration.between(duration - 5, duration + 5))
        else:
            return None  # title-only matching would mean scanning everything

        for row in query.limit(200).all():
            row_facts = MediaFacts.from_fields(
                title=row.title or "", url=row.url or "",
                thumbnail=row.original_thumbnail_url or row.thumbnail_path or "",
                size_bytes=(row.file_size_mb or 0) * 1024 * 1024,
                duration=row.duration or 0, height=row.height or 0,
            )
            if looks_like_same_video(candidate, row_facts):
                return row
        return None

    def _attach_mirror(self, db: Session, existing: Video, item: ImportJobItem) -> None:
        """Record `item` as an alternate source for `existing` instead of
        importing it as its own card. The first mirror recorded for a video
        also backfills a VideoSource row for the primary URL, so the set of
        sources for a card is always complete rather than "primary implicit,
        mirrors explicit" — that split would complicate every reader.
        """
        already = db.query(VideoSource).filter(VideoSource.video_id == existing.id).count()
        if already == 0 and existing.url:
            db.add(VideoSource(
                video_id=existing.id, url=existing.url, source_url=existing.source_url,
                label=classify_library_source_name(existing.url, existing.source_url),
                quality=existing.quality, height=existing.height or 0,
                size_mb=existing.file_size_mb or 0, is_primary=True,
                link_status=existing.link_status or "unknown",
            ))
        dup = db.query(VideoSource).filter(
            VideoSource.video_id == existing.id, VideoSource.url == item.url,
        ).first()
        if dup:
            return  # this exact mirror URL is already attached
        db.add(VideoSource(
            video_id=existing.id, url=item.url, source_url=item.source_url or item.url,
            label=classify_library_source_name(item.url, item.source_url),
            quality=item.quality or "", height=int(item.height or 0),
            size_mb=float(item.file_size_mb or 0), is_primary=False,
        ))

    def _mark_failed_or_retry(self, item_id: int, exc: Exception) -> None:
        db = SessionLocal()
        try:
            item = db.query(ImportJobItem).filter(ImportJobItem.id == item_id).first()
            if not item:
                return
            job = db.query(ImportJob).filter(ImportJob.id == item.job_id).first()
            message = f"{type(exc).__name__}: {exc}"
            if int(item.attempts or 0) < int(item.max_attempts or 3):
                item.status = "pending_retry"
                item.error = message
                level = "warning"
                event = "item_retry"
            else:
                item.status = "failed"
                item.error = message
                level = "error"
                event = "item_failed"
            if job:
                if (job.options or {}).get("process_existing_video") and item.video_id:
                    video = db.get(Video, item.video_id)
                    if video and video.status in {"pending", "processing", "error", "failed"}:
                        video.status = "error"
                        video.error_msg = message
                _log_event(db, job.id, event, message[:600], level, item.id)
                _refresh_job_counts(db, job)
            db.commit()
        finally:
            db.close()


intake_worker = IntakeWorker()


def retry_job(job_id: int, db: Session) -> ImportJob:
    job = db.query(ImportJob).filter(ImportJob.id == job_id).first()
    if not job:
        raise ValueError("Job not found")
    db.query(ImportJobItem).filter(
        ImportJobItem.job_id == job_id,
        ImportJobItem.status.in_(["failed", "pending_retry"]),
    ).update({"status": "pending_retry", "error": None}, synchronize_session=False)
    job.status = "queued"
    job.finished_at = None
    _log_event(db, job.id, "job_retry", "Retry requested")
    _refresh_job_counts(db, job)
    db.commit()
    db.refresh(job)
    return job


def cancel_job(job_id: int, db: Session) -> ImportJob:
    job = db.query(ImportJob).filter(ImportJob.id == job_id).first()
    if not job:
        raise ValueError("Job not found")
    db.query(ImportJobItem).filter(
        ImportJobItem.job_id == job_id,
        ImportJobItem.status.in_(["pending", "pending_retry"]),
    ).update({"status": "cancelled", "error": "Cancelled by user"}, synchronize_session=False)
    job.status = "cancelled"
    job.finished_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    _log_event(db, job.id, "job_cancelled", "Cancel requested", "warning")
    _refresh_job_counts(db, job)
    db.commit()
    db.refresh(job)
    return job
