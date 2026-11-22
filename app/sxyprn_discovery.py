"""
SxyPrn Discovery scraper.

Scrapes listing pages (latest/trending/search/tag/profile) and per-post
external-host links. Returns structured dicts ready for the discovery UI.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urljoin

import httpx

logger = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_HEADERS = {
    "User-Agent": _UA,
    "Referer": "https://sxyprn.com/",
    "Accept-Language": "en-US,en;q=0.9",
}

BASE = "https://sxyprn.com"

# Host priority: higher index = worse.  We pick the lowest index available.
HOST_PRIORITY = [
    "vidara.so",
    "vidara.to",
    "lulustream.com",
    "luluvid.com",
    "luluvdo.com",
    "luluvids.com",
    "lulu.stream",
    "lulust.com",
    "bunkr.si",
    "bunkr.la",
    "bunkr.black",
    "streamtape.com",
    "doodstream.com",
    "doodstream.co",
    "bysesukior.com",
    "dood.watch",
    "voe.sx",
    "filemoon.sx",
    "playmogo.com",
    "vidsonic.net",
    "uploadmall.com",
    "savefiles.com",
    "streamcash.to",
    "uploadg.com",
    "krakenfiles.com",
]

_POSTID_RE = re.compile(r"data-postid='([a-f0-9]+)'")
_AUTHOR_NAME_RE = re.compile(r"class='a_name'[^>]*>([^<]+)<")
_AUTHOR_BLOG_RE = re.compile(r"href='/blog/([^/']+)/")
_THUMB_RE = re.compile(r"<img[^>]+data-src='(//[^']+trafficdeposit\.com[^']+/(?:0\.webp|small\.jpg|0\.jpg))'")
_THUMB_FALLBACK_RE = re.compile(r"data-src='(//[^']+trafficdeposit\.com[^']+)'")
_VIDTHUMB_RE = re.compile(r"class='hvp_player'[^>]+src='(//[^']+vidthumb\.mp4)'")
_DURATION_RE = re.compile(r"class='duration_small'(?:[^>']|'[^']*')*>(\d{1,2}:\d{2}(?::\d{2})?)<")
_SHD_RE = re.compile(r"<span\s+class=['\"]shd_small['\"]([^>]*?)>([^<]*)</span>", re.IGNORECASE)
_SHD_TITLE_RE = re.compile(r"title=['\"]([^'\"]*)['\"]", re.IGNORECASE)
_BITRATE_RE = re.compile(r"bitrate:(\d+)", re.IGNORECASE)
_HEIGHT_ATTR_RE = re.compile(r"height:(\d+)", re.IGNORECASE)
_VIDEO_INFO_RE = re.compile(r"Video\s+Info\s*->\s*(.*?)</div>", re.IGNORECASE | re.DOTALL)
_SIZE_TEXT_RE = re.compile(r"size:\s*([\d.,]+)\s*(GB|MB|KB)\b", re.IGNORECASE)
_RESOLUTION_TEXT_RE = re.compile(r"resolution:\s*([A-Za-z0-9]+)", re.IGNORECASE)
_VINFO_BITRATE_RE = re.compile(r"bitrate:\s*(\d+)\s*kb/s", re.IGNORECASE)
_VINFO_DURATION_RE = re.compile(r"duration:\s*(\d{1,2}:\d{2}(?::\d{2})?)", re.IGNORECASE)
_HOSTS_RE = re.compile(r"class='extlink_icon extlink'>([^<]+)</a>")
_EXTLINK_HREF_RE = re.compile(
    r"href='(https?://[^']+)' target='_blank' rel='nofollow' title='[^']*' class='extlink_icon extlink'"
)
_HASHTAGS_RE = re.compile(r'label="([^"]+)"[^>]+href="/[^.]+\.html')
_TITLE_RE = re.compile(
    r"class='post_text'[^>]*>(.*?)</div>",
    re.DOTALL,
)
_EXT_URL_RE = re.compile(
    r"https?://(?:"
    r"vidara\.(?:so|to)|vidsonic\.net|vidfast\.co"
    r"|lulustream\.com|luluvid\.com|luluvdo\.com|luluvids\.com|lulu\.stream|lulust\.com"
    r"|bunkr\.[a-z]+|bunkrr?\.[a-z]+"
    r"|streamtape\.com"
    r"|doodstream\.(?:com|co)|dood\.(?:watch|to|so)|bysesukior\.com"
    r"|voe\.sx|filemoon\.sx|playmogo\.com|uploadmall\.com"
    r"|savefiles\.com|streamcash\.to|uploadg\.com|krakenfiles\.com"
    r")[^\s'\"<>]+",
    re.IGNORECASE,
)


def _host_rank(url: str) -> int:
    for i, h in enumerate(HOST_PRIORITY):
        if h in url:
            return i
    return 999


def _clean_title(raw: str) -> str:
    # strip HTML tags
    t = re.sub(r"<[^>]+>", " ", raw)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:200]


def _parse_duration_seconds(duration_str: str) -> int:
    """Convert 'MM:SS' or 'HH:MM:SS' into integer seconds."""
    if not duration_str:
        return 0
    parts = [p for p in duration_str.strip().split(":") if p.isdigit()]
    if len(parts) == 2:
        return int(parts[0]) * 60 + int(parts[1])
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    return 0


def _format_size_mb(size_mb: float) -> str:
    """Format megabytes into a compact human label ('470 MB', '1.25 GB')."""
    if not size_mb or size_mb <= 0:
        return ""
    if size_mb >= 1024.0:
        return f"{size_mb / 1024.0:.2f} GB"
    return f"{round(size_mb)} MB"


def _normalize_quality_info(label: str, height: int = 0) -> tuple[str, int]:
    """Normalize SxyPrn quality/resolution strings ('HD720', 'SD480', 'HD') into (badge, height)."""
    h = int(height or 0)
    if h >= 2160:
        return "4K", 2160
    if h > 0:
        return f"{h}p", h

    raw = (label or "").strip().upper()
    if not raw:
        return "", 0
    if "4K" in raw or "2160" in raw:
        return "4K", 2160
    m = re.search(r"(1440|1080|720|540|480|360|240)", raw)
    if m:
        parsed_h = int(m.group(1))
        return f"{parsed_h}p", parsed_h
    if "FHD" in raw:
        return "1080p", 1080
    if "HD" in raw:
        return "HD", 0
    if "SD" in raw:
        return "SD", 0
    return raw[:8], 0


def _estimate_size_mb(duration_sec: int, bitrate_kbps: int) -> float:
    """Estimate file size in MB from duration (s) and total bitrate (kbps)."""
    if duration_sec <= 0 or bitrate_kbps <= 0:
        return 0.0
    return round((duration_sec * bitrate_kbps * 1000.0) / 8.0 / (1024.0 * 1024.0), 1)


def _parse_shd_badge(html_fragment: str) -> tuple[str, int, int]:
    """Extract (quality_label, height, bitrate_kbps) from SxyPrn's shd_small badge."""
    m_shd = _SHD_RE.search(html_fragment)
    if not m_shd:
        return "", 0, 0
    attrs, text = m_shd.group(1), m_shd.group(2).strip()
    m_title = _SHD_TITLE_RE.search(attrs)
    title_attr = m_title.group(1) if m_title else ""
    m_br = _BITRATE_RE.search(title_attr)
    bitrate_kbps = int(m_br.group(1)) if m_br else 0
    m_h = _HEIGHT_ATTR_RE.search(title_attr)
    raw_height = int(m_h.group(1)) if m_h else 0
    quality, height = _normalize_quality_info(text, raw_height)
    return quality, height, bitrate_kbps


