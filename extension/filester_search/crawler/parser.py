from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import parse_qs, urljoin, urlparse, urldefrag, urlencode, urlunparse

from bs4 import BeautifulSoup


FOLDER_RE = re.compile(r"^/f/([a-fA-F0-9]{8,64})/?$")
FILE_COUNT_RE = re.compile(r"with\s+(\d+)\s+files?", re.I)
DOWNLOAD_RE = re.compile(r"/d/([A-Za-z0-9]{4,16})")
THUMB_RE = re.compile(r"/t/([a-f0-9-]{20,})", re.I)

DEFAULT_HOSTS = {
    "filester.me", "www.filester.me",
    "filester.sh", "filester.si", "filester.gg",
}


@dataclass
class ParsedPage:
    url: str
    folder_id: Optional[str]
    kind: str
    title: str = ""
    description: str = ""
    file_count: int = 0
    filenames: list[str] = field(default_factory=list)
    file_meta: list[dict] = field(default_factory=list)
    file_slugs: list[str] = field(default_factory=list)
    thumb_ids: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    outbound_folders: list[str] = field(default_factory=list)
    outbound_pages: list[str] = field(default_factory=list)
    pagination_urls: list[str] = field(default_factory=list)
    out_degree: int = 0
    is_collection: bool = False
    content_hash: str = ""
    http_status: int = 200
    page_number: int = 1


def normalize_url(base: str, href: str, allowed_hosts: set[str] | None = None) -> Optional[str]:
    if not href:
        return None
    href = href.strip()
    if href.startswith(("#", "javascript:", "mailto:", "data:")):
        return None
    abs_url = urljoin(base, href)
    abs_url, _ = urldefrag(abs_url)
    parsed = urlparse(abs_url)
    if parsed.scheme not in ("http", "https"):
        return None
    host = (parsed.hostname or "").lower()
    hosts = allowed_hosts or DEFAULT_HOSTS
    if host not in hosts:
        return None
    path = parsed.path or "/"
    qs = parse_qs(parsed.query)
    page = qs.get("page", [None])[0]
    query = urlencode({"page": page}) if page and str(page).isdigit() and int(page) > 1 else ""
    return urlunparse(("https", "filester.me", path, "", query, ""))


def folder_id_from_url(url: str) -> Optional[str]:
    path = urlparse(url).path or ""
    m = FOLDER_RE.match(path)
    return m.group(1).lower() if m else None


def page_num_from_url(url: str) -> int:
    qs = parse_qs(urlparse(url).query)
    try:
        return max(1, int(qs.get("page", ["1"])[0]))
    except Exception:
        return 1


def folder_page_url(folder_id: str, page: int = 1) -> str:
    if page <= 1:
        return f"https://filester.me/f/{folder_id}"
    return f"https://filester.me/f/{folder_id}?page={page}"


