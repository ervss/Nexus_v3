"""Spoločné pomocné funkcie, HTTP klient a Circuit Breaker pre Omni-Search adaptéry."""
from __future__ import annotations

import asyncio
import difflib
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from app.extractors.circuit_breaker import extractor_circuit_breaker, normalize_domain

try:
    from curl_cffi import requests as curl_requests
except Exception:  # pragma: no cover - voliteľný fallback ak curl_cffi nie je dostupné
    curl_requests = None

logger = logging.getLogger("nexus.omega_search")

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


class CircuitBreakerBlockedError(RuntimeError):
    """Vyvolaná pri preskočení domény s otvoreným circuit breakerom."""

    def __init__(self, domain: str, retry_after: float):
        self.domain = domain
        self.retry_after = retry_after
        super().__init__(f"Circuit open pre {domain} (retry za {retry_after:.1f}s)")


@dataclass
class AdapterBatch:
    """Výsledok jedného zdroja alebo adaptéra pre progressive SSE stream."""

    layer: str
    adapter: str
    source_key: str
    source_label: str
    items: List[Dict[str, Any]] = field(default_factory=list)
    status: str = "ok"  # ok | empty | skipped_circuit | error
    error: str = ""
    elapsed_ms: int = 0
    query_used: str = ""


def cb_allow(url_or_domain: str) -> tuple[bool, float]:
    """Skontroluje `extractor_circuit_breaker` pred vykonaním HTTP/sieťového volania."""
    domain = normalize_domain(url_or_domain)
    allowed, retry_after = extractor_circuit_breaker.allow(domain)
    if not allowed:
        logger.warning("[OMEGA][CB] SKIP %s (circuit open, retry za %.1fs)", domain, retry_after)
    return allowed, retry_after


def cb_record_success(url_or_domain: str) -> None:
    """Označí doménu ako zdravú v zdieľanom circuit breakeri."""
    extractor_circuit_breaker.record_success(normalize_domain(url_or_domain))


def cb_record_failure(url_or_domain: str, reason: str = "", *, immediate_trip: bool = False) -> dict:
    """Zaznamená zlyhanie do `extractor_circuit_breaker`.

    Pri 403/429/timeout v Omni-Search môže `immediate_trip=True` rýchlo otvoriť
    circuit, aby nebrzdil ďalšie požiadavky počas výpadku.
    """
    domain = normalize_domain(url_or_domain)
    info = extractor_circuit_breaker.record_failure(domain, reason=reason)
    if immediate_trip and info.get("state") != "open":
        for _ in range(max(0, extractor_circuit_breaker.failure_threshold - int(info.get("failures", 0)))):
            info = extractor_circuit_breaker.record_failure(domain, reason=reason)
    logger.warning(
        "[OMEGA][CB] FAIL %s (%s) -> state=%s failures=%s",
        domain,
        reason,
        info.get("state"),
        info.get("failures"),
    )
    return info


def parse_duration_seconds(raw: Any) -> int:
    """Prevedie MM:SS, HH:MM:SS, ISO8601 (PT12M34S) alebo číslo na sekundy."""
    if raw is None or raw == "":
        return 0
    if isinstance(raw, (int, float)):
        return max(0, int(raw))
    text = str(raw).strip()
    if text.isdigit():
        return int(text)
    iso = re.match(r"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$", text, re.I)
    if iso:
        return int(iso.group(1) or 0) * 3600 + int(iso.group(2) or 0) * 60 + int(iso.group(3) or 0)
    colon = re.search(r"(?<!\d)(\d{1,3}):(\d{2})(?::(\d{2}))?", text)
    if colon:
        if colon.group(3) is not None:
            return int(colon.group(1)) * 3600 + int(colon.group(2)) * 60 + int(colon.group(3))
        return int(colon.group(1)) * 60 + int(colon.group(2))
    words = re.search(
        r"(?:(\d+)\s*(?:h|hod|hours?))?\s*(?:(\d+)\s*(?:m|min|minutes?))?\s*(?:(\d+)\s*(?:s|sec|seconds?))?",
        text,
        re.I,
    )
    if words and any(words.groups()):
        return int(words.group(1) or 0) * 3600 + int(words.group(2) or 0) * 60 + int(words.group(3) or 0)
    return 0


