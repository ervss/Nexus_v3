import os
import urllib.parse
from typing import Dict, Optional


def build_proxy_request_headers(
    v_url: str,
    ref_url: Optional[str] = None,
    range_header: Optional[str] = None,
) -> Dict[str, str]:
    domain = urllib.parse.urlparse(v_url).netloc
    referer = f"https://{domain}/"
    origin = None
    if "webshare.cz" in v_url or "wsfiles.cz" in v_url:
        referer = None
    elif any(host in (v_url or "").lower() for host in ("phncdn.com", "pornhub.com")) or (
        ref_url and "pornhub.com" in ref_url.lower()
    ):
        referer = ref_url if (ref_url and "pornhub.com" in ref_url.lower()) else "https://www.pornhub.com/"
        parsed_ref = urllib.parse.urlparse(referer)
        origin = f"{parsed_ref.scheme}://{parsed_ref.netloc}" if parsed_ref.scheme and parsed_ref.netloc else "https://www.pornhub.com"
    elif "eporner.com" in v_url or (ref_url and "eporner.com" in ref_url):
        referer = ref_url if (ref_url and "eporner.com" in ref_url) else "https://www.eporner.com/"
    elif "xhamster" in v_url or (ref_url and "xhamster" in ref_url):
        referer = ref_url if (ref_url and "xhamster.com" in ref_url) else "https://xhamster.com/"
    elif "xvideos." in v_url:
        referer = f"https://{domain}/"
    elif "erome.com" in v_url:
        referer = "https://www.erome.com/"
    elif "camwhores" in v_url:
        referer = ref_url if (ref_url and "camwhores.tv/videos/" in ref_url) else "https://www.camwhores.tv/"
    elif "bunkr" in v_url or "scdn.st" in v_url or any(
        x in (v_url or "").lower() for x in ("media-files", "stream-files", "milkshake", "cdn.", "bunkr.")
    ):
        ref = ref_url or ""
        if ref and ("bunkr" in ref.lower() or "/f/" in ref or "/v/" in ref):
            referer = ref if ref.endswith("/") else ref + "/"
        else:
            parsed_b = urllib.parse.urlparse(v_url)
            referer = f"{parsed_b.scheme}://{parsed_b.netloc}/"
    elif "filester." in (v_url or "").lower() or ("filester." in (ref_url or "").lower()):
        filester_ref = ref_url or ""
        if "filester." in filester_ref.lower():
            referer = filester_ref
        else:
            parsed_f = urllib.parse.urlparse(v_url)
            referer = f"{parsed_f.scheme}://{parsed_f.netloc}/"
        if referer:
            parsed_ref = urllib.parse.urlparse(referer)
            origin = f"{parsed_ref.scheme}://{parsed_ref.netloc}"
    elif "mydaddy.cc" in v_url:
        referer = "https://hqporner.com/"
    elif any(x in (v_url or "").lower() for x in ("archivebate.com", "mxcontent.net", "mixdrop.", "m1xdrop.")) or (
        ref_url and "archivebate.com" in (ref_url or "").lower()
    ):
        if ref_url and "archivebate.com" in ref_url.lower():
            referer = ref_url if ref_url.endswith("/") else ref_url + "/"
        else:
            referer = "https://archivebate.com/"
        parsed_ref = urllib.parse.urlparse(referer)
        origin = f"{parsed_ref.scheme}://{parsed_ref.netloc}" if parsed_ref.scheme and parsed_ref.netloc else None
    elif any(x in (v_url or "").lower() for x in ("rec-ur-bate.com", "recurbate.com")):
        if ref_url and any(x in ref_url.lower() for x in ("rec-ur-bate.com", "recurbate.com")):
            referer = ref_url if ref_url.endswith("/") else ref_url + "/"
        else:
            referer = "https://rec-ur-bate.com/"
        parsed_ref = urllib.parse.urlparse(referer)
        origin = f"{parsed_ref.scheme}://{parsed_ref.netloc}" if parsed_ref.scheme and parsed_ref.netloc else None
    elif "leakedzone.com" in (v_url or "").lower() or (ref_url and "leakedzone.com" in (ref_url or "").lower()) or "b-cdn.net" in (v_url or "").lower():
        referer = ref_url if (ref_url and "leakedzone.com" in (ref_url or "").lower()) else "https://leakedzone.com/"
        origin = "https://leakedzone.com"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Referer": referer,
        "Origin": origin,
        "Accept": "*/*",
        "Connection": "keep-alive",
    }
    if range_header:
        headers["Range"] = range_header
    return {k: v for k, v in headers.items() if v is not None}


def load_proxy_cookies(url: str) -> Dict[str, str]:
    cookies: Dict[str, str] = {}
    low = (url or "").lower()
    is_vk = any(d in low for d in ["vk.com", "vk.video", "vkvideo.ru", "okcdn.ru", "vkvideo.net", "vk.ru", "ok.ru"])
    if not is_vk:
        return cookies
    _COOKIE_CANDIDATES = [
        os.path.join("app", "vkvideos.ru_cookies.txt"),
        os.path.join("app", "vkvideo.ru_cookies.txt"),
        os.path.join("app", "vk.com_cookies.txt"),
        os.path.join("app", "vk.netscape.txt"),
        os.path.join("app", "cookies.netscape.txt"),
        "vkvideos.ru_cookies.txt",
        "vkvideo.ru_cookies.txt",
        "vk.com_cookies.txt",
        "vk.netscape.txt",
        "cookies.netscape.txt",
    ]
    _cookie_file = next((p for p in _COOKIE_CANDIDATES if os.path.exists(p)), None)
    if not _cookie_file:
        return cookies
    try:
        with open(_cookie_file, "r", encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                if not line.startswith("#") and line.strip():
                    parts = line.strip().split("\t")
                    if len(parts) >= 7:
                        cookies[parts[5]] = parts[6]
    except Exception:
        pass
    return cookies
