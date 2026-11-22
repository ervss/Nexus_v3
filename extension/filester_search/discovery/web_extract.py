from __future__ import annotations


import re
from urllib.parse import urlparse

from exclusions import EXCLUDED_FOLDER_ROOTS

FOLDER_ID_PATTERN = r"[a-fA-F0-9]{8,64}"
FOLDER_RE = re.compile(
    rf"(?<![\w./:@-])(?:https?://)?(?:www\.)?filester\.(?:me|sh|si|gg)/f/({FOLDER_ID_PATTERN})(?![\w-])",
    re.I,
)
# bare path in JSON-escaped URLs
FOLDER_RE2 = re.compile(
    rf"(?<![\w./:@-])(?:https?://)?(?:www\.)?filester\.(?:me|sh|si|gg)\\?/f\\?/({FOLDER_ID_PATTERN})(?![\w-])",
    re.I,
)

# Hard-block: never treat as discovery target
BLOCKED_IDS = set(EXCLUDED_FOLDER_ROOTS)


def normalize_folder_id(value: str) -> str | None:
    """Accept a bare ID or a public Filester folder URL; reject foreign hosts."""
    value = (value or "").strip()
    if "://" in value:
        parsed = urlparse(value)
        if parsed.scheme not in ("http", "https") or (parsed.hostname or "").lower() not in {
            "filester.me", "www.filester.me", "filester.sh", "filester.si", "filester.gg",
        }:
            return None
        if not parsed.path.startswith("/f/"):
            return None
        value = parsed.path.removeprefix("/f/").rstrip("/")
    fid = value.lower()
    return fid if re.fullmatch(FOLDER_ID_PATTERN, fid) and fid not in BLOCKED_IDS else None


def extract_folder_ids(text: str) -> list[str]:
    if not text:
        return []
    seen: set[str] = set()
    out: list[str] = []
    # Decode slash escaping before matching so host boundaries remain reliable.
    text = text.replace(r"\/", "/")
    for rx in (FOLDER_RE, FOLDER_RE2):
        for m in rx.finditer(text):
            fid = m.group(1).lower()
            if fid in BLOCKED_IDS or fid in seen:
                continue
            if not re.fullmatch(FOLDER_ID_PATTERN, fid):
                continue
            seen.add(fid)
            out.append(fid)
    return out


def canonical_folder_url(folder_id: str) -> str:
    return f"https://filester.me/f/{folder_id.lower()}"
