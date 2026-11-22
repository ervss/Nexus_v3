"""
Automated Faphouse cookie refresh — the browser extension's `chrome.cookies`
API sees the user's real, logged-in session (including HttpOnly cookies a
content script could never read via `document.cookie`), and periodically
pushes it here so `faphouse_cookies.txt` never goes stale between manual
DevTools exports.

Writes the EXACT Netscape 7-field format `app/cookie_jar.py` reads, using
each cookie's real `expirationDate` from `chrome.cookies.getAll()` rather
than a fabricated far-future date — Faphouse mixes long-lived auth cookies
with short-TTL Cloudflare challenge cookies (`__cf_bm`, ~30 min), and
collapsing that distinction would make a genuinely expired cookie look fresh
to anything that later inspects the file's individual cookie expirations.
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

#: Same file the FaphouseHub/FaphouseExtractor look for first (highest
#: priority in COOKIE_CANDIDATES) — writing here means no adapter-side
#: change is needed for the auto-refreshed jar to take effect immediately.
FAPHOUSE_COOKIE_FILE = "faphouse_cookies.txt"

#: A cookie the extension sent with no expirationDate is a session cookie in
#: the browser's own model (dies when the browser closes) — NOT "lives
#: forever". Netscape format has no "session" marker, so the closest honest
#: representation is a short, clearly-bounded lifetime rather than either
#: extreme (immediately-expired would make resolve() treat it as absent;
#: far-future would misrepresent a cookie the browser itself doesn't persist).
_SESSION_COOKIE_TTL_SECONDS = 6 * 3600


def _build_netscape_lines(cookies: list[dict]) -> tuple[list[str], list[str]]:
    now = time.time()
    lines = ["# Netscape HTTP Cookie File", "# Auto-written by the Nexus_Gallery extension — do not edit by hand."]
    names: list[str] = []
    for c in cookies or []:
        name = str(c.get("name") or "").strip()
        value = c.get("value")
        if not name or value is None:
            continue
        domain = str(c.get("domain") or "faphouse.com").strip() or "faphouse.com"
        # Netscape's leading-dot domain flag means "this and all subdomains" —
        # chrome.cookies already reports a leading dot for host-wide cookies,
        # so this only needs to ensure one is present, never to add a second.
        if not domain.startswith("."):
            domain = "." + domain
        path_field = str(c.get("path") or "/").strip() or "/"
        secure = "TRUE" if c.get("secure") else "FALSE"
        include_subdomains = "TRUE"
        expiry = c.get("expirationDate")
        expiry_ts = int(float(expiry)) if expiry else int(now + _SESSION_COOKIE_TTL_SECONDS)
        lines.append(f"{domain}\t{include_subdomains}\t{path_field}\t{secure}\t{expiry_ts}\t{name}\t{value}")
        names.append(name)
    return lines, names


async def _looks_signed_in(cookie_header: str) -> Optional[bool]:
    """Best-effort: does Faphouse's OWN view-state say this session is
    logged in? None means "couldn't tell" (network hiccup, page shape
    changed) — treated as "don't know, don't block the write" by the caller,
    since refusing every write on an unrelated fetch failure would be worse
    than the stale-cookie problem this function exists to catch.
    """
    import re
    import json as _json
    from curl_cffi import requests as cr

    def _do() -> Optional[bool]:
        try:
            resp = cr.Session(impersonate="chrome").get(
                "https://faphouse.com/videos",
                headers={"Cookie": cookie_header, "Referer": "https://faphouse.com/"},
                timeout=10,
            )
            m = re.search(r'<script[^>]*id="view-state-data"[^>]*>(.*?)</script>', resp.text, re.S)
            if not m:
                return None
            data = _json.loads(m.group(1).strip())
            return bool((data.get("user") or {}).get("currentUserId"))
        except Exception:  # noqa: BLE001
            return None

    return await asyncio.to_thread(_do)


async def write_faphouse_cookies(cookies: list[dict], *, root: Path | None = None,
                                  verify: bool = True) -> dict:
    """`chrome.cookies.getAll()` rows -> Netscape file. Returns a small report.

    `cookies` rows are the raw browser objects: {name, value, domain, path,
    secure, expirationDate (unix seconds, float, optional)}. Silently drops
    any row missing name/value rather than writing a malformed line — a
    partial browser export must not corrupt the whole jar for the sake of
    one odd cookie.

    When `verify` is True (the default — the extension's push path), a
    signed-OUT incoming batch is refused if the file it would replace is
    currently signed-IN: a session that just expired mid-browsing, or a
    push captured from an incognito/logged-out tab, would otherwise silently
    downgrade a working cookie jar to a dead one — exactly the "resolve()
    suddenly starts failing with no obvious cause" symptom this module was
    built to prevent, just moved from "manual export went stale" to
    "auto-refresh clobbered a good file with a bad one".
    """
    root = root or Path(__file__).resolve().parents[1]
    path = root / FAPHOUSE_COOKIE_FILE

    lines, names = _build_netscape_lines(cookies)
    if not names:
        return {"success": False, "reason": "no valid cookies in payload", "written": 0}

    if verify:
        from .cookie_jar import build_cookie_header

        incoming_header = "; ".join(
            f"{c.get('name')}={c.get('value')}" for c in cookies
            if c.get("name") and c.get("value") is not None
        )
        incoming_signed_in = await _looks_signed_in(incoming_header)
        if incoming_signed_in is False and path.exists() and path.stat().st_size > 0:
            existing_header = build_cookie_header(str(path))
            existing_signed_in = await _looks_signed_in(existing_header)
            if existing_signed_in:
                logger.warning(
                    "[faphouse cookie sync] refused: incoming batch is signed-out "
                    "but %s currently holds a signed-in session — keeping the existing file",
                    path,
                )
                return {"success": False, "reason": "incoming session is signed-out; kept existing signed-in cookies",
                        "written": 0, "refused_downgrade": True}

    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tmp.replace(path)
    logger.info("[faphouse cookie sync] wrote %d cookies to %s", len(names), path)
    return {"success": True, "written": len(names), "cookie_names": names, "path": str(path)}
