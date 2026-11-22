"""Pinned source-board galleries for one folder/site/theme."""
from __future__ import annotations

import datetime
import asyncio
import re
import time
from typing import Optional
from urllib.parse import urljoin, urlparse, unquote

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.cookie_jar import build_cookie_header, cookiejar_mtime, resolve_cookiefile
from app.database import ImportJob, ImportJobItem, SourceBoard, Video, get_db
from app.extractors.bunkr import BunkrExtractor
from app.extractors.filester import FilesterExtractor
from app.extractors.gofile import GoFileExtractor
from app.extractors.pixeldrain import PixeldrainExtractor
from app.intake import IntakeCandidate, IntakeImportRequest, create_import_job, intake_worker, serialize_job
from app import pornhub_hub

router = APIRouter(tags=["source-boards"])


SHELL_ONLY_THRESHOLD = 40
# These sources supply watch-page URLs, not direct media URLs.  Leaving them
# unresolved creates non-playable library rows that look imported until the
# next restart marks them as stale pending work.
SHELL_ONLY_DISABLED_SOURCES = frozenset({"pornhub", "camwhores"})


DEFAULT_SOURCE_BOARDS = [
    {
        "name": "Jack and Jill",
        "slug": "jack-and-jill",
        "source_url": "https://filester.me/f/01024d457faf41e0?page=1",
        "source_type": "filester",
        "batch_name": "Board - Jack and Jill",
        "description": "Pinned solo gallery synced from the Filester folder.",
        "icon": "folder_special",
        "color": "#a855f7",
        "sort_order": 10,
    }
]


class SourceBoardPayload(BaseModel):
    name: str
    source_url: str
    source_type: str = "auto"
    batch_name: Optional[str] = None
    description: str = ""
    icon: str = "folder_special"
    color: str = "#a855f7"
    pinned: bool = True


class SourceBoardLinksPayload(BaseModel):
    urls: list[str]


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return slug or "source-board"


def _default_batch_name(name: str) -> str:
    clean = re.sub(r"\s+", " ", (name or "Source Board").strip())
    return f"Board - {clean}"


def _should_use_shell_only(source_type: str, candidate_count: int) -> bool:
    return (
        candidate_count > SHELL_ONLY_THRESHOLD
        and (source_type or "").strip().lower() not in SHELL_ONLY_DISABLED_SOURCES
    )


def _detect_source_type(url: str, explicit: Optional[str] = None) -> str:
    value = (url or "").lower()
    requested = (explicit or "").strip().lower()
    if _is_fileditch_album(url):
        return "fileditch_album"
    if requested and requested not in {"auto", "generic", "unknown", "mixed"}:
        return requested
    if "whoreshub.com" in value:
        return "whoreshub"
    if "camwhores.tv" in value:
        return "camwhores"
    if "pixeldrain.com" in value:
        return "pixeldrain"
    if any(host in value for host in ("bunkr.", "bunkrr.", "balbums.st", "bunkr-albums.io")):
        return "bunkr"
    if "filester." in value or "fileditchfiles." in value:
        return "filester"
    if "gofile.io" in value:
        return "gofile"
    if "pornhub.com" in value or "pornhub.org" in value or "pornhub.net" in value:
        return "pornhub"
    return "generic"


def _is_fileditch_album(url: str) -> bool:
    parsed = urlparse(url or "")
    return parsed.scheme in {"http", "https"} and parsed.hostname in {"fileditchalbums.st", "www.fileditchalbums.st"}