def _parse_video_info(html: str) -> Dict[str, Any]:
    """Parse SxyPrn's 'Video Info -> duration:... · resolution:... · bitrate:... · size:...' block."""
    info: Dict[str, Any] = {
        "duration": "",
        "duration_sec": 0,
        "quality": "",
        "height": 0,
        "bitrate_kbps": 0,
        "file_size_mb": 0.0,
        "size_label": "",
        "size_estimated": False,
    }

    m_vi = _VIDEO_INFO_RE.search(html)
    if m_vi:
        text = re.sub(r"<[^>]+>", "", m_vi.group(1))
        text = re.sub(r"\s+", " ", text).strip()

        m_dur = _VINFO_DURATION_RE.search(text)
        if m_dur:
            info["duration"] = m_dur.group(1).strip()
            info["duration_sec"] = _parse_duration_seconds(info["duration"])

        m_res = _RESOLUTION_TEXT_RE.search(text)
        if m_res:
            q, h = _normalize_quality_info(m_res.group(1))
            info["quality"] = q
            info["height"] = h

        m_br = _VINFO_BITRATE_RE.search(text)
        if m_br:
            info["bitrate_kbps"] = int(m_br.group(1))

        m_sz = _SIZE_TEXT_RE.search(text)
        if m_sz:
            val = float(m_sz.group(1).replace(",", "."))
            unit = m_sz.group(2).upper()
            if unit == "GB":
                val *= 1024.0
            elif unit == "KB":
                val /= 1024.0
            info["file_size_mb"] = round(val, 1)
            info["size_label"] = _format_size_mb(info["file_size_mb"])

    if not info["quality"]:
        q, h, br = _parse_shd_badge(html)
        if q:
            info["quality"] = q
            info["height"] = h
        if br and not info["bitrate_kbps"]:
            info["bitrate_kbps"] = br

    if info["file_size_mb"] <= 0 and info["duration_sec"] > 0 and info["bitrate_kbps"] > 0:
        est = _estimate_size_mb(info["duration_sec"], info["bitrate_kbps"])
        if est > 0:
            info["file_size_mb"] = est
            info["size_label"] = _format_size_mb(est)
            info["size_estimated"] = True

    return info


def _split_cards(html: str) -> List[str]:
    """Split full page HTML into per-card chunks using post_el_small anchors."""
    chunks = re.split(r"(?=<div class='post_el_small'>)", html)
    return [c for c in chunks if "data-postid='" in c]


