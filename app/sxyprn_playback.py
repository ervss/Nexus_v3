"""Validate SxyPrn media before caching it or handing it to a player."""
from urllib.parse import urlparse

import httpx


_LULU_CDN_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def provider_referer(url: str, fallback: str = "") -> str:
    host = (urlparse(url or "").hostname or "").lower()
    if host.endswith(("97bf1.com", "vidara.so", "vidara.to")):
        return "https://vidara.to/" if host.endswith("vidara.to") else "https://vidara.so/"
    if host.endswith(("tnmr.org", "cdn-tnmr.org", "lulustream.com", "luluvdo.com", "luluvid.com", "lulust.com", "lplaygo.com")):
        return "https://luluvdo.com/"
    if host.endswith("bysesukior.com"):
        return "https://bysesukior.com/"
    if host.endswith("streamtape.com"):
        return "https://streamtape.com/"
    return fallback or "https://www.sxyprn.net/"


def provider_headers(url: str, fallback_referer: str = "") -> dict[str, str]:
    headers = {
        "User-Agent": _LULU_CDN_USER_AGENT,
        "Referer": provider_referer(url, fallback_referer),
    }
    host = (urlparse(url or "").hostname or "").lower()
    if host.endswith("tnmr.org"):
        headers.update({
            "Origin": "https://luluvdo.com",
            "Accept": "*/*",
            "Connection": "keep-alive",
        })
    return headers


async def probe_media(url: str, referer: str) -> bool:
    if not url.startswith(('https://', 'http://')):
        return False
    try:
        headers = provider_headers(url, referer)
        headers["Range"] = "bytes=0-4095"
        async with httpx.AsyncClient(follow_redirects=True, timeout=8) as client:
            async with client.stream('GET', url, headers=headers) as response:
                if response.status_code not in (200, 206):
                    return False
                sample = b''
                async for chunk in response.aiter_bytes(4096):
                    sample += chunk
                    if len(sample) >= 4096:
                        break
                # A 200 HTML player/error page is not playable media.
                return sample.lstrip().startswith(b'#EXTM3U') or b'ftyp' in sample[:64] or sample.startswith(b'\x1aE\xdf\xa3')
    except (httpx.HTTPError, OSError):
        return False
