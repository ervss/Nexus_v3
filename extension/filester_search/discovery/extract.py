
from __future__ import annotations
import re
from typing import Iterable
from discovery.web_extract import FOLDER_ID_PATTERN

# Preserve relative public links, using the same length contract as the parser.
FOLDER_ID_RE = re.compile(rf"(?<![\w./:@-])(?:https?://(?:www\.)?filester\.(?:me|sh|si|gg))?/f/({FOLDER_ID_PATTERN})(?![\w-])", re.I)
FOLDER_ID_BARE = re.compile(r"\b([a-f0-9]{16})\b", re.I)
DOWNLOAD_SLUG_RE = re.compile(r"/d/([A-Za-z0-9]{4,20})")

def extract_folder_ids(text: str) -> list[str]:
    """Generic extractor: HTML, JSON, JS, plain text."""
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for m in FOLDER_ID_RE.finditer(text):
        fid = m.group(1).lower()
        if fid not in seen:
            seen.add(fid)
            found.append(fid)
    return found

def extract_download_slugs(text: str) -> list[str]:
    return list(dict.fromkeys(DOWNLOAD_SLUG_RE.findall(text or "")))

def looks_like_collection(html: str, folder_ids_in_page: int) -> bool:
    if folder_ids_in_page >= 8:
        return True
    if re.search(r"\b(\d+)\s+subfolders?\b", html or "", re.I):
        return True
    if "subfoldersGrid" in (html or "") or "subfolder-item" in (html or ""):
        return True
    return False

def subfolder_count_meta(html: str) -> int:
    m = re.search(r"\b(\d+)\s+subfolders?\b", html or "", re.I)
    return int(m.group(1)) if m else 0
