"""
Automated VK/vkvideo.ru cookie refresh — same rationale and mechanism as
app/faphouse_cookie_sync.py: the Nexus_Gallery browser extension reads the
user's real, logged-in session via `chrome.cookies.getAll` (which sees
HttpOnly cookies a content script never could — VK's own session cookies are
commonly HttpOnly) and pushes it here on a timer.

VK is a two-domain session (vk.com desktop site + vkvideo.ru, the actual
video-serving domain), and three independent, already-drifted code paths
read cookie files for it (app/extractors/vk.py, app/vk_ko_discovery.py,
app/routers/vk.py) — each with its own candidate-file list and, worse, two
on-disk copies (project root and app/) that were already observed out of
sync. Rather than unify those three readers (out of scope here, and risky —
each has its own working behavior today), this writer targets EVERY path any
of them checks, atomically, so whichever one runs next sees the same fresh
cookies no matter which file it happens to prefer.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

logger = logging.getLogger(__name__)

#: Every path any of the three existing VK cookie readers checks, for either
#: domain. Writing to all of them (rather than picking "the" canonical one)
#: sidesteps the root-vs-app drift the ones already on disk had fallen into.
_TARGETS: dict[str, tuple[str, ...]] = {
    "vk.com": ("vk.com_cookies.txt", "app/vk.com_cookies.txt"),
    "vkvideo.ru": ("vkvideo.ru_cookies.txt", "app/vkvideo.ru_cookies.txt", "vk.netscape.txt", "app/vk.netscape.txt"),
}

#: Same reasoning as Faphouse's sync module: a cookie with no expirationDate
#: is a browser session cookie (dies on browser close), not a forever one.
_SESSION_COOKIE_TTL_SECONDS = 6 * 3600


def _netscape_lines(cookies: list[dict]) -> tuple[list[str], list[str]]:
    now = time.time()
    lines = ["# Netscape HTTP Cookie File", "# Auto-written by the Nexus_Gallery extension — do not edit by hand."]
    names: list[str] = []
    for c in cookies or []:
        name = str(c.get("name") or "").strip()
        value = c.get("value")
        if not name or value is None:
            continue
        domain = str(c.get("domain") or "").strip()
        if not domain:
            continue
        if not domain.startswith("."):
            domain = "." + domain
        path_field = str(c.get("path") or "/").strip() or "/"
        secure = "TRUE" if c.get("secure") else "FALSE"
        expiry = c.get("expirationDate")
        expiry_ts = int(float(expiry)) if expiry else int(now + _SESSION_COOKIE_TTL_SECONDS)
        lines.append(f"{domain}\tTRUE\t{path_field}\t{secure}\t{expiry_ts}\t{name}\t{value}")
        names.append(name)
    return lines, names


def write_vk_cookies(cookies_by_domain: dict[str, list[dict]], *, root: Path | None = None) -> dict:
    """`{"vk.com": [...], "vkvideo.ru": [...]}` of raw chrome.cookies rows ->
    every on-disk file any VK code path reads. Returns a small per-domain
    report; a domain with no rows sent is skipped entirely rather than
    truncating that domain's existing (possibly still-valid) cookie files.
    """
    root = root or Path(__file__).resolve().parents[1]
    report: dict[str, dict] = {}

    for domain, rows in (cookies_by_domain or {}).items():
        targets = _TARGETS.get(domain)
        if targets is None:
            report[domain] = {"success": False, "reason": f"unknown domain '{domain}'"}
            continue
        lines, names = _netscape_lines(rows)
        if not names:
            report[domain] = {"success": False, "reason": "no valid cookies in payload", "written": 0}
            continue

        content = "\n".join(lines) + "\n"
        written_paths: list[str] = []
        for rel in targets:
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(content, encoding="utf-8")
            tmp.replace(path)
            written_paths.append(str(path))
        logger.info("[vk cookie sync] wrote %d cookies for %s to %d location(s)",
                    len(names), domain, len(written_paths))
        report[domain] = {"success": True, "written": len(names), "cookie_names": names, "paths": written_paths}

    return report
