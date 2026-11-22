"""Pomocné funkcie pre prácu s náhľadmi, extrakciu snímok a anti-spam klasifikáciu URL v Related Search."""
from __future__ import annotations

import asyncio
import io
import ipaddress
import logging
import os
import re
import shutil
import socket
import subprocess
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
from PIL import Image

logger = logging.getLogger(__name__)

_CBIR_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# Známe dôveryhodné video a obsahové domény pre CBIR výsledky
_TRUSTED_VIDEO_HOSTS = re.compile(
    r"(pornhub|xvideos|xhamster|bunkr|bunkrr|balbums|erome|camwhores|eporner|redgifs|"
    r"tnaflix|spankbang|hqporner|beeg|xnxx|nhentai|kemono|coomer|rule34|"
    r"leakporner|pornone|turbo\.cr|lulustream|filester|fileditch|simpcity|"
    r"onlyfans|fansly|fapello|scrolller|newgrounds|motherless|txxx|porntube|"
    r"homemoviestube|boyfriendtv|empflix|youporn|tube8|redtube|xtube|nudevista|"
    r"imagefap|porntrex|whoreshub|fpo\.xxx|1porn\.tv|ixxx|noodlemagazine|"
    r"djav\.org|cyberleaks|internetchicks|leakedzone|pimpbunny|hornysimp|"
    r"slutvids|mypornerleak|nsfw247|vk\.com|vkvideo|ok\.ru|pixeldrain|gofile|"
    r"abxxx|porntok|xgroovy|heavyonhotties)",
    re.I,
)

# Galérie, fóra a zbierky súborov
_COLLECTION_PATH_RE = re.compile(
    r"/(album|collection|playlist|favorites|gallery|a|set|serie|series|folder|threads|t\.me)/[^/?#]{2,}",
    re.I,
)

# Domény, ktoré nikdy nie sú cieľovým videom (balast z Vision/Google/Yandex)
_BLOCKED_NOISE_HOSTS = re.compile(
    r"(^|\.)(yandex\.|yastatic\.|yastat\.|google\.|bing\.|yahoo\.|duckduckgo\.|"
    r"youtube\.com|youtu\.be|music\.youtube\.com|vimeo\.com|dailymotion\.com|"
    r"amazon\.|ebay\.|aliexpress\.|etsy\.|walmart\.|temu\.|shein\.|"
    r"wikipedia\.|wikimedia\.|pinterest\.|pinimg\.|"
    r"facebook\.|fb\.com|instagram\.|tiktok\.|linkedin\.|sotwe\.com|"
    r"marriott\.com|rockefellercenter\.com|backstage\.com|tripadvisor\.|booking\.com|"
    r"onlyfanssigns\.com|onlyselects\.com|onlyfanslifestyle\.com|photoloading\.com|"
    r"cloudflare\.|gstatic\.|doubleclick\.|mc\.yandex\.|counter\.yadro\.|an\.yandex\.)",
    re.I,
)

# Cesty tagových a kategóriových indexov, ktoré nie sú konkrétnym videom ani albumom
_TAG_OR_CATEGORY_INDEX_PATH_RE = re.compile(
    r"^/(?:[a-z]{2}/)?(?:tags?|categories|category|c|country|channels|pornstars)/[^/]+/?$",
    re.I,
)

# Statické assety a CDN cesty, ktoré nie sú videostránkou
_ASSET_EXT_RE = re.compile(
    r"\.(css|js|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|webp|ico|map|json)([?#]|$)",
    re.I,
)
_CDN_PATH_RE = re.compile(r"/(fiji-static|_static|chunks|static|node_modules)/", re.I)

# Vzory SEO-spamových presmerovacích stránok, ktoré často vracia Yandex CBIR
_SEO_SPAM_PATH_RE = re.compile(
    r"([?&](query|q|search|s|keyword)=|/search\?|/[a-z0-9-]+\+[a-z0-9-]+\+[a-z0-9-]+)",
    re.I,
)
_SUSPICIOUS_NONVIDEO_TLDS = frozenset({
    "ua", "sk", "cz", "pl", "tw", "fun", "shop", "store", "blog", "online", "site", "xyz",
})


