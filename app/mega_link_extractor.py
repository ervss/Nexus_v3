"""Spoločný extraktor a klasifikátor MEGA a externých odkazov pre Telegram a Quantum Search."""
from __future__ import annotations

import asyncio
import base64
import html
import ipaddress
import re
import socket
import unicodedata
from typing import Any, Iterable
from urllib.parse import parse_qs, unquote, urljoin, urlsplit

import httpx

_MEGA_HOSTS = {"mega.nz", "www.mega.nz", "mega.co.nz", "www.mega.co.nz"}
_TELEGRAM_NOISE_HOSTS = {
    "t.me",
    "telegram.me",
    "telegram.dog",
    "www.t.me",
    "linktr.ee",
    "www.linktr.ee",
    "onlyshare.io",
    "www.onlyshare.io",
    "robinhoodcenter.net",
    "www.robinhoodcenter.net",
    "store.megadropz.org",
}
_FAST_REDIRECTOR_HOSTS = {
    "onlyshare.info",
    "speedy-links.com",
    "megadropz.com",
    "megadropz.net",
    "links2megas.com",
    "best-links.org",
    "fast-links.org",
    "rapid-links.net",
    "rapid-links.com",
    "free-content.pro",
}
_LINKVERTISE_DYNAMIC_HOSTS = {
    "link-to.net",
    "link-center.net",
    "link-hub.net",
    "link-target.net",
    "direct-link.net",
    "direct-link.org",
    "linkvertise.com",
    "linkvertise.net",
    "file-link.net",
    "up-to-down.net",
}
_PASTE_CONTAINER_HOSTS = {
    "rentry.org",
    "rentry.co",
    "rentry.ir",
    "pastebin.com",
    "justpaste.it",
    "telegra.ph",
    "paste.ee",
    "pastemode.com",
    "controlc.com",
    "dpaste.org",
    "dpaste.com",
    "ghostbin.co",
    "ctxt.io",
    "paste.gg",
    "notes.io",
}
_KNOWN_PACK_LINK_HOSTS = _FAST_REDIRECTOR_HOSTS | _LINKVERTISE_DYNAMIC_HOSTS | _PASTE_CONTAINER_HOSTS | {
    "bstlar.com",
    "cuty.io",
    "ouo.io",
    "exe.io",
    "shrinkme.io",
    "loot-link.com",
    "lootdest.org",
    "lootdest.com",
    "work.ink",
}
_QUERY_WRAPPER_HOSTS = {
    "l.facebook.com",
    "lm.facebook.com",
    "out.reddit.com",
    "www.google.com",
    "google.com",
    "adfoc.us",
    "socialmediagirls.com",
    "forums.socialmediagirls.com",
} | _LINKVERTISE_DYNAMIC_HOSTS

_MEGA_TEXT_RE = re.compile(
    r"(?<![\w./:@%+-])(?:https?://|//)?(?:www\.)?mega\.(?:nz|co\.nz)[/#][^\s<>\"'`\])},]*",
    re.IGNORECASE,
)
_BARE_MEGA_FOLDER_RE = re.compile(
    r"(?<![\w./:@%+-])(?:https?://|//)?(?:www\.)?mega\.(?:nz|co\.nz)/"
    r"(folder|file)/([A-Za-z0-9_-]{8})(?![A-Za-z0-9_-])(?!/#)(?:#(?![A-Za-z0-9_-]{16,}))?",
    re.IGNORECASE,
)
_BARE_LEGACY_MEGA_RE = re.compile(
    r"(?<![\w./:@%+-])(?:https?://|//)?(?:www\.)?mega\.(?:nz|co\.nz)/?#?(F?!)([A-Za-z0-9_-]{8})(?![A-Za-z0-9_-])(?!![A-Za-z0-9_-]{16,})",
    re.IGNORECASE,
)
_SPLIT_KEY_RE = re.compile(
    r"(?:decryption\s*key|decryption|mega\s*key|key|k[lľ][uú][cč]|pass(?:word)?)\s*[:=\-]?\s*#?([A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])",
    re.IGNORECASE,
)
_HTTP_URL_RE = re.compile(r"https?://[^\s<>\"'`\])},]+", re.IGNORECASE)
_SCHEMELESS_PACK_URL_RE = re.compile(
    r"(?<![\w./:@%+-])(?:www\.)?"
    r"(?:onlyshare\.info|speedy-links\.com|megadropz\.(?:com|net|org)|links2megas\.com|"
    r"link-to\.net|link-center\.net|link-hub\.net|link-target\.net|direct-link\.(?:net|org)|"
    r"linkvertise\.(?:com|net)|file-link\.net|up-to-down\.net|bstlar\.com|"
    r"rentry\.(?:org|co|ir)|pastebin\.com|justpaste\.it|telegra\.ph|paste\.ee|pastemode\.com|"
    r"bunkr(?:r)?\.[a-z]{2,4}|gofile\.io|pixeldrain\.com|cyberdrop\.[a-z]{2,4}|"
    r"cyberfile\.[a-z]{2,4}|erome\.com|filester\.me|krakenfiles\.com)"
    r"/[^\s<>\"'`\])},]+",
    re.IGNORECASE,
)

_TITLE_LABEL_RE = re.compile(
    r"^[^\w#@]*(?:name|model|creator|girl|pack|title|set|album|performer|author|update)\s*[:=\-–]\s*(.+)$",
    re.IGNORECASE,
)
_PROMO_LINE_RE = re.compile(
    r"(?:unlock\s+full\s+vip|tap\s+here|instant\s+access|no\s+ads|get\s+vip(?:\s+access)?|"
    r"complete\s+collection|vip\s+access|join\s*[:@]|t\.me/|telegram\.me/|subscribe\s+to|archive\b|"
    r"explore\s+more|discover\s+the\s+new|onlyshare\.io|robinhoodcenter\.net|linktr\.ee|"
    r"everything\s+on\s+her|compiled\s+up\s+huge|wanted\s+baddie|rare\s+af\s+collection|"
    r"new\s+and\s+updated\s+stuff|ppv[\'s$]*\s+(?:are\s+)?(?:included|collection)|"
    r"grab\s+that\s+now|don\'t\s+miss|be\s+quick\s+af|for\s+ads\s+free|tutorial\b|main\s+@|"
    r"direct\s+links\s+without|community\b|this\s+content\s+may\s+be\s+removed|"
    r"share\s+our\s+website|categories\s*:|alternative\s+way|download\s+here)",
    re.IGNORECASE,
)
_DOWNLOAD_HINT_RE = re.compile(
    r"(?:download|mega|link|pack|folder|archive|stiahnu[tť]|ulo[zž]isko)",
    re.IGNORECASE,
)
_ALT_HINT_RE = re.compile(
    r"(?:alternative|mirror|backup|alt\b|náhradn)",
    re.IGNORECASE,
)
_HASHTAG_RE = re.compile(r"#([A-Za-z][A-Za-z0-9_]{1,48})")
_PACK_SIZE_RE = re.compile(
    r"(?<![A-Za-z0-9])(\d{1,4}(?:[.,]\d{1,2})?)\s*(TB|GB|MB)\b",
    re.IGNORECASE,
)
_TRAILING_SIZE_CLEAN_RE = re.compile(
    r"""(?:\s*[-–|•:]?\s*(?:visit\s+\S+\s+for\s+)?["'“”«»(\[]?\d{1,4}(?:[.,]\d{1,2})?\s*(?:TB|GB|MB)["'“”«»)\]]?)+\s*$""",
    re.IGNORECASE,
)
_NOISE_TAG_WORDS = frozenset({"nsfw", "sfw", "vip", "ads", "free", "mega", "update", "new", "full", "pack"})


