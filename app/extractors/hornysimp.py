import re
from typing import Any, Dict, List, Optional

import aiohttp
from bs4 import BeautifulSoup
from curl_cffi.requests import AsyncSession

from .leakporner import LeakPornerExtractor

import logging
import asyncio

logger = logging.getLogger(__name__)


class HornySimpExtractor(LeakPornerExtractor):
    @property
    def name(self) -> str:
        return "HornySimp"

    def can_handle(self, url: str) -> bool:
        low = (url or "").lower()
        return "hornysimp" in low

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        """
        HornySimp always skips the first embed (Player 01 – an HLS-only stream
        that never resolves to a direct MP4) and starts from the second embed.
        Falls back to remaining embeds or yt-dlp if the second also fails.
        """
        result = await self._parse_and_resolve_hornysimp(url)
        if not result or not self._is_direct_playable_url(result.get("stream_url")):
            # Last resort: try yt-dlp on the page itself
            ytdlp = await asyncio.to_thread(self._try_ytdlp, url)
            if ytdlp and self._is_direct_playable_url(ytdlp.get("stream_url")):
                result = ytdlp
            elif result:
                pass  # keep whatever partial result we have
            elif ytdlp:
                result = ytdlp

        if not result:
            return None

        # Normalize identity / title
        result["uploader"] = "HornySimp"
        title = str(result.get("title") or "")
        title = re.sub(r"\s*-\s*(?:leakporner|hornysimp)\s*$", "", title, flags=re.I).strip()
        result["title"] = title or "HornySimp Video"
        if not result.get("description"):
            result["description"] = result["title"]

        return result

    async def _parse_and_resolve_hornysimp(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Same as LeakPornerExtractor._parse_and_resolve but always drops the
        first embed URL (index 0) and resolves starting from index 1.
        """
        try:
            headers = {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
                "Referer": "https://hornysimp.com/",
            }
            async with AsyncSession(impersonate="chrome") as cf_session:
                resp = await cf_session.get(url, headers={"Referer": "https://hornysimp.com/"}, timeout=15)
                if resp.status_code != 200:
                    return None
                html = resp.text

            soup = BeautifulSoup(html, "lxml")

            # --- Title ---
            title = (soup.find("meta", property="og:title") or {}).get("content", "")
            if not title:
                h1 = soup.find("h1", class_="entry-title")
                title = (
                    h1.get_text(strip=True)
                    if h1
                    else (
                        soup.title.get_text(strip=True) if soup.title else "HornySimp Video"
                    )
                )
            title = re.sub(r"\s*-\s*(?:leakporner|hornysimp)\s*$", "", title, flags=re.I).strip()

            # --- Thumbnail ---
            thumbnail = (soup.find("meta", property="og:image") or {}).get("content", "")

            # --- Duration ---
            dur_span = soup.find("span", class_="duration")
            duration = 0.0
            if dur_span:
                dur_text = dur_span.get_text(strip=True).replace("\xa0", "").strip()
                parts = [p for p in re.split(r"[:\s]+", dur_text) if p.isdigit()]
                if len(parts) == 3:
                    duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                elif len(parts) == 2:
                    duration = int(parts[0]) * 60 + int(parts[1])

            # --- Collect ALL embed URLs ---
            all_embeds: List[str] = self._collect_embed_urls(html, soup)
            logger.info(
                "[HornySimp] Found %d embed URLs for %s: %s",
                len(all_embeds),
                url,
                all_embeds,
            )

            # ALWAYS skip the first embed (Player 01) – it never yields a direct MP4.
            # Start from index 1; keep index 0 as ultimate fallback only.
            if len(all_embeds) >= 2:
                priority_embeds = all_embeds[1:]    # start from Player 02
                fallback_embeds = all_embeds[:1]    # Player 01 as last resort
            else:
                priority_embeds = all_embeds
                fallback_embeds = []

            video_id = url.rstrip("/").split("/")[-1] or url.rstrip("/").split("/")[-2]
            stream_url: Optional[str] = None

            async with aiohttp.ClientSession(headers=headers) as session:
                # 1. Try priority embeds (Player 02, 03, …)
                for embed_url in priority_embeds[:4]:
                    candidate = await self._resolve_embed(embed_url, session, url)
                    if candidate:
                        logger.info(
                            "[HornySimp] Resolved (priority) embed %s -> %s",
                            embed_url,
                            candidate[:80],
                        )
                        stream_url = candidate
                        break

                # 2. If still nothing, try the first embed as a last resort
                if not stream_url:
                    for embed_url in fallback_embeds:
                        candidate = await self._resolve_embed(embed_url, session, url)
                        if candidate:
                            logger.info(
                                "[HornySimp] Resolved (fallback/Player01) embed %s -> %s",
                                embed_url,
                                candidate[:80],
                            )
                            stream_url = candidate
                            break

            # 3. Direct media URL na hlavnej stránke (napr. fileditchvids.st/*.mp4)
            if not stream_url:
                direct_page_media = self._extract_direct_media_url(html, url)
                if direct_page_media and self._is_direct_playable_url(direct_page_media):
                    stream_url = direct_page_media

            # 4. yt-dlp on best embed
            if not stream_url and priority_embeds:
                ytdlp = await asyncio.to_thread(self._try_ytdlp, priority_embeds[0])
                if ytdlp:
                    stream_url = ytdlp.get("stream_url")
                    if not thumbnail and ytdlp.get("thumbnail"):
                        thumbnail = ytdlp["thumbnail"]

            # 5. Absolute fallback: use embed URL directly (iframe playback)
            if not stream_url:
                stream_url = (priority_embeds + fallback_embeds + [url])[0]

            # Route custom-encrypted cdnvids/cdnstream streams through their playable iframe embeds instead.
            # Standard Hls.js throws media parsing errors due to custom-encrypted .image segments on TikTok CDN.
            if stream_url and any(d in stream_url.lower() for d in ("cdnvids.top", "cdnstream.top")):
                matching_embed = next((e for e in priority_embeds if any(d in e.lower() for d in ("bysezoxexe.com", "398fitus.com"))), None)
                stream_url = matching_embed or (priority_embeds + fallback_embeds + [url])[0]
                logger.info(f"[HornySimp] Direct HLS stream is custom-encrypted. Using iframe fallback: {stream_url}")

            height = 1080
            title_lower = title.lower()
            if "4k" in title_lower or "2160" in title_lower:
                height = 2160
            elif "720" in title_lower or "hd" in title_lower:
                height = 720

            size_bytes = 0
            if duration > 0:
                size_bytes = int((duration / 60) * 25) * 1024 * 1024

            return {
                "id": video_id,
                "title": title,
                "description": title,
                "thumbnail": thumbnail,
                "duration": duration,
                "stream_url": stream_url,
                "width": 0,
                "height": height,
                "size_bytes": size_bytes,
                "tags": [],
                "uploader": "HornySimp",
                "is_hls": ".m3u8" in (stream_url or "").lower(),
                "embed_urls": all_embeds,
            }
        except Exception as exc:
            logger.error("[HornySimp] Extraction failed for %s: %s", url, exc)
            return None
