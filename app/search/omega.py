"""4-vrstvový Omni-Search orchestrátor s progresívnym SSE streamingom, presetmi, cache a Circuit Breakerom."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Any, AsyncIterator, Dict, List, Optional, Set, Tuple

from app.database import SessionLocal
from app.extractors.circuit_breaker import extractor_circuit_breaker
from app.vault_search import search_local_vault

from .adapters import (
    ApiFamilyAdapter,
    DorkAggregatorAdapter,
    KvsFamilyAdapter,
    TelethonSearchAdapter,
    TubeEngineAdapter,
    WpDleFamilyAdapter,
)
from .adapters.dork_adapter import DEFAULT_DORK_GROUPS
from .adapters.kvs_adapter import KVS_SITES
from .adapters.tube_adapter import TUBE_ENGINE_SITES
from .adapters.wp_dle_adapter import WP_DLE_SITES
from .base import AdapterBatch, matches_query_strictly, normalize_result

logger = logging.getLogger("nexus.omega_search")

ALL_LAYERS: tuple[str, ...] = ("local_vault", "telethon", "api", "tube", "kvs", "wp_dle", "dork")

# Predvoľby (Profily zdrojov) pre jednoduché ovládanie z UI jedným klikom
OMEGA_PRESETS: Dict[str, Dict[str, Any]] = {
    "all": {
        "label": "Všetko (Omni)",
        "layers": set(ALL_LAYERS),
        "sources": None,
    },
    "leaks": {
        "label": "Leaks & Creators",
        "layers": {"local_vault", "telethon", "api", "tube", "wp_dle", "dork"},
        "sources": {
            "reddit",
            "erome", "pimpbunny",
            "leakporner", "mypornerleak", "hornysimp", "internetchicks",
            "djav", "nsfw247", "baddiehub", "cyberleaks", "leakedzone",
            "dork_leaks_a", "dork_tubes_b", "dork_albums", "dork_forums", "telegram", "telegram_fts", "telegram_live",
        },
    },
    "tubes": {
        "label": "HD Tubes",
        "layers": {"local_vault", "api", "tube", "kvs", "dork"},
        "sources": {
            "eporner", "redgifs",
            "pornhub", "xvideos", "xhamster", "noodlemagazine", "pimpbunny",
            "hqporner", "pornone", "beeg", "spankbang",
            "whoreshub", "porntrex", "camwhores", "camwhoresbay", "thisvid",
            "thothub", "xxbrits", "4kporno", "analdin", "anysex", "drtuber", "tnaflix",
            "dork_tubes_a", "dork_tubes_b",
        },
    },
    "fast": {
        "label": "Fast / Bez HTML",
        "layers": {"local_vault", "api", "dork"},
        "sources": None,
    },
}

# Krátkodobá cache externých dávok (TTL 180 s), aby opakované / filtrované dopyty nehitovali weby znova
_OMEGA_CACHE_TTL_S = float(os.getenv("OMEGA_CACHE_TTL_S", "180"))
_OMEGA_BATCH_CACHE: Dict[Tuple[str, str, int], Tuple[float, List[AdapterBatch]]] = {}

OMEGA_SOURCE_CATALOG: Dict[str, Any] = {
    "layers": list(ALL_LAYERS),
    "presets": [{"key": k, "label": v["label"], "layers": sorted(v["layers"])} for k, v in OMEGA_PRESETS.items()],
    "tube": [{"key": s.key, "label": s.label, "domain": s.domain} for s in TUBE_ENGINE_SITES],
    "kvs": [{"key": s.key, "label": s.label, "origin": s.origin} for s in KVS_SITES],
    "wp_dle": [{"key": s.key, "label": s.label, "origin": s.origin, "kind": s.kind} for s in WP_DLE_SITES],
    "api": [
        {"key": "eporner", "label": "Eporner API"},
        {"key": "redgifs", "label": "RedGIFs v2 API"},
        {"key": "reddit", "label": "Reddit JSON API"},
    ],
    "dork_groups": [{"key": k, "label": lbl, "domains": list(doms)} for k, lbl, doms in DEFAULT_DORK_GROUPS],
    "telethon": [{"key": "telegram_fts", "label": "Telegram FTS5"}, {"key": "telegram_live", "label": "Telegram Live (Telethon)"}],
    "local_vault": [{"key": "local_vault", "label": "Local Vault (Library / Telegram / Forum / Filester / MEGA / Queue)"}],
}


def clear_omega_cache() -> int:
    cnt = len(_OMEGA_BATCH_CACHE)
    _OMEGA_BATCH_CACHE.clear()
    return cnt


def _tokenize_query(query: str) -> List[str]:
    return [t for t in re.split(r"[\s\-_.,/|]+", (query or "").strip().lower()) if len(t) >= 2]


def _score_relevance(item: Dict[str, Any], clean_query: str, tokens: List[str]) -> int:
    """Vypočíta relevance skóre pre zoraďovanie v reálnom čase (plná zhoda hore)."""
    title_low = str(item.get("title") or "").lower()
    url_low = str(item.get("url") or "").lower()
    desc_low = str(item.get("description") or "").lower()
    hay = f"{title_low} {url_low} {desc_low}"

    phrase = clean_query.lower()
    score = 0
    if phrase and phrase in title_low:
        score += 300
    elif phrase and phrase in url_low:
        score += 220

    if tokens:
        title_hits = sum(1 for tok in tokens if tok in title_low)
        hay_hits = sum(1 for tok in tokens if tok in hay)
        if title_hits == len(tokens):
            score += 180
        elif hay_hits == len(tokens):
            score += 120
        score += title_hits * 35 + hay_hits * 15

    # Malý bonus za kvalitu a lokálny vault
    h = int(item.get("height") or 0)
    if h >= 2160:
        score += 25
    elif h >= 1080:
        score += 18
    elif h >= 720:
        score += 10
    if item.get("layer") == "local_vault":
        score += 15
    return score


def _vault_item_to_omega(item: Dict[str, Any]) -> Dict[str, Any]:
    bucket = str(item.get("bucket") or "vault")
    label = str(item.get("bucket_label") or bucket.title())
    target_url = str(item.get("source_url") or item.get("url") or item.get("playable_url") or "").strip()
    return normalize_result(
        title=str(item.get("title") or target_url),
        url=target_url,
        source=f"Vault · {label}",
        source_key=f"vault_{bucket}",
        layer="local_vault",
        adapter="vault_search",
        thumbnail=str(item.get("thumbnail") or ""),
        duration=int(item.get("duration_sec") or 0),
        quality=str(item.get("quality") or ""),
        height=int(item.get("height") or 0),
        description=str(item.get("subtitle") or f"Local Vault ({label})"),
        extra={
            "bucket": bucket,
            "playable_url": item.get("playable_url") or "",
            "in_library": bool(item.get("in_library", bucket == "library")),
            "size_mb": item.get("size_mb"),
        },
    )


def _run_local_vault_sync(query: str, min_quality: int, per_source_limit: int) -> Dict[str, Any]:
    with SessionLocal() as db:
        return search_local_vault(
            db,
            query,
            min_height=min_quality,
            limit_per_bucket=min(max(per_source_limit, 15), 100),
        )


def _dedupe_and_score_items(
    items: List[Dict[str, Any]],
    seen_urls: Set[str],
    min_quality: int,
    clean_query: str,
    tokens: List[str],
) -> List[Dict[str, Any]]:
    unique: List[Dict[str, Any]] = []
    for item in items:
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        norm = url.rstrip("/").lower()
        if norm in seen_urls:
            continue
        height = int(item.get("height") or 0)
        if min_quality > 0 and height > 0 and height < min_quality:
            continue
        if clean_query and item.get("layer") not in ("local_vault", "telethon"):
            perf = str(item.get("performer") or item.get("uploader") or "")
            tags_raw = item.get("tags") or []
            tags_str = " ".join(str(t) for t in tags_raw) if isinstance(tags_raw, (list, tuple)) else str(tags_raw)
            if not matches_query_strictly(
                clean_query,
                f"{item.get('title') or ''} {perf}".strip(),
                url,
                extra_text=f"{perf} {tags_str} {item.get('description') or ''}".strip(),
            ):
                continue
        seen_urls.add(norm)
        enriched = dict(item)
        rel = _score_relevance(enriched, clean_query, tokens)
        enriched["omega_relevance"] = rel
        enriched["relevance_score"] = rel
        unique.append(enriched)
    return unique


async def stream_omega_search(
    query: str,
    *,
    preset: Optional[str] = None,
    layers: Optional[Set[str]] = None,
    source_keys: Optional[Set[str]] = None,
    min_quality: int = 0,
    per_source_limit: int = 20,
    timeout_s: float = 10.0,
    use_cache: bool = True,
) -> AsyncIterator[Dict[str, Any]]:
    """Async generátor progresívnych SSE udalostí (`meta`, `results`, `source_status`, `done`)."""
    t0 = time.perf_counter()
    clean_query = (query or "").strip()
    tokens = _tokenize_query(clean_query)

    preset_key = (preset or "all").strip().lower()
    preset_cfg = OMEGA_PRESETS.get(preset_key) or OMEGA_PRESETS["all"]
    active_layers = set(layers) if layers else set(preset_cfg["layers"])
    effective_sources = set(source_keys) if source_keys else (set(preset_cfg["sources"]) if preset_cfg["sources"] else None)

    seen_urls: Set[str] = set()
    total_results = 0
    stats_by_source: Dict[str, Dict[str, Any]] = {}

    cache_key = (clean_query.lower(), f"{preset_key}:{','.join(sorted(active_layers))}:{','.join(sorted(effective_sources or []))}", int(per_source_limit))
    cached_batches: Optional[List[AdapterBatch]] = None
    if use_cache and _OMEGA_CACHE_TTL_S > 0:
        hit = _OMEGA_BATCH_CACHE.get(cache_key)
        if hit and (time.monotonic() - hit[0]) < _OMEGA_CACHE_TTL_S:
            cached_batches = hit[1]

    logger.info(
        "[OMEGA] START query=%r preset=%s layers=%s min_quality=%s cache_hit=%s",
        clean_query,
        preset_key,
        sorted(active_layers),
        min_quality,
        bool(cached_batches is not None),
    )
    yield {
        "event": "meta",
        "data": {
            "query": clean_query,
            "preset": preset_key,
            "layers": sorted(active_layers),
            "min_quality": min_quality,
            "cache_hit": bool(cached_batches is not None),
            "started_at_ms": 0,
        },
    }

    # --- VRSTVA 1: Okamžitý Local Vault ---
    if "local_vault" in active_layers:
        t_vault = time.perf_counter()
        try:
            vault_payload = await asyncio.to_thread(
                _run_local_vault_sync, clean_query, min_quality, per_source_limit
            )
            converted = [_vault_item_to_omega(it) for it in (vault_payload.get("items") or [])]
            fresh = _dedupe_and_score_items(converted, seen_urls, min_quality, clean_query, tokens)
            elapsed_v = int((time.perf_counter() - t_vault) * 1000)
            total_results += len(fresh)
            stats_by_source["local_vault"] = {
                "layer": "local_vault",
                "status": "ok" if fresh else "empty",
                "count": len(fresh),
                "elapsed_ms": elapsed_v,
                "bucket_counts": vault_payload.get("bucket_counts") or {},
            }
            logger.info("[OMEGA][LOCAL_VAULT] %d výsledkov za %d ms", len(fresh), elapsed_v)
            yield {
                "event": "results" if fresh else "source_status",
                "data": {
                    "layer": "local_vault",
                    "adapter": "vault_search",
                    "source_key": "local_vault",
                    "source_label": "Local Vault",
                    "status": "ok" if fresh else "empty",
                    "count": len(fresh),
                    "elapsed_ms": elapsed_v,
                    "bucket_counts": vault_payload.get("bucket_counts") or {},
                    "items": fresh,
                },
            }
        except Exception as exc:
            elapsed_v = int((time.perf_counter() - t_vault) * 1000)
            logger.warning("[OMEGA][LOCAL_VAULT] chyba: %s (%d ms)", exc, elapsed_v)
            stats_by_source["local_vault"] = {"layer": "local_vault", "status": "error", "error": str(exc), "elapsed_ms": elapsed_v}
            yield {
                "event": "source_status",
                "data": {
                    "layer": "local_vault",
                    "adapter": "vault_search",
                    "source_key": "local_vault",
                    "source_label": "Local Vault",
                    "status": "error",
                    "error": str(exc),
                    "elapsed_ms": elapsed_v,
                },
            }

    # --- CACHE HIT pre externé vrstvy ---
    if cached_batches is not None:
        for batch in cached_batches:
            fresh = _dedupe_and_score_items(batch.items, seen_urls, min_quality, clean_query, tokens)
            total_results += len(fresh)
            status = "ok" if fresh else ("empty" if batch.status == "ok" else batch.status)
            stats_by_source[batch.source_key] = {
                "layer": batch.layer,
                "adapter": batch.adapter,
                "label": batch.source_label,
                "status": status,
                "count": stats_by_source.get(batch.source_key, {}).get("count", 0) + len(fresh),
                "elapsed_ms": 0,
                "error": batch.error,
                "cached": True,
            }
            payload = {
                "layer": batch.layer,
                "adapter": batch.adapter,
                "source_key": batch.source_key,
                "source_label": batch.source_label,
                "status": status,
                "count": len(fresh),
                "elapsed_ms": 0,
                "cached": True,
            }
            if batch.error:
                payload["error"] = batch.error
            if fresh:
                payload["items"] = fresh
                yield {"event": "results", "data": payload}
            else:
                yield {"event": "source_status", "data": payload}

        total_ms = int((time.perf_counter() - t0) * 1000)
        yield {
            "event": "done",
            "data": {
                "query": clean_query,
                "preset": preset_key,
                "cache_hit": True,
                "total_results": total_results,
                "elapsed_ms": total_ms,
                "sources": stats_by_source,
                "circuit_breaker": extractor_circuit_breaker.snapshot(),
            },
        }
        return

    # --- VRSTVY 2–4 + TELETHON: Paralelné spúšťanie s okamžitým streamovaním ---
    queue: asyncio.Queue[Optional[AdapterBatch]] = asyncio.Queue()
    workers: List[asyncio.Task] = []
    collected_for_cache: List[AdapterBatch] = []

    def _enqueue_batch_task(coro_task: asyncio.Task) -> asyncio.Task:
        async def _runner() -> None:
            try:
                batch = await coro_task
                await queue.put(batch)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await queue.put(AdapterBatch("unknown", "worker", "unknown", "Worker", status="error", error=str(exc)))

        return asyncio.create_task(_runner())

    if "api" in active_layers:
        api_adapter = ApiFamilyAdapter(timeout_s=min(timeout_s, 8.0))
        for t in api_adapter.iter_tasks(clean_query, selected_keys=effective_sources, per_source_limit=per_source_limit):
            workers.append(_enqueue_batch_task(t))

    if "tube" in active_layers:
        tube_adapter = TubeEngineAdapter(concurrency=6, timeout_s=min(max(timeout_s, 10.0), 14.0))
        for t in tube_adapter.iter_tasks(clean_query, selected_keys=effective_sources, per_source_limit=per_source_limit):
            workers.append(_enqueue_batch_task(t))

    if "kvs" in active_layers:
        kvs_adapter = KvsFamilyAdapter(concurrency=8, timeout_s=min(timeout_s, 7.0))
        for t in kvs_adapter.iter_tasks(clean_query, selected_keys=effective_sources, per_source_limit=per_source_limit):
            workers.append(_enqueue_batch_task(t))

    if "wp_dle" in active_layers:
        wp_adapter = WpDleFamilyAdapter(concurrency=8, timeout_s=min(timeout_s, 7.0))
        for t in wp_adapter.iter_tasks(clean_query, selected_keys=effective_sources, per_source_limit=per_source_limit):
            workers.append(_enqueue_batch_task(t))

    if "dork" in active_layers:
        dork_adapter = DorkAggregatorAdapter(timeout_s=min(timeout_s, 8.0))
        for t in dork_adapter.iter_tasks(clean_query, selected_keys=effective_sources, per_group_limit=per_source_limit):
            workers.append(_enqueue_batch_task(t))

    if "telethon" in active_layers and (not effective_sources or {"telegram", "telegram_fts", "telegram_live"} & effective_sources):
        tele_adapter = TelethonSearchAdapter(live_limit=max(per_source_limit, 25), timeout_s=min(max(timeout_s, 10.0), 18.0))

        async def _tele_pump() -> None:
            try:
                async for batch in tele_adapter.search_stream(clean_query, limit=per_source_limit):
                    await queue.put(batch)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await queue.put(AdapterBatch("telethon", "telethon_adapter", "telegram_live", "Telegram Live", status="error", error=str(exc)))

        workers.append(asyncio.create_task(_tele_pump()))

    if workers:
        async def _sentinel() -> None:
            await asyncio.gather(*workers, return_exceptions=True)
            await queue.put(None)

        sentinel_task = asyncio.create_task(_sentinel())
    else:
        sentinel_task = None
        await queue.put(None)

    completed_cleanly = False
    try:
        while True:
            batch = await queue.get()
            if batch is None:
                completed_cleanly = True
                break

            if batch.status == "ok" and batch.items:
                collected_for_cache.append(batch)

            fresh = _dedupe_and_score_items(batch.items, seen_urls, min_quality, clean_query, tokens)
            total_results += len(fresh)
            status = "ok" if fresh else ("empty" if batch.status == "ok" else batch.status)
            stats_by_source[batch.source_key] = {
                "layer": batch.layer,
                "adapter": batch.adapter,
                "label": batch.source_label,
                "status": status,
                "count": stats_by_source.get(batch.source_key, {}).get("count", 0) + len(fresh),
                "elapsed_ms": batch.elapsed_ms,
                "error": batch.error,
            }
            payload: Dict[str, Any] = {
                "layer": batch.layer,
                "adapter": batch.adapter,
                "source_key": batch.source_key,
                "source_label": batch.source_label,
                "status": status,
                "count": len(fresh),
                "elapsed_ms": batch.elapsed_ms,
                "query_used": batch.query_used,
            }
            if batch.error:
                payload["error"] = batch.error
            if fresh:
                payload["items"] = fresh
                yield {"event": "results", "data": payload}
            else:
                yield {"event": "source_status", "data": payload}
    finally:
        for w in workers:
            if not w.done():
                w.cancel()
        if sentinel_task and not sentinel_task.done():
            sentinel_task.cancel()

    if completed_cleanly and use_cache and _OMEGA_CACHE_TTL_S > 0 and collected_for_cache:
        if len(_OMEGA_BATCH_CACHE) >= 40:
            _OMEGA_BATCH_CACHE.pop(next(iter(_OMEGA_BATCH_CACHE)))
        _OMEGA_BATCH_CACHE[cache_key] = (time.monotonic(), collected_for_cache)

    total_ms = int((time.perf_counter() - t0) * 1000)
    cb_snapshot = extractor_circuit_breaker.snapshot()
    logger.info(
        "[OMEGA] DONE query=%r preset=%s total=%d elapsed=%dms open_circuits=%d",
        clean_query,
        preset_key,
        total_results,
        total_ms,
        sum(1 for c in cb_snapshot if c.get("state") == "open"),
    )
    yield {
        "event": "done",
        "data": {
            "query": clean_query,
            "preset": preset_key,
            "cache_hit": False,
            "total_results": total_results,
            "elapsed_ms": total_ms,
            "sources": stats_by_source,
            "circuit_breaker": cb_snapshot,
        },
    }
