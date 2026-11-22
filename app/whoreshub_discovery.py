"""
WhoresHub Discovery Module
Smart discovery and import system for WhoresHub videos with advanced filtering.
"""
import re
import logging
import requests
from bs4 import BeautifulSoup
from typing import List, Dict, Any, Optional
from urllib.parse import urljoin, unquote
from concurrent.futures import ThreadPoolExecutor, as_completed

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _split_query(base_url: str) -> (str, str):
    """Split a URL into (path_part, query_string) so we can preserve ?sort_by=."""
    base = base_url or ""
    if "?" in base:
        path, query = base.split("?", 1)
        return path, query
    return base, ""


def _with_query(path: str, query: str, extra_params: Dict[str, str] = None) -> str:
    """Rebuild a URL from a path + existing query string, merging extra params."""
    parts = [chunk for chunk in (query or "").split("&") if chunk]
    seen_keys = {chunk.split("=", 1)[0] for chunk in parts}
    for key, value in (extra_params or {}).items():
        if key not in seen_keys:
            parts.append(f"{key}={value}")
    if not parts:
        return path
    return f"{path}?{'&'.join(parts)}"


def _pagination_candidates(base_url: str, page_num: int) -> List[str]:
    # Preserve any query string (e.g. ?sort_by=post_date) already on the base URL.
    path, query = _split_query(base_url)
    if page_num <= 1:
        return [base_url]
    normalized = (path or "").rstrip("/") + "/"
    # WhoresHub's KVS engine paginates a sorted listing via a PATH segment
    # (/tags/4k/2/) and only keeps the sort when ?sort_by= is re-appended.
    # This is live-verified (2026-07-14): the path form advances the listing
    # AND keeps post_date order, whereas ?from_videos=/?page= are ignored and
    # just re-serve page 1. The site's own pagination href uses this exact form.
    # Alternate ?from=NN also works and is kept as a fallback for other KVS skins.
    candidates = [
        _with_query(f"{normalized}{page_num}/", query),
        _with_query(normalized, query, {"from": str(page_num)}),
        _with_query(normalized, query, {"from_videos": str(page_num)}),
        _with_query(f"{normalized}page/{page_num}/", query),
        _with_query(normalized, query, {"page": str(page_num)}),
    ]
    unique = []
    for candidate in candidates:
        if candidate not in unique:
            unique.append(candidate)
    return unique


def _extract_next_page_url(soup: BeautifulSoup, current_url: str, next_page_num: int) -> Optional[str]:
    patterns = [
        re.compile(rf"page[/=-]{next_page_num}\b", re.IGNORECASE),
        re.compile(rf"[?&]page={next_page_num}\b", re.IGNORECASE),
        re.compile(rf"/{next_page_num}/?$", re.IGNORECASE),
    ]
    selectors = [
        "a[rel='next']",
        ".pagination a",
        ".pager a",
        ".nav-links a",
        ".page-numbers a",
    ]

    for selector in selectors:
        for link in soup.select(selector):
            href = (link.get("href") or "").strip()
            if not href:
                continue
            text = link.get_text(" ", strip=True).lower()
            classes = " ".join(link.get("class", [])).lower()
            aria = (link.get("aria-label") or "").lower()
            if (
                "next" in text
                or "next" in classes
                or "next" in aria
                or "older" in text
                or any(pattern.search(href) for pattern in patterns)
            ):
                if href.startswith("#"):
                    continue
                return urljoin(current_url, href)
    return None


def _page_link_hints(soup: BeautifulSoup, target_page_num: int) -> List[str]:
    hints: List[str] = []
    selectors = [
        ".pagination a",
        ".pager a",
        ".nav-links a",
        ".page-numbers a",
        "a[href]",
    ]
    for selector in selectors:
        for link in soup.select(selector):
            href = (link.get("href") or "").strip()
            text = link.get_text(" ", strip=True)
            data_page = (link.get("data-page") or "").strip()
            if not href and not data_page and text != str(target_page_num):
                continue
            if href and href.startswith("#"):
                continue
            if text == str(target_page_num) or data_page == str(target_page_num):
                if href:
                    hints.append(href)
    unique: List[str] = []
    for hint in hints:
        if hint not in unique:
            unique.append(hint)
    return unique


