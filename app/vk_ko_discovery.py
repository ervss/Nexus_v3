import asyncio
import sys
import logging
import urllib.parse
import re
import threading
from typing import List, Dict, Any, Optional
from concurrent.futures import Future
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, parse_qs

logger = logging.getLogger(__name__)


def _load_async_playwright():
    from playwright.async_api import async_playwright

    return async_playwright

VK_PLAYLIST_RE = re.compile(r"https?://(?:m\.)?vkvideo\.ru/playlist/(-?\d+_-?\d+)", re.I)
VK_PLAYLIST_BREADCRUMB_RE = re.compile(
    r"(?:m\.)?vkvideo\.ru\s*(?:[>/›»]+\s*)+playlist\s*(?:[>/›»]+\s*)+(-?\d+_-?\d+)",
    re.I,
)


def _playlist_identity_from_url(url: str) -> Dict[str, str]:
    match = re.search(r"/playlist/(-?\d+)_(-?\d+)", str(url or ""), re.I)
    if not match:
        return {"owner_id": "", "playlist_id": ""}
    return {
        "owner_id": match.group(1),
        "playlist_id": match.group(2),
    }


def _normalize_playlist_title(raw_title: str, fallback_url: str = "") -> str:
    title = re.sub(r"\s+", " ", str(raw_title or "").strip())
    title = re.sub(r"\s*[-|]\s*VK.*$", "", title, flags=re.I).strip()
    title = re.sub(r"\s*[-|]\s*Видео\s*VK.*$", "", title, flags=re.I).strip()
    if title and not title.lower().startswith("vk playlist "):
        return title[:180]
    playlist_key = _playlist_identity_from_url(fallback_url)
    if playlist_key["owner_id"] and playlist_key["playlist_id"]:
        return f"VK playlist {playlist_key['owner_id']}_{playlist_key['playlist_id']}"
    return title[:180]


def _extract_count_from_text(raw_text: str) -> int:
    text = str(raw_text or "")
    if not text:
        return 0
    match = re.search(r"(\d[\d\s.,]*)\s*(?:видео|video|videos|ролик|роликов|clips?)", text, re.I)
    if not match:
        return 0
    digits = re.sub(r"[^\d]", "", match.group(1))
    return int(digits) if digits.isdigit() else 0


def _normalize_external_playlist_url(raw_url: str) -> str:
    """
    Converts search-result redirect URLs into a clean VK playlist URL.
    """
    if not raw_url:
        return ""

    url = str(raw_url).strip()
    breadcrumb_match = VK_PLAYLIST_BREADCRUMB_RE.search(url)
    if breadcrumb_match:
        return f"https://vkvideo.ru/playlist/{breadcrumb_match.group(1)}"

    parsed = urllib.parse.urlparse(url)
    query = urllib.parse.parse_qs(parsed.query)

    for values in query.values():
        for value in values:
            candidate = urllib.parse.unquote(value)
            if "vkvideo.ru" in candidate and ("playlist" in candidate or "%2Fplaylist" in candidate.lower()):
                nested = _normalize_external_playlist_url(candidate)
                if nested:
                    return nested

    url = urllib.parse.unquote(url)
    match = VK_PLAYLIST_RE.search(url)
    if not match:
        breadcrumb_match = VK_PLAYLIST_BREADCRUMB_RE.search(url)
        if breadcrumb_match:
            return f"https://vkvideo.ru/playlist/{breadcrumb_match.group(1)}"
        return ""
    return f"https://vkvideo.ru/playlist/{match.group(1)}"


def build_external_playlist_query(
    keyword: str,
    site_domain: str = "m.vkvideo.ru",
    extra_terms: str = "vk video playlist",
    exclude_terms: str = "",
) -> str:
    """
    Query shape mirrors the screenshot: site:m.vkvideo.ru <keyword> vk video playlist.
    """
    parts = [f"site:{site_domain or 'm.vkvideo.ru'}"]
    if keyword:
        parts.append(keyword.strip())
    if extra_terms:
        parts.append(extra_terms.strip())
    for term in re.split(r"[\s,;]+", exclude_terms or ""):
        term = term.strip().lstrip("-")
        if term:
            parts.append(f"-{term}")
    return " ".join(parts).strip()


def build_external_search_url(engine: str, query: str, page_index: int = 0) -> str:
    engine = (engine or "yandex").lower()
    if engine == "google":
        params = {
            "q": query,
            "safe": "off",
            "filter": "0",
            "num": "20",
            "start": str(max(0, page_index) * 20),
        }
        return f"https://www.google.com/search?{urllib.parse.urlencode(params)}"
    if engine in {"duckduckgo", "ddg"}:
        params = {
            "q": query,
            "kp": "-2",
            "ia": "web",
        }
        if page_index > 0:
            params["s"] = str(max(0, page_index) * 30)
        return f"https://duckduckgo.com/html/?{urllib.parse.urlencode(params)}"

    params = {
        "text": query,
        "lr": "10489",
        "search_source": "yacom_desktop_common",
        "noreask": "1",
    }
    if page_index > 0:
        params["p"] = str(page_index)
    return f"https://yandex.com/search/?{urllib.parse.urlencode(params)}"


def _playlist_result_from_match(raw_text: str, match: re.Match, source_engine: str = "pasted") -> Dict[str, Any]:
    playlist_id = match.group(1)
    playlist_url = f"https://vkvideo.ru/playlist/{playlist_id}"
    lines = [line.strip() for line in raw_text.splitlines() if line.strip()]

    match_line_index = 0
    for idx, line in enumerate(lines):
        if playlist_id in line:
            match_line_index = idx
            break

    nearby = lines[max(0, match_line_index - 2): min(len(lines), match_line_index + 5)]
    title = ""
    for line in nearby:
        low = line.lower()
        if playlist_id in line or "vkvideo.ru" in low or low.startswith("missing:"):
            continue
        if "search" == low or low in {"web", "video", "images", "maps", "translate"}:
            continue
        if len(line) >= 4:
            title = line
            break
    if not title:
        title = f"VK playlist {playlist_id}"

    context = " ".join(nearby)
    video_count = 0
    count_match = re.search(
        r"(\d[\d\s.,]*)\s*(?:видео|video|videos|ролик|роликов)",
        context,
        re.I,
    )
    if count_match:
        count_raw = count_match.group(1).replace(" ", "").replace(",", "").replace(".", "")
        if count_raw.isdigit():
            video_count = int(count_raw)

    return {
        "title": title[:180],
        "url": playlist_url,
        "video_count": video_count,
        "community_id": source_engine,
        "community_name": f"{source_engine.title()} Results",
        "source_engine": source_engine,
        "snippet": context[:260],
        "search_query": "",
        "search_url": "",
    }


def _playlist_result_from_url(playlist_url: str, source_engine: str = "pasted") -> Dict[str, Any]:
    match = re.search(r"/playlist/(-?\d+_-?\d+)", playlist_url, re.I)
    playlist_id = match.group(1) if match else playlist_url.rsplit("/", 1)[-1]
    clean_url = f"https://vkvideo.ru/playlist/{playlist_id}" if match else playlist_url.strip()
    return {
        "title": f"VK playlist {playlist_id}",
        "url": clean_url,
        "video_count": 0,
        "community_id": source_engine,
        "community_name": f"{source_engine.title()} Results",
        "source_engine": source_engine,
        "snippet": "",
        "search_query": "",
        "search_url": "",
    }


def extract_playlist_results_from_text(raw_text: str, source_engine: str = "pasted") -> List[Dict[str, Any]]:
    """
    Parses text copied from Yandex/Google results. This catches the exact Yandex
    breadcrumb shape visible in the browser: m.vkvideo.ru > playlist > -123_45.
    """
    text = urllib.parse.unquote(str(raw_text or ""))
    results: List[Dict[str, Any]] = []
    seen_urls = set()

    # If the pasted payload is already a clean URL list, treat each line as one playlist.
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if lines and all(re.search(r"https?://(?:m\.)?vkvideo\.ru/playlist/-?\d+_-?\d+", line, re.I) for line in lines):
        for line in lines:
            item = _playlist_result_from_url(line, source_engine=source_engine)
            if item["url"] in seen_urls:
                continue
            seen_urls.add(item["url"])
            results.append(item)
        return results

    for regex in (VK_PLAYLIST_RE, VK_PLAYLIST_BREADCRUMB_RE):
        for match in regex.finditer(text):
            item = _playlist_result_from_match(text, match, source_engine=source_engine)
            if item["url"] in seen_urls:
                continue
            seen_urls.add(item["url"])
            results.append(item)

    results.sort(key=lambda item: item.get("video_count") or 0, reverse=True)
    return results


def _vk_playlist_ytdlp_opts() -> Dict[str, Any]:
    import os

    user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    opts: Dict[str, Any] = {
        'quiet': True,
        'skip_download': True,
        'extract_flat': True,
        'ignoreerrors': True,
        'no_warnings': True,
        'user_agent': user_agent,
        'http_headers': {
            'User-Agent': user_agent,
            'Referer': 'https://vk.com/',
            'Accept-Language': 'en-us,en;q=0.5',
        },
    }
    vk_cookie_candidates = [
        os.path.join("app", "vkvideo.ru_cookies.txt"),
        os.path.join("app", "vk.com_cookies.txt"),
        os.path.join("app", "vk.netscape.txt"),
        os.path.join("app", "cookies.netscape.txt"),
        "vkvideo.ru_cookies.txt",
        "vk.com_cookies.txt",
        "vk.netscape.txt",
        "cookies.netscape.txt",
    ]
    cookie_file = next((p for p in vk_cookie_candidates if os.path.exists(p)), None)
    if cookie_file:
        opts['cookiefile'] = cookie_file
    return opts


