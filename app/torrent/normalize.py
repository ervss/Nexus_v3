"""Pure result normalization. No network, so the search contract stays testable."""

from __future__ import annotations

import base64
import binascii
import re
import secrets
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urlsplit, urlunsplit

from ..url_safety import require_public_http_url

_HEX = set("0123456789abcdef")
_B32 = re.compile(r"^[A-Z2-7]{32}$")
_REF_TTL = 30 * 60
_refs: dict[str, tuple[float, str]] = {}
_SENSITIVE_QUERY = {"apikey", "api_key", "key", "passkey", "password", "token"}


class RejectedURL(ValueError):
    pass


def canonical_infohash(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    lower = raw.lower()
    if "urn:btih:" in lower:
        raw = raw.split(":")[-1]
        lower = raw.lower()
    if len(lower) in {40, 64} and all(ch in _HEX for ch in lower):
        return lower
    candidate = raw.upper()
    if _B32.match(candidate):
        try:
            decoded = base64.b32decode(candidate)
        except binascii.Error:
            return ""
        if len(decoded) == 20:
            return decoded.hex()
    return ""


def build_magnet(infohash: str, title: str = "") -> str:
    digest = canonical_infohash(infohash)
    if not digest:
        return ""
    magnet = f"magnet:?xt=urn:btih:{digest}"
    cleaned = " ".join((title or "").split())
    if cleaned:
        magnet += "&dn=" + quote(cleaned[:180])
    return magnet


def validate_magnet(value: str) -> str:
    magnet = (value or "").strip()
    if len(magnet) > 8192 or not magnet.lower().startswith("magnet:?"):
        raise RejectedURL("Magnet link is not valid")
    if "urn:btih:" not in magnet.lower() and "urn:btmh:" not in magnet.lower():
        raise RejectedURL("Magnet link has no infohash")
    return magnet


def infohash_from_magnet(magnet: str) -> str:
    try:
        query = parse_qs(urlsplit(magnet).query)
    except ValueError:
        return ""
    for item in query.get("xt", []):
        digest = canonical_infohash(item)
        if digest:
            return digest
    return ""


def clean_details_url(value: Any) -> str:
    """Keep a public details page and drop query secrets such as an API key."""
    raw = str(value or "").strip()
    if not raw or raw.lower().startswith(("magnet:", "data:", "file:")):
        return ""
    try:
        safe = require_public_http_url(raw)
    except ValueError:
        return ""
    parts = urlsplit(safe)
    kept = []
    for key, val in parse_qs(parts.query, keep_blank_values=True).items():
        if key.lower() in _SENSITIVE_QUERY:
            continue
        for item in val:
            kept.append((key, item))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(kept), ""))


def _same_origin(url: str, base: str) -> bool:
    try:
        left, right = urlsplit(url), urlsplit(base)
    except ValueError:
        return False
    if left.scheme not in {"http", "https"} or left.scheme != right.scheme:
        return False
    if (left.hostname or "").lower() != (right.hostname or "").lower():
        return False

    def port(parsed) -> int | None:
        if parsed.port:
            return parsed.port
        return 443 if parsed.scheme == "https" else 80

    return port(left) == port(right)


def acceptable_download_url(url: str, allowed_bases: list[str]) -> bool:
    candidate = (url or "").strip()
    if not candidate or len(candidate) > 4000:
        return False
    if any(base and _same_origin(candidate, base) for base in allowed_bases):
        return True
    try:
        require_public_http_url(candidate)
    except ValueError:
        return False
    return True


def store_download_ref(url: str) -> str:
    token = secrets.token_urlsafe(18)
    _refs[token] = (time.time() + _REF_TTL, url)
    _purge_refs()
    return token


def lookup_download_ref(token: str) -> str | None:
    item = _refs.get((token or "").strip())
    if not item:
        return None
    expires, url = item
    if expires < time.time():
        _refs.pop(token, None)
        return None
    return url


def _purge_refs() -> None:
    if len(_refs) < 400:
        return
    now = time.time()
    for key, (expires, _) in list(_refs.items()):
        if expires < now:
            _refs.pop(key, None)


def _as_int(value: Any) -> int:
    if value is None or value is False:
        return 0
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return max(0, int(value))
    text = str(value).strip().replace(",", "")
    if not text:
        return 0
    try:
        return max(0, int(float(text)))
    except ValueError:
        return 0


def _publish_date(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (int, float)) and value > 10_000_000_000:
        value = value / 1000
    if isinstance(value, (int, float)) and value > 1_000_000_000:
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
    text = str(value).strip()
    if not text:
        return ""
    match = re.search(r"/Date\((\d+)\)/", text)
    if match:
        return datetime.fromtimestamp(int(match.group(1)) / 1000, tz=timezone.utc).isoformat()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        parsed = None
    if parsed is None:
        try:
            parsed = parsedate_to_datetime(text)
        except (TypeError, ValueError, IndexError):
            return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _leechers(seeders: int, peers: int, explicit: int | None = None) -> int:
    if explicit is not None:
        return max(0, explicit)
    if peers <= 0:
        return 0
    # Jackett's Peers field is the leecher count on most indexers. When a
    # tracker reports total peers instead, the value is larger than seeders.
    if seeders and peers > seeders:
        return peers - seeders
    return peers


