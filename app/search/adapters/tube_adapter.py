"""Adaptér pre hlavné video portály z ExternalSearchEngine pod kontrolou Circuit Breakera."""
from __future__ import annotations

import asyncio
import inspect
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional

from app.search_engine import ExternalSearchEngine

from ..base import (
    AdapterBatch,
    CircuitBreakerBlockedError,
    cb_allow,
    cb_record_failure,
    cb_record_success,
    filter_strict_query_items,
    normalize_result,
)

logger = logging.getLogger("nexus.omega_search.tube")


@dataclass(frozen=True)
class TubeSiteProfile:
    key: str
    label: str
    domain: str
    method_name: str


TUBE_ENGINE_SITES: tuple[TubeSiteProfile, ...] = (
    TubeSiteProfile("pornhub", "Pornhub", "www.pornhub.com", "search_pornhub_async"),
    TubeSiteProfile("xvideos", "XVideos", "www.xvideos.com", "search_xvideos_async"),
    TubeSiteProfile("xhamster", "xHamster", "xhamster.com", "search_xhamster_async"),
    TubeSiteProfile("noodlemagazine", "NoodleMagazine", "noodlemagazine.com", "search_noodlemagazine_async"),
    TubeSiteProfile("pimpbunny", "PimpBunny", "pimpbunny.com", "search_pimpbunny_async"),
    TubeSiteProfile("hqporner", "HQPorner", "hqporner.com", "search_hqporner_async"),
    TubeSiteProfile("pornone", "PornOne", "pornone.com", "search_pornone_async"),
    TubeSiteProfile("beeg", "Beeg", "beeg.com", "search_beeg_async"),
    TubeSiteProfile("erome", "Erome", "www.erome.com", "search_erome_async"),
    TubeSiteProfile("spankbang", "SpankBang", "spankbang.com", "search_spankbang_async"),
)


def _to_omega_item(raw: Dict[str, Any], profile: TubeSiteProfile) -> Optional[Dict[str, Any]]:
    url = str(raw.get("url") or raw.get("source_url") or "").strip()
    if not url or not url.startswith("http"):
        return None
    title = str(raw.get("title") or url).strip()
    thumb = str(raw.get("thumbnail") or raw.get("thumb_url") or "").strip()
    extra: Dict[str, Any] = {}
    for k in ("performer", "uploader", "tags", "views", "width", "video_count", "photo_count", "source_url"):
        if raw.get(k) not in (None, "", []):
            extra[k] = raw[k]
    return normalize_result(
        title=title,
        url=url,
        source=profile.label,
        source_key=profile.key,
        layer="tube",
        adapter="tube_adapter",
        thumbnail=thumb,
        duration=raw.get("duration") or raw.get("duration_str") or 0,
        quality=str(raw.get("quality") or ""),
        height=int(raw.get("height") or 0),
        description=str(raw.get("description") or f"{profile.label} search"),
        embed=str(raw.get("embed") or ""),
        preview_url=str(raw.get("preview_url") or ""),
        extra=extra or None,
    )


