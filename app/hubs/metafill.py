"""Fill the three fields a Fusion Hub card promises: quality, size and date.

Adapters answer `enrich()` in whatever shape their own site made convenient, so
the grid receives three different kinds of gap:

  * the date lives under `added` on some adapters and `upload_date` on others,
    and arrives either ISO ("2024-02-14") or relative ("9 months ago"),
  * the size is missing entirely on sources whose watch page never states it,
  * neither is reported in a way the frontend can tell "unknown" from
    "this source can never know".

The first two are fixable here. The third is the important one: a card that
shows a blank size because the fetch has not run yet and a card that shows a
blank size because SxyPrn's CDN refuses a HEAD are the same pixel, and a
progress bar that counts the second kind as outstanding never reaches 100%.
So every filled row carries `size_basis` / `date_basis` explaining where the
value came from — or why there is none.

Measured live 2026-08-02 on `blowjob`, first page, per source:

    size from enrich   eporner whoreshub porntrex camwhores xvideos
                       noodlemagazine pornhub pimpbunny xxbrits
    size from HEAD     analdin (271 MB) anysex (2053 MB) thisvid (82 MB)
                       spankbang (117 MB)
    size impossible    xhamster (HLS master, no single file)
                       sxyprn  (CDN 404s a HEAD without a player session)
                       drtuber (resolve() itself is broken)
                       hqporner 4kporno (no enrich at all)
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

__all__ = ["SIZE_IMPOSSIBLE", "fill_missing", "normalise_date", "size_via_head"]

#: Sources that cannot produce a byte count no matter how hard we try, with the
#: reason shown to the user. Listing them beats an open-ended retry: without
#: this the auto-fetch would re-resolve these cards on every pass, pay the
#: watch-page cost each time and still end with an empty field.
SIZE_IMPOSSIBLE: dict[str, str] = {
    "xhamster": "HLS stream — nemá jeden súbor",
    "sxyprn": "CDN nepovolí zistiť veľkosť",
    "drtuber": "zdroj neposkytuje veľkosť",
    "hqporner": "zdroj neposkytuje veľkosť",
    "4kporno": "zdroj neposkytuje veľkosť",
    # Faphouse exposes the full feature as a signed HLS manifest.  A HEAD
    # cannot describe its aggregate size, and resolving every visible tile
    # solely to discover that fact both wastes requests and, with a signed-out
    # cookie jar, floods the log with one access warning per card.
    "faphouse": "HLS stream — nemá jeden súbor",
}

#: Keys adapters have historically used for the upload date, best first.
_DATE_KEYS = ("upload_date", "added", "date", "published", "posted")

_ISO_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
#: "9 months ago", "3 days ago", "22 hours ago", "1 week ago"
_AGO_RE = re.compile(
    r"(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago", re.I)
#: Rough spans; a card only needs the day, not the instant.
_AGO_DAYS = {"second": 0, "minute": 0, "hour": 0, "day": 1,
             "week": 7, "month": 30, "year": 365}
#: "Jun 7, 2026" / "7 June 2026"
_MONTHS = ("jan", "feb", "mar", "apr", "may", "jun",
           "jul", "aug", "sep", "oct", "nov", "dec")


def normalise_date(value: Any, *, today: Optional[date] = None) -> str:
    """Any adapter's date shape -> "YYYY-MM-DD", or "" when unreadable.

    Relative dates ("9 months ago") are resolved against `today` so the grid can
    sort every source on one axis. That conversion is lossy by nature — the
    source only ever said "about 9 months" — but a sortable approximation beats
    a string the UI can only print.
    """
    if not value:
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()

    text = str(value).strip()
    if not text:
        return ""

    iso = _ISO_RE.match(text)
    if iso:
        year, month, day = (int(g) for g in iso.groups())
        try:
            return date(year, month, day).isoformat()
        except ValueError:
            return ""

    now = today or datetime.now(timezone.utc).date()

    ago = _AGO_RE.search(text)
    if ago:
        n, unit = int(ago.group(1)), ago.group(2).lower()
        return (now - timedelta(days=n * _AGO_DAYS[unit])).isoformat()

    low = text.lower()
    if low.startswith("today") or low.startswith("dnes"):
        return now.isoformat()
    if low.startswith("yesterday") or low.startswith("včera"):
        return (now - timedelta(days=1)).isoformat()

    # "Jun 7, 2026" / "7 Jun 2026" — month name plus a 4-digit year.
    year_m = re.search(r"(19|20)\d{2}", text)
    if year_m:
        for idx, name in enumerate(_MONTHS, start=1):
            if name in low:
                day_m = re.search(r"\b(\d{1,2})\b", low.replace(year_m.group(0), " "))
                day = int(day_m.group(1)) if day_m else 1
                try:
                    return date(int(year_m.group(0)), idx, min(day, 28)).isoformat()
                except ValueError:
                    return ""
    return ""


def _pick_date(*sources: dict) -> str:
    """First readable date across several dicts, checked in key preference order."""
    for src in sources:
        if not src:
            continue
        for key in _DATE_KEYS:
            got = normalise_date(src.get(key))
            if got:
                return got
    return ""


async def size_via_head(adapter, url: str, *, timeout: float = 20.0) -> Optional[float]:
    """Megabytes from a HEAD on the resolved stream, or None.

    Only for sources whose `enrich()` cannot state a size. Two round-trips
    (resolve + HEAD) per card, so callers must gate it behind a concurrency
    limit and skip anything in SIZE_IMPOSSIBLE. Returns None rather than raising:
    a missing size is a blank field, never a failed grid.
    """
    try:
        from curl_cffi import requests as cr
    except ImportError:  # pragma: no cover - dependency is present in prod
        return None

    try:
        resolved = await asyncio.wait_for(adapter.resolve(url), timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[metafill] resolve failed for %s: %s", url[:60], exc)
        return None

    stream = (resolved or {}).get("stream_url") or ""
    # An HLS master lists renditions; it has no single byte count to report.
    if not stream or resolved.get("is_hls") or ".m3u8" in stream.lower():
        return None

    origin = getattr(adapter, "origin", "") or getattr(adapter, "stream_referer", "") or ""
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
    }
    if origin:
        headers["Referer"] = origin if origin.endswith("/") else origin + "/"

    def _head():
        return cr.head(stream, impersonate="chrome124", headers=headers,
                       timeout=timeout, allow_redirects=True)

    try:
        resp = await asyncio.wait_for(asyncio.to_thread(_head), timeout=timeout + 5)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[metafill] HEAD failed for %s: %s", url[:60], exc)
        return None

    if resp.status_code != 200:
        return None
    length = resp.headers.get("content-length")
    if not length:
        return None
    try:
        mb = int(length) / 1048576
    except (TypeError, ValueError):
        return None
    # A few hundred KB is a redirect stub or an error page, not the video.
    return round(mb, 1) if mb >= 1 else None


async def fill_missing(adapter, results: dict[str, dict], *,
                       tiles: Optional[dict[str, dict]] = None,
                       want_size: bool = True,
                       urls: Optional[list[str]] = None,
                       concurrency: int = 4,
                       timeout: float = 20.0) -> dict[str, dict]:
    """Normalise dates and backfill sizes for one source's enrich results.

    `tiles` optionally carries what the listing already knew per url, so a date
    the listing had is not thrown away when `enrich()` omits it.

    `urls` is what the caller asked about. It matters for the ~7 adapters that
    have no `enrich()` at all: those return `{}`, and without seeding the rows
    here the size fallback would have nothing to iterate and the card would stay
    blank forever — the exact gap this module exists to close. Mutates and
    returns `results`.
    """
    source = getattr(adapter, "source", "") or ""
    tiles = tiles or {}

    for url in (urls or []):
        results.setdefault(url, {})

    for url, data in results.items():
        if not isinstance(data, dict):
            continue
        iso = _pick_date(data, tiles.get(url) or {})
        if iso:
            data["upload_date"] = iso
            data["added"] = iso          # keep the legacy key the UI already reads
            data["date_basis"] = "source"
        try:
            from ..orientation import classify
            info = classify(data)
            data.setdefault("orientation", info["orientation"])
            data.setdefault("orientation_evidence", info["evidence"])
            if info.get("likely"):
                data.setdefault("orientation_likely", info["likely"])
            if info.get("confidence"):
                data.setdefault("orientation_confidence", info["confidence"])
        except Exception:
            pass

    if not want_size:
        return results

    reason = SIZE_IMPOSSIBLE.get(source)
    if reason:
        for data in results.values():
            if isinstance(data, dict) and not data.get("size_mb"):
                data["size_basis"] = "impossible"
                data["size_note"] = reason
        return results

    for data in results.values():
        if isinstance(data, dict) and data.get("size_mb"):
            data.setdefault("size_basis", "source")

    missing = [u for u, d in results.items()
               if isinstance(d, dict) and not d.get("size_mb")]
    if not missing:
        return results
    if not hasattr(adapter, "resolve"):
        for url in missing:
            results[url]["size_basis"] = "impossible"
            results[url]["size_note"] = "zdroj nemá resolver"
        return results

    sem = asyncio.Semaphore(max(1, concurrency))

    async def _one(url: str) -> None:
        async with sem:
            mb = await size_via_head(adapter, url, timeout=timeout)
        row = results.get(url)
        if not isinstance(row, dict):
            return
        if mb:
            row["size_mb"] = mb
            row["size_basis"] = "head"
        else:
            row["size_basis"] = "unavailable"

    await asyncio.gather(*[_one(u) for u in missing], return_exceptions=True)
    return results
