
import requests
import re
from bs4 import BeautifulSoup
import logging
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed


def tnaflix_category_slug(category: str) -> str:
    """Category name/slug -> the site's real single-segment path.

    TNAFlix category paths do NOT share one suffix: of the 74 on /categories, 49 end
    in "-porn", 13 in "-videos" (babe-videos, blowjob-videos), 5 in "-sex", and the
    rest are plain phrases (double-penetration, big-cock). So the suffix cannot be
    derived — the slug from categories() IS the path and is used verbatim. Every real
    slug contains a dash, so a bare one-word category (hand-typed or legacy) is the
    only case left to guess at, and there "-porn" is the majority shape.
    """
    slug = (category or "").strip().strip("/").lower().replace(" ", "-")
    if not slug:
        return ""
    return slug if "-" in slug else f"{slug}-porn"


class TnaflixExtractor:
    def __init__(self):
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
        }
        self.session = requests.Session()

    def can_handle(self, url: str) -> bool:
        return "tnaflix.com" in url

    def extract(self, url: str) -> dict:
        """
        Extracts metadata for a single video.
        """
        # Handle direct MP4 links from CDN
        if ".mp4" in url.lower():
            # Try to extract a clean title from the filename
            filename = url.split('/')[-1].split('?')[0]
            title = filename.replace('.mp4', '').replace('-', ' ').replace('_', ' ').title()
            
            # Simple metadata for direct links
            return {
                "title": title,
                "duration": 0,
                "thumbnail": None, # Direct link doesn't have a thumb easily available
                "stream_url": url,
                "tags": ""
            }

        try:
            resp = self.session.get(url, headers=self.headers, timeout=15)
            if resp.status_code != 200:
                logging.error(f"Tnaflix: Failed to fetch {url}, status {resp.status_code}")
                return None
            
            # Check content type - if it's video, skip BeautifulSoup
            content_type = resp.headers.get('Content-Type', '')
            if 'video' in content_type:
                 filename = url.split('/')[-1].split('?')[0]
                 return {
                    "title": filename.replace('.mp4', '').title(),
                    "duration": 0,
                    "thumbnail": None,
                    "stream_url": url,
                    "tags": ""
                }

            soup = BeautifulSoup(resp.text, 'html.parser')
            
            # Title
            title_tag = soup.find("meta", property="og:title")
            title = title_tag["content"] if title_tag else "Unknown Tnaflix Video"
            
            # Thumbnail
            thumb_tag = soup.find("meta", property="og:image")
            thumbnail = thumb_tag["content"] if thumb_tag else None
            
            # Stream URL
            stream_url = None
            video_tag = soup.find("video")
            if video_tag:
                 sources = video_tag.find_all("source", src=True)
                 best_size = 0
                 for s in sources:
                     try:
                         size_attr = s.get("size", "0")
                         # Tnaflix uses size="4" for 4K/2160p videos
                         if size_attr == "4":
                             size = 2160
                         else:
                             size = int(size_attr)
                         
                         if size >= best_size:
                             best_size = size
                             stream_url = s["src"]
                     except:
                         if not stream_url:
                             stream_url = s["src"]
            
            if not stream_url:
                og_vid = soup.find("meta", property="og:video")
                if og_vid and ".mp4" in og_vid["content"]:
                    stream_url = og_vid["content"]

            # Duration — from video tag data-duration attr (seconds), JSON-LD PTxxHxxMxxS, or DOM
            duration = 0
            if video_tag and video_tag.get('data-duration'):
                try:
                    duration = int(video_tag['data-duration'])
                except Exception:
                    pass
            if not duration:
                import json as _json
                jsonld_tag = soup.find('script', type='application/ld+json')
                if jsonld_tag:
                    try:
                        jd = _json.loads(jsonld_tag.get_text())
                        pt = jd.get('duration', '')
                        m = re.search(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', pt)
                        if m:
                            duration = (int(m.group(1) or 0) * 3600
                                        + int(m.group(2) or 0) * 60
                                        + int(m.group(3) or 0))
                    except Exception:
                        pass
            if not duration:
                dur_el = soup.select_one(".duration, .video-time, .time")
                if dur_el:
                    dur_text = dur_el.get_text(strip=True)
                    try:
                        parts = dur_text.split(':')
                        if len(parts) == 2:
                            duration = int(parts[0]) * 60 + int(parts[1])
                        elif len(parts) == 3:
                            duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                    except Exception:
                        pass

            # Tags
            tags = []
            tag_els = soup.select(".tags a, .video-info .tag a, .tag-container a")
            for t in tag_els:
                tags.append(t.get_text(strip=True))

            if stream_url and stream_url.startswith("//"):
                stream_url = "https:" + stream_url

            # Never return the watch-page URL as a stream — CDN urls (cdnl.tnaflix.com) are fine
            if stream_url and "www.tnaflix.com" in stream_url:
                stream_url = None

            return {
                "title": title,
                "duration": duration,
                "thumbnail": thumbnail,
                "stream_url": stream_url,
                "tags": ",".join(tags)
            }

        except Exception as e:
            logging.error(f"Tnaflix extraction error: {e}")
            return None

    def _parse_quality_from_card(self, card) -> int:
        """Try multiple strategies to get quality from a listing card."""
        for selector in [
            '.quality', '.hd-label', '.badge', '.res', '.resolution',
            '[class*="quality"]', '[class*="hd"]', '[class*="res"]',
            '.label-hd', '.label-4k', 'span.hd', 'span.fhd',
        ]:
            el = card.select_one(selector)
            if el:
                q_text = el.get_text(strip=True).lower().replace('p', '').strip()
                try:
                    q = int(q_text)
                    if 240 <= q <= 4320:
                        return q
                except Exception:
                    pass
                if '4k' in q_text or '2160' in q_text:
                    return 2160
                if '1080' in q_text or 'fhd' in q_text or 'full' in q_text:
                    return 1080
                if '720' in q_text or 'hd' in q_text:
                    return 720
                if '480' in q_text or 'sd' in q_text:
                    return 480
        # Detect from thumbnail URL
        img = card.select_one('img[data-original], img[data-src], img')
        if img:
            src = img.get('data-original') or img.get('data-src') or img.get('src') or ''
            for q in (2160, 1080, 720, 480):
                if str(q) in src:
                    return q
        return 0

    def discover(
        self,
        keyword: str = "",
        category: str = "",
        min_quality: int = 720,
        min_duration: int = 0,
        sort_by: str = "new",
        pages: int = 3,
    ) -> list:
        """
        Scrape Tnaflix search/category pages and return filtered video card list.
        sort_by values: 'new', 'views', 'rating'
        Returns list of {page_url, title, thumbnail, duration, quality, views}.
        """
        import urllib.parse
        results = []
        seen: set = set()

        def _build_url(page):
            # Live-verified 2026-07-16: /all-videos/pageN/ and /porn-videos/{slug}/pageN/
            # both 404 now. The homepage's own <link rel="next"> reveals the real listing
            # is /featured/{page} (page 1 == homepage).
            if keyword:
                q = urllib.parse.quote_plus(keyword)
                return f"https://www.tnaflix.com/search.php?what={q}&sort={sort_by}&page={page}"
            elif category:
                base = f"https://www.tnaflix.com/{tnaflix_category_slug(category)}"
                return base if page <= 1 else f"{base}/{page}"
            else:
                return "https://www.tnaflix.com/featured/1" if page <= 1 \
                    else f"https://www.tnaflix.com/featured/{page}"

        def _fetch_and_parse(page):
            url = _build_url(page)
            try:
                resp = self.session.get(url, headers=self.headers, timeout=20)
                if resp.status_code != 200:
                    return page, []
                soup = BeautifulSoup(resp.text, 'html.parser')
                cards = soup.select('div[data-vid]')
                if not cards:
                    cards = [c for c in soup.select('.col-xs-6, .col-md-4, .col-lg-4')
                             if c.select_one('a.video-thumb, a[href*="/video"]')]
                if not cards:
                    cards = soup.select('a.video-thumb')
                page_results = []
                for card in cards:
                    try:
                        anchor = card.select_one('a.video-thumb, a.video-title, a[href*="/video"]')
                        if not anchor:
                            if card.name == 'a' and '/video' in card.get('href', ''):
                                anchor = card
                            else:
                                continue
                        page_url = anchor.get('href', '')
                        if not page_url:
                            continue
                        if not page_url.startswith('http'):
                            page_url = 'https://www.tnaflix.com' + page_url
                        title_el = card.select_one('a.video-title')
                        if title_el:
                            title = title_el.get_text(strip=True)
                        else:
                            img_t = card.select_one('img')
                            title = img_t.get('alt', '').strip() if img_t else 'Tnaflix Video'
                        if not title:
                            title = 'Tnaflix Video'
                        thumb_anchor = card.select_one('a.video-thumb')
                        thumb_el = thumb_anchor.select_one('img') if thumb_anchor else card.select_one('img')
                        thumbnail = ''
                        if thumb_el:
                            thumbnail = (thumb_el.get('data-original') or thumb_el.get('data-src') or thumb_el.get('src') or '')
                        duration = 0
                        dur_el = card.select_one('.video-duration, .thumb-icon.video-duration, .duration')
                        if dur_el:
                            parts = dur_el.get_text(strip=True).split(':')
                            try:
                                if len(parts) == 3:
                                    duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                                elif len(parts) == 2:
                                    duration = int(parts[0]) * 60 + int(parts[1])
                            except Exception:
                                pass
                        quality = 0
                        qual_el = card.select_one('.max-quality, .thumb-icon.max-quality')
                        if qual_el:
                            q_text = qual_el.get_text(strip=True).lower().replace('p', '').strip()
                            try:
                                q = int(q_text)
                                if 240 <= q <= 4320:
                                    quality = q
                            except Exception:
                                if '4k' in q_text or '2160' in q_text:
                                    quality = 2160
                                elif '1080' in q_text or 'fhd' in q_text:
                                    quality = 1080
                                elif '720' in q_text or 'hd' in q_text:
                                    quality = 720
                                elif '480' in q_text:
                                    quality = 480
                        if not quality:
                            quality = self._parse_quality_from_card(card)
                        if min_duration > 0 and duration > 0 and duration < min_duration:
                            continue
                        if min_quality > 0 and quality > 0 and quality < min_quality:
                            continue
                        page_results.append({
                            'page_url': page_url,
                            'title': title,
                            'thumbnail': thumbnail,
                            'duration': duration,
                            'quality': quality or None,
                            'views': None,
                        })
                    except Exception as card_err:
                        logging.debug(f'[TnaflixDiscovery] Card parse error: {card_err}')
                return page, page_results
            except Exception as page_err:
                logging.error(f'[TnaflixDiscovery] Page {page} error: {page_err}')
                return page, []

        with ThreadPoolExecutor(max_workers=min(pages, 10)) as pool:
            futures = {pool.submit(_fetch_and_parse, pg): pg for pg in range(1, pages + 1)}
            page_data = {}
            for fut in as_completed(futures):
                pg, pg_results = fut.result()
                page_data[pg] = pg_results

        for pg in sorted(page_data.keys()):
            for item in page_data[pg]:
                if item['page_url'] not in seen:
                    seen.add(item['page_url'])
                    results.append(item)

        logging.info(f"[Tnaflix] discover() returning {len(results)} results for keyword={keyword!r}")
        return results

    def discover_profile(self, url: str, max_pages: int = 30) -> dict:
        """
        Fast profile scraper — returns card list WITHOUT extracting individual stream URLs.
        Each card has: {page_url, title, thumbnail, duration, quality, views, uploader}
        Import happens later via /discovery/tnaflix/import which stores watch-page URLs for JIT.
        """
        import urllib.parse
        cards = []
        seen: set = set()
        related_profiles = {}
        related_counts = Counter()
        base_url = url.split('?')[0].rstrip('/')

        # Detect uploader from URL
        uploader = ''
        m = re.search(r'/(?:profile|user)/([^/?#]+)', url)
        if m:
            uploader = m.group(1)

        # Detect section type from URL
        section = 'videos'
        if '/favorites' in url:
            section = 'favorites'
        elif '/playlist' in url:
            section = 'playlist'

        profile_info: dict = {}

        def _fetch_page(page: int):
            page_url = base_url if page == 1 else f"{base_url}?page={page}"
            try:
                resp = self.session.get(page_url, headers=self.headers, timeout=20)
                if resp.status_code != 200:
                    return page, None, None
                return page, resp.text, page_url
            except Exception as e:
                logging.error(f'[TnaflixProfile] page {page} fetch error: {e}')
                return page, None, None

        def _parse_page(page: int, html: str):
            soup = BeautifulSoup(html, 'html.parser')
            page_cards = []
            page_related_profiles = {}
            page_related_counts = Counter()
            p_info = None

            if page == 1:
                avatar_el = soup.select_one('.profile-avatar img, .user-avatar img, .avatar img')
                avatar = (avatar_el.get('src') or '') if avatar_el else ''
                name_el = soup.select_one('.profile-name, .username, h1.name, .user-name')
                display_name = name_el.get_text(strip=True) if name_el else uploader
                count_el = soup.select_one('.video-count, .videos-count, [class*="count"]')
                total_str = count_el.get_text(strip=True) if count_el else ''
                tabs = []
                for tab in soup.select('a[href*="/profile/"], a[href*="/user/"]'):
                    href = tab.get('href', '')
                    label = tab.get_text(strip=True)
                    if href and label and uploader.lower() in href.lower():
                        tabs.append({'label': label, 'url': href if href.startswith('http') else 'https://www.tnaflix.com' + href})
                p_info = {'username': uploader, 'display_name': display_name, 'avatar': avatar, 'total_str': total_str, 'tabs': tabs}

            card_els = soup.select('div[data-vid]')
            if not card_els:
                card_els = [c for c in soup.select('.col-xs-6, .col-md-4, .col-lg-4')
                            if c.select_one('a.video-thumb, a[href*="/video"]')]
            if not card_els:
                card_els = soup.select('a.video-thumb')

            for card in card_els:
                anchor = card.select_one('a.video-thumb, a.video-title, a[href*="/video"]')
                if not anchor:
                    if card.name == 'a' and '/video' in card.get('href', ''):
                        anchor = card
                    else:
                        continue
                href = anchor.get('href', '')
                if not href:
                    continue
                if not href.startswith('http'):
                    href = 'https://www.tnaflix.com' + href

                title_el = card.select_one('a.video-title')
                title = title_el.get_text(strip=True) if title_el else ''
                if not title:
                    img_t = card.select_one('img')
                    title = (img_t.get('alt') or '').strip() if img_t else ''
                if not title:
                    title = 'Tnaflix Video'

                thumb_anchor = card.select_one('a.video-thumb')
                img_el = (thumb_anchor or card).select_one('img')
                thumbnail = ''
                if img_el:
                    thumbnail = (img_el.get('data-original') or img_el.get('data-src') or img_el.get('src') or '')

                duration = 0
                dur_el = card.select_one('.video-duration, .thumb-icon.video-duration, .duration')
                if dur_el:
                    parts = dur_el.get_text(strip=True).split(':')
                    try:
                        if len(parts) == 3:
                            duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                        elif len(parts) == 2:
                            duration = int(parts[0]) * 60 + int(parts[1])
                    except Exception:
                        pass

                quality = 0
                qual_el = card.select_one('.max-quality, .thumb-icon.max-quality')
                if qual_el:
                    q_text = qual_el.get_text(strip=True).lower().replace('p', '').strip()
                    try:
                        q = int(q_text)
                        if 240 <= q <= 4320:
                            quality = q
                    except Exception:
                        if '4k' in q_text or '2160' in q_text:
                            quality = 2160
                        elif '1080' in q_text:
                            quality = 1080
                        elif '720' in q_text:
                            quality = 720
                if not quality:
                    quality = self._parse_quality_from_card(card)

                co_profiles_local = []
                for prof in card.select('a.badge[href*="/profile/"], a[href*="/profile/"].badge, a[href*="/user/"].badge'):
                    prof_href = prof.get('href', '')
                    prof_name = prof.get_text(strip=True)
                    if not prof_href or not prof_name:
                        continue
                    if not prof_href.startswith('http'):
                        prof_href = 'https://www.tnaflix.com' + prof_href
                    prof_match = re.search(r'/(?:profile|user)/([^/?#]+)', prof_href)
                    slug = prof_match.group(1) if prof_match else prof_name
                    if uploader and slug.lower() == uploader.lower():
                        continue
                    key = prof_href.split('?')[0].rstrip('/')
                    page_related_profiles[key] = {'name': prof_name, 'url': key, 'slug': slug}
                    page_related_counts[key] += 1
                    if not any(p['url'] == key for p in co_profiles_local):
                        co_profiles_local.append(page_related_profiles[key])

                views_el = card.select_one('.views, .view-count, [class*="view"]')
                views = 0
                if views_el:
                    v_text = re.sub(r'[^\d]', '', views_el.get_text())
                    try:
                        views = int(v_text)
                    except Exception:
                        pass

                page_cards.append({
                    'page_url': href,
                    'title': title,
                    'thumbnail': thumbnail,
                    'duration': duration,
                    'quality': quality or None,
                    'views': views or None,
                    'uploader': uploader,
                    'co_profiles': co_profiles_local,
                })
            return page_cards, p_info, page_related_profiles, page_related_counts

        # Probe page 1 first to detect total pages and get profile info
        _, html1, _ = _fetch_page(1)
        if not html1:
            related = []
            profile_info['related_profiles'] = related
            return {'cards': [], 'profile': profile_info, 'related_profiles': related, 'total': 0, 'uploader': uploader}

        p1_cards, p_info, p1_rel_profiles, p1_rel_counts = _parse_page(1, html1)
        if p_info:
            profile_info = p_info
        for k, v in p1_rel_profiles.items():
            related_profiles[k] = v
        for k, v in p1_rel_counts.items():
            related_counts[k] += v
        for c in p1_cards:
            if c['page_url'] not in seen:
                seen.add(c['page_url'])
                cards.append(c)

        if not p1_cards:
            # No videos on page 1
            related = []
            profile_info['related_profiles'] = related
            return {'cards': cards, 'profile': profile_info, 'related_profiles': related, 'total': len(cards), 'uploader': uploader}

        # Fetch remaining pages in parallel (up to max_pages, 12 workers)
        remaining_pages = list(range(2, max_pages + 1))
        if remaining_pages:
            with ThreadPoolExecutor(max_workers=12) as pool:
                futures = {pool.submit(_fetch_page, pg): pg for pg in remaining_pages}
                page_htmls = {}
                for fut in as_completed(futures):
                    pg, html, _ = fut.result()
                    if html:
                        page_htmls[pg] = html

            # Parse in page order to preserve sequence
            for pg in sorted(page_htmls.keys()):
                pg_cards, _, pg_rel, pg_counts = _parse_page(pg, page_htmls[pg])
                if not pg_cards:
                    break  # Empty page = reached end
                for k, v in pg_rel.items():
                    related_profiles[k] = v
                for k, v in pg_counts.items():
                    related_counts[k] += v
                for c in pg_cards:
                    if c['page_url'] not in seen:
                        seen.add(c['page_url'])
                        cards.append(c)

        related = []
        for key, count in related_counts.most_common(80):
            item = dict(related_profiles[key])
            item['count'] = count
            related.append(item)
        profile_info['related_profiles'] = related[:40]

        return {
            'cards': cards,
            'profile': profile_info,
            'related_profiles': related,
            'total': len(cards),
            'uploader': uploader,
        }

    def enrich_card(self, page_url: str) -> dict:
        """Fetch a single Tnaflix video page and return size, quality, duration, upload_date, thumbnail."""
        import json as _json
        result = {'page_url': page_url, 'ok': False, 'size_bytes': 0, 'size': '', 'quality': None, 'duration': 0, 'upload_date': '', 'thumbnail': '', 'stream_url': ''}
        try:
            resp = self.session.get(page_url, headers=self.headers, timeout=10)
            if resp.status_code != 200:
                return result
            html = resp.text
            soup = BeautifulSoup(html, 'html.parser')

            # Thumbnail
            og_img = soup.find('meta', property='og:image')
            if og_img:
                result['thumbnail'] = og_img.get('content', '')

            # Quality from og:video:height
            og_h = soup.find('meta', property='og:video:height')
            if og_h:
                try:
                    h = int(og_h.get('content', 0))
                    if h >= 2160: result['quality'] = 2160
                    elif h >= 1080: result['quality'] = 1080
                    elif h >= 720: result['quality'] = 720
                    elif h >= 480: result['quality'] = 480
                except Exception: pass

            # Duration from og:video:duration or LD+JSON
            og_dur = soup.find('meta', property='og:video:duration')
            if og_dur:
                try: result['duration'] = int(og_dur.get('content', 0))
                except Exception: pass
            if not result['duration']:
                for s in soup.find_all('script', type='application/ld+json'):
                    try:
                        jd = _json.loads(s.get_text())
                        pt = jd.get('duration', '')
                        m = re.search(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', pt)
                        if m:
                            result['duration'] = (int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0))
                            # Upload date from LD+JSON
                            ud = jd.get('uploadDate') or jd.get('datePublished') or ''
                            if ud: result['upload_date'] = str(ud)[:10]
                            break
                    except Exception: pass

            # Upload date fallback — itemprop
            if not result['upload_date']:
                ud_el = soup.find(itemprop='uploadDate') or soup.find(itemprop='datePublished')
                if ud_el:
                    result['upload_date'] = (ud_el.get('content') or ud_el.get_text(strip=True))[:10]

            # Stream URL — best quality source tag
            stream_url = ''
            quality_from_src = None
            video_tag = soup.find('video')
            if video_tag:
                best_size = -1
                for s in video_tag.find_all('source', src=True):
                    try:
                        size_attr = s.get('size', '0')
                        sz = 2160 if size_attr == '4' else int(size_attr)
                        if sz >= best_size:
                            best_size = sz
                            stream_url = s['src']
                            quality_from_src = sz if sz > 0 else None
                    except Exception:
                        if not stream_url:
                            stream_url = s['src']
            if not stream_url:
                og_vid = soup.find('meta', property='og:video')
                if og_vid and og_vid.get('content'):
                    stream_url = og_vid['content']
            # Normalize
            if stream_url and stream_url.startswith('//'):
                stream_url = 'https:' + stream_url
            if stream_url and 'www.tnaflix.com' in stream_url:
                stream_url = ''
            result['stream_url'] = stream_url
            if quality_from_src and not result['quality']:
                result['quality'] = quality_from_src

            # Quality fallback from URL path
            if not result['quality'] and stream_url:
                m = re.search(r'/(2160|1080|720|480|360)p?/', stream_url)
                if m: result['quality'] = int(m.group(1))

            # File size via HEAD on stream URL
            if stream_url:
                try:
                    head = self.session.head(stream_url, headers={**self.headers, 'Referer': page_url}, timeout=5, allow_redirects=True)
                    cl = int(head.headers.get('Content-Length', 0))
                    if cl > 0:
                        result['size_bytes'] = cl
                        mb = cl / 1048576
                        if mb >= 1024:
                            result['size'] = f'{mb/1024:.2f} GB'
                        else:
                            result['size'] = f'{mb:.1f} MB'
                except Exception: pass

            result['ok'] = True
        except Exception as e:
            logging.debug(f'[TnaflixEnrich] {page_url}: {e}')
        return result

    def enrich_cards_batch(self, page_urls: list, max_workers: int = 32) -> list:
        """Parallel enrich of multiple cards. Returns list of enrich results."""
        workers = min(max_workers, max(8, len(page_urls)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(self.enrich_card, url): url for url in page_urls}
            results = []
            for fut in as_completed(futures):
                results.append(fut.result())
        return results

    def discover_profiles(self, mode: str = "last_updated", limit: int = 50, pages: int = 3) -> dict:
        """
        Discover profile URLs without starting from one specific profile.

        mode="last_updated" scans TNAFlix's Most Recent listing pages and collects profile
        badges from fresh cards. This approximates recently active/updated profiles.
        mode="pornstars" reads the public TNAFlix pornstar directory.
        """
        profiles = {}
        order = 0
        limit = max(1, min(int(limit or 50), 200))
        pages = max(1, min(int(pages or 3), 20))
        mode = (mode or "last_updated").strip().lower()

        def abs_url(href: str) -> str:
            if not href:
                return ""
            return href if href.startswith("http") else "https://www.tnaflix.com" + href

        def add_profile(name: str, href: str, context: dict | None = None):
            nonlocal order
            href = abs_url(href).split("?")[0].rstrip("/")
            name = (name or "").strip()
            if not href or "/profile/" not in href or not name:
                return
            if href not in profiles:
                order += 1
                m = re.search(r"/profile/([^/?#]+)", href)
                profiles[href] = {
                    "name": re.sub(r"^#\d+\s+", "", name).strip(),
                    "url": href,
                    "slug": m.group(1) if m else name,
                    "count": 0,
                    "first_seen": order,
                    "latest_title": "",
                    "latest_page_url": "",
                    "thumbnail": "",
                    "rank": "",
                }
            profiles[href]["count"] += 1
            if context:
                for key in ("latest_title", "latest_page_url", "thumbnail", "rank"):
                    if context.get(key) and not profiles[href].get(key):
                        profiles[href][key] = context[key]

        if mode == "pornstars":
            # The directory is not a true user activity list, but it is useful
            # as a broad profile finder.
            for page in range(1, pages + 1):
                url = "https://www.tnaflix.com/pornstars" if page == 1 else f"https://www.tnaflix.com/pornstars?page={page}"
                try:
                    resp = self.session.get(url, headers=self.headers, timeout=20)
                    if resp.status_code >= 500:
                        break
                    soup = BeautifulSoup(resp.text, "html.parser")
                    links = soup.select('a[href*="/profile/"]')
                    if not links and page > 1:
                        break
                    for a in links:
                        text = a.get_text(" ", strip=True)
                        rank = ""
                        rank_m = re.search(r"#(\d+)", text)
                        if rank_m:
                            rank = rank_m.group(1)
                        img = a.select_one("img")
                        add_profile(text, a.get("href", ""), {
                            "thumbnail": (img.get("src") or img.get("data-src") or "") if img else "",
                            "rank": rank,
                        })
                        if len(profiles) >= limit:
                            break
                    if len(profiles) >= limit:
                        break
                except Exception as e:
                    logging.error(f"[TnaflixProfiles] pornstar page {page} error: {e}")
                    break
        else:
            for page in range(1, pages + 1):
                url = "https://www.tnaflix.com/new" if page == 1 else f"https://www.tnaflix.com/new/{page}"
                try:
                    resp = self.session.get(url, headers=self.headers, timeout=20)
                    if resp.status_code >= 500:
                        break
                    soup = BeautifulSoup(resp.text, "html.parser")
                    before_page = len(profiles)
                    cards = soup.select("div[data-vid]")
                    if not cards:
                        cards = [c for c in soup.select(".col-xs-6, .col-md-4, .col-lg-4") if c.select_one('a[href*="/video"]')]
                    if not cards and page > 1:
                        break
                    for card in cards:
                        title_el = card.select_one("a.video-title")
                        title = title_el.get_text(" ", strip=True) if title_el else ""
                        page_anchor = card.select_one('a.video-thumb, a.video-title, a[href*="/video"]')
                        page_url = abs_url(page_anchor.get("href", "")) if page_anchor else ""
                        img = card.select_one("img")
                        thumbnail = ""
                        if img:
                            thumbnail = img.get("data-original") or img.get("data-src") or img.get("src") or ""
                        for a in card.select('a.badge[href*="/profile/"], a[href*="/profile/"].badge'):
                            add_profile(a.get_text(" ", strip=True), a.get("href", ""), {
                                "latest_title": title,
                                "latest_page_url": page_url,
                                "thumbnail": thumbnail,
                            })
                            if len(profiles) >= limit:
                                break
                        if len(profiles) >= limit:
                            break
                    if len(profiles) == before_page:
                        # TNAFlix sometimes returns a useful listing page with
                        # profile badges outside the card nodes, and may even
                        # label that response as 404. Keep the finder useful
                        # by falling back to page-level profile links.
                        for a in soup.select('a[href*="/profile/"]'):
                            img = a.find_previous("img") or a.find_next("img")
                            thumbnail = ""
                            if img:
                                thumbnail = img.get("data-original") or img.get("data-src") or img.get("src") or ""
                            add_profile(a.get_text(" ", strip=True), a.get("href", ""), {
                                "latest_page_url": url,
                                "thumbnail": thumbnail,
                            })
                            if len(profiles) >= limit:
                                break
                    if len(profiles) >= limit:
                        break
                except Exception as e:
                    logging.error(f"[TnaflixProfiles] latest page {page} error: {e}")
                    break

        items = sorted(profiles.values(), key=lambda p: (-int(p.get("count") or 0), int(p.get("first_seen") or 0)))
        return {"profiles": items[:limit], "total": len(items[:limit]), "mode": mode, "pages": pages}

    def extract_from_profile(self, url: str, max_results=200) -> list:
        """
        Crawls a profile page and extracts videos.
        Supports automatic pagination up to max_results.
        """
        results = []
        seen_urls = set()
        count = 0
        
        # Base URL for pagination (remove query params)
        base_url = url.split('?')[0]
        
        # Iterate pages (safety limit 20 pages)
        for page in range(1, 21):
            if count >= max_results: break
            
            # Construct page URL
            # Tnaflix pagination: ?page=2
            current_url = base_url if page == 1 else f"{base_url}?page={page}"
            if page > 1: logging.info(f"Scanning Tnaflix Profile Page {page}: {current_url}")
            
            try:
                 resp = self.session.get(current_url, headers=self.headers, timeout=15)
                 if resp.status_code != 200:
                     logging.warning(f"Failed page {page}, status {resp.status_code}")
                     break
                 
                 soup = BeautifulSoup(resp.text, 'html.parser')
                 
                 # Links
                 links = soup.find_all('a', href=re.compile(r'/video\d+'))
                 if not links and page > 1:
                     # Stop if no videos found on subsequent pages
                     break
                 
                 # If we found links but all of them are already seen, we reached end/loop
                 new_links_on_page = 0
                 
                 for l in links:
                     if count >= max_results: break
                     
                     href = l['href']
                     if not href.startswith('http'):
                         href = "https://www.tnaflix.com" + href
                     
                     if href in seen_urls: continue
                     
                     seen_urls.add(href)
                     new_links_on_page += 1
                     
                     # Extract individual video
                     # Optimization: For profile mass import, we avoid full page load if possible?
                     # No, we need stream URL. But we can catch errors and continue.
                     try:
                        meta = self.extract(href)
                        if meta and meta.get('stream_url'):
                            results.append(meta)
                            count += 1
                     except Exception as ve:
                        logging.error(f"Failed to extract video {href}: {ve}")
                 
                 if new_links_on_page == 0:
                     logging.info(f"No new videos found on page {page}, stopping pagination.")
                     break
                     
            except Exception as e:
                logging.error(f"Tnaflix profile extraction error on page {page}: {e}")
                break
            
        return results
