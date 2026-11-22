"""
Camwhores.tv resolver for watch pages (/videos/...).

Primary path uses Playwright so site JS and Cloudflare checks run in a real
browser context. If that fails, fall back to the legacy HTML/regex scraper.
"""
import asyncio
import datetime
import html as html_lib
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import aiohttp
from .base import ntc_get
from app.ntc import NTCStatusError

logger = logging.getLogger(__name__)

# The cookie bundle is rebuilt for every probe, page fetch and fallback rung —
# roughly four times per video. Callers also construct a fresh
# CamwhoresExtractor() per video, so an instance-level cache would never hit.
# Cache the parsed bundle at module scope instead, keyed on the resolved file's
# mtime/size and the CAMWHORES_COOKIE value so a real edit still takes effect.
_COOKIE_BUNDLE_LOCK = threading.Lock()
_COOKIE_BUNDLE_CACHE: Dict[str, Any] = {"key": None, "value": None}


def _reset_cookie_bundle_cache() -> None:
    """Drop the cached bundle. Used by tests and after cookie rotation."""
    with _COOKIE_BUNDLE_LOCK:
        _COOKIE_BUNDLE_CACHE["key"] = None
        _COOKIE_BUNDLE_CACHE["value"] = None


def normalize_camwhores_get_file_rnd(url: str) -> str:
    """
    CamWhores direct file URLs use query param rnd=<unix_ms>. Extension-captured links
    always include it; HTML extraction sometimes omits it. Always set/refresh rnd so
    playback and probes match the working URL shape.
    """
    if not url:
        return url
    low = url.lower()
    # Camvideos and cwvids serve the same KVS get_file links. They need a fresh
    # rnd token too, otherwise the CDN closes the connection on playback.
    if "get_file" not in low or not any(
        host in low for host in ("camwhores.tv", "camvideos.org", "cwvids.com")
    ):
        return url
    try:
        # Repair URLs normalized by older versions before HTML unescape treats
        # the semicolon-less &amp prefix as an entity of its own.
        url = html_lib.unescape(re.sub(r"&amp%3[Bb]", "&", url))
        parsed = urlparse(url)
        pairs = [(k.removeprefix("amp;"), v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k.removeprefix("amp;").lower() != "rnd"]
        pairs.append(("rnd", str(int(time.time() * 1000))))
        new_q = urlencode(pairs)
        return urlunparse(
            (parsed.scheme, parsed.netloc, parsed.path, parsed.params, new_q, parsed.fragment)
        )
    except Exception as exc:
        logger.debug("[Camwhores] normalize rnd urlparse failed, regex fallback: %s", exc)
        ms = int(time.time() * 1000)
        if re.search(r"[?&]rnd=\d+", url, re.I):
            return re.sub(r"(?<=[?&])rnd=\d+", f"rnd={ms}", url, count=1, flags=re.I)
        sep = "&" if ("?" in url) else "?"
        return f"{url}{sep}rnd={ms}"


class CamwhoresExtractor:
    def __init__(self) -> None:
        self.user_agent = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        self.page_timeout_ms = int(os.getenv("CAMWHORES_PLAYWRIGHT_TIMEOUT_MS", "45000"))
        self.network_idle_timeout_ms = int(os.getenv("CAMWHORES_NETWORK_IDLE_TIMEOUT_MS", "15000"))
        self.probe_timeout_secs = int(os.getenv("CAMWHORES_PROBE_TIMEOUT_SECS", "12"))
        self.max_probe_candidates = int(os.getenv("CAMWHORES_MAX_PROBE_CANDIDATES", "8"))

    @property
    def name(self) -> str:
        return "Camwhores"

    def can_handle(self, url: str) -> bool:
        if not url:
            return False
        u = url.lower()
        if "camwhores.tv" not in u:
            return False
        if self._is_member_url(url):
            return True
        return "/videos/" in u and "/members/" not in u

    @staticmethod
    def _is_member_url(url: str) -> bool:
        path = urlparse(url or "").path
        return bool(re.search(r"/members/\d+", path, re.I))

    @staticmethod
    def _member_kind(url: str) -> str:
        path = urlparse(url or "").path.lower()
        return "favourites" if "/favourites/" in path else "posted"

    async def extract_album_entries(
        self,
        url: str,
        *,
        max_pages=None,
        max_entries=None,
        info=None,
    ) -> List[Dict[str, Any]]:
        """Expand a Camwhores member page into posted (or favourite) watch URLs."""
        if not self._is_member_url(url):
            return []
        from app.hubs.camwhores import CamwhoresHub

        hub = CamwhoresHub()
        kind = self._member_kind(url)
        max_pages = int(max_pages) if max_pages else 50
        max_entries = int(max_entries) if max_entries else 0
        seeded = None
        if kind == "posted":
            seeded = await hub.member_videos(url, kind="posted", page=1)
            if not (getattr(seeded, "items", None) or []):
                kind = "favourites"
                seeded = None
        entries: List[Dict[str, Any]] = []
        seen: set = set()
        for page in range(1, max_pages + 1):
            if seeded is not None and page == 1:
                result = seeded
                seeded = None
            else:
                result = await hub.member_videos(url, kind=kind, page=page)
            items = list(getattr(result, "items", None) or [])
            new_on_page = 0
            for tile in items:
                if not isinstance(tile, dict):
                    continue
                watch = str(tile.get("url") or "").split("?")[0].strip()
                if "/videos/" not in watch or watch in seen:
                    continue
                seen.add(watch)
                entries.append({
                    "url": watch,
                    "source_url": watch,
                    "title": (tile.get("title") or "Camwhores video")[:150],
                    "thumbnail": tile.get("thumb") or tile.get("thumbnail") or "",
                    "duration": int(tile.get("duration_sec") or 0),
                    "stream_url": "",
                    "height": int(tile.get("height") or 0),
                    "quality": tile.get("quality") or "",
                    "upload_date": tile.get("added") or "",
                })
                new_on_page += 1
                if max_entries and len(entries) >= max_entries:
                    if info is not None:
                        info["truncated"] = True
                    return entries
            has_more = bool(getattr(result, "has_more", False))
            if not items or new_on_page == 0 or not has_more:
                break
            if page >= max_pages:
                if info is not None and has_more:
                    info["truncated"] = True
                break
        logging.info("[Camwhores] member %s → %d videos", url, len(entries))
        return entries

    @staticmethod
    def _normalize_watch_url(url: str) -> str:
        if not url:
            return ""
        cleaned = url.strip()
        if "camwhores.tv" in cleaned.lower() and "/videos/" in cleaned.lower():
            return cleaned.rstrip("/") + "/"
        return cleaned

    @staticmethod
    def _sanitize_url(raw: str) -> str:
        if not raw:
            return ""
        url = html_lib.unescape(raw.replace("\\/", "/").strip())
        if "function/0/" in url:
            url = url.split("function/0/", 1)[-1]
        if url.startswith("//"):
            url = "https:" + url
        http_idx = url.find("http://")
        https_idx = url.find("https://")
        if https_idx > 0:
            url = url[https_idx:]
        elif http_idx > 0:
            url = url[http_idx:]
        return url

    @staticmethod
    def _infer_height_from_url(url: str) -> int:
        if not url:
            return 0
        m = re.search(r"[/_](2160|1440|1080|720|480|360)p(?:[/_.-]|$)", url, re.I) or re.search(
            r"/(2160|1440|1080|720|480|360)/", url
        )
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                return 0
        if "4k" in url.lower():
            return 2160
        return 0

    @staticmethod
    def _width_for_height(height: int) -> int:
        return {
            2160: 3840,
            1440: 2560,
            1080: 1920,
            720: 1280,
            480: 854,
            360: 640,
        }.get(height, 0)

    @staticmethod
    def _safe_duration_secs(v: int) -> int:
        return v if 1 <= v <= 21600 else 0

    @staticmethod
    def _resolve_cookie_file_path() -> Optional[str]:
        env = os.getenv("CAMWHORES_COOKIE_FILE", "").strip()
        if env and os.path.isfile(env):
            return env
        here = Path(__file__).resolve()
        repo_root = here.parents[2]
        for candidate in (Path.cwd() / "camwhores.cookies.txt", repo_root / "camwhores.cookies.txt"):
            if candidate.is_file():
                return str(candidate)
        return None

    @staticmethod
    def _parse_netscape_cookie_file(path: str) -> List[Dict[str, Any]]:
        """Netscape format (Export from browser extension). Domain must mention camwhores."""
        out: List[Dict[str, Any]] = []
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    parts = line.split("\t")
                    if len(parts) < 7:
                        continue
                    domain = (parts[0] or "").strip()
                    if "camwhores" not in domain.lower():
                        continue
                    secure = parts[3] == "TRUE"
                    try:
                        exp_raw = parts[4]
                        expires = int(exp_raw) if exp_raw and exp_raw.isdigit() and int(exp_raw) > 0 else -1
                    except ValueError:
                        expires = -1
                    path_s = parts[2] or "/"
                    name, value = parts[5], parts[6].strip()
                    if not name:
                        continue
                    entry: Dict[str, Any] = {
                        "name": name,
                        "value": value,
                        "domain": domain,
                        "path": path_s,
                        "httpOnly": False,
                        "secure": secure,
                    }
                    if expires > 0:
                        entry["expires"] = expires
                    out.append(entry)
        except OSError as exc:
            logger.warning("[Camwhores] cannot read cookie file %s: %s", path, exc)
        return out

    @staticmethod
    def _parse_inline_cookie_header(header: str) -> Dict[str, str]:
        pairs: Dict[str, str] = {}
        if not header:
            return pairs
        for part in header.split(";"):
            part = part.strip()
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            name = name.strip()
            if not name:
                continue
            pairs[name] = value.strip()
        return pairs

    def _cookie_bundle(self) -> Tuple[str, List[Dict[str, Any]]]:
        """
        Merge cookies from (1) camwhores.cookies.txt / CAMWHORES_COOKIE_FILE,
        (2) CAMWHORES_COOKIE env. Env wins on name collision.
        Returns (Cookie header string, list for Playwright add_cookies).

        Parsing is cached module-wide; callers get fresh dicts each time so a
        Playwright context cannot mutate the cached bundle.
        """
        path = self._resolve_cookie_file_path()
        env_value = os.getenv("CAMWHORES_COOKIE", "").strip()
        try:
            stat = os.stat(path) if path else None
        except OSError:
            stat = None
        signature = (stat.st_mtime_ns, stat.st_size) if stat else None
        key = (path, signature, env_value)

        with _COOKIE_BUNDLE_LOCK:
            if _COOKIE_BUNDLE_CACHE["value"] is not None and _COOKIE_BUNDLE_CACHE["key"] == key:
                cached_header, cached_pw = _COOKIE_BUNDLE_CACHE["value"]
                return cached_header, [dict(cookie) for cookie in cached_pw]

        header, pw = self._build_cookie_bundle(path, env_value)

        with _COOKIE_BUNDLE_LOCK:
            _COOKIE_BUNDLE_CACHE["key"] = key
            _COOKIE_BUNDLE_CACHE["value"] = (header, pw)
        return header, [dict(cookie) for cookie in pw]

    def _build_cookie_bundle(self, path: Optional[str], env_value: str) -> Tuple[str, List[Dict[str, Any]]]:
        by_name: Dict[str, str] = {}
        pw: List[Dict[str, Any]] = []

        if path:
            for c in self._parse_netscape_cookie_file(path):
                by_name[c["name"]] = c["value"]
                pw.append(dict(c))

        env_pairs = self._parse_inline_cookie_header(env_value)
        for name, value in env_pairs.items():
            by_name[name] = value
            pw = [x for x in pw if x.get("name") != name]
            pw.append(
                {
                    "name": name,
                    "value": value,
                    "domain": ".camwhores.tv",
                    "path": "/",
                    "expires": -1,
                    "httpOnly": False,
                    "secure": True,
                }
            )

        header = "; ".join(f"{k}={v}" for k, v in sorted(by_name.items())) if by_name else ""
        if path or by_name:
            logger.info(
                "[Camwhores] cookies: file=%s names=%s",
                path or "(none)",
                len(by_name),
            )
        return header, pw

    def _base_headers(self, referer: Optional[str] = None) -> Dict[str, str]:
        headers = {
            "User-Agent": self.user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": referer or "https://www.camwhores.tv/",
        }
        cookie_header, _ = self._cookie_bundle()
        if cookie_header:
            headers["Cookie"] = cookie_header
        return headers

    def _playwright_cookies(self) -> List[Dict[str, Any]]:
        _, cookies = self._cookie_bundle()
        return cookies

    def _extract_title(self, html: str, fallback: str = "Camwhores Video") -> str:
        for pat in (
            r'<meta\s+property=["\']og:title["\']\s+content=["\']([^"\']+)["\']',
            r"<title>([^<]+)</title>",
        ):
            m = re.search(pat, html or "", re.I)
            if m:
                return m.group(1).strip()
        return fallback

    def _extract_thumbnail(self, html: str) -> Optional[str]:
        for pat in (
            r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']',
            r'<video[^>]+poster=["\']([^"\']+)["\']',
        ):
            m = re.search(pat, html or "", re.I)
            if m:
                thumb = m.group(1).strip()
                if thumb.startswith("//"):
                    thumb = "https:" + thumb
                return thumb
        return None

    def _extract_duration(self, html: str) -> int:
        dm = re.search(
            r'<meta\s+property=["\']video:duration["\']\s+content=["\'](\d+)["\']',
            html or "",
            re.I,
        )
        if dm:
            try:
                return self._safe_duration_secs(int(dm.group(1)))
            except ValueError:
                pass
        # Try Duration: <em>MM:SS</em> or <em>HH:MM:SS</em>
        em_m = re.search(r"Duration:\s*<em>\s*(\d+(?::\d+)+)\s*</em>", html or "", re.I)
        if em_m:
            parts = em_m.group(1).split(":")
            try:
                if len(parts) == 2:
                    return int(parts[0]) * 60 + int(parts[1])
                elif len(parts) == 3:
                    return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
            except ValueError:
                pass
        for pat in (
            r'"duration"\s*:\s*"?(\d{2,6})"?',
            r"video_duration['\"]?\s*[:=]\s*['\"]?(\d+)",
            r"'duration'\s*:\s*'(\d+)'",
            r'"video_duration"\s*:\s*(\d+)',
        ):
            mm = re.search(pat, html or "", re.I)
            if mm:
                try:
                    d = self._safe_duration_secs(int(mm.group(1)))
                    if d:
                        return d
                except ValueError:
                    pass
        return 0

    def _extract_candidates_from_html(self, html: str) -> List[str]:
        candidates: List[str] = []
        for pat in (
            r"video_url\s*=\s*['\"]([^'\"]+)['\"]",
            r"(https://(?:www\.)?camwhores\.tv/get_file/[^\"'\s<>]+)",
            r'"file"\s*:\s*"([^"]+get_file[^"]+)"',
            r"'file'\s*:\s*'([^']+get_file[^']+)'",
        ):
            matches = re.findall(pat, html or "", re.I)
            for raw in matches:
                cleaned = self._sanitize_url(raw).rstrip()
                if cleaned and "get_file" in cleaned and cleaned.startswith("http"):
                    candidates.append(cleaned)
        deduped = list(dict.fromkeys(candidates))
        deduped.sort(key=lambda f: (self._infer_height_from_url(f), len(f)), reverse=True)
        return deduped

    async def _probe_candidates(self, candidates: List[str], watch_url: str) -> Optional[str]:
        if not candidates:
            return None
        headers = self._base_headers(referer=watch_url)
        timeout = aiohttp.ClientTimeout(total=self.probe_timeout_secs)
        
        async def _check_one(url: str, session: aiohttp.ClientSession) -> Optional[str]:
            try:
                probe_url = normalize_camwhores_get_file_rnd(url)
                probe_headers = {**headers, "Referer": watch_url, "Range": "bytes=0-0"}
                async with session.get(probe_url, headers=probe_headers, timeout=timeout, allow_redirects=True, ssl=False) as probe:
                    ctype = (probe.headers.get("Content-Type") or "").lower()
                    clen = int(probe.headers.get("Content-Length") or 0)
                    ok = probe.status in (200, 206) and (probe.status == 206 or "video" in ctype or clen >= 65536)
                    if ok:
                        return probe_url
            except Exception:
                pass
            return None

        async with aiohttp.ClientSession() as session:
            # Parallel probe
            tasks = [_check_one(c, session) for c in candidates[:self.max_probe_candidates]]
            results = await asyncio.gather(*tasks)
            # Find first non-None result in original priority order
            for r in results:
                if r:
                    return r
        return None

    async def _probe_stream_size(self, stream_url: str, watch_url: str) -> int:
        """Read the total byte count without downloading the Camwhores video."""
        if not stream_url:
            return 0
        headers = {**self._base_headers(referer=watch_url), "Range": "bytes=0-0"}
        timeout = aiohttp.ClientTimeout(total=self.probe_timeout_secs)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(stream_url, headers=headers, timeout=timeout,
                                       allow_redirects=True, ssl=False) as response:
                    content_range = response.headers.get("Content-Range") or ""
                    if "/" in content_range:
                        try:
                            return int(content_range.rsplit("/", 1)[-1])
                        except ValueError:
                            pass
                    # A few CDN nodes ignore Range but still report the full length.
                    if response.status == 200:
                        try:
                            return int(response.headers.get("Content-Length") or 0)
                        except ValueError:
                            pass
        except Exception as exc:
            logger.debug("[Camwhores] size probe failed for %s: %s", watch_url, exc)
        return 0

    async def _validate_payload(self, payload: Optional[Dict[str, Any]], watch_url: str) -> Optional[Dict[str, Any]]:
        if not payload or not payload.get("stream_url"):
            return None
        if payload.get("_prevalidated"):
            return payload

        candidates = payload.get("_candidates") or [payload["stream_url"]]
        stream_url = await self._probe_candidates(candidates, watch_url)
        if not stream_url:
            logger.warning(
                "[Camwhores] candidate validation failed for %s: %s",
                payload.get("_resolver") or "unknown",
                watch_url,
            )
            return None

        payload["stream_url"] = stream_url
        payload["_prevalidated"] = True
        return payload

    async def _legacy_extract_html(self, url: str) -> Optional[str]:
        headers = self._base_headers()
        try:
            return await ntc_get(url, domain="camwhores.tv", headers=headers, deadline=20)
        except TimeoutError as exc:
            logger.warning("[Camwhores] ntc html fetch failed for %s: %s", url, exc)
            return None
        except NTCStatusError as exc:
            logger.warning("[Camwhores] http_%s for %s", exc.status_code, url)
            return None
        except Exception as exc:
            logger.warning("[Camwhores] ntc html fetch failed for %s: %s", url, exc)
            return None

    async def _extract_with_playwright(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Run Playwright extraction in thread pool to prevent event loop blocking.
        This is the CRITICAL FIX for issue #1 in the audit report.
        """
        try:
            # Run synchronous Playwright in thread pool - prevents blocking FastAPI event loop
            result = await asyncio.to_thread(self._extract_with_playwright_sync, url)
            return result
        except Exception as exc:
            logger.warning("[Camwhores] Playwright thread pool execution failed: %s", exc)
            return None

    def _extract_with_playwright_sync(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Synchronous Playwright extraction - runs in dedicated thread.
        This prevents blocking the async event loop.
        """
        try:
            from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
        except Exception as exc:
            logger.warning("[Camwhores] Playwright unavailable: %s", exc)
            return None

        network_urls: List[str] = []
        watch_url = self._normalize_watch_url(url)

        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-infobars",
                ],
            )
            context = browser.new_context(
                user_agent=self.user_agent,
                viewport={"width": 1440, "height": 1024},
                locale="en-US",
                extra_http_headers={
                    "Accept-Language": "en-US,en;q=0.9",
                    "Upgrade-Insecure-Requests": "1",
                },
            )
            cookies = self._playwright_cookies()
            if cookies:
                context.add_cookies(cookies)
            page = context.new_page()

            def _collect_url(candidate_url: str) -> None:
                cleaned = self._sanitize_url(candidate_url).rstrip()
                if cleaned and "get_file" in cleaned and cleaned not in network_urls:
                    network_urls.append(cleaned)

            page.on("request", lambda request: _collect_url(request.url))
            page.on("response", lambda response: _collect_url(response.url))

            try:
                logger.info("[Camwhores] Playwright (sync thread) fetching %s", watch_url)
                page.goto(watch_url, wait_until="domcontentloaded", timeout=self.page_timeout_ms)

                for selector in (
                    'button:has-text("I am 18")',
                    'button:has-text("Enter")',
                    'button:has-text("Accept")',
                    ".btn-enter",
                    ".age-confirm",
                    "[data-action='confirm']",
                ):
                    try:
                        btn = page.query_selector(selector)
                        if btn and btn.is_visible():
                            btn.click()
                            time.sleep(1)
                            break
                    except Exception:
                        continue

                try:
                    page.wait_for_load_state("networkidle", timeout=self.network_idle_timeout_ms)
                except PlaywrightTimeoutError:
                    logger.info("[Camwhores] Playwright networkidle timeout for %s", watch_url)

                # Trigger player/network activity
                try:
                    page.evaluate(
                        """() => {
                            const v = document.querySelector('video');
                            if (v) {
                                v.muted = true;
                                const p = v.play();
                                if (p && typeof p.catch === 'function') p.catch(() => {});
                            }
                        }"""
                    )
                    time.sleep(2)
                except Exception:
                    pass

                page_meta = page.evaluate(
                    """() => {
                        const meta = {
                            title: document.querySelector('meta[property="og:title"]')?.content || '',
                            thumbnail: document.querySelector('meta[property="og:image"]')?.content || document.querySelector('video')?.poster || '',
                            duration: 0,
                            sources: [],
                        };
                        const durMeta = document.querySelector('meta[property="video:duration"]')?.content;
                        if (durMeta && /^\\d+$/.test(durMeta)) {
                            meta.duration = parseInt(durMeta, 10);
                        }
                        document.querySelectorAll('video[src], video source[src]').forEach((node) => {
                            const src = node.getAttribute('src');
                            if (src) meta.sources.push(src);
                        });
                        if (!meta.title) {
                            const h1 = document.querySelector('h1');
                            meta.title = h1 ? h1.textContent : document.title;
                        }
                        return meta;
                    }"""
                )
                html = page.content()
            except Exception as exc:
                logger.warning("[Camwhores] Playwright sync extract failed for %s: %s", watch_url, exc)
                return None
            finally:
                browser.close()

        # Process results (synchronous, but fast)
        html_candidates = self._extract_candidates_from_html(html)
        for raw in page_meta.get("sources") or []:
            cleaned = self._sanitize_url(raw).rstrip()
            if cleaned and "get_file" in cleaned and cleaned not in html_candidates:
                html_candidates.append(cleaned)
        candidates = list(dict.fromkeys(network_urls + html_candidates))
        candidates.sort(key=lambda f: (self._infer_height_from_url(f), len(f)), reverse=True)

        if not candidates:
            logger.warning("[Camwhores] Playwright found no get_file URLs for %s", watch_url)
            return None

        # Note: _probe_candidates is async, so we can't call it here
        # Instead, return candidates and let the async wrapper handle probing
        # For now, return the best candidate
        stream_url = candidates[0] if candidates else None
        if not stream_url:
            logger.warning("[Camwhores] Playwright failed to find candidates for %s", watch_url)
            return None

        duration = self._safe_duration_secs(int(page_meta.get("duration") or 0)) or self._extract_duration(html)
        return {
            "html": html,
            "title": (page_meta.get("title") or "").strip() or self._extract_title(html),
            "thumbnail": (page_meta.get("thumbnail") or "").strip() or self._extract_thumbnail(html),
            "duration": duration,
            "stream_url": stream_url,
            "height": self._infer_height_from_url(stream_url),
            "_resolver": "playwright_sync_thread",
            "_prevalidated": False,  # Needs async probing
            "_candidates": candidates,  # Pass all candidates for async probing
        }

    async def _extract_with_curl_cffi(self, url: str) -> Optional[Dict[str, Any]]:
        try:
            try:
                from cyberdrop_dl.crawlers._kvs import _parse_video_vars
            except Exception:
                _parse_video_vars = None
            
            headers = self._base_headers()
            # Ensure trailing slash
            fetch_url = url.rstrip("/") + "/"
            
            logger.info("[Camwhores] curl_cffi fetching %s", fetch_url)
            try:
                html = await ntc_get(
                    fetch_url,
                    domain="camwhores.tv",
                    headers=headers,
                    deadline=20,
                    impersonate="chrome124",
                )
            except NTCStatusError as exc:
                logger.warning("[Camwhores] curl_cffi status %s for %s", exc.status_code, fetch_url)
                return None
            except TimeoutError as exc:
                logger.warning("[Camwhores] NTC timeout for %s: %s", fetch_url, exc)
                raise
            
            if not html or len(html) < 1000:
                return None
            
            # 1. Try KVS flashvars decryption
            m_vars = re.search(r'flashvars\s*=\s*({.*?});', html, re.S)
            if m_vars:
                try:
                    video = _parse_video_vars(m_vars.group(1)) if _parse_video_vars else None
                    if video and video.url:
                        stream_url = str(video.url)
                        return {
                            "html": html,
                            "title": video.title or self._extract_title(html),
                            "thumbnail": self._extract_thumbnail(html),
                            "duration": self._safe_duration_secs(int(video.duration or 0)) or self._extract_duration(html),
                            "stream_url": stream_url,
                            "height": self._infer_height_from_url(stream_url),
                            "_resolver": "curl_cffi-kvs",
                            "_prevalidated": False,
                        }
                except Exception as e:
                    logger.debug("[Camwhores] KVS parse failed: %s", e)

            # 2. Fallback to candidate probing from HTML
            candidates = self._extract_candidates_from_html(html)
            stream_url = await self._probe_candidates(candidates, fetch_url)
            if stream_url:
                return {
                    "html": html,
                    "title": self._extract_title(html),
                    "thumbnail": self._extract_thumbnail(html),
                    "duration": self._extract_duration(html),
                    "stream_url": stream_url,
                    "height": self._infer_height_from_url(stream_url),
                    "_resolver": "curl_cffi-scrape",
                    "_prevalidated": True,
                }
        except TimeoutError:
            raise
        except Exception as exc:
            logger.debug("[Camwhores] curl_cffi path failed: %s", exc)
        return None

    async def _extract_with_http_fallback(self, url: str) -> Optional[Dict[str, Any]]:
        html = await self._legacy_extract_html(url)
        if not html or len(html) < 1200:
            logger.warning("[Camwhores] too short response for %s", url)
            return None

        candidates = self._extract_candidates_from_html(html)
        stream_url = await self._probe_candidates(candidates, url)
        if not stream_url:
            logger.warning("[Camwhores] no get_file found for %s", url)
            return None

        return {
            "html": html,
            "title": self._extract_title(html),
            "thumbnail": self._extract_thumbnail(html),
            "duration": self._extract_duration(html),
            "stream_url": stream_url,
            "height": self._infer_height_from_url(stream_url),
            "_resolver": "http-fallback",
            "_prevalidated": True,
        }

    def _parse_flashvars(self, html: str) -> Dict[str, Any]:
        """
        Parses flashvars JS object from the watch page HTML.
        """
        if not html:
            return {}
        m = re.search(r"var\s+flashvars\s*=\s*({.*?});", html, re.S)
        if not m:
            m = re.search(r"flashvars\s*=\s*({.*?});", html, re.S)
        if m:
            js_obj = m.group(1)
            out = {}
            pairs = re.findall(r"(\w+)\s*:\s*['\"](.*?)['\"]", js_obj)
            for k, v in pairs:
                import html as html_lib
                out[k] = html_lib.unescape(v)
            return out
        return {}

    @staticmethod
    def _extract_page_extras(html: str) -> Dict[str, str]:
        """Small watch-page fields reused by fast and deep metadata paths."""
        extras = {"uploader": "", "uploader_id": "", "upload_date": ""}
        if not html:
            return extras
        member = re.search(
            r'<a[^>]+href=["\'][^"\']*/members/(\d+)/?[^"\']*["\'][^>]*>(.*?)</a>',
            html, re.I | re.S,
        )
        if member:
            extras["uploader_id"] = member.group(1)
            extras["uploader"] = re.sub(r"<[^>]+>", "", member.group(2)).strip()
        date_pattern = r"(20\d\d[-/.]\d{1,2}[-/.]\d{1,2}|\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago|today|yesterday)"
        # Prefer the explicit Submitted:/Added: metadata field; never match words
        # like "yesterday" inside <head><meta name="description">...</head>.
        date_match = re.search(
            r"(?:Submitted|Added)\s*:\s*(?:<[^>]+>\s*)*" + date_pattern,
            html, re.I,
        )
        if not date_match:
            body_html = re.sub(r"<head\b.*?</head>", "", html, flags=re.I | re.S)
            date_match = re.search(date_pattern, body_html, re.I)
        if date_match:
            value = date_match.group(1).strip().lower()
            absolute = re.match(r"(20\d\d)[-/.](\d{1,2})[-/.](\d{1,2})", value)
            if absolute:
                extras["upload_date"] = f"{absolute.group(1)}-{int(absolute.group(2)):02d}-{int(absolute.group(3)):02d}"
            else:
                now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
                if value == "today":
                    date = now
                elif value == "yesterday":
                    date = now - datetime.timedelta(days=1)
                else:
                    relative = re.match(r"(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago", value)
                    amount = int(relative.group(1)) if relative else 0
                    unit = relative.group(2) if relative else "day"
                    days = {"day": amount, "week": amount * 7, "month": amount * 30, "year": amount * 365}.get(unit, 0)
                    date = now - datetime.timedelta(days=days)
                extras["upload_date"] = date.strftime("%Y-%m-%d")
        return extras

    def _build_result(self, watch_url: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        stream_url = normalize_camwhores_get_file_rnd(payload["stream_url"])
        inferred_height = int(payload.get("height") or self._infer_height_from_url(stream_url))
        
        # Pull rich metadata from payload
        categories = payload.get("categories") or ""
        models = payload.get("models") or ""
        related_src = payload.get("related_src") or ""
        preview_mp4_url = payload.get("preview_mp4_url") or ""
        tags = [t.strip() for t in (payload.get("tags") or "").split(",") if t.strip()]

        return {
            "id": None,
            "title": payload.get("title") or "Camwhores Video",
            "description": payload.get("description") or "",
            "thumbnail": payload.get("thumbnail"),
            "duration": int(payload.get("duration") or 0),
            "stream_url": stream_url,
            "size_bytes": int(payload.get("size_bytes") or 0),
            "width": self._width_for_height(inferred_height),
            "height": inferred_height,
            "tags": tags,
            "uploader": payload.get("uploader") or "",
            "uploader_id": payload.get("uploader_id") or "",
            "upload_date": payload.get("upload_date") or "",
            "is_hls": False,
            "source_url": watch_url,
            "categories": categories,
            "models": models,
            "related_src": related_src,
            "preview_mp4_url": preview_mp4_url,
            "_resolver": payload.get("_resolver"),
            "_prevalidated": bool(payload.get("_prevalidated")),
            "_stream_probe_unavailable": bool(payload.get("_stream_probe_unavailable")),
        }

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        if self._is_member_url(url):
            return None
        watch_url = self._normalize_watch_url(url)
        if not self.can_handle(watch_url):
            logger.warning("[Camwhores] unsupported URL: %s", url)
            return None

        try:
            payload = None
            last_candidate_payload: Optional[Dict[str, Any]] = None

            skip_ntc_html = False
            try:
                raw_payload = await self._extract_with_curl_cffi(watch_url)
            except TimeoutError:
                logger.warning("[Camwhores] NTC busy, skipping duplicate HTML fetch for %s", watch_url)
                raw_payload = None
                skip_ntc_html = True
            last_candidate_payload = raw_payload or last_candidate_payload
            payload = await self._validate_payload(raw_payload, watch_url)

            # 2. Medium path: aiohttp fallback (plain HTTP)
            if (not payload or not payload.get("stream_url")) and not skip_ntc_html:
                raw_payload = await self._extract_with_http_fallback(watch_url)
                last_candidate_payload = raw_payload or last_candidate_payload
                payload = await self._validate_payload(raw_payload, watch_url)

            # 3. Slow path: Playwright (last resort, runs in thread pool)
            if not payload or not payload.get("stream_url"):
                raw_payload = await self._extract_with_playwright(watch_url)
                last_candidate_payload = raw_payload or last_candidate_payload
                payload = await self._validate_payload(raw_payload, watch_url)

            # Some Camwhores CDN nodes allow the actual browser player but
            # reject our one-byte probe. When the watch page yielded a direct
            # get_file URL, keep it as a playable browser-ready fallback.
            if not payload and last_candidate_payload:
                candidates = last_candidate_payload.get("_candidates") or [last_candidate_payload.get("stream_url")]
                direct = next((normalize_camwhores_get_file_rnd(str(candidate or "")) for candidate in candidates if candidate), "")
                if direct:
                    payload = dict(last_candidate_payload)
                    payload["stream_url"] = direct
                    payload["_prevalidated"] = True
                    payload["_stream_probe_unavailable"] = True

            if payload and payload.get("stream_url"):
                # Enrich payload with flashvars!
                html_content = payload.get("html")
                if html_content:
                    flashvars = self._parse_flashvars(html_content)
                    if flashvars:
                        # Map keys safely
                        payload["tags"] = flashvars.get("video_tags") or payload.get("tags") or ""
                        payload["categories"] = flashvars.get("video_categories") or ""
                        payload["models"] = flashvars.get("video_models") or ""
                        payload["related_src"] = flashvars.get("related_src") or ""
                        
                        # `preview_height1` really is the video's height: the screenshot
                        # is rendered at the source resolution. Verified against the mp4
                        # `tkhd` box — 1200/1280/736 matched 1920x1200, 960x1280, 544x736.
                        # The odd-looking values are portrait cam recordings, not a bug.
                        pf_h = flashvars.get("preview_height1")
                        if pf_h and str(pf_h).isdigit():
                            payload["height"] = int(pf_h)
                        
                        # Generate 3-second preview mp4 url
                        preview_img = flashvars.get("preview_url1") or flashvars.get("preview_url") or payload.get("thumbnail")
                        if preview_img and "videos_screenshots" in preview_img:
                            preview_mp4 = re.sub(r"\.(jpg|png|webp|jpeg)$", ".mp4", preview_img, flags=re.I)
                            if preview_mp4.endswith(".mp4.mp4"):
                                preview_mp4 = preview_mp4[:-4]
                            payload["preview_mp4_url"] = preview_mp4
                    payload.update(self._extract_page_extras(html_content))

                # Content-Range carries the exact file size while transferring
                # only one byte, so cards can show the size immediately.
                payload["size_bytes"] = await self._probe_stream_size(payload["stream_url"], watch_url)
                        
                logger.info("[Camwhores] resolved via %s: %s", payload.get("_resolver"), watch_url)
                return self._build_result(watch_url, payload)

            logger.warning("[Camwhores] all extraction paths failed for %s", watch_url)
            return None
        except Exception as exc:
            logger.error("[Camwhores] extract failed: %s", exc, exc_info=True)
            return None
