"""
Nexus Intel API — the five cross-source intelligence features.

    GET  /intel/prefetch     warm the stream cache for a video (hover path)
    GET  /intel/resolve      resolve a stream (served from cache when warm)
    GET  /intel/better       same title elsewhere, ideally higher quality
    GET  /intel/identity     one performer, merged across every source
    POST /intel/sentinel     scan saved links for rot + auto-mirror
    GET  /intel/semantic     meaning-based search over the owned library
    POST /intel/reindex      (re)build the semantic index
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from .. import nexus_intel as intel

logger = logging.getLogger(__name__)
router = APIRouter(tags=["nexus-intel"])


# ── 1. predictive pre-resolution ─────────────────────────────────────────────
@router.get("/intel/prefetch")
async def intel_prefetch(url: str = Query(..., min_length=8)):
    """Fire-and-mostly-forget warm-up triggered on hover. Returns minimal info."""
    data = await intel.resolve_cached(url, prefetch=True)
    return {"ok": bool(data), "cached": bool(data and data.get("cached")),
            "height": (data or {}).get("height", 0)}


@router.get("/intel/resolve")
async def intel_resolve(url: str = Query(..., min_length=8), refresh: bool = False):
    data = await intel.resolve_cached(url, refresh=refresh)
    if not data or not data.get("stream_url"):
        raise HTTPException(502, detail="Could not resolve a stream")
    return data


# ── 2. cross-source better quality ───────────────────────────────────────────
@router.get("/intel/better")
async def intel_better(
    title: str = Query(..., min_length=2),
    thumb: str = "",
    referer: str = "",
    height: int = 0,
):
    try:
        return await intel.find_better_quality(
            title=title, thumb=thumb, referer=referer, source_height=height)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"better-quality search failed: {exc}")


# ── 5. identity aggregation ──────────────────────────────────────────────────
@router.get("/intel/identity")
async def intel_identity(name: str = Query(..., min_length=2)):
    try:
        return await intel.aggregate_performer(name)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"identity aggregation failed: {exc}")


# ── 3. link-rot sentinel + mirror ────────────────────────────────────────────
@router.post("/intel/sentinel")
async def intel_sentinel(limit: int = 40, mirror: bool = True):
    try:
        return await intel.sentinel_scan(limit=limit, mirror=mirror)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"sentinel scan failed: {exc}")


# ── 4. semantic search ───────────────────────────────────────────────────────
@router.get("/intel/semantic")
async def intel_semantic(q: str = Query(..., min_length=2), top_k: int = 40):
    from .. import semantic_search as sem
    try:
        return {"query": q, "results": sem.search(q, top_k=top_k)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"semantic search failed: {exc}")


@router.post("/intel/reindex")
async def intel_reindex(rebuild: bool = False):
    from .. import semantic_search as sem
    try:
        return sem.build_index(rebuild=rebuild)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"reindex failed: {exc}")
