import re
import logging
import aiohttp
import asyncio
import os
from urllib.parse import unquote, urlparse
from .base import VideoExtractor
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

# Watch-page download rows look like: MP4 (2160p, h264, 2744.25 MB)
_DLOAD_RE = re.compile(
    r"MP4 \((\d+)p[^,]*,\s*([A-Za-z0-9]+),\s*([\d.]+)\s*([MG]B)\)",
    re.IGNORECASE,
)
_DLOAD_LINK_RE = re.compile(
    r'href=["\']([^"\']+)["\'][^>]*>\s*MP4 \((\d+)p[^,]*,\s*([A-Za-z0-9]+),\s*([\d.]+)\s*([MG]B)\)',
    re.IGNORECASE,
)


def _parse_compact_count(text: str) -> int:
    """Parse listing counters like 1.2M, 12K, 1,234."""
    cleaned = re.sub(r"[^0-9.KMB]", "", (text or "").upper().replace(",", ""))
    match = re.match(r"([\d.]+)([KMB])?$", cleaned)
    if not match:
        digits = re.sub(r"[^\d]", "", text or "")
        return int(digits) if digits else 0
    value = float(match.group(1))
    suffix = match.group(2) or ""
    multiplier = {"": 1, "K": 1_000, "M": 1_000_000, "B": 1_000_000_000}[suffix]
    return int(value * multiplier)


def _parse_listing_height(block_text: str, class_names: str) -> int:
    blob = f"{class_names} {block_text}".lower()
    if re.search(r"\b(2160p|4k)\b", blob):
        return 2160
    if "1440p" in blob:
        return 1440
    if "1080p" in blob:
        return 1080
    if "720p" in blob:
        return 720
    if "480p" in blob:
        return 480
    if "360p" in blob:
        return 360
    return 0