def _candidate_page_urls(base_url: str, page_num: int, current_url: str, hinted_url: Optional[str], soup: Optional[BeautifulSoup]) -> List[str]:
    candidates: List[str] = []

    def add(url: Optional[str]) -> None:
        if not url:
            return
        normalized = urljoin(current_url or base_url, url).strip()
        if not normalized or normalized.startswith("#"):
            return
        if "#" in normalized:
            normalized = normalized.split("#", 1)[0]
        if normalized not in candidates:
            candidates.append(normalized)

    add(hinted_url)
    if soup is not None:
        for hinted in _page_link_hints(soup, page_num):
            add(hinted)
    for fallback in _pagination_candidates(base_url, page_num):
        add(fallback)
    return candidates


def _parse_ajax_parameters(raw: str) -> Dict[str, str]:
    params: Dict[str, str] = {}
    text = (raw or "").strip()
    if not text:
        return params
    for chunk in text.split(";"):
        if ":" not in chunk:
            continue
        name_blob, value = chunk.split(":", 1)
        value = unquote(value).replace("+", " ").strip()
        for name in [part.strip() for part in name_blob.split("+") if part.strip()]:
            params[name] = value
    return params


def _find_ajax_pagination_params(soup: BeautifulSoup, target_page_num: int) -> Optional[Dict[str, str]]:
    # WhoresHub tag/category listings use the block id `list_videos_common_videos_list`,
    # while on-site search results use `list_videos_videos_list_search_result`. Match
    # any KVS ajax pagination link and carry its own block id through so the async
    # request targets the right block. (live-verified 2026-07-14)
    selectors = [
        "a[data-action='ajax'][data-block-id]",
        "a[data-action='ajax'][data-parameters]",
    ]

    next_candidate: Optional[Dict[str, str]] = None
    for selector in selectors:
        for link in soup.select(selector):
            text = link.get_text(" ", strip=True)
            classes = " ".join(link.get("class", [])).lower()
            href = (link.get("href") or "").strip()
            params = _parse_ajax_parameters(link.get("data-parameters") or "")
            if not params:
                continue
            block_id = (link.get("data-block-id") or "").strip()
            if block_id:
                params = {"__block_id": block_id, **params}
            if text == str(target_page_num):
                return params
            if (
                "next" in text.lower()
                or "next" in classes
                or link.find_parent("li", class_=re.compile(r"\bnext\b", re.IGNORECASE))
                or href == "#search"
            ) and next_candidate is None:
                next_candidate = params
        if next_candidate:
            return next_candidate
    return None


