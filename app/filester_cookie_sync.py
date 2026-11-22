"""
Automated Filester cookie refresh — same rationale as app/faphouse_cookie_sync.py:
the browser extension's `chrome.cookies` API sees the real, logged-in session
and periodically pushes it here so filester.me_cookies.txt never goes stale
between manual exports.

Filester only needs one cookie (`auth_token`, a JWT) to authenticate — unlike
Faphouse there's no separate short-TTL challenge cookie mixed in, so every
cookie in the batch gets its real expirationDate from chrome.cookies rather
than needing Faphouse's "don't fabricate a date" distinction for a second
cookie class that doesn't exist here.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

#: Same file FilesterExtractor's cookie search checks first (see
#: _build_cookie_search_paths in app/extractors/filester.py) — writing here
#: means no extractor-side change is needed for the refreshed jar to apply.
FILESTER_COOKIE_FILE = "filester.me_cookies.txt"
FILEDITCH_COOKIE_FILE = "fileditchfiles_cookies.txt"

_SESSION_COOKIE_TTL_SECONDS = 6 * 3600
_FILESTER_SYNC_LOCK = asyncio.Lock()
_FILESTER_RECENT_SYNCS: dict[Path, tuple[str, float]] = {}


async def write_filester_cookies(cookies: list[dict], *, root: Path | None = None,
                                  verify: bool = True) -> dict:
    """Coalesce repeated browser events before network verification or disk writes."""
    root = root or Path(__file__).resolve().parents[1]
    path = (root / FILESTER_COOKIE_FILE).resolve()
    canonical = sorted((dict(c) for c in cookies), key=lambda c: (
        str(c.get("domain", "")), str(c.get("path", "/")), str(c.get("name", ""))))
    fingerprint = hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()
    async with _FILESTER_SYNC_LOCK:
        recent = _FILESTER_RECENT_SYNCS.get(path)
        if recent and recent[0] == fingerprint and time.monotonic() - recent[1] < 60 and path.exists():
            return {"success": True, "written": 0, "unchanged": True}
        result = await _write_filester_cookies(cookies, root=root, verify=verify)
        if result.get("success"):
            _FILESTER_RECENT_SYNCS[path] = (fingerprint, time.monotonic())
        return result


def _build_netscape_lines(cookies: list[dict]) -> tuple[list[str], list[str]]:
    now = time.time()
    lines = ["# Netscape HTTP Cookie File", "# Auto-written by the Nexus_Gallery extension — do not edit by hand."]
    names: list[str] = []
    for c in cookies or []:
        name = str(c.get("name") or "").strip()
        value = c.get("value")
        if not name or value is None:
            continue
        domain = str(c.get("domain") or "filester.me").strip() or "filester.me"
        if not domain.startswith("."):
            domain = "." + domain
        path_field = str(c.get("path") or "/").strip() or "/"
        secure = "TRUE" if c.get("secure") else "FALSE"
        expiry = c.get("expirationDate")
        expiry_ts = int(float(expiry)) if expiry else int(now + _SESSION_COOKIE_TTL_SECONDS)
        lines.append(f"{domain}\tTRUE\t{path_field}\t{secure}\t{expiry_ts}\t{name}\t{value}")
        names.append(name)
    return lines, names


async def _looks_signed_in(cookie_header: str) -> Optional[bool]:
    """Best-effort: does Filester's own dashboard say this session is logged
    in? None means "couldn't tell" — treated by the caller as "don't know,
    don't block the write", since refusing a write on an unrelated network
    hiccup would be worse than the stale-cookie problem this exists to catch.
    """
    import httpx

    try:
        async with httpx.AsyncClient(timeout=10, verify=False, follow_redirects=False) as client:
            resp = await client.get(
                "https://filester.me/dashboard",
                headers={"Cookie": cookie_header, "User-Agent": "Mozilla/5.0"},
            )
            # A dead/expired auth_token gets redirected away from /dashboard
            # (login or a challenge page) instead of served directly — the
            # same redirect-loop symptom extract_folder hits with a stale jar.
            if resp.status_code in (301, 302, 303, 307, 308):
                return False
            if resp.status_code == 200:
                return True
            return None
    except Exception:  # noqa: BLE001
        return None


async def _write_filester_cookies(cookies: list[dict], *, root: Path | None = None,
                                  verify: bool = True) -> dict:
    """`chrome.cookies.getAll()` rows -> Netscape file. Returns a small report.

    Mirrors write_faphouse_cookies's refuse-a-downgrade guard: an incoming
    signed-out batch (session just expired mid-browsing, or captured from a
    logged-out tab) is refused if the file it would replace is currently
    signed-in, so an auto-refresh tick can't silently clobber a working jar
    with a dead one.
    """
    root = root or Path(__file__).resolve().parents[1]
    path = root / FILESTER_COOKIE_FILE

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
                    "[filester cookie sync] refused: incoming batch is signed-out "
                    "but %s currently holds a signed-in session — keeping the existing file",
                    path,
                )
                return {"success": False, "reason": "incoming session is signed-out; kept existing signed-in cookies",
                        "written": 0, "refused_downgrade": True}

    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tmp.replace(path)
    logger.info("[filester cookie sync] wrote %d cookies to %s", len(names), path)
    return {"success": True, "written": len(names), "cookie_names": names, "path": str(path)}


def write_fileditch_cookies(cookies: list[dict], *, root: Path | None = None) -> dict:
    """Persist browser clearance cookies used by FileDitch's CDN viewer."""
    root = root or Path(__file__).resolve().parents[1]
    path = root / FILEDITCH_COOKIE_FILE
    lines, names = _build_netscape_lines(cookies)
    if not names:
        return {"success": False, "reason": "no valid cookies in payload", "written": 0}
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tmp.replace(path)
    logger.info("[fileditch cookie sync] wrote %d cookies to %s", len(names), path)
    return {"success": True, "written": len(names), "cookie_names": names, "path": str(path)}
