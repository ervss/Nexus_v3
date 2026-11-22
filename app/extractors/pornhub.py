import logging
import asyncio
import json
import os
import re
import subprocess
import tempfile
import shutil
import time
import requests as http_requests
from pathlib import Path
import yt_dlp
from yt_dlp.networking.impersonate import ImpersonateTarget
from typing import Optional, Dict, Any
from .base import VideoExtractor

logger = logging.getLogger(__name__)

class PornhubExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "Pornhub"

    def can_handle(self, url: str) -> bool:
        return "pornhub.com" in url.lower() or "pornhub.org" in url.lower() or "pornhub.net" in url.lower()

    def _is_listing_url(self, url: str) -> bool:
        from urllib.parse import urlparse
        return bool(re.search(r"/(?:playlist|favorites|model|pornstar|channels|users)/",
                              urlparse(url or "").path, re.I))

    async def extract_album_entries(self, url: str):
        """
        Expand a Pornhub playlist / favorites / model listing into every video.
        Each entry's url is the normal /view_video.php watch page → resolved to a
        stream lazily at play/import, exactly like a hand-added video.
        """
        if not self._is_listing_url(url):
            return []
        from urllib.parse import urljoin
        from bs4 import BeautifulSoup
        from .base import ntc_get
        from app.ntc import NTCStatusError

        base = url.split("#")[0].split("?")[0].rstrip("/")
        host_m = re.match(r"(https?://[^/]+)", url)
        host = host_m.group(1) if host_m else "https://www.pornhub.com"
        headers = {"Referer": "https://www.pornhub.com/",
                   "Cookie": "accessAgeDisclaimerPH=1; accessPH=1; platform=pc; age_verified=1"}

        entries = []
        seen = set()
        MAX_PAGES = 50
        for page in range(1, MAX_PAGES + 1):
            page_url = base if page == 1 else f"{base}?page={page}"
            # Pornhub intermittently serves a tiny JS challenge page instead of
            # the real listing; retry until we get a full page.
            html = ""
            for _attempt in range(4):
                try:
                    html = await ntc_get(
                        page_url,
                        domain="pornhub.com",
                        headers=headers,
                        deadline=20,
                        impersonate="chrome",
                    )
                    status_ok = True
                except NTCStatusError as e:
                    logging.warning("[Pornhub] playlist fetch HTTP %s: %s", e.status_code, page_url)
                    html = ""
                    status_ok = False
                except Exception as e:
                    logging.warning("[Pornhub] playlist fetch error %s: %s", page_url, e)
                    html = ""
                    status_ok = False
                    break
                if not status_ok:
                    html = ""
                    break
                if len(html) > 20000:
                    break
                await asyncio.sleep(0.6)
            if not html:
                break
            soup = BeautifulSoup(html, "html.parser")
            blocks = soup.select("li.pcVideoListItem")
            if not blocks:
                break
            new_on_page = 0
            for li in blocks:
                a = li.select_one('a[href*="view_video"]') or li.find("a", href=True)
                if not a:
                    continue
                href = a.get("href", "")
                if "view_video" not in href:
                    continue
                full = urljoin(host, href).split("&")[0]
                if full in seen:
                    continue
                seen.add(full)
                title = ""
                st = li.select_one("span.title a")
                if st:
                    title = st.get_text(strip=True)
                if not title:
                    title = (a.get("title") or "").strip()
                if not title:
                    img = li.find("img")
                    title = (img.get("alt") if img else "") or ""
                dur = ""
                dv = li.select_one("var.duration")
                if dv:
                    dur = dv.get_text(strip=True)
                duration = 0
                mm = re.match(r"(?:(\d+):)?(\d+):(\d+)$", dur)
                if mm:
                    duration = (int(mm.group(1) or 0) * 3600 +
                                int(mm.group(2)) * 60 + int(mm.group(3)))
                img = li.find("img")
                thumb = ""
                if img:
                    thumb = img.get("data-src") or img.get("data-thumb_url") or img.get("src") or ""
                entries.append({
                    "url": full, "source_url": full,
                    "title": (title or "Pornhub video")[:150],
                    "thumbnail": thumb, "duration": duration, "stream_url": "",
                })
                new_on_page += 1
            if new_on_page == 0:
                break
        logging.info("[Pornhub] playlist %s → %d videos", url, len(entries))
        return entries

    async def extract(self, url: str, resolve_stream: bool = True) -> Optional[Dict[str, Any]]:
        """
        Extracts metadata and stream URL from Pornhub using yt-dlp with curl_cffi and impersonation.
        Listing/discovery should pass resolve_stream=False so yt-dlp is not run.
        """
        if not resolve_stream:
            from .base import ntc_get
            headers = {
                "Referer": "https://www.pornhub.com/",
                "Cookie": "accessAgeDisclaimerPH=1; accessPH=1; platform=pc; age_verified=1",
            }
            try:
                html = await ntc_get(url, domain="pornhub.com", headers=headers, deadline=28.0)
            except Exception as exc:
                logger.warning("[Pornhub] lazy watch fetch failed for %s: %s", url, exc)
                html = ""
            title = ""
            thumb = ""
            if html:
                tm = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', html, re.I)
                if tm:
                    title = tm.group(1).strip()
                im = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', html, re.I)
                if im:
                    thumb = im.group(1).strip()
            return {
                "id": "",
                "title": title or "Pornhub video",
                "description": "",
                "thumbnail": thumb,
                "duration": 0,
                "stream_url": "",
                "width": 0,
                "height": 0,
                "tags": [],
                "uploader": "",
                "is_hls": False,
            }

        def _solve_challenge(html: str) -> Optional[str]:
            if not shutil.which('node'):
                logger.error("Node.js is not installed or not in PATH! Required for Pornhub JS challenge.")
                return None

            # Find the script containing leastFactor
            scripts = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)
            js_code = None
            for s in scripts:
                if "leastFactor" in s:
                    js_code = s
                    break
                    
            if not js_code:
                return None
                
            js_code = js_code.replace("<!--", "").replace("//-->", "").strip()
            js_code = js_code.replace("if (typeof phantom !== 'undefined') return 'phantom';", "")
            js_code = js_code.replace("if (typeof module !== 'undefined' && module.exports) return 'node';", "")
            
            full_js = f"""
            var document = {{ 
                cookie: "",
                location: {{
                    reload: function() {{}},
                    href: ""
                }}
            }};
            var window = {{
                document: document,
                location: document.location
            }};
            {js_code}
            try {{
                go();
            }} catch(e) {{
                // Ignore runtime crashes inside go() after cookie is set
            }}
            console.log(document.cookie);
            """
            
            # Using mkstemp and closing it to prevent file-locking issues on Windows
            fd, temp_path = tempfile.mkstemp(suffix='.js')
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    f.write(full_js)
                res = subprocess.run(['node', temp_path], capture_output=True, text=True, timeout=5)
                if res.returncode == 0:
                    return res.stdout.strip()
            except Exception as e:
                logger.warning(f"Node challenge execution failed: {e}")
            finally:
                if os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except Exception:
                        pass
            return None

        def _extract():
            temp_cookiefile = None
            try:
                repo_root = Path(__file__).resolve().parents[2]
                
                # Step 1: Initialize cookies dictionary
                cookies = {}
                
                # Step 2: Load existing Netscape cookies if available
                cookie_candidates = [
                    repo_root / "cookies.netscape.txt",
                    repo_root / "app" / "cookies.netscape.txt",
                    Path("cookies.netscape.txt")
                ]
                
                for candidate in cookie_candidates:
                    if candidate.exists():
                        try:
                            with open(candidate, "r", encoding="utf-8", errors="ignore") as f:
                                for line in f:
                                    if not line.strip() or line.startswith("#"):
                                        continue
                                    parts = line.strip().split("\t")
                                    if len(parts) >= 7:
                                        cookies[parts[5]] = parts[6]
                            logger.info(f"Loaded existing cookies from {candidate}")
                            break
                        except Exception as e:
                            logger.warning(f"Failed to read existing cookies from {candidate}: {e}")
                
                # Step 3: Run stealth pre-request using NTC (curl_cffi preferred)
                source_page_html = ''
                try:
                    from app.ntc import ntc, NTCStatusError
                    headers_trigger = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    }
                    logger.info("Starting challenge trigger pre-request...")
                    try:
                        r = asyncio.run(ntc.request(url, domain="pornhub.com", headers=headers_trigger, deadline=15, cache=False))
                    except NTCStatusError as status_err:
                        class _Stub:
                            status_code = status_err.status_code
                            text = ""
                            cookies = {}
                        r = _Stub()
                    
                    # Merge cookies from fresh response
                    for name, value in (r.cookies or {}).items():
                        if str(value).lower() != 'deleted':
                            cookies[name] = value

                    if getattr(r, "status_code", None) in (404, 410):
                        logger.info(f"[Pornhub] Watch page returned HTTP {r.status_code} for {url}; skipping slow retries.")
                        return None
                        
                    logger.info(f"Pre-request status: {r.status_code}, length: {len(r.text)}, sample: {r.text[:250].strip().replace(chr(10), ' ')}")
                        
                    # Solve math challenge if present
                    if "onload=\"go()\"" in r.text or "leastFactor" in r.text:
                        logger.info("Challenge detected! Solving...")
                        solved_cookie = _solve_challenge(r.text)
                        if solved_cookie:
                            parts = solved_cookie.split(";")[0].split("=")
                            if len(parts) == 2:
                                cookies[parts[0].strip()] = parts[1].strip()
                                logger.info("Challenge solved successfully and cookie set.")
                    elif 'KEY' not in cookies:
                        logger.info("No KEY cookie present and no challenge in pre-request. Forcing challenge trigger...")
                        try:
                            r_force = asyncio.run(ntc.request(
                                url,
                                domain="pornhub.com",
                                headers={'User-Agent': 'curl/7.81.0'},
                                deadline=15,
                                cache=False,
                            ))
                            if "onload=\"go()\"" in r_force.text or "leastFactor" in r_force.text:
                                logger.info("Forced challenge detected! Solving...")
                                solved_cookie = _solve_challenge(r_force.text)
                                if solved_cookie:
                                    parts = solved_cookie.split(";")[0].split("=")
                                    if len(parts) == 2:
                                        cookies[parts[0].strip()] = parts[1].strip()
                                        logger.info("Forced challenge solved successfully and cookie set.")
                        except Exception as force_err:
                            logger.warning(f"Forced challenge trigger failed: {force_err}")
                                
                    # Always perform retry request with Chrome impersonation and solved cookies to get all session cookies
                    try:
                        headers_chrome = {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5',
                            'Referer': 'https://www.pornhub.com/',
                        }
                        logger.info("Performing session cookies fetch request with Chrome impersonation...")
                        r_session = asyncio.run(ntc.request(
                            url,
                            domain="pornhub.com",
                            headers=headers_chrome,
                            cookies=cookies,
                            impersonate="chrome",
                            deadline=15,
                            sticky_key="pornhub-login",
                            cache=False,
                        ))
                        for name, value in (r_session.cookies or {}).items():
                            if str(value).lower() != 'deleted':
                                cookies[name] = value
                        source_page_html = str(r_session.text or '')
                        logger.info(f"Session cookies fetch successful. Status: {r_session.status_code}, length: {len(source_page_html)}")
                    except Exception as retry_err:
                        logger.warning(f"Session cookies fetch request failed: {retry_err}")
                except Exception as pre_err:
                    logger.warning(f"Stealth pre-request failed: {pre_err}, falling back to static cookies.")

                # Step 4: Ensure mandatory age gate and platform cookies are set
                cookies['age_verified'] = '1'
                cookies['accessAgeDisclaimerPH'] = '1'
                cookies['accessAgeDisclaimerUK'] = '1'
                cookies['accessPH'] = '1'
                cookies['platform'] = 'pc'

                # Step 5: Save final merged cookie jar to temporary netscape format (closed immediately to prevent locks)
                fd, temp_cookiefile = tempfile.mkstemp(suffix='.txt')
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    f.write("# Netscape HTTP Cookie File\n")
                    f.write("# Generated programmatically by PornhubExtractor.\n\n")
                    for name, value in cookies.items():
                        f.write(f".pornhub.com\tTRUE\t/\tFALSE\t2085285221\t{name}\t{value}\n")
                        f.write(f"www.pornhub.com\tFALSE\t/\tFALSE\t2085285221\t{name}\t{value}\n")
                        f.write(f"pornhub.com\tFALSE\t/\tFALSE\t2085285221\t{name}\t{value}\n")
                        # Support mirror domains
                        f.write(f".pornhub.org\tTRUE\t/\tFALSE\t2085285221\t{name}\t{value}\n")
                        f.write(f".pornhub.net\tTRUE\t/\tFALSE\t2085285221\t{name}\t{value}\n")
                
                # Step 6: Configure ydl_opts with curl_cffi handler, impersonation, and cookies
                ydl_opts = {
                    'quiet': True,
                    'no_warnings': True,
                    'skip_download': True,
                    'format': 'best[protocol*=m3u8]/best[ext=mp4]/bestvideo+bestaudio/best',
                    'extract_flat': False,
                    'impersonate': ImpersonateTarget.from_str('chrome'),
                    'request_handler': 'curl_cffi',
                    'cookiefile': temp_cookiefile,
                    'http_headers': {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Referer': 'https://www.pornhub.com/',
                    }
                }
                
                # PornHub intermittently sends a one-off anti-bot page that
                # makes yt-dlp request PhantomJS.  A fresh request a moment
                # later normally returns the normal player payload, so retry
                # the extraction before declaring this playback unavailable.
                info = None
                last_extract_error = None
                for attempt in range(3):
                    try:
                        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                            info = ydl.extract_info(url, download=False)
                        if info:
                            break
                    except Exception as extract_error:
                        last_extract_error = extract_error
                        if attempt < 2:
                            time.sleep(1 + attempt)
                if not info:
                    logger.info('[Pornhub] yt-dlp unavailable; trying watch-page media definitions: %s', last_extract_error)
                    info = {}
                    
                # A Pornhub CDN URL can look valid while an edge has already
                # invalidated it.  Verify a small response with the cookies
                # from this exact extraction before we hand it to the player.
                # HLS is preferred because its manifest is rewritten through
                # the local proxy, preserving the same cookie session for its
                # media segments.
                def _is_hls(candidate_url: str) -> bool:
                    value = candidate_url.lower()
                    return '.m3u8' in value or '/hls/' in value

                def _candidate_works(candidate_url: str) -> bool:
                    try:
                        with http_requests.get(
                            candidate_url,
                            headers={
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
                                'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, video/*;q=0.9, */*;q=0.8',
                                'Accept-Language': 'en-US,en;q=0.9',
                                'Referer': url,
                                'Origin': 'https://www.pornhub.com',
                            },
                            cookies=cookies or None,
                            timeout=(8, 15),
                            stream=True,
                        ) as response:
                            if response.status_code not in (200, 206):
                                logger.info('[Pornhub] rejected CDN candidate HTTP %s', response.status_code)
                                return False
                            content_type = (response.headers.get('Content-Type') or '').lower()
                            if _is_hls(candidate_url):
                                sample = response.raw.read(2048, decode_content=True)
                                return 'mpegurl' in content_type or b'#EXTM3U' in sample
                            return content_type.startswith('video/') or 'octet-stream' in content_type
                    except (http_requests.RequestException, OSError) as probe_error:
                        logger.info('[Pornhub] CDN candidate probe failed: %s', probe_error)
                        return False

                candidates = []
                seen_urls = set()

                def _add_candidate(candidate_url, candidate_height=0):
                    candidate_url = str(candidate_url or '').strip()
                    if candidate_url and candidate_url not in seen_urls:
                        seen_urls.add(candidate_url)
                        quality = re.search(r'\d+', str(candidate_height or ''))
                        candidates.append({'url': candidate_url, 'height': int(quality.group()) if quality else 0})

                _add_candidate(info.get('url'), info.get('height'))
                for fmt in info.get('formats') or []:
                    if fmt.get('vcodec') == 'none' or fmt.get('acodec') == 'none':
                        continue
                    _add_candidate(fmt.get('url'), fmt.get('height') or 0)

                # yt-dlp can expose only an HLS URL from a CDN edge that has
                # already expired. The watch page carries the original direct
                # media definitions too; retain them as playback candidates.
                flashvars_duration = 0.0
                flashvars = re.search(r'var\s+flashvars_\d+\s*=\s*(\{.+?\})\s*;', source_page_html, re.DOTALL)
                if flashvars:
                    try:
                        flashvars_data = json.loads(flashvars.group(1))
                        try:
                            flashvars_duration = float(flashvars_data.get('video_duration') or 0.0)
                        except (ValueError, TypeError):
                            flashvars_duration = 0.0
                        definitions = flashvars_data.get('mediaDefinitions') or []
                        for definition in definitions:
                            media_url = definition.get('videoUrl')
                            if isinstance(media_url, str) and ('.mp4' in media_url.lower() or '.m3u8' in media_url.lower()):
                                _add_candidate(media_url, definition.get('quality') or 0)
                    except (ValueError, TypeError, AttributeError) as definitions_error:
                        logger.info('[Pornhub] media definitions unavailable: %s', definitions_error)

                # Successful ev-h edges have been more durable than hv-h for
                # older saved records. The probe remains authoritative.
                candidates.sort(key=lambda candidate: (
                    -candidate['height'],
                    0 if _is_hls(candidate['url']) else 1,
                    0 if 'ev-h.phncdn.com' in candidate['url'].lower() else 1,
                ))
                selected = next((candidate for candidate in candidates if _candidate_works(candidate['url'])), None)
                if not selected:
                    logger.warning('[Pornhub] no verified playable CDN candidate for %s', url)
                    return None

                stream_url = selected['url']
                height = selected['height'] or int(info.get('height') or 0)
                dur = float(info.get('duration') or flashvars_duration or 0.0)

                def _probe_mp4_size(mp4_url: str) -> int:
                    req_hdrs = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
                        'Referer': url,
                        'Origin': 'https://www.pornhub.com',
                    }
                    try:
                        r = http_requests.head(mp4_url, headers=req_hdrs, cookies=cookies or None, timeout=(5, 8), allow_redirects=True)
                        if r.status_code < 400:
                            cl = int(r.headers.get('Content-Length') or 0)
                            if cl > 50_000:
                                return cl
                        r2 = http_requests.get(mp4_url, headers={**req_hdrs, 'Range': 'bytes=0-0'}, cookies=cookies or None, timeout=(5, 8), stream=True)
                        with r2:
                            cr = str(r2.headers.get('Content-Range') or '')
                            m_cr = re.search(r'/(\d+)\s*$', cr)
                            if m_cr:
                                total = int(m_cr.group(1))
                                if total > 50_000:
                                    return total
                    except Exception:
                        pass
                    return 0

                # HLS streams carry no Content-Length, so filesize is usually
                # None. Try exact filesize from matching formats or direct MP4
                # candidate at the same height first, then fall back to an
                # estimate from filesize_approx or bitrate × duration.
                size_bytes = info.get('filesize') or None
                size_estimated = False

                if not size_bytes:
                    for fmt in info.get('formats') or []:
                        if fmt.get('vcodec') == 'none':
                            continue
                        fh = int(fmt.get('height') or 0)
                        if (height == 0 or fh == height) and fmt.get('filesize'):
                            size_bytes = int(fmt['filesize'])
                            size_estimated = False
                            break

                if not size_bytes:
                    mp4_same_height = [
                        c['url'] for c in candidates
                        if not _is_hls(c['url']) and (height == 0 or c['height'] == height)
                    ]
                    if not _is_hls(stream_url) and stream_url not in mp4_same_height:
                        mp4_same_height.insert(0, stream_url)
                    for mp4_cand in mp4_same_height[:2]:
                        probed_sz = _probe_mp4_size(mp4_cand)
                        if probed_sz > 0:
                            size_bytes = probed_sz
                            size_estimated = False
                            break

                if not size_bytes:
                    size_bytes = info.get('filesize_approx')
                    if not size_bytes:
                        for fmt in info.get('formats') or []:
                            if fmt.get('vcodec') == 'none':
                                continue
                            fh = int(fmt.get('height') or 0)
                            if (height == 0 or fh == height) and fmt.get('filesize_approx'):
                                size_bytes = int(fmt['filesize_approx'])
                                break
                    if not size_bytes and dur > 0:
                        tbr = info.get('tbr')
                        if not tbr:
                            for fmt in info.get('formats') or []:
                                if fmt.get('vcodec') == 'none':
                                    continue
                                fh = int(fmt.get('height') or 0)
                                if (height == 0 or fh == height) and (fmt.get('tbr') or fmt.get('vbr')):
                                    tbr = fmt.get('tbr') or fmt.get('vbr')
                                    break
                        if tbr:
                            size_bytes = int(float(tbr) * 1000 / 8 * dur)
                    if size_bytes:
                        size_estimated = True

                return {
                    "id": info.get('id', ''),
                    "title": info.get('title', ''),
                    "description": info.get('description', ''),
                    "thumbnail": info.get('thumbnail'),
                    "duration": dur,
                    "stream_url": stream_url,
                    "width": int(info.get('width') or 0),
                    "height": height,
                    "size_bytes": size_bytes,
                    "size_estimated": size_estimated,
                    "tags": info.get('tags', []),
                    "uploader": info.get('uploader', ''),
                    "upload_date": info.get('upload_date') or '',  # yt-dlp YYYYMMDD
                    "timestamp": info.get('timestamp') or 0,
                    "is_hls": bool(stream_url and '.m3u8' in stream_url),
                    # A PornHub CDN token is bound to the player session.  This
                    # stays server-side: the playback resolver gives it to the
                    # local HLS proxy through a short-lived session id.
                    "proxy_cookies": cookies,
                    # The endpoint rechecks these candidates with aiohttp, the
                    # exact HTTP stack that sends the eventual proxy request.
                    "stream_candidates": candidates,
                }
            except Exception as e:
                logger.error(f"Pornhub yt-dlp extraction failed for {url}: {e}")
                return None
            finally:
                if temp_cookiefile and os.path.exists(temp_cookiefile):
                    try:
                        os.remove(temp_cookiefile)
                    except Exception:
                        pass

        # Run yt-dlp extraction in a separate thread so we don't block the async loop
        return await asyncio.to_thread(_extract)
