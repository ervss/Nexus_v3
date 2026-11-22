from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import CBIRSearchCache, DiscoveredVideo, Video, get_db
from ..related_media import resolve_video_thumb_bytes, validate_public_http_url
from ..related_query_planner import ai_analyze_for_related, split_csv
from ..related_recommendations import RelatedRecommendationService
from ..related_unified import (
    discover_creator_for_video,
    identify_video_on_namethatporn,
    probe_related_candidates,
    resolve_related_stream_url,
    stream_probe_related_candidates,
    stream_unified_related,
)
from ..source_catalog import filter_valid_discovery_sources
from .. import visual_semantic_index as vsi

router = APIRouter(tags=["related"])


class UnifiedRelatedRequest(BaseModel):
    """Vstupné parametre pre jednotný Related Search stream."""
    mode: str = "hybrid"
    intent: Literal["similar", "same_video", "same_creator"] = "similar"
    crop_box: Optional[Dict[str, float]] = None
    queries: Optional[List[str]] = None
    keywords: Optional[List[str]] = None
    web_sources: Optional[List[str]] = None
    cbir_engines: Optional[List[str]] = None
    frame_mode: str = "fast"
    yandex_text: Optional[str] = None
    min_duration: int = 0
    min_height: int = 0
    limit: int = 60
    force_refresh: bool = False
    auto_ai_analyze: bool = True
    auto_creator_pivot: bool = True
    image_url: Optional[str] = None
    title: Optional[str] = None


class DiscoverCreatorRequest(BaseModel):
    crop_box: Optional[Dict[str, float]] = None
    auto_save: bool = False


class RelatedProbeRequest(BaseModel):
    urls: List[str] = []
    limit: int = 80


class RelatedResolveStreamRequest(BaseModel):
    url: str

_FAST_DEFAULT_SOURCES = [
    "xvideos",
    "pornhub",
    "xhamster",
    "eporner",
    "spankbang",
    "noodlemagazine",
    "erome",
]


def _build_user_tag_pool(db: Session) -> set[str]:
    user_tags: set[str] = set()
    try:
        from sqlalchemy import text as sa_text

        top_tags_rows = db.execute(
            sa_text("SELECT tags FROM videos WHERE tags IS NOT NULL AND tags != '' LIMIT 300")
        ).all()
        for row in top_tags_rows:
            if row[0]:
                user_tags.update([t.strip().lower() for t in row[0].split(",") if t.strip()])
    except Exception as exc:
        logging.debug("[RELATED_RECS] Failed to load top user tags: %s", exc)
    return user_tags


def _compute_relevancy_score(title_str: str, tags_str: str = "", user_tag_pool: Optional[set[str]] = None) -> float:
    combined = f"{title_str} {tags_str}"
    if not combined.strip() or not user_tag_pool:
        return 0.0
    words = set(re.findall(r"\w+", combined.lower()))
    stopwords = {
        "the",
        "and",
        "webcam",
        "private",
        "public",
        "show",
        "cam",
        "video",
        "recording",
        "with",
        "for",
        "from",
    }
    words = {w for w in words if len(w) > 2 and w not in stopwords}
    if not words:
        return 0.0
    intersection = words.intersection(user_tag_pool)
    return round(len(intersection) / len(words) * 100, 1)


