import asyncio
import html as html_module
import re
import logging
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from curl_cffi import requests as browser_requests
from .base import VideoExtractor
from typing import Optional, Dict, Any
from app.media_urls import is_pimpbunny_remote_media

class PimpBunnyExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "PimpBunny"
    
    @property
    def domains(self):
        return ["pimpbunny.com"]
    
    def can_handle(self, url: str) -> bool:
        return any(domain in url for domain in self.domains)

    def _is_direct_media_url(self, url: str) -> bool:
        path = url.split("?")[0].lower()
        return is_pimpbunny_remote_media(url) or any(path.endswith(ext) for ext in (".mp4", ".m3u8", ".webm", ".mkv", ".mov"))

    @staticmethod
    def _quality_from_text(value: str) -> int:
        """Map player labels to a sortable pixel height (2K means 1440p)."""
        low = (value or "").lower()
        if re.search(r"\b(?:2k|1440p?)\b", low):
            return 1440
        match = re.search(r"\b(2160|1080|720|480|360)\s*p?\b", low)
        return int(match.group(1)) if match else 0

    @staticmethod
    def _clean_stream_url(value: str) -> str:
        return html_module.unescape(value).replace("\\/", "/").replace("\\u0026", "&").strip("'\" ")

    # PimpBunny runs a KVS (Kernel Video Sharing) player. Its flashvars expose
    # every rendition (`video_url` … `video_alt_url4`) but each is prefixed
    # `function/0/…/get_file/<seg>/<HASH>/…` where the first 32 hex chars of
    # <HASH> are scrambled. The player unscrambles them client-side with
    # `license_code`. The raw scrambled token 404s; only the unscrambled one
    # resolves. Verified 2026-07-23 on player v9.5.7: this math still unlocks
    # 720p/1080p/1440p with NO cookies. (JSON-LD `contentUrl` only ever carries
    # the 720p rendition, which is why importing that alone capped everything at
    # 720p — we must de-obfuscate the flashvars to reach the higher renditions.)

    @staticmethod
    def _kvs_license_token(license_code: str) -> list[int]:
        """Port of yt-dlp's _kvs_get_license_token (generic.py)."""
        license_code = (license_code or "").replace("$", "")
        values = [int(c) for c in license_code]
        modlicense = license_code.replace("0", "1")
        center = len(modlicense) // 2
        fronthalf = int(modlicense[: center + 1])
        backhalf = int(modlicense[center:])
        modlicense = str(4 * abs(fronthalf - backhalf))[: center + 1]
        out: list[int] = []
        mod = [int(c) for c in modlicense]
        for index, current in enumerate(mod):
            for offset in range(4):
                out.append((values[index + offset] + current) % 10)
        return out

    @classmethod
    def _kvs_real_url(cls, video_url: str, license_code: str) -> str:
        """Port of yt-dlp's _kvs_get_real_url. Unscrambles the get_file HASH."""
        prefix = "function/0/"
        raw = video_url or ""
        if not raw.startswith(prefix):
            return raw  # not obfuscated
        body = raw[len(prefix):]
        if not license_code:
            return body
        parsed = urllib.parse.urlparse(body)
        parts = parsed.path.split("/")  # ['', 'get_file', '<seg>', '<HASH>', ...]
        HASH_LENGTH = 32
        seg = parts[3] if len(parts) > 3 else ""
        if len(seg) < HASH_LENGTH:
            return parsed.geturl()
        hash_ = seg[:HASH_LENGTH]
        token = cls._kvs_license_token(license_code)
        indices = list(range(HASH_LENGTH))
        accum = 0
        for src in range(HASH_LENGTH - 1, -1, -1):
            accum += token[src] if src < len(token) else 0
            dest = (src + accum) % HASH_LENGTH
            indices[src], indices[dest] = indices[dest], indices[src]
        parts[3] = "".join(hash_[i] for i in indices) + seg[HASH_LENGTH:]
        rebuilt = parsed._replace(path="/".join(parts))
        return urllib.parse.urlunparse(rebuilt)

    def _flashvars_streams(self, page_html: str) -> list[dict[str, Any]]:
        """De-obfuscate the KVS flashvars renditions — these carry 1080p/1440p."""
        lic_match = re.search(r"license_code\s*:\s*['\"]([^'\"]+)['\"]", page_html)
        license_code = lic_match.group(1) if lic_match else ""
        out: dict[str, dict[str, Any]] = {}
        key_re = re.compile(r"\bvideo_(?:alt_)?url\d*\s*:\s*['\"]([^'\"]+)['\"]")
        for match in key_re.finditer(page_html):
            raw = self._clean_stream_url(match.group(1))
            if "upgrade" in raw or "preview" in raw.lower():
                continue
            real = self._kvs_real_url(raw, license_code)
            # KVS get_file URLs carry a trailing slash (`…_720p.mp4/`), so match
            # the extension anywhere in the path, not just at the very end.
            if "/get_file/" not in real or not re.search(r"\.(?:mp4|m3u8)(?:[/?]|$)", real, re.I):
                continue
            suffix = re.search(r"[_-](2160|1440|1080|720|480|360|240)p?\.mp4", real, re.I)
            # The unsuffixed master (`…/<id>.mp4`) has no marker — leave 0 so a
            # labelled rendition wins the "best" tie without us guessing a height.
            height = int(suffix.group(1)) if suffix else 0
            if not height:
                # Newer KVS signs opaque file paths; quality is in the paired label.
                key = match.group(0).split(':', 1)[0].strip()
                label = re.search(r"\b" + re.escape(key) + r"_text\s*:\s*['\"]([^'\"]+)['\"]", page_html)
                if label:
                    height = self._quality_from_text(label.group(1))
            if real not in out or height > out[real]["height"]:
                out[real] = {"url": real, "height": height}
        return list(out.values())

    def _stream_candidates(self, page_html: str) -> list[dict[str, Any]]:
        """Collect all player variants instead of accepting the first default stream."""
        # De-obfuscated flashvars are authoritative AND expose the full rendition
        # ladder (up to 1440p). If we got any, use only those.
        flashvars = self._flashvars_streams(page_html)
        if flashvars:
            # Keep the page's remote player URL as a last-resort browser stream.
            # Cloudflare can reject the de-obfuscated get_file URL from the
            # server IP while the same remote_control URL still plays in Chrome.
            remote_urls = re.findall(
                r"https?://[^\s'\"<>]+/remote_control\.php\?[^\s'\"<>]+",
                page_html,
                re.I,
            )
            seen = {item["url"] for item in flashvars}
            for remote_url in remote_urls:
                remote_url = html_module.unescape(remote_url).replace("\\/", "/")
                if remote_url in seen:
                    continue
                seen.add(remote_url)
                flashvars.append({"url": remote_url, "height": 0, "is_remote": True})
            return flashvars

        candidates: dict[str, dict[str, Any]] = {}
        pattern = re.compile(
            r"https?:(?:\\/|/)[^\s'\"<>]+?(?:remote_control\.php[^\s'\"<>]*|\.(?:mp4|m3u8)(?:\?[^\s'\"<>]*)?)",
            re.I,
        )
        for match in pattern.finditer(page_html):
            stream_url = self._clean_stream_url(match.group(0))
            if not stream_url:
                continue
            # Listing previews are short teaser clips. They are playable but
            # must never replace the full video stored in the library.
            low_stream_url = stream_url.lower()
            if "preview" in low_stream_url or "upgrade" in low_stream_url:
                continue

            # Source variants are stored as small JS objects. Restrict the label
            # lookup to this object so a later `2K` label cannot upgrade 720p.
            object_start = page_html.rfind("{", 0, match.start())
            object_end = page_html.find("}", match.end())
            if object_start >= 0 and object_end >= match.end():
                context = page_html[object_start: object_end + 1]
            else:
                context = page_html[max(0, match.start() - 90): min(len(page_html), match.end() + 90)]
            height = self._quality_from_text(context)

            if "remote_control.php" in stream_url:
                try:
                    parsed = urllib.parse.urlparse(stream_url)
                    params = urllib.parse.parse_qs(parsed.query)
                    param_name = None
                    for name in ['res', 'q', 'quality', 'resolution']:
                        if name in params:
                            param_name = name
                            break
                    if not param_name:
                        param_name = 'res'

                    qualities = ['4k', '2k', '1080p', '720p', '480p', '360p']
                    for q in qualities:
                        new_params = params.copy()
                        new_params[param_name] = [q]
                        new_query = urllib.parse.urlencode(new_params, doseq=True)
                        new_url = urllib.parse.urlunparse((
                            parsed.scheme, parsed.netloc, parsed.path,
                            parsed.params, new_query, parsed.fragment
                        ))
                        
                        variant_height = 2160 if q == '4k' else 1440 if q == '2k' else int(q.replace('p', '')) if q.replace('p', '').isdigit() else 0
                        if new_url not in candidates or variant_height > candidates[new_url]["height"]:
                            candidates[new_url] = {"url": new_url, "height": variant_height}
                except Exception as e:
                    logging.error(f"Error generating PimpBunny variants: {e}")
                    if stream_url not in candidates or height > candidates[stream_url]["height"]:
                        candidates[stream_url] = {"url": stream_url, "height": height}
            else:
                if stream_url not in candidates or height > candidates[stream_url]["height"]:
                    candidates[stream_url] = {"url": stream_url, "height": height}

        return list(candidates.values())

    @staticmethod
    def _content_length(stream_url: str, headers: dict[str, str]) -> int:
        try:
            # Short timeout: a dead/slow CDN variant must not stall the import.
            response = requests.head(stream_url, headers=headers, timeout=4, allow_redirects=True)
            if "text/html" in (response.headers.get("Content-Type", "") or "").lower():
                return 0
            value = response.headers.get("Content-Length", "")
            return int(value) if value.isdigit() else 0
        except Exception:
            return 0

    def _choose_best_stream(self, candidates: list[dict[str, Any]], headers: dict[str, str]) -> Optional[dict[str, Any]]:
        if not candidates:
            return None

        # Group candidates by height, highest first.
        by_height: dict[int, list[dict[str, Any]]] = {}
        for item in candidates:
            by_height.setdefault(item["height"], []).append(item)
        sorted_heights = sorted(by_height.keys(), reverse=True)

        # Probe each height's candidates CONCURRENTLY (not serially — a serial
        # storm of HEAD requests across 6 quality variants was taking ~1 minute
        # per video and starving the server's thread pool). Stop at the first
        # height that yields a real Content-Length.
        for h in sorted_heights:
            finalists = by_height[h]
            valid_finalists: list[dict[str, Any]] = []
            with ThreadPoolExecutor(max_workers=min(6, len(finalists))) as pool:
                future_map = {pool.submit(self._content_length, item["url"], headers): item for item in finalists}
                for fut in as_completed(future_map):
                    item = future_map[fut]
                    try:
                        size = fut.result()
                    except Exception:
                        size = 0
                    if size > 0:
                        item["size_bytes"] = size
                        valid_finalists.append(item)
            if valid_finalists:
                valid_finalists.sort(key=lambda x: x.get("size_bytes", 0), reverse=True)
                return valid_finalists[0]

        # Fallback: if none returned a size, return the highest height one.
        remote = [item for item in candidates if item.get("is_remote")]
        if remote:
            return remote[0]
        highest_h = max(item["height"] for item in candidates)
        return [item for item in candidates if item["height"] == highest_h][0]

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        logging.info(f"Extracting metadata from PimpBunny: {url}")

        # Direct CDN media links (get_file/… paths) — no HTML to parse
        if self._is_direct_media_url(url) or "/get_file/" in url:
            path = url.split("?")[0].lower()
            is_hls = path.endswith(".m3u8")
            slug = url.rstrip("/").rsplit("/", 1)[-1].split("?")[0]
            title = re.sub(r"[_-]+", " ", slug.rsplit(".", 1)[0]).strip().title() or "PimpBunny Video"
            return {
                "id": None,
                "title": title,
                "description": "",
                "thumbnail": None,
                "duration": 0,
                "stream_url": url,
                "width": 0,
                "height": 0,
                "tags": [],
                "views": 0,
                "upload_date": None,
                "uploader": "",
                "is_hls": is_hls,
            }

        # All the work below is blocking (requests.get + HEAD probes). Run it in a
        # worker thread so it never blocks the async event loop — calling it
        # inline previously starved the server's thread pool and froze the
        # dashboard during bulk PimpBunny imports.
        return await asyncio.to_thread(self._extract_sync, url)

    def _extract_sync(self, url: str) -> Optional[Dict[str, Any]]:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': f'https://{self.domains[0]}/'
        }

        try:
            resp = browser_requests.get(url, headers=headers, timeout=8, impersonate="chrome")
            if resp.status_code != 200:
                return None

            page_html = resp.text
            candidates = self._stream_candidates(page_html)
            selected = self._choose_best_stream(candidates, headers)
            if not selected:
                return None
            stream_url = selected["url"]

            title = "PimpBunny Video"
            title_match = re.search(r'<title>(.*?)</title>', page_html, re.S | re.I)
            if title_match:
                title = title_match.group(1).split('|')[0].strip()

            thumb_url = None
            thumb_match = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', page_html, re.I)
            if thumb_match:
                thumb_url = thumb_match.group(1)

            # Lower renditions to fall back to if the chosen (top) stream is
            # rejected downstream — e.g. the CDN 410s the 1080p under a rate-limit
            # while 720p/480p still serve. Descending by height, excluding the pick.
            fallback_urls = [
                item["url"]
                for item in sorted(candidates, key=lambda x: x.get("height") or 0, reverse=True)
                if item["url"] != stream_url
            ]

            return {
                "id": None,
                "title": title,
                "description": "",
                "thumbnail": thumb_url,
                "duration": 0,
                "stream_url": stream_url,
                "width": 0,
                "height": int(selected.get("height") or 0),
                "size_bytes": int(selected.get("size_bytes") or 0),
                "quality_variants": sorted({item["height"] for item in candidates if item["height"]}, reverse=True),
                "fallback_urls": fallback_urls,
                "tags": [],
                "views": 0,
                "upload_date": None,
                "uploader": "",
                "is_hls": ".m3u8" in stream_url
            }
        except Exception as e:
            logging.error(f"PimpBunny extraction failed: {e}")
            return None
