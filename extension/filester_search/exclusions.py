from __future__ import annotations

import re


EXCLUDED_FOLDER_ROOTS = {
    "442dd49c4567186e": "operator exclusion: #Cam tree",
}

_FOLDER_URL_RE = re.compile(
    r"^https?://(?:www\.)?filester\.(?:me|sh|si|gg)/f/([a-f0-9]{8,64})(?:[/?#].*)?$",
    re.IGNORECASE,
)


def folder_id_from_url(value: str) -> str | None:
    match = _FOLDER_URL_RE.match((value or "").strip())
    return match.group(1).lower() if match else None


def canonical_folder_url(folder_id: str) -> str:
    return f"https://filester.me/f/{folder_id.lower()}"