class EpornerExtractor(VideoExtractor):
    @staticmethod
    def best_listed_download(html: str) -> Optional[Dict[str, Any]]:
        """Highest resolution + its largest listed file size from the watch page."""
        best = None  # (height, size_mb, codec, filename)
        linked = _DLOAD_LINK_RE.findall(html or "")
        rows = [(h, codec, size, unit, href) for href, h, codec, size, unit in linked]
        if not rows:
            rows = [(h, codec, size, unit, "") for h, codec, size, unit in _DLOAD_RE.findall(html or "")]
        for h, codec, size, unit, href in rows:
            height = int(h)
            mb = float(size) * (1024 if unit.upper() == "GB" else 1)
            if best is None or height > best[0] or (height == best[0] and mb > best[1]):
                filename = unquote(urlparse(href).path.rsplit("/", 1)[-1]) if href else ""
                best = (height, mb, codec.lower(), filename)
        if not best:
            return None
        height, mb, codec, filename = best
        return {
            "height": height,
            "codec": codec,
            "filename": filename,
            "size_mb": round(mb, 1),
            "size_bytes": int(mb * 1024 * 1024),
        }

    @staticmethod
    def listed_size_for_height(html: str, height: int) -> Optional[Dict[str, Any]]:
        best_mb = None
        for h, _codec, size, unit in _DLOAD_RE.findall(html or ""):
            if int(h) != height:
                continue
            mb = float(size) * (1024 if unit.upper() == "GB" else 1)
            if best_mb is None or mb > best_mb:
                best_mb = mb
        if best_mb is None:
            return None
        return {
            "size_mb": round(best_mb, 1),
            "size_bytes": int(best_mb * 1024 * 1024),
        }

    @staticmethod
    def parse_watch_page_meta(html: str) -> Dict[str, Any]:
        """Size/date/duration from the watch page only — no /dload HEAD."""
        listed = EpornerExtractor.best_listed_download(html) or {}
        title = "Eporner Video"
        title_match = re.search(r"<title>(.*?)</title>", html or "", re.I | re.S)
        if title_match:
            title = re.sub(r"\s*-\s*EPORNER\s*$", "", title_match.group(1), flags=re.I).strip() or title
        thumb = ""
        thumb_match = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', html or "", re.I)
        if thumb_match:
            thumb = thumb_match.group(1)
        duration = 0
        dur_match = re.search(r'<meta\s+property="og:duration"\s+content="(\d+)"', html or "", re.I)
        if dur_match:
            duration = int(dur_match.group(1))
        views = 0
        views_match = re.search(r'id=["\']videoviews["\'][^>]*>\s*([\d,]+)\s*<', html or "", re.I)
        if views_match:
            try:
                views = int(views_match.group(1).replace(",", ""))
            except ValueError:
                views = 0
        upload_date = ""
        iso_match = re.search(
            r'"uploadDate"\s*:\s*"([^"]+)"|itemprop=["\']uploadDate["\'][^>]+content=["\']([^"\']+)',
            html or "",
            re.I,
        )
        if iso_match:
            upload_date = (iso_match.group(1) or iso_match.group(2) or "").strip()
        if not upload_date:
            date_match = re.search(r"(\w{3,9}\s+\d{1,2},\s+\d{4})", html or "")
            if date_match:
                upload_date = date_match.group(1)
        height = int(listed.get("height") or 0)
        size_mb = listed.get("size_mb")
        size_bytes = int(listed.get("size_bytes") or 0)
        quality = "4K" if height >= 2160 else (f"{height}p" if height else "")
        return {
            "title": title,
            "thumbnail": thumb,
            "duration": duration,
            "views": views,
            "upload_date": upload_date,
            "height": height,
            "quality": quality,
            "filename": listed.get("filename") or "",
            "size_mb": size_mb,
            "size_bytes": size_bytes,
            "size_estimated": bool(size_bytes),
        }

    @property
    def name(self) -> str:
        return "Eporner"
    
    @property
    def domains(self):
        return ["eporner.com", "www.eporner.com"]
    
    def can_handle(self, url: str) -> bool:
        return any(domain in url for domain in self.domains)

    def _is_listing_url(self, url: str) -> bool:
        from urllib.parse import urlparse
        return bool(re.search(r"/(?:gallery|playlist|profile)/",
                              urlparse(url or "").path, re.I))

    async def extract_album_entries(self, url: str, *, on_page=None, between_pages=None, strict: bool = False, page_semaphore=None, max_pages=None, max_entries=None, info=None):
        """
        Expand an Eporner gallery / playlist / profile listing into every video.
        Entry url is the /video-<id>/<slug> watch page → resolved lazily.
        """
        if not self._is_listing_url(url):
            return []
        from urllib.parse import urljoin
        from types import SimpleNamespace
        from bs4 import BeautifulSoup
        from ..eporner_transport import fetch_listing, EpornerListingError
        from .base import ntc_get
        from app.ntc import NTCStatusError

        def parse_html(document: str):
            try:
                return BeautifulSoup(document, "lxml")
            except Exception:
                return BeautifulSoup(document, "html.parser")

        base = url.split("#")[0].split("?")[0].rstrip("/")
        page_url = f"{base}/"
        entries = []
        seen = set()
        # None keeps the historical 50-page ceiling. 0 means walk until the
        # listing itself ends (tester playlists). A positive value is a hard cap.
        if max_pages is None:
            MAX_PAGES = 50
        else:
            requested_pages = int(max_pages)
            MAX_PAGES = requested_pages if requested_pages > 0 else 10_000
        MAX_ENTRIES = int(max_entries) if max_entries else 0
        try:
            if True:
                for page in range(1, MAX_PAGES + 1):
                    try:
                        use_tor = os.getenv("EPORNER_USE_TOR", "false").lower() in ("1", "true", "yes")
                        mode = (os.getenv("EPORNER_NETWORK_MODE") or "auto").lower()
                        if page_semaphore is None:
                            if use_tor or mode == "tor":
                                resp = await fetch_listing(page_url)
                            else:
                                try:
                                    html_body = await ntc_get(page_url, domain="eporner.com", deadline=28.0)
                                    resp = SimpleNamespace(text=html_body, status_code=200)
                                except NTCStatusError as status_err:
                                    if status_err.status_code == 404:
                                        resp = SimpleNamespace(text=status_err.text or "", status_code=404)
                                    else:
                                        raise EpornerListingError(
                                            f"Eporner HTTP {status_err.status_code}: playlist je nedostupný alebo chránený."
                                        ) from status_err
                        else:
                            async with page_semaphore:
                                if use_tor or mode == "tor":
                                    resp = await fetch_listing(page_url)
                                else:
                                    try:
                                        html_body = await ntc_get(page_url, domain="eporner.com", deadline=28.0)
                                        resp = SimpleNamespace(text=html_body, status_code=200)
                                    except NTCStatusError as status_err:
                                        if status_err.status_code == 404:
                                            resp = SimpleNamespace(text=status_err.text or "", status_code=404)
                                        else:
                                            raise EpornerListingError(
                                                f"Eporner HTTP {status_err.status_code}: playlist je nedostupný alebo chránený."
                                            ) from status_err
                        html = resp.text or ""
                        # Eporner galleries answer 404 but still serve the cards;
                        # only bail if there's genuinely no usable HTML.
                        if resp.status_code not in (200, 404) or not html:
                            break
                    except EpornerListingError:
                        raise
                    soup = parse_html(html)
                    listing = soup.select_one(".streamevents") if "/playlist/" in url else soup
                    if listing is None:
                        listing = soup
                    blocks = listing.select("div.mb")
                    if not blocks:
                        break
                    new_on_page = 0
                    for b in blocks:
                        tit = b.select_one("p.mbtit a") or b.select_one(".mbunder a")
                        href = tit.get("href") if tit else ""
                        if not href:
                            a = b.find("a", href=True)
                            href = a.get("href") if a else ""
                        if not re.search(r"/(?:video-|hd-porn/)", href):
                            continue
                        full = urljoin("https://www.eporner.com", href).split("?")[0]
                        if full in seen:
                            continue
                        seen.add(full)
                        title = ""
                        if tit:
                            title = tit.get_text(strip=True)
                        if not title:
                            img = b.find("img")
                            title = (img.get("alt") if img else "") or ""
                        dur_el = b.select_one(".mbtim") or b.find(class_=lambda c: c and "tim" in c)
                        dur = dur_el.get_text(strip=True) if dur_el else ""
                        duration = 0
                        mm = re.match(r"(?:(\d+):)?(\d+):(\d+)$", dur)
                        if mm:
                            duration = (int(mm.group(1) or 0) * 3600 +
                                        int(mm.group(2)) * 60 + int(mm.group(3)))
                        img = b.find("img")
                        thumb = ""
                        if img:
                            thumb = img.get("data-src") or img.get("src") or ""
                        class_names = " ".join(b.get("class") or [])
                        quality_el = b.select_one(".mvhdico, .mbhd, .mb4k")
                        height = _parse_listing_height(
                            (quality_el.get_text(" ", strip=True) if quality_el else "") or "",
                            class_names,
                        )
                        views_el = b.select_one(".mbvie, .mbviews")
                        rating_el = b.select_one(".mbrate")
                        added_el = b.select_one(".mbadded, .mbadd")
                        uploader_el = b.select_one(".mbuploader, .mbuser")
                        entries.append({
                            "url": full, "source_url": full,
                            "title": title or "Eporner video",
                            "thumbnail": thumb, "duration": duration, "stream_url": "",
                            "height": height,
                            "views": _parse_compact_count(views_el.get_text() if views_el else ""),
                            "rating": (rating_el.get_text(strip=True) if rating_el else ""),
                            "upload_date": (added_el.get_text(strip=True) if added_el else ""),
                            "uploader": (uploader_el.get_text(strip=True) if uploader_el else ""),
                        })
                        new_on_page += 1
                    if new_on_page == 0:
                        break
                    # Follow real pagination only; guessed /2/ URLs can render
                    # unrelated profile recommendations instead of a playlist.
                    next_pages = []
                    for a in listing.select(".numlist2 a[href], .pagination a[href]"):
                        label = a.get_text(strip=True)
                        if label.isdigit() and int(label) > page:
                            next_url = urljoin(page_url, a["href"])
                            if next_url.startswith(base + "/"):
                                next_pages.append((int(label), next_url))
                    if info is not None:
                        info["pages_loaded"] = page
                        info["next_page"] = min(next_pages)[0] if next_pages else 0
                    if on_page is not None:
                        await on_page(entries[-new_on_page:], page, bool(next_pages))
                    if MAX_ENTRIES and len(entries) >= MAX_ENTRIES:
                        if info is not None:
                            info["truncated"] = True
                        del entries[MAX_ENTRIES:]
                        break
                    if not next_pages:
                        break
                    if page >= MAX_PAGES:
                        if info is not None:
                            info["truncated"] = True
                        break
                    if between_pages is not None:
                        await between_pages(page)
                    page_url = min(next_pages)[1]
        except EpornerListingError:
            raise
        except Exception as e:
            if strict:
                raise
            logging.error("[Eporner] album extract failed: %s", e)
        logging.info("[Eporner] listing %s → %d videos", url, len(entries))
        return entries

    async def extract(self, url: str, pre_fetched_html: str = None) -> Optional[Dict[str, Any]]:
        if self._is_listing_url(url):
            return None  # Never send a playlist through watch-page/yt-dlp retries.
        search_url = url
        logger.info(f"[EPORNER_FAST] Extracting metadata from {search_url}")

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://www.eporner.com/',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }

        # Load eporner cookies if available (as Cookie header to avoid aiohttp.CookieJar quirks)
        _cookie_header = None
        for cookie_path in ['eporner.netscape.txt', 'eporner.cookies.txt', 'cookies.netscape.txt']:
            if os.path.exists(cookie_path):
                try:
                    import http.cookiejar
                    jar = http.cookiejar.MozillaCookieJar(cookie_path)
                    jar.load(ignore_discard=True, ignore_expires=True)
                    _cookies = {c.name: c.value for c in jar if 'eporner.com' in (c.domain or '')}
                    if _cookies:
                        _cookie_header = '; '.join(f'{k}={v}' for k, v in _cookies.items())
                        logger.info(f"[EPORNER_FAST] Loaded {len(_cookies)} eporner cookies from {cookie_path}")
                        break
                    else:
                        logger.debug(f"[EPORNER_FAST] Cookie file {cookie_path} has no eporner.com cookies")
                except Exception as ce:
                    logger.debug(f"[EPORNER_FAST] Cookie load failed: {ce}")

        size_bytes = 0
        size_mb = None
        size_estimated = False
        candidate_urls = []
        for candidate in [
            search_url,
            search_url.replace("://www.eporner.com/", "://eporner.com/"),
            search_url.replace("://eporner.com/", "://www.eporner.com/"),
        ]:
            if candidate and candidate not in candidate_urls:
                candidate_urls.append(candidate)

        # Try Manual Extraction FIRST (Much faster than yt-dlp)
        try:
            # 1. Fetch HTML — use pre-fetched HTML from browser if provided.
            html = pre_fetched_html or None
            resolved_watch_url = search_url
            not_found_count = 0
            if html:
                logger.info(f"[EPORNER_FAST] Using browser-provided HTML ({len(html)} chars)")
            else:
                try:
                    _fetch_headers = dict(headers)
                    if _cookie_header:
                        _fetch_headers['Cookie'] = _cookie_header
                    from .base import ntc_get
                    from app.ntc import NTCStatusError
                    for candidate_url in candidate_urls:
                        try:
                            html = await ntc_get(
                                candidate_url,
                                domain="eporner.com",
                                headers=_fetch_headers,
                                deadline=15.0,
                            )
                            resolved_watch_url = candidate_url
                            logger.info(f"[EPORNER_FAST] HTML fetched from {resolved_watch_url}")
                            break
                        except NTCStatusError as fetch_exc:
                            logger.warning(f"[EPORNER_FAST] Got {fetch_exc.status_code} for {candidate_url}")
                            if fetch_exc.status_code in (404, 410):
                                not_found_count += 1
                                break
                        except Exception as fetch_exc:
                            logger.warning(f"[EPORNER_FAST] Failed to fetch {candidate_url}: {fetch_exc}")
                except Exception as e:
                    logger.error(f"[EPORNER_FAST] Failed to fetch any watch URL for {search_url}: {e}")
            if not html and not_found_count > 0:
                logger.info(f"[EPORNER_FAST] Watch page returned 404/410 for {search_url}; skipping slow yt-dlp fallback.")
                return None

            if html:
                stream_url = None
                width = 0
                height = 0
                _WIDTH_FOR_H = {2160: 3840, 1440: 2560, 1080: 1920, 720: 1280, 480: 854, 360: 640, 240: 426}

                # 1. Strategy: Download table FIRST.
                # The watch-page download rows list EVERY rendition the source has
                # (4K/1440p/1080p/…), whereas the inline player JSON is frequently
                # capped at 720p for guests. So to always push the highest quality
                # (playback AND import), we resolve the dload table before falling
                # back to the player-JSON regex.
                # Matches both old (/dload/ID/720/) and new (/dload/ID/720/filename.mp4) formats.
                dload_raw = re.findall(r'href=["\'](/dload/[\w]+/(\d+)/[^"\'<>\s]*)["\']', html)
                dload_by_q = {}
                for path, q_str in dload_raw:
                    q = int(q_str)
                    # prefer a non-AV1 (h264) rendition at the same height — h264
                    # plays everywhere and tends to be the larger/native file.
                    if q not in dload_by_q or 'av1' in dload_by_q[q].lower():
                        dload_by_q[q] = path

                listed = self.best_listed_download(html)
                listed_filename = ""
                if listed:
                    size_bytes = listed["size_bytes"]
                    size_mb = listed["size_mb"]
                    size_estimated = True
                    listed_filename = listed.get("filename") or ""

                is_hls = False
                if dload_by_q:
                    base_origin = "https://www.eporner.com" if "www.eporner.com" in resolved_watch_url else "https://eporner.com"
                    _dload_headers = dict(headers)
                    if _cookie_header:
                        _dload_headers['Cookie'] = _cookie_header
                    timeout = aiohttp.ClientTimeout(total=12, connect=8, sock_connect=8, sock_read=10)
                    async with aiohttp.ClientSession(headers=_dload_headers) as session:
                        for q_val in [2160, 1440, 1080, 720, 480, 360, 240]:
                            if q_val not in dload_by_q:
                                continue
                            full_dload = f"{base_origin}{dload_by_q[q_val]}"
                            resolved = ""
                            head_status = 0
                            head_size = 0
                            try:
                                async with session.head(full_dload, allow_redirects=True, timeout=timeout) as res_head:
                                    resolved = str(res_head.url)
                                    head_status = res_head.status
                                    cl = res_head.headers.get("Content-Length") or res_head.headers.get("content-length")
                                    try:
                                        head_size = int(cl) if cl else 0
                                    except (TypeError, ValueError):
                                        head_size = 0
                            except Exception as e:
                                logger.debug(f"[EPORNER_FAST] aiohttp dload head failed ({q_val}p): {e}")

                            # Fallback cez curl_cffi ak aiohttp zlyhal alebo dostal 403/405/503
                            if head_status in (0, 403, 405, 503):
                                try:
                                    def _cf_head() -> tuple[int, str, int]:
                                        from curl_cffi import requests as cr
                                        r = cr.head(
                                            full_dload,
                                            headers=_dload_headers,
                                            allow_redirects=True,
                                            timeout=10,
                                            impersonate="chrome",
                                        )
                                        if r.status_code == 405:
                                            r = cr.get(
                                                full_dload,
                                                headers=_dload_headers,
                                                allow_redirects=True,
                                                timeout=10,
                                                impersonate="chrome",
                                                stream=True,
                                            )
                                            r.close()
                                        cl_val = r.headers.get("Content-Length") or r.headers.get("content-length")
                                        try:
                                            sz = int(cl_val) if cl_val else 0
                                        except (TypeError, ValueError):
                                            sz = 0
                                        return int(r.status_code), str(r.url), sz

                                    head_status, resolved, head_size = await asyncio.to_thread(_cf_head)
                                except Exception as cf_exc:
                                    logger.debug(f"[EPORNER_FAST] curl_cffi dload head failed ({q_val}p): {cf_exc}")

                            if head_status == 200 and resolved and '/login/' not in resolved:
                                stream_url = resolved
                                height = q_val
                                width = _WIDTH_FOR_H.get(q_val, 0)
                                if head_size > 10240:
                                    size_bytes = head_size
                                    size_mb = round(head_size / (1024 * 1024), 1)
                                    size_estimated = False
                                else:
                                    listed_at = self.listed_size_for_height(html, q_val) or listed
                                    if listed_at:
                                        size_bytes = listed_at["size_bytes"]
                                        size_mb = listed_at["size_mb"]
                                        size_estimated = True
                                logger.info(f"[EPORNER_FAST] Resolved dload ({q_val}p): {stream_url}")
                                break
                            else:
                                logger.debug(f"[EPORNER_FAST] dload {q_val}p login-redirect or failed ({head_status})")

                # 2. Strategy: player-JSON / <source> regex (fallback or upgrade if dload was capped below listed height).
                listed_max_height = int(listed.get("height") or 0) if listed else 0
                if not stream_url or height < listed_max_height:
                    _q_map = {'4k': 2160, '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360}
                    for quality in ['4k', '2160p', '1440p', '1080p', '720p', '480p', '360p']:
                        cand_h = _q_map[quality]
                        if stream_url and cand_h <= height:
                            break
                        pattern = rf'(?:["\']?{quality}["\']?)\s*:\s*["\'](https?://[^"\']+\.(?:mp4|m3u8)[^"\']*)["\']'
                        match = re.search(pattern, html, re.IGNORECASE)
                        if not match:
                            pattern_src = rf'<source[^>]+src=["\'](https?://[^"\']+)["\'][^>]+(?:label|title|size)=["\'][^"\']*{quality}[^"\']*["\']'
                            match = re.search(pattern_src, html, re.IGNORECASE)
                        if match:
                            stream_url = match.group(1).replace('\\/', '/')
                            is_hls = '.m3u8' in stream_url.lower()
                            height = cand_h
                            width = _WIDTH_FOR_H.get(height, 0)
                            listed_at = self.listed_size_for_height(html, height) or listed
                            if listed_at:
                                size_bytes = listed_at["size_bytes"]
                                size_mb = listed_at["size_mb"]
                                size_estimated = True
                            break

                if stream_url:
                    # 3. Extract Metadata
                    title = "Eporner Video"
                    title_match = re.search(r'<title>(.*?)</title>', html)
                    if title_match:
                        title = title_match.group(1).replace(' - EPORNER', '').strip()
                    
                    thumb_url = None
                    thumb_match = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', html)
                    if not thumb_match:
                        thumb_match = re.search(r'["\']poster["\']\s*:\s*["\'](https?://[^"\']+)["\']', html)
                    if thumb_match:
                        thumb_url = thumb_match.group(1)
                    
                    duration = 0
                    dur_match = re.search(r'<meta\s+property="og:duration"\s+content="(\d+)"', html)
                    if dur_match:
                        duration = int(dur_match.group(1))
                    
                    views = 0
                    views_match = re.search(r'id=["\']videoviews["\'][^>]*>\s*([\d,]+)\s*<', html)
                    if views_match:
                        try: views = int(views_match.group(1).replace(',', ''))
                        except: pass
                    
                    upload_date = None
                    date_match = re.search(r'(\w{3,9}\s+\d{1,2},\s+\d{4})', html)
                    if date_match:
                        upload_date = date_match.group(1)
                    
                    tags = []
                    keywords_div_match = re.search(r'<div[^>]*class=["\'](?:keyw|keywords|tags)["\'][^>]*>(.*?)</div>', html, re.DOTALL)
                    if keywords_div_match:
                        tags_html = keywords_div_match.group(1)
                        tags = re.findall(r'<a[^>]*>(.*?)</a>', tags_html)
                        tags = [t.strip() for t in tags if t.strip()]

                    return {
                        "id": None,
                        "title": title,
                        "description": "",
                        "thumbnail": thumb_url,
                        "duration": duration,
                        "stream_url": stream_url,
                        "width": width,
                        "height": height,
                        "filename": listed_filename or unquote(urlparse(stream_url).path.rsplit("/", 1)[-1]),
                        "size_bytes": size_bytes,
                        "size_mb": size_mb,
                        "size_estimated": size_estimated,
                        "tags": tags,
                        "views": views,
                        "upload_date": upload_date,
                        "uploader": "",
                        "is_hls": is_hls,
                        "listed_max_height": listed_max_height,
                        "listed_max_size_bytes": int(listed["size_bytes"]) if listed else 0,
                        "_resolver": "manual",
                    }
        except Exception as e:
            logger.warning(f"[EPORNER_FAST] Manual extraction failed: {e}")

        logger.info("[EPORNER_FAST] Fast extraction yielded no result. Starting yt-dlp (slow)...")

        # Fallback to yt-dlp
        try:
            def _ydl_extract():
                ytdlp_opts = {
                    'quiet': True, 'ignoreerrors': True, 'no_warnings': True,
                    'format': 'bestvideo+bestaudio/best',
                    'extract_flat': False,
                    # This is only a fallback.  Long retry cascades used to
                    # consume every intake worker when Eporner DNS/CDNs were
                    # unreachable, leaving the local dashboard unresponsive.
                    'socket_timeout': 15,
                    'retries': 1,
                    'http_headers': {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                        'Referer': 'https://www.eporner.com/',
                        'Accept-Language': 'en-US,en;q=0.9',
                    },
                }
                for cookie_path in ['eporner.netscape.txt', 'eporner.cookies.txt', 'cookies.netscape.txt']:
                    if os.path.exists(cookie_path):
                        ytdlp_opts['cookiefile'] = cookie_path
                        break

                import yt_dlp
                with yt_dlp.YoutubeDL(ytdlp_opts) as ydl:
                    return ydl.extract_info(url, download=False)
            
            # asyncio cancellation cannot kill a native/network call already
            # executing in a thread, but this releases the intake worker and
            # lets its watchdog mark the item for a controlled retry.
            info = await asyncio.wait_for(asyncio.to_thread(_ydl_extract), timeout=45)
            if not info:
                raise Exception("yt-dlp returned no stream URL")

            best_format = None
            best_height = 0
            for f in info.get('formats', []):
                if not f.get('url') or not f.get('height'):
                    continue
                h = f.get('height') or 0
                if h > best_height:
                    best_format = f
                    best_height = h
            
            stream_url = best_format['url'] if best_format else info.get('url')
            width = best_format.get('width') if best_format else info.get('width')
            height = best_format.get('height') if best_format else info.get('height')
            ydl_size = 0
            ydl_size_estimated = False
            if best_format:
                ydl_size = int(best_format.get("filesize") or 0)
                if not ydl_size:
                    ydl_size = int(best_format.get("filesize_approx") or 0)
                    ydl_size_estimated = bool(ydl_size)
            if not ydl_size:
                ydl_size = int(info.get("filesize") or 0)
                if not ydl_size:
                    ydl_size = int(info.get("filesize_approx") or 0)
                    ydl_size_estimated = bool(ydl_size)
            if ydl_size > 0:
                size_bytes = ydl_size
                size_mb = round(ydl_size / (1024 * 1024), 1)
            
            views = info.get('view_count', 0)
            upload_date = info.get('upload_date')
            if upload_date and len(upload_date) == 8:
                try:
                    import datetime
                    dt = datetime.datetime.strptime(upload_date, "%Y%m%d")
                    upload_date = dt.strftime("%b %d, %Y")
                except: pass
            
            tags = info.get('tags', [])

            logger.info(f"[EPORNER_SLOW] yt-dlp extracted: {info.get('title')} ({height}p)")
            return {
                "id": None,
                "title": info.get('title'),
                "description": info.get('description'),
                "thumbnail": info.get('thumbnail'),
                "duration": info.get('duration'),
                "stream_url": stream_url,
                "width": width,
                "height": height,
                "filename": unquote(urlparse(stream_url or "").path.rsplit("/", 1)[-1]) or info.get("title"),
                "size_bytes": size_bytes,
                "size_mb": size_mb,
                "size_estimated": ydl_size_estimated,
                "tags": tags,
                "views": views,
                "upload_date": upload_date,
                "uploader": info.get('uploader'),
                "is_hls": False,
                "_resolver": "ytdlp",
            }
        except Exception as e:
            logger.error(f"Eporner extraction failed completely: {e}")
            return None