def _normalize_text(text: str) -> str:
    """Prevedie matematické/štýlované Unicode písmo (napr. 𝙈𝙊𝘿𝙀𝙇) na čitateľný štandard (NFKC)."""
    if not text:
        return ""
    return unicodedata.normalize("NFKC", text)

_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def _try_parse_mega(raw: str) -> str | None:
    """Overí a znormalizuje MEGA odkaz pomocou mega_hub.parse_share."""
    candidate = (raw or "").strip()
    if not candidate:
        return None
    if candidate.endswith("...") or candidate.endswith("…"):
        return None
    candidate = re.sub(r"[.,;:!?]+$", "", candidate)
    if candidate.endswith("...") or candidate.endswith("…"):
        return None
    if candidate.startswith("//"):
        candidate = f"https:{candidate}"
    elif re.match(r"^(?:www\.)?mega\.(?:nz|co\.nz)[/#]", candidate, re.IGNORECASE):
        candidate = f"https://{candidate}"

    from fastapi import HTTPException
    from .routers.mega_hub import parse_share

    try:
        return parse_share(candidate).url
    except HTTPException:
        return None


def _collect_candidates_from_string(value: str, out: list[str], seen: set[str]) -> None:
    """Vytiahne kompletné MEGA odkazy z ľubovoľného reťazca vrátane rozdelených kľúčov."""
    if not value:
        return

    def _add(raw_url: str) -> None:
        canonical = _try_parse_mega(raw_url)
        if canonical and canonical not in seen:
            seen.add(canonical)
            out.append(canonical)

    for match in _MEGA_TEXT_RE.finditer(value):
        raw = match.group(0)
        # Ak hneď za zachyteným tokenom nasleduje znak výpustky, kľúč bol skrátený.
        tail = value[match.end():match.end() + 3]
        if raw.endswith("...") or raw.endswith("…") or tail.startswith("…") or tail.startswith("..."):
            continue
        _add(raw)

    # Podpora pre formát s kľúčom na rovnakom alebo ďalších 1–2 riadkoch (bežné v Telegrame).
    lines = value.splitlines()
    for idx, line in enumerate(lines):
        next_lines = " ".join(lines[idx + 1:min(len(lines), idx + 3)])
        for m in _BARE_MEGA_FOLDER_RE.finditer(line):
            kind, handle = m.group(1).lower(), m.group(2)
            search_span = f"{line[m.end():]} {next_lines}"
            key_match = _SPLIT_KEY_RE.search(search_span)
            if key_match:
                key_val = key_match.group(1)
                if (kind == "folder" and len(key_val) == 22) or (kind == "file" and len(key_val) == 43):
                    _add(f"https://mega.nz/{kind}/{handle}#{key_val}")
        for m in _BARE_LEGACY_MEGA_RE.finditer(line):
            prefix, handle = m.group(1).upper(), m.group(2)
            kind = "folder" if prefix == "F!" else "file"
            search_span = f"{line[m.end():]} {next_lines}"
            key_match = _SPLIT_KEY_RE.search(search_span)
            if key_match:
                key_val = key_match.group(1)
                if (kind == "folder" and len(key_val) == 22) or (kind == "file" and len(key_val) == 43):
                    _add(f"https://mega.nz/{kind}/{handle}#{key_val}")


def extract_mega_urls(text: str, extra_urls: Iterable[str] = ()) -> list[str]:
    """Vráti deduplikovaný zoznam validných kanonických mega.nz odkazov."""
    found: list[str] = []
    seen: set[str] = set()

    if text:
        _collect_candidates_from_string(text, found, seen)

    for url in extra_urls or ():
        raw = str(url or "").strip()
        if not raw:
            continue
        _collect_candidates_from_string(raw, found, seen)
        if re.search(r"%(?:2f|23|21)", raw, re.IGNORECASE):
            try:
                _collect_candidates_from_string(unquote(raw), found, seen)
            except Exception:
                pass

    return found


_STANDALONE_KEY_RE = re.compile(r"(?<![A-Za-z0-9_-])#?([A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])")


def extract_keyless_mega_urls(text: str, extra_urls: Iterable[str] = ()) -> list[dict[str, str]]:
    """Nájde mega.nz/folder/<id> alebo mega.nz/file/<id> odkazy BEZ dešifrovacieho kľúča (#key).

    Používa sa pri príspevkoch typu 'Download Link: mega.nz/folder/XXXX' + 'Unlock Key: link-hub.net/...'.
    """
    full_handles: set[str] = set()
    for full in extract_mega_urls(text, extra_urls=extra_urls):
        m = re.search(r"mega\.nz/(?:folder|file)/([A-Za-z0-9_-]{8})", full, re.IGNORECASE)
        if m:
            full_handles.add(m.group(1))

    sources = [text or "", *(str(u or "") for u in (extra_urls or ()))]
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for src in sources:
        if not src:
            continue
        for m in _BARE_MEGA_FOLDER_RE.finditer(src):
            kind, handle = m.group(1).lower(), m.group(2)
            if handle in full_handles or handle in seen:
                continue
            seen.add(handle)
            out.append({"url": f"https://mega.nz/{kind}/{handle}", "kind": kind, "handle": handle})
        for m in _BARE_LEGACY_MEGA_RE.finditer(src):
            prefix, handle = m.group(1).upper(), m.group(2)
            kind = "folder" if prefix == "F!" else "file"
            if handle in full_handles or handle in seen:
                continue
            seen.add(handle)
            out.append({"url": f"https://mega.nz/{kind}/{handle}", "kind": kind, "handle": handle})
    return out


def combine_mega_url_and_key(keyless_url: str, raw_input: str) -> str | None:
    """Spojí bezkľúčovú mega.nz URL so zadaným kľúčom (alebo vráti už kompletnú MEGA URL)."""
    text = (raw_input or "").strip()
    if not text:
        return None
    # 1. Ak vstup už obsahuje kompletnú MEGA URL, vrátime ju priamo.
    direct = extract_mega_urls(text)
    if direct:
        return direct[0]

    base = (keyless_url or "").strip().rstrip("/#")
    m = re.match(r"^https?://(?:www\.)?mega\.(?:nz|co\.nz)/(folder|file)/([A-Za-z0-9_-]{8})$", base, re.IGNORECASE)
    if not m:
        return None
    kind, handle = m.group(1).lower(), m.group(2)
    expected_len = 22 if kind == "folder" else 43

    # 2. Čistý token (prípadne s '#' na začiatku alebo v krátkom texte z Direct Paste)
    cleaned_single = text.lstrip("#").strip()
    if len(cleaned_single) == expected_len and re.fullmatch(r"[A-Za-z0-9_-]+", cleaned_single):
        return _try_parse_mega(f"https://mega.nz/{kind}/{handle}#{cleaned_single}")

    for km in _STANDALONE_KEY_RE.finditer(text):
        cand = km.group(1)
        if len(cand) == expected_len:
            parsed = _try_parse_mega(f"https://mega.nz/{kind}/{handle}#{cand}")
            if parsed:
                return parsed
    return None


