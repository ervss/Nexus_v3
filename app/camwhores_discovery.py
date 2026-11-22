"""
Camwhores Discovery Module
Smart discovery, deep metadata crawling, and active size probing for Camwhores.tv videos.
"""
import asyncio
import httpx
import re
import logging
import requests
from bs4 import BeautifulSoup
from typing import List, Dict, Any, Optional
from urllib.parse import urljoin, quote
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import os
import sys
import datetime as dt

# Ensure parent directory is in path to import from app extractors
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.extractors.camwhores import CamwhoresExtractor, normalize_camwhores_get_file_rnd
from app.mp4_probe import probe_mp4_cached

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _cw_detail_taxonomy(soup):
    info = soup.select_one('#tab_video_info')
    if not info:
        return None
    def names(kind):
        return list(dict.fromkeys(a.get_text(' ', strip=True) for a in info.select(f'a[href*="/{kind}/"]') if a.get_text(' ', strip=True)))
    submitted = info.find(string=re.compile(r'^\s*Submitted\s*:\s*$', re.I))
    added = submitted.parent.find('em').get_text(' ', strip=True) if submitted and submitted.parent and submitted.parent.find('em') else ''
    user = info.select_one('.username a[href*="/members/"]')
    return {'tags': names('tags'), 'categories': names('categories'), 'models': names('models'),
            'uploader': user.get_text(' ', strip=True) if user else '', 'added': added}


class CamwhoresSourceError(RuntimeError):
    """A source failure must never be presented as an empty search."""

    def __init__(self, message: str, code: str = "source_error", http_status: int = 0):
        super().__init__(message)
        self.code = code
        self.http_status = http_status


def _cw_http_error(status: int) -> CamwhoresSourceError:
    if status == 403:
        return CamwhoresSourceError("Camwhores odmietol prístup (HTTP 403). Over pripojenie a stav WARP.", "blocked", status)
    if status == 429:
        return CamwhoresSourceError("Camwhores dočasne obmedzil požiadavky (HTTP 429). Skús neskôr.", "rate_limited", status)
    return CamwhoresSourceError(f"Camwhores vrátil HTTP {status}.", "source_error", status)


def _cw_check_response_body(body: str) -> None:
    text = (body or "").lower()
    if any(token in text for token in ("cf-chl-", "just a moment...", "attention required!", "checking your browser")):
        raise CamwhoresSourceError("Camwhores vyžaduje overenie prístupu.", "blocked")
    if not text.strip():
        raise CamwhoresSourceError("Camwhores vrátil prázdnu odpoveď.", "parse_error")

# Watch-page metadata is stable. Keep successful reads across repeated gallery
# fetches in this server process; do not cache transient network failures.
_CW_DETAIL_CACHE: Dict[str, tuple[float, Dict[str, Any]]] = {}
_CW_DETAIL_CACHE_TTL = 3600.0

def _extract_labeled_value(soup: BeautifulSoup, labels: tuple[str, ...]) -> str:
    """Extracts a nearby value for metadata labels such as Added or Date."""
    label_re = re.compile(rf"\b({'|'.join(re.escape(label) for label in labels)})\b\s*:?", re.I)

    def clean_value(value: str) -> str:
        value = re.sub(r"\s+", " ", (value or "")).strip(" :-")
        if not value or len(value) > 80:
            return ""
        blocked = ("window.", "dataLayer", "function(", "gtag(", "{", "}", ";")
        if any(token in value for token in blocked):
            return ""
        return value

    for node in soup.find_all(string=label_re):
        if node.find_parent(["script", "style", "noscript", "svg"]):
            continue
        parent = node.parent
        if not parent:
            continue
        parent_text = parent.get_text(" ", strip=True)
        if len(parent_text) > 140:
            continue

        em = parent.find("em")
        if em:
            text = clean_value(em.get_text(" ", strip=True))
            if text:
                return text

        text = clean_value(label_re.sub("", parent_text, count=1))
        if text:
            return text

        sibling = parent.find_next_sibling()
        if sibling:
            text = clean_value(sibling.get_text(" ", strip=True))
            if text:
                return text

    return ""

def _normalize_relative_date(value: str) -> str:
    """
    Converts common relative dates to YYYY-MM-DD while preserving the original
    string when it cannot be interpreted reliably.
    """
    text = (value or "").strip()
    if not text:
        return ""

    low = text.lower()
    now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    if low in {"today", "just now"}:
        return now.strftime("%Y-%m-%d")
    if low == "yesterday":
        return (now - dt.timedelta(days=1)).strftime("%Y-%m-%d")

    m = re.search(r"(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago", low)
    if not m:
        return text

    amount = int(m.group(1))
    unit = m.group(2)
    days = {
        "minute": 0,
        "hour": 0,
        "day": amount,
        "week": amount * 7,
        "month": amount * 30,
        "year": amount * 365,
    }.get(unit, 0)
    if days <= 0:
        return now.strftime("%Y-%m-%d")
    return (now - dt.timedelta(days=days)).strftime("%Y-%m-%d")

def _probe_candidate_sync(url: str, referer: str, session: requests.Session) -> tuple[Optional[str], int]:
    """
    Probes a Camwhores get_file candidate URL using a fast 1-byte range request.
    Returns (working_url, size_in_bytes).
    """
    if not url:
        return None, 0
    try:
        probe_url = normalize_camwhores_get_file_rnd(url)
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": referer,
            "Range": "bytes=0-0"
        }
        # Disable SSL verification issues if any
        resp = session.get(probe_url, headers=headers, timeout=6, allow_redirects=True, verify=False)
        if resp.status_code in (200, 206):
            content_range = resp.headers.get("Content-Range")
            total_size = 0
            if content_range:
                # Format: bytes 0-0/1234567
                m = re.search(r'/(\d+)', content_range)
                if m:
                    total_size = int(m.group(1))
            if not total_size:
                total_size = int(resp.headers.get("Content-Length") or 0)
            return probe_url, total_size
    except Exception as e:
        logger.debug(f"[CAMWHORES_PROBE] Fast probe exception for {url}: {e}")
    return None, 0