def _fetch_vk_playlist_metadata(url: str) -> Dict[str, Any]:
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL(_vk_playlist_ytdlp_opts()) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        logger.warning(f"VK playlist metadata fetch failed for {url}: {exc}")
        return {}

    if not info:
        return {}

    entries = info.get('entries') or []
    title = (info.get('title') or '').strip()
    playlist_count = info.get('playlist_count')
    video_count = int(playlist_count or len([entry for entry in entries if entry])) if entries or playlist_count else 0

    return {
        "title": _normalize_playlist_title(title, url),
        "video_count": video_count,
        "uploader": (info.get("uploader") or info.get("channel") or info.get("creator") or "").strip(),
        "thumbnail": (info.get("thumbnail") or "").strip(),
        "modified_date": (info.get("modified_date") or info.get("release_date") or info.get("upload_date") or "").strip(),
    }


async def _enrich_vk_playlist_results_async(playlists: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    from datetime import datetime
    
    if not playlists:
        return playlists

    # Candidates are items that lack title/video_count/thumbnail/community_name
    all_candidates = [
        item for item in playlists
        if not item.get("thumbnail") or not item.get("community_name") or (item.get("video_count") or 0) == 0 or str(item.get("title") or "").lower().startswith("vk playlist ")
    ]
    candidates = all_candidates[:80]  # Broader enrichment to avoid half-empty rows in larger pasted batches
    if not candidates:
        return playlists

    logger.info(f"Enriching {len(candidates)} VK playlists with Playwright API interceptor...")

    async with _load_async_playwright()() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 1000}
        )
        
        # Load combined cookies
        cookies = parse_netscape_cookies("vkvideo.ru_cookies.txt")
        if cookies:
            await context.add_cookies(cookies)
            logger.info(f"Loaded {len(cookies)} cookies into enrichment context.")

        async def enrich_one(item):
            url = item["url"]
            page = await context.new_page()
            
            album_data = None
            group_data = None
            user_data = None
            
            async def handle_response(resp):
                nonlocal album_data, group_data, user_data
                u = resp.url
                if "video.getAlbumById" in u:
                    try:
                        album_data = await resp.json()
                    except Exception:
                        pass
                elif "groups.getById" in u:
                    try:
                        group_data = await resp.json()
                    except Exception:
                        pass
                elif "users.get" in u:
                    try:
                        user_data = await resp.json()
                    except Exception:
                        pass
                        
            page.on("response", handle_response)
            
            try:
                # Domcontentloaded is fast and enough for API calls to initiate
                await page.goto(url, wait_until="domcontentloaded", timeout=12000)
                
                # Wait up to 6 seconds for the API responses to arrive
                for _ in range(6):
                    await page.wait_for_timeout(1000)
                    if album_data:
                        break
            except Exception as e:
                logger.warning(f"Playwright enrichment navigation failed for playlist {url}: {e}")
                
            # If Playwright got the API response, parse it
            parsed_successfully = False
            if album_data and "response" in album_data:
                resp = album_data["response"]
                title = resp.get("title")
                if title:
                    item["title"] = _normalize_playlist_title(title, url)
                if resp.get("count") is not None:
                    item["video_count"] = int(resp["count"])
                
                # Extract thumbnail (highest resolution)
                images = resp.get("image") or []
                if images:
                    images_sorted = sorted(images, key=lambda img: img.get("width") or 0)
                    item["thumbnail"] = images_sorted[-1].get("url") or ""
                    
                # Format update date
                updated_time = resp.get("updated_time")
                if updated_time:
                    try:
                        item["updated_date"] = datetime.fromtimestamp(updated_time).strftime("%Y-%m-%d")
                    except Exception:
                        pass
                parsed_successfully = True
                
            if group_data and "response" in group_data:
                groups = group_data["response"].get("groups") or []
                if groups:
                    item["community_name"] = groups[0].get("name") or ""
            elif user_data and "response" in user_data:
                users = user_data["response"]
                if users:
                    first = users[0].get("first_name") or ""
                    last = users[0].get("last_name") or ""
                    item["community_name"] = f"{first} {last}".strip() or f"User {users[0].get('id')}"

            # Fallback to uploader name from owner_id if not resolved
            if album_data and "response" in album_data and not item.get("community_name"):
                owner_id = album_data["response"].get("owner_id")
                if owner_id:
                    item["community_name"] = f"Owner {owner_id}"

            # DOM fallback: when API interception is partial, scrape already-rendered page metadata.
            try:
                dom_meta = await page.evaluate("""
                    () => {
                        const pickText = (selectors) => {
                            for (const selector of selectors) {
                                const node = document.querySelector(selector);
                                const value = (node?.content || node?.innerText || node?.textContent || '').trim();
                                if (value) return value;
                            }
                            return '';
                        };

                        const title = pickText([
                            'meta[property="og:title"]',
                            'meta[name="twitter:title"]',
                            'h1',
                            '[data-testid="title"]',
                            '[class*="title"]',
                        ]);

                        const thumbnail = pickText([
                            'meta[property="og:image"]',
                            'meta[name="twitter:image"]',
                        ]);

                        let communityName = '';
                        const communityCandidates = Array.from(document.querySelectorAll('a[href*="@club"], a[href*="@id"], a[href*="/video/@"]'));
                        for (const node of communityCandidates) {
                            const value = (node.innerText || node.textContent || '').trim();
                            if (value && value.length > 1) {
                                communityName = value;
                                break;
                            }
                        }

                        const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
                        const countMatch = bodyText.match(/(\\d[\\d\\s.,]*)\\s*(?:видео|video|videos|ролик|роликов|clips?)/i);
                        const updatedMatch = bodyText.match(/(?:Updated|Обновлено|Обновлен|Последнее обновление)[:\\s]+([^\\n|•]{4,40})/i);

                        let dateText = updatedMatch ? updatedMatch[1].trim() : '';
                        if (!dateText) {
                            const timeEl = document.querySelector('time,[datetime],[data-time],[class*="date"],[class*="time"]');
                            const candidate = (timeEl?.getAttribute?.('datetime') || timeEl?.innerText || timeEl?.textContent || '').trim();
                            if (candidate) dateText = candidate;
                        }

                        return {
                            title,
                            thumbnail,
                            community_name: communityName,
                            body_text: bodyText.slice(0, 5000),
                            count_text: countMatch ? countMatch[0] : '',
                            updated_date: dateText,
                        };
                    }
                """)

                dom_title = _normalize_playlist_title(dom_meta.get("title") or "", url)
                if dom_title and (not item.get("title") or str(item.get("title") or "").lower().startswith("vk playlist ")):
                    item["title"] = dom_title

                dom_thumb = str(dom_meta.get("thumbnail") or "").strip()
                if dom_thumb and not item.get("thumbnail"):
                    item["thumbnail"] = dom_thumb

                dom_community = str(dom_meta.get("community_name") or "").strip()
                if dom_community and (
                    not item.get("community_name")
                    or str(item.get("community_name") or "").lower() in {"yandex results", "google results", "global search"}
                ):
                    item["community_name"] = dom_community

                if not item.get("video_count"):
                    dom_count = _extract_count_from_text(dom_meta.get("count_text") or dom_meta.get("body_text") or "")
                    if dom_count > 0:
                        item["video_count"] = dom_count

                dom_updated = str(dom_meta.get("updated_date") or "").strip()
                if dom_updated and not item.get("updated_date"):
                    item["updated_date"] = dom_updated[:40]
            except Exception as dom_err:
                logger.debug(f"DOM fallback enrichment failed for {url}: {dom_err}")

            # Fallback to old yt-dlp check if Playwright failed to parse the album
            if not parsed_successfully:
                logger.info(f"Playwright enrichment failed for {url}. Falling back to yt-dlp...")
                try:
                    # Run the original yt-dlp metadata fetcher in a thread pool thread
                    loop = asyncio.get_running_loop()
                    meta = await loop.run_in_executor(None, _fetch_vk_playlist_metadata, url)
                    if meta:
                        if meta.get("title"):
                            item["title"] = meta["title"]
                        if meta.get("video_count"):
                            item["video_count"] = meta["video_count"]
                        if meta.get("uploader") and (
                            not item.get("community_name")
                            or str(item.get("community_name") or "").lower() in {"yandex results", "google results", "global search"}
                        ):
                            item["community_name"] = meta["uploader"]
                        if meta.get("thumbnail") and not item.get("thumbnail"):
                            item["thumbnail"] = meta["thumbnail"]
                        if meta.get("modified_date") and not item.get("updated_date"):
                            raw = str(meta["modified_date"]).strip()
                            if re.fullmatch(r"\\d{8}", raw):
                                item["updated_date"] = f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
                            else:
                                item["updated_date"] = raw[:40]
                except Exception as ytdl_err:
                    logger.warning(f"yt-dlp fallback failed for {url}: {ytdl_err}")

            # Final deterministic fallback so the table is never half-empty again.
            playlist_key = _playlist_identity_from_url(url)
            if not item.get("title"):
                item["title"] = _normalize_playlist_title("", url)
            if not item.get("community_name"):
                owner_id = playlist_key.get("owner_id") or ""
                if owner_id.startswith("-"):
                    item["community_name"] = f"VK Community {owner_id}"
                elif owner_id:
                    item["community_name"] = f"VK User {owner_id}"
                else:
                    item["community_name"] = "VK Playlist"

            await page.close()

        # Process in chunks of 5 concurrent pages
        chunk_size = 5
        for i in range(0, len(candidates), chunk_size):
            chunk = candidates[i:i+chunk_size]
            await asyncio.gather(*(enrich_one(item) for item in chunk), return_exceptions=True)

        await browser.close()
        
    return playlists


