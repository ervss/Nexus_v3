"""API adaptér pre rýchle JSON portály (Eporner API, RedGIFs v2, Reddit JSON)."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import logging
import time
from typing import Any, Callable, Coroutine, Dict, List, Optional
from urllib.parse import quote_plus

import httpx

from ..base import (
    DEFAULT_UA,
    AdapterBatch,
    CircuitBreakerBlockedError,
    cb_allow,
    cb_record_failure,
    cb_record_success,
    fetch_text,
    filter_strict_query_items,
    normalize_result,
)

logger = logging.getLogger("nexus.omega_search.api")


class ApiFamilyAdapter:
    """Paralelný klient pre JSON API zdroje s per-doménovým Circuit Breakerom."""

    def __init__(self, *, timeout_s: float = 8.0):
        self.timeout_s = timeout_s
        self._redgifs_token: str = ""
        self._redgifs_token_ts: float = 0.0

    async def _search_eporner(self, query: str, limit: int) -> AdapterBatch:
        t0 = time.perf_counter()
        domain = "www.eporner.com"
        url = (
            f"https://www.eporner.com/api/v2/video/search/"
            f"?query={quote_plus(query)}&per_page={min(limit, 50)}&page=1&thumbsize=big&order=top-weekly&format=json"
        )
        try:
            status, body = await fetch_text(url, domain=domain, referer="https://www.eporner.com/", timeout_s=self.timeout_s, prefer_curl_cffi=False)
            payload = json.loads(body) if status == 200 and body else {}
            items: List[Dict[str, Any]] = []
            for v in payload.get("videos") or []:
                thumb = ""
                thumbs = v.get("thumbs") or []
                if isinstance(thumbs, list) and thumbs:
                    thumb = str(thumbs[0].get("src") or "")
                elif v.get("default_thumb"):
                    thumb = str((v.get("default_thumb") or {}).get("src") or "")
                items.append(
                    normalize_result(
                        title=str(v.get("title") or ""),
                        url=str(v.get("url") or ""),
                        source="Eporner",
                        source_key="eporner",
                        layer="api",
                        adapter="api_adapter",
                        thumbnail=thumb,
                        duration=v.get("length_sec") or v.get("length_min") or 0,
                        embed=str(v.get("embed") or ""),
                        description=f"Eporner API | {v.get('views', 0)} views",
                        extra={
                            "tags": v.get("keywords") or "",
                            "upload_date": str(v.get("added") or "")[:10],
                        },
                    )
                )
                if len(items) >= limit * 2:
                    break
            items = filter_strict_query_items(items, query)[:limit]
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.info("[OMEGA][API] Eporner: %d výsledkov (%d ms)", len(items), elapsed)
            return AdapterBatch("api", "api_adapter", "eporner", "Eporner", items, "ok" if items else "empty", elapsed_ms=elapsed, query_used=url)
        except CircuitBreakerBlockedError as exc:
            return AdapterBatch("api", "api_adapter", "eporner", "Eporner", status="skipped_circuit", error=str(exc), elapsed_ms=int((time.perf_counter() - t0) * 1000), query_used=url)
        except Exception as exc:
            return AdapterBatch("api", "api_adapter", "eporner", "Eporner", status="error", error=str(exc), elapsed_ms=int((time.perf_counter() - t0) * 1000), query_used=url)

    async def _get_redgifs_token(self, client: httpx.AsyncClient) -> str:
        if self._redgifs_token and (time.monotonic() - self._redgifs_token_ts) < 1800:
            return self._redgifs_token
        resp = await client.get("https://api.redgifs.com/v2/auth/temporary")
        resp.raise_for_status()
        tok = str((resp.json() or {}).get("token") or "")
        if tok:
            self._redgifs_token = tok
            self._redgifs_token_ts = time.monotonic()
        return tok

    async def _search_redgifs(self, query: str, limit: int) -> AdapterBatch:
        t0 = time.perf_counter()
        domain = "api.redgifs.com"
        search_url = f"https://api.redgifs.com/v2/gifs/search?search_text={quote_plus(query)}&count={min(limit, 40)}&order=trending"
        allowed, retry_after = cb_allow(domain)
        if not allowed:
            return AdapterBatch("api", "api_adapter", "redgifs", "RedGIFs", status="skipped_circuit", error=f"Circuit open ({retry_after:.1f}s)", query_used=search_url)
        try:
            headers = {
                "User-Agent": DEFAULT_UA,
                "Accept": "application/json",
                "Origin": "https://www.redgifs.com",
                "Referer": "https://www.redgifs.com/",
            }
            async with httpx.AsyncClient(timeout=self.timeout_s, headers=headers) as client:
                token = await self._get_redgifs_token(client)
                if not token:
                    cb_record_failure(domain, "Chýba RedGIFs token")
                    return AdapterBatch("api", "api_adapter", "redgifs", "RedGIFs", status="error", error="Missing temporary token", elapsed_ms=int((time.perf_counter() - t0) * 1000), query_used=search_url)
                resp = await client.get(search_url, headers={"Authorization": f"Bearer {token}"})
                if resp.status_code in (403, 429):
                    cb_record_failure(domain, f"HTTP {resp.status_code}", immediate_trip=True)
                    return AdapterBatch("api", "api_adapter", "redgifs", "RedGIFs", status="error", error=f"HTTP {resp.status_code}", elapsed_ms=int((time.perf_counter() - t0) * 1000), query_used=search_url)
                resp.raise_for_status()
                payload = resp.json() or {}
            cb_record_success(domain)
            items: List[Dict[str, Any]] = []
            for gif in payload.get("gifs") or []:
                gid = str(gif.get("id") or "").strip()
                if not gid:
                    continue
                urls = gif.get("urls") or {}
                thumb = str(urls.get("thumbnail") or urls.get("poster") or "")
                stream = str(urls.get("hd") or urls.get("sd") or "")
                items.append(
                    normalize_result(
                        title=str(gif.get("title") or f"RedGIFs {gid}"),
                        url=f"https://www.redgifs.com/watch/{gid}",
                        source="RedGIFs",
                        source_key="redgifs",
                        layer="api",
                        adapter="api_adapter",
                        thumbnail=thumb,
                        duration=gif.get("duration") or 0,
                        height=1080 if urls.get("hd") else 720,
                        preview_url=stream,
                        description=", ".join((gif.get("tags") or [])[:5]) or "RedGIFs v2 API",
                        extra={
                            "tags": gif.get("tags") or [],
                            "upload_date": datetime.fromtimestamp(int(gif["createDate"]), tz=timezone.utc).strftime("%Y-%m-%d")
                            if gif.get("createDate") else "",
                        },
                    )
                )
                if len(items) >= limit * 2:
                    break
            items = filter_strict_query_items(items, query)[:limit]
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.info("[OMEGA][API] RedGIFs: %d výsledkov (%d ms)", len(items), elapsed)
            return AdapterBatch("api", "api_adapter", "redgifs", "RedGIFs", items, "ok" if items else "empty", elapsed_ms=elapsed, query_used=search_url)
        except Exception as exc:
            cb_record_failure(domain, str(exc), immediate_trip=isinstance(exc, (httpx.TimeoutException, httpx.TransportError)))
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.warning("[OMEGA][API] RedGIFs chyba: %s (%d ms)", exc, elapsed)
            return AdapterBatch("api", "api_adapter", "redgifs", "RedGIFs", status="error", error=str(exc), elapsed_ms=elapsed, query_used=search_url)

    async def _search_reddit(self, query: str, limit: int) -> AdapterBatch:
        t0 = time.perf_counter()
        domain = "www.reddit.com"
        url = f"https://www.reddit.com/search.json?q={quote_plus(query)}&include_over_18=on&type=link&limit={min(limit, 30)}"
        try:
            status, body = await fetch_text(url, domain=domain, referer="https://www.reddit.com/", timeout_s=self.timeout_s, prefer_curl_cffi=False)
            payload = json.loads(body) if status == 200 and body else {}
            children = ((payload.get("data") or {}).get("children") or [])
            items: List[Dict[str, Any]] = []
            for ch in children:
                d = ch.get("data") or {}
                permalink = str(d.get("permalink") or "")
                post_url = f"https://www.reddit.com{permalink}" if permalink else str(d.get("url") or "")
                if not post_url:
                    continue
                thumb = str(d.get("thumbnail") or "")
                if not thumb.startswith("http"):
                    thumb = ""
                items.append(
                    normalize_result(
                        title=str(d.get("title") or post_url),
                        url=post_url,
                        source=f"Reddit (r/{d.get('subreddit', 'nsfw')})",
                        source_key="reddit",
                        layer="api",
                        adapter="api_adapter",
                        thumbnail=thumb,
                        description=f"r/{d.get('subreddit', '')} | {d.get('score', 0)} pts",
                        extra={
                            "upload_date": datetime.fromtimestamp(float(d["created_utc"]), tz=timezone.utc).strftime("%Y-%m-%d")
                            if d.get("created_utc") else "",
                        },
                    )
                )
            items = filter_strict_query_items(items, query)[:limit]
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.info("[OMEGA][API] Reddit: %d výsledkov (%d ms)", len(items), elapsed)
            return AdapterBatch("api", "api_adapter", "reddit", "Reddit", items, "ok" if items else "empty", elapsed_ms=elapsed, query_used=url)
        except CircuitBreakerBlockedError as exc:
            return AdapterBatch("api", "api_adapter", "reddit", "Reddit", status="skipped_circuit", error=str(exc), elapsed_ms=int((time.perf_counter() - t0) * 1000), query_used=url)
        except Exception as exc:
            return AdapterBatch("api", "api_adapter", "reddit", "Reddit", status="error", error=str(exc), elapsed_ms=int((time.perf_counter() - t0) * 1000), query_used=url)

    def iter_tasks(
        self,
        query: str,
        *,
        selected_keys: Optional[set[str]] = None,
        per_source_limit: int = 20,
    ) -> List[asyncio.Task]:
        providers: dict[str, Callable[[], Coroutine[Any, Any, AdapterBatch]]] = {
            "eporner": lambda: self._search_eporner(query, per_source_limit),
            "redgifs": lambda: self._search_redgifs(query, per_source_limit),
            "reddit": lambda: self._search_reddit(query, per_source_limit),
        }
        tasks: List[asyncio.Task] = []
        for key, factory in providers.items():
            if selected_keys and key not in selected_keys:
                continue
            tasks.append(asyncio.create_task(factory()))
        return tasks