def _extract_detail_metadata(video_url: str, session: requests.Session, fallback_item: Optional[Dict[str, Any]] = None, quick: bool = False) -> Optional[Dict[str, Any]]:
    """
    Worker function to fetch and scrape the detail page of a Camwhores video.
    Extracts tags, uploader name, candidate stream URLs, resolution, and probes size.
    If detail request fails or is rate-limited (HTTP 503/429), falls back to fallback_item data.
    """
    try:
        extractor = CamwhoresExtractor()
        headers = extractor._base_headers(referer="https://www.camwhores.tv/")
        
        # Fast execution without blocking sleep
        
        logger.info(f"[CAMWHORES_DISCOVERY] Crawling details page: {video_url}")
        resp = None
        for attempt in range(1 if quick else 3):
            try:
                resp = session.get(video_url, headers=headers, timeout=8 if quick else 15, verify=False)
                if resp.status_code == 200:
                    break
                elif resp.status_code in (429, 503, 502, 504):
                    logger.debug(f"[CAMWHORES_DISCOVERY] Retry {attempt+1} for {video_url} (HTTP {resp.status_code})")
                    time.sleep(1.0 * (attempt + 1))
            except Exception as req_err:
                logger.debug(f"[CAMWHORES_DISCOVERY] Req error on attempt {attempt+1}: {req_err}")
                time.sleep(0.5)

        if not resp or resp.status_code != 200:
            logger.warning(f"[CAMWHORES_DISCOVERY] Watch page {video_url} returned status {resp.status_code if resp else 'No response'} after retries.")
            if fallback_item:
                # Return safe fallback metadata so valid video is not discarded!
                return {
                    "title": fallback_item.get("title", "Camwhores Video"),
                    "url": video_url,
                    "source_url": video_url,
                    "thumbnail": fallback_item.get("thumbnail", ""),
                    "duration": fallback_item.get("duration", 0),
                    "tags": ["camwhores", "video"],
                    "uploader": "Camwhores",
                    "views": fallback_item.get("views", 0),
                    "added": fallback_item.get("added", ""),
                    "added_date": fallback_item.get("added_date", ""),
                    "upload_date": fallback_item.get("added_date", ""),
                    "date_added": fallback_item.get("added_date", ""),
                    "stream_url": video_url,
                    "resolution": 0,
                    "quality": "",
                    "size_bytes": 0,
                    "size_human": "-",
                    "source": "camwhores",
                    "categories": "",
                    "models": "",
                    "related_src": "",
                    "preview_mp4_url": "",
                }
            return None
            
        html = resp.text
        soup = BeautifulSoup(html, 'lxml')

        # Strict public-only gate: reject private/members-only pages immediately
        _html_lower = html.lower()
        _PRIVATE_SIGNALS = (
            'class="private"', "class='private'",
            'video-private', 'video_private',
            'members only', 'members-only',
            'this video is private',
            'private video',
            'login to watch',
            'sign up to watch',
            'upgrade to watch',
            'locked video',
        )
        if any(sig in _html_lower for sig in _PRIVATE_SIGNALS):
            logger.info(f"[CAMWHORES_DISCOVERY] Skipping private/locked video (HTML signal): {video_url}")
            return None

        # 1. Title Extraction
        title = extractor._extract_title(html, fallback="Camwhores Video")
        
        # 2. Thumbnail Extraction
        thumbnail = extractor._extract_thumbnail(html)
        
        # 3. Duration Extraction
        duration = extractor._extract_duration(html)
        if duration == 0:
            # Fallback for Duration in <span>Duration: <em>MM:SS</em></span>
            duration_span = None
            for s in soup.find_all('span'):
                txt = s.get_text()
                if txt and 'Duration:' in txt:
                    duration_span = s
                    break
            if duration_span:
                em = duration_span.find('em')
                if em:
                    dur_str = em.get_text(strip=True)
                    parts = dur_str.split(':')
                    try:
                        if len(parts) == 2:
                            duration = int(parts[0]) * 60 + int(parts[1])
                        elif len(parts) == 3:
                            duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                    except ValueError:
                        pass

        # 3.5 Views Extraction
        views = 0
        views_span = None
        for s in soup.find_all('span'):
            txt = s.get_text()
            if txt and 'Views:' in txt:
                views_span = s
                break
        if views_span:
            em = views_span.find('em')
            if em:
                try:
                    views = int(re.sub(r'[^\d]', '', em.get_text(strip=True)))
                except ValueError:
                    pass

        taxonomy = _cw_detail_taxonomy(soup)
        added_text = (taxonomy or {}).get('added', '')
        added_date = added_text if re.fullmatch(r'\d{4}-\d{2}-\d{2}', added_text or '') else ''
        if not added_date and fallback_item:
            added_date = fallback_item.get("added_date") or ""
            added_text = added_text or fallback_item.get("added") or ""
        
        # 4. Tags Extraction
        tags = []
        for a in (soup.select_one('#tab_video_info') or soup).find_all('a', href=True):
            if '/tags/' in a['href'] or '/tag/' in a['href']:
                tag_text = a.get_text(strip=True)
                if tag_text and tag_text not in tags:
                    tags.append(tag_text)
                    
        # 5. Uploader Extraction
        uploader = "Anonymous"
        
        # Method A: Look inside div.username
        username_div = soup.select_one('div.username')
        if username_div:
            a_link = username_div.find('a')
            if a_link and a_link.get_text(strip=True):
                uploader = a_link.get_text(strip=True)
                
        # Method B: Find 'Submitted by:' text node
        if uploader == "Anonymous":
            submitted_node = soup.find(string=re.compile(r'Submitted by:', re.I))
            if submitted_node:
                parent = submitted_node.parent
                a_link = parent.find('a')
                if a_link:
                    uploader = a_link.get_text(strip=True)
                else:
                    # Check next sibling
                    sibling = parent.find_next_sibling()
                    if sibling:
                        a_link = sibling.find('a') if sibling.name != 'a' else sibling
                        if a_link:
                            uploader = a_link.get_text(strip=True)
        
        # Method C: Look for a link containing /members/ or /models/ with a username/ID (not just generic directory)
        if uploader == "Anonymous":
            for a in soup.find_all('a', href=True):
                href = a['href']
                parts = [p for p in href.split('/') if p]
                
                # Check for /members/<user>
                if 'members' in parts:
                    try:
                        idx = parts.index('members')
                        if idx < len(parts) - 1:
                            val = parts[idx + 1]
                            if val and val.lower() not in ('community', 'members', 'models', 'login', 'signup'):
                                text = a.get_text(strip=True)
                                if text and text.lower() not in ('community', 'members', 'models', 'login', 'signup'):
                                    uploader = text
                                    break
                    except ValueError:
                        pass
                        
                # Check for /models/<user>
                elif 'models' in parts:
                    try:
                        idx = parts.index('models')
                        if idx < len(parts) - 1:
                            val = parts[idx + 1]
                            if val and val.lower() not in ('community', 'members', 'models', 'login', 'signup'):
                                text = a.get_text(strip=True)
                                if text and text.lower() not in ('community', 'members', 'models', 'login', 'signup'):
                                    uploader = text
                                    break
                    except ValueError:
                        pass
                    
        # Fallback to first word of title if still anonymous (models often put their name first)
        if uploader == "Anonymous" and title:
            words = title.split()
            if words and len(words[0]) >= 3 and not words[0].lower() in ('webcam', 'cam', 'stream', 'recording', 'private', 'public'):
                uploader = words[0]
                
        # 6. Stream URL Extraction & Probing
        candidates = extractor._extract_candidates_from_html(html)
        flashvars = extractor._parse_flashvars(html)
        for key in ("video_url_urhd", "video_url_hd", "video_url", "video_url_sd"):
            raw = flashvars.get(key)
            if raw:
                candidate = extractor._sanitize_url(raw)
                if candidate.startswith("http") and "get_file" in candidate and candidate not in candidates:
                    candidates.append(candidate)
        candidates.sort(key=extractor._infer_height_from_url, reverse=True)
        if not candidates and not duration and not soup.select_one('input[name="video_id"]'):
            return {**fallback_item, "url": video_url, "enriched": False} if fallback_item else None

        # Hard gate: no get_file candidates means the video is private or inaccessible
        if not candidates:
            logger.info(f"[CAMWHORES_DISCOVERY] No stream candidates (private/inaccessible): {video_url}")
            return None

        stream_url = None
        exact_size_bytes = 0
        resolution = 0
        quality_str = "SD"

        # Probe candidates to find working stream URL and exact size
        for candidate in candidates[:3]:  # Try up to 3 candidates
            working_url, size_bytes = _probe_candidate_sync(candidate, video_url, session)
            if working_url:
                stream_url = working_url
                exact_size_bytes = size_bytes
                resolution = extractor._infer_height_from_url(working_url)
                break
                
        # Fallback if probing yielded no results
        if not stream_url and candidates:
            stream_url = normalize_camwhores_get_file_rnd(candidates[0])
            resolution = extractor._infer_height_from_url(stream_url)
            
        # Refine resolution from flashvars/HTML heuristics if still 0
        if resolution == 0:
            if 'video_url_urhd' in html:
                resolution = 1080
            elif 'video_url_hd' in html:
                resolution = 720
                
        # Set quality string based on resolution
        if resolution >= 2160:
            quality_str = "4K"
        elif resolution >= 1080:
            quality_str = "1080p"
        elif resolution >= 720:
            quality_str = "720p"
        elif resolution >= 480:
            quality_str = "480p"
        else:
            quality_str = "HD" if resolution > 0 else "SD"
            
        # Estimate size if probing failed to get content-length
        # Unknown size remains unknown; an estimate is not a verified stream size.
            
        size_human = f"{exact_size_bytes / (1024 * 1024):.1f} MB" if exact_size_bytes > 0 else "-"

        bitrate_kbps = 0
        bitrate_human = ""
        if exact_size_bytes > 0 and duration > 0:
            bitrate_kbps = int((exact_size_bytes * 8) / (duration * 1000))
            if bitrate_kbps >= 1000:
                bitrate_human = f"{bitrate_kbps / 1000:.1f} Mbps"
            else:
                bitrate_human = f"{bitrate_kbps} kbps"
        
        # Deep flashvars extraction
        flashvars = extractor._parse_flashvars(html)
        categories_str = ""
        models_str = ""
        related_src = ""
        preview_mp4_url = ""
        
        if flashvars:
            categories_str = flashvars.get("video_categories") or ""
            models_str = flashvars.get("video_models") or ""
            related_src = flashvars.get("related_src") or ""
            
            # Enrich tags
            fv_tags = [t.strip() for t in (flashvars.get("video_tags") or "").split(",") if t.strip()]
            for t in fv_tags:
                if t not in tags:
                    tags.append(t)
            
            # Preview MP4 video URL (only if a real video trailer is explicitly provided)
            raw_trailer = flashvars.get("trailer_url") or flashvars.get("preview_video_url") or flashvars.get("video_alt_url") or ""
            if raw_trailer and ".mp4" in raw_trailer.lower():
                preview_mp4_url = raw_trailer
                
            # NOTE: preview_height1 is the thumbnail/screenshot height, NOT video resolution.
            # Do not use it as resolution — it would incorrectly filter out valid videos.
        
        if taxonomy is not None:
            tags = taxonomy['tags']
            categories_str = ', '.join(taxonomy['categories'])
            models_str = ', '.join(taxonomy['models'])
            uploader = taxonomy['uploader'] or 'Anonymous'
        else:
            tags, categories_str, models_str, uploader = [], '', '', 'Anonymous'
        return {
            "title": title,
            "url": video_url,
            "source_url": video_url,
            "thumbnail": thumbnail,
            "duration": duration,
            "tags": tags,
            "uploader": uploader,
            "views": views,
            "added": added_text,
            "taxonomy_verified": taxonomy is not None,
            "date_precision": "exact" if added_date else ("relative" if added_text else "unknown"),
            "added_date": added_date,
            "upload_date": added_date,
            "date_added": added_date,
            "stream_url": stream_url,
            "resolution": resolution,
            "quality": quality_str,
            "size_bytes": exact_size_bytes,
            "size_human": size_human,
            "bitrate_kbps": bitrate_kbps,
            "bitrate_human": bitrate_human,
            "source": "camwhores",
            "categories": categories_str,
            "models": models_str,
            "related_src": related_src,
            "preview_mp4_url": preview_mp4_url,
        }
    except Exception as e:
        logger.error(f"[CAMWHORES_DISCOVERY] Detail page extraction failed for {video_url}: {e}")
        return None

def _passes_filters(
    video: Dict[str, Any],
    min_quality: int,
    min_duration: int,
    max_duration: int,
    search_terms: str,
    auto_skip_low_quality: bool
) -> bool:
    """Checks if video passes search filter constraints."""
    if not video or not video.get("url"):
        return False
        
    resolution = video.get("resolution", 0)
    
    # 1. Quality Filter
    if auto_skip_low_quality and min_quality > 0:
        if resolution > 0 and resolution < min_quality:
            return False
            
    # 2. Duration Filters
    duration = video.get("duration", 0)
    if min_duration > 0 and duration < min_duration:
        return False
    if max_duration > 0 and duration > max_duration:
        return False
        
    # 3. Search Terms Filter (Title keyword filter)
    if search_terms:
        title = video.get("title", "").lower()
        terms = [t.strip().lower() for t in search_terms.split() if t.strip()]
        if terms and not all(term in title for term in terms):
            return False
            
    return True

