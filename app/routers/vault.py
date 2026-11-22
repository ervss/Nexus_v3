"""Local Vault Search API — instant search & import across all local Nexus stores."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import check_auth
from ..creator_thumbs import promote_creator_thumb_to_library
from ..database import ForumLink, get_db, utcnow
from ..intake import IntakeCandidate, IntakeImportRequest, create_import_job, intake_worker, serialize_job
from ..telegram_service import save_telegram_library_video, telegram_import_spec
from ..vault_search import get_vault_stats, search_local_vault

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/vault", tags=["vault"])


class VaultImportItem(BaseModel):
    id: str = ""
    bucket: str = "forum"
    url: str = ""
    source_url: str = ""
    title: str = ""
    thumbnail: str = ""
    duration_sec: int = 0
    height: int = 0
    quality: str = ""
    size_mb: Optional[float] = None
    telegram_meta: Optional[Dict[str, Any]] = None


class VaultImportRequest(BaseModel):
    items: List[VaultImportItem] = Field(default_factory=list, min_length=1, max_length=100)
    batch_name: str = "Local Vault"


@router.get("/stats")
async def vault_stats(
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    return get_vault_stats(db)


@router.get("/search")
async def vault_search(
    q: str = Query("", max_length=300),
    buckets: str = Query("", description="CSV of bucket IDs (library,telegram,forum,filester,mega,queue)"),
    min_height: int = Query(0, ge=0, le=4320),
    min_duration: int = Query(0, ge=0, le=86400),
    min_size_mb: float = Query(0, ge=0, le=100000),
    only_playable: bool = Query(False),
    only_importable: bool = Query(False),
    source: str = Query("", max_length=120),
    sort: str = Query("relevance", max_length=32),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0, le=50000),
    browse: bool = Query(False),
    deduplicate: bool = Query(True),
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    selected = [b.strip().lower() for b in (buckets or "").split(",") if b.strip()]
    return search_local_vault(
        db,
        q,
        buckets=selected or None,
        min_height=min_height,
        min_duration=min_duration,
        min_size_mb=min_size_mb,
        only_playable=only_playable,
        only_importable=only_importable,
        source_filter=source,
        sort=sort,
        limit_per_bucket=limit,
        offset=offset,
        browse=browse,
        deduplicate=deduplicate,
    )


@router.post("/import")
async def vault_import(
    body: VaultImportRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    batch = (body.batch_name or "Local Vault").strip()[:255] or "Local Vault"
    tg_imported: List[Dict[str, Any]] = []
    url_candidates: List[IntakeCandidate] = []
    forum_link_ids: List[int] = []

    for item in body.items:
        raw_thumb = (item.thumbnail or ((item.telegram_meta or {}).get("thumbnail") if isinstance(item.telegram_meta, dict) else "") or "").strip()
        promoted_thumb = promote_creator_thumb_to_library(raw_thumb) or raw_thumb

        if item.bucket == "telegram" and item.telegram_meta:
            meta = dict(item.telegram_meta)
            if promoted_thumb:
                meta["thumbnail"] = promoted_thumb
            spec = telegram_import_spec(
                meta.get("url") or meta.get("stream_url") or item.url,
                meta,
            )
            if spec and spec.get("chat_id") and spec.get("message_id"):
                video, created = save_telegram_library_video(db, spec, batch_name=batch)
                if promoted_thumb and (
                    "/api/v1/telegram/thumb/" in promoted_thumb
                    or "/static/thumbnails/cr_" in promoted_thumb
                ):
                    video.thumbnail_path = promoted_thumb
                    if not video.smart_rethumb_at:
                        video.smart_rethumb_at = utcnow()
                    db.commit()
                tg_imported.append({
                    "id": video.id,
                    "created": created,
                    "title": video.title,
                    "thumbnail": video.thumbnail_path,
                })
                continue

        target_url = (item.source_url or item.url or "").strip()
        if not target_url.startswith(("http://", "https://")):
            continue
        url_candidates.append(
            IntakeCandidate(
                url=target_url,
                source_url=target_url,
                title=item.title or "Untitled",
                thumbnail=promoted_thumb,
                duration=float(item.duration_sec or 0),
                height=int(item.height or 0),
                quality=item.quality or "",
                file_size_mb=float(item.size_mb or 0),
                source=f"vault:{item.bucket}",
            )
        )
        if item.bucket == "forum" and item.id.startswith("forum:"):
            try:
                forum_link_ids.append(int(item.id.split(":", 1)[1]))
            except ValueError:
                pass

    job_payload = None
    if url_candidates:
        job = create_import_job(
            IntakeImportRequest(
                candidates=url_candidates,
                batch_name=batch,
                source_mode="mixed",
                auto_metadata=True,
                playwright_fallback=True,
            ),
            db,
        )
        if forum_link_ids:
            db.query(ForumLink).filter(ForumLink.id.in_(forum_link_ids)).update(
                {"status": "imported"}, synchronize_session=False
            )
            db.commit()
        intake_worker.start()
        job_payload = serialize_job(job)

    if not tg_imported and not url_candidates:
        raise HTTPException(status_code=400, detail="Žiadna položka nemala platnú URL ani Telegram ID na import.")

    return {
        "success": True,
        "telegram_imported": len(tg_imported),
        "telegram_items": tg_imported,
        "queued_urls": len(url_candidates),
        "job": job_payload,
    }
