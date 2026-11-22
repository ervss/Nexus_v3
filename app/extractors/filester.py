import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List
from urllib.parse import parse_qs, unquote, urlencode, urljoin, urlparse, urlunparse

import httpx
from bs4 import BeautifulSoup

from .base import VideoExtractor

logger = logging.getLogger(__name__)


# ── FileDitch proof-of-work challenge ────────────────────────────────────────
# fileditchfiles.* now gates every direct file behind a hashcash-style PoW: the
# viewer page ships an anti-bot HTML shell whose inline JS mines a SHA-256 nonce
# with N leading zero bits, POSTs it back with the signed challenge fields, and
# only then does the server return the real player HTML — where the signed CDN
# link (freakingfileditch.me/…?md5=…&expires=…) is split across a JS array and
# reassembled with .join(""). We replicate that here so no browser is needed.
_POW_CHALLENGE_RE = re.compile(r'challenge\s*=\s*"([0-9a-f]+)"\s*,\s*diff\s*=\s*(\d+)')
_POW_SPLIT_URL_RE = re.compile(r'var\s+u\s*=\s*\[(.*?)\]\.join\(\s*""\s*\)', re.S)


def _pow_has_challenge(html: str) -> bool:
    return bool(_POW_CHALLENGE_RE.search(html or ""))


def _pow_leading_zero_bits_ok(digest: bytes, need: int) -> bool:
    """Mirror of the site's leadingZeroBits(): first `need` bits of digest are 0."""
    full, rem = need >> 3, need & 7
    if any(digest[i] for i in range(full)):
        return False
    if rem and (digest[full] & ((0xFF << (8 - rem)) & 0xFF)):
        return False
    return True


def _pow_solve(challenge: str, diff: int, max_tries: int = 5_000_000) -> Optional[int]:
    """Find a nonce so sha256(f'{challenge}:{nonce}') has `diff` leading zero bits.
    diff=18 solves in well under a second; the cap guards against a moved goalpost."""
    prefix = (challenge + ":").encode()
    for nonce in range(max_tries):
        if _pow_leading_zero_bits_ok(hashlib.sha256(prefix + str(nonce).encode()).digest(), diff):
            return nonce
    return None


def _pow_reassemble_signed_url(html: str) -> str:
    """Rebuild the signed CDN URL from the `var u = [..].join("")` obfuscation."""
    m = _POW_SPLIT_URL_RE.search(html or "")
    if not m:
        return ""
    parts = re.findall(r'"([^"]*)"', m.group(1))
    return "".join(parts).replace("\\/", "/")


# ── FileDitch's newer WebAssembly PoW shell ──────────────────────────────────
# Some time after the SHA-256 hashcash above was written, fileditchfiles.*
# swapped it for a `<script type="module">` that imports /pow/powwasm.js,
# runs an obfuscated (renamed-identifier) WASM-backed proof-of-work, and
# auto-submits a hidden form once solved — landing back on the SAME url with
# the real Plyr player server-rendered into the page. `_POW_CHALLENGE_RE`
# never matches this shell (there is no `challenge="..."` string to find), so
# the old solver silently no-ops and the broad CDN-url regexes in
# `_scrape_direct_viewer` end up matching a stray self-link instead of a real
# stream — this is what showed up as "stream_url == the page's own url".
# Reverse-engineering the WASM isn't worth it: a real headless browser solves
# it in ~1-2s just by loading the page, so that's what this does instead —
# same approach already used for VK's JS challenge in vk_ko_discovery.py.
_WASM_SHELL_MARKERS = ("verifying-overlay", "/pow/powwasm.js")

# FileDitch rotates public viewer and short-link hosts.  They all serve the
# same file viewer / proof-of-work flow, so treat them as one provider rather
# than mistaking an .mp4-looking viewer page for a direct media file.
_FILEDITCH_HOST_SUFFIXES = (
    "fileditchfiles.st",
    "fileditchfiles.me",
    "fileditchvids.st",
    "theditch.st",
    "embedditch.st",
    "fileditchhot.st",
    "fileditch.com",
    "itsfileditchfiles.st",
    "freakingfileditch.me",
    "blehpooffileditchvidsstuff.org",
    "donotsharethesetemplinksyouidiot.st",
)


def _fileditch_clean_path(url: str) -> str:
    parsed = urlparse(url)
    path = parsed.path or ""
    if "/file.php" in path:
        path = parse_qs(parsed.query).get("f", [""])[0] or path
    if path.startswith("/api/"):
        path = path[4:]
    if not path.startswith("/"):
        path = "/" + path
    return path


async def _fetch_fileditch_status_api(clean_path: str) -> Optional[dict]:
    """Call FileDitch's official fast /api/<folder>/<id>/<filename> status endpoint.
    Returns dict with {file, status, size, short_link, uploaded} or None.
    """
    if not clean_path or clean_path == "/" or "/d/" in clean_path or "/f/" in clean_path:
        return None
    for host in ("fileditchvids.st", "fileditchfiles.st"):
        api_url = f"https://{host}/api{clean_path}"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(6.0, connect=3.0), follow_redirects=True, verify=False) as client:
                resp = await client.get(api_url)
                if resp.status_code == 200:
                    data = resp.json()
                    if isinstance(data, dict) and "status" in data:
                        return data
        except Exception as exc:
            logger.debug("FileDitch status API failed on %s: %s", host, exc)
    return None


async def _resolve_theditch_shortlink(url: str) -> Optional[str]:
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=True, verify=False) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                m = re.search(r'https?://(?:[a-z0-9-]+\.)*(?:fileditchvids|fileditchfiles|embedditch)\.[a-z]+/[^"\'\s<>]+\.(?:mp4|mkv|webm|avi|mov|m4v)', resp.text, re.I)
                if m:
                    return m.group(0)
    except Exception as exc:
        logger.debug("Failed to resolve theditch shortlink %s: %s", url, exc)
    return None


def is_fileditch_url(url: str) -> bool:
    """Whether *url* belongs to any current FileDitch viewer/CDN hostname."""
    try:
        host = (urlparse(str(url or "")).hostname or "").lower().rstrip(".")
    except ValueError:
        return False
    return any(host == suffix or host.endswith("." + suffix) for suffix in _FILEDITCH_HOST_SUFFIXES)


def _pow_has_wasm_shell(html: str) -> bool:
    return any(marker in (html or "") for marker in _WASM_SHELL_MARKERS)


def _load_async_playwright():
    from playwright.async_api import async_playwright
    return async_playwright


async def _solve_fileditch_wasm_pow(url: str, cookie_file: str = "") -> dict:
    """Load a FileDitch pretty-URL page in a real headless browser and read
    back the resolved `<video><source src>` once its own WASM PoW clears.

    Returns {} on any failure (missing Playwright, timeout, no video found) —
    callers must keep whatever they already scraped as a fallback.
    """
    try:
        async_playwright = _load_async_playwright()
    except Exception as exc:
        logger.warning("FileDitch WASM PoW: Playwright unavailable (%s)", exc)
        return {}

    target_url = url
    if is_fileditch_url(url):
        clean_p = _fileditch_clean_path(url)
        target_url = f"https://fileditchvids.st{clean_p}?fdg=1"

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=["--disable-blink-features=AutomationControlled"],
            )
            try:
                context = await browser.new_context(
                    user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
                    viewport={"width": 1280, "height": 800},
                    locale="en-US",
                )
                # The PoW page validates its result server-side. Keep Chromium's
                # automation flag out of that browser fingerprint so a valid
                # solve is not rejected as a 429 after the form submission.
                await context.add_init_script(
                    "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
                )
                browser_cookies = _load_playwright_cookies(cookie_file)
                if browser_cookies:
                    await context.add_cookies(browser_cookies)
                page = await context.new_page()

                captured_streams = []
                def _on_response(r):
                    if r.status in (200, 206) and any(x in r.url.lower() for x in (".mp4", ".mkv", ".webm", "staysharpwakesat5am", "xyz/")):
                        captured_streams.append(r.url)
                page.on("response", _on_response)

                await page.goto(target_url, wait_until="domcontentloaded", timeout=20000)

                # The WASM solve submits a form and navigates this same page.
                # page.evaluate() can land exactly between the old and new
                # document and raise "Execution context was destroyed".  That
                # is expected progress, not an extraction failure, so keep
                # polling across the navigation until the real player appears.
                stream_url = ""
                for _ in range(35):
                    try:
                        stream_url = await page.evaluate(
                            "() => document.querySelector('video source')?.src "
                            "|| document.querySelector('video')?.src "
                            "|| document.querySelector('video')?.currentSrc || ''"
                        )
                    except Exception as exc:
                        logger.debug("FileDitch WASM PoW navigation in progress for %s: %s", target_url, exc)
                    if stream_url and not stream_url.startswith("blob:"):
                        break
                    await page.wait_for_timeout(500)

                if not stream_url and captured_streams:
                    stream_url = captured_streams[-1]

                if not stream_url:
                    return {}

                page_text = await page.evaluate("() => document.body.innerText || ''")
                size_bytes = _parse_size_bytes(page_text)
                title = ""
                doc_title = await page.title()
                if doc_title and not any(bad in doc_title.lower() for bad in ("just a moment", "cloudflare", "fileditch", "520", "error")):
                    title = re.sub(r'\.(mp4|mkv|webm|avi|mov|m4v|ts)$', '', doc_title, flags=re.I).strip()
                if not title or title.lower() in ("dismiss", "close", "file viewer", "file"):
                    title_el = await page.query_selector('.pathline, [title]')
                    if title_el:
                        cand = (await title_el.get_attribute("title") or await title_el.inner_text() or "").strip()
                        if cand and cand.lower() not in ("dismiss", "close"):
                            title = cand

                return {"stream_url": stream_url, "size_bytes": size_bytes, "title": title}
            finally:
                await browser.close()
    except Exception as exc:
        logger.warning("FileDitch WASM PoW solve failed for %s: %s", target_url, exc)
        return {}