def _parse_fileditch_album(html: str, page_url: str) -> list[dict]:
    """Collect video file pages from an album, preserving the page URL for refresh."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    found: dict[str, dict] = {}
    for link in soup.select("a[href]"):
        raw = (link.get("href") or "").strip()
        if not raw:
            continue
        file_url = urljoin(page_url, raw)
        parsed = urlparse(file_url)
        host = (parsed.hostname or "").lower()
        if not any(host == domain or host.endswith('.' + domain) for domain in
                   ("fileditchfiles.st", "fileditchfiles.me", "fileditchvids.st")):
            continue
        if not re.search(r"\.(?:mp4|mkv|webm|avi|mov|m4v|ts)$", unquote(parsed.path), re.I):
            continue
        canonical = parsed._replace(query="", fragment="").geturl()
        if canonical in found:
            continue
        image = link.find("img")
        title = (link.get("title") or (image.get("alt") if image else "")
                 or link.get_text(" ", strip=True) or unquote(parsed.path.rsplit("/", 1)[-1]))
        if title.lower() in {"mp4", "mkv", "webm", "avi", "mov", "m4v", "ts"}:
            title = unquote(parsed.path.rsplit("/", 1)[-1])
        found[canonical] = {"url": canonical, "source_url": canonical, "title": title.strip(),
                            "thumbnail": urljoin(page_url, image.get("src")) if image and image.get("src") else ""}
    return list(found.values())


async def _extract_fileditch_album(url: str) -> list[dict]:
    import httpx

    if not _is_fileditch_album(url):
        raise HTTPException(status_code=400, detail="Expected a fileditchalbums.st album URL.")
    try:
        async with httpx.AsyncClient(timeout=25, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"}) as client:
            response = await client.get(url)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"FileDitch album could not be loaded: {exc}") from exc
    items = _parse_fileditch_album(response.text, str(response.url))
    if not items:
        raise HTTPException(status_code=502, detail="FileDitch album returned no video file links.")
    return [_normalize_item(item, "filester", url) for item in items]


def _normalize_item(item: dict, source_type: str, board_url: str) -> dict:
    source_url = (
        item.get("source_url")
        or item.get("page_url")
        or item.get("detail_url")
        or item.get("url")
        or item.get("stream_url")
        or board_url
    )
    url = item.get("url") or item.get("stream_url") or source_url
    if source_url == board_url and url and url != board_url:
        source_url = url
    thumbnail = item.get("thumbnail") or item.get("thumb") or item.get("thumbnail_path") or ""
    title = item.get("title") or item.get("name") or "Queued..."
    size_bytes = int(item.get("size_bytes") or 0)
    return {
        "title": title,
        "url": url,
        "source_url": source_url,
        "thumbnail": thumbnail,
        "duration": float(item.get("duration") or 0),
        "width": int(item.get("width") or 0),
        "height": int(item.get("height") or 0),
        "source": source_type,
        "warnings": ["source_board", "metadata_limited"],
        "size_bytes": size_bytes,
    }


async def _extract_board_items(source_type: str, url: str) -> list[dict]:
    if source_type == "fileditch_album":
        return await _extract_fileditch_album(url)
    if source_type == "filester":
        extractor = FilesterExtractor()
        return [_normalize_item(item, source_type, url) for item in await extractor.extract_folder(url)]

    if source_type == "gofile":
        extractor = GoFileExtractor()
        return [_normalize_item(item, source_type, url) for item in await extractor.extract_album_entries(url)]

    if source_type == "bunkr":
        extractor = BunkrExtractor()
        return [_normalize_item(item, source_type, url) for item in await extractor.extract_album(url, listing_only=True)]

    if source_type == "pixeldrain":
        extractor = PixeldrainExtractor()
        return [_normalize_item(item, source_type, url) for item in await extractor.extract_album_entries(url)]

    if source_type == "whoreshub":
        items = await _extract_whoreshub_playlist_items(url, 50)
        return [_normalize_item(item, source_type, url) for item in items]

    if source_type == "camwhores":
        return await _extract_camwhores_playlist_items(url)

    if source_type == "pornhub":
        return await _extract_pornhub_board_items(url)

    raise HTTPException(
        status_code=400,
        detail=(
            f"Source type '{source_type}' is not supported for automatic sync. "
            "Supported: Filester, GoFile folders, Bunkr albums, Pixeldrain lists, WhoresHub, Camwhores and Pornhub playlists. "
            "Check the board URL or set a supported source type."
        ),
    )


async def _extract_camwhores_playlist_items(url: str) -> list[dict]:
    """Expand a public Camwhores playlist into its individual watch pages."""
    if not re.match(r"https?://(?:www\.)?camwhores\.tv/playlists/\d+(?:/|[?#]|$)", url or "", re.I):
        raise HTTPException(
            status_code=400,
            detail="Camwhores Source Board needs a public /playlists/<id> URL.",
        )

    # The existing playlist fetcher is synchronous and handles KVS pagination,
    # private entries and relative links. Run it off the event loop and request
    # a window large enough to retain every public entry it discovers.
    from app.camwhores_discovery import fetch_playlist_videos

    try:
        payload = await asyncio.to_thread(
            fetch_playlist_videos,
            url,
            only_public=True,
            batch_size=100_000,
            batch_offset=0,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Camwhores playlist sa nepodarilo načítať: {exc}") from exc

    playlist_id_match = re.search(r"/playlists/(\d+)", url, re.I)
    playlist_id = playlist_id_match.group(1) if playlist_id_match else ""
    items = []
    for video in payload.get("videos") or []:
        watch_url = str(video.get("url") or "").strip()
        if not watch_url:
            continue
        items.append(_normalize_item({
            "url": watch_url,
            "source_url": watch_url,
            "title": video.get("title") or "Camwhores video",
            "thumbnail": video.get("thumbnail") or "",
            "duration": video.get("duration") or 0,
        }, "camwhores", url) | {
            "warnings": ["source_board", "camwhores_playlist", f"playlist:{playlist_id}"] if playlist_id else ["source_board", "camwhores_playlist"],
        })
    if not items:
        raise HTTPException(status_code=502, detail="Camwhores playlist nevrátil žiadne verejné videá; skús Sync Board znova.")
    return items


async def _extract_pornhub_board_items(url: str) -> list[dict]:
    """Expand a public Pornhub playlist via its tokenized chunk API.

    Pornhub's ordinary ``?page=`` URLs often repeat the first page, so Source
    Boards must use the same ``viewChunked`` traversal as the dedicated PH Hub.
    This yields one watch-page candidate per video, never the playlist URL.
    """
    if not re.search(r"/(?:playlist)/\d+(?:[/?#]|$)", url or "", re.I):
        raise HTTPException(
            status_code=400,
            detail="Pornhub Source Board currently needs a public /playlist/<id> URL.",
        )
    try:
        payload = await pornhub_hub.playlist_videos(url, all_pages=True)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Pornhub playlist sa nepodaril načítať: {exc}") from exc

    items = []
    playlist_id = str(payload.get("playlist_id") or "")
    for tile in payload.get("items") or []:
        watch_url = str(tile.get("url") or "").strip()
        if not watch_url:
            continue
        items.append(_normalize_item({
            "url": watch_url,
            "source_url": watch_url,
            "title": tile.get("title") or "Pornhub video",
            "thumbnail": tile.get("thumb") or "",
            "duration": tile.get("duration_sec") or 0,
        }, "pornhub", url) | {
            "warnings": ["source_board", "pornhub_playlist", f"playlist:{playlist_id}"] if playlist_id else ["source_board", "pornhub_playlist"],
        })
    if not items:
        raise HTTPException(status_code=502, detail="Pornhub playlist nevrátil žiadne videá; skús Sync Board znova.")
    return items


async def _extract_whoreshub_playlist_items(url: str, max_pages: int = 50) -> list[dict]:
    import httpx
    from bs4 import BeautifulSoup

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://whoreshub.com/",
    }
    items: list[dict] = []
    seen: set[str] = set()

    def parse_page(html: str, page_url: str) -> list[dict]:
        soup = BeautifulSoup(html or "", "html.parser")
        page_items: list[dict] = []
        local_seen: set[str] = set()

        for link in soup.find_all("a", href=re.compile(r"/videos?/", re.I)):
            href = (link.get("href") or "").strip()
            if not href:
                continue
            video_url = href if href.startswith("http") else urljoin(page_url, href)
            if video_url in seen or video_url in local_seen:
                continue
            local_seen.add(video_url)

            title = (link.get("title") or "").strip()
            img = link.find("img")
            if not title and img:
                title = (img.get("alt") or "").strip()
            if not title:
                title = link.get_text(" ", strip=True)
            if not title:
                slug = video_url.rstrip("/").rsplit("/", 1)[-1]
                title = re.sub(r"[-_]+", " ", slug).strip().title() or "WhoresHub Video"

            thumbnail = ""
            if img:
                thumbnail = (
                    img.get("data-src")
                    or img.get("data-original")
                    or img.get("data-lazy-src")
                    or img.get("data-lazy")
                    or img.get("data-thumb")
                    or img.get("src")
                    or ""
                ).strip()
                if thumbnail.startswith("//"):
                    thumbnail = "https:" + thumbnail
                elif thumbnail and not thumbnail.startswith("http"):
                    thumbnail = urljoin(page_url, thumbnail)

            container = link
            for parent in link.parents:
                classes = " ".join(parent.get("class", [])).lower() if hasattr(parent, "get") else ""
                if any(token in classes for token in ("thumb", "item", "video-card")):
                    container = parent
                    break

            duration = 0
            text = container.get_text(" ", strip=True) if hasattr(container, "get_text") else ""
            match = re.search(r"\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b", text)
            if match:
                left = int(match.group(1))
                mid = int(match.group(2))
                right = match.group(3)
                duration = left * 60 + mid if right is None else left * 3600 + mid * 60 + int(right)

            height = 0
            qmatch = re.search(r"\b(2160|1440|1080|720|480|360)\s*p?\b|4k", text, re.I)
            if qmatch:
                height = 2160 if qmatch.group(0).lower() == "4k" else int(re.search(r"\d+", qmatch.group(0)).group(0))

            page_items.append({
                "url": video_url,
                "source_url": video_url,
                "title": title,
                "thumbnail": thumbnail,
                "duration": duration,
                "height": height,
                "width": int(height * 16 / 9) if height else 0,
            })
        return page_items

    async with httpx.AsyncClient(timeout=20, follow_redirects=True, verify=False, headers=headers) as client:
        for page_num in range(1, max_pages + 1):
            if page_num == 1:
                resp = await client.get(url)
            else:
                resp = await client.get(url, params={
                    "mode": "async",
                    "function": "get_block",
                    "block_id": "playlist_view_playlist_view",
                    "sort_by": "added2fav_date",
                    "from": str(page_num),
                })
            if resp.status_code != 200:
                break

            page_items = parse_page(resp.text, str(resp.url))
            fresh = [item for item in page_items if item["url"] not in seen]
            if page_num > 1 and not fresh:
                break
            for item in fresh:
                seen.add(item["url"])
                items.append(item)

    return items


def _ensure_default_boards(db: Session) -> None:
    existing = db.query(SourceBoard).count()
    if existing:
        return
    for data in DEFAULT_SOURCE_BOARDS:
        db.add(SourceBoard(**data))
    db.commit()


def board_video_ids(db: Session, board: SourceBoard):
    """Resolve board membership from actual job items, without moving videos."""
    batch = board.batch_name or ""
    ids = set()
    if batch:
        ids.update(row[0] for row in db.query(Video.id).filter(Video.batch_name == batch))
    # A job label alone is not an identity.  Legacy Filester jobs also carry
    # the album URL on each item; sync jobs can be identified by their recorded
    # sync time. New sync/add-links jobs carry the explicit board id.
    base_url = (board.source_url or '').split('?', 1)[0].rstrip('/')
    jobs = db.query(ImportJob).filter(ImportJob.batch_name.like('% · job #%')).all()
    for job in jobs:
        explicit = (job.options or {}).get('source_board_id') == board.id
        matching_label = job.batch_name == f'{batch} · job #{job.id}'
        if not explicit and not matching_label:
            continue
        items = db.query(ImportJobItem).filter(ImportJobItem.job_id == job.id)
        source_match = bool(base_url and items.filter(or_(ImportJobItem.source_url == base_url, ImportJobItem.source_url == board.source_url)).first())
        sync_match = bool(board.last_sync_at and job.created_at and 0 <= (board.last_sync_at - job.created_at).total_seconds() < 10)
        if not (explicit or source_match or (matching_label and sync_match)):
            continue
        if source_match and not explicit and not sync_match:
            items = items.filter(or_(ImportJobItem.source_url == base_url, ImportJobItem.source_url == board.source_url))
        for item in items:
            if item.video_id:
                ids.add(item.video_id)
            elif item.status == 'duplicate' and item.url:
                ids.update(row[0] for row in db.query(Video.id).filter(or_(Video.url == item.url, Video.source_url == item.url)))
    return ids


def _board_counts(db: Session, board: SourceBoard) -> tuple[int, float]:
    ids = board_video_ids(db, board)
    if not ids:
        return 0, 0.0
    row = (
        db.query(func.count(Video.id), func.coalesce(func.sum(Video.file_size_mb), 0))
        .filter(Video.id.in_(ids))
        .first()
    )
    return int(row[0] or 0), float(row[1] or 0)


def _serialize_board(board: SourceBoard, db: Session) -> dict:
    count, total_size_mb = _board_counts(db, board)
    source_count = int(board.item_count or 0)
    return {
        "id": board.id,
        "name": board.name,
        "slug": board.slug,
        "source_url": board.source_url,
        "source_type": board.source_type,
        "batch_name": board.batch_name,
        "description": board.description or "",
        "icon": board.icon or "folder_special",
        "color": board.color or "#a855f7",
        "pinned": bool(board.pinned),
        "sort_order": board.sort_order or 0,
        "item_count": count,
        "imported_count": count,
        "source_item_count": source_count,
        "total_size_mb": total_size_mb,
        "last_sync_at": board.last_sync_at.isoformat() if board.last_sync_at else None,
        "created_at": board.created_at.isoformat() if board.created_at else None,
    }


@router.get("/source-boards")
def list_source_boards(db: Session = Depends(get_db)):
    _ensure_default_boards(db)
    boards = (
        db.query(SourceBoard)
        .order_by(SourceBoard.pinned.desc(), SourceBoard.sort_order.asc(), SourceBoard.name.asc())
        .all()
    )
    return {"boards": [_serialize_board(board, db) for board in boards]}


class BulkSourceBoardItem(BaseModel):
    name: str
    source_url: str
    source_type: str = "auto"
    description: str = ""
    icon: str = "folder_special"
    color: str = "#a855f7"


class BulkSourceBoardPayload(BaseModel):
    boards: list[BulkSourceBoardItem]
    auto_sync: bool = False


@router.post("/source-boards/bulk")
def create_source_boards_bulk(payload: BulkSourceBoardPayload, db: Session = Depends(get_db)):
    created = []
    skipped = []
    for item in payload.boards:
        name = (item.name or "").strip()
        source_url = (item.source_url or "").strip()
        if not name or not source_url or not source_url.startswith("http"):
            skipped.append({"name": name, "reason": "invalid"})
            continue
        slug = _slugify(name)
        batch_name = _default_batch_name(name)
        if db.query(SourceBoard).filter((SourceBoard.slug == slug) | (SourceBoard.name == name)).first():
            skipped.append({"name": name, "reason": "duplicate"})
            continue
        board = SourceBoard(
            name=name,
            slug=slug,
            source_url=source_url,
            source_type=_detect_source_type(source_url, item.source_type),
            batch_name=batch_name,
            description=item.description or "",
            icon=item.icon or "folder_special",
            color=item.color or "#a855f7",
            pinned=True,
        )
        db.add(board)
        db.flush()
        db.refresh(board)
        created.append(_serialize_board(board, db))
    db.commit()
    return {"created": created, "skipped": skipped}


@router.post("/source-boards")
def create_source_board(payload: SourceBoardPayload, db: Session = Depends(get_db)):
    name = (payload.name or "").strip()
    source_url = (payload.source_url or "").strip()
    if not name or not source_url:
        raise HTTPException(status_code=400, detail="Board name and source URL are required.")
    if not source_url.startswith("http"):
        raise HTTPException(status_code=400, detail="Source URL must start with http:// or https://")

    slug = _slugify(name)
    batch_name = (payload.batch_name or _default_batch_name(name)).strip()
    if db.query(SourceBoard).filter((SourceBoard.slug == slug) | (SourceBoard.name == name)).first():
        raise HTTPException(status_code=400, detail="A source board with this name already exists.")

    board = SourceBoard(
        name=name,
        slug=slug,
        source_url=source_url,
        source_type=_detect_source_type(source_url, payload.source_type),
        batch_name=batch_name,
        description=payload.description or "",
        icon=payload.icon or "folder_special",
        color=payload.color or "#a855f7",
        pinned=payload.pinned,
    )
    db.add(board)
    db.commit()
    db.refresh(board)
    return {"success": True, "board": _serialize_board(board, db)}


@router.put("/source-boards/{board_id}")
def update_source_board(board_id: int, payload: SourceBoardPayload, db: Session = Depends(get_db)):
    board = db.query(SourceBoard).filter(SourceBoard.id == board_id).first()
    if not board:
        raise HTTPException(status_code=404, detail="Source board not found.")

    new_url = (payload.source_url or board.source_url).strip()
    if not new_url.startswith("http"):
        raise HTTPException(status_code=400, detail="Source URL must start with http:// or https://")

    board.name = (payload.name or board.name).strip()
    board.slug = _slugify(board.name)
    board.source_url = new_url
    board.source_type = _detect_source_type(board.source_url, payload.source_type or board.source_type)
    board.batch_name = (payload.batch_name or board.batch_name or _default_batch_name(board.name)).strip()
    board.description = payload.description or ""
    board.icon = payload.icon or "folder_special"
    board.color = payload.color or "#a855f7"
    board.pinned = payload.pinned
    board.updated_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(board)
    return {"success": True, "board": _serialize_board(board, db)}


@router.delete("/source-boards/{board_id}")
def delete_source_board(board_id: int, db: Session = Depends(get_db)):
    board = db.query(SourceBoard).filter(SourceBoard.id == board_id).first()
    if not board:
        raise HTTPException(status_code=404, detail="Source board not found.")
    db.delete(board)
    db.commit()
    return {"success": True}


@router.post("/source-boards/{board_id}/sync")
async def sync_source_board(board_id: int, db: Session = Depends(get_db)):
    board = db.query(SourceBoard).filter(SourceBoard.id == board_id).first()
    if not board:
        raise HTTPException(status_code=404, detail="Source board not found.")

    raw_url = (board.source_url or "").strip()
    if not raw_url.startswith("http"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Board '{board.name}' has an invalid source URL: '{raw_url}'. "
                "Please edit the board and set a valid https:// URL before syncing."
            ),
        )

    source_type = _detect_source_type(raw_url, board.source_type)
    items = await _extract_board_items(source_type, raw_url)
    if not items:
        raise HTTPException(status_code=400, detail="No items were found in this source folder.")

    # Earlier builds queued a public Pornhub playlist page itself as one video.
    # It cannot be played or refreshed, and would otherwise remain beside the
    # real watch-page candidates after the fixed sync.  Remove only that exact
    # stale placeholder, and only after the playlist read has succeeded.
    removed_invalid_placeholders = 0
    if source_type == "pornhub" and re.search(r"/playlist/\d+(?:[/?#]|$)", raw_url, re.I):
        stale_rows = (
            db.query(Video)
            .filter(Video.batch_name == (board.batch_name or _default_batch_name(board.name)))
            .filter(Video.url == raw_url)
            .filter(Video.source_url == raw_url)
            .all()
        )
        for stale in stale_rows:
            db.delete(stale)
            removed_invalid_placeholders += 1

    candidates = [
        IntakeCandidate(
            title=item.get("title") or "Queued...",
            url=item.get("url") or "",
            source_url=item.get("source_url") or item.get("url") or board.source_url,
            thumbnail=item.get("thumbnail") or "",
            duration=item.get("duration") or 0,
            width=item.get("width") or 0,
            height=item.get("height") or 0,
            source=source_type,
            confidence=0.92,
            warnings=item.get("warnings") or ["source_board", "metadata_limited"],
        )
        for item in items
        if item.get("url")
    ]
    if not candidates:
        raise HTTPException(status_code=400, detail="The folder was read, but no importable URLs were found.")

    # Large folders (bulk file-host dumps, etc.) would otherwise resolve every
    # item's direct URL/thumbnail one by one on sync — for hundreds of files
    # that can take a long time and hammer the source domain. Past a threshold,
    # do a fast shell-only import instead (title/thumbnail/size from the
    # listing only) and leave per-video resolve to an on-demand refetch.
    #
    # A Pornhub watch page is not a playable media URL.  Shell-only Pornhub
    # rows therefore remain pending until a restart, whose orphan recovery
    # correctly turns them into retryable errors.  Resolve them through Intake
    # from the start, regardless of playlist length.
    auto_metadata = not _should_use_shell_only(source_type, len(candidates))

    request = IntakeImportRequest(
        candidates=candidates,
        batch_name=board.batch_name or _default_batch_name(board.name),
        source_mode=source_type,
        auto_metadata=auto_metadata,
        playwright_fallback=True,
    )
    job = create_import_job(request, db)
    job.options = {**(job.options or {}), "source_board_id": board.id}
    board.last_sync_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    board.source_type = source_type
    board.item_count = len(candidates)
    board.updated_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    db.commit()
    intake_worker.start()
    return {
        "success": True,
        "board": _serialize_board(board, db),
        "found": len(candidates),
        "shell_only": not auto_metadata,
        "removed_invalid_placeholders": removed_invalid_placeholders,
        "job": serialize_job(job),
    }


@router.post("/source-boards/{board_id}/add-links")
async def add_links_to_source_board(board_id: int, payload: SourceBoardLinksPayload, db: Session = Depends(get_db)):
    board = db.query(SourceBoard).filter(SourceBoard.id == board_id).first()
    if not board:
        raise HTTPException(status_code=404, detail="Source board not found.")
    candidates: list[IntakeCandidate] = []
    seen: set[str] = set()
    for raw in payload.urls:
        url = raw.strip()
        if urlparse(url).scheme not in {"http", "https"} or not urlparse(url).hostname:
            raise HTTPException(status_code=400, detail=f"Invalid URL: {url}")
        if _is_fileditch_album(url):
            items = await _extract_fileditch_album(url)
        else:
            items = [{"url": url, "source_url": url, "title": "Queued...", "source": _detect_source_type(url)}]
        for item in items:
            item_url = item["url"]
            if item_url in seen:
                continue
            seen.add(item_url)
            candidates.append(IntakeCandidate(
                title=item.get("title") or "Queued...", url=item_url,
                source_url=item.get("source_url") or item_url,
                thumbnail=item.get("thumbnail") or "", source=item.get("source") or _detect_source_type(item_url),
                warnings=item.get("warnings") or ["source_board"],
            ))
    if not candidates:
        raise HTTPException(status_code=400, detail="No importable video links found.")
    request = IntakeImportRequest(candidates=candidates, batch_name=board.batch_name or _default_batch_name(board.name),
                                  source_mode="mixed", auto_metadata=True, playwright_fallback=True)
    job = create_import_job(request, db)
    job.options = {**(job.options or {}), "source_board_id": board.id}
    db.commit()
    intake_worker.start()
    return {"success": True, "found": len(candidates), "job": serialize_job(job)}


# --------------------------------------------------------------------------- #
# Filester cookie auto-refresh — pushed by the Nexus_Gallery browser extension
# (background.js's chrome.cookies.getAll on a timer + on-change listener),
# same pattern as /api/v1/faphouse/cookies/sync but writing the single-cookie
# Netscape file app/extractors/filester.py's cookie search already reads.
# --------------------------------------------------------------------------- #

class FilesterCookieRow(BaseModel):
    name: str
    value: str
    domain: str = ""
    path: str = "/"
    secure: bool = False
    expirationDate: Optional[float] = None


class FilesterCookieSyncPayload(BaseModel):
    cookies: list[FilesterCookieRow] = []


@router.post("/filester/cookies/sync")
async def sync_filester_cookies(payload: FilesterCookieSyncPayload):
    """Extension push: keeps filester.me_cookies.txt current without a manual
    DevTools export. Silently accepts an empty/partial batch (returns
    success=False rather than an error) so a transient extension glitch can't
    break the sync loop — the next timer tick just tries again."""
    from app.filester_cookie_sync import write_filester_cookies

    rows = [row.model_dump() for row in payload.cookies]
    result = await write_filester_cookies(rows)
    return result


@router.post("/fileditch/cookies/sync")
async def sync_fileditch_cookies(payload: FilesterCookieSyncPayload):
    """Persist FileDitch/Cloudflare cookies for the browser-backed extractor."""
    from app.filester_cookie_sync import write_fileditch_cookies

    rows = [row.model_dump() for row in payload.cookies]
    return write_fileditch_cookies(rows)


@router.get("/filester/cookies/status")
async def filester_cookies_status(check_signed_in: bool = False):
    """What the extractor actually sees right now — poll this instead of
    guessing from file-manager timestamps or waiting for the next sync to
    fail. `check_signed_in=true` adds one live request to Filester so it
    costs a network round-trip only when explicitly asked for."""
    cookie_file = resolve_cookiefile("filester.me_cookies.txt", "app/filester.me_cookies.txt")
    mtime = cookiejar_mtime(cookie_file)
    out = {
        "cookie_file": cookie_file,
        "cookie_present": bool(cookie_file),
        "cookie_mtime": mtime,
        "age_seconds": (time.time() - mtime) if mtime else None,
    }
    if check_signed_in and cookie_file:
        from app.filester_cookie_sync import _looks_signed_in

        out["signed_in"] = await _looks_signed_in(build_cookie_header(cookie_file))
    return out
