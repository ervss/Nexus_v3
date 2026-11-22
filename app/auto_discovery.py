"""
Asynchronous auto-discovery worker for continuous video discovery and import.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set
import random
import time

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import (
    get_db,
    SessionLocal,
    DiscoveryProfile,
    DiscoveryNotification,
    Video,
    DiscoveredVideo,
)
from app.search_engine import ExternalSearchEngine
from app.services import VIPVideoProcessor

logger = logging.getLogger("auto_discovery")


class AutoDiscoveryWorker:
    """
    Worker responsible for profile-based discovery, filtering, deduplication and import.
    """

    max_results_per_profile: int = 200
    request_delay: float = 0.8
    max_retries: int = 3
    backoff_factor: float = 2.0

    def __init__(self) -> None:
        self.running_profiles: Set[int] = set()
        self.semaphore = asyncio.Semaphore(3)
        self._domain_last_request: Dict[str, float] = {}

    async def run_profile(self, profile_id: int) -> None:
        """
        Run one discovery profile safely.

        - Prevents concurrent run per profile ID.
        - Uses bounded concurrency via semaphore.
        - Writes notifications and profile stats on success/failure.
        """
        if profile_id in self.running_profiles:
            logger.info("profile_already_running profile_id=%s", profile_id)
            return

        self.running_profiles.add(profile_id)
        started_at = time.time()
        run_found = 0
        run_imported = 0

        async with self.semaphore:
            db: Session = SessionLocal()
            profile: Optional[DiscoveryProfile] = None
            try:
                profile = db.query(DiscoveryProfile).filter(DiscoveryProfile.id == profile_id).first()
                if not profile:
                    logger.warning("profile_not_found profile_id=%s", profile_id)
                    return

                if not profile.enabled:
                    self._notify(
                        db,
                        profile,
                        "profile_disabled",
                        f'Profile "{profile.name}" is disabled, skipping run.',
                        0,
                    )
                    db.commit()
                    logger.info("profile_disabled profile_id=%s profile_name=%s", profile.id, profile.name)
                    return

                logger.info("profile_run_start profile_id=%s profile_name=%s", profile.id, profile.name)

                raw_results = await self._search_with_profile(profile)
                filtered_results = self._filter_results(raw_results, profile, db)
                run_found = len(filtered_results)

                await self._save_discovered_videos(filtered_results, profile, db)

                if filtered_results:
                    self._notify(
                        db,
                        profile,
                        "new_matches",
                        f'Found {len(filtered_results)} new matches for "{profile.name}".',
                        len(filtered_results),
                    )

                if filtered_results and profile.auto_import:
                    run_imported = await self._import_videos(filtered_results, profile, db)
                    self._notify(
                        db,
                        profile,
                        "import_complete",
                        f'Imported {run_imported} videos for "{profile.name}".',
                        run_imported,
                    )

                profile.last_run = datetime.now(timezone.utc).replace(tzinfo=None)
                profile.total_runs = (profile.total_runs or 0) + 1
                profile.total_found = (profile.total_found or 0) + run_found
                profile.total_imported = (profile.total_imported or 0) + run_imported
                profile.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                db.commit()

                duration_s = round(time.time() - started_at, 2)
                logger.info(
                    "profile_run_done profile_id=%s profile_name=%s found=%s imported=%s duration_s=%s",
                    profile.id,
                    profile.name,
                    run_found,
                    run_imported,
                    duration_s,
                )
            except Exception as exc:
                logger.exception("profile_run_error profile_id=%s error=%s", profile_id, exc)
                if profile is not None:
                    error_summary = f"{type(exc).__name__}: {exc}"
                    self._notify(
                        db,
                        profile,
                        "error",
                        f'Profile "{profile.name}" failed: {error_summary}',
                        0,
                    )
                    profile.last_run = datetime.now(timezone.utc).replace(tzinfo=None)
                    profile.total_runs = (profile.total_runs or 0) + 1
                    if hasattr(profile, "last_error"):
                        setattr(profile, "last_error", error_summary)
                    profile.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                    db.commit()
            finally:
                db.close()
                self.running_profiles.discard(profile_id)

    async def _search_with_profile(self, profile: DiscoveryProfile) -> List[Dict[str, Any]]:
        """
        Search for candidates according to profile.

        Supports source-specific and general search with per-source retry/backoff/jitter.
        """
        query = (profile.keywords or "").strip()
        if not query:
            return []

        engine = ExternalSearchEngine()
        source_keys = profile.sources if isinstance(profile.sources, list) else []
        combined: List[Dict[str, Any]] = []
        max_results = min((profile.max_results or 20) * 4, self.max_results_per_profile)

        if source_keys:
            for source in source_keys:
                result = await self._search_single_source(engine, query, source, profile.id, profile.name)
                if result:
                    combined.extend(result)
                if len(combined) >= max_results:
                    break
        else:
            result = await self._search_general(engine, query, profile.id, profile.name)
            if result:
                combined.extend(result)

        # URL-level de-dup in-memory preserving order
        seen: Set[str] = set()
        unique: List[Dict[str, Any]] = []
        for item in combined:
            url = (item.get("url") or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            unique.append(item)
            if len(unique) >= max_results:
                break

        return unique

    def _filter_results(
        self,
        results: List[Dict[str, Any]],
        profile: DiscoveryProfile,
        db: Session,
    ) -> List[Dict[str, Any]]:
        """
        Filter results by exclude words, media constraints and DB deduplication.
        """
        if not results:
            return []

        exclude_keywords = {
            part.strip().lower()
            for part in (profile.exclude_keywords or "").split(",")
            if part.strip()
        }

        # Batch URL dedupe query
        url_candidates = [(r.get("url") or "").strip() for r in results if r.get("url")]
        duplicate_urls = self._is_duplicate_batch(url_candidates, db)

        filtered: List[Dict[str, Any]] = []
        max_results = min(profile.max_results or 20, self.max_results_per_profile)

        for item in results:
            title = (item.get("title") or "").strip()
            description = (item.get("description") or item.get("subtitle") or "").strip()
            text = f"{title} {description}".lower()
            url = (item.get("url") or "").strip()

            if not url:
                continue
            if url in duplicate_urls:
                continue
            if exclude_keywords and any(word in text for word in exclude_keywords):
                continue

            duration = self._to_int(item.get("duration"), 0)
            width = self._to_int(item.get("width"), 0)
            height = self._to_int(item.get("height"), 0)
            ratio = self._calculate_aspect_ratio(width, height)

            min_duration = self._to_int(profile.min_duration, 0)
            max_duration = self._to_int(profile.max_duration, 0)
            min_height = self._to_int(profile.min_height, 0)
            max_height = self._to_int(profile.max_height, 0)
            requested_ratio = (profile.aspect_ratio or "any").strip().lower()

            if min_duration > 0 and duration > 0 and duration < min_duration:
                continue
            if max_duration > 0 and duration > max_duration:
                continue
            if min_height > 0 and height > 0 and height < min_height:
                continue
            if max_height > 0 and height > max_height:
                continue
            if requested_ratio not in ("", "any") and ratio and ratio.lower() != requested_ratio:
                continue

            # Basic title similarity dedupe against imported videos (optional requirement)
            if title and self._is_title_likely_duplicate(title, db):
                continue

            normalized = dict(item)
            normalized["duration"] = duration
            normalized["width"] = width
            normalized["height"] = height
            normalized["aspect_ratio"] = ratio
            filtered.append(normalized)

            if len(filtered) >= max_results:
                break

        filtered.sort(
            key=lambda item: (
                float(item.get("discovery_score") or 0.0),
                int(item.get("height") or 0),
                int(item.get("duration") or 0),
            ),
            reverse=True,
        )
        return filtered

    async def _save_discovered_videos(
        self,
        results: List[Dict[str, Any]],
        profile: DiscoveryProfile,
        db: Session,
    ) -> None:
        """
        Save newly discovered candidates into `discovered_videos`.
        """
        if not results:
            return

        urls = [(r.get("url") or "").strip() for r in results if r.get("url")]
        if not urls:
            return

        existing_video_urls = {
            row[0]
            for row in db.query(Video.url).filter(Video.url.in_(urls)).all()
            if row and row[0]
        }
        existing_discovered_urls = {
            row[0]
            for row in db.query(DiscoveredVideo.url).filter(DiscoveredVideo.url.in_(urls)).all()
            if row and row[0]
        }
        blocked = existing_video_urls | existing_discovered_urls

        rows: List[DiscoveredVideo] = []
        for item in results:
            url = (item.get("url") or "").strip()
            if not url or url in blocked:
                continue
            blocked.add(url)
            rows.append(
                DiscoveredVideo(
                    profile_id=profile.id,
                    profile_name=profile.name,
                    title=(item.get("title") or "Untitled").strip(),
                    url=url,
                    source_url=(item.get("source_url") or url).strip(),
                    thumbnail=(item.get("thumbnail") or item.get("thumbnail_path") or "").strip(),
                    duration=float(item.get("duration") or 0),
                    width=self._to_int(item.get("width"), 0),
                    height=self._to_int(item.get("height"), 0),
                    file_size_mb=float(item.get("file_size_mb") or 0),
                    source=(item.get("source") or "").strip(),
                    imported=False,
                    discovered_at=datetime.now(timezone.utc).replace(tzinfo=None),
                    categories=(item.get("categories") or "").strip(),
                    models=(item.get("models") or "").strip(),
                    related_src=(item.get("related_src") or "").strip(),
                    preview_mp4_url=(item.get("preview_mp4_url") or "").strip(),
                )
            )

        if rows:
            db.add_all(rows)
            db.commit()
            logger.info(
                "discovered_saved profile_id=%s profile_name=%s saved=%s",
                profile.id,
                profile.name,
                len(rows),
            )

    async def _import_videos(
        self,
        results: List[Dict[str, Any]],
        profile: DiscoveryProfile,
        db: Session,
    ) -> int:
        """
        Import filtered discovery results into `videos` and trigger async processing.
        """
        if not results:
            return 0

        date_part = datetime.now(timezone.utc).replace(tzinfo=None).strftime("%Y-%m-%d")
        prefix = (profile.batch_prefix or profile.name or "Auto").strip()
        batch_name = f"{prefix} • {date_part}"

        urls = [(r.get("url") or "").strip() for r in results if r.get("url")]
        existing_urls = {
            row[0]
            for row in db.query(Video.url).filter(Video.url.in_(urls)).all()
            if row and row[0]
        }

        imported = 0
        for item in results:
            url = (item.get("url") or "").strip()
            if not url or url in existing_urls:
                continue
            existing_urls.add(url)

            video = Video(
                title=(item.get("title") or "Untitled").strip(),
                url=url,
                source_url=(item.get("source_url") or url).strip(),
                thumbnail_path=(item.get("thumbnail") or item.get("thumbnail_path") or "").strip(),
                duration=float(item.get("duration") or 0),
                width=self._to_int(item.get("width"), 0),
                height=self._to_int(item.get("height"), 0),
                aspect_ratio=self._calculate_aspect_ratio(
                    self._to_int(item.get("width"), 0),
                    self._to_int(item.get("height"), 0),
                ),
                batch_name=batch_name,
                status="pending",
                storage_type="remote",
                tags=f"auto_discovery,{profile.name}" + (f",{item.get('models')}" if item.get('models') else "") + (f",{item.get('categories')}" if item.get('categories') else ""),
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
                file_size_mb=float(item.get("file_size_mb") or 0),
                quality=self._quality_from_height(self._to_int(item.get("height"), 0)),
                categories=(item.get("categories") or "").strip(),
                models=(item.get("models") or "").strip(),
                preview_mp4_url=(item.get("preview_mp4_url") or "").strip(),
            )
            db.add(video)
            db.flush()

            # Update discovered table records to imported state.
            db.query(DiscoveredVideo).filter(
                DiscoveredVideo.profile_id == profile.id,
                DiscoveredVideo.url == url,
            ).update(
                {
                    "imported": True,
                    "video_id": video.id,
                    "imported_at": datetime.now(timezone.utc).replace(tzinfo=None),
                },
                synchronize_session=False,
            )

            imported += 1
            asyncio.create_task(self._process_video_async(video.id))

        if imported:
            db.commit()
        return imported

    async def _process_video_async(self, video_id: int) -> None:
        """
        Process one imported video safely in a thread without blocking discovery run.
        """
        try:
            processor = VIPVideoProcessor()
            await processor.process_single_video(
                video_id,
                True,
                "mp4",
                "auto",
            )
        except Exception:
            logger.exception("video_processing_failed video_id=%s", video_id)

    def _calculate_aspect_ratio(self, width: int, height: int) -> Optional[str]:
        """
        Convert dimensions into common aspect ratio buckets.
        """
        if width <= 0 or height <= 0:
            return None
        ratio = width / height
        if 1.74 <= ratio <= 1.81:
            return "16:9"
        if 0.54 <= ratio <= 0.60:
            return "9:16"
        if 1.30 <= ratio <= 1.36:
            return "4:3"
        if 0.74 <= ratio <= 0.76:
            return "3:4"
        if 0.98 <= ratio <= 1.02:
            return "1:1"
        return f"{width}:{height}"

    def _is_duplicate_batch(self, urls: List[str], db: Session) -> Set[str]:
        """
        Batch duplicate check against videos and discovered_videos URLs in one pass each.
        """
        cleaned = list({u.strip() for u in urls if u and u.strip()})
        if not cleaned:
            return set()

        duplicates = {
            row[0]
            for row in db.query(Video.url).filter(Video.url.in_(cleaned)).all()
            if row and row[0]
        }
        duplicates |= {
            row[0]
            for row in db.query(DiscoveredVideo.url).filter(DiscoveredVideo.url.in_(cleaned)).all()
            if row and row[0]
        }
        return duplicates

    async def _search_single_source(
        self,
        engine: ExternalSearchEngine,
        query: str,
        source: str,
        profile_id: int,
        profile_name: str,
    ) -> List[Dict[str, Any]]:
        source_key = (source or "").strip().lower()
        if not source_key:
            return []

        for attempt in range(1, self.max_retries + 1):
            await self._apply_rate_limit(source_key)
            try:
                results = await engine.search_sources(query, [source_key])
                logger.info(
                    "search_source_ok profile_id=%s profile_name=%s source=%s attempt=%s results=%s",
                    profile_id,
                    profile_name,
                    source_key,
                    attempt,
                    len(results or []),
                )
                return results or []
            except Exception as exc:
                wait = self._backoff_delay(attempt)
                logger.warning(
                    "search_source_retry profile_id=%s source=%s attempt=%s wait_s=%.2f error=%s",
                    profile_id,
                    source_key,
                    attempt,
                    wait,
                    exc,
                )
                if attempt < self.max_retries:
                    await asyncio.sleep(wait)
        logger.error("search_source_failed profile_id=%s source=%s", profile_id, source_key)
        return []

    async def _search_general(
        self,
        engine: ExternalSearchEngine,
        query: str,
        profile_id: int,
        profile_name: str,
    ) -> List[Dict[str, Any]]:
        for attempt in range(1, self.max_retries + 1):
            await self._apply_rate_limit("global")
            try:
                results = await engine.search(query)
                logger.info(
                    "search_general_ok profile_id=%s profile_name=%s attempt=%s results=%s",
                    profile_id,
                    profile_name,
                    attempt,
                    len(results or []),
                )
                return results or []
            except Exception as exc:
                wait = self._backoff_delay(attempt)
                logger.warning(
                    "search_general_retry profile_id=%s attempt=%s wait_s=%.2f error=%s",
                    profile_id,
                    attempt,
                    wait,
                    exc,
                )
                if attempt < self.max_retries:
                    await asyncio.sleep(wait)
        logger.error("search_general_failed profile_id=%s", profile_id)
        return []

    async def _apply_rate_limit(self, domain_key: str) -> None:
        now = time.time()
        last = self._domain_last_request.get(domain_key, 0.0)
        min_spacing = self.request_delay + random.uniform(0.05, 0.35)
        delta = now - last
        if delta < min_spacing:
            await asyncio.sleep(min_spacing - delta)
        self._domain_last_request[domain_key] = time.time()

    def _backoff_delay(self, attempt: int) -> float:
        base = self.request_delay * (self.backoff_factor ** (attempt - 1))
        return min(base + random.uniform(0.05, 0.5), 20.0)

    def _notify(
        self,
        db: Session,
        profile: DiscoveryProfile,
        notification_type: str,
        message: str,
        video_count: int,
    ) -> None:
        db.add(
            DiscoveryNotification(
                profile_id=profile.id,
                profile_name=profile.name,
                notification_type=notification_type,
                message=message,
                video_count=video_count,
                read=False,
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
        )

    def _to_int(self, value: Any, default: int = 0) -> int:
        if value is None:
            return default
        if isinstance(value, (int, float)):
            return int(value)
        text = str(value).strip()
        if not text:
            return default
        if ":" in text:
            parts = [p for p in text.split(":") if p]
            try:
                if len(parts) == 3:
                    return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                if len(parts) == 2:
                    return int(parts[0]) * 60 + int(parts[1])
            except ValueError:
                return default
        digits = "".join(ch for ch in text if ch.isdigit())
        return int(digits) if digits else default

    def _quality_from_height(self, height: int) -> str:
        if height >= 2160:
            return "4K"
        if height >= 1440:
            return "2K"
        if height >= 1080:
            return "1080p"
        if height >= 720:
            return "720p"
        return "SD"

    def _is_title_likely_duplicate(self, title: str, db: Session) -> bool:
        """
        Lightweight title duplicate check to reduce near-duplicate imports.
        """
        compact = " ".join((title or "").lower().split())
        if len(compact) < 12:
            return False
        sample = compact[:80]
        found = (
            db.query(Video.id)
            .filter(or_(Video.title.ilike(f"%{sample}%"), Video.title == title))
            .limit(1)
            .first()
        )
        return found is not None


Python_worker: Optional[AutoDiscoveryWorker] = None


def get_worker() -> AutoDiscoveryWorker:
    """Return singleton auto-discovery worker."""
    global Python_worker
    if Python_worker is None:
        Python_worker = AutoDiscoveryWorker()
    return Python_worker


async def run_discovery_profile(profile_id: int) -> None:
    """Entry point for APScheduler/background tasks."""
    # Keep get_db import in module contract; use SessionLocal for explicit session lifecycle.
    _ = get_db
    worker = get_worker()
    await worker.run_profile(profile_id)
