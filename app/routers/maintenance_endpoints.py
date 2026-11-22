"""Library maintenance / repair API."""
from __future__ import annotations

import logging
import re
import asyncio

from fastapi import APIRouter, BackgroundTasks, Body, Depends
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import SessionLocal, Video, get_db
import app.maintenance as maintenance
from app.duplicate_detector import compute_all_phashes
from app.maintenance import (
    auto_resolve_duplicates,
    cleanup_broken_links,
    enrich_tags_for_selection,
    enrich_video_tags,
    fix_broken_thumbnails,
    get_duplicates_by_hash,
    get_duplicates_by_name,
    normalize_all_titles,
    retry_flagged_previews,
    scan_and_extract_file_sizes,
    sync_video_durations,
    refresh_poor_metadata,
    smart_rethumb_worker,
    smart_rethumb_videos,
    smart_rethumb_status,
    smart_rethumb_report,
    auto_smart_rethumb_tick,
    _resolve_rethumb_targets,
    _generate_thumb_from_stream,
    _local_video_file_path,
    _is_cyberfile_url,
    thumbnail_quality,
    metadata_backfill_candidates,
    metadata_backfill_videos,
)
from app.services import VIPVideoProcessor

router = APIRouter(tags=["maintenance"])


class EnrichTagsBody(BaseModel):
    video_ids: list[int] | None = None
    batch_name: str | None = None
    only_missing: bool = True
    limit: int = 250
    overwrite: bool = False


class EnrichSingleBody(BaseModel):
    overwrite: bool = False


class RethumbStartBody(BaseModel):
    limit: int = 100


class RethumbBatchBody(BaseModel):
    video_ids: list[int] | None = None
    batch_name: str | None = None
    concurrency: int | None = None   # None = dynamický limit (štart 32, max 64)
    limit: int = 300
    force: bool = False   # True = rethumb even videos that already have one
    all_batch: bool = False
    skip_hd: bool = False


@router.get("/maintenance/smart-rethumb/status")
def smart_rethumb_status_route(db: Session = Depends(get_db)):
    """How many videos need a thumbnail upgrade + whether the worker is running."""
    return smart_rethumb_status(db)


@router.get("/maintenance/smart-rethumb/report")
def smart_rethumb_report_route(db: Session = Depends(get_db)):
    """Counts + last-run summary + failed videos with reasons and suggested fixes."""
    return smart_rethumb_report(db)


@router.post("/maintenance/smart-rethumb/stop")
def smart_rethumb_stop_route():
    if maintenance.stop_smart_rethumb():
        return {"status": "stopping", "message": "Zastavujem rozpracované videá a pozastavujem automatické spúšťanie."}
    return {"status": "idle", "message": "Smart Rethumb práve nebeží; automatické spúšťanie je pozastavené."}


@router.post("/maintenance/smart-rethumb/start")
def smart_rethumb_start_route(background_tasks: BackgroundTasks,
                              body: RethumbStartBody = Body(default=RethumbStartBody())):
    """Continuously repair poor thumbnails in consecutive 100-item batches."""
    if maintenance._SMART_THUMB_RUNNING or maintenance._SMART_THUMB_PENDING:
        return {"status": "already_running", "message": "Smart rethumb už beží; sleduj aktuálny priebeh"}
    async def run():
        await auto_smart_rethumb_tick(limit=body.limit, manual=True)

    background_tasks.add_task(run)
    return {"status": "started", "message": "Smart rethumb spustený: dávky po 100 až do vyčerpania kandidátov"}