def _video_thumb_referer(video: Any) -> str:
    """Vráti najvhodnejší Referer pre sťahovanie chráneného náhľadu."""
    for candidate in (
        getattr(video, "thumbnail_referer", "") or "",
        getattr(video, "source_url", "") or "",
    ):
        val = str(candidate).strip()
        if val.startswith(("http://", "https://")):
            return val
    return ""


def _thumb_fetch_headers(referer: str = "") -> Dict[str, str]:
    """Vytvorí hlavičky prehliadača pre CDNs blokujúce hotlinking."""
    headers = {
        "User-Agent": _CBIR_UA,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
    }
    if referer.startswith(("http://", "https://")):
        headers["Referer"] = referer
    return headers


def _looks_like_image(response: httpx.Response, max_bytes: int = 8_000_000) -> bool:
    """Overí, či odpoveď obsahuje skutočný obrázok a nepresahuje dátový limit."""
    content_type = (response.headers.get("content-type") or "").lower()
    if content_type and not content_type.startswith("image/"):
        return False
    raw = response.content or b""
    return 500 < len(raw) <= max_bytes


_BLOCKED_SSRF_HOSTS = frozenset({
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
    "metadata",
    "ip6-localhost",
    "ip6-loopback",
})


def _is_public_ip(ip_str: str) -> bool:
    """Overí, že IP adresa patrí do verejného internetu (nie loopback/RFC1918/link-local)."""
    try:
        addr = ipaddress.ip_address(ip_str.split("%", 1)[0])
        if (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_multicast
            or addr.is_reserved
            or addr.is_unspecified
        ):
            return False
        if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
            v4 = addr.ipv4_mapped
            if v4.is_private or v4.is_loopback or v4.is_link_local or v4.is_reserved or v4.is_unspecified:
                return False
        return True
    except ValueError:
        return False


def validate_public_http_url(url: str) -> Tuple[bool, str]:
    """SSRF ochrana: povolí iba verejné HTTP(S) adresy bez lokálnych/privátnych sietí."""
    raw = str(url or "").strip()
    if not raw or len(raw) > 2048:
        return False, "Neplatná alebo príliš dlhá URL"
    try:
        parsed = urllib.parse.urlparse(raw)
    except Exception:
        return False, "Neplatný formát URL"

    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False, "Náhľad musí byť verejná HTTP(S) URL"
    if parsed.username or parsed.password:
        return False, "URL nesmie obsahovať prihlasovacie údaje"

    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        return False, "Chýba názov servera v URL"
    if host in _BLOCKED_SSRF_HOSTS or host.endswith((".local", ".internal", ".localhost", ".lan")):
        return False, f"Interná adresa nie je povolená ({host})"

    # Ak je host zadaný priamo ako IP adresa
    try:
        ipaddress.ip_address(host)
        if not _is_public_ip(host):
            return False, f"Privátna alebo lokálna IP adresa nie je povolená ({host})"
        return True, ""
    except ValueError:
        pass

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        return False, f"Nepodarilo sa preložiť doménu ({host})"
    if not infos:
        return False, f"Doména nemá DNS záznam ({host})"

    for entry in infos:
        sockaddr = entry[4]
        if not sockaddr:
            continue
        ip_str = str(sockaddr[0])
        if not _is_public_ip(ip_str):
            return False, f"Doména {host} smeruje na neverejnú IP ({ip_str})"
    return True, ""


def _decode_safe_image_bytes(raw: bytes, max_pixels: int = 25_000_000) -> Optional[bytes]:
    """Overí cez Pillow, že dáta sú bezpečný dekódovateľný obrázok pod pixelovým stropom."""
    if not raw or len(raw) < 200:
        return None
    try:
        with Image.open(io.BytesIO(raw)) as im:
            w, h = im.size
            if w <= 0 or h <= 0 or (w * h) > max_pixels:
                return None
            im.verify()
        return raw
    except Exception:
        return None


