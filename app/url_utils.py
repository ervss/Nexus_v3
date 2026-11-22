"""
Shared helpers for normalizing URL-like values across discovery, related matching,
and lightweight lookup indexes.
"""
from __future__ import annotations

from typing import Optional
from urllib.parse import urlsplit


def normalize_url_key(
    value: Optional[str],
    *,
    strip_www: bool = True,
    lowercase_path: bool = True,
    lowercase_query: bool = False,
) -> str:
    """
    Return a stable host+path(+query) key for matching URLs across app surfaces.

    For fully-qualified HTTP/HTTPS URLs:
    - drops scheme and fragment
    - lowercases host
    - strips trailing slash from path
    - optionally strips leading ``www.``
    - lowercases path by default

    For non-URL or partial values, returns a trimmed trailing-slash-free fallback.
    """
    raw = (value or "").strip()
    if not raw:
        return ""

    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw.rstrip("/").lower()

    if parts.scheme and parts.netloc:
        host = (parts.hostname or parts.netloc or "").lower()
        if strip_www and host.startswith("www."):
            host = host[4:]

        path = parts.path.rstrip("/")
        if lowercase_path:
            path = path.lower()

        key = f"{host}{path}"
        if parts.query:
            query = parts.query.lower() if lowercase_query else parts.query
            key = f"{key}?{query}"
        return key

    fallback = raw.rstrip("/")
    return fallback.lower() if lowercase_path else fallback