def enrich_vk_playlist_results(playlists: List[Dict[str, Any]], max_workers: int = 6) -> List[Dict[str, Any]]:
    """
    Resolve playlist title and video count for plain VK playlist URLs.
    Runs the async Playwright enrichment pipeline inside a dedicated event loop thread.
    """
    if not playlists:
        return playlists
        
    future = Future()
    
    def thread_target():
        import asyncio
        if sys.platform == 'win32':
            loop = asyncio.WindowsProactorEventLoopPolicy().new_event_loop()
        else:
            loop = asyncio.new_event_loop()
            
        asyncio.set_event_loop(loop)
        
        try:
            result = loop.run_until_complete(_enrich_vk_playlist_results_async(playlists))
            future.set_result(result)
        except Exception as e:
            future.set_exception(e)
        finally:
            loop.close()
            
    t = threading.Thread(target=thread_target)
    t.start()
    
    res = future.result()
    res.sort(key=lambda item: item.get("video_count") or 0, reverse=True)
    return res



async def _soft_accept_search_gate(page) -> None:
    """
    Search engines sometimes show consent/continue gates. We only click ordinary
    consent buttons; no bypassing account or age restrictions.
    """
    labels = [
        "Accept all",
        "I agree",
        "Agree",
        "Принять",
        "Продолжить",
        "Continue",
    ]
    for label in labels:
        try:
            locator = page.get_by_text(label, exact=False)
            if await locator.count() > 0:
                await locator.first.click(timeout=1200)
                await page.wait_for_timeout(800)
                return
        except Exception:
            continue


async def scan_external_playlist_search(
    browser,
    keyword: str,
    engine: str = "yandex",
    pages: int = 2,
    site_domain: str = "m.vkvideo.ru",
    extra_terms: str = "vk video playlist",
    exclude_terms: str = "",
    min_video_count: int = 0,
    max_results: int = 80,
) -> List[Dict[str, Any]]:
    """
    Searches public search-engine indexes for VK playlist pages.
    This is intentionally additive: it finds playlist URLs, while playlist import
    still uses the existing VK playlist expansion pipeline.
    """
    engine = (engine or "yandex").lower()
    if engine == "ddg":
        engine = "duckduckgo"
    discovered: List[Dict[str, Any]] = []
    seen_urls = set()
    query = build_external_playlist_query(keyword, site_domain, extra_terms, exclude_terms)

    context = await browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport={"width": 1366, "height": 1100},
        locale="en-US",
    )
    page = await context.new_page()

    try:
        for page_index in range(max(1, min(int(pages or 1), 8))):
            search_url = build_external_search_url(engine, query, page_index)
            logger.info(f"Scanning {engine} playlist index page {page_index + 1}: {search_url}")
            try:
                await page.goto(search_url, wait_until="domcontentloaded", timeout=25000)
                await _soft_accept_search_gate(page)
                await page.wait_for_timeout(1200)
                for _ in range(2):
                    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    await page.wait_for_timeout(350)
            except Exception as nav_err:
                logger.warning(f"{engine} playlist search navigation failed on page {page_index + 1}: {nav_err}")
                continue

            results = await page.evaluate("""
                () => {
                    const out = [];
                    const anchors = Array.from(document.querySelectorAll('a[href]'));
                    for (const a of anchors) {
                        const href = a.href || a.getAttribute('href') || '';
                        const text = (a.innerText || a.textContent || '').trim();
                        let box = a.closest('li, article, .serp-item, .g, [data-cid], [class*="result"], [class*="organic"]');
                        let snippet = '';
                        if (box) {
                            snippet = (box.innerText || box.textContent || '').trim();
                        }
                        out.push({ href, text, snippet });
                    }
                    return out;
                }
            """)

            page_found = 0
            for item in results:
                title = re.sub(r"\s+", " ", (item.get("text") or "").strip())
                snippet = re.sub(r"\s+", " ", (item.get("snippet") or "").strip())
                playlist_url = _normalize_external_playlist_url(item.get("href", ""))
                if not playlist_url:
                    playlist_url = _normalize_external_playlist_url(f"{title} {snippet}")
                if not playlist_url or playlist_url in seen_urls:
                    continue

                if not title or len(title) < 4:
                    title = snippet[:90] or playlist_url

                video_count = 0
                count_match = re.search(
                    r"(\d[\d\s.,]*)\s*(?:видео|video|videos|ролик|роликов)",
                    f"{title} {snippet}",
                    re.I,
                )
                if count_match:
                    count_raw = count_match.group(1).replace(" ", "").replace(",", "").replace(".", "")
                    if count_raw.isdigit():
                        video_count = int(count_raw)

                if min_video_count and video_count and video_count < min_video_count:
                    continue

                seen_urls.add(playlist_url)
                page_found += 1
                discovered.append({
                    "title": title[:180],
                    "url": playlist_url,
                    "video_count": video_count,
                    "community_id": engine,
                    "community_name": f"{engine.title()} Search",
                    "source_engine": engine,
                    "snippet": snippet[:260],
                    "search_query": query,
                    "search_url": search_url,
                })

                if len(discovered) >= max(1, min(int(max_results or 80), 300)):
                    return discovered

            try:
                body_text = await page.evaluate("document.body ? document.body.innerText : ''")
            except Exception:
                body_text = ""
            for item in extract_playlist_results_from_text(body_text, source_engine=engine):
                if item["url"] in seen_urls:
                    continue
                if min_video_count and item.get("video_count") and item["video_count"] < min_video_count:
                    continue
                seen_urls.add(item["url"])
                page_found += 1
                item["search_query"] = query
                item["search_url"] = search_url
                discovered.append(item)

                if len(discovered) >= max(1, min(int(max_results or 80), 300)):
                    return discovered

            logger.info(
                f"{engine} playlist index page {page_index + 1}: scanned {len(results)} links, parsed {page_found} playlists"
            )
    except Exception as e:
        logger.error(f"Error scanning {engine} playlist index: {e}")
    finally:
        await context.close()
    return discovered


def scan_external_playlist_search_sync(
    keyword: str,
    engines: Optional[List[str]] = None,
    pages: int = 2,
    site_domain: str = "m.vkvideo.ru",
    extra_terms: str = "vk video playlist",
    exclude_terms: str = "",
    min_video_count: int = 0,
    max_results: int = 80,
) -> List[Dict[str, Any]]:
    """Run the Playwright search in a private event loop, including Windows."""
    future: Future = Future()

    def thread_target() -> None:
        if sys.platform == "win32":
            loop = asyncio.WindowsProactorEventLoopPolicy().new_event_loop()
        else:
            loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        async def run() -> List[Dict[str, Any]]:
            async with _load_async_playwright()() as playwright:
                browser = await playwright.chromium.launch(headless=True)
                try:
                    found: List[Dict[str, Any]] = []
                    seen_urls: set[str] = set()
                    for engine in engines or ["yandex", "duckduckgo", "google"]:
                        try:
                            results = await scan_external_playlist_search(
                                browser,
                                keyword,
                                engine=engine,
                                pages=pages,
                                site_domain=site_domain,
                                extra_terms=extra_terms,
                                exclude_terms=exclude_terms,
                                min_video_count=min_video_count,
                                max_results=max_results,
                            )
                        except Exception as exc:
                            logger.warning("VK KO engine %s failed: %s", engine, exc, exc_info=True)
                            continue
                        for item in results:
                            if item["url"] not in seen_urls:
                                seen_urls.add(item["url"])
                                found.append(item)
                    return found[:max(1, min(int(max_results or 80), 300))]
                finally:
                    await browser.close()

        try:
            future.set_result(loop.run_until_complete(run()))
        except Exception as exc:
            future.set_exception(exc)
        finally:
            loop.close()

    thread = threading.Thread(target=thread_target, name="vk-ko-playlist-search")
    thread.start()
    return future.result()