@router.get("/discovery/video/{video_id}/related")
async def get_discovered_video_related(
    video_id: int,
    limit: int = Query(48, ge=1, le=300),
    sources: Optional[str] = Query(None),
    refresh: bool = Query(False),
    min_score: float = Query(5.0, ge=0.0, le=100.0),
    search_depth: int = Query(1, ge=1, le=4),
    db: Session = Depends(get_db),
):
    """
    Fetches and parses related videos for a discovered video.
    Supports: Camwhores.tv (HTML scrape) and Pornhub (Webmasters JSON API).
    """
    discovered = db.query(DiscoveredVideo).filter(DiscoveredVideo.id == video_id).first()
    if not discovered:
        raise HTTPException(status_code=404, detail="Discovered video not found")

    user_tags = _build_user_tag_pool(db)
    source_url = (discovered.url or "").lower()
    is_pornhub = any(domain in source_url for domain in ("pornhub.com", "pornhub.org", "pornhub.net"))
    is_camwhores = any(domain in source_url for domain in ("camwhores.tv", "camwhores.video"))
    requested_sources = [s.strip() for s in (sources or "").split(",") if s.strip()]

    async def hybrid_related_response():
        return await RelatedRecommendationService(db).get_related(
            discovered,
            limit=limit,
            sources=requested_sources,
            refresh=refresh,
            include_library=False,
            min_score=min_score,
            search_depth=search_depth,
        )

    if is_pornhub:
        try:
            import requests as _requests

            title_words = (discovered.title or "").strip()
            models_str = (getattr(discovered, "models", "") or "").strip()

            if models_str:
                search_query = models_str.split(",")[0].strip()
            else:
                words = [w for w in re.findall(r"\w+", title_words) if len(w) > 2][:6]
                search_query = " ".join(words)

            if not search_query:
                return await hybrid_related_response()

            ph_api_url = "https://www.pornhub.com/webmasters/search"
            params = {
                "search": search_query,
                "page": 1,
                "per_page": 20,
                "format": "json",
                "ordering": "mostviewed",
                "period": "weekly",
            }
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "application/json",
                "Referer": "https://www.pornhub.com/",
            }

            def _ph_duration_to_seconds(dur_str: str) -> int:
                try:
                    parts = [int(p) for p in str(dur_str).split(":")]
                    if len(parts) == 2:
                        return parts[0] * 60 + parts[1]
                    if len(parts) == 3:
                        return parts[0] * 3600 + parts[1] * 60 + parts[2]
                except Exception:
                    pass
                return 0

            def _fetch_ph():
                return _requests.get(ph_api_url, params=params, headers=headers, timeout=12, verify=False)

            resp = await asyncio.to_thread(_fetch_ph)
            if resp.status_code != 200:
                logging.warning("[PH_RELATED] API returned %s for query=%r", resp.status_code, search_query)
                return await hybrid_related_response()

            ph_data = resp.json()
            ph_videos = ph_data.get("videos", [])
            source_viewkey = ""
            match = re.search(r"viewkey=([a-zA-Z0-9]+)", discovered.url or "")
            if match:
                source_viewkey = match.group(1)

            related_videos = []
            for item in ph_videos:
                item_viewkey = item.get("video_id", "")
                if source_viewkey and item_viewkey == source_viewkey:
                    continue

                item_title = item.get("title", "")
                item_tags_list = [t.get("tag_name", "") for t in (item.get("tags") or [])]
                item_tags_str = ",".join(item_tags_list)
                related_videos.append(
                    {
                        "title": item_title,
                        "url": item.get("url", ""),
                        "thumbnail": item.get("thumb") or item.get("default_thumb") or "",
                        "duration": _ph_duration_to_seconds(item.get("duration", "0:00")),
                        "views": int(item.get("views", 0)),
                        "height": int(item.get("height") or 0),
                        "quality": item.get("quality") or "",
                        "rating": int(item.get("rating") or 0),
                        "size_bytes": 0,
                        "source": "pornhub",
                        "relevancy_score": _compute_relevancy_score(item_title, item_tags_str, user_tags),
                        "reason": "pornhub related api",
                    }
                )

            related_videos.sort(key=lambda x: (x["relevancy_score"], x["views"]), reverse=True)
            if not related_videos:
                return await hybrid_related_response()

            logging.info("[PH_RELATED] query=%r results=%s", search_query, len(related_videos))
            return {
                "status": "success",
                "total": len(related_videos),
                "related_videos": related_videos,
                "source": "pornhub",
                "search_query": search_query,
            }
        except Exception as exc:
            logging.error("[PH_RELATED] Failed: %s", exc)
            return await hybrid_related_response()

    if is_camwhores:
        related_src = getattr(discovered, "related_src", "")
        if not related_src:
            match = re.search(r"/videos/(\d+)", discovered.url or "")
            if match:
                related_src = f"https://www.camwhores.tv/related_videos_html/{match.group(1)}/"

        if not related_src:
            return await hybrid_related_response()

        try:
            import requests as _requests
            from bs4 import BeautifulSoup
            from app.extractors.camwhores import CamwhoresExtractor

            extractor = CamwhoresExtractor()
            headers = extractor._base_headers(referer=discovered.url)

            def _fetch_cw():
                return _requests.get(related_src, headers=headers, timeout=10, verify=False)

            resp = await asyncio.to_thread(_fetch_cw)
            if resp.status_code != 200:
                return await hybrid_related_response()

            soup = BeautifulSoup(resp.text, "html.parser")
            items = soup.select(".item")
            related_videos = []
            for item in items:
                link = item.find("a", href=True)
                if not link:
                    continue

                href = link["href"]
                video_url = href if href.startswith("http") else f"https://www.camwhores.tv{href}"
                title_el = item.select_one(".title") or item.select_one("strong")
                title = title_el.get_text(strip=True) if title_el else link.get("title") or "Related Video"

                img = item.find("img")
                thumbnail = ""
                if img:
                    thumbnail = img.get("data-original") or img.get("src") or ""
                    if thumbnail.startswith("//"):
                        thumbnail = f"https:{thumbnail}"

                duration = 0
                duration_el = item.select_one(".duration") or item.select_one(".time")
                if duration_el:
                    dur_str = duration_el.get_text(strip=True)
                    parts = dur_str.split(":")
                    try:
                        if len(parts) == 2:
                            duration = int(parts[0]) * 60 + int(parts[1])
                        elif len(parts) == 3:
                            duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                    except Exception:
                        pass

                views = 0
                views_el = item.select_one(".views")
                if views_el:
                    try:
                        views = int(re.sub(r"[^\d]", "", views_el.get_text(strip=True)))
                    except Exception:
                        pass

                related_videos.append(
                    {
                        "title": title,
                        "url": video_url,
                        "thumbnail": thumbnail,
                        "duration": duration,
                        "views": views,
                        "height": 0,
                        "quality": "",
                        "rating": 0,
                        "size_bytes": 0,
                        "source": "camwhores",
                        "relevancy_score": _compute_relevancy_score(title, "", user_tags),
                        "reason": "camwhores related feed",
                    }
                )

            related_videos.sort(key=lambda x: x["relevancy_score"], reverse=True)
            if not related_videos:
                return await hybrid_related_response()

            return {
                "status": "success",
                "total": len(related_videos),
                "related_videos": related_videos,
                "source": "camwhores",
            }
        except Exception as exc:
            logging.error("[CAMWHORES_RELATED] Scrape failed for %s: %s", related_src, exc)
            return await hybrid_related_response()

    return await hybrid_related_response()


