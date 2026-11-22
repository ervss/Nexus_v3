
from __future__ import annotations
"""
V6 multi-source public OSINT collectors.
Pipeline unchanged: collect -> extract -> dedupe -> validate.
Focus: maximize unique candidate /f/ IDs.
"""

import json
import asyncio
import logging
import time
import urllib.parse
from collections import defaultdict
from dataclasses import dataclass, field
from contextvars import ContextVar
from typing import Optional

import httpx

from discovery.web_extract import extract_folder_ids
from discovery.network import GuardedClient

logger = logging.getLogger("filester.web_sources")

UA = "FilesterPublicIndexer/6.0 (+OSINT candidate acquisition; polite)"


@dataclass
class Hit:
    folder_id: str
    source_name: str
    source_url: str
    query_class: str
    query: str
    external_ts: str = ""  # historical timestamp if any


@dataclass
class QueryStats:
    source: str
    query_class: str
    requests: int = 0
    status_codes: list = field(default_factory=list)
    result_rows: int = 0
    candidate_ids: int = 0
    unique_ids: set = field(default_factory=set)
    health: str = "ok"  # ok | no_matches | blocked | unavailable | parse_error


class SourceHealth:
    def __init__(self) -> None:
        self.by_query: dict[tuple[str, str], QueryStats] = {}

    def stats(self, source: str, qclass: str) -> QueryStats:
        k = (source, qclass)
        if k not in self.by_query:
            self.by_query[k] = QueryStats(source=source, query_class=qclass)
        return self.by_query[k]

    def summary(self) -> list[dict]:
        rows = []
        for (src, qc), st in sorted(self.by_query.items()):
            rows.append({
                "source": src,
                "query_class": qc,
                "requests": st.requests,
                "candidates": len(st.unique_ids),
                "result_rows": st.result_rows,
                "health": st.health,
                "status_codes": st.status_codes[-5:],
            })
        return rows


HEALTH = SourceHealth()
PARTIAL: ContextVar[list | None] = ContextVar("collector_partial", default=None)


async def _get(client: httpx.AsyncClient, url: str) -> tuple[int, str]:
    try:
        import os
        headers={}
        if urllib.parse.urlsplit(url).hostname=="urlscan.io" and os.getenv("URLSCAN_API_KEY"):
            headers["API-Key"]=os.environ["URLSCAN_API_KEY"]
        r = await client.get(url, follow_redirects=True,headers=headers)
        return r.status_code, r.text or ""
    except Exception as e:
        logger.warning("fetch_fail url=%s err=%s", url[:120], e)
        return 0, ""


def _record(source: str, qclass: str, st: int, body: str, ids: list[str], source_url: str = "", query: str = "") -> None:
    qs = HEALTH.stats(source, qclass)
    qs.requests += 1
    qs.status_codes.append(st)
    qs.candidate_ids += len(ids)
    qs.unique_ids.update(ids)
    partial=PARTIAL.get()
    if partial is not None and st==200:
        partial.extend(Hit(fid,source,source_url,qclass,query or qclass) for fid in ids)
    if st == 0 or st >= 500:
        qs.health = "unavailable"
    elif st in (401, 403, 429):
        qs.health = "blocked"
    elif st == 200 and not ids:
        if "captcha" in (body or "").lower() or "challenge" in (body or "").lower()[:2000]:
            qs.health = "blocked"
        else:
            qs.health = "no_matches"
    elif st in (200, 202) and ids:
        qs.health = "ok"
        qs.result_rows += body.count("/f/") if body else 0


# ---- urlscan (primary; supports pagination) ----
async def collect_urlscan(client: httpx.AsyncClient, limit: int = 500) -> list[Hit]:
    hits: list[Hit] = []
    # Exact .me page and task-domain queries have produced the useful
    # results in live probes.  Exhaust them before spending requests on mirrors.
    queries = [
        ("domain_page", "page.domain:filester.me"),
        ("domain", "domain:filester.me"),
        ("domain_task", "task.domain:filester.me"),
        ("domain_page_si", "page.domain:filester.si"),
        ("domain_page_gg", "page.domain:filester.gg"),
        ("domain_page_sh", "page.domain:filester.sh"),
        ("domain_si", "domain:filester.si"),
    ]
    seen_fid: set[str] = set()

    for qclass, q in queries:
        search_after = None
        seen_cursors = set()
        pages = 0
        while len(seen_fid) < limit and pages < 15:
            params = f"q={urllib.parse.quote(q)}&size=100"
            if search_after:
                params += f"&search_after={search_after[0]},{search_after[1]}"
            url = f"https://urlscan.io/api/v1/search/?{params}"
            st, body = await _get(client, url)
            ids = extract_folder_ids(body)
            _record("urlscan", qclass, st, body, ids,url,q)
            if st != 200:
                break
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                HEALTH.stats("urlscan", qclass).health = "parse_error"
                break
            results = data.get("results") or []
            for fid in ids:
                if fid not in seen_fid:
                    seen_fid.add(fid)
                    hits.append(Hit(fid, "urlscan", url, qclass, q))
            pages += 1
            if len(results) < 100:
                break
            sort = results[-1].get("sort")
            if not sort or len(sort) < 2:
                break
            cursor = tuple(sort[:2])
            if cursor in seen_cursors:
                break
            seen_cursors.add(cursor)
            search_after = sort
            await asyncio_sleep(0.25)
    return hits


