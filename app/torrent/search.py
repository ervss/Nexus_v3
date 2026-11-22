"""Indexer search. Prowlarr when configured, otherwise Jackett, with a fallback."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import Counter
from typing import Any
from urllib.parse import quote

import httpx

from .limit import search_cache
from .normalize import (
    acceptable_download_url,
    dedupe_results,
    normalize_jackett_result,
    normalize_prowlarr_result,
    parse_torznab,
    public_result,
)
from .thumbs import remember_poster
from .settings import TorrentSettings, load_settings

logger = logging.getLogger("nexus.torrent")
_INDEXER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$")
_RESULT_CAP = 400

_client: httpx.AsyncClient | None = None


class SearchError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message = message
        self.status = status


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(follow_redirects=False, headers={"User-Agent": "NexusTorrent/1.0"})
    return _client


def _timeout(settings: TorrentSettings) -> httpx.Timeout:
    return httpx.Timeout(connect=3.0, read=settings.jackett_timeout, write=10.0, pool=5.0)


def indexers_without_category(reports: list[dict]) -> list[str]:
    """Indexers that answered the XXX category with nothing.

    TorrentDownload, Torrent Downloads and LimeTorrents are configured, but
    they do not implement Torznab category 6000, so Jackett reports zero hits.
    They still have results when asked without that category.
    """
    chosen: list[str] = []
    for item in reports:
        if not isinstance(item, dict) or item.get("Error"):
            continue
        ident = str(item.get("ID") or "")
        if not _INDEXER_ID.match(ident) or ident.lower() == "all":
            continue
        try:
            count = int(item.get("Results") or 0)
        except (TypeError, ValueError):
            count = 0
        if count == 0:
            chosen.append(ident)
    return chosen


def _rows_from_payload(payload: Any) -> tuple[list[dict], list[dict], list[str]]:
    raw_rows = payload.get("Results") if isinstance(payload, dict) else payload
    if not isinstance(raw_rows, list):
        raw_rows = []
    rows = []
    for raw in raw_rows[:_RESULT_CAP]:
        row = normalize_jackett_result(raw)
        if row:
            rows.append(row)
    reports = []
    warnings = []
    for indexer in (payload.get("Indexers") if isinstance(payload, dict) else []) or []:
        if not isinstance(indexer, dict):
            continue
        reports.append(indexer)
        error = indexer.get("Error") or indexer.get("error")
        if error:
            name = indexer.get("Name") or indexer.get("ID") or "indexer"
            warnings.append(f"{name}: {error}")
    return rows, reports, warnings


async def _jackett_query(
    settings: TorrentSettings,
    indexer_id: str,
    query: str,
    category: int | None,
) -> tuple[list[dict], list[dict], list[str]]:
    params: dict[str, str] = {"apikey": settings.jackett_api_key, "Query": query}
    if category:
        params["Category[]"] = str(category)
    url = f"{settings.jackett_url}/api/v2.0/indexers/{indexer_id}/results"
    try:
        response = await _http().get(url, params=params, timeout=_timeout(settings))
    except httpx.TimeoutException as exc:
        raise SearchError("Jackett timed out", 504) from exc
    except httpx.HTTPError as exc:
        raise SearchError("Jackett is not reachable", 503) from exc
    if response.status_code in {401, 403}:
        raise SearchError("Jackett rejected the API key", 502)
    if response.status_code == 404 and indexer_id == "all":
        rows, warning = await _jackett_torznab(settings, query, category or 0)
        return rows, [], warning
    if response.status_code >= 400:
        raise SearchError(f"Jackett returned HTTP {response.status_code}", 502)
    content_type = response.headers.get("content-type", "")
    if "xml" in content_type or response.text.lstrip().startswith("<?xml"):
        return parse_torznab(response.text), [], []
    try:
        payload = response.json()
    except ValueError as exc:
        raise SearchError("Jackett returned a response that is not JSON", 502) from exc
    return _rows_from_payload(payload)


async def _jackett(settings: TorrentSettings, query: str, category: int) -> tuple[list[dict], list[str]]:
    rows, reports, warnings = await _jackett_query(settings, "all", query, category)
    extra_ids = indexers_without_category(reports)
    if not extra_ids:
        return rows, warnings[:8]

    async def one(indexer_id: str) -> list[dict]:
        try:
            extra_rows, _reports, extra_warnings = await _jackett_query(settings, indexer_id, query, None)
        except SearchError as exc:
            logger.info("jackett indexer %s without category failed: %s", indexer_id, exc.message)
            return []
        warnings.extend(extra_warnings)
        return extra_rows

    batches = await asyncio.gather(*(one(indexer_id) for indexer_id in extra_ids))
    names = []
    for indexer_id in extra_ids:
        match = next((item for item in reports if item.get("ID") == indexer_id), None)
        names.append(str((match or {}).get("Name") or indexer_id))
    warnings.insert(0, "Bez kategórie 6000, lebo ju indexer nepodporuje: " + ", ".join(names))
    for batch in batches:
        rows.extend(batch)
    return rows, warnings[:8]


async def _jackett_torznab(settings: TorrentSettings, query: str, category: int) -> tuple[list[dict], list[str]]:
    url = f"{settings.jackett_url}/api/v2.0/indexers/all/results/torznab/api"
    params = {"apikey": settings.jackett_api_key, "t": "search", "q": query, "cat": str(category)}
    try:
        response = await _http().get(url, params=params, timeout=_timeout(settings))
    except httpx.HTTPError as exc:
        raise SearchError("Jackett Torznab endpoint is not reachable", 503) from exc
    if response.status_code in {401, 403}:
        raise SearchError("Jackett rejected the API key", 502)
    if response.status_code >= 400:
        raise SearchError(f"Jackett Torznab returned HTTP {response.status_code}", 502)
    return parse_torznab(response.text), ["Jackett JSON aggregate was missing; used Torznab."]


async def _prowlarr(settings: TorrentSettings, query: str, category: int) -> tuple[list[dict], list[str]]:
    url = f"{settings.prowlarr_url}/api/v1/search"
    params = {"query": query, "categories": str(category), "type": "search"}
    headers = {"X-Api-Key": settings.prowlarr_api_key}
    try:
        response = await _http().get(url, params=params, headers=headers, timeout=_timeout(settings))
    except httpx.TimeoutException as exc:
        raise SearchError("Prowlarr timed out", 504) from exc
    except httpx.HTTPError as exc:
        raise SearchError("Prowlarr is not reachable", 503) from exc
    if response.status_code in {401, 403}:
        raise SearchError("Prowlarr rejected the API key", 502)
    if response.status_code >= 400:
        raise SearchError(f"Prowlarr returned HTTP {response.status_code}", 502)
    try:
        payload = response.json()
    except ValueError as exc:
        raise SearchError("Prowlarr returned a response that is not JSON", 502) from exc
    if not isinstance(payload, list):
        raise SearchError("Prowlarr returned an unexpected payload", 502)
    rows = []
    for raw in payload[:300]:
        row = normalize_prowlarr_result(raw)
        if row:
            rows.append(row)
    return rows, []


def _bases(settings: TorrentSettings) -> list[str]:
    return [base for base in (settings.jackett_url, settings.prowlarr_url) if base]


async def search_torrents(query: str, category: int | None = None) -> dict[str, Any]:
    settings = load_settings()
    if not settings.jackett_configured and not settings.prowlarr_configured:
        raise SearchError("Set JACKETT_API_KEY or PROWLARR_API_KEY in .env", 503)

    cat = category or settings.category
    cleaned = " ".join(query.split())
    cache_key = f"{int(cat)}:{cleaned.lower()}"
    cached = search_cache.get(cache_key)
    if cached is not None:
        return {**cached, "cached": True}

    started = time.perf_counter()
    engine = "jackett"
    warnings: list[str] = []
    if settings.prowlarr_configured:
        engine = "prowlarr"
        try:
            rows, warnings = await _prowlarr(settings, cleaned, cat)
        except SearchError as exc:
            if not settings.jackett_configured:
                raise
            logger.warning("Prowlarr search failed (%s); falling back to Jackett", exc.message)
            engine = "jackett"
            rows, warnings = await _jackett(settings, cleaned, cat)
            warnings = [f"Prowlarr failed ({exc.message}); used Jackett.", *warnings]
    else:
        rows, warnings = await _jackett(settings, cleaned, cat)

    bases = _bases(settings)
    merged = dedupe_results(rows)[:_RESULT_CAP]
    exposed = []
    for row in merged:
        item = public_result(row, bases)
        poster = str(row.get("poster_url") or "")
        if poster and acceptable_download_url(poster, bases):
            if item.get("infohash"):
                remember_poster(item["infohash"], poster)
            elif item.get("ref"):
                remember_poster("ref:" + item["ref"], poster)
                item["thumb_url"] = "/api/torrent/thumb?ref=" + quote(item["ref"])
        exposed.append(item)
    elapsed = int((time.perf_counter() - started) * 1000)
    payload = {
        "query": cleaned,
        "count": len(exposed),
        "category": cat,
        "engine": engine,
        "cached": False,
        "took_ms": elapsed,
        "indexers": sorted({row["indexer"] for row in exposed if row.get("indexer")}),
        "indexer_counts": dict(Counter(row["indexer"] for row in exposed if row.get("indexer"))),
        "warnings": warnings,
        "results": exposed,
    }
    logger.info(
        "torrent search engine=%s q=%r results=%s indexers=%s took_ms=%s",
        engine, cleaned, payload["count"], len(payload["indexers"]), elapsed,
    )
    search_cache.set(cache_key, payload, settings.search_cache_ttl)
    return payload