@router.get("/videos/{video_id}/related")
async def get_library_video_related(
    video_id: int,
    limit: int = Query(48, ge=1, le=300),
    sources: Optional[str] = Query(None),
    refresh: bool = Query(False),
    min_score: float = Query(5.0, ge=0.0, le=100.0),
    search_depth: int = Query(1, ge=1, le=4),
    db: Session = Depends(get_db),
):
    """Hybrid related recommendations for an already imported library video."""
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    requested_sources = [s.strip() for s in (sources or "").split(",") if s.strip()]
    return await RelatedRecommendationService(db).get_related(
        video,
        limit=limit,
        sources=requested_sources,
        refresh=refresh,
        include_library=True,
        min_score=min_score,
        search_depth=search_depth,
    )


@router.get("/discovery/video/{video_id}/related/stream")
async def get_discovered_video_related_stream(
    video_id: int,
    limit: int = Query(48, ge=1, le=300),
    sources: Optional[str] = Query(None),
    refresh: bool = Query(False),
    min_score: float = Query(5.0, ge=0.0, le=100.0),
    search_depth: int = Query(1, ge=1, le=4),
    db: Session = Depends(get_db),
):
    """SSE endpoint for discovered-video related search with progressive results."""
    discovered = db.query(DiscoveredVideo).filter(DiscoveredVideo.id == video_id).first()
    if not discovered:
        raise HTTPException(status_code=404, detail="Discovered video not found")

    requested_sources = [s.strip() for s in (sources or "").split(",") if s.strip()]
    effective_sources = filter_valid_discovery_sources(requested_sources) or _FAST_DEFAULT_SOURCES
    total_sources = len(effective_sources)

    queue: asyncio.Queue = asyncio.Queue()
    seen_sources: dict[str, int] = {}
    progress_state = {"pct": 0}

    async def progress_cb(source_key: str, count: int, status: str):
        prev_best = seen_sources.get(source_key, -1)
        is_new = source_key not in seen_sources
        seen_sources[source_key] = max(seen_sources.get(source_key, 0), count)
        if not is_new and count <= prev_best:
            return
        done = len(seen_sources)
        pct = min(90, int(done / max(total_sources, 1) * 90))
        if pct < progress_state["pct"]:
            pct = progress_state["pct"]
        progress_state["pct"] = pct
        label = source_key.replace("_", " ").title()
        icon = "✓" if status == "ok" else ("✗" if status == "timeout" else "!")
        if status == "ok" and count:
            msg = f"{icon} {label}: {count} výsledkov"
        elif status == "timeout":
            msg = f"{icon} {label}: timeout"
        else:
            msg = f"{icon} {label}"
        await queue.put({"type": "progress", "pct": pct, "done": done, "total": total_sources, "msg": msg, "source": source_key})

    async def batch_cb(payload: Dict[str, Any]):
        await queue.put({
            "type": "batch",
            "query": payload.get("query") or "",
            "source_type": payload.get("source_type") or "all",
            "related_videos": payload.get("related_videos") or [],
            "diagnostics": payload.get("diagnostics") or {},
        })

    async def generate():
        yield f"data: {json.dumps({'type': 'start', 'pct': 0, 'msg': 'Hľadám...', 'total_sources': total_sources})}\n\n"

        async def run_search():
            try:
                result = await RelatedRecommendationService(db).get_related(
                    discovered,
                    limit=limit,
                    sources=requested_sources,
                    refresh=refresh,
                    include_library=False,
                    min_score=min_score,
                    search_depth=search_depth,
                    progress_callback=progress_cb,
                    batch_callback=batch_cb,
                )
                await queue.put({"type": "done", "pct": 100, "result": result})
            except Exception as exc:
                await queue.put({"type": "error", "msg": str(exc)})

        search_task = asyncio.ensure_future(run_search())

        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=35.0)
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'type': 'error', 'msg': 'timeout'})}\n\n"
                search_task.cancel()
                break

            if event["type"] == "done":
                yield f"data: {json.dumps({'type': 'pct', 'pct': 95, 'msg': 'Hodnotím výsledky...'})}\n\n"
                yield f"data: {json.dumps(event)}\n\n"
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


