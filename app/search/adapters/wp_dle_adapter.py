"""Generický WordPress & DLE adaptér (?s= / DLE search + JSON-LD + článkové karty)."""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import quote_plus, urljoin, urlparse

from bs4 import BeautifulSoup

from ..base import (
    AdapterBatch,
    CircuitBreakerBlockedError,
    extract_json_ld_items,
    fetch_text,
    filter_strict_query_items,
    normalize_result,
    parse_duration_seconds,
    parse_quality_height,
)

logger = logging.getLogger("nexus.omega_search.wp_dle")


@dataclass(frozen=True)
class WpDleSiteProfile:
    key: str
    label: str
    origin: str
    search_template: str
    kind: str = "wp"  # wp | dle


WP_DLE_SITES: tuple[WpDleSiteProfile, ...] = (
    WpDleSiteProfile("leakporner", "LeakPorner", "https://leakporner.com", "https://leakporner.com/?s={q}", "wp"),
    WpDleSiteProfile("mypornerleak", "MyPornerLeak", "https://tv.mypornerleak.com", "https://tv.mypornerleak.com/?s={q}", "wp"),
    WpDleSiteProfile("hornysimp", "HornySimp", "https://hornysimp.com", "https://hornysimp.com/?s={q}", "wp"),
    WpDleSiteProfile("internetchicks", "InternetChicks", "https://internetchicks.com", "https://internetchicks.com/?s={q}", "wp"),
    WpDleSiteProfile("djav", "DJAV", "https://djav.org", "https://djav.org/?s={q}", "wp"),
    WpDleSiteProfile("nsfw247", "NSFW247", "https://nsfw247.to", "https://nsfw247.to/?s={q}", "wp"),
    WpDleSiteProfile("baddiehub", "BaddieHub", "https://baddiehub.com", "https://baddiehub.com/?s={q}", "wp"),
    WpDleSiteProfile("cyberleaks", "CyberLeaks", "https://cyberleaks.top", "https://cyberleaks.top/?s={q}", "wp"),
    WpDleSiteProfile("leakedzone", "Leakedzone", "https://leakedzone.com", "https://leakedzone.com/search?search={q}", "wp"),
    WpDleSiteProfile("pornonahobka", "Pornonahobka", "https://pornonahobka.icu", "https://pornonahobka.icu/?do=search&subaction=search&story={q}", "dle"),
)

_WP_DLE_SELECTOR = (
    "article, div.post, div.shortstory, div.video-item, div.thumb, "
    "div.loop-video, li.video, div.entry, div.item-video"
)
_IGNORE_PATH_RE = re.compile(
    r"/(?:category|tag|author|page|wp-login|wp-admin|privacy|dmca|terms|contact|feed)(?:/|$)",
    re.I,
)
_BAD_THUMB_RE = re.compile(r"(?:data:image|blank\.gif|spacer\.gif|gravatar\.com/avatar)", re.I)


def _pick_thumb(node: Any, origin: str) -> str:
    for img in node.select("img"):
        for attr in ("data-src", "data-original", "data-lazy-src", "data-cfsrc", "src"):
            val = (img.get(attr) or "").strip()
            if val and not _BAD_THUMB_RE.search(val):
                return urljoin(origin, val)
    return ""


