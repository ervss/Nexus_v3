"""Board configuration + cookie loading.

Domains move (simpcity.su -> simpcity.cr), so they live here and nowhere else.
Auth is cookie-only: both boards sit behind DDoS-Guard and a captcha'd login,
so a scripted login flow is unreliable. Export cookies from the browser instead.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Board:
    key: str
    label: str
    base_url: str
    cookie_file: str
    #: XenForo renames its session cookies on some installs; we just send them all.
    color: str = "#22d3ee"

    @property
    def watched_url(self) -> str:
        return f"{self.base_url}/watched/threads"

    @property
    def tags_url(self) -> str:
        return f"{self.base_url}/tags/"

    @property
    def search_url(self) -> str:
        return f"{self.base_url}/search/search"


BOARDS: dict[str, Board] = {
    "simpcity": Board(
        key="simpcity",
        label="SimpCity",
        base_url=os.getenv("SIMPCITY_BASE_URL", "https://simpcity.cr").rstrip("/"),
        cookie_file=os.getenv("SIMPCITY_COOKIES", "simpcity.netscape.txt"),
        color="#22d3ee",
    ),
    "smg": Board(
        key="smg",
        label="SocialMediaGirls",
        base_url=os.getenv("SMG_BASE_URL", "https://forums.socialmediagirls.com").rstrip("/"),
        cookie_file=os.getenv("SMG_COOKIES", "smg.netscape.txt"),
        color="#f472b6",
    ),
}


def get_board(key: str) -> Board:
    board = BOARDS.get((key or "").strip().lower())
    if board is None:
        raise KeyError(f"Unknown board '{key}'. Known: {', '.join(BOARDS)}")
    return board


def load_cookies(board: Board) -> dict[str, str]:
    """Parse a Netscape cookie jar into a name->value dict. Missing file = no auth."""
    path = Path(board.cookie_file)
    if not path.is_absolute():
        path = _ROOT / path
    if not path.exists():
        return {}

    cookies: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        # Some exporters prefix HttpOnly cookies with #HttpOnly_ instead of a comment.
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) >= 7:
            try:
                expiry = int(parts[4])
            except ValueError:
                continue
            if expiry and expiry <= int(time.time()):
                continue
            cookies[parts[5]] = parts[6]
    return cookies


def _read_cookie_rows(board: Board) -> list[dict]:
    path = Path(board.cookie_file)
    if not path.is_absolute():
        path = _ROOT / path
    if not path.exists():
        return []

    rows = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        http_only = line.startswith("#HttpOnly_")
        if http_only:
            line = line[len("#HttpOnly_"):]
        elif line.startswith("#") or not line:
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        try:
            expiry = int(parts[4])
        except ValueError:
            expiry = 0
        rows.append({
            "domain": parts[0],
            "includeSubdomains": parts[1] == "TRUE",
            "path": parts[2],
            "secure": parts[3] == "TRUE",
            "expirationDate": expiry,
            "name": parts[5],
            "value": parts[6],
            "httpOnly": http_only,
        })
    return rows


def write_cookies(board: Board, cookies: dict[str, str]) -> int:
    """Merge a legacy name/value export without discarding cookie metadata."""
    existing = _read_cookie_rows(board)
    if existing:
        existing = [row for row in existing if row["name"] in cookies]
        by_name: dict[str, list[dict]] = {}
        for row in existing:
            by_name.setdefault(row["name"], []).append(row)
        for name, value in cookies.items():
            if name in by_name:
                for row in by_name[name]:
                    row["value"] = value
            else:
                existing.append({"name": name, "value": value})
        return write_cookie_rows(board, existing)

    domain = board.base_url.split("://", 1)[-1].split("/", 1)[0]
    return write_cookie_rows(board, [
        {
            "domain": domain,
            "includeSubdomains": False,
            "path": "/",
            "secure": True,
            "expirationDate": 0,
            "name": name,
            "value": value,
        }
        for name, value in cookies.items()
    ])


def merge_cookie_rows(board: Board, incoming_rows: list[dict]) -> int:
    """Merge a browser cookie export, preserving untouched domains and cookies."""
    rows = _read_cookie_rows(board)
    by_key = {(r["name"], r["domain"], r["path"]): i for i, r in enumerate(rows)}
    for incoming in incoming_rows:
        name = str(incoming.get("name") or "").strip()
        domain = str(incoming.get("domain") or "").strip()
        cookie_path = str(incoming.get("path") or "/").strip() or "/"
        if not name or incoming.get("value") is None:
            continue
        key = (name, domain, cookie_path)
        row = dict(incoming)
        if key in by_key:
            old = rows[by_key[key]]
            row.setdefault("httpOnly", old.get("httpOnly", False))
            rows[by_key[key]] = row
        else:
            by_key[key] = len(rows)
            rows.append(row)
    return write_cookie_rows(board, rows)


def write_cookie_rows(board: Board, rows: list[dict]) -> int:
    """Write a browser ``chrome.cookies`` export without losing its metadata.

    Keeping the real domain/path/secure/expiry fields matters for DDoS-Guard
    and prevents session cookies from being misrepresented as valid until 2100.
    """
    path = Path(board.cookie_file)
    if not path.is_absolute():
        path = _ROOT / path

    fallback_domain = board.base_url.split("://", 1)[-1].split("/", 1)[0]
    lines = ["# Netscape HTTP Cookie File", "# Auto-written by the Nexus_Gallery extension — do not edit by hand."]
    written = 0
    for row in rows:
        name = str(row.get("name") or "").strip()
        value = row.get("value")
        if not name or value is None:
            continue
        domain = str(row.get("domain") or fallback_domain).strip() or fallback_domain
        cookie_path = str(row.get("path") or "/").strip() or "/"
        # Tabs/newlines would corrupt the seven-field Netscape record.
        if any(ch in f"{name}{value}{domain}{cookie_path}" for ch in "\t\r\n"):
            continue
        include_subdomains = "TRUE" if row.get("includeSubdomains", domain.startswith(".")) else "FALSE"
        secure = "TRUE" if row.get("secure") else "FALSE"
        try:
            expiry = int(float(row.get("expirationDate") or 0))
        except (TypeError, ValueError):
            expiry = 0
        prefix = "#HttpOnly_" if row.get("httpOnly") else ""
        lines.append(f"{prefix}{domain}\t{include_subdomains}\t{cookie_path}\t{secure}\t{expiry}\t{name}\t{value}")
        written += 1
    if not written:
        return 0
    _atomic_write(path, lines)
    return written


def _atomic_write(path: Path, lines: list[str]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tmp.replace(path)


def cookie_prefix(cookies: dict[str, str]) -> str:
    """XenForo randomizes its cookie prefix on these boards; `<prefix>_csrf` reveals it."""
    for name in cookies:
        if name.endswith("_csrf"):
            return name[: -len("_csrf")]
    return "xf"


def missing_auth_cookies(cookies: dict[str, str]) -> list[str]:
    """The session/user cookies are HttpOnly, so JS-based exporters silently drop them."""
    if not cookies:
        return ["<all>"]
    prefix = cookie_prefix(cookies)
    return [name for name in (f"{prefix}_session", f"{prefix}_user") if name not in cookies]


def board_status(board: Board, *, expose_cookie_details: bool = True) -> dict:
    cookies = load_cookies(board)
    missing = missing_auth_cookies(cookies)
    cookie_path = Path(board.cookie_file)
    if not cookie_path.is_absolute():
        cookie_path = _ROOT / cookie_path
    status = {
        "board": board.key,
        "label": board.label,
        "base_url": board.base_url,
        "color": board.color,
        "authenticated": bool(cookies) and not missing,
        "cookie_updated_at": (
            datetime.fromtimestamp(cookie_path.stat().st_mtime).astimezone().isoformat(timespec="seconds")
            if cookie_path.exists() else ""
        ),
    }
    if expose_cookie_details:
        status.update({
            "cookie_file": board.cookie_file,
            "cookie_names": sorted(cookies),
            "missing_cookies": missing,
        })
    return status
