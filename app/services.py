import os
import ffmpeg
import concurrent.futures
import urllib.parse
from typing import Optional
import glob
import logging
import subprocess
from sqlalchemy.orm import Session
from .database import Video, SessionLocal
from .media_urls import is_pimpbunny_remote_media
from .websockets import manager # Import the manager
import re
import requests
from bs4 import BeautifulSoup
import time
import httpx
import json
import shutil
import asyncio
import sys
import threading
import urllib.parse
from collections import Counter

logger = logging.getLogger(__name__)


def _gofile_metadata_url(video_url: str, source_url: str) -> str:
    """Choose the GoFile page that represents this one library card.

    Album imports intentionally preserve the shared album URL in ``source_url``
    for lineage.  Each child card, however, has its own ``/d/<file-id>`` page in
    ``video_url``.  Resolving against the album page makes GoFile return its
    first child for every card, replacing all streams, titles and thumbnails
    with that first video.
    """
    child_id = GoFileExtractor._extract_content_id(video_url or "")
    source_id = GoFileExtractor._extract_content_id(source_url or "")
    if child_id and child_id != source_id:
        return video_url
    return source_url or video_url

# Ensure we can import from the root extractors and archivist
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from .extractors.bunkr import BunkrExtractor
from .extractors.gofile import GoFileExtractor
from .extractors.turbo import TurboExtractor
from app.extractors.legacy.generic import PixeldrainExtractor
from scripts.archivist import Archivist