def _parse_cards(html: str) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for card in _split_cards(html):
        m_pid = _POSTID_RE.search(card)
        if not m_pid:
            continue
        post_id = m_pid.group(1)
        # Trim card at the next post_el_small boundary so regexes don't bleed
        next_card = card.find("<div class='post_el_small'>", 10)
        if next_card > 0:
            card = card[:next_card]

        author = ""
        m_author = _AUTHOR_NAME_RE.search(card)
        if m_author:
            author = re.sub(r"<[^>]+>", "", m_author.group(1)).strip()

        author_id = ""
        m_blog = _AUTHOR_BLOG_RE.search(card)
        if m_blog:
            author_id = m_blog.group(1)

        thumbnail = ""
        m_thumb = _THUMB_RE.search(card) or _THUMB_FALLBACK_RE.search(card)
        if m_thumb:
            thumbnail = "https:" + m_thumb.group(1)

        vidthumb = ""
        m_vid = _VIDTHUMB_RE.search(card)
        if m_vid:
            vidthumb = "https:" + m_vid.group(1)

        duration = ""
        m_dur = _DURATION_RE.search(card)
        if m_dur:
            duration = m_dur.group(1).strip()
        duration_sec = _parse_duration_seconds(duration)

        quality, height, bitrate_kbps = _parse_shd_badge(card)
        file_size_mb = _estimate_size_mb(duration_sec, bitrate_kbps)
        size_label = _format_size_mb(file_size_mb)
        size_estimated = file_size_mb > 0

        hosts = _HOSTS_RE.findall(card)
        hashtags = list(dict.fromkeys(_HASHTAGS_RE.findall(card)))[:12]

        # Extract external URLs directly from listing (no per-post fetch needed)
        ext_hrefs = _EXTLINK_HREF_RE.findall(card)
        ext_hrefs_ranked = sorted(ext_hrefs, key=_host_rank) if ext_hrefs else []

        title_raw = ""
        m_title = _TITLE_RE.search(card)
        if m_title:
            title_raw = _clean_title(m_title.group(1))

        post_url = f"{BASE}/post/{post_id}.html"

        results.append(
            {
                "post_id": post_id,
                "post_url": post_url,
                "title": title_raw,
                "thumbnail": thumbnail,
                "vidthumb": vidthumb,
                "duration": duration,
                "duration_sec": duration_sec,
                "quality": quality,
                "height": height,
                "bitrate_kbps": bitrate_kbps,
                "file_size_mb": file_size_mb,
                "size_label": size_label,
                "size_estimated": size_estimated,
                "enriched": False,
                "author": author,
                "author_id": author_id,
                "hosts": hosts,
                "hashtags": hashtags,
                "stream_url": ext_hrefs_ranked[0] if ext_hrefs_ranked else None,
                "ext_urls": ext_hrefs_ranked,
                "best_host": _hostname(ext_hrefs_ranked[0]) if ext_hrefs_ranked else (hosts[0] if hosts else ""),
            }
        )
    return results


def _tag_url(slug: str, page: int) -> str:
    """SxyPrn tag/search pagination: page1=slug.html, page2=slug-2.html, ..."""
    base_slug = slug.strip().replace(" ", "-")
    path = f"{base_slug}.html" if page <= 1 else f"{base_slug}-{page}.html"
    return f"{BASE}/{path}?sm=latest"


def _listing_url(mode: str, query: str = "", tag: str = "", profile_id: str = "", page: int = 1) -> str:
    if mode == "search" and query:
        # sxyprn search.php returns "Nothing Found" — use tag URL instead
        return _tag_url(query, page)
    if mode == "tag" and tag:
        return _tag_url(tag, page)
    if mode == "profile" and profile_id:
        # Profile pagination: /blog/ID/0, /blog/ID/20, /blog/ID/40 ...
        offset = (page - 1) * 20
        return f"{BASE}/blog/{profile_id}/{offset}.html"
    if mode == "trending":
        return f"{BASE}/?sm=trending&p={page}"
    # default: latest
    return f"{BASE}/?sm=latest&p={page}"


def scrape_sxyprn_listing(
    mode: str = "latest",
    query: str = "",
    tag: str = "",
    profile_id: str = "",
    pages: int = 1,
) -> List[Dict[str, Any]]:
    """Synchronous listing scraper — run in thread pool from async code."""
    all_results: List[Dict[str, Any]] = []
    seen: set = set()

    for page in range(1, pages + 1):
        url = _listing_url(mode, query, tag, profile_id, page)
        try:
            with httpx.Client(headers=_HEADERS, timeout=15, follow_redirects=True) as client:
                resp = client.get(url)
                if resp.status_code != 200:
                    logger.warning("[SxyPrn] HTTP %s for %s", resp.status_code, url)
                    break
                html = resp.text
        except Exception as exc:
            logger.warning("[SxyPrn] fetch error: %s", exc)
            break

        # Detect sxyprn "Nothing Found" fallback — returns unrelated posts
        if "Nothing Found" in html and "search_results" in html:
            logger.info("[SxyPrn] Search returned 'Nothing Found' for URL %s", url)
            break
        cards = _parse_cards(html)
        if not cards:
            break
        for c in cards:
            if c["post_id"] not in seen:
                seen.add(c["post_id"])
                all_results.append(c)

    return all_results