@router.post("/maintenance/smart-rethumb/batch")
def smart_rethumb_batch_route(background_tasks: BackgroundTasks,
                              body: RethumbBatchBody = Body(default=RethumbBatchBody())):
    """Regenerate thumbnails for a named batch or an explicit selection."""
    if maintenance._SMART_THUMB_RUNNING or maintenance._SMART_THUMB_PENDING:
        return {"status": "already_running", "message": "Smart rethumb už beží; sleduj aktuálny priebeh"}
    db = SessionLocal()
    try:
        targets = _resolve_rethumb_targets(
            db, video_ids=body.video_ids, batch_name=body.batch_name or "",
            limit=None if body.all_batch and body.batch_name else body.limit)
        # Skip-rule: videos that already carry a smart rethumb are dropped
        # immediately (unless force) and reported, not silently re-processed.
        if body.force:
            todo = targets
        else:
            def needs_rethumb(v):
                quality = thumbnail_quality(v)["status"]
                return not ((body.skip_hd and quality == "high") or
                            (v.smart_rethumb_at and quality not in {"poor", "unknown"}))
            todo = [v for v in targets if needs_rethumb(v)]
        skipped_done = len(targets) - len(todo)
        # detach the ids so the background task can re-query in its own session
        target_ids = [v.id for v in todo]
    finally:
        db.close()

    scope = (f"batch '{body.batch_name}'" if body.batch_name
             else f"{len(target_ids)} vybraných videí")

    if not target_ids:
        if skipped_done:
            return {"status": "all_skipped", "skipped_done": skipped_done,
                    "message": f"Všetkých {skipped_done} videí už má kvalitný náhľad — preskočené"}
        return {"status": "empty", "message": "Žiadne vhodné videá na rethumb"}

    if not maintenance.reserve_smart_rethumb():
        return {"status": "already_running", "message": "Smart rethumb už beží; sleduj aktuálny priebeh"}

    async def run():
        wdb = SessionLocal()
        try:
            rows = wdb.query(Video).filter(Video.id.in_(target_ids)).all()
            await smart_rethumb_videos(rows, concurrency=body.concurrency,
                                       skipped_done=skipped_done, label=scope)
        finally:
            wdb.close()
            maintenance.release_smart_rethumb_reservation()

    background_tasks.add_task(run)
    msg = f"Smart rethumb spustený pre {scope}"
    if skipped_done:
        msg += f" · {skipped_done} preskočených (už majú kvalitný náhľad)"
    return {"status": "started", "count": len(target_ids),
            "skipped_done": skipped_done, "message": msg}


class MetadataBackfillBody(BaseModel):
    video_ids: list[int] | None = None
    batch_name: str | None = None
    concurrency: int = 6
    limit: int = 1000


@router.get("/maintenance/metadata-backfill/status")
def metadata_backfill_status_route(batch_name: str = "", db: Session = Depends(get_db)):
    """How many videos are missing duration/resolution (optionally per batch)."""
    candidates = metadata_backfill_candidates(db, batch_name=batch_name or "", limit=100000)
    return {"needs_backfill": len(candidates)}


@router.post("/maintenance/metadata-backfill/start")
def metadata_backfill_start_route(background_tasks: BackgroundTasks,
                                  body: MetadataBackfillBody = Body(default=MetadataBackfillBody())):
    """Re-resolve duration/resolution/quality/size for existing videos that are
    missing it — direct-file hosts (Turbo, Coomer, CyberDrop, Pixeldrain, Bunkr,
    Filester …) whose metadata never got probed at import time."""
    db = SessionLocal()
    try:
        if body.video_ids:
            targets = db.query(Video).filter(Video.id.in_(body.video_ids)).all()
        else:
            targets = metadata_backfill_candidates(db, batch_name=body.batch_name or "", limit=body.limit)
        target_ids = [v.id for v in targets]
    finally:
        db.close()

    if not target_ids:
        return {"status": "empty", "message": "Žiadne videá nepotrebujú doplnenie metadát"}

    async def run():
        wdb = SessionLocal()
        try:
            rows = wdb.query(Video).filter(Video.id.in_(target_ids)).all()
            await metadata_backfill_videos(rows, concurrency=body.concurrency)
        finally:
            wdb.close()

    background_tasks.add_task(run)
    scope = (f"batch '{body.batch_name}'" if body.batch_name else f"{len(target_ids)} videí")
    return {"status": "started", "count": len(target_ids),
            "message": f"Doplnenie metadát spustené pre {scope}"}


class RefreshBunkrBody(BaseModel):
    video_ids: list[int] | None = None
    batch_name: str | None = None
    concurrency: int = 4
    limit: int = 2000
    rethumb: bool = True