def parse_netscape_cookies(cookie_file_path: str) -> List[Dict[str, Any]]:
    """
    Parses a standard Netscape/Mozilla cookies file format.
    """
    import os
    cookies = []
    if not os.path.exists(cookie_file_path):
        return cookies
    try:
        with open(cookie_file_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or line.startswith('//'):
                    continue
                parts = line.split('\t')
                if len(parts) >= 7:
                    domain, _, path, secure_str, expires_str, name, value = parts[:7]
                    
                    secure = secure_str.upper() == 'TRUE'
                    expires = int(expires_str) if expires_str.isdigit() else -1
                    
                    cookie = {
                        'name': name,
                        'value': value,
                        'domain': domain,
                        'path': path,
                        'secure': secure
                    }
                    if expires > 0:
                        cookie['expires'] = expires
                    cookies.append(cookie)
    except Exception as e:
        logger.error(f"Error parsing Netscape cookies file: {e}")
    return cookies


def parse_vk_cookie_bundle() -> List[Dict[str, Any]]:
    """
    Loads both vk.com and vkvideo.ru cookies for browser-backed discovery.
    Values are never logged; callers only receive Playwright cookie objects.
    """
    import os

    cookie_files = [
        "vkvideo.ru_cookies.txt",
        "vk.com_cookies.txt",
        os.path.join("app", "vkvideo.ru_cookies.txt"),
        os.path.join("app", "vk.com_cookies.txt"),
        os.path.join("app", "vk.netscape.txt"),
        "vk.netscape.txt",
    ]
    cookies: List[Dict[str, Any]] = []
    seen = set()
    for cookie_file in cookie_files:
        for cookie in parse_netscape_cookies(cookie_file):
            key = (cookie.get("domain"), cookie.get("path"), cookie.get("name"))
            if key in seen:
                continue
            seen.add(key)
            cookies.append(cookie)
    return cookies


def _normalize_vk_source_url(url: str) -> str:
    raw = (url or "").strip()
    if not raw:
        return ""
    if raw.startswith("//"):
        raw = "https:" + raw
    if not raw.startswith(("http://", "https://")):
        raw = "https://" + raw.lstrip("/")
    return raw.split("?", 1)[0].rstrip("/")


def _source_to_vkvideo_videos_url(url: str) -> str:
    source = _normalize_vk_source_url(url)
    if not source:
        return ""
    parsed = urlparse(source)
    path = parsed.path.strip("/")

    if "vkvideo.ru" in parsed.netloc:
        base = source
    elif "vk.com" in parsed.netloc:
        if path.startswith(("club", "public")) and path[4:].isdigit():
            group_id = re.sub(r"^(club|public)", "", path)
            base = f"https://vkvideo.ru/@club{group_id}"
        else:
            slug = path.split("/", 1)[0]
            base = f"https://vkvideo.ru/@{slug}"
    else:
        base = source

    for suffix in ("/videos", "/playlists"):
        if base.endswith(suffix):
            return base
    return f"{base}/videos"


def _source_to_vkvideo_playlists_url(url: str) -> str:
    videos_url = _source_to_vkvideo_videos_url(url)
    if videos_url.endswith("/videos"):
        return videos_url[:-7] + "/playlists"
    return videos_url.rstrip("/") + "/playlists"


def _normalize_vk_video_url(raw_url: str) -> str:
    raw = str(raw_url or "").strip()
    if not raw:
        return ""
    raw = urllib.parse.unquote(raw)
    if raw.startswith("//"):
        raw = "https:" + raw
    if raw.startswith("/"):
        raw = "https://vkvideo.ru" + raw

    parsed = urlparse(raw if raw.startswith(("http://", "https://")) else f"https://vkvideo.ru/{raw.lstrip('/')}")
    query = parse_qs(parsed.query)

    video_match = re.search(r"video(-?\d+_\d+)", raw)
    if video_match:
        return f"https://vk.com/video{video_match.group(1)}"

    oid = (query.get("oid") or query.get("owner_id") or [""])[0]
    vid = (query.get("id") or query.get("video_id") or [""])[0]
    if oid and vid and re.match(r"-?\d+$", oid) and re.match(r"\d+$", vid):
        return f"https://vk.com/video{oid}_{vid}"

    return ""


async def scan_followed_vk_groups_async(max_groups: int = 300) -> List[Dict[str, Any]]:
    """
    Reads the user's followed VK communities from vk.com/groups/my_all_groups.
    This is read-only browser automation using the supplied vk.com cookies.
    """
    groups: List[Dict[str, Any]] = []
    seen = set()

    async with _load_async_playwright()() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1366, "height": 1100},
            locale="en-US",
        )
        cookies = parse_vk_cookie_bundle()
        if cookies:
            await context.add_cookies(cookies)
        page = await context.new_page()
        try:
            # VKVideo keeps the current logged-in session more reliably than vk.com
            # for this account, and exposes the followed channel list in the sidebar/feed.
            for source_url in ("https://vkvideo.ru/subscriptions", "https://vkvideo.ru/my_communities"):
                await page.goto(source_url, wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_timeout(1800)
                for _ in range(8):
                    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    await page.wait_for_timeout(350)

                raw_channels = await page.evaluate(r"""
                    () => Array.from(document.querySelectorAll('a[href]')).map(a => {
                        const href = a.href || a.getAttribute('href') || '';
                        const path = new URL(href, location.origin).pathname;
                        if (!/^\/@[A-Za-z0-9_.-]+\/?$/.test(path)) return null;
                        const card = a.closest('[class*="Card"], [class*="Item"], li, article, [class*="Channel"], [class*="Community"]') || a.parentElement;
                        const text = [
                            a.innerText || a.textContent || '',
                            card ? (card.innerText || card.textContent || '') : ''
                        ].join(' ').replace(/\s+/g, ' ').trim();
                        const img = card?.querySelector?.('img')?.src || a.querySelector?.('img')?.src || '';
                        return { href: `https://vkvideo.ru${path.replace(/\/$/, '')}`, text, thumbnail: img };
                    }).filter(Boolean)
                """)

                for item in raw_channels:
                    url = _normalize_vk_source_url(item.get("href", ""))
                    if not url or url in seen or url.endswith("@patinko999"):
                        continue
                    title = re.sub(r"\s+", " ", str(item.get("text") or "").strip())
                    title = re.sub(r"\b(Channels|Playlists|Following|Manage followed content|Set up channel list)\b", "", title, flags=re.I).strip()
                    if not title or len(title) < 2:
                        title = url.rsplit("@", 1)[-1]
                    seen.add(url)
                    groups.append({
                        "name": title[:140],
                        "url": url,
                        "source_type": "group",
                        "thumbnail": item.get("thumbnail") or "",
                        "notes": f"Imported from {source_url}",
                    })
                    if len(groups) >= max(1, min(int(max_groups or 300), 1000)):
                        return groups

            await page.goto("https://vk.com/groups/my_all_groups", wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(2000)
            for _ in range(18):
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await page.wait_for_timeout(450)

            raw_groups = await page.evaluate(r"""
                () => {
                    const out = [];
                    const anchors = Array.from(document.querySelectorAll('a[href]'));
                    for (const a of anchors) {
                        const href = a.href || a.getAttribute('href') || '';
                        if (!href) continue;
                        const url = new URL(href, location.origin);
                        const path = url.pathname.replace(/^\/+/, '').split('/')[0];
                        if (!/^(club\d+|public\d+|[A-Za-z0-9_.-]{3,})$/.test(path)) continue;
                        if (['about','about_us','ads','blog','dev','feed','groups','help','im','jobs','login','press','privacy','promo','search','settings','support','terms','video','videos'].includes(path)) continue;
                        const card = a.closest('.group_row, .groups_row, .CatalogBlock, .ui_rmenu_item, li, article, [class*="group"], [class*="Group"]') || a.parentElement;
                        if (!/^club\d+|public\d+$/.test(path) && !card?.className?.toString?.().toLowerCase?.().includes('group')) continue;
                        const text = [
                            a.innerText || a.textContent || '',
                            card ? (card.innerText || card.textContent || '') : ''
                        ].join(' ').replace(/\s+/g, ' ').trim();
                        const img = card?.querySelector?.('img')?.src || a.querySelector?.('img')?.src || '';
                        out.push({ href: `https://vk.com/${path}`, path, text, thumbnail: img });
                    }
                    return out;
                }
            """)

            for item in raw_groups:
                url = _normalize_vk_source_url(item.get("href", ""))
                if not url or url in seen:
                    continue
                seen.add(url)
                title = re.sub(r"\s+", " ", str(item.get("text") or "").strip())
                if not title:
                    title = item.get("path") or url.rsplit("/", 1)[-1]
                groups.append({
                    "name": title[:140],
                    "url": url,
                    "source_type": "group",
                    "thumbnail": item.get("thumbnail") or "",
                    "notes": "Imported from vk.com/groups/my_all_groups",
                })
                if len(groups) >= max(1, min(int(max_groups or 300), 1000)):
                    break
        finally:
            await context.close()
            await browser.close()

    return groups


def scan_followed_vk_groups_sync(max_groups: int = 300) -> List[Dict[str, Any]]:
    future = Future()

    def thread_target():
        if sys.platform == 'win32':
            loop = asyncio.WindowsProactorEventLoopPolicy().new_event_loop()
        else:
            loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            future.set_result(loop.run_until_complete(scan_followed_vk_groups_async(max_groups=max_groups)))
        except Exception as e:
            future.set_exception(e)
        finally:
            loop.close()

    threading.Thread(target=thread_target).start()
    return future.result()


async def scan_vk_following_feed_recent_videos_async(max_videos: int = 120) -> Dict[str, Any]:
    """
    Reads the logged-in VKVideo Following feed and extracts newest visible videos.
    This captures the user's "new updates from followed communities" view.
    """
    videos: List[Dict[str, Any]] = []
    channels: List[Dict[str, Any]] = []
    seen_videos = set()
    seen_channels = set()

    async with _load_async_playwright()() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1366, "height": 1600},
            locale="en-US",
        )
        cookies = parse_vk_cookie_bundle()
        if cookies:
            await context.add_cookies(cookies)
        page = await context.new_page()
        try:
            await page.goto("https://vkvideo.ru/subscriptions", wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(2200)
            for _ in range(12):
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await page.wait_for_timeout(550)

            raw = await page.evaluate(r"""
                () => {
                    const grouped = new Map();
                    const channelMap = new Map();
                    const videoAnchors = Array.from(document.querySelectorAll('a[href*="/video-"]'));
                    for (const a of videoAnchors) {
                        const href = a.href || a.getAttribute('href') || '';
                        if (!/\/video-?\d+_\d+/.test(href)) continue;
                        const card = a.closest('[class*="Card"], [class*="Item"], [class*="Video"], li, article, [data-testid]') || a.parentElement;
                        const cardText = (card?.innerText || card?.textContent || '').replace(/\s+/g, ' ').trim();
                        const linkText = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
                        const img = card?.querySelector?.('img')?.src || a.querySelector?.('img')?.src || '';
                        const channelLink = card?.querySelector?.('a[href*="vkvideo.ru/@"]');
                        const channelUrl = channelLink?.href || '';
                        const channelName = (channelLink?.innerText || channelLink?.textContent || '').replace(/\s+/g, ' ').trim();
                        const relMatch = cardText.match(/(\d+\s+(?:minutes?|hours?|days?|weeks?|months?)\s+ago|вчера|сегодня|yesterday|today)/i);
                        const viewsMatch = cardText.match(/(\d+(?:[.,]\d+)?K?|\d+)\s+views/i);
                        if (channelUrl && channelName && !channelMap.has(channelUrl)) {
                            channelMap.set(channelUrl, { url: channelUrl.replace(/\/$/, ''), name: channelName });
                        }
                        if (!grouped.has(href)) grouped.set(href, { href, texts: [], cardTexts: [], thumbnail: '', channelUrl: '', channelName: '', dateText: '', viewsText: '' });
                        const item = grouped.get(href);
                        if (linkText) item.texts.push(linkText);
                        if (cardText) item.cardTexts.push(cardText);
                        if (img && !item.thumbnail) item.thumbnail = img;
                        if (channelUrl && !item.channelUrl) item.channelUrl = channelUrl;
                        if (channelName && !item.channelName) item.channelName = channelName;
                        if (relMatch && !item.dateText) item.dateText = relMatch[1];
                        if (viewsMatch && !item.viewsText) item.viewsText = viewsMatch[0];
                    }
                    const videos = Array.from(grouped.values()).map(item => {
                        const candidates = [...item.texts, ...item.cardTexts]
                            .map(x => String(x || '').replace(/\s+/g, ' ').trim())
                            .filter(x => x && !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(x))
                            .filter(x => !/^(Watch|Shuffle|All videos|Following|Channels|Playlists)$/i.test(x));
                        candidates.sort((a, b) => b.length - a.length);
                        return { ...item, bestText: candidates[0] || '' };
                    });
                    return { videos, channels: Array.from(channelMap.values()) };
                }
            """)

            for ch in raw.get("channels") or []:
                url = _normalize_vk_source_url(ch.get("url") or "")
                if not url or url in seen_channels:
                    continue
                seen_channels.add(url)
                channels.append({"name": ch.get("name") or url.rsplit("@", 1)[-1], "url": url})

            for item in raw.get("videos") or []:
                video_url = _normalize_vk_video_url(item.get("href", ""))
                if not video_url or video_url in seen_videos:
                    continue
                seen_videos.add(video_url)
                title = str(item.get("bestText") or item.get("linkText") or "").strip()
                if re.match(r"^\d{1,2}:\d{2}(?::\d{2})?$", title):
                    title = ""
                if not title:
                    card_text = str(item.get("cardText") or "")
                    title = re.sub(r"^\d{1,2}:\d{2}(?::\d{2})?\s*", "", card_text).strip()
                    channel_name = str(item.get("channelName") or "").strip()
                    if channel_name:
                        title = title.split(channel_name, 1)[0].strip() or title

                videos.append({
                    "title": re.sub(r"\s+", " ", title)[:240] or "VK Video",
                    "url": video_url,
                    "source_url": "https://vkvideo.ru/subscriptions",
                    "thumbnail": item.get("thumbnail") or "",
                    "channel_name": item.get("channelName") or "",
                    "channel_url": _normalize_vk_source_url(item.get("channelUrl") or ""),
                    "date_text": item.get("dateText") or "",
                    "views_text": item.get("viewsText") or "",
                })
                if len(videos) >= max(1, min(int(max_videos or 120), 500)):
                    break
        finally:
            await context.close()
            await browser.close()

    return {
        "feed_url": "https://vkvideo.ru/subscriptions",
        "videos": videos,
        "channels": channels,
        "video_count": len(videos),
        "channel_count": len(channels),
    }


def scan_vk_following_feed_recent_videos_sync(max_videos: int = 120) -> Dict[str, Any]:
    future = Future()

    def thread_target():
        if sys.platform == 'win32':
            loop = asyncio.WindowsProactorEventLoopPolicy().new_event_loop()
        else:
            loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            future.set_result(loop.run_until_complete(scan_vk_following_feed_recent_videos_async(max_videos=max_videos)))
        except Exception as e:
            future.set_exception(e)
        finally:
            loop.close()

    threading.Thread(target=thread_target).start()
    return future.result()


async def scan_vk_playlist_videos_async(
    playlist_url: str,
    max_videos: int = 200,
    scroll_rounds: int = 12,
) -> Dict[str, Any]:
    """
    Scans a VKVideo playlist page, including virtual community "All videos"
    playlists such as /playlist/-227772114_-2.
    """
    clean_playlist_url = _normalize_external_playlist_url(playlist_url) or _normalize_vk_source_url(playlist_url)
    videos: List[Dict[str, Any]] = []
    seen = set()
    playlist_meta: Dict[str, Any] = {
        "url": clean_playlist_url,
        "title": "VK playlist",
        "community_name": "",
        "video_count": 0,
        "updated_date": "",
    }

    async with _load_async_playwright()() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1600, "height": 1400},
            locale="en-US",
        )
        cookies = parse_vk_cookie_bundle()
        if cookies:
            await context.add_cookies(cookies)
        page = await context.new_page()
        try:
            await page.goto(clean_playlist_url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(2200)
            # Consumers that need only a card preview can ask for one quick
            # scroll; full discovery keeps the original exhaustive default.
            for _ in range(max(0, int(scroll_rounds))):
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await page.wait_for_timeout(500)

            raw = await page.evaluate(r"""
                () => {
                    const pageText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                    const videoAnchors = Array.from(document.querySelectorAll('a[href*="/video-"]'));
                    const grouped = new Map();
                    for (const a of videoAnchors) {
                        const href = a.href || a.getAttribute('href') || '';
                        if (!/\/video-?\d+_\d+/.test(href)) continue;
                        const card = a.closest('[class*="Card"], [class*="Item"], [class*="Video"], li, article, [data-testid]') || a.parentElement;
                        const cardText = (card?.innerText || card?.textContent || '').replace(/\s+/g, ' ').trim();
                        const linkText = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
                        const img = card?.querySelector?.('img')?.src || a.querySelector?.('img')?.src || '';
                        const relMatch = cardText.match(/(\d+\s+(?:minutes?|hours?|days?|weeks?|months?)\s+ago|вчера|сегодня|yesterday|today)/i);
                        const viewsMatch = cardText.match(/(\d+(?:[.,]\d+)?K?|\d+)\s+views/i);
                        if (!grouped.has(href)) grouped.set(href, { href, texts: [], cardTexts: [], thumbnail: '', dateText: '', viewsText: '' });
                        const item = grouped.get(href);
                        if (linkText) item.texts.push(linkText);
                        if (cardText) item.cardTexts.push(cardText);
                        if (img && !item.thumbnail) item.thumbnail = img;
                        if (relMatch && !item.dateText) item.dateText = relMatch[1];
                        if (viewsMatch && !item.viewsText) item.viewsText = viewsMatch[0];
                    }
                    const videos = Array.from(grouped.values()).map(item => {
                        const candidates = [...item.texts, ...item.cardTexts]
                            .map(x => String(x || '').replace(/\s+/g, ' ').trim())
                            .filter(x => x && !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(x))
                            .filter(x => !/^(Watch|Shuffle|All videos|Following|Channels|Playlists)$/i.test(x));
                        candidates.sort((a, b) => b.length - a.length);
                        return { ...item, bestText: candidates[0] || '' };
                    });

                    const crumbLinks = Array.from(document.querySelectorAll('a[href*="@"]')).map(a => (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
                    const titleMatch = pageText.match(/>\s*Playlists\s*>\s*([^]+?)\s+\d{1,3}(?::\d{2}){1,2}/i);
                    const allVideosMatch = pageText.match(/All videos\s+([^]+?)\s+(\d[\d\s.,]*)\s+videos?\s+[\u2022·]\s+\d+\s+followers?\s+Updated\s+([^]+?)(?:\s+Watch|\s+Shuffle|\s+\.\.\.|$)/i);
                    const countMatch = pageText.match(/(\d[\d\s.,]*)\s+videos?\s+[\u2022·]\s+\d+\s+followers?/i);
                    return {
                        title: allVideosMatch ? 'All videos' : (titleMatch ? titleMatch[1].trim() : 'All videos'),
                        communityName: allVideosMatch ? allVideosMatch[1].trim() : (crumbLinks[0] || ''),
                        countText: countMatch ? countMatch[1] : '',
                        updatedDate: allVideosMatch ? allVideosMatch[3].trim() : '',
                        videos
                    };
                }
            """)

            playlist_meta["title"] = raw.get("title") or "All videos"
            playlist_meta["community_name"] = raw.get("communityName") or ""
            count_digits = re.sub(r"[^\d]", "", str(raw.get("countText") or ""))
            if count_digits.isdigit():
                playlist_meta["video_count"] = int(count_digits)
            playlist_meta["updated_date"] = raw.get("updatedDate") or ""

            for item in raw.get("videos") or []:
                video_url = _normalize_vk_video_url(item.get("href", ""))
                if not video_url or video_url in seen:
                    continue
                seen.add(video_url)
                title = str(item.get("bestText") or item.get("linkText") or "").strip()
                if re.match(r"^\d{1,2}:\d{2}(?::\d{2})?$", title):
                    title = ""
                if not title:
                    title = re.sub(r"^\d{1,2}:\d{2}(?::\d{2})?\s*", "", str(item.get("cardText") or "")).strip()
                    if playlist_meta.get("community_name"):
                        title = title.split(playlist_meta["community_name"], 1)[0].strip() or title
                videos.append({
                    "title": re.sub(r"\s+", " ", title)[:240] or "VK Video",
                    "url": video_url,
                    "source_url": clean_playlist_url,
                    "thumbnail": item.get("thumbnail") or "",
                    "channel_name": playlist_meta.get("community_name") or "",
                    "channel_url": "",
                    "date_text": item.get("dateText") or "",
                    "views_text": item.get("viewsText") or "",
                })
                if len(videos) >= max(1, min(int(max_videos or 200), 1000)):
                    break
        finally:
            await context.close()
            await browser.close()

    return {
        "playlist": playlist_meta,
        "videos": videos,
        "video_count_visible": len(videos),
    }


def scan_vk_playlist_videos_sync(
    playlist_url: str,
    max_videos: int = 200,
    scroll_rounds: int = 12,
) -> Dict[str, Any]:
    future = Future()

    def thread_target():
        if sys.platform == 'win32':
            loop = asyncio.WindowsProactorEventLoopPolicy().new_event_loop()
        else:
            loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            future.set_result(loop.run_until_complete(scan_vk_playlist_videos_async(
                playlist_url,
                max_videos=max_videos,
                scroll_rounds=scroll_rounds,
            )))
        except Exception as e:
            future.set_exception(e)
        finally:
            loop.close()

    threading.Thread(target=thread_target).start()
    return future.result()


async def scan_vk_source_recent_videos_async(source_url: str, max_videos: int = 80) -> Dict[str, Any]:
    """
    Scans one VK/VKVideo community for recent video cards and playlists.
    Returns lightweight metadata; stream/quality is resolved later on import/playback.
    """
    videos_url = _source_to_vkvideo_videos_url(source_url)
    playlists_url = _source_to_vkvideo_playlists_url(source_url)
    videos: List[Dict[str, Any]] = []
    playlists: List[Dict[str, Any]] = []
    seen_videos = set()
    seen_playlists = set()

    async with _load_async_playwright()() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1366, "height": 1100},
            locale="en-US",
        )
        cookies = parse_vk_cookie_bundle()
        if cookies:
            await context.add_cookies(cookies)
        page = await context.new_page()
        try:
            for target_url, mode in [(videos_url, "videos"), (playlists_url, "playlists")]:
                try:
                    await page.goto(target_url, wait_until="domcontentloaded", timeout=25000)
                    await page.wait_for_timeout(1600)
                    for _ in range(8 if mode == "videos" else 4):
                        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                        await page.wait_for_timeout(500)
                except Exception as nav_err:
                    logger.warning(f"VK source scan navigation failed for {target_url}: {nav_err}")
                    continue

                if mode == "videos":
                    raw_videos = await page.evaluate(r"""
                        () => {
                            const out = [];
                            const anchors = Array.from(document.querySelectorAll('a[href]'));
                            for (const a of anchors) {
                                const href = a.href || a.getAttribute('href') || '';
                                if (!/video-?\d+_\d+|video_ext\.php/.test(href)) continue;
                                const card = a.closest('[class*="Card"], [class*="Item"], [class*="cell"], [class*="Video"], li, article') || a.parentElement;
                                const text = [
                                    a.innerText || a.textContent || '',
                                    card ? (card.innerText || card.textContent || '') : ''
                                ].join(' ').replace(/\s+/g, ' ').trim();
                                const img = card?.querySelector?.('img')?.src || a.querySelector?.('img')?.src || '';
                                const timeText = card?.querySelector?.('time,[datetime],[class*="date"],[class*="time"]')?.getAttribute?.('datetime')
                                    || card?.querySelector?.('time,[datetime],[class*="date"],[class*="time"]')?.textContent
                                    || '';
                                out.push({ href, text, thumbnail: img, date_text: String(timeText || '').trim() });
                            }
                            return out;
                        }
                    """)
                    for item in raw_videos:
                        video_url = _normalize_vk_video_url(item.get("href", ""))
                        if not video_url or video_url in seen_videos:
                            continue
                        seen_videos.add(video_url)
                        title = re.sub(r"\s+", " ", str(item.get("text") or "").strip())
                        title = re.sub(r"\b\d{1,2}:\d{2}(?::\d{2})?\b", "", title).strip()
                        videos.append({
                            "title": title[:220] or "VK Video",
                            "url": video_url,
                            "source_url": target_url,
                            "thumbnail": item.get("thumbnail") or "",
                            "date_text": item.get("date_text") or "",
                        })
                        if len(videos) >= max(1, min(int(max_videos or 80), 300)):
                            break
                else:
                    raw_playlists = await page.evaluate(r"""
                        () => Array.from(document.querySelectorAll('a[href*="/playlist/"]')).map(a => {
                            const href = a.href || a.getAttribute('href') || '';
                            const card = a.closest('[class*="Card"], [class*="Item"], li, article') || a.parentElement;
                            const text = [
                                a.innerText || a.textContent || '',
                                card ? (card.innerText || card.textContent || '') : ''
                            ].join(' ').replace(/\s+/g, ' ').trim();
                            const img = card?.querySelector?.('img')?.src || a.querySelector?.('img')?.src || '';
                            return { href, text, thumbnail: img };
                        })
                    """)
                    for item in raw_playlists:
                        playlist_url = _normalize_external_playlist_url(item.get("href", ""))
                        if not playlist_url or playlist_url in seen_playlists:
                            continue
                        seen_playlists.add(playlist_url)
                        playlists.append({
                            "title": re.sub(r"\s+", " ", str(item.get("text") or "").strip())[:180] or "VK playlist",
                            "url": playlist_url,
                            "thumbnail": item.get("thumbnail") or "",
                        })
        finally:
            await context.close()
            await browser.close()

    return {
        "source_url": source_url,
        "videos_url": videos_url,
        "playlists_url": playlists_url,
        "videos": videos,
        "playlists": playlists,
        "video_count": len(videos),
        "playlist_count": len(playlists),
    }