def _extract_from_listing(container, video_url: str, thumbnail_map: Dict[str, str] = None) -> Optional[Dict[str, Any]]:
    """
    Extract metadata from a video container element.
    
    Args:
        container: BeautifulSoup element (the div.thumb or similar)
        video_url: Full video page URL
        thumbnail_map: Optional dictionary mapping video IDs/URLs to thumbnail URLs
        
    Returns:
        Video metadata dict or None
    """
    try:
        if thumbnail_map is None:
            thumbnail_map = {}

        # Extract title - try multiple sources
        title = None
        
        # Method 1: Find link with title
        link = container.find('a', href=True)
        if link and link.get('title'):
            title = link.get('title').strip()
            
        # Method 2: Find description span
        if not title:
            desc_elem = container.find(['span', 'div'], class_=re.compile(r'description|title', re.IGNORECASE))
            if desc_elem:
                title = desc_elem.get_text().strip()
                
        # Method 3: alt text on image
        if not title:
            img = container.find('img')
            if img and img.get('alt'):
                title = img.get('alt').strip()
                
        # Method 4: Extract from URL
        if not title:
            parts = video_url.split('/')
            if len(parts) > 3:
                title_slug = parts[-1] if parts[-1] else parts[-2]
                title = title_slug.replace('-', ' ').replace('_', ' ').title()
        
        if not title:
            title = "WhoresHub Video"

        # Extract thumbnail
        thumbnail = None
        
        # Strategy 0: Check thumbnail map
        if thumbnail_map:
            for key in thumbnail_map:
                if key in video_url or video_url in key:
                    thumbnail = thumbnail_map[key]
                    break

        # Strategy 1: Check img tag
        if not thumbnail:
            img = container.find('img')
            if img:
                # Check ALL common lazy-load attributes
                thumbnail = (
                    img.get('data-src') or 
                    img.get('data-original') or 
                    img.get('data-lazy-src') or 
                    img.get('data-lazy') or 
                    img.get('data-thumb') or 
                    img.get('src')
                )
                
                # Skip placeholders
                if thumbnail and ('placeholder' in thumbnail.lower() or 'data:image' in thumbnail or 'blank.gif' in thumbnail):
                    thumbnail = None
                    # Try to find other images if this was a placeholder
                    other_imgs = container.find_all('img')
                    for other_img in other_imgs:
                        other_thumb = other_img.get('data-src') or other_img.get('data-original') or other_img.get('src')
                        if other_thumb and 'placeholder' not in other_thumb.lower() and 'data:image' not in other_thumb:
                            thumbnail = other_thumb
                            break

        # Clean up thumbnail URL
        if thumbnail:
            thumbnail = thumbnail.strip()
            if thumbnail.startswith('//'):
                thumbnail = f"https:{thumbnail}"
            elif not thumbnail.startswith('http'):
                thumbnail = f"https://whoreshub.com{thumbnail if thumbnail.startswith('/') else '/' + thumbnail}"

        # Extract duration - look for specific classes
        duration = 0
        duration_elem = container.find(['span', 'div', 'time'], class_=re.compile(r'duration|time|length', re.IGNORECASE))
        if duration_elem:
            duration_text = duration_elem.get_text().strip()
            # Match 00:00 or 0:00:00
            time_match = re.search(r'(\d+):(\d+)(?::(\d+))?', duration_text)
            if time_match:
                if time_match.group(3):  # HH:MM:SS
                    duration = int(time_match.group(1)) * 3600 + int(time_match.group(2)) * 60 + int(time_match.group(3))
                else:  # MM:SS
                    duration = int(time_match.group(1)) * 60 + int(time_match.group(2))

        # Extract quality
        resolution = 0
        quality_str = "Unknown"
        quality_elem = container.find(['span', 'div'], class_=re.compile(r'quality|hd|is-hd|badge', re.IGNORECASE))
        if quality_elem:
            quality_text = quality_elem.get_text().strip().upper()
            if '2160' in quality_text or '4K' in quality_text:
                resolution = 2160
                quality_str = "4K"
            elif '1440' in quality_text or '2K' in quality_text:
                resolution = 1440
                quality_str = "1440p"
            elif '1080' in quality_text:
                resolution = 1080
                quality_str = "1080p"
            elif '720' in quality_text or 'HD' in quality_text:
                resolution = 720
                quality_str = "720p"
            elif '480' in quality_text or 'SD' in quality_text:
                resolution = 480
                quality_str = "480p"

        # Extract views
        views = 0
        views_elem = container.find(['span', 'div'], class_=re.compile(r'views?|watch', re.IGNORECASE))
        if views_elem:
            views_text = views_elem.get_text().strip()
            views_match = re.search(r'(\d+(?:,\d+)*(?:\.\d+)?)\s*([KMB])?', views_text, re.IGNORECASE)
            if views_match:
                try:
                    num = float(views_match.group(1).replace(',', ''))
                    multiplier = views_match.group(2)
                    if multiplier:
                        mult_upper = multiplier.upper()
                        if mult_upper == 'K': num *= 1000
                        elif mult_upper == 'M': num *= 1000000
                    views = int(num)
                except: pass

        upload_type = "studio"
        if '/user/' in video_url or '/users/' in video_url or '/amateur/' in video_url:
            upload_type = "user"

        return {
            "url": video_url,
            "title": title,
            "thumbnail": thumbnail,
            "duration": duration,
            "quality": quality_str,
            "resolution": resolution,
            "views": views,
            "upload_type": upload_type,
            "stream_url": None
        }
    except Exception as e:
        logger.error(f"[WHORESHUB_DISCOVERY] Extraction failed: {e}")
        return None



def _passes_filters(
    video: Dict[str, Any],
    min_quality: int,
    min_duration: int,
    upload_type: str,
    keyword: str = "",
    auto_skip_low_quality: bool = True,
) -> bool:
    """
    Check if video passes all filter criteria.
    NOTE: For discovery mode, we're lenient on quality/duration since listing pages
    may not have complete metadata. The actual filtering happens during import.

    Args:
        video: Video metadata dict
        min_quality: Minimum resolution (e.g., 720, 1080)
        min_duration: Minimum duration in seconds
        upload_type: "all", "user", or "studio"
        keyword: Optional keyword filter

    Returns:
        True if video passes all filters
    """
    # Must have URL
    if not video.get('url'):
        return False

    # Quality filter:
    # - if listing exposes explicit resolution, respect it strictly
    # - if listing has no usable resolution and caller asked for aggressive skipping,
    #   drop unknown-quality rows instead of pretending they are HD
    resolution = video.get('resolution', 0)
    if min_quality > 0:
        if resolution > 0 and resolution < min_quality:
            return False
        if resolution <= 0 and auto_skip_low_quality:
            return False

    # Duration filter - LENIENT: Only filter if we KNOW it's too short
    # If duration is 0, let it through - we'll check during import
    duration = video.get('duration', 0)
    if duration > 0 and duration < min_duration:
        return False

    # Upload type filter - STRICT: This can be determined from URL
    if upload_type != "all":
        if video.get('upload_type') != upload_type:
            return False

    # Keyword filter - not applicable if already searched by keyword
    # Skip this filter since the search already includes the keyword

    return True