def _slice_utf16(text: str, offset: int, length: int) -> str:
    """Bezpečne vyreže podreťazec podľa Telegram UTF-16 offsetu a dĺžky."""
    if not text or offset < 0 or length <= 0:
        return ""
    try:
        raw = text.encode("utf-16-le")
        start = offset * 2
        end = (offset + length) * 2
        if start >= len(raw):
            return ""
        return raw[start:end].decode("utf-16-le", errors="ignore")
    except Exception:
        return text[offset:offset + length]


def _clean_external_url(raw: str) -> str:
    url = _normalize_text(raw or "").strip()
    if not url:
        return ""
    url = re.sub(r"[.,;:!?]+$", "", url)
    if not re.match(r"^https?://", url, re.IGNORECASE):
        if _SCHEMELESS_PACK_URL_RE.match(url):
            url = f"https://{url}"
        else:
            return ""
    try:
        parsed = urlsplit(url)
    except ValueError:
        return ""
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        return ""
    host = parsed.netloc.lower().split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    if host in _TELEGRAM_NOISE_HOSTS or host.endswith(".t.me"):
        return ""
    # Holé domény bez cesty a query (napr. https://onlyshare.io/) sú reklamné pätičky, nie balíčky.
    path_clean = (parsed.path or "").strip("/")
    if not path_clean and not parsed.query and not parsed.fragment:
        return ""
    return url


def _domain_of(url: str) -> str:
    try:
        host = urlsplit(url).netloc.lower().split(":")[0]
        return host[4:] if host.startswith("www.") else host
    except ValueError:
        return ""


def _is_mega_host(url: str) -> bool:
    try:
        return urlsplit(url).netloc.lower().split(":")[0] in _MEGA_HOSTS
    except ValueError:
        return False


def has_message_preview(message: Any) -> bool:
    """Vráti True, ak Telegram správa obsahuje fotku, video náhľad alebo web preview obrázok."""
    if getattr(message, "photo", None):
        return True
    document = getattr(message, "document", None)
    if document is not None:
        if getattr(document, "thumbs", None):
            return True
        mime = str(getattr(document, "mime_type", "") or "").lower()
        if mime.startswith("video/"):
            return True
    webpage = getattr(getattr(message, "media", None), "webpage", None)
    if webpage is not None and getattr(webpage, "photo", None):
        return True
    return False


def extract_message_video_meta(message: Any) -> dict[str, Any]:
    """Zistí, či správa obsahuje krátke ukážkové video, a vráti jeho dĺžku."""
    document = getattr(message, "document", None)
    if document is None:
        return {"has_video_preview": False, "video_duration": ""}
    mime = str(getattr(document, "mime_type", "") or "").lower()
    is_video = mime.startswith("video/") or bool(getattr(message, "video", None))
    duration_sec = 0
    for attr in getattr(document, "attributes", None) or ():
        if type(attr).__name__ == "DocumentAttributeVideo" or hasattr(attr, "duration"):
            is_video = True
            try:
                duration_sec = int(round(float(getattr(attr, "duration", 0) or 0)))
            except (TypeError, ValueError):
                duration_sec = 0
            break
    if not is_video:
        return {"has_video_preview": False, "video_duration": ""}
    if duration_sec > 0:
        mins, secs = divmod(duration_sec, 60)
        hours, mins = divmod(mins, 60)
        dur_str = f"{hours}:{mins:02d}:{secs:02d}" if hours else f"{mins}:{secs:02d}"
    else:
        dur_str = ""
    return {"has_video_preview": True, "video_duration": dur_str}


def extract_pack_size(text: str) -> str:
    """Extrahuje veľkosť balíčka (napr. '5.45 GB', '117.15 GB', '1 TB') z popisu príspevku."""
    norm = _normalize_text(text or "")
    if not norm:
        return ""
    best_str = ""
    best_mb = -1.0
    unit_mult = {"MB": 1.0, "GB": 1024.0, "TB": 1024.0 * 1024.0}
    for m in _PACK_SIZE_RE.finditer(norm):
        raw_num = m.group(1).replace(",", ".")
        unit = m.group(2).upper()
        try:
            val = float(raw_num)
        except ValueError:
            continue
        if val <= 0:
            continue
        mb = val * unit_mult.get(unit, 1.0)
        if mb > best_mb:
            best_mb = mb
            num_fmt = f"{val:g}" if val.is_integer() else raw_num
            best_str = f"{num_fmt} {unit}"
    return best_str


def extract_pack_tags(text: str, max_tags: int = 8) -> list[str]:
    """Vytiahne hashtag štítky (napr. ['Beauty', 'Erotic']) z popisu príspevku."""
    norm = _normalize_text(text or "")
    if not norm:
        return []
    tags: list[str] = []
    seen: set[str] = set()
    for m in _HASHTAG_RE.finditer(norm):
        tag = m.group(1).strip("_")
        if not tag or len(tag) < 2:
            continue
        low = tag.lower()
        if low in _NOISE_TAG_WORDS or low in seen:
            continue
        seen.add(low)
        tags.append(tag)
        if len(tags) >= max_tags:
            break
    return tags


def _clean_title_candidate(candidate: str) -> str:
    cleaned = _HTTP_URL_RE.sub("", candidate or "")
    cleaned = _SCHEMELESS_PACK_URL_RE.sub("", cleaned)
    # Odstráni dekoratívne symboly na okrajoch pred aj po odrezaní veľkosti.
    cleaned = re.sub(r"^[^\w#@]+|[^\w)\]'\"”»]+$", "", cleaned).strip()
    cleaned_no_size = _TRAILING_SIZE_CLEAN_RE.sub("", cleaned).strip()
    if cleaned_no_size:
        cleaned = cleaned_no_size
    cleaned = re.sub(r"\s*[-–|•:]+\s*$", "", cleaned)
    cleaned = re.sub(r"^[^\w#@]+|[^\w)\]'\"”»]+$", "", cleaned).strip(" \t-–:|•")
    return cleaned


def extract_pack_title(text: str, fallback: str = "") -> str:
    """Extrahuje meno modelky alebo názov balíčka z Telegram popisu (s NFKC normalizáciou)."""
    raw_text = _normalize_text(text or "").strip()
    clean_fallback = _normalize_text(fallback or "").strip()
    if _PROMO_LINE_RE.search(clean_fallback):
        clean_fallback = ""
    if not raw_text:
        return clean_fallback[:180]

    lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
    for line in lines:
        match = _TITLE_LABEL_RE.match(line)
        if not match:
            continue
        candidate = _clean_title_candidate(match.group(1))
        if candidate and not _PROMO_LINE_RE.search(candidate):
            return candidate[:180]

    for line in lines:
        if line.startswith("#") and all(tok.startswith("#") for tok in line.split()):
            continue
        if _PACK_SIZE_RE.match(line.lstrip("☁️📦💾🔥💎 ")) and "+" in line:
            continue
        cleaned = _clean_title_candidate(line)
        if not cleaned or len(cleaned) < 2:
            continue
        if _PROMO_LINE_RE.search(cleaned):
            continue
        if cleaned.lower().startswith(("download", "link", "mirror", "password", "key", "categories", "update")):
            continue
        return cleaned[:180]

    tags = extract_pack_tags(raw_text, max_tags=1)
    if tags:
        return tags[0][:180]

    return clean_fallback[:180]