# --- Eporner API import ---
def fetch_eporner_videos(query=None, page=1, per_page=20, tags=None, gay=None, hd=None, pornstar=None, order=None):
    base_url = "https://www.eporner.com/api/v2/video/search/"
    params = { "query": query or "", "per_page": per_page, "page": page }
    if tags: params["tags"] = tags
    if gay is not None: params["gay"] = int(bool(gay))
    if hd is not None: params["hd"] = int(bool(hd))
    if pornstar: params["pornstar"] = pornstar
    if order: params["order"] = order
    try:
        resp = requests.get(base_url, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logging.error(f"Eporner API Error: {e}")
        return []

    videos = []
    for v in data.get("videos", []):
        duration = v.get("length_sec")
        if not duration and v.get("length_min"):
            try:
                # If length_min is "10:30", convert to seconds
                parts = str(v.get("length_min")).split(':')
                if len(parts) == 2:
                    duration = int(parts[0]) * 60 + int(parts[1])
                else:
                    duration = int(v.get("length_min")) * 60
            except:
                duration = v.get("length_min")

        videos.append({
            "title": v.get("title"),
            "url": v.get("url"),
            "thumbnail": v.get("default_thumb", {}).get("src") if isinstance(v.get("default_thumb"), dict) else v.get("default_thumb"),
            "video_url": None,
            "duration": duration,
            "quality": "HD" if v.get("hd") else "SD",
            "embed_url": v.get("embed")
        })
    return videos

# --- Eporner Smart Discovery (HTML Scraping) ---
def scrape_eporner_discovery(keyword: str, min_quality: int = 1080, min_duration: int = 0, max_duration: int = 0, search_terms: str = "", pages: int = 2, auto_skip_low_quality: bool = True):
    """
    Scrapes Eporner tag/search pages directly via HTML parsing.
    Does NOT use the Eporner API.
    
    Args:
        keyword: Tag or search term (e.g., "bbc sloppy")
        min_quality: Minimum resolution in pixels (720, 1080, 1440, 2160)
        min_duration: Minimum video duration in seconds
        max_duration: Maximum video duration in seconds
        search_terms: Additional title/keyword filter for search results
        pages: Number of pages to scrape
        auto_skip_low_quality: If True, filter out videos below min_quality
    
    Returns:
        List of video dictionaries with metadata
    """
    results = []
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://www.eporner.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    }
    
    # Determine mode and base URL
    is_tag_mode = keyword.lower().startswith('tag:')
    clean_keyword = keyword[4:].strip() if is_tag_mode else keyword.strip()
    
    if is_tag_mode:
        tag_slug = clean_keyword.lower().replace(' ', '-').replace('_', '-')
        base_url = f"https://www.eporner.com/tag/{tag_slug}/"
        logging.info(f"[EPORNER_DISCOVERY] Mode: TAG | Tag: '{tag_slug}'")
    else:
        search_slug = clean_keyword.replace(' ', '+')
        base_url = f"https://www.eporner.com/search/{search_slug}/"
        logging.info(f"[EPORNER_DISCOVERY] Mode: SEARCH | Query: '{clean_keyword}'")
    
    logging.info(f"[EPORNER_DISCOVERY] Starting scrape (min_quality={min_quality}p, pages={pages})")
    
    for page_num in range(1, pages + 1):
        try:
            # Construct page URL
            if is_tag_mode:
                page_url = f"{base_url}?p={page_num}" if page_num > 1 else base_url
            else:
                page_url = f"{base_url}{page_num}/" if page_num > 1 else base_url
            
            logging.info(f"[EPORNER_DISCOVERY] Fetching page {page_num}: {page_url}")
            
            # FAST MODE: No delays, maximum speed
            resp = requests.get(page_url, headers=headers, timeout=15)
            
            if resp.status_code != 200:
                logging.error(f"[EPORNER_DISCOVERY] Page {page_num} returned status {resp.status_code}")
                continue
            
            soup = BeautifulSoup(resp.text, 'html.parser')
            
            # Find all video containers
            # Eporner uses div.mb with data-id attribute for each video
            video_containers = soup.find_all('div', class_='mb')
            
            if not video_containers:
                logging.warning(f"[EPORNER_DISCOVERY] No videos found on page {page_num}")
                continue
            
            logging.info(f"[EPORNER_DISCOVERY] Found {len(video_containers)} videos on page {page_num}")
            
            for container in video_containers:
                try:
                    # Extract video page URL
                    link_tag = container.find('a', href=True)
                    if not link_tag:
                        continue
                    
                    video_url = link_tag['href']
                    if not video_url.startswith('http'):
                        video_url = f"https://www.eporner.com{video_url}"
                    
                    # Extract title - try multiple methods
                    title = None
                    
                    # Method 1: Look for title in link tag
                    if link_tag.get('title'):
                        title = link_tag.get('title').strip()
                    
                    # Method 2: Look for title div/span (mbtit or mbt)
                    if not title or title == '':
                        # Search for mbtit OR mbt classes
                        title_tag = container.find('div', class_=re.compile(r'mbt(it)?'))
                        if title_tag:
                            title = title_tag.get_text().strip()
                    
                    # Method 3: Look in any h3, h4, or strong tag
                    if not title or title == '':
                        for tag_name in ['h3', 'h4', 'strong', 'b']:
                            title_tag = container.find(tag_name)
                            if title_tag and title_tag.get_text().strip():
                                title = title_tag.get_text().strip()
                                break
                    
                    # Method 4: Extract from URL slug
                    if not title or title == '' or title == 'Unknown' or title.lower() == 'https':
                        # Extract title from URL like /video-xxxxx/title-here/
                        try:
                            # Remove protocol and domain
                            url_path = video_url.replace('https://', '').replace('http://', '')
                            if '/' in url_path:
                                url_path = '/' + '/'.join(url_path.split('/')[1:])  # Remove domain
                            
                            url_parts = url_path.split('/')
                            for part in url_parts:
                                # Skip empty, 'video-xxxxx', domain parts, and short parts
                                if part and not part.startswith('video-') and 'eporner.com' not in part and len(part) > 5:
                                    title = part.replace('-', ' ').replace('_', ' ').title()
                                    break
                        except:
                            pass
                    
                    # Fallback
                    if not title or title == '' or title.lower() == 'https':
                        title = 'Eporner Video'
                    
                    # Extract thumbnail (lazy-loaded via data-src)
                    img_tag = container.find('img')
                    thumbnail = None
                    if img_tag:
                        thumbnail = img_tag.get('data-src') or img_tag.get('src')
                        if thumbnail and not thumbnail.startswith('http'):
                            thumbnail = f"https:{thumbnail}" if thumbnail.startswith('//') else f"https://www.eporner.com{thumbnail}"
                    
                    # Extract duration - try multiple methods
                    duration_seconds = 0
                    duration_str = None
                    
                    # Method 1: Look for duration div/span
                    duration_tag = container.find('div', class_='mbtim')
                    if not duration_tag:
                        duration_tag = container.find('span', class_='dur')
                    if not duration_tag:
                        duration_tag = container.find('div', class_='duration')
                    if not duration_tag:
                        duration_tag = container.find('span', class_='duration')
                    
                    if duration_tag:
                        duration_str = duration_tag.text.strip()
                    
                    # Method 2: Search for time pattern in container text
                    if not duration_str:
                        container_text = container.get_text()
                        # Look for patterns like "12:34" or "1:23:45"
                        time_match = re.search(r'(\d{1,2}):(\d{2})(?::(\d{2}))?', container_text)
                        if time_match:
                            duration_str = time_match.group(0)
                    
                    # Parse duration string
                    if duration_str:
                        try:
                            # Parse MM:SS or HH:MM:SS
                            parts = duration_str.split(':')
                            if len(parts) == 3:  # HH:MM:SS
                                duration_seconds = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                            elif len(parts) == 2:  # MM:SS
                                duration_seconds = int(parts[0]) * 60 + int(parts[1])
                        except:
                            pass
                    
                    # Extract quality label - try multiple methods with debug logging
                    quality_str = 'SD'
                    quality_tag = None
                    resolution = 480  # Default SD
                    
                    # Method 1: Look for quality badge/label with various class names
                    quality_tag = container.find('div', class_='mbqual')
                    if not quality_tag:
                        quality_tag = container.find('span', class_='hd')
                    if not quality_tag:
                        quality_tag = container.find('div', class_='hd')
                    if not quality_tag:
                        quality_tag = container.find('span', class_='quality')
                    if not quality_tag:
                        quality_tag = container.find('div', class_='quality')
                    
                    if quality_tag:
                        quality_str = quality_tag.get_text().strip()
                        logging.debug(f"[EPORNER_DISCOVERY] Found quality tag: '{quality_str}'")
                    else:
                        # Method 2: Search entire container HTML for quality indicators
                        container_html = str(container).upper()
                        
                        # Look for quality in HTML attributes or text
                        if '4K' in container_html or '2160P' in container_html:
                            quality_str = '4K'
                            resolution = 2160
                        elif '1440P' in container_html or '2K' in container_html:
                            quality_str = '1440p'
                            resolution = 1440
                        elif '1080P' in container_html or 'FHD' in container_html:
                            quality_str = '1080p'
                            resolution = 1080
                        elif '720P' in container_html or 'HD' in container_html:
                            quality_str = '720p'
                            resolution = 720
                        
                        logging.debug(f"[EPORNER_DISCOVERY] No quality tag, inferred from HTML: '{quality_str}' ({resolution}p)")
                    
                    # Parse quality string to resolution if not already set
                    if resolution == 480 and quality_str != 'SD':
                        if '4K' in quality_str.upper() or '2160' in quality_str:
                            resolution = 2160
                        elif '1440' in quality_str or '2K' in quality_str.upper():
                            resolution = 1440
                        elif '1080' in quality_str or 'FHD' in quality_str.upper():
                            resolution = 1080
                        elif '720' in quality_str or 'HD' in quality_str.upper():
                            resolution = 720
                    
                    # Extract upload date (if available)
                    upload_date = None
                    date_tag = container.find('div', class_='mbdate')
                    if not date_tag:
                        date_tag = container.find('span', class_='date')
                    if not date_tag:
                        date_tag = container.find('div', class_='added')
                    if not date_tag:
                        # Try to find date in container text (e.g., "Added: 2 days ago", "1 week ago")
                        container_text = container.get_text()
                        date_patterns = [
                            r'(\d+)\s*(day|days|week|weeks|month|months|year|years)\s*ago',
                            r'Added:\s*(.+?)(?:\n|$)',
                            r'(\d{4}-\d{2}-\d{2})',  # YYYY-MM-DD
                            r'(\d{1,2}/\d{1,2}/\d{4})'  # MM/DD/YYYY
                        ]
                        for pattern in date_patterns:
                            match = re.search(pattern, container_text, re.IGNORECASE)
                            if match:
                                upload_date = match.group(0).strip()
                                break
                    else:
                        upload_date = date_tag.text.strip()
                    
                    # Extract rating and views (if available)
                    rating = None
                    views = None
                    rating_tag = container.find('div', class_='mbrate')
                    if rating_tag:
                        rating_text = rating_tag.text.strip()
                        try:
                            rating = int(re.search(r'(\d+)%', rating_text).group(1))
                        except:
                            pass
                    
                    views_tag = container.find('div', class_='mbvie')
                    if views_tag:
                        views_text = views_tag.text.strip()
                        try:
                            # Parse "1.2M" or "500K" format
                            if 'M' in views_text:
                                views = int(float(views_text.replace('M', '').strip()) * 1000000)
                            elif 'K' in views_text:
                                views = int(float(views_text.replace('K', '').strip()) * 1000)
                            else:
                                views = int(re.sub(r'[^\d]', '', views_text))
                        except:
                            pass
                    
                    # Determine if video matches filter criteria
                    matches_quality = resolution >= min_quality
                    matches_min_duration = (min_duration <= 0 or duration_seconds >= min_duration)
                    matches_max_duration = (max_duration <= 0 or duration_seconds <= max_duration)
                    matches_search = True
                    if search_terms:
                        search_text = (title or '').lower()
                        matches_search = all(term.strip() in search_text for term in search_terms.lower().split() if term.strip())

                    matched = matches_quality and matches_min_duration and matches_max_duration and matches_search

                    # Skip if auto_skip_low_quality is enabled AND quality doesn't match
                    if auto_skip_low_quality and not matches_quality:
                        logging.debug(f"[EPORNER_DISCOVERY] Skipping '{title}' ({resolution}p < {min_quality}p)")
                        continue
                    
                    # If the search_terms or duration filters are present, skip non-matching videos as well
                    if not matches_min_duration:
                        logging.debug(f"[EPORNER_DISCOVERY] Skipping '{title}' duration {duration_seconds}s < {min_duration}s")
                        continue
                    if not matches_max_duration:
                        logging.debug(f"[EPORNER_DISCOVERY] Skipping '{title}' duration {duration_seconds}s > {max_duration}s")
                        continue
                    if search_terms and not matches_search:
                        logging.debug(f"[EPORNER_DISCOVERY] Skipping '{title}' because it does not match search terms '{search_terms}'")
                        continue

                    video_data = {
                        'title': title,
                        'url': video_url,
                        'source_url': video_url,
                        'thumbnail': thumbnail,
                        'duration': duration_seconds,
                        'quality': quality_str,
                        'resolution': resolution,
                        'rating': rating,
                        'views': views,
                        'upload_date': upload_date,
                        'origin_keyword': keyword,
                        'matched': matched
                    }
                    
                    results.append(video_data)
                    
                    # Debug: Log first video from each page
                    if len(results) == 1 or (len(results) - 1) % 100 == 0:
                        logging.info(f"[EPORNER_DISCOVERY] Sample: '{title}' | Duration: {duration_seconds}s | Quality: {quality_str} ({resolution}p) | Matched: {matched}")
                    
                    
                except Exception as e:
                    logging.error(f"[EPORNER_DISCOVERY] Error parsing video container: {e}")
                    continue
            
        except Exception as e:
            logging.error(f"[EPORNER_DISCOVERY] Error fetching page {page_num}: {e}")
            continue
    
    # Remove duplicates based on URL
    unique_results = []
    seen_urls = set()
    
    for video in results:
        if video['url'] not in seen_urls:
            seen_urls.add(video['url'])
            unique_results.append(video)
            
    matched_count = sum(1 for v in unique_results if v.get('matched', False))
    logging.info(f"[EPORNER_DISCOVERY] Scrape complete: {matched_count}/{len(unique_results)} unique videos matched quality filter")
    
    return unique_results

# --- Konfigurácia ---

APP_DIR = os.path.dirname(os.path.abspath(__file__))
THUMB_DIR = os.path.join(APP_DIR, "static", "thumbnails")
PREVIEW_DIR = os.path.join(APP_DIR, "static", "previews")
SUBTITLE_DIR = os.path.join(APP_DIR, "static", "subtitles")
os.makedirs(THUMB_DIR, exist_ok=True)
os.makedirs(PREVIEW_DIR, exist_ok=True)
os.makedirs(SUBTITLE_DIR, exist_ok=True)


def _has_usable_thumbnail_path(value, video_id: int) -> bool:
    from .telegram_service import is_telegram_thumbnail_path

    thumb_value = (value or "").strip()
    if not thumb_value:
        return False
    if thumb_value.startswith(("data:", "http://", "https://")):
        return True
    if is_telegram_thumbnail_path(thumb_value):
        return True
    if thumb_value.startswith("/static/"):
        return os.path.exists(f"app{thumb_value.split('?')[0]}")
    return False


def _preserve_telegram_video_for_preview(video, video_id: int) -> bool:
    from .telegram_service import (
        _pair_from_text,
        library_telegram_stream_path,
        telegram_thumb_path,
    )

    stream_path = library_telegram_stream_path(video)
    if not stream_path:
        return False

    pair = _pair_from_text(stream_path)
    if not pair:
        return False

    video.url = stream_path
    video.telegram_chat_id = str(pair[0])
    video.telegram_message_id = pair[1]
    video.storage_type = "telegram"
    if not _has_usable_thumbnail_path(video.thumbnail_path, video_id):
        video.thumbnail_path = telegram_thumb_path(*pair)
    if video.status in {"pending", "processing"}:
        video.status = "ready_to_stream"
        video.error_msg = None
    video.preview_retry_needed = False
    video.preview_retry_count = 0
    video.preview_last_error = None
    return True


# Auto-install/setup ffmpeg paths
try:
    import static_ffmpeg
    static_ffmpeg.add_paths()
    logging.info("static-ffmpeg paths added.")
except ImportError:
    logging.warning("static-ffmpeg not installed, relying on system PATH.")

# FFMPEG is missing from local dir, assuming system PATH
FFMPEG_CMD = 'ffmpeg'
FFPROBE_CMD = 'ffprobe'

# Only warn if system command fails basic check
if not shutil.which(FFMPEG_CMD):
    logging.warning(f"CRITICAL WARNING: ffmpeg not found in system PATH.")

FFMPEG_NETWORK_ARGS = [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
    '-timeout', '20000000', '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
]


async def run_subprocess_capture(cmd, timeout: float = 30):
    """Run a subprocess and return (returncode, stdout_bytes, stderr_bytes).

    Uses subprocess.run in a worker thread instead of
    asyncio.create_subprocess_exec: under `uvicorn --reload` (and multi-worker)
    on Windows the request-handler loop is a SelectorEventLoop, where
    create_subprocess_exec raises NotImplementedError — which silently broke every
    ffprobe/ffmpeg call (missing duration/height/thumbnails on import). subprocess
    .run works under any event loop. Returns (-1, b"", b"<error>") on failure.
    """
    import subprocess as _sp

    def _blocking():
        try:
            p = _sp.run(cmd, stdout=_sp.PIPE, stderr=_sp.PIPE, timeout=timeout)
            return p.returncode, p.stdout or b"", p.stderr or b""
        except _sp.TimeoutExpired:
            return -1, b"", b"timeout"
        except Exception as exc:  # noqa: BLE001
            return -1, b"", str(exc).encode("utf-8", "ignore")

    return await asyncio.to_thread(_blocking)

NLP = None
_NLP_LOADED = False


def _get_nlp():
    global NLP, _NLP_LOADED
    if not _NLP_LOADED:
        _NLP_LOADED = True
        try:
            import spacy
            NLP = spacy.load('en_core_web_sm')
        except (ImportError, OSError) as e:
            logging.warning("spaCy unavailable (AI noun tags disabled): %s", e)
            NLP = None
    return NLP

# --- Helper Functions ---

def calculate_aspect_ratio(width: int, height: int) -> Optional[str]:
    """
    Calculate aspect ratio from video dimensions.

    Args:
        width: Video width in pixels
        height: Video height in pixels

    Returns:
        Aspect ratio string (e.g., "16:9", "9:16") or None if invalid dimensions
    """
    if not width or not height or width <= 0 or height <= 0:
        return None

    ratio = width / height

    # Common aspect ratios with tolerance ranges
    # Landscape ratios
    if 2.3 <= ratio <= 2.5:
        return "21:9"  # Ultra-wide
    elif 1.85 <= ratio <= 1.95:
        return "2:1"  # Univisium
    elif 1.7 <= ratio <= 1.8:
        return "16:9"  # HD Standard
    elif 1.55 <= ratio <= 1.68:
        return "5:3"  # Common video
    elif 1.3 <= ratio <= 1.35:
        return "4:3"  # SD Standard

    # Portrait ratios (vertical)
    elif 0.55 <= ratio <= 0.58:
        return "9:16"  # Vertical HD (TikTok, Stories)
    elif 0.52 <= ratio <= 0.54:
        return "9:19.5"  # Full-screen mobile
    elif 0.73 <= ratio <= 0.78:
        return "3:4"  # Vertical SD

    # Square
    elif 0.95 <= ratio <= 1.05:
        return "1:1"  # Square (Instagram)

    # If doesn't match common ratios, return calculated ratio
    from math import gcd
    divisor = gcd(width, height)
    return f"{width // divisor}:{height // divisor}"

# --- Hlavná trieda ---

class VIPVideoProcessor:
    # Shared across processor instances. A large album import used to start one
    # ffprobe and one ffmpeg per video at the same time; each probe reads up to
    # 15 MB and each visual pass decodes a stream. Two of each is enough to
    # overlap network wait without saturating CPU or RAM.
    _shared_ffprobe_gate_obj = None
    _shared_visual_gate_obj = None

    @classmethod
    def shared_ffprobe_gate(cls) -> asyncio.Semaphore:
        if cls._shared_ffprobe_gate_obj is None:
            cls._shared_ffprobe_gate_obj = asyncio.Semaphore(2)
        return cls._shared_ffprobe_gate_obj

    @classmethod
    def shared_visual_gate(cls) -> asyncio.Semaphore:
        if cls._shared_visual_gate_obj is None:
            cls._shared_visual_gate_obj = asyncio.Semaphore(2)
        return cls._shared_visual_gate_obj

    _webshare_lock = threading.Lock()
    async def _broadcast_status(self, video_id: int, status: str, extra_data: dict = None):
        message = {"type": "status_update", "video_id": video_id, "status": status}
        if extra_data:
            message.update(extra_data)
        await manager.broadcast(json.dumps(message))

    def log_sync(self, message: str, level: str = "info"):
        """A synchronous helper to call the async manager.log"""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # 'RuntimeError: There is no current event loop...'
            loop = None

        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(manager.log(message, level), loop)
        else:
            asyncio.run(manager.log(message, level))

    def broadcast_sync(self, video_id: int, status: str, extra_data: dict = None):
        """Robust broadast helper that handles event loops safely"""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(self._broadcast_status(video_id, status, extra_data), loop)
            else:
                loop.run_until_complete(self._broadcast_status(video_id, status, extra_data))
        except:
            # Fallback for background threads
            try:
                new_loop = asyncio.new_event_loop()
                new_loop.run_until_complete(self._broadcast_status(video_id, status, extra_data))
                new_loop.close()
            except: pass

    def broadcast_new_video(self, video):
        """Broadcasts a newly created video to the frontend."""
        data = {
            "type": "new_video",
            "video": {
                "id": video.id,
                "title": video.title,
                "url": video.url,
                "thumbnail_path": video.thumbnail_path or "/static/placeholder.jpg",
                "duration": video.duration or 0,
                "status": video.status,
                "batch_name": video.batch_name,
                "storage_type": video.storage_type or "remote",
                "created_at": video.created_at.isoformat() if video.created_at else None,
                "tags": video.tags or "",
                "ai_tags": video.ai_tags or "",
                "height": video.height or 0,
                "width": video.width or 0,
                "file_size_mb": float(video.file_size_mb or 0),
                "download_stats": video.download_stats,
                "resume_time": video.resume_time or 0
            }
        }
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(manager.broadcast(json.dumps(data)), loop)
            else:
                loop.run_until_complete(manager.broadcast(json.dumps(data)))
        except:
            try:
                new_loop = asyncio.new_event_loop()
                new_loop.run_until_complete(manager.broadcast(json.dumps(data)))
                new_loop.close()
            except: pass

    async def process_batch(self, video_ids: list[int]):
        """
        Process multiple videos with a concurrency limit (Fix 2).
        """
        max_workers = 4
        try:
            db = SessionLocal()
            eporner_count = db.query(Video).filter(
                Video.id.in_(video_ids),
                Video.source_url.isnot(None),
                Video.source_url.contains("eporner.com")
            ).count()
            if eporner_count:
                max_workers = 2
        except Exception:
            pass
        finally:
            try:
                db.close()
            except Exception:
                pass
        semaphore = asyncio.Semaphore(max_workers)

        async def process_with_limit(video_id):
            async with semaphore:
                from .config import config
                timeout = int(getattr(config, "INTAKE_ITEM_TIMEOUT_SECONDS", 90) or 90)
                try:
                    await asyncio.wait_for(self.process_single_video(video_id), timeout=timeout)
                except asyncio.TimeoutError:
                    message = f"Processing timed out after {timeout}s; retry from the dashboard."
                    logging.warning("[BulkImport] video %s %s", video_id, message)
                    db = SessionLocal()
                    try:
                        video = db.query(Video).filter(Video.id == video_id).first()
                        if video and video.status in {"pending", "processing"}:
                            video.status = "error"
                            video.error_msg = message
                            video.preview_retry_needed = True
                            db.commit()
                    finally:
                        db.close()
                    await self._broadcast_status(video_id, "error", {"error": message})

        tasks = [process_with_limit(vid) for vid in video_ids]
        await asyncio.gather(*tasks, return_exceptions=True)

    _active_processing_ids = set()

    async def process_single_video(self, video_id, force=False, quality_mode="mp4", extractor="auto"):
        if video_id in VIPVideoProcessor._active_processing_ids:
            logging.info(f"Video {video_id} is already being processed by another worker. Skipping duplicate.")
            return
        VIPVideoProcessor._active_processing_ids.add(video_id)
        try:
            return await self._process_single_video_internal(video_id, force, quality_mode, extractor)
        finally:
            VIPVideoProcessor._active_processing_ids.discard(video_id)

    async def _process_single_video_internal(self, video_id, force=False, quality_mode="mp4", extractor="auto"):
        import time # Ensuring 'time' is always available locally to avoid UnboundLocalError
        db = SessionLocal()
        video = None
        try:
            video = db.query(Video).get(video_id)
            if not video: return

            if _preserve_telegram_video_for_preview(video, video_id):
                db.commit()
                logging.info("Skipped generic preview processing for Telegram video %s", video_id)
                await self._broadcast_status(video_id, video.status, {
                    "thumbnail_path": video.thumbnail_path,
                    "storage_type": video.storage_type,
                })
                return

            await manager.log(f"VIPVideoProcessor: Processing ID {video_id}...", "working")

            # Preserve the provider URL before this processor replaces it with
            # the local Nexus cache path.  That URL is required by SerpApi.
            if not video.original_thumbnail_url and str(video.thumbnail_path or "").startswith(("http://", "https://")):
                video.original_thumbnail_url = video.thumbnail_path
                video.thumbnail_referer = video.thumbnail_referer or video.source_url or video.url
                db.commit()

            # Skip processing for VK videos that were already processed during import
            if video.status == 'ready_to_stream' and video.source_url and any(d in video.source_url for d in ['vk.com', 'vk.video', 'vkvideo.ru']):
                logging.info(f"VK video {video_id} already processed during import, skipping")
                db.close()
                return

            thumb_exists = video.thumbnail_path and os.path.exists(f"app{video.thumbnail_path}")
            if not force and video.status == 'ready' and thumb_exists:
                db.close(); return

            # Improved direct file detection (ignoring query params)
            parsed_url = urllib.parse.urlparse(video.url.lower())
            is_direct_file = any(parsed_url.path.endswith(ext) for ext in ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m3u8'])
            
            is_pixeldrain = "pixeldrain.com" in video.url
            is_bunkr = "bunkr" in video.url or "cdn.cr" in video.url or (video.source_url and ("bunkr" in video.source_url or "cdn.cr" in video.source_url))
            is_gofile = "gofile.io" in video.url or (video.source_url and "gofile.io" in video.source_url)

            # Use source_url for domain checks to ensure they work on "Regenerate" too
            from app.media_urls import media_refresh_source
            search_url = media_refresh_source(video.url, video.source_url)
            if search_url != (video.source_url or video.url):
                video.source_url = search_url
                db.commit()
            is_xvideos = "xvideos.com" in search_url
            is_xhamster = "xhamster.com" in search_url
            is_bunkr = "bunkr" in search_url or "scdn.st" in search_url or "cdn.cr" in search_url
            if is_bunkr and ("/a/" in search_url.lower() or "/album/" in search_url.lower()):
                search_url = video.url  # Do not use album URL for single video metadata extraction
            
            is_gofile = "gofile.io" in search_url
            is_camwhores = "camwhores.tv" in (video.url or "").lower() or "camwhores.tv" in (search_url or "").lower()
            if is_gofile:
                # Album children keep their parent folder as source_url, but
                # metadata must be resolved from the child's own GoFile page.
                search_url = _gofile_metadata_url(video.url or "", video.source_url or "")
            is_webshare = "webshare.cz" in search_url or "wsfiles.cz" in search_url or search_url.startswith("webshare:")
            is_turbo = "turbo.cr" in search_url or "turbocdn" in (video.url or "").lower()
            is_cyberfile = "cyberfile.me" in search_url or "cyberfile.me" in (video.url or "").lower()
            source_low = (video.source_url or "").lower()
            has_bunkr_page_source = bool(
                is_bunkr and (
                    "/f/" in source_low or
                    "/v/" in source_low
                )
            )
            if has_bunkr_page_source and video.source_url:
                # Force canonical extraction from page URL to avoid cross-bound direct-link mixups.
                search_url = video.source_url
            _cw_match = re.search(r"/videos/(\d+)", f"{video.source_url or ''} {video.url or ''}", re.I)
            cw_corr = f"cw:{_cw_match.group(1)}" if _cw_match else "cw:unknown"
            if "camwhores" in (video.url or "").lower() or "camwhores" in (video.source_url or "").lower():
                logging.info(
                    "[CW_PROCESS][%s] start video_id=%s url=%s source=%s status=%s",
                    cw_corr,
                    video_id,
                    (video.url or "")[:120],
                    (video.source_url or "")[:120],
                    video.status,
                )

            # Camwhores: bulk/extension often sets source_url to search HTML — scraping needs the /videos/… watch URL.
            if video.url and "camwhores.tv" in video.url.lower() and "/videos/" in video.url.lower():
                search_url = video.url
                su_low = (video.source_url or "").lower()
                if "camwhores.tv/videos/" not in su_low:
                    video.source_url = video.url
                    db.commit()

            video.status = "processing"
            video.storage_type = "remote" # Default on import
            db.commit()
            await self._broadcast_status(video_id, "processing")

            def _has_local_thumb() -> bool:
                return os.path.exists(os.path.join(THUMB_DIR, f"thumb_{video_id}.jpg"))

            stream_url = video.url
            if has_bunkr_page_source:
                # Never trust previously captured direct URL for Bunkr page imports.
                stream_url = None
                is_direct_file = False
            # Watch-page URLs are not playable streams; do not skip yt-dlp / generic scrapers.
            _vurl = (stream_url or "").lower()
            if "camwhores.tv" in _vurl and "/videos/" in _vurl and "get_file" not in _vurl:
                stream_url = None

            meta = {}
            if video.title and not any(x in str(video.title).lower() for x in ["queued", "untitled"]):
                meta['title'] = video.title
            if video.thumbnail_path and video.thumbnail_path.startswith(('http://', 'https://')):
                meta['thumbnail_url'] = video.thumbnail_path
            if video.duration and video.duration > 0:
                meta['duration'] = video.duration
            if video.width and video.width > 0:
                meta['width'] = video.width
            if video.height and video.height > 0:
                meta['height'] = video.height
            yt_id = None
            pd_id = None
            
            # --- PLUGIN SYSTEM (NEW) ---
            from app.extractors.registry import ExtractorRegistry
            from app.extractors import init_registry, register_extended_extractors

            init_registry()
            register_extended_extractors()

            # Try to find a dedicated plugin first
            plugin = ExtractorRegistry.find_extractor(search_url)
            if plugin and extractor == 'auto':
                logging.info(f"Using Plugin: {plugin.name} for {search_url}")
                try:
                    def _is_playable_stream_url(u: str) -> bool:
                        if not u or not isinstance(u, str):
                            return False
                        ul = u.lower()
                        return (
                            ul.startswith(("http://", "https://")) and
                            (
                                is_pimpbunny_remote_media(u) or
                                bool(re.search(r"\.(mp4|m3u8|mpd)(\?|$)", ul)) or
                                "/api/v1/proxy/hls?url=" in ul or
                                "/hls_proxy?url=" in ul
                            )
                        )

                    def _is_safe_beeg_stream(u: str) -> bool:
                        ul = (u or "").strip().lower()
                        if "beeg.com" not in ul and "externulls.com" not in ul:
                            return True
                        if re.search(r"^https?://(?:www\.)?beeg\.com/-\d+", ul):
                            return False
                        if ul.endswith(".ts") or ".ts?" in ul or "/seg-" in ul:
                            return False
                        return _is_playable_stream_url(u)

                    def _normalize_thumbnail_value(value):
                        # Some extractors return thumbnailUrl as list/dict from JSON-LD.
                        if isinstance(value, list):
                            return str(value[0]).strip() if value else ""
                        if isinstance(value, dict):
                            return str(value.get("url") or value.get("src") or "").strip()
                        return str(value or "").strip()

                    # Run async plugin in this thread
                    res = await plugin.extract(search_url)
                    if res:
                        pl_stream = res.get("stream_url")
                        current_stream = (video.url or "").strip()
                        # Prevent regressions where a resolved direct stream gets overwritten
                        # by an embed/player URL (observed on PornHoarder player.php).
                        if has_bunkr_page_source and pl_stream:
                            pl_low = pl_stream.lower()
                            # The guard's real job is to reject embed/player URLs (e.g.
                            # PornHoarder player.php) while accepting a fresh DIRECT media
                            # file. Bunkr rotates its CDN host (scdn.st -> cdn.cr -> …), so a
                            # fixed "bunkr"/"scdn.st" allowlist wrongly rejected valid new
                            # streams like https://c2ru-b.cdn.cr/…/x.mp4?token=… and R "did
                            # nothing". Trust the same CDN family the Bunkr extractor itself
                            # accepts (host on Bunkr's TLD set) AND require a media extension.
                            has_media_ext = bool(re.search(r"\.(mp4|m3u8|webm|mkv|mov)(\?|$)", pl_low))
                            on_bunkr_cdn = (
                                "bunkr" in pl_low or "scdn.st" in pl_low or "cdn.cr" in pl_low
                                or bool(re.search(r"://[a-z0-9.-]+\.(?:st|su|io|is|si|la|cr)/", pl_low))
                            )
                            valid_bunkr_direct = has_media_ext and on_bunkr_cdn
                            if not valid_bunkr_direct:
                                logging.warning(
                                    "[BUNKR_GUARD] Rejected suspicious plugin stream for video %s: %s",
                                    video_id,
                                    (pl_stream or "")[:160],
                                )
                                pl_stream = None
                        if pl_stream and (_is_playable_stream_url(pl_stream) or not _is_playable_stream_url(current_stream)):
                            video.url = pl_stream
                            stream_url = pl_stream
                        else:
                            stream_url = current_stream
                        if "beeg.com" in (search_url or "").lower() or "beeg.com" in (video.source_url or "").lower():
                            if not _is_safe_beeg_stream(video.url or stream_url):
                                video.url = video.source_url or search_url or video.url
                                stream_url = video.url
                        meta['title'] = res.get('title') or meta.get('title')
                        meta['description'] = res.get('description')
                        thumb = _normalize_thumbnail_value(res.get('thumbnail'))
                        if thumb:
                            meta['thumbnail_url'] = thumb
                        # Keep duration/resolution the importer already stored.
                        # Extractors often return 0/None for CDN files, and
                        # overwriting forced a second ffprobe on every item.
                        if res.get('duration'):
                            meta['duration'] = res.get('duration')
                        if res.get('width'):
                            meta['width'] = res.get('width')
                        if res.get('height'):
                            meta['height'] = res.get('height')
                        if res.get('tags'): meta['tags'] = ",".join(res['tags'])
                        if res.get('views'): meta['views'] = res.get('views')
                        if res.get('upload_date'): meta['upload_date'] = res.get('upload_date')
                        if res.get('size_bytes'): meta['size_bytes'] = res.get('size_bytes')
                        if res.get('file_size_mb') and float(res['file_size_mb']) > float(video.file_size_mb or 0):
                            video.file_size_mb = round(float(res['file_size_mb']), 2)
                        
                        if pl_stream:
                            await manager.log(f"Plugin {plugin.name} success for {video_id}", "success")
                except Exception as e:
                     logging.error(f"Plugin {plugin.name} failed: {e}")
                     # Fallthrough to legacy methods if plugin crashes?
            
            # --- LEGACY EXTRACTORS (To be migrated) ---

            # 0. Turbo.cr signed link refresh. Its CDN URL always looks like a
            # direct file (dl*.turbocdn.st/turbo/data/<id>.mp4?exp=...&token=...),
            # so is_direct_file is True even once exp has passed — nothing else
            # here would ever re-run extraction for it. The signed token has a
            # short TTL (commonly 2-6h); with no refresh, every Turbo import
            # played back later than that hits an expired/rejected CDN link.
            # source_url is the canonical https://turbo.cr/v/<id> watch page
            # (set at import time), which TurboExtractor can always re-resolve.
            if is_turbo and extractor == 'auto':
                exp_match = re.search(r"[?&]exp=(\d+)", video.url or "")
                is_expired = bool(exp_match) and int(exp_match.group(1)) <= int(time.time())
                if force or is_expired or not stream_url:
                    try:
                        te = TurboExtractor()
                        turbo_page = video.source_url if te.can_handle(video.source_url or "") else video.url
                        refreshed = await te.extract(turbo_page)
                        if refreshed and refreshed.get('stream_url'):
                            stream_url = refreshed['stream_url']
                            video.url = stream_url
                            if not video.source_url:
                                video.source_url = te._canonical_watch_url(turbo_page)
                            if refreshed.get('title') and (not video.title or video.title.lower().startswith('queued')):
                                meta['title'] = refreshed['title']
                            if refreshed.get('thumbnail') and not video.thumbnail_path:
                                meta['thumbnail_url'] = refreshed['thumbnail']
                            logging.info(f"Turbo link refreshed for video {video_id}")
                        else:
                            logging.warning(f"Turbo re-extraction returned no stream for video {video_id}")
                    except Exception as e:
                        logging.error(f"Turbo re-extraction failed for video {video_id}: {e}")

            # 1. Bunkr Scraper (Playwright)
            if is_bunkr and extractor == 'auto' and not is_direct_file and not stream_url:
                try:
                    be = BunkrExtractor()
                    # Try the plugin extractor (handles /f/, /v/, and /a/ album URLs)
                    plugin = ExtractorRegistry.find_extractor(video.url if not is_direct_file else search_url)
                    if plugin and plugin.name == "Bunkr":
                        logging.info(f"Using new Bunkr plugin for {video_id}")
                        res = await plugin.extract(search_url or video.url)
                        if res:
                            stream_url = res.get('stream_url')
                            video.url = stream_url
                            if not video.source_url:
                                video.source_url = search_url or video.url
                            meta.update({
                                'title': res.get('title'),
                                'thumbnail_url': res.get('thumbnail'),
                                'description': res.get('description')
                            })
                        # Plugin handled it (success or album — either way don't fall through)
                    else:
                        # Legacy fallback path
                        original_bunkr_url = video.url
                        if "/a/" in video.url or "/album/" in video.url:
                            files = await be.extract_album(video.url)
                            if files:
                                f = files[0]
                                cdn = f['cdn']
                                if cdn.startswith("//"):  cdn = "https:" + cdn
                                stream_url = f"{cdn}/{f['name']}"
                                meta['title'] = f.get('name', video.title)
                                if f.get('thumb'): meta['thumbnail_url'] = f['thumb']
                                video.url = stream_url
                                if not video.source_url:
                                    video.source_url = original_bunkr_url
                        else:
                            direct_link = await be.extract_file(video.url)
                            if direct_link:
                                stream_url = direct_link
                                video.url = stream_url
                                if not video.source_url:
                                    video.source_url = original_bunkr_url
                                logging.info(f"Bunkr file extracted: {original_bunkr_url} -> {stream_url}")
                except Exception as e:
                    logging.error(f"Bunkr extraction failed: {e}")


            # 2. Gofile Scraper
            if is_gofile and extractor == 'auto' and not is_direct_file and not stream_url:
                try:
                    ge = GoFileExtractor()
                    content_id = video.url.split('/')[-1] if '/d/' in video.url else None
                    if content_id:
                        files = ge.get_content(content_id)
                        if files:
                            target_file = next((f for f in files if f['mimetype'].startswith('video')), files[0])
                            stream_url = target_file['link']
                            meta['title'] = target_file['name']
                            if target_file.get('thumbnail'): meta['thumbnail_url'] = target_file['thumbnail']
                            # Update video URL — no intermediate commit
                            video.url = stream_url
                except Exception as e:
                    logging.error(f"Gofile extraction failed: {e}")

            # 3. Webshare VIP Resolver
            if is_webshare:
                try:
                    from app.extractors.legacy.webshare import WebshareAPI, parse_webshare_ident
                    ws = WebshareAPI() # Will load token from env

                    original_webshare_url = video.source_url or video.url
                    ident = parse_webshare_ident(video.source_url) or parse_webshare_ident(video.url)

                    if ident:
                        # Webshare is sensitive to concurrent sessions. Serialize and retry a few times.
                        real_url = None
                        with VIPVideoProcessor._webshare_lock:
                            for attempt in range(1, 4):
                                real_url = ws.get_vip_link(ident)
                                if real_url:
                                    break
                                time.sleep(2 * attempt)

                        if real_url:
                            logging.info(f"Webshare VIP Link Resolved for video {video_id}: {real_url}")
                            stream_url = real_url
                            video.url = real_url # Update to direct, processable link
                            # Defer commit — will run at end of processing

                            # Attempt to grab technical metadata and thumbnail via API
                            file_info = ws.get_file_info(ident)
                            if file_info:
                                if file_info.get('thumbnail'):
                                    meta['thumbnail_url'] = file_info['thumbnail']
                                if file_info.get('duration'):
                                    meta['duration'] = file_info['duration']
                                if file_info.get('width'):
                                    meta['width'] = file_info['width']
                                if file_info.get('height'):
                                    meta['height'] = file_info['height']
                                if file_info.get('name'):
                                    meta['title'] = file_info['name']
                                if file_info.get('size_bytes'):
                                    meta['size_bytes'] = file_info['size_bytes']
                                    # If size is missing from download_stats, populate it now
                                    stats = video.download_stats or {}
                                    if not stats.get('size_mb') and not stats.get('reported_size_bytes'):
                                        stats['reported_size_bytes'] = file_info['size_bytes']
                                        video.download_stats = stats
                                        from sqlalchemy.orm.attributes import flag_modified
                                        flag_modified(video, "download_stats")
                            logging.info(f"Webshare metadata resolved via API for video {video_id}: {meta}")
                            
                            # Fallback thumbnail scrape if still missing
                            if not meta.get('thumbnail_url'):
                                thumb = self._fetch_webshare_thumbnail(ident, original=original_webshare_url)
                                if thumb:
                                    meta['thumbnail_url'] = thumb
                                    logging.info(f"Webshare thumbnail resolved via page scrape for video {video_id}")
                        else:
                            # If we can't get a VIP link, we cannot stream or thumbnail.
                            raise Exception("Could not resolve Webshare VIP link (token missing/expired or Webshare limit hit).")
                    # If we have a 'free' link, we need an ident to try and get a VIP one. If no ident, we can't proceed.
                    elif 'wsfiles.cz' in video.url and not ident:
                        raise Exception("Webshare 'free' link detected without a usable file 'ident' in source_url. Cannot upgrade to VIP link.")

                except Exception as e:
                    # Catch the exception raised above or any other error
                    logging.error(f"Webshare processing failed for video {video_id}: {e}")
                    video.status = "error"
                    video.error_msg = str(e)
                    db.commit()
                    await self._broadcast_status(video_id, "error", {"error": str(e)})
                    db.close() # Close session
                    return   # STOP PROCESSING THIS VIDEO

            # 4. Pixeldrain Scraper (Direct & Generic)
            # CRITICAL: Always run for Pixeldrain to convert user URLs to API URLs
            if (is_pixeldrain or "pixeldrain.com" in video.url) and extractor == 'auto' and not video.url.startswith("https://pixeldrain.com/api/"):
                try:
                    pe = PixeldrainExtractor()
                    # It handles full URL now
                    info = pe.get_file_info(video.url)
                    if info:
                        stream_url = info['link']
                        meta['title'] = info['name']
                        if info.get('thumbnail'): meta['thumbnail_url'] = info.get('thumbnail')
                        if info.get('size'): meta['size_bytes'] = info.get('size')
                        # Update video URL to the direct stream API link which is streamable
                        # But keep source_url intact
                        video.url = stream_url 
                        logging.info(f"Pixeldrain API URL resolved for video {video_id}: {stream_url}")
                        
                except Exception as e:
                    logging.error(f"Pixeldrain extraction failed: {e}")

            
            # --- METADATA EXTRACTION (Legacy Blocks removed for migrated plugins) ---
                       
            # 1.1 Custom Scraper for XHAMSTER (To migrate next)
            if is_xhamster and extractor == 'auto' and not stream_url:
                xh_meta, xh_stream_url = self._fetch_xhamster_meta(search_url)
                if xh_stream_url:
                    stream_url = xh_stream_url
                    video.url = xh_stream_url
                    meta.update(xh_meta)
                    await manager.log(f"xHamster scraper success for {video_id}", "success")

            # 1.5 Generic Scraper
            if not is_direct_file and not stream_url and extractor == 'auto' and not is_camwhores:
                logging.info(f"Running generic scraper for {video.url}")
                scraped_meta, scraped_stream_url = await self._scrape_generic_video_page(video.url)
                if scraped_stream_url:
                    stream_url = scraped_stream_url
                    video.url = scraped_stream_url  # Update URL to the direct stream
                    meta.update(scraped_meta)
                    await manager.log(f"Generic scraper success for {video_id}, found stream: {stream_url}", "success")

            # Direct stream fallback metadata scraping from source watch page
            if is_direct_file and video.source_url and not meta.get('title'):
                logging.info(f"Scraping source page for metadata: {video.source_url}")
                try:
                    scraped_meta, _ = await self._scrape_generic_video_page(video.source_url)
                    if scraped_meta:
                        meta.update(scraped_meta)
                except Exception as e:
                    logging.warning(f"Failed to scrape source page for metadata: {e}")

            # 2. Pixeldrain API
            pd_id_match = re.search(r'/(?:u|l|file|filesystem|d)/([a-zA-Z0-9_-]+)', video.url)
            if is_pixeldrain and pd_id_match:
                pd_id = pd_id_match.group(1)
                pd_info = self._fetch_pixeldrain_info_api(pd_id)
                if pd_info and pd_info.get("name"):
                    meta['title'] = pd_info['name']

            # 3. Generic Fallback (yt-dlp)
            # Trigger if title is missing OR if technical metadata (duration or height) is missing/low
            # For XVideos in particular, we want to try deep extraction if initial scraper got low quality
            needs_better_meta = not (meta.get('duration') and meta.get('height') and meta.get('height') >= 720)
            if (not meta.get('title') or needs_better_meta) and not stream_url:
                should_run_ytdlp = False
                if extractor == "yt-dlp": should_run_ytdlp = True
                elif extractor == "auto" and not is_pixeldrain and not is_direct_file: should_run_ytdlp = True

                # Bunkr CDN/page URLs are never handled by yt-dlp — skip it entirely
                if is_bunkr or is_camwhores:
                    should_run_ytdlp = False

                if should_run_ytdlp:
                    try:
                        # For XVideos/XHamster, we MUST set extract_flat=False to get format/HLS info properly
                        ytdlp_opts = {
                            'quiet': True, 'ignoreerrors': True, 'no_warnings': True,
                            'format': 'bestvideo+bestaudio/best',
                            'extract_flat': False if (is_xvideos or is_xhamster) else True
                        }
                        import yt_dlp
                        info_id = yt_dlp.YoutubeDL(ytdlp_opts).extract_info(search_url, download=False)
                        yt_id = info_id.get('id') if info_id else None
                        
                        dlp_meta, fetched_stream_url = self._fetch_metadata(search_url, yt_id, quality_mode)
                        
                        if fetched_stream_url and not meta.get('stream_url'):
                            stream_url = fetched_stream_url
                        
                        meta.update(dlp_meta)

                    except Exception as e: logging.warning(f"yt-dlp failed: {e}")
            
            # 3. FFprobe
            if (not meta.get('duration') or not meta.get('height') or extractor == "ffprobe") and stream_url:
                extraction_referer = search_url
                if "camwhores" in (search_url or ""):
                    extraction_referer = (
                        video.source_url
                        if (video.source_url and "camwhores.tv/videos/" in video.source_url)
                        else "https://www.camwhores.tv/"
                    )
                elif "erome.com" in (search_url or ""):
                    extraction_referer = "https://www.erome.com/"
                elif is_bunkr:
                    # Bunkr CDN requires Referer from a bunkr.* domain root, NOT scdn.st or CDN itself
                    extraction_referer = self._bunkr_cdn_referer(video.source_url or stream_url)

                meta = await self._ffprobe_fallback(stream_url, meta, referer=extraction_referer)

            if is_bunkr and (not meta.get('duration') or not meta.get('height')):
                try:
                    bunkr_page_url = video.source_url or search_url
                    refreshed_stream_url = stream_url
                    if bunkr_page_url and BunkrExtractor().can_handle(bunkr_page_url):
                        refreshed_meta = await BunkrExtractor().extract(bunkr_page_url)
                        if refreshed_meta:
                            refreshed_stream_url = refreshed_meta.get('stream_url') or refreshed_stream_url
                            if refreshed_meta.get('title') and not meta.get('title'):
                                meta['title'] = refreshed_meta.get('title')
                            if refreshed_meta.get('thumbnail') and not meta.get('thumbnail_url'):
                                meta['thumbnail_url'] = refreshed_meta.get('thumbnail')
                            if refreshed_meta.get('duration') and not meta.get('duration'):
                                meta['duration'] = refreshed_meta.get('duration')
                            if refreshed_meta.get('width') and not meta.get('width'):
                                meta['width'] = refreshed_meta.get('width')
                            if refreshed_meta.get('height') and not meta.get('height'):
                                meta['height'] = refreshed_meta.get('height')

                    if refreshed_stream_url:
                        retry_referer = self._bunkr_cdn_referer(video.source_url or refreshed_stream_url)
                        meta = await self._ffprobe_fallback(refreshed_stream_url, meta, referer=retry_referer)
                        if refreshed_stream_url != stream_url and refreshed_stream_url.startswith(("http://", "https://")):
                            video.url = refreshed_stream_url
                            stream_url = refreshed_stream_url
                except Exception as bunkr_retry_exc:
                    logging.warning("Bunkr metadata retry failed for video %s: %s", video_id, bunkr_retry_exc)

            # 4. Názov a Tagy
            resolved_thumb = str(meta.get('thumbnail_url') or "").strip()
            if resolved_thumb.startswith("//"):
                resolved_thumb = "https:" + resolved_thumb
            if resolved_thumb.startswith(("http://", "https://")) and not video.original_thumbnail_url:
                video.original_thumbnail_url = resolved_thumb
            new_title = meta.get('title')
            # Clean up tube site suffix signatures to keep it clean and professional
            if new_title:
                new_title = new_title.replace('\ufffd', '')
                new_title = re.sub(r'[\s\-\|»\ufffd\xbb\xab«·•\u2022\u2013\u2014]+(?:free porn|sex movies|hot porn|xxx|youperv|porn tube|porn video|online porn).*$', '', new_title, flags=re.IGNORECASE)
                new_title = re.sub(r'[\s\-\|»\ufffd\xbb\xab«·•\u2022\u2013\u2014]+\d{2}\.\d{2}\.\d{4}.*$', '', new_title)
                new_title = re.sub(r'[\s\-\|»\ufffd\xbb\xab«·•\u2022\u2013\u2014]+$', '', new_title).strip()

            # Filter out generic titles
            if new_title and not any(x in new_title.lower() for x in ["hls", "index", "m3u8", "video", "queued"]):
                video.title = new_title
            
            if not video.title or len(video.title) < 4 or any(x in str(video.title).lower() for x in ["untitled", "queued", "video #"]):
                 path_title = self._extract_title_from_url(search_url)
                 video.title = path_title if path_title else f"Video #{video_id}"

            # Keep duration provided by extension import when already present.
            # Some providers return noisy/blocked metadata during processing, which can
            # otherwise overwrite a correct imported duration with 0 or bogus values.
            # However, if the existing duration is extremely short (e.g. under 30 seconds)
            # and the extracted metadata duration is much longer/valid, we prefer the meta duration.
            existing_duration = float(video.duration or 0)
            meta_duration = float(meta.get('duration') or 0)
            if meta_duration > 0:
                if existing_duration <= 0 or (existing_duration < 30 and meta_duration >= 30) or (meta_duration > existing_duration * 1.5):
                    video.duration = meta_duration
                else:
                    video.duration = existing_duration
            else:
                video.duration = existing_duration if existing_duration > 0 else 0.0
            existing_width = int(video.width or 0)
            existing_height = int(video.height or 0)
            video.width = int(meta.get('width') or existing_width or 0)
            video.height = int(meta.get('height') or existing_height or 0)
            
            # Update quality based on resolved height or fallback to title/url checks
            if video.height >= 2160:
                video.quality = "4K"
            elif video.height >= 1440:
                video.quality = "1440p"
            elif video.height >= 1080:
                video.quality = "FHD"
            elif video.height >= 720:
                video.quality = "HD"
            elif video.height > 0:
                video.quality = "SD"
            else:
                # Fallback check from title and url strings if height remains 0
                _low_check = (str(video.title or "") + str(video.url or "") + str(video.source_url or "")).lower()
                if any(x in _low_check for x in ("2160", "4k")):
                    video.quality = "4K"
                elif "1440" in _low_check:
                    video.quality = "1440p"
                elif any(x in _low_check for x in ("1080", "fhd", "ultra")):
                    video.quality = "FHD"
                elif any(x in _low_check for x in ("720", "hd")):
                    video.quality = "HD"
                else:
                    video.quality = "SD"
                
            if meta.get('views') is not None: video.views = meta.get('views')
            if meta.get('upload_date'): video.upload_date = meta.get('upload_date')
            video.aspect_ratio = calculate_aspect_ratio(video.width, video.height)

            if not video.tags: video.tags = meta.get('tags') or self._generate_smart_tags(video.title)
            video.ai_tags = self._generate_ai_tags(video.title, meta.get('description', ''))
            
            if not is_direct_file and yt_id:
                video.subtitle = self._read_and_clean_vtt(yt_id)

            # 5. Vizuály
            # TODO: Add Watermark Detector (detect text overlays in thumbnails/frames)
            # TODO: Add Classification System (auto-tag "solo", "BJ", "facial" from metadata/frames)
            visuals_ok = False
            # FileDitch: the .mp4 page is now an anti-bot HTML shell, so ffmpeg
            # and the direct-viewer scraper yield nothing (empty thumb/duration).
            # Fall back to FileDitch's hosted poster PNG, which lives at a
            # predictable CDN path derived from the file-page URL.
            if not meta.get('thumbnail_url'):
                fd_poster = self._fileditch_poster_url(video.url, video.source_url)
                if fd_poster:
                    meta['thumbnail_url'] = fd_poster
                    logging.info(f"Using FileDitch poster thumbnail for {video_id}: {fd_poster}")
            # Use scraper thumbnail if available — download asynchronously with httpx
            if meta.get('thumbnail_url'):
                try:
                    if isinstance(meta.get('thumbnail_url'), str) and meta['thumbnail_url'].startswith('//'):
                        meta['thumbnail_url'] = f"https:{meta['thumbnail_url']}"
                    # Use realistic User-Agent to avoid scraping blocks and rate-limiting from Pixeldrain/Cloudflare
                    dl_headers = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                    }
                    if is_bunkr:
                        dl_headers['Referer'] = self._bunkr_cdn_referer(video.source_url or video.url)
                    elif video.url:
                        dl_headers['Referer'] = video.url

                    # Robust async downloader with built-in rate-limit (HTTP 429) backoff/retries
                    async def _dl_thumb():
                        async with httpx.AsyncClient(follow_redirects=True, timeout=10) as client:
                            for attempt in range(1, 4):
                                try:
                                    r = await client.get(meta['thumbnail_url'], headers=dl_headers)
                                    if r.status_code == 429:
                                        await asyncio.sleep(1.5 * attempt)
                                        continue
                                    return r.status_code, r.content
                                except Exception as exc:
                                    if attempt == 3:
                                        raise exc
                                    await asyncio.sleep(1.0 * attempt)
                            return 500, b""

                    th_status, th_content = await _dl_thumb()
                    # CyberFile labels its 56px file-type icon as image/jpeg.
                    # It is a valid image transport-wise but not a usable video
                    # preview; leave visuals_ok false so FFmpeg creates a frame.
                    is_cyberfile_icon = is_cyberfile and len(th_content or b"") <= 4096
                    if th_status == 200 and not is_cyberfile_icon:
                        thumb_path = os.path.join(THUMB_DIR, f"thumb_{video_id}.jpg")
                        thumb_stage = f"{thumb_path}.incoming"
                        with open(thumb_stage, 'wb') as f:
                            f.write(th_content)
                        if os.path.getsize(thumb_stage) <= 500:
                            os.remove(thumb_stage)
                            raise ValueError("Downloaded thumbnail is too small to replace the existing preview")
                        os.replace(thumb_stage, thumb_path)
                        
                        # Optimization: Duplicate native thumbnail directly to previews, 
                        # bypassing any future need to run FFmpeg for hover previews!
                        try:
                            preview_base = os.path.join(PREVIEW_DIR, f"{video_id}_")
                            for i in range(4):
                                shutil.copy(thumb_path, f"{preview_base}{i}.jpg")
                        except Exception as preview_err:
                            logging.debug(f"Failed to populate previews for {video_id}: {preview_err}")
                            
                        visuals_ok = True
                    elif is_cyberfile_icon:
                        logging.info("[CyberFile] Ignoring generic poster icon for video %s", video_id)
                except Exception as e:
                    logging.error(f"Failed to download thumbnail from URL {meta['thumbnail_url']}: {e}")

            if not visuals_ok and is_pixeldrain and pd_id and extractor == "auto":
                if self._download_pixeldrain_thumbnail(video_id, pd_id): visuals_ok = True
            
            # CyberFile's generic poster is ignored above.  A real frame is
            # produced from the freshly resolved, serialized media stream.
            if not visuals_ok and stream_url:
                # Determine best referer for extraction
                current_referer = video.source_url if video.source_url else video.url
                
                if "camwhores" in video.url or "camwhores" in (video.source_url or ""):
                     current_referer = (
                         video.source_url
                         if (video.source_url and "camwhores.tv/videos/" in video.source_url)
                         else "https://www.camwhores.tv/"
                     )
                elif "erome.com" in video.url or "erome.com" in (video.source_url or ""):
                     current_referer = "https://www.erome.com/"
                elif "eporner.com" in (video.source_url or ""):
                     current_referer = video.source_url
                elif "webshare" in video.url or "webshare.cz" in (video.source_url or ""):
                     current_referer = None
                elif "pornone.com" in (video.source_url or ""):
                     current_referer = video.source_url if video.source_url else "https://www.pornone.com/"
                elif is_bunkr:
                    current_referer = self._bunkr_cdn_referer(video.source_url or stream_url)

                # For Webshare, if we haven't found a thumbnail by now, we will not use ffmpeg.
                is_webshare_link = self._is_webshare_host(stream_url) or \
                                   (video.source_url and self._is_webshare_host(video.source_url))

                if is_webshare_link:
                    is_free_link = "free" in stream_url.lower()
                    if is_free_link:
                         logging.warning(f"Could not resolve thumbnail for Webshare FREE video {video_id} via API or scrape. Skipping ffmpeg.")
                         visuals_ok = True 
                    else:
                         logging.info(f"Webshare VIP link detected, proceeding with FFmpeg fallback for {video_id}")
                         await manager.log(f"Generating FFmpeg thumbnail for {video_id}...", "working")
                         await self._generate_visuals(stream_url, video_id, video.duration, referer=current_referer)
                else:
                    try:
                        await manager.log(f"Generating FFmpeg thumbnail for {video_id}...", "working")
                        await self._generate_visuals(stream_url, video_id, video.duration, referer=current_referer)
                    except Exception as e: 
                         logging.error(f"Visuals gen failed for {video_id}: {e}")
                         await manager.log(f"FFmpeg error for {video_id}: {e}", "error")

                if _has_local_thumb():
                    visuals_ok = True
                    await manager.log(f"Thumbnail created for {video_id}", "success")
                else:
                    await manager.log(f"Thumbnail generation failed (no output) for {video_id}", "warning")

            if _has_local_thumb():
                # Store clean path, frontend adds timestamp to bypass cache
                video.thumbnail_path = f"/static/thumbnails/thumb_{video_id}.jpg"
            elif meta.get('thumbnail_url') and isinstance(meta.get('thumbnail_url'), str):
                # If local thumbnail generation failed, keep a usable remote thumbnail
                # instead of leaving a stale /static/thumbnails path that returns 404.
                remote_thumb = meta['thumbnail_url'].strip()
                if remote_thumb.startswith('//'):
                    remote_thumb = f"https:{remote_thumb}"
                if remote_thumb.startswith(("http://", "https://")):
                    video.thumbnail_path = remote_thumb
            
            gif_preview_path = os.path.join(THUMB_DIR, f"thumb_{video_id}.gif")
            if os.path.exists(gif_preview_path):
                video.gif_preview_path = f"/static/thumbnails/thumb_{video_id}.gif"
            sprite_preview_path = os.path.join(THUMB_DIR, f"sprite_{video_id}.jpg")
            if os.path.exists(sprite_preview_path) and not str(video.sprite_path or '').startswith('/static/thumbnails/discovery_sprite_'):
                video.sprite_path = f"/static/thumbnails/sprite_{video_id}.jpg"

            if _has_usable_thumbnail_path(video.thumbnail_path, video_id):
                video.preview_retry_needed = False
                video.preview_retry_count = 0
                video.preview_last_error = None
            else:
                video.preview_retry_needed = True
                video.preview_last_error = "Thumbnail/preview generation produced no usable output"
                if video.preview_retry_count is None:
                    video.preview_retry_count = 0
                await manager.log(f"Marked video {video_id} for preview retry", "warning")

            video.preview_path = f"/static/previews/{video_id}"

            def _has_safe_remote_stream(vobj) -> bool:
                low_url = (vobj.url or "").strip().lower()
                low_source = (vobj.source_url or "").strip().lower()
                is_beeg = "beeg.com" in low_url or "beeg.com" in low_source or "externulls.com" in low_url
                if not is_beeg:
                    return True
                if re.search(r"^https?://(?:www\.)?beeg\.com/-\d+", low_url):
                    return False
                if low_url.endswith(".ts") or ".ts?" in low_url or "/seg-" in low_url:
                    return False
                if ".m3u8" in low_url or ".mp4" in low_url:
                    return True
                return False

            if _has_safe_remote_stream(video):
                video.status = "ready_to_stream"
                video.error_msg = None
            else:
                video.status = "error"
                video.error_msg = "Beeg stream was not resolved to a playable media URL"
                await manager.log(f"Blocked non-playable Beeg stream for {video_id}", "warning")
            
            # Auto-fetch file size if missing
            try:
                if meta.get('size_bytes'):
                    stats = video.download_stats or {}
                    if not stats.get('reported_size_bytes'):
                        stats['reported_size_bytes'] = meta['size_bytes']
                        video.download_stats = stats
                        from sqlalchemy.orm.attributes import flag_modified
                        flag_modified(video, "download_stats")
                already_sized = float(video.file_size_mb or 0) > 0 or bool((video.download_stats or {}).get("size_mb"))
                if not already_sized:
                    self.fetch_and_update_video_size(video_id, db=db, force=False)
            except Exception as e:
                logging.debug(f"Size auto-fetch failed for {video_id}: {e}")

            db.commit()
            if "camwhores" in (video.url or "").lower() or "camwhores" in (video.source_url or "").lower():
                logging.info(
                    "[CW_PROCESS][%s] done video_id=%s duration=%s height=%s source=%s",
                    cw_corr,
                    video_id,
                    int(video.duration or 0),
                    int(video.height or 0),
                    (video.source_url or "")[:120],
                )

            # Broadcast final status with the actual terminal state from DB.
            this_stats = video.download_stats
            await self._broadcast_status(video_id, video.status, {
                "title": video.title,
                "thumbnail_path": video.thumbnail_path,
                "storage_type": video.storage_type,
                "duration": video.duration,
                "height": video.height,
                "width": video.width,
                "file_size_mb": float(video.file_size_mb or 0),
                "download_stats": this_stats
            })

        except Exception as e:
            logging.error(f"Error processing video {video_id}: {e}")
            try:
                db.rollback()
            except Exception:
                pass
            try:
                err_db = SessionLocal()
                err_video = err_db.query(Video).get(video_id)
                if err_video:
                    err_video.status = "error"
                    err_video.error_msg = str(e)
                    err_video.preview_retry_needed = True
                    err_video.preview_last_error = str(e)
                    if err_video.preview_retry_count is None:
                        err_video.preview_retry_count = 0
                    err_db.commit()
                err_db.close()
            except Exception as state_exc:
                logging.warning(f"Failed to persist error state for video {video_id}: {state_exc}")
            # Broadcast ERROR status
            await manager.log(f"Error processing video {video_id}: {e}", "error")
            await self._broadcast_status(video_id, "error", {"error": str(e)})
        finally:
            # Guard against interrupted / half-finished runs that never leave "processing".
            try:
                finalize_db = SessionLocal()
                current_video = finalize_db.query(Video).get(video_id)
                if current_video and current_video.status == "processing":
                    current_video.status = "pending"
                    if not current_video.error_msg:
                        current_video.error_msg = "Processing did not reach a terminal state; reset for retry"
                    current_video.preview_retry_needed = True
                    if not current_video.preview_last_error:
                        current_video.preview_last_error = current_video.error_msg
                    finalize_db.commit()
                    self.broadcast_sync(video_id, "pending", {"error": current_video.error_msg})
                finalize_db.close()
            except Exception as finalize_exc:
                logging.warning(f"Failed to finalize processing state for video {video_id}: {finalize_exc}")
            db.close()

    # --- POMOCNÉ METÓDY ---

    def _fetch_pixeldrain_info_api(self, pd_id):
        try:
            url = f"https://pixeldrain.com/api/file/{pd_id}/info"
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200: return resp.json()
        except: pass
        return None

    async def extract_xvideos_metadata(self, url):
        """
        Highest quality XVideos extractor using yt-dlp.
        Prioritizes HLS (m3u8) for maximum quality (1080p+), falls back to best MP4.
        """


        # Modern User-Agent to avoid blocks/low quality
        user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        
        ydl_opts = {
            'quiet': True,
            'skip_download': True,
            'extract_flat': False,
            'format': 'bestvideo+bestaudio/best', 
            'cookiefile': 'xvideos.cookies.txt',
            'ignoreerrors': True,
            'no_warnings': True,
            'user_agent': user_agent,
            'http_headers': {
                'User-Agent': user_agent,
                'Referer': 'https://www.xvideos.com/'
            }
        }

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info:
                    return None

                formats = info.get('formats', [])
                valid_formats = []
                
                for f in formats:
                    stream_url = f.get('url')
                    if not stream_url: 
                        continue
                    
                    height = f.get('height') or 0
                    
                    # Fix 0p: Extract from format_note or format_id if height is missing
                    if height == 0:
                        note = (f.get('format_note') or '') + (f.get('format_id') or '')
                        match = re.search(r'(\d{3,4})p', note)
                        if match:
                            height = int(match.group(1))
                    
                    # Fallback for HLS if height is still 0
                    is_hls = '.m3u8' in stream_url or 'hls' in f.get('protocol', '').lower()
                    if is_hls and height == 0:
                        height = 1080 # Default to high quality for HLS
                    
                    valid_formats.append({
                        'url': stream_url,
                        'height': height,
                        'width': f.get('width') or 0,
                        'ext': f.get('ext'),
                        'protocol': f.get('protocol'),
                        'is_hls': is_hls,
                        'type': 'hls' if is_hls else 'mp4'
                    })

                # Sort: HLS first, then by height DESC
                # We want highest quality HLS if possible
                valid_formats.sort(key=lambda x: (x['is_hls'], x['height']), reverse=True)
                
                # Fallback to XVideosExtractor (Playwright) if standard methods fail or return low quality
                # This is the "Nuclear Option" for quality
                current_best_height = valid_formats[0]['height'] if valid_formats else 0
                if current_best_height < 720:
                    try:
                        from app.extractors.legacy.xvideos import XVideosExtractor
                        logging.info(f"Using Playwright Extractor for {url} (Standard method yielded low quality: {current_best_height}p)")
                        xv = XVideosExtractor()
                        pw_res = await xv.extract_metadata(url)
                        
                        if pw_res and pw_res.get('found'):
                             # Map Playwright result to our structure
                             is_hls = 'hls' in (pw_res.get('quality_source') or '').lower() or '.m3u8' in pw_res['stream_url']
                             pw_height = 1080 if is_hls else 0 
                             
                             # ffprobe the Playwright URL to be sure
                             pw_meta = {'duration': 0, 'height': pw_height, 'width': 0}
                             pw_meta = await self._ffprobe_fallback(pw_res['stream_url'], pw_meta)
                             
                             return {
                                "source": "xvideos",
                                "id": info.get('id') if info else 'unknown',
                                "title": pw_res['title'],
                                "duration": pw_meta.get('duration') or info.get('duration') or 0,
                                "thumbnail": pw_res.get('thumbnail_url') or info.get('thumbnail'),
                                "stream": {
                                    "type": "hls" if is_hls else "mp4",
                                    "url": pw_res['stream_url'],
                                    "height": pw_meta.get('height') or pw_height,
                                    "width": pw_meta.get('width') or 0
                                },
                                 "tags": list(set(info.get('tags', []) + info.get('categories', []))) if info else []
                             }
                    except Exception as e:
                        logging.error(f"Playwright fallback failed: {e}")

                if not valid_formats:
                    # Final fallback from info directly
                    fallback_url = info.get('url')
                    is_hls_fallback = '.m3u8' in (fallback_url or '')
                    return {
                        "source": "xvideos",
                        "id": info.get('id'),
                        "title": info.get('title'),
                        "duration": info.get('duration'),
                        "thumbnail": info.get('thumbnail'),
                        "stream": {
                            "type": "hls" if is_hls_fallback else "mp4",
                            "url": fallback_url,
                            "height": info.get('height') or (1080 if is_hls_fallback else 0),
                            "width": info.get('width') or 0
                        },
                        "tags": list(set(info.get('tags', []) + info.get('categories', [])))
                    }

                best = valid_formats[0]
                
                return {
                    "source": "xvideos",
                    "id": info.get('id'),
                    "title": info.get('title'),
                    "duration": info.get('duration'),
                    "thumbnail": info.get('thumbnail'),
                    "stream": {
                        "type": best['type'],
                        "url": best['url'],
                        "height": best['height'],
                        "width": best['width']
                    },
                    "tags": list(set(info.get('tags', []) + info.get('categories', [])))
                }
        except Exception as e:
            logging.error(f"XVideos extraction failed for {url}: {e}")
            return None


    async def _fetch_xhamster_meta(self, url):
        """
        Robust xHamster extractor using yt-dlp to get the best playable stream,
        with fallback to Playwright (Nuclear Option) for 1080p/4K detection.
        """
        import yt_dlp
        ydl_opts = {
            'quiet': True,
            'skip_download': True,
            'extract_flat': False,
            'format': 'best',
            'ignoreerrors': True,
            'no_warnings': True,
        }
        meta = {}
        stream_url = None
        
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if info:
                    meta = {
                        'title': info.get('title'),
                        'duration': info.get('duration'),
                        'thumbnail_url': info.get('thumbnail'),
                        'width': info.get('width'),
                        'height': info.get('height'),
                        'tags': ",".join(info.get('tags', [])),
                        'id': info.get('id')
                    }
                    stream_url = info.get('url')

        except Exception as e:
            logging.warning(f"xHamster yt-dlp extraction failed for {url}: {e}")

        # NUCLEAR OPTION: If yt-dlp failed OR quality is low (<720p), use Playwright
        if not stream_url or (meta.get('height') or 0) < 720:
             try:
                from app.extractors.xhamster import XHamsterExtractor
                logging.info(f"Using Playwright Extractor for xHamster {url}...")
                xh = XHamsterExtractor()
                pw_res = await xh.extract_playwright(url)
                
                if pw_res:
                    stream_url = pw_res['stream_url']
                    meta['title'] = pw_res['title'] or meta.get('title')
                    meta['thumbnail_url'] = pw_res['thumbnail'] or meta.get('thumbnail_url')
                    meta['duration'] = pw_res['duration'] or meta.get('duration')
                    meta['height'] = pw_res['height'] or meta.get('height')
                    
                    logging.info(f"xHamster Nuclear Success: {meta.get('height')}p")

             except Exception as e:
                 logging.error(f"xHamster Playwright fallback error: {e}")

        return meta, stream_url

    def _fetch_xvideos_meta(self, url):
        try:
            # Enhanced User-Agent to avoid mobile redirection or anti-bot blocks
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
            }
            resp = requests.get(url, headers=headers, timeout=15)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, 'html.parser')

            meta = {}
            stream_url = None

            # --- Title ---
            title_tag = soup.select_one('h2.page-title, .video-title h1 strong')
            if title_tag:
                meta['title'] = title_tag.text.strip()
            
            script_content = ""
            scripts = soup.find_all('script')
            for script in scripts:
                # Check script.string or script.get_text() if string is empty
                content = script.string or script.get_text()
                if content and 'html5player.setVideoTitle' in content:
                    script_content = content
                    break
            
            if script_content:
                # Title from script (Highly reliable for XVideos)
                title_match = re.search(r"html5player\.setVideoTitle\s*\(\s*['\"]([^'\"]+)['\"]\s*\);", script_content)
                if title_match:
                    meta['title'] = title_match.group(1).strip()

                # HLS (Preferred for quality)
                match_hls = re.search(r"html5player\.setVideoHLS\s*\(\s*['\"]([^'\"]+)['\"]\s*\);", script_content)
                if match_hls:
                    stream_url = match_hls.group(1)

                # High Quality Fallback
                if not stream_url:
                    match_high = re.search(r"html5player\.setVideoUrlHigh\s*\(\s*['\"]([^'\"]+)['\"]\s*\);", script_content)
                    if match_high:
                        stream_url = match_high.group(1)
                
                # Low Quality Fallback
                if not stream_url:
                    match_low = re.search(r"html5player\.setVideoUrlLow\s*\(\s*['\"]([^'\"]+)['\"]\s*\);", script_content)
                    if match_low:
                        stream_url = match_low.group(1)

                # Duration
                duration_match = re.search(r"html5player\.setVideoDuration\s*\(\s*([\d\.\s]+)\s*\);", script_content)
                if duration_match:
                    meta['duration'] = int(float(duration_match.group(1).strip()))

                # Fallback for HLS if not in standard call
                if not stream_url:
                    hls_raw = re.search(r"['\"](https?://[^'\"]+?\.m3u8[^'\"]*?)['\"]", script_content)
                    if hls_raw: stream_url = hls_raw.group(1)

                # Thumbnail
                # Try setThumbUrl169 first (often higher res)
                thumb_match = re.search(r"html5player\.setThumbUrl169\s*\(\s*['\"]([^'\"]+)['\"]\s*\);", script_content)
                if thumb_match:
                     meta['thumbnail_url'] = thumb_match.group(1)
                else:
                    # Fallback to setThumbUrl
                    thumb_match = re.search(r"html5player\.setThumbUrl\s*\(\s*['\"]([^'\"]+)['\"]\s*\);", script_content)
                    if thumb_match:
                         meta['thumbnail_url'] = thumb_match.group(1)

            # --- Actresses & Tags Extraction ---
            tags = []
            # Improved selectors for XVideos (Actresses, Models, Categories)
            selectors = [
                '.video-metadata a[href*="/tags/"]', 
                '.video-metadata a[href*="/models/"]',
                '.video-metadata a[href*="/pornstars/"]',
                '.video-tags a', 
                'a.label',
                'ul.video-tags li a'
            ]
            for selector in selectors:
                for t in soup.select(selector):
                    txt = t.get_text(strip=True).replace('#', '')
                    if txt and len(txt) > 1 and txt not in tags:
                        tags.append(txt)
            
            if tags:
                meta['tags'] = ",".join(tags)

            # Fallback for title
            if not meta.get('title'):
                title_og = soup.find('meta', property='og:title')
                if title_og: meta['title'] = title_og['content']

            # Final fallback for stream URL in entire page
            if not stream_url:
                hls_page = re.search(r"['\"](https?://[^'\"]+?\.m3u8[^'\"]*?)['\"]", resp.text)
                if hls_page: stream_url = hls_page.group(1)

            return meta, stream_url
        except Exception as e:
            logging.warning(f"Xvideos scraping failed for {url}: {e}")
            return {}, None

    async def _scrape_generic_video_page(self, url):
        meta = {}
        stream_url = None
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        
        try:
            async with httpx.AsyncClient(http2=True, timeout=20, follow_redirects=True) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                soup = BeautifulSoup(resp.text, 'html.parser')

                # --- Find Title ---
                og_title = soup.find('meta', property='og:title')
                if og_title and og_title.get('content'):
                    meta['title'] = og_title['content']
                else:
                    title_tag = soup.find('title')
                    if title_tag:
                        meta['title'] = title_tag.text.strip()

                # --- Find Video Stream ---
                # Look for <video> tag src
                video_tag = soup.find('video')
                if video_tag and video_tag.get('src'):
                    stream_url = urllib.parse.urljoin(url, video_tag['src'])
                
                # Look for HLS (.m3u8) links if no video tag found
                if not stream_url:
                    links = soup.find_all('a', href=True)
                    for link in links:
                        if '.m3u8' in link['href']:
                            stream_url = urllib.parse.urljoin(url, link['href'])
                            break
                
                # Fallback: Look for any MP4 links
                if not stream_url:
                    links = soup.find_all('a', href=True)
                    for link in links:
                        if '.mp4' in link['href']:
                            stream_url = urllib.parse.urljoin(url, link['href'])
                            break
                            
        except Exception as e:
            logging.error(f"Generic scraping failed for {url}: {e}")

        return meta, stream_url

    def _read_and_clean_vtt(self, yt_id):
        try:
            vtt_path = os.path.join(SUBTITLE_DIR, f"{yt_id}.en.vtt")
            if not os.path.exists(vtt_path): return ""
            with open(vtt_path, 'r', encoding='utf-8') as f: content = f.read()
            lines = content.splitlines()
            clean_lines = []
            for line in lines:
                if line.strip().startswith('WEBVTT') or '-->' in line or line.strip().startswith('Kind:') or line.strip().startswith('Language:'): continue
                line = re.sub(r'<[^>]+>', '', line)
                clean_lines.append(line.strip())
            return " ".join(clean_lines)
        except: return ""

    def _download_pixeldrain_thumbnail(self, video_id, pd_id):
        target_path = os.path.join(THUMB_DIR, f"thumb_{video_id}.jpg")
        thumb_urls = [
            f"https://pixeldrain.com/api/file/{pd_id}?thumbnail",
            f"https://pixeldrain.com/api/file/{pd_id}/thumbnail",
        ]
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": "https://pixeldrain.com/",
        }
        for thumb_url in thumb_urls:
            try:
                for attempt in range(1, 4):
                    resp = requests.get(thumb_url, headers=headers, timeout=5)
                    if resp.status_code == 200 and resp.content:
                        stage_path = f"{target_path}.incoming"
                        with open(stage_path, 'wb') as f:
                            f.write(resp.content)
                        if os.path.getsize(stage_path) <= 500:
                            os.remove(stage_path)
                            continue
                        os.replace(stage_path, target_path)
                        preview_base = os.path.join(PREVIEW_DIR, f"{video_id}_")
                        for i in range(4):
                            shutil.copy(target_path, f"{preview_base}{i}.jpg")
                        return True
                    elif resp.status_code == 429:
                        time.sleep(1.5 * attempt)
                    else:
                        break
            except Exception:
                continue
        return False

    def _extract_title_from_url(self, url):
        try:
            parsed = urllib.parse.urlparse(url)
            path = parsed.path
            basename = os.path.basename(path)

            # Special logic for XVideos to extract title from slug (e.g. /video.xxx/slug_name)
            if "xvideos.com" in url or "xvideos-cdn.com" in url:
                parts = [p for p in path.split('/') if p]
                for i, p in enumerate(parts):
                    if p.startswith('video.') and i + 1 < len(parts):
                        slug = parts[i+1]
                        return slug.replace('_', ' ').replace('-', ' ').title()
                    # Fallback for CDN URLs that might have the slug in a different part
                    if len(p) > 20 and '_' in p:
                         return p.replace('_', ' ').replace('-', ' ').title()

            if "nsfw247.to" in url:
                # Princessjas4Ux Pov Doggystyle Anal Fuck 0Z3C8Wb0 -> Princessjas4Ux POV Doggystyle Anal Fuck
                slug = basename.replace('_', ' ').replace('-', ' ')
                # Remove random ID at the end (e.g. 0z3c8wb0)
                slug = re.sub(r'\s[a-z0-9]{8,12}$', '', slug)
                return slug.title()

            if "pixeldrain" in url:
                decoded = urllib.parse.unquote(basename)
                if len(decoded) > 3: return decoded
            
            title = os.path.splitext(basename)[0]
            if title.lower() in ["hls", "index", "m3u8", "video", "queued"]: return None
            
            # Strip leading numerical slug prefixes (e.g. 1972052457-manyvids -> manyvids)
            title = re.sub(r'^\d+[-_\s]+', '', title)
            
            return title.replace('_', ' ').replace('-', ' ').title()
        except: return None

    def _fetch_metadata(self, url, yt_id, quality_mode='mp4'):
        meta = {}
        stream_url = None
        try:
            subtitle_path_template = os.path.join(SUBTITLE_DIR, f'{yt_id}.%(ext)s') if yt_id else os.path.join(SUBTITLE_DIR, 'subtitle.%(ext)s')
            fmt = 'bestvideo+bestaudio/best'
            opts = {
                'quiet': True, 'skip_download': True, 'ignoreerrors': True, 'socket_timeout': 15,
                'ffmpeg_location': FFMPEG_CMD,
                'format': fmt,
                'writesubtitles': True, 'writeautomaticsub': True,
                'subtitleslangs': ['en'],
                'outtmpl': subtitle_path_template,
                'http_headers': {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Referer': url
                }
            }
            import yt_dlp
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if info:
                    stream_url = info.get('url') 
                    meta.update({
                        'title': info.get('title'), 'description': info.get('description'),
                        'duration': info.get('duration'), 'width': info.get('width'),
                        'height': info.get('height'), 'tags': ",".join(info.get('tags', []))
                    })
        except Exception as e:
            logging.warning(f"Failed to fetch metadata with yt-dlp for {url}: {e}")
        return meta, stream_url

    def _bunkr_cdn_referer(self, url_hint: str) -> str:
        """Return the correct Referer for Bunkr CDN requests.
        scdn.st CDN 5XX-es when Referer is itself or missing — needs a bunkr.* domain root."""
        try:
            p = urllib.parse.urlparse(url_hint or "")
            h = p.netloc.lower()
            if h and "bunkr" in h and "scdn" not in h:
                return f"{p.scheme}://{p.netloc}/"
        except Exception:
            pass
        return "https://bunkr.cr/"

    @staticmethod
    def _fileditch_poster_url(*url_hints) -> Optional[str]:
        """Derive FileDitch's hosted poster thumbnail from a file-page URL.

        FileDitch's `.mp4` pages now serve an anti-bot HTML shell (empty
        <source>, real link injected by an obfuscated WASM script), so ffmpeg
        and the direct-viewer scraper both come back empty. But every page
        embeds a real poster at a predictable CDN path derived from the URL:
            /<bucket>/<id>/<file>.mp4  ->  thumbsditch.b-cdn.net/<bucket>/<id>/thumbs.png
        Return that PNG URL for the first fileditch-looking hint, else None.
        """
        for hint in url_hints:
            try:
                p = urllib.parse.urlparse(hint or "")
                if "fileditchfiles." not in p.netloc.lower():
                    continue
                # Drop the trailing filename segment, keep /<bucket>/<id>.
                segs = [s for s in (p.path or "").split("/") if s]
                if len(segs) < 2:
                    continue
                base = "/".join(segs[:-1])  # bucket/id
                return f"https://thumbsditch.b-cdn.net/{base}/thumbs.png"
            except Exception:
                continue
        return None

    async def _ffprobe_fallback(self, url, meta, referer=None):
        try:
            if not shutil.which(FFPROBE_CMD): return meta
            async with self.shared_ffprobe_gate():
                return await self._ffprobe_fallback_limited(url, meta, referer)
        except Exception as e:
            logging.error(f"ffprobe failed: {e}")
        return meta

    async def _ffprobe_fallback_limited(self, url, meta, referer=None):
        try:
            async def _run_ffprobe(cmd):
                rc, stdout, stderr = await run_subprocess_capture(cmd, timeout=20)
                if rc != 0 and not stdout:
                    raise Exception((stderr or b"ffprobe failed").decode("utf-8", "ignore")[:200])
                return stdout.decode('utf-8', 'ignore')

            ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            probe_targets = [(url, referer)]
            if "pixeldrain.com" in (url or "").lower():
                try:
                    from .config import config
                    proxied_url = (
                        f"http://127.0.0.1:{config.SERVER_PORT}/stream_proxy/0.mp4"
                        f"?url={urllib.parse.quote(url, safe='')}"
                    )
                    probe_targets.append((proxied_url, None))
                except Exception:
                    pass

            for probe_url, probe_referer in probe_targets:
                headers_args = []
                if probe_referer and not self._is_webshare_host(probe_referer):
                    headers_args = ['-headers', f'Referer: {probe_referer}\r\nUser-Agent: {ua}\r\n']
                elif self._is_webshare_host(probe_url):
                    headers_args = ['-headers', f'User-Agent: {ua}\r\n']

                # GoFile returns CDN links from its contents API, but the CDN
                # serves the real MP4 only when the account token plus rotating
                # website token accompany the request.  Without these headers
                # ffprobe receives GoFile's HTML redirect page and reports
                # `moov atom not found`, leaving every imported card at 0:00.
                if "gofile.io" in (probe_url or "").lower():
                    try:
                        from .extractors.gofile import GoFileExtractor
                        gofile_token = GoFileExtractor._get_token()
                        if gofile_token:
                            gofile_wt = GoFileExtractor._generate_website_token(gofile_token)
                            gofile_headers = (
                                f'Referer: {probe_referer or "https://gofile.io/"}\r\n'
                                f'User-Agent: {ua}\r\n'
                                f'Cookie: accountToken={gofile_token}\r\n'
                                f'Authorization: Bearer {gofile_token}\r\n'
                                f'X-BL: en-US\r\n'
                                f'X-Website-Token: {gofile_wt}\r\n'
                            )
                            headers_args = ['-headers', gofile_headers]
                    except Exception as gofile_header_exc:
                        logging.debug("GoFile ffprobe headers unavailable: %s", gofile_header_exc)

                cmd = [FFPROBE_CMD] + headers_args + FFMPEG_NETWORK_ARGS + [
                    '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height,duration:format=duration',
                    '-of', 'json', '-analyzeduration', '15000000', '-probesize', '15000000', probe_url
                ]
                try:
                    stdout_data = await _run_ffprobe(cmd)
                    data = json.loads(stdout_data or "{}")
                except Exception as probe_exc:
                    logging.warning("ffprobe failed for %s: %s", probe_url, probe_exc)
                    continue

                if 'streams' in data and len(data['streams']) > 0:
                    # Pick the highest quality stream if multiple (e.g. in master HLS)
                    streams = sorted(data['streams'], key=lambda s: int(s.get('height', 0)), reverse=True)
                    stream = streams[0]
                    meta['width'] = int(stream.get('width', 0))
                    meta['height'] = int(stream.get('height', 0))

                    # Robust duration: try all streams if available
                    durations = [float(s.get('duration')) for s in data['streams'] if s.get('duration')]
                    if durations:
                        meta['duration'] = max(durations)
                    elif not meta.get('duration'):
                        # Final attempt: check format duration
                        format_dur = data.get('format', {}).get('duration')
                        if format_dur:
                            meta['duration'] = float(format_dur)

                    if meta.get('height') or meta.get('duration'):
                        break

        except Exception as e: logging.error(f"ffprobe failed: {e}")
        return meta
    
    def _is_webshare_host(self, value):
        if not value:
            return False
        lowered = str(value).lower()
        return "webshare" in lowered or "wsfiles" in lowered or "vip-stream" in lowered

    def _fetch_webshare_thumbnail(self, ident: str, original: Optional[str] = None) -> Optional[str]:
        """Best-effort scrape of Webshare file page to retrieve the og:image thumbnail."""
        if not ident:
            return None

        candidates = []
        if original and original.startswith('http') and 'webshare.cz' in original:
            # Handle client-side routing hash URLs: #/file/ident -> /file/ident
            if "/#/file/" in original:
                fixed_url = original.replace("/#/file/", "/file/")
                candidates.append(fixed_url)
            candidates.append(original)
        
        if original and original.startswith('webshare:'):
            parts = original.split(':', 2)
            slug = parts[2] if len(parts) > 2 else ''
            if slug:
                safe_slug = urllib.parse.quote(slug)
                candidates.append(f"https://webshare.cz/file/{ident}/{safe_slug}")
        
        candidates.append(f"https://webshare.cz/file/{ident}")

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }

        seen = set()
        for page_url in candidates:
            if not page_url or page_url in seen:
                continue
            seen.add(page_url)
            try:
                resp = requests.get(page_url, headers=headers, timeout=12)
                if resp.status_code != 200 or not resp.text:
                    continue
                soup = BeautifulSoup(resp.text, 'html.parser')
                meta_tag = soup.find('meta', attrs={'property': 'og:image'}) or soup.find('meta', attrs={'name': 'og:image'})
                if meta_tag and meta_tag.get('content'):
                    candidate = meta_tag['content'].strip()
                    if candidate:
                        return urllib.parse.urljoin(page_url, candidate)
            except Exception as e:
                logging.debug(f"Webshare thumbnail scrape failed for {page_url}: {e}")
                continue
        return None

    async def _generate_visuals(self, url, vid_id, duration, referer=None):
        if not shutil.which(FFMPEG_CMD): return
        thumb_out = os.path.join(THUMB_DIR, f"thumb_{vid_id}.jpg")
        sprite_out = os.path.join(THUMB_DIR, f"sprite_{vid_id}.jpg")
        # Never destroy an existing visual before a refetched stream proves it
        # can produce a replacement. Signed URLs may be playable in the browser
        # yet unavailable to FFmpeg because of a short token lifetime/referer.
        # Rendering into staging files and promoting only valid output prevents
        # a failed refetch from leaving the card blank.
        thumb_stage = os.path.join(THUMB_DIR, f"thumb_{vid_id}.next.jpg")
        sprite_stage = os.path.join(THUMB_DIR, f"sprite_{vid_id}.next.jpg")
        for stage_path in (thumb_stage, sprite_stage):
            try:
                if os.path.exists(stage_path):
                    os.remove(stage_path)
            except OSError:
                pass

        def _promote_if_valid(stage_path, final_path):
            try:
                if os.path.exists(stage_path) and os.path.getsize(stage_path) > 500:
                    os.replace(stage_path, final_path)
                    return True
            except OSError:
                pass
            finally:
                try:
                    if os.path.exists(stage_path):
                        os.remove(stage_path)
                except OSError:
                    pass
            return False

        is_http = url.startswith('http')
        
        # Optimize FFmpeg thread usage specifically for image generation (lightweight tasks)
        # Cap at 2 threads maximum to avoid saturating host CPU during concurrent batch imports
        ffmpeg_threads = '2'
        try:
            from .config import config
            if config.FFMPEG_THREADS > 0:
                ffmpeg_threads = str(min(config.FFMPEG_THREADS, 2))
        except:
            pass
            
        sw_args = [FFMPEG_CMD, '-y', '-threads', ffmpeg_threads, '-hide_banner', '-loglevel', 'error']

        if is_http:
            sw_args += FFMPEG_NETWORK_ARGS

        headers_str = ""
        if referer and is_http:
            headers_str += f"Referer: {referer}\r\n"
        
        if is_http and "User-Agent" not in headers_str:
             headers_str += "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\n"

        async def _run_cmd_async(cmd_template, label, timeout_s):
            try:
                idx = cmd_template.index('-i')
                if headers_str and is_http:
                    full_cmd = cmd_template[:idx] + ['-headers', headers_str] + cmd_template[idx:]
                else:
                    full_cmd = cmd_template
            except ValueError:
                full_cmd = cmd_template

            try:
                rc, _out, _err = await run_subprocess_capture(full_cmd, timeout=timeout_s)
                return rc == 0
            except: pass
            return False

        async def _generate_all():
            if duration > 10:
                cmd = sw_args + ['-ss', str(duration * 0.1), '-i', url, '-vf', "scale=640:-1", '-vframes', '1', '-q:v', '5', thumb_stage]
                if await _run_cmd_async(cmd, "sw_seek", 60):
                    pass

            if not os.path.exists(thumb_stage) or os.path.getsize(thumb_stage) <= 500:
                cmd = sw_args + ['-i', url, '-vf', "thumbnail,scale=640:-1", '-frames:v', '1', thumb_stage]
                await _run_cmd_async(cmd, "sw_deep_scan", 120)

            # Lightweight StriperView sprite sheet for low-cost hover previews.
            frame_count = 8
            try:
                duration_value = float(duration or 0)
            except Exception:
                duration_value = 0
            sample_window = max(duration_value, float(frame_count))
            sample_interval = max(round(sample_window / frame_count, 2), 1.0)
            sprite_filter = f"fps=1/{sample_interval},scale=220:-1,tile={frame_count}x1"
            sprite_cmd = sw_args + ['-i', url, '-vf', sprite_filter, '-frames:v', '1', '-q:v', '4', sprite_stage]
            await _run_cmd_async(sprite_cmd, "striper_sprite", 120)

        async with self.shared_visual_gate():
            await _generate_all()
            _promote_if_valid(thumb_stage, thumb_out)
            _promote_if_valid(sprite_stage, sprite_out)

    def _generate_smart_tags(self, title):
        if not title: return ""
        tags = []
        for k in ['4k', 'hd', 'vlog', 'gameplay', 'pov', 'asmr']:
            if k in title.lower(): tags.append(k)
        return ",".join(tags)

    def _generate_ai_tags(self, title, description):
        nlp = _get_nlp()
        if not nlp or not title: return ""
        try:
            doc = nlp(title[:200])
            tags = {token.lemma_.lower() for token in doc if token.pos_ == 'NOUN' and not token.is_stop}
            return ",".join(list(tags)[:10])
        except: return ""

    def fetch_and_update_video_size(self, video_id, db=None, force=False):
        """Fetches file size for a video (remote or local) and updates download_stats."""
        close_db = False
        if db is None:
            db = SessionLocal()
            close_db = True
            
        try:
            video = db.query(Video).get(video_id)
            if not video: return False
            
            stats = video.download_stats or {}
            # If we already have size_mb, we're done
            if stats.get('size_mb') and not force: return True
            
            size_mb = 0
            # 1. Local file check
            is_local = video.storage_type == "local" or (video.url and video.url.startswith('/static/'))
            if is_local:
                path_part = video.url.replace('/static/', '', 1).lstrip('/')
                local_path = os.path.join("app", "static", path_part)
                if os.path.exists(local_path):
                    size_mb = round(os.path.getsize(local_path) / (1024 * 1024), 2)
                    video.storage_type = "local"
            # 2. Remote file check
            elif video.url and video.url.startswith('http'):
                import requests
                try:
                    headers = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                        'Accept': '*/*'
                    }
                    
                    is_bunkr = "bunkr" in video.url or "cdn.cr" in video.url or "scdn.st" in video.url or (video.source_url and ("bunkr" in video.source_url or "cdn.cr" in video.source_url))
                    if is_bunkr:
                        headers['Referer'] = self._bunkr_cdn_referer(video.source_url or video.url)
                    elif video.source_url:
                        headers['Referer'] = video.source_url
                    
                    is_hls = ".m3u8" in video.url.lower() or "hls" in video.url.lower()
                    if is_hls:
                        # HLS size resolution / estimation
                        duration = float(video.duration or 0)
                        height = int(video.height or 0)
                        if duration > 0:
                            bandwidth = 0
                            try:
                                resp = requests.get(video.url, headers=headers, timeout=5)
                                if resp.status_code == 200:
                                    lines = resp.text.split('\n')
                                    best_bw = 0
                                    for line in lines:
                                        if "#EXT-X-STREAM-INF" in line:
                                            m_bw = re.search(r'BANDWIDTH=(\d+)', line)
                                            m_res = re.search(r'RESOLUTION=\d+x(\d+)', line)
                                            if m_bw:
                                                bw = int(m_bw.group(1))
                                                res_h = int(m_res.group(1)) if m_res else 0
                                                if res_h == height:
                                                    bandwidth = bw
                                                    break
                                                elif bw > best_bw:
                                                    best_bw = bw
                                    if not bandwidth and best_bw:
                                        bandwidth = best_bw
                            except Exception as e:
                                logging.debug(f"Failed to parse HLS playlist for {video_id}: {e}")
                            
                            if bandwidth > 0:
                                size_mb = round((bandwidth * duration) / (8 * 1024 * 1024), 2)
                            elif height > 0:
                                if height >= 2160: bitrate = 12000000
                                elif height >= 1080: bitrate = 3500000
                                elif height >= 720: bitrate = 1800000
                                elif height >= 480: bitrate = 800000
                                else: bitrate = 400000
                                size_mb = round((bitrate * duration) / (8 * 1024 * 1024), 2)
                            else:
                                size_mb = round((800000 * duration) / (8 * 1024 * 1024), 2)
                    else:
                        # Try HEAD first
                        resp = requests.head(video.url, headers=headers, timeout=8, allow_redirects=True)
                        content_length = int(resp.headers.get('Content-Length', 0))
                        
                        # If HEAD fails or returns 0, try small GET with Range
                        if content_length <= 0:
                            headers['Range'] = 'bytes=0-0'
                            resp = requests.get(video.url, headers=headers, timeout=8, allow_redirects=True, stream=True)
                            
                            # Check Content-Range first: "bytes 0-0/12345"
                            content_range = resp.headers.get('Content-Range', '')
                            m = re.search(r'/(\d+)$', content_range)
                            if m:
                                content_length = int(m.group(1))
                            else:
                                content_length = int(resp.headers.get('Content-Length', 0))
                        
                        if content_length > 0:
                            size_mb = round(content_length / (1024 * 1024), 2)
                except Exception as e:
                    logging.debug(f"Failed to fetch remote size for {video_id}: {e}")
            
            if size_mb > 0:
                stats['size_mb'] = size_mb
                video.download_stats = stats
                from sqlalchemy.orm.attributes import flag_modified
                flag_modified(video, "download_stats")
                # DEFINITIVE FIX: also sync to the dedicated file_size_mb column
                # so the UI card always shows the correct file size immediately
                video.file_size_mb = size_mb
                db.commit()
                return True
        except Exception as e:
            logging.error(f"Error in fetch_and_update_video_size for {video_id}: {e}")
        finally:
            if close_db: db.close()
        return False