def parse_quality_height(raw: Any) -> tuple[int, str]:
    """Zistí výšku rozlíšenia a normalizovaný štítok (napr. 1080 -> '1080p')."""
    if isinstance(raw, (int, float)) and raw > 0:
        h = int(raw)
        return h, ("4K" if h >= 2160 else f"{h}p")
    text = str(raw or "").upper()
    if not text:
        return 0, ""
    if "4K" in text or "2160" in text or "UHD" in text:
        return 2160, "2160p"
    for h in (1440, 1080, 720, 480, 360, 240):
        if str(h) in text:
            return h, f"{h}p"
    if re.search(r"\bFHD\b", text):
        return 1080, "1080p"
    if re.search(r"\bHD\b", text):
        return 720, "720p"
    return 0, ""


def format_duration_str(seconds: int) -> str:
    if seconds <= 0:
        return ""
    hrs, rem = divmod(seconds, 3600)
    mins, secs = divmod(rem, 60)
    if hrs:
        return f"{hrs}:{mins:02d}:{secs:02d}"
    return f"{mins}:{secs:02d}"


def normalize_result(
    *,
    title: str,
    url: str,
    source: str,
    source_key: str,
    layer: str,
    adapter: str,
    thumbnail: str = "",
    duration: Any = 0,
    quality: str = "",
    height: int = 0,
    description: str = "",
    embed: str = "",
    preview_url: str = "",
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Vytvorí jednotný dict výsledku kompatibilný s Quantum Search UI aj SSE streamom."""
    dur_sec = parse_duration_seconds(duration)
    parsed_h, parsed_q = parse_quality_height(height or quality or title)
    final_h = int(height or parsed_h or 0)
    final_q = quality or parsed_q
    item: Dict[str, Any] = {
        "title": (title or "").strip()[:180] or url,
        "url": (url or "").strip(),
        "source": source,
        "source_key": source_key,
        "layer": layer,
        "adapter": adapter,
        "thumbnail": (thumbnail or "").strip(),
        "thumb_url": (thumbnail or "").strip(),
        "duration": dur_sec,
        "duration_str": format_duration_str(dur_sec),
        "height": final_h,
        "quality": final_q,
        "description": (description or "").strip()[:280],
        "embed": embed,
        "preview_url": preview_url,
    }
    if extra:
        item.update(extra)
    return item


def _extract_json_ld_video_nodes(node: Any, out: List[Dict[str, Any]]) -> None:
    if isinstance(node, list):
        for entry in node:
            _extract_json_ld_video_nodes(entry, out)
        return
    if not isinstance(node, dict):
        return
    node_type = str(node.get("@type") or "").lower()
    if "videoobject" in node_type or ("article" in node_type and node.get("url")):
        out.append(node)
    if "@graph" in node:
        _extract_json_ld_video_nodes(node["@graph"], out)
    if "itemListElement" in node:
        for el in node.get("itemListElement") or []:
            if isinstance(el, dict):
                _extract_json_ld_video_nodes(el.get("item") or el, out)


def extract_json_ld_items(
    soup: BeautifulSoup,
    *,
    base_url: str,
    source_label: str,
    source_key: str,
    layer: str,
    adapter: str,
    limit: int = 24,
) -> List[Dict[str, Any]]:
    """Generický JSON-LD parser (VideoObject / ItemList) použiteľný naprieč KVS aj WP/DLE."""
    items: List[Dict[str, Any]] = []
    seen_urls: set[str] = set()
    for script in soup.select('script[type="application/ld+json"]'):
        raw = (script.string or script.get_text() or "").strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except Exception:
            continue
        nodes: List[Dict[str, Any]] = []
        _extract_json_ld_video_nodes(payload, nodes)
        for node in nodes:
            href = str(node.get("url") or node.get("@id") or node.get("embedUrl") or "").strip()
            if not href:
                continue
            full_url = urljoin(base_url, href)
            if not full_url.startswith("http") or full_url in seen_urls:
                continue
            # Ignoruj samotnú search URL, ak je len obalová stránka
            if full_url.rstrip("/") == base_url.rstrip("/"):
                continue
            seen_urls.add(full_url)
            thumb = node.get("thumbnailUrl") or node.get("thumbnail") or ""
            if isinstance(thumb, list):
                thumb = thumb[0] if thumb else ""
            if isinstance(thumb, dict):
                thumb = thumb.get("url") or thumb.get("contentUrl") or ""
            thumb_str = urljoin(base_url, str(thumb)) if thumb else ""
            title = str(node.get("name") or node.get("headline") or "").strip()
            desc = str(node.get("description") or "").strip()
            dur = parse_duration_seconds(node.get("duration"))
            items.append(
                normalize_result(
                    title=title or full_url,
                    url=full_url,
                    source=source_label,
                    source_key=source_key,
                    layer=layer,
                    adapter=adapter,
                    thumbnail=thumb_str,
                    duration=dur,
                    description=desc or f"Found via JSON-LD on {source_label}",
                    embed=str(node.get("embedUrl") or ""),
                )
            )
            if len(items) >= limit:
                return items
    return items


def _query_tokens(query: str) -> List[str]:
    return [t for t in re.split(r"[^a-z0-9]+", (query or "").strip().lower()) if len(t) >= 2]


def matches_query_strictly(query: str, title: str, url: str = "", extra_text: str = "") -> bool:
    """Overí prísnu zhodu dotazu proti falošným výsledkom (napr. 'Tina Tolly' vs 'Tiny Million').

    - Jednoslovný dotaz: slovo (alebo zreteľný substring v URL/titulku) musí byť prítomné.
    - Viacslovný dotaz (2+ tokenov): všetky tokeny musia mať presnú slovnú zhodu v titulku/URL/performerovi,
      prípadne celá fráza bez medzier (napr. tinatolly), alebo pri 2+ tokenoch s aspoň jednou presnou zhodou
      tesný pravopisný variant priezviska dĺžky >= 5 (napr. 'tolly' ~ 'tolley', ratio >= 0.84).
    """
    tokens = _query_tokens(query)
    if not tokens:
        return True

    primary_norm = re.sub(r"[^a-z0-9]+", " ", f"{title} {url}".lower()).strip()
    primary_words = primary_norm.split()
    primary_word_set = set(primary_words)
    compact_primary = "".join(primary_words)
    compact_query = "".join(tokens)

    if compact_query and len(compact_query) >= 5 and compact_query in compact_primary:
        return True

    if len(tokens) == 1:
        tok = tokens[0]
        if tok in primary_word_set or tok in compact_primary:
            return True
        extra_norm = re.sub(r"[^a-z0-9]+", " ", (extra_text or "").lower())
        return tok in set(extra_norm.split())

    exact_hits = 0
    fuzzy_hits = 0
    for tok in tokens:
        if tok in primary_word_set:
            exact_hits += 1
            continue
        # Povoľ tesný variant len pre dlhšie slovo (>= 5 znakov, napr. tolly vs tolley)
        if len(tok) >= 5 and any(
            len(w) >= 5 and difflib.SequenceMatcher(None, tok, w).ratio() >= 0.84
            for w in primary_words
        ):
            fuzzy_hits += 1

    if exact_hits == len(tokens):
        return True
    if exact_hits >= 1 and (exact_hits + fuzzy_hits) == len(tokens):
        return True

    # Záložná kontrola celej presnej frázy v extra texte (napr. performer / popis / tags)
    extra_norm = re.sub(r"[^a-z0-9]+", " ", (extra_text or "").lower()).strip()
    phrase = " ".join(tokens)
    return bool(phrase and phrase in extra_norm)


def filter_strict_query_items(items: List[Dict[str, Any]], query: str) -> List[Dict[str, Any]]:
    """Odfiltruje nerelevantné výsledky, ktoré nespĺňajú prísnu tokenovú zhodu pre dotaz."""
    tokens = _query_tokens(query)
    if not tokens or not items:
        return items
    filtered: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "")
        url = str(item.get("url") or "")
        performer = str(item.get("performer") or item.get("uploader") or "")
        tags_raw = item.get("tags") or []
        tags_str = " ".join(str(t) for t in tags_raw) if isinstance(tags_raw, (list, tuple)) else str(tags_raw)
        desc = str(item.get("description") or "")
        # Bočné frázy z titulkov iných videí nedávame do primary; pre performer/tags kontrolujeme prísne
        extra = f"{performer} {tags_str}".strip()
        if matches_query_strictly(query, f"{title} {performer}".strip(), url, extra_text=f"{extra} {desc}".strip()):
            filtered.append(item)
    return filtered


def _is_anti_bot_challenge(status: int, body: str) -> bool:
    if status in (403, 429, 503):
        return True
    low = (body or "")[:4000].lower()
    if status != 200 and ("cloudflare" in low or "just a moment" in low or "ddos-guard" in low):
        return True
    return "cf-browser-verification" in low or "<title>just a moment...</title>" in low


def _sync_curl_fetch(url: str, headers: Dict[str, str], timeout_s: float) -> tuple[int, str, str]:
    assert curl_requests is not None
    resp = curl_requests.get(
        url,
        headers=headers,
        timeout=timeout_s,
        impersonate="chrome131",
        allow_redirects=True,
    )
    final_url = str(getattr(resp, "url", "") or url)
    return int(resp.status_code), final_url, str(resp.text or "")


async def fetch_page(
    url: str,
    *,
    domain: Optional[str] = None,
    referer: Optional[str] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout_s: float = 8.0,
    prefer_curl_cffi: bool = True,
) -> tuple[int, str, str]:
    """Stiahne URL a vráti `(status, final_url, body)` s kontrolou Circuit Breakera."""
    target_domain = normalize_domain(domain or url)
    allowed, retry_after = cb_allow(target_domain)
    if not allowed:
        raise CircuitBreakerBlockedError(target_domain, retry_after)

    req_headers = {
        "User-Agent": DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if referer:
        req_headers["Referer"] = referer
    if headers:
        req_headers.update(headers)

    t0 = time.perf_counter()
    try:
        if prefer_curl_cffi and curl_requests is not None:
            status, final_url, body = await asyncio.wait_for(
                asyncio.to_thread(_sync_curl_fetch, url, req_headers, timeout_s),
                timeout=timeout_s + 1.5,
            )
        else:
            async with httpx.AsyncClient(follow_redirects=True, timeout=timeout_s, headers=req_headers) as client:
                resp = await client.get(url)
                status, final_url, body = int(resp.status_code), str(resp.url or url), resp.text

        if _is_anti_bot_challenge(status, body):
            cb_record_failure(target_domain, f"HTTP {status} / challenge", immediate_trip=(status in (403, 429)))
            raise RuntimeError(f"HTTP {status} / anti-bot challenge pre {target_domain}")
        if status >= 500:
            cb_record_failure(target_domain, f"HTTP {status}")
            raise RuntimeError(f"HTTP {status} pre {target_domain}")

        cb_record_success(target_domain)
        logger.debug("[OMEGA][HTTP] %s -> HTTP %s (%d ms)", target_domain, status, int((time.perf_counter() - t0) * 1000))
        return status, final_url, body
    except CircuitBreakerBlockedError:
        raise
    except (asyncio.TimeoutError, TimeoutError) as exc:
        cb_record_failure(target_domain, f"timeout {timeout_s}s", immediate_trip=True)
        raise TimeoutError(f"Timeout {timeout_s}s na {target_domain}") from exc
    except Exception as exc:
        msg = str(exc) or type(exc).__name__
        is_conn = "refused" in msg.lower() or "connect" in msg.lower() or isinstance(exc, httpx.TransportError)
        cb_record_failure(target_domain, msg, immediate_trip=is_conn)
        raise


async def fetch_text(
    url: str,
    *,
    domain: Optional[str] = None,
    referer: Optional[str] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout_s: float = 8.0,
    prefer_curl_cffi: bool = True,
) -> tuple[int, str]:
    """Stiahne URL s kontrolou Circuit Breakera a okamžitým fail-fast pri 403/429/timeout."""
    status, _final_url, body = await fetch_page(
        url,
        domain=domain,
        referer=referer,
        headers=headers,
        timeout_s=timeout_s,
        prefer_curl_cffi=prefer_curl_cffi,
    )
    return status, body