def is_paste_container_url(url: str) -> bool:
    """Vráti True, ak URL smeruje na známu paste/textovú kontajnerovú stránku (rentry, pastebin, telegra.ph...)."""
    dom = _domain_of(url)
    if not dom:
        return False
    if dom in _PASTE_CONTAINER_HOSTS:
        try:
            path = (urlsplit(url).path or "").strip("/")
            return bool(path)
        except ValueError:
            return False
    return False


def _paste_raw_url(url: str) -> str | None:
    """Vráti priamu /raw adresu pre podporované paste služby (len kde /raw naozaj vracia plain-text)."""
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None
    dom = _domain_of(url)
    path = (parsed.path or "").strip("/")
    if not path:
        return None
    # Pozn.: rentry.org/co /raw vracia 200 HTML 'What' bez obsahu -> sťahujeme priamo HTML stránku (má všetky linky).
    if dom == "pastebin.com":
        if path.lower().startswith("raw/"):
            return url
        if "/" not in path:
            return f"https://pastebin.com/raw/{path}"
    elif dom == "paste.ee":
        if path.lower().startswith("r/"):
            return url
        if path.lower().startswith("p/"):
            slug = path.split("/", 1)[1].strip("/")
            if slug and "/" not in slug:
                return f"https://paste.ee/r/{slug}"
    return None


def _decode_base64_http_url(raw_value: str) -> str | None:
    """Bezpečne dekóduje Base64 / URL-enkódovaný reťazec na platnú http(s) URL (0 HTTP requestov)."""
    val = (raw_value or "").strip()
    if not val:
        return None
    for candidate in (val, unquote(val)):
        cand = candidate.strip()
        if re.match(r"^https?://", cand, re.IGNORECASE):
            cleaned = _try_parse_mega(cand) or _clean_external_url(cand)
            if cleaned:
                return cleaned
        b64_clean = re.sub(r"\s+", "", cand).replace("-", "+").replace("_", "/")
        if len(b64_clean) < 12 or not re.fullmatch(r"[A-Za-z0-9+/=]+", b64_clean):
            continue
        rem = len(b64_clean) % 4
        if rem == 1:
            continue
        if rem:
            b64_clean += "=" * (4 - rem)
        try:
            decoded_bytes = base64.b64decode(b64_clean, validate=False)
            decoded = decoded_bytes.decode("utf-8", errors="strict").strip()
        except Exception:
            continue
        # Niektoré linky majú URL v Base64 ešte raz percent-enkódovanú alebo obalenú bielymi znakmi
        for inner in (decoded, unquote(decoded)):
            inner_clean = inner.strip()
            if re.match(r"^https?://", inner_clean, re.IGNORECASE):
                resolved = _try_parse_mega(inner_clean) or _clean_external_url(inner_clean)
                if resolved:
                    return resolved
    return None


def decode_local_wrapper_url(url: str, *, max_depth: int = 3) -> str | None:
    """Vrstva 0: Lokálne rozbalí wrapper/dynamic?r=Base64 URL bez jediného sieťového requestu."""
    current = (url or "").strip()
    if not current:
        return None
    changed = False
    for _ in range(max_depth):
        try:
            parsed = urlsplit(current)
        except ValueError:
            break
        dom = _domain_of(current)
        path_low = (parsed.path or "").lower()
        qs = parse_qs(parsed.query or "", keep_blank_values=False)
        next_target: str | None = None

        # 1. Linkvertise a príbuzné /dynamic?r=<base64> (link-to.net, link-center.net, direct-link.net...)
        if (dom in _LINKVERTISE_DYNAMIC_HOSTS or "/dynamic" in path_low) and qs.get("r"):
            next_target = _decode_base64_http_url(qs["r"][0])

        # 2. Známe redirect wrappery s cieľom v query parametri (url=, dest=, target=, u=, to=, redirect=)
        if not next_target and (dom in _QUERY_WRAPPER_HOSTS or "/goto/" in path_low or "/redirect" in path_low):
            for param in ("r", "url", "dest", "target", "u", "to", "redirect"):
                vals = qs.get(param)
                if not vals:
                    continue
                cand = _decode_base64_http_url(vals[0])
                if cand and cand != current:
                    next_target = cand
                    break

        if not next_target or next_target == current:
            break
        current = next_target
        changed = True
        if _try_parse_mega(current):
            break
    return current if changed else None


_BUNKR_HOST_RE = re.compile(r"^(?:[\w-]+\.)*bunkr(?:r)?\.[a-z]{2,6}$", re.IGNORECASE)
_CYBERDROP_HOST_RE = re.compile(r"^(?:[\w-]+\.)*cyberdrop\.[a-z]{2,6}$", re.IGNORECASE)
_CYBERFILE_HOST_RE = re.compile(r"^(?:[\w-]+\.)*cyberfile\.[a-z]{2,6}$", re.IGNORECASE)
_COOMER_HOST_RE = re.compile(r"^(?:[\w-]+\.)*coomer\.(?:su|st|party)$", re.IGNORECASE)
_SAINT_HOST_RE = re.compile(r"^(?:[\w-]+\.)*saint2?\.(?:su|cr|to)$", re.IGNORECASE)