@router.post("/maintenance/refresh-bunkr")
def refresh_bunkr_route(background_tasks: BackgroundTasks,
                        body: RefreshBunkrBody = Body(default=RefreshBunkrBody())):
    """Re-extract fresh Bunkr CDN URLs (tokens expire → 403), then optionally
    smart-rethumb so the cards get real frames instead of the album placeholder."""
    db = SessionLocal()
    try:
        q = db.query(Video).filter(
            or_(
                Video.source_url.ilike("%bunkr%"),
                Video.url.ilike("%bunkr%"),
                Video.url.ilike("%cdn.cr%"),
                Video.url.ilike("%scdn.st%"),
            )
        )
        if body.video_ids:
            q = q.filter(Video.id.in_(body.video_ids))
        elif body.batch_name:
            q = q.filter(Video.batch_name == body.batch_name)
        targets = q.limit(max(1, body.limit)).all()
        target_ids = [v.id for v in targets]
    finally:
        db.close()

    if not target_ids:
        return {"status": "empty", "message": "Žiadne Bunkr videá na obnovu"}

    async def run():
        from app.extractors.bunkr import BunkrExtractor
        from app.services import THUMB_DIR
        ex = BunkrExtractor()
        sem = asyncio.Semaphore(max(1, body.concurrency))
        healed = 0

        async def _one(vid_id: int):
            nonlocal healed
            async with sem:
                wdb = SessionLocal()
                try:
                    v = wdb.query(Video).get(vid_id)
                    if not v:
                        return
                    src = v.source_url or v.url or ""
                    try:
                        ok = await ex.heal(vid_id, src, wdb)
                    except Exception as exc:  # noqa: BLE001
                        logging.warning("[refresh-bunkr] heal failed for %s: %s", vid_id, exc)
                        ok = False
                    if ok:
                        healed += 1
                        if body.rethumb:
                            v2 = wdb.query(Video).get(vid_id)
                            try:
                                if await _generate_thumb_from_stream(v2, THUMB_DIR):
                                    v2.thumbnail_path = f"/static/thumbnails/thumb_{vid_id}.jpg"
                                    v2.preview_retry_needed = False
                                    wdb.commit()
                            except Exception as exc:  # noqa: BLE001
                                logging.warning("[refresh-bunkr] rethumb failed for %s: %s", vid_id, exc)
                finally:
                    wdb.close()

        await asyncio.gather(*[_one(i) for i in target_ids], return_exceptions=True)
        logging.info("[refresh-bunkr] healed %s/%s videos", healed, len(target_ids))

    background_tasks.add_task(run)
    scope = (f"batch '{body.batch_name}'" if body.batch_name
             else (f"{len(target_ids)} vybraných" if body.video_ids else f"{len(target_ids)} Bunkr videí"))
    return {"status": "started", "message": f"Bunkr refresh + rethumb spustený pre {scope}"}


@router.post("/maintenance/smart-rethumb/card/{video_id}")
async def smart_rethumb_card_route(video_id: int, background_tasks: BackgroundTasks,
                                   db: Session = Depends(get_db)):
    """Queue a manual reroll using the same reservation and progress as batches."""
    video = db.get(Video, video_id)
    if not video:
        return {"ok": False, "message": "Video sa nenašlo"}
    url = (video.url or "").strip().lower()
    from app.telegram_service import is_telegram_library_video
    if not is_telegram_library_video(video) and not maintenance._is_mega_video(video) and not url.startswith(("http://", "https://")) and not _local_video_file_path(video):
        return {"ok": False, "message": "Lokálny súbor sa nenašiel alebo nie je čitateľný"}
    if not maintenance.reserve_smart_rethumb():
        return {"ok": False, "message": "Smart rethumb už beží; počkaj na dokončenie aktuálnej dávky"}

    import random
    seek_frac = round(random.uniform(0.08, 0.9), 3)

    async def run():
        try:
            with SessionLocal() as work_db:
                row = work_db.get(Video, video_id)
                if row:
                    await smart_rethumb_videos([row], concurrency=1,
                                              label=f"Video #{video_id}", seek_frac=seek_frac)
        finally:
            maintenance.release_smart_rethumb_reservation()

    background_tasks.add_task(run)
    return {"ok": True, "queued": True, "message": "Náhľad sa generuje na pozadí; priebeh vidíš nad galériou"}


@router.get("/maintenance/duplicates/name")
def list_name_duplicates(db: Session = Depends(get_db)):
    return get_duplicates_by_name(db)


@router.get("/maintenance/duplicates/hash")
def list_hash_duplicates(db: Session = Depends(get_db), threshold: int = 5):
    return get_duplicates_by_hash(db, threshold)


@router.post("/maintenance/duplicates/resolve")
def resolve_dups(background_tasks: BackgroundTasks, type: str = Body(..., embed=True)):
    def run_resolve():
        db = SessionLocal()
        try:
            auto_resolve_duplicates(db, type)
        finally:
            db.close()

    background_tasks.add_task(run_resolve)
    return {"status": "started", "message": f"Auto-resolving {type} duplicates in background"}