def _row(
    *,
    title: str,
    size: int,
    seeders: int,
    leechers: int,
    magnet: str,
    infohash: str,
    indexer: str,
    details_url: str,
    publish_date: str,
    download_url: str = "",
) -> dict[str, Any] | None:
    digest = canonical_infohash(infohash) or infohash_from_magnet(magnet)
    magnet = magnet.strip() if magnet.strip().lower().startswith("magnet:?") else ""
    if not magnet and digest:
        magnet = build_magnet(digest, title)
    if not title and not digest and not magnet and not download_url:
        return None
    return {
        "title": " ".join((title or digest or "Untitled").split())[:500],
        "size": max(0, size),
        "seeders": max(0, seeders),
        "leechers": max(0, leechers),
        "magnet": magnet,
        "infohash": digest,
        "indexer": (indexer or "unknown")[:120],
        "details_url": clean_details_url(details_url),
        "publish_date": publish_date,
        "download_url": download_url,
        "poster_url": "",
    }


def _first(raw: dict[str, Any], *names: str) -> Any:
    folded = {str(key).lower(): value for key, value in raw.items()}
    for name in names:
        if name.lower() in folded:
            return folded[name.lower()]
    return None


def normalize_jackett_result(raw: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    seeders = _as_int(_first(raw, "Seeders", "seeders"))
    peers = _as_int(_first(raw, "Peers", "peers"))
    explicit = _first(raw, "Leechers", "leechers")
    row = _row(
        title=str(_first(raw, "Title", "title") or ""),
        size=_as_int(_first(raw, "Size", "size")),
        seeders=seeders,
        leechers=_leechers(seeders, peers, _as_int(explicit) if explicit is not None else None),
        magnet=str(_first(raw, "MagnetUri", "MagnetUrl", "magnet") or ""),
        infohash=str(_first(raw, "InfoHash", "infoHash", "infohash") or ""),
        indexer=str(_first(raw, "Tracker", "Indexer", "tracker", "indexer") or ""),
        details_url=str(_first(raw, "Details", "Guid", "comments", "InfoUrl") or ""),
        publish_date=_publish_date(_first(raw, "PublishDate", "publishDate", "pubDate")),
        download_url=str(_first(raw, "Link", "downloadUrl", "DownloadUrl") or ""),
    )
    if row is not None:
        row["poster_url"] = str(_first(raw, "Poster", "poster", "posterUrl") or "")
    return row


def normalize_prowlarr_result(raw: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    if str(raw.get("protocol") or "torrent").lower() not in {"", "torrent"}:
        return None
    seeders = _as_int(raw.get("seeders"))
    row = _row(
        title=str(raw.get("title") or ""),
        size=_as_int(raw.get("size")),
        seeders=seeders,
        leechers=_as_int(raw.get("leechers")),
        magnet=str(raw.get("magnetUrl") or ""),
        infohash=str(raw.get("infoHash") or ""),
        indexer=str(raw.get("indexer") or ""),
        details_url=str(raw.get("infoUrl") or raw.get("guid") or ""),
        publish_date=_publish_date(raw.get("publishDate")),
        download_url=str(raw.get("downloadUrl") or ""),
    )
    if row is not None:
        row["poster_url"] = str(raw.get("posterUrl") or raw.get("poster") or "")
    return row


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def normalize_torznab_item(item: ET.Element) -> dict[str, Any] | None:
    fields: dict[str, str] = {}
    attrs: dict[str, str] = {}
    for child in list(item):
        name = _local(child.tag)
        if name == "attr":
            key = (child.attrib.get("name") or "").lower()
            attrs[key] = child.attrib.get("value") or ""
        elif child.text:
            fields[name] = child.text.strip()
    seeders = _as_int(attrs.get("seeders"))
    peers = _as_int(attrs.get("peers"))
    return _row(
        title=fields.get("title", ""),
        size=_as_int(attrs.get("size") or fields.get("size")),
        seeders=seeders,
        leechers=_leechers(seeders, peers),
        magnet=attrs.get("magneturl") or "",
        infohash=attrs.get("infohash") or "",
        indexer=fields.get("jackettindexer") or fields.get("indexer") or "",
        details_url=fields.get("comments") or fields.get("guid") or "",
        publish_date=_publish_date(fields.get("pubdate")),
        download_url=fields.get("link") or "",
    )


def parse_torznab(xml_text: str) -> list[dict[str, Any]]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    rows = []
    for item in root.iter():
        if _local(item.tag) != "item":
            continue
        row = normalize_torznab_item(item)
        if row:
            rows.append(row)
    return rows


def dedupe_results(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the healthiest release when several indexers return one infohash."""
    best: dict[str, dict[str, Any]] = {}
    anonymous: list[dict[str, Any]] = []
    for row in rows:
        digest = row.get("infohash") or ""
        if not digest:
            anonymous.append(row)
            continue
        current = best.get(digest)
        if current is None or (row.get("seeders") or 0, row.get("size") or 0) > (
            current.get("seeders") or 0,
            current.get("size") or 0,
        ):
            best[digest] = row
    merged = list(best.values()) + anonymous
    merged.sort(key=lambda row: (row.get("seeders") or 0, row.get("size") or 0), reverse=True)
    return merged


def public_result(row: dict[str, Any], allowed_bases: list[str]) -> dict[str, Any]:
    """Strip indexer download URLs. They often embed the Jackett or Prowlarr key."""
    exposed = {key: value for key, value in row.items() if key not in {"download_url", "poster_url"}}
    download = str(row.get("download_url") or "")
    exposed["ref"] = ""
    if not exposed.get("magnet") and acceptable_download_url(download, allowed_bases):
        exposed["ref"] = store_download_ref(download)
    digest = exposed.get("infohash") or ""
    if digest:
        title = quote(str(exposed.get("title") or "")[:180])
        details = quote(str(exposed.get("details_url") or "")[:800])
        exposed["thumb_url"] = f"/api/torrent/thumb?hash={digest}&title={title}&details={details}&v=2"
    else:
        exposed["thumb_url"] = "/static/torrent_placeholder.svg"
    return exposed
