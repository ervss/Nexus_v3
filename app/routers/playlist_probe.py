"""
Playlist Probe Router
======================
Rýchly server-side "fast fetch" pre karty playlistov v sekcii Related
playlists (napr. na xvideos.com watch stránke). Extension pošle URL
playlistu, tento endpoint stiahne prvú stránku a vráti súhrn: počet videí,
priemernú dĺžku, odhad priemernej veľkosti a dátum posledného pridania
(ak ho stránka vôbec ukazuje).

Zámerne NEprechádza celý playlist stránku po stránke — pri playlistoch
s tisíckami videí by to bolo pomalé a naťahovalo by to cieľovú stránku
zbytočne veľa requestami. Štatistiky sú odhad zo vzorky prvej stránky
(rovnaký kompromis ako `related_recommendations.py` robí pre related-search:
rýchla čiastočná odpoveď je lepšia než presný, ale pomalý výsledok).

POST /api/v1/playlist/probe   {"url": "https://www.xvideos.com/favorite/123/..."}
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
from typing import Optional

from curl_cffi import requests as cr
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/playlist", tags=["playlist-probe"])

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

_local = threading.local()


def _session() -> cr.Session:
    session = getattr(_local, "session", None)
    if session is None:
        session = cr.Session(impersonate="chrome")
        _local.session = session
    return session


class PlaylistProbeRequest(BaseModel):
    url: str


class PlaylistProbeResponse(BaseModel):
    url: str
    source: str
    video_count: Optional[int] = None
    sampled_count: int = 0
    avg_duration_sec: Optional[int] = None
    avg_duration: str = ""
    avg_size_mb: Optional[float] = None
    size_estimated: bool = True
    last_updated: str = ""


def _pretty_duration(seconds: int) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _duration_from_text(text: str) -> int:
    m = re.search(r"(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?", text or "")
    if m:
        if m.group(3) is not None:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        return int(m.group(1)) * 60 + int(m.group(2))
    m = re.search(r"(\d+)\s*min", text or "", re.I)
    return int(m.group(1)) * 60 if m else 0


def _identify_source(url: str) -> str:
    if re.search(r"(?:^|\.)xvideos\.(?:com|red)", url, re.I):
        return "xvideos"
    return "unknown"


async def _get_html(url: str) -> tuple[int, str]:
    def _do() -> tuple[int, str]:
        response = _session().get(
            url, headers={"User-Agent": _UA, "Referer": "https://www.xvideos.com/"},
            impersonate="chrome", timeout=15, allow_redirects=True)
        return response.status_code, response.text
    return await asyncio.to_thread(_do)


def _probe_xvideos_playlist(html: str) -> dict:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html or "", "html.parser")

    video_count: Optional[int] = None
    # The playlist header shows a count somewhere near "N videos" — try a few
    # tolerant spots before falling back to counting the sampled cards.
    header_text = ""
    for selector in ("h2", ".header", ".playlist-header", "title"):
        el = soup.select_one(selector)
        if el:
            header_text += " " + el.get_text(" ", strip=True)
    m = re.search(r"([\d][\d,\.]*)\s*videos?", header_text, re.I)
    if m:
        try:
            video_count = int(re.sub(r"[,\.]", "", m.group(1)))
        except ValueError:
            video_count = None

    cards = soup.select("div.thumb-block")
    durations: list[int] = []
    heights: list[int] = []
    for block in cards:
        block_text = block.get_text(" ", strip=True)
        duration_el = block.select_one(".duration, [class*='duration']")
        dur = _duration_from_text(duration_el.get_text(" ", strip=True) if duration_el else block_text)
        if dur:
            durations.append(dur)
        hd_el = block.select_one(".video-hd-mark, [class*='hd-mark'], .quality")
        hd_text = hd_el.get_text(" ", strip=True) if hd_el else ""
        if re.search(r"\b4k|2160\b", hd_text, re.I):
            heights.append(2160)
        else:
            hm = re.search(r"\b(1440|1080|720|480|360)\b", hd_text)
            if hm:
                heights.append(int(hm.group(1)))

    if video_count is None:
        video_count = len(cards) or None

    avg_duration_sec = round(sum(durations) / len(durations)) if durations else None

    # No page exposes real file size for a playlist card — estimate from the
    # sampled durations/resolutions using the same bitrate assumption the
    # XVideos hub adapter uses for its own size estimates (~2.5 Mbit/s at
    # 1080p, scaled by resolution). This is clearly marked `size_estimated`.
    avg_size_mb = None
    if durations:
        avg_height = round(sum(heights) / len(heights)) if heights else 720
        bits_per_sec = 2_500_000 * (avg_height / 1080) ** 1.4
        avg_size_mb = round(bits_per_sec * (sum(durations) / len(durations)) / 8 / 1_048_576, 1)

    last_updated = ""
    date_el = soup.select_one("[class*='date'], .updated, .last-update")
    if date_el:
        last_updated = date_el.get_text(" ", strip=True)

    return {
        "video_count": video_count,
        "sampled_count": len(cards),
        "avg_duration_sec": avg_duration_sec,
        "avg_duration": _pretty_duration(avg_duration_sec) if avg_duration_sec else "",
        "avg_size_mb": avg_size_mb,
        "size_estimated": True,
        "last_updated": last_updated,
    }


@router.post("/probe", response_model=PlaylistProbeResponse)
async def probe_playlist(payload: PlaylistProbeRequest) -> PlaylistProbeResponse:
    url = (payload.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="Missing url")

    source = _identify_source(url)
    if source != "xvideos":
        raise HTTPException(status_code=400, detail=f"Unsupported playlist source: {source}")

    try:
        status, html = await _get_html(url)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[playlist-probe] fetch failed for %s: %s", url, exc)
        raise HTTPException(status_code=502, detail="Nepodarilo sa načítať playlist") from exc

    if status != 200:
        raise HTTPException(status_code=502, detail=f"Playlist HTTP {status}")

    stats = _probe_xvideos_playlist(html)
    return PlaylistProbeResponse(url=url, source=source, **stats)