async def safe_fetch_public_image_bytes(
    url: str,
    referer: str = "",
    timeout_sec: float = 10.0,
    max_bytes: int = 8_000_000,
    max_redirects: int = 4,
) -> Optional[bytes]:
    """Bezpečne stiahne externý obrázok s kontrolou SSRF na každom presmerovaní."""
    ok, reason = await asyncio.to_thread(validate_public_http_url, url)
    if not ok:
        logger.warning("[RELATED_MEDIA/SSRF] Zablokovaná externá URL (%s): %s", reason, url[:90])
        return None

    parsed = urllib.parse.urlparse(url)
    ref_candidates: List[str] = [referer] if referer else []
    if parsed.scheme and parsed.netloc:
        ref_candidates.append(f"{parsed.scheme}://{parsed.netloc}/")
    ref_candidates.append("")

    try:
        async with httpx.AsyncClient(timeout=timeout_sec, follow_redirects=False) as cl:
            for cand_ref in ref_candidates:
                cur_url = url
                for _hop in range(max_redirects + 1):
                    hop_ok, hop_reason = await asyncio.to_thread(validate_public_http_url, cur_url)
                    if not hop_ok:
                        logger.warning("[RELATED_MEDIA/SSRF] Zablokovaný redirect (%s): %s", hop_reason, cur_url[:90])
                        return None
                    resp = await cl.get(cur_url, headers=_thumb_fetch_headers(cand_ref))
                    if resp.status_code in {301, 302, 303, 307, 308}:
                        loc = resp.headers.get("location")
                        if not loc:
                            break
                        cur_url = urllib.parse.urljoin(cur_url, loc)
                        continue
                    if resp.status_code == 200 and _looks_like_image(resp, max_bytes=max_bytes):
                        valid = _decode_safe_image_bytes(resp.content)
                        if valid:
                            return valid
                    break
    except Exception as exc:
        logger.debug("[RELATED_MEDIA] Bezpečný fetch náhľadu zlyhal (%s): %s", url[:70], exc)
    return None


def crop_image_bytes(img_bytes: bytes, crop_box: Optional[Dict[str, Any]]) -> bytes:
    """Oreže obrázok podľa normalizovaného obdĺžnika {x, y, w, h} v rozsahu 0..1."""
    if not img_bytes or not isinstance(crop_box, dict):
        return img_bytes
    try:
        x = float(crop_box.get("x", 0.0))
        y = float(crop_box.get("y", 0.0))
        w = float(crop_box.get("w", 1.0))
        h = float(crop_box.get("h", 1.0))
    except (TypeError, ValueError):
        return img_bytes

    # Ak výrez pokrýva prakticky celý obrázok, orez netreba
    if x <= 0.01 and y <= 0.01 and w >= 0.98 and h >= 0.98:
        return img_bytes
    if w <= 0.04 or h <= 0.04:
        return img_bytes

    try:
        with Image.open(io.BytesIO(img_bytes)) as im:
            rgb = im.convert("RGB")
            iw, ih = rgb.size
            left = max(0, min(iw - 16, int(round(x * iw))))
            top = max(0, min(ih - 16, int(round(y * ih))))
            right = max(left + 16, min(iw, int(round((x + w) * iw))))
            bottom = max(top + 16, min(ih, int(round((y + h) * ih))))
            cropped = rgb.crop((left, top, right, bottom))
            # Príliš malý výrez zväčšíme, aby mal CBIR aj SigLIP použiteľné rozlíšenie
            if min(cropped.size) < 160:
                scale = 224.0 / max(1, min(cropped.size))
                new_size = (
                    max(64, int(round(cropped.width * scale))),
                    max(64, int(round(cropped.height * scale))),
                )
                cropped = cropped.resize(new_size, Image.Resampling.LANCZOS)
            out = io.BytesIO()
            cropped.save(out, format="JPEG", quality=90)
            return out.getvalue()
    except Exception as exc:
        logger.debug("[RELATED_MEDIA] Orez obrázka zlyhal: %s", exc)
        return img_bytes


