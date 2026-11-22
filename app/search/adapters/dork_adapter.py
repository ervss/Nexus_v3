"""Vrstva 4: Local SearXNG Dork Aggregator s prísnym filtrovaním URL, zhodou frázy a live overením 404."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence
from urllib.parse import urlencode, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from ..base import (
    DEFAULT_UA,
    AdapterBatch,
    CircuitBreakerBlockedError,
    cb_allow,
    cb_record_failure,
    cb_record_success,
    extract_json_ld_items,
    fetch_page,
    format_duration_str,
    matches_query_strictly as _base_matches_query,
    normalize_result,
    parse_duration_seconds,
    parse_quality_height,
)

logger = logging.getLogger("nexus.omega_search.dork")

# Kompaktné dávky po max 5 domén (väčšina vyhľadávačov v SearXNG ignoruje dlhé OR site: reťazce)
DEFAULT_DORK_GROUPS: tuple[tuple[str, str, Sequence[str]], ...] = (
    (
        "dork_leaks_a",
        "Dork (Erome / PimpBunny / PornHoarder / LeakHub / PureGirl)",
        ("erome.com", "pimpbunny.com", "pornhoarder.tv", "leakhub.vip", "puregirl.tv"),
    ),
    (
        "dork_tubes_a",
        "Dork (FapHouse / PornHat / 1Porn / FPO / PornOne)",
        ("faphouse.com", "pornhat.com", "1porn.tv", "fpo.xxx", "pornone.com"),
    ),
    (
        "dork_tubes_b",
        "Dork (Beeg / Noodle / SxyPrn / ThotsTv)",
        ("beeg.com", "noodlemagazine.com", "sxyprn.com", "thots.tv"),
    ),
    (
        "dork_albums",
        "Dork (Balbums / Findr / Bunkrr / GoFile / Pixeldrain)",
        ("balbums.st", "bunkr-albums.io", "findr.to", "gofile.io", "pixeldrain.com"),
    ),
    (
        "dork_forums",
        "Dork (SimpCity / SMG / Archivebate / Recurbate / FapFolder)",
        ("simpcity.cr", "forums.socialmediagirls.com", "archivebate.live", "rec-ur-bate.com", "fapfolder.club"),
    ),
)

# Navigačné a zoznamové cesty, ktoré nie sú konkrétnym videom/albumom/postom
_JUNK_PATH_RE = re.compile(
    r"(?:^/$|/(?:categor(?:y|ies)|tags?|trending|popular|bundles|latest|top(?:-rated)?|"
    r"best|most-viewed|new(?:-\d+)?|search|models?|pornstars?|channels?|actors?|"
    r"users?|feed|login|register|signup|dmca|privacy|terms|contact|page)(?:/|$))",
    re.I,
)
_CAT_PREFIX_RE = re.compile(r"^/(?:[a-z]{2}/)?(?:c|t|tag|cat|channel|model|pornstar|user)/", re.I)

# Povinné vzory pre známe domény — aby prešli iba konkrétne videá / albumy / thready
_ITEM_URL_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("erome.com", re.compile(r"/a/[A-Za-z0-9_-]+", re.I)),
    ("balbums.st", re.compile(r"/a/[A-Za-z0-9_-]+", re.I)),
    ("bunkr-albums.io", re.compile(r"/a/[A-Za-z0-9_-]+", re.I)),
    ("findr.to", re.compile(r"/(?:albums?|a)/[A-Za-z0-9_-]+", re.I)),
    ("gofile.io", re.compile(r"/d/[A-Za-z0-9_-]+", re.I)),
    ("pixeldrain.com", re.compile(r"/(?:u|l)/[A-Za-z0-9_-]+", re.I)),
    ("faphouse.com", re.compile(r"/videos/[A-Za-z0-9_-]+", re.I)),
    ("pimpbunny.com", re.compile(r"/videos/[A-Za-z0-9_-]+", re.I)),
    ("pornhat.com", re.compile(r"/video/[A-Za-z0-9_-]+", re.I)),
    ("1porn.tv", re.compile(r"/videos?/[A-Za-z0-9_-]+", re.I)),
    ("fpo.xxx", re.compile(r"/video/\d+", re.I)),
    ("pornone.com", re.compile(r"/[^/]+/[^/]+/\d+", re.I)),
    ("beeg.com", re.compile(r"/-\d+", re.I)),
    ("noodlemagazine.com", re.compile(r"/watch/-?\d+_\d+", re.I)),
    ("sxyprn.com", re.compile(r"/post/[A-Za-z0-9]+", re.I)),
    ("pornhoarder.tv", re.compile(r"/(?:pornvideo|watch)/", re.I)),
    ("leakhub.vip", re.compile(r"/video/\d+", re.I)),
    ("simpcity.cr", re.compile(r"/threads/", re.I)),
    ("forums.socialmediagirls.com", re.compile(r"/threads/", re.I)),
    ("fapfolder.club", re.compile(r"/posts/\d+", re.I)),
    ("archivebate.live", re.compile(r"/(?:watch|video)/", re.I)),
    ("rec-ur-bate.com", re.compile(r"/video/\d+", re.I)),
)

_SOFT_404_RE = re.compile(
    r"(?:404\s*(?:not\s*found|error|page)|(?:page|post|video|thread|file|album)\s*(?:not|cannot\s*be)\s*found|"
    r"(?:video|post|thread|content)\s*(?:has\s*been\s*(?:removed|deleted)|is\s*(?:unavailable|deleted|no\s*longer\s*available))|"
    r"(?:album|post|video)\s*(?:was|is)\s*removed|content\s*(?:was\s*removed|unavailable)|nothing\s+found|"
    r"this\s*(?:page|video|post)\s*(?:doesn['’]t|does\s*not)\s*exist)",
    re.I,
)


def build_dork_query(domains: Sequence[str], user_query: str) -> str:
    """Zostaví dynamickú query: `(site:web1.com OR site:web2.com ...) "dotaz"`."""
    clean_domains = [d.strip().lower() for d in domains if d and d.strip()]
    site_clause = " OR ".join(f"site:{dom}" for dom in clean_domains)
    escaped = (user_query or "").replace('"', " ").strip()
    return f'({site_clause}) "{escaped}"'


def is_valid_dork_item_url(url: str, host: str = "") -> bool:
    """Overí, že URL ukazuje na konkrétne video/album/vlákno a nie na homepage či kategóriu."""
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return False
    clean_host = (host or parsed.netloc).lower().lstrip("www.")
    path = parsed.path or "/"
    if _JUNK_PATH_RE.search(path) or _CAT_PREFIX_RE.search(path):
        return False
    for dom, pat in _ITEM_URL_PATTERNS:
        if clean_host == dom or clean_host.endswith("." + dom):
            return bool(pat.search(path))
    # Pre domény bez špecifického vzoru vyžaduj aspoň jeden neprázdny slug mimo page query
    return len(path.strip("/")) >= 3 and not re.fullmatch(r"page=\d+", parsed.query or "", re.I)


def _canonical_dork_key(url: str) -> str:
    """Zlúči varianty rovnakej stránky líšiace sa len sort/filter parametrami (napr. sxyprn ?sk=...)."""
    parsed = urlparse(url)
    base = f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/").lower()
    if any(k in (parsed.query or "").lower() for k in ("sk=", "so=", "ss=", "utm_")):
        return base
    return url.rstrip("/").lower()


def matches_query_strictly(query: str, title: str, url: str, content: str) -> bool:
    """Pri viacslovnom dotaze vyžaduje všetky podstatné slová (vrátane variantov priezvisk)."""
    return _base_matches_query(query, title, url, extra_text=content)


class _SearxHttpError(RuntimeError):
    def __init__(self, status_code: int):
        self.status_code = status_code
        super().__init__(f"SearXNG HTTP {status_code}")


class DorkAggregatorAdapter:
    """Pošle dorkované dotazy na lokálny SearXNG (127.0.0.1:8888) s prísnym overením URL."""

    def __init__(
        self,
        *,
        searxng_url: Optional[str] = None,
        groups: Iterable[tuple[str, str, Sequence[str]]] = DEFAULT_DORK_GROUPS,
        timeout_s: float = 8.0,
        verify_urls: bool = True,
    ):
        self.searxng_url = (searxng_url or os.getenv("SEARXNG_URL") or "http://127.0.0.1:8888/search").rstrip("/")
        self.engines = os.getenv("SEARXNG_ENGINES", "").strip()
        self.groups = tuple(groups)
        self.timeout_s = timeout_s
        self.verify_urls = verify_urls

    async def _query_searx(
        self,
        client: httpx.AsyncClient,
        raw_query: str,
        user_query: str,
        allowed_domains: set[str],
        group_key: str,
        seen_urls: set[str],
        limit: int,
    ) -> List[Dict[str, Any]]:
        query_params = {"q": raw_query, "format": "json"}
        if self.engines:
            query_params["engines"] = self.engines
        full_url = f"{self.searxng_url}?{urlencode(query_params)}"
        resp = await client.get(full_url)
        if resp.status_code in (403, 429) or resp.status_code >= 500:
            raise _SearxHttpError(resp.status_code)
        resp.raise_for_status()
        payload = resp.json() if resp.text else {}
        raw_rows = payload.get("results") if isinstance(payload, dict) else []
        out: List[Dict[str, Any]] = []
        for row in raw_rows or []:
            if not isinstance(row, dict):
                continue
            url = str(row.get("url") or "").strip()
            if not url or not url.startswith("http"):
                continue
            canon_key = _canonical_dork_key(url)
            if url in seen_urls or canon_key in seen_urls:
                continue
            host = urlparse(url).netloc.lower().lstrip("www.")
            if allowed_domains and not any(host == dom or host.endswith("." + dom) for dom in allowed_domains):
                continue
            if not is_valid_dork_item_url(url, host):
                continue
            title = str(row.get("title") or "").strip()
            content = str(row.get("content") or "").strip()
            if _SOFT_404_RE.search(f"{title} {content}"):
                continue
            if not matches_query_strictly(user_query, title, url, content):
                continue

            seen_urls.add(url)
            seen_urls.add(canon_key)
            out.append(
                normalize_result(
                    title=title or url,
                    url=url,
                    source=f"Dork ({host})",
                    source_key=group_key,
                    layer="dork",
                    adapter="dork_adapter",
                    thumbnail=str(row.get("thumbnail") or row.get("img_src") or ""),
                    description=content or f"SearXNG ({row.get('engine', 'dork')})",
                    extra={"dork_domain": host, "searx_engine": row.get("engine", "")},
                )
            )
            if len(out) >= limit:
                break
        return out

    async def _verify_live_item(
        self,
        item: Dict[str, Any],
        sem: asyncio.Semaphore,
        user_query: str = "",
    ) -> Optional[Dict[str, Any]]:
        """Rýchle live overenie, že URL reálne existuje (nie je 404/deleted/soft-404/redirect)."""
        url = str(item.get("url") or "")
        if not url:
            return None
        host = str(item.get("dork_domain") or urlparse(url).netloc.lower().lstrip("www."))
        async with sem:
            try:
                status, final_url, body = await fetch_page(
                    url,
                    domain=host,
                    referer=f"https://{host}/",
                    timeout_s=4.5,
                )
                if status in (404, 410, 451) or status >= 500:
                    logger.debug("[OMEGA][DORK] Vyradená mŕtva URL (HTTP %s): %s", status, url)
                    return None
                final_host = urlparse(final_url).netloc.lower().lstrip("www.") or host
                if final_url and not is_valid_dork_item_url(final_url, final_host):
                    logger.debug("[OMEGA][DORK] Vyradená presmerovaná URL (%s -> %s)", url, final_url)
                    return None

                head_slice = (body or "")[:80000]
                if status != 200 or _SOFT_404_RE.search((body or "")[:50000]):
                    logger.debug("[OMEGA][DORK] Vyradená soft-404/zmazaná URL: %s", url)
                    return None

                # Doplň presný titulok, náhľad, dĺžku a kvalitu zo živej stránky (JSON-LD + meta tagy)
                if head_slice:
                    soup = await asyncio.to_thread(BeautifulSoup, head_slice, "lxml")
                    json_ld = extract_json_ld_items(
                        soup,
                        base_url=final_url or url,
                        source_label=str(item.get("source") or host),
                        source_key=str(item.get("source_key") or "dork"),
                        layer="dork",
                        adapter="dork_adapter",
                        limit=2,
                    )
                    if json_ld:
                        meta0 = json_ld[0]
                        if meta0.get("title") and len(str(meta0["title"])) > 4 and (item.get("title") == url or "..." in str(item.get("title"))):
                            item["title"] = str(meta0["title"])[:180]
                        if not item.get("thumbnail") and meta0.get("thumbnail"):
                            item["thumbnail"] = meta0["thumbnail"]
                            item["thumb_url"] = meta0["thumbnail"]
                        if not item.get("duration") and meta0.get("duration"):
                            item["duration"] = int(meta0["duration"])
                            item["duration_str"] = format_duration_str(int(meta0["duration"]))
                        if not item.get("embed") and meta0.get("embed"):
                            item["embed"] = meta0["embed"]

                    title_tag = soup.select_one('meta[property="og:title"], meta[name="twitter:title"]')
                    page_title = (title_tag.get("content") if title_tag else "") or (
                        soup.title.get_text(" ", strip=True) if soup.title else ""
                    )
                    if page_title and _SOFT_404_RE.search(page_title):
                        return None
                    if not item.get("thumbnail"):
                        og_img = soup.select_one(
                            'meta[property="og:image"], meta[name="twitter:image"], meta[itemprop="thumbnailUrl"], video[poster]'
                        )
                        raw_img = (og_img.get("content") or og_img.get("poster")) if og_img else ""
                        if not raw_img and body:
                            m_pl_img = re.search(r'"image"\s*:\s*"(https?:[^"]+)"', body)
                            if m_pl_img:
                                raw_img = m_pl_img.group(1).replace("\\/", "/")
                        if raw_img:
                            thumb_abs = urljoin(final_url or url, str(raw_img).strip())
                            item["thumbnail"] = thumb_abs
                            item["thumb_url"] = thumb_abs
                    if not item.get("duration"):
                        dur_meta = soup.select_one(
                            'meta[property="video:duration"], meta[property="og:video:duration"], meta[itemprop="duration"]'
                        )
                        if dur_meta and dur_meta.get("content"):
                            d_sec = parse_duration_seconds(dur_meta.get("content"))
                            if d_sec:
                                item["duration"] = d_sec
                                item["duration_str"] = format_duration_str(d_sec)
                    if not item.get("quality"):
                        h_meta, q_meta = parse_quality_height(f"{page_title} {head_slice[:8000]}")
                        if h_meta:
                            item["height"] = h_meta
                            item["quality"] = q_meta
                    if not item.get("upload_date"):
                        dt_meta = soup.select_one(
                            'meta[itemprop="uploadDate"], meta[itemprop="datePublished"], '
                            'meta[property="article:published_time"], meta[property="video:release_date"], '
                            'meta[property="og:updated_time"]'
                        )
                        raw_dt = str((dt_meta.get("content") if dt_meta else "") or "").strip()
                        if not raw_dt:
                            m_ud = re.search(r'"uploadDate"\s*:\s*"(\d{4}-\d{2}-\d{2})', head_slice)
                            if m_ud:
                                raw_dt = m_ud.group(1)
                        if raw_dt and re.match(r"^\d{4}-\d{2}-\d{2}", raw_dt):
                            item["upload_date"] = raw_dt[:10]
                    if page_title and (item.get("title") == url or len(page_title) > len(str(item.get("title") or ""))):
                        item["title"] = page_title[:180]

                if user_query and not _base_matches_query(
                    user_query,
                    str(item.get("title") or ""),
                    final_url or url,
                    str(item.get("description") or ""),
                ):
                    logger.debug("[OMEGA][DORK] Vyradená nezhodná stránka po live kontrole: %s", url)
                    return None
                return item
            except CircuitBreakerBlockedError:
                # Ak web blokuje kontrolu a nemáme ani základný náhľad, nevyhadzuj mŕtvu prázdnu kartu
                if item.get("thumbnail"):
                    return item
                return None
            except Exception as exc:
                msg = str(exc).lower()
                # Pri 403/Cloudflare ponechaj iba výsledok s náhľadom; prázdne neoveriteľné odkazy (napr. pornhoarder 403/404) zahadzujeme
                if ("403" in msg or "challenge" in msg) and item.get("thumbnail"):
                    return item
                logger.debug("[OMEGA][DORK] Overenie URL zlyhalo (%s): %s", exc, url)
                return None

    async def search_group(
        self,
        group_key: str,
        group_label: str,
        domains: Sequence[str],
        query: str,
        *,
        limit: int = 25,
    ) -> AdapterBatch:
        t0 = time.perf_counter()
        dork_q = build_dork_query(domains, query)
        cb_key = urlparse(self.searxng_url).netloc or "127.0.0.1:8888"

        allowed, retry_after = cb_allow(cb_key)
        if not allowed:
            return AdapterBatch(
                layer="dork",
                adapter="dork_adapter",
                source_key=group_key,
                source_label=group_label,
                status="skipped_circuit",
                error=f"SearXNG circuit open (retry za {retry_after:.1f}s)",
                elapsed_ms=int((time.perf_counter() - t0) * 1000),
                query_used=dork_q,
            )

        try:
            allowed_domains = {d.strip().lower().lstrip("www.") for d in domains if d and d.strip()}
            seen_urls: set[str] = set()
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout_s, connect=1.5),
                headers={"User-Agent": DEFAULT_UA, "Accept": "application/json"},
            ) as client:
                items = await self._query_searx(client, dork_q, query, allowed_domains, group_key, seen_urls, limit)
                # Ak kombinovaný OR dork nevrátil presné zhody (napr. Bing limit), skús paralelne per-domain s úvodzovkami
                if not items and len(domains) > 1:
                    clean_q = (query or "").replace('"', " ").strip()
                    per_dom = await asyncio.gather(
                        *[
                            self._query_searx(
                                client,
                                f'site:{dom} "{clean_q}"',
                                query,
                                {dom.strip().lower().lstrip("www.")},
                                group_key,
                                seen_urls,
                                max(4, limit // len(domains)),
                            )
                            for dom in domains[:5]
                        ],
                        return_exceptions=True,
                    )
                    for res in per_dom:
                        if isinstance(res, list):
                            items.extend(res)
                    # Ak úvodzovky vrátili 0 (niektoré enginy sú príliš prísne pri presnej fráze),
                    # skús voľnejšie slová s naším vlastným prísnym post-filtrom `matches_query_strictly`
                    if not items:
                        per_dom_loose = await asyncio.gather(
                            *[
                                self._query_searx(
                                    client,
                                    f"site:{dom} {clean_q}",
                                    query,
                                    {dom.strip().lower().lstrip("www.")},
                                    group_key,
                                    seen_urls,
                                    max(4, limit // len(domains)),
                                )
                                for dom in domains[:5]
                            ],
                            return_exceptions=True,
                        )
                        for res in per_dom_loose:
                            if isinstance(res, list):
                                items.extend(res)
                    items = items[:limit]

            cb_record_success(cb_key)

            # Live verifikácia kandidátov — vyradí 404 a zmazané videá
            if self.verify_urls and items:
                verify_sem = asyncio.Semaphore(6)
                checked = await asyncio.gather(
                    *[self._verify_live_item(it, verify_sem, query) for it in items[:12]],
                    return_exceptions=True,
                )
                items = [c for c in checked if isinstance(c, dict)]

            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.info("[OMEGA][DORK] %s (%s): %d overených výsledkov (%d ms)", group_label, self.searxng_url, len(items), elapsed)
            return AdapterBatch(
                layer="dork",
                adapter="dork_adapter",
                source_key=group_key,
                source_label=group_label,
                items=items,
                status="ok" if items else "empty",
                elapsed_ms=elapsed,
                query_used=dork_q,
            )
        except CircuitBreakerBlockedError as exc:
            return AdapterBatch("dork", "dork_adapter", group_key, group_label, status="skipped_circuit", error=str(exc), query_used=dork_q)
        except _SearxHttpError as exc:
            sc = exc.status_code
            err_msg = str(exc)
            cb_record_failure(cb_key, err_msg, immediate_trip=(sc in (403, 429)))
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.warning("[OMEGA][DORK] %s nedostupný (%s) (%d ms)", self.searxng_url, err_msg, elapsed)
            return AdapterBatch("dork", "dork_adapter", group_key, group_label, status="error", error=err_msg, elapsed_ms=elapsed, query_used=dork_q)
        except Exception as exc:
            err_msg = str(exc).strip() or type(exc).__name__
            is_down = isinstance(exc, (httpx.TimeoutException, httpx.TransportError)) or "refused" in err_msg.lower()
            cb_record_failure(cb_key, f"SearXNG unavailable: {err_msg}", immediate_trip=is_down)
            elapsed = int((time.perf_counter() - t0) * 1000)
            logger.warning("[OMEGA][DORK] %s nedostupný (%s) (%d ms)", self.searxng_url, err_msg, elapsed)
            return AdapterBatch(
                layer="dork",
                adapter="dork_adapter",
                source_key=group_key,
                source_label=group_label,
                status="error",
                error=err_msg,
                elapsed_ms=elapsed,
                query_used=dork_q,
            )

    def iter_tasks(
        self,
        query: str,
        *,
        selected_keys: Optional[set[str]] = None,
        per_group_limit: int = 25,
    ) -> List[asyncio.Task]:
        tasks: List[asyncio.Task] = []
        for g_key, g_label, domains in self.groups:
            if selected_keys and g_key not in selected_keys and "dork" not in selected_keys:
                continue
            tasks.append(
                asyncio.create_task(self.search_group(g_key, g_label, domains, query, limit=per_group_limit))
            )
        return tasks