@router.post("/maintenance/cleanup")
def cleanup_db(background_tasks: BackgroundTasks, delete_permanently: bool = Body(False, embed=True)):
    def run_cleanup():
        db = SessionLocal()
        try:
            cleanup_broken_links(db, delete_permanently)
        finally:
            db.close()

    background_tasks.add_task(run_cleanup)
    return {"status": "started", "message": "Database cleanup started in background"}


@router.post("/maintenance/normalize-titles")
def normalize_titles_route(background_tasks: BackgroundTasks):
    def run_normalize():
        db = SessionLocal()
        try:
            normalize_all_titles(db)
        finally:
            db.close()

    background_tasks.add_task(run_normalize)
    return {"status": "started", "message": "Title normalization started in background"}


@router.post("/maintenance/fix-thumbnails")
async def fix_thumbnails_route(background_tasks: BackgroundTasks):
    async def run_fix():
        db = SessionLocal()
        try:
            await fix_broken_thumbnails(db)
        finally:
            db.close()

    background_tasks.add_task(run_fix)
    return {"status": "started", "message": "Thumbnail repair started in background"}


@router.post("/maintenance/retry-flagged-previews")
def retry_flagged_previews_route(background_tasks: BackgroundTasks):
    def run_retry():
        db = SessionLocal()
        try:
            retry_flagged_previews(db)
        finally:
            db.close()

    background_tasks.add_task(run_retry)
    return {"status": "started", "message": "Flagged preview retry started in background"}


@router.post("/maintenance/sync-durations")
def sync_durations_route(background_tasks: BackgroundTasks):
    def run_sync():
        db = SessionLocal()
        try:
            sync_video_durations(db)
        finally:
            db.close()

    background_tasks.add_task(run_sync)
    return {"status": "started", "message": "Duration sync started in background"}


@router.post("/maintenance/scan-sizes")
def scan_sizes_route(background_tasks: BackgroundTasks):
    def run_scan():
        db = SessionLocal()
        try:
            scan_and_extract_file_sizes(db)
        finally:
            db.close()

    background_tasks.add_task(run_scan)
    return {"status": "started", "message": "File size scan started in background"}


@router.post("/maintenance/repair-import-streams")
def repair_import_streams_route(
    background_tasks: BackgroundTasks,
    limit: int = Body(250, embed=True),
):
    safe_limit = max(1, min(int(limit or 250), 1000))

    def _needs_repair(v: Video) -> bool:
        u = (v.url or "").strip().lower()
        su = (v.source_url or "").strip().lower()

        if not u:
            return False

        if ("http://" in u or "https://" in u) and not u.startswith(("http://", "https://", "file://", "/")):
            return True
        if "function/" in u and ("http://" in u or "https://" in u):
            return True

        if "camwhores.tv/videos/" in u:
            return True
        if "pixeldrain.com/u/" in u or "pixeldrain.com/l/" in u:
            return True

        if ("camwhores.tv/videos/" in su or "pixeldrain.com/u/" in su) and (v.duration or 0) == 0 and (v.height or 0) == 0:
            return True

        return False

    async def run_repair():
        db_local = SessionLocal()
        repaired = 0
        failed = 0
        scanned = 0
        queued = 0
        try:
            processor = VIPVideoProcessor()
            candidates = (
                db_local.query(Video)
                .filter(Video.storage_type == "remote")
                .filter(
                    or_(
                        Video.url.like("function/%"),
                        Video.url.like("%camwhores.tv/videos/%"),
                        Video.url.like("%pixeldrain.com/u/%"),
                        Video.url.like("%pixeldrain.com/l/%"),
                        Video.url.like("%https://%"),
                        Video.url.like("%http://%"),
                        Video.source_url.like("%camwhores.tv/videos/%"),
                        Video.source_url.like("%pixeldrain.com/u/%"),
                    )
                )
                .order_by(Video.id.desc())
                .limit(safe_limit)
                .all()
            )

            for v in candidates:
                scanned += 1
                if not _needs_repair(v):
                    continue
                queued += 1

                try:
                    if v.url:
                        m = re.search(r"https?://", v.url)
                        if m and m.start() > 0:
                            v.url = v.url[m.start():]
                            db_local.commit()

                    if (not v.source_url) and (
                        "camwhores.tv/videos/" in (v.url or "").lower()
                        or "pixeldrain.com/u/" in (v.url or "").lower()
                    ):
                        v.source_url = v.url
                        db_local.commit()

                    await processor.process_single_video(v.id, force=True, extractor="auto")
                    repaired += 1
                except Exception as e:
                    failed += 1
                    logging.warning(f"[repair-import-streams] Failed video {v.id}: {e}")

            logging.info(
                f"[repair-import-streams] Done scanned={scanned}, queued={queued}, repaired={repaired}, failed={failed}"
            )
        finally:
            db_local.close()

    background_tasks.add_task(run_repair)
    return {
        "status": "started",
        "message": "Import stream repair started in background",
        "limit": safe_limit,
    }