def resolve_local_thumb_path(thumbnail_path: str) -> Optional[Path]:
    """Nájde lokálny súbor náhľadu na disku vrátane Telegram keše v data/telegram_thumbs."""
    src = (thumbnail_path or "").split("?")[0].strip()
    if not src or src.startswith(("http://", "https://")):
        return None

    # 1. Telegram náhľady majú diskovú keš v data/telegram_thumbs/{chat_id}_{msg_id}.jpg
    tg_match = re.search(r"/telegram/thumb/(-?\d+)/(\d+)", src)
    if tg_match:
        tg_file = Path("data") / "telegram_thumbs" / f"{tg_match.group(1)}_{tg_match.group(2)}.jpg"
        if tg_file.is_file() and tg_file.stat().st_size > 200:
            return tg_file
        return None

    # 2. Štandardné statické cesty (/static/thumbnails/...)
    rel = src.lstrip("/")
    candidates = [
        Path("app") / rel,
        Path(rel),
        Path("app") / "static" / "thumbnails" / os.path.basename(src),
        Path("app") / "static" / os.path.basename(src),
    ]
    for path in candidates:
        if path.is_file() and path.stat().st_size > 200:
            return path
    return None


async def resolve_video_thumb_bytes(
    thumbnail_path: str,
    referer: str = "",
    crop_box: Optional[Dict[str, Any]] = None,
    internal_port: Optional[int] = None,
) -> Optional[bytes]:
    """Načíta bajty náhľadu z disku (vrátane Telegramu), interného API alebo vzdialenej URL."""
    raw_bytes: Optional[bytes] = None
    src = (thumbnail_path or "").strip()
    if not src:
        return None

    local_path = resolve_local_thumb_path(src)
    if local_path is not None:
        try:
            raw_bytes = local_path.read_bytes()
        except Exception as exc:
            logger.debug("[RELATED_MEDIA] Chyba čítania lokálneho náhľadu %s: %s", local_path, exc)

    # Ak Telegram náhľad ešte nie je v data/telegram_thumbs, skúsime interný endpoint bežiaceho servera
    if raw_bytes is None and src.startswith("/") and "/telegram/thumb/" in src:
        port = internal_port or int(os.getenv("PORT", "8000") or 8000)
        local_url = f"http://127.0.0.1:{port}{src}"
        try:
            async with httpx.AsyncClient(timeout=8, follow_redirects=True) as cl:
                resp = await cl.get(local_url)
                if resp.status_code == 200 and _looks_like_image(resp):
                    raw_bytes = resp.content
        except Exception as exc:
            logger.debug("[RELATED_MEDIA] Interný fetch TG náhľadu zlyhal: %s", exc)

    # Vzdialená HTTP(S) URL s refererom a SSRF ochranou
    if raw_bytes is None and src.startswith(("http://", "https://")):
        raw_bytes = await safe_fetch_public_image_bytes(src, referer=referer, timeout_sec=10.0)

    if not raw_bytes:
        return None
    return crop_image_bytes(raw_bytes, crop_box) if crop_box else raw_bytes


def _ffmpeg_extract_frames_sync(
    stream_url: str,
    positions: List[float],
    headers_str: str = "",
    timeout_per_frame: int = 8,
) -> List[bytes]:
    """Synchrónna extrakcia snímok cez ffmpeg s podporou HTTP hlavičiek."""
    if not stream_url or not shutil.which("ffmpeg"):
        return []
    frames: List[bytes] = []
    with tempfile.TemporaryDirectory(prefix="nexus_lens_") as tmp:
        for index, pos in enumerate(positions):
            out_file = Path(tmp) / f"frame_{index}.jpg"
            cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
            if headers_str and stream_url.startswith(("http://", "https://")):
                cmd.extend(["-headers", headers_str])
            cmd.extend([
                "-ss", str(pos),
                "-i", stream_url,
                "-frames:v", "1",
                "-vf", "scale='min(960,iw)':-2",
                "-q:v", "3",
                str(out_file),
            ])
            try:
                res = subprocess.run(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=timeout_per_frame,
                )
                if res.returncode == 0 and out_file.is_file() and out_file.stat().st_size > 500:
                    frames.append(out_file.read_bytes())
            except Exception:
                continue
    return frames