def classify_media_url(url: str) -> dict[str, str] | None:
    """Rozpozná a znormalizuje podporované non-MEGA media hosty (Bunkr, Gofile, Pixeldrain, Cyberdrop, Erome...)."""
    clean = _clean_external_url(url)
    if not clean or _is_mega_host(clean):
        return None
    try:
        parsed = urlsplit(clean)
    except ValueError:
        return None
    host = _domain_of(clean)
    path = parsed.path or ""
    path_clean = path.strip("/")
    if not path_clean:
        return None

    if _BUNKR_HOST_RE.match(host):
        # Ignorujeme CDN súbory bez jasného album/file slugu len vtedy, ak ide o root; /a/, /f/, /v/, /d/, /i/ sú platné.
        m = re.match(r"^/(a|album|albums|f|v|d|i)/([A-Za-z0-9._-]+)", path, re.IGNORECASE)
        if not m:
            return None
        seg, slug = m.group(1).lower(), m.group(2)
        is_album = seg in {"a", "album", "albums"}
        canonical_seg = "a" if is_album else seg
        canonical = f"https://bunkr.cr/{canonical_seg}/{slug}"
        return {
            "url": canonical,
            "raw_url": clean,
            "host": "bunkr",
            "kind": "album" if is_album else "file",
            "label": "Bunkr album" if is_album else "Bunkr súbor",
        }

    if host == "gofile.io" or host.endswith(".gofile.io"):
        m = re.match(r"^/d/([A-Za-z0-9_-]{4,})", path, re.IGNORECASE)
        if not m:
            return None
        return {
            "url": f"https://gofile.io/d/{m.group(1)}",
            "raw_url": clean,
            "host": "gofile",
            "kind": "album",
            "label": "Gofile priečinok",
        }

    if host == "pixeldrain.com" or host.endswith(".pixeldrain.com"):
        m = re.match(r"^/(u|l)/([A-Za-z0-9_-]{4,})", path, re.IGNORECASE)
        if not m:
            return None
        kind = "album" if m.group(1).lower() == "l" else "file"
        return {
            "url": f"https://pixeldrain.com/{m.group(1).lower()}/{m.group(2)}",
            "raw_url": clean,
            "host": "pixeldrain",
            "kind": kind,
            "label": "Pixeldrain zoznam" if kind == "album" else "Pixeldrain súbor",
        }

    if _CYBERDROP_HOST_RE.match(host):
        m = re.match(r"^/(a|f)/([A-Za-z0-9_-]{4,})", path, re.IGNORECASE)
        if not m:
            return None
        kind = "album" if m.group(1).lower() == "a" else "file"
        return {
            "url": f"https://cyberdrop.cr/{m.group(1).lower()}/{m.group(2)}",
            "raw_url": clean,
            "host": "cyberdrop",
            "kind": kind,
            "label": "Cyberdrop album" if kind == "album" else "Cyberdrop súbor",
        }

    if _CYBERFILE_HOST_RE.match(host):
        return {
            "url": clean,
            "raw_url": clean,
            "host": "cyberfile",
            "kind": "album" if "/folder/" in path.lower() else "file",
            "label": "Cyberfile",
        }

    if host == "erome.com" or host.endswith(".erome.com"):
        m = re.match(r"^/a/([A-Za-z0-9_-]{4,})", path, re.IGNORECASE)
        if not m:
            return None
        return {
            "url": f"https://www.erome.com/a/{m.group(1)}",
            "raw_url": clean,
            "host": "erome",
            "kind": "album",
            "label": "Erome album",
        }

    if host == "filester.me" or host.endswith(".filester.me"):
        if re.match(r"^/(d|f|a)/[A-Za-z0-9_-]+", path, re.IGNORECASE):
            return {
                "url": f"https://filester.me{path}",
                "raw_url": clean,
                "host": "filester",
                "kind": "album" if path.lower().startswith("/a/") else "file",
                "label": "Filester",
            }
        return None

    if host == "krakenfiles.com":
        if re.match(r"^/view/[A-Za-z0-9_-]+", path, re.IGNORECASE):
            return {
                "url": clean,
                "raw_url": clean,
                "host": "krakenfiles",
                "kind": "file",
                "label": "Krakenfiles",
            }
        return None

    if _COOMER_HOST_RE.match(host):
        if re.search(r"/user/[^/]+", path, re.IGNORECASE):
            return {
                "url": clean,
                "raw_url": clean,
                "host": "coomer",
                "kind": "album",
                "label": "Coomer profil/post",
            }
        return None

    if _SAINT_HOST_RE.match(host):
        if re.match(r"^/(a|embed|videos?)/", path, re.IGNORECASE):
            return {
                "url": clean,
                "raw_url": clean,
                "host": "saint",
                "kind": "album" if path.lower().startswith("/a/") else "file",
                "label": "Saint",
            }
        return None

    if host in {"fileditchfiles.me", "fileditch.com"}:
        return {
            "url": clean,
            "raw_url": clean,
            "host": "fileditch",
            "kind": "file",
            "label": "FileDitch",
        }

    if host == "redgifs.com" and re.match(r"^/watch/[A-Za-z0-9_-]+", path, re.IGNORECASE):
        return {
            "url": clean,
            "raw_url": clean,
            "host": "redgifs",
            "kind": "file",
            "label": "RedGifs",
        }

    return None


def extract_supported_media_urls(text: str, extra_urls: Iterable[str] = ()) -> list[dict[str, str]]:
    """Extrahuje deduplikovaný zoznam podporovaných non-MEGA media linkov (Bunkr, Gofile, Pixeldrain...)."""
    candidates: list[str] = []
    norm = _normalize_text(text or "")
    if norm:
        for m in _HTTP_URL_RE.finditer(norm):
            candidates.append(m.group(0))
        for m in _SCHEMELESS_PACK_URL_RE.finditer(norm):
            candidates.append(f"https://{m.group(0)}")
    for u in extra_urls or ():
        if u:
            candidates.append(str(u))

    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in candidates:
        decoded = decode_local_wrapper_url(raw)
        for cand in (decoded, raw):
            if not cand:
                continue
            info = classify_media_url(cand)
            if info and info["url"] not in seen:
                seen.add(info["url"])
                out.append(info)
                break
    return out


def extract_paste_container_urls(text: str, extra_urls: Iterable[str] = ()) -> list[dict[str, Any]]:
    """Extrahuje deduplikovaný zoznam paste kontajnerov (rentry.org, pastebin, telegra.ph...)."""
    candidates: list[str] = []
    norm = _normalize_text(text or "")
    if norm:
        for m in _HTTP_URL_RE.finditer(norm):
            candidates.append(m.group(0))
        for m in _SCHEMELESS_PACK_URL_RE.finditer(norm):
            candidates.append(f"https://{m.group(0)}")
    for u in extra_urls or ():
        if u:
            candidates.append(str(u))

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in candidates:
        decoded = decode_local_wrapper_url(raw)
        for cand in (decoded, raw):
            if not cand:
                continue
            clean = _clean_external_url(cand)
            if clean and is_paste_container_url(clean):
                norm_u = clean.rstrip("/")
                if norm_u not in seen:
                    seen.add(norm_u)
                    out.append({"url": clean, "domain": _domain_of(clean), "crawled": False})
                break
    return out


def _categorize_external_url(url: str, decoded_url: str | None = None) -> str:
    effective = decoded_url or url
    if _try_parse_mega(effective):
        return "mega"
    if _is_mega_host(effective):
        return "keyless_mega"
    if is_paste_container_url(effective):
        return "paste"
    if classify_media_url(effective):
        return "media_host"
    dom = _domain_of(effective)
    if dom in _FAST_REDIRECTOR_HOSTS or dom in _LINKVERTISE_DYNAMIC_HOSTS or dom in _KNOWN_PACK_LINK_HOSTS:
        return "shortener"
    return "external"


def _score_external_link(url: str, context: str, *, decoded_url: str | None = None) -> tuple[int, int]:
    """Vráti skóre pre výber hlavného odkazu (vyššie = lepší primárny odkaz; paste/media porazia brány)."""
    effective = decoded_url or url
    domain = _domain_of(effective)
    norm_ctx = _normalize_text(context or "")
    score = 0
    if is_paste_container_url(effective):
        score += 80
    elif classify_media_url(effective):
        score += 65
    elif domain in _FAST_REDIRECTOR_HOSTS or "/s?" in effective.lower():
        score += 35
    elif domain in _KNOWN_PACK_LINK_HOSTS:
        score += 20
    if decoded_url and decoded_url != url:
        score += 15
    if _DOWNLOAD_HINT_RE.search(norm_ctx):
        score += 15
    if _ALT_HINT_RE.search(norm_ctx):
        score -= 25
    return (score, -len(effective))


