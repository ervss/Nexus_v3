"""
MetaEnrichmentService — parallel video detail-page fetcher.

Extracts data unavailable from search listings:
  quality_variants, file_sizes, performers, tags,
  upload_date, likes, stream_urls, embed_url

Design:
  - 100 URLs in < 5s via per-domain semaphores + asyncio.gather
  - Circuit breaker per domain — opens after N failures, auto-resets
  - Domain 429 back-off — shared timestamp, all queued requests pause
  - Staggered batch start — 10ms inter-task delay to kill thundering herd
  - Error budget — aborts remaining batch if >60% already failed
  - Response size cap — truncate at 400 KB (scripts are in page head)
  - TTL cache — 1h / 5k entries, deduplicates repeated URLs
  - Parser health alert — logs when a parser extracts nothing (site changed)
  - Graceful degradation — original result returned unchanged on any failure
"""

import asyncio
import json
import logging
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import urlparse

from cachetools import TTLCache

logger = logging.getLogger(__name__)

# ── Chrome impersonate pool ───────────────────────────────────────────────────
_CHROME_VERSIONS = ["chrome120", "chrome124", "chrome126", "chrome131"]

# ── Domain configuration ──────────────────────────────────────────────────────

@dataclass
class DomainConfig:
    concurrency:    int                  # max parallel requests to this domain
    jitter_ms:      tuple[int, int]      # random sleep range (ms) before each request
    timeout_s:      float                # per-request hard timeout
    max_retries:    int                  # retry attempts on timeout (not on 4xx)
    cb_threshold:   int                  # consecutive failures → circuit OPEN
    cb_reset_s:     float                # seconds circuit stays OPEN before HALF_OPEN
    use_api:        bool = False         # hit JSON API instead of HTML


DOMAIN_CONFIGS: dict[str, DomainConfig] = {
    "xvideos.com":   DomainConfig(8,  (30,  120), 5.0, 2, 5, 30.0),
    "pornhub.com":   DomainConfig(4,  (80,  300), 8.0, 2, 3, 60.0),   # strict bot-detect
    "xhamster.com":  DomainConfig(6,  (50,  180), 6.0, 2, 4, 45.0),
    "eporner.com":   DomainConfig(12, (10,   60), 4.0, 3, 8, 20.0, use_api=True),
    "_default":      DomainConfig(4,  (60,  200), 6.0, 2, 4, 30.0),
}

# ── Circuit Breaker ───────────────────────────────────────────────────────────

class CircuitBreaker:
    CLOSED    = "closed"
    OPEN      = "open"
    HALF_OPEN = "half_open"

    def __init__(self, threshold: int, reset_s: float, domain: str) -> None:
        self._threshold  = threshold
        self._reset_s    = reset_s
        self._domain     = domain
        self.state       = self.CLOSED
        self._failures   = 0
        self._opened_at: Optional[float] = None

    def allow(self) -> bool:
        if self.state == self.OPEN:
            if time.monotonic() - self._opened_at >= self._reset_s:
                self.state = self.HALF_OPEN
                logger.info("[CB] %s → HALF_OPEN", self._domain)
                return True
            return False
        return True

    def record_success(self) -> None:
        if self.state != self.CLOSED:
            logger.info("[CB] %s → CLOSED", self._domain)
        self._failures = 0
        self.state     = self.CLOSED

    def record_failure(self) -> None:
        self._failures += 1
        if self._failures >= self._threshold and self.state != self.OPEN:
            self.state      = self.OPEN
            self._opened_at = time.monotonic()
            logger.warning("[CB] %s OPEN after %d consecutive failures", self._domain, self._failures)


# ── Per-domain runtime state ──────────────────────────────────────────────────

@dataclass
class DomainState:
    semaphore:       asyncio.Semaphore
    circuit_breaker: CircuitBreaker
    backoff_until:   float = 0.0     # epoch time; set when 429 received
    config:          DomainConfig = field(default_factory=lambda: DOMAIN_CONFIGS["_default"])