def _post_candidate_urls(clean_id: str, post_url: Optional[str] = None) -> List[str]:
    urls_to_try = []
    if post_url:
        urls_to_try.append(post_url)
    base = "https://www.sxyprn.net" if (post_url and "sxyprn.net" in post_url.lower()) else BASE
    urls_to_try.extend([
        f"{base}/post/{clean_id}",
        f"{base}/post/{clean_id}.html",
        f"https://www.sxyprn.net/post/{clean_id}",
        f"https://sxyprn.com/post/{clean_id}.html",
    ])
    return list(dict.fromkeys(urls_to_try))


def _parse_post_detail(html: str, clean_id: str) -> Dict[str, Any]:
    """Parse external stream URLs and Video Info (resolution, size, bitrate, duration) from post HTML."""
    video_info = _parse_video_info(html)

    # Detail pages can contain recommendations with their own extlink_icon
    # anchors. Never accept mirrors found inside recommended video cards (post_el_small)
    # or by walking up into div.main_content.
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    target = clean_id.lower()
    urls: List[str] = []

    # 1. Author-provided links in post description and title
    # SxyPrn uploaders frequently place links in <textarea class='PostEditTA'> or <h1>
    ta = soup.find('textarea', class_='PostEditTA')
    if ta and ta.text:
        urls.extend(_EXT_URL_RE.findall(ta.text))

    h1 = soup.find('h1')
    if h1 and h1.text:
        urls.extend(_EXT_URL_RE.findall(h1.text))

    # Also check post text containers NOT inside recommended cards
    for pt in soup.find_all('div', class_='post_text'):
        if not pt.find_parent('div', class_='post_el_small'):
            urls.extend(_EXT_URL_RE.findall(pt.text))

    # 2. Look for explicit a.extlink elements belonging specifically to THIS post (never from recommended cards)
    markers = []
    for node in soup.find_all(True):
        attrs = node.attrs
        if any(
            str(value).lower() == target
            for key, value in attrs.items()
            if key in {"id", "data-postid", "data-post-id", "data-id"}
        ):
            markers.append(node)

    for marker in markers:
        # Never search inside recommended video cards
        if marker.find_parent('div', class_='post_el_small'):
            continue
        scope = marker
        for _ in range(3):
            if not scope or getattr(scope, 'name', '') in {"body", "html"}:
                break
            classes = scope.get("class", [])
            if any(c in classes for c in ["main_content", "posts_list", "post_el_small"]):
                break
            for a in scope.select("a.extlink_icon.extlink[href]"):
                if not a.find_parent('div', class_='post_el_small'):
                    href = a.get("href", "")
                    if href:
                        urls.append(href)
            if not getattr(scope, "parent", None):
                break
            scope = scope.parent

    # Clean and deduplicate URLs (strip trailing punctuation like }, ), ., etc.)
    cleaned_urls = []
    for u in urls:
        cleaned = re.sub(r"[\}\]\)\>\.\,\;]+$", "", u.strip())
        if cleaned and _hostname(cleaned):
            cleaned_urls.append(cleaned)

    urls = list(dict.fromkeys(cleaned_urls))
    if not urls:
        logger.info("[SxyPrn] No post-scoped mirror links for %s; ignoring page-wide links", clean_id)
    ranked = sorted(urls, key=_host_rank)
    streams = [{"url": u, "host": _hostname(u)} for u in ranked]
    return {
        "post_id": clean_id,
        "streams": streams,
        **video_info,
    }


def fetch_post_detail(post_id: str, post_url: Optional[str] = None) -> Dict[str, Any]:
    """Fetch a single post page and return ranked streams + Video Info metadata."""
    clean_id = post_id.split('?')[0].replace('.html', '')
    html = ""
    for candidate_url in _post_candidate_urls(clean_id, post_url):
        try:
            req_headers = dict(_HEADERS)
            if "sxyprn.net" in candidate_url.lower():
                req_headers["Referer"] = "https://www.sxyprn.net/"
            with httpx.Client(headers=req_headers, timeout=15, follow_redirects=True) as client:
                resp = client.get(candidate_url)
                if resp.status_code == 200 and resp.text:
                    html = resp.text
                    break
        except Exception as exc:
            logger.debug("[SxyPrn] candidate fetch error %s: %s", candidate_url, exc)

    if not html:
        return {"post_id": clean_id, "streams": []}
    return _parse_post_detail(html, clean_id)


def fetch_post_streams(post_id: str, post_url: Optional[str] = None) -> List[Dict[str, str]]:
    """
    Fetch a single post page and return all external video host URLs,
    ranked by HOST_PRIORITY. Synchronous — run in thread pool.
    """
    return fetch_post_detail(post_id, post_url).get("streams", [])