def extract_text_links(
    text: str,
    extra_urls: Iterable[str] = (),
    extra_Pairs: Iterable[tuple[str, str]] = (),
    extra_entries: Iterable[dict[str, str]] = (),
) -> dict[str, Any] | None:
    """Extrahuje primárny odkaz, všetky vyťažené linky (vrátane lokálne dekódovaných), media linky, veľkosť a tagy."""
    norm_text = _normalize_text(text or "")
    # (raw_url, context, source_kind)
    raw_entries: list[tuple[str, str, str]] = []

    def _context_for_span(src: str, start: int, end: int) -> str:
        line_start = src.rfind("\n", 0, start) + 1
        line_end = src.find("\n", end)
        if line_end == -1:
            line_end = len(src)
        prev_start = src.rfind("\n", 0, max(0, line_start - 1)) + 1 if line_start > 0 else 0
        return src[prev_start:line_end]

    for m in _HTTP_URL_RE.finditer(norm_text):
        raw_entries.append((m.group(0), _context_for_span(norm_text, m.start(), m.end()), "text"))

    for m in _SCHEMELESS_PACK_URL_RE.finditer(norm_text):
        raw_entries.append((f"https://{m.group(0)}", _context_for_span(norm_text, m.start(), m.end()), "text"))

    for u in extra_urls or ():
        if u:
            raw_entries.append((str(u), "", "extra"))

    for u, ctx in extra_Pairs or ():
        if u:
            raw_entries.append((str(u), str(ctx or ""), "entity"))

    for ent in extra_entries or ():
        u = str((ent or {}).get("url") or "").strip()
        if u:
            raw_entries.append((u, str((ent or {}).get("label") or ""), str((ent or {}).get("source") or "entity")))

    # Vrstva 0: lokálne dekódovanie wrapperov (napr. link-to.net/.../dynamic?r=Base64 -> rentry.org alebo mega.nz)
    decoded_candidates: list[str] = []
    for raw_u, _, _ in raw_entries:
        decoded_candidates.append(raw_u)
        dec = decode_local_wrapper_url(raw_u)
        if dec:
            decoded_candidates.append(dec)

    mega_urls = extract_mega_urls(norm_text, extra_urls=decoded_candidates)
    media_urls = extract_supported_media_urls(norm_text, extra_urls=decoded_candidates)
    container_urls = extract_paste_container_urls(norm_text, extra_urls=decoded_candidates)

    external_records: list[dict[str, Any]] = []
    seen_ext: set[str] = set()
    for idx, (raw_url, context, source_kind) in enumerate(raw_entries):
        clean_raw = _clean_external_url(raw_url)
        if not clean_raw or _is_mega_host(clean_raw):
            continue
        decoded = decode_local_wrapper_url(clean_raw)
        effective = decoded or clean_raw
        # Ak sa wrapper lokálne rozbalil priamo na mega.nz, už je v mega_urls.
        if _try_parse_mega(effective):
            continue
        dedup_key = effective.rstrip("/")
        if dedup_key in seen_ext:
            continue
        seen_ext.add(dedup_key)
        score_tuple = _score_external_link(clean_raw, context, decoded_url=decoded)
        ctx_lines = _normalize_text(context or "").strip().splitlines()
        short_label = ctx_lines[0][:60] if ctx_lines else ""
        external_records.append({
            "url": effective,
            "raw_url": clean_raw,
            "decoded_url": decoded,
            "domain": _domain_of(effective),
            "label": short_label,
            "source": source_kind,
            "category": _categorize_external_url(clean_raw, decoded),
            "_score": score_tuple,
            "_idx": idx,
        })

    external_records.sort(key=lambda item: (item["_score"], -item["_idx"]), reverse=True)
    external_urls = [rec["url"] for rec in external_records]

    extracted_links: list[dict[str, Any]] = []
    for m_url in mega_urls:
        extracted_links.append({
            "url": m_url,
            "raw_url": m_url,
            "decoded_url": None,
            "domain": "mega.nz",
            "label": "MEGA",
            "source": "mega",
            "category": "mega",
        })
    for rec in external_records:
        extracted_links.append({
            "url": rec["url"],
            "raw_url": rec["raw_url"],
            "decoded_url": rec["decoded_url"],
            "domain": rec["domain"],
            "label": rec["label"],
            "source": rec["source"],
            "category": rec["category"],
        })

    if mega_urls:
        return {
            "mega_urls": mega_urls,
            "media_urls": media_urls,
            "container_urls": container_urls,
            "external_urls": external_urls,
            "extracted_links": extracted_links,
            "alt_urls": mega_urls[1:] + external_urls,
            "primary_url": mega_urls[0],
            "link_kind": "direct_mega",
            "resolved_mega_url": mega_urls[0],
            "domain": "mega.nz",
            "pack_size": extract_pack_size(norm_text),
            "tags": extract_pack_tags(norm_text),
        }

    if external_urls:
        primary = external_urls[0]
        return {
            "mega_urls": [],
            "media_urls": media_urls,
            "container_urls": container_urls,
            "external_urls": external_urls,
            "extracted_links": extracted_links,
            "alt_urls": external_urls[1:],
            "primary_url": primary,
            "link_kind": "external",
            "resolved_mega_url": None,
            "domain": _domain_of(primary),
            "pack_size": extract_pack_size(norm_text),
            "tags": extract_pack_tags(norm_text),
        }

    return None


def extract_message_links(message: Any) -> dict[str, Any] | None:
    """Vytiahne MEGA a externé odkazy (vrátane entít, tlačidiel, alt mirrorov, veľkosti, tagov a video preview) zo správy."""
    text = (getattr(message, "message", None) or getattr(message, "raw_text", None) or "").strip()
    extra_entries: list[dict[str, str]] = []

    # 1. Entity správy (MessageEntityTextUrl, MessageEntityUrl)
    for ent in getattr(message, "entities", None) or ():
        ent_url = getattr(ent, "url", None)
        if ent_url:
            offset = int(getattr(ent, "offset", 0) or 0)
            length = int(getattr(ent, "length", 0) or 0)
            label = _slice_utf16(text, offset, length)
            extra_entries.append({"url": str(ent_url), "label": label, "source": "entity"})
        elif "url" in type(ent).__name__.lower():
            offset = int(getattr(ent, "offset", 0) or 0)
            length = int(getattr(ent, "length", 0) or 0)
            sliced = _slice_utf16(text, offset, length)
            if sliced:
                extra_entries.append({"url": sliced, "label": sliced, "source": "entity_url"})

    # 2. Inline tlačidlá (reply_markup)
    reply_markup = getattr(message, "reply_markup", None)
    for row in getattr(reply_markup, "rows", None) or ():
        for btn in getattr(row, "buttons", None) or ():
            btn_url = getattr(btn, "url", None)
            if btn_url:
                btn_text = str(getattr(btn, "text", None) or "")
                extra_entries.append({"url": str(btn_url), "label": btn_text, "source": "button"})

    # 3. WebPage preview
    webpage = getattr(getattr(message, "media", None), "webpage", None)
    if webpage is not None:
        wp_url = getattr(webpage, "url", None)
        if wp_url:
            extra_entries.append({"url": str(wp_url), "label": str(getattr(webpage, "title", None) or ""), "source": "webpage"})

    extracted = extract_text_links(text, extra_entries=extra_entries)
    if not extracted:
        return None
    video_meta = extract_message_video_meta(message)
    extracted.update(video_meta)
    return extracted