def scrape_camwhores_discovery(
    keyword: str = "",
    min_quality: int = 720,
    min_duration: int = 0,
    max_duration: int = 0,
    search_terms: str = "",
    pages: int = 1,
    sort_by: str = "newest",
    only_public: bool = True,
    auto_skip_low_quality: bool = True,
    max_workers: int = 10,
    listing_only: bool = False,
    report: Optional[Dict[str, Any]] = None,
    search_mode: str = "auto",
) -> List[Dict[str, Any]]:
    """
    Queries Camwhores.tv, paginates listing pages, fetches details in a concurrent
    thread pool, applies filters, sorts results, and returns complete video metadata.
    """
    logger.info(f"[CAMWHORES_DISCOVERY] Starting Camwhores Smart Discovery: keyword='{keyword}', pages={pages}, sort_by='{sort_by}'")
    
    extractor = CamwhoresExtractor()
    headers = extractor._base_headers()

    # Map sort_by to CamWhores sort_by param
    # CamWhores search supports: latest, most_viewed, top_rated, longest
    _SORT_MAP = {
        "newest": "latest",
        "latest": "latest",
        "most_viewed": "most_viewed",
        "popularity": "most_viewed",
        "views": "most_viewed",
        "top_rated": "top_rated",
        "rating": "top_rated",
        "longest": "longest",
        "duration": "longest",
    }
    cw_sort = _SORT_MAP.get(sort_by, "latest")

    # CamWhores search pages hold 26 videos each (items per page = 26)
    ITEMS_PER_PAGE = 26

    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry

    session = requests.Session()
    retries = Retry(total=3, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504], allowed_methods=["GET", "HEAD"])
    adapter = HTTPAdapter(max_retries=retries, pool_connections=20, pool_maxsize=20)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update(headers)

    # Base URL for search or latest
    kw = keyword.strip() if keyword else ""
    mode = (search_mode or 'auto').lower()
    if mode == 'auto':
        mode = 'search' if kw else 'latest'
    if mode not in {'latest', 'search', 'tag', 'category', 'model', 'member'}:
        raise CamwhoresSourceError('Neznámy režim vyhľadávania.', 'invalid_query')
    if mode != 'latest' and not kw:
        raise CamwhoresSourceError('Zadaj hľadaný výraz.', 'invalid_query')
    if mode == 'member':
        member_match = re.fullmatch(r'\d+', kw) or re.search(r'^https?://(?:www\.)?camwhores\.tv/members/(\d+)(?:/|$)', kw, re.I)
        if not member_match:
            raise CamwhoresSourceError('Zadaj číselné ID člena alebo jeho Camwhores profil.', 'invalid_query')
        member_id = member_match.group(0) if kw.isdigit() else member_match.group(1)
        base_url = f'https://www.camwhores.tv/members/{member_id}/videos/'
        def _page_url(page_num: int) -> str:
            return base_url if page_num == 1 else f'{base_url}?from_videos={page_num}'
    elif mode in {'tag', 'category', 'model'}:
        slug = re.sub(r'[^a-z0-9]+', '-', kw.lower()).strip('-')
        if not slug:
            raise CamwhoresSourceError('Zadaj platný názov alebo slug.', 'invalid_query')
        prefix = {'tag':'tags', 'category':'categories', 'model':'models'}[mode]
        base_url = f'https://www.camwhores.tv/{prefix}/{slug}/'
        def _page_url(page_num: int) -> str:
            return base_url if page_num == 1 else f'{base_url}?from={page_num}'
    elif mode == 'search':
        # KVS search sort parameters
        _SEARCH_SORT_MAP = {
            "newest": "post_date",
            "latest": "post_date",
            "most_viewed": "video_viewed",
            "popularity": "video_viewed",
            "views": "video_viewed",
            "top_rated": "rating",
            "rating": "rating",
            "longest": "duration",
            "duration": "duration",
        }
        cw_search_sort = _SEARCH_SORT_MAP.get(sort_by, "post_date")

        # Fulltext search preserves the user's intent; tag/model browsing is separate.
        slug = quote(kw, safe="-_")
        base_url = f"https://www.camwhores.tv/search/{slug}/"
        def _page_url(page_num: int) -> str:
            if page_num == 1:
                return f"{base_url}?sort_by={cw_search_sort}"
            return f"{base_url}?sort_by={cw_search_sort}&from_videos={page_num}"
    else:
        # Latest / sorted browse
        if mode == 'latest' or cw_sort == "latest":
            base_url = "https://www.camwhores.tv/latest-updates/"
        elif cw_sort == "most_viewed":
            base_url = "https://www.camwhores.tv/most-popular/"
        elif cw_sort == "top_rated":
            base_url = "https://www.camwhores.tv/top-rated/"
        elif cw_sort == "longest":
            base_url = "https://www.camwhores.tv/longest/"
        else:
            base_url = "https://www.camwhores.tv/latest-updates/"
        def _page_url(page_num: int) -> str:
            if page_num == 1:
                return base_url
            return f"{base_url}?from={page_num}"

    discovered_urls = []
    seen_urls = set()
    successful_pages = 0
    failure = None
    if not 1 <= pages <= 20:
        raise CamwhoresSourceError("Počet strán musí byť medzi 1 a 20.", "invalid_query")
    if report is not None:
        report.update(pages_requested=pages, pages_scanned=0, status="ok", mode=mode, cards_scanned=0, public_count=0, private_count=0)

    # 1. Fetch search / listing pages to collect video watch URLs
    for page_num in range(1, pages + 1):
        try:
            page_url = _page_url(page_num)
                
            logger.info(f"[CAMWHORES_DISCOVERY] Fetching listing page {page_num}: {page_url}")
            resp = session.get(page_url, timeout=12)
            if resp.status_code != 200:
                logger.error(f"[CAMWHORES_DISCOVERY] Listing page {page_num} failed with status {resp.status_code}")
                failure = _cw_http_error(resp.status_code)
                break
            _cw_check_response_body(resp.text)
            successful_pages += 1
            if report is not None:
                report["pages_scanned"] = successful_pages
                
            soup = BeautifulSoup(resp.text, 'lxml')
            
            # Find item elements
            items = soup.select('.item')
            page_url_count = 0
            page_ids = set()
            for item in items:
                link = item if item.name == 'a' and item.get('href') else item.find('a', href=True)
                if not link:
                    continue
                href = link['href']
                full_url = href if href.startswith('http') else f"https://www.camwhores.tv{href}"
                video_match = re.search(r'/videos/(\d+)', full_url)
                if not video_match:
                    continue
                video_id = video_match.group(1)
                if video_id in page_ids:
                    continue
                page_ids.add(video_id)

                # Strict private detection — skip anything that looks locked/premium
                item_classes = " ".join(item.get("class", []))
                is_private = bool(
                    "private" in item_classes
                    or "locked" in item_classes
                    or bool(item.select(".lock, .private, .members-only, .premium"))
                )
                if report is not None:
                    report['cards_scanned'] += 1
                    report['private_count' if is_private else 'public_count'] += 1
                if video_id in seen_urls:
                    continue
                if only_public and is_private:
                    logger.debug(f"[CAMWHORES_DISCOVERY] Skipping private item on listing: {full_url}")
                    continue

                seen_urls.add(video_id)
                # Extract views and rating if listed on listing page (as initial info)
                views_val = 0
                rating_val = 0

                views_el = item.select_one('.views')
                if views_el:
                    try:
                        views_val = int(re.sub(r'[^\d]', '', views_el.get_text(strip=True)))
                    except:
                        pass

                rating_el = item.select_one('.rating')
                if rating_el:
                    try:
                        rating_val = int(re.sub(r'[^\d]', '', rating_el.get_text(strip=True)))
                    except:
                        pass

                added_text = ""
                added_el = item.select_one('.added em, .added, .date, .time')
                if added_el:
                    added_text = added_el.get_text(" ", strip=True)
                    added_text = re.sub(r"^(Added|Uploaded|Date|Published)\s*:?\s*", "", added_text, flags=re.I).strip()

                image = item.select_one('img')
                title_el = item.select_one('.title a, .title, .description, .video-title')
                title = (link.get('title') or (image.get('alt') if image else '')
                         or (title_el.get_text(' ', strip=True) if title_el else '')).strip()
                if not title:
                    title = full_url.rstrip('/').rsplit('/', 1)[-1].replace('-', ' ').strip().title()
                thumb = ((image.get('data-src') or image.get('data-original') or image.get('src') or '') if image else '').strip()
                if thumb.startswith('data:'):
                    thumb = ''
                duration_el = item.select_one('.duration, .durations, [class*="duration"]')
                duration_text = duration_el.get_text(' ', strip=True) if duration_el else ''
                duration_match = re.search(r'(?<!\d)(\d{1,3}):(\d{2})(?::(\d{2}))?', duration_text)
                duration = 0
                if duration_match:
                    parts = [int(part) for part in duration_match.groups() if part is not None]
                    duration = parts[0] * 3600 + parts[1] * 60 + parts[2] if len(parts) == 3 else parts[0] * 60 + parts[1]

                discovered_urls.append({
                    "url": full_url,
                    "video_id": video_id,
                    "discovery_mode": mode,
                    "discovery_query": kw,
                    "access_status": 'private' if is_private else 'public_listing',
                    "source_page": page_num,
                    "taxonomy_verified": False,
                    "source_url": full_url,
                    "title": title,
                    "thumbnail": urljoin('https://www.camwhores.tv/', thumb) if thumb else '',
                    "duration": duration,
                    "duration_known": bool(duration_match),
                    "resolution": 0,
                    "quality": "—",
                    "size_human": "—",
                    "uploader": "",
                    "enriched": False,
                    "views": views_val,
                    "rating": rating_val,
                    "added": added_text,
                    "added_date": added_text if re.fullmatch(r'\d{4}-\d{2}-\d{2}', added_text or '') else '',
                    "date_precision": 'exact' if re.fullmatch(r'\d{4}-\d{2}-\d{2}', added_text or '') else ('relative' if added_text else 'unknown'),
                    "_discovery_index": len(discovered_urls),
                })
                page_url_count += 1
            logger.info(f"[CAMWHORES_DISCOVERY] Collected {page_url_count} URLs from page {page_num}")
            if page_num > 1 and page_ids and page_ids == previous_page_ids:
                failure = CamwhoresSourceError('Zdroj vrátil opakovanú stránku.', 'pagination_error')
                break
            previous_page_ids = page_ids
        except CamwhoresSourceError as e:
            failure = e
            break
        except Exception as e:
            logger.error(f"[CAMWHORES_DISCOVERY] Error scraping listing page {page_num}: {e}")
            failure = CamwhoresSourceError("Camwhores sa nepodarilo načítať. Skontroluj pripojenie.", "network_error")
            break
            
    if not successful_pages:
        raise failure or CamwhoresSourceError("Camwhores nevrátil stránku výsledkov.")
    if failure and report is not None:
        report.update(status="partial", code=failure.code, message=str(failure))
    if not discovered_urls:
        logger.warning("[CAMWHORES_DISCOVERY] No video watch URLs discovered.")
        return []

    def _sort_discovery_items(items_list: List[Dict[str, Any]], criteria: str) -> None:
        def _date_and_id_key(x):
            raw_d = str(x.get("added_date") or x.get("upload_date") or x.get("date_added") or "").strip()
            d_val = raw_d if re.match(r"^\d{4}-\d{2}-\d{2}", raw_d) else ""
            m_id = re.search(r"/videos/(\d+)", str(x.get("url") or ""))
            vid_id = int(m_id.group(1)) if m_id else 0
            return (d_val, vid_id)

        if criteria == "rating":
            items_list.sort(key=lambda x: x.get("rating", 0) or 0, reverse=True)
        elif criteria in {"popularity", "views"}:
            items_list.sort(key=lambda x: x.get("views", 0) or 0, reverse=True)
        elif criteria == "duration":
            items_list.sort(key=lambda x: x.get("duration", 0) or 0, reverse=True)
        elif criteria == "bitrate":
            items_list.sort(key=lambda x: x.get("bitrate_kbps", 0) or 0, reverse=True)
        elif criteria in {"duration_asc", "duration_min"}:
            items_list.sort(key=lambda x: x.get("duration", 0) or 0, reverse=False)
        elif criteria in {"size", "size_desc"}:
            items_list.sort(key=lambda x: x.get("size_bytes", 0) or 0, reverse=True)
        elif criteria == "size_asc":
            items_list.sort(key=lambda x: x.get("size_bytes", 0) or 0, reverse=False)
        elif criteria == "oldest":
            items_list.sort(key=_date_and_id_key, reverse=False)
        else:  # Preserve the order returned by the source.
            items_list.sort(key=lambda x: x.get('_discovery_index', 0))

        for idx, item in enumerate(items_list):
            item["_discovery_index"] = idx

    if listing_only:
        _sort_discovery_items(discovered_urls, sort_by)
        return discovered_urls
        
    logger.info(f"[CAMWHORES_DISCOVERY] Discovered {len(discovered_urls)} video URLs. Running deep metadata extraction in concurrent pool...")
    
    # 2. Concurrently fetch and parse details page for all discovered videos
    video_details = []
    effective_workers = min(max(1, max_workers), 6)
    with ThreadPoolExecutor(max_workers=min(effective_workers, len(discovered_urls))) as executor:
        future_to_url = {
            executor.submit(_extract_detail_metadata, item["url"], session, item): item
            for item in discovered_urls
        }
        for future in as_completed(future_to_url):
            item = future_to_url[future]
            try:
                details = future.result()
                if details:
                    # Enrich details with views and ratings from the listing page if they were parsed
                    if item.get("views") and not details.get("views"):
                        details["views"] = item["views"]
                    if item.get("rating") and not details.get("rating"):
                        details["rating"] = item["rating"]
                    if item.get("added") and not details.get("added"):
                        details["added"] = item["added"]
                    if item.get("added_date") and not details.get("added_date"):
                        details["added_date"] = item["added_date"]
                        details["upload_date"] = item["added_date"]
                        details["date_added"] = item["added_date"]
                    details["_discovery_index"] = item.get("_discovery_index", len(video_details))
                    video_details.append(details)
            except Exception as e:
                logger.error(f"[CAMWHORES_DISCOVERY] Details extraction future threw exception: {e}")
                
    logger.info(f"[CAMWHORES_DISCOVERY] Successfully extracted details for {len(video_details)} videos.")
    
    # 3. Apply Filters
    filtered_videos = [
        v for v in video_details
        if _passes_filters(v, min_quality, min_duration, max_duration, search_terms, auto_skip_low_quality)
    ]
    logger.info(f"[CAMWHORES_DISCOVERY] {len(filtered_videos)} matching videos passed filters (Filtered out {len(video_details) - len(filtered_videos)}).")
    
    # 4. Apply Sorting
    _sort_discovery_items(filtered_videos, sort_by)
        
    return filtered_videos