def _parse_wp_dle_html(html: str, profile: WpDleSiteProfile, *, limit: int = 24) -> List[Dict[str, Any]]:
    soup = BeautifulSoup(html, "lxml")

    items = extract_json_ld_items(
        soup,
        base_url=profile.origin,
        source_label=profile.label,
        source_key=profile.key,
        layer="wp_dle",
        adapter="wp_dle_adapter",
        limit=limit,
    )
    seen = {it["url"] for it in items}
    origin_host = urlparse(profile.origin).netloc.lower().lstrip("www.")

    for card in soup.select(_WP_DLE_SELECTOR):
        anchor = card.select_one(
            "h2 a[href], h3 a[href], .entry-title a[href], .post-title a[href], "
            "a.clip-link[href], a[rel='bookmark'][href], a[href]"
        )
        if not anchor:
            continue
        href = (anchor.get("href") or "").strip()
        if not href or href.startswith("#") or href.startswith("javascript:"):
            continue
        full_url = urljoin(profile.origin, href)
        parsed = urlparse(full_url)
        if not parsed.scheme.startswith("http"):
            continue
        # Povoľuj iba linky patriace danému webu a odfiltruj navigačné/tag stránky
        if origin_host not in parsed.netloc.lower():
            continue
        if _IGNORE_PATH_RE.search(parsed.path) or parsed.path in ("", "/") or "?s=" in full_url:
            continue
        if full_url in seen:
            continue

        img_el = card.select_one("img[alt]")
        title = (
            anchor.get("title")
            or anchor.get_text(" ", strip=True)
            or (img_el.get("alt") if img_el else "")
            or ""
        ).strip()
        if len(title) < 3:
            continue

        dur_el = card.select_one(".duration, .time, .length, span.video-duration")
        dur_sec = parse_duration_seconds(dur_el.get_text(" ", strip=True) if dur_el else card.get_text(" ", strip=True))
        q_el = card.select_one(".hd-video, .quality, .badge, .hd")
        height, quality = parse_quality_height((q_el.get_text(" ", strip=True) if q_el else "") + " " + title)
        thumb = _pick_thumb(card, profile.origin)

        seen.add(full_url)
        items.append(
            normalize_result(
                title=title,
                url=full_url,
                source=profile.label,
                source_key=profile.key,
                layer="wp_dle",
                adapter="wp_dle_adapter",
                thumbnail=thumb,
                duration=dur_sec,
                quality=quality,
                height=height,
                description=f"{profile.kind.upper()} ({profile.label})",
            )
        )
        if len(items) >= limit:
            break

    return items


class WpDleFamilyAdapter:
    """Paralelný adaptér pre WordPress a DLE weby s Circuit Breakerom."""

    def __init__(self, sites: Iterable[WpDleSiteProfile] = WP_DLE_SITES, *, concurrency: int = 6, timeout_s: float = 8.0):
        self.sites = tuple(sites)
        self.concurrency = max(1, concurrency)
        self.timeout_s = timeout_s

    async def search_site(self, profile: WpDleSiteProfile, query: str, *, limit: int = 20) -> AdapterBatch:
        t0 = time.perf_counter()
        search_url = profile.search_template.format(q=quote_plus((query or "").strip()))
        try:
            status, html = await fetch_text(
                search_url,
                domain=profile.origin,
                referer=f"{profile.origin}/",
                timeout_s=self.timeout_s,
            )
            if status != 200 or not html:
                return AdapterBatch(
                    layer="wp_dle",
                    adapter="wp_dle_adapter",
                    source_key=profile.key,
                    source_label=profile.label,
                    status="empty",
                    elapsed_ms=int((time.perf_counter() - t0) * 1000),
                    query_used=search_url,
                )
            raw_items = await asyncio.to_thread(_parse_wp_dle_html, html, profile, limit=max(limit * 2, 48))
            items = filter_strict_query_items(raw_items, query)[:limit]
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.info("[OMEGA][WP/DLE] %s: %d/%d relevantných výsledkov (%d ms)", profile.label, len(items), len(raw_items), elapsed)
            return AdapterBatch(
                layer="wp_dle",
                adapter="wp_dle_adapter",
                source_key=profile.key,
                source_label=profile.label,
                items=items,
                status="ok" if items else "empty",
                elapsed_ms=elapsed,
                query_used=search_url,
            )
        except CircuitBreakerBlockedError as exc:
            return AdapterBatch(
                layer="wp_dle",
                adapter="wp_dle_adapter",
                source_key=profile.key,
                source_label=profile.label,
                status="skipped_circuit",
                error=str(exc),
                elapsed_ms=int((time.perf_counter() - t0) * 1000),
                query_used=search_url,
            )
        except Exception as exc:
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.warning("[OMEGA][WP/DLE] %s chyba: %s (%d ms)", profile.label, exc, elapsed)
            return AdapterBatch(
                layer="wp_dle",
                adapter="wp_dle_adapter",
                source_key=profile.key,
                source_label=profile.label,
                status="error",
                error=str(exc),
                elapsed_ms=elapsed,
                query_used=search_url,
            )

    def iter_tasks(
        self,
        query: str,
        *,
        selected_keys: Optional[set[str]] = None,
        per_source_limit: int = 20,
    ) -> List[asyncio.Task]:
        sem = asyncio.Semaphore(self.concurrency)
        tasks: List[asyncio.Task] = []
        for profile in self.sites:
            if selected_keys and profile.key not in selected_keys:
                continue

            async def _run(p: WpDleSiteProfile = profile) -> AdapterBatch:
                async with sem:
                    return await self.search_site(p, query, limit=per_source_limit)

            tasks.append(asyncio.create_task(_run()))
        return tasks