class TubeEngineAdapter:
    """Paralelne spúšťa existujúce portálové scrapery v Omni-Search SSE s CB a prísnym filtrom."""

    def __init__(
        self,
        sites: Iterable[TubeSiteProfile] = TUBE_ENGINE_SITES,
        *,
        concurrency: int = 6,
        timeout_s: float = 11.0,
        engine: Optional[ExternalSearchEngine] = None,
    ):
        self.sites = tuple(sites)
        self.concurrency = max(1, concurrency)
        self.timeout_s = timeout_s
        self.engine = engine or ExternalSearchEngine()

    async def search_site(self, profile: TubeSiteProfile, query: str, *, limit: int = 24) -> AdapterBatch:
        t0 = time.perf_counter()
        allowed, retry_after = cb_allow(profile.domain)
        if not allowed:
            return AdapterBatch(
                layer="tube",
                adapter="tube_adapter",
                source_key=profile.key,
                source_label=profile.label,
                status="skipped_circuit",
                error=f"Circuit open pre {profile.domain} (retry za {retry_after:.1f}s)",
                elapsed_ms=int((time.perf_counter() - t0) * 1000),
                query_used=query,
            )

        fn = getattr(self.engine, profile.method_name, None)
        if not callable(fn):
            return AdapterBatch(
                layer="tube",
                adapter="tube_adapter",
                source_key=profile.key,
                source_label=profile.label,
                status="error",
                error=f"Missing method {profile.method_name}",
                elapsed_ms=int((time.perf_counter() - t0) * 1000),
                query_used=query,
            )

        fetch_cap = max(limit * 2, 48)
        try:
            sig = inspect.signature(fn)
            coro = fn(query, result_limit=fetch_cap) if "result_limit" in sig.parameters else fn(query)
            raw_rows = await asyncio.wait_for(coro, timeout=self.timeout_s)
            if not isinstance(raw_rows, list):
                raw_rows = list(raw_rows or [])

            normalized: List[Dict[str, Any]] = []
            seen_u: set[str] = set()
            for r in raw_rows:
                if not isinstance(r, dict):
                    continue
                item = _to_omega_item(r, profile)
                if not item or item["url"] in seen_u:
                    continue
                seen_u.add(item["url"])
                normalized.append(item)

            filtered = filter_strict_query_items(normalized, query)[:limit]
            cb_record_success(profile.domain)
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.info(
                "[OMEGA][TUBE] %s: %d/%d relevantných výsledkov (%d ms)",
                profile.label,
                len(filtered),
                len(normalized),
                elapsed,
            )
            return AdapterBatch(
                layer="tube",
                adapter="tube_adapter",
                source_key=profile.key,
                source_label=profile.label,
                items=filtered,
                status="ok" if filtered else "empty",
                elapsed_ms=elapsed,
                query_used=query,
            )
        except CircuitBreakerBlockedError as exc:
            return AdapterBatch(
                layer="tube",
                adapter="tube_adapter",
                source_key=profile.key,
                source_label=profile.label,
                status="skipped_circuit",
                error=str(exc),
                elapsed_ms=int((time.perf_counter() - t0) * 1000),
                query_used=query,
            )
        except (asyncio.TimeoutError, TimeoutError):
            cb_record_failure(profile.domain, f"timeout {self.timeout_s}s", immediate_trip=True)
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.warning("[OMEGA][TUBE] %s timeout (%d ms)", profile.label, elapsed)
            return AdapterBatch(
                layer="tube",
                adapter="tube_adapter",
                source_key=profile.key,
                source_label=profile.label,
                status="error",
                error=f"Timeout {self.timeout_s}s",
                elapsed_ms=elapsed,
                query_used=query,
            )
        except Exception as exc:
            msg = str(exc) or type(exc).__name__
            cb_record_failure(profile.domain, msg, immediate_trip=("403" in msg or "429" in msg))
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.warning("[OMEGA][TUBE] %s chyba: %s (%d ms)", profile.label, msg, elapsed)
            return AdapterBatch(
                layer="tube",
                adapter="tube_adapter",
                source_key=profile.key,
                source_label=profile.label,
                status="error",
                error=msg,
                elapsed_ms=elapsed,
                query_used=query,
            )

    def iter_tasks(
        self,
        query: str,
        *,
        selected_keys: Optional[set[str]] = None,
        per_source_limit: int = 24,
    ) -> List[asyncio.Task]:
        sem = asyncio.Semaphore(self.concurrency)
        tasks: List[asyncio.Task] = []
        for profile in self.sites:
            if selected_keys and profile.key not in selected_keys:
                continue

            async def _run(p: TubeSiteProfile = profile) -> AdapterBatch:
                async with sem:
                    return await self.search_site(p, query, limit=per_source_limit)

            tasks.append(asyncio.create_task(_run()))
        return tasks