async def _unified_sse_response(video_id: int, payload: UnifiedRelatedRequest, db: Session) -> StreamingResponse:
    """Vytvorí SSE odpoveď zo stream_unified_related s ochranou proti výpadkom."""
    opts = payload.model_dump()

    async def event_gen():
        try:
            async for event in stream_unified_related(video_id, opts, db):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as exc:
            logging.warning("[RELATED_UNIFIED] Stream zlyhal video_id=%s: %s", video_id, exc)
            yield f"data: {json.dumps({'type': 'error', 'msg': str(exc)[:220]})}\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/videos/{video_id}/related/unified/stream")
async def unified_video_related_stream(
    video_id: int,
    payload: UnifiedRelatedRequest = Body(default_factory=UnifiedRelatedRequest),
    db: Session = Depends(get_db),
):
    """Jednotný SSE stream spájajúci lokálny SigLIP2+FTS5, web a visual CBIR."""
    return await _unified_sse_response(video_id, payload, db)


@router.post("/cbir/unified/stream")
async def unified_external_cbir_stream(
    payload: UnifiedRelatedRequest = Body(...),
    db: Session = Depends(get_db),
):
    """Jednotný SSE stream pre externé náhľady (napr. Album Viewer)."""
    ext_url = str(payload.image_url or "").strip()
    if not ext_url and not (payload.keywords or payload.queries):
        raise HTTPException(status_code=422, detail="Zadaj náhľad alebo kľúčové slová")
    if ext_url:
        ok, reason = await asyncio.to_thread(validate_public_http_url, ext_url)
        if not ok:
            raise HTTPException(status_code=422, detail=reason or "Náhľad musí byť verejná HTTP(S) URL")
    return await _unified_sse_response(0, payload, db)


