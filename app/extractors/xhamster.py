import logging
import asyncio
import yt_dlp
from datetime import datetime, timezone
from typing import Optional, Dict, Any
from .base import VideoExtractor

logger = logging.getLogger(__name__)

class XHamsterExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "xHamster"

    def can_handle(self, url: str) -> bool:
        return "xhamster.com" in url.lower()

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Extracts metadata and stream URL from xHamster using yt-dlp.
        This replaces the old Playwright logic, making it 10x faster and more reliable.
        """
        def _extract():
            try:
                ydl_opts = {
                    'quiet': True,
                    'no_warnings': True,
                    'skip_download': True,
                    'format': 'best[protocol*=m3u8]/best[ext=mp4]/bestvideo+bestaudio/best',
                    'extract_flat': False,
                    'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                }
                
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                    
                if not info:
                    return None
                    
                stream_url = info.get('url')
                if not stream_url and info.get('formats'):
                    fmts = [f for f in info.get('formats', []) if f.get('url')]
                    if fmts:
                        fmts.sort(key=lambda f: (f.get('height') or 0), reverse=True)
                        stream_url = fmts[0]['url']
                        
                height = int(info.get('height') or 0)
                duration = float(info.get('duration') or 0.0)

                # yt-dlp normally exposes xHamster's published date as the
                # compact YYYYMMDD value.  Keep the shared tester contract
                # (`upload_date`) populated; otherwise the card has all other
                # metadata but no date to render.
                upload_date = (info.get('upload_date') or info.get('release_date') or '')
                if not upload_date and info.get('timestamp'):
                    try:
                        timestamp = int(info['timestamp'])
                        if timestamp > 10**12:
                            timestamp //= 1000
                        upload_date = datetime.fromtimestamp(
                            timestamp, timezone.utc
                        ).strftime('%Y-%m-%d')
                    except (TypeError, ValueError, OSError, OverflowError):
                        upload_date = ''

                # xHamster serves HLS, so there is no single file to measure and yt-dlp
                # reports neither filesize nor filesize_approx. The renditions do carry a
                # bitrate, so derive the size the same way the browser extension does:
                # tbr (kbit/s) * duration / 8. This is an ESTIMATE, not a true byte count.
                size_bytes = info.get('filesize') or info.get('filesize_approx')
                size_estimated = False
                if not size_bytes and duration > 0:
                    rated = [f for f in (info.get('formats') or [])
                             if f.get('tbr') and (f.get('height') or 0) <= (height or 10 ** 6)]
                    if rated:
                        best = max(rated, key=lambda f: (f.get('height') or 0, f['tbr']))
                        size_bytes = int(best['tbr'] * 1000 * duration / 8)
                        size_estimated = True

                return {
                    "id": info.get('id', ''),
                    "title": info.get('title', ''),
                    "description": info.get('description', ''),
                    "thumbnail": info.get('thumbnail'),
                    "duration": duration,
                    "stream_url": stream_url,
                    "width": int(info.get('width') or 0),
                    "height": height,
                    "size_bytes": size_bytes,
                    "size_estimated": size_estimated,
                    "tags": info.get('tags', []),
                    "uploader": info.get('uploader', ''),
                    "upload_date": str(upload_date or ''),
                    "is_hls": bool(stream_url and '.m3u8' in stream_url)
                }
            except Exception as e:
                logger.error(f"xHamster yt-dlp extraction failed for {url}: {e}")
                return None

        # Run yt-dlp extraction in a separate thread so we don't block the async loop
        return await asyncio.to_thread(_extract)
