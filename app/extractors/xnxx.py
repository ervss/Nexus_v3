import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, Optional

import yt_dlp

from .base import VideoExtractor


_XNXX_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


class XnxxExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "XNXX"

    def can_handle(self, url: str) -> bool:
        return "xnxx.com" in (url or "").lower()

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        return self._extract_ytdlp(url)

    def _extract_ytdlp(self, url: str) -> Optional[Dict[str, Any]]:
        ydl_opts = {
            "quiet": True,
            "skip_download": True,
            "extract_flat": False,
            "format": "bestvideo[ext=mp4][height>=2160]+bestaudio/bestvideo[ext=mp4][height>=1080]+bestaudio/bestvideo+bestaudio/best",
            "ignoreerrors": True,
            "no_warnings": True,
            "user_agent": _XNXX_UA,
            "http_headers": {
                "User-Agent": _XNXX_UA,
                "Referer": "https://www.xnxx.com/",
                "Accept-Language": "en-US,en;q=0.9",
            },
        }

        repo_root = Path(__file__).resolve().parents[2]
        cookie_candidates = [
            "xnxx.netscape.txt",
            str(repo_root / "xnxx.netscape.txt"),
            str(repo_root / "app" / "xnxx.netscape.txt"),
            "xnxx.cookies.txt",
            str(repo_root / "xnxx.cookies.txt"),
            str(repo_root / "app" / "xnxx.cookies.txt"),
            "cookies.netscape.txt",
            str(repo_root / "cookies.netscape.txt"),
            str(repo_root / "app" / "cookies.netscape.txt"),
        ]
        for cookie_path in cookie_candidates:
            if os.path.exists(cookie_path):
                ydl_opts["cookiefile"] = cookie_path
                break

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info:
                    return None

                best = self._pick_best_format(info)
                if not best.get("url"):
                    return None

                logging.info(
                    "[XNXX] Best format: %sp %s for %s",
                    best.get("height") or 0,
                    "HLS" if best.get("is_hls") else "MP4",
                    url,
                )

                return {
                    "id": info.get("id"),
                    "title": info.get("title"),
                    "description": info.get("description"),
                    "thumbnail": info.get("thumbnail"),
                    "duration": info.get("duration"),
                    "stream_url": best["url"],
                    "width": best.get("width") or 0,
                    "height": best.get("height") or 0,
                    "tags": info.get("tags", []),
                    "uploader": info.get("uploader"),
                    "is_hls": bool(best.get("is_hls")),
                }
        except Exception as exc:
            logging.warning("[XNXX] yt-dlp failed for %s: %s", url, exc)
            return None

    @staticmethod
    def _pick_best_format(info: Dict[str, Any]) -> Dict[str, Any]:
        valid_formats = []
        for fmt in info.get("formats") or []:
            fmt_url = fmt.get("url")
            if not fmt_url:
                continue

            height = int(fmt.get("height") or 0)
            if height == 0:
                note = f"{fmt.get('format_note') or ''} {fmt.get('format_id') or ''}"
                match = re.search(r"(\d{3,4})p", note)
                if match:
                    height = int(match.group(1))

            is_hls = ".m3u8" in fmt_url or "hls" in str(fmt.get("protocol") or "").lower()
            is_mp4 = fmt.get("ext") == "mp4" or ".mp4" in fmt_url
            if is_hls and height == 0:
                height = 1080

            score = height * 10
            if is_mp4 and not is_hls:
                score += 5

            valid_formats.append(
                {
                    "url": fmt_url,
                    "height": height,
                    "width": int(fmt.get("width") or 0),
                    "is_hls": is_hls,
                    "score": score,
                }
            )

        valid_formats.sort(key=lambda item: item["score"], reverse=True)
        if valid_formats:
            return valid_formats[0]
        return {
            "url": info.get("url"),
            "height": int(info.get("height") or 0),
            "width": int(info.get("width") or 0),
            "is_hls": ".m3u8" in str(info.get("url") or ""),
        }