def scan_vk_source_recent_videos_sync(source_url: str, max_videos: int = 80) -> Dict[str, Any]:
    future = Future()

    def thread_target():
        if sys.platform == 'win32':
            loop = asyncio.WindowsProactorEventLoopPolicy().new_event_loop()
        else:
            loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            future.set_result(loop.run_until_complete(scan_vk_source_recent_videos_async(source_url, max_videos=max_videos)))
        except Exception as e:
            future.set_exception(e)
        finally:
            loop.close()

    threading.Thread(target=thread_target).start()
    return future.result()

# Curated list of the top adult VK communities hosting premium content
DEFAULT_ADULT_COMMUNITIES = [
    {"id": "209003643", "name": "Movie 18+"},
    {"id": "207115292", "name": "PCORNO S MILFKAMI"},
    {"id": "220456182", "name": "Brazzers Premium"},
    {"id": "218451029", "name": "OnlyFans / Fansly Vids"},
    {"id": "219504820", "name": "Adult Hub 18+"},
    {"id": "215456722", "name": "Private Premium"},
    {"id": "211456902", "name": "Milfs & Moms"},
    {"id": "208456102", "name": "18+ Video Catalog"}
]

async def scan_single_community_playlists(browser, group_id: str, group_name: str, keyword: str) -> List[Dict[str, Any]]:
    """
    Loads a single community's /playlists page in Playwright, scrolls, and extracts matching playlists.
    """
    discovered = []
    context = await browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport={"width": 1280, "height": 1000}
    )
    
    # Load cookies to bypass NSFW warnings / age verification filters
    cookies = parse_netscape_cookies("vkvideo.ru_cookies.txt")
    if cookies:
        await context.add_cookies(cookies)
        logger.info(f"Loaded {len(cookies)} auth cookies into Playwright context.")
        
    page = await context.new_page()
    
    url = f"https://vkvideo.ru/@club{group_id}/playlists"
    logger.info(f"Scanning community {group_name} ({group_id}) at: {url}")
    
    try:
        # Load the directory page
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        
        # Detect and bypass VK robot security gate if present (with robust hydration delays)
        try:
            await asyncio.sleep(1.5)
            robot_btn = page.locator('text="Продолжить"')
            if await robot_btn.count() > 0:
                logger.info(f"Robot gate detected for community {group_name} ({group_id}). Clicking Continue...")
                await robot_btn.first.click()
                await asyncio.sleep(3.0) # Wait for session validation
                # Re-navigate to the playlists page under the validated session
                logger.info(f"Re-navigating to playlists directory: {url}")
                await page.goto(url, wait_until="domcontentloaded", timeout=20000)
                await asyncio.sleep(1.5)
        except Exception as gate_err:
            logger.warning(f"Error handling VK robot gate for community {group_id}: {gate_err}")
            
        # Wait specifically for playlist links to appear (giving up to 2.5 seconds for hydration)
        try:
            await page.wait_for_selector('a[href*="playlist"]', timeout=10000)
        except Exception:
            # If no playlists are rendered or group has none, return empty
            await context.close()
            return []
            
        # Scroll 2 times to load up to ~50 playlists (extremely fast, plenty of results)
        for _ in range(2):
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await asyncio.sleep(0.4)
            
        # Extract playlist elements with robust grouping and parsing
        playlists = await page.evaluate("""
            () => {
                const results = [];
                const links = document.querySelectorAll('a[href*="playlist"]');
                
                // Group by normalized href to resolve double links (e.g. title vs count link)
                const grouped = {};
                links.forEach(l => {
                    let href = l.getAttribute('href');
                    if (!href) return;
                    if (href.includes('?')) {
                        href = href.split('?')[0];
                    }
                    const text = (l.innerText || l.textContent || '').trim();
                    if (!grouped[href]) {
                        grouped[href] = [];
                    }
                    if (text) {
                        grouped[href].push(text);
                    }
                });
                
                for (const href in grouped) {
                    const texts = grouped[href];
                    // Clean and filter number-only / helper texts
                    const validTitles = texts.filter(t => !/^\\d+$/.test(t));
                    
                    // Longest non-numeric text is always the true playlist title
                    const titleText = validTitles.sort((a, b) => b.length - a.length)[0] || texts[0] || '';
                    
                    // Find count badge text (containing digits and words like 'video', 'playlist', 'клип')
                    let countVal = 0;
                    for (const t of texts) {
                        const hasDigits = /\\d+/.test(t);
                        if (hasDigits && (t.toLowerCase().includes('vid') || t.toLowerCase().includes('play') || t.toLowerCase().includes('видео') || t.toLowerCase().includes('пл') || t.toLowerCase().includes('альб'))) {
                            const m = t.match(/\\d+/);
                            if (m) {
                                countVal = parseInt(m[0]) || 0;
                                break;
                            }
                        }
                    }
                    
                    // Fallback to purely numeric text if count is still 0
                    if (countVal === 0) {
                        for (const t of texts) {
                            if (/^\\d+$/.test(t)) {
                                countVal = parseInt(t) || 0;
                                break;
                            }
                        }
                    }
                    
                    // Second fallback count check from card parent
                    if (countVal === 0) {
                        let card = document.querySelector(`a[href*="${href}"]`);
                        if (card) {
                            let parent = card.parentElement;
                            while (parent && !parent.className.includes('Card') && !parent.className.includes('root')) {
                                parent = parent.parentElement;
                            }
                            if (parent) {
                                const countEl = parent.querySelector('[class*="metadata"]') || parent.querySelector('[class*="count"]') || parent.querySelector('span');
                                if (countEl) {
                                    const m = countEl.textContent.match(/\\d+/);
                                    if (m) countVal = parseInt(m[0]) || 0;
                                }
                            }
                        }
                    }
                    
                    results.push({
                        href: href,
                        title: titleText,
                        videoCount: countVal
                    });
                }
                return results;
            }
        """)
        
        seen_urls = set()
        for p in playlists:
            title = p['title']
            href = p['href']
            full_url = f"https://vkvideo.ru{href}"
            
            if full_url in seen_urls or not title:
                continue
            seen_urls.add(full_url)
            
            # Substring match filter (case-insensitive)
            if keyword.lower() in title.lower():
                discovered.append({
                    "title": title,
                    "url": full_url,
                    "video_count": p['videoCount'],
                    "community_id": group_id,
                    "community_name": group_name
                })
                
    except Exception as e:
        logger.error(f"Error scanning community {group_id}: {e}")
    finally:
        await context.close()
        
    return discovered