async def asyncio_sleep(s: float) -> None:
    import asyncio
    await asyncio.sleep(s)


# ---- Wayback CDX (historical) ----
async def collect_wayback(client: httpx.AsyncClient, limit: int = 500) -> list[Hit]:
    hits: list[Hit] = []
    hosts = [
        ("me", "filester.me/f/*"),
        ("sh", "filester.sh/f/*"),
        ("si", "filester.si/f/*"),
        ("gg", "filester.gg/f/*"),
    ]
    seen: set[str] = set()
    for qclass, pattern in hosts:
        if len(seen) >= limit:
            break
        qs = urllib.parse.urlencode({
            "url": pattern,
            "output": "json",
            "fl": "original,timestamp",
            "collapse": "urlkey",
            "limit": str(min(200, limit)),
        })
        url = f"https://web.archive.org/cdx/search/cdx?{qs}"
        st, body = await _get(client, url)
        ids = extract_folder_ids(body)
        _record("wayback_cdx", qclass, st, body, ids,url,pattern)
        if st != 200:
            continue
        # pair timestamps roughly from lines
        for line in (body or "").splitlines():
            fids = extract_folder_ids(line)
            ts = ""
            parts = line.replace("[", "").replace("]", "").replace('"', "").split(",")
            if len(parts) >= 2 and parts[1].strip().isdigit():
                ts = parts[1].strip()
            for fid in fids:
                if fid in seen:
                    continue
                seen.add(fid)
                hits.append(Hit(fid, "wayback_cdx", url, qclass, pattern, external_ts=ts))
    return hits


# ---- Common Crawl CDX (historical index) ----
async def collect_commoncrawl(client: httpx.AsyncClient, limit: int = 500) -> list[Hit]:
    hits: list[Hit] = []
    # recent indexes; health-tracked if unreachable
    indexes = [
        "CC-MAIN-2025-08",
        "CC-MAIN-2024-51",
        "CC-MAIN-2024-33",
        "CC-MAIN-2024-10",
    ]
    seen: set[str] = set()
    for idx in indexes:
        if len(seen) >= limit:
            break
        qs = urllib.parse.urlencode({
            "url": "filester.me/f/*",
            "output": "json",
            "limit": str(min(100, limit)),
        })
        url = f"https://index.commoncrawl.org/{idx}-index?{qs}"
        st, body = await _get(client, url)
        ids = extract_folder_ids(body)
        _record("commoncrawl", idx, st, body, ids,url,"filester.me/f/*")
        if st != 200:
            continue
        for fid in ids:
            if fid in seen:
                continue
            seen.add(fid)
            hits.append(Hit(fid, "commoncrawl", url, idx, "filester.me/f/*"))
        # also try mirrors once per index
        for host, qc in [("filester.sh/f/*", f"{idx}_sh"), ("filester.si/f/*", f"{idx}_si")]:
            qs2 = urllib.parse.urlencode({"url": host, "output": "json", "limit": "50"})
            url2 = f"https://index.commoncrawl.org/{idx}-index?{qs2}"
            st2, body2 = await _get(client, url2)
            ids2 = extract_folder_ids(body2)
            _record("commoncrawl", qc, st2, body2, ids2,url2,host)
            for fid in ids2:
                if fid not in seen:
                    seen.add(fid)
                    hits.append(Hit(fid, "commoncrawl", url2, qc, host))
    return hits


# ---- DuckDuckGo HTML ----
def _planned_queries(planned, defaults):
    """Keep the rotator's exact expressions first, then generic coverage.

    None preserves legacy caller ordering. An explicit plan replaces keyword
    expansion; source-native archive/domain queries never use this helper.
    """
    families = defaults if planned is None else [(f"planned_{keyword}", query) for keyword, query in planned] + defaults
    seen = set()
    result = []
    for query_class, query in families:
        if query and query not in seen:
            seen.add(query)
            result.append((query_class, query))
    return result