async def probe_hls_quality_and_size(
    client: httpx.AsyncClient,
    m3u8_url: str,
    duration_sec: int = 0,
    referer: str = "",
    sample_limit: int = 3,
) -> Optional[Dict[str, Any]]:
    """
    Fetch an HLS master/media playlist, identify highest resolution/bandwidth variant,
    and estimate total file size in MB by sampling the first N segments (or via bandwidth * duration).
    """
    if not m3u8_url or not m3u8_url.startswith(("http://", "https://")):
        return None
    try:
        from .sxyprn_playback import provider_headers
        headers = provider_headers(m3u8_url, referer)
        resp = await client.get(m3u8_url, headers=headers, timeout=8.0)
        if resp.status_code not in (200, 206) or "#EXTM3U" not in resp.text:
            return None
        text = resp.text

        max_bandwidth = 0
        best_height = 0
        best_quality = ""
        best_variant_path = ""

        stream_re = re.compile(r"^#EXT-X-STREAM-INF:([^\r\n]+)\r?\n([^\r\n]+)", re.MULTILINE | re.IGNORECASE)
        for m in stream_re.finditer(text):
            attrs = m.group(1)
            variant_line = m.group(2).strip()
            if not variant_line or variant_line.startswith("#"):
                continue
            bw_m = re.search(r"(?:AVERAGE-)?BANDWIDTH=(\d+)", attrs, re.IGNORECASE)
            res_m = re.search(r"RESOLUTION=\d+x(\d+)", attrs, re.IGNORECASE)
            name_m = re.search(r'NAME=["\']?([^,"\']+)', attrs, re.IGNORECASE)
            bw = int(bw_m.group(1)) if bw_m else 0
            h = int(res_m.group(1)) if res_m else 0
            if not h and name_m:
                _, h = _normalize_quality_info(name_m.group(1))

            if bw > max_bandwidth or (h > best_height and bw == max_bandwidth):
                if bw > max_bandwidth:
                    max_bandwidth = bw
                if h > 0:
                    best_height = h
                    best_quality, _ = _normalize_quality_info(f"{h}p", h)
                elif name_m:
                    best_quality, best_height = _normalize_quality_info(name_m.group(1))
                best_variant_path = variant_line

        variant_url = urljoin(m3u8_url, best_variant_path) if best_variant_path else m3u8_url
        if best_variant_path:
            v_headers = provider_headers(variant_url, referer)
            v_resp = await client.get(variant_url, headers=v_headers, timeout=8.0)
            if v_resp.status_code not in (200, 206) or "#EXT" not in v_resp.text:
                v_text = ""
            else:
                v_text = v_resp.text
        else:
            v_text = text

        seg_urls: List[str] = []
        total_seg_duration = 0.0
        if v_text:
            lines = v_text.splitlines()
            for idx, line in enumerate(lines):
                extinf = re.match(r"^#EXTINF:([\d.]+)", line.strip())
                if extinf:
                    try:
                        total_seg_duration += float(extinf.group(1))
                    except ValueError:
                        pass
                    if idx + 1 < len(lines):
                        seg_line = lines[idx + 1].strip()
                        if seg_line and not seg_line.startswith("#"):
                            seg_urls.append(urljoin(variant_url, seg_line))

        size_mb = 0.0
        if seg_urls:
            req_segs = seg_urls[:sample_limit] if sample_limit > 0 else seg_urls

            async def _probe_seg_bytes(seg_u: str) -> int:
                s_headers = provider_headers(seg_u, referer)
                try:
                    h_resp = await client.head(seg_u, headers=s_headers, timeout=5.0)
                    cl = int(h_resp.headers.get("content-length") or 0)
                    if h_resp.status_code in (200, 206) and cl > 0:
                        return cl
                except Exception:
                    pass
                try:
                    r_headers = {**s_headers, "Range": "bytes=0-0"}
                    async with client.stream("GET", seg_u, headers=r_headers, timeout=5.0) as g_resp:
                        cr = g_resp.headers.get("content-range") or ""
                        if "/" in cr:
                            tail = cr.split("/")[-1].strip()
                            if tail.isdigit():
                                return int(tail)
                        cl2 = int(g_resp.headers.get("content-length") or 0)
                        if g_resp.status_code == 200 and cl2 > 0:
                            return cl2
                except Exception:
                    pass
                return 0

            seg_sizes = await asyncio.gather(*[_probe_seg_bytes(u) for u in req_segs])
            valid_sizes = [s for s in seg_sizes if s > 0]
            failed_count = len(req_segs) - len(valid_sizes)
            if valid_sizes and failed_count <= len(req_segs) * 0.34:
                total_bytes = sum(valid_sizes)
                if sample_limit > 0 and len(req_segs) < len(seg_urls):
                    total_bytes = round((total_bytes / len(valid_sizes)) * len(seg_urls))
                size_mb = round(total_bytes / (1024.0 * 1024.0), 1)

        eff_dur = int(round(total_seg_duration)) if total_seg_duration > 0 else duration_sec
        if size_mb <= 0 and max_bandwidth > 0 and eff_dur > 0:
            size_mb = round((max_bandwidth * eff_dur) / (8.0 * 1024.0 * 1024.0), 1)

        if not best_height and not size_mb:
            return None

        return {
            "quality": best_quality or ("1080p" if best_height >= 1080 else ("720p" if best_height >= 720 else "")),
            "height": best_height,
            "file_size_mb": size_mb,
            "size_label": _format_size_mb(size_mb),
            "size_estimated": True,
            "duration_sec": eff_dur,
        }
    except Exception as exc:
        logger.debug("[SxyPrn] probe_hls_quality_and_size failed for %s: %s", m3u8_url[:80], exc)
        return None


