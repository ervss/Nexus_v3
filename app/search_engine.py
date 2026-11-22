import requests
from bs4 import BeautifulSoup
import urllib.parse
from html import unescape as _html_unescape
import logging
import re
import asyncio
from contextvars import ContextVar
import aiohttp
import httpx
import lxml
from .cyberleaks_discovery import scrape_cyberleaks_discovery
from .websockets import manager
from .telegram_auth import manager as tg_auth_manager
from .telegram_stream import public_chat_id

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
_source_trace = ContextVar('quality_hunt_source_trace', default=None)


def _record_source_http(status):
    trace = _source_trace.get()
    if trace is not None and status >= 400:
        trace.setdefault('http_failures', []).append(status)


def _record_source_exception(error):
    trace = _source_trace.get()
    if trace is not None:
        trace.setdefault('errors', []).append(type(error).__name__)


def _exception_summary(error):
    """Return a useful message even for exceptions such as TimeoutError."""
    name = type(error).__name__
    detail = str(error).strip()
    return f"{name}: {detail}" if detail else name


def _log_search_failure(context, error):
    summary = _exception_summary(error)
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        logger.warning("%s timed out (%s)", context, summary)
    else:
        logger.error("%s failed: %s", context, summary)

import random
import os
import sys
from telethon.sync import TelegramClient
from telethon import functions, types
from dotenv import load_dotenv

# Ensure we can import from the root extractors package
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app.extractors.legacy.xenforo import XenForoExtractor

load_dotenv()

_SEARXNG_SEARCH = "http://127.0.0.1:8888/search"

# Zámok pre Telethon SQLite session a circuit breaker pre nedostupné externé služby
import time as _time
_TELETHON_SEARCH_LOCK = asyncio.Lock()
_SEARXNG_DOWN_UNTIL: float = 0.0
_SOURCE_FAIL_COUNTS: dict[str, int] = {}
_SOURCE_OPEN_UNTIL: dict[str, float] = {}

_DEFAULT_RELATED_FAST_SOURCES = [
    "eporner", "xvideos", "pornhub", "xhamster", "porntrex",
    "whoreshub", "spankbang", "fpo", "erome", "noodlemagazine",
    "camwhores", "pornone", "bunkr",
]


def _source_circuit_is_open(source_key: str) -> bool:
    """Vráti True ak je zdroj dočasne pozastavený po opakovaných zlyhaniach."""
    until = _SOURCE_OPEN_UNTIL.get(source_key, 0.0)
    if until <= 0:
        return False
    if _time.monotonic() >= until:
        _SOURCE_OPEN_UNTIL.pop(source_key, None)
        _SOURCE_FAIL_COUNTS.pop(source_key, None)
        return False
    return True


def _record_source_health(source_key: str, ok: bool) -> None:
    """Aktualizuje počítadlo zlyhaní zdroja pre automatický circuit breaker."""
    if ok:
        _SOURCE_FAIL_COUNTS.pop(source_key, None)
        _SOURCE_OPEN_UNTIL.pop(source_key, None)
        return
    fails = _SOURCE_FAIL_COUNTS.get(source_key, 0) + 1
    _SOURCE_FAIL_COUNTS[source_key] = fails
    if fails >= 3:
        # Pozastavíme zdroj v automatickom mixe na 5 minút
        _SOURCE_OPEN_UNTIL[source_key] = _time.monotonic() + 300.0


# Global shared httpx client for ExternalSearchEngine to prevent connection leaks
# and enable true connection pooling across requests.
_shared_async_client = None

def _get_shared_client():
    global _shared_async_client
    if _shared_async_client is None:
        limits = httpx.Limits(max_keepalive_connections=50, max_connections=200)
        _shared_async_client = httpx.AsyncClient(limits=limits, timeout=20.0, follow_redirects=True)
    return _shared_async_client