def enrich_camwhores_discovery_item(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Best-effort detail pass for a card already returned from the search page."""
    with requests.Session() as session:
        details = _extract_detail_metadata(item["url"], session, quick=True)
    if not details:
        return None
    details["_discovery_index"] = item["_discovery_index"]
    for key in ("views", "rating", "added", "added_date"):
        if not details.get(key):
            details[key] = item.get(key)
    details["enriched"] = True
    details["duration_known"] = bool(details.get("duration"))
    return details


# ─────────────────────────────────────────────────────────────────────────────
# HUB  —  categories & models browse (Eporner-Hub-style landing for CamWhores)
# ─────────────────────────────────────────────────────────────────────────────

CW_BASE = "https://www.camwhores.tv"

# CamWhores category/model landing browse sorting. Note: these are BROWSE-type
# listings — page 2+ paginates via ?from=N (NOT ?from_videos=, which silently
# re-serves page 1). Live-verified 2026-07-14. See camwhores-pagination-split memory.
_HUB_SORT_MAP = {
    "newest": "post_date",
    "latest": "post_date",
    "recent": "post_date",
    "most_viewed": "video_viewed",
    "views": "video_viewed",
    "popularity": "video_viewed",
    "top_rated": "rating",
    "rating": "rating",
    "longest": "duration",
    "duration": "duration",
    # landing-only sorts (categories/models pages)
    "most_videos": "total_videos",
    "title": "title",
}


def _hub_session() -> requests.Session:
    extractor = CamwhoresExtractor()
    session = requests.Session()
    session.headers.update(extractor._base_headers())
    return session


def _parse_hub_cards(html: str, href_must_contain: str) -> List[Dict[str, Any]]:
    """
    Parse CamWhores category/model landing cards.

    On CamWhores the card IS the <a class="item"> element itself, e.g.
        <a class="item" href=".../categories/fansly/" title="Fansly">
          <img class="thumb" src="..."> <strong class="title">Fansly</strong>
          <div class="videos">8457 videos</div> <div class="rating positive">95%</div>
        </a>
    """
    soup = BeautifulSoup(html, "html.parser")
    results: List[Dict[str, Any]] = []
    seen: set = set()

    for card in soup.select("a.item, .item"):
        a = card if (card.name == "a" and card.get("href")) else card.find("a", href=True)
        if not a:
            continue
        href = a.get("href") or ""
        if href_must_contain not in href:
            continue
        url = href if href.startswith("http") else f"{CW_BASE}{href}"
        if url in seen:
            continue

        title_el = card.select_one("strong.title") or card.select_one(".title")
        title = (title_el.get_text(strip=True) if title_el else a.get("title", "")).strip()
        if not title:
            continue

        img = card.select_one("img.thumb") or card.find("img")
        thumbnail = ""
        if img:
            thumbnail = (img.get("data-original") or img.get("src") or "").strip()

        video_count = 0
        vc_el = card.select_one(".videos")
        if vc_el:
            m = re.search(r"([\d\s,]+)", vc_el.get_text())
            if m:
                try:
                    video_count = int(re.sub(r"[^\d]", "", m.group(1)))
                except ValueError:
                    pass

        rating = ""
        r_el = card.select_one(".rating")
        if r_el:
            rating = r_el.get_text(strip=True)

        # slug is the last path segment
        slug = ""
        seg = [p for p in href.split("/") if p]
        if seg:
            slug = seg[-1]

        seen.add(url)
        results.append({
            "title": title,
            "url": url,
            "slug": slug,
            "thumbnail": thumbnail,
            "video_count": video_count,
            "rating": rating,
        })

    return results


def _scrape_hub_landing(kind: str, sort_by: str, pages: int, max_results: int) -> List[Dict[str, Any]]:
    """Shared browser for /categories/ and /models/ landing pages."""
    assert kind in ("categories", "models")
    href_token = f"/{kind}/"
    sort_param = _HUB_SORT_MAP.get((sort_by or "").strip().lower(), "")
    base = f"{CW_BASE}/{kind}/"

    session = _hub_session()
    out: List[Dict[str, Any]] = []
    seen_urls: set = set()
    pages = max(1, pages)

    for page_num in range(1, pages + 1):
        # BROWSE pagination: ?from=N (page 1 = bare url). Re-append sort each page.
        params = []
        if sort_param:
            params.append(f"sort_by={sort_param}")
        if page_num > 1:
            params.append(f"from={page_num}")
        url = base + ("?" + "&".join(params) if params else "")

        try:
            logger.info(f"[CW_HUB] Fetching {kind} landing page {page_num}: {url}")
            resp = session.get(url, timeout=15, verify=False)
            if resp.status_code != 200:
                logger.warning(f"[CW_HUB] {kind} page {page_num} -> {resp.status_code}")
                break
            cards = _parse_hub_cards(resp.text, href_token)
            if not cards:
                break
            new = 0
            for c in cards:
                if c["url"] in seen_urls:
                    continue
                seen_urls.add(c["url"])
                out.append(c)
                new += 1
            logger.info(f"[CW_HUB] {kind} page {page_num}: +{new} (total={len(out)})")
            if new == 0:  # page repeated -> stop
                break
            if max_results and len(out) >= max_results:
                break
        except Exception as e:
            logger.error(f"[CW_HUB] Error on {kind} page {page_num}: {e}")
            break

    return out[:max_results] if max_results else out


def scrape_camwhores_categories(sort_by: str = "most_videos", pages: int = 1, max_results: int = 120) -> List[Dict[str, Any]]:
    """Browse CamWhores categories as Hub cards (title, thumb, video_count, rating, url)."""
    return _scrape_hub_landing("categories", sort_by, pages, max_results)


def scrape_camwhores_models(sort_by: str = "most_viewed", pages: int = 1, max_results: int = 120, keyword: str = "") -> List[Dict[str, Any]]:
    """
    Browse CamWhores models as Hub cards. Optional keyword filters by model name
    (client-side, since the models landing has no direct name search).
    """
    # When searching by name, scan more pages by default to build a usable index.
    scan_pages = pages
    if keyword and pages == 1:
        scan_pages = 6
    models = _scrape_hub_landing("models", sort_by, scan_pages, 0 if keyword else max_results)
    if keyword:
        kw = keyword.strip().lower()
        models = [m for m in models if kw in m["title"].lower()]
    return models[:max_results] if max_results else models


def scrape_camwhores_hub_videos(
    hub_url: str,
    sort_by: str = "newest",
    min_quality: int = 0,
    min_duration: int = 0,
    max_duration: int = 0,
    pages: int = 1,
    only_public: bool = True,
    auto_skip_low_quality: bool = False,
    deep: bool = True,
    max_workers: int = 10,
) -> List[Dict[str, Any]]:
    """
    Fetch videos from a CamWhores category OR model URL (e.g. /categories/fansly/
    or /models/caylin/) as a Hub browse. Uses BROWSE pagination (?from=N) with
    sort re-appended each page. When deep=True, runs the same concurrent detail
    crawl + size probing as scrape_camwhores_discovery; when False, returns fast
    listing-only rows (thumbnail/title/url) for instant browsing.
    """
    base = (hub_url or "").strip()
    if not base:
        return []
    if not base.startswith("http"):
        base = f"{CW_BASE}/{base.lstrip('/')}"
    base = base.split("?", 1)[0].rstrip("/") + "/"

    sort_param = _HUB_SORT_MAP.get((sort_by or "").strip().lower(), "post_date")
    logger.info(f"[CW_HUB] Hub video browse: {base} sort={sort_param} pages={pages} deep={deep}")

    session = _hub_session()

    def _page_url(page_num: int) -> str:
        params = [f"sort_by={sort_param}"]
        if page_num > 1:
            params.append(f"from={page_num}")  # BROWSE-type pagination
        return base + "?" + "&".join(params)

    discovered: List[Dict[str, Any]] = []
    seen: set = set()
    pages = max(1, pages)

    for page_num in range(1, pages + 1):
        try:
            page_url = _page_url(page_num)
            logger.info(f"[CW_HUB] Listing page {page_num}: {page_url}")
            resp = session.get(page_url, timeout=12, verify=False)
            if resp.status_code != 200:
                logger.warning(f"[CW_HUB] Listing page {page_num} -> {resp.status_code}")
                break
            soup = BeautifulSoup(resp.text, "html.parser")
            page_new = 0
            for item in soup.select(".item"):
                a = item if (item.name == "a" and item.get("href")) else item.find("a", href=True)
                if not a:
                    continue
                href = a.get("href") or ""
                full = href if href.startswith("http") else f"{CW_BASE}{href}"
                if "/videos/" not in full or full in seen:
                    continue

                item_classes = " ".join(item.get("class", []))
                if only_public and (
                    "private" in item_classes or "locked" in item_classes
                    or bool(item.select(".lock, .private, .members-only, .premium"))
                ):
                    continue

                seen.add(full)
                # listing-level quick fields
                title_el = item.select_one(".title") or a
                title = title_el.get("title", "").strip() if title_el.name == "a" else title_el.get_text(strip=True)
                if not title:
                    title = a.get("title", "").strip()
                img = item.select_one("img.thumb") or item.find("img")
                thumb = (img.get("data-original") or img.get("src") or "").strip() if img else ""
                duration = 0
                dur_el = item.select_one(".duration, .time")
                if dur_el:
                    parts = dur_el.get_text(strip=True).split(":")
                    try:
                        if len(parts) == 2:
                            duration = int(parts[0]) * 60 + int(parts[1])
                        elif len(parts) == 3:
                            duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                    except ValueError:
                        pass

                discovered.append({
                    "url": full, "title": title, "thumbnail": thumb,
                    "duration": duration, "_discovery_index": len(discovered),
                })
                page_new += 1
            logger.info(f"[CW_HUB] page {page_num}: +{page_new} (total={len(discovered)})")
            if page_new == 0:
                break
        except Exception as e:
            logger.error(f"[CW_HUB] Error on listing page {page_num}: {e}")
            break

    if not discovered:
        return []

    if not deep:
        # Fast mode: apply cheap filters only (duration), leave quality unknown.
        rows = []
        for v in discovered:
            if min_duration and v["duration"] and v["duration"] < min_duration:
                continue
            if max_duration and v["duration"] and v["duration"] > max_duration:
                continue
            v["source"] = "camwhores"
            rows.append(v)
        return rows

    # Deep mode: reuse the discovery detail crawler + probing.
    video_details: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(max_workers, len(discovered))) as executor:
        fut = {executor.submit(_extract_detail_metadata, item["url"], session): item for item in discovered}
        for future in as_completed(fut):
            item = fut[future]
            try:
                details = future.result()
                if details:
                    details["_discovery_index"] = item.get("_discovery_index", len(video_details))
                    video_details.append(details)
            except Exception as e:
                logger.error(f"[CW_HUB] Detail future error: {e}")

    filtered = [
        v for v in video_details
        if _passes_filters(v, min_quality, min_duration, max_duration, "", auto_skip_low_quality)
    ]
    filtered.sort(key=lambda x: x.get("_discovery_index", 0))
    logger.info(f"[CW_HUB] Hub videos ready: {len(filtered)} (from {len(discovered)} listed)")
    return filtered


# ─────────────────────────────────────────────────────────────────────────────
# MEMBER HUB  —  an uploader/curator is 3 content sources at once:
#   posted videos, favourite videos (curated!), and playlists.
# ─────────────────────────────────────────────────────────────────────────────

def _member_base(member_url: str) -> str:
    """Normalize any member URL/id to https://www.camwhores.tv/members/<id>."""
    v = (member_url or "").strip()
    if not v:
        return ""
    if v.isdigit():
        return f"{CW_BASE}/members/{v}"
    if not v.startswith("http"):
        v = f"{CW_BASE}/{v.lstrip('/')}"
    # strip trailing sub-paths (/videos/, /favourites/…) back to /members/<id>
    m = re.search(r"(https?://[^/]+/members/\d+)", v)
    return m.group(1) if m else v.rstrip("/")


def scrape_camwhores_member_profile(member_url: str) -> Optional[Dict[str, Any]]:
    """
    Summary of a CamWhores member: name, avatar, posted/favourite counts, the
    public/private split, and the member's playlists — everything needed to decide
    what to pull before downloading. One request, no deep crawl.
    """
    base = _member_base(member_url)
    if not base:
        return None
    session = _hub_session()
    try:
        resp = session.get(base + "/", timeout=15, verify=False)
        if resp.status_code != 200:
            logger.warning(f"[CW_MEMBER] profile {base} -> {resp.status_code}")
            return None
        soup = BeautifulSoup(resp.text, "html.parser")

        member_id = ""
        mid = re.search(r"/members/(\d+)", base)
        if mid:
            member_id = mid.group(1)

        # Name: page headline <h1> like "RenFan126's Page"
        name = ""
        h1 = soup.select_one("h1")
        if h1:
            name = re.sub(r"'s Page\s*$", "", h1.get_text(strip=True)).strip()

        # Avatar
        avatar = ""
        av = soup.select_one(".avatar img") or soup.select_one("img.thumb")
        if av:
            avatar = (av.get("data-original") or av.get("src") or "").strip()

        def _count(href_frag: str) -> int:
            for a in soup.find_all("a", href=True):
                if href_frag in a["href"]:
                    m = re.search(r"([\d\s,]+)\s*video", a.get_text(" ", strip=True), re.I)
                    if m:
                        try:
                            return int(re.sub(r"[^\d]", "", m.group(1)))
                        except ValueError:
                            pass
            return 0

        posted_count = _count("/videos/")
        favourite_count = _count("/favourites/videos/")

        # Public / Private split from the headline sub-nav (Public (507) / Private (1652))
        public_count = private_count = 0
        for a in soup.select(".headline a, .headline span, .tabs a"):
            t = re.sub(r"\s+", " ", a.get_text(" ", strip=True))
            mp = re.search(r"Public\s*\((\d[\d\s]*)\)", t, re.I)
            mv = re.search(r"Private\s*\((\d[\d\s]*)\)", t, re.I)
            if mp:
                public_count = int(re.sub(r"\D", "", mp.group(1)))
            if mv:
                private_count = int(re.sub(r"\D", "", mv.group(1)))

        # Member playlists (title, url, video_count)
        playlists = []
        seen_pl = set()
        for a in soup.find_all("a", href=True):
            if "/playlists/" not in a["href"] or "/members/" in a["href"]:
                continue
            purl = a["href"] if a["href"].startswith("http") else f"{CW_BASE}{a['href']}"
            pm = re.search(r"/playlists/(\d+)/", purl)
            if not pm or pm.group(1) in seen_pl:
                continue
            txt = re.sub(r"\s+", " ", a.get_text(" ", strip=True))
            vc = 0
            vcm = re.search(r"(\d+)\s*video", txt, re.I)
            if vcm:
                vc = int(vcm.group(1))
            title = re.split(r"\s+\d+\s*video", txt)[0].strip() or txt[:40]
            if not title or title.isdigit():
                continue
            seen_pl.add(pm.group(1))
            playlists.append({"id": pm.group(1), "url": purl, "title": title, "video_count": vc})

        return {
            "member_id": member_id,
            "name": name or f"Member {member_id}",
            "url": base + "/",
            "avatar": avatar,
            "posted_count": posted_count,
            "favourite_count": favourite_count,
            "public_count": public_count,
            "private_count": private_count,
            "posted_url": f"{base}/videos/",
            "favourites_url": f"{base}/favourites/videos/",
            "playlists_url": f"{base}/playlists/",
            "playlists": playlists,
        }
    except Exception as e:
        logger.error(f"[CW_MEMBER] profile error for {member_url}: {e}")
        return None


def scrape_camwhores_member_videos(
    member_url: str,
    kind: str = "posted",          # "posted" | "favourites"
    pages: int = 1,
    only_public: bool = True,
    deep: bool = False,
    min_quality: int = 0,
    min_duration: int = 0,
    max_duration: int = 0,
    auto_skip_low_quality: bool = False,
    max_workers: int = 10,
) -> List[Dict[str, Any]]:
    """
    List a member's POSTED or FAVOURITE videos.

    Pagination differs per kind (KVS quirk, live-verified 2026-07-14):
      - posted    (/members/ID/videos/):            page 2+ via path /N/ or ?from_videos=N
      - favourites(/members/ID/favourites/videos/): AJAX block list_videos_favourite_videos
                                                     with ?from_fav_videos=N
    deep=False returns fast listing rows; deep=True runs the detail crawl + probe.
    """
    base = _member_base(member_url)
    if not base:
        return []
    kind = (kind or "posted").strip().lower()
    session = _hub_session()

    def _page_url(page_num: int) -> str:
        if kind == "favourites":
            root = f"{base}/favourites/videos/"
            if page_num == 1:
                return root
            return (f"{root}?mode=async&function=get_block"
                    f"&block_id=list_videos_favourite_videos"
                    f"&fav_type=0&playlist_id=0&sort_by=&from_fav_videos={page_num}")
        # posted
        root = f"{base}/videos/"
        if page_num == 1:
            return root
        return f"{root}{page_num}/"   # path form works for posted

    discovered: List[Dict[str, Any]] = []
    seen: set = set()
    pages = max(1, pages)

    for page_num in range(1, pages + 1):
        try:
            url = _page_url(page_num)
            logger.info(f"[CW_MEMBER] {kind} page {page_num}: {url}")
            resp = session.get(url, timeout=12, verify=False)
            if resp.status_code != 200:
                logger.warning(f"[CW_MEMBER] {kind} page {page_num} -> {resp.status_code}")
                break
            soup = BeautifulSoup(resp.text, "html.parser")
            page_new = 0
            for item in soup.select(".item"):
                a = item if (item.name == "a" and item.get("href")) else item.find("a", href=True)
                if not a:
                    continue
                href = a.get("href") or ""
                full = href if href.startswith("http") else f"{CW_BASE}{href}"
                if "/videos/" not in full or full in seen:
                    continue
                item_classes = " ".join(item.get("class", []))
                if only_public and (
                    "private" in item_classes or "locked" in item_classes
                    or bool(item.select(".lock, .private, .members-only, .premium"))
                ):
                    continue
                seen.add(full)
                title = a.get("title", "").strip()
                t_el = item.select_one(".title")
                if t_el and t_el.get_text(strip=True):
                    title = t_el.get_text(strip=True)
                img = item.select_one("img.thumb") or item.find("img")
                thumb = (img.get("data-original") or img.get("src") or "").strip() if img else ""
                duration = 0
                dur_el = item.select_one(".duration, .time")
                if dur_el:
                    parts = dur_el.get_text(strip=True).split(":")
                    try:
                        if len(parts) == 2:
                            duration = int(parts[0]) * 60 + int(parts[1])
                        elif len(parts) == 3:
                            duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                    except ValueError:
                        pass
                discovered.append({
                    "url": full, "title": title, "thumbnail": thumb,
                    "duration": duration, "_discovery_index": len(discovered),
                })
                page_new += 1
            logger.info(f"[CW_MEMBER] {kind} page {page_num}: +{page_new} (total={len(discovered)})")
            if page_new == 0:
                break
        except Exception as e:
            logger.error(f"[CW_MEMBER] Error on {kind} page {page_num}: {e}")
            break

    if not discovered or not deep:
        for v in discovered:
            v["source"] = "camwhores"
        return discovered

    video_details: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(max_workers, len(discovered))) as executor:
        fut = {executor.submit(_extract_detail_metadata, item["url"], session): item for item in discovered}
        for future in as_completed(fut):
            item = fut[future]
            try:
                details = future.result()
                if details:
                    details["_discovery_index"] = item.get("_discovery_index", len(video_details))
                    video_details.append(details)
            except Exception as e:
                logger.error(f"[CW_MEMBER] Detail future error: {e}")

    filtered = [
        v for v in video_details
        if _passes_filters(v, min_quality, min_duration, max_duration, "", auto_skip_low_quality)
    ]
    filtered.sort(key=lambda x: x.get("_discovery_index", 0))
    return filtered