async def _assert_public_host(hostname: str, port: int) -> None:
    """Zabráni SSRF: povolí iba verejné IP adresy."""
    host = (hostname or "").strip().strip("[]").lower()
    if not host or host in {"localhost", "localhost.localdomain"}:
        raise ValueError("Lokálne ani privátne adresy nie sú povolené.")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if not literal.is_global:
            raise ValueError("Lokálne ani privátne adresy nie sú povolené.")
        return

    infos = await asyncio.to_thread(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM)
    if not infos:
        raise ValueError("Doménu sa nepodarilo preložiť.")
    for info in infos:
        ip_str = info[4][0].split("%")[0]
        addr = ipaddress.ip_address(ip_str)
        if not addr.is_global:
            raise ValueError("Cieľová adresa smeruje do neverejnej siete.")


_META_REFRESH_RE = re.compile(
    r"""<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["'][^"']*?url\s*=\s*([^"'\s>]+)["']""",
    re.IGNORECASE,
)
_JS_REDIRECT_RE = re.compile(
    r"""(?:window\.|top\.|self\.)?location(?:\.href\s*=\s*|\.replace\s*\(\s*|\.assign\s*\(\s*)["'](https?://[^"'\s<>]+)["']""",
    re.IGNORECASE,
)


def _is_text_like_content_type(content_type: str | None) -> bool:
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    if not ct:
        return True
    return ct.startswith("text/") or ct in {
        "application/xhtml+xml",
        "application/xml",
        "application/json",
    }


def _extract_harvest_from_body(body_text: str, *, source_url: str = "") -> dict[str, Any]:
    """Z HTML alebo plain-text tela stránky (napr. rentry.org/raw) vytiahne všetky MEGA, media aj vnorené odkazy."""
    unescaped = html.unescape(body_text or "")
    # Okrem priamych URL skúsime dekódovať aj prípadné vnorené dynamic?r= wrappery v texte
    embedded_urls = [m.group(0) for m in _HTTP_URL_RE.finditer(unescaped)]
    decoded_extras: list[str] = []
    for u in embedded_urls[:200]:
        dec = decode_local_wrapper_url(u)
        if dec:
            decoded_extras.append(dec)

    mega_urls = extract_mega_urls(unescaped, extra_urls=decoded_extras)
    media_urls = extract_supported_media_urls(unescaped, extra_urls=decoded_extras)
    nested_containers = [
        c for c in extract_paste_container_urls(unescaped, extra_urls=decoded_extras)
        if c["url"].rstrip("/") != source_url.rstrip("/")
    ]
    return {
        "mega_urls": mega_urls[:60],
        "media_urls": media_urls[:40],
        "nested_containers": nested_containers[:5],
    }


async def _fetch_text_body(http: Any, url: str) -> str:
    """Bezpečne stiahne textové telo (pre pastebin/paste.ee skúsi /raw s fallbackom na HTML, ak telo neobsahuje linky)."""
    if not callable(getattr(http, "get", None)):
        return ""
    targets: list[str] = []
    raw_variant = _paste_raw_url(url)
    if raw_variant and raw_variant != url:
        targets.append(raw_variant)
    targets.append(url)
    fallback_body = ""
    for target in targets:
        try:
            parsed = urlsplit(target)
            scheme = parsed.scheme.lower()
            if scheme not in {"http", "https"} or not parsed.hostname:
                continue
            port = parsed.port or (443 if scheme == "https" else 80)
            await _assert_public_host(parsed.hostname, port)
            page_resp = await http.get(target)
            if 200 <= page_resp.status_code < 300 and _is_text_like_content_type(page_resp.headers.get("content-type")):
                body = (page_resp.text or "")[:512_000]
                if body.strip():
                    # Ak ide o /raw variant, uistíme sa, že nejde o prázdnu HTML error/redirect stránku bez odkazov
                    if target != url and not re.search(r"(?:mega\.(?:nz|co\.nz)|bunkr|gofile\.io|pixeldrain|cyberdrop|erome|http)", body, re.IGNORECASE):
                        fallback_body = fallback_body or body
                        continue
                    return body
        except (httpx.HTTPError, ValueError):
            continue
    return fallback_body