def _guess_resolution_from_name(name: str):
    """Extract width/height hints from filename like 2160p, 1080p, 720p.

    Uses non-word-boundary edges (?<![A-Z0-9]) / (?![A-Z0-9]) instead of \\b so it
    also matches glued prefixes Filester uses, e.g. "source4k_..." or "1080p_rb-...".
    """
    t = (name or "").upper()
    # left edge: not preceded by a digit (avoids matching "11080p"); allows letters like "SOURCE4K"
    L = r'(?<![0-9])'
    R = r'(?![A-Z0-9])'
    if re.search(L + r'(4K|2160P|UHD)' + R, t):
        return 3840, 2160
    if re.search(L + r'(1440P|2K)' + R, t):
        return 2560, 1440
    if re.search(L + r'(1080P|FHD)' + R, t):
        return 1920, 1080
    if re.search(L + r'(720P)' + R, t) or re.search(r'\bHD\b', t):
        return 1280, 720
    if re.search(L + r'(480P)' + R, t):
        return 854, 480
    if re.search(L + r'(360P)' + R, t):
        return 640, 360
    return 0, 0


def _parse_duration(text: str) -> float:
    """Parse 'HH:MM:SS' or 'MM:SS' string into seconds."""
    if not text:
        return 0.0
    parts = text.strip().split(":")
    try:
        parts = [int(p) for p in parts]
        if len(parts) == 3:
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
        if len(parts) == 2:
            return parts[0] * 60 + parts[1]
        if len(parts) == 1:
            return float(parts[0])
    except Exception:
        pass
    return 0.0


def _parse_size_bytes(text: str) -> int:
    """Parse '5.27 GB', '320 MB' etc. into bytes."""
    if not text:
        return 0
    m = re.search(r'([\d.]+)\s*(TB|GB|MB|KB|B)\b', text, re.I)
    if not m:
        return 0
    n = float(m.group(1))
    u = m.group(2).upper()
    mult = {'B': 1, 'KB': 1024, 'MB': 1024**2, 'GB': 1024**3, 'TB': 1024**4}
    return int(n * mult.get(u, 1))


def _normalize_upload_date(value: Any) -> str:
    """Return a comparable UTC timestamp for dates exposed on public cards."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    if raw.isdigit() and 9 <= len(raw) <= 13:
        try:
            seconds = int(raw) / (1000 if len(raw) == 13 else 1)
            return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return ""

    normalized = raw.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        parsed = None
        for fmt in (
            "%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y",
            "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y",
        ):
            try:
                parsed = datetime.strptime(raw, fmt)
                break
            except ValueError:
                continue
    if parsed is None:
        return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _upload_date_from_fields(data: Dict[str, Any]) -> str:
    for key in ("created_at", "uploaded_at", "upload_date", "upload_time", "date_uploaded", "date_created", "datePublished", "dateCreated", "uploadDate"):
        parsed = _normalize_upload_date(data.get(key))
        if parsed:
            return parsed
    return ""


def _extract_page_uploaded_at(soup: Any) -> str:
    for tag in soup.select('meta[property="article:published_time"], meta[property="video:release_date"], meta[itemprop="uploadDate"], meta[itemprop="datePublished"], time[datetime], [data-uploaded-at], [data-created-at], [data-upload-date]'):
        parsed = _normalize_upload_date(tag.get("content") or tag.get("datetime") or tag.get("data-uploaded-at") or tag.get("data-created-at") or tag.get("data-upload-date"))
        if parsed:
            return parsed
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            payload = json.loads(script.string or "")
        except (TypeError, ValueError):
            continue
        entries = payload if isinstance(payload, list) else [payload]
        for entry in entries:
            if isinstance(entry, dict):
                parsed = _upload_date_from_fields(entry)
                if parsed:
                    return parsed
    return ""


def _extract_card_uploaded_at(card: Any) -> str:
    """Read upload/creation time without depending on one Filester markup version."""
    candidates: List[str] = []
    time_node = card.select_one("time")
    if time_node:
        candidates.extend([time_node.get("datetime", ""), time_node.get_text(" ", strip=True)])
    for attr in ("data-uploaded-at", "data-created-at", "data-date", "data-timestamp"):
        if card.get(attr):
            candidates.append(card.get(attr))
        attr_node = card.select_one(f"[{attr}]")
        if attr_node and attr_node.get(attr):
            candidates.append(attr_node.get(attr))
    date_node = card.select_one(".file-date, .upload-date, .uploaded-at, .created-at, [class*='date']")
    if date_node:
        candidates.append(date_node.get_text(" ", strip=True))

    card_text = card.get_text(" ", strip=True)
    date_match = re.search(
        r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
        r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
        r"\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}",
        card_text,
        re.I,
    )
    if date_match:
        candidates.append(date_match.group(0))

    for candidate in candidates:
        parsed = _normalize_upload_date(candidate)
        if parsed:
            return parsed
    return ""


def _guess_content_type(name: str, stream_url: str) -> str:
    value = f"{name or ''} {stream_url or ''}".lower()
    if ".m3u8" in value:
        return "application/vnd.apple.mpegurl"
    if ".webm" in value:
        return "video/webm"
    if ".mkv" in value:
        return "video/x-matroska"
    return "video/mp4"


def _load_api_key() -> str:
    """Load Filester official API key from env or key file."""
    import os
    from pathlib import Path

    key = os.getenv("FILESTER_API_KEY", "").strip()
    if key:
        return key

    repo_root = Path(__file__).resolve().parents[2]
    for candidate in [
        repo_root / "filester_api_key.txt",
        repo_root / "app" / "filester_api_key.txt",
        Path("filester_api_key.txt"),
    ]:
        try:
            if candidate.is_file():
                k = candidate.read_text(encoding="utf-8").strip()
                if k:
                    return k
        except Exception:
            pass
    return ""


async def _filester_api_get_file(slug: str, api_key: str) -> Optional[Dict[str, Any]]:
    """Try the official Filester API for a file. Returns None if not found (e.g. other user's file)."""
    if not api_key or not slug:
        return None
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
    }
    try:
        async with httpx.AsyncClient(timeout=10, verify=False, follow_redirects=True) as client:
            r = await client.get(f"https://u1.filester.me/api/v1/file/{slug}", headers=headers)
            if r.status_code == 200:
                data = r.json()
                return data.get("data") or data
    except Exception as e:
        logger.debug("Filester API file lookup failed for %s: %s", slug, e)
    return None


async def _filester_api_get_folder_files(folder_id: str, api_key: str) -> List[Dict[str, Any]]:
    """Try the official Filester API for folder files. Returns [] if not found."""
    if not api_key or not folder_id:
        return []
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
    }
    try:
        async with httpx.AsyncClient(timeout=15, verify=False, follow_redirects=True) as client:
            r = await client.get(
                f"https://u1.filester.me/api/v1/folder/{folder_id}/files",
                headers=headers,
            )
            if r.status_code == 200:
                data = r.json()
                files = data.get("data") or []
                return files if isinstance(files, list) else []
    except Exception as e:
        logger.debug("Filester API folder lookup failed for %s: %s", folder_id, e)
    return []