# ─────────────────────────────────────────────────────────────────────────────
# PLAYLIST DISCOVERY
# ─────────────────────────────────────────────────────────────────────────────

PLAYLIST_SORT_MAP = {
    "top_rated": "rating",
    "most_viewed": "playlist_viewed",
    "most_commented": "most_commented",
    "most_videos": "total_videos",
    "recently_updated": "last_content_date",
}

# Search URL (keyword-based, different endpoint)
PLAYLIST_SEARCH_URL = "https://www.camwhores.tv/search/playlists/?q={q}&sort_by={sort}&mode=async&function=get_block&block_id=list_playlists_common_playlists_list&from={page}"
# Browse URL (no keyword — browse all by sort)
PLAYLIST_BROWSE_URL = "https://www.camwhores.tv/playlists/?mode=async&function=get_block&block_id=list_playlists_common_playlists_list&sort_by={sort}&from={page}"


def _parse_playlist_items(html: str) -> List[Dict[str, Any]]:
    """
    Parse playlist card items from a Camwhores playlist listing page / AJAX response.
    Returns list of playlist metadata dicts.
    """
    soup = BeautifulSoup(html, "html.parser")
    items = soup.select(".item")
    results = []

    for item in items:
        try:
            a = item if item.name == "a" and item.get("href") else item.find("a", href=True)
            if not a:
                continue
            href = a["href"]
            if "/playlists/" not in href:
                continue

            playlist_url = href if href.startswith("http") else f"https://www.camwhores.tv{href}"
            title = ""

            # Title in <strong class="title">
            title_el = item.select_one("strong.title")
            if title_el:
                title = title_el.get_text(strip=True)
            if not title:
                title = a.get("title", "").strip()

            # Thumbnails — up to 4 preview thumbs
            thumbnails = []
            for img in item.select("img.thumb"):
                src = img.get("data-original") or img.get("src") or ""
                if src and src not in thumbnails:
                    thumbnails.append(src)

            thumbnail = thumbnails[0] if thumbnails else ""

            # Video count: <div class="videos">4 videos</div>
            video_count = 0
            videos_el = item.select_one("div.videos")
            if videos_el:
                m = re.search(r"(\d+)", videos_el.get_text())
                if m:
                    video_count = int(m.group(1))

            # Rating: <div class="rating positive">100%</div>
            rating = ""
            rating_el = item.select_one("div.rating")
            if rating_el:
                rating = rating_el.get_text(strip=True)

            # Views: <div class="views">14 618</div>
            views = 0
            views_el = item.select_one("div.views")
            if views_el:
                try:
                    views = int(re.sub(r"[^\d]", "", views_el.get_text(strip=True)))
                except ValueError:
                    pass

            # Age / added: <div class="added"><em>8 years ago</em></div>
            age = ""
            added_el = item.select_one("div.added em")
            if added_el:
                age = added_el.get_text(strip=True)

            # Extract playlist numeric ID from URL, e.g. /playlists/81467/pucciosa/
            playlist_id = ""
            m = re.search(r"/playlists/(\d+)/", playlist_url)
            if m:
                playlist_id = m.group(1)

            results.append({
                "id": playlist_id,
                "url": playlist_url,
                "title": title,
                "thumbnail": thumbnail,
                "thumbnails": thumbnails,
                "video_count": video_count,
                "rating": rating,
                "views": views,
                "age": age,
            })
        except Exception as e:
            logger.debug(f"[PLAYLIST_PARSE] Error parsing item: {e}")
            continue

    return results