def parse_html(
    url: str,
    html: str,
    status: int = 200,
    allowed_hosts: set[str] | None = None,
) -> ParsedPage:
    soup = BeautifulSoup(html or "", "html.parser")
    fid = folder_id_from_url(url)
    kind = "folder" if fid else "page"
    page_number = page_num_from_url(url)

    title = ""
    og_t = soup.find("meta", property="og:title")
    if og_t and og_t.get("content"):
        title = og_t["content"].strip()
    if not title and soup.title:
        title = soup.title.get_text(" ", strip=True)
    title = re.sub(r"\s*\|\s*filester\.me\s*$", "", title, flags=re.I).strip()

    ft = soup.select_one("h1.folder-title, .folder-title")
    if ft:
        t2 = ft.get_text(" ", strip=True)
        if t2:
            title = t2

    desc = ""
    og_d = soup.find("meta", property="og:description")
    if og_d and og_d.get("content"):
        desc = og_d["content"].strip()
    if not desc:
        md = soup.find("meta", attrs={"name": "description"})
        if md and md.get("content"):
            desc = md["content"].strip()

    file_count = 0
    m = FILE_COUNT_RE.search(desc)
    if m:
        file_count = int(m.group(1))

    filenames: list[str] = []
    file_meta: list[dict] = []
    file_slugs: list[str] = []
    seen_names: set[str] = set()

    for el in soup.select(".file-item, [data-name]"):
        name = (el.get("data-name") or "").strip()
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        filenames.append(name)
        slug = ""
        onclick = el.get("onclick") or ""
        sm = DOWNLOAD_RE.search(onclick)
        if sm:
            slug = sm.group(1)
        if not slug:
            a = el.find("a", href=True)
            if a:
                sm = DOWNLOAD_RE.search(a["href"])
                if sm:
                    slug = sm.group(1)
        if slug:
            file_slugs.append(slug)
        file_thumbs = THUMB_RE.findall(str(el))
        file_meta.append({
            "name": name,
            "size": int(el.get("data-size") or 0),
            "type": (el.get("data-type") or "").strip(),
            "date": (el.get("data-date") or "").strip(),
            "slug": slug,
            "thumb_id": file_thumbs[0] if file_thumbs else "",
        })

    if not file_count and filenames:
        file_count = len(filenames)

    thumb_ids = list(dict.fromkeys(THUMB_RE.findall(html or "")))

    outbound_folders: list[str] = []
    outbound_pages: list[str] = []
    pagination_urls: list[str] = []
    seen_f: set[str] = set()
    seen_p: set[str] = set()

    def _add_folder(nurl: str) -> None:
        if not nurl:
            return
        base = nurl.split("?")[0]
        fid2 = folder_id_from_url(base)
        if not fid2:
            return
        if base not in seen_f:
            seen_f.add(base)
            outbound_folders.append(base)

    for a in soup.find_all("a", href=True):
        nurl = normalize_url(url, a["href"], allowed_hosts)
        if not nurl:
            continue
        if folder_id_from_url(nurl):
            if fid and folder_id_from_url(nurl) == fid and "page=" in nurl:
                if nurl not in seen_p:
                    seen_p.add(nurl)
                    pagination_urls.append(nurl)
            else:
                _add_folder(nurl)
        else:
            path = urlparse(nurl).path
            if path in ("/", "/blog", "/changelog", "/faq", "/paste", "/proxy") or path.startswith("/blog/"):
                if nurl not in seen_p:
                    seen_p.add(nurl)
                    outbound_pages.append(nurl)

    for el in soup.select(
        "#subfoldersGrid a[href], .subfolder-item a[href], a.subfolder-item, "
        ".subfolders a[href], [class*='subfolder'] a[href]"
    ):
        nurl = normalize_url(url, el.get("href", ""), allowed_hosts)
        _add_folder(nurl)

    for mid in re.findall(r"/f/([a-fA-F0-9]{8,64})", html or ""):
        _add_folder(f"https://filester.me/f/{mid.lower()}")

    if fid and file_count and file_count > len(filenames) and page_number == 1:
        remaining = file_count - len(filenames)
        if remaining > 0:
            per = max(len(filenames), 1)
            extra = min(20, (remaining + per - 1) // per)
            for p in range(2, extra + 2):
                pu = folder_page_url(fid, p)
                if pu not in seen_p:
                    seen_p.add(pu)
                    pagination_urls.append(pu)

    if fid:
        for p in re.findall(r"[?&]page=(\d+)", html or ""):
            try:
                pi = int(p)
            except ValueError:
                continue
            if pi > 1:
                pu = folder_page_url(fid, pi)
                if pu not in seen_p:
                    seen_p.add(pu)
                    pagination_urls.append(pu)

    out_degree = len(outbound_folders)
    is_collection = out_degree >= 8 or bool(
        soup.select_one("#subfoldersGrid, .subfoldersGrid, .subfolder-item")
    )

    h = hashlib.sha1()
    h.update((title or "").encode())
    h.update((desc or "").encode())
    for n in filenames:
        h.update(n.encode("utf-8", errors="ignore"))
    for f in sorted(seen_f):
        h.update(f.encode())
    content_hash = h.hexdigest()

    return ParsedPage(
        url=url.split("?")[0] if page_number <= 1 else url,
        folder_id=fid,
        kind=kind,
        title=title,
        description=desc,
        file_count=file_count,
        filenames=filenames,
        file_meta=file_meta,
        file_slugs=file_slugs,
        thumb_ids=thumb_ids,
        outbound_folders=outbound_folders,
        outbound_pages=outbound_pages,
        pagination_urls=pagination_urls,
        out_degree=out_degree,
        is_collection=is_collection,
        content_hash=content_hash,
        http_status=status,
        page_number=page_number,
    )