def _build_cookie_search_paths(extra_paths: list | None = None) -> list:
    """Return ordered list of file paths to check for Filester cookies.

    Priority:
    1. FILESTER_COOKIE_FILE env var (explicit override — set this to forget about path guessing)
    2. Paths provided by the caller (repo-relative candidates)
    3. Downloads folder — newest .txt file that contains 'filester' or 'auth_token' in name/content
    """
    import os
    from pathlib import Path

    paths = []

    # 1. Explicit env override
    env_path = os.getenv("FILESTER_COOKIE_FILE", "").strip()
    if env_path:
        paths.append(env_path)

    # 2. Caller-supplied candidates
    if extra_paths:
        paths.extend(extra_paths)

    # 3. Auto-scan Downloads folder — pick the newest .txt that looks like a cookie file
    downloads = Path.home() / "Downloads"
    if downloads.is_dir():
        candidates = sorted(
            [p for p in downloads.glob("*.txt") if p.is_file()],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for p in candidates[:20]:  # only check the 20 newest
            name_low = p.name.lower()
            if any(kw in name_low for kw in ("filester", "auth", "cookie")):
                paths.append(str(p))
                continue
            # Peek first 200 bytes to see if it looks like a Netscape cookie file for filester
            try:
                with open(p, "r", encoding="utf-8", errors="ignore") as fh:
                    head = fh.read(200)
                if "filester" in head.lower() or ("auth_token" in head and "Netscape" in head):
                    paths.append(str(p))
            except Exception:
                pass

    return paths


def _load_cookies_from_paths(cookie_paths: list) -> dict:
    """Try loading Netscape-format cookies; fallback to raw semicolon-separated pairs."""
    import os
    cookies = {}
    all_paths = _build_cookie_search_paths(cookie_paths)
    for cookie_path in all_paths:
        if not os.path.exists(cookie_path):
            continue
        # Try MozillaCookieJar (Netscape format)
        try:
            import http.cookiejar
            jar = http.cookiejar.MozillaCookieJar(cookie_path)
            jar.load(ignore_discard=True, ignore_expires=True)
            found = {c.name: c.value for c in jar if "filester" in c.domain.lower()}
            if found:
                cookies.update(found)
                logger.info("Loaded %d Netscape Filester cookies from %s", len(found), cookie_path)
                return cookies
        except Exception as e:
            # Fallback: raw semicolon-separated
            try:
                with open(cookie_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read().strip()
                if content and "=" in content and not content.startswith("#"):
                    for pair in content.replace("\n", "").strip().split(";"):
                        if "=" in pair:
                            k, v = pair.strip().split("=", 1)
                            cookies[k.strip()] = v.strip()
                    if cookies:
                        logger.info("Loaded %d raw cookies from %s (fallback)", len(cookies), cookie_path)
                        return cookies
            except Exception as raw_exc:
                logger.warning("Raw cookie parse failed for %s: %s", cookie_path, raw_exc)
            logger.warning("Failed to load cookies from %s via MozillaCookieJar: %s", cookie_path, e)
    return cookies


def _load_playwright_cookies(cookie_path: str) -> list[dict]:
    """Load a Netscape cookie jar in Playwright's cookie format."""
    import http.cookiejar
    import os

    if not cookie_path or not os.path.exists(cookie_path):
        return []
    try:
        jar = http.cookiejar.MozillaCookieJar(cookie_path)
        jar.load(ignore_discard=True, ignore_expires=True)
        return [
            {
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path or "/",
                "secure": bool(cookie.secure),
                "expires": cookie.expires or -1,
            }
            for cookie in jar
            if cookie.domain
        ]
    except Exception as exc:
        logger.warning("Failed to load FileDitch browser cookies: %s", exc)
        return []


def _fetch_bytes_range(cdn_url: str, headers: dict, start: int, end: int) -> bytes:
    """Fetch a byte range from CDN via httpx sync client."""
    import httpx as _httpx
    range_headers = {**headers, "Range": f"bytes={start}-{end}"}
    with _httpx.Client(verify=False, follow_redirects=True, timeout=30) as client:
        r = client.get(cdn_url, headers=range_headers)
        if r.status_code in (200, 206):
            return r.content
    return b""


def _ffprobe_stdin(data: bytes) -> float:
    """Run ffprobe on bytes via stdin, return duration or 0."""
    import subprocess as _sp
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration:stream=duration",
        "-of", "json",
        "-analyzeduration", "30000000",
        "-probesize", "30000000",
        "pipe:0",
    ]
    try:
        r = _sp.run(cmd, input=data, capture_output=True, timeout=20)
        parsed = json.loads(r.stdout.decode("utf-8", errors="replace") or "{}")
        streams = parsed.get("streams", [])
        durations = [float(s["duration"]) for s in streams if s.get("duration")]
        if durations:
            return max(durations)
        fmt_dur = parsed.get("format", {}).get("duration")
        if fmt_dur:
            return float(fmt_dur)
    except Exception:
        pass
    return 0.0


def _probe_duration_sync(cdn_url: str, referer: str, max_bytes: int = 8 * 1024 * 1024) -> float:
    """Fetch bytes from CDN via httpx (sync) and pipe to ffprobe stdin.

    Tries first 8MB (for faststart MP4), then falls back to last 4MB
    (for non-faststart MP4 where moov atom is at the end).
    """
    import shutil
    import httpx as _httpx

    if not shutil.which("ffprobe"):
        return 0.0

    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    base_headers = {"Referer": referer, "User-Agent": ua}

    try:
        # Pass 1: probe first max_bytes
        data_start = _fetch_bytes_range(cdn_url, base_headers, 0, max_bytes - 1)
        if not data_start:
            return 0.0

        dur = _ffprobe_stdin(data_start)
        if dur > 0:
            return dur

        # Pass 2: moov atom might be at end — get Content-Length then fetch last 4MB
        tail_bytes = 4 * 1024 * 1024
        with _httpx.Client(verify=False, follow_redirects=True, timeout=15) as client:
            head = client.head(cdn_url, headers=base_headers)
            content_length = int(head.headers.get("content-length", 0))

        if content_length > max_bytes + tail_bytes:
            tail_start = content_length - tail_bytes
            data_tail = _fetch_bytes_range(cdn_url, base_headers, tail_start, content_length - 1)
            if data_tail:
                # Combine: beginning + end (ffprobe can stitch partial boxes)
                dur = _ffprobe_stdin(data_start + data_tail)
                if dur > 0:
                    return dur
                # Try tail alone
                dur = _ffprobe_stdin(data_tail)
                if dur > 0:
                    return dur

    except Exception as e:
        logger.debug("_probe_duration_sync failed for %s: %s", cdn_url[:80], e)
    return 0.0


async def _probe_duration_via_httpx(cdn_url: str, referer: str, max_bytes: int = 8 * 1024 * 1024) -> float:
    """Async wrapper: runs sync probe in thread executor to avoid blocking the event loop."""
    import asyncio
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _probe_duration_sync, cdn_url, referer, max_bytes)


class FilesterExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "Filester"

    @staticmethod
    def source_label(url: str) -> str:
        """Return the real public host brand handled by this shared extractor."""
        return "FileDitch" if is_fileditch_url(url) else "Filester"

    def can_handle(self, url: str) -> bool:
        u = (url or "").lower()
        is_fileditch_host = is_fileditch_url(url)
        is_filester_host = "filester." in u or is_fileditch_host
        # /d/<slug>  — individual file page (slug-based)
        # /f/<slug>  — folder page
        # /file.php?f=... — legacy direct file viewer
        # /<bucket>/<filename>.mp4 — pretty URL redirect target
        has_file_path = (
            "/d/" in u
            or "/f/" in u
            or "/file.php" in u
            or re.search(r"/[a-z0-9_-]{2,8}/[A-Za-z0-9_%-]{4,}", u) is not None
            or re.search(r"/[^/]+\.(?:mp4|mkv|webm|avi|mov|m4v|ts)(?:[?#]|$)", u) is not None
        )
        # theditch.st uses a one-segment short URL (e.g. /z6nevvdy) that
        # redirects to fileditchvids.st.  Permit it so the HTTP client can
        # follow the redirect and process the real viewer page.
        is_fileditch_short_url = is_fileditch_host and bool(urlparse(url).path.strip("/"))
        return is_filester_host and (has_file_path or is_fileditch_short_url)

    @staticmethod
    def _is_direct_file_viewer(url: str) -> bool:
        """Returns True for /file.php?f=... and pretty /<bucket>/<file>.mp4 URLs."""
        u = (url or "").lower()
        if "/file.php" in u:
            return True
        # pretty URL: /<alphanum-bucket>/<filename> but NOT /d/ or /f/ slugs
        if "/d/" not in u and "/f/" not in u:
            m = re.search(r"/[a-z0-9_-]{2,8}/[A-Za-z0-9._%_-]{5,}", u)
            if m:
                return True
            if re.search(r"/[^/]+\.(?:mp4|mkv|webm|avi|mov|m4v|ts)(?:[?#]|$)", u):
                return True
        return False

    @staticmethod
    def _extract_slug(url: str) -> Optional[str]:
        m = re.search(r"/d/([A-Za-z0-9_-]+)", url or "", re.I)
        return m.group(1) if m else None

    @staticmethod
    def _extract_folder_slug(url: str) -> Optional[str]:
        m = re.search(r"/f/([A-Za-z0-9_-]+)", url or "", re.I)
        return m.group(1) if m else None

    @staticmethod
    def _cache_origin_from_page(url: str) -> str:
        parsed = urlparse(url)
        scheme = parsed.scheme or "https"
        netloc = parsed.netloc or "filester.me"
        # fileditchfiles uses alpha7.fileditchfiles.me etc.; filester uses cache1.filester.me
        if is_fileditch_url(url):
            return f"{scheme}://alpha7.{netloc.lstrip('www.')}"
        return f"{scheme}://cache1.filester.me"

    @staticmethod
    def _scrape_page_meta(html: str, page_url: str) -> dict:
        """Extract title, thumbnail, duration, size from Filester HTML page."""
        soup = BeautifulSoup(html, "html.parser")
        meta = {}

        # --- Title ---
        # Filester puts the actual filename as the <title> (before " | filester")
        title = ""
        title_tag = soup.find("title")
        if title_tag and title_tag.string:
            # "SheLovesBlack.2024.mp4 | filester.me" -> "SheLovesBlack.2024.mp4"
            title = re.split(r'\s*[|\-]\s*filester', title_tag.string, flags=re.I)[0].strip()

        # Fallback: og:title
        if not title:
            og = soup.find("meta", property="og:title") or soup.find("meta", attrs={"name": "og:title"})
            if og:
                title = re.split(r'\s*[|\-]\s*filester', og.get("content", ""), flags=re.I)[0].strip()

        # Fallback: first h1/h2 that doesn't contain "filester" brand
        if not title or "filester" in title.lower():
            for tag in soup.find_all(["h1", "h2", "h3"]):
                t = tag.get_text(strip=True)
                if t and "filester" not in t.lower() and len(t) > 3:
                    title = t
                    break

        # Strip file extension — Filester uses raw filename as title
        title = re.sub(r'\.(mp4|mkv|webm|avi|mov|m4v|ts)$', '', title, flags=re.I).strip()

        # Extract quality hint from trailing (2160) / (1080) etc. before stripping it
        _quality_hint = 0
        _qm = re.search(r'\((\d{3,4})\)\s*$', title)
        if _qm:
            _quality_hint = int(_qm.group(1))
            title = title[:_qm.start()].strip()

        # Strip "SITENAME.COM - [id] " uploader prefix injected into filenames
        title = re.sub(r'^[A-Z][A-Z0-9]+\.COM\s*[-–]\s*(?:\[[A-Za-z0-9]+\]\s*)?', '', title).strip()

        meta["title"] = title
        meta["_quality_hint_height"] = _quality_hint
        meta["uploaded_at"] = _extract_page_uploaded_at(soup)

        # --- Thumbnail ---
        thumb = ""
        og_img = soup.find("meta", property="og:image")
        if og_img:
            thumb = og_img.get("content", "").strip()
        if not thumb:
            vid = soup.find("video", poster=True)
            if vid:
                thumb = vid.get("poster", "").strip()
        if thumb and thumb.startswith("//"):
            thumb = "https:" + thumb
        meta["thumbnail"] = thumb

        # --- Duration ---
        # Video player duration is in the <video> element or in a time display element
        duration = 0.0
        vid_el = soup.find("video")
        if vid_el and vid_el.get("data-duration"):
            try:
                duration = float(vid_el["data-duration"])
            except Exception:
                pass
        if not duration:
            # Look for a time text like "33:58" or "1:33:58" in page
            time_els = soup.find_all(string=re.compile(r'^\s*\d{1,2}:\d{2}(:\d{2})?\s*$'))
            for t in time_els:
                d = _parse_duration(t.strip())
                if d > 0:
                    duration = d
                    break
        if not duration:
            # og:video:duration (seconds)
            og_dur = soup.find("meta", property="og:video:duration")
            if og_dur:
                try:
                    duration = float(og_dur.get("content", 0))
                except Exception:
                    pass

        if not duration:
            # data-duration / data-length / data-time attributes on any element
            for attr in ("data-duration", "data-length", "data-time"):
                for tag in soup.find_all(attrs={attr: True}):
                    try:
                        d = float(tag[attr])
                        if d > 0:
                            duration = d
                            break
                    except (TypeError, ValueError):
                        pass
                if duration:
                    break

        if not duration:
            # JSON-LD: VideoObject with ISO 8601 duration like PT33M58S
            for script in soup.find_all("script", type="application/ld+json"):
                try:
                    ld = json.loads(script.string or "")
                    entries = ld if isinstance(ld, list) else [ld]
                    for entry in entries:
                        iso = str(entry.get("duration") or "")
                        if iso:
                            m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?', iso, re.I)
                            if m and any(m.group(i) for i in (1, 2, 3)):
                                d = int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + float(m.group(3) or 0)
                                if d > 0:
                                    duration = d
                                    break
                    if duration:
                        break
                except Exception:
                    pass

        if not duration:
            # JavaScript variables in <script> tags: "duration":2038 or duration: 2038
            for script in soup.find_all("script"):
                src = script.string or ""
                if not src:
                    continue
                m = re.search(r'"duration"\s*:\s*(\d+(?:\.\d+)?)', src)
                if not m:
                    m = re.search(r'\bduration\s*[:=]\s*(\d+(?:\.\d+)?)', src)
                if m:
                    d = float(m.group(1))
                    if 10 < d < 86400:
                        duration = d
                        break

        meta["duration"] = duration

        # --- File size ---
        size_bytes = 0
        # Look for text like "5.27 GB" anywhere on page
        body_text = soup.get_text(" ", strip=True)
        m = re.search(r'([\d.]+)\s*(TB|GB|MB|KB)\b', body_text, re.I)
        if m:
            size_bytes = _parse_size_bytes(m.group(0))
        meta["size_bytes"] = size_bytes

        # --- fileUUID from inline script (used to build p1.filester.me URL) ---
        uuid_m = re.search(r'window\.fileUUID\s*=\s*["\']([a-f0-9\-]{36})["\']', html, re.I)
        if uuid_m:
            meta["file_uuid"] = uuid_m.group(1)

        # --- Resolution from filename ---
        width, height = _guess_resolution_from_name(meta.get("title", ""))
        # Fall back to quality hint parsed from (2160)/(1080) suffix in original filename
        if not height and meta.get("_quality_hint_height"):
            height = meta["_quality_hint_height"]
            width = {2160: 3840, 1440: 2560, 1080: 1920, 720: 1280, 480: 854}.get(height, 0)
        meta["width"] = width
        meta["height"] = height

        return meta

    @staticmethod
    def _scrape_folder_items(html: str, page_url: str, source_url: str) -> List[Dict[str, Any]]:
        """Extract /d/<slug> file pages from a Filester folder page."""
        soup = BeautifulSoup(html, "html.parser")
        items: List[Dict[str, Any]] = []
        seen = set()

        for card in soup.select(".file-item"):
            onclick = (card.get("onclick") or "").strip()
            href = ""
            match = re.search(r"['\"](?P<href>/d/[A-Za-z0-9_-]+)['\"]", onclick)
            if match:
                href = match.group("href")
            if not href:
                anchor = card.select_one("a[href*='/d/']")
                if anchor:
                    href = anchor.get("href", "").strip()
            if not href:
                continue

            file_url = urljoin(page_url, href)
            if file_url in seen:
                continue
            seen.add(file_url)

            title = ""
            title_el = card.select_one(".file-name")
            if title_el:
                title = title_el.get_text(" ", strip=True)

            thumb = ""
            img = card.select_one("img[src]")
            if img:
                thumb = urljoin(page_url, img.get("src", "").strip())

            size_bytes = 0
            raw_size = card.get("data-size")
            if raw_size:
                try:
                    size_bytes = int(raw_size)
                except (TypeError, ValueError):
                    size_bytes = 0

            _w, _h = _guess_resolution_from_name(title or file_url.rsplit("/", 1)[-1])
            items.append({
                "url": file_url,
                "title": title or file_url.rsplit("/", 1)[-1],
                "thumbnail": thumb,
                "size_bytes": size_bytes,
                "uploaded_at": _extract_card_uploaded_at(card),
                "width": _w,
                "height": _h,
                "source_url": file_url,
                "folder_source_url": source_url,
            })

        return items

    @staticmethod
    def _detect_folder_pages(html: str, page_url: str) -> tuple[int, Dict[int, str]]:
        soup = BeautifulSoup(html, "html.parser")
        page_numbers = {1}
        page_urls: Dict[int, str] = {}

        def _page_from_candidate(candidate: str) -> int:
            if not candidate:
                return 0
            try:
                parsed = urlparse(urljoin(page_url, candidate))
                for key in ("page", "p", "pg", "files_page"):
                    value = parse_qs(parsed.query).get(key, [None])[0]
                    if value and str(value).isdigit():
                        return int(value)
                path = parsed.path.rstrip("/")
                match = re.search(r"/page/(\d+)$", path, re.I) or re.search(r"/(\d+)$", path)
                if match:
                    return int(match.group(1))
            except Exception:
                return 0
            return 0

        for node in soup.select("a[href], [onclick]"):
            raw = (node.get("href") or node.get("onclick") or "").strip()
            if not raw:
                continue
            page_num = _page_from_candidate(raw)
            if not page_num:
                text = node.get_text(" ", strip=True)
                if text.isdigit():
                    page_num = int(text)
            if page_num > 0:
                page_numbers.add(page_num)
                try:
                    page_urls.setdefault(page_num, urljoin(page_url, raw))
                except Exception:
                    pass

        page_text = soup.get_text(" ", strip=True)
        ratio_match = re.search(r"\b(\d{1,4})\s*/\s*(\d{1,4})\b", page_text)
        if ratio_match:
            page_numbers.add(int(ratio_match.group(1)))
            page_numbers.add(int(ratio_match.group(2)))

        sane_pages = [n for n in page_numbers if 0 < n <= 9999]
        return (max(sane_pages) if sane_pages else 1), page_urls

    @staticmethod
    def _build_folder_page_url(base_url: str, page_num: int, strategy: str) -> str:
        parsed = urlparse(base_url)
        query = parse_qs(parsed.query, keep_blank_values=True)
        path = parsed.path.rstrip("/")

        if strategy in {"page", "p", "files_page"}:
            query[strategy] = [str(page_num)]
            return urlunparse(parsed._replace(query=urlencode(query, doseq=True)))

        if re.search(r"/page/\d+$", path, re.I):
            path = re.sub(r"/page/\d+$", f"/page/{page_num}", path, flags=re.I)
        else:
            path = f"{path}/page/{page_num}"
        return urlunparse(parsed._replace(path=path, query=urlencode(query, doseq=True)))

    async def extract_folder(self, url: str, *, require_complete: bool = False) -> List[Dict[str, Any]]:
        """Extract file page URLs and light metadata from a Filester folder page."""
        folder_slug = self._extract_folder_slug(url)
        if not folder_slug:
            return []

        # Try official API first (works for own folders)
        api_key = _load_api_key()
        # Radar needs verified pagination, not an API list of unknown completeness.
        api_files = [] if require_complete else await _filester_api_get_folder_files(folder_slug, api_key)
        if api_files:
            items = []
            for f in api_files:
                # Prefer short slug-based URL; skip UUID-based paths (internal refs, not publicly accessible)
                _fslug = str(f.get("slug") or "").strip()
                if _fslug and not re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-', _fslug, re.I):
                    file_url = f"https://filester.me/d/{_fslug}"
                else:
                    raw_url = str(f.get("url") or f.get("view_url") or f.get("download_url") or "").strip()
                    if raw_url.startswith("/"):
                        raw_url = "https://filester.me" + raw_url
                    # Skip if path segment looks like a UUID (not a public page)
                    path_part = raw_url.rsplit("/", 1)[-1] if "/" in raw_url else raw_url
                    if re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-', path_part, re.I):
                        continue
                    file_url = raw_url
                if not file_url or not file_url.startswith("http"):
                    continue
                raw_name = str(f.get("name") or "")
                clean_name = re.sub(r'\.(mp4|mkv|webm|avi|mov|m4v|ts)$', '', raw_name, flags=re.I).strip()
                thumb_path = str(f.get("thumbnail_url") or "")
                thumb = ("https://filester.me" + thumb_path) if thumb_path.startswith("/") else thumb_path
                _w, _h = _guess_resolution_from_name(raw_name or clean_name)
                items.append({
                    "url": file_url,
                    "title": clean_name or file_url.rsplit("/", 1)[-1],
                    "thumbnail": thumb,
                    "size_bytes": int(f.get("size") or 0),
                    "uploaded_at": _upload_date_from_fields(f),
                    "width": _w,
                    "height": _h,
                    "source_url": file_url,
                    "folder_source_url": url,
                })
            if len(items) >= 5:
                logger.info("Filester: API returned %d files for folder %s", len(items), folder_slug)
                return items
            elif items:
                logger.info("Filester: API returned only %d files for %s, supplementing with HTML", len(items), folder_slug)

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": url,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
        
        # Load Filester cookies if available
        from pathlib import Path
        repo_root = Path(__file__).resolve().parents[2]
        cookie_paths = [
            "filester.me_cookies.txt",
            str(repo_root / "filester.me_cookies.txt"),
            str(repo_root / "app" / "filester.me_cookies.txt"),
            "filester.cookies.txt",
            str(repo_root / "filester.cookies.txt"),
            str(repo_root / "app" / "filester.cookies.txt"),
            "cookies.txt",
            str(repo_root / "cookies.txt"),
            str(repo_root / "app" / "cookies.txt")
        ]
        cookies = _load_cookies_from_paths(cookie_paths)

        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True, verify=False, cookies=cookies) as client:
                resp = await client.get(url, headers=headers)
                if resp.status_code != 200:
                    if require_complete:
                        raise RuntimeError(f"HTTP {resp.status_code}: album sa nepodarilo načítať")
                    logger.warning("Filester folder fetch failed for %s with status %s", url, resp.status_code)
                    return []
                first_page_url = str(resp.url)
                items = self._scrape_folder_items(resp.text, first_page_url, url)
                seen_urls = {item.get("url") for item in items if item.get("url")}
                total_pages, explicit_page_urls = self._detect_folder_pages(resp.text, first_page_url)

                if total_pages > 1:
                    for page_num in range(2, total_pages + 1):
                        candidate_urls = []
                        if explicit_page_urls.get(page_num):
                            candidate_urls.append(explicit_page_urls[page_num])
                        for strategy in ("page", "p", "files_page", "path"):
                            candidate = self._build_folder_page_url(first_page_url, page_num, strategy)
                            if candidate:
                                candidate_urls.append(candidate)

                        page_loaded = False
                        for candidate_url in dict.fromkeys(candidate_urls):
                            try:
                                page_resp = await client.get(candidate_url, headers=headers)
                                if page_resp.status_code != 200:
                                    continue
                                page_items = self._scrape_folder_items(page_resp.text, str(page_resp.url), url)
                                fresh_items = [item for item in page_items if item.get("url") and item.get("url") not in seen_urls]
                                if fresh_items:
                                    for item in fresh_items:
                                        seen_urls.add(item["url"])
                                    items.extend(fresh_items)
                                    page_loaded = True
                                    break
                            except Exception:
                                continue
                        if not page_loaded:
                            if require_complete:
                                raise RuntimeError(f"Neúplný album: stránka {page_num}/{total_pages} sa nepodarila načítať")
                            break
                if require_complete:
                    counts = re.findall(r"(\d[\d\s,.]*)\s*files?\b", BeautifulSoup(resp.text, "html.parser").get_text(" ", strip=True), re.I)
                    expected = max((int(re.sub(r"\D", "", count)) for count in counts), default=0)
                    if expected > len(items):
                        raise RuntimeError(f"Neúplný album: načítaných {len(items)} z {expected} súborov")
                    if not items and not re.search(r"\b0\s+files?\b|folder is empty", resp.text, re.I):
                        raise RuntimeError("Album neobsahuje čitateľné súbory; môže byť nedostupný alebo vyžadovať prihlásenie")
                if items:
                    logger.info("Filester folder extracted %s items from %s", len(items), url)
                return items
        except Exception as e:
            logger.error("Filester folder extraction failed for %s: %s", url, e)
            if require_complete:
                raise
            return []

    async def probe_folder_metadata(self, url: str) -> Dict[str, Any]:
        """Read only the first public folder page for Radar metadata.

        This deliberately does not paginate or resolve streams: it is a quick
        review aid for a shortlist, not an import or a full folder sync.
        """
        if not self._extract_folder_slug(url):
            return {"url": url, "ok": False, "error": "invalid folder URL"}

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": url,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
        from pathlib import Path
        repo_root = Path(__file__).resolve().parents[2]
        cookies = _load_cookies_from_paths([
            "filester.me_cookies.txt", str(repo_root / "filester.me_cookies.txt"),
            str(repo_root / "app" / "filester.me_cookies.txt"), "filester.cookies.txt",
            str(repo_root / "filester.cookies.txt"), str(repo_root / "app" / "filester.cookies.txt"),
        ])
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True, verify=False, cookies=cookies) as client:
                response = await client.get(url, headers=headers)
            if response.status_code != 200:
                return {"url": url, "ok": False, "error": f"HTTP {response.status_code}"}

            soup = BeautifulSoup(response.text, "html.parser")
            text = soup.get_text(" ", strip=True)
            title = ""
            title_tag = soup.find("title")
            if title_tag:
                title = re.split(r"\s*[|–-]\s*filester", title_tag.get_text(" ", strip=True), flags=re.I)[0].strip()
            if not title or title.lower() == "filester.me":
                heading = soup.find(["h1", "h2"])
                title = heading.get_text(" ", strip=True) if heading else ""

            count_matches = re.findall(r"(\d[\d\s,.]*)\s*files?\b", text, re.I)
            counts = [int(re.sub(r"\D", "", value)) for value in count_matches if re.sub(r"\D", "", value)]
            file_count = max(counts, default=0)
            sizes = [_parse_size_bytes(match.group(0)) for match in re.finditer(r"\d+(?:[.,]\d+)?\s*(?:KB|MB|GB|TB)\b", text, re.I)]
            items = self._scrape_folder_items(response.text, str(response.url), url)
            preview_items = [{
                "url": item.get("url", ""),
                "title": item.get("title", ""),
                "thumbnail": item.get("thumbnail", ""),
                "size_bytes": int(item.get("size_bytes") or 0),
                "uploaded_at": item.get("uploaded_at", ""),
            } for item in items[:6]]
            latest_upload_at = max(
                (item.get("uploaded_at", "") for item in items if item.get("uploaded_at")),
                default="",
            )
            return {
                "url": url,
                "ok": True,
                "title": title,
                "file_count": file_count or len(items),
                "size_bytes": max(sizes, default=0),
                "preview_count": len(items),
                "latest_upload_at": latest_upload_at,
                "previews": preview_items,
                "checked_at": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as exc:
            logger.warning("Filester folder metadata probe failed for %s: %s", url, exc)
            return {"url": url, "ok": False, "error": str(exc)}

    async def search_folder_keyword(self, url: str, keyword: str) -> Dict[str, Any]:
        """Find a keyword in public file names across a folder, without importing it."""
        normalized_keyword = re.sub(r"[\W_]+", " ", str(keyword or ""), flags=re.UNICODE).casefold().strip()
        if not normalized_keyword:
            return {"url": url, "ok": False, "error": "missing keyword"}
        if not self._extract_folder_slug(url):
            return {"url": url, "ok": False, "error": "invalid folder URL"}
        try:
            items = await self.extract_folder(url, require_complete=True)
            matches = []
            matched_items = []
            seen = set()
            for item in items:
                title = str(item.get("title") or "")
                file_url = str(item.get("url") or "")
                name = title or unquote(urlparse(file_url).path.rsplit("/", 1)[-1])
                searchable = re.sub(r"[\W_]+", " ", name, flags=re.UNICODE).casefold()
                if normalized_keyword in searchable and file_url and file_url not in seen:
                    seen.add(file_url)
                    matches.append(name)
                    matched_items.append({
                        "url": file_url, "title": name,
                        "thumbnail": item.get("thumbnail") or "",
                        "size_bytes": int(item.get("size_bytes") or 0),
                        "uploaded_at": item.get("uploaded_at") or "",
                        "width": int(item.get("width") or 0),
                        "height": int(item.get("height") or 0),
                        "duration": float(item.get("duration") or 0),
                        "quality_inferred": True,
                    })
            return {
                "url": url,
                "ok": True,
                "scanned_files": len(items),
                "match_count": len(matches),
                "matches": matches[:12],
                "matched_items": matched_items,
                "checked_at": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as exc:
            logger.warning("Filester folder keyword search failed for %s: %s", url, exc)
            return {"url": url, "ok": False, "error": str(exc)}

    async def extract_album_entries(self, url: str) -> List[Dict[str, Any]]:
        """Expose Filester folders to tools that call album extractors."""
        return await self.extract_folder(url)

    async def extract_album(self, url: str) -> List[Dict[str, Any]]:
        """Backward-compatible alias for folder albums."""
        return await self.extract_folder(url)

    @staticmethod
    def _scrape_direct_viewer(html: str, page_url: str) -> dict:
        """
        Parse the simple fileditchfiles "File Viewer" page:
        /file.php?f=...  or  /<bucket>/<file>.mp4

        Returns dict with: stream_url, title, size_bytes, width, height, thumbnail
        """
        soup = BeautifulSoup(html, "html.parser")
        result = {"stream_url": "", "title": "", "size_bytes": 0,
                  "width": 0, "height": 0, "thumbnail": "", "duration": 0.0}

        page_url_clean = page_url.rstrip("/")

        def accept_stream(candidate: str) -> bool:
            candidate = urljoin(page_url, (candidate or "").strip())
            if not candidate or candidate.startswith("blob:"):
                return False
            if candidate.rstrip("/") == page_url_clean:
                return False
            result["stream_url"] = candidate
            return True

        # --- Stream URL: <video><source src="..."> ---
        for sel in ["video source[src]", "video[src]", "source[type='video/mp4']"]:
            el = soup.select_one(sel)
            if el:
                s = el.get("src", "")
                if accept_stream(("https:" + s) if s.strip().startswith("//") else s):
                    break

        # Fallback: signed CDN href (download link) — covers files with no extension in URL
        if not result["stream_url"]:
            for a in soup.select("a[href]"):
                href = a.get("href", "")
                if "donotsharethesetemplinksyouidiot.st" in href and "md5=" in href:
                    if accept_stream(href):
                        break

        # Fallback: any CDN mp4 link in raw HTML
        if not result["stream_url"]:
            for pat in [
                r'(https?://(?:\d+\.)?donotsharethesetemplinksyouidiot\.st/[^"\'<>\s]+(?:\?[^"\'<>\s]*)?)',
                r'(https?://\d+\.donotsharethesetemplinksyouidiot\.st/[^"\'<>\s]+\.(?:mp4|mkv|webm)(?:\?[^"\'<>\s]*)?)',
                r'(https?://[a-z0-9.-]+/[^"\'<>\s]+\.(?:mp4|mkv|webm)(?:\?[^"\'<>\s]*)?)',
            ]:
                m = re.search(pat, html, re.I)
                if m:
                    if accept_stream(m.group(1)):
                        break

        # --- Title: filename from .pathline or from URL path ---
        pathline = soup.select_one(".pathline")
        if pathline:
            # pathline text: "/alpha2/xxx/filename.mp4\n3.28 GB"
            # Extract the last path segment as title
            text = pathline.get_text(" ", strip=True)
            # Pick the path segment (starts with /)
            # Match /dir/file.mp4 OR just /file.mp4 (last segment)
            path_m = re.search(r'/(?:[^\s]+/)?([^/\s]+\.(?:mp4|mkv|webm|avi|mov))', text, re.I)
            if path_m:
                raw = path_m.group(1)
                result["title"] = re.sub(r'\.(mp4|mkv|webm|avi|mov)$', '', raw, flags=re.I)
            # File size
            size_m = re.search(r'([\d.]+)\s*(TB|GB|MB|KB)\b', text, re.I)
            if size_m:
                result["size_bytes"] = _parse_size_bytes(size_m.group(0))

        # Fallback title: filename from page_url itself
        if not result["title"]:
            parsed = urlparse(page_url)
            path = parsed.path or ""
            # /file.php?f=/b72/Filename.mp4 → Filename.mp4
            qs_f = parse_qs(parsed.query).get("f", [""])[0]
            candidate = unquote((qs_f or path).rstrip("/").rsplit("/", 1)[-1])
            # Strip .mp4/.mkv extension for title
            candidate = re.sub(r'\.(mp4|mkv|webm|avi|mov)$', '', candidate, flags=re.I)
            # Replace underscores/dashes with spaces, clean up
            candidate = re.sub(r'[_\-]+', ' ', candidate).strip()
            if candidate and candidate.lower() not in ("file viewer", "file", ""):
                result["title"] = candidate

        # Resolution hint from title/filename
        w, h = _guess_resolution_from_name(result.get("title", ""))
        result["width"] = w
        result["height"] = h

        return result

    @staticmethod
    async def _solve_fileditch_pow(html: str, page_url: str, headers: dict) -> dict:
        """Given a FileDitch PoW shell, solve the challenge, POST it back, and
        return {stream_url, thumbnail, size_bytes, title, duration} from the real
        player HTML. Returns {} on any failure."""
        cm = _POW_CHALLENGE_RE.search(html)
        if not cm:
            return {}
        challenge, diff = cm.group(1), int(cm.group(2))

        soup = BeautifulSoup(html, "html.parser")
        form = soup.find("form", id="pow-form") or soup.find("form")
        if not form:
            return {}
        action = form.get("action") or page_url
        action = urljoin(page_url, action)
        data = {inp.get("name"): inp.get("value", "")
                for inp in form.find_all("input") if inp.get("name")}

        import asyncio
        nonce = await asyncio.to_thread(_pow_solve, challenge, diff)
        if nonce is None:
            logger.warning("FileDitch PoW: no nonce found (diff=%s) for %s", diff, page_url)
            return {}
        data["pow_nonce"] = str(nonce)

        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True, verify=False) as client:
                resp = await client.post(action, data=data,
                                         headers={**headers, "Referer": page_url})
        except httpx.HTTPError as exc:
            logger.warning("FileDitch PoW submit failed for %s: %s", page_url, exc)
            return {}

        body = resp.text
        if _pow_has_challenge(body):
            logger.warning("FileDitch PoW: still challenged after submit for %s", page_url)
            return {}

        stream_url = _pow_reassemble_signed_url(body)
        out: dict = {"stream_url": stream_url}
        psoup = BeautifulSoup(body, "html.parser")
        vid = psoup.find("video")
        if vid:
            # thumbsditch poster is frequently 404 now → let the caller ffmpeg it,
            # but pass it through so a live poster (rare) can still be used.
            out["thumbnail"] = (vid.get("poster") or "").strip()
        m = re.search(r'([\d.]+)\s*(TB|GB|MB|KB)\b', psoup.get_text(" ", strip=True), re.I)
        if m:
            out["size_bytes"] = _parse_size_bytes(m.group(0))
        return out

    async def _extract_fileditch(self, url: str) -> Optional[Dict[str, Any]]:
        """Dedicated robust extractor for FileDitch hosted files."""
        clean_url = url
        if "theditch.st" in url.lower():
            resolved = await _resolve_theditch_shortlink(url)
            if resolved:
                clean_url = resolved

        clean_path = _fileditch_clean_path(clean_url)
        status_data = await _fetch_fileditch_status_api(clean_path)
        if status_data and status_data.get("status") is False:
            logger.info("FileDitch status API reported file as dead / 404: %s", url)
            return None

        # Build viewer URL on fileditchvids.st with fdg=1 parameter
        viewer_url = f"https://fileditchvids.st{clean_path}?fdg=1"
        from pathlib import Path
        repo_root = Path(__file__).resolve().parents[2]
        fileditch_cookie_file = str(repo_root / "fileditchfiles_cookies.txt")

        browser_meta = await _solve_fileditch_wasm_pow(viewer_url, fileditch_cookie_file)
        stream_url = browser_meta.get("stream_url") or viewer_url
        size_bytes = (status_data.get("size") if status_data else None) or browser_meta.get("size_bytes") or 0

        raw_filename = unquote(clean_path.rsplit("/", 1)[-1])
        clean_title = re.sub(r'\.(mp4|mkv|webm|avi|mov|m4v|ts)$', '', raw_filename, flags=re.I).replace('_', ' ').replace('-', ' ').strip()
        title = browser_meta.get("title") or clean_title or raw_filename

        w, h = _guess_resolution_from_name(title)
        uploaded_ts = status_data.get("uploaded") if status_data else None
        uploaded_str = ""
        if uploaded_ts and isinstance(uploaded_ts, (int, float)):
            try:
                uploaded_str = datetime.fromtimestamp(uploaded_ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                uploaded_str = str(uploaded_ts)

        return {
            "id": clean_path.rsplit("/", 1)[-1],
            "title": title,
            "description": "",
            "thumbnail": browser_meta.get("thumbnail", ""),
            "duration": browser_meta.get("duration", 0.0),
            "stream_url": stream_url,
            "content_type": _guess_content_type(title, stream_url),
            "width": w,
            "height": h,
            "size_bytes": size_bytes,
            "tags": [],
            "uploader": "FileDitch",
            "is_hls": False,
            "needs_ffmpeg_thumb": True,
            "uploaded_at": uploaded_str,
        }

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        from pathlib import Path
        repo_root = Path(__file__).resolve().parents[2]
        cookie_paths = [
            "filester.me_cookies.txt",
            str(repo_root / "filester.me_cookies.txt"),
            str(repo_root / "app" / "filester.me_cookies.txt"),
            "filester.cookies.txt",
            str(repo_root / "filester.cookies.txt"),
            str(repo_root / "app" / "filester.cookies.txt"),
            "cookies.txt",
            str(repo_root / "cookies.txt"),
            str(repo_root / "app" / "cookies.txt"),
        ]
        if is_fileditch_url(url):
            return await self._extract_fileditch(url)

        cookies = _load_cookies_from_paths(cookie_paths)
        fileditch_cookie_file = str(repo_root / "fileditchfiles_cookies.txt")

        parsed = urlparse(url)
        page_origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else "https://filester.me"
        source_label = self.source_label(url)

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": url,
            "Origin": page_origin,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }

        async def fetch_with_cookie_fallback(target_url: str):
            cookies_valid = False
            resp = None
            if cookies:
                try:
                    async with httpx.AsyncClient(timeout=20, follow_redirects=True, verify=False, cookies=cookies) as client:
                        resp = await client.get(target_url, headers=headers)
                        if "/auth" in str(resp.url) or "/login" in str(resp.url):
                            logger.warning("%s cookies invalid/expired (redirected to auth). Retrying without cookies.", source_label)
                        else:
                            cookies_valid = True
                except (httpx.TooManyRedirects, httpx.HTTPError) as e:
                    logger.warning(
                        "%s fetch with cookies failed: %s (%s). Retrying without cookies.",
                        source_label, e or type(e).__name__, type(e).__name__,
                    )
            
            if not cookies_valid:
                async with httpx.AsyncClient(timeout=20, follow_redirects=True, verify=False) as client:
                    resp = await client.get(target_url, headers=headers)
            
            return resp, cookies_valid

        # ── Branch A: /file.php?f=... or pretty /<bucket>/<file>.mp4 ──────────
        if self._is_direct_file_viewer(url):
            try:
                resp, _ = await fetch_with_cookie_fallback(url)
                if not resp or resp.status_code != 200:
                    status = resp.status_code if resp is not None else "no-response"
                    logger.warning("%s direct-viewer fetch failed (%s) %s", source_label, status, url)
                    # FileDitch may reject httpx while serving the same viewer
                    # normally in Chrome. Let the browser solve its anti-bot
                    # page before classifying an otherwise valid file as dead.
                    browser_meta = await _solve_fileditch_wasm_pow(url, fileditch_cookie_file)
                    if browser_meta.get("stream_url"):
                        browser_title = browser_meta.get("title") or unquote(parsed.path.rsplit("/", 1)[-1])
                        return {
                            "id": parsed.path.rsplit("/", 1)[-1],
                            "title": browser_title,
                            "description": "",
                            "thumbnail": "",
                            "duration": 0.0,
                            "stream_url": browser_meta["stream_url"],
                            "content_type": _guess_content_type(browser_title, browser_meta["stream_url"]),
                            "width": 0,
                            "height": 0,
                            "size_bytes": browser_meta.get("size_bytes", 0),
                            "tags": [],
                            "uploader": source_label,
                            "is_hls": False,
                            "needs_ffmpeg_thumb": True,
                        }
                    return None
                if "/auth" in str(resp.url) or "/login" in str(resp.url):
                    logger.warning("%s direct-viewer redirected to auth. Cannot view.", source_label)
                    return None
                final_url = str(resp.url)
                meta = self._scrape_direct_viewer(resp.text, final_url)

                # FileDitch now hides direct files behind a SHA-256 proof-of-work
                # shell. Whenever the shell is present we MUST solve the PoW: any
                # stream_url scraped from the shell itself is the dead page URL
                # (an anti-bot HTML shell, not a video), so the PoW result wins.
                if _pow_has_challenge(resp.text):
                    logger.info("FileDitch PoW challenge detected for %s — solving", url)
                    pow_meta = await self._solve_fileditch_pow(resp.text, final_url, headers)
                    if pow_meta.get("stream_url"):
                        meta["stream_url"] = pow_meta["stream_url"]
                        meta["size_bytes"] = pow_meta.get("size_bytes") or meta.get("size_bytes", 0)
                        # Only trust a poster that isn't the known-dead thumbsditch host.
                        pt = pow_meta.get("thumbnail", "")
                        if pt and "thumbsditch" not in pt:
                            meta["thumbnail"] = pt
                # Newer WASM shell (see _pow_has_wasm_shell docstring): no
                # `challenge=` string to match, so the branch above never fires
                # and the scraper's broad CDN-regex fallback grabs a stray
                # self-link instead of a stream — recognisable because it comes
                # back equal to the page's own url. Either signal routes here.
                elif _pow_has_wasm_shell(resp.text) or meta.get("stream_url", "").rstrip("/") in (
                    url.rstrip("/"), final_url.rstrip("/")
                ):
                    logger.info("FileDitch WASM PoW shell detected for %s — solving via headless browser", url)
                    browser_meta = await _solve_fileditch_wasm_pow(final_url, fileditch_cookie_file)
                    if browser_meta.get("stream_url"):
                        meta["stream_url"] = browser_meta["stream_url"]
                        if browser_meta.get("size_bytes"):
                            meta["size_bytes"] = browser_meta["size_bytes"]
                        if browser_meta.get("title") and not meta.get("title"):
                            meta["title"] = browser_meta["title"]
                    else:
                        # The bogus self-link is worse than nothing — a caller
                        # that plays it gets the HTML shell, not a video.
                        meta["stream_url"] = ""
            except Exception as e:
                logger.error("%s direct-viewer extraction failed for %s: %s", source_label, url, e)
                return None

            if not meta.get("stream_url"):
                logger.warning("%s direct-viewer: no stream found for %s", source_label, url)
                return None

            title = meta["title"] or parsed.path.rsplit("/", 1)[-1]
            return {
                "id": parsed.path.rsplit("/", 1)[-1],
                "title": title,
                "description": "",
                "thumbnail": meta.get("thumbnail", ""),
                "duration": meta.get("duration", 0.0),
                "stream_url": meta["stream_url"],
                "content_type": _guess_content_type(title, meta["stream_url"]),
                "width": meta.get("width", 0),
                "height": meta.get("height", 0),
                "size_bytes": meta.get("size_bytes", 0),
                "tags": [],
                "uploader": source_label,
                "is_hls": False,
                "needs_ffmpeg_thumb": True,  # no og:image on this page format
            }

        # ── Branch B: /d/<slug> page (original slug-based flow) ──────────────
        slug = self._extract_slug(url)
        if not slug:
            return None

        # ── Branch B0: try official API first (own files only) ───────────────
        api_key = _load_api_key()
        api_file_data = await _filester_api_get_file(slug, api_key)
        api_meta = {}
        if api_file_data:
            raw_name = str(api_file_data.get("name") or "")
            # Strip extension and site prefix from filename
            clean_name = re.sub(r'\.(mp4|mkv|webm|avi|mov|m4v|ts)$', '', raw_name, flags=re.I).strip()
            _qm = re.search(r'\((\d{3,4})\)\s*$', clean_name)
            _qhint = int(_qm.group(1)) if _qm else 0
            if _qm:
                clean_name = clean_name[:_qm.start()].strip()
            clean_name = re.sub(r'^[A-Z][A-Z0-9]+\.COM\s*[-–]\s*(?:\[[A-Za-z0-9]+\]\s*)?', '', clean_name).strip()
            w, h = _guess_resolution_from_name(clean_name)
            if not h and _qhint:
                h = _qhint
                w = {2160: 3840, 1440: 2560, 1080: 1920, 720: 1280, 480: 854}.get(h, 0)
            file_uuid = str(api_file_data.get("uuid") or "")
            thumb = ""
            thumb_path = str(api_file_data.get("thumbnail_url") or "")
            if thumb_path:
                thumb = ("https://filester.me" + thumb_path) if thumb_path.startswith("/") else thumb_path
            api_meta = {
                "title": clean_name or slug,
                "size_bytes": int(api_file_data.get("size") or 0),
                "file_uuid": file_uuid,
                "thumbnail": thumb,
                "width": w,
                "height": h,
                "uploaded_at": _upload_date_from_fields(api_file_data),
            }
            logger.info("Filester: used official API for slug=%s (own file)", slug)

        cache_origin = self._cache_origin_from_page(url)
        stream_url = None
        page_meta = {}

        try:
            page_resp, cookies_valid = await fetch_with_cookie_fallback(url)
            if not page_resp or page_resp.status_code != 200:
                status = page_resp.status_code if page_resp is not None else "no-response"
                logger.warning("Filester page fetch failed for %s (status=%s)", url, status)
                return None

            if "/auth" in str(page_resp.url) or "/login" in str(page_resp.url):
                logger.warning("Filester page redirected to auth. Private or dead link.")
                return None

            page_meta = self._scrape_page_meta(page_resp.text, url)
            
            final_parsed = urlparse(str(page_resp.url))
            current_page_origin = f"{final_parsed.scheme}://{final_parsed.netloc}" if final_parsed.scheme and final_parsed.netloc else page_origin

            # 2. Token API for stream URL
            client_cookies = cookies if cookies_valid else {}
            async with httpx.AsyncClient(timeout=20, follow_redirects=True, verify=False, cookies=client_cookies) as client:
                # Mirrors may redirect the HTML through a legacy cache host whose
                # token response lacks the selected CDN.  The public view API is
                # canonical on filester.me and returns the live `server` field
                # consumed by the site's own player.
                api_origin = "https://filester.me" if "filester." in current_page_origin.lower() else current_page_origin
                api_url = f"{api_origin}/v2/api/public/view"
                api_headers = {**headers, "Content-Type": "application/json", "Accept": "application/json, text/plain, */*"}
                api_resp = await client.post(api_url, json={"file_slug": slug}, headers=api_headers)

                if api_resp.status_code == 200 and api_resp.content:
                    data = api_resp.json()
                    if not page_meta.get("uploaded_at"):
                        page_meta["uploaded_at"] = _upload_date_from_fields(data)
                    view_url = data.get("view_url") or data.get("url") or data.get("stream_url")
                    view_token = str(data.get("token") or "")
                    # The public view API chooses a live CDN for this token.  Do
                    # not replace it with a guessed p1/cache host: those hosts can
                    # have a different certificate or reject the token outright.
                    api_server = str(data.get("server") or "").strip().rstrip("/")
                    api_file = str(data.get("file") or "").strip().lstrip("/")
                    if api_server.startswith(("https://", "http://")) and api_file and view_token:
                        stream_url = f"{api_server}/v2/{api_file}?token={view_token}"
                        logger.debug("Filester: using API-selected CDN %s for %s", api_server, url)
                    elif view_url:
                        stream_url = view_url if view_url.startswith("http") else f"{cache_origin}{view_url}"

                    # Extract duration from API response if page HTML didn't provide it
                    if not page_meta.get("duration"):
                        for _dur_key in ("duration", "duration_seconds", "length", "video_duration"):
                            _api_dur = data.get(_dur_key)
                            if _api_dur is not None:
                                try:
                                    d = float(_api_dur)
                                    if d > 0:
                                        page_meta["duration"] = d
                                        break
                                except (TypeError, ValueError):
                                    pass

                # 3. Fallback: video tag / CDN patterns in HTML
                if not stream_url:
                    soup = BeautifulSoup(page_resp.text, "html.parser")
                    for sel in ["video source[src]", "video[src]", "source[src]"]:
                        el = soup.select_one(sel)
                        if el:
                            s = el.get("src", "")
                            if s and not s.startswith("blob:"):
                                stream_url = ("https:" + s) if s.startswith("//") else s
                                break
                    if not stream_url:
                        for pattern in [
                            r'(https?://(?:cache\d*\.filester\.[a-z]+|[a-z0-9.-]*fileditchfiles\.[a-z]+)/[^"\'\\s<>]+\.(?:mp4|mkv|webm)(?:\?[^"\'\\s<>]*)?)',
                            r'(https?://(?:alpha\d*|cdn\d*|cache\d*)\.[^"\'\\s<>]+\.(?:mp4|mkv|webm)(?:\?[^"\'\\s<>]*)?)',
                            r'"(https?://[^"]+\.(?:mp4|mkv|webm)(?:\?[^"]+)?)"',
                        ]:
                            m = re.search(pattern, page_resp.text, re.I)
                            if m:
                                stream_url = m.group(1)
                                break

        except Exception as e:
            logger.error("Filester extraction failed for %s: %s (%s)", url, e or type(e).__name__, type(e).__name__)
            return None

        if not stream_url:
            logger.warning("Filester: no stream URL found for %s", url)
            return None

        # Duration comes from page JS/API when available.
        # ffprobe probe skipped — CDN token expires in 30 min and blocking the processor is worse.

        # Merge: official API data wins for name/size/uuid/thumb (own files); page scrape fills the rest
        merged = {**page_meta}
        for k in ("title", "size_bytes", "file_uuid", "thumbnail", "width", "height", "uploaded_at"):
            if api_meta.get(k):
                merged[k] = api_meta[k]

        title = merged.get("title") or slug
        return {
            "id": slug,
            "title": title,
            "description": "",
            "thumbnail": merged.get("thumbnail", ""),
            "duration": merged.get("duration", 0),
            "stream_url": stream_url,
            "content_type": _guess_content_type(title, stream_url),
            "width": merged.get("width", 0),
            "height": merged.get("height", 0),
            "size_bytes": merged.get("size_bytes", 0),
            "uploaded_at": merged.get("uploaded_at", ""),
            "tags": [],
            "uploader": "Filester",
            "is_hls": False,
        }
