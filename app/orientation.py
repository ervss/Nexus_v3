"""Orientation (vertical/portrait) detection for search results.

Dôkazy sú rozdelené do dvoch úrovní:

* **confirmed** – skutočné rozmery videa (výsledok zdroja, detail stránky,
  HLS master playlist, MP4 hlavička) alebo explicitná metadata zdroja.
* **likely** – nepriamy odhad (kľúčové slová v názve/tagoch, URL, predpoklad
  zdroja). Nikdy sa nevydáva za potvrdené; UI to zobrazuje ako "Možno".

Náhľady (thumbnail) sa tu zámerne nepoužívajú: väčšina webov ich orezáva na
16:9, takže sú nespoľahlivé. Klient ich môže použiť len ako samostatný odhad.
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Iterable, Optional
from urllib.parse import urlparse

PORTRAIT_RATIO = 0.95  # width / height pod touto hranicou = vertikálne

CONFIRMED_EVIDENCE = frozenset({
    "video_dimensions", "page_dimensions", "stream_dimensions", "mp4_probe",
    "aspect_ratio", "source_metadata",
})

# Zdroje, ktorých obsah je z princípu prevažne vertikálny (iba odhad).
VERTICAL_SOURCES = frozenset({"redgifs", "tiktok", "snapchat", "reels"})

_PORTRAIT_TEXT = re.compile(
    r"(?<![a-z0-9])(?:vertical(?:\s*video|\s*cam|\s*pov|\s*clip)?|vertikaln\w*|portrait"
    r"|9\s*[:x/]\s*16|tik\s*tok|tiktok|reels?|snapchat|vertical\s*format)(?![a-z0-9])",
    re.IGNORECASE,
)
_LANDSCAPE_TEXT = re.compile(
    r"(?<![a-z0-9])(?:horizontal|landscape|16\s*[:x/]\s*9)(?![a-z0-9])", re.IGNORECASE)
_PORTRAIT_URL = re.compile(
    r"(?:/|[-_.])(?:vertical|portrait|shorts?|reels?|tiktok|9x16|9-16)(?:/|[-_.]|$)",
    re.IGNORECASE)
_TEXT_FIELDS = ("title", "description", "tags", "categories", "performers",
                "file_name", "caption", "text")
_DIRECT_MEDIA = re.compile(r"\.(?:mp4|m4v|mov|webm)(?:$|\?)", re.IGNORECASE)


def _int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _flatten(value: Any) -> str:
    if isinstance(value, (list, tuple, set)):
        return " ".join(_flatten(v) for v in value)
    if isinstance(value, dict):
        return " ".join(_flatten(v) for v in value.values())
    return str(value or "")


def label_for(width: int, height: int) -> str:
    return "portrait" if width / height < PORTRAIT_RATIO else "landscape"


def parse_aspect_ratio(value: Any) -> float:
    """'9:16', '9/16', '0.5625', 0.5625 → width/height, alebo 0."""
    if value in (None, ""):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value) if value > 0 else 0.0
    text = str(value).strip()
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)", text)
    if match:
        denominator = float(match[2])
        return float(match[1]) / denominator if denominator else 0.0
    try:
        ratio = float(text)
        return ratio if ratio > 0 else 0.0
    except ValueError:
        return 0.0


def confirmed_orientation(item: dict) -> tuple[str, str]:
    """('portrait'|'landscape'|'unknown', evidence) iba z potvrdených dôkazov."""
    width, height = _int(item.get("width")), _int(item.get("height"))
    if width > 0 and height > 0:
        if _int(item.get("rotation")) % 180 == 90:
            width, height = height, width
        return label_for(width, height), "video_dimensions"

    declared = str(item.get("orientation") or "").strip().lower()
    declared_evidence = str(item.get("orientation_evidence") or "").strip()
    if declared in {"portrait", "vertical", "landscape", "horizontal"}:
        label = "portrait" if declared in {"portrait", "vertical"} else "landscape"
        # Zdrojový dôkaz z probe/page ostáva zachovaný, inak "source_metadata".
        evidence = declared_evidence if declared_evidence in CONFIRMED_EVIDENCE else "source_metadata"
        return label, evidence

    ratio = parse_aspect_ratio(item.get("aspect_ratio") or item.get("video_aspect_ratio"))
    if ratio > 0:
        return ("portrait" if ratio < PORTRAIT_RATIO else "landscape"), "aspect_ratio"
    return "unknown", "unknown"


def orientation_hint(item: dict) -> tuple[str, str]:
    """Nepotvrdený odhad: ('portrait'|'', evidence)."""
    text = _flatten([item.get(field) for field in _TEXT_FIELDS])
    if _PORTRAIT_TEXT.search(text) and not _LANDSCAPE_TEXT.search(text):
        return "portrait", "text_hint"
    url = str(item.get("url") or "")
    if url and _PORTRAIT_URL.search(urlparse(url).path or ""):
        return "portrait", "url_hint"
    source = str(item.get("source_key") or item.get("source") or "").lower()
    if source in VERTICAL_SOURCES:
        return "portrait", "source_prior"
    return "", ""


def classify(item: dict) -> dict:
    """Jednotný výsledok: orientation, evidence, likely, confidence."""
    orientation, evidence = confirmed_orientation(item)
    if orientation != "unknown":
        return {"orientation": orientation, "evidence": evidence,
                "likely": "", "confidence": 1.0 if evidence != "source_metadata" else 0.85}
    likely, hint_evidence = orientation_hint(item)
    if likely:
        confidence = {"text_hint": 0.6, "url_hint": 0.55, "source_prior": 0.5}.get(hint_evidence, 0.4)
        return {"orientation": "unknown", "evidence": hint_evidence,
                "likely": likely, "confidence": confidence}
    return {"orientation": "unknown", "evidence": "unknown", "likely": "", "confidence": 0.0}


def orientation_score(item: dict) -> int:
    """2 = potvrdené vertikálne, 1 = pravdepodobné, 0 = ostatné."""
    if item.get("orientation") == "portrait":
        return 2
    return 1 if item.get("orientation_likely") == "portrait" else 0


# ── Extrakcia rozmerov zo stránky / HLS ──────────────────────────────────────

def _pair(width: Any, height: Any) -> Optional[tuple[int, int]]:
    w, h = _int(width), _int(height)
    # Ignoruj nezmysly (reklamné bannery, ikony, player-boxy 16x16 ...).
    if 120 <= w <= 8192 and 120 <= h <= 8192:
        return w, h
    return None


def _dimension_value(value: Any) -> int:
    if isinstance(value, dict):
        return _int(value.get("value") or value.get("@value"))
    return _int(value)


def _walk_ld(node: Any) -> Iterable[dict]:
    if isinstance(node, list):
        for child in node:
            yield from _walk_ld(child)
    elif isinstance(node, dict):
        if "@graph" in node:
            yield from _walk_ld(node["@graph"])
        yield node


def dimensions_from_hls(text: str) -> Optional[tuple[int, int]]:
    """Najvyššie RESOLUTION=WxH z HLS master playlistu."""
    best: Optional[tuple[int, int]] = None
    for match in re.finditer(r"RESOLUTION=(\d{2,5})x(\d{2,5})", text or ""):
        pair = _pair(match[1], match[2])
        if pair and (best is None or pair[0] * pair[1] > best[0] * best[1]):
            best = pair
    return best


def dimensions_from_html(html: str) -> Optional[tuple[int, int]]:
    """Rozmery videa z OpenGraph, JSON-LD alebo vložených JSON kľúčov."""
    if not html:
        return None

    def og(name: str) -> int:
        for pattern in (
            rf'<meta[^>]+(?:property|name)=["\']{name}["\'][^>]*content=["\'](\d+)',
            rf'<meta[^>]+content=["\'](\d+)["\'][^>]*(?:property|name)=["\']{name}["\']',
        ):
            match = re.search(pattern, html, re.IGNORECASE)
            if match:
                return int(match[1])
        return 0

    pair = _pair(og("og:video:width"), og("og:video:height")) or \
        _pair(og("video:width"), og("video:height"))
    if pair:
        return pair

    for block in re.finditer(
            r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.+?)</script>',
            html, re.DOTALL | re.IGNORECASE):
        try:
            data = json.loads(block[1])
        except Exception:  # noqa: BLE001
            continue
        for node in _walk_ld(data):
            kind = node.get("@type")
            kinds = kind if isinstance(kind, list) else [kind]
            if "VideoObject" not in kinds:
                continue
            pair = _pair(_dimension_value(node.get("width")), _dimension_value(node.get("height")))
            if pair:
                return pair

    for w_key, h_key in (("video_width", "video_height"), ("videoWidth", "videoHeight"),
                         ("data-video-width", "data-video-height"),
                         ("stream_width", "stream_height")):
        w = re.search(rf'["\']?{w_key}["\']?\s*[:=]\s*["\']?(\d{{2,5}})', html)
        h = re.search(rf'["\']?{h_key}["\']?\s*[:=]\s*["\']?(\d{{2,5}})', html)
        if w and h:
            pair = _pair(w[1], h[1])
            if pair:
                return pair

    return dimensions_from_hls(html)


def hls_urls_from_html(html: str, limit: int = 2) -> list[str]:
    found: list[str] = []
    for match in re.finditer(r'https?:(?:\\?/){2}(?:[^"\'\s<>\\]|\\/)+?\.m3u8[^"\'\s<>]*', html or ""):
        url = match[0].replace("\\/", "/")
        if url not in found:
            found.append(url)
        if len(found) >= limit:
            break
    return found


def patch_from_dimensions(width: int, height: int, evidence: str) -> dict:
    """Patch pre výsledok. Rozmery sa vždy ukladajú ako dvojica."""
    return {"width": width, "height": height,
            "orientation": label_for(width, height), "orientation_evidence": evidence}


# ── Rýchle aktívne overenie neznámych kandidátov ─────────────────────────────
#
# Zámerne ľahké: žiadny jitter, žiadne retry, tvrdý timeout na požiadavku,
# čítame len začiatok stránky, vysoký súbeh (globálny + na doménu) a cache
# (aj negatívna), aby opakované kliky/hľadania boli okamžité.

_FAST_CACHE: dict[str, tuple[float, Optional[dict]]] = {}
_CACHE_HIT_TTL = 6 * 3600.0
_CACHE_MISS_TTL = 20 * 60.0
_CACHE_MAX = 8000
_PAGE_BYTES = 160_000
_REQUEST_TIMEOUT = 4.0
_HLS_TIMEOUT = 3.0
_GLOBAL_CONCURRENCY = 24
_DOMAIN_CONCURRENCY = 6
_CHROME = ("chrome124", "chrome131")
_gates: dict[Any, asyncio.Semaphore] = {}


def _gate(key: Any, size: int) -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    gate = _gates.get((id(loop), key))
    if gate is None:
        if len(_gates) > 200:
            _gates.clear()
        gate = _gates[(id(loop), key)] = asyncio.Semaphore(size)
    return gate


def _cache_get(url: str):
    import time
    entry = _FAST_CACHE.get(url)
    if entry and entry[0] > time.monotonic():
        return True, entry[1]
    return False, None


def _cache_put(url: str, patch: Optional[dict]) -> None:
    import time
    if len(_FAST_CACHE) >= _CACHE_MAX:
        for key in list(_FAST_CACHE)[: _CACHE_MAX // 4]:
            _FAST_CACHE.pop(key, None)
    ttl = _CACHE_HIT_TTL if patch else _CACHE_MISS_TTL
    _FAST_CACHE[url] = (time.monotonic() + ttl, patch)


async def _fast_page(session: Any, url: str) -> Optional[dict]:
    resp = await asyncio.wait_for(session.get(url, allow_redirects=True), _REQUEST_TIMEOUT)
    if resp.status_code >= 400:
        return None
    html = resp.text[:_PAGE_BYTES]
    dims, evidence = dimensions_from_html(html), "page_dimensions"
    if not dims:
        for hls_url in hls_urls_from_html(html, limit=1):
            try:
                master = await asyncio.wait_for(session.get(hls_url, allow_redirects=True), _HLS_TIMEOUT)
                if master.status_code < 400:
                    dims, evidence = dimensions_from_hls(master.text[:60_000]), "stream_dimensions"
            except Exception:  # noqa: BLE001
                pass
    if not dims:
        return None
    patch = patch_from_dimensions(*dims, evidence)
    patch["aspect_ratio"] = round(dims[0] / dims[1], 4)
    return patch


async def _fast_direct(url: str) -> Optional[dict]:
    from .mp4_probe import probe_mp4
    info = await asyncio.wait_for(probe_mp4(url, timeout=4.0), 6.0)
    pair = _pair(info.get("width"), info.get("height"))
    return patch_from_dimensions(*pair, "mp4_probe") if pair else None


async def probe_orientation(urls: list[str], *, timeout_s: float = 6.0,
                            max_urls: int = 40) -> dict[str, dict]:
    """Rýchlo zistí rozmery/orientáciu pre URL. Vráti iba to, čo stihlo do
    `timeout_s` (zvyšok sa zruší). Nikdy nevyhodí výnimku."""
    unique = list(dict.fromkeys(u for u in urls if isinstance(u, str) and u.startswith("http")))[:max_urls]
    patches: dict[str, dict] = {}
    todo: list[str] = []
    for url in unique:
        hit, patch = _cache_get(url)
        if hit:
            if patch:
                patches[url] = patch
        else:
            todo.append(url)
    if not todo:
        return patches

    try:
        from curl_cffi.requests import AsyncSession
    except Exception:  # noqa: BLE001
        AsyncSession = None  # type: ignore

    async def run(session: Any) -> None:
        async def one(url: str) -> None:
            host = (urlparse(url).hostname or "").lower()
            try:
                async with _gate("all", _GLOBAL_CONCURRENCY), _gate(host, _DOMAIN_CONCURRENCY):
                    if _DIRECT_MEDIA.search(url):
                        patch = await _fast_direct(url)
                    elif session is not None:
                        patch = await _fast_page(session, url)
                    else:
                        patch = None
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                patch = None
            _cache_put(url, patch)
            if patch:
                patches[url] = patch

        tasks = [asyncio.ensure_future(one(u)) for u in todo]
        _, pending = await asyncio.wait(tasks, timeout=timeout_s)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    try:
        if AsyncSession is None:
            await run(None)
        else:
            import random
            async with AsyncSession(impersonate=random.choice(_CHROME), timeout=_REQUEST_TIMEOUT) as session:
                await run(session)
    except Exception:  # noqa: BLE001
        pass
    return patches
