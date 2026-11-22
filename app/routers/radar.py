"""
Nexus Radar — library-aware browsing API.

The browser extension batches the video URLs visible on a page and asks
"which of these do I already have?". Answers come from an in-memory index
(rebuilt at most every 60 s) over Video.source_url/url and DiscoveredVideo,
so a lookup of hundreds of URLs costs microseconds.

Statuses:
    library     — already imported into the main library
    discovered  — sitting in the discovery review queue (not yet imported)
    unknown     — new to the system
"""
import asyncio
import threading
import time
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlsplit

from fastapi import APIRouter
from pydantic import BaseModel

from ..database import DiscoveredVideo, SessionLocal, Video
from ..url_utils import normalize_url_key

router = APIRouter(prefix="/api/v1/radar", tags=["radar"])

INDEX_TTL = 60.0
MAX_URLS_PER_REQUEST = 500
MAX_COLLECTOR_METADATA_FETCH = 12
FILESTER_FOLDER_PATH_RE = re.compile(r"^/f/([a-z0-9_-]+)$", re.IGNORECASE)
_collector_lock = threading.Lock()
_filester_collector_urls: List[str] = []
_filester_collector_received_at: Optional[str] = None


def normalize_url(url: str) -> Optional[str]:
    """host+path+query, lowercased host, no scheme/www/fragment/trailing slash."""
    try:
        parts = urlsplit((url or "").strip())
    except ValueError:
        return None
    if not (parts.scheme and parts.netloc and parts.hostname):
        return None
    return normalize_url_key(url, lowercase_query=False)


def _strip_query(key: str) -> str:
    return key.split("?", 1)[0]


class _RadarIndex:
    def __init__(self):
        self._exact: Dict[str, Tuple[str, int, str]] = {}     # key -> (status, id, title)
        self._no_query: Dict[str, Tuple[str, int, str]] = {}  # query-less fallback
        self._built_at = 0.0
        self._lock = threading.Lock()

    def _add(self, url: str, status: str, entity_id: int, title: str):
        key = normalize_url(url)
        if not key:
            return
        # library entries always win over discovered ones
        if status == "library" or key not in self._exact:
            self._exact[key] = (status, entity_id, title)
        nq = _strip_query(key)
        if status == "library" or nq not in self._no_query:
            self._no_query[nq] = (status, entity_id, title)

    def _rebuild(self):
        exact, no_query = self._exact, self._no_query
        self._exact, self._no_query = {}, {}
        db = SessionLocal()
        try:
            for vid, source_url, url, title in db.query(
                Video.id, Video.source_url, Video.url, Video.title
            ).yield_per(1000):
                if source_url:
                    self._add(source_url, "library", vid, title or "")
                if url:
                    self._add(url, "library", vid, title or "")
            for did, url, source_url, title, imported in db.query(
                DiscoveredVideo.id, DiscoveredVideo.url, DiscoveredVideo.source_url,
                DiscoveredVideo.title, DiscoveredVideo.imported
            ).yield_per(1000):
                status = "library" if imported else "discovered"
                if url:
                    self._add(url, status, did, title or "")
                if source_url:
                    self._add(source_url, status, did, title or "")
            self._built_at = time.monotonic()
        except Exception:
            # keep serving the previous index on rebuild failure
            self._exact, self._no_query = exact, no_query
            raise

    def lookup_many(self, urls: List[str]) -> Dict[str, dict]:
        with self._lock:
            if time.monotonic() - self._built_at > INDEX_TTL:
                self._rebuild()
            exact, no_query = self._exact, self._no_query

        results = {}
        for url in urls:
            key = normalize_url(url)
            hit = None
            if key:
                hit = exact.get(key) or no_query.get(_strip_query(key))
            if hit:
                status, entity_id, title = hit
                results[url] = {"status": status, "id": entity_id, "title": title}
            else:
                results[url] = {"status": "unknown"}
        return results


_index = _RadarIndex()


class RadarCheckRequest(BaseModel):
    urls: List[str]


class FilesterCollectorRequest(BaseModel):
    urls: List[str]


class FilesterKeywordSearchRequest(FilesterCollectorRequest):
    keyword: str