def scrape_whoreshub_discovery(
    keyword: str = "",
    tag: str = "",
    min_quality: int = 720,
    min_duration: int = 300,  # 5 minutes default
    pages: int = 1,
    upload_type: str = "all",
    auto_skip_low_quality: bool = True,
    sort_by: str = "post_date",
) -> List[Dict[str, Any]]:
    """
    Discover videos from WhoresHub with filtering.

    sort_by controls the WhoresHub listing order. The site's default order for
    a tag/category is *not* upload date (small categories like 4K surface old
    videos first), so we default to "post_date" to get genuinely newest first.
    Supported: post_date (newest), post_date_asc (oldest), most_viewed, rating,
    duration. Anything else is passed through to the site verbatim.
    """
    logger.info(f"[WHORESHUB_DISCOVERY] Starting scrape: keyword='{keyword}', tag='{tag}', min_quality={min_quality}p, pages={pages}, sort_by='{sort_by}'")

    # Map friendly aliases to WhoresHub/KVS sort_by values.
    _SORT_MAP = {
        "newest": "post_date",
        "new": "post_date",
        "recent": "post_date",
        "latest": "post_date",
        "oldest": "post_date_asc",
        "views": "most_viewed",
        "most_viewed": "most_viewed",
        "popularity": "most_viewed",
        "rating": "rating",
        "top_rated": "rating",
        "duration": "duration",
        "longest": "duration",
    }
    sort_param = _SORT_MAP.get((sort_by or "").strip().lower(), (sort_by or "post_date").strip() or "post_date")

    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://whoreshub.com/'
    }

    # Determine base URL based on search type
    base_url = None
    if keyword:
        search_slug = keyword.strip().lower().replace(' ', '-')
        base_url = f"https://whoreshub.com/search/{search_slug}/"
    elif tag:
        tag_slug = tag.strip().lower().replace(' ', '-')
        base_url = f"https://whoreshub.com/tags/{tag_slug}/"
    else:
        base_url = "https://whoreshub.com/"

    # Append the sort order so the listing returns genuinely newest-first
    # instead of the site's default category order (which surfaces old videos).
    if sort_param:
        base_url = f"{base_url}?sort_by={sort_param}"

    all_videos = []
    seen_urls = set()
    pages = min(max(1, pages), 50)

    # Use a session for connection pooling
    session = requests.Session()
    session.headers.update(headers)

    next_page_url = base_url
    last_successful_page_url = base_url
    last_soup: Optional[BeautifulSoup] = None
    for page_num in range(1, pages + 1):
        try:
            accepted_page = False
            accepted_soup: Optional[BeautifulSoup] = None
            accepted_final_url: Optional[str] = None
            accepted_page_count = 0
            if page_num == 1:
                candidate_requests = [{"mode": "page", "url": base_url}]
            else:
                ajax_params = _find_ajax_pagination_params(last_soup, page_num) if last_soup else None
                candidate_requests = []
                if ajax_params:
                    candidate_requests.append({"mode": "ajax", "params": ajax_params})
                for candidate_url in _candidate_page_urls(
                    base_url,
                    page_num,
                    last_successful_page_url or base_url,
                    next_page_url,
                    last_soup,
                ):
                    candidate_requests.append({"mode": "page", "url": candidate_url})

            for candidate in candidate_requests:
                candidate_mode = candidate.get("mode")
                try:
                    if candidate_mode == "ajax":
                        candidate_params = dict(candidate.get("params") or {})
                        # Block id is carried from the pagination link when present so
                        # tag/category (list_videos_common_videos_list) and search
                        # (list_videos_videos_list_search_result) both work.
                        block_id = candidate_params.pop("__block_id", "list_videos_common_videos_list")
                        request_params = {
                            "mode": "async",
                            "function": "get_block",
                            "block_id": block_id,
                            **candidate_params,
                        }
                        # Send to the path part only; sort_by/from live in request_params.
                        ajax_base = _split_query(base_url)[0]
                        logger.info(f"[WHORESHUB_DISCOVERY] Fetching page {page_num}/{pages} via ajax: {request_params}")
                        attempt = session.get(ajax_base, params=request_params, timeout=10, allow_redirects=True)
                        candidate_label = f"{ajax_base}?mode=async&page={page_num}"
                    else:
                        candidate_url = candidate.get("url") or base_url
                        logger.info(f"[WHORESHUB_DISCOVERY] Fetching page {page_num}/{pages}: {candidate_url}")
                        attempt = session.get(candidate_url, timeout=10, allow_redirects=True)
                        candidate_label = candidate_url
                except Exception as exc:
                    logger.warning(f"[WHORESHUB_DISCOVERY] Candidate page failed {candidate}: {exc}")
                    continue

                if attempt.status_code != 200:
                    logger.warning(f"[WHORESHUB_DISCOVERY] Candidate page returned {attempt.status_code}: {candidate_label}")
                    continue

                final_page_url = attempt.url or candidate_label
                cleaned_final_url = final_page_url.split("#", 1)[0]
                if candidate_mode == "page" and page_num > 1 and cleaned_final_url.rstrip("/") == (last_successful_page_url or "").split("#", 1)[0].rstrip("/"):
                    logger.info(f"[WHORESHUB_DISCOVERY] Candidate resolved to same URL as previous page, skipping: {final_page_url}")
                    continue

                soup = BeautifulSoup(attempt.text, 'html.parser')

                # Extract thumbnail mapping from page JavaScript
                thumbnail_map = {}
                for script in soup.find_all('script'):
                    script_text = script.string if script.string else ""
                    json_matches = re.findall(r'\{[^{}]*"thumb[^:]*":\s*"([^"]+)"[^{}]*"(?:id|url|href)[^:]*":\s*"([^"]+)"[^{}]*\}', script_text, re.IGNORECASE)
                    for thumb_url, video_id in json_matches:
                        if thumb_url and video_id:
                            thumbnail_map[video_id] = thumb_url

                # Find video cards
                video_cards = soup.find_all('div', class_=re.compile(r'thumb|item|video-card', re.IGNORECASE))
                if not video_cards:
                    links = soup.find_all('a', href=re.compile(r'/videos?/'))
                    unique_links = {}
                    for l in links:
                        u = l.get('href')
                        if u and u not in unique_links:
                            unique_links[u] = l
                    video_cards = list(unique_links.values())

                logger.info(f"[WHORESHUB_DISCOVERY] Processing {len(video_cards)} items on page {page_num}")

                page_results: List[Dict[str, Any]] = []
                page_urls_seen = set()
                for card in video_cards:
                    link = card if card.name == 'a' else card.find('a', href=re.compile(r'/videos?/'))
                    if not link:
                        continue

                    href = link.get('href', '')
                    if not href:
                        continue

                    video_url = href if href.startswith('http') else f"https://whoreshub.com{href if href.startswith('/') else '/' + href}"
                    if video_url in page_urls_seen:
                        continue
                    page_urls_seen.add(video_url)

                    if video_url in seen_urls:
                        continue

                    metadata = _extract_from_listing(card, video_url, thumbnail_map)
                    if metadata:
                        page_results.append(metadata)

                if page_num > 1 and not page_results:
                    logger.info(f"[WHORESHUB_DISCOVERY] Candidate produced no new videos, trying next variant: {candidate_label}")
                    continue

                for metadata in page_results:
                    seen_urls.add(metadata["url"])
                    all_videos.append(metadata)

                accepted_page = True
                accepted_soup = soup
                accepted_final_url = cleaned_final_url
                accepted_page_count = len(page_results)
                break
            if not accepted_page:
                logger.info(f"[WHORESHUB_DISCOVERY] No valid page variant produced new results for page {page_num}.")
                break

            logger.info(f"[WHORESHUB_DISCOVERY] Page {page_num} done. Added {accepted_page_count} videos.")
            last_soup = accepted_soup
            last_successful_page_url = accepted_final_url or last_successful_page_url
            next_page_url = _extract_next_page_url(accepted_soup, accepted_final_url or base_url, page_num + 1)
            if page_num < pages and not next_page_url:
                fallback_candidates = _pagination_candidates(base_url, page_num + 1)
                next_page_url = fallback_candidates[0] if fallback_candidates else None

        except Exception as e:
            logger.error(f"[WHORESHUB_DISCOVERY] Error on page {page_num}: {e}")
            continue

    # Apply filters
    filtered_results = [
        v for v in all_videos
        if _passes_filters(v, min_quality, min_duration, upload_type, keyword, auto_skip_low_quality)
    ]
    
    logger.info(f"[WHORESHUB_DISCOVERY] Discovery finished: {len(filtered_results)} matching videos found (Total scanned: {len(all_videos)})")
    return filtered_results
