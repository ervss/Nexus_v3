import yt_dlp
import logging
import asyncio
import re
from urllib.parse import urlparse, urljoin
from .base import VideoExtractor, ntc_get
from typing import Optional, Dict, Any, List

# Listing-style XVideos URLs that contain many videos (favorites, playlists,
# galleries, channel/model/pornstar video lists). These are expanded by
# extract_album_entries() into every individual video.
_XV_LISTING_RE = re.compile(
    r"^/(?:favorite|playlists?|gallery|profiles)(?:/|$)",
    re.I,
)
_XV_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

class XVideosExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "XVideos"

    def can_handle(self, url: str) -> bool:
        return "xvideos.com" in url or "xvideos.red" in url

    def _is_listing_url(self, url: str) -> bool:
        return bool(_XV_LISTING_RE.search(urlparse(url or "").path))

    async def extract_album_entries(
        self,
        url: str,
        *,
        max_pages=None,
        max_entries=None,
        info=None,
        start_page=0,
    ) -> List[Dict[str, Any]]:
        """
        Expand an XVideos listing page (favorite / playlist / gallery / channel)
        into every video it contains, paginating until exhausted. Each entry's
        ``url`` is the normal watch page, so it resolves to a real stream at
        play/import time via the single-video extractor — exactly like a video
        added by hand.
        """
        if not self._is_listing_url(url):
            return []

        from bs4 import BeautifulSoup
        from app.ntc import NTCStatusError

        base = url.rstrip("/")
        # The base path itself is page 0; subsequent pages are /<n>.
        # Strip a trailing /<digits> the user may have pasted so we start clean.
        m_page = re.search(r"/(\d+)$", base)
        if m_page:
            base = base[: m_page.start()]

        headers = {
            "User-Agent": _XV_UA,
            "Referer": "https://www.xvideos.com/",
            "Accept-Language": "en-US,en;q=0.9",
        }

        entries: List[Dict[str, Any]] = []
        seen: set = set()
        MAX_PAGES = int(max_pages) if max_pages else 60
        MAX_ENTRIES = int(max_entries) if max_entries else 0

        try:
            first_page = max(0, int(start_page or 0))
        except (TypeError, ValueError):
            first_page = 0

        for page in range(first_page, first_page + MAX_PAGES):
                page_url = base if page == 0 else f"{base}/{page}"
                try:
                    html = await ntc_get(
                        page_url,
                        domain="xvideos.com",
                        headers=headers,
                        deadline=28.0,
                    )
                except NTCStatusError as exc:
                    logging.warning("[XVideos] listing HTTP %s: %s", exc.status_code, page_url)
                    break
                except Exception as exc:
                    logging.warning("[XVideos] listing fetch error %s: %s", page_url, exc)
                    break

                soup = BeautifulSoup(html, "html.parser")
                blocks = soup.select("div.thumb-block")
                if not blocks:
                    break

                if info is not None:
                    info["pages_loaded"] = int(info.get("pages_loaded") or 0) + 1

                new_on_page = 0
                for b in blocks:
                    link = b.select_one("p.title a") or b.select_one(".thumb-under a") or b.find("a", href=True)
                    if not link:
                        continue
                    href = link.get("href", "")
                    if "/video" not in href:
                        continue
                    # Strip the ?pl=…&plname=… playlist query so it's a clean watch URL.
                    full = urljoin("https://www.xvideos.com", href).split("?")[0]
                    if full in seen:
                        continue
                    seen.add(full)

                    title = (link.get("title") or link.get_text(strip=True) or "").strip()
                    if not title or re.fullmatch(r"\d{3,4}p", title):
                        # title attr can be the quality badge; fall back to slug
                        slug = full.rstrip("/").split("/")[-1]
                        title = slug.replace("_", " ").strip().capitalize()

                    img = b.find("img")
                    thumbnail = ""
                    if img:
                        src = img.get("data-src") or img.get("src") or ""
                        if src and not src.startswith("data:"):
                            thumbnail = src

                    duration = 0
                    meta = b.select_one(".duration") or b.find(class_=lambda c: c and "duration" in c)
                    dur_text = ""
                    if meta:
                        dur_text = meta.get_text(strip=True)
                    if not dur_text:
                        meta_block = b.select_one(".metadata")
                        if meta_block:
                            mm = re.search(r"(\d+)\s*min", meta_block.get_text(" ", strip=True))
                            if mm:
                                dur_text = f"{mm.group(1)} min"
                    mm = re.search(r"(\d+)\s*min", dur_text)
                    if mm:
                        duration = int(mm.group(1)) * 60

                    entries.append({
                        "url": full,
                        "source_url": full,
                        "title": title[:150],
                        "thumbnail": thumbnail,
                        "duration": duration,
                        "stream_url": "",  # resolved lazily at play/import time
                    })
                    new_on_page += 1

                if new_on_page == 0:
                    break
                if MAX_ENTRIES and len(entries) >= MAX_ENTRIES:
                    if info is not None:
                        info["truncated"] = True
                        info["next_page"] = page + 1
                    del entries[MAX_ENTRIES:]
                    break
                if page + 1 >= first_page + MAX_PAGES:
                    if info is not None:
                        info["truncated"] = True
                        info["next_page"] = page + 1
                    break

        logging.info("[XVideos] listing %s → %d videos", url, len(entries))
        return entries

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        if self._is_listing_url(url):
            return None
        # Normalize URL (convert red to com if needed for certain extractors, or keep it)
        # Actually xvideos.red usually works directly or redirects.

        # yt-dlp already scores every rendition in the HLS/mp4 ladder and picks
        # the highest one that genuinely exists (verified live: correctly
        # returns 720p when that IS the site's ceiling for a video, and 1080p+
        # when the ladder actually goes higher). A Playwright fallback used to
        # fire whenever this came back <=720p and unconditionally relabeled the
        # result as height=1080 — a hardcoded guess, not a measurement, and it
        # returns the same master .m3u8 yt-dlp already had rather than a
        # specific higher rendition. That silently lied about quality on every
        # video whose real ceiling is 480p/720p, which is most of the catalogue.
        # Only fall back when yt-dlp found nothing at all to resolve.
        meta = self._extract_ytdlp(url)
        if meta and meta.get('stream_url'):
            return meta

        try:
            from app.extractors.legacy.xvideos import XVideosExtractor as PWXVideos
            logging.info(f"yt-dlp found nothing for {url}, trying Playwright fallback...")
            xv = PWXVideos()
            pw_res = await xv.extract_metadata(url)

            if pw_res and pw_res.get('found'):
                is_hls = 'hls' in (pw_res.get('quality_source') or '').lower() or '.m3u8' in pw_res['stream_url']
                return {
                    "id": meta.get('id') if meta else None, # preserve ID if we had it
                    "title": pw_res['title'],
                    "description": "",
                    "thumbnail": pw_res.get('thumbnail_url'),
                    "duration": meta.get('duration') if meta else 0,
                    "stream_url": pw_res['stream_url'],
                    # Playwright never resolves a specific rendition height —
                    # it hands back the master manifest, whose actual playback
                    # quality is picked by the player's own ABR. Report unknown
                    # rather than a guessed number.
                    "width": 0,
                    "height": 0,
                    "tags": meta.get('tags') if meta else [],
                    "uploader": "",
                    "is_hls": is_hls
                }
        except ImportError:
            pass # Playwright extractor not available
        except Exception as e:
            logging.error(f"Playwright fallback failed: {e}")

        return meta # Return whatever we got from yt-dlp (even if it found nothing)

    def _extract_ytdlp(self, url: str) -> Optional[Dict[str, Any]]:
        import os
        email = os.getenv("XVIDEOS_EMAIL")
        password = os.getenv("XVIDEOS_PASSWORD")
        
        user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        ydl_opts = {
            'quiet': True, 'skip_download': True, 'extract_flat': False,
            # Prefer highest resolution MP4, then HLS, then anything
            'format': 'bestvideo[ext=mp4][height>=2160]+bestaudio/bestvideo[ext=mp4][height>=1080]+bestaudio/bestvideo+bestaudio/best',
            'ignoreerrors': True, 'no_warnings': True,
            'user_agent': user_agent,
            'http_headers': {'User-Agent': user_agent, 'Referer': 'https://www.xvideos.com/'}
        }
        
        if email and password:
            ydl_opts['username'] = email
            ydl_opts['password'] = password
        
        # Cookie file search order: dedicated xvideos > general cookies
        from pathlib import Path
        repo_root = Path(__file__).resolve().parents[2]
        cookie_candidates = [
            "xvideos.netscape.txt",
            str(repo_root / "xvideos.netscape.txt"),
            str(repo_root / "app" / "xvideos.netscape.txt"),
            "xvideos.cookies.txt",
            str(repo_root / "xvideos.cookies.txt"),
            str(repo_root / "app" / "xvideos.cookies.txt"),
            "cookies.netscape.txt",
            str(repo_root / "cookies.netscape.txt"),
            str(repo_root / "app" / "cookies.netscape.txt"),
        ]
        for cookie_path in cookie_candidates:
            if os.path.exists(cookie_path):
                ydl_opts['cookiefile'] = cookie_path
                break
        
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info: return None

                formats = info.get('formats', [])
                valid_formats = []
                for f in formats:
                    if not f.get('url'): continue
                    height = f.get('height') or 0
                    if height == 0:
                        note = (f.get('format_note') or '') + (f.get('format_id') or '')
                        match = re.search(r'(\d{3,4})p', note)
                        if match: height = int(match.group(1))
                    
                    is_hls = '.m3u8' in f.get('url', '') or 'hls' in f.get('protocol', '').lower()
                    is_mp4 = f.get('ext', '') == 'mp4' or '.mp4' in f.get('url', '')
                    
                    # For HLS without detected resolution, assume 1080 (conservative)
                    if is_hls and height == 0: height = 1080
                    
                    # Score: prefer MP4 at high res, then HLS
                    # Bonus for MP4 (easier to seek/stream), penalty for HLS unless high res
                    score = height * 10
                    if is_mp4 and not is_hls: score += 5  # small MP4 bonus
                    
                    valid_formats.append({
                        'url': f['url'],
                        'height': height,
                        'is_hls': is_hls,
                        'is_mp4': is_mp4,
                        'score': score,
                        'format_id': f.get('format_id', '')
                    })

                # Sort: highest score first
                valid_formats.sort(key=lambda x: x['score'], reverse=True)
                best = valid_formats[0] if valid_formats else {
                    'url': info.get('url'), 'height': 0, 'is_hls': False, 'is_mp4': False, 'score': 0
                }
                
                logging.info(f"[XVideos] Best format: {best.get('height')}p {'HLS' if best['is_hls'] else 'MP4'} for {url}")

                return {
                    "id": info.get('id'),
                    "title": info.get('title'),
                    "description": info.get('description'),
                    "thumbnail": info.get('thumbnail'),
                    "duration": info.get('duration'),
                    "stream_url": best['url'],
                    "width": 0,
                    "height": best['height'],
                    "tags": info.get('tags', []),
                    "uploader": info.get('uploader'),
                    "is_hls": best.get('is_hls', False)
                }
        except Exception as e:
            logging.warning(f"[XVideos] yt-dlp failed for {url}: {e}")
            return None
