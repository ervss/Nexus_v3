import logging
import re
import asyncio
from typing import Optional, Dict, Any, List
import base64
import json
import urllib.parse
from bs4 import BeautifulSoup
from curl_cffi.requests import AsyncSession
from .base import VideoExtractor, ntc_get
from app.ntc import NTCStatusError, ntc
from app.ntc.bunkr_scheduler import fetch_durable

logger = logging.getLogger(__name__)

BUNKR_DOMAINS = [
    "bunkr.site", "bunkr.red",
    "balbums.st", "bunkr.la", "bunkr.si", "bunkr.is", "bunkr-albums.io", "bunkr.cr",
    "bunkr.black", "bunkr.su", "bunkr.pk", "bunkrr.su", "bunkr.ws",
    "bunkr.vc", "bunkr.media", "bunkr.ru", "bunkr.to", "bunkr.ac",
    "bunkr.ph", "bunkr.sk", "bunkr.ps", "bunkr.fi", "bunkrr.pics"
]

_SHARED_BUNKR_SESSION: Optional[AsyncSession] = None

async def get_bunkr_session() -> AsyncSession:
    global _SHARED_BUNKR_SESSION
    if _SHARED_BUNKR_SESSION is None:
        _SHARED_BUNKR_SESSION = AsyncSession(impersonate="chrome120", timeout=25, verify=False)
    return _SHARED_BUNKR_SESSION

class BunkrExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "Bunkr"

    def can_handle(self, url: str) -> bool:
        parsed = urllib.parse.urlparse(url)
        host = parsed.netloc.lower().split(":", 1)[0]
        if host in {"findr.to", "www.findr.to"} and re.match(r"^/albums/\d+/?$", parsed.path):
            return True
        page_mirrors = BUNKR_DOMAINS
        lower = url.lower()
        if not any(x in lower for x in page_mirrors):
            return False
        # Album links are handled via extract_album(), routed through extract()
        if re.search(r"/(a|albums|album)/", lower):
            return True
        # Bunkr file/video page routes
        if re.search(r"/(f|v)/", lower):
            return True
        # Reject direct CDN file links (no page to scrape)
        path = lower.split('?')[0].split('#')[0]
        if re.search(r'\.(mp4|mkv|mov|webm|m4v|avi)$', path):
            return False
        return True

    def _absolute_url(self, base_url: str, href: str) -> str:
        if href.startswith("//"):
            return "https:" + href
        return urllib.parse.urljoin(base_url, href)

    def _is_valid_media_stream(self, value: str) -> bool:
        raw = str(value or "").strip()
        if not raw:
            return False
        low = raw.lower()
        if not low.startswith(("http://", "https://")):
            return False
        if "/uploads/" in low or "/images/" in low or "/thumbs/" in low:
            return False
        return bool(re.search(r"\.(mp4|mkv|mov|webm|m4v|avi)(?:[?#]|$)", low))

    def _script_var(self, html: str, name: str) -> str:
        pattern = rf"var\s+{re.escape(name)}\s*=\s*([\"'])(.*?)\1\s*;"
        match = re.search(pattern, html or "", re.I | re.S)
        if not match:
            return ""
        return match.group(2).replace("\\/", "/").strip()

    def _with_query_params(self, url: str, **params: str) -> str:
        parsed = urllib.parse.urlparse(url)
        query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
        for key, value in params.items():
            if value is None:
                query.pop(key, None)
            else:
                query[key] = str(value)
        return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query)))

    def _album_thumbnail(self, container: Any, page_url: str) -> str:
        """Return a real thumbnail from Bunkr's eager or lazy image markup."""
        if not container:
            return ""

        candidates: List[str] = []
        for element in container.select("img, source"):
            for attr in (
                "data-src", "data-original", "data-lazy-src", "data-lazy",
                "data-thumb", "data-srcset", "srcset", "src",
            ):
                raw = str(element.get(attr) or "").strip()
                if not raw:
                    continue
                # srcset may contain several width/density variants. Prefer the
                # last (normally largest) candidate.
                parts = [part.strip().split()[0] for part in raw.split(",") if part.strip()]
                candidates.extend(reversed(parts))

        for raw in candidates:
            low = raw.lower()
            if (
                not raw
                or low.startswith(("data:", "blob:"))
                or "video.svg" in low
                or "placeholder" in low
            ):
                continue
            absolute = self._absolute_url(page_url, raw)
            if absolute.startswith(("http://", "https://")):
                return absolute
        return ""

    def _album_page_links(self, soup: BeautifulSoup, page_url: str) -> List[str]:
        """Find paginated album pages when advanced mode is not available."""
        parsed_current = urllib.parse.urlparse(page_url)
        current_path = parsed_current.path.rstrip("/")
        urls = []
        seen = {page_url}
        page_numbers = set()

        for a in soup.find_all("a", href=True):
            href = self._absolute_url(page_url, a.get("href", ""))
            parsed = urllib.parse.urlparse(href)
            if parsed.netloc != parsed_current.netloc or parsed.path.rstrip("/") != current_path:
                continue
            query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
            raw_page = query.get("page")
            if raw_page and raw_page.isdigit():
                page_numbers.add(int(raw_page))
            if href not in seen and (raw_page or re.search(r"\b\d+\b", a.get_text(" ", strip=True))):
                seen.add(href)
                urls.append(href)

        if page_numbers:
            for page_num in range(2, max(page_numbers) + 1):
                href = self._with_query_params(page_url, page=page_num, advanced=None)
                if href not in seen:
                    seen.add(href)
                    urls.append(href)

        return urls

    def _append_album_items(self, soup: BeautifulSoup, page_url: str, source_url: str, seen: set, results: List[Dict[str, Any]]) -> int:
        before = len(results)

        if "bunkrr.pics" in urllib.parse.urlparse(page_url).netloc.lower():
            for row_el in soup.select('div.border-b.py-3.px-3'):
                link = row_el.find('a', href=lambda h: h and re.search(r'/(f|v)/', h))
                if not link or link.get_text(strip=True).lower() == 'open':
                    continue
                href = link.get('href', '')
                file_url = self._absolute_url(page_url, href)
                if file_url in seen:
                    continue
                seen.add(file_url)

                title = link.get_text(strip=True)
                thumb = self._album_thumbnail(row_el, page_url)

                size_text = ''
                for text_el in row_el.find_all(string=True):
                    m = re.search(r'^\s*([\d.]+)\s*(TB|GB|MB|KB|B)\s*$', text_el, re.I)
                    if m:
                        size_text = text_el.strip()
                        break

                date_text = ''
                date_el = row_el.select_one('.theDate, time, [class*="date"], [data-date]')
                if date_el:
                    date_text = (date_el.get('datetime') or date_el.get('data-date') or
                                 date_el.get_text(' ', strip=True))
                if not date_text:
                    match = re.search(
                        r'\b(?:\d{1,2}:\d{2}(?::\d{2})?\s+)?(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}-\d{1,2}-\d{1,2})\b',
                        row_el.get_text(' ', strip=True),
                    )
                    date_text = match.group(0) if match else ''

                parsed_file = urllib.parse.urlparse(file_url)
                origin_file = f"{parsed_file.scheme}://{parsed_file.netloc}"
                name_file = parsed_file.path.lstrip("/")
                results.append({
                    "url": file_url,
                    "cdn": origin_file,
                    "name": name_file,
                    "title": title or name_file.rsplit("/", 1)[-1],
                    "thumb": thumb,
                    "size": size_text,
                    "date": date_text,
                    "source_url": file_url,
                    "album_url": source_url,
                })

        for card in soup.select('.theItem'):
            link = card.find('a', href=True)
            if not link:
                continue
            href = link.get('href', '')
            if not re.search(r'/(f|v)/', href, re.I):
                continue

            file_url = self._absolute_url(page_url, href)
            if file_url in seen:
                continue
            seen.add(file_url)

            title = (card.get('title') or '').strip()
            if not title:
                name_el = card.select_one('.theName')
                title = name_el.get_text(' ', strip=True) if name_el else ''

            thumb = self._album_thumbnail(card, page_url)

            size_text = ''
            size_el = card.select_one('.theSize')
            if size_el:
                size_text = size_el.get_text(' ', strip=True)

            date_text = ''
            date_el = card.select_one('.theDate')
            if date_el:
                date_text = date_el.get_text(' ', strip=True)

            parsed = urllib.parse.urlparse(file_url)
            origin = f"{parsed.scheme}://{parsed.netloc}"
            name = parsed.path.lstrip("/")
            results.append({
                "url": file_url,
                "cdn": origin,
                "name": name,
                "title": title or name.rsplit("/", 1)[-1],
                "thumb": thumb,
                "size": size_text,
                "date": date_text,
                "source_url": file_url,
                    "album_url": source_url,
            })

        if len(results) == before:
            for a in soup.find_all('a', href=True):
                href = a.get('href', '')
                if not re.search(r'/(f|v)/', href, re.I):
                    continue
                file_url = self._absolute_url(page_url, href)
                if file_url in seen:
                    continue
                seen.add(file_url)
                parsed = urllib.parse.urlparse(file_url)
                origin = f"{parsed.scheme}://{parsed.netloc}"
                name = parsed.path.lstrip("/")
                results.append({
                    "url": file_url,
                    "cdn": origin,
                    "name": name,
                    "title": name.rsplit("/", 1)[-1],
                    "thumb": "",
                    "source_url": file_url,
                    "album_url": source_url,
                })

        return len(results) - before

    async def _sign_cdn_url(self, session: AsyncSession, raw_url: str, sign_url: str, referer: str) -> str:
        if not raw_url or not sign_url:
            return raw_url
        try:
            parsed = urllib.parse.urlparse(raw_url)
            path = urllib.parse.unquote(parsed.path or "")
            separator = "&" if "?" in sign_url else "?"
            url = f"{sign_url}{separator}path={urllib.parse.quote(path, safe='')}"
            resp = await ntc.request(
                url,
                cache=False, deadline=12,
                headers={
                    "Accept": "application/json",
                    "Referer": referer,
                    "Origin": f"{urllib.parse.urlparse(referer).scheme}://{urllib.parse.urlparse(referer).netloc}",
                },
            )
            if resp.status_code != 200:
                return raw_url
            data = json.loads(resp.text)
            token = data.get("token")
            expires = data.get("ex")
            if not token or not expires:
                return raw_url
            parts = list(parsed)
            query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
            query["token"] = str(token)
            query["ex"] = str(expires)
            parts[4] = urllib.parse.urlencode(query)
            return urllib.parse.urlunparse(parts)
        except Exception as e:
            if fetch_durable.get():
                raise
            logger.debug("Bunkr CDN signing failed for %s: %s", raw_url, e)
            return raw_url

    def _parse_file_page(self, html: str, file_url: str) -> Dict[str, Any]:
        soup = BeautifulSoup(html or "", "html.parser")
        title = ""
        og_title = soup.find("meta", property="og:title")
        if og_title:
            title = (og_title.get("content") or "").strip()
        if not title:
            t = soup.find("title")
            if t:
                title = t.get_text(" ", strip=True).replace(" - Bunkr", "").strip()
        thumbnail = ""
        og_image = soup.find("meta", property="og:image")
        if og_image:
            thumbnail = (og_image.get("content") or "").strip()
            if thumbnail.startswith("//"):
                thumbnail = "https:" + thumbnail
        size_text = ""
        size_el = soup.select_one(".theSize")
        if size_el:
            size_text = size_el.get_text(" ", strip=True)
        if not size_text:
            m_size = re.search(r"\b([\d,.]+\s*(?:TB|GB|MB|KB))\b", html or "", re.I)
            if m_size:
                size_text = m_size.group(1).strip()
        return {"title": title, "thumb": thumbnail, "size": size_text, "source_url": file_url}

    async def extract_album(self, url: str, *, listing_only: bool = False) -> List[Dict[str, Any]]:
        """Extract Bunkr album file page URLs from an album page.

        ``listing_only`` keeps a multi-album workspace fast: it returns the
        complete album listing without opening every individual file page for
        title/cover/size enrichment.  The normal path remains unchanged for
        callers that need ready-to-display individual-file metadata.
        """
        headers = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://bunkr.cr/',
        }
        results: List[Dict[str, Any]] = []
        seen = set()

        # Extract album ID and domain
        parsed_url = urllib.parse.urlparse(url)
        path_parts = parsed_url.path.strip('/').split('/')
        if not path_parts or path_parts[0] not in ('a', 'album', 'albums'):
            logger.warning("Invalid Bunkr album URL: %s", url)
            return []

        if parsed_url.netloc.lower().split(":", 1)[0] in {"findr.to", "www.findr.to"}:
            album_id = path_parts[1] if len(path_parts) > 1 else ""
            if not album_id.isdigit():
                return []
            try:
                session = await get_bunkr_session()
                first_response = await session.get(
                    f"https://findr.to/api/albums/{album_id}",
                    params={"page": 1, "limit": 100},
                    headers={"Accept": "application/json", "Referer": "https://findr.to/"},
                )
                if first_response.status_code != 200:
                    logger.warning("Findr album API HTTP %s for %s", first_response.status_code, album_id)
                    return []
                first_payload = first_response.json()
                total_pages = max(1, min(int(first_payload.get("total_pages") or 1), 500))
                payloads = [first_payload]
                if total_pages > 1:
                    async def fetch_page(page: int) -> Optional[Dict[str, Any]]:
                        try:
                            response = await session.get(
                                f"https://findr.to/api/albums/{album_id}",
                                params={"page": page, "limit": 100},
                                headers={"Accept": "application/json", "Referer": "https://findr.to/"},
                            )
                            if response.status_code != 200:
                                return None
                            return response.json()
                        except Exception as exc:
                            logger.debug("Findr album page %s failed for %s: %s", page, album_id, exc)
                            return None
                    pages = await asyncio.gather(*(fetch_page(page) for page in range(2, total_pages + 1)))
                    payloads.extend(payload for payload in pages if payload)

                results: List[Dict[str, Any]] = []
                seen: set[str] = set()
                for payload in payloads:
                    for entry in payload.get("files") or []:
                        if not isinstance(entry, dict):
                            continue
                        file_url = str(entry.get("source_link") or "").strip()
                        if not file_url or file_url in seen:
                            continue
                        seen.add(file_url)
                        parsed_file = urllib.parse.urlparse(file_url)
                        title = str(entry.get("filename") or parsed_file.path.rsplit("/", 1)[-1] or "Bunkr file")
                        results.append({
                            "url": file_url,
                            "cdn": f"{parsed_file.scheme}://{parsed_file.netloc}",
                            "name": parsed_file.path.lstrip("/"),
                            "title": title,
                            "thumb": str(entry.get("thumbnail_path") or ""),
                            "size": str(entry.get("file_size") or ""),
                            "size_bytes": int(entry.get("file_size_bytes") or 0),
                            "date": str(entry.get("created_at") or ""),
                            "source_url": file_url,
                            "album_url": str(first_payload.get("original_url") or url),
                        })

                try:
                    from app.bunkr_cache import album_put
                    album_put(url, results)
                except Exception:
                    pass
                if listing_only or not results:
                    return results

                semaphore = asyncio.Semaphore(5)
                async def enrich_one(item: Dict[str, Any]) -> None:
                    async with semaphore:
                        try:
                            data = await self.extract(item["url"], metadata_only=True)
                            if data:
                                item["title"] = item.get("title") or data.get("title") or ""
                                item["thumb"] = item.get("thumb") or data.get("thumbnail") or ""
                        except Exception:
                            return
                await asyncio.gather(*(enrich_one(item) for item in results), return_exceptions=True)
                return results
            except Exception as exc:
                logger.warning("Findr album extraction failed for %s: %s", url, exc)
                return []

        try:
            from app.bunkr_cache import album_get
            cached = album_get(url)
            if cached and cached.get("items"):
                return list(cached["items"])
        except Exception:
            pass
        
        album_id = path_parts[1] if len(path_parts) > 1 else ""
        current_domain = parsed_url.netloc

        # Strategy: try current domain first, then fall back to maximum 2 others if 403
        domains_to_try = [current_domain] + [d for d in BUNKR_DOMAINS if d != current_domain][:2]

        for domain in domains_to_try:
            if "bunkrr.pics" in domain:
                query = parsed_url.query
                q_str = f"?{query}" if query else ""
                p_type = path_parts[0] if path_parts[0] in ('albums', 'album', 'a') else 'albums'
                try_url = f"https://{domain}/{p_type}/{album_id}{q_str}"
            elif domain == current_domain:
                p_type = path_parts[0] if path_parts[0] in ('albums', 'album', 'a') else 'a'
                try_url = f"https://{domain}/{p_type}/{album_id}"
            else:
                try_url = f"https://{domain}/a/{album_id}"
            try:
                primary_url = try_url
                urls_to_fetch = []
                if "bunkrr.pics" not in domain:
                    urls_to_fetch.append(self._with_query_params(primary_url, advanced="1", page=None))
                urls_to_fetch.append(primary_url)

                parsed_pages = set()
                saw_403 = False
                for fetch_url in urls_to_fetch:
                    if fetch_url in parsed_pages:
                        continue
                    parsed_pages.add(fetch_url)
                    before_fetch = len(results)
                    try:
                        html = await ntc_get(fetch_url, domain=domain, headers=headers, deadline=25)
                    except NTCStatusError as status_err:
                        if status_err.status_code == 403:
                            saw_403 = True
                            logger.info("Bunkr domain %s returned 403, trying next...", domain)
                            continue
                        raise
                    soup = BeautifulSoup(html, 'html.parser')
                    page_url = fetch_url
                    self._append_album_items(soup, page_url, url, seen, results)
                    page_links = self._album_page_links(soup, page_url)

                    is_advanced = urllib.parse.parse_qs(urllib.parse.urlparse(page_url).query).get("advanced") == ["1"]
                    if is_advanced and len(results) > before_fetch and not page_links:
                        logger.info(
                            "Bunkr album advanced view extracted %s items from %s (via %s)",
                            len(results),
                            url,
                            domain,
                        )
                        break

                    for page_link in page_links:
                        if page_link in parsed_pages:
                            continue
                        parsed_pages.add(page_link)
                        try:
                            page_html = await ntc_get(page_link, domain=domain, headers=headers, deadline=25)
                            page_soup = BeautifulSoup(page_html, 'html.parser')
                            self._append_album_items(page_soup, page_link, url, seen, results)
                        except NTCStatusError:
                            if fetch_durable.get():
                                raise
                            continue
                        except Exception as page_exc:
                            if fetch_durable.get():
                                raise
                            logger.debug("Bunkr album page fetch failed for %s: %s", page_link, page_exc)

                if results:
                    logger.info("Bunkr album extracted %s items from %s (via %s)", len(results), url, domain)
                    break # Successfully extracted
                if saw_403:
                    continue
            except Exception as e:
                if fetch_durable.get():
                    raise
                logger.warning("Bunkr album extraction attempt failed for %s (domain %s): %s", url, domain, e)
                continue

        if results and not listing_only:
            async def resolve_one(item: Dict[str, Any]):
                file_url = item.get("url") or ""
                try:
                    from app.bunkr_cache import file_meta_get, file_meta_put
                    hit = file_meta_get(file_url)
                    if hit:
                        if hit.get("title"):
                            item["title"] = hit["title"]
                        if hit.get("thumbnail"):
                            item["thumb"] = hit["thumbnail"]
                        if hit.get("size"):
                            item["size"] = hit["size"]
                        return item
                except Exception:
                    pass
                if file_url:
                    try:
                        html = await ntc_get(file_url, deadline=22.0, priority="low")
                        parsed = self._parse_file_page(html, file_url)
                        for key, value in parsed.items():
                            if value:
                                item[key] = value
                        try:
                            from app.bunkr_cache import file_meta_put
                            file_meta_put(file_url, {
                                "title": item.get("title"),
                                "thumbnail": item.get("thumb"),
                                "size": item.get("size"),
                            })
                        except Exception:
                            pass
                    except Exception as e:
                        logger.warning("bunkr_file_fail url=%s err=%s", file_url, e)
                    return item

            from app.async_work import map_unordered
            # Only missing listing fields need a detail request. Keep album order.
            sparse = [item for item in results if not item.get("title") or not item.get("thumb") or not item.get("size")]
            async for _ in map_unordered(sparse, resolve_one, workers=5):
                pass
            try:
                from app.bunkr_cache import album_put, file_meta_flush
                file_meta_flush()
                album_put(url, results)
            except Exception:
                pass

        if results and listing_only:
            from app.bunkr_cache import album_put
            album_put(url, results)
        return results

    async def extract_file(self, url: str) -> Optional[str]:
        result = await self.extract(url)
        if result:
            return result.get("stream_url")
        return None

    def _decode_bunkr_vs_url(self, encoded: str, timestamp: int) -> Optional[str]:
        """
        Decode URL from /api/vs response.
        Mirrors player.enc.js logic:
        key = "SECRET_KEY_" + floor(timestamp/3600)
        decoded = xor(base64_decode(url), key)
        """
        if not encoded:
            return None
        try:
            raw = base64.b64decode(encoded)
            key = f"SECRET_KEY_{int(timestamp // 3600)}".encode("utf-8")
            out = bytes(b ^ key[i % len(key)] for i, b in enumerate(raw))
            return out.decode("utf-8", errors="ignore")
        except Exception as e:
            logger.debug(f"Bunkr URL decode failed: {e}")
            return None

    async def _api_resolve(self, session: AsyncSession, page_url: str, slug: str) -> Optional[str]:
        """Resolve direct stream URL using Bunkr page API (/api/vs)."""
        parsed = urllib.parse.urlparse(page_url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        try:
            resp = await ntc.request(
                f"{origin}/api/vs",
                method="POST", idempotent=True, cache=False, deadline=12,
                json={"slug": slug},
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Referer": page_url,
                    "Origin": origin,
                },
            )
            if resp.status_code == 200:
                data = json.loads(resp.text)
                u = data.get("url")
                if u:
                    if data.get("encrypted"):
                        u = self._decode_bunkr_vs_url(u, int(data.get("timestamp") or 0))
                    if u:
                        return ("https:" + u) if str(u).startswith("//") else str(u)
        except Exception as e:
            if fetch_durable.get():
                raise
            logger.debug(f"Bunkr /api/vs resolve failed for {slug}: {e}")
        return None

    async def extract(self, url: str, *, metadata_only: bool = False) -> Optional[Dict[str, Any]]:
        """
        Extracts metadata and direct stream URL from a Bunkr file/album page.
        Album URLs (/a/, /album/) return first video's stream URL.
        Uses Bunkr private API first (reliable), falls back to HTML parsing.
        """
        headers = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://bunkr.cr/',
        }
        parsed = urllib.parse.urlparse(url)
        path = parsed.path or ""
        path_parts = path.strip('/').split('/')

        # Route album URLs through extract_album()
        if path_parts and path_parts[0] in ('a', 'album', 'albums'):
            items = await self.extract_album(url, listing_only=True)
            if not items:
                logger.warning("Bunkr album empty or inaccessible: %s", url)
                return None
            first = items[0]
            item_url = first.get("url") or ""
            if item_url and not item_url.startswith(("http://", "https://")):
                cdn = first.get("cdn", "")
                name = first.get("name", "")
                item_url = f"{cdn}/{name}" if cdn else item_url
            # Try to extract stream from the first file's page URL
            if item_url and re.search(r"/(f|v)/", item_url):
                return await self.extract(item_url, metadata_only=metadata_only)
            return {
                "id": first.get("name", ""),
                "title": first.get("title", ""),
                "description": f"Bunkr album ({len(items)} files)",
                "thumbnail": first.get("thumb", ""),
                "duration": 0,
                "stream_url": item_url,
                "width": 0,
                "height": 0,
                "tags": [],
                "uploader": "Bunkr",
                "is_hls": False,
            }

        if len(path_parts) < 2 or path_parts[0] not in ('f', 'v'):
            logger.warning("Invalid Bunkr file URL: %s", url)
            return None
            
        file_type = path_parts[0]
        slug = path_parts[1]
        # For /f/<slug>.mp4 style page URLs, /api/vs expects slug without extension.
        slug_no_ext = re.sub(r'\.(mp4|mkv|mov|webm|m4v|avi)$', '', slug, flags=re.I)
        current_domain = parsed.netloc

        domains_to_try = [current_domain] + [d for d in BUNKR_DOMAINS if d != current_domain][:2]

        for domain in domains_to_try:
            try_url = f"https://{domain}/{file_type}/{slug}"
            try:
                session = None  # All HTTP, including /api/vs, now goes through NTC.
                # --- Step 1: Bunkr page API (/api/vs) used by player.enc.js ---
                stream_url = await self._api_resolve(session, try_url, slug_no_ext or slug)
                if not stream_url and slug_no_ext != slug:
                    stream_url = await self._api_resolve(session, try_url, slug)
                
                if stream_url:
                    logger.info(f"Bunkr /api/vs resolved {slug} -> {stream_url[:80]} (via {domain})")

                # Album Helper already has the title and cover. Its duration /
                # dimensions probe only needs a valid CDN URL, not a second
                # full-page GET. Keep HTML fallback and normal extraction intact.
                if metadata_only and self._is_valid_media_stream(stream_url):
                    return {
                        "id": slug, "title": slug, "thumbnail": "",
                        "duration": 0, "width": 0, "height": 0, "size": "",
                        "stream_url": stream_url, "is_hls": False,
                    }

                # --- Step 2: HTML parse fallback ---
                title = ""
                thumbnail = ""
                file_size = ""
                upload_date = ""
                script_cover = ""
                
                # Optimization: Use a tighter timeout for the full page fetch.
                # Bunkr pages can be slow; we don't want to block for 20s if API resolve worked.
                try:
                    html = await ntc_get(try_url, domain=domain, headers=headers, deadline=10)
                except NTCStatusError as status_err:
                    if status_err.status_code == 403:
                        continue
                    if fetch_durable.get():
                        raise
                    html = ""
                except Exception:
                    if fetch_durable.get():
                        raise
                    html = ""

                if html:
                    soup = BeautifulSoup(html, 'html.parser')
                    date_el = soup.select_one('.theDate, time[datetime], [data-date], meta[property="article:published_time"], meta[itemprop="uploadDate"]')
                    if date_el:
                        upload_date = (date_el.get('datetime') or date_el.get('data-date') or
                                       date_el.get('content') or date_el.get_text(' ', strip=True))
                    og_title = soup.find('meta', property='og:title')
                    if og_title:
                        title = og_title.get('content', '').strip()
                    if not title:
                        t = soup.find('title')
                        if t:
                            title = t.text.replace(' - Bunkr', '').strip()

                    og_image = soup.find('meta', property='og:image')
                    if og_image:
                        thumbnail = og_image.get('content', '').strip()
                        if thumbnail.startswith('//'):
                            thumbnail = 'https:' + thumbnail

                    script_cdn = self._script_var(html, "jsCDN")
                    script_sign_url = self._script_var(html, "signUrl")
                    script_cover = self._script_var(html, "videoCoverUrl")
                    if script_cover and not thumbnail:
                        thumbnail = script_cover
                    if script_cdn and self._is_valid_media_stream(script_cdn):
                        stream_url = await self._sign_cdn_url(session, script_cdn, script_sign_url, try_url)

                    if not stream_url:
                        video_tag = soup.find('video')
                        if video_tag:
                            src = (video_tag.find('source') or {}).get('src') or video_tag.get('src')
                            if src and not src.startswith('blob:') and src not in ('/', '#'):
                                candidate = ('https:' + src) if src.startswith('//') else self._absolute_url(try_url, src)
                                if self._is_valid_media_stream(candidate):
                                    stream_url = candidate

                    if not stream_url:
                        for a in soup.find_all('a', href=True):
                            h = a['href']
                            if any(x in h for x in ['.mp4', '.mkv', '.webm', 'media-files', 'scdn.st']):
                                if h.startswith('//'): h = 'https:' + h
                                elif h.startswith('/'): h = f"https://{domain}{h}"
                                if self._is_valid_media_stream(h):
                                    stream_url = h; break

                    if not stream_url and html:
                        m = re.search(r'https?://[a-z0-9.-]+\.(?:st|su|io|is|si|la|cr)/[^\s"\'<>]+\.(?:mp4|mkv|mov|webm|m4v|avi)(?:[?#][^\s"\'<>]*)?', html)
                        if m:
                            candidate = m.group(0)
                            if self._is_valid_media_stream(candidate):
                                stream_url = candidate

                    # Parse file size from the file detail page
                    file_size = ""
                    if html:
                        size_el = soup.select_one('.theSize')
                        if size_el:
                            file_size = size_el.get_text(' ', strip=True)
                        if not file_size:
                            m_size = re.search(r'\b([\d,.]+\s*(?:TB|GB|MB|KB))\b', html, re.I)
                            if m_size:
                                file_size = m_size.group(1).strip()

                if stream_url and self._is_valid_media_stream(stream_url):
                    if stream_url.startswith('//'):
                        stream_url = 'https:' + stream_url

                    if not title:
                        title = slug

                    return {
                        "id": slug,
                        "title": title,
                        "description": f"Extracted from Bunkr ({domain})",
                        "thumbnail": thumbnail,
                        "storyboard_url": (script_cover or "").replace(r"\/", "/"),
                        "duration": 0,
                        "stream_url": stream_url,
                        "width": 0,
                        "height": 0,
                        "size": file_size,
                        "upload_date": upload_date,
                        "tags": [],
                        "uploader": "Bunkr",
                        "is_hls": False
                    }
            except Exception as e:
                if fetch_durable.get():
                    raise
                logger.debug(f"Bunkr extraction attempt failed for {domain}: {e}")
                continue

        logger.warning(f"Bunkr extractor: failed to extract {url} after trying multiple domains")
        return None

    async def heal(self, video_id: int, source_url: str, db_session) -> bool:
        """
        Special healing method for Bunkr links.
        If a direct link is dead, this re-extracts it and updates the DB.
        """
        logger.info(f"Healing Bunkr video {video_id} using source {source_url}")
        result = await self.extract(source_url)
        if result and result.get('stream_url'):
            from ..database import Video
            video = db_session.query(Video).get(video_id)
            if video:
                video.url = result['stream_url']
                video.last_checked = asyncio.get_event_loop().time() # Or datetime
                import datetime
                video.last_checked = datetime.datetime.now()
                db_session.commit()
                logger.info(f"Successfully healed Bunkr video {video_id}")
                return True
        return False
