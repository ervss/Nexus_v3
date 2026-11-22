import re
import logging
import aiohttp
import asyncio
from bs4 import BeautifulSoup
from typing import Optional, Dict, Any
from .base import VideoExtractor

logger = logging.getLogger(__name__)


class WhoresHubExtractor(VideoExtractor):
    """Extractor for WhoresHub videos."""

    @property
    def name(self) -> str:
        return "WhoresHub"

    @property
    def domains(self):
        return ["whoreshub.com", "www.whoreshub.com"]

    def can_handle(self, url: str) -> bool:
        """Check if this extractor can handle the given URL."""
        return any(domain in url for domain in self.domains)

    def _is_listing_url(self, url: str) -> bool:
        from urllib.parse import urlparse
        return bool(re.search(r"/(?:playlists?|models?|categories|search|tags)/",
                              urlparse(url or "").path, re.I))

    async def extract_album_entries(self, url: str):
        """
        Expand a WhoresHub playlist / model / category listing into every video.
        Entry url is the /videos/<id>/<slug> watch page → resolved lazily.
        """
        if not self._is_listing_url(url):
            return []
        from urllib.parse import urljoin
        try:
            from curl_cffi import requests as creq
        except Exception:
            return []

        # WhoresHub 404s without the trailing slash — keep it.
        base = url.split("#")[0].split("?")[0].rstrip("/")
        headers = {"Referer": "https://www.whoreshub.com/"}
        entries = []
        seen = set()
        MAX_PAGES = 50
        try:
            if True:
                for page in range(1, MAX_PAGES + 1):
                    page_url = f"{base}/" if page == 1 else f"{base}/{page}/"
                    try:
                        resp = await asyncio.to_thread(
                            lambda: creq.get(page_url, impersonate="chrome", timeout=20, headers=headers))
                        if resp.status_code != 200:
                            break
                        html = resp.text
                    except Exception as e:
                        logging.warning("[WhoresHub] playlist fetch error %s: %s", page_url, e)
                        break
                    soup = BeautifulSoup(html, "html.parser")
                    links = [a for a in soup.select('a[href*="/videos/"]')
                             if re.search(r"/videos/\d+/", a.get("href", ""))]
                    if not links:
                        break
                    new_on_page = 0
                    for a in links:
                        href = a.get("href", "")
                        full = urljoin("https://www.whoreshub.com", href).split("?")[0]
                        if full in seen:
                            continue
                        seen.add(full)
                        img = a.find("img")
                        title = (a.get("title") or (img.get("alt") if img else "") or a.get_text(strip=True) or "").strip()
                        if not title:
                            slug = href.rstrip("/").split("/")[-1]
                            title = slug.replace("-", " ").strip().capitalize()
                        thumb = ""
                        if img:
                            src = img.get("data-original") or img.get("data-src") or img.get("src") or ""
                            if src.startswith("//"):
                                src = "https:" + src
                            if src and not src.startswith("data:"):
                                thumb = src
                        entries.append({
                            "url": full, "source_url": full,
                            "title": title[:150], "thumbnail": thumb,
                            "duration": 0, "stream_url": "",
                        })
                        new_on_page += 1
                    if new_on_page == 0:
                        break
        except Exception as e:
            logging.error("[WhoresHub] album extract failed: %s", e)
        logging.info("[WhoresHub] listing %s → %d videos", url, len(entries))
        return entries

    def _ranked_own_files(self, html: str, page_url: str):
        """Own get_file renditions, highest label first.

        Preview clips from other cards on the watch page are ignored. A label
        with no height (the unsuffixed file) stays last so a missing 1080p can
        fall through to 720p.
        """
        page_id = ""
        id_match = re.search(r"/videos/(\d+)", page_url or "", re.I)
        if id_match:
            page_id = id_match.group(1)
        text = (html or "").replace("\\/", "/")
        found = re.findall(
            r"https?://[^\"'\s<>]+/get_file/[^\"'\s<>]+\.mp4/?(?:\?[^\"'\s<>]*)?",
            text,
            re.I,
        )
        ranked = []
        seen = set()
        for raw in found:
            stream = raw.replace("&amp;", "&").strip()
            low = stream.lower()
            if any(token in low for token in ("preview", "trailer", "sample")):
                continue
            if page_id and not re.search(rf"/{re.escape(page_id)}(?:[._/]|$)", low):
                continue
            if stream in seen:
                continue
            seen.add(stream)
            height_match = re.search(r"_(\d{3,4})p\.mp4", low)
            height = int(height_match.group(1)) if height_match else 0
            ranked.append((stream, height))
        ranked.sort(key=lambda item: item[1], reverse=True)
        return ranked

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Extract video metadata and direct stream URL from WhoresHub.
        OPTIMIZED: Fast regex-based extraction, similar to Porntrex.
        Handles both direct video URLs and embedded players (Streamtape, Dood, etc.)

        Args:
            url: WhoresHub video URL

        Returns:
            Dictionary with video metadata or None if extraction fails
        """
        try:
            logger.info(f"[WHORESHUB_FAST] Extracting metadata from {url}")

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': 'https://whoreshub.com/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            }

            # Fetch page asynchronously
            html = None
            try:
                async with aiohttp.ClientSession(headers=headers) as session:
                    async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                        if resp.status != 200:
                            logger.error(f"[WHORESHUB_FAST] HTTP {resp.status} for {url}")
                            return None
                        html = await resp.text()
            except Exception as e:
                logger.error(f"[WHORESHUB_FAST] Failed to fetch {url}: {e}")
                return None

            if not html:
                return None

            ranked_files = self._ranked_own_files(html, url)
            fallback_urls = [item[0] for item in ranked_files[1:]]

            # FAST PATH: Extract metadata using REGEX FIRST (avoid BeautifulSoup overhead)

            # Extract title - FAST regex first
            title = "WhoresHub Video"
            title_match = re.search(r'<title>(.*?)</title>', html, re.IGNORECASE)
            if title_match:
                title = title_match.group(1).replace(' - WhoresHub', '').replace(' - WHORESHUB', '').strip()
            else:
                # Fallback: og:title meta tag
                title_match = re.search(r'<meta\s+property=["\']og:title["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
                if title_match:
                    title = title_match.group(1).strip()

            # Extract thumbnail - FAST regex
            thumbnail = None
            thumb_match = re.search(r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
            if thumb_match:
                thumbnail = thumb_match.group(1)
            else:
                # Fallback: poster attribute
                poster_match = re.search(r'poster=["\']([^"\']+)["\']', html, re.IGNORECASE)
                if poster_match:
                    thumbnail = poster_match.group(1)
            
            if thumbnail and thumbnail.startswith('//'):
                thumbnail = 'https:' + thumbnail

            # Extract duration - FAST regex
            duration = 0
            
            # Strategy 1: Check icon-duration pattern
            time_match = re.search(r'icon-duration.*?value[^>]*>\s*(\d+):(\d+)(?::(\d+))?\s*<', html, re.DOTALL | re.IGNORECASE)
            if time_match:
                try:
                    if time_match.group(3):  # HH:MM:SS
                        duration = int(time_match.group(1)) * 3600 + int(time_match.group(2)) * 60 + int(time_match.group(3))
                    else:  # MM:SS
                        duration = int(time_match.group(1)) * 60 + int(time_match.group(2))
                except:
                    pass

            if duration == 0:
                duration_match = re.search(r'<meta\s+property=["\']video:duration["\']\s+content=["\'](\d+)["\']', html, re.IGNORECASE)
                if duration_match:
                    try:
                        duration = int(duration_match.group(1))
                    except:
                        pass

            if duration == 0:
                # Alternative duration pattern
                duration_match = re.search(r'duration["\']?\s*[:=]\s*["\']?(\d+)', html, re.IGNORECASE)
                if duration_match:
                    try:
                        duration = int(duration_match.group(1))
                    except:
                        pass
                        
            # Extract size - Check for MB/GB
            size_bytes = None
            size_match = re.search(r'(?i)(\d+(?:\.\d+)?)\s*(MB|GB|KB)', html)
            if size_match:
                try:
                    val = float(size_match.group(1))
                    unit = size_match.group(2).upper()
                    if unit == 'GB':
                        size_bytes = int(val * 1024 * 1024 * 1024)
                    elif unit == 'MB':
                        size_bytes = int(val * 1024 * 1024)
                    elif unit == 'KB':
                        size_bytes = int(val * 1024)
                except:
                    pass

            # Only create BeautifulSoup if we need it for fallback
            soup = None

            # FAST PATH: Extract video sources using REGEX FIRST (like Porntrex)
            stream_url = None
            width = 0
            height = 0
            is_hls = False

            # Strategy 1: FAST - Regex search for quality URLs in HTML (PRIORITY)
            # Own get_file renditions first. The highest label is not always
            # on the CDN (this title's 1080p 404s while 720p plays), so the
            # rest are returned as fallbacks for the stream proxy.
            if ranked_files:
                stream_url = ranked_files[0][0]
                height = ranked_files[0][1]
                width = int(height * 16 / 9) if height else 0
                logger.info("[WHORESHUB_FAST] Using %sp get_file with %d fallback(s)", height or "?", len(fallback_urls))

            for quality in [] if ranked_files else ['2160p', '1440p', '1080p', '720p', '480p', '360p']:
                patterns = [
                    rf'["\']?{quality}["\']?\s*:\s*["\'](https?://[^"\']+\.(?:mp4|m3u8)[^"\']*)["\']',
                    rf'{quality.replace("p", "")}\s*:\s*["\'](https?://[^"\']+\.(?:mp4|m3u8)[^"\']*)["\']',
                    rf'file\s*:\s*["\'](https?://[^"\']+\.(?:mp4|m3u8)[^"\']+)["\'][^}}]*label\s*:\s*["\']?{quality}',
                    rf'video_{quality}\s*:\s*["\'](https?://[^"\']+\.(?:mp4|m3u8)[^"\']*)["\']',
                ]

                for pattern in patterns:
                    match = re.search(pattern, html, re.IGNORECASE)
                    if match:
                        stream_url = match.group(1).replace('\\/', '/')
                        if '.m3u8' in stream_url:
                            is_hls = True
                        height = int(quality.replace('p', ''))
                        width = int(height * 16 / 9)
                        logger.info(f"[WHORESHUB_FAST] Found {quality} URL via regex (HLS={is_hls})")
                        break

                if stream_url:
                    break
                    
            # Strategy 1.5: FAST - Check for KVS style variables
            if not stream_url:
                best_height = 0
                for k in ['video_url', 'video_alt_url', 'video_alt_url2', 'video_alt_url3', 'video_alt_url4']:
                    m_url = re.search(rf"{k}:\s*'(https?://[^']+)'", html)
                    m_text = re.search(rf"{k}_text:\s*'([^']+)'", html)
                    if m_url:
                        url_val = m_url.group(1)
                        if '.m3u8' in url_val:
                            is_hls = True
                        h = 720
                        if m_text:
                            text = m_text.group(1)
                            if '2160' in text or '4K' in text.upper(): h = 2160
                            elif '1440' in text: h = 1440
                            elif '1080' in text: h = 1080
                            elif '720' in text: h = 720
                            elif '480' in text: h = 480
                            elif '360' in text: h = 360
                            
                        if h > best_height:
                            best_height = h
                            stream_url = url_val
                            height = h
                            width = int(h * 16 / 9)
                            logger.info(f"[WHORESHUB_FAST] Found URL via KVS {k} ({h}p)")

            # Strategy 2: FAST - Find any MP4 or M3U8 URL in HTML
            if not stream_url:
                video_matches = re.findall(r'(https?://[^\s"\'<>]+\.(?:mp4|m3u8)[^\s"\'<>]*)', html)
                if video_matches:
                    for video_url in video_matches:
                        if '2160' in video_url or '4k' in video_url.lower():
                            stream_url = video_url
                            height = 2160
                            width = 3840
                            break
                        elif '1440' in video_url:
                            stream_url = video_url
                            height = 1440
                            width = 2560
                            break
                        elif '1080' in video_url:
                            stream_url = video_url
                            height = 1080
                            width = 1920
                            break
                        elif '720' in video_url:
                            stream_url = video_url
                            height = 720
                            width = 1280
                            break

                    if not stream_url and video_matches:
                        stream_url = video_matches[0]
                        height = 720
                        width = 1280

                    if stream_url and '.m3u8' in stream_url:
                        is_hls = True

            # Strategy 3: Check for embedded iframes
            if not stream_url:
                iframe_match = re.search(r'<iframe[^>]+src=["\']([^"\']+)["\']', html, re.IGNORECASE)
                if iframe_match:
                    iframe_src = iframe_match.group(1)
                    logger.info(f"[WHORESHUB_FAST] Found embedded player: {iframe_src}")

                    # Detect quality
                    if '2160' in iframe_src or '4k' in iframe_src.lower():
                        height, width = 2160, 3840
                    elif '1440' in iframe_src:
                        height, width = 1440, 2560
                    elif '1080' in iframe_src or 'fhd' in iframe_src.lower():
                        height, width = 1080, 1920
                    elif '720' in iframe_src or 'hd' in iframe_src.lower():
                        height, width = 720, 1280
                    else:
                        height, width = 720, 1280
                    stream_url = iframe_src

            # Strategy 4: SLOW FALLBACK - Parse video tag sources
            if not stream_url:
                logger.info(f"[WHORESHUB_FAST] Regex extraction failed, trying video tag parsing...")
                soup = BeautifulSoup(html, 'html.parser')
                video_tag = soup.find('video')
                if video_tag:
                    source_tags = video_tag.find_all('source')
                    best_source = None
                    best_height = 0

                    for source in source_tags:
                        src = source.get('src')
                        src_type = source.get('type', '').lower()
                        label = source.get('label', '').lower()
                        res = source.get('res', '').lower()

                        if src:
                            if '.m3u8' in src or 'application/x-mpegurl' in src_type:
                                is_hls = True
                            h = 0
                            if '2160' in label or '4k' in label or '2160' in res: h = 2160
                            elif '1440' in label or '1440' in res: h = 1440
                            elif '1080' in label or '1080' in res: h = 1080
                            elif '720' in label or '720' in res: h = 720
                            elif '480' in label or '480' in res: h = 480

                            if h > best_height:
                                best_height = h
                                best_source = src

                    if best_source:
                        stream_url = best_source
                        height = best_height if best_height > 0 else 720
                        width = int(height * 16 / 9)

            if not stream_url:
                logger.error(f"[WHORESHUB_FAST] No stream URL found for {url}, trying yt-dlp...")
                try:
                    def _ydl_extract():
                        import yt_dlp
                        ydl_opts = {
                            'quiet': True, 'no_warnings': True, 'ignoreerrors': True,
                            'socket_timeout': 15, 'retries': 2, 'format': 'best'
                        }
                        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                            return ydl.extract_info(url, download=False)
                    
                    info = await asyncio.to_thread(_ydl_extract)
                    if info and info.get('url'):
                        stream_url = info['url']
                        height = info.get('height', 720)
                        width = info.get('width', 1280)
                        if info.get('duration'):
                            duration = int(info['duration'])
                        logger.info(f"[WHORESHUB_FAST] yt-dlp extracted: {height}p")
                    else:
                        return None
                except Exception as e:
                    logger.error(f"[WHORESHUB_FAST] yt-dlp extraction failed: {e}")
                    return None

            # Extract views - FAST regex
            views = 0
            views_match = re.search(r'(\d+(?:,\d+)*)\s*views?', html, re.IGNORECASE)
            if views_match:
                try: views = int(views_match.group(1).replace(',', ''))
                except: pass

            # Extract tags - FAST regex
            tags = []
            tags_matches = re.findall(r'(?:class=["\'](?:tag|category)[^>]*>|/tags?/[^"\'<>]+["\'])[^>]*>([^<]+)</a>', html, re.IGNORECASE)
            if tags_matches:
                tags = [tag.strip() for tag in tags_matches if tag.strip()]

            # Extract uploader - FAST regex
            uploader = ""
            uploader_match = re.search(r'(?:uploader|author|user|channel)[^>]*>([^<]+)</a>', html, re.IGNORECASE)
            if uploader_match:
                uploader = uploader_match.group(1).strip()

            return {
                "id": None,
                "title": title,
                "description": "",
                "thumbnail": thumbnail,
                "duration": duration,
                "stream_url": stream_url,
                "width": width,
                "height": height,
                "tags": tags,
                "views": views,
                "upload_date": None,
                "uploader": uploader,
                "is_hls": is_hls,
                "size_bytes": size_bytes,
                "fallback_urls": fallback_urls,
            }

        except Exception as e:
            logger.error(f"[WHORESHUB] Extraction failed for {url}: {e}", exc_info=True)
            return None