# ── Enriched metadata schema ──────────────────────────────────────────────────

@dataclass
class EnrichedMeta:
    quality_variants: list[dict] = field(default_factory=list)  # [{quality, url, size_bytes}]
    file_sizes:       dict       = field(default_factory=dict)   # {"1080p": bytes}
    stream_urls:      dict       = field(default_factory=dict)   # {"1080p": "https://..."}
    performers:       list[str]  = field(default_factory=list)
    tags:             list[str]  = field(default_factory=list)
    upload_date:      str        = ""
    embed_url:        str        = ""
    likes:            Optional[int]   = None
    dislikes:         Optional[int]   = None
    comments:         Optional[int]   = None
    duration_s:       Optional[int]   = None
    views:            Optional[int]   = None
    rating:           Optional[float] = None
    height:           Optional[int]   = None
    width:            Optional[int]   = None
    orientation:      str             = ""      # portrait | landscape (z rozmerov stránky/streamu)
    orientation_evidence: str         = ""
    aspect_ratio:     Optional[float] = None

    def to_dict(self) -> dict:
        out = {}
        for k, v in self.__dict__.items():
            # Skip empty containers and None, keep 0
            if v is None:
                continue
            if isinstance(v, (list, dict)) and not v:
                continue
            out[k] = v
        return out

    def has_useful_data(self) -> bool:
        return bool(
            self.quality_variants or self.stream_urls or
            self.performers or self.tags or self.file_sizes or self.orientation
        )


# ── Exceptions ────────────────────────────────────────────────────────────────

class RateLimitError(Exception):
    pass

class BlockedError(Exception):
    pass


# ── Main service ──────────────────────────────────────────────────────────────