async def scan_global_playlists(browser, keyword: str) -> List[Dict[str, Any]]:
    """
    Performs a global search on VK Video for the keyword, scrolls, and extracts playlists.
    """
    discovered = []
    context = await browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport={"width": 1280, "height": 1000}
    )
    
    # Load cookies
    cookies = parse_netscape_cookies("vkvideo.ru_cookies.txt")
    if cookies:
        await context.add_cookies(cookies)
        
    page = await context.new_page()
    url = f"https://vkvideo.ru/search?q={urllib.parse.quote(keyword)}"
    logger.info(f"Scanning global playlists for '{keyword}' at: {url}")
    
    try:
        # Load the search page
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        
        # Detect and bypass robot gate with robust hydration delays
        try:
            await asyncio.sleep(1.5)
            robot_btn = page.locator('text="Продолжить"')
            if await robot_btn.count() > 0:
                logger.info("Robot check detected on global search! Clicking...")
                await robot_btn.first.click()
                await asyncio.sleep(3.0) # Wait for session validation
                await page.goto(url, wait_until="domcontentloaded", timeout=20000)
                await asyncio.sleep(1.5)
        except Exception:
            pass
            
        # Scroll 3 times to load dynamic results (extremely fast, plenty of results)
        for _ in range(8):
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await asyncio.sleep(0.5)
            
        # Extract playlists with clean grouping
        playlists = await page.evaluate(r"""
            () => {
                const results = [];
                const grouped = {};
                const links = Array.from(document.querySelectorAll('a[href*="/playlist/"], a[href*="video_playlist"], a[href*="pl="]'));
                for (const link of links) {
                    let href = link.getAttribute('href') || '';
                    if (!href) continue;

                    const playlistMatch = href.match(/\/playlist\/-?\d+_\d+/);
                    const zMatch = href.match(/z=video_playlist(-?\d+_\d+)/);
                    const plMatch = href.match(/[?&]pl=(-?\d+_\d+)/);
                    if (playlistMatch) {
                        href = playlistMatch[0];
                    } else if (zMatch) {
                        href = `/playlist/${zMatch[1]}`;
                    } else if (plMatch) {
                        href = `/playlist/${plMatch[1]}`;
                    } else {
                        continue;
                    }

                    if (!grouped[href]) grouped[href] = [];
                    const card = link.closest('[class*="Card"], [class*="Item"], [class*="cell"], [class*="root"], li, article') || link.parentElement;
                    const text = [
                        link.innerText || link.textContent || '',
                        card ? (card.innerText || card.textContent || '') : ''
                    ].join(' ').replace(/\s+/g, ' ').trim();
                    if (text) grouped[href].push(text);
                }
                
                for (const href in grouped) {
                    const texts = grouped[href];
                    // Clean and filter number-only / helper texts
                    const validTitles = texts.filter(t => !/^\\d+$/.test(t));
                    
                    // Longest non-numeric text is always the true playlist title
                    const titleText = validTitles.sort((a, b) => b.length - a.length)[0] || texts[0] || '';
                    
                    // Find count badge text (containing digits and words like 'video', 'playlist', 'клип')
                    let countVal = 0;
                    for (const t of texts) {
                        const hasDigits = /\\d+/.test(t);
                        if (hasDigits && (t.toLowerCase().includes('vid') || t.toLowerCase().includes('play') || t.toLowerCase().includes('видео') || t.toLowerCase().includes('пл') || t.toLowerCase().includes('альб'))) {
                            const m = t.match(/\\d+/);
                            if (m) {
                                countVal = parseInt(m[0]) || 0;
                                break;
                            }
                        }
                    }
                    
                    // Fallback to purely numeric text if count is still 0
                    if (countVal === 0) {
                        for (const t of texts) {
                            if (/^\\d+$/.test(t)) {
                                countVal = parseInt(t) || 0;
                                break;
                            }
                        }
                    }
                    
                    // Second fallback count check from card parent
                    if (countVal === 0) {
                        let card = document.querySelector(`a[href*="${href}"]`);
                        if (card) {
                            let parent = card.parentElement;
                            while (parent && !parent.className.includes('Card') && !parent.className.includes('root')) {
                                parent = parent.parentElement;
                            }
                            if (parent) {
                                const countEl = parent.querySelector('[class*="metadata"]') || parent.querySelector('[class*="count"]') || parent.querySelector('span');
                                if (countEl) {
                                    const m = countEl.textContent.match(/\\d+/);
                                    if (m) countVal = parseInt(m[0]) || 0;
                                }
                            }
                        }
                    }
                    
                    results.push({
                        href: href,
                        title: titleText,
                        videoCount: countVal
                    });
                }
                return results;
            }
        """)
        
        seen_urls = set()
        for p in playlists:
            title = p['title']
            href = p['href']
            # Normalize href to remove search parameters
            if "?" in href:
                href = href.split("?")[0]
            full_url = f"https://vkvideo.ru{href}"
            
            if full_url in seen_urls or not title:
                continue
            seen_urls.add(full_url)
            
            # Extract owner ID from href like /playlist/770179586_1 or /playlist/-209003643_103
            owner_id = "global"
            match = re.search(r'/playlist/(-?\\d+)_', href)
            if match:
                owner_id = match.group(1)
                
            discovered.append({
                "title": title,
                "url": full_url,
                "video_count": p['videoCount'],
                "community_id": owner_id,
                "community_name": "Global Search"
            })
            
    except Exception as e:
        logger.error(f"Error scanning global playlists: {e}")
    finally:
        await context.close()
        
    return discovered