@router.post("/videos/{video_id}/related/ai-analyze")
async def unified_related_ai_analyze(
    video_id: int,
    payload: Optional[Dict[str, Any]] = Body(default=None),
    db: Session = Depends(get_db),
):
    """Spustí rýchlu AI analýzu náhľadu + názvu a vráti čisté tagy, modelky a queries."""
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video sa nenašlo")
    crop_box = (payload or {}).get("crop_box") if isinstance(payload, dict) else None
    thumb_bytes = await resolve_video_thumb_bytes(
        str(video.thumbnail_path or ""),
        referer=str(getattr(video, "thumbnail_referer", "") or getattr(video, "source_url", "") or ""),
        crop_box=crop_box,
    )
    if not thumb_bytes:
        raise HTTPException(status_code=422, detail="Video nemá čitateľný náhľad")

    try:
        res = await ai_analyze_for_related(thumb_bytes, raw_title=str(video.title or ""))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)[:220]) from exc

    # Uložíme AI tagy a odhadované mená do DB
    added_tags: List[str] = []
    try:
        existing_tags = {t.lower() for t in split_csv(video.tags)} | {t.lower() for t in split_csv(video.ai_tags)}
        current_ai = split_csv(video.ai_tags)
        for t in res.get("tags") or []:
            if t and t.lower() not in existing_tags:
                current_ai.append(t)
                existing_tags.add(t.lower())
                added_tags.append(t)
        if added_tags:
            video.ai_tags = ",".join(current_ai)
        if res.get("performers") and not (video.models or "").strip():
            video.models = ", ".join(res["performers"])
        db.commit()
    except Exception:
        db.rollback()

    return {
        **res,
        "added_tags": added_tags,
        "all_tags": ",".join(dict.fromkeys(split_csv(video.tags) + split_csv(video.ai_tags))),
        "models": video.models or "",
    }


@router.post("/videos/{video_id}/related/discover-creator")
async def unified_related_discover_creator(
    video_id: int,
    payload: Optional[DiscoverCreatorRequest] = Body(default=None),
    db: Session = Depends(get_db),
):
    """Zistí pravdepodobného tvorcu/performera z vizuálneho CBIR a AI analýzy."""
    req = payload or DiscoverCreatorRequest()
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video sa nenašlo")
    return await discover_creator_for_video(
        video_id,
        crop_box=req.crop_box,
        auto_save=bool(req.auto_save),
        db=db,
    )


@router.post("/videos/{video_id}/namethatporn/identify")
async def namethatporn_identify_gallery_video(
    video_id: int,
    payload: Optional[DiscoverCreatorRequest] = Body(default=None),
    db: Session = Depends(get_db),
):
    """Spustí NameThatPorn identifikáciu pre kartu v hlavnej galérii (ak chýba náhľad, vygeneruje ho)."""
    req = payload or DiscoverCreatorRequest()
    return await identify_video_on_namethatporn(
        video_id,
        auto_save=bool(req.auto_save),
        db=db,
    )


@router.post("/related/probe")
async def probe_related_results(payload: RelatedProbeRequest):
    """On-demand overenie rozlíšenia, dĺžky a veľkosti súboru pre vybrané alebo všetky výsledky."""
    items = await probe_related_candidates(payload.urls, limit=max(1, min(payload.limit or 80, 100)))
    return {"results": items}


