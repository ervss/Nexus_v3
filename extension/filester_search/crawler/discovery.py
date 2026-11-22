from __future__ import annotations

from urllib.parse import urlparse

from .parser import folder_id_from_url, normalize_url, page_num_from_url


def is_filester_url(url: str, allowed_hosts: set[str] | None = None) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
        if allowed_hosts:
            return host in allowed_hosts
        return host in {
            "filester.me", "www.filester.me",
            "filester.sh", "filester.si", "filester.gg",
        }
    except Exception:
        return False


def prioritize_url(url: str, *, out_degree_hint: int = 0, is_collection: bool = False) -> int:
    """Lower = higher priority. Graph-aware."""
    if "page=" in url and folder_id_from_url(url):
        pn = page_num_from_url(url)
        return 5 + min(20, pn)

    if folder_id_from_url(url):
        if is_collection or out_degree_hint >= 8:
            return 8
        return 15

    path = urlparse(url).path or "/"
    if path == "/proxy":
        return 25
    if path in ("/", "/blog", "/changelog"):
        return 35
    if path.startswith("/blog/"):
        return 45
    return 80


def expand_seeds(raw: list[str], allowed_hosts: set[str] | None = None) -> list[str]:
    out = []
    seen = set()
    for s in raw:
        s = (s or "").strip()
        if not s:
            continue
        if s.startswith("/f/"):
            s = "https://filester.me" + s
        if not s.startswith("http"):
            if len(s) >= 8 and all(c in "0123456789abcdef" for c in s.lower()):
                s = f"https://filester.me/f/{s.lower()}"
            else:
                continue
        n = normalize_url(s, s, allowed_hosts) or s
        if folder_id_from_url(n):
            n = n.split("?")[0]
        if n not in seen and is_filester_url(n, allowed_hosts):
            seen.add(n)
            out.append(n)
    return out


BOUNDARY_NOTES = """
AUTH_BOUNDARIES (observed, not crossed):
  GET /api/user/folders              -> 401
  GET /api/manager/preferences       -> 401
  GET /api/v1/files|/folders         -> auth required (Bearer)
METHOD_GATED:
  POST /api/folder/download|create|edit
ANTI_ABUSE:
  ddos-guard edge; HTTP 429 -> Retry-After / backoff
ID_SPACE:
  folder IDs = 16-char hex — not enumerable under policy
  /d/<slug> only captured when embedded in public HTML
PUBLIC_EXPANSION_EDGES:
  1. high-fanout collection folders (/f/ grids, subfolder UI)
  2. same-folder pagination (?page=N)
  3. mirrors filester.sh|.si|.gg (same public IDs)
  4. user-supplied seeds
"""
