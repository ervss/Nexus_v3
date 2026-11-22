"""Shared Netscape-format cookies.txt loading, for sources that need a real
authenticated session (not just a static consent cookie).

Factored out of app/extractors/faphouse.py so the Faphouse hub adapter
(app/hubs/faphouse.py) doesn't duplicate the candidate-file list or the
Netscape parser — both need the exact same cookie jar for every request.
"""
from __future__ import annotations

import http.cookiejar
import logging
import os
import urllib.request
from typing import Optional

logger = logging.getLogger(__name__)


def resolve_cookiefile(*names: str) -> Optional[str]:
    """First existing, non-empty file among `names` (checked in order)."""
    for name in names:
        if name and os.path.exists(name) and os.path.getsize(name) > 0:
            return name
    return None


def build_cookie_header(cookie_file: Optional[str]) -> str:
    """Netscape cookies.txt -> a `Cookie:` header string. "" if unreadable/missing."""
    if not cookie_file:
        return ""
    try:
        with open(cookie_file, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
        pairs: dict[str, str] = {}
        for line in lines:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.strip().split("\t")
            if len(parts) >= 7:
                pairs[parts[5]] = parts[6]
        return "; ".join(f"{k}={v}" for k, v in pairs.items())
    except Exception as exc:  # noqa: BLE001
        logger.warning("[cookie_jar] Error reading cookie header from %s: %s", cookie_file, exc)
        return ""


def load_cookie_dict(cookie_file: Optional[str]) -> dict[str, str]:
    """Netscape cookies.txt -> mapping suitable for an HTTP client cookie jar."""
    header = build_cookie_header(cookie_file)
    if not header:
        return {}
    return {
        name: value
        for part in header.split("; ")
        if "=" in part
        for name, value in [part.split("=", 1)]
    }


def build_opener(cookie_file: Optional[str]) -> urllib.request.OpenerDirector:
    """A urllib opener carrying the cookie jar, or a plain opener if none is available."""
    if cookie_file:
        try:
            jar = http.cookiejar.MozillaCookieJar(cookie_file)
            jar.load(ignore_discard=True, ignore_expires=True)
            return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[cookie_jar] Failed to load cookiejar from %s: %s", cookie_file, exc)
    return urllib.request.build_opener()


def cookiejar_mtime(cookie_file: Optional[str]) -> Optional[float]:
    """mtime of the resolved cookie file, for freshness reporting (net_status()).

    None means "no cookie file found" — callers should not treat that the same
    as "cookie file present but very old": a missing file is an outright
    signed-out session, distinct from a stale-but-present one.
    """
    if not cookie_file:
        return None
    try:
        return os.path.getmtime(cookie_file)
    except OSError:
        return None