async def extract_search_frames(
    video: Any,
    count: int = 1,
    crop_box: Optional[Dict[str, Any]] = None,
    internal_port: Optional[int] = None,
) -> List[bytes]:
    """Vytiahne aktuálny náhľad (vrátane orezu) a pri Deep režime doplní ďalšie snímky z videa."""
    count = max(1, min(int(count or 1), 5))
    referer = _video_thumb_referer(video)
    primary = await resolve_video_thumb_bytes(
        str(getattr(video, "thumbnail_path", "") or ""),
        referer=referer,
        crop_box=crop_box,
        internal_port=internal_port,
    )
    # Ak používateľ ručne orezal konkrétnu oblasť, hľadáme iba túto oblasť
    if crop_box and primary:
        return [primary]
    if count == 1 and primary:
        return [primary]

    if not shutil.which("ffmpeg"):
        return [primary] if primary else []

    raw_source = str(getattr(video, "preview_mp4_url", "") or getattr(video, "url", "") or "").strip()
    if not raw_source:
        return [primary] if primary else []

    # Relatívnu Telegram stream URL preložíme na lokálny server, aby ju ffmpeg vedel prečítať
    port = internal_port or int(os.getenv("PORT", "8000") or 8000)
    stream_url = f"http://127.0.0.1:{port}{raw_source}" if raw_source.startswith("/") else raw_source

    duration = max(0.0, float(getattr(video, "duration", 0) or 0))
    extract_count = max(0, count - (1 if primary else 0))
    if extract_count == 0:
        return [primary] if primary else []

    positions = (
        [round((i + 1) * duration / (extract_count + 1), 2) for i in range(extract_count)]
        if duration > 4
        else [float(i * 3 + 2) for i in range(extract_count)]
    )

    headers_lines = [f"User-Agent: {_CBIR_UA}"]
    if referer:
        headers_lines.append(f"Referer: {referer}")
    headers_str = "\r\n".join(headers_lines) + "\r\n"

    extra = await asyncio.to_thread(
        _ffmpeg_extract_frames_sync, stream_url, positions, headers_str, 8
    )

    # Ak chránená CDN URL expirovala, skúsime ešte preview_mp4_url alebo rýchly yt-dlp re-resolve
    if not extra:
        alt_source = str(getattr(video, "source_url", "") or "").strip()
        if alt_source.startswith(("http://", "https://")) and alt_source != stream_url:
            def _quick_resolve() -> str:
                try:
                    import yt_dlp
                    silent = type("_SL", (), {"debug": lambda *_: None, "warning": lambda *_: None, "error": lambda *_: None})()
                    with yt_dlp.YoutubeDL({
                        "quiet": True, "no_warnings": True, "skip_download": True,
                        "socket_timeout": 6, "logger": silent,
                    }) as ydl:
                        info = ydl.extract_info(alt_source, download=False) or {}
                        return str(info.get("url") or "")
                except Exception:
                    return ""

            try:
                resolved = await asyncio.wait_for(asyncio.to_thread(_quick_resolve), timeout=8.0)
                if resolved.startswith(("http://", "https://")):
                    extra = await asyncio.to_thread(
                        _ffmpeg_extract_frames_sync, resolved, positions, headers_str, 8
                    )
            except Exception:
                pass

    combined = ([primary] if primary else []) + extra
    return combined[:count]


