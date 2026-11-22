import asyncio
import html
import json
import logging
import re
from typing import Optional, Dict, Any, List
from urllib.parse import urljoin, quote

from bs4 import BeautifulSoup
import httpx

from .base import VideoExtractor


class TurboExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "Turbo"

    def can_handle(self, url: str) -> bool:
        return "turbo.cr" in url

    def _extract_id(self, url: str) -> str:
        raw = str(url or "").strip()
        match = re.search(r"turbo\.cr\/(?:v|d|embed)\/([^/?#]+)", raw, re.I)
        if match:
            return match.group(1)
        match_cdn = re.search(r"turbocdn\.st\/(?:turbo\/data\/|data\/)?([A-Za-z0-9_-]+)\.mp4", raw, re.I)
        return match_cdn.group(1) if match_cdn else ""

    def _canonical_watch_url(self, url: str) -> str:
        turbo_id = self._extract_id(url)
        return f"https://turbo.cr/v/{turbo_id}" if turbo_id else str(url or "").strip()

    def _embed_url(self, url: str) -> str:
        turbo_id = self._extract_id(url)
        return f"https://turbo.cr/embed/{turbo_id}" if turbo_id else ""

    def _parse_page(self, page_html: str, page_url: str) -> Dict[str, Any]:
        soup = BeautifulSoup(page_html, "html.parser")

        def _meta(prop: str) -> str:
            direct = soup.find("meta", property=prop)
            if direct and direct.get("content"):
                return html.unescape(str(direct["content"]).strip())
            reverse = soup.find("meta", attrs={"name": prop})
            if reverse and reverse.get("content"):
                return html.unescape(str(reverse["content"]).strip())
            return ""

        stream_url = ""

        direct_var = re.search(r'const\s+VIDEO_DIRECT\s*=\s*["\']([^"\']+)["\'];', page_html)
        if direct_var:
            candidate = html.unescape(direct_var.group(1)).lstrip("\\")
            stream_url = urljoin(page_url, candidate)

        if not stream_url:
            patterns = [
                r'(https?:\/\/[^"\'\\<>\s]+turbocdn[^"\'\\<>\s]+\.mp4[^"\'\\<>\s]*)',
                r'["\'](\/data\/[^"\']+\.mp4[^"\']*)["\']',
            ]
            for pattern in patterns:
                match = re.search(pattern, page_html, re.I)
                if match:
                    stream_url = urljoin(page_url, html.unescape(match.group(1)))
                    break

        # Legacy direct link still appears in HTML (VIDEO_DIRECT) but is
        # hotlink-blocked and 404s server-side for ANY extension (.mp4/.mov/...).
        # Drop it so we fall through to the signed /api/sign URL.
        if re.match(r"^https?:\/\/turbo\.cr\/[^/?#]+\.[a-z0-9]{2,4}(?:\?|$)", stream_url, re.I):
            stream_url = ""

        title = (_meta("og:title") or (soup.title.text.strip() if soup.title and soup.title.text else "") or "Turbo video")
        title = re.sub(r"\s+[^A-Za-z0-9]+\s*turbo\.cr\s*$", "", title, flags=re.I).strip() or "Turbo video"

        thumbnail = _meta("og:image")
        if not thumbnail:
            poster = soup.select_one("video[poster]")
            if poster:
                thumbnail = html.unescape(str(poster.get("poster", "")).strip())
        if thumbnail:
            thumbnail = urljoin(page_url, thumbnail)
        # Turbo's legacy og:image (cdn.turbo.cr/thumbs/{id}.jpg) was a dead abuse-parked
        # redirect that 404s. Discard it. If missing or invalid, fall back to the
        # canonical static poster CDN (static.scdn.st) for the video ID.
        if re.search(r"cdn\.turbo\.cr/thumbs/", thumbnail, re.I):
            thumbnail = ""
        if not thumbnail:
            turbo_id = self._extract_id(page_url)
            if turbo_id:
                thumbnail = f"https://static.scdn.st/6049fd43-838b-492d-a20a-9aead716dfe7/thumbs/{turbo_id}.jpg"

        duration_raw = _meta("og:video:duration") or _meta("video:duration")
        try:
            duration = int(float(duration_raw or 0))
        except Exception:
            duration = 0

        if duration == 0:
            duration_match = re.search(r'>\s*(?:Duration|Length|Time):\s*(?:<\/?[^>]+>\s*)*(\d{1,2}:\d{2}(?::\d{2})?)\s*<', page_html, re.I)
            if not duration_match:
                duration_match = re.search(r'class=["\']time["\'][^>]*>\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*<', page_html, re.I)
            if duration_match:
                parts = duration_match.group(1).split(":")
                if len(parts) == 3:
                    duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                elif len(parts) == 2:
                    duration = int(parts[0]) * 60 + int(parts[1])

        width = 0
        height = 0
        title_lower = title.lower()
        if stream_url:
            stream_lower = stream_url.lower()
            if "2160" in stream_lower or "4k" in title_lower:
                width, height = 3840, 2160
            elif "1080" in stream_lower or "1080p" in title_lower:
                width, height = 1920, 1080
            elif "720" in stream_lower or "720p" in title_lower:
                width, height = 1280, 720
            elif "480" in stream_lower or "480p" in title_lower:
                width, height = 854, 480
            elif "360" in stream_lower or "360p" in title_lower:
                width, height = 640, 360

        return {
            "title": title,
            "thumbnail": thumbnail,
            "duration": duration,
            "width": width,
            "height": height,
            "stream_url": stream_url,
        }

    async def _extract_with_client(self, url: str, client: httpx.AsyncClient) -> Optional[Dict[str, Any]]:
        """Core extraction logic reusable with a shared client."""
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
            ),
            "Referer": "https://turbo.cr/",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
        canonical_url = self._canonical_watch_url(url)
        embed_url = self._embed_url(canonical_url)
        turbo_id = self._extract_id(canonical_url)

        # Fire watch page and sign API simultaneously — cuts latency from 2 round-trips to 1
        async def _get_watch():
            r = await client.get(canonical_url, headers=headers)
            r.raise_for_status()
            return r

        async def _get_sign():
            if not turbo_id:
                return None
            r = await client.get(
                f"https://turbo.cr/api/sign?v={turbo_id}",
                headers={**headers, "Accept": "application/json, text/plain, */*", "Referer": embed_url or canonical_url},
            )
            return r if r.is_success else None

        watch_resp, sign_resp = await asyncio.gather(_get_watch(), _get_sign(), return_exceptions=True)

        if isinstance(watch_resp, Exception):
            raise watch_resp

        parsed = self._parse_page(watch_resp.text, canonical_url)

        # Apply sign URL if watch page didn't contain stream
        if not parsed.get("stream_url") and sign_resp and not isinstance(sign_resp, Exception):
            try:
                sign_data = sign_resp.json()
                signed = str(sign_data.get("url") or "").strip()
                if re.match(r"^https?://", signed, re.I):
                    parsed["stream_url"] = signed
            except Exception:
                pass

        # Embed fallback only if both above failed
        if not parsed.get("stream_url") and embed_url:
            embed_resp = await client.get(embed_url, headers={**headers, "Referer": canonical_url})
            if embed_resp.is_success:
                embed_parsed = self._parse_page(embed_resp.text, embed_url)
                for key in ("title", "thumbnail", "duration"):
                    if not parsed.get(key) and embed_parsed.get(key):
                        parsed[key] = embed_parsed[key]
                if embed_parsed.get("stream_url"):
                    parsed["stream_url"] = embed_parsed["stream_url"]

        if not parsed.get("stream_url"):
            raise ValueError("Direct Turbo stream not found")

        # Prefer static poster thumbnail from static.scdn.st if resolved or fallback to turbo_id
        thumbnail = parsed.get("thumbnail") or ""
        if not thumbnail and turbo_id:
            thumbnail = f"https://static.scdn.st/6049fd43-838b-492d-a20a-9aead716dfe7/thumbs/{turbo_id}.jpg"
        if not thumbnail and re.search(r"turbocdn\.st/", parsed["stream_url"], re.I):
            thumbnail = "/api/tester/frame?url=" + quote(parsed["stream_url"], safe="")

        return {
            "id": turbo_id,
            "title": parsed.get("title") or "Turbo video",
            "description": "",
            "thumbnail": thumbnail,
            "duration": parsed.get("duration") or 0,
            "stream_url": parsed["stream_url"],
            "width": 0,
            "height": 0,
            "tags": [],
            "uploader": "",
            "is_hls": False,
        }

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
                return await self._extract_with_client(url, client)
        except Exception as e:
            logging.error(f"Turbo extraction failed for {url}: {e}")
            return None

    @staticmethod
    def _decode_js_string(value: str) -> str:
        try:
            return json.loads(f'"{value}"')
        except (TypeError, ValueError, json.JSONDecodeError):
            return html.unescape(str(value or "").replace(r"\/", "/"))

    def _parse_album_entries(self, page_html: str, album_url: str) -> List[Dict[str, Any]]:
        """Parse Turbo's current JS-backed album listing (`const FILES`)."""
        block_match = re.search(r"const\s+FILES\s*=\s*\[(.*?)\]\s*;", page_html, re.I | re.S)
        if not block_match:
            return []

        soup = BeautifulSoup(page_html, "html.parser")
        heading = soup.find("h1")
        album_title = heading.get_text(" ", strip=True) if heading else "Turbo album"
        entries: List[Dict[str, Any]] = []

        def string_field(body: str, field: str) -> str:
            match = re.search(rf'(?:^|,)\s*{re.escape(field)}\s*:\s*"((?:\\.|[^"\\])*)"', body, re.S)
            return self._decode_js_string(match.group(1)) if match else ""

        def int_field(body: str, field: str) -> int:
            match = re.search(rf'(?:^|,)\s*{re.escape(field)}\s*:\s*(-?\d+(?:\.\d+)?)', body)
            try:
                return int(float(match.group(1))) if match else 0
            except (TypeError, ValueError):
                return 0

        for object_match in re.finditer(r"\{(.*?)\}", block_match.group(1), re.S):
            body = object_match.group(1)
            video_id = string_field(body, "id").strip()
            if not video_id:
                continue
            title = string_field(body, "name").strip() or f"{video_id}.mp4"
            thumbnail = string_field(body, "thumb").strip()
            if not thumbnail or re.search(r"cdn\.turbo\.cr/thumbs/", thumbnail, re.I):
                thumbnail = f"https://static.scdn.st/6049fd43-838b-492d-a20a-9aead716dfe7/thumbs/{video_id}.jpg"
            size_bytes = max(0, int_field(body, "size"))
            watch_url = f"https://turbo.cr/v/{video_id}"
            entries.append({
                "id": video_id,
                "title": title,
                "album_title": album_title,
                "url": watch_url,
                "source_url": watch_url,
                "album_url": album_url,
                "thumbnail": thumbnail,
                "duration": max(0, int_field(body, "dur")),
                "size_bytes": size_bytes,
                "size_mb": round(size_bytes / (1024 * 1024), 1) if size_bytes else None,
                "views": max(0, int_field(body, "views")),
                "stream_url": "",
                "is_hls": False,
            })
        return entries

    async def extract_album_entries(self, url: str) -> List[Dict[str, Any]]:
        if not re.search(r"turbo\.cr/a/[^/?#]+", str(url or ""), re.I):
            return []
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
            ),
            "Referer": "https://turbo.cr/",
        }
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=headers) as client:
                response = await client.get(url)
                response.raise_for_status()
                return self._parse_album_entries(response.text, url)
        except Exception as exc:
            logging.error("Turbo album entries extraction failed for %s: %s", url, exc)
            return []

    async def extract_album(self, url: str) -> List[str]:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
            ),
            "Referer": "https://turbo.cr/",
        }

        found_urls: List[str] = []
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=headers) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                parsed_entries = self._parse_album_entries(resp.text, url)
                if parsed_entries:
                    return [entry["url"] for entry in parsed_entries]

                soup = BeautifulSoup(resp.text, "html.parser")

                rows = soup.find_all("tr", class_="file-row")
                for row in rows:
                    video_id = str(row.get("data-id") or "").strip()
                    if video_id:
                        found_urls.append(f"https://turbo.cr/v/{video_id}")

                if not found_urls:
                    links = soup.find_all("a", href=re.compile(r"/(?:a|v)/[^/?#]+"))
                    for link in links:
                        href = str(link.get("href") or "").strip()
                        if not href:
                            continue
                        found_urls.append(urljoin("https://turbo.cr", href))

            return list(dict.fromkeys(found_urls))
        except Exception as e:
            logging.error(f"Turbo album extraction failed for {url}: {e}")
            return []