@router.post("/related/probe/stream")
async def probe_related_results_stream(payload: RelatedProbeRequest):
    """SSE stream pre dávkové overenie dĺžky a rozlíšenia s priebežným progresom po položkách."""
    req_limit = max(1, min(payload.limit or len(payload.urls) or 80, 100))

    async def event_gen():
        async for ev in stream_probe_related_candidates(payload.urls, limit=req_limit):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/related/resolve-stream")
async def resolve_related_external_stream(payload: RelatedResolveStreamRequest):
    """Získa priamy stream externého výsledku pre okamžité prehratie v prehrávači Nexusu."""
    ok, reason = await asyncio.to_thread(validate_public_http_url, payload.url)
    if not ok:
        raise HTTPException(status_code=422, detail=reason or "Nepovolená URL")
    return await resolve_related_stream_url(payload.url)


@router.get("/videos/{video_id}/playback-item")
async def get_library_video_playback_item(video_id: int, db: Session = Depends(get_db)):
    """Vráti serializované Video z knižnice pre okamžité spustenie prehrávača z výsledkov Related Search."""
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video sa nenašlo")
    return {
        "id": int(video.id),
        "title": video.title or f"Video #{video.id}",
        "url": video.url or "",
        "source_url": video.source_url or "",
        "thumbnail_path": video.thumbnail_path or "",
        "duration": int(video.duration or 0),
        "height": int(video.height or 0),
        "width": int(video.width or 0),
        "storage_type": video.storage_type or "remote",
        "status": video.status or "ready",
        "tags": video.tags or "",
        "models": video.models or "",
        "batch_name": getattr(video, "batch_name", "") or "",
        "size": int(getattr(video, "file_size", None) or getattr(video, "size", 0) or 0),
        "is_favorite": bool(getattr(video, "is_favorite", False)),
    }


@router.get("/related/history")
async def get_related_search_history(
    limit: int = Query(25, ge=1, le=60),
    db: Session = Depends(get_db),
):
    """Vráti históriu nedávnych Related Search hľadaní zo serverovej cache databázy."""
    rows = (
        db.query(CBIRSearchCache, Video)
        .outerjoin(Video, CBIRSearchCache.video_id == Video.id)
        .order_by(CBIRSearchCache.created_at.desc())
        .limit(limit)
        .all()
    )
    items: List[Dict[str, Any]] = []
    for cache_row, vid in rows:
        req = dict(cache_row.request_json or {})
        resp = dict(cache_row.response_json or {})
        results = list(resp.get("results") or [])
        if not results:
            continue
        items.append({
            "id": str(cache_row.cache_key or "")[:16],
            "cache_key": cache_row.cache_key,
            "ts": int(cache_row.created_at.timestamp() * 1000) if cache_row.created_at else 0,
            "video_id": int(cache_row.video_id or 0),
            "video_title": (vid.title if vid else None) or f"Video #{cache_row.video_id}",
            "thumbnail_path": (vid.thumbnail_path if vid else "") or "",
            "duration": int((vid.duration if vid else 0) or 0),
            "height": int((vid.height if vid else 0) or 0),
            "mode": str(req.get("mode") or "hybrid"),
            "queries": list(resp.get("queries") or req.get("queries") or []),
            "creators": list(resp.get("detected_creators") or [])[:3],
            "count": len(results),
            "engines": resp.get("engines") or {},
            "results_preview": results[:40],
        })
    return {"items": items}


@router.delete("/related/history")
async def clear_related_search_history(db: Session = Depends(get_db)):
    """Vymaže históriu hľadaní uloženú v CBIRSearchCache."""
    deleted = db.query(CBIRSearchCache).delete()
    db.commit()
    return {"deleted": int(deleted or 0)}


@router.get("/related/visual-index/status")
async def related_visual_index_status():
    """Vráti aktuálny stav GPU SigLIP2 indexu lokálnej knižnice."""
    return vsi.get_status()


@router.post("/related/visual-index/sync")
async def related_visual_index_sync(
    background_tasks: BackgroundTasks,
    limit: int = Query(0, ge=0, le=50000),
):
    """Spustí inkrementálnu GPU indexáciu thumbnailov v knižnici na pozadí."""
    status = vsi.get_status()
    if not status.get("available"):
        raise HTTPException(status_code=503, detail="GPU OpenCLIP/PyTorch balíky nie sú dostupné")
    if not status.get("syncing"):
        background_tasks.add_task(vsi.sync_library_embeddings, limit=limit)
    return {"started": not status.get("syncing"), "status": vsi.get_status()}


