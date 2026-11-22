from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.download_manager import (
    MAX_CONNECTIONS_PER_FILE,
    DownloadManagerError,
    download_manager,
)


router = APIRouter(prefix="/api/downloads", tags=["downloads"])


class DownloadItem(BaseModel):
    url: str
    filename: str | None = None
    title: str | None = None
    video_id: int | None = None
    source: str | None = None
    referer: str | None = None


class StartDownloadsRequest(BaseModel):
    urls: list[str | DownloadItem] = Field(default_factory=list)
    url: str | None = None


class DownloadSettingsRequest(BaseModel):
    max_concurrent_downloads: int = Field(ge=1)
    connections_per_file: int = Field(ge=1, le=MAX_CONNECTIONS_PER_FILE)
    download_path: str
    auto_clear_completed: bool = False


def _manager_error(exc: Exception) -> HTTPException:
    logging.warning("Download manager operation failed: %s", exc)
    if "gid not found" in str(exc).lower():
        return HTTPException(status_code=404, detail="Download not found")
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=str(exc))
    if isinstance(exc, KeyError):
        return HTTPException(status_code=404, detail="Download not found")
    return HTTPException(status_code=503, detail=str(exc))


@router.post("/start")
async def start_downloads(
    request: StartDownloadsRequest | list[str | DownloadItem],
) -> dict[str, Any]:
    items = request if isinstance(request, list) else request.urls
    if not items and isinstance(request, StartDownloadsRequest) and request.url:
        items = [request.url]
    if not items:
        raise HTTPException(status_code=422, detail="Provide at least one URL")
    added = []
    errors = []
    for item in items:
        value = item if isinstance(item, DownloadItem) else DownloadItem(url=item)
        try:
            added.append(await download_manager.add_url(
                value.url,
                filename=value.filename,
                title=value.title,
                video_id=value.video_id,
                source=value.source,
                referer=value.referer,
            ))
        except ValueError as exc:
            errors.append({"url": value.url, "error": str(exc)})
        except (DownloadManagerError, OSError) as exc:
            if not added:
                raise _manager_error(exc) from exc
            errors.append({"url": value.url, "error": str(exc)})
            break
    if not added:
        raise HTTPException(status_code=400, detail={"message": "No downloads were queued", "errors": errors})
    return {"status": "download_queued", "added": added, "errors": errors}


@router.get("/status")
async def download_status() -> dict[str, Any]:
    try:
        return await download_manager.status()
    except (DownloadManagerError, OSError, ValueError) as exc:
        raise _manager_error(exc) from exc


@router.post("/pause/{gid}")
async def pause_download(gid: str) -> dict[str, str]:
    try:
        await download_manager.pause(gid)
        return {"status": "paused", "gid": gid}
    except (DownloadManagerError, OSError, ValueError) as exc:
        raise _manager_error(exc) from exc


@router.post("/resume/{gid}")
async def resume_download(gid: str) -> dict[str, str]:
    try:
        await download_manager.resume(gid)
        return {"status": "active", "gid": gid}
    except (DownloadManagerError, OSError) as exc:
        raise _manager_error(exc) from exc


@router.post("/cancel/{gid}")
async def cancel_download(gid: str) -> dict[str, str]:
    try:
        await download_manager.cancel(gid)
        return {"status": "cancelled", "gid": gid}
    except (DownloadManagerError, OSError, ValueError) as exc:
        raise _manager_error(exc) from exc


@router.post("/remove/{gid}")
async def remove_download(gid: str) -> dict[str, str]:
    try:
        await download_manager.remove(gid)
        return {"status": "removed", "gid": gid}
    except (DownloadManagerError, OSError) as exc:
        raise _manager_error(exc) from exc


@router.post("/retry/{gid}")
async def retry_download(gid: str) -> dict[str, Any]:
    try:
        return {"status": "download_queued", **await download_manager.retry(gid)}
    except (DownloadManagerError, OSError, ValueError, KeyError) as exc:
        raise _manager_error(exc) from exc


@router.get("/settings")
async def get_download_settings() -> dict[str, Any]:
    return await download_manager.get_settings()


@router.post("/settings")
async def save_download_settings(request: DownloadSettingsRequest) -> dict[str, Any]:
    try:
        settings = await download_manager.update_settings(request.model_dump())
        return {"status": "saved", **settings}
    except (DownloadManagerError, OSError, ValueError) as exc:
        raise _manager_error(exc) from exc


@router.get("/open-folder")
async def open_download_folder() -> dict[str, str]:
    try:
        folder = await download_manager.open_folder()
        return {"status": "opened", "path": folder}
    except (DownloadManagerError, OSError) as exc:
        raise _manager_error(exc) from exc
