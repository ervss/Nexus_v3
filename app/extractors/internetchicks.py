"""Refresh InternetChicks imports from their stable post and player links."""

import html
import re
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from .base import VideoExtractor


class InternetChicksExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "InternetChicks"

    def can_handle(self, url: str) -> bool:
        host = (urlparse(url).hostname or "").lower()
        return host == "internetchicks.com" or host.endswith(".internetchicks.com")

    @staticmethod
    def _supported_player(url: str) -> bool:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        domains = ("streamtape.com", "voe.sx", "doodstream.com", "dood.watch", "playmogo.com")
        return parsed.scheme in {"http", "https"} and any(
            host == domain or host.endswith("." + domain) for domain in domains
        )

    async def extract(self, url: str):
        if not self.can_handle(url):
            return None
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"}
        try:
            async with httpx.AsyncClient(headers=headers, timeout=15, follow_redirects=True) as client:
                response = await client.get(url)
                response.raise_for_status()
        except (httpx.HTTPError, ValueError):
            return None

        soup = BeautifulSoup(response.text, "html.parser")
        title = (soup.find("h1") or soup.find("title"))
        title = title.get_text(" ", strip=True) if title else "InternetChicks video"
        players = []
        for button in soup.select("button.button_choice_server[onclick]"):
            match = re.search(r"playEmbed\(\s*['\"](https?://[^'\"]+)['\"]", button.get("onclick", ""), re.I)
            if not match:
                continue
            player_url = html.unescape(match.group(1))
            if self._supported_player(player_url) and player_url not in players:
                players.append(player_url)
        if not players:
            return None

        # These checkers resolve provider tokens and validate the resulting
        # media. Mirror embeds and unrelated links are intentionally skipped.
        from app.checkers.orchestrator import CheckerOrchestrator

        results = await CheckerOrchestrator().check_batch(players[:8])
        playable = [(player, result) for player, result in zip(players, results) if result.direct_url]
        if not playable:
            return None
        player_url, best = max(playable, key=lambda item: item[1].size_bytes or 0)
        return {
            "title": title,
            "stream_url": best.direct_url,
            "source_url": url,
            "playback_referer": player_url,
            "is_hls": ".m3u8" in best.direct_url.lower(),
            "quality": best.quality,
            "size_bytes": best.size_bytes,
        }