def classify_cbir_url(
    url: str,
    title: str = "",
    source: str = "",
    explicit_kind: str = "",
) -> Dict[str, Any]:
    """Klasifikuje nájdenú CBIR URL, odfiltruje balast a určí podporu importu (importability)."""
    try:
        parsed = urllib.parse.urlparse(url)
        host = (parsed.hostname or "").lower().lstrip("www.")
        path = parsed.path or ""
    except Exception:
        return {
            "blocked": True, "tier": "blocked", "kind": "other",
            "is_video_site": False, "importable": False, "importability": "unsupported",
            "domain": "", "penalty": 100,
        }

    if not host or not parsed.scheme.startswith("http"):
        return {
            "blocked": True, "tier": "blocked", "kind": "other",
            "is_video_site": False, "importable": False, "importability": "unsupported",
            "domain": host, "penalty": 100,
        }

    if _BLOCKED_NOISE_HOSTS.search(host) or host.endswith((".edu", ".gov")):
        return {
            "blocked": True, "tier": "blocked", "kind": "other",
            "is_video_site": False, "importable": False, "importability": "unsupported",
            "domain": host, "penalty": 100,
        }

    # Odfiltrujeme všeobecné tagové a kategóriové zoznamy (napr. /tags/hayes/, /c/blowjob/videos)
    if _TAG_OR_CATEGORY_INDEX_PATH_RE.search(path) or re.match(r"^\s*videos\s+tagged\s+with\b", title or "", re.I):
        return {
            "blocked": True, "tier": "blocked", "kind": "other",
            "is_video_site": False, "importable": False, "importability": "unsupported",
            "domain": host, "penalty": 100,
        }

    # Priame obrázkové zhody (napr. z Vision fullMatchingImages/partialMatchingImages) necháme ako typ 'image'
    is_direct_image = explicit_kind == "image" or bool(_ASSET_EXT_RE.search(url))
    if _CDN_PATH_RE.search(url) or (_ASSET_EXT_RE.search(url) and explicit_kind != "image"):
        return {
            "blocked": True, "tier": "blocked", "kind": "other",
            "is_video_site": False, "importable": False, "importability": "unsupported",
            "domain": host, "penalty": 100,
        }
    if is_direct_image:
        return {
            "blocked": False,
            "tier": "image_match",
            "kind": "image",
            "is_video_site": False,
            "importable": False,
            "importability": "unsupported",
            "domain": host,
            "penalty": 14,
        }

    if host.endswith("namethatporn.com"):
        if "/post/" in path.lower():
            return {
                "blocked": False,
                "tier": "trusted_video",
                "kind": "collection",
                "is_video_site": True,
                "importable": False,
                "importability": "unsupported",
                "domain": host,
                "penalty": 0,
            }
        return {
            "blocked": True,
            "tier": "blocked",
            "kind": "other",
            "is_video_site": False,
            "importable": False,
            "importability": "unsupported",
            "domain": host,
            "penalty": 100,
        }

    is_collection = bool(_COLLECTION_PATH_RE.search(url))
    is_trusted_video = bool(_TRUSTED_VIDEO_HOSTS.search(host))
    kind = "collection" if is_collection else ("video" if is_trusted_video else "other")

    if is_trusted_video:
        return {
            "blocked": False,
            "tier": "trusted_video",
            "kind": kind,
            "is_video_site": True,
            "importable": True,
            "importability": "confirmed",
            "domain": host,
            "penalty": 0,
        }

    # Heuristika SEO spamu: neznáma doména + vyhľadávacia query alebo keyword-stuffed cesta s "+"
    has_spam_path = bool(_SEO_SPAM_PATH_RE.search(url))
    tld = host.rsplit(".", 1)[-1] if "." in host else ""
    looks_like_video_page = bool(re.search(r"/(video|videos|watch|v|clip|scene|view|movies)/", path, re.I))

    if has_spam_path or (tld in _SUSPICIOUS_NONVIDEO_TLDS and not looks_like_video_page):
        return {
            "blocked": True,
            "tier": "spam_suspected",
            "kind": "other",
            "is_video_site": False,
            "importable": False,
            "importability": "unsupported",
            "domain": host,
            "penalty": 60,
        }

    # Zvyšné neznáme stránky: video-like cesty majú importability='unknown', bežné weby 'unsupported'
    return {
        "blocked": False,
        "tier": "web_page" if looks_like_video_page else "unverified_web",
        "kind": "video" if looks_like_video_page else "webpage",
        "is_video_site": looks_like_video_page,
        "importable": looks_like_video_page,
        "importability": "unknown" if looks_like_video_page else "unsupported",
        "domain": host,
        "penalty": 8 if looks_like_video_page else 24,
    }