async def resolve_clean_redirect(url: str, *, max_hops: int = 5, timeout: float = 6.0) -> dict[str, Any]:
    """Bezpečne rozbalí lokálne Base64 wrappery, sleduje 3xx/meta/JS presmerovania a zozbiera všetky MEGA + media linky z paste/HTML stránok."""
    current = (url or "").strip()
    if not current:
        raise ValueError("Chýba URL adresa na overenie.")

    direct = _try_parse_mega(current)
    if direct:
        return {
            "link_kind": "resolved_mega",
            "resolved_mega_url": direct,
            "final_url": direct,
            "domain": "mega.nz",
            "hops": 0,
            "mega_urls": [direct],
            "media_urls": [],
            "container_urls": [],
            "resolved_via": "direct_mega",
        }

    hops = 0
    resolved_via = "clean_http"
    collected_mega: list[str] = []
    seen_mega: set[str] = set()
    collected_media: list[dict[str, str]] = []
    seen_media: set[str] = set()
    collected_containers: list[dict[str, Any]] = []
    seen_containers: set[str] = set()

    def _merge_mega(items: Iterable[str]) -> None:
        for m in items:
            if m and m not in seen_mega:
                seen_mega.add(m)
                collected_mega.append(m)

    def _merge_media(items: Iterable[dict[str, str]]) -> None:
        for item in items:
            u = item.get("url")
            if u and u not in seen_media:
                seen_media.add(u)
                collected_media.append(item)

    def _register_container(c_url: str, *, crawled: bool) -> None:
        norm = c_url.rstrip("/")
        if not norm:
            return
        if norm in seen_containers:
            if crawled:
                for entry in collected_containers:
                    if entry["url"].rstrip("/") == norm:
                        entry["crawled"] = True
            return
        seen_containers.add(norm)
        collected_containers.append({"url": c_url, "domain": _domain_of(c_url), "crawled": crawled})

    # Vrstva 0: okamžité lokálne dekódovanie pred akýmkoľvek sieťovým volaním
    local_decoded = decode_local_wrapper_url(current)
    if local_decoded:
        current = local_decoded
        resolved_via = "local_b64"
        mega_local = _try_parse_mega(current)
        if mega_local:
            return {
                "link_kind": "resolved_mega",
                "resolved_mega_url": mega_local,
                "final_url": mega_local,
                "domain": "mega.nz",
                "hops": 0,
                "mega_urls": [mega_local],
                "media_urls": [],
                "container_urls": [],
                "resolved_via": "local_b64",
            }

    # Ak už samotná cieľová URL (alebo lokálne dekódovaná) je podporovaný media host (Bunkr/Gofile/Pixeldrain...)
    direct_media = classify_media_url(current)
    if direct_media:
        _merge_media([direct_media])
        return {
            "link_kind": "external",
            "resolved_mega_url": None,
            "final_url": direct_media["url"],
            "domain": _domain_of(direct_media["url"]),
            "hops": hops,
            "mega_urls": [],
            "media_urls": collected_media,
            "container_urls": [],
            "resolved_via": resolved_via,
        }

    async with httpx.AsyncClient(follow_redirects=False, timeout=timeout, headers=_HTTP_HEADERS) as http:
        for _ in range(max_hops):
            # Pred každým hopom skúsime lokálne dekódovanie (napr. 302 -> link-to.net/dynamic?r=...)
            hop_decoded = decode_local_wrapper_url(current)
            if hop_decoded and hop_decoded != current:
                current = hop_decoded
                mega_target = _try_parse_mega(current)
                if mega_target:
                    _merge_mega([mega_target])
                    return {
                        "link_kind": "resolved_mega",
                        "resolved_mega_url": collected_mega[0],
                        "final_url": collected_mega[0],
                        "domain": "mega.nz",
                        "hops": hops,
                        "mega_urls": collected_mega,
                        "media_urls": collected_media,
                        "container_urls": collected_containers,
                        "resolved_via": "local_b64",
                    }
                media_target = classify_media_url(current)
                if media_target:
                    _merge_media([media_target])
                    return {
                        "link_kind": "external",
                        "resolved_mega_url": None,
                        "final_url": media_target["url"],
                        "domain": _domain_of(media_target["url"]),
                        "hops": hops,
                        "mega_urls": collected_mega,
                        "media_urls": collected_media,
                        "container_urls": collected_containers,
                        "resolved_via": "local_b64",
                    }

            parsed = urlsplit(current)
            scheme = parsed.scheme.lower()
            if scheme not in {"http", "https"} or not parsed.hostname:
                raise ValueError("Nepodporovaná alebo neplatná URL adresa.")
            port = parsed.port or (443 if scheme == "https" else 80)
            await _assert_public_host(parsed.hostname, port)

            # Ak sme už priamo na paste kontajneri (napr. rentry.org), môžeme ísť rovno cez /raw alebo GET bez zbytočného HEAD
            if is_paste_container_url(current) and callable(getattr(http, "get", None)):
                body_text = await _fetch_text_body(http, current)
                if body_text:
                    _register_container(current, crawled=True)
                    harvest = _extract_harvest_from_body(body_text, source_url=current)
                    _merge_mega(harvest["mega_urls"])
                    _merge_media(harvest["media_urls"])
                    # 1 úroveň vnorených paste odkazov (max 3)
                    for nested in harvest["nested_containers"][:3]:
                        n_url = nested["url"]
                        _register_container(n_url, crawled=False)
                        nested_body = await _fetch_text_body(http, n_url)
                        if nested_body:
                            _register_container(n_url, crawled=True)
                            nh = _extract_harvest_from_body(nested_body, source_url=n_url)
                            _merge_mega(nh["mega_urls"])
                            _merge_media(nh["media_urls"])
                    if collected_mega or collected_media:
                        resolved_via = "paste_crawl"
                        break

            resp = await http.head(current)
            if resp.status_code in {403, 405, 501} and "location" not in resp.headers:
                async with http.stream("GET", current) as stream_resp:
                    status = stream_resp.status_code
                    location = stream_resp.headers.get("location")
                    resp_ct = stream_resp.headers.get("content-type")
            else:
                status = resp.status_code
                location = resp.headers.get("location")
                resp_ct = resp.headers.get("content-type")

            if status in {301, 302, 303, 307, 308} and location:
                next_url = urljoin(current, location.strip())
                hops += 1
                current = decode_local_wrapper_url(next_url) or next_url
                mega_target = _try_parse_mega(current)
                if mega_target:
                    _merge_mega([mega_target])
                    return {
                        "link_kind": "resolved_mega",
                        "resolved_mega_url": collected_mega[0],
                        "final_url": collected_mega[0],
                        "domain": "mega.nz",
                        "hops": hops,
                        "mega_urls": collected_mega,
                        "media_urls": collected_media,
                        "container_urls": collected_containers,
                        "resolved_via": resolved_via,
                    }
                media_target = classify_media_url(current)
                if media_target:
                    _merge_media([media_target])
                    return {
                        "link_kind": "external",
                        "resolved_mega_url": None,
                        "final_url": media_target["url"],
                        "domain": _domain_of(media_target["url"]),
                        "hops": hops,
                        "mega_urls": collected_mega,
                        "media_urls": collected_media,
                        "container_urls": collected_containers,
                        "resolved_via": resolved_via,
                    }
                continue

            # Ak nejde o 3xx redirect a server vrátil úspešnú odpoveď, vytiahneme všetky MEGA + media linky z HTML/textu
            if status < 400 and callable(getattr(http, "get", None)) and _is_text_like_content_type(resp_ct):
                try:
                    body_text = await _fetch_text_body(http, current)
                    if body_text:
                        if is_paste_container_url(current):
                            _register_container(current, crawled=True)
                        harvest = _extract_harvest_from_body(body_text, source_url=current)
                        _merge_mega(harvest["mega_urls"])
                        _merge_media(harvest["media_urls"])
                        for nested in harvest["nested_containers"][:2]:
                            _register_container(nested["url"], crawled=False)
                        if collected_mega:
                            resolved_via = "paste_crawl" if is_paste_container_url(current) else "clean_http"
                            return {
                                "link_kind": "resolved_mega",
                                "resolved_mega_url": collected_mega[0],
                                "final_url": collected_mega[0],
                                "domain": "mega.nz",
                                "hops": hops,
                                "mega_urls": collected_mega,
                                "media_urls": collected_media,
                                "container_urls": collected_containers,
                                "resolved_via": resolved_via,
                            }
                        if collected_media:
                            resolved_via = "paste_crawl" if is_paste_container_url(current) else "clean_http"
                            break
                        meta_match = _META_REFRESH_RE.search(body_text) or _JS_REDIRECT_RE.search(body_text)
                        if meta_match:
                            raw_next = html.unescape(meta_match.group(1).strip())
                            next_url = urljoin(current, raw_next)
                            if next_url != current:
                                hops += 1
                                current = decode_local_wrapper_url(next_url) or next_url
                                mega_target = _try_parse_mega(current)
                                if mega_target:
                                    _merge_mega([mega_target])
                                    return {
                                        "link_kind": "resolved_mega",
                                        "resolved_mega_url": collected_mega[0],
                                        "final_url": collected_mega[0],
                                        "domain": "mega.nz",
                                        "hops": hops,
                                        "mega_urls": collected_mega,
                                        "media_urls": collected_media,
                                        "container_urls": collected_containers,
                                        "resolved_via": resolved_via,
                                    }
                                continue
                except httpx.HTTPError:
                    pass
            break

    if collected_mega:
        return {
            "link_kind": "resolved_mega",
            "resolved_mega_url": collected_mega[0],
            "final_url": collected_mega[0],
            "domain": "mega.nz",
            "hops": hops,
            "mega_urls": collected_mega,
            "media_urls": collected_media,
            "container_urls": collected_containers,
            "resolved_via": resolved_via,
        }

    return {
        "link_kind": "external",
        "resolved_mega_url": None,
        "final_url": current,
        "domain": _domain_of(current),
        "hops": hops,
        "mega_urls": collected_mega,
        "media_urls": collected_media,
        "container_urls": collected_containers,
        "resolved_via": resolved_via if collected_media else "external_gate",
    }