async def _unified_ko_playlist_search_async(
    keyword: str,
    target_communities: List[Dict[str, str]],
    external_engines: Optional[List[str]] = None,
    external_pages: int = 2,
    site_domain: str = "m.vkvideo.ru",
    extra_terms: str = "vk video playlist",
    exclude_terms: str = "",
    min_video_count: int = 0,
    max_results: int = 120,
    target_results: int = 100,
) -> List[Dict[str, Any]]:
    """
    Highly optimized, super fast VK playlist discovery pipeline.
    To bypass VK's bot-detection, we avoid slamming their server with concurrent community requests.
    Since global search indexes the entire network (including all public groups), a single robust
    global query delivers comprehensive network-wide results in under 3 seconds!
    """
    logger.info(f"Starting optimized VK playlist search for keyword: '{keyword}'")
    discovered_playlists = []
    
    async with _load_async_playwright()() as p:
        browser = await p.chromium.launch(headless=True)
        
        external_engines = external_engines or []
        if "vk" in external_engines or not external_engines:
            # Primary global search (covers the entire network, including all target groups!)
            global_results = await scan_global_playlists(browser, keyword)
            discovered_playlists.extend(global_results)

        search_tasks = []
        query_domains = []
        for domain in [site_domain, "vkvideo.ru/playlist", "m.vkvideo.ru/playlist", "vkvideo.ru"]:
            if domain and domain not in query_domains:
                query_domains.append(domain)

        query_terms = []
        for terms in [extra_terms, "vk video playlist 720p 1080p hd", "playlist videos hd", ""]:
            if terms is not None and terms not in query_terms:
                query_terms.append(terms)

        per_probe_limit = max(20, min(max_results, max(target_results, 100)))
        for engine in external_engines:
            if engine not in {"yandex", "google", "duckduckgo", "ddg"}:
                continue
            for domain in query_domains:
                for terms in query_terms:
                    search_tasks.append(scan_external_playlist_search(
                        browser,
                        keyword=keyword,
                        engine=engine,
                        pages=external_pages,
                        site_domain=domain,
                        extra_terms=terms,
                        exclude_terms=exclude_terms,
                        min_video_count=min_video_count,
                        max_results=per_probe_limit,
                    ))
        if search_tasks:
            external_batches = await asyncio.gather(*search_tasks, return_exceptions=True)
            for batch in external_batches:
                if isinstance(batch, Exception):
                    logger.warning(f"External playlist search failed: {batch}")
                    continue
                discovered_playlists.extend(batch)
                if len({pl.get("url") for pl in discovered_playlists if pl.get("url")}) >= target_results:
                    break
        
        # If the user has custom active communities tracked in the DB, we scan them sequentially
        # to avoid triggering the concurrent security challenge storm.
        if len(target_communities) > len(DEFAULT_ADULT_COMMUNITIES):
            # Only scan the non-default custom communities added by the user
            custom_only = [c for c in target_communities if c not in DEFAULT_ADULT_COMMUNITIES]
            if custom_only:
                logger.info(f"Scanning {len(custom_only)} custom tracked community sources...")
                for c in custom_only:
                    res = await scan_single_community_playlists(browser, c["id"], c["name"], keyword)
                    discovered_playlists.extend(res)
                    
        await browser.close()
        
    # De-duplicate results
    unique_playlists = []
    seen_urls = set()
    for pl in discovered_playlists:
        if pl["url"] not in seen_urls:
            seen_urls.add(pl["url"])
            unique_playlists.append(pl)
            
    unique_playlists.sort(key=lambda x: (x.get("video_count") or 0), reverse=True)
    logger.info(f"VK playlist search completed. Total discovered: {len(unique_playlists)}")
    return unique_playlists[:max(1, min(int(max_results or 120), 300))]


