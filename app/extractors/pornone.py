import requests
import asyncio
from urllib.parse import urljoin
import re
import logging
from bs4 import BeautifulSoup
from typing import List, Dict, Optional, Any
from .base import VideoExtractor

logger = logging.getLogger(__name__)

class PornOneExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "PornOne"

    def can_handle(self, url: str) -> bool:
        return "pornone.com" in url

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Referer": "https://www.pornone.com/"
        })
        self.session.cookies.set("verified", "1", domain="pornone.com")
        self.session.cookies.set("age_verified", "1", domain="pornone.com")

    def _parse_cards(self, soup: BeautifulSoup) -> list:
        """Try multiple selectors to find video cards."""
        for selector in [
            'a.videocard.linkage',
            'a.videocard',
            '.video-list a[href*="/video/"]',
            '.videos-list a[href*="/video/"]',
            'article a[href*="/video/"]',
            '.thumb-block a',
            'a[href*="pornone.com/video/"]',
        ]:
            cards = soup.select(selector)
            if cards:
                logger.debug(f"[PornOne] Found {len(cards)} cards with selector: {selector}")
                return cards
        # Last resort: any link to a video page
        cards = [a for a in soup.find_all('a', href=True)
                 if re.search(r'/video/', a.get('href', ''))]
        if cards:
            logger.debug(f"[PornOne] Found {len(cards)} cards via href regex")
        return cards

    def _build_search_urls(self, keyword: str, page: int, sort_param: str) -> list:
        """Return candidate URLs to try for keyword search."""
        kw = requests.utils.quote(keyword)
        return [
            f"https://www.pornone.com/search/{kw}/{page}/?sort={sort_param}",
            f"https://www.pornone.com/?s={kw}&sort={sort_param}&page={page}",
            f"https://www.pornone.com/search/?q={kw}&sort={sort_param}&page={page}",
        ]

    def discover(
        self,
        keyword: str = "",
        category: str = "",
        min_quality: int = 720,
        min_duration: int = 0,
        sort_by: str = "newest",
        pages: int = 3,
    ) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        seen: set = set()

        sort_map = {
            "newest": "new",
            "most-viewed": "views",
            "top-rated": "rating",
        }
        sort_param = sort_map.get(sort_by, "new")

        for page in range(1, pages + 1):
            try:
                soup = None

                if keyword:
                    for url in self._build_search_urls(keyword.strip(), page, sort_param):
                        try:
                            resp = self.session.get(url, timeout=20)
                            # Detect Cloudflare redirect to homepage
                            if resp.url.rstrip('/') in ('https://pornone.com', 'https://www.pornone.com',
                                                        'https://pornone.com/', 'https://www.pornone.com/'):
                                logger.warning(f"[PornOne] Cloudflare redirect detected for URL {url}")
                                continue
                            if resp.status_code == 200:
                                candidate = BeautifulSoup(resp.text, 'html.parser')
                                cards_check = self._parse_cards(candidate)
                                if cards_check:
                                    soup = candidate
                                    logger.info(f"[PornOne] Search URL worked: {url} ({len(cards_check)} cards)")
                                    break
                                else:
                                    logger.debug(f"[PornOne] URL returned 200 but no cards: {url}")
                        except Exception as e:
                            logger.debug(f"[PornOne] URL failed {url}: {e}")
                    if soup is None:
                        # Cloudflare blocked keyword search — fallback to newest + title filter
                        logger.warning(f"[PornOne] CF block on page {page}, falling back to newest with title filter")
                        fb_url = f"https://www.pornone.com/newest/{page}/"
                        resp = self.session.get(fb_url, timeout=20)
                        if resp.status_code != 200:
                            break
                        soup = BeautifulSoup(resp.text, 'html.parser')
                        # Mark that we must client-side filter by keyword
                        _apply_keyword_filter = keyword.strip().lower()
                    else:
                        _apply_keyword_filter = ""
                elif category:
                    url = f"https://www.pornone.com/{requests.utils.quote(category.strip())}/{page}/?sort={sort_param}"
                    resp = self.session.get(url, timeout=20)
                    if resp.status_code != 200:
                        break
                    soup = BeautifulSoup(resp.text, 'html.parser')
                    _apply_keyword_filter = ""
                else:
                    url = f"https://www.pornone.com/newest/{page}/"
                    resp = self.session.get(url, timeout=20)
                    if resp.status_code != 200:
                        break
                    soup = BeautifulSoup(resp.text, 'html.parser')
                    _apply_keyword_filter = ""

                cards = self._parse_cards(soup)

                if not cards and page > 1:
                    break

                for card in cards:
                    try:
                        page_url = card.get('href', '')
                        if not page_url:
                            continue
                        if not page_url.startswith('http'):
                            page_url = f"https://www.pornone.com{page_url}"
                        if page_url in seen:
                            continue
                        seen.add(page_url)

                        # Title — .videotitle only (not the author span)
                        title_el = card.select_one('.videotitle')
                        title = title_el.get_text(strip=True) if title_el else (card.get('title') or "PornOne Video")

                        # Thumbnail — img.thumbimg has src directly (not data-src)
                        thumb_el = card.select_one('img.thumbimg')
                        if not thumb_el:
                            # fallback: non-SVG img
                            for img in card.find_all('img'):
                                s = img.get('src', '')
                                if s and '.svg' not in s and 'data:' not in s:
                                    thumb_el = img
                                    break
                        thumbnail = ""
                        if thumb_el:
                            thumbnail = thumb_el.get('src') or thumb_el.get('data-src') or ""

                        # Duration — .durlabel text (contains an HD SVG img before the time)
                        duration = 0
                        dur_el = card.select_one('.durlabel')
                        if dur_el:
                            dur_text = dur_el.get_text(strip=True)  # e.g. "36:13"
                            parts = re.sub(r'[^\d:]', '', dur_text).split(':')
                            try:
                                if len(parts) == 3:
                                    duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                                elif len(parts) == 2:
                                    duration = int(parts[0]) * 60 + int(parts[1])
                            except Exception:
                                pass

                        # Quality — detect from alt of inline SVG badge inside .durlabel
                        quality = 0
                        if dur_el:
                            badge_img = dur_el.select_one('img')
                            if badge_img:
                                alt = badge_img.get('alt', '').lower()
                                if '4k' in alt or '2160' in alt:
                                    quality = 2160
                                elif '1080' in alt or 'fhd' in alt or 'full hd' in alt:
                                    quality = 1080
                                elif 'hd' in alt:
                                    quality = 720
                                elif '480' in alt or 'sd' in alt:
                                    quality = 480
                        # Also detect from hdcont span class names or title text
                        if not quality:
                            hd_el = card.select_one('.hdcont')
                            if hd_el:
                                hd_imgs = hd_el.find_all('img', alt=True)
                                for hi in hd_imgs:
                                    alt = hi.get('alt', '').lower()
                                    if '4k' in alt or '2160' in alt:
                                        quality = 2160; break
                                    elif '1080' in alt or 'fhd' in alt:
                                        quality = 1080; break
                                    elif 'hd' in alt:
                                        quality = 720; break

                        # Views — in the author span sibling
                        views = 0
                        author_el = card.select_one('.author, .videoinfo .author')
                        if author_el:
                            # The views element is a span with text like "97.9K" after viewsIcon
                            views_icon = author_el.select_one('.viewsIcon, .statsicon')
                            if views_icon:
                                v_text = views_icon.parent.get_text(strip=True).replace(',', '')
                            else:
                                v_text = author_el.get_text(strip=True).replace(',', '')
                            # Extract last token which is likely the view count
                            tokens = v_text.split()
                            for tok in reversed(tokens):
                                tok = tok.strip()
                                try:
                                    if tok.lower().endswith('k'):
                                        views = int(float(tok[:-1]) * 1000); break
                                    elif tok.lower().endswith('m'):
                                        views = int(float(tok[:-1]) * 1_000_000); break
                                    elif tok.isdigit():
                                        views = int(tok); break
                                except Exception:
                                    pass

                        # Client-side keyword filter for CF fallback
                        if _apply_keyword_filter and _apply_keyword_filter not in title.lower():
                            continue

                        if min_duration > 0 and duration > 0 and duration < min_duration:
                            continue
                        if min_quality > 0 and quality > 0 and quality < min_quality:
                            continue

                        results.append({
                            "page_url": page_url,
                            "title": title,
                            "thumbnail": thumbnail,
                            "duration": duration,
                            "quality": quality or None,
                            "views": views or None,
                        })
                    except Exception as card_err:
                        logger.debug(f"[PornOneDiscovery] Card parse error: {card_err}")

            except Exception as page_err:
                logger.error(f"[PornOneDiscovery] Page {page} error: {page_err}")
                break

        logger.info(f"[PornOne] discover() returning {len(results)} results for keyword={keyword!r}")
        return results

    def search(self, keyword: str, count: int = 20) -> List[Dict[str, Any]]:
        search_url = f"https://www.pornone.com/search/{keyword}/"
        try:
            resp = self.session.get(search_url, timeout=15)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, 'html.parser')
            cards = self._parse_cards(soup)
            results = []

            for card in cards[:count]:
                try:
                    title_el = card.select_one('.videotitle, [class*="title"]')
                    title = title_el.get_text(strip=True) if title_el else "Unknown PornOne Video"

                    page_url = card.get('href')
                    if page_url and not page_url.startswith('http'):
                        page_url = f"https://www.pornone.com{page_url}"

                    thumb_el = card.select_one('img.thumbimg, img[data-src], img')
                    thumbnail = ""
                    if thumb_el:
                        thumbnail = thumb_el.get('data-src') or thumb_el.get('src') or ""

                    dur_el = card.select_one('.durlabel, [class*="dur"]')
                    duration_str = dur_el.get_text(strip=True) if dur_el else "0:00"

                    duration = 0
                    parts = duration_str.split(':')
                    if len(parts) == 3:
                        duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                    elif len(parts) == 2:
                        duration = int(parts[0]) * 60 + int(parts[1])

                    results.append({
                        "title": title,
                        "page_url": page_url,
                        "thumbnail": thumbnail,
                        "duration": duration,
                        "tags": []
                    })
                except Exception as e:
                    logger.error(f"Error parsing PornOne search card: {e}")

            return results
        except Exception as e:
            logger.error(f"PornOne Search Error: {e}")
            return []

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        try:
            resp = await asyncio.to_thread(self.session.get, url, timeout=15)
            resp.raise_for_status()
            html = resp.text
            soup = BeautifulSoup(html, 'html.parser')

            title_el = soup.select_one('.videotitle, h1')
            title = title_el.get_text(strip=True) if title_el else "PornOne Video"

            tags = [a.get_text(strip=True) for a in soup.select('a[href*="/tags/"], a[href*="/category/"]')]

            duration = 0
            dur_match = re.search(r'["\']duration["\']\s*:\s*["\']?(\d+)["\']?', html)
            if dur_match:
                duration = int(dur_match.group(1))
            else:
                dur_text_el = soup.select_one('.durlabel')
                if dur_text_el:
                    duration_str = dur_text_el.get_text(strip=True)
                    parts = duration_str.split(':')
                    if len(parts) == 2: duration = int(parts[0]) * 60 + int(parts[1])
                    elif len(parts) == 3: duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])

            stream_url = None
            sources = soup.select('video source')
            sources_list = []
            for s in sources:
                src = s.get('src')
                if src:
                    res = 0
                    if '1080' in src: res = 1080
                    elif '720' in src: res = 720
                    elif '480' in src: res = 480
                    sources_list.append((res, src))

            if sources_list:
                sources_list.sort(key=lambda x: x[0], reverse=True)
                stream_url = sources_list[0][1]

            if not stream_url:
                mp4_matches = re.findall(r'["\'](https?://[^"\']+?\.mp4[^"\']*?)["\']', html)
                if mp4_matches:
                    stream_url = next((m for m in mp4_matches if '1080' in m), mp4_matches[0])

            if not stream_url:
                m3u8_matches = re.findall(r'["\'](https?://[^"\']+?\.m3u8[^"\']*?)["\']', html)
                if m3u8_matches:
                    stream_url = m3u8_matches[0]

            if not stream_url:
                return None

            stream_url = urljoin(resp.url, stream_url.replace('\\/', '/'))

            return {
                "id": url.split('/')[-2] if '/' in url else None,
                "title": title,
                "description": "",
                "thumbnail": soup.select_one('meta[property="og:image"]')['content'] if soup.select_one('meta[property="og:image"]') else "",
                "duration": duration,
                "stream_url": stream_url,
                "width": 1920 if '1080' in stream_url else (1280 if '720' in stream_url else 0),
                "height": 1080 if '1080' in stream_url else (720 if '720' in stream_url else 0),
                "tags": tags,
                "uploader": "",
                "is_hls": ".m3u8" in stream_url
            }
        except Exception as e:
            logger.error(f"PornOne Extraction Error for {url}: {e}")
            return None
