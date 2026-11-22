import logging
import re
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

import httpx

from .base import VideoExtractor

logger = logging.getLogger(__name__)


class PixeldrainExtractor(VideoExtractor):
    API_BASE = "https://pixeldrain.com/api"
    VIDEO_EXTENSIONS = (".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".ts")

    @property
    def name(self) -> str:
        return "Pixeldrain"

    def can_handle(self, url: str) -> bool:
        value = (url or "").lower()
        return "pixeldrain.com" in value and any(
            token in value for token in ("/u/", "/l/", "/d/", "/api/file/", "/api/list/", "/api/filesystem/")
        )

    @staticmethod
    def _extract_id(url: str, patterns: List[str]) -> Optional[str]:
        for pattern in patterns:
            match = re.search(pattern, url or "", re.I)
            if match:
                return match.group(1)
        return None

    @classmethod
    def _looks_like_video(cls, item: Dict[str, Any]) -> bool:
        name = (item.get("name") or item.get("title") or "").lower()
        mime_type = (item.get("mime_type") or item.get("mime") or item.get("content_type") or "").lower()
        return mime_type.startswith("video/") or name.endswith(cls.VIDEO_EXTENSIONS)

    @staticmethod
    def _select_list_item(url: str, files: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        parsed = urlparse(url)
        item_index = None
        query_item = parse_qs(parsed.query).get("item", [None])[0]
        fragment_item = parse_qs(parsed.fragment).get("item", [None])[0]
        raw = query_item or fragment_item
        if raw and str(raw).isdigit():
            item_index = int(raw)

        if item_index is not None and 0 <= item_index < len(files):
            return files[item_index]
        return files[0] if files else None

    @staticmethod
    def _headers() -> Dict[str, str]:
        import os
        import base64
        headers = {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        }
        key = (os.environ.get("PIXELDRAIN_API_KEY") or "").strip()
        if key:
            headers["Authorization"] = f"Basic {base64.b64encode(f':{key}'.encode()).decode()}"
        return headers

    async def _fetch_json(self, client: httpx.AsyncClient, url: str) -> Optional[Dict[str, Any]]:
        try:
            response = await client.get(url, headers=self._headers())
            response.raise_for_status()
            data = response.json()
            if isinstance(data, dict) and data.get("success") is False:
                return None
            return data if isinstance(data, dict) else None
        except Exception as exc:
            logger.warning("Pixeldrain API request failed for %s: %s", url, exc)
            return None

    @staticmethod
    def _shape_file(file_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        name = payload.get("name") or file_id
        mime_type = payload.get("mime_type") or payload.get("mime") or ""
        return {
            "id": file_id,
            "title": name,
            "description": "",
            "thumbnail": f"https://pixeldrain.com/api/file/{file_id}/thumbnail",
            "duration": 0,
            "stream_url": f"https://pixeldrain.com/api/file/{file_id}",
            "width": 0,
            "height": 0,
            "size_bytes": int(payload.get("size") or 0),
            "tags": [],
            "uploader": "Pixeldrain",
            "is_hls": False,
            "content_type": mime_type,
        }

    async def extract_album_entries(self, url: str) -> List[Dict[str, Any]]:
        list_id = self._extract_id(url, [r"/l/([A-Za-z0-9_-]+)", r"/api/list/([A-Za-z0-9_-]+)"])
        if not list_id:
            return []

        async with httpx.AsyncClient(timeout=20, follow_redirects=True, verify=False) as client:
            data = await self._fetch_json(client, f"{self.API_BASE}/list/{list_id}")
            if not data:
                return []

        files = [item for item in (data.get("files") or []) if isinstance(item, dict) and item.get("id") and self._looks_like_video(item)]
        return [
            {
                "id": file["id"],
                "title": file.get("name") or file["id"],
                "thumbnail": f"https://pixeldrain.com/api/file/{file['id']}/thumbnail",
                "stream_url": f"https://pixeldrain.com/api/file/{file['id']}",
                "content_type": file.get("mime_type") or file.get("mime") or "",
                "size_bytes": int(file.get("size") or 0),
            }
            for file in files
        ]

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        file_id = self._extract_id(url, [r"/u/([A-Za-z0-9_-]+)", r"/api/file/([A-Za-z0-9_-]+)"])
        list_id = self._extract_id(url, [r"/l/([A-Za-z0-9_-]+)", r"/api/list/([A-Za-z0-9_-]+)"])

        async with httpx.AsyncClient(timeout=20, follow_redirects=True, verify=False) as client:
            if file_id:
                data = await self._fetch_json(client, f"{self.API_BASE}/file/{file_id}/info")
                if data and data.get("id") and self._looks_like_video(data):
                    return self._shape_file(file_id, data)
                return None

            if list_id:
                data = await self._fetch_json(client, f"{self.API_BASE}/list/{list_id}")
                if not data:
                    return None
                files = [item for item in (data.get("files") or []) if isinstance(item, dict) and item.get("id") and self._looks_like_video(item)]
                chosen = self._select_list_item(url, files)
                if chosen:
                    return self._shape_file(chosen["id"], chosen)

        return None