def search_videos_by_subtitle(query: str, db: Session):
    return db.query(Video).filter(Video.subtitle.contains(query)).all()

def get_batch_stats(db: Session):
    from sqlalchemy import func
    
    # SQLite JSON1 extension allows extracting sizes without loading rows into Python
    results = db.query(
        func.coalesce(Video.batch_name, "Uncategorized").label("label"),
        func.count(Video.id).label("value"),
        func.sum(func.json_extract(Video.download_stats, '$.size_mb')).label("total_size_mb")
    ).group_by(func.coalesce(Video.batch_name, "Uncategorized")).all()
    
    out = []
    for row in results:
        b = row.label
        cnt = row.value
        size_mb = float(row.total_size_mb or 0.0)
        
        size_text = f"{size_mb / 1024:.1f} GB" if size_mb > 1024 else f"{int(size_mb)} MB"
        out.append({
            "label": b,
            "value": cnt,
            "total_size_mb": round(size_mb, 2),
            "size_text": size_text
        })
    return out

def get_tags_stats(db: Session):
    from sqlalchemy import or_, and_
    tag_counts = Counter()
    
    # Stream tags without buffering the entire library into memory
    videos = db.query(Video.tags, Video.ai_tags).filter(
        or_(
            and_(Video.tags.isnot(None), Video.tags != ''),
            and_(Video.ai_tags.isnot(None), Video.ai_tags != '')
        )
    ).yield_per(2000)
    
    for v_tags, v_ai_tags in videos:
        if v_tags:
            tag_counts.update(t.strip() for t in v_tags.split(','))
        if v_ai_tags:
            tag_counts.update(t.strip() for t in v_ai_tags.split(','))
            
    return [{"label": t[0], "value": t[1]} for t in tag_counts.most_common(20)]