async def probe_mp4_size_mb(
    client: httpx.AsyncClient,
    mp4_url: str,
    referer: str = "",
) -> float:
    """Probe direct MP4 file size in MB via HEAD or Range GET."""
    if not mp4_url or not mp4_url.startswith(("http://", "https://")):
        return 0.0
    from .sxyprn_playback import provider_headers
    headers = provider_headers(mp4_url, referer)
    try:
        h_resp = await client.head(mp4_url, headers=headers, timeout=5.0)
        ctype = (h_resp.headers.get("content-type") or "").lower()
        cl = int(h_resp.headers.get("content-length") or 0)
        if h_resp.status_code in (200, 206) and cl > 0 and "text/html" not in ctype and "application/json" not in ctype:
            return round(cl / (1024.0 * 1024.0), 1)
    except Exception:
        pass
    try:
        r_headers = {**headers, "Range": "bytes=0-0"}
        async with client.stream("GET", mp4_url, headers=r_headers, timeout=5.0) as g_resp:
            ctype = (g_resp.headers.get("content-type") or "").lower()
            if "text/html" in ctype or "application/json" in ctype:
                return 0.0
            cr = g_resp.headers.get("content-range") or ""
            if g_resp.status_code == 206 and "/" in cr:
                tail = cr.split("/")[-1].strip()
                if tail.isdigit():
                    return round(int(tail) / (1024.0 * 1024.0), 1)
            cl2 = int(g_resp.headers.get("content-length") or 0)
            if g_resp.status_code == 200 and cl2 > 0:
                return round(cl2 / (1024.0 * 1024.0), 1)
    except Exception:
        pass
    return 0.0