def scrape_camwhores_playlists(
    keyword: str = "",
    sort_by: str = "top_rated",
    pages: int = 1,
    max_results: int = 60,
    report: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """
    Search or browse Camwhores playlists.

    Since Camwhores.tv doesn't support direct playlist search (search URLs redirect to video search),
    we handle searching by browsing the top-rated/most-viewed playlists and filtering by title.
    """
    kvs_sort = PLAYLIST_SORT_MAP.get(sort_by, "rating")
    logger.info(f"[CW_PLAYLISTS] Searching playlists: keyword='{keyword}', sort={sort_by}, pages={pages}")

    extractor = CamwhoresExtractor()
    headers = extractor._base_headers()
    session = requests.Session()
    session.headers.update(headers)

    all_playlists: List[Dict[str, Any]] = []
    seen_ids: set = set()
    previous_ids: set = set()

    pages_to_scan = min(max(int(pages), 1), 10)
    max_results = min(max(int(max_results), 1), 300)
    if report is not None:
        report.update(status="ok", pages_requested=pages_to_scan, pages_scanned=0, playlists_scanned=0, scope="title_filter")
    failure = None

    for page_num in range(1, pages_to_scan + 1):
        # KVS uses zero-padded page numbers for pages 2+
        if page_num == 1:
            page_param = "01"
        else:
            page_param = f"{page_num:02d}"

        try:
            # We always use BROWSE_URL because SEARCH_URL is not supported for playlists on Camwhores
            url = PLAYLIST_BROWSE_URL.format(sort=kvs_sort, page=page_param)

            logger.info(f"[CW_PLAYLISTS] Fetching page {page_num}: {url}")
            resp = session.get(url, timeout=15)

            if resp.status_code != 200:
                logger.warning(f"[CW_PLAYLISTS] Page {page_num} returned {resp.status_code}")
                failure = _cw_http_error(resp.status_code)
                break

            _cw_check_response_body(resp.text)
            page_playlists = _parse_playlist_items(resp.text)
            if report is not None:
                report["pages_scanned"] += 1
            if not page_playlists:
                logger.info(f"[CW_PLAYLISTS] No more results at page {page_num}, stopping.")
                break

            page_ids = {pl["id"] for pl in page_playlists if pl.get("id")}
            if page_num > 1 and page_ids and page_ids == previous_ids:
                failure = CamwhoresSourceError("Zdroj vrátil rovnakú stránku znovu; ďalšie výsledky nie sú overené.", "pagination_error")
                break
            previous_ids = page_ids

            for pl in page_playlists:
                if pl["id"] and pl["id"] not in seen_ids:
                    seen_ids.add(pl["id"])
                    all_playlists.append(pl)

            logger.info(f"[CW_PLAYLISTS] Page {page_num}: +{len(page_playlists)} playlists, total={len(all_playlists)}")

        except CamwhoresSourceError as e:
            failure = e
            break
        except Exception as e:
            logger.error(f"[CW_PLAYLISTS] Error on page {page_num}: {e}")
            failure = CamwhoresSourceError("Camwhores sa nepodarilo načítať. Skontroluj pripojenie.", "network_error")
            break

    if failure and not all_playlists:
        raise failure
    if report is not None:
        report["playlists_scanned"] = len(all_playlists)
        if failure:
            report.update(status="partial", code=failure.code, message=str(failure))

    # Filter playlists by keyword in title if provided
    if keyword:
        norm_kw = keyword.strip().lower()
        filtered = []
        for pl in all_playlists:
            title = pl.get("title", "").lower()
            if norm_kw in title:
                filtered.append(pl)
        logger.info(f"[CW_PLAYLISTS] Filtered by keyword '{keyword}': {len(all_playlists)} -> {len(filtered)}")
        all_playlists = filtered

    return all_playlists[:max_results]


def fetch_playlist_videos(
    playlist_url: str,
    only_public: bool = True,
    batch_size: int = 200,
    batch_offset: int = 0,
) -> Dict[str, Any]:
    """
    Fetch all public videos from a Camwhores playlist, with batched gallery delivery.

    Fetches ALL pages of the playlist (no hard cap), classifies public vs private,
    then returns only the requested window: videos[batch_offset : batch_offset + batch_size].
    The full counts (total_count, public_count, private_count) always reflect the complete playlist.

    Args:
        playlist_url: full URL like https://www.camwhores.tv/playlists/674825/b-g-couple/
        only_public: if True, only public videos go into the result window
        batch_size: how many videos to return in this call (gallery page size, e.g. 100 or 200)
        batch_offset: starting index for this batch (0 = first batch)

    Returns:
        Dict with keys: playlist_url, playlist_title, total_count, public_count,
                        private_count, public_ratio, has_more, videos (windowed batch)
    """
    extractor = CamwhoresExtractor()
    headers = extractor._base_headers(referer="https://www.camwhores.tv/playlists/")
    session = requests.Session()
    session.headers.update(headers)

    VIDEOS_BLOCK = "playlist_view_playlist_view"

    playlist_title = ""
    all_videos: List[Dict[str, Any]] = []
    seen_video_ids: set = set()
    public_count = 0
    private_count = 0
    page_num = 1

    # Fetch all pages — no hard cap, we want full playlist counts
    while True:
        if page_num == 1:
            page_url = playlist_url
        else:
            page_param = f"{page_num:02d}"
            page_url = (
                f"{playlist_url.rstrip('/')}/"
                f"?mode=async&function=get_block"
                f"&block_id={VIDEOS_BLOCK}"
                f"&from={page_param}"
            )

        try:
            logger.info(f"[CW_PLAYLIST_FETCH] Fetching page {page_num}: {page_url}")
            resp = session.get(page_url, timeout=15, verify=False)
            if resp.status_code != 200:
                logger.warning(f"[CW_PLAYLIST_FETCH] Status {resp.status_code} at page {page_num}")
                break

            soup = BeautifulSoup(resp.text, "html.parser")

            # Extract title on first page
            if page_num == 1:
                h1 = soup.select_one("h1")
                if h1:
                    playlist_title = h1.get_text(strip=True)
                    # Strip "Playlist: " prefix if present
                    playlist_title = re.sub(r"^(Playlist:\s*)", "", playlist_title, flags=re.I)
                if not playlist_title:
                    # Try <title>
                    title_tag = soup.select_one("title")
                    if title_tag:
                        playlist_title = title_tag.get_text(strip=True).split("-")[0].strip()

            # Parse video items
            items = soup.select(".item")
            if not items:
                logger.info(f"[CW_PLAYLIST_FETCH] No items on page {page_num}, stopping.")
                break

            page_found = 0
            for item in items:
                if item.name == "a" and item.get("href"):
                    a = item
                else:
                    a = item.find("a", href=True)

                if not a:
                    continue
                href = a["href"]
                if "/videos/" not in href:
                    continue

                video_url = href if href.startswith("http") else f"https://www.camwhores.tv{href}"

                # Extract video numeric id
                m = re.search(r"/videos/(\d+)/", video_url)
                vid_id = m.group(1) if m else video_url
                if vid_id in seen_video_ids:
                    continue
                seen_video_ids.add(vid_id)

                # Private detection:
                # - item has class "private" or "locked"
                # - OR a child element has class "lock", "private", "members-only"
                # - OR no valid thumbnail (src is placeholder)
                item_classes = " ".join(item.get("class", []))
                is_private = (
                    "private" in item_classes
                    or "locked" in item_classes
                    or bool(item.select(".lock, .private, .members-only, .premium"))
                    or "private" in item.get_text(separator=" ", strip=True).lower()
                )

                # Get title
                title_el = item.select_one(".title")
                title = title_el.get_text(strip=True) if title_el else a.get("title", "").strip()

                # Get thumbnail
                img = item.select_one("img.thumb") or item.find("img")
                thumbnail = ""
                if img:
                    thumbnail = img.get("data-original") or img.get("src") or ""

                # Duration
                duration = 0
                dur_el = item.select_one(".duration, .time")
                if dur_el:
                    dur_str = dur_el.get_text(strip=True)
                    parts = dur_str.split(":")
                    try:
                        if len(parts) == 2:
                            duration = int(parts[0]) * 60 + int(parts[1])
                        elif len(parts) == 3:
                            duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                    except ValueError:
                        pass

                if is_private:
                    private_count += 1
                else:
                    public_count += 1

                video_entry = {
                    "url": video_url,
                    "source_url": video_url,
                    "title": title,
                    "thumbnail": thumbnail,
                    "duration": duration,
                    "is_public": not is_private,
                    "playlist_title": playlist_title,
                    "playlist_url": playlist_url,
                    "source": "camwhores",
                    "resolution": 0,
                    "quality": "",
                    "size_bytes": 0,
                    "size_human": "-",
                    "uploader": "",
                    "enriched": False,
                }
                all_videos.append(video_entry)
                page_found += 1

            logger.info(f"[CW_PLAYLIST_FETCH] Page {page_num}: +{page_found} videos (total={len(all_videos)})")

            # Stop early if we have collected enough videos to satisfy the batch window
            needed_videos = batch_offset + batch_size
            current_count = sum(1 for v in all_videos if v["is_public"]) if only_public else len(all_videos)
            if current_count >= (needed_videos + 8):
                logger.info(f"[CW_PLAYLIST_FETCH] Loaded {current_count} matches, stopping early since batch window is covered.")
                break

            # Check if there's a next page
            pagination = soup.select(".pagination a")
            has_next = any("next" in (a.get("class") or []) or a.get_text(strip=True).lower() == "next" for a in pagination)
            # Also check by looking for a page link > current page
            if not has_next:
                page_links = [a for a in pagination if a.get_text(strip=True).isdigit()]
                if page_links:
                    max_page = max(int(a.get_text(strip=True)) for a in page_links)
                    has_next = max_page > page_num
                else:
                    has_next = False

            if not has_next or page_found == 0:
                break

            page_num += 1
            time.sleep(0.3)  # Polite delay

        except Exception as e:
            logger.error(f"[CW_PLAYLIST_FETCH] Error fetching page {page_num}: {e}")
            break

    total_count = len(all_videos)
    public_videos = [v for v in all_videos if v["is_public"]]
    source_list = public_videos if only_public else all_videos

    public_ratio = f"{int(len(public_videos) / total_count * 100)}%" if total_count > 0 else "0%"

    # Apply batch window
    batch_slice = source_list[batch_offset: batch_offset + batch_size]
    has_more = (batch_offset + batch_size) < len(source_list)

    return {
        "playlist_url": playlist_url,
        "playlist_title": playlist_title,
        "total_count": total_count,
        "public_count": len(public_videos),
        "private_count": private_count,
        "public_ratio": public_ratio,
        "has_more": has_more,
        "batch_offset": batch_offset,
        "batch_size": batch_size,
        "returned_count": len(batch_slice),
        "videos": batch_slice,
    }


def fetch_multiple_playlists(
    playlist_urls: List[str],
    only_public: bool = True,
    batch_size: int = 200,
    batch_offset: int = 0,
    max_workers: int = 4,
) -> Dict[str, Any]:
    """
    Fetch videos from multiple playlists concurrently and aggregate results.
    Returns flat list of all public video URLs plus per-playlist breakdown and
    a unified list of video objects with attached playlist metadata for shared gallery view.

    Args:
        playlist_urls: list of camwhores playlist URLs
        only_public: if True, only public videos in result
        batch_size: videos per batch per playlist (200 default)
        batch_offset: start offset for pagination across playlists
        max_workers: concurrency level
    """
    results_per_playlist: List[Dict[str, Any]] = []

    with ThreadPoolExecutor(max_workers=min(max_workers, max(1, len(playlist_urls)))) as executor:
        futures = {
            executor.submit(
                fetch_playlist_videos,
                url,
                only_public,
                batch_size,
                batch_offset,
            ): url
            for url in playlist_urls
        }
        for future in as_completed(futures):
            url = futures[future]
            try:
                result = future.result()
                results_per_playlist.append(result)
            except Exception as e:
                logger.error(f"[CW_MULTI_FETCH] Failed for {url}: {e}")
                results_per_playlist.append({
                    "playlist_url": url,
                    "playlist_title": url,
                    "total_count": 0,
                    "public_count": 0,
                    "private_count": 0,
                    "public_ratio": "0%",
                    "videos": [],
                    "has_more": False,
                    "error": str(e),
                })

    # Aggregate
    all_videos = []
    all_video_urls = []
    seen_urls: set = set()
    total_public = 0
    total_private = 0
    has_any_more = False

    for pl in results_per_playlist:
        total_public += pl.get("public_count", 0)
        total_private += pl.get("private_count", 0)
        if pl.get("has_more"):
            has_any_more = True
        pl_title = pl.get("playlist_title", "")
        pl_url = pl.get("playlist_url", "")
        for v in pl.get("videos", []):
            u = v.get("url", "")
            if u and u not in seen_urls:
                seen_urls.add(u)
                all_video_urls.append(u)
                item_copy = dict(v)
                if not item_copy.get("playlist_title"):
                    item_copy["playlist_title"] = pl_title
                if not item_copy.get("playlist_url"):
                    item_copy["playlist_url"] = pl_url
                all_videos.append(item_copy)

    return {
        "playlists": results_per_playlist,
        "total_playlists": len(playlist_urls),
        "total_public": total_public,
        "total_private": total_private,
        "total_fetched": len(all_video_urls),
        "has_more": has_any_more,
        "batch_offset": batch_offset,
        "batch_size": batch_size,
        "video_urls": all_video_urls,
        "videos": all_videos,
    }


def enrich_playlist_card(card: Dict[str, Any], session: Optional[requests.Session] = None) -> Dict[str, Any]:
    """
    Fetches full metadata for a video card (stream URL, probe size, resolution, uploader, tags, date).
    Returns an enriched card dictionary with accurate resolution, exact size, and stream details.
    """
    url = card.get("url") or card.get("source_url")
    if not url:
        return card

    should_close_session = False
    if session is None:
        session = requests.Session()
        should_close_session = True

    try:
        details = _extract_detail_metadata(url, session, fallback_item=card, quick=False)
        if details:
            # Preserve playlist origin info
            if card.get("playlist_title") and not details.get("playlist_title"):
                details["playlist_title"] = card["playlist_title"]
            if card.get("playlist_url") and not details.get("playlist_url"):
                details["playlist_url"] = card["playlist_url"]
            details["enriched"] = True
            details["duration_known"] = bool(details.get("duration"))
            return details
    except Exception as e:
        logger.warning(f"[ENRICH_PLAYLIST_CARD] Failed for {url}: {e}")
    finally:
        if should_close_session:
            session.close()

    card_copy = dict(card)
    card_copy["enriched"] = False
    return card_copy


def batch_enrich_cards(cards: List[Dict[str, Any]], max_workers: int = 5) -> List[Dict[str, Any]]:
    """
    Concurrently enrich a list of cards with full metadata, size probes, and stream URLs.
    """
    if not cards:
        return []

    results = []
    with ThreadPoolExecutor(max_workers=min(max_workers, max(1, len(cards)))) as executor:
        futures = {executor.submit(enrich_playlist_card, card): card for card in cards}
        for future in as_completed(futures):
            try:
                res = future.result()
                results.append(res)
            except Exception as e:
                orig_card = futures[future]
                logger.error(f"[BATCH_ENRICH_CARDS] Error for {orig_card.get('url')}: {e}")
                results.append(orig_card)
    return results


async def async_extract_detail_metadata(
    video_url: str,
    client: httpx.AsyncClient,
    fallback_item: Optional[Dict[str, Any]] = None,
    watch_client: Any = None,
    external_gate: Any = None,
) -> Optional[Dict[str, Any]]:
    """
    Read watch-page metadata and probe an available direct stream for its exact size.
    Older Camwhores entries may delegate playback to a Camvideos embed.
    """
    if not video_url:
        return None
    cached = _CW_DETAIL_CACHE.get(video_url)
    if cached and time.monotonic() - cached[0] < _CW_DETAIL_CACHE_TTL:
        return dict(cached[1])
    try:
        from app.extractors.base import ntc_get
        _has_ntc = True
    except ImportError:
        _has_ntc = False

    try:
        extractor = CamwhoresExtractor()
        headers = extractor._base_headers(referer="https://www.camwhores.tv/")
        # The saved browser Cookie header makes public watch-page requests stall
        # on this host. The public metadata is available without it.
        page_headers = {key: value for key, value in headers.items() if key.lower() != "cookie"}
        fetch_url = video_url.rstrip("/") + "/"

        html: Optional[str] = None

        # Batch requests share one curl_cffi session. This avoids per-request
        # NTC queueing and TLS/session setup for a gallery of watch pages.
        if watch_client is not None:
            try:
                watch_response = await watch_client.get(fetch_url, headers=page_headers, timeout=10)
                if watch_response.status_code == 200 and len(watch_response.text) >= 1000:
                    html = watch_response.text
            except Exception as watch_error:
                logger.debug("[ASYNC_CW_DISCOVERY] shared session failed for %s: %s", video_url, watch_error)

        # --- Path A: ntc_get with TLS fingerprint (bypasses Cloudflare, gets real flashvars) ---
        if not html and _has_ntc:
            try:
                html = await ntc_get(
                    fetch_url,
                    domain="camwhores.tv",
                    headers=page_headers,
                    deadline=12,
                    impersonate="chrome124",
                )
                # A short response is usually a challenge or an error page.
                if html and len(html) < 1000:
                    logger.debug("[ASYNC_CW_DISCOVERY] ntc_get returned suspiciously short response for %s", video_url)
                    html = None
            except Exception as ntc_err:
                logger.debug("[ASYNC_CW_DISCOVERY] ntc_get failed for %s: %s", video_url, ntc_err)
                html = None

        # --- Path B: plain httpx fallback (works only if Cloudflare not blocking) ---
        if not html and not _has_ntc:
            try:
                resp = await client.get(video_url, headers=page_headers, timeout=3.0)
                if resp and resp.status_code == 200 and len(resp.text) > 1000:
                    html = resp.text
            except Exception as req_err:
                logger.debug("[ASYNC_CW_DISCOVERY] httpx fallback error for %s: %s", video_url, req_err)

        if not html or len(html) < 1000:
            if fallback_item:
                return {**fallback_item, "url": video_url, "enriched": False}
            return None

        soup = BeautifulSoup(html, 'html.parser')

        # Strict public-only gate
        _html_lower = html.lower()
        _PRIVATE_SIGNALS = (
            'class="private"', "class='private'",
            'video-private', 'video_private',
            'members only', 'members-only',
            'this video is private',
            'private video',
            'login to watch',
            'sign up to watch',
            'upgrade to watch',
            'locked video',
        )
        if any(sig in _html_lower for sig in _PRIVATE_SIGNALS):
            return None

        # 1. Title
        title = extractor._extract_title(html, fallback="Camwhores Video")

        # 2. Thumbnail
        thumbnail = extractor._extract_thumbnail(html)

        # 3. Duration
        duration = extractor._extract_duration(html)
        if duration == 0:
            for s in soup.find_all('span'):
                txt = s.get_text()
                if txt and 'Duration:' in txt:
                    em = s.find('em')
                    if em:
                        dur_str = em.get_text(strip=True)
                        parts = dur_str.split(':')
                        try:
                            if len(parts) == 2:
                                duration = int(parts[0]) * 60 + int(parts[1])
                            elif len(parts) == 3:
                                duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                        except ValueError:
                            pass
                    break

        # 4. Views
        views = 0
        for s in soup.find_all('span'):
            txt = s.get_text()
            if txt and 'Views:' in txt:
                em = s.find('em')
                if em:
                    try:
                        views = int(re.sub(r'[^\d]', '', em.get_text(strip=True)))
                    except ValueError:
                        pass
                break

        taxonomy = _cw_detail_taxonomy(soup)
        added_text = (taxonomy or {}).get('added', '')
        added_date = added_text if re.fullmatch(r'\d{4}-\d{2}-\d{2}', added_text or '') else ''

        # 5. Tags
        tags = []
        for a in (soup.select_one('#tab_video_info') or soup).find_all('a', href=True):
            if '/tags/' in a['href'] or '/tag/' in a['href']:
                tag_text = a.get_text(strip=True)
                if tag_text and tag_text not in tags:
                    tags.append(tag_text)

        # 6. Uploader
        uploader = "Anonymous"
        username_div = soup.select_one('div.username')
        if username_div:
            a_link = username_div.find('a')
            if a_link and a_link.get_text(strip=True):
                uploader = a_link.get_text(strip=True)
        if uploader == "Anonymous":
            submitted_node = soup.find(string=re.compile(r'Submitted by:', re.I))
            if submitted_node and submitted_node.parent:
                a_link = submitted_node.parent.find('a')
                if a_link:
                    uploader = a_link.get_text(strip=True)
        if uploader == "Anonymous" and title:
            words = title.split()
            if words and len(words[0]) >= 3 and not words[0].lower() in ('webcam', 'cam', 'stream', 'recording', 'private', 'public'):
                uploader = words[0]

        # A valid page may contain metadata but no direct file (external embed).
        # Keep the duration in that case instead of discarding the whole result.
        candidates = extractor._extract_candidates_from_html(html)
        flashvars = extractor._parse_flashvars(html)
        for key in ("video_url_urhd", "video_url_hd", "video_url", "video_url_sd"):
            raw = flashvars.get(key)
            if raw:
                candidate = extractor._sanitize_url(raw)
                if candidate.startswith("http") and "get_file" in candidate and candidate not in candidates:
                    candidates.append(candidate)
        external_embed = soup.select_one('.player-holder iframe[src]')
        stream_referer = video_url
        if not candidates and external_embed:
            # Camvideos denies some /embed/ pages while its ordinary video page
            # exposes KVS flashvars. This is the same fallback used by JD's
            # CamVideosOrg plugin. Only accept an exact, numeric Camvideos embed.
            embed_url = external_embed.get('src', '')
            embed_match = re.fullmatch(
                r'https?://(?:www\.)?camvideos\.org/embed/(\d+)/?(?:\?.*)?',
                embed_url,
                flags=re.I,
            )
            if embed_match:
                external_url = f'https://www.camvideos.org/videos/{embed_match.group(1)}/dummystring/'
                external_headers = {**page_headers, 'Referer': video_url}
                try:
                    async def fetch_external_page():
                        for attempt in range(3):
                            if watch_client is not None:
                                response = await watch_client.get(
                                    external_url, headers=external_headers, timeout=8,
                                )
                            else:
                                response = await client.get(
                                    external_url, headers=external_headers, timeout=8,
                                    follow_redirects=True,
                                )
                            if response.status_code not in (429, 503) or attempt == 2:
                                return response
                            await asyncio.sleep(0.35 * (attempt + 1))

                    if external_gate is not None:
                        async with external_gate:
                            external_response = await fetch_external_page()
                    else:
                        external_response = await fetch_external_page()
                    if external_response.status_code == 200:
                        external_html = external_response.text
                        external_flashvars = extractor._parse_flashvars(external_html)
                        for key in ('video_url_urhd', 'video_url_hd', 'video_url', 'video_url_sd'):
                            raw = external_flashvars.get(key)
                            if raw:
                                candidate = extractor._sanitize_url(raw)
                                if candidate.startswith('https://') and 'get_file' in candidate:
                                    candidates.append(candidate)
                        if candidates:
                            stream_referer = str(external_response.url)
                except Exception as external_error:
                    logger.debug('[ASYNC_CW_DISCOVERY] Camvideos page failed for %s: %s', video_url, external_error)
        candidates.sort(key=extractor._infer_height_from_url, reverse=True)

        stream_url = ""
        exact_size_bytes = 0
        resolution = 0
        width = 0
        if candidates:
            probe_url = normalize_camwhores_get_file_rnd(candidates[0])
            stream_url = probe_url
            resolution = extractor._infer_height_from_url(probe_url)
            probe_headers = {**page_headers, "Referer": stream_referer, "Range": "bytes=0-0"}
            try:
                # Streaming avoids downloading a full video when a CDN ignores Range.
                async with client.stream("GET", probe_url, headers=probe_headers,
                                         timeout=5.0, follow_redirects=True) as p_resp:
                    if p_resp.status_code in (200, 206):
                        content_range = p_resp.headers.get("Content-Range", "")
                        match = re.search(r"/(\d+)$", content_range)
                        if match:
                            exact_size_bytes = int(match.group(1))
                        elif p_resp.status_code == 200 and (
                            "video" in p_resp.headers.get("Content-Type", "").lower()
                            or "octet-stream" in p_resp.headers.get("Content-Type", "").lower()
                        ):
                            # Trust a whole-file length only for media responses.
                            exact_size_bytes = int(p_resp.headers.get("Content-Length") or 0)
            except Exception as probe_error:
                logger.debug("[ASYNC_CW_DISCOVERY] size probe failed for %s: %s", video_url, probe_error)

            if not resolution and ".mp4" in probe_url.lower():
                # Many Camvideos get_file URLs carry no quality label. Read
                # small MP4 byte ranges for the actual track dimensions.
                try:
                    mp4 = await asyncio.wait_for(
                        probe_mp4_cached(
                            video_url, probe_url,
                            headers={**page_headers, "Referer": stream_referer},
                            timeout=5.0,
                        ),
                        timeout=6.0,
                    )
                    width = int(mp4.get("width") or 0)
                    resolution = int(mp4.get("height") or 0)
                except Exception as dimension_error:
                    logger.debug("[ASYNC_CW_DISCOVERY] dimension probe failed for %s: %s",
                                 video_url, dimension_error)

        quality_str = ""
        # Portrait clips have more vertical than horizontal pixels. Display
        # their shorter edge as the familiar quality tier (720x1280 -> 720p),
        # while keeping ``resolution`` as the actual video height.
        quality_height = min(width, resolution) if width > 0 and resolution > 0 else resolution

        if quality_height >= 2160:
            quality_str = "4K"
        elif quality_height > 0:
            quality_str = f"{quality_height}p"

        size_human = f"{exact_size_bytes / (1024 * 1024):.1f} MB" if exact_size_bytes > 0 else "-"
        size_reason = "external_embed" if external_embed and not candidates else "no_file_size"

        bitrate_kbps = 0
        bitrate_human = ""
        if exact_size_bytes > 0 and duration > 0:
            bitrate_kbps = int((exact_size_bytes * 8) / (duration * 1000))
            if bitrate_kbps >= 1000:
                bitrate_human = f"{bitrate_kbps / 1000:.1f} Mbps"
            else:
                bitrate_human = f"{bitrate_kbps} kbps"

        # Flashvars
        categories_str = flashvars.get("video_categories") or "" if flashvars else ""
        models_str = flashvars.get("video_models") or "" if flashvars else ""
        related_src = flashvars.get("related_src") or "" if flashvars else ""
        preview_mp4_url = ""
        if flashvars:
            fv_tags = [t.strip() for t in (flashvars.get("video_tags") or "").split(",") if t.strip()]
            for t in fv_tags:
                if t not in tags:
                    tags.append(t)
            # Preview MP4 video URL (only if a real video trailer is explicitly provided)
            raw_trailer = flashvars.get("trailer_url") or flashvars.get("preview_video_url") or flashvars.get("video_alt_url") or ""
            if raw_trailer and ".mp4" in raw_trailer.lower():
                preview_mp4_url = raw_trailer

        if taxonomy is not None:
            tags = taxonomy['tags']
            categories_str = ', '.join(taxonomy['categories'])
            models_str = ', '.join(taxonomy['models'])
            uploader = taxonomy['uploader'] or 'Anonymous'
        else:
            tags, categories_str, models_str, uploader = [], '', '', 'Anonymous'
        result = {
            "title": title,
            "url": video_url,
            "source_url": video_url,
            "thumbnail": thumbnail,
            "duration": duration,
            "tags": tags,
            "uploader": uploader,
            "views": views,
            "added": added_text,
            "taxonomy_verified": taxonomy is not None,
            "date_precision": "exact" if added_date else ("relative" if added_text else "unknown"),
            "added_date": added_date,
            "upload_date": added_date,
            "date_added": added_date,
            "stream_url": stream_url,
            "resolution": resolution,
            "width": width,
            "quality": quality_str,
            "size_bytes": exact_size_bytes,
            "size_human": size_human,
            "size_status": "exact" if exact_size_bytes else "unavailable",
            "size_reason": "" if exact_size_bytes else size_reason,
            "bitrate_kbps": bitrate_kbps,
            "bitrate_human": bitrate_human,
            "source": "camwhores",
            "categories": categories_str,
            "models": models_str,
            "related_src": related_src,
            "preview_mp4_url": preview_mp4_url,
            "enriched": True,
            "duration_known": bool(duration)
        }
        if len(_CW_DETAIL_CACHE) >= 2000:
            _CW_DETAIL_CACHE.clear()
        # A transient failure on an external player should be retried next time.
        if exact_size_bytes or not external_embed:
            _CW_DETAIL_CACHE[video_url] = (time.monotonic(), dict(result))
        return result
    except Exception as e:
        logger.error(f"[ASYNC_CW_DISCOVERY] Detail page extraction failed for {video_url}: {e}")
        return None