class MetaEnrichmentService:
    """
    Singleton-safe: instantiate once at startup, reuse across requests.
    All shared mutable state is protected by asyncio primitives.
    """

    _RESPONSE_SIZE_CAP = 400_000   # bytes — player scripts always appear in first ~100KB

    def __init__(
        self,
        cache_size:      int   = 5_000,
        cache_ttl_s:     float = 3_600.0,
        error_budget:    float = 0.60,    # abort batch if this fraction fails
        stagger_ms:      int   = 10,      # ms between task launches (thundering-herd guard)
    ) -> None:
        self._cache:          TTLCache             = TTLCache(maxsize=cache_size, ttl=cache_ttl_s)
        self._domain_states:  dict[str, DomainState] = {}
        self._init_lock:      asyncio.Lock         = asyncio.Lock()
        self._error_budget    = error_budget
        self._stagger_ms      = stagger_ms

    # ── Public: enrich a list of result dicts ─────────────────────────────────

    async def enrich_batch(
        self,
        results:        list[dict],
        total_timeout_s: float = 10.0,
    ) -> list[dict]:
        """
        Enrich search result dicts with full video-page metadata.
        Returns a list of the same length; failures leave the original dict intact.
        """
        if not results:
            return results

        # Deduplicate: multiple results can share the same URL
        url_to_indices: dict[str, list[int]] = {}
        for i, r in enumerate(results):
            url = r.get("url", "")
            if url:
                url_to_indices.setdefault(url, []).append(i)

        enriched = list(results)  # shallow copy — only enriched ones get merged

        try:
            from curl_cffi.requests import AsyncSession
            async with AsyncSession(impersonate=random.choice(_CHROME_VERSIONS)) as session:
                async with asyncio.timeout(total_timeout_s):
                    meta_map = await self._run_batch(session, list(url_to_indices))
        except asyncio.TimeoutError:
            logger.warning("[Enrich] Hard batch timeout %.1fs", total_timeout_s)
            meta_map = {}
        except Exception as exc:
            logger.error("[Enrich] Session error: %s", exc)
            return results

        for url, meta in meta_map.items():
            if meta:
                patch = meta.to_dict()
                for i in url_to_indices.get(url, []):
                    enriched[i] = {**enriched[i], **patch}

        return enriched

    # ── Public: enrich a plain list of URLs ──────────────────────────────────

    async def enrich_urls(
        self,
        urls:            list[str],
        total_timeout_s: float = 10.0,
    ) -> dict[str, dict]:
        """
        Enrich a list of raw URLs.
        Returns {url: enriched_dict} — missing URLs had no enrichment data.
        """
        if not urls:
            return {}

        unique = list(dict.fromkeys(urls))  # preserve order, deduplicate

        try:
            from curl_cffi.requests import AsyncSession
            async with AsyncSession(impersonate=random.choice(_CHROME_VERSIONS)) as session:
                async with asyncio.timeout(total_timeout_s):
                    meta_map = await self._run_batch(session, unique)
        except asyncio.TimeoutError:
            logger.warning("[Enrich] Hard batch timeout %.1fs", total_timeout_s)
            meta_map = {}
        except Exception as exc:
            logger.error("[Enrich] Session error: %s", exc)
            return {}

        return {url: m.to_dict() for url, m in meta_map.items() if m and m.has_useful_data()}

    # ── Internal: batch orchestration ─────────────────────────────────────────

    async def _run_batch(
        self,
        session:      Any,
        urls:         list[str],
    ) -> dict[str, Optional["EnrichedMeta"]]:
        """
        Runs all URL fetches concurrently, applies stagger + error-budget guard.
        Returns {url: EnrichedMeta | None}.
        """
        results: dict[str, Optional[EnrichedMeta]] = {}
        done_count   = 0
        failed_count = 0
        budget_aborted = False

        # Staggered task launch: avoid thundering herd on batch start
        stagger_s = self._stagger_ms / 1000.0

        async def fetch_with_stagger(url: str, delay: float) -> tuple[str, Optional[EnrichedMeta]]:
            if delay > 0:
                await asyncio.sleep(delay)
            meta = await self._fetch_one(session, url)
            return url, meta

        tasks = [
            asyncio.create_task(fetch_with_stagger(url, i * stagger_s))
            for i, url in enumerate(urls)
        ]

        for coro in asyncio.as_completed(tasks):
            if budget_aborted:
                break
            url, meta = await coro
            results[url] = meta
            done_count += 1
            if meta is None or not meta.has_useful_data():
                failed_count += 1

            # Error budget check (only meaningful after at least 8 results)
            if done_count >= 8 and (failed_count / done_count) > self._error_budget:
                logger.error(
                    "[Enrich] Error budget exceeded: %d/%d failed — aborting batch",
                    failed_count, done_count,
                )
                budget_aborted = True
                for t in tasks:
                    t.cancel()

        return results

    # ── Internal: single URL fetch pipeline ───────────────────────────────────

    async def _fetch_one(self, session: Any, url: str) -> Optional[EnrichedMeta]:
        if not url or not url.startswith("http"):
            return None

        # Cache hit
        cached = self._cache.get(url)
        if cached is not None:
            return cached

        domain = self._normalize_domain(url)
        state  = await self._get_domain_state(domain)
        config = state.config

        # Circuit breaker gate
        if not state.circuit_breaker.allow():
            logger.debug("[CB] %s blocked (circuit open)", domain)
            return None

        # Domain-level 429 pause
        wait_s = state.backoff_until - time.monotonic()
        if wait_s > 0:
            await asyncio.sleep(min(wait_s, 30.0))

        jitter_s = random.randint(*config.jitter_ms) / 1000.0

        async with state.semaphore:
            await asyncio.sleep(jitter_s)

            for attempt in range(config.max_retries + 1):
                try:
                    meta = await asyncio.wait_for(
                        self._do_fetch(session, url, domain, config),
                        timeout=config.timeout_s,
                    )
                    state.circuit_breaker.record_success()
                    self._cache[url] = meta
                    return meta

                except asyncio.TimeoutError:
                    state.circuit_breaker.record_failure()
                    if attempt < config.max_retries:
                        await asyncio.sleep(0.4 * (2 ** attempt))
                    continue

                except RateLimitError:
                    backoff = 1.5 * (2 ** attempt)
                    logger.warning("[Enrich] 429 %s → back-off %.1fs", domain, backoff)
                    state.backoff_until = time.monotonic() + backoff
                    state.circuit_breaker.record_failure()
                    await asyncio.sleep(backoff)
                    continue

                except BlockedError:
                    state.circuit_breaker.record_failure()
                    return None

                except Exception as exc:
                    logger.debug("[Enrich] %s error: %s: %s", url, type(exc).__name__, exc)
                    state.circuit_breaker.record_failure()
                    break

        return None

    async def _do_fetch(
        self,
        session: Any,
        url:     str,
        domain:  str,
        config:  DomainConfig,
    ) -> Optional[EnrichedMeta]:
        if config.use_api and domain == "eporner.com":
            return await self._parse_eporner_api(session, url)

        resp = await session.get(
            url,
            headers={"Accept-Language": "en-US,en;q=0.9", "Accept-Encoding": "gzip, deflate, br"},
            allow_redirects=True,
        )

        if resp.status_code == 429:
            raise RateLimitError()
        if resp.status_code == 403:
            raise BlockedError()
        if resp.status_code >= 400:
            return None

        # Cap response size — player scripts always in first 400 KB
        text = resp.text
        if len(text) > self._RESPONSE_SIZE_CAP:
            text = text[:self._RESPONSE_SIZE_CAP]

        parser = self._get_parser(domain)
        meta   = parser(text, url)
        if meta is not None:
            await self._attach_orientation(session, meta, text)

        if meta and not meta.has_useful_data():
            logger.warning(
                "[Parser] %s returned no enrichment data — site structure may have changed", domain
            )

        return meta

    async def _attach_orientation(self, session: Any, meta: EnrichedMeta, html: str) -> None:
        """Doplní orientáciu z reálnych rozmerov (OG/JSON-LD, inak HLS master).

        Šírka/výška sa zapisujú len ako dvojica z jedného zdroja, aby sa
        `height` z kvalitatívnych štítkov nemiešal so šírkou.
        """
        from .orientation import (dimensions_from_hls, dimensions_from_html,
                                  hls_urls_from_html, label_for)
        dims, evidence = dimensions_from_html(html), "page_dimensions"
        if not dims:
            candidates = hls_urls_from_html(html)
            candidates += [u for u in meta.stream_urls.values() if ".m3u8" in str(u)]
            for hls_url in list(dict.fromkeys(candidates))[:2]:
                try:
                    resp = await asyncio.wait_for(session.get(hls_url, allow_redirects=True), 6.0)
                    if resp.status_code < 400:
                        dims = dimensions_from_hls(resp.text[:200_000])
                except Exception:  # noqa: BLE001
                    continue
                if dims:
                    evidence = "stream_dimensions"
                    break
        if not dims:
            return
        width, height = dims
        meta.orientation = label_for(width, height)
        meta.orientation_evidence = evidence
        meta.aspect_ratio = round(width / height, 4)
        if not meta.height:
            meta.width, meta.height = width, height

    # ── Domain state management ───────────────────────────────────────────────

    async def _get_domain_state(self, domain: str) -> DomainState:
        # Fast path — no lock needed once populated (asyncio single-thread guarantee)
        if domain in self._domain_states:
            return self._domain_states[domain]
        async with self._init_lock:
            if domain not in self._domain_states:
                config = DOMAIN_CONFIGS.get(domain, DOMAIN_CONFIGS["_default"])
                self._domain_states[domain] = DomainState(
                    semaphore       = asyncio.Semaphore(config.concurrency),
                    circuit_breaker = CircuitBreaker(config.cb_threshold, config.cb_reset_s, domain),
                    config          = config,
                )
        return self._domain_states[domain]

    def _get_parser(self, domain: str):
        return {
            "xvideos.com":  self._parse_xvideos,
            "pornhub.com":  self._parse_pornhub,
            "xhamster.com": self._parse_xhamster,
        }.get(domain, self._parse_generic)

    @staticmethod
    def _normalize_domain(url: str) -> str:
        host = urlparse(url).hostname or ""
        parts = host.lower().lstrip("www.").split(".")
        return ".".join(parts[-2:]) if len(parts) >= 2 else host

    # ── Parsers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _parse_xvideos(html: str, url: str) -> EnrichedMeta:
        meta = EnrichedMeta()

        # Primary: xvideos_videodata JSON blob
        m = re.search(r'xvideos_videodata\s*=\s*(\{.+?\})\s*;', html, re.DOTALL)
        if m:
            try:
                data = json.loads(m.group(1))
                mp4_sources = data.get("sources", {}).get("mp4", {})
                meta.stream_urls = {q: u for q, u in mp4_sources.items() if u}
                meta.quality_variants = [
                    {"quality": q, "url": u, "size_bytes": None}
                    for q, u in mp4_sources.items() if u
                ]
                if mp4_sources:
                    qs = [int(q.rstrip("p")) for q in mp4_sources if q.rstrip("p").isdigit()]
                    if qs:
                        meta.height = max(qs)
            except Exception:
                pass

        # Fallback: html5player calls
        if not meta.stream_urls:
            for label, pat in [("high", r"html5player\.setVideoUrlHigh\('(.+?)'\)"),
                                ("low",  r"html5player\.setVideoUrlLow\('(.+?)'\)")]:
                m2 = re.search(pat, html)
                if m2:
                    meta.stream_urls[label] = m2.group(1)

        # Performers
        meta.performers = list(dict.fromkeys(
            re.findall(r'/pornstar-channels/([^/"]+)', html) or
            re.findall(r'class="model-profile"[^>]*>\s*<[^>]+>\s*([^<]+)', html)
        ))[:20]

        # Tags
        meta.tags = list(dict.fromkeys(
            re.findall(r'class="is-keyword-tag"[^>]*>[^<]*<[^>]+>([^<]+)</a>', html)
        ))[:30]

        # Structured data
        dm = re.search(r'"uploadDate"\s*:\s*"([^"]+)"', html)
        if dm:
            meta.upload_date = dm.group(1)[:10]

        vm = re.search(r'"interactionCount"\s*:\s*"(\d+)"', html)
        if vm:
            meta.views = int(vm.group(1))

        dur = re.search(r'"duration"\s*:\s*"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"', html)
        if dur:
            h_, m_, s_ = (int(x or 0) for x in dur.groups())
            meta.duration_s = h_ * 3600 + m_ * 60 + s_

        em = re.search(r'html5player\.setVideoEmbedCode\("([^"]+)"\)', html)
        if em:
            meta.embed_url = em.group(1)

        return meta

    @staticmethod
    def _parse_pornhub(html: str, url: str) -> EnrichedMeta:
        meta = EnrichedMeta()

        # Primary: flashvars_XXXXXX JSON — contains mediaDefinitions + file sizes
        m = re.search(r'var flashvars_\d+\s*=\s*(\{.+?\})\s*;', html, re.DOTALL)
        if m:
            try:
                data = json.loads(m.group(1))
                defs = data.get("mediaDefinitions", [])
                for d in defs:
                    q    = str(d.get("quality", ""))
                    vurl = d.get("videoUrl", "")
                    sz   = d.get("videoSize")
                    if vurl and q:
                        label = q + "p" if not q.endswith("p") else q
                        meta.quality_variants.append({"quality": label, "url": vurl, "size_bytes": sz})
                        meta.stream_urls[label] = vurl
                        if sz:
                            meta.file_sizes[label] = sz

                if meta.quality_variants:
                    qs = [int(v["quality"].rstrip("p")) for v in meta.quality_variants
                          if v["quality"].rstrip("p").isdigit()]
                    if qs:
                        meta.height = max(qs)

                meta.duration_s = _safe_int(data.get("video_duration"))
                meta.views      = _safe_int(data.get("video_views"))

            except Exception as exc:
                logger.debug("[PH parser] flashvars parse failed: %s", exc)

        # Performers
        meta.performers = list(dict.fromkeys(
            re.findall(r'/pornstar/([^/"?]+)', html)
        ))[:20]

        # Tags
        tag_m = re.findall(r'/video\?tags%5B%5D=([^"&]+)', html)
        if not tag_m:
            tag_m = re.findall(r'"name"\s*:\s*"([^"]+)"\s*,\s*"url"\s*:\s*"[^"]*tag', html)
        meta.tags = list(dict.fromkeys(tag_m))[:30]

        # Upload date + rating + likes from structured data / JSON-LD
        ud = re.search(r'"uploadDate"\s*:\s*"([^"]+)"', html)
        if ud:
            meta.upload_date = ud.group(1)[:10]

        rv = re.search(r'"ratingValue"\s*:\s*"?([0-9.]+)"?', html)
        if rv:
            meta.rating = _safe_float(rv.group(1))

        lk = re.search(r'"likesCount"\s*:\s*(\d+)', html)
        if lk:
            meta.likes = int(lk.group(1))

        dlk = re.search(r'"dislikesCount"\s*:\s*(\d+)', html)
        if dlk:
            meta.dislikes = int(dlk.group(1))

        return meta

    @staticmethod
    def _parse_xhamster(html: str, url: str) -> EnrichedMeta:
        meta = EnrichedMeta()

        # xHamster is Next.js — __NEXT_DATA__ has everything including file sizes
        m = re.search(
            r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.+?)</script>',
            html, re.DOTALL
        )
        if m:
            try:
                nd    = json.loads(m.group(1))
                props = nd.get("props", {}).get("pageProps", {})

                # Video sources with real file sizes (unique to xHamster!)
                sources = (
                    props.get("xplayerSettings", {})
                         .get("sources", {})
                         .get("mp4", [])
                )
                for s in sources:
                    q    = s.get("quality", "")
                    vurl = s.get("url", "")
                    sz   = s.get("size")
                    if vurl:
                        label = q if q.endswith("p") else q + "p" if q else "unknown"
                        meta.quality_variants.append({"quality": label, "url": vurl, "size_bytes": sz})
                        meta.stream_urls[label] = vurl
                        if sz:
                            meta.file_sizes[label] = sz

                if meta.quality_variants:
                    qs = [int(v["quality"].rstrip("p")) for v in meta.quality_variants
                          if v["quality"].rstrip("p").isdigit()]
                    if qs:
                        meta.height = max(qs)

                video = props.get("videoModel", {})
                meta.duration_s  = _safe_int(video.get("duration"))
                meta.views       = _safe_int(video.get("views"))
                meta.likes       = _safe_int(video.get("likes"))
                meta.dislikes    = _safe_int(video.get("dislikes"))
                meta.rating      = _safe_float(video.get("rating"))
                meta.upload_date = (video.get("created") or "")[:10]
                meta.embed_url   = (
                    props.get("xplayerSettings", {}).get("embedUrl", "")
                )

                meta.performers = [
                    p.get("name", "") for p in props.get("pornstars", [])
                    if p.get("name")
                ][:20]

                meta.tags = [
                    t.get("name", "") for t in video.get("categories", [])
                    if t.get("name")
                ][:30]

            except Exception as exc:
                logger.debug("[XH parser] __NEXT_DATA__ parse failed: %s", exc)

        return meta

    @staticmethod
    async def _parse_eporner_api(session: Any, url: str) -> Optional[EnrichedMeta]:
        """Eporner exposes a proper JSON API — no HTML scraping needed."""
        m = re.search(r'/video-([A-Za-z0-9]+)/', url)
        if not m:
            # Try fallback patterns
            m = re.search(r'eporner\.com/([A-Za-z0-9]{6,})/', url)
        if not m:
            return None

        video_id = m.group(1)
        api_url  = (
            f"https://www.eporner.com/api/v2/video/get/"
            f"?id={video_id}&thumbsize=big&format=json"
        )

        try:
            resp = await session.get(api_url, timeout=4.0)
            if resp.status_code != 200:
                return None
            data = resp.json()
        except Exception as exc:
            logger.debug("[Eporner API] %s: %s", url, exc)
            return None

        meta = EnrichedMeta()
        meta.duration_s  = _safe_int(data.get("length_sec"))
        meta.views       = _safe_int(data.get("views"))
        meta.rating      = _safe_float(data.get("rate"))
        meta.upload_date = (data.get("added") or "")[:10]
        meta.embed_url   = data.get("embed", "")

        meta.performers = [
            p.get("name") for p in data.get("pornstars", []) if p.get("name")
        ][:20]
        meta.tags = [
            k.get("keyword") for k in data.get("keywords", []) if k.get("keyword")
        ][:30]

        # Quality variants — Eporner API returns per-resolution URL keys
        for q_label, api_key, height in [
            ("4K",    "urls4k",   2160),
            ("1080p", "urls1080p", 1080),
            ("720p",  "urls720p",   720),
            ("480p",  "urls480p",   480),
        ]:
            entry = data.get(api_key, {})
            vurl  = entry.get("mp4") if isinstance(entry, dict) else None
            if vurl:
                meta.quality_variants.append({"quality": q_label, "url": vurl, "size_bytes": None})
                meta.stream_urls[q_label] = vurl

        if meta.quality_variants:
            q_order = {"4K": 2160, "1080p": 1080, "720p": 720, "480p": 480}
            meta.height = max(
                (q_order.get(v["quality"], 0) for v in meta.quality_variants),
                default=None
            )

        return meta

    @staticmethod
    def _parse_generic(html: str, url: str) -> EnrichedMeta:
        """Fallback: extract JSON-LD VideoObject structured data."""
        meta = EnrichedMeta()
        for m in re.finditer(
            r'<script[^>]+type="application/ld\+json"[^>]*>(.+?)</script>',
            html, re.DOTALL
        ):
            try:
                ld = json.loads(m.group(1))
                if isinstance(ld, list):
                    ld = next(
                        (x for x in ld if x.get("@type") in ("VideoObject", "Movie")),
                        None
                    )
                if not ld:
                    continue
                meta.upload_date = (ld.get("uploadDate") or "")[:10]
                meta.views       = _safe_int(
                    (ld.get("interactionStatistic") or {}).get("userInteractionCount")
                    or ld.get("interactionCount")
                )
                meta.rating = _safe_float(
                    (ld.get("aggregateRating") or {}).get("ratingValue")
                )
                dur = ld.get("duration", "")
                dm  = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', dur)
                if dm:
                    h_, mn_, s_ = (int(x or 0) for x in dm.groups())
                    meta.duration_s = h_ * 3600 + mn_ * 60 + s_
                if meta.upload_date or meta.views or meta.duration_s:
                    break
            except Exception:
                continue
        return meta


# ── Helpers ───────────────────────────────────────────────────────────────────

def _safe_int(v: Any) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(str(v).replace(",", "").replace(".", "").strip())
    except Exception:
        return None


def _safe_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return round(float(v), 1)
    except Exception:
        return None


# ── Module-level singleton ────────────────────────────────────────────────────

_service: Optional[MetaEnrichmentService] = None


def get_enrichment_service() -> MetaEnrichmentService:
    global _service
    if _service is None:
        _service = MetaEnrichmentService()
    return _service