def canonical_filester_folder_url(url: str) -> Optional[str]:
    """Accept only a public Filester folder address and remove its page/query."""
    try:
        parts = urlsplit((url or "").strip())
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if host not in {
        "filester.me", "www.filester.me", "filester.gg", "www.filester.gg",
        "filester.net", "www.filester.net", "filester.co", "www.filester.co",
        "filester.org", "www.filester.org", "filester.io", "www.filester.io",
    }:
        return None
    match = FILESTER_FOLDER_PATH_RE.fullmatch(parts.path or "")
    return f"https://filester.me/f/{match.group(1)}" if match else None


@router.post("/check")
def radar_check(req: RadarCheckRequest):
    """Batch lookup: which of these URLs are already in the library/queue?"""
    urls = [u for u in req.urls if isinstance(u, str) and u.strip()][:MAX_URLS_PER_REQUEST]
    results = _index.lookup_many(urls)
    summary = {"library": 0, "discovered": 0, "unknown": 0}
    for r in results.values():
        summary[r["status"]] = summary.get(r["status"], 0) + 1
    return {"results": results, "summary": summary}


@router.post("/refresh")
def radar_refresh():
    """Force the index to rebuild on next lookup (e.g. after an import)."""
    _index._built_at = 0.0
    return {"success": True}


@router.post("/collector/filester")
def collector_filester_push(req: FilesterCollectorRequest):
    """Receive a short, review-only Filester folder list from the Yandex userscript."""
    urls: List[str] = []
    seen = set()
    for raw_url in req.urls[:MAX_URLS_PER_REQUEST]:
        if not isinstance(raw_url, str):
            continue
        url = canonical_filester_folder_url(raw_url)
        if url and url not in seen:
            seen.add(url)
            urls.append(url)
    global _filester_collector_received_at
    with _collector_lock:
        _filester_collector_urls[:] = urls
        _filester_collector_received_at = datetime.now(timezone.utc).isoformat()
    return {"count": len(urls), "urls": urls, "received_at": _filester_collector_received_at}


@router.get("/collector/filester")
def collector_filester_latest():
    """Return the latest local Collector handoff; Radar decides what to select/import."""
    with _collector_lock:
        urls = list(_filester_collector_urls)
        received_at = _filester_collector_received_at
    return {"count": len(urls), "urls": urls, "received_at": received_at}


@router.post("/collector/filester/fetch")
async def collector_filester_fetch_metadata(req: FilesterCollectorRequest):
    """Fast, review-only first-page metadata probe for selected public folders."""
    urls: List[str] = []
    seen = set()
    for raw_url in req.urls[:MAX_COLLECTOR_METADATA_FETCH]:
        if not isinstance(raw_url, str):
            continue
        url = canonical_filester_folder_url(raw_url)
        if url and url not in seen:
            seen.add(url)
            urls.append(url)

    from ..extractors.filester import FilesterExtractor
    semaphore = asyncio.Semaphore(2)

    async def probe(url: str) -> dict:
        async with semaphore:
            return await FilesterExtractor().probe_folder_metadata(url)

    items = await asyncio.gather(*(probe(url) for url in urls))
    return {
        "requested": len(urls),
        "limit": MAX_COLLECTOR_METADATA_FETCH,
        "items": items,
    }


@router.post("/collector/filester/search")
async def collector_filester_search_keyword(req: FilesterKeywordSearchRequest):
    """Review-only keyword search through file names in selected public folders."""
    keyword = " ".join((req.keyword or "").split())
    if not keyword:
        return {"requested": 0, "limit": MAX_COLLECTOR_METADATA_FETCH, "items": []}

    urls: List[str] = []
    seen = set()
    for raw_url in req.urls[:MAX_COLLECTOR_METADATA_FETCH]:
        if not isinstance(raw_url, str):
            continue
        url = canonical_filester_folder_url(raw_url)
        if url and url not in seen:
            seen.add(url)
            urls.append(url)

    from ..extractors.filester import FilesterExtractor
    semaphore = asyncio.Semaphore(2)

    async def search(url: str) -> dict:
        async with semaphore:
            return await FilesterExtractor().search_folder_keyword(url, keyword)

    items = await asyncio.gather(*(search(url) for url in urls))
    return {"requested": len(urls), "limit": MAX_COLLECTOR_METADATA_FETCH, "items": items}
