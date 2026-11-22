"""Univerzálny KVS adaptér pre všetky KVS-style portály (JSON-LD + generické KVS karty)."""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import quote, quote_plus, urljoin

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

logger = logging.getLogger("nexus.omega_search.kvs")


@dataclass(frozen=True)
class KvsSiteProfile:
    key: str
    label: str
    origin: str
    search_template: str
    video_href_re: str = r"/(?:videos?|watch)/"
    use_slug: bool = True


KVS_SITES: tuple[KvsSiteProfile, ...] = (
    KvsSiteProfile("whoreshub", "WhoresHub", "https://www.whoreshub.com", "https://www.whoreshub.com/search/{slug}/", r"/videos/\d+"),
    KvsSiteProfile("porntrex", "PornTrex", "https://www.porntrex.com", "https://www.porntrex.com/search/{slug}/", r"/video/\d+"),
    KvsSiteProfile("camwhores", "Camwhores", "https://www.camwhores.tv", "https://www.camwhores.tv/search/{slug}/", r"/videos/\d+"),
    KvsSiteProfile("camwhoresbay", "CamwhoresBay", "https://www.camwhoresbay.com", "https://www.camwhoresbay.com/search/{slug}/", r"/videos/\d+"),
    KvsSiteProfile("thisvid", "ThisVid", "https://thisvid.com", "https://thisvid.com/search/{slug}/", r"/videos/"),
    KvsSiteProfile("thothub", "Thothub", "https://thothub.to", "https://thothub.to/search/{slug}/", r"/videos/\d+"),
    KvsSiteProfile("xxbrits", "XXBrits", "https://www.xxbrits.com", "https://www.xxbrits.com/search/{slug}/", r"/videos/\d+"),
    KvsSiteProfile("4kporno", "4KPorno", "https://www.4kporno.xxx", "https://www.4kporno.xxx/search/{slug}/", r"/videos/\d+"),
    KvsSiteProfile("analdin", "Analdin", "https://www.analdin.com", "https://www.analdin.com/search/{slug}/", r"/videos/\d+"),
    KvsSiteProfile("anysex", "AnySex", "https://anysex.com", "https://anysex.com/search/?q={q}", r"/(?:\d+|videos/)", use_slug=False),
    KvsSiteProfile("drtuber", "DrTuber", "https://www.drtuber.com", "https://www.drtuber.com/search/videos/{q}", r"/video/\d+", use_slug=False),
    KvsSiteProfile("tnaflix", "Tnaflix", "https://www.tnaflix.com", "https://www.tnaflix.com/search.php?what={q}", r"/video\d+", use_slug=False),
)

_CARD_SELECTOR = (
    "div.item, div.thumb, div.box, div.video-item, article.item, "
    "div[data-video-id], li.video-item, div.thumb-block"
)
_BAD_THUMB_RE = re.compile(r"(?:data:image|blank\.gif|spacer\.gif|placeholder|loading\.gif)", re.I)


def _slugify(query: str) -> str:
    clean = re.sub(r"[^a-z0-9]+", "-", (query or "").strip().lower()).strip("-")
    return quote(clean or (query or "").strip(), safe="-")


def _extract_thumb(card: Any, origin: str) -> str:
    for img in card.select("img"):
        for attr in ("data-original", "data-src", "data-webp", "data-thumb", "data-lazy-src", "src"):
            val = (img.get(attr) or "").strip()
            if val and not _BAD_THUMB_RE.search(val):
                return urljoin(origin, val)
    return ""