def get_quality_stats(db: Session):
    from sqlalchemy import case, func, or_
    
    res = db.query(
        func.sum(case((Video.height >= 1080, 1), else_=0)).label("FHD"),
        func.sum(case((Video.height.between(720, 1079), 1), else_=0)).label("HD"),
        func.sum(case((Video.height.between(1, 719), 1), else_=0)).label("SD"),
        func.sum(case((or_(Video.height == 0, Video.height.is_(None)), 1), else_=0)).label("Unknown")
    ).first()

    return [
        {"label": "4K", "value": 0},
        {"label": "FHD", "value": res.FHD or 0},
        {"label": "HD", "value": res.HD or 0},
        {"label": "SD", "value": res.SD or 0},
        {"label": "Unknown", "value": res.Unknown or 0},
    ]

async def extract_playlist_urls(url: str, parser: str = "yt-dlp"):
    import os  # Import at function level for use throughout
    found_urls = []
    
    # Camwhores watch pages must keep slug path; yt-dlp flattening can degrade them to /videos/<id>/.
    if "camwhores.tv" in (url or "").lower() and "/videos/" in (url or "").lower():
        return [url]
    
    # 0. Skip direct files immediately to prevent IncompleteRead errors
    # Erome CDN v40.erome.com and direct .mp4 links should not be scraped as HTML
    is_direct = any(url.lower().split('?')[0].endswith(ext) for ext in ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m3u8'])
    is_cdn = any(domain in url for domain in ['v.erome.com', 'v40.erome.com', 'v1.erome.com', 'cdn.bunkr.is', 'wsfiles.cz'])
    
    if is_direct or is_cdn:
        return [url]
    
    # 1. XenForo Thread Extraction (SimpCity, SMG)
    if "simpcity.su" in url or "socialmediagirls.com" in url:
        try:
            from app.extractors.legacy.xenforo import XenForoExtractor
            base = "https://simpcity.su" if "simpcity" in url else "https://socialmediagirls.com"
            scout = XenForoExtractor(base)
            links = scout.extract_links_from_thread(url)
            for l in links:
                found_urls.append(l['url'])
            if found_urls: return list(dict.fromkeys(found_urls))
        except Exception as e:
            logging.warning(f"XenForo extraction failed for {url}: {e}")

    # 1.5 VK Playlist Extraction
    if any(pattern in url for pattern in ['/playlist/', '/videos-', '/album-']):
        if any(domain in url for domain in ['vk.com', 'vkvideo.ru', 'vk.video']):
            try:
                import yt_dlp
                
                logging.info(f"Detected VK playlist: {url}")
                
                user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                ydl_opts = {
                    'quiet': True,
                    'extract_flat': True,  # Don't download, just get URLs
                    'skip_download': True,
                    'ignoreerrors': True,
                    'no_warnings': True,
                    'user_agent': user_agent,
                    'http_headers': {
                        'User-Agent': user_agent,
                        'Referer': 'https://vk.com/'
                    }
                }
                
                # Add cookies if available
                if os.path.exists("vk.netscape.txt"):
                    ydl_opts['cookiefile'] = "vk.netscape.txt"
                elif os.path.exists("cookies.netscape.txt"):
                    ydl_opts['cookiefile'] = "cookies.netscape.txt"
                
                import yt_dlp
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                    
                    if info:
                        # Extract video URLs from playlist entries
                        entries = info.get('entries', [])
                        
                        for entry in entries:
                            if entry:
                                # Try to get the video URL
                                video_url = None
                                
                                # Method 1: webpage_url (most reliable)
                                if entry.get('webpage_url'):
                                    video_url = entry['webpage_url']
                                # Method 2: Construct from ID
                                elif entry.get('id'):
                                    video_url = f"https://vk.com/video{entry['id']}"
                                # Method 3: url field
                                elif entry.get('url') and 'vk.com' in entry['url']:
                                    video_url = entry['url']
                                
                                if video_url:
                                    found_urls.append(video_url)
                        
                        if found_urls:
                            logging.info(f"Extracted {len(found_urls)} videos from VK playlist")
                            return list(dict.fromkeys(found_urls))
                        else:
                            logging.warning(f"No videos found in VK playlist: {url}")
            except Exception as e:
                logging.error(f"VK playlist extraction failed for {url}: {e}")
                import traceback
                logging.error(traceback.format_exc())

    # 2. Specialized Bunkr Scraper
    if "bunkr" in url and ("/a/" in url or "/album/" in url or "/f/" in url):
        try:
             from app.extractors.bunkr import BunkrExtractor
             be = BunkrExtractor()
             # We use a brief loop for async call in sync method
             files = await be.extract_album(url, listing_only=True)
             for f in files:
                 direct = f.get("url")
                 if not direct and f.get("cdn") and f.get("name"):
                     # Legacy extractor shape: cdn/name.
                     direct = f"{str(f['cdn']).rstrip('/')}/{str(f['name']).lstrip('/')}"
                 if direct:
                     found_urls.append(direct)
             if found_urls: return list(dict.fromkeys(found_urls))
        except Exception as e:
            logging.warning(f"Bunkr album extraction failed for {url}: {e}")

    # 2.5 Specialized Turbo.cr Album
    if "turbo.cr" in url and ("/a/" in url or "/album/" in url):
        try:
             from app.extractors.turbo import TurboExtractor
             te = TurboExtractor()
             all_videos = await te.extract_album(url)
             if all_videos:
                 logging.info(f"Turbo.cr album expanded: found {len(all_videos)} videos")
                 return all_videos
        except Exception as e:
            logging.warning(f"Turbo.cr album extraction failed for {url}: {e}")

    # 2.5 Specialized Erome Scraper
    if "erome.com" in url:
        try:

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': 'https://www.erome.com/'
            }
            # Use stream=True to check headers before downloading the body
            resp = requests.get(url, headers=headers, timeout=10, stream=True)
            if resp.status_code == 200:
                # If it's a direct video (not HTML), just return it
                ctype = resp.headers.get('Content-Type', '').lower()
                if 'text/html' not in ctype:
                    return [url]
                
                soup = BeautifulSoup(resp.text, 'html.parser')
                # Erome videos are in <video> or <source> tags
                sources = soup.select('video > source[src]')
                for s in sources:
                    src = s['src']
                    if src.startswith('//'): src = 'https:' + src
                    found_urls.append(src)
                
                # Check for direct video tags too
                videos = soup.select('video[src]')
                for v in videos:
                    src = v['src']
                    if src.startswith('//'): src = 'https:' + src
                    found_urls.append(src)
                
                if found_urls: return list(dict.fromkeys(found_urls))
        except Exception as e:
            logging.warning(f"Erome extraction failed for {url}: {e}")

    # 2.6 Specialized Eporner Playlist
    if "eporner.com" in url and "/playlist/" in url:
        # Share the tester's paced, configured transport and real pagination.
        # Never fall through to yt-dlp or collect sidebar recommendations.
        from .extractors.eporner import EpornerExtractor
        entries = await EpornerExtractor().extract_album_entries(url)
        return list(dict.fromkeys(entry["source_url"] for entry in entries))


    # 2.7 Specialized XVideos Profile/Model/List
    if "xvideos.com" in url:
        # Check if it's a playlist/favorite/profile/channel but NOT a single video
        is_playlist = "/favorite/" in url or "/profiles/" in url or "/channels/" in url or "/tags/" in url or not "/video." in url
        if is_playlist:
            try:
                headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Referer': 'https://www.xvideos.com/'
                }
                
                # Robust cookie handling: only use if it looks like a simple key=value string
                if os.path.exists("xvideos.cookies.txt"):
                     with open("xvideos.cookies.txt", "r") as f:
                          cookie_data = f.read().strip()
                          if cookie_data and not cookie_data.startswith("# Netscape"):
                              headers['Cookie'] = cookie_data

                resp = requests.get(url, headers=headers, timeout=20)
                if resp.status_code != 200:
                    logging.error(f"[XVIDEOS_PLAYLIST_FAIL] Status code {resp.status_code} for {url}")
                else:
                    soup = BeautifulSoup(resp.text, 'html.parser')
                    
                    found_videos = []
                    # Try to find video blocks first for accurate limit counting
                    blocks = soup.select('.thumb-block')
                    for block in blocks:
                        # Prioritize the main title link
                        a = block.select_one('p.title a') or block.select_one('.thumb a')
                        if a and a.get('href'):
                            href = a['href']
                            if not href.startswith('http'): 
                                href = "https://www.xvideos.com" + href
                            clean_url = href.split('#')[0].split('?')[0]
                            if "/video." in clean_url and clean_url not in found_videos:
                                found_videos.append(clean_url)
                                if len(found_videos) >= 500:
                                    break
                    
                    # Fallback to any video links if blocks failed
                    if not found_videos:
                        links = soup.select('a[href*="/video."]')
                        for l in links:
                            href = l['href']
                            if not href.startswith('http'): 
                                href = "https://www.xvideos.com" + href
                            clean_url = href.split('#')[0].split('?')[0]
                            if clean_url not in found_videos:
                                found_videos.append(clean_url)
                                if len(found_videos) >= 500:
                                    break

                    if found_videos:
                        logging.info(f"[XVIDEOS_PLAYLIST_OK] {len(found_videos)} videos processed from playlist {url}")
                        if len(found_videos) < 20:
                            logging.warning(f"[XVIDEOS_PLAYLIST_PARTIAL] Only {len(found_videos)} found")
                        return found_videos
                    else:
                        logging.warning(f"[XVIDEOS_PLAYLIST_FAIL] No videos found in {url}")
            except Exception as e:
                logging.warning(f"XVideos profile extraction failed for {url}: {e}")


    # 2.8 Specialized SpankBang Playlist
    if "spankbang.com" in url and "/playlist/" in url:
        try:
            from app.extractors.legacy.spankbang import SpankBangExtractor
            logging.info(f"Using Playwright for SpankBang playlist expansion: {url}")
            sb = SpankBangExtractor()
            all_videos = await sb.extract_playlist(url)
            
            if all_videos:
                logging.info(f"SpankBang playlist expanded: found {len(all_videos)} unique videos")
                return all_videos
        except Exception as e:
            logging.warning(f"SpankBang playlist expansion failed: {e}")

    # 2.9 Pixeldrain Folder/List Expansion
    if "pixeldrain.com" in url and ("/l/" in url or "/api/filesystem/" in url or "/u/" in url or "/d/" in url):
        try:
            from app.extractors.legacy.generic import PixeldrainExtractor
            pe = PixeldrainExtractor()
            files = pe.get_folder_content(url)
            for f in files:
                found_urls.append(f['link'])
            if found_urls: 
                logging.info(f"Pixeldrain folder expanded: found {len(found_urls)} videos")
                return list(dict.fromkeys(found_urls))
        except Exception as e:
            logging.warning(f"Pixeldrain expansion failed for {url}: {e}")

    # 2.95 Filester Folder Expansion
    if "filester." in url and "/f/" in url:
        try:
            from app.extractors.filester import FilesterExtractor
            fe = FilesterExtractor()
            files = await fe.extract_folder(url)
            for f in files:
                direct = f.get("url")
                if direct:
                    found_urls.append(direct)
            if found_urls:
                logging.info(f"Filester folder expanded: found {len(found_urls)} files")
                return list(dict.fromkeys(found_urls))
        except Exception as e:
            logging.warning(f"Filester folder expansion failed for {url}: {e}")

    # 3. yt-dlp Fallback
    opts = {'extract_flat': True, 'quiet': True, 'ignoreerrors': True, 'socket_timeout': 15}
    if "xvideos.com" in url and os.path.exists("xvideos.netscape.txt"):
        opts['cookiefile'] = "xvideos.netscape.txt"
    elif "eporner.com" in url and os.path.exists("eporner.netscape.txt"):
        opts['cookiefile'] = "eporner.netscape.txt"
    elif "faphouse.com" in url and os.path.exists("faphouse.netscape.txt"):
        opts['cookiefile'] = "faphouse.netscape.txt"
    elif os.path.exists("bridge.cookies.txt"): # Generic fallback
        # We'd need to convert bridge.cookies.txt to netscape too if we want to use it here
        pass

    try:
        import yt_dlp
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if info and 'entries' in info:
                for entry in info['entries']:
                    if entry: found_urls.append(entry.get('url') or entry.get('webpage_url'))
            elif info: found_urls.append(url)
    except: pass
    
    if found_urls:
        return [u for u in found_urls if u]
    
    # If no videos found, and it's a known non-video page, return empty instead of [url]
    is_profile = (
        "xvideos.com" in url and not "/video." in url
    ) or (
        "eporner.com" in url and "/playlist/" in url
    ) or (
        "bunkr" in url and ("/a/" in url or "/album/" in url)
    ) or (
        "filester." in url and "/f/" in url
    )
    
    if is_profile:
        return []

    return [url]