async def probe_external_stream_candidate(
    client: httpx.AsyncClient,
    source_url: str,
    duration_sec: int = 0,
    fallback_quality: str = "",
    fallback_height: int = 0,
    fallback_size_mb: float = 0.0,
) -> Optional[Dict[str, Any]]:
    """
    Resolve and probe a single external mirror URL (Vidara, LuluStream, Streamtape, DoodStream)
    for its real stream URL, resolution (height/quality), and file size (MB).
    """
    if not source_url or not source_url.startswith(("http://", "https://")):
        return None
    host = _hostname(source_url).lower().replace("www.", "")
    stream_url = ""
    is_hls = False
    quality = fallback_quality or "720p"
    height = fallback_height or 720
    size_mb = 0.0
    size_exact = False
    is_direct_stream = False

    try:
        if any(x in host for x in ("vidara.so", "vidara.to", "vidsonic.net", "vidfast.co")):
            from .extractors.vidara import VidaraExtractor
            v_res = await VidaraExtractor().extract(source_url)
            if v_res and v_res.get("stream_url"):
                stream_url = v_res["stream_url"]
                is_hls = bool(v_res.get("is_hls", ".m3u8" in stream_url.lower()))
                is_direct_stream = True
                if v_res.get("file_size_mb"):
                    size_mb = float(v_res["file_size_mb"])
                    size_exact = True
                if is_hls:
                    hls_info = await probe_hls_quality_and_size(
                        client, stream_url, duration_sec, referer=f"https://{host}/", sample_limit=3
                    )
                    if hls_info:
                        if hls_info.get("height"):
                            height = int(hls_info["height"])
                            quality = hls_info.get("quality") or f"{height}p"
                        if hls_info.get("file_size_mb"):
                            size_mb = float(hls_info["file_size_mb"])
                            size_exact = False
                    else:
                        # Unreachable HLS playlist
                        stream_url = ""
                        is_direct_stream = False
                elif not size_mb:
                    probed_mb = await probe_mp4_size_mb(client, stream_url, referer=f"https://{host}/")
                    if probed_mb > 0:
                        size_mb = probed_mb
                        size_exact = True

        elif any(x in host for x in ("lulustream.com", "luluvdo.com", "luluvid.com", "luluvid.net", "luluvids.com", "luluvids.top", "lulu.stream", "lulust.com", "lplaygo.com")):
            from .extractors.lulustream import LuluStreamExtractor
            l_res = await LuluStreamExtractor().extract(source_url)
            if l_res and l_res.get("stream_url"):
                stream_url = l_res["stream_url"]
                is_hls = bool(l_res.get("is_hls", ".m3u8" in stream_url.lower()))
                is_direct_stream = True
                if is_hls:
                    hls_info = await probe_hls_quality_and_size(
                        client, stream_url, duration_sec, referer="https://luluvdo.com/", sample_limit=3
                    )
                    if hls_info:
                        if hls_info.get("height"):
                            height = int(hls_info["height"])
                            quality = hls_info.get("quality") or f"{height}p"
                        if hls_info.get("file_size_mb"):
                            size_mb = float(hls_info["file_size_mb"])
                            size_exact = False
                    else:
                        stream_url = ""
                        is_direct_stream = False

        elif "streamtape." in host:
            from .checkers.streamtape import StreamtapeChecker
            st_res = await StreamtapeChecker(timeout=10.0).check(source_url)
            if st_res and st_res.direct_url:
                stream_url = st_res.direct_url
                is_hls = False
                is_direct_stream = True
                if st_res.size_bytes and st_res.size_bytes > 0:
                    size_mb = round(st_res.size_bytes / (1024.0 * 1024.0), 1)
                    size_exact = True
                height = 1080 if size_mb > 400 else 720
                quality = f"{height}p"

        elif any(x in host for x in ("doodstream.", "dood.", "ds2play.", "bysesukior.")):
            from .checkers.doodstream import DoodstreamChecker
            dd_res = await DoodstreamChecker(timeout=8.0).check(source_url)
            if dd_res and dd_res.direct_url:
                stream_url = dd_res.direct_url
                is_hls = False
                is_direct_stream = True
                if dd_res.size_bytes and dd_res.size_bytes > 0:
                    size_mb = round(dd_res.size_bytes / (1024.0 * 1024.0), 1)
                    size_exact = True
                height = 1080 if size_mb > 500 else 720
                quality = f"{height}p"
    except Exception as exc:
        logger.debug("[SxyPrn] probe_external_stream_candidate error for %s: %s", source_url, exc)

    if not stream_url:
        stream_url = source_url
        is_direct_stream = False

    if size_mb <= 0 and fallback_size_mb > 0:
        size_mb = fallback_size_mb

    return {
        "source_url": source_url,
        "stream_url": stream_url,
        "host": host,
        "is_hls": is_hls,
        "is_direct_stream": is_direct_stream,
        "quality": quality,
        "height": height,
        "file_size_mb": round(size_mb, 1) if size_mb > 0 else 0.0,
        "size_label": _format_size_mb(size_mb),
        "size_exact": size_exact,
        "size_estimated": bool(size_mb > 0 and not size_exact),
        "status": "verified" if is_direct_stream else "fallback",
    }


def _candidate_sort_key(cand: Dict[str, Any]) -> tuple:
    """
    Sort candidates identically to NVS extension:
    1) Direct playable stream (.m3u8 / direct MP4) over generic host page URL
    2) Highest file_size_mb (largest / highest bitrate file)
    3) Highest resolution height
    4) Host priority tie-breaker (lower rank index = better)
    """
    is_direct = 1 if cand.get("is_direct_stream") else 0
    size_mb = float(cand.get("file_size_mb") or 0.0)
    height = int(cand.get("height") or 0)
    host_rank = _host_rank(cand.get("source_url") or cand.get("host") or "")
    return (is_direct, size_mb, height, -host_rank)


async def probe_best_post_streams(
    streams: List[Dict[str, str]],
    duration_sec: int = 0,
    fallback_quality: str = "",
    fallback_height: int = 0,
    fallback_size_mb: float = 0.0,
    client: Optional[httpx.AsyncClient] = None,
) -> Dict[str, Any]:
    """
    Probe all external mirrors for a SxyPrn post concurrently and rank them
    so the highest quality / largest file size stream wins automatically.
    """
    if not streams:
        return {"best": None, "candidates": []}

    owns_client = client is None
    if owns_client:
        client = httpx.AsyncClient(timeout=12, follow_redirects=True, verify=False)

    try:
        tasks = [
            probe_external_stream_candidate(
                client,
                s.get("url", ""),
                duration_sec=duration_sec,
                fallback_quality=fallback_quality,
                fallback_height=fallback_height,
                fallback_size_mb=fallback_size_mb,
            )
            for s in streams
            if s.get("url")
        ]
        results = [r for r in await asyncio.gather(*tasks) if r]
        results.sort(key=_candidate_sort_key, reverse=True)
        return {
            "best": results[0] if results else None,
            "candidates": results,
        }
    finally:
        if owns_client and client is not None:
            await client.aclose()