def _parse_kvs_html(html: str, profile: KvsSiteProfile, *, limit: int = 24) -> List[Dict[str, Any]]:
    soup = BeautifulSoup(html, "lxml")

    # 1. JSON-LD (ak web poskytuje VideoObject / ItemList)
    items = extract_json_ld_items(
        soup,
        base_url=profile.origin,
        source_label=profile.label,
        source_key=profile.key,
        layer="kvs",
        adapter="kvs_adapter",
        limit=limit,
    )
    seen = {it["url"] for it in items}

    href_re = re.compile(profile.video_href_re, re.I)
    for card in soup.select(_CARD_SELECTOR):
        anchor = card.select_one("a[href]")
        if not anchor:
            continue
        href = (anchor.get("href") or "").strip()
        if not href or href.startswith("#") or href.startswith("javascript:"):
            continue
        full_url = urljoin(profile.origin, href)
        if full_url in seen:
            continue
        if not href_re.search(full_url) and not card.get("data-video-id"):
            continue

        title_el = card.select_one(".title, .video-title, strong.title, h2, h3, a[title]")
        img_el = card.select_one("img[alt]")
        title = (
            (anchor.get("title") or "")
            or (title_el.get("title") if title_el else "")
            or (title_el.get_text(" ", strip=True) if title_el else "")
            or (img_el.get("alt") if img_el else "")
            or anchor.get_text(" ", strip=True)
        ).strip()
        if not title or len(title) < 2:
            continue

        dur_el = card.select_one(".duration, .time, .video-duration, span.is-hd + span")
        dur_text = dur_el.get_text(" ", strip=True) if dur_el else card.get_text(" ", strip=True)
        duration_sec = parse_duration_seconds(dur_text)

        q_el = card.select_one(".is-hd, .hd, .quality, .badge, .res, span.video-hd")
        q_text = (q_el.get_text(" ", strip=True) if q_el else "") or " ".join(card.get("class") or [])
        height, quality = parse_quality_height(q_text or title)
        if not height and card.select_one(".is-hd, .hd"):
            height, quality = 720, "HD"

        thumb = _extract_thumb(card, profile.origin)
        seen.add(full_url)
        items.append(
            normalize_result(
                title=title,
                url=full_url,
                source=profile.label,
                source_key=profile.key,
                layer="kvs",
                adapter="kvs_adapter",
                thumbnail=thumb,
                duration=duration_sec,
                quality=quality,
                height=height,
                description=f"KVS ({profile.label})",
                extra={"preview_url": anchor.get("data-preview") or card.get("data-preview") or ""},
            )
        )
        if len(items) >= limit:
            break

    return items


class KvsFamilyAdapter:
    """Paralelne prehľadáva celú KVS rodinu webov pod kontrolou Circuit Breakera."""

    def __init__(self, sites: Iterable[KvsSiteProfile] = KVS_SITES, *, concurrency: int = 6, timeout_s: float = 8.0):
        self.sites = tuple(sites)
        self.concurrency = max(1, concurrency)
        self.timeout_s = timeout_s

    def _build_url(self, profile: KvsSiteProfile, query: str) -> str:
        clean_q = (query or "").strip()
        return profile.search_template.format(
            slug=_slugify(clean_q),
            q=quote_plus(clean_q),
        )

    async def search_site(self, profile: KvsSiteProfile, query: str, *, limit: int = 20) -> AdapterBatch:
        t0 = time.perf_counter()
        search_url = self._build_url(profile, query)
        try:
            status, html = await fetch_text(
                search_url,
                domain=profile.origin,
                referer=f"{profile.origin}/",
                timeout_s=self.timeout_s,
            )
            if status != 200 or not html:
                return AdapterBatch(
                    layer="kvs",
                    adapter="kvs_adapter",
                    source_key=profile.key,
                    source_label=profile.label,
                    status="empty",
                    elapsed_ms=int((time.perf_counter() - t0) * 1000),
                    query_used=search_url,
                )
            raw_items = await asyncio.to_thread(_parse_kvs_html, html, profile, limit=max(limit * 2, 48))
            items = filter_strict_query_items(raw_items, query)[:limit]
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.info("[OMEGA][KVS] %s: %d/%d relevantných výsledkov (%d ms)", profile.label, len(items), len(raw_items), elapsed)
            return AdapterBatch(
                layer="kvs",
                adapter="kvs_adapter",
                source_key=profile.key,
                source_label=profile.label,
                items=items,
                status="ok" if items else "empty",
                elapsed_ms=elapsed,
                query_used=search_url,
            )
        except CircuitBreakerBlockedError as exc:
            return AdapterBatch(
                layer="kvs",
                adapter="kvs_adapter",
                source_key=profile.key,
                source_label=profile.label,
                status="skipped_circuit",
                error=str(exc),
                elapsed_ms=int((time.perf_counter() - t0) * 1000),
                query_used=search_url,
            )
        except Exception as exc:
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.warning("[OMEGA][KVS] %s chyba: %s (%d ms)", profile.label, exc, elapsed)
            return AdapterBatch(
                layer="kvs",
                adapter="kvs_adapter",
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

            async def _run(p: KvsSiteProfile = profile) -> AdapterBatch:
                async with sem:
                    return await self.search_site(p, query, limit=per_source_limit)

            tasks.append(asyncio.create_task(_run()))
        return tasks