@router.post("/maintenance/full-optimization")
async def full_optimization(background_tasks: BackgroundTasks):
    def run_optimization():
        db_local = SessionLocal()
        try:
            logging.info("Starting Full Library Optimization...")
            res1 = normalize_all_titles(db_local)
            compute_all_phashes(db_local)
            res2 = auto_resolve_duplicates(db_local, "name")
            res3 = auto_resolve_duplicates(db_local, "hash")
            logging.info(f"Optimization complete: {res1}, {res2}, {res3}")
        finally:
            db_local.close()

    background_tasks.add_task(run_optimization)
    return {"status": "started", "message": "Full library optimization started in background"}


@router.post("/maintenance/refresh-metadata")
async def refresh_metadata_route(background_tasks: BackgroundTasks):
    async def run_refresh():
        db = SessionLocal()
        try:
            await refresh_poor_metadata(db)
        finally:
            db.close()

    background_tasks.add_task(run_refresh)
    return {"status": "started", "message": "Metadata refresh for incomplete videos started in background"}


@router.post("/maintenance/enrich-tags")
async def enrich_tags_route(
    payload: EnrichTagsBody,
    background_tasks: BackgroundTasks,
):
    def run_enrich():
        db = SessionLocal()
        try:
            asyncio.run(
                enrich_tags_for_selection(
                    db,
                    video_ids=payload.video_ids,
                    batch_name=payload.batch_name,
                    only_missing=payload.only_missing,
                    limit=payload.limit,
                    overwrite=payload.overwrite,
                )
            )
        finally:
            db.close()

    background_tasks.add_task(run_enrich)
    return {
        "status": "started",
        "message": "Tag enrichment started in background",
        "scope": {
            "video_ids": payload.video_ids or [],
            "batch_name": payload.batch_name,
            "only_missing": payload.only_missing,
            "limit": payload.limit,
            "overwrite": payload.overwrite,
        },
    }


@router.post("/maintenance/enrich-tags/{video_id}")
async def enrich_single_video_tags_route(
    video_id: int,
    payload: EnrichSingleBody,
    db: Session = Depends(get_db),
):
    video = db.query(Video).get(video_id)
    if not video:
        return {"updated": False, "reason": "video_not_found", "video_id": video_id}
    return await enrich_video_tags(db, video, overwrite=payload.overwrite)


# ── Batch AI Vision Tagger (Gemini) ──────────────────────────────────────────

from app.ai_tagger_batch import (
    AITagBatchRequest,
    cancel_ai_tag_batch,
    get_ai_tag_batch_status,
    run_ai_tag_batch_job,
)


@router.get("/maintenance/ai-tag-batch/status")
def get_ai_tag_batch_status_route():
    """Return live status of the batch AI Vision tagging process."""
    return get_ai_tag_batch_status()


@router.post("/maintenance/ai-tag-batch/start")
async def start_ai_tag_batch_route(
    background_tasks: BackgroundTasks,
    payload: AITagBatchRequest = Body(default=AITagBatchRequest()),
):
    """Start batch AI tagging on background via Google Gemini Vision."""
    status = get_ai_tag_batch_status()
    if status.get("running"):
        return {"status": "already_running", "message": "AI tagovanie už beží na pozadí."}

    background_tasks.add_task(run_ai_tag_batch_job, payload)
    return {
        "status": "started",
        "message": "AI tagovanie spustené na pozadí.",
        "config": payload.dict(),
    }


@router.post("/maintenance/ai-tag-batch/cancel")
def cancel_ai_tag_batch_route():
    """Cancel the currently running batch AI tagging process."""
    return cancel_ai_tag_batch()