async def enrich_sxyprn_posts(
    posts: List[Dict[str, Any]],
    max_concurrency: int = 6,
) -> List[Dict[str, Any]]:
    """Concurrently fetch SxyPrn post detail pages and probe external mirrors for highest quality/size."""
    if not posts:
        return []

    sem = asyncio.Semaphore(max(1, min(max_concurrency, 10)))

    async def _fetch_one(client: httpx.AsyncClient, item: Dict[str, Any]) -> Dict[str, Any]:
        raw_id = str(item.get("post_id") or "").strip()
        post_url = item.get("post_url")
        if not raw_id:
            return {"post_id": "", "enriched": False}
        clean_id = raw_id.split('?')[0].replace('.html', '')
        candidates = _post_candidate_urls(clean_id, post_url)
        # Prefer canonical .html URL first to avoid redundant fallback hops
        primary_url = f"{BASE}/post/{clean_id}.html"
        ordered = [primary_url] + [u for u in candidates if u != primary_url]

        async with sem:
            html = ""
            for candidate_url in ordered[:2]:
                try:
                    req_headers = dict(_HEADERS)
                    if "sxyprn.net" in candidate_url.lower():
                        req_headers["Referer"] = "https://www.sxyprn.net/"
                    resp = await client.get(candidate_url, headers=req_headers)
                    if resp.status_code == 200 and resp.text:
                        html = resp.text
                        break
                except Exception as exc:
                    logger.debug("[SxyPrn] async enrich fetch error %s: %s", candidate_url, exc)

            if not html:
                return {"post_id": clean_id, "enriched": False}

            detail = await asyncio.to_thread(_parse_post_detail, html, clean_id)
            streams = detail.get("streams") or []
            page_dur_sec = int(detail.get("duration_sec") or 0)
            page_quality = detail.get("quality") or ""
            page_height = int(detail.get("height") or 0)
            page_size_mb = float(detail.get("file_size_mb") or 0.0)
            page_size_label = detail.get("size_label") or ""
            page_size_est = bool(detail.get("size_estimated"))

            probed = await probe_best_post_streams(
                streams,
                duration_sec=page_dur_sec,
                fallback_quality=page_quality,
                fallback_height=page_height,
                fallback_size_mb=page_size_mb,
                client=client,
            )

        best_cand = probed.get("best")
        ranked_cands = probed.get("candidates") or []

        if ranked_cands:
            ext_urls = [c["source_url"] for c in ranked_cands if c.get("source_url")]
            hosts = list(dict.fromkeys(c["host"] for c in ranked_cands if c.get("host")))
            streams_out = [
                {
                    "url": c["source_url"],
                    "stream_url": c.get("stream_url") or c["source_url"],
                    "host": c["host"],
                    "quality": c.get("quality") or "",
                    "height": c.get("height") or 0,
                    "file_size_mb": c.get("file_size_mb") or 0.0,
                    "size_label": c.get("size_label") or "",
                    "status": c.get("status") or "fallback",
                }
                for c in ranked_cands
            ]
        else:
            ext_urls = [s["url"] for s in streams]
            hosts = list(dict.fromkeys(s["host"] for s in streams if s.get("host")))
            streams_out = streams

        best_source_url = (best_cand.get("source_url") if best_cand else None) or (ext_urls[0] if ext_urls else None)
        best_direct_url = (best_cand.get("stream_url") if best_cand else None) or best_source_url
        best_host = (best_cand.get("host") if best_cand else None) or (hosts[0] if hosts else "")

        final_height = int((best_cand.get("height") if best_cand else 0) or page_height or 0)
        final_quality = (best_cand.get("quality") if best_cand and best_cand.get("height") else "") or page_quality
        if final_height and not final_quality:
            final_quality, _ = _normalize_quality_info(f"{final_height}p", final_height)

        final_size_mb = float((best_cand.get("file_size_mb") if best_cand else 0.0) or page_size_mb or 0.0)
        final_size_label = _format_size_mb(final_size_mb) if final_size_mb > 0 else page_size_label
        final_size_est = bool(best_cand.get("size_estimated")) if (best_cand and best_cand.get("file_size_mb")) else page_size_est

        verified_count = sum(1 for c in ranked_cands if c.get("is_direct_stream"))
        total_count = len(ranked_cands) + (1 if page_size_mb > 0 else 0)

        return {
            "post_id": clean_id,
            "enriched": True,
            "streams": streams_out,
            "best": best_source_url,
            "direct_stream_url": best_direct_url,
            "ext_urls": ext_urls,
            "hosts": hosts,
            "best_host": best_host,
            "verified_sources": verified_count,
            "total_sources": total_count,
            "duration": detail.get("duration") or "",
            "duration_sec": page_dur_sec,
            "quality": final_quality,
            "height": final_height,
            "bitrate_kbps": detail.get("bitrate_kbps") or 0,
            "file_size_mb": final_size_mb,
            "size_label": final_size_label,
            "size_estimated": final_size_est,
        }

    async with httpx.AsyncClient(timeout=12, follow_redirects=True, verify=False) as client:
        return list(await asyncio.gather(*[_fetch_one(client, p) for p in posts]))



def _hostname(url: str) -> str:
    m = re.search(r"https?://([^/]+)", url)
    return m.group(1) if m else url


def pick_best_stream(streams: List[Dict[str, str]]) -> Optional[str]:
    """Return URL of highest-priority stream from fetch_post_streams output."""
    if not streams:
        return None
    return streams[0]["url"]
