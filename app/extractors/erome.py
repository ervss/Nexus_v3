import logging
import re
import urllib.parse
from typing import Optional, Dict, Any, List
from bs4 import BeautifulSoup
from curl_cffi.requests import AsyncSession
from .base import VideoExtractor

logger = logging.getLogger(__name__)

class EromeExtractor(VideoExtractor):
    _CDN_HOST_PATTERNS = (
        "v.erome.com",
        "v1.erome.com",
        "v2.erome.com",
        "v3.erome.com",
        "v4.erome.com",
        "v40.erome.com",
    )

    @property
    def name(self) -> str:
        return "Erome"

    def can_handle(self, url: str) -> bool:
        # Avoid direct CDN links
        if any(x in (url or "") for x in self._CDN_HOST_PATTERNS):
            return False
        return "erome.com" in url.lower()

    async def _get_session(self) -> AsyncSession:
        return AsyncSession(impersonate="chrome120", timeout=30, verify=False)

    def _clean_title(self, raw: str, fallback: str = "") -> str:
        title = re.sub(r"\s+", " ", str(raw or "").strip())
        title = re.sub(r"\s*[-|]\s*Erome.*$", "", title, flags=re.I).strip()
        return title or fallback

    def _parse_duration_value(self, raw: Any) -> int:
        if raw is None:
            return 0
        if isinstance(raw, (int, float)):
            return max(0, int(float(raw)))
        text = str(raw).strip()
        if not text:
            return 0
        if re.fullmatch(r"\d+(?:\.\d+)?", text):
            return max(0, int(float(text)))
        match = re.search(r"(\d{1,2}:\d{2}(?::\d{2})?)", text)
        if match:
            text = match.group(1)
        parts = [p for p in text.split(":") if p.strip()]
        try:
            if len(parts) == 3:
                return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
            if len(parts) == 2:
                return int(parts[0]) * 60 + int(parts[1])
            return max(0, int(float(text)))
        except Exception:
            return 0

    def _normalize_media_url(self, page_url: str, candidate: str) -> str:
        raw = str(candidate or "").strip().replace("\\/", "/")
        if not raw:
            return ""
        full_url = urllib.parse.urljoin(page_url, raw)
        if full_url.startswith("//"):
            full_url = "https:" + full_url
        return full_url

    def _extract_source_id(self, url: str) -> str:
        parsed = urllib.parse.urlparse(url)
        path_bits = [part for part in parsed.path.split("/") if part]
        return path_bits[-1] if path_bits else "erome"

    def _extract_page_payload(self, page_url: str, html: str) -> Dict[str, Any]:
        soup = BeautifulSoup(html, "html.parser")
        fallback_id = self._extract_source_id(page_url)

        title_candidates = [
            soup.select_one("h1"),
            soup.select_one(".album-title"),
            soup.find("meta", property="og:title"),
            soup.find("title"),
        ]
        title = ""
        for candidate in title_candidates:
            if not candidate:
                continue
            if getattr(candidate, "name", "") == "meta":
                title = candidate.get("content", "")
            else:
                title = candidate.get_text(" ", strip=True)
            title = self._clean_title(title, fallback_id)
            if title:
                break

        thumbnail = ""
        for candidate in (
            soup.find("meta", property="og:image"),
            soup.find("meta", property="twitter:image"),
        ):
            if candidate and candidate.get("content"):
                thumbnail = self._normalize_media_url(page_url, candidate.get("content", ""))
                if thumbnail:
                    break
        if not thumbnail:
            poster_node = soup.select_one("video[poster], video[data-poster]")
            if poster_node:
                thumbnail = self._normalize_media_url(
                    page_url,
                    poster_node.get("poster") or poster_node.get("data-poster") or "",
                )

        streams: List[str] = []
        seen_streams = set()
        for node in soup.select("video source[src], video[src]"):
            src = node.get("src") or node.get("data-src")
            full_url = self._normalize_media_url(page_url, src or "")
            if full_url and full_url not in seen_streams:
                streams.append(full_url)
                seen_streams.add(full_url)

        regex_candidates = set()
        for match in re.finditer(r'https?://[^\s"\'<>\\]+\.mp4(?:\?[^\s"\'<>\\]*)?', html, re.I):
            regex_candidates.add(match.group(0))
        for match in re.finditer(r'"((?:https?:)?//[^"]+\.mp4[^"]*)"', html, re.I):
            regex_candidates.add(match.group(1))
        for candidate in regex_candidates:
            full_url = self._normalize_media_url(page_url, candidate)
            if full_url and full_url not in seen_streams:
                streams.append(full_url)
                seen_streams.add(full_url)

        page_level_durations: List[int] = []
        for meta_node in (
            soup.find("meta", property="video:duration"),
            soup.find("meta", property="og:video:duration"),
            soup.find("meta", itemprop="duration"),
        ):
            if meta_node:
                parsed = self._parse_duration_value(meta_node.get("content"))
                if parsed > 0:
                    page_level_durations.append(parsed)

        node_durations: List[int] = []
        for node in soup.select(".duration, .video-duration, time, [data-duration], [class*=duration]"):
            parsed = self._parse_duration_value(
                node.get("data-duration") or node.get_text(" ", strip=True)
            )
            if parsed > 0:
                node_durations.append(parsed)

        duration = 0
        page_duration = max(page_level_durations) if page_level_durations else 0
        node_total = sum(node_durations) if node_durations else 0
        node_max = max(node_durations) if node_durations else 0
        if len(streams) <= 1:
            duration = max(page_duration, node_max)
        else:
            duration = max(page_duration, node_total)

        height = 0
        for candidate in (
            soup.find("meta", property="og:video:height"),
            soup.find("meta", property="video:height"),
        ):
            try:
                height = int(candidate.get("content") or 0) if candidate else 0
            except Exception:
                height = 0
            if height > 0:
                break
        if height <= 0:
            title_match = re.search(r"\b(2160|1440|1080|720|480|360)p\b", title, re.I)
            if title_match:
                height = int(title_match.group(1))

        return {
            "id": fallback_id,
            "title": title or fallback_id,
            "thumbnail": thumbnail,
            "duration": duration,
            "height": height,
            "width": 0,
            "streams": streams,
            "video_count": len(streams),
        }

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Extracts metadata and the FIRST stream URL from an Erome page (album or single video).
        """
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://www.erome.com/'
        }

        try:
            async with await self._get_session() as session:
                resp = await session.get(url, headers=headers)
                resp.raise_for_status()
                
                # If it's not HTML, we can't parse it
                if 'text/html' not in resp.headers.get('Content-Type', '').lower():
                    return None

                payload = self._extract_page_payload(url, resp.text)
                stream_url = (payload.get("streams") or [None])[0]
                if not stream_url:
                    return None

                return {
                    "id": payload["id"],
                    "title": payload["title"],
                    "description": f"Extracted from Erome: {url}",
                    "thumbnail": payload["thumbnail"],
                    "duration": payload["duration"],
                    "stream_url": stream_url,
                    "source_url": url,
                    "width": payload["width"],
                    "height": payload["height"],
                    "tags": [],
                    "uploader": "Erome",
                    "is_hls": False,
                    "video_count": payload["video_count"],
                }

        except Exception as e:
            logger.error(f"Erome extraction failed for {url}: {e}")
            return None

    async def extract_album_entries(self, url: str) -> List[Dict[str, Any]]:
        """
        Return one metadata-rich entry per discovered stream inside an Erome album/page.
        """
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://www.erome.com/'
        }

        try:
            async with await self._get_session() as session:
                resp = await session.get(url, headers=headers)
                resp.raise_for_status()
                if 'text/html' not in resp.headers.get('Content-Type', '').lower():
                    return []

                payload = self._extract_page_payload(url, resp.text)
                streams = payload.get("streams") or []
                if not streams:
                    return []

                base_title = payload["title"]
                multiple = len(streams) > 1
                entries: List[Dict[str, Any]] = []
                for idx, stream_url in enumerate(streams, start=1):
                    entry_title = base_title
                    if multiple:
                        entry_title = f"{base_title} [{idx}/{len(streams)}]"
                    entries.append({
                        "id": payload["id"],
                        "title": entry_title,
                        "thumbnail": payload["thumbnail"],
                        "duration": payload["duration"],
                        "stream_url": stream_url,
                        "source_url": url,
                        "width": payload["width"],
                        "height": payload["height"],
                        "quality": f"{payload['height']}p" if payload.get("height") else "",
                    })
                return entries
        except Exception as e:
            logger.error(f"Erome album entries extraction failed for {url}: {e}")
            return []

    async def extract_album(self, url: str) -> List[str]:
        """
        Extracts all direct video stream URLs from an Erome album page.
        """
        entries = await self.extract_album_entries(url)
        return [entry["stream_url"] for entry in entries if entry.get("stream_url")]