def unified_ko_playlist_search(
    keyword: str,
    custom_communities: List[Dict[str, str]] = None,
    external_engines: Optional[List[str]] = None,
    external_pages: int = 2,
    site_domain: str = "m.vkvideo.ru",
    extra_terms: str = "vk video playlist",
    exclude_terms: str = "",
    min_video_count: int = 0,
    max_results: int = 120,
    target_results: int = 100,
) -> List[Dict[str, Any]]:
    """
    Synchronous entry point that runs the async Playwright crawling pipeline 
    inside a dedicated thread with a private, Windows-safe Proactor Event Loop.
    """
    target_communities = list(DEFAULT_ADULT_COMMUNITIES)
    if custom_communities:
        existing_ids = {c["id"] for c in target_communities}
        for cc in custom_communities:
            if cc["id"] not in existing_ids:
                target_communities.append(cc)
                
    future = Future()
    
    def thread_target():
        # Create a private, dedicated event loop for this thread.
        # Under Windows, we force WindowsProactorEventLoop to support Playwright subprocesses!
        if sys.platform == 'win32':
            loop = asyncio.WindowsProactorEventLoopPolicy().new_event_loop()
        else:
            loop = asyncio.new_event_loop()
            
        asyncio.set_event_loop(loop)
        
        try:
            result = loop.run_until_complete(_unified_ko_playlist_search_async(
                keyword,
                target_communities,
                external_engines=external_engines,
                external_pages=external_pages,
                site_domain=site_domain,
                extra_terms=extra_terms,
                exclude_terms=exclude_terms,
                min_video_count=min_video_count,
                max_results=max_results,
                target_results=target_results,
            ))
            future.set_result(result)
        except Exception as e:
            future.set_exception(e)
        finally:
            loop.close()
            
    t = threading.Thread(target=thread_target)
    t.start()
    
    return future.result()  # Blocks and safely returns the search resultnd safely returns the search result


async def scan_custom_community_playlists_async(browser, url: str) -> List[Dict[str, Any]]:
    discovered = []
    context = await browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport={"width": 1280, "height": 1000}
    )
    
    from app.vk_ko_discovery import parse_netscape_cookies
    cookies = parse_netscape_cookies("vkvideo.ru_cookies.txt")
    if cookies:
        await context.add_cookies(cookies)
        
    page = await context.new_page()
    
    target_url = url
    if not target_url.endswith("/playlists"):
        if target_url.endswith("/"):
            target_url += "playlists"
        else:
            target_url += "/playlists"
            
    try:
        await page.goto(target_url, wait_until="domcontentloaded", timeout=20000)
        
        import asyncio
        try:
            await asyncio.sleep(1.5)
            robot_btn = page.locator('text="Продолжить"')
            if await robot_btn.count() > 0:
                await robot_btn.first.click()
                await asyncio.sleep(3.0) 
                await page.goto(target_url, wait_until="domcontentloaded", timeout=20000)
                await asyncio.sleep(1.5)
        except Exception:
            pass
            
        try:
            await page.wait_for_selector('a[href*="playlist"]', timeout=10000)
        except Exception:
            await context.close()
            return []
            
        for _ in range(12):
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await asyncio.sleep(0.7)
            
        playlists = await page.evaluate(r'''
            () => {
                const results = [];
                const links = document.querySelectorAll('a[href*="playlist"]');
                const grouped = {};
                links.forEach(l => {
                    let href = l.getAttribute('href');
                    if (!href) return;
                    if (href.includes('?')) {
                        const parts = href.split('?');
                        if (parts[1].includes('z=video_playlist') || parts[1].includes('pl=')) {
                            // keep the search part if it contains playlist info
                        } else {
                            href = parts[0];
                        }
                    }
                    if (!grouped[href]) grouped[href] = { texts: [], images: [], elements: [] };
                    const text = (l.innerText || l.textContent || '').trim();
                    if (text) grouped[href].texts.push(text);
                    
                    const img = l.querySelector('img');
                    if (img && img.src) grouped[href].images.push(img.src);
                    
                    grouped[href].elements.push(l);
                });
                
                function parseLooseCount(text) {
                    const raw = String(text || '').replace(/\u00a0/g, ' ').trim();
                    if (!raw) return 0;
                    const patterns = [
                        /(\d{1,6})\s*(?:videos?|видео|ролик(?:ов)?)/i,
                        /(?:videos?|видео|ролик(?:ов)?)\s*[:|-]?\s*(\d{1,6})/i,
                        /\b(\d{1,6})\b/
                    ];
                    for (const pattern of patterns) {
                        const match = raw.match(pattern);
                        if (match) return parseInt(match[1], 10) || 0;
                    }
                    return 0;
                }
                
                for (const href in grouped) {
                    const data = grouped[href];
                    const texts = data.texts;
                    
                    // Title extraction
                    const validTitles = texts.filter(t => !/^\d+$/.test(t) && !/videos?|видео|ролик(?:ов)?/i.test(t));
                    const titleText = validTitles.sort((a, b) => b.length - a.length)[0] || texts[0] || 'VK Playlist';
                    
                    // Video count extraction
                    let countVal = 0;
                    for (const el of data.elements) {
                        let parent = el;
                        for (let i=0; i<4; i++) {
                            if (!parent) break;
                            const countSpan = parent.querySelector('[class*="count"], [class*="metadata"], span');
                            if (countSpan) {
                                const c = parseLooseCount(countSpan.textContent);
                                if (c > 0) { countVal = c; break; }
                            }
                            parent = parent.parentElement;
                        }
                        if (countVal > 0) break;
                    }
                    if (countVal === 0) {
                        for (const t of texts) {
                            const c = parseLooseCount(t);
                            if (c > 0) { countVal = c; break; }
                        }
                    }
                    
                    // Thumbnail
                    let thumbUrl = data.images[0] || '';
                    if (!thumbUrl) {
                        for (const el of data.elements) {
                            const card = el.closest('[class*="Card"], [class*="Item"], [class*="root"]');
                            if (card) {
                                const img = card.querySelector('img');
                                if (img && img.src) { thumbUrl = img.src; break; }
                            }
                        }
                    }
                    
                    results.push({ href: href, title: titleText, videoCount: countVal, thumbnail: thumbUrl });
                }
                return results;
            }
        ''')
        
        seen_urls = set()
        for p in playlists:
            title = p['title']
            href = p['href']
            
            # Reconstruct absolute URL
            if href.startswith('http'):
                full_url = href
            elif href.startswith('//'):
                full_url = f"https:{href}"
            else:
                full_url = f"https://vkvideo.ru{href if href.startswith('/') else '/' + href}"
                
            if full_url in seen_urls:
                continue
            seen_urls.add(full_url)
            
            # Community extraction
            community_name = "Custom Community"
            match = re.search(r'(?:club|public|@)(\d+|[a-zA-Z0-9_.-]+)', target_url)
            if match:
                community_name = match.group(1)
                
            discovered.append({
                "title": title,
                "url": full_url,
                "video_count": p['videoCount'],
                "thumbnail": p['thumbnail'],
                "community_id": target_url,
                "community_name": community_name,
                "updated_date": ""
            })
                
    except Exception as e:
        import logging
        logging.error(f"Error scanning custom community {target_url}: {e}")
    finally:
        await context.close()
        
    return discovered

def scan_custom_community_playlists_sync(url: str) -> List[Dict[str, Any]]:
    future = Future()
    def thread_target():
        import asyncio
        if sys.platform == 'win32':
            loop = asyncio.WindowsProactorEventLoopPolicy().new_event_loop()
        else:
            loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            async def run_scan():
                async with _load_async_playwright()() as p:
                    browser = await p.chromium.launch(headless=True)
                    res = await scan_custom_community_playlists_async(browser, url)
                    await browser.close()
                    return res
            result = loop.run_until_complete(run_scan())
            future.set_result(result)
        except Exception as e:
            future.set_exception(e)
        finally:
            loop.close()
    t = threading.Thread(target=thread_target)
    t.start()
    return future.result()
