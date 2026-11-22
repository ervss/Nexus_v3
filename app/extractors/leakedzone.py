"""Extractor pre platformu Leakedzone (leakedzone.com).

Podporuje videá, shorty aj fotky.
Dekóduje obfuskovaný parameter JWPlayera: f("...") pomocou obojstranného orezania (16 znakov),
obrátenia reťazca a Base64 dekódovania na platný HLS (.m3u8) stream.
"""
from __future__ import annotations

import base64
import html
import re
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from .base import VideoExtractor


def decode_leakedzone_token(encoded: str) -> Optional[str]:
    """Dekóduje zašifrovaný token videa z funkcie f(s) na Leakedzone."""
    if not encoded or len(encoded) <= 32:
        return None
    try:
        # Odstráni prvých 16 a posledných 16 znakov
        trimmed = encoded[16:-16]
        # Obráti reťazec
        reversed_str = trimmed[::-1]
        # Base64 decode
        decoded = base64.b64decode(reversed_str).decode("utf-8", errors="ignore").strip()
        if decoded.startswith("http://") or decoded.startswith("https://"):
            return decoded
        return None
    except Exception:
        return None


class LeakedzoneExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "Leakedzone"

    def can_handle(self, url: str) -> bool:
        if not url:
            return False
        try:
            host = (urlparse(url).hostname or "").lower()
            return host == "leakedzone.com" or host.endswith(".leakedzone.com")
        except Exception:
            return False

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        if not self.can_handle(url):
            return None

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": "https://leakedzone.com/",
        }

        cookies = {}
        try:
            async with httpx.AsyncClient(headers=headers, timeout=15.0, follow_redirects=True) as client:
                resp = await client.get(url)
                if resp.status_code >= 400:
                    return None
                page_html = resp.text
                cookies = dict(client.cookies) if hasattr(client, "cookies") else dict(getattr(resp, "cookies", {}))
        except Exception:
            return None

        soup = BeautifulSoup(page_html, "html.parser")

        # Názov
        h1 = soup.find("h1")
        title_text = h1.get_text(" ", strip=True) if h1 else ""
        if not title_text:
            title_tag = soup.find("title")
            title_text = title_tag.get_text(" ", strip=True) if title_tag else ""
        if not title_text:
            meta_title = soup.find("meta", property="og:title")
            title_text = meta_title.get("content", "") if meta_title else ""

        title = re.sub(r"\s*-\s*Leakedzone\s*$", "", title_text, flags=re.I).strip()
        if not title:
            title = "Leakedzone video"

        # Popis
        desc_meta = soup.find("meta", attrs={"name": "description"}) or soup.find("meta", property="og:description")
        description = desc_meta.get("content", "").strip() if desc_meta else ""

        # Uploader / Model
        path_parts = [p for p in urlparse(url).path.split("/") if p]
        uploader = path_parts[0] if path_parts and path_parts[0] not in ("video", "short", "photo", "creators") else ""

        # ID
        video_id = ""
        id_match = re.search(r"/(?:video|short|photo)/(\d+)", url)
        if id_match:
            video_id = id_match.group(1)

        # Náhľad
        thumbnail = ""
        mp = soup.find(id="media-player")
        if mp:
            mp_img = mp.find("img")
            if mp_img and mp_img.get("src"):
                thumbnail = mp_img["src"]
        if not thumbnail:
            og_img = soup.find("meta", property="og:image")
            if og_img and og_img.get("content"):
                thumbnail = og_img["content"]

        # Hľadanie zašifrovaného streamu v skriptoch
        stream_url = ""
        encoded_match = re.search(r'file:\s*f\(\s*["\']([^"\']+)["\']\s*\)', page_html)
        if encoded_match:
            stream_url = decode_leakedzone_token(encoded_match.group(1)) or ""

        # Ak stream nie je v JWPlayeri (napr. fotka)
        is_photo = False
        if not stream_url:
            photo_img = soup.select_one("img.w-full.h-auto, img[src*='/storage/images/']")
            if photo_img and photo_img.get("src"):
                stream_url = photo_img["src"]
                is_photo = True
                if not thumbnail:
                    thumbnail = stream_url

        if not stream_url:
            return None

        # POZNÁMKA: Leakedzone m3u8 token je single-use (jednorazový).
        # Nesmieme ho predčasne sťahovať pre zistenie trvania, inak by bol pre prehrávač neplatný.
        is_hls = ".m3u8" in stream_url.lower()

        return {
            "id": video_id,
            "title": title,
            "description": description,
            "thumbnail": thumbnail,
            "duration": 0,
            "stream_url": stream_url,
            "playback_referer": url,
            "source_url": url,
            "uploader": uploader,
            "quality": "HD",
            "is_hls": is_hls,
            "size_bytes": 0,
            "proxy_cookies": cookies,
        }
