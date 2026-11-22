import re
import logging
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

import base64
from urllib.parse import urlparse

def sxyprn_ssut51(arg: Any) -> int:
    s = re.sub(r'[^0-9]', '', str(arg or ''))
    return sum(int(c) for c in s)

def sxyprn_boo(ss: int, es: int, host: str) -> str:
    try:
        raw = f"{ss}-{host}-{es}"
        b = base64.b64encode(raw.encode('ascii')).decode('ascii')
        return b.replace('+', '-').replace('/', '_').replace('=', '.')
    except Exception:
        return ""

def resolve_sxyprn_cdn_url(raw_path: str, page_url: str) -> Optional[str]:
    try:
        parsed = urlparse(page_url)
        host = parsed.hostname or ("www.sxyprn.net" if "sxyprn.net" in str(page_url).lower() else "sxyprn.com")
        clean = str(raw_path or '').replace('\\', '')
        tmp = clean.split('/')
        if len(tmp) < 8:
            return None
        s6 = sxyprn_ssut51(tmp[6])
        s7 = sxyprn_ssut51(tmp[7])
        tmp[1] += '8/' + sxyprn_boo(s6, s7, host)
        tmp[5] = str(int(tmp[5]) - (s6 + s7))
        return f"https://{host}" + '/'.join(tmp)
    except Exception as e:
        logger.warning(f"resolve_sxyprn_cdn_url error: {e}")
        return None

