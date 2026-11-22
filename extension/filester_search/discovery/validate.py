from __future__ import annotations



import re
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

from crawler.parser import parse_html
from discovery.web_extract import BLOCKED_IDS, canonical_folder_url, normalize_folder_id

UA = "FilesterPublicIndexer/5.0 (+live validation; polite; single GET per candidate)"


@dataclass
class ValidatedFolder:
    folder_id: str
    url: str
    title: str
    file_count: int
    subfolder_count: int
    folder_type: str  # CONTENT_FOLDER | COLLECTION | MIXED | DEAD | UNKNOWN
    http_status: int
    verified_at: float
    filenames: list[str] = field(default_factory=list)
    file_meta: list[dict] = field(default_factory=list)
    thumb_ids: list[str] = field(default_factory=list)
    outbound_folders: list[str] = field(default_factory=list)


def classify(file_count: int, subfolder_count: int, status: int) -> str:
    if status in (404,410):
        return "DEAD"
    if status == 0 or status in (401,403,429) or status >= 500:
        return "ERROR"
    if status not in (200, 304):
        return "UNKNOWN"
    if subfolder_count >= 8:
        return "COLLECTION"
    if file_count > 0 and subfolder_count <= 2:
        return "CONTENT_FOLDER"
    if file_count > 0 and subfolder_count > 2:
        return "MIXED"
    if file_count == 0 and subfolder_count > 0:
        return "COLLECTION"
    return "UNKNOWN"


async def validate_folder(client: httpx.AsyncClient, folder_id: str) -> ValidatedFolder:
    fid = folder_id.lower()
    url = canonical_folder_url(fid)
    if fid in BLOCKED_IDS:
        return ValidatedFolder(fid, url, "", 0, 0, "DEAD", 0, time.time())

    try:
        r = await client.get(url, follow_redirects=True)
        body = r.text or ""
        status = r.status_code
    except (httpx.HTTPError, TimeoutError):
        return ValidatedFolder(fid, url, "", 0, 0, "ERROR", 0, time.time())

    title = ""
    m = re.search(r'og:title" content="([^"]+)"', body)
    if m:
        title = m.group(1).strip()
    if not title:
        m = re.search(r'class="folder-title"[^>]*>([^<]+)', body)
        if m:
            title = m.group(1).strip()

    file_count = 0
    m = re.search(r"with\s+(\d+)\s+files?", body, re.I)
    if m:
        file_count = int(m.group(1))
    if not file_count:
        m = re.search(r"(\d+)\s+files?\b", body)
        if m:
            file_count = int(m.group(1))
    # visible file-items as lower bound
    vis = len(re.findall(r'class="file-item"', body))
    if vis > file_count:
        file_count = vis

    subfolder_count = 0
    m = re.search(r"(\d+)\s+subfolders?", body, re.I)
    if m:
        subfolder_count = int(m.group(1))

    parsed = parse_html(url, body, status=status)
    outbound = list(dict.fromkeys(
        candidate for link in parsed.outbound_folders
        if (candidate := normalize_folder_id(link)) and candidate != fid
    )) if status == 200 else []
    file_count = max(file_count, parsed.file_count)
    # A parent backlink is not evidence of a collection. An empty page with
    # real folder links is, even when the site's count metadata is absent.
    if not file_count and outbound:
        subfolder_count = max(subfolder_count, len(outbound))
    ftype = classify(file_count, subfolder_count, status)
    return ValidatedFolder(
        folder_id=fid,
        url=url,
        title=title,
        file_count=file_count,
        subfolder_count=subfolder_count,
        folder_type=ftype,
        http_status=status,
        verified_at=time.time(),
        filenames=parsed.filenames,
        file_meta=parsed.file_meta,
        thumb_ids=parsed.thumb_ids,
        outbound_folders=outbound,
    )
