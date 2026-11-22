import logging
import re
import asyncio
import base64
import json
import subprocess
from urllib.parse import urljoin, urlsplit
from typing import Optional, Dict, Any, List
from bs4 import BeautifulSoup
import aiohttp
import requests
import yt_dlp
from curl_cffi.requests import AsyncSession
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .base import VideoExtractor
from ..hubs.base import iso_duration_to_secs

logger = logging.getLogger(__name__)

# Embed domains that consistently fail (geo-blocked, token-locked, or ad-redirect).
# Stahmut is the LeakPorner default Player 1 — it returns streams that break in
# any non-original-browser context. We de-prioritize / skip it entirely.
_SKIP_EMBED_DOMAINS = (
    "stahmut.com",
    "sthtm.com",
    "sthmus.com",
    "sthmut.net",
)

# Byse/Vidara/Lulu embeds are the most reliable — try these first.
_PREFER_EMBED_DOMAINS = (
    "vidara.to",
    "luluvids.top",
    "lulustream.com",
    "bysezoxexe.com",
    "398fitus.com",
    "byse",
)

class LeakPornerExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "LeakPorner"

    def can_handle(self, url: str) -> bool:
        u = url.lower()
        return "leakporner.com" in u or "pornerleak.com" in u or "mypornerleak.com" in u

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        if self._native_watch_host(url):
            result = await self._parse_and_resolve(url)
            return result if result and result.get("stream_url") else None

        # Strategy 1: Try yt-dlp on the page directly
        result = await asyncio.to_thread(self._try_ytdlp, url)
        if result and self._is_direct_playable_url(result.get('stream_url')):
            logger.info(f"LeakPorner yt-dlp success: {url}")
            return result
        if result and result.get('stream_url'):
            logger.debug(
                "LeakPorner yt-dlp returned non-direct stream URL, continuing with HTML parsing: %s",
                result.get('stream_url'),
            )

        # Strategy 2: Parse page for embeds, then resolve them
        return await self._parse_and_resolve(url)

    @staticmethod
    def _native_watch_host(url: str) -> bool:
        host = urlsplit(url).hostname or ""
        return any(host == domain or host.endswith("." + domain)
                   for domain in ("leakporner.com", "mypornerleak.com"))

    @staticmethod
    async def _fetch_native_watch_page(url: str) -> tuple[str, str]:
        origin = urlsplit(url)
        async with AsyncSession(impersonate="chrome") as session:
            response = await session.get(
                url, headers={"Referer": f"{origin.scheme}://{origin.netloc}/"}, timeout=12,
            )
            response.raise_for_status()
            return response.text, str(response.url)

    @staticmethod
    def _watch_page_metadata(soup: BeautifulSoup, url: str) -> dict:
        def content(selector: str) -> str:
            node = soup.select_one(selector)
            return (node.get("content") or "").strip() if node else ""

        title = content('meta[property="og:title"]')
        if not title:
            heading = soup.select_one("h1.entry-title, h1") or soup.title
            title = heading.get_text(strip=True) if heading else ""
        title = re.sub(r'\s*[-|]\s*(?:LeakPorner|PornerLeak|MyPornerLeak)\s*$', '', title, flags=re.I)
        thumbnail = content('meta[property="og:image"], meta[itemprop="thumbnailUrl"]')
        if not thumbnail:
            image = soup.select_one(".vi-on[data-thum]")
            thumbnail = (image.get("data-thum") or "").strip() if image else ""

        duration = iso_duration_to_secs(content('meta[itemprop="duration"]').replace("P0DT", "PT", 1))
        if not duration:
            badge = soup.select_one("span.duration")
            parts = badge.get_text(strip=True).split(":") if badge else []
            if len(parts) in (2, 3) and all(part.strip().isascii() and part.strip().isdigit() for part in parts):
                for part in parts:
                    duration = duration * 60 + int(part)

        return {
            "title": title.strip(),
            "thumbnail": urljoin(url, thumbnail) if thumbnail else "",
            "duration": duration,
            "upload_date": content('meta[itemprop="uploadDate"], meta[property="article:published_time"]')[:10],
        }

    async def fetch_watch_metadata(self, url: str) -> dict:
        html, page_url = await self._fetch_native_watch_page(url)
        return self._watch_page_metadata(BeautifulSoup(html, "lxml"), page_url)

    @staticmethod
    def _normalize_embed_url(embed_url: str) -> Optional[str]:
        url = (embed_url or "").strip()
        if not url or not url.startswith(("http://", "https://")):
            return None
        if 'luluvids.top' in url:
            # The .top player is live; rewriting it to .com yields DNS failure.
            url = url.replace('/v/', '/e/')
        return url

    @staticmethod
    def _collect_embed_urls(html: str, soup: BeautifulSoup) -> List[str]:
        embed_urls: List[str] = []
        servideo = soup.find('div', class_='servideo')
        if servideo:
            for span in servideo.find_all('span', class_='change-video'):
                e = LeakPornerExtractor._normalize_embed_url(span.get('data-embed') or "")
                if e and e not in embed_urls:
                    embed_urls.append(e)
        for match in re.findall(r'data-embed=["\']([^"\']+)["\']', html):
            e = LeakPornerExtractor._normalize_embed_url(match)
            if e and e not in embed_urls:
                embed_urls.append(e)
        for iframe in soup.select("iframe[src]"):
            e = LeakPornerExtractor._normalize_embed_url(iframe.get("src") or "")
            if e and e not in embed_urls:
                embed_urls.append(e)
        return embed_urls

    @staticmethod
    async def _collect_kau_embeds(html: str, soup: BeautifulSoup, page_url: str) -> List[str]:
        """Načíta dynamické embed URL cez `/wp-json/kau/v1/stream` (nový player na tv.leakporner.com)."""
        cfg_match = re.search(r"kauCfg\s*=\s*(\{.*?\})", html)
        kau_div = soup.select_one("#kauvideo[data-post-id]")
        if not cfg_match or not kau_div:
            return []
        try:
            cfg = json.loads(cfg_match.group(1))
        except Exception:
            return []
        api_url = str(cfg.get("api") or "").strip()
        nonce = str(cfg.get("nonce") or "").strip()
        post_id = str(kau_div.get("data-post-id") or "").strip()
        if not api_url or not post_id:
            return []

        player_keys: List[str] = []
        for node in kau_div.select("[data-player]"):
            pk = str(node.get("data-player") or "").strip()
            if pk and pk not in player_keys:
                player_keys.append(pk)
        if not player_keys:
            player_keys = ["player1", "player2", "player3", "player4", "player5"]

        origin_parts = urlsplit(page_url)
        origin = f"{origin_parts.scheme}://{origin_parts.netloc}"
        headers = {
            "X-WP-Nonce": nonce,
            "Referer": page_url,
            "Origin": origin,
            "Content-Type": "application/json",
        }
        out: List[str] = []
        try:
            async with AsyncSession(impersonate="chrome") as session:
                async def _one(pk: str) -> str:
                    try:
                        resp = await session.post(api_url, json={"id": post_id, "p": pk}, headers=headers, timeout=8)
                        if resp.status_code == 200:
                            data = resp.json() or {}
                            return LeakPornerExtractor._normalize_embed_url(str(data.get("u") or ""))
                    except Exception:
                        pass
                    return ""

                resolved_list = await asyncio.gather(*[_one(pk) for pk in player_keys[:6]])
                for u in resolved_list:
                    if u and u not in out:
                        out.append(u)
        except Exception as exc:
            logger.debug("LeakPorner kau embed collection failed for %s: %s", page_url, exc)
        return out

    @staticmethod
    def _extract_mng_fluid_stream(html: str) -> Optional[str]:
        """Parsuje `window.MNGFluidConfig` z HornySimp/MNG Fluid Player iframe stránky."""
        m = re.search(r"window\.MNGFluidConfig\s*=\s*", html)
        if not m:
            return None
        try:
            cfg, _ = json.JSONDecoder().raw_decode(html[m.end():].lstrip())
        except Exception:
            return None
        if not isinstance(cfg, dict):
            return None
        init = cfg.get("initialStream") if isinstance(cfg.get("initialStream"), dict) else {}
        for cand in (
            init.get("hls_url"),
            init.get("mp4_url"),
            init.get("url"),
            cfg.get("fallbackEmbedUrl"),
        ):
            u = str(cand or "").strip()
            if u.startswith(("http://", "https://")) and LeakPornerExtractor._is_direct_playable_url(u):
                return u
        return None

    @staticmethod
    def _extract_direct_media_url(html: str, page_url: str) -> Optional[str]:
        if not html:
            return None

        soup = BeautifulSoup(html, "html.parser")
        candidates: List[str] = []

        for tag in soup.select(
            "video source[src], video[src], meta[property='og:video'], meta[property='og:video:url'], meta[property='og:video:secure_url']"
        ):
            candidate = (tag.get("src") or tag.get("content") or "").strip()
            if candidate:
                candidates.append(candidate)

        for match in re.findall(r'https?://[^"\']+\.(?:mp4|m3u8|webm|m4v)(?:\?[^"\']*)?', html, flags=re.I):
            candidates.append(match)

        for candidate in candidates:
            try:
                candidate = urljoin(page_url, candidate.strip())
            except Exception:
                continue
            low = candidate.lower()
            if low.startswith("blob:") or low.startswith("data:"):
                continue
            if any(token in low for token in (".mp4", ".m3u8", ".webm", ".m4v")):
                return candidate
        return None

    @staticmethod
    def _is_direct_playable_url(url: Optional[str]) -> bool:
        low = (url or "").lower()
        return any(token in low for token in (".m3u8", ".mp4", ".webm", ".m4v"))

    @staticmethod
    def _decode_b64url(raw: str) -> bytes:
        text = (raw or "").strip().replace("-", "+").replace("_", "/")
        text += "=" * (-len(text) % 4)
        return base64.b64decode(text)

    @classmethod
    def _resolve_byse_playback(cls, embed_url: str, page_referer: str = "https://w12.leakporner.com/") -> Optional[Dict[str, Any]]:
        url = (embed_url or "").strip()
        if not url:
            return None
        match = re.search(r"/(?:e|kpw)/([a-zA-Z0-9_-]+)", url)
        if not match:
            return None

        code = match.group(1)
        api_url = f"https://bysezoxexe.com/api/videos/{code}/embed/playback"
        normalized_referer = (page_referer or "https://w12.leakporner.com/").strip()
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": normalized_referer,
            "Origin": "https://bysezoxexe.com",
        }
        resp = requests.get(api_url, headers=headers, timeout=20)
        if resp.status_code != 200:
            return None

        data = resp.json() or {}
        playback = data.get("playback") or {}
        key_parts = playback.get("key_parts") or []
        iv = playback.get("iv") or ""
        payload = playback.get("payload") or ""
        if not key_parts or not iv or not payload:
            return None

        try:
            key = b"".join(cls._decode_b64url(part) for part in key_parts)
            nonce = cls._decode_b64url(iv)
            ciphertext = cls._decode_b64url(payload)
            plain = AESGCM(key).decrypt(nonce, ciphertext, None)
            parsed = json.loads(plain.decode("utf-8", errors="replace"))
            sources = parsed.get("sources") or []
            if not sources:
                return None
            # Prefer the first real playable source.
            sorted_sources = sorted(
                sources,
                key=lambda s: (
                    0 if cls._is_direct_playable_url(s.get("url")) else 1,
                    -(int(s.get("bitrate_kbps") or 0)),
                    -(int(s.get("height") or 0)),
                ),
            )
            for source in sorted_sources:
                candidate = (source.get("url") or "").strip()
                if candidate and cls._is_direct_playable_url(candidate):
                    return {
                        "title": "",
                        "thumbnail": parsed.get("poster_url") or data.get("poster_url") or "",
                        "duration": 0.0,
                        "stream_url": candidate,
                        "width": 0,
                        "height": int(source.get("height") or 0),
                        "uploader": "LeakPorner",
                        "is_hls": ".m3u8" in candidate.lower(),
                    }
        except Exception as exc:
            logger.debug("LeakPorner byse playback decrypt failed for %s: %s", embed_url, exc)
        return None

    @staticmethod
    def _resolve_jwplayer_script(script_text: str, page_url: str) -> Optional[str]:
        if not script_text or "jwplayer" not in script_text.lower():
            return None

        node_code = r"""
const vm = require('node:vm');
const script = Buffer.from(process.argv[1], 'base64').toString('utf8');
const pageUrl = process.argv[2];
const hits = [];

function makeStubElement(tag) {
  return {
    tagName: String(tag || '').toUpperCase(),
    style: {},
    children: [],
    setAttribute(name, value) { this[name] = value; },
    appendChild(child) {
      this.children.push(child);
      if (child && typeof child.textContent === 'string' && child.textContent.trim()) {
        try { vm.runInContext(child.textContent, context, { timeout: 3000 }); } catch (e) {}
      }
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
    },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    innerHTML: '',
    textContent: '',
  };
}

const body = makeStubElement('body');
const document = {
  body,
  createElement: makeStubElement,
  scripts: [],
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
};

const chain = {
  on() { return this; },
  click() { return this; },
  ready(cb) { try { if (typeof cb === 'function') cb(); } catch (e) {} return this; },
  attr() { return ''; },
  text() { return ''; },
  html() { return ''; },
  append() { return this; },
  addClass() { return this; },
  removeClass() { return this; },
  hide() { return this; },
  show() { return this; },
  find() { return this; },
  each() { return this; },
  data() { return null; },
  val() { return ''; },
  length: 0,
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  window: null,
  document,
  location: {
    href: pageUrl,
    host: new URL(pageUrl).host,
    pathname: new URL(pageUrl).pathname,
    protocol: new URL(pageUrl).protocol,
  },
  navigator: { userAgent: 'Mozilla/5.0' },
  localStorage: {
    _s: {},
    getItem(k) { return this._s[k] ?? null; },
    setItem(k, v) { this._s[k] = String(v); },
    removeItem(k) { delete this._s[k]; },
  },
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  fetch: async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}), headers: { get: () => null } }),
  DOMParser: class { parseFromString(txt) { return { textContent: txt, querySelector() { return null; }, querySelectorAll() { return []; }, body: { innerHTML: txt } }; } },
  URL,
  Blob,
  FormData,
  Headers,
  MutationObserver: class { observe() {} disconnect() {} },
  performance: { now: () => Date.now() },
  open: (link) => { hits.push({ type: 'open', link }); return null; },
  alert() {},
  confirm: () => true,
  prompt: () => '',
};

const $ = function () { return chain; };
$.cookie = () => {};
$.ajaxSetup = () => {};
$.ajax = () => chain;
$.get = () => chain;
$.post = () => chain;
$.fn = {};

sandbox["$"] = $;
sandbox.jwplayer = function () {
  return {
    setup(cfg) { hits.push({ type: 'jwsetup', cfg }); return this; },
    on() { return this; },
    addButton() { return this; },
    playlistItem() { return this; },
    load() { return this; },
    play() { return this; },
    getPlaylistItem() { return {}; },
    getCurrentTime() { return 0; },
    getPosition() { return 0; },
    setCurrentAudioTrack() { return this; },
    getAudioTracks() { return []; },
    onReady() { return this; },
  };
};
sandbox.window = sandbox;

const context = vm.createContext(sandbox);
try { vm.runInContext(script, context, { timeout: 5000 }); } catch (e) {}

for (const hit of hits) {
  if (hit.type === 'jwsetup' && hit.cfg) {
    const sources = Array.isArray(hit.cfg.sources) ? hit.cfg.sources : [];
    for (const source of sources) {
      const file = source && source.file ? String(source.file) : '';
      if (file) {
        process.stdout.write(new URL(file, pageUrl).href);
        process.exit(0);
      }
    }
  }
}
for (const hit of hits) {
  if (hit.type === 'open' && hit.link) {
    process.stdout.write(String(hit.link));
    process.exit(0);
  }
}
"""
        try:
            payload = base64.b64encode(script_text.encode("utf-8")).decode("ascii")
            completed = subprocess.run(
                ["node", "-e", node_code, payload, page_url],
                capture_output=True,
                text=True,
                timeout=8,
            )
            candidate = (completed.stdout or "").strip()
            if candidate.startswith(("http://", "https://")):
                return candidate
        except Exception as exc:
            logger.debug(f"LeakPorner jwplayer sandbox failed: {exc}")
        return None

    def _try_ytdlp(self, url: str) -> Optional[Dict[str, Any]]:
        def _try_ytdlp_cli_impersonate(target_url: str) -> Optional[str]:
            try:
                completed = subprocess.run(
                    [
                        "yt-dlp",
                        "--extractor-args",
                        "generic:impersonate",
                        "-g",
                        target_url,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                direct = (completed.stdout or "").strip().splitlines()
                for line in direct:
                    line = line.strip()
                    if line.startswith(("http://", "https://")):
                        return line
            except Exception as cli_exc:
                logger.debug(f"LeakPorner djav yt-dlp CLI fallback failed: {cli_exc}")
            return None

        try:
            ydl_opts = {
                'quiet': True, 'no_warnings': True, 'skip_download': True,
                'format': 'best[ext=mp4]/best[protocol*=m3u8]/best',
                'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if not info:
                return None
            stream_url = info.get('url')
            if not stream_url and info.get('formats'):
                fmts = sorted([f for f in info['formats'] if f.get('url')],
                               key=lambda f: f.get('height') or 0, reverse=True)
                if fmts:
                    stream_url = fmts[0]['url']
            if not stream_url:
                if "djav.org" in url.lower():
                    stream_url = _try_ytdlp_cli_impersonate(url)
                if not stream_url:
                    return None
            return {
                "id": info.get('id', ''),
                "title": info.get('title', ''),
                "description": info.get('description', ''),
                "thumbnail": info.get('thumbnail', ''),
                "duration": float(info.get('duration') or 0.0),
                "stream_url": stream_url,
                "width": int(info.get('width') or 0),
                "height": int(info.get('height') or 0),
                "tags": info.get('tags', []),
                "uploader": "LeakPorner",
                "is_hls": '.m3u8' in stream_url.lower(),
            }
        except Exception as e:
            logger.debug(f"LeakPorner yt-dlp failed: {e}")
            if "djav.org" in url.lower():
                stream_url = _try_ytdlp_cli_impersonate(url)
                if stream_url:
                    return {
                        "id": "",
                        "title": "",
                        "description": "",
                        "thumbnail": "",
                        "duration": 0.0,
                        "stream_url": stream_url,
                        "width": 0,
                        "height": 0,
                        "tags": [],
                        "uploader": "LeakPorner",
                        "is_hls": '.m3u8' in stream_url.lower(),
                    }
            return None

    async def _parse_and_resolve(self, url: str) -> Optional[Dict[str, Any]]:
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': 'https://leakporner.com/'
            }
            native = self._native_watch_host(url)
            if native:
                html, url = await self._fetch_native_watch_page(url)
                headers["Referer"] = url
            else:
                async with aiohttp.ClientSession(headers=headers) as session:
                    async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                        if resp.status != 200:
                            return None
                        html = await resp.text()

            soup = BeautifulSoup(html, 'lxml')
            metadata = self._watch_page_metadata(soup, url)
            title = metadata["title"] or "LeakPorner Video"
            thumbnail = metadata["thumbnail"]

            # Embed URLs (vrátane dynamického kauCfg /wp-json/kau/v1/stream)
            embed_urls = self._collect_embed_urls(html, soup)
            if not embed_urls:
                embed_urls = await self._collect_kau_embeds(html, soup, url)

            video_id = url.rstrip('/').split('/')[-1] or url.rstrip('/').split('/')[-2]

            direct_media_url = self._extract_direct_media_url(html, url)
            prefer_embed_resolution = any(
                token in url.lower() for token in ("hornysimp", "nsfw247", "pornhat", "beeg")
            )

            # Resolve embeds to direct stream.
            # Strategy: try byse/preferred embeds first (Player 2+ on LP), skip Stahmut (Player 1).
            def _sort_key(u: str) -> int:
                ul = u.lower()
                if any(d in ul for d in _PREFER_EMBED_DOMAINS):
                    return 0   # highest priority
                if any(d in ul for d in _SKIP_EMBED_DOMAINS):
                    return 2   # lowest priority (try last or skip)
                return 1

            embed_urls_sorted = sorted(embed_urls, key=_sort_key)

            stream_url = None if prefer_embed_resolution else direct_media_url
            async with aiohttp.ClientSession(headers=headers) as session:
                if not stream_url:
                    for embed_url in embed_urls_sorted[:5]:
                        # Skip Stahmut entirely unless it's the only option
                        if any(d in embed_url.lower() for d in _SKIP_EMBED_DOMAINS) and len(embed_urls_sorted) > 1:
                            logger.debug(f"[LeakPorner] Skipping Stahmut embed: {embed_url[:60]}")
                            continue
                        stream_url = await self._resolve_embed(embed_url, session, url)
                        if stream_url:
                            logger.info(f"Resolved embed {embed_url[:60]} -> {stream_url[:60]}")
                            break

            if not stream_url and direct_media_url:
                stream_url = direct_media_url

            # Fallback: try yt-dlp on the best non-Stahmut embed URL
            if not stream_url and embed_urls_sorted:
                best_fallback = next(
                    (e for e in embed_urls_sorted if not any(d in e.lower() for d in _SKIP_EMBED_DOMAINS)),
                    embed_urls_sorted[0]
                )
                ytdlp_result = await asyncio.to_thread(self._try_ytdlp, best_fallback)
                if ytdlp_result:
                    stream_url = ytdlp_result.get('stream_url')
                    if not thumbnail and ytdlp_result.get('thumbnail'):
                        thumbnail = ytdlp_result['thumbnail']

            if not stream_url:
                stream_url = embed_urls[0] if embed_urls else (None if native else url)

            # Route custom-encrypted cdnvids/cdnstream streams through their playable iframe embeds instead.
            # Standard Hls.js throws media parsing errors due to custom-encrypted .image segments on TikTok CDN.
            if stream_url and any(d in stream_url.lower() for d in ("cdnvids.top", "cdnstream.top")):
                matching_embed = next((e for e in embed_urls_sorted if any(d in e.lower() for d in ("bysezoxexe.com", "398fitus.com"))), None)
                stream_url = matching_embed or embed_urls_sorted[0] if embed_urls_sorted else url
                logger.info(f"[LeakPorner] Direct HLS stream is custom-encrypted. Using iframe fallback: {stream_url}")

            # A title badge and duration do not establish the stream resolution
            # or byte size. Leave these unknown until a media probe confirms them.
            height = 0
            size_bytes = 0

            return {
                "id": video_id,
                "title": title,
                "description": title,
                "thumbnail": thumbnail,
                "duration": metadata["duration"],
                "upload_date": metadata["upload_date"],
                "playback_referer": url,
                "stream_url": stream_url,
                "width": 0, "height": height,
                "size_bytes": size_bytes,
                "tags": [],
                "uploader": "LeakPorner",
                "is_hls": '.m3u8' in (stream_url or '').lower(),
                "embed_urls": embed_urls,
            }
        except Exception as e:
            logger.error(f"LeakPorner extraction failed for {url}: {e}")
            return None

    async def _resolve_embed(self, embed_url: str, session: aiohttp.ClientSession, referer: str) -> Optional[str]:
        """Fetch embed page and find direct video URL inside."""
        try:
            embed_url = self._normalize_embed_url(embed_url or "")
            if not embed_url:
                return None

            if any(domain in embed_url.lower() for domain in ("bysezoxexe.com", "398fitus.com")):
                byse_meta = await asyncio.to_thread(self._resolve_byse_playback, embed_url, referer)
                if byse_meta and byse_meta.get("stream_url"):
                    return byse_meta["stream_url"]

            # Deleguj známe embed hosty (Vidara, LuluStream, ...) na špecializované extraktory
            try:
                from .registry import ExtractorRegistry
                delegate = ExtractorRegistry.find_extractor(embed_url)
                if delegate is not None and not isinstance(delegate, LeakPornerExtractor):
                    ext_res = await delegate.extract(embed_url)
                    if ext_res and ext_res.get("stream_url"):
                        return str(ext_res["stream_url"])
            except Exception as exc:
                logger.debug("Delegate extractor failed for %s: %s", embed_url, exc)

            async with AsyncSession(impersonate="chrome") as cf_session:
                resp = await cf_session.get(
                    embed_url,
                    headers={"Referer": referer},
                    timeout=12,
                    verify=False,
                )
                if resp.status_code != 200:
                    return None
                html = resp.text

            mng_stream = self._extract_mng_fluid_stream(html)
            if mng_stream:
                return mng_stream

            # Ordered patterns - most specific first
            patterns = [
                r'["\']?(https?://[^"\'>\s]+\.m3u8(?:\?[^"\'>\s]*)?)["\']?',
                r'["\']?(https?://[^"\'>\s]+\.mp4(?:\?[^"\'>\s]*)?)["\']?',
                r'file\s*:\s*["\']([^"\']+)["\']',
                r'"hls"\s*:\s*["\']([^"\']+)["\']',
                r'"src"\s*:\s*"(https?://[^"]+\.(?:m3u8|mp4)[^"]*)"',
                r'src=["\'](https?://[^"\']+\.(?:m3u8|mp4)[^"\']*)["\']',
                r'sources\s*:\s*\[\s*\{\s*file\s*:\s*["\']([^"\']+)["\']',
            ]

            for pattern in patterns:
                for match in re.findall(pattern, html, re.IGNORECASE):
                    url_cand = match.strip().strip('"\'')
                    if not url_cand.startswith('http'):
                        if url_cand.startswith('//'):
                            url_cand = 'https:' + url_cand
                        else:
                            continue
                    if any(x in url_cand.lower() for x in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.js', '.css']):
                        continue
                    if '.m3u8' in url_cand.lower() or '.mp4' in url_cand.lower():
                        if '.m3u8' in url_cand.lower():
                            try:
                                async with session.get(
                                    url_cand,
                                    headers={
                                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                                        'Referer': referer,
                                    },
                                    timeout=aiohttp.ClientTimeout(total=10),
                                    ssl=False,
                                ) as probe_resp:
                                    if probe_resp.status != 200:
                                        continue
                                    probe_body = await probe_resp.text()
                                    probe_low = probe_body.lower()
                                    if any(token in probe_low for token in ('.image', 'tiktokcdn', 'ad-site')) and not any(token in probe_low for token in ('.ts', '.m4s', '.mp4')):
                                        continue
                            except Exception:
                                pass
                        return url_cand

            scripts = BeautifulSoup(html, 'lxml').find_all('script')
            for script in scripts:
                script_text = script.get_text("\n", strip=False)
                if any(token in script_text.lower() for token in ('jwplayer', 'currentfile', 'pickdirect', '__directlink')):
                    direct = await asyncio.to_thread(self._resolve_jwplayer_script, script_text, embed_url)
                    if direct and ('.m3u8' in direct.lower() or '.mp4' in direct.lower()):
                        return direct
        except Exception as e:
            logger.debug(f"Embed resolve failed for {embed_url}: {e}")
        return None