async def collect_ddg(client: httpx.AsyncClient, limit: int = 100, keywords: list[str] | None = None, queries: list[tuple[str, str]] | None = None) -> list[Hit]:
    hits: list[Hit] = []
    query_families = [
        ("quoted_path", '"filester.me/f/"'),
        ("quoted_https", '"https://filester.me/f/"'),
        ("path_mp4", "filester.me/f/ mp4"),
        ("path_files", "filester.me/f/ files"),
        ("mirror_sh", '"filester.sh/f/"'),
        ("mirror_si", '"filester.si/f/"'),
        ("mirror_gg", '"filester.gg/f/"'),
        ("site_f", "site:filester.me /f/"),
    ]
    if keywords and queries is None:
        for kw in keywords[:12]:
            query_families.append((f"kw_{kw}", f'"filester.me/f/" {kw}'))
            query_families.append((f"site_kw_{kw}", f"site:filester.me/f {kw}"))

    seen: set[str] = set()
    for qclass, q in _planned_queries(queries, query_families):
        if len(seen) >= limit:
            break
        url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(q)
        st, body = await _get(client, url)
        ids = extract_folder_ids(body)
        _record("duckduckgo_html", qclass, st, body, ids,url,q)
        for fid in ids:
            if fid not in seen:
                seen.add(fid)
                hits.append(Hit(fid, "duckduckgo_html", url, qclass, q))
    return hits


# ---- Bing HTML ----
async def collect_bing(client: httpx.AsyncClient, limit: int = 50, keywords: list[str] | None = None, queries: list[tuple[str, str]] | None = None) -> list[Hit]:
    hits: list[Hit] = []
    query_families = [
        ("quoted_path", '"filester.me/f/"'),
        ("bare_path", "filester.me/f/"),
        ("mirror_sh", '"filester.sh/f/"'),
        ("inurl", "inurl:filester.me/f"),
    ]
    if keywords and queries is None:
        for kw in keywords[:12]:
            query_families.extend([(f"site_kw_{kw}", f"site:filester.me/f {kw}"),
                                   (f"kw_{kw}", f'"filester.me/f/" {kw}')])
    seen: set[str] = set()
    for qclass, q in _planned_queries(queries, query_families):
        if len(seen) >= limit:
            break
        url = "https://www.bing.com/search?q=" + urllib.parse.quote(q) + "&count=30"
        st, body = await _get(client, url)
        ids = extract_folder_ids(body)
        _record("bing_html", qclass, st, body, ids,url,q)
        for fid in ids:
            if fid not in seen:
                seen.add(fid)
                hits.append(Hit(fid, "bing_html", url, qclass, q))
    return hits



# ---- Brave Search (API preferred; HTML best-effort) ----
async def collect_brave(client: httpx.AsyncClient, limit: int = 200, keywords: list[str] | None = None, queries: list[tuple[str, str]] | None = None) -> list[Hit]:
    import os
    hits: list[Hit] = []
    kws = keywords or []
    # bootstrap keywords if none
    if not kws:
        from discovery.keywords import DEFAULT_KEYWORDS
        kws = DEFAULT_KEYWORDS[:8]

    api_key = os.environ.get("BRAVE_API_KEY") or os.environ.get("BRAVE_SEARCH_API_KEY")
    seen: set[str] = set()

    query_families = []
    for kw in kws if queries is None else []:
        query_families.append((f"site_kw_{kw}", f"site:filester.me/f {kw}"))
        query_families.append((f"quoted_kw_{kw}", f'"filester.me/f/" {kw}'))
    # pattern-only families
    query_families.extend([
        ("quoted_path", '"filester.me/f/"'),
        ("mirror_sh", '"filester.sh/f/"'),
        ("mirror_si", '"filester.si/f/"'),
        ("mirror_gg", '"filester.gg/f/"'),
    ])

    for qclass, q in _planned_queries(queries, query_families):
        if len(seen) >= limit:
            break
        if api_key:
            url = (
                "https://api.search.brave.com/res/v1/web/search?"
                + urllib.parse.urlencode({"q": q, "count": 20})
            )
            try:
                r = await client.get(
                    url,
                    headers={
                        "X-Subscription-Token": api_key,
                        "Accept": "application/json",
                    },
                )
                st, body = r.status_code, r.text or ""
            except Exception as e:
                st, body = 0, ""
            source_name = "brave_api"
        else:
            url = "https://search.brave.com/search?q=" + urllib.parse.quote(q)
            st, body = await _get(client, url)
            source_name = "brave_html"

        ids = extract_folder_ids(body)
        _record(source_name, qclass, st, body, ids,url,q)
        # keyword tracker
        try:
            from discovery.keywords import KEYWORDS
            for kw in kws:
                if kw in q:
                    KEYWORDS.record_query(kw, ids)
        except Exception:
            pass
        for fid in ids:
            if fid not in seen:
                seen.add(fid)
                hits.append(Hit(fid, source_name, url, qclass, q))
        await asyncio_sleep(0.3)
    return hits


