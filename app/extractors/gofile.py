"""
GoFile.io video extractor for direct streaming.
Uses official GoFile API to extract metadata and stream URLs.
Supports both single files and folder URLs with multiple videos / playlist expand.
"""
import os
import requests
import hashlib
import logging
import time
import asyncio
from typing import Dict, List, Optional, Any
from urllib.parse import quote
from datetime import datetime, timezone
from .base import VideoExtractor

logger = logging.getLogger(__name__)

try:
    from curl_cffi import requests as _cffi_requests
    _HAS_CFFI = True
except ImportError:
    _cffi_requests = None
    _HAS_CFFI = False

DEFAULT_TIMEOUT = 15
WT_WINDOW_SECONDS = 14400  # 4-hour rotating window used by GoFile


class GoFileExtractor(VideoExtractor):
    """
    Extracts video metadata and stream URLs from GoFile.io links.
    Supports direct streaming without downloading.
    Handles both single file and folder URLs (multi-video playlists).
    """

    @property
    def name(self) -> str:
        return "GoFile"

    def can_handle(self, url: str) -> bool:
        return "gofile.io" in url.lower()

    _cached_token: Optional[str] = None
    _user_token: Optional[str] = None
    _token_failed_until: float = 0.0
    _user_agent = os.environ.get(
        "GOFILE_USER_AGENT",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    )
    _language = os.environ.get("GOFILE_LANGUAGE", "en-US")
    _salt = os.environ.get("GOFILE_WT_SALT", "12af056dacea0b")

    @classmethod
    def _http_request(cls, method: str, url: str, **kwargs: Any) -> Any:
        """Execute HTTP request using curl_cffi when available or requests fallback."""
        kwargs.setdefault("timeout", 6)
        if _HAS_CFFI and _cffi_requests is not None:
            try:
                return _cffi_requests.request(method, url, impersonate="chrome", **kwargs)
            except Exception as e:
                logger.debug(f"[GoFile] curl_cffi request failed ({e}), falling back to requests")
        return requests.request(method, url, **kwargs)

    @classmethod
    def _generate_website_token(
        cls,
        token: str,
        window_offset: int = 0,
        user_agent: Optional[str] = None,
        language: Optional[str] = None,
        salt: Optional[str] = None,
    ) -> str:
        """
        Generate the x-website-token required by GoFile API.
        Formula: sha256(userAgent::language::accountToken::window::salt)
        where window = floor(unix_time / 14400)
        """
        if not token:
            return ""
        ua = user_agent or cls._user_agent
        lang = language or cls._language
        s = salt or cls._salt
        window = int(time.time() // WT_WINDOW_SECONDS) + window_offset
        raw = f"{ua}::{lang}::{token}::{window}::{s}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @classmethod
    def set_user_token(cls, token: str):
        """Set a user's permanent GoFile account token."""
        cls._user_token = token
        logger.info("GoFile user token configured")

    @classmethod
    def _get_token(cls, force_guest: bool = False) -> Optional[str]:
        """
        Get GoFile API token.
        Priority: 1) User token / ENV, 2) Cached guest token, 3) Create new guest token
        """
        env_token = os.environ.get("GOFILE_TOKEN", "").strip() or None
        if (cls._user_token or env_token) and not force_guest:
            return cls._user_token or env_token

        if cls._cached_token and not force_guest:
            return cls._cached_token

        # Don't hammer failing endpoint repeatedly in a batch
        if not force_guest and time.time() < cls._token_failed_until:
            return None

        try:
            headers = {
                'User-Agent': cls._user_agent,
                'Accept': 'application/json',
                'Origin': 'https://gofile.io',
                'Referer': 'https://gofile.io/'
            }
            response = cls._http_request('POST', 'https://api.gofile.io/accounts', json={}, headers=headers, timeout=6)
            if response.status_code == 200:
                data = response.json()
                if data.get('status') == 'ok':
                    token = data.get('data', {}).get('token')
                    if token:
                        cls._cached_token = token
                        cls._token_failed_until = 0.0
                        logger.info("Successfully obtained GoFile guest token")
                        return token
            logger.warning(f"GoFile account creation failed: {response.status_code}")
            cls._token_failed_until = time.time() + 60.0
        except Exception as e:
            logger.warning(f"Failed to get GoFile token: {e}")
            cls._token_failed_until = time.time() + 60.0

        return None

    @classmethod
    def _extract_content_id(cls, url: str) -> Optional[str]:
        """Extract content/folder ID from a GoFile URL."""
        if '/d/' in url.lower():
            part = url.split('/d/')[-1].split('?')[0].split('#')[0].strip()
            return part.strip('/')
        if '/c/' in url.lower():
            part = url.split('/c/')[-1].split('?')[0].split('#')[0].strip()
            return part.strip('/')
        return None

    @classmethod
    def _is_video_file(cls, item: Dict[str, Any]) -> bool:
        """Check if an item dictionary is a video file."""
        mimetype = str(item.get('mimetype') or '').lower()
        if mimetype.startswith('video/'):
            return True
        name = str(item.get('name') or item.get('fileName') or '').lower()
        return any(name.endswith(ext) for ext in ('.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ts', '.wmv', '.flv'))

    @classmethod
    def _fetch_folder_contents_sync(cls, content_id: str) -> Optional[Dict[str, Any]]:
        """Synchronously fetch folder contents with automatic token & window fallback."""
        token = cls._get_token()
        if not token:
            token = cls._get_token(force_guest=True)
            if not token:
                return None

        def _do_request(t: str, offset: int = 0):
            wt = cls._generate_website_token(t, window_offset=offset)
            url = f"https://api.gofile.io/contents/{content_id}?wt={wt}&contentFilter=&page=1&pageSize=1000&sortField=name&sortDirection=1"
            headers = {
                'User-Agent': cls._user_agent,
                'Accept': 'application/json',
                'Authorization': f'Bearer {t}',
                'X-Website-Token': wt,
                'X-BL': cls._language,
                'Origin': 'https://gofile.io',
                'Referer': f'https://gofile.io/d/{content_id}',
            }
            cookies = {'accountToken': t}
            return cls._http_request('GET', url, headers=headers, cookies=cookies, timeout=DEFAULT_TIMEOUT)

        try:
            resp = _do_request(token, 0)
            if resp.status_code == 401 or (resp.status_code == 200 and resp.json().get('status') == 'error-notPremium'):
                # Try with previous window offset
                logger.info(f"[GoFile] Retrying {content_id} with window offset -1")
                resp = _do_request(token, -1)
                
                # If still failing and we used a user token, fallback to guest token
                if resp.status_code != 200 or resp.json().get('status') != 'ok':
                    guest_token = cls._get_token(force_guest=True)
                    if guest_token and guest_token != token:
                        logger.info(f"[GoFile] Retrying {content_id} with fresh guest token")
                        token = guest_token
                        resp = _do_request(token, 0)
                        if resp.status_code != 200 or resp.json().get('status') != 'ok':
                            resp = _do_request(token, -1)

            if resp.status_code != 200:
                logger.error(f"[GoFile] API status {resp.status_code} for {content_id}")
                return None

            data = resp.json()
            if data.get('status') == 'ok':
                return data.get('data')
            logger.warning(f"[GoFile] API returned status {data.get('status')} for {content_id}")
            return None
        except Exception as e:
            logger.error(f"[GoFile] Error fetching {content_id}: {e}", exc_info=True)
            return None

    @classmethod
    def _parse_video_entries(cls, content_data: Dict[str, Any], base_url: str) -> List[Dict[str, Any]]:
        """Parse all video files from content data dict."""
        if not content_data:
            return []

        raw_contents = content_data.get('children') or content_data.get('contents') or {}
        items_list = list(raw_contents.values()) if isinstance(raw_contents, dict) else (raw_contents if isinstance(raw_contents, list) else [])

        # If content_data itself is a file
        if content_data.get('type') == 'file' and not items_list:
            items_list = [content_data]

        videos = []
        for item in items_list:
            if not isinstance(item, dict):
                continue
            if item.get('type') == 'file' or cls._is_video_file(item):
                name = item.get('name') or item.get('fileName') or 'Video'
                stream_url = item.get('link') or item.get('directLink') or item.get('downloadLink')
                if not stream_url:
                    continue

                size_bytes = int(item.get('size') or item.get('filesize') or 0)
                size_mb = round(size_bytes / (1024 * 1024), 1) if size_bytes > 0 else None
                duration = int(item.get('duration') or 0)
                
                # Format upload date
                create_time = item.get('createTime')
                upload_date = ""
                if create_time:
                    try:
                        upload_date = datetime.fromtimestamp(int(create_time), tz=timezone.utc).strftime('%Y-%m-%d')
                    except Exception:
                        upload_date = str(create_time)

                # Thumbnail: if GoFile gives a valid custom thumbnail use it, otherwise frame proxy
                raw_thumb = item.get('thumbnail') or ''
                if raw_thumb and 'dist/img/logo.png' not in raw_thumb:
                    thumbnail = raw_thumb
                else:
                    thumbnail = f"/api/tester/frame?url={quote(stream_url, safe='')}"

                file_id = item.get('id') or item.get('code') or ''
                item_url = f"https://gofile.io/d/{file_id}" if file_id else base_url

                videos.append({
                    'id': file_id,
                    'title': name,
                    'url': stream_url,
                    'stream_url': stream_url,
                    'source_url': item_url or stream_url,
                    'album_url': base_url,
                    'item_url': item_url,
                    'thumbnail': thumbnail,
                    'duration': duration,
                    'size_bytes': size_bytes,
                    'size_mb': size_mb,
                    'upload_date': upload_date,
                    'uploader': 'GoFile User',
                    'is_hls': False,
                    'quality': '',
                    'width': 0,
                    'height': 0,
                })
        return videos

    async def extract_album_entries(self, url: str) -> List[Dict[str, Any]]:
        """Extract all video entries from a GoFile folder/link for playlist expansion."""
        content_id = self._extract_content_id(url)
        if not content_id:
            return []

        data = await asyncio.to_thread(self._fetch_folder_contents_sync, content_id)
        if not data:
            return []

        return self._parse_video_entries(data, url)

    async def extract_album(self, url: str) -> List[Dict[str, Any]]:
        """Alias for album extraction."""
        return await self.extract_album_entries(url)

    @classmethod
    async def extract_multiple(cls, url: str) -> List[Dict[str, Any]]:
        """Extract all videos from a GoFile folder (backwards compatibility)."""
        content_id = cls._extract_content_id(url)
        if not content_id:
            return []

        data = await asyncio.to_thread(cls._fetch_folder_contents_sync, content_id)
        if not data:
            return []

        return cls._parse_video_entries(data, url)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Extract video metadata from GoFile URL.
        If the URL contains multiple files, the first is returned as primary result.
        """
        content_id = self._extract_content_id(url)
        if not content_id:
            return None

        data = await asyncio.to_thread(self._fetch_folder_contents_sync, content_id)
        if not data:
            return None

        videos = self._parse_video_entries(data, url)
        if not videos:
            return None

        # Return the first video file with full metadata
        first = videos[0]
        result = {
            'id': first.get('id') or content_id,
            'title': first.get('title') or f"GoFile_{content_id}",
            'description': f"GoFile: {first.get('title')}",
            'thumbnail': first.get('thumbnail') or f"/api/tester/frame?url={quote(first['stream_url'], safe='')}",
            'duration': first.get('duration', 0),
            'stream_url': first.get('stream_url'),
            'size_bytes': first.get('size_bytes', 0),
            'size_mb': first.get('size_mb'),
            'upload_date': first.get('upload_date', ''),
            'uploader': 'GoFile User',
            'width': 0,
            'height': 0,
            'tags': [],
            'is_hls': False,
            'video_count': len(videos),
            'item_count': len(videos),
            'album_items': videos,
        }
        return result


# Backwards compatibility alias for imports using PascalCase GoFileExtractor
GofileExtractor = GoFileExtractor