@router.get("/videos/{video_id}/related/stream")
async def get_library_video_related_stream(
    video_id: int,
    limit: int = Query(48, ge=1, le=300),
    sources: Optional[str] = Query(None),
    refresh: bool = Query(False),
    min_score: float = Query(5.0, ge=0.0, le=100.0),
    search_depth: int = Query(1, ge=1, le=4),
    db: Session = Depends(get_db),
):
    """SSE endpoint — streams progress events then final JSON result."""
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    requested_sources = [s.strip() for s in (sources or "").split(",") if s.strip()]
    effective_sources = filter_valid_discovery_sources(requested_sources) or _FAST_DEFAULT_SOURCES
    total_sources = len(effective_sources)

    queue: asyncio.Queue = asyncio.Queue()
    seen_sources: dict[str, int] = {}
    progress_state = {"pct": 0}

    async def progress_cb(source_key: str, count: int, status: str):
        prev_best = seen_sources.get(source_key, -1)
        is_new = source_key not in seen_sources
        seen_sources[source_key] = max(seen_sources.get(source_key, 0), count)
        if not is_new and count <= prev_best:
            return
        done = len(seen_sources)
        pct = min(90, int(done / max(total_sources, 1) * 90))
        if pct < progress_state["pct"]:
            pct = progress_state["pct"]
        progress_state["pct"] = pct
        label = source_key.replace("_", " ").title()
        icon = "✓" if status == "ok" else ("✗" if status == "timeout" else "!")
        if status == "ok" and count:
            msg = f"{icon} {label}: {count} výsledkov"
        elif status == "timeout":
            msg = f"{icon} {label}: timeout"
        else:
            msg = f"{icon} {label}"
        await queue.put({"type": "progress", "pct": pct, "done": done, "total": total_sources, "msg": msg, "source": source_key})

    async def batch_cb(payload: Dict[str, Any]):
        await queue.put({
            "type": "batch",
            "query": payload.get("query") or "",
            "source_type": payload.get("source_type") or "all",
            "related_videos": payload.get("related_videos") or [],
            "diagnostics": payload.get("diagnostics") or {},
        })

    async def generate():
        yield f"data: {json.dumps({'type': 'start', 'pct': 0, 'msg': 'Hľadám...', 'total_sources': total_sources})}\n\n"

        async def run_search():
            try:
                result = await RelatedRecommendationService(db).get_related(
                    video,
                    limit=limit,
                    sources=requested_sources,
                    refresh=refresh,
                    include_library=True,
                    min_score=min_score,
                    search_depth=search_depth,
                    progress_callback=progress_cb,
                    batch_callback=batch_cb,
                )
                await queue.put({"type": "done", "pct": 100, "result": result})
            except Exception as exc:
                await queue.put({"type": "error", "msg": str(exc)})

        search_task = asyncio.ensure_future(run_search())

        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=35.0)
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'type': 'error', 'msg': 'timeout'})}\n\n"
                search_task.cancel()
                break

            if event["type"] == "done":
                yield f"data: {json.dumps({'type': 'pct', 'pct': 95, 'msg': 'Hodnotím výsledky...'})}\n\n"
                yield f"data: {json.dumps(event)}\n\n"
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


async def _unified_sse_response(video_id: int, payload: UnifiedRelatedRequest, db: Session) -> StreamingResponse:
    """Vytvorí SSE odpoveď zo stream_unified_related s ochranou proti výpadkom."""
    opts = payload.model_dump()

    async def event_gen():
        try:
            async for event in stream_unified_related(video_id, opts, db):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as exc:
            logging.warning("[RELATED_UNIFIED] Stream zlyhal video_id=%s: %s", video_id, exc)
            yield f"data: {json.dumps({'type': 'error', 'msg': str(exc)[:220]})}\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