class SxyPrnExtractor:
    def __init__(self):
        self.name = "SxyPrn"

    def can_handle(self, url: str) -> bool:
        value = url.lower()
        return "sxyprn.com" in value or "sxyprn.net" in value

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        import httpx
        from bs4 import BeautifulSoup

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://sxyprn.net/' if "sxyprn.net" in url.lower() else 'https://sxyprn.com/',
        }

        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                resp = await client.get(url, headers=headers)
                if resp.status_code != 200:
                    logger.warning(f"SxyPrn: Failed to fetch page {url}, status: {resp.status_code}")
                    return None

                html = resp.text
                soup = BeautifulSoup(html, 'html.parser')

                # Title
                title = ""
                og_title = soup.find('meta', property='og:title')
                if og_title:
                    title = og_title.get('content', '').strip()
                if not title:
                    title_tag = soup.find('title')
                    if title_tag:
                        title = re.sub(r'\s*-\s*SxyPrn.*$', '', title_tag.text.strip(), flags=re.IGNORECASE)

                # Thumbnail
                thumbnail = ""
                og_image = soup.find('meta', property='og:image')
                if og_image:
                    thumbnail = og_image.get('content', '').strip()
                if not thumbnail:
                    video_tag = soup.find('video')
                    if video_tag:
                        thumbnail = video_tag.get('poster', '') or video_tag.get('data-poster', '')

                # Duration
                duration = 0
                dur_tag = soup.find(class_='duration_small') or soup.find(class_='duration')
                if dur_tag:
                    dur_text = dur_tag.get_text(strip=True)
                    try:
                        parts = dur_text.split(':')
                        if len(parts) == 2:
                            duration = int(parts[0]) * 60 + int(parts[1])
                        elif len(parts) == 3:
                            duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                    except Exception:
                        pass

                # 1. Primary: Probe ALL external host mirrors (Vidara, LuluStream, Streamtape, DoodStream)
                # and automatically select the highest quality / largest file size stream!
                stream_url = ""
                embed_fallback = ""
                is_hls = False
                best_height = 0
                best_quality = ""
                best_size_mb = 0.0
                clean_post_id = re.search(r"/post/([a-f0-9]+)", url)
                target_post_id = clean_post_id.group(1) if clean_post_id else ""

                if target_post_id:
                    try:
                        import asyncio
                        from app.sxyprn_discovery import _parse_post_detail, probe_best_post_streams
                        detail = await asyncio.to_thread(_parse_post_detail, html, target_post_id)
                        streams = detail.get("streams") or []
                        if not streams:
                            from app.sxyprn_discovery import fetch_post_streams
                            streams = await asyncio.to_thread(fetch_post_streams, target_post_id, url)
                        if not duration and detail.get("duration_sec"):
                            duration = int(detail["duration_sec"])
                        best_height = int(detail.get("height") or 0)
                        best_quality = detail.get("quality") or ""
                        best_size_mb = float(detail.get("file_size_mb") or 0.0)

                        if streams:
                            probed = await probe_best_post_streams(
                                streams,
                                duration_sec=duration,
                                fallback_quality=best_quality,
                                fallback_height=best_height,
                                fallback_size_mb=best_size_mb,
                                client=client,
                            )
                            best_cand = probed.get("best")
                            if best_cand and best_cand.get("is_direct_stream") and best_cand.get("stream_url"):
                                stream_url = best_cand["stream_url"]
                                is_hls = bool(best_cand.get("is_hls", ".m3u8" in stream_url.lower()))
                                if best_cand.get("height"):
                                    best_height = int(best_cand["height"])
                                    best_quality = best_cand.get("quality") or f"{best_height}p"
                                if best_cand.get("file_size_mb"):
                                    best_size_mb = float(best_cand["file_size_mb"])
                                logger.info(
                                    f"[SxyPrn] Selected BEST external stream ({best_cand.get('host')} "
                                    f"{best_quality} ~{best_size_mb} MB): {stream_url[:80]}"
                                )

                            # Embed fallback from external host if no direct stream resolved
                            if not stream_url:
                                for s in streams:
                                    s_url = s.get("url", "")
                                    if any(x in s_url.lower() for x in ["vidara.so", "vidara.to"]):
                                        code = s_url.split("/")[-1].split("?")[0]
                                        domain = "vidara.to" if "vidara.to" in s_url.lower() else "vidara.so"
                                        embed_fallback = f"https://{domain}/e/{code}"
                                        is_hls = False
                                        logger.info(f"[SxyPrn] Fallback to Vidara embed: {embed_fallback}")
                                        break
                                    elif any(h in s_url.lower() for h in ["lulustream.com", "luluvdo.com", "luluvid.com", "lulust.com", "lplaygo.com"]):
                                        code = s_url.split("/")[-1].split("?")[0]
                                        embed_fallback = f"https://lulustream.com/e/{code}"
                                        is_hls = False
                                        logger.info(f"[SxyPrn] Fallback to Lulu embed: {embed_fallback}")
                                        break
                                    elif any(h in s_url.lower() for h in ["doodstream.com", "doodstream.co", "dood.", "bysesukior.com"]):
                                        code = s_url.split("/")[-1].split("?")[0]
                                        embed_fallback = f"https://bysesukior.com/e/{code}"
                                        is_hls = False
                                        logger.info(f"[SxyPrn] Fallback to Byse embed: {embed_fallback}")
                                        break
                    except Exception as ex:
                        logger.debug(f"[SxyPrn] probe_best_post_streams failed: {ex}")

                # 2. Secondary: Deobfuscated direct CDN stream from page data-vnfo if no external stream
                if not stream_url:
                    raw_vnfo_val = None
                    vidsnfo_tag = soup.find(class_='vidsnfo') or soup.find(attrs={"data-vnfo": True})
                    if vidsnfo_tag and vidsnfo_tag.get('data-vnfo'):
                        try:
                            import json
                            vnfo_data = json.loads(vidsnfo_tag.get('data-vnfo'))
                            if target_post_id:
                                raw_vnfo_val = vnfo_data.get(target_post_id)
                        except Exception as je:
                            logger.warning(f"SxyPrn: Failed to parse data-vnfo tag: {je}")

                    if not raw_vnfo_val:
                        vnfo_match = re.search(r'data-vnfo=[\'"]({.+?})[\'"]', html, re.DOTALL)
                        if vnfo_match:
                            try:
                                import json
                                vnfo_data = json.loads(vnfo_match.group(1).replace('&quot;', '"'))
                                if target_post_id:
                                    raw_vnfo_val = vnfo_data.get(target_post_id)
                            except Exception as re_je:
                                logger.warning(f"SxyPrn: Regex data-vnfo parse failed: {re_je}")

                    if raw_vnfo_val:
                        resolved_cdn = resolve_sxyprn_cdn_url(raw_vnfo_val, url)
                        if resolved_cdn:
                            # Verify if the CDN stream is actually reachable (not 404/dead)
                            is_alive = False
                            try:
                                probe_resp = await client.head(resolved_cdn, headers={'Referer': url}, timeout=5.0)
                                if probe_resp.status_code in (200, 206):
                                    is_alive = True
                                else:
                                    logger.warning(f"[SxyPrn] Deobfuscated CDN stream returned HTTP {probe_resp.status_code}, rejecting dead link")
                            except Exception as pe:
                                logger.debug(f"[SxyPrn] CDN probe check error: {pe}")

                            if is_alive:
                                stream_url = resolved_cdn
                                logger.info(f"[SxyPrn] Verified direct CDN stream: {stream_url[:80]}")

                # 3. Tertiary: Look for alternate mirror posts on SxyPrn matching title / model
                if not stream_url and title:
                    try:
                        alt_stream, alt_is_hls = await self._find_alternate_mirror(client, title)
                        if alt_stream:
                            stream_url = alt_stream
                            is_hls = alt_is_hls
                            logger.info(f"[SxyPrn] Found working alternate mirror stream: {stream_url[:80]}")
                    except Exception as ae:
                        logger.debug(f"[SxyPrn] Alternate mirror search error: {ae}")

                if not stream_url:
                    # Detail pages can contain hidden recommendation players.
                    # Accept a video tag only when its URL names this post ID.
                    for video_tag in soup.find_all('video'):
                        candidate_src = video_tag.get('src') or video_tag.get('data-src') or ""
                        if target_post_id and target_post_id.lower() in candidate_src.lower():
                            stream_url = candidate_src
                            break

                if stream_url and stream_url.startswith('/'):
                    base = "https://sxyprn.net" if "sxyprn.net" in url.lower() else "https://sxyprn.com"
                    stream_url = f"{base}{stream_url}"

                if not stream_url:
                    match = re.search(r'src["\']:\s*["\']([^"\']+\.vid[^"\']*)["\']', html)
                    if match and target_post_id and target_post_id.lower() in match.group(1).lower():
                        cand = match.group(1)
                        if cand.startswith('/'):
                            base = "https://sxyprn.net" if "sxyprn.net" in url.lower() else "https://sxyprn.com"
                            cand = f"{base}{cand}"
                        try:
                            probe = await client.head(cand, headers={'Referer': url}, timeout=4.0)
                            if probe.status_code in (200, 206):
                                stream_url = cand
                        except Exception:
                            pass

                if not stream_url:
                    logger.warning(f"SxyPrn: Could not find stream URL for {url}")
                    if not title:
                        return None

                if not stream_url and embed_fallback:
                    stream_url = embed_fallback

                raw_id = url.split('/')[-1].split('?')[0].replace('.html', '')
                return {
                    "id": raw_id,
                    "title": title or "SxyPrn Video",
                    "description": "",
                    "thumbnail": thumbnail,
                    "duration": duration,
                    "height": best_height,
                    "quality": best_quality,
                    "file_size_mb": best_size_mb,
                    "size_bytes": int(round(best_size_mb * 1024 * 1024)) if best_size_mb > 0 else 0,
                    "stream_url": stream_url,
                    "is_hls": is_hls or (".m3u8" in stream_url.lower() if stream_url else False),
                    "extractor": self.name
                }

        except Exception as e:
            logger.error(f"SxyPrn extraction error: {e}")
            return None

    async def _find_alternate_mirror(self, client, title: str) -> tuple[Optional[str], bool]:
        """Find working external stream from alternate posts on SxyPrn with matching title."""
        from bs4 import BeautifulSoup
        clean = re.sub(r'#[a-zA-Z0-9_]+', '', title)
        clean = re.sub(r'\b(?:NEW|FULL HD|SCENE \d+ ->|on SexyPorn|More scenes of this model)\b', '', clean, flags=re.I)
        stop_words = {'onlyfans', 'video', 'full', 'scene', 'free', 'online', 'porn', 'sexyporn', 'with', 'from', 'this', 'that', 'and', 'the', 'for', 'more', 'model'}
        words = [w.strip() for w in re.split(r'[^a-zA-Z0-9]+', clean) if len(w.strip()) > 2 and w.lower() not in stop_words]
        if len(words) < 2:
            return None, False

        primary_kw = words[0]
        tag_url = f"https://www.sxyprn.net/{primary_kw}.html?sm=latest"
        try:
            resp = await client.get(tag_url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://sxyprn.net/"}, timeout=10.0)
            if resp.status_code != 200:
                return None, False
            soup = BeautifulSoup(resp.text, "html.parser")
            for card in soup.find_all("div", class_="post_el_small"):
                c_title_el = card.find(class_="post_text")
                c_text = (c_title_el.text if c_title_el else "").lower()
                if primary_kw.lower() not in c_text:
                    continue
                match_count = sum(1 for w in words[1:6] if w.lower() in c_text)
                if match_count >= 3:
                    ext_links = [a.get("href") for a in card.find_all("a", class_=re.compile("extlink"))]
                    for el in ext_links:
                        if any(x in el.lower() for x in ["vidara.so", "vidara.to", "vidsonic.net"]):
                            from .vidara import VidaraExtractor
                            v_ext = VidaraExtractor()
                            v_res = await v_ext.extract(el)
                            if v_res and v_res.get("stream_url"):
                                return v_res["stream_url"], v_res.get("is_hls", True)
                        elif any(h in el.lower() for h in ["lulustream.com", "luluvdo.com", "luluvid.com", "lulust.com"]):
                            from .lulustream import LuluStreamExtractor
                            l_ext = LuluStreamExtractor()
                            l_res = await l_ext.extract(el)
                            if l_res and l_res.get("stream_url"):
                                return l_res["stream_url"], l_res.get("is_hls", True)
        except Exception as e:
            logger.debug(f"[SxyPrn] alternate mirror search failed: {e}")
        return None, False