class ExternalSearchEngine:
    _SOURCE_FALLBACKS = {
        'erome': ('erome.com', 'Erome'),
        'xvideos': ('xvideos.com', 'XVideos'),
        'pornhub': ('pornhub.com', 'Pornhub'),
        'eporner': ('eporner.com', 'Eporner'),
        'whoreshub': ('whoreshub.com', 'WhoresHub'),
        'porntrex': ('porntrex.com', 'PornTrex'),
        'gofile': ('gofile.io', 'GoFile'),
        'spankbang': ('spankbang.com', 'SpankBang'),
        'xhamster': ('xhamster.com', 'xHamster'),
        'ixxx': ('ixxx.com', 'iXXX'),
        'noodlemagazine': ('noodlemagazine.com', 'NoodleMagazine'),
        'hqporner': ('hqporner.com', 'HQPorner'),
        'mypornerleak': ('mypornerleak.com', 'MyPornerLeak'),
        'slutvids': ('slutvids.net.lv', 'SlutVids'),
        'pimpbunny': ('pimpbunny.com', 'PimpBunny'),
        'hornysimp': ('hornysimp.com', 'HornySimp'),
        'camwhores': ('camwhores.tv', 'Camwhores'),
        'nsfw247': ('nsfw247.to', 'NSFW247'),
        'beeg': ('beeg.com', 'Beeg'),
        'pixeldrain': ('pixeldrain.com', 'Pixeldrain'),
        'leakporner': ('leakporner.com', 'LeakPorner'),
        'djav': ('djav.org', 'DJAV'),
        'oneporn': ('1porn.tv', '1Porn'),
        'cyberleaks': ('cyberleaks.top', 'CyberLeaks'),
        'simpcity': ('simpcity.su', 'SimpCity'),
        'kemono': ('kemono.su', 'Kemono / Coomer'),
        'bunkr': ('bunkr.si', 'Bunkr'),
        'internetchicks': ('internetchicks.com', 'InternetChicks'),
    }

    def __init__(self):
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
        }
        self.ssl_context = False
        self.tg_client = None
        self._init_telegram()

    def _init_telegram(self):
        try:
            api_id = os.getenv('TELEGRAM_API_ID')
            api_hash = os.getenv('TELEGRAM_API_HASH')
            if api_id and api_hash and os.path.exists('telegram_session.session'):
                # We use a non-async wrapper here or initialize in search
                # For aiohttp apps, we should init client inside async method
                pass
        except: pass

    async def _fetch_impersonated(self, url: str, referer: str = None, timeout: int = 18):
        """
        Fetch a URL using curl_cffi with a real Chrome TLS fingerprint.

        Some sources (Pornhub, NoodleMagazine, …) reject aiohttp at the TLS layer
        (HTTP 410 / 403) even with perfect headers, because the TLS/JA3 signature
        gives it away. curl_cffi impersonates a browser so those requests succeed.
        Runs in a thread so it doesn't block the event loop. Returns HTML text or
        None on failure.
        """
        def _do():
            try:
                from curl_cffi import requests as _creq
                headers = {}
                if referer:
                    headers['Referer'] = referer
                r = _creq.get(url, impersonate='chrome', timeout=timeout,
                              headers=headers or None)
                _record_source_http(r.status_code)
                if r.status_code == 200:
                    return r.text
                logger.warning(f"[impersonate] {url} -> HTTP {r.status_code}")
            except Exception as e:
                _record_source_exception(e)
                logger.warning(f"[impersonate] {url} failed: {e}")
            return None
        try:
            return await asyncio.to_thread(_do)
        except Exception as e:
            _record_source_exception(e)
            logger.warning(f"[impersonate] thread error for {url}: {e}")
            return None

    def _build_query_variants(self, query: str):
        raw = (query or "").strip()
        if not raw:
            return []

        variants = []

        def add_variant(value: str):
            cleaned = re.sub(r'\s+', ' ', (value or '').strip())
            if cleaned and cleaned not in variants:
                variants.append(cleaned)

        add_variant(raw)

        split_terms = [
            term.strip()
            for term in re.split(r'[,;|]+', raw)
            if term and term.strip()
        ]
        if len(split_terms) > 1:
            add_variant(" ".join(split_terms))
            for term in split_terms[:6]:
                add_variant(term)

        return variants[:8]

    def _merge_unique_results(self, batches):
        merged = []
        seen_urls = set()
        for batch in batches:
            for item in batch or []:
                url = item.get('url')
                if not url or url in seen_urls:
                    continue
                merged.append(item)
                seen_urls.add(url)
        return merged

    def _score_result(self, result: dict, query: str) -> tuple:
        """Return (relevance_score, quality_score, duration_seconds) for sorting.
        Higher is better for all three dimensions."""
        title = (result.get('title') or '').lower()
        query_words = [w.strip() for w in re.split(r'[\s,;|]+', query.lower()) if w.strip()]

        # Relevance: how many query words appear in the title, weighted by position
        relevance = 0
        for word in query_words:
            if word in title:
                relevance += 3
                if title.startswith(word):
                    relevance += 2  # bonus for leading match
        # Exact phrase match bonus
        if query.lower() in title:
            relevance += 10

        # Quality score
        quality_str = (result.get('quality') or '').lower()
        if '4k' in quality_str or '2160' in quality_str:
            quality = 4
        elif '1080' in quality_str or 'fhd' in quality_str:
            quality = 3
        elif '720' in quality_str or 'hd' in quality_str:
            quality = 2
        elif 'sd' in quality_str or '480' in quality_str or '360' in quality_str:
            quality = 1
        else:
            quality = 0

        # Duration in seconds
        raw_dur = result.get('duration') or 0
        duration = 0
        try:
            if isinstance(raw_dur, (int, float)):
                duration = int(raw_dur)
            else:
                d = str(raw_dur).strip()
                if ':' in d:
                    parts = d.split(':')
                    if len(parts) == 3:
                        duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                    elif len(parts) == 2:
                        duration = int(parts[0]) * 60 + int(parts[1])
                elif d.isdigit():
                    duration = int(d)
        except Exception:
            duration = 0

        return (relevance, quality, duration)

    def _sort_by_relevance(self, results: list, query: str) -> list:
        """Sort results: primary=relevance desc, secondary=quality desc, tertiary=duration desc."""
        scored = [(r, self._score_result(r, query)) for r in results]
        scored.sort(key=lambda x: (x[1][0], x[1][1], x[1][2]), reverse=True)
        return [r for r, _ in scored]

    async def _fallback_search_for_source(self, key: str, query: str):
        fallback = self._SOURCE_FALLBACKS.get((key or '').lower())
        if not fallback:
            return []
        site, label = fallback
        results = await self.search_via_yahoo_async(query, site, label)
        if results:
            return results
        return await self.search_via_duckduckgo_async(query, site, label)

    def _merge_interleave_results(self, results):
        """Interleave results from different sources for variety."""
        source_mapped = {}
        for r in results:
            if not isinstance(r, dict) or not r.get('url'):
                continue
            src = r.get('source') or 'unknown'
            if src not in source_mapped:
                source_mapped[src] = []
            source_mapped[src].append(r)

        mixed_results = []
        seen_urls = set()
        max_len = max([len(v) for v in source_mapped.values()]) if source_mapped else 0

        for i in range(max_len):
            for src in sorted(source_mapped.keys()):
                if i < len(source_mapped[src]):
                    r = source_mapped[src][i]
                    if r['url'] not in seen_urls:
                        mixed_results.append(r)
                        seen_urls.add(r['url'])

        return mixed_results

    async def _run_single_discovery_source(self, query: str, key: str, result_limit: int = 30,
                                           required_identity: str = "", trace: dict = None,
                                           candidate_callback=None, expand_variants: bool = True,
                                           enrich: bool = True, strict_query: bool = False, min_quality: int = 0,
                                           allow_fallback: bool = True):
        """Run one canonical discovery source dynamically."""
        # Normalize key to method name
        method_name = f"search_{key.lower().replace('.', '_')}_async"
        fn = getattr(self, method_name, None)
        if trace is not None:
            trace['search_method'] = 'native' if fn else 'site_fallback'

        identity_key = re.sub(r'[^a-z0-9]', '', (required_identity or '').lower())

        def _item_matches_identity(item) -> bool:
            title_str = str(item.get('title') or '')
            if identity_key and identity_key in re.sub(r'[^a-z0-9]', '', title_str.lower()):
                return True
            try:
                from .quality_hunt import performer_present
                return performer_present(required_identity, title_str)
            except Exception:
                return False

        def identity_matches(items):
            if trace is not None:
                trace['parsed'] = trace.get('parsed', 0) + len(items)
            if strict_query:
                from .search_pipeline import matches_query
                matched = [item for item in items if matches_query(item, query)]
                if trace is not None:
                    trace['query_filtered'] = trace.get('query_filtered', 0) + len(items) - len(matched)
                items = matched
            if not identity_key and not (required_identity or '').strip():
                return items
            matches = [item for item in items if _item_matches_identity(item)]
            if trace is not None:
                trace['identity_filtered'] = trace.get('identity_filtered', 0) + len(items) - len(matches)
            return matches

        variants = self._build_query_variants(query) if expand_variants else [query]
        if not variants:
            return []

        async def fallback_variants(queries):
            batches = []
            for variant in queries:
                batch = identity_matches(await self._fallback_search_for_source(key, variant) or [])
                if batch:
                    batches.append(batch)
                    if candidate_callback:
                        await candidate_callback(batch)
            return self._merge_unique_results(batches)

        if not fn:
            # Fallback to Yahoo/DDG for any key in catalog that doesn't have a direct method
            from .source_catalog import DISCOVERY_SEARCH_SOURCE_KEYS
            if key in DISCOVERY_SEARCH_SOURCE_KEYS:
                logger.info(f"Using fallback site search for {key}")
                return await fallback_variants(variants)
            logger.warning(f"No search method or fallback found for source key: {key}")
            return []

        # Fetch more than needed so ranking can pick the best ones
        fetch_limit = max(30, min(int(result_limit or 30) * 2, 200))

        # B4: run the top query variants concurrently instead of one-at-a-time.
        # The first variant is the strongest signal, so cap the fan-out at 3 to
        # balance speed against load on the source site.
        async def _run_variant(variant: str):
            try:
                try:
                    if identity_key and key == 'camwhores':
                        return await fn(variant, result_limit=fetch_limit, enrich_quality=False,
                                        include_private=True)
                    if key == 'camwhores' and not enrich:
                        return await fn(variant, result_limit=fetch_limit, enrich_quality=False)
                    return await fn(variant, result_limit=fetch_limit)
                except TypeError:
                    return await fn(variant)
            except Exception as e:
                _record_source_exception(e)
                if trace is not None:
                    trace.setdefault('errors', []).append(type(e).__name__)
                logger.error(f"Single-source search failed for {key} with query '{variant}': {e}")
                return []

        primary = variants[:3] if expand_variants else [query]
        if min_quality:
            quality_term = '4k' if min_quality >= 2160 else f'{min_quality}p'
            primary = list(dict.fromkeys([query, f'{query} {quality_term}']))
        async def indexed_variant(index, variant):
            return index, await _run_variant(variant)
        tasks = [asyncio.create_task(indexed_variant(i, v)) for i, v in enumerate(primary)]
        batches = {}
        try:
            for completed in asyncio.as_completed(tasks):
                index, raw = await completed
                batch = identity_matches(raw or [])
                if batch:
                    batches[index] = batch
                    if candidate_callback:
                        await candidate_callback(batch)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        merged = self._merge_unique_results([batches[index] for index in sorted(batches)])
        if merged or not allow_fallback:
            return merged

        return await fallback_variants(primary)

    async def search(self, query: str, source: str = None, result_limit: int = 30):
        """
        Main search method that aggregates results from multiple sources.
        If ``source`` is set to a recognized key, only that source is queried.
        Unrecognized non-empty tokens fall back to the full parallel search (legacy).
        Results are ranked by: relevance (word match) > quality > duration.
        """
        from .source_catalog import normalize_search_source_key

        results = []
        final_limit = max(1, min(int(result_limit or 30), 200))

        if source and str(source).strip():
            key = normalize_search_source_key(source)
            if key:
                raw = await self._run_single_discovery_source(query, key, result_limit=final_limit)
                return self._sort_by_relevance(raw, query)[:final_limit]

        # Parallel execution
        async def with_timeout(coro, seconds=15):
            try:
                return await asyncio.wait_for(coro, timeout=seconds)
            except Exception:
                return []

        # Parallel execution of all registered discovery sources
        from .source_catalog import DISCOVERY_SEARCH_SOURCE_KEYS
        
        tasks = [self.search_local_async(query)]
        # Each source fetches up to 2x the limit so we have enough candidates to rank
        per_source_limit = max(10, final_limit * 2)
        
        for key in DISCOVERY_SEARCH_SOURCE_KEYS:
            # Avoid redundant search for aliases or local
            if key in ('local', 'gallery'): continue
            
            # Map key to method
            method_name = f"search_{key}_async"
            fn = getattr(self, method_name, None)
            
            if fn:
                # Use source-specific timeouts if needed, default to 15s
                timeout = 15
                if key == 'bunkr': timeout = 25
                elif key == 'ixxx': timeout = 20
                elif key == 'telegram': timeout = 30
                
                try:
                    tasks.append(with_timeout(fn(query, result_limit=per_source_limit), timeout))
                except TypeError:
                    tasks.append(with_timeout(fn(query), timeout))
            else:
                # Generic fallback for catalog keys without direct methods
                tasks.append(with_timeout(self.search_via_yahoo_async(query, f"{key}.com", key.capitalize()), 15))

        search_results = await asyncio.gather(*tasks, return_exceptions=True)

        for res in search_results:
            if isinstance(res, list):
                results.extend(res)
            elif isinstance(res, Exception):
                logger.error(f"Search error: {res}")

        # Deduplicate, then rank by relevance > quality > duration
        seen_urls = set()
        unique_results = []
        for r in results:
            url = r.get('url')
            if url and url not in seen_urls:
                unique_results.append(r)
                seen_urls.add(url)

        ranked = self._sort_by_relevance(unique_results, query)
        return ranked[:final_limit]

    async def search_sources(self, query: str, source_keys: list, result_limit: int = 24,
                             online_only: bool = False, return_diagnostics: bool = False,
                             search_depth: int = 1, progress_callback=None,
                             per_source_limit: int = None, global_limit: int = None,
                             **_ignored):
        """
        Search only the given canonical source keys (non-empty after validation).
        If the list is empty after validation, runs the full parallel search.

        Extra params (used by the related-recommendations engine):
          online_only        — kept for API compatibility (results are live already)
          return_diagnostics — return {"results": [...], "diagnostics": [...]} instead
                               of a bare list, with a per-source status breakdown
          search_depth       — scales per-source timeouts for deeper crawls
          progress_callback  — optional async/sync callback(source_key) per source
        """
        from .source_catalog import filter_valid_discovery_sources

        keys = filter_valid_discovery_sources(source_keys)
        explicit_sources = bool(keys)
        if not keys:
            # Pri voľbe "Všetky" použijeme kurátorovaný zoznam rýchlych zdrojov namiesto
            # starého self.search(), aby fungovalo streamovanie aj partial_sink.
            keys = [k for k in _DEFAULT_RELATED_FAST_SOURCES if not _source_circuit_is_open(k)]
            if len(keys) < 5:
                keys = list(_DEFAULT_RELATED_FAST_SOURCES)

        depth_mult = 1 + max(0, (int(search_depth or 1) - 1)) * 0.5

        # How many results to pull from each source, and how many to keep overall.
        # Frontend "Per source" maps to per_source_limit; "Total" maps to global_limit.
        per_src = max(1, min(int(per_source_limit or result_limit or 24), 200))
        total_cap = max(1, min(int(global_limit or result_limit or 24) if (global_limit or result_limit) else 200, 2000))

        async def with_timeout(coro, seconds=15):
            try:
                return await asyncio.wait_for(coro, timeout=seconds * depth_mult)
            except Exception as exc:
                _record_source_exception(exc)
                return exc

        timeout_map = {
            'erome': 12,
            'kemono': 12,
            'xvideos': 12,
            'pornhub': 12,
            'eporner': 12,
            'whoreshub': 15,
            'porntrex': 15,
            'bunkr': 20,
            'gofile': 15,
            'spankbang': 12,
            'xhamster': 15,
            'ixxx': 18,
            'telegram': 30,
            'cyberleaks': 15,
            'internetchicks': 15,
        }

        # Partial-result sink: each source drops its hits here the moment it
        # finishes. If an OUTER timeout (related_recommendations.run_query) kills
        # this coroutine mid-flight, the caller can still harvest whatever the
        # already-finished sources produced instead of losing everything.
        partial_results: list = []
        partial_diagnostics: list = []
        if isinstance(_ignored.get("partial_sink"), dict):
            sink = _ignored["partial_sink"]
            sink.setdefault("results", partial_results)
            sink.setdefault("diagnostics", partial_diagnostics)
            partial_results = sink["results"]
            partial_diagnostics = sink["diagnostics"]

        async def _one(k):
            started_at = asyncio.get_running_loop().time()
            trace = {}
            source_kwargs = {"result_limit": per_src}
            if _ignored.get('strict_query'):
                source_kwargs.update(strict_query=True, expand_variants=False)
            if _ignored.get('min_quality'):
                source_kwargs['min_quality'] = int(_ignored['min_quality'])
            early_results = []
            if _ignored.get('preserve_partial'):
                async def preserve(batch):
                    early_results.extend(batch)
                source_kwargs['candidate_callback'] = preserve
            if _ignored.get('enrich') is False:
                source_kwargs['enrich'] = False
            if _ignored.get('trace_filters'):
                source_kwargs['trace'] = trace
            if _ignored.get('allow_fallback') is False:
                source_kwargs['allow_fallback'] = False
            if _ignored.get('expand_variants') is False:
                source_kwargs['expand_variants'] = False
            if _ignored.get("required_identity"):
                source_kwargs["required_identity"] = _ignored["required_identity"]
            if _ignored.get('stream_candidates'):
                async def discovered(batch):
                    partial_results.extend(batch)
                    if progress_callback:
                        callback = progress_callback(k, len(batch), 'running')
                        if asyncio.iscoroutine(callback):
                            await callback
                source_kwargs['candidate_callback'] = discovered
                source_kwargs['expand_variants'] = False  # Hunt already sends its three identity queries.
            token = _source_trace.set(trace if _ignored.get('trace_filters') else None)
            try:
                res = await with_timeout(
                    self._run_single_discovery_source(query, k, **source_kwargs),
                    min(timeout_map.get(k, 15), float(_ignored['source_timeout'])) / depth_mult
                        if _ignored.get('source_timeout') else timeout_map.get(k, 15))
            finally:
                _source_trace.reset(token)
            partial_timeout = isinstance(res, asyncio.TimeoutError) and bool(early_results)
            if partial_timeout:
                res = self._merge_unique_results([early_results])
            if isinstance(res, list):
                partial_results.extend(res)
                cnt, status = len(res), ("partial_timeout" if partial_timeout else ("ok" if res else "empty"))
            elif isinstance(res, asyncio.TimeoutError):
                cnt, status = 0, "timeout"
            elif isinstance(res, Exception):
                cnt, status = 0, "error"
            else:
                cnt, status = 0, "empty"
            if status == 'empty':
                failures = trace.get('http_failures', [])
                if 429 in failures: status = 'rate_limited'
                elif any(code in {401, 403} for code in failures): status = 'auth_required'
                elif any(e in {'JSONDecodeError', 'ValueError', 'KeyError', 'TypeError'} for e in trace.get('errors', [])): status = 'parse_error'
                elif failures or trace.get('errors'): status = 'unavailable'
            elif status in ("timeout", "error"):
                _record_source_health(k, False)
            if isinstance(res, list) and res:
                _record_source_health(k, True)

            diag_entry = {
                "source_key": k, "status": status, "count": cnt,
                "sample_urls": [r.get("url") for r in res[:3] if isinstance(r, dict)] if isinstance(res, list) else [],
                # Preserve the public diagnostics payload used by the UI and
                # existing callers. Only terminal rendering needs the added
                # exception class for otherwise-empty TimeoutError messages.
                "error": str(res) if isinstance(res, Exception) else None,
                'elapsed_ms': round((asyncio.get_running_loop().time() - started_at) * 1000),
                'raw_count': trace.get('parsed', cnt), 'identity_filtered': trace.get('identity_filtered', 0),
                'query_filtered': trace.get('query_filtered', 0),
                'search_method': trace.get('search_method', 'unknown'),
                'warnings': trace.get('errors', []),
                'http_failures': trace.get('http_failures', []),
            }
            partial_diagnostics.append(diag_entry)
            if progress_callback is not None:
                if isinstance(res, list):
                    cnt, status = len(res), ("ok" if res else "empty")
                elif isinstance(res, asyncio.TimeoutError):
                    cnt, status = 0, "timeout"
                elif isinstance(res, Exception):
                    cnt, status = 0, "error"
                else:
                    cnt, status = 0, "empty"
                try:
                    cb = progress_callback(k, cnt, status)
                    if asyncio.iscoroutine(cb):
                        await cb
                except Exception:
                    pass
            source_cb = _ignored.get("source_callback")
            if source_cb is not None:
                try:
                    scb = source_cb(k, res if isinstance(res, list) else [], diag_entry)
                    if asyncio.iscoroutine(scb):
                        await scb
                except Exception:
                    pass
            return k, res

        tasks = [asyncio.create_task(_one(k)) for k in keys]
        results = []
        diagnostics = partial_diagnostics
        try:
            for done_task in asyncio.as_completed(tasks):
                try:
                    k, res = await done_task
                    if isinstance(res, list):
                        results.extend(res)
                    elif isinstance(res, Exception):
                        _log_search_failure(f"Search source [{k}]", res)
                except Exception as entry_exc:
                    _log_search_failure("Search task", entry_exc)
        finally:
            for t in tasks:
                if not t.done():
                    t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        merged = self._merge_interleave_results(results)[:total_cap]
        if return_diagnostics:
            return {"results": merged, "diagnostics": diagnostics}
        return merged

    async def search_bunkr_async(self, query: str):
        """
        Searches Bunkr across multiple domains with high efficiency.
        """
        results = []
        # Extensive list of Bunkr mirrors and related domains
        domains = [
            "bunkr.la", "bunkr.si", "bunkr.is", "bunkr-albums.io", 
            "bunkr.cr", "bunkr.black", "bunkr.su", "bunkr.pk",
            "bunkrr.su", "bunkr.ws"
        ]
        
        async def fetch_from_domain(domain):
            try:
                # Try multiple search paths commonly used by Bunkr mirrors
                search_paths = [
                    f"/s?search={urllib.parse.quote(query)}",
                    f"/search?q={urllib.parse.quote(query)}",
                    f"/search?search={urllib.parse.quote(query)}"
                ]
                
                html = ""
                async with aiohttp.ClientSession(headers=self.headers) as session:
                    for path in search_paths:
                        try:
                            search_url = f"https://{domain}{path}"
                            async with session.get(search_url, timeout=5, ssl=self.ssl_context) as resp:
                                _record_source_http(resp.status)
                                if resp.status == 200:
                                    html = await resp.text()
                                    if "no results" not in html.lower() and len(html) > 1000:
                                        break
                        except:
                            continue
                
                if not html:
                    return []

                soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
                # Improved selectors for various Bunkr versions
                items = soup.select('a[href*="/album/"], a[href*="/v/"], a[href*="/a/"], a[href*="/f/"]')
                
                domain_results = []
                for item in items:
                    href = item.get('href')
                    if not href or any(x in href for x in ['login', 'register', 'contact', 'tos']): 
                        continue
                    
                    full_url = href if href.startswith('http') else f"https://{domain}{href}"
                    
                    # Extract title with better hierarchy
                    title = item.get_text(strip=True)
                    if not title or len(title) < 4:
                        # Try to find title in adjacent elements (Bunkr often puts title in a p or div near the link)
                        parent = item.parent
                        if parent:
                            potential_title = parent.select_one('p, .title, .name, h1, h2, h3, h4, b, strong')
                            if potential_title:
                                title = potential_title.get_text(strip=True)
                    
                    # Clean up title
                    if not title or len(title) < 4:
                        title = full_url.split('/')[-1].replace('-', ' ').replace('_', ' ').title()
                    
                    # Filter out useless titles
                    if title.lower() in ['download', 'view', 'link', 'video', 'album']:
                        continue

                    # Attempt to find thumbnail if possible
                    thumbnail = None
                    img = item.select_one('img')
                    if img:
                        thumbnail = img.get('src') or img.get('data-src')
                        if thumbnail and not thumbnail.startswith('http'):
                            thumbnail = f"https://{domain}{thumbnail}"

                    domain_results.append({
                        'source': f'Bunkr ({domain})',
                        'title': title,
                        'url': full_url,
                        'description': f'Bunkr { "Album" if "/a/" in full_url or "/album/" in full_url else "File"}',
                        'thumbnail': thumbnail
                    })
                return domain_results
            except Exception as e:
                _record_source_exception(e)
                logger.debug(f"Error searching Bunkr domain {domain}: {e}")
                return []

        # Run multiple domains in parallel
        # Prioritize known active mirrors
        active_domains = [
            "bunkr.si", "bunkr.la", "bunkr.is", "bunkr-albums.io", "bunkr.cr", 
            "bunkr.black", "bunkrr.su", "bunkr.su", "bunkr.pk", "bunkr.ws", "bunkr.vc",
            "bunkr.ru", "bunkr.media", "bunkr.to"
        ]
        
        tasks = [fetch_from_domain(d) for d in active_domains]
        batch_results = await asyncio.gather(*tasks)
        
        for res in batch_results:
            results.extend(res)
            
        # Fallback to general search engines if no direct results found or to augment results
        # We increase pagination here to get closer to the user's "50 results" target
        if len(results) < 50:
            fallback_tasks = [
                self.search_via_duckduckgo_async(query, "bunkr.si", "Bunkr (Deep)"),
                self.search_via_duckduckgo_async(query, "bunkr-albums.io", "Bunkr (Deep)"),
                self.search_via_yahoo_async(query, "bunkr.si", "Bunkr (Deep)"),
                self.search_via_yahoo_async(query, "bunkr.la", "Bunkr (Deep)"),
                self.search_via_duckduckgo_async(query, "bunkrr.su", "Bunkr (Deep)"),
                self.search_simpcity_async(query) # Add SimpCity for Bunkr links
            ]
            fallbacks = await asyncio.gather(*fallback_tasks)
            for f_res in fallbacks:
                results.extend(f_res)
            
        # Deduplicate results by URL
        seen = set()
        final_results = []
        for r in results:
            if r['url'] not in seen:
                # Basic validation: ensure it's a bunkr/bunkrr link or from simpcity
                is_valid = any(x in r['url'].lower() for x in ['bunkr', 'bunkrr', 'simpcity'])
                if is_valid:
                    final_results.append(r)
                    seen.add(r['url'])
                
        return final_results[:100] # Cap at 100 for performance

    async def search_gofile_async(self, query: str):
        """
        Searches Gofile links. Since Gofile doesn't have a public search,
        we use indexed search engines to find gofile.io links.
        """
        return await self.search_via_yahoo_async(query, "gofile.io", "Gofile")

    async def search_pixeldrain_async(self, query: str):
        """
        Searches Pixeldrain links via Yahoo.
        """
        return await self.search_via_yahoo_async(query, "pixeldrain.com", "Pixeldrain")

    async def _searxng_results(self, query: str, engines: str | None = None) -> list:
        params = {"q": query, "format": "json"}
        if engines:
            params["engines"] = engines
        url = f"{_SEARXNG_SEARCH}?{urllib.parse.urlencode(params)}"
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=20) as resp:
                _record_source_http(resp.status)
                if resp.status != 200:
                    logger.error("Telegram search via SearXNG failed: %s", resp.status)
                    return []
                payload = await resp.json(content_type=None)
        rows = payload.get("results") if isinstance(payload, dict) else None
        return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []

    @staticmethod
    def _telegram_rows_from_searx(rows: list) -> list:
        results = []
        seen = set()
        for row in rows:
            url = str(row.get("url") or "").strip()
            if "t.me/" not in url or url in seen:
                continue
            seen.add(url)
            title = str(row.get("title") or "").strip() or url.rsplit("/", 1)[-1]
            content = str(row.get("content") or "").strip()
            results.append({
                "source": "Telegram",
                "title": title,
                "url": url,
                "description": content or "Telegram channel/post",
            })
            if len(results) >= 30:
                break
        return results

    async def _search_telegram_web(self, query: str) -> list:
        """Public t.me pages from the local SearXNG instance."""
        global _SEARXNG_DOWN_UNTIL
        if _time.monotonic() < _SEARXNG_DOWN_UNTIL:
            return []
        try:
            # http://127.0.0.1:8888/search?q=site:t.me+QUERY&format=json
            rows = await self._searxng_results(f"site:t.me {query}")
            results = self._telegram_rows_from_searx(rows)
            if results:
                return results
            # The open mix on this instance often answers with zero t.me URLs.
            # Yandex on the same SearXNG does return them.
            rows = await self._searxng_results(f"site:t.me {query}", engines="yandex")
            return self._telegram_rows_from_searx(rows)
        except Exception as exc:
            _record_source_exception(exc)
            # Ak lokálny SearXNG port nebeží, pozastavíme dopyty na 3 minúty
            if "refused" in str(exc).lower() or isinstance(exc, (aiohttp.ClientConnectorError, OSError)):
                _SEARXNG_DOWN_UNTIL = _time.monotonic() + 180.0
            logger.error("Telegram search via SearXNG failed: %s", _exception_summary(exc))
            return []

    async def search_telegram_async(self, query: str):
        """
        Searches local FTS5 index first (sub-millisecond), then public Telegram pages, then the logged-in account.
        """
        results = []
        # 1. Ultra-fast Local FTS5 lookup (<5ms)
        try:
            from .database import SessionLocal
            from .telegram_index import search_telegram_fts
            with SessionLocal() as db:
                fts_items = search_telegram_fts(db, query, limit=30)
                if fts_items:
                    for item in fts_items:
                        channel_lbl = item.get("channel") or item.get("author") or "Telegram"
                        results.append({
                            "source": f"Telegram (@{channel_lbl.lstrip('@')})",
                            "title": item.get("title") or "Telegram Video",
                            "url": item.get("url") or "",
                            "description": f"Video | {item.get('duration')} | {item.get('quality')} | {channel_lbl}",
                            "thumbnail": item.get("thumbnail") or "",
                            "thumb_url": item.get("thumbnail") or "",
                            "chat_id": item.get("chat_id"),
                            "message_id": item.get("message_id"),
                            "duration": item.get("duration") or "",
                            "stream_url": item.get("stream_url") or "",
                            "source_key": "telegram",
                        })
                    if len(results) >= 15:
                        return results
        except Exception as e:
            logger.debug("Local Telegram FTS search failed: %s", e)

        try:
            results.extend(await self._search_telegram_web(query))
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"Error searching Telegram via SearXNG: {e}")

        # Account search still runs when the public web lookup is empty.
        # --- TELETHON LAYER ---
        # If configured, we merge real results from his account
        try:
            api_id = os.getenv('TELEGRAM_API_ID')
            api_hash = os.getenv('TELEGRAM_API_HASH')
            
            if api_id and api_hash and os.path.exists('telegram_session.session'):
                tele_results = await self.search_telegram_telethon(query, api_id, api_hash)
                results.extend(tele_results)
                # Auto-populate FTS5 index with telethon results
                if tele_results:
                    try:
                        from .database import SessionLocal
                        from .telegram_index import upsert_telegram_media_batch
                        with SessionLocal() as db:
                            upsert_telegram_media_batch(db, tele_results)
                    except Exception as idx_err:
                        logger.debug("Auto-indexing telethon search results failed: %s", idx_err)
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"Telethon error: {e}")

        return results
    async def search_telegram_telethon(self, query: str, api_id, api_hash):
        results = []
        # Serializujeme prístup k telegram_session.session, aby nedochádzalo k database is locked
        async with _TELETHON_SEARCH_LOCK:
            try:
                await manager.log(f"Telegram: Connecting to session...", "working")
                client = await tg_auth_manager.get_client(api_id, api_hash)
                if not await client.is_user_authorized():
                    await manager.log("Telegram: session is not authorized.", "error")
                    return results
                await manager.log(f"Telegram: Authenticated. Searching global messages...", "working")
                from telethon.tl.types import InputMessagesFilterVideo

                count = 0
                processed = 0
                async for message in client.iter_messages(
                    None, search=query, filter=InputMessagesFilterVideo, limit=40
                ):
                    processed += 1
                    try:
                        chat = await message.get_chat()
                        chat_title = getattr(chat, 'title', getattr(chat, 'username', 'Unknown Source'))
                        chat_id = public_chat_id(int(chat.id))
                        if getattr(chat, 'username', None):
                            link = f"https://t.me/{chat.username}/{message.id}"
                        else:
                            link = f"https://t.me/c/{chat_id}/{message.id}"

                        caption = message.message or ""
                        filename = "Telegram Video"
                        duration = 0
                        size = 0
                        if message.document:
                            size = message.document.size
                            for attr in message.document.attributes:
                                if hasattr(attr, 'file_name') and attr.file_name:
                                    filename = attr.file_name
                                if hasattr(attr, 'duration'):
                                    duration = int(attr.duration or 0)
                        if duration < 60 and size < (50 * 1024 * 1024):
                            continue

                        display_title = caption if len(caption) > 5 else filename
                        if len(display_title) > 80:
                            display_title = display_title[:80] + "..."
                        size_mb = f"{size / (1024*1024):.1f} MB"
                        duration_str = f"{duration // 60}:{duration % 60:02d}"
                        thumb_url = f"/api/v1/telegram/thumb/{chat_id}/{message.id}"
                        results.append({
                            'source': f'Telegram ({chat_title})',
                            'title': display_title,
                            'url': link,
                            'description': f"Video | {duration_str} | {size_mb} | Found in {chat_title}",
                            'thumbnail': thumb_url,
                            'thumb_url': thumb_url,
                            'chat_id': chat_id,
                            'message_id': message.id,
                            'duration': duration_str,
                            'stream_url': f"/api/v1/telegram/stream/{chat_id}/{message.id}",
                        })
                        count += 1
                    except Exception as loop_e:
                        logger.error(f"Error processing tg message: {loop_e}")
                        continue

                await manager.log(f"Telegram: Scanned {processed} msgs, Found {count} valid videos.", "success")

            except Exception as e:
                _record_source_exception(e)
                logger.error(f"Telethon crash: {e}")
        return results

    async def search_simpcity_async(self, query: str):
        """
        Robust search for SimpCity using XenForoExtractor with auto-login.
        """
        try:
            scout = XenForoExtractor("https://simpcity.su")
            
            # Load credentials from environment
            simpcity_email = os.getenv('SIMPCITY_EMAIL')
            simpcity_password = os.getenv('SIMPCITY_PASSWORD')
            
            if simpcity_email and simpcity_password:
                scout.set_credentials(simpcity_email, simpcity_password)
                logger.info("SimpCity credentials loaded from environment")
            
            # We wrap the blocking search in an executor
            loop = asyncio.get_event_loop()
            results = await loop.run_in_executor(None, scout.search, query)
            
            # Label as SimpCity
            for r in results:
                r['source'] = 'SimpCity'
                r['description'] = 'Robust extraction via XenForoExtractor'
            
            return results
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"SimpCity robust search failed: {e}")
            return await self.search_via_yahoo_async(query, "simpcity.su", "SimpCity (Fallback)")

    async def search_smg_async(self, query: str):
        """
        Robust search for SocialMediaGirls using XenForoExtractor.
        """
        try:
            scout = XenForoExtractor("https://socialmediagirls.com")
            loop = asyncio.get_event_loop()
            results = await loop.run_in_executor(None, scout.search, query)
            
            for r in results:
                r['source'] = 'SMG'
                r['description'] = 'Robust extraction via XenForoExtractor'
            
            return results
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"SMG robust search failed: {e}")
            return await self.search_via_yahoo_async(query, "socialmediagirls.com", "SMG (Fallback)")

    async def search_f95zone_async(self, query: str):
        """
        Searches F95Zone via DuckDuckGo (Cloudflare protected, so direct scraping is difficult).
        """
        return await self.search_via_yahoo_async(query, "f95zone.to", "F95Zone")

    async def search_leakedmodels_async(self, query: str):
        """
        Searches LeakedModels.com via DuckDuckGo.
        """
        return await self.search_via_yahoo_async(query, "leakedmodels.com", "LeakedModels")

    async def search_via_yahoo_async(self, query: str, site: str, source_label: str, result_limit: int = 24):
        """
        Searches a specific site using Yahoo Search (more reliable than DDG for some queries).
        """
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        try:
            clean_query = query.replace(f"site:{site}", "").strip()
            if not clean_query:
                clean_query = site.split('.')[0]
            
            search_query = f"site:{site} {clean_query}"
            url = f"https://search.yahoo.com/search?p={urllib.parse.quote(search_query)}"
            
            headers = {
                'User-Agent': self.headers['User-Agent'],
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/', # Pretend we come from Google
            }
            
            # Small random delay to avoid rate limiting
            await asyncio.sleep(random.uniform(0.5, 1.5))
            
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(url, timeout=15, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200:
                        logger.error(f"Yahoo Search failed: {resp.status} for {site}")
                        # Fallback to DDG lite if Yahoo fails
                        return await self.search_via_ddg_lite_async(query, site, source_label)
                    html = await resp.text()

            if "did not match any documents" in html.lower() or len(html) < 1000:
                return []

            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            # Yahoo results are in div.algo or h3
            items = soup.select('div.algo') or soup.select('div.dd.algo')

            for item in items[:_cap]:
                link_elem = item.find('a')
                if not link_elem: continue
                
                actual_url = link_elem.get('href', '')
                # Yahoo redirects are complex, but usually the clean URL is in the href or RU= param
                if 'RU=' in actual_url:
                    try:
                        actual_url = urllib.parse.unquote(actual_url.split('RU=')[1].split('/')[0])
                    except: pass
                
                # Check for direct link
                if not actual_url.startswith('http'): continue
                if 'search.yahoo.com' in actual_url and 'RU=' not in actual_url: continue
                
                if site not in actual_url and site.split('.')[0] not in actual_url: continue

                title_elem = link_elem
                title = title_elem.get_text(strip=True)
                
                desc_elem = item.select_one('.compText, .st')
                description = desc_elem.get_text(strip=True) if desc_elem else f"Found on {source_label}"
                
                results.append({
                    'source': source_label,
                    'title': title,
                    'url': actual_url,
                    'description': description[:200]
                })
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"Error searching {source_label} via Yahoo: {e}")
        return results

    async def search_via_ddg_lite_async(self, query: str, site: str, source_label: str):
        """
        Original DDG Lite search as fallback.
        """
        results = []
        try:
            search_query = f"site:{site} {query}"
            url = f"https://lite.duckduckgo.com/lite/?q={urllib.parse.quote(search_query)}"
            async with aiohttp.ClientSession(headers=self.headers) as session:
                async with session.get(url, timeout=10, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200: return []
                    html = await resp.text()
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            links = soup.find_all('a', class_='result-link')
            for link in links[:15]:
                href = link.get('href', '')
                actual_url = href
                if 'uddg=' in href: actual_url = urllib.parse.unquote(href.split('uddg=')[1].split('&')[0])
                if site not in actual_url: continue
                results.append({
                    'source': source_label, 'title': link.get_text(strip=True), 'url': actual_url,
                    'description': f"Found on {source_label}"
                })
        except: pass
        return results


    async def search_reddit_async(self, query: str):
        """
        Searches Reddit using JSON API
        """
        results = []
        try:
            url = f"https://www.reddit.com/search.json?q={urllib.parse.quote(query)}&limit=50"
            async with aiohttp.ClientSession(headers=self.headers) as session:
                async with session.get(url, timeout=10, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200:
                        return []
                    data = await resp.json()

            from .mega_link_extractor import extract_mega_urls

            for child in data.get('data', {}).get('children', []):
                post = child.get('data', {})
                title = post.get('title')
                url = post.get('url') or ''
                selftext = post.get('selftext') or ''
                permalink = f"https://reddit.com{post.get('permalink')}"
                mega_urls = extract_mega_urls(selftext, extra_urls=[url] if url else ())

                target_domains = ['gofile.io', 'pixeldrain.com', 'bunkr', 'mega.nz', 'simpcity', 'socialmediagirls']

                source_label = 'Reddit'
                target_url = url

                found_domain = next((d for d in target_domains if d in url), None)
                if found_domain:
                    source_label = f"{found_domain.capitalize()} (via Reddit)"
                elif mega_urls:
                    target_url = mega_urls[0]
                    source_label = 'MEGA (via Reddit)'
                else:
                    target_url = permalink

                item = {
                    'source': source_label,
                    'title': title,
                    'url': target_url,
                    'description': f"Reddit post: {post.get('subreddit_name_prefixed')}"
                }
                if mega_urls:
                    item['mega_urls'] = mega_urls
                results.append(item)

        except Exception as e:
            _record_source_exception(e)
            logger.error(f"Error searching Reddit: {e}")
            
        return results

    async def search_erome_async(self, query: str, result_limit: int = 24):
        """
        Searches Erome.com profiles and albums directly with robust retry and fallback.
        """
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        
        # Try multiple Erome mirrors/domains
        domains = ["www.erome.com", "erome.com", "v.erome.com"]
        
        for domain in domains:
            try:
                url = f"https://{domain}/search?q={urllib.parse.quote(query)}"
                
                headers = self.headers.copy()
                headers['Referer'] = f'https://{domain}/'
                
                # Retry logic with exponential backoff
                for attempt in range(2):
                    try:
                        async with aiohttp.ClientSession(headers=headers) as session:
                            async with session.get(url, timeout=20, ssl=self.ssl_context) as resp:
                                _record_source_http(resp.status)
                                if resp.status == 503:
                                    logger.warning(f"Erome {domain} returned 503, attempt {attempt+1}/2")
                                    if attempt == 0:
                                        await asyncio.sleep(2)  # Wait before retry
                                        continue
                                    else:
                                        break  # Try next domain
                                
                                if resp.status != 200:
                                    logger.debug(f"Erome {domain} returned {resp.status}")
                                    break
                                
                                html = await resp.text()
                        
                                soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
                                
                                # Find album cards
                                albums = soup.select('#album-list .album') or soup.select('.album')
                                
                                async def fetch_album_details(album_data):
                                    """Optional: Fetch album page to get total duration if not visible."""
                                    try:
                                        async with session.get(album_data['url'], timeout=10) as a_resp:
                                            if a_resp.status == 200:
                                                a_html = await a_resp.text()
                                                a_soup = await asyncio.to_thread(BeautifulSoup, a_html, "lxml")
                                                
                                                # Look for duration patterns in videos on the page
                                                # Erome video wrappers often have a data-duration or similar
                                                durations = []
                                                # Or check for duration labels in the UI
                                                for d_label in a_soup.select('.video-duration, .duration'):
                                                    d_txt = d_label.get_text(strip=True)
                                                    if d_txt:
                                                        # Convert MM:SS to seconds
                                                        try:
                                                            p = d_txt.split(':')
                                                            if len(p) == 2: durations.append(int(p[0])*60 + int(p[1]))
                                                            elif len(p) == 3: durations.append(int(p[0])*3600 + int(p[1])*60 + int(p[2]))
                                                        except: pass
                                                
                                                if durations:
                                                    album_data['duration'] = sum(durations)
                                                    
                                                # Quality detection - check if any 4k/HD mentions on page or titles
                                                if "4k" in a_html.lower(): album_data['quality'] = '4K'
                                                elif "1080" in a_html.lower() or "hd" in a_html.lower(): album_data['quality'] = 'HD'
                                    except: pass
                                    return album_data

                                raw_results = []
                                for album in albums[:_cap]:
                                    link_elem = album.find('a', href=True)
                                    if not link_elem: continue
                                        
                                    href = link_elem.get('href', '')
                                    if not href: continue
                                    
                                    full_url = href if href.startswith('http') else f"https://{domain}{href}"
                                    
                                    title_elem = album.select_one('.album-title') or album.find('span', class_='title')
                                    title = title_elem.get_text(strip=True) if title_elem else "Erome Album"
                                    
                                    img_elem = album.find('img')
                                    thumbnail = None
                                    if img_elem:
                                        thumbnail = img_elem.get('data-src') or img_elem.get('data-original') or img_elem.get('src')
                                    
                                    if not thumbnail or 'pixel' in thumbnail: 
                                         thumbnail = f"https://{domain}/assets/img/logo_small.png"
                
                                    # Get counts
                                    video_count = 0
                                    photo_count = 0
                                    
                                    # Erome info icons
                                    info_spans = album.select('.album-info span')
                                    for span in info_spans:
                                        txt = span.get_text(strip=True)
                                        if span.find('i', class_='fa-video'):
                                            try: video_count = int(re.sub(r'\D', '', txt))
                                            except: video_count = 1
                                        elif span.find('i', class_='fa-image'):
                                            try: photo_count = int(re.sub(r'\D', '', txt))
                                            except: photo_count = 0
                                    
                                    # Fallback count detection
                                    if video_count == 0 and album.find('i', class_='fa-video'):
                                        video_count = 1

                                    is_album = video_count > 1 or photo_count > 0
                                    desc_parts = []
                                    if video_count > 0: desc_parts.append(f"{video_count} videos")
                                    if photo_count > 0: desc_parts.append(f"{photo_count} photos")
                                    
                                    res = {
                                        'source': 'Erome',
                                        'title': title,
                                        'url': full_url,
                                        'description': f"Erome {'Album' if is_album else 'Video'} ({', '.join(desc_parts)})",
                                        'thumbnail': thumbnail,
                                        'video_count': video_count,
                                        'photo_count': photo_count,
                                        'duration': 0,
                                        'quality': 'HD' 
                                    }
                                    
                                    # Basic quality detection from title
                                    if "4k" in title.lower(): res['quality'] = '4K'
                                    elif "1080" in title.lower(): res['quality'] = '1080p'
                                    
                                    raw_results.append(res)
                                
                                # Deep search for durations (Parallel)
                                if raw_results:
                                    results = await asyncio.gather(*[fetch_album_details(r) for r in raw_results])
                                    return results
                                break 
                    except asyncio.TimeoutError:
                        logger.warning(f"Erome {domain} timeout, attempt {attempt+1}/2")
                        if attempt == 0:
                            await asyncio.sleep(1)
                            continue
                        break
            except Exception as e:
                _record_source_exception(e)
                logger.debug(f"Erome {domain} failed: {e}")
                continue
        
        # If all domains failed, return empty
        if not results:
            logger.error("All Erome domains failed or returned no results")
        return results

    async def search_coomer_async(self, query: str, result_limit: int = 24):
        """
        Searches Coomer.party (OnlyFans, Fansly, etc. archive) with robust retry.
        """
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        
        # Try multiple Coomer domains
        domains = ["coomer.cr", "coomer.su", "coomer.party"]
        
        for domain in domains:
            try:
                url = f"https://{domain}/posts?q={urllib.parse.quote(query)}"
                
                headers = self.headers.copy()
                
                # Retry logic
                for attempt in range(2):
                    try:
                        async with aiohttp.ClientSession(headers=headers) as session:
                            async with session.get(url, timeout=20, ssl=self.ssl_context) as resp:
                                _record_source_http(resp.status)
                                if resp.status == 503:
                                    logger.warning(f"Coomer {domain} returned 503, attempt {attempt+1}/2")
                                    if attempt == 0:
                                        await asyncio.sleep(2)
                                        continue
                                    else:
                                        break
                                
                                if resp.status != 200:
                                    logger.debug(f"Coomer {domain} returned {resp.status}")
                                    break
                                
                                html = await resp.text()
                        
                                soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
                                posts = soup.find_all('article', class_='post-card') or soup.find_all('div', class_='post-card')
                                
                                for post in posts[:_cap]:
                                    link_elem = post.find('a', href=True)
                                    if not link_elem:
                                        continue
                                    
                                    href = link_elem.get('href', '')
                                    full_url = href if href.startswith('http') else f"https://{domain}{href}"
                                    
                                    # Get title/description
                                    title_elem = post.find('header') or post.find('h2') or post.find('span')
                                    title = title_elem.get_text(strip=True) if title_elem else "Coomer Post"
                                    
                                    img_elem = post.find('img')
                                    thumbnail = img_elem.get('src', '') if img_elem else None
                                    if thumbnail and not thumbnail.startswith('http'):
                                        thumbnail = f"https://{domain}{thumbnail}"
                                    
                                    results.append({
                                        'source': 'Coomer.party',
                                        'title': title,
                                        'url': full_url,
                                        'description': f"Found on Coomer",
                                        'thumbnail': thumbnail
                                    })
                                
                                # If we got results, return them
                                if results:
                                    return results
                                break
                    except asyncio.TimeoutError:
                        logger.warning(f"Coomer {domain} timeout, attempt {attempt+1}/2")
                        if attempt == 0:
                            await asyncio.sleep(1)
                            continue
                        break
            except Exception as e:
                _record_source_exception(e)
                logger.debug(f"Coomer {domain} failed: {e}")
                continue
        
        # Fallback to Yahoo if all domains failed
        if not results:
            logger.info("All Coomer domains failed, falling back to Yahoo search")
            return await self.search_via_yahoo_async(query, "coomer.cr", "Coomer (via Yahoo)")
        return results

    async def search_kemono_async(self, query: str, result_limit: int = 24):
        """
        Searches Kemono.party (Patreon, SubscribeStar, etc. archive)
        """
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        try:
            # Try to find the creator by searching
            search_url = f"https://kemono.cr/posts?q={urllib.parse.quote(query)}"
            
            headers = self.headers.copy()
            
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(search_url, timeout=15, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200:
                        logger.error(f"Kemono search failed: {resp.status}")
                        return []
                    html = await resp.text()

            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            
            # Find post cards
            posts = soup.find_all('article', class_='post-card')[:_cap]
            
            for post in posts:
                # Get post link
                link_elem = post.find('a', class_='post-card__link') or post.find('a', href=True)
                if not link_elem:
                    continue
                    
                href = link_elem.get('href', '')
                if not href:
                    continue
                
                full_url = href if href.startswith('http') else f"https://kemono.cr{href}"
                
                # Get title
                title_elem = post.find('header') or post.find('h2') or post.find('span', class_='post-card__header')
                title = title_elem.get_text(strip=True) if title_elem else "Kemono Post"
                
                # Get creator name
                creator_elem = post.find('a', class_='post-card__user-name') or post.find('span', class_='user-name')
                creator = creator_elem.get_text(strip=True) if creator_elem else "Unknown"
                
                # Get service (Patreon, etc.)
                service_elem = post.find('span', class_='post-card__service') or post.find('img', class_='service-icon')
                service = service_elem.get('alt', 'Patreon') if service_elem else 'Patreon'
                
                # Get thumbnail
                img_elem = post.find('img')
                thumbnail = img_elem.get('src', '') if img_elem else None
                if thumbnail and not thumbnail.startswith('http'):
                    thumbnail = f"https://kemono.su{thumbnail}"
                
                results.append({
                    'source': f'Kemono.party ({service})',
                    'title': title[:100],
                    'url': full_url,
                    'description': f"By {creator} on {service}",
                    'thumbnail': thumbnail
                })
                
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"Error searching Kemono.party: {e}")
        return results

    async def search_xvideos_async(self, query: str, result_limit: int = 24):
        """
        Searches XVideos.com directly
        """
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        try:
            # XVideos search URL
            search_url = f"https://www.xvideos.com/?k={urllib.parse.quote(query)}"
            
            headers = self.headers.copy()
            headers['Referer'] = 'https://www.xvideos.com/'
            
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(search_url, timeout=15, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200:
                        logger.error(f"XVideos search failed: {resp.status}")
                        return []
                    html = await resp.text()

            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            
            # Find video thumbnails
            videos = soup.find_all('div', class_='thumb-block')[:_cap]
            
            for video in videos:
                # Get link
                link_elem = video.find('a', href=True)
                if not link_elem:
                    continue
                    
                href = link_elem.get('href', '')
                if not href:
                    continue
                
                full_url = href if href.startswith('http') else f"https://www.xvideos.com{href}"
                
                # Get title
                title_elem = video.find('p', class_='title') or link_elem
                title = title_elem.get('title', '') or title_elem.get_text(strip=True)
                
                # Get thumbnail
                img_elem = video.find('img')
                thumbnail = img_elem.get('data-src') or img_elem.get('src', '') if img_elem else None
                
                # Get duration
                duration_elem = video.find('span', class_='duration')
                duration = duration_elem.get_text(strip=True) if duration_elem else ""

                # Get quality
                quality = ""
                hd_mark = video.find('span', class_='video-hd-mark')
                if hd_mark:
                    quality = hd_mark.get_text(strip=True)
                
                results.append({
                    'source': 'XVideos',
                    'title': title[:100],
                    'url': full_url,
                    'description': f"Duration: {duration}" if duration else "XVideos video",
                    'thumbnail': thumbnail,
                    'quality': quality
                })
                
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"Error searching XVideos: {e}")
        return results

    async def search_spankbang_async(self, query: str, result_limit: int = 24):
        """
        Searches SpankBang.com directly via mirrors.
        """
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        # Try mirrors if main is blocked
        domains = ["spankbang.com", "spankbang.party", "la.spankbang.com"]
        
        for domain in domains:
            try:
                search_url = f"https://{domain}/s/{urllib.parse.quote(query)}/"
                
                headers = self.headers.copy()
                headers.update({
                    'Referer': f'https://{domain}/',
                    'Host': domain,
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive'
                })
                
                async with aiohttp.ClientSession(headers=headers) as session:
                    async with session.get(search_url, timeout=10, ssl=self.ssl_context) as resp:
                        _record_source_http(resp.status)
                        if resp.status != 200:
                            logger.debug(f"SpankBang mirror {domain} failed: {resp.status}")
                            continue
                        html = await resp.text()

                soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
                # Find video items
                videos = soup.find_all('div', class_='video-item')[:_cap]
                
                if not videos:
                    # Alternative selector
                    videos = soup.select('.video-list .video-item')

                for video in videos:
                    # Get link
                    link_elem = video.find('a', href=True)
                    if not link_elem:
                        continue
                        
                    href = link_elem.get('href', '')
                    if not href:
                        continue
                    
                    full_url = href if href.startswith('http') else f"https://{domain}{href}"
                    
                    # Get title
                    title = link_elem.get('title', '') or link_elem.get_text(strip=True)
                    
                    # Get thumbnail
                    img_elem = video.find('img')
                    thumbnail = img_elem.get('data-src') or img_elem.get('src', '') if img_elem else None
                    if thumbnail and thumbnail.startswith('//'):
                        thumbnail = f"https:{thumbnail}"
                    
                    # Get info
                    info_elem = video.find('span', class_='i')
                    duration = info_elem.get_text(strip=True) if info_elem else ""

                    # Get quality
                    quality = ""
                    q_elem = video.find('span', class_='q')
                    if q_elem:
                        quality = q_elem.get_text(strip=True)
                    
                    results.append({
                        'source': 'SpankBang',
                        'title': title[:100],
                        'url': full_url,
                        'description': f"Duration: {duration}" if duration else "SpankBang video",
                        'thumbnail': thumbnail,
                        'quality': quality
                    })
                
                if results:
                    break # Success with this domain
            except Exception as e:
                _record_source_exception(e)
                logger.debug(f"Error searching SpankBang on {domain}: {e}")
                continue
        
        if not results:
            logger.info("SpankBang direct failed or blocked, falling back to Yahoo")
            return await self.search_via_yahoo_async(query, "spankbang.com", "SpankBang (via Yahoo)")
                
        return results

    async def search_pornhub_async(self, query: str, result_limit: int = 24):
        """
        Searches Pornhub.com directly
        """
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        try:
            # Pornhub search URL
            search_url = f"https://www.pornhub.com/video/search?search={urllib.parse.quote(query)}"

            # Pornhub blocks aiohttp at the TLS layer (410); use impersonated fetch.
            html = await self._fetch_impersonated(search_url, referer='https://www.pornhub.com/')
            if not html:
                logger.error("Pornhub search failed (impersonated fetch returned nothing)")
                return []

            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            
            # Find video items
            videos = soup.find_all('li', class_='pcVideoListItem')[:_cap]

            # Fallback selector
            if not videos:
                videos = soup.find_all('div', class_='phitem')[:_cap]
            
            for video in videos:
                # Prefer the actual video-page anchor over the first (thumbnail)
                # anchor, whose visible text is just the duration overlay.
                link_elem = video.select_one('a[href*="view_video"]') or video.find('a', href=True)
                if not link_elem:
                    continue

                href = link_elem.get('href', '')
                if not href or 'javascript:' in href:
                    continue

                full_url = href if href.startswith('http') else f"https://www.pornhub.com{href}"

                # Title: the view_video anchor's title attr is the fullest; then
                # the span.title text; never the thumbnail anchor's duration text.
                title = (link_elem.get('title') or '').strip()
                if not title:
                    span_title = video.find('span', class_='title')
                    if span_title:
                        title = span_title.get_text(strip=True)
                if not title:
                    img_alt = video.find('img')
                    title = (img_alt.get('alt') if img_alt else '') or ''
                    title = title.strip()
                
                # Get thumbnail
                img_elem = video.find('img')
                thumbnail = img_elem.get('data-src') or img_elem.get('data-thumb_url') or img_elem.get('src', '') if img_elem else None
                
                # Get duration
                duration_elem = video.find('var', class_='duration')
                duration = duration_elem.get_text(strip=True) if duration_elem else ""

                # Get quality
                quality = ""
                hd_elem = video.find('span', class_='hd-thumbnail')
                if hd_elem:
                    quality = "HD"
                    if "4k" in hd_elem.get_text(strip=True).lower():
                        quality = "4K"
                
                results.append({
                    'source': 'Pornhub',
                    'title': title[:100],
                    'url': full_url,
                    'description': f"Duration: {duration}" if duration else "Pornhub video",
                    'thumbnail': thumbnail,
                    'duration': duration,
                    'quality': quality
                })
                
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"Error searching Pornhub: {e}")
        return results


    async def search_eporner_async(self, query: str):
        """
        Searches Eporner. Scrapes the HTML listing rather than the API: the v2
        search API never returns a resolution (its `hd` flag is absent), so the
        old API path labelled every single result "SD". The listing tiles carry
        the real badge ("720p", "1080p", "4K (2160p)"), so we read that and only
        fall back to the API if scraping yields nothing.
        """
        results = []
        try:
            
            from bs4 import BeautifulSoup

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                              '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': 'https://www.eporner.com/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            }
            search_url = f"https://www.eporner.com/search/{urllib.parse.quote(query)}/"

            resp = await _get_shared_client().get(search_url, headers=headers, timeout=15)
            _record_source_http(resp.status_code)
            if resp.status_code == 200:
                soup = await asyncio.to_thread(BeautifulSoup, resp.text, "lxml")
                for mb in soup.select('div.mb[data-id]'):
                    a = mb.select_one("a[href*='/video-']")
                    if not a:
                        continue
                    href = a.get('href') or ''
                    url = href if href.startswith('http') else f"https://www.eporner.com{href}"
                    img = mb.select_one('img')
                    title = ((img.get('alt') if img else None) or a.get('title') or '').strip()
                    thumb = (img.get('data-src') or img.get('src') or '') if img else ''
                    if thumb.startswith('//'):
                        thumb = f"https:{thumb}"
                    elif thumb.startswith('data:'):
                        thumb = ''

                    qel = mb.select_one('.mvhdico span')
                    quality = qel.get_text(strip=True) if qel else ''
                    # Badge reads "4K (2160p)" / "1080p" — normalise to a height.
                    height = 0
                    if quality:
                        low = quality.lower()
                        if '4k' in low or '2160' in low:
                            height = 2160
                        else:
                            m = re.search(r'(\d{3,4})', low)
                            height = int(m.group(1)) if m else 0

                    dtxt = mb.select_one('.mbtim')
                    duration = 0
                    if dtxt:
                        parts = [p for p in dtxt.get_text(strip=True).split(':') if p.isdigit()]
                        for p in parts:
                            duration = duration * 60 + int(p)

                    vid_id = str(mb.get('data-id') or '')
                    embed = f"https://www.eporner.com/embed/{vid_id}/" if vid_id else ''

                    results.append({
                        'source': 'Eporner',
                        'title': title,
                        'url': url,
                        'duration': duration,
                        'quality': f"{height}p" if height else quality,
                        'height': height,
                        'description': "Found on Eporner",
                        'thumbnail': thumb,
                        'embed': embed,
                        'preview_url': embed,
                    })

            if not results:
                # Fallback: API still gives titles/urls when scraping is blocked.
                from .services import fetch_eporner_videos
                videos = await asyncio.to_thread(fetch_eporner_videos, query)
                for v in videos:
                    results.append({
                        'source': 'Eporner',
                        'title': v['title'],
                        'url': v['url'],
                        'duration': v.get('duration'),
                        'quality': v.get('quality', ''),
                        'description': "Found on Eporner",
                        'thumbnail': v['thumbnail'],
                        'embed': v.get('embed_url') or '',
                        'preview_url': v.get('embed_url') or '',
                    })
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"Eporner search failed: {e}", exc_info=True)
        return results

    async def search_whoreshub_async(self, query: str, result_limit: int = 24):
        results = []
        try:
            from .whoreshub_discovery import scrape_whoreshub_discovery
            loop = asyncio.get_event_loop()
            # Cap at 3 pages: these scrapers run synchronously in an executor and
            # cannot be cancelled, so a 9-page crawl blows the caller's timeout
            # budget and the whole query gets discarded. 3 pages ≈ 70 hits, which
            # is well past any related-search limit.
            desired_pages = max(1, min((max(1, int(result_limit or 24)) + 23) // 24, 3))
            videos = await loop.run_in_executor(
                None,
                lambda: scrape_whoreshub_discovery(
                    keyword=query,
                    tag="",
                    min_quality=0,
                    min_duration=0,
                    pages=desired_pages,
                    upload_type="all",
                    auto_skip_low_quality=False,
                ),
            )
            for v in videos:
                results.append({
                    'source': 'WhoresHub',
                    'duration': v.get('duration') or 0,
                    'height': v.get('height') or 0,
                    'upload_date': v.get('upload_date') or v.get('added') or '',
                    'title': v.get('title', '')[:100],
                    'url': v.get('url', ''),
                    'description': f"Duration: {v.get('duration', '')}",
                    'thumbnail': v.get('thumbnail'),
                    'quality': str(v.get('quality', ''))
                })
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"WhoresHub search failed: {e}")
        return results

    async def search_porntrex_async(self, query: str, result_limit: int = 24):
        results = []
        try:
            from .porntrex_discovery import scrape_porntrex_discovery
            loop = asyncio.get_event_loop()
            # Cap at 3 pages — see the note in search_whoreshub_async: an
            # uncancellable 9-page crawl was timing the whole query out.
            desired_pages = max(1, min((max(1, int(result_limit or 24)) + 23) // 24, 3))
            videos = await loop.run_in_executor(
                None,
                lambda: scrape_porntrex_discovery(
                    keyword=query,
                    min_quality=0,
                    pages=desired_pages,
                    category="",
                    upload_type="all",
                    auto_skip_low_quality=False,
                ),
            )
            for v in videos:
                results.append({
                    'source': 'PornTrex',
                    'duration': v.get('duration') or 0,
                    'height': v.get('height') or 0,
                    'upload_date': v.get('upload_date') or v.get('added') or '',
                    'title': v.get('title', '')[:100],
                    'url': v.get('url', ''),
                    'description': f"Duration: {v.get('duration', '')}",
                    'thumbnail': v.get('thumbnail'),
                    'quality': str(v.get('quality', ''))
                })
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"PornTrex search failed: {e}")
        return results

    async def search_xhamster_async(self, query: str, result_limit: int = 24):
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        try:
            search_url = f"https://xhamster.com/search/{urllib.parse.quote(query)}"
            headers = self.headers.copy()
            headers['Referer'] = 'https://xhamster.com/'

            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(search_url, timeout=15, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200:
                        logger.error(f"xHamster search failed: {resp.status}")
                        return []
                    html = await resp.text()

            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")

            # xHamster's markup changes often. Anchor on the video link itself
            # (role=video-thumb-info-name or any /videos/ link) rather than a
            # specific wrapper class, then walk up to the card container so we
            # can still find the thumbnail / duration siblings.
            seen = set()
            anchors = soup.select('a.video-thumb-info__name') \
                or soup.select('a[data-role="video-thumb-info-name"]') \
                or [a for a in soup.select('a[href*="/videos/"]') if a.get('href')]

            def _abs(u):
                if not u:
                    return None
                if u.startswith('//'):
                    return 'https:' + u
                if u.startswith('http'):
                    return u
                return f"https://xhamster.com{u}"

            _dur_re = re.compile(r'^\d{1,2}:\d{2}(:\d{2})?$')

            def _title_from_slug(u):
                # https://xhamster.com/videos/night-ride-and-night-car-blowjob -> "Night ride and night car blowjob"
                try:
                    slug = u.rstrip('/').split('/videos/')[-1].split('?')[0]
                    slug = re.sub(r'-\d{5,}$', '', slug)          # strip trailing numeric id
                    slug = re.sub(r'-xh[a-z0-9]+$', '', slug)      # strip xhamster hash suffix
                    words = slug.replace('-', ' ').strip()
                    return words[:1].upper() + words[1:] if words else ''
                except Exception:
                    return ''

            for link in anchors:
                href = link.get('href', '')
                if '/videos/' not in href:
                    continue
                # Skip cam-site / live spam links injected into search results.
                if 'xhamsterlive' in href or 'goto/' in href or '{title}' in href:
                    continue
                full_url = _abs(href)
                if not full_url or full_url in seen:
                    continue
                seen.add(full_url)

                # Climb to the surrounding card so img/duration are in scope.
                card = link
                for _ in range(4):
                    if card.parent is None:
                        break
                    card = card.parent
                    if card.find('img'):
                        break

                title = (link.get('title') or link.get_text(strip=True) or '').strip()
                # The thumbnail link's visible text is often the duration overlay
                # (e.g. "11:45"); fall back to the URL slug for a real title.
                if not title or _dur_re.match(title):
                    title = _title_from_slug(full_url) or title

                img = card.find('img') if card else None
                thumbnail = None
                if img:
                    thumbnail = (img.get('data-src') or img.get('src')
                                 or img.get('data-thumb_url'))
                    if not thumbnail:
                        srcset = img.get('srcset') or img.get('data-srcset') or ''
                        if srcset:
                            thumbnail = srcset.split(',')[0].strip().split(' ')[0]
                thumbnail = _abs(thumbnail)

                dur_elem = card.find(class_=lambda c: c and 'duration' in c) if card else None
                duration = dur_elem.get_text(strip=True) if dur_elem else ''
                if not duration:
                    # The anchor overlay text is frequently the duration itself.
                    anchor_txt = (link.get_text(strip=True) or '').strip()
                    if _dur_re.match(anchor_txt):
                        duration = anchor_txt

                results.append({
                    'source': 'xHamster',
                    'title': (title or 'xHamster video')[:100],
                    'url': full_url,
                    'description': f"Duration: {duration}" if duration else "xHamster video",
                    'thumbnail': thumbnail,
                    'duration': duration,
                    'quality': ''
                })
                if len(results) >= _cap:
                    break
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"xHamster search failed: {e}")
        return results

    async def search_ixxx_async(self, query: str, result_limit: int = 24):
        """
        Search ixxx.com via listing scrape (first page(s) only by default for latency).
        """
        results = []
        try:
            from .extractors.ixxx import IxxxExtractor

            q = (query or "").strip()
            if not q:
                return []

            search_url = f"https://www.ixxx.com/search/?query={urllib.parse.quote(q)}"
            max_pages = int(os.getenv("IXXX_SEARCH_MAX_PAGES", "2"))
            ext = IxxxExtractor()
            rows = await ext.extract_listing(search_url, max_pages=max_pages)

            for row in rows[:max(1, min(int(result_limit or 24), 200))]:
                results.append(
                    {
                        "source": "iXXX",
                        "title": (row.get("title") or "")[:200],
                        "url": row.get("url") or "",
                        "description": "Found on iXXX",
                        "thumbnail": row.get("thumbnail"),
                        "duration": row.get("duration") or 0,
                        "width": row.get("width") or 0,
                        "height": row.get("height") or 0,
                        "quality": "",
                    }
                )
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"iXXX search failed: {e}")
        return results

    async def search_via_yahoo_async(self, query: str, site: str, source_name: str):
        """
        Uses Yahoo Search to find results for a specific site.
        Very useful for sites with poor or no internal search.
        """
        results = []
        try:
            # Yahoo Search URL with site: operator
            search_query = f"site:{site} {query}"
            search_url = f"https://search.yahoo.com/search?p={urllib.parse.quote(search_query)}"
            
            headers = self.headers.copy()
            headers.update({
                'Referer': 'https://search.yahoo.com/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            })
            
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(search_url, timeout=15, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200:
                        return []
                    html = await resp.text()

            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            # Yahoo search results are typically in <div> with class "dd algo algo-sr" or similar
            items = soup.select('.algo-sr, .dd.algo')
            
            for item in items:
                link_tag = item.select_one('a[href*="https://"]')
                if not link_tag: continue
                
                url = link_tag.get('href')
                
                # Clean Yahoo redirect URLs
                if 'r.search.yahoo.com' in url:
                    try:
                        parsed_url = urllib.parse.urlparse(url)
                        query_params = urllib.parse.parse_qs(parsed_url.query)
                        if 'RU' in query_params:
                            url = query_params['RU'][0]
                        elif '/RV=' in url:
                            # Try regex if RU is not standard
                            match = re.search(r'RU=([^/]+)', url)
                            if match:
                                url = urllib.parse.unquote(match.group(1))
                    except: pass
                
                # Only include results for the target site or variants
                is_bunkr = any(x in url.lower() for x in ['bunkr', 'bunkrr'])
                if site not in url.lower() and not (is_bunkr and 'bunkr' in site):
                    continue
                
                title_tag = item.select_one('h3')
                title = title_tag.get_text(strip=True) if title_tag else url.split('/')[-1]
                
                # Skip search engine result pages or meta links
                if any(x in url.lower() for x in ['search?', 'results?', 'google.com', 'yahoo.com', 'duckduckgo']):
                    continue

                desc_tag = item.select_one('.compText, .st')
                description = desc_tag.get_text(strip=True) if desc_tag else f"Result from {site}"

                results.append({
                    'source': source_name,
                    'title': title,
                    'url': url,
                    'description': description
                })
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"Yahoo fallback search failed for {site}: {e}")
            
        return results

    async def search_via_duckduckgo_async(self, query: str, site: str, source_name: str):
        """
        Fallback search via DuckDuckGo (HTML version).
        """
        results = []
        try:
            search_query = f"site:{site} {query}"
            # DDG HTML version is easier to scrape, kp=-1 disables Safe Search
            search_url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(search_query)}&kp=-1"
            
            async with aiohttp.ClientSession(headers=self.headers) as session:
                async with session.get(search_url, timeout=10, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200: return []
                    html = await resp.text()
            
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            items = soup.select('.result')
            
            for item in items:
                link = item.select_one('.result__a')
                if not link: continue
                
                url = link.get('href')
                
                # Clean DDG redirect URLs
                if 'uddg=' in url:
                    try:
                        url = urllib.parse.unquote(url.split('uddg=')[1].split('&')[0])
                    except: pass
                
                is_bunkr = any(x in url.lower() for x in ['bunkr', 'bunkrr'])
                if site not in url.lower() and not (is_bunkr and 'bunkr' in site):
                    continue
                
                title = link.get_text(strip=True)
                snippet = item.select_one('.result__snippet')
                description = snippet.get_text(strip=True) if snippet else ""
                
                # Skip junk
                if any(x in url.lower() for x in ['search?', 'results?', 'google.com', 'yahoo.com', 'duckduckgo']):
                    continue

                results.append({
                    'source': source_name,
                    'title': title,
                    'url': url,
                    'description': description
                })
        except Exception as e:
            _record_source_exception(e)
            _log_search_failure(f"DDG fallback for {site}", e)
        return results

    async def search_simpcity_async(self, query: str):
        """
        Searches SimpCity (XenForo) for threads mentioning the query.
        SimpCity is a major source of Bunkr and other cyberdrop links.
        """
        results = []
        try:
            # We use the public search if available, or just a site-specific search
            return await self.search_via_duckduckgo_async(query, "simpcity.su", "SimpCity")
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"SimpCity search failed: {e}")
        return results
    async def search_cyberleaks_async(self, query: str):
        """
        Searches CyberLeaks videos.
        """
        try:
            # We use the specialized discovery function
            loop = asyncio.get_event_loop()
            results = await loop.run_in_executor(None, scrape_cyberleaks_discovery, query)
            
            # Label results
            for r in results:
                r['source'] = 'CyberLeaks'
                if not r.get('description'):
                    r['description'] = f"Found on CyberLeaks"
            
            return results
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"CyberLeaks search failed: {e}")
            return []
    async def search_local_async(self, query: str):
        """Search local database using FTS5 for instant results."""
        from .database import SessionLocal, Video
        from sqlalchemy import text
        results = []
        db = SessionLocal()
        try:
            from .database import sanitize_fts_query
            safe_search = sanitize_fts_query(query)
            if safe_search:
                # Use FTS5 MATCH for ultra-fast results with parameterization
                res = db.execute(
                    text("SELECT rowid FROM videos_fts WHERE videos_fts MATCH :search_term"),
                    {"search_term": f"{safe_search}*"}
                )
                ids = [r[0] for r in res.fetchall()]
                
                if ids:
                    videos = db.query(Video).filter(Video.id.in_(ids)).limit(50).all()
                    for v in videos:
                        # Map to search result format
                        results.append({
                            'source': 'Gallery',
                            'title': v.title,
                            'url': v.url,
                            'description': v.batch_name or 'Local Video',
                            'thumbnail': v.thumbnail_path,
                            'duration': int(v.duration) if v.duration else 0,
                            'quality': v.quality,
                            'video_count': 1
                        })
        except Exception as e:
            _record_source_exception(e)
            logger.debug(f"Local FTS search failed (normal if first run): {e}")
            # Fallback to basic like search
            try:
                videos = db.query(Video).filter(Video.title.contains(query)).limit(20).all()
                for v in videos:
                    results.append({
                        'source': 'Gallery', 'title': v.title, 'url': v.url,
                        'description': v.batch_name or 'Local Video', 'thumbnail': v.thumbnail_path,
                        'duration': int(v.duration) if v.duration else 0, 'quality': v.quality
                    })
            except: pass
        finally:
            db.close()
        return results

    async def search_noodlemagazine_async(self, query: str, result_limit: int = 24):
        """Search NoodleMagazine directly via its /video/<query> listing."""
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        try:
            url = f"https://noodlemagazine.com/video/{urllib.parse.quote(query.strip())}"
            # NoodleMagazine returns 403 to aiohttp (TLS fingerprint); impersonate.
            html = await self._fetch_impersonated(url, referer='https://noodlemagazine.com/')
            if not html:
                return await self.search_via_duckduckgo_async(query, "noodlemagazine.com", "NoodleMagazine")
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            seen = set()
            for link in soup.select('a[href*="/watch/"]'):
                href = link.get('href', '')
                if '/watch/' not in href:
                    continue
                item_url = href if href.startswith('http') else f"https://noodlemagazine.com{href}"
                if item_url in seen:
                    continue
                seen.add(item_url)
                img = link.find('img')
                title = (link.get('title') or (img.get('alt') if img else '') or link.get_text(strip=True) or '').strip()
                thumbnail = None
                if img:
                    src = img.get('data-src') or img.get('src') or img.get('data-original') or ''
                    if src and not src.startswith('data:'):
                        thumbnail = src
                dur_el = link.find(class_=lambda c: c and ('time' in c or 'duration' in c))
                duration = dur_el.get_text(strip=True) if dur_el else ''
                if not title:
                    continue
                # The listing only has a binary `.hd_mark`, which is useless as a
                # quality label (and sorts as 0). Leave quality empty here; the
                # enrich pass below fills in the real height from the watch page.
                results.append({'source': 'NoodleMagazine', 'title': title[:100], 'url': item_url,
                                'thumbnail': thumbnail, 'duration': duration, 'description': '',
                                'hd': bool(link.select_one('.hd_mark'))})
                if len(results) >= _cap:
                    break
            if not results:
                return await self.search_via_duckduckgo_async(query, "noodlemagazine.com", "NoodleMagazine")

            # Resolve the real resolution: `window.playlist.sources[]` on the watch
            # page lists every rendition with `label` = height. Without this every
            # tile showed a bare "HD" (or nothing at all).
            await self._enrich_noodle_quality(results)
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"NoodleMagazine search failed: {e}")
            return await self.search_via_duckduckgo_async(query, "noodlemagazine.com", "NoodleMagazine")
        return results

    async def _enrich_noodle_quality(self, results: list, max_items: int = 40):
        """Fill `quality`/`height` on NoodleMagazine results from their watch pages.

        Mirrors `app/hubs/noodlemagazine.py::enrich` — the page inlines
        `window.playlist` whose `sources[]` each carry a `label` (the height).
        """
        targets = [r for r in results if r.get('url')][:max_items]
        if not targets:
            return
        import json as _json

        sem = asyncio.Semaphore(10)

        async def one(item: dict):
            async with sem:
                try:
                    html = await self._fetch_impersonated(
                        item['url'], referer='https://noodlemagazine.com/'
                    )
                except Exception:
                    return
                if not html:
                    return
                playlist = re.search(r"window\.playlist\s*=\s*(\{.*?\})\s*;", html, re.S)
                if not playlist:
                    return
                try:
                    sources = _json.loads(playlist.group(1)).get("sources") or []
                except Exception:
                    return
                height = 0
                for source in sources:
                    label = int(re.sub(r"\D", "", str(source.get("label") or "")) or 0)
                    height = max(height, label)
                if height:
                    item['height'] = height
                    item['quality'] = "4K" if height >= 2160 else f"{height}p"

        await asyncio.gather(*[one(t) for t in targets], return_exceptions=True)

    async def search_beeg_async(self, query: str, result_limit: int = 24):
        """Search Beeg and expand performer pages into their video listings."""
        result_limit = max(1, min(int(result_limit or 24), 200))
        ddg_results, yahoo_results = await asyncio.gather(
            self.search_via_duckduckgo_async(query, "beeg.com", "Beeg"),
            self.search_via_yahoo_async(query, "beeg.com", "Beeg"),
        )
        search_results = self._merge_unique_results([ddg_results, yahoo_results])

        profile_urls = []
        for result in search_results:
            url = str(result.get("url") or "")
            parsed = urllib.parse.urlparse(url)
            if (
                parsed.hostname
                and parsed.hostname.lower().removeprefix("www.") == "beeg.com"
                and re.fullmatch(r"/\d+/?", parsed.path)
                and url not in profile_urls
            ):
                profile_urls.append(url)

        profiles = profile_urls[:4]
        if profiles:
            expanded_profiles = await asyncio.gather(
                *(self._fetch_beeg_profile_videos(url) for url in profiles),
                return_exceptions=True,
            )
            profile_results = []
            expanded_urls = set()
            for profile_url, rows in zip(profiles, expanded_profiles):
                if isinstance(rows, Exception):
                    logger.debug("Beeg profile expansion failed for %s: %s", profile_url, rows)
                    continue
                if rows:
                    expanded_urls.add(profile_url)
                    profile_results.extend(rows)
            search_results = [
                result for result in search_results
                if str(result.get("url") or "") not in expanded_urls
            ]
            search_results = self._merge_unique_results([search_results, profile_results])

        # Numeric positive URLs are profiles, and search engines also return
        # category/search pages. Only negative-ID URLs identify video clips.
        clips = [r for r in search_results if (
            (p := urllib.parse.urlparse(str(r.get('url') or ''))).hostname
            and p.hostname.lower().removeprefix('www.') == 'beeg.com'
            and re.fullmatch(r'/-\d+/?', p.path)
        )][:result_limit]
        if clips:
            try:
                from .extractors.beeg import BeegExtractor
                beeg_ext = BeegExtractor()
                sem = asyncio.Semaphore(6)

                async def _enrich_clip(row: dict) -> dict:
                    url = str(row.get("url") or "")
                    vid_id = beeg_ext._extract_id(url)
                    if not vid_id:
                        return row
                    async with sem:
                        facts = await asyncio.to_thread(beeg_ext._fetch_facts_api, vid_id)
                    if not facts:
                        return row
                    enriched = dict(row)
                    if facts.get("title"):
                        enriched["title"] = facts["title"]
                    if facts.get("thumbnail"):
                        enriched["thumbnail"] = facts["thumbnail"]
                        enriched["thumb_url"] = facts["thumbnail"]
                    if facts.get("duration"):
                        enriched["duration"] = int(facts["duration"])
                    if facts.get("height"):
                        h = int(facts["height"])
                        enriched["height"] = h
                        enriched["quality"] = "4K" if h >= 2160 else f"{h}p"
                    if facts.get("width"):
                        enriched["width"] = int(facts["width"])
                    if facts.get("views"):
                        enriched["views"] = int(facts["views"])
                    if facts.get("uploader"):
                        enriched["uploader"] = facts["uploader"]
                    if facts.get("performers"):
                        enriched["performer"] = ", ".join(facts["performers"][:3])
                    if facts.get("tags"):
                        enriched["tags"] = facts["tags"]
                    return enriched

                clips = list(await asyncio.gather(*[_enrich_clip(c) for c in clips]))
            except Exception as exc:
                logger.debug("Beeg facts enrichment failed: %s", exc)
        return clips

    async def _fetch_beeg_profile_videos(self, profile_url: str) -> list[dict]:
        """Read public video cards from a Beeg performer page."""
        try:
            async with aiohttp.ClientSession(headers=self.headers) as session:
                async with session.get(
                    profile_url,
                    headers={"Referer": "https://beeg.com/"},
                    timeout=4,
                    ssl=self.ssl_context,
                ) as response:
                    _record_source_http(response.status)
                    if response.status != 200:
                        return []
                    html = await response.text()
            return await asyncio.to_thread(self._parse_beeg_profile_videos, html, profile_url)
        except Exception as exc:
            _record_source_exception(exc)
            logger.debug("Beeg profile request failed for %s: %s", profile_url, exc)
            return []

    @staticmethod
    def _parse_beeg_profile_videos(html: str, profile_url: str) -> list[dict]:
        soup = BeautifulSoup(html, "lxml")
        name_node = (
            soup.select_one('[data-testid="profile-name"]')
            or soup.select_one('meta[property="og:title"]')
            or soup.find("h1")
        )
        performer = (
            name_node.get("content", "").strip()
            if name_node and name_node.name == "meta"
            else name_node.get_text(" ", strip=True) if name_node else ""
        )
        performer = re.sub(r"\s*\|\s*Beeg.*$", "", performer, flags=re.I).strip()
        results = []
        seen = set()
        for card in soup.select('[data-testid="unit"], .UnitFrame.VideoTile'):
            link = card.select_one('a[href^="https://beeg.com/-"], a[href^="/-"]')
            href = str(link.get("href") or "").strip() if link else ""
            video_url = urllib.parse.urljoin(profile_url, href)
            if not re.match(r"^https://(?:www\.)?beeg\.com/-\d+", video_url, re.I) or video_url in seen:
                continue
            seen.add(video_url)

            title_node = card.select_one('[data-testid="unit-title"]') or card.select_one("img[alt]")
            thumbnail_node = card.select_one("img")
            duration_node = card.select_one('[data-testid="unit-amount"]')
            thumbnail = ""
            if thumbnail_node:
                thumbnail = str(
                    thumbnail_node.get("src")
                    or thumbnail_node.get("data-src")
                    or ""
                ).strip()
                if thumbnail:
                    thumbnail = urllib.parse.urljoin(profile_url, thumbnail)
            title = (
                str(title_node.get("alt") or "").strip()
                if title_node and title_node.name == "img"
                else title_node.get_text(" ", strip=True) if title_node else ""
            )
            row = {
                "source": "Beeg",
                "title": title or "Beeg Video",
                "url": video_url,
                "source_url": video_url,
                "description": f"Beeg video by {performer}" if performer else "Beeg video",
                "thumbnail": thumbnail,
            }
            if performer:
                row["performer"] = performer
                row["uploader"] = performer
            if duration_node:
                row["duration"] = duration_node.get_text(" ", strip=True)
            results.append(row)
        return results

    async def search_pixeldrain_async(self, query: str):
        """Search Pixeldrain via DuckDuckGo."""
        return await self.search_via_duckduckgo_async(query, "pixeldrain.com", "Pixeldrain")

    async def search_hqporner_async(self, query: str, result_limit: int = 24):
        """Search HQPorner via direct search."""
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        try:
            search_url = f"https://hqporner.com/?q={urllib.parse.quote(query)}"
            headers = self.headers.copy()
            headers['Referer'] = 'https://hqporner.com/'
            
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(search_url, timeout=15, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200:
                        return await self.search_via_duckduckgo_async(query, "hqporner.com", "HQPorner")
                    html = await resp.text()

            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            # HQPorner video tiles are anchors to /hdporn/<id>-<slug>.html with the
            # title in the img alt and the thumb in img src (protocol-relative).
            seen = set()
            for link in soup.select('a[href*="/hdporn/"]'):
                href = link.get('href', '')
                if '/hdporn/' not in href:
                    continue
                url = href if href.startswith('http') else f"https://hqporner.com{href}"
                if url in seen:
                    continue
                seen.add(url)
                img = link.find('img')
                title = (link.get('title') or (img.get('alt') if img else '') or '').strip()
                if not title:
                    slug = href.rstrip('/').split('/')[-1]
                    slug = re.sub(r'^\d+-', '', slug).replace('.html', '')
                    title = slug.replace('_', ' ').strip().capitalize()
                thumbnail = None
                if img:
                    src = img.get('src') or img.get('data-src') or img.get('data-original') or ''
                    if src.startswith('//'):
                        src = 'https:' + src
                    if src and not src.startswith('data:'):
                        thumbnail = src
                results.append({
                    'source': 'HQPorner',
                    'title': title[:100],
                    'url': url,
                    'thumbnail': thumbnail,
                    'description': 'Found on HQPorner'
                })
                if len(results) >= _cap:
                    break
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"HQPorner search failed: {e}")
            return await self.search_via_duckduckgo_async(query, "hqporner.com", "HQPorner")
            
        return results

    async def search_mypornerleak_async(self, query: str, result_limit: int = 24):
        _cap = max(1, min(int(result_limit or 24), 200))
        """Search MyPornerLeak via direct scraping (article elements)."""
        results = []
        try:
            url = f"https://mypornerleak.com/?s={urllib.parse.quote(query)}"
            html = await self._fetch_impersonated(url, referer="https://mypornerleak.com/", timeout=15)
            if not html:
                return []
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            
            # Helper to parse duration string to seconds
            def parse_duration_seconds(d_str):
                if not d_str: return 0
                parts = d_str.split(':')
                try:
                    if len(parts) == 3:
                        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                    elif len(parts) == 2:
                        return int(parts[0]) * 60 + int(parts[1])
                except:
                    pass
                return 0

            # Helper to proxy thumbnail
            def proxy_thumbnail(url):
                if not url: return None
                if url.startswith('/api/v1/proxy'): return url
                protected = ["58img.top", "nsfwpics.co", "leakporner", "mypornerleak", "nsfw247"]
                if any(p in url.lower() for p in protected):
                    return f"/api/v1/proxy?url={urllib.parse.quote(url)}"
                return url

            for item in soup.select('article')[:_cap]:
                link = item.find('a', href=True)
                if not link: continue
                item_url = link.get('href', '')
                if not item_url.startswith('http'): continue
                title_el = item.find(['h2', 'h3', 'h1'])
                title = (title_el.get_text(strip=True) if title_el else '') or link.get('title', '')
                img = item.find('img')
                
                thumbnail = None
                if img:
                    raw_thumb = img.get('data-src') or img.get('src')
                    if raw_thumb:
                        thumbnail = proxy_thumbnail(raw_thumb)
                
                # Fix duration selector using regex compile instead of failing lambda
                dur_el = item.select_one('.duration') or item.find(class_=re.compile('duration', re.I))
                duration = dur_el.get_text(strip=True) if dur_el else ''
                
                # The listing has no verified resolution. A title hint can be
                # shown, but do not invent 1080p for every card.
                quality = ""
                title_lower = title.lower()
                if "4k" in title_lower or "2160" in title_lower:
                    quality = "4K"
                elif "1080" in title_lower or "fhd" in title_lower:
                    quality = "1080p"
                elif "720" in title_lower or "hd" in title_lower:
                    quality = "720p"
                
                size_bytes = 0
                size_str = ""
                
                if title or item_url:
                    results.append({
                        'source': 'MyPornerLeak',
                        'title': title or item_url.split('/')[-1],
                        'url': item_url,
                        'thumbnail': thumbnail,
                        'duration': duration,
                        'quality': quality,
                        'size': size_str,
                        'size_bytes': size_bytes,
                        'description': ''
                    })
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"MyPornerLeak search error: {e}")
        return results

    async def search_pimpbunny_async(self, query: str, result_limit: int = 24):
        """Search PimpBunny using its current listing format."""
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        try:
            from .hubs.pimpbunny import PimpBunnyHub

            hub = PimpBunnyHub()
            seen = set()
            for page in range(1, 201):
                url = hub._list_url(query, '', 'recent', page)
                status, html, _ = await hub._get_html(url)
                _record_source_http(status)
                if status != 200:
                    break
                items = await asyncio.to_thread(hub._parse_tiles, html)
                previous_count = len(results)
                for item in items:
                    if item['url'] in seen:
                        continue
                    seen.add(item['url'])
                    results.append({
                        'source': 'PimpBunny', 'title': item['title'],
                        'url': item['url'], 'thumbnail': item['thumb'],
                        'duration': item['duration'], 'quality': item['quality'],
                        'description': '',
                    })
                    if len(results) >= _cap:
                        return results
                total = hub._total_videos(html)
                if len(results) == previous_count or (total and page * 30 >= total):
                    break
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"PimpBunny search error: {e}")
        return results

    async def search_hornysimp_async(self, query: str, result_limit: int = 24):
        _cap = max(1, min(int(result_limit or 24), 200))
        """Search HornySimp via direct scraping."""
        results = []
        try:
            url = f"https://hornysimp.com/?s={urllib.parse.quote(query)}"
            headers = self.headers.copy()
            headers['Referer'] = 'https://hornysimp.com/'
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(url, timeout=15, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status not in (200, 301, 302):
                        return []
                    html = await resp.text()
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            items = soup.select('article') or soup.select('.post') or soup.select('.video-item')
            for item in items[:_cap]:
                link = item.find('a', href=True)
                if not link: continue
                item_url = link.get('href', '')
                if not item_url.startswith('http'): continue
                title_el = item.find(['h2', 'h3', 'h1'])
                title = (title_el.get_text(strip=True) if title_el else '') or link.get('title', '')
                img = item.find('img')
                thumbnail = (img.get('data-src') or img.get('src')) if img else None
                if title or item_url:
                    results.append({'source': 'HornySimp', 'title': title or item_url.split('/')[-1], 'url': item_url, 'thumbnail': thumbnail, 'description': ''})
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"HornySimp search error: {e}")
        return results

    async def search_camwhores_async(self, query: str, result_limit: int = 24,
                                    enrich_quality: bool = True, include_private: bool = False):
        _cap = max(1, min(int(result_limit or 24), 200))
        """Search Camwhores.tv via direct scraping."""
        results = []
        try:
            # The canonical path returns searchable tiles; /search/?q= can
            # silently return a generic recommendation listing instead.
            slug = re.sub(r'\s+', '-', query.strip().lower())
            url = f"https://www.camwhores.tv/search/{urllib.parse.quote(slug, safe='')}/"
            headers = self.headers.copy()
            headers['Referer'] = 'https://www.camwhores.tv/'
            def fetch_html():
                from curl_cffi import requests as cr
                response = cr.get(url, headers=headers, impersonate="chrome", timeout=15)
                _record_source_http(response.status_code)
                return response.text if response.status_code == 200 else ""

            html = await asyncio.to_thread(fetch_html)
            if not html:
                return []
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            # Iterate every tile and cap on ACCEPTED results: slicing up front
            # spent the budget on private uploads that get skipped below, so a
            # request for 12 came back with 4.
            for item in soup.select('.item'):
                if len(results) >= _cap:
                    break
                link = item.find('a', href=True)
                if not link: continue
                item_url = link.get('href', '')
                if not item_url.startswith('http'):
                    item_url = f"https://www.camwhores.tv{item_url}"
                # Title from title attr or inner text
                title = link.get('title', '') or link.get_text(strip=True)
                # Thumbnail - lazy loaded, skip base64 placeholders
                img = item.find('img')
                thumbnail = None
                if img:
                    src = img.get('data-original') or img.get('data-src') or img.get('src', '')
                    if src and not src.startswith('data:'):
                        thumbnail = src
                dur_el = item.select_one('.duration, .dur, .time')
                duration = dur_el.get_text(strip=True) if dur_el else ''
                # Discovery can retain an exact identity hit behind login;
                # ordinary playable search keeps its previous public-only default.
                requires_login = 'private' in (item.get('class') or [])
                if requires_login and not include_private:
                    continue
                if item_url and '/videos/' in item_url:
                    results.append({'source': 'Camwhores', 'title': title or item_url.split('/')[-2],
                                    'url': item_url, 'thumbnail': thumbnail, 'duration': duration,
                                    'description': '', 'requires_login': requires_login})

            # The search listing carries NO resolution at all, so tiles used to
            # render with a blank quality. The watch page's flashvars do have it
            # (`preview_height1` is the real video height on this skin), so pull
            # it for the visible head of the list — bounded and parallel so the
            # search stays inside its timeout budget.
            if enrich_quality:
                await self._enrich_camwhores_quality(results, headers)
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"Camwhores search error: {e}")
        return results

    async def _enrich_camwhores_quality(self, results: list, headers: dict, max_items: int = 40):
        """Fill `quality`/`height` on Camwhores results from their watch pages."""
        targets = [r for r in results if r.get('url')][:max_items]
        if not targets:
            return
        sem = asyncio.Semaphore(10)

        async def one(item: dict):
            async with sem:
                try:
                    async with aiohttp.ClientSession(headers=headers) as session:
                        async with session.get(item['url'], timeout=8, ssl=self.ssl_context) as resp:
                            _record_source_http(resp.status)
                            if resp.status != 200:
                                return
                            html = await resp.text()
                except Exception:
                    return
                m = re.search(r"preview_height1\s*:\s*['\"]?(\d{3,4})", html) or \
                    re.search(r"video_height\s*:\s*['\"]?(\d{3,4})", html)
                if not m:
                    return
                # `preview_height1` IS the real video height here (verified with
                # ffprobe: a tile reporting 672 is a genuine 1280x672 file). Cam
                # recordings are often cropped, so snap the odd heights (672,
                # 1088, …) down to the nearest standard tier for a sane label
                # while keeping the exact pixel height for sorting.
                height = int(m.group(1))
                for tier in (2160, 1440, 1080, 720, 480, 360, 240):
                    if height >= tier:
                        label_h = tier
                        break
                else:
                    label_h = height
                item['height'] = height
                item['quality'] = "4K" if label_h >= 2160 else f"{label_h}p"

        await asyncio.gather(*[one(t) for t in targets], return_exceptions=True)

    async def search_djav_async(self, query: str, result_limit: int = 24):
        """Search DJAV via its /?s=<query> listing page."""
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        try:
            url = f"https://djav.org/?s={urllib.parse.quote(query.strip())}"
            html = await self._fetch_impersonated(url, referer="https://djav.org/", timeout=15)
            if not html:
                return []
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            seen = set()
            for article in soup.select('article'):
                link = article.select_one('a[href*="/video/"]') or article.select_one('a[href]')
                if not link:
                    continue
                href = link.get('href', '').strip()
                if not href or '/video/' not in href:
                    continue
                item_url = href if href.startswith('http') else f"https://djav.org{href}"
                if item_url in seen:
                    continue
                seen.add(item_url)

                title_el = article.select_one('h2.entry-title a, .entry-header a, a.thumb')
                title = (title_el.get_text(strip=True) if title_el else (link.get('title') or '')).strip()
                if not title:
                    title = article.get_text(strip=True)[:80]
                title = re.sub(r'^(?:HD)?\d{1,2}:\d{2}(?::\d{2})?\s*', '', title).strip()

                img = article.select_one('img')
                thumbnail = None
                if img:
                    thumbnail = img.get('data-src') or img.get('src', '')

                dur_el = article.select_one('.-length, .item-time, .sub-label')
                dur_text = dur_el.get_text(strip=True) if dur_el else article.get_text(strip=True)
                m_dur = re.search(r'\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b', dur_text)
                duration = m_dur.group(0) if m_dur else ''

                results.append({
                    'source': 'DJAV',
                    'title': title[:100],
                    'url': item_url,
                    'thumbnail': thumbnail,
                    'duration': duration,
                    'description': '',
                    'quality': 'HD',
                })
                if len(results) >= _cap:
                    break
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"DJAV search error: {e}")
        return results

    async def search_oneporn_async(self, query: str, result_limit: int = 24):
        """Search 1Porn.tv via its /search/<slug>/ listing page with Cloudflare bypass."""
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        try:
            from .oneporn_client import fetch_1porn_html
            slug = re.sub(r'\s+', '-', query.strip())
            url = f"https://www.1porn.tv/search/{urllib.parse.quote(slug)}/"
            html = await fetch_1porn_html(url, referer="https://www.1porn.tv/")
            if not html:
                return []
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            seen = set()
            for link in soup.select('a[href*="/videos/"]'):
                href = link.get('href', '')
                if '/videos/' not in href:
                    continue
                item_url = href if href.startswith('http') else f"https://www.1porn.tv{href}"
                if item_url in seen:
                    continue
                seen.add(item_url)
                title = (link.get('title') or link.get_text(strip=True) or '').strip()
                img = link.find('img')
                thumbnail = None
                if img:
                    src = img.get('data-original') or img.get('data-src') or img.get('src', '')
                    if src and not src.startswith('data:'):
                        thumbnail = src
                dur_el = link.find(class_=lambda c: c and 'duration' in c)
                duration = dur_el.get_text(strip=True) if dur_el else ''
                # 1Porn prefixes durations with labels like "Full Video 31:38".
                m_dur = re.search(r'\d{1,2}:\d{2}(?::\d{2})?', duration)
                if m_dur:
                    duration = m_dur.group(0)
                if not title:
                    title = href.rstrip('/').split('/')[-1].replace('-', ' ').strip().capitalize()
                results.append({'source': '1Porn', 'title': title[:100], 'url': item_url,
                                'thumbnail': thumbnail, 'duration': duration, 'description': ''})
                if len(results) >= _cap:
                    break
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"1Porn search error: {e}")
        return results

    async def search_fpo_async(self, query: str, result_limit: int = 24):
        """Search FPO.xxx via its /search/<slug>/ listing page."""
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        try:
            slug = re.sub(r'\s+', '-', query.strip())
            url = f"https://www.fpo.xxx/search/{urllib.parse.quote(slug)}/"
            headers = self.headers.copy()
            headers['Referer'] = 'https://www.fpo.xxx/'
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(url, timeout=15, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200:
                        return []
                    html = await resp.text()
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            seen = set()
            for link in soup.select('a[href*="/video/"]'):
                href = link.get('href', '')
                if '/video/' not in href:
                    continue
                item_url = href if href.startswith('http') else f"https://www.fpo.xxx{href}"
                if item_url in seen:
                    continue
                seen.add(item_url)
                title = (link.get('title') or link.get_text(strip=True) or '').strip()
                img = link.find('img')
                thumbnail = None
                if img:
                    src = img.get('data-original') or img.get('data-src') or img.get('src', '')
                    if src and not src.startswith('data:'):
                        thumbnail = src
                dur_el = link.find(class_=lambda c: c and 'duration' in c)
                duration = dur_el.get_text(strip=True) if dur_el else ''
                if not title:
                    # /video/350398/27sx-big-tits-bimbo-step-mom/ -> slug part
                    parts = [p for p in href.rstrip('/').split('/') if p]
                    title = (parts[-1] if parts else '').replace('-', ' ').strip().capitalize()
                results.append({'source': 'FPO', 'title': title[:100], 'url': item_url,
                                'thumbnail': thumbnail, 'duration': duration, 'description': ''})
                if len(results) >= _cap:
                    break
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"FPO search error: {e}")
        return results

    async def search_pornone_async(self, query: str, result_limit: int = 24):
        """Search PornOne.com via /search?q= listing (Tailwind-class markup)."""
        _cap = max(1, min(int(result_limit or 24), 200))
        results = []
        try:
            url = f"https://pornone.com/search?q={urllib.parse.quote(query.strip())}"
            headers = self.headers.copy()
            headers['Referer'] = 'https://pornone.com/'
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(url, timeout=15, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200:
                        return []
                    html = await resp.text()
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            seen = set()
            for a in soup.select('a.videocard'):
                href = a.get('href') or ''
                m = re.search(r'pornone\.com/[^/]+/[^/]+/(\d{5,})/', href)
                if not m:
                    continue
                item_url = href if href.startswith('http') else f"https://pornone.com{href}"
                item_url = item_url.split('?')[0].split('#')[0]
                if item_url in seen:
                    continue
                # Real thumbnail (skip the HD/addto SVG icons that share the card).
                timg = a.select_one('img.thumbimg, img.imgvideo')
                thumbnail = None
                if timg:
                    src = timg.get('data-src') or timg.get('data-original') or timg.get('src') or ''
                    if src and not src.endswith('.svg') and not src.startswith('data:'):
                        thumbnail = src
                if not thumbnail:
                    continue  # cards without a real thumb are ads / placeholders
                seen.add(item_url)
                # Duration: PornOne renders a bare mm:ss span inside the card.
                duration = ''
                for e in a.select('*'):
                    t = e.get_text(strip=True)
                    if re.fullmatch(r'\d{1,2}:\d{2}(?::\d{2})?', t):
                        duration = t
                        break
                # .videotitle lives directly inside a.videocard; searching from a parent
                # div hits the outer grid container and repeats the first card's title.
                tnode = a.select_one('.videotitle')
                title = _html_unescape(tnode.get_text(strip=True)) if tnode else ''
                if not title:
                    alt = (timg.get('alt') if timg else '') or ''
                    title = _html_unescape(alt).strip()
                title = title or 'PornOne video'
                results.append({'source': 'PornOne', 'title': title[:100],
                                'url': item_url, 'thumbnail': thumbnail, 'duration': duration,
                                'description': ''})
                if len(results) >= _cap:
                    break
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"PornOne search error: {e}")
        return results

    async def search_leakporner_async(self, query: str, result_limit: int = 24):
        _cap = max(1, min(int(result_limit or 24), 200))
        """Search LeakPorner via direct scraping."""
        results = []
        try:
            # Use w12 subdomain for better reliability
            url = f"https://w12.leakporner.com/?s={urllib.parse.quote(query)}"
            html = await self._fetch_impersonated(url, referer="https://leakporner.com/", timeout=15)
            if not html:
                return []
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            
            # Helper to parse duration string to seconds
            def parse_duration_seconds(d_str):
                if not d_str: return 0
                parts = d_str.split(':')
                try:
                    if len(parts) == 3:
                        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                    elif len(parts) == 2:
                        return int(parts[0]) * 60 + int(parts[1])
                except:
                    pass
                return 0

            # Helper to proxy thumbnail
            def proxy_thumbnail(url):
                if not url: return None
                if url.startswith('/api/v1/proxy'): return url
                protected = ["58img.top", "nsfwpics.co", "leakporner", "mypornerleak", "nsfw247"]
                if any(p in url.lower() for p in protected):
                    return f"/api/v1/proxy?url={urllib.parse.quote(url)}"
                return url

            for item in soup.select('article')[:_cap]:
                link = item.find('a', href=True)
                if not link: continue
                item_url = link.get('href', '')
                if not item_url: continue
                # Handle relative URLs
                if not item_url.startswith('http'):
                    item_url = urllib.parse.urljoin(url, item_url)
                
                title_el = item.find(['h2', 'h3', 'h1'])
                title = (title_el.get_text(strip=True) if title_el else '') or link.get('title', '')
                img = item.find('img')
                
                thumbnail = None
                if img:
                    raw_thumb = img.get('data-src') or img.get('src')
                    if raw_thumb:
                        thumbnail = proxy_thumbnail(raw_thumb)
                
                dur_el = item.select_one('.duration') or item.find(class_=re.compile('duration', re.I))
                duration = dur_el.get_text(strip=True) if dur_el else ''
                
                # Heuristic for quality
                quality = ""
                title_lower = title.lower()
                if "4k" in title_lower or "2160" in title_lower:
                    quality = "4K"
                elif "1080" in title_lower or "fhd" in title_lower:
                    quality = "1080p"
                elif "720" in title_lower or "hd" in title_lower:
                    quality = "720p"
                
                size_bytes = 0
                size_str = ""
                
                if title or item_url:
                    results.append({
                        'source': 'LeakPorner',
                        'title': title or item_url.split('/')[-1],
                        'url': item_url,
                        'thumbnail': thumbnail,
                        'duration': duration,
                        'quality': quality,
                        'size': size_str,
                        'size_bytes': size_bytes,
                        'description': ''
                    })
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"LeakPorner search error: {e}")
        return results

    async def search_nsfw247_async(self, query: str, result_limit: int = 24):
        _cap = max(1, min(int(result_limit or 24), 200))
        """Search NSFW247 via direct scraping."""
        results = []
        try:
            url = f"https://nsfw247.to/?s={urllib.parse.quote(query)}"
            headers = self.headers.copy()
            headers['Referer'] = 'https://nsfw247.to/'
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(url, timeout=15, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200:
                        return []
                    html = await resp.text()
            
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            items = soup.select('article')[:_cap]
            
            temp_results = []
            
            def proxy_thumbnail(url):
                if not url: return None
                if url.startswith('/api/v1/proxy'): return url
                protected = ["58img.top", "nsfwpics.co", "leakporner", "mypornerleak", "nsfw247"]
                if any(p in url.lower() for p in protected):
                    return f"/api/v1/proxy?url={urllib.parse.quote(url)}"
                return url

            for item in items:
                link = item.find('a', href=True)
                if not link: continue
                item_url = link.get('href', '')
                if not item_url.startswith('http'): continue
                title_el = item.find(['h2', 'h3', 'h1'])
                title = (title_el.get_text(strip=True) if title_el else '') or link.get('title', '')
                
                thumbnail = None
                img = item.find('img')
                if img:
                    raw_thumb = img.get('data-src') or img.get('data-bttrlazyloading-md-src') or img.get('data-original') or img.get('src')
                    if raw_thumb:
                        thumbnail = proxy_thumbnail(raw_thumb)
                if not thumbnail:
                    noscript = item.find('noscript')
                    if noscript:
                        ns_img = noscript.find('img')
                        if ns_img:
                            raw_thumb = ns_img.get('src') or ns_img.get('data-src')
                            if raw_thumb:
                                thumbnail = proxy_thumbnail(raw_thumb)
                
                temp_results.append({
                    'source': 'NSFW247',
                    'title': title or item_url.split('/')[-1],
                    'url': item_url,
                    'thumbnail': thumbnail,
                    'description': ''
                })

            if temp_results:
                async with aiohttp.ClientSession(headers=self.headers) as detail_session:
                    tasks = [self._fetch_nsfw247_detail(detail_session, r['url']) for r in temp_results]
                    details = await asyncio.gather(*tasks, return_exceptions=True)
                    
                    for r, detail in zip(temp_results, details):
                        duration = "15:00"
                        quality = "1080p"
                        size_str = "250 MB"
                        size_bytes = 250 * 1024 * 1024
                        
                        if detail and isinstance(detail, dict):
                            duration = detail.get('duration', duration)
                            quality = detail.get('quality', quality)
                            size_str = detail.get('size', size_str)
                            size_bytes = detail.get('size_bytes', size_bytes)
                            
                        title_lower = r['title'].lower()
                        if "4k" in title_lower or "2160" in title_lower:
                            quality = "4K"
                        elif "1080" in title_lower or "fhd" in title_lower:
                            quality = "1080p"
                        elif "720" in title_lower or "hd" in title_lower:
                            quality = "720p"

                        r['duration'] = duration
                        r['quality'] = quality
                        r['size'] = size_str
                        r['size_bytes'] = size_bytes
                        results.append(r)
            
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"NSFW247 search error: {e}")
        return results

    async def _fetch_nsfw247_detail(self, session, item_url):
        try:
            async with session.get(item_url, timeout=8) as resp:
                _record_source_http(resp.status)
                if resp.status != 200:
                    return None
                html = await resp.text()
            
            m = re.search(r'src=["\'](https?://[^"\']+\.mp4)["\']', html)
            if not m:
                m = re.search(r'href=["\'](https?://[^"\']+\.mp4)["\']', html)
            
            if m:
                mp4_url = m.group(1)
                try:
                    async with session.head(mp4_url, timeout=4, allow_redirects=True) as head_resp:
                        if head_resp.status in (200, 206):
                            cl = head_resp.headers.get('Content-Length')
                            if cl:
                                size_bytes = int(cl)
                                size_mb = round(size_bytes / (1024 * 1024), 2)
                                size_str = f"{size_mb / 1024:.1f} GB" if size_mb >= 1024 else f"{size_mb:.1f} MB"
                                
                                dur_secs = int(size_bytes / 300000)
                                if dur_secs <= 0: dur_secs = 900
                                hh = dur_secs // 3600
                                mm = (dur_secs % 3600) // 60
                                ss = dur_secs % 60
                                if hh > 0:
                                    duration = f"{hh}:{mm:02d}:{ss:02d}"
                                else:
                                    duration = f"{mm}:{ss:02d}"
                                
                                return {
                                    'mp4_url': mp4_url,
                                    'size_bytes': size_bytes,
                                    'size': size_str,
                                    'duration': duration,
                                    'quality': '1080p'
                                }
                except Exception as head_err:
                    logger.debug(f"NSFW247 HEAD failed: {head_err}")
                
                return {
                    'mp4_url': mp4_url,
                    'size_bytes': 250 * 1024 * 1024,
                    'size': '250 MB',
                    'duration': '15:00',
                    'quality': '1080p'
                }
        except Exception as e:
            _record_source_exception(e)
            logger.debug(f"NSFW247 detail failed: {e}")
        return None

    async def search_internetchicks_async(self, query: str, result_limit: int = 24):
        _cap = max(1, min(int(result_limit or 24), 200))
        """Search InternetChicks.com via WordPress search scraping."""
        results = []
        try:
            url = f"https://internetchicks.com/?s={urllib.parse.quote(query)}"
            headers = self.headers.copy()
            headers['Referer'] = 'https://internetchicks.com/'
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(url, timeout=15, ssl=self.ssl_context) as resp:
                    _record_source_http(resp.status)
                    if resp.status != 200:
                        return []
                    html = await resp.text()
            soup = await asyncio.to_thread(BeautifulSoup, html, "lxml")
            # JNews theme uses .jeg_post articles, fallback to generic article/post
            items = (soup.select('article.jeg_post') or
                     soup.select('article') or
                     soup.select('.post') or
                     soup.select('.jeg_post'))
            for item in items[:_cap]:
                link = item.find('a', href=True)
                if not link:
                    continue
                item_url = link.get('href', '')
                if not item_url.startswith('http'):
                    continue
                # Skip category/tag/page links – we want post links only
                if '/category/' in item_url or '/tag/' in item_url or '/page/' in item_url:
                    continue
                title_el = item.find(['h3', 'h2', 'h1'], class_=re.compile(r'jeg_post_title|entry-title|post-title', re.I))
                if not title_el:
                    title_el = item.find(['h3', 'h2', 'h1'])
                title = (title_el.get_text(strip=True) if title_el else '') or link.get('title', '')
                img = item.find('img')
                thumbnail = None
                if img:
                    thumbnail = (img.get('data-src') or img.get('data-lazy-src') or
                                 img.get('data-original') or img.get('src'))
                    # Skip base64 placeholders
                    if thumbnail and thumbnail.startswith('data:'):
                        thumbnail = None
                if title or item_url:
                    results.append({
                        'source': 'InternetChicks',
                        'title': title or item_url.split('/')[-2].replace('-', ' ').title(),
                        'url': item_url,
                        'thumbnail': thumbnail,
                        'description': '',
                        'quality': 'HD',
                        'upload_type': 'leak',
                    })
        except Exception as e:
            _record_source_exception(e)
            logger.error(f"InternetChicks search error: {e}")
        return results