# Curated public reference pages are intentionally bounded and non-recursive.
# Add a page only after measuring useful unique-folder yield; do not turn this
# into a general web crawler.
PUBLIC_HUB_PAGES = (
    "https://text.is/2024LinksList",
)


async def collect_public_hubs(client: httpx.AsyncClient, limit: int = 500) -> list[Hit]:
    hits: list[Hit] = []
    seen: set[str] = set()
    for index, url in enumerate(PUBLIC_HUB_PAGES):
        if len(seen) >= limit:
            break
        qclass = f"curated_reference_{index + 1}"
        status, body = await _get(client, url)
        ids = extract_folder_ids(body)
        _record("public_hubs", qclass, status, body, ids, url, url)
        if status != 200:
            continue
        for fid in ids:
            if fid not in seen and len(seen) < limit:
                seen.add(fid)
                hits.append(Hit(fid, "public_hubs", url, qclass, url))
    return hits



COLLECTORS = {
    "public_hubs": collect_public_hubs,
    "brave": collect_brave,
    "brave_search": collect_brave,

    "urlscan": collect_urlscan,
    "wayback": collect_wayback,
    "archive": collect_wayback,  # alias
    "commoncrawl": collect_commoncrawl,
    "duckduckgo_html": collect_ddg,
    "bing_html": collect_bing,
}


async def run_collectors(
    sources: Optional[list[str]] = None,
    per_source_limit: int = 500,
    keywords: Optional[list[str]] = None,
    on_source=None,
    source_timeout: float = 20.0,
    max_requests: int | None = None,
    metrics: dict | None = None,
    queries: list[tuple[str, str]] | None = None,
) -> list[Hit]:
    # reset health for this run
    global HEALTH
    HEALTH = SourceHealth()

    names = sources or ["urlscan", "wayback", "commoncrawl", "brave", "duckduckgo_html", "bing_html"]
    aliases = {"archive": "wayback", "brave_search": "brave"}
    names = list(dict.fromkeys(aliases.get(name, name) for name in names))
    all_hits: list[Hit] = []
    async with GuardedClient(
        headers={"User-Agent": UA, "Accept": "application/json,text/html,*/*"},
        ttl=1800,
        max_requests=max_requests,
    ) as client:
        async def collect(name):
            fn = COLLECTORS.get(name)
            if not fn:
                logger.warning("unknown source %s", name)
                return []
            started=time.perf_counter()
            outcome="completed"
            partial=[]
            token=PARTIAL.set(partial)
            try:
                import inspect
                sig = inspect.signature(fn)
                kwargs = {"limit": per_source_limit}
                if "keywords" in sig.parameters:
                    kwargs["keywords"] = keywords
                if "queries" in sig.parameters:
                    kwargs["queries"] = queries
                async with asyncio.timeout(source_timeout):
                    part = await fn(client, **kwargs)
            except Exception as e:
                logger.warning("collector %s failed: %s", name, e)
                outcome="timeout" if isinstance(e,TimeoutError) else "failed"
                part=list({hit.folder_id:hit for hit in partial}.values())[:per_source_limit]
            finally:
                PARTIAL.reset(token)
            uniq = len({h.folder_id for h in part})
            if outcome=="completed" and not part:
                aliases={"wayback":"wayback_cdx","archive":"wayback_cdx","brave":"brave_html","brave_search":"brave_html"}
                labels={name,aliases.get(name,name)}
                if name.startswith("brave"): labels.add("brave_api")
                if any(st.health in ("unavailable","blocked") for (src,qc),st in HEALTH.by_query.items() if src in labels):
                    outcome="unavailable"
            logger.info("collector=%s hits=%s unique=%s", name, len(part), uniq)
            if on_source:
                await on_source(name,part,{"status":outcome,"seconds":round(time.perf_counter()-started,2),"hits":len(part)})
            return part
        # Different origins can proceed together; every origin retains its own guard.
        tasks=[asyncio.create_task(collect(name)) for name in dict.fromkeys(names)]
        try:
            for part in await asyncio.gather(*tasks): all_hits.extend(part)
        finally:
            for task in tasks:
                if not task.done(): task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
            if metrics is not None:
                metrics["network_requests"] = client.network_requests
    return all_hits
