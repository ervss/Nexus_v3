"""qBittorrent Web API client.

Sequential download plus first/last piece priority is what makes a growing
file playable: the container header (often the last piece of an MP4) and the
opening seconds arrive before the middle of the file.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from typing import Any
from urllib.parse import urljoin

import httpx

from .bencode import torrent_infohash
from .files import has_archive, pick_video_file, resolve_video_path, stream_mode
from .settings import TorrentSettings, load_settings

logger = logging.getLogger("nexus.torrent")

STREAM_MIN_BYTES = 1_500_000
_tasks: set[asyncio.Task] = set()


def parse_add_response(status_code: int, body: str) -> tuple[bool, list[str]]:
    """qBittorrent 4 returns ``Ok.`` qBittorrent 5 returns JSON, including pending adds."""
    text = (body or "").strip()
    try:
        import json
        payload = json.loads(text) if text.startswith("{") else None
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        ids = [str(item).lower() for item in payload.get("added_torrent_ids") or [] if item]
        try:
            pending = int(payload.get("pending_count") or 0)
            success = int(payload.get("success_count") or 0)
            failure = int(payload.get("failure_count") or 0)
        except (TypeError, ValueError):
            pending = success = failure = 0
        accepted = status_code < 400 and (bool(ids) or pending > 0 or success > 0) and not (failure and not ids and pending == 0)
        return accepted, ids
    lowered = text.lower()
    if status_code >= 400 or lowered.startswith("fails"):
        return False, []
    return status_code < 400, []


class QbitError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message = message
        self.status = status


class QbitClient:
    def __init__(self, settings: TorrentSettings):
        self.settings = settings
        self._login_lock = asyncio.Lock()
        self._client = httpx.AsyncClient(
            base_url=settings.qbit_url,
            timeout=httpx.Timeout(connect=3.0, read=20.0, write=20.0, pool=5.0),
            follow_redirects=False,
            headers={"Referer": settings.qbit_url + "/"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def login(self) -> None:
        async with self._login_lock:
            response = await self._client.post(
                "/api/v2/auth/login",
                data={"username": self.settings.qbit_user, "password": self.settings.qbit_pass},
            )
            if response.status_code >= 400 or response.text.strip().lower().startswith("fails"):
                raise QbitError("qBittorrent rejected the username or password", 502)
            logger.info("qBittorrent login ok")

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise QbitError("qBittorrent timed out", 504) from exc
        except httpx.HTTPError as exc:
            raise QbitError("qBittorrent is not reachable", 503) from exc
        if response.status_code in {401, 403}:
            await self.login()
            try:
                response = await self._client.request(method, path, **kwargs)
            except httpx.HTTPError as exc:
                raise QbitError("qBittorrent is not reachable", 503) from exc
        if response.status_code in {401, 403}:
            raise QbitError("qBittorrent rejected the session", 502)
        return response

    async def version(self) -> str | None:
        response = await self._request("GET", "/api/v2/app/version")
        if response.status_code >= 400:
            return None
        return response.text.strip() or None

    async def ensure_category(self) -> None:
        response = await self._request(
            "POST",
            "/api/v2/torrents/createCategory",
            data={"category": "nexus"},
        )
        if response.status_code not in {200, 409}:
            logger.info("qBittorrent category create returned HTTP %s", response.status_code)

    async def _download_torrent(self, url: str) -> bytes:
        from .normalize import acceptable_download_url

        bases = [self.settings.jackett_url, self.settings.prowlarr_url]
        if not acceptable_download_url(url, [base for base in bases if base]):
            raise QbitError("Indexer download link is not allowed", 400)
        current = url
        async with httpx.AsyncClient(follow_redirects=False, timeout=httpx.Timeout(20.0)) as client:
            for _ in range(4):
                try:
                    response = await client.get(current)
                except httpx.HTTPError as exc:
                    raise QbitError("Could not download the .torrent file", 502) from exc
                if response.status_code in {301, 302, 303, 307, 308}:
                    current = urljoin(current, response.headers.get("location") or "")
                    if not acceptable_download_url(current, [base for base in bases if base]):
                        raise QbitError("Torrent download redirected to a blocked address", 502)
                    continue
                if response.status_code >= 400:
                    raise QbitError(f"Indexer returned HTTP {response.status_code} for the .torrent", 502)
                blob = response.content
                if len(blob) > 2_000_000 or not blob.startswith(b"d"):
                    raise QbitError("Indexer did not return a torrent file", 502)
                return blob
        raise QbitError("Could not download the .torrent file", 502)

    async def add(self, source: str) -> str:
        """Add a magnet or indexer .torrent. Returns the infohash for the dashboard player."""
        from .normalize import infohash_from_magnet

        tag = "nx" + secrets.token_hex(4)
        torrent_bytes = b""
        if source.startswith("magnet:"):
            known = infohash_from_magnet(source)
        elif source.startswith(("http://", "https://")):
            torrent_bytes = await self._download_torrent(source)
            known = torrent_infohash(torrent_bytes)
        else:
            raise QbitError("Magnet link is not valid", 400)
        await self.ensure_category()
        form = {
            "category": "nexus",
            "tags": f"nexus,{tag}",
            "stopped": "false",
            "sequentialDownload": "true",
            "firstLastPiecePrio": "true",
        }
        if torrent_bytes:
            response = await self._request(
                "POST",
                "/api/v2/torrents/add",
                data=form,
                files={"torrents": ("nexus.torrent", torrent_bytes, "application/x-bittorrent")},
            )
        else:
            response = await self._request("POST", "/api/v2/torrents/add", data={"urls": source, **form})
        accepted, ids = parse_add_response(response.status_code, response.text)
        digest = ids[0] if ids else known
        if not accepted and not ids and known and await self._wait_until_listed(known):
            digest = known
            accepted = True
        if digest and accepted:
            await self._wait_until_listed(digest)
        elif accepted:
            digest = await self._hash_for_tag(tag)
        if not digest or not accepted:
            logger.info("qBittorrent add rejected status=%s", response.status_code)
            raise QbitError("qBittorrent did not accept the torrent", 502)
        logger.info("qBittorrent add hash=%s", digest)
        _spawn(self.prepare_stream(digest))
        return digest

    async def _wait_until_listed(self, infohash: str) -> bool:
        for _ in range(12):
            try:
                if await self.info(infohash):
                    return True
            except QbitError:
                return False
            await asyncio.sleep(0.4)
        return False

    async def _hash_for_tag(self, tag: str) -> str:
        for _ in range(20):
            response = await self._request("GET", "/api/v2/torrents/info", params={"tag": tag})
            if response.status_code < 400:
                try:
                    payload = response.json()
                except ValueError:
                    payload = []
                if isinstance(payload, list) and payload:
                    digest = str(payload[0].get("hash") or "")
                    if digest:
                        return digest.lower()
            await asyncio.sleep(0.4)
        return ""

    async def info(self, infohash: str) -> dict[str, Any] | None:
        response = await self._request("GET", "/api/v2/torrents/info", params={"hashes": infohash})
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise QbitError(f"qBittorrent status returned HTTP {response.status_code}", 502)
        try:
            payload = response.json()
        except ValueError as exc:
            raise QbitError("qBittorrent status was not JSON", 502) from exc
        if not isinstance(payload, list) or not payload:
            return None
        return payload[0]

    async def piece_states(self, infohash: str) -> list[int]:
        response = await self._request("GET", "/api/v2/torrents/pieceStates", params={"hash": infohash})
        if response.status_code >= 400:
            return []
        try:
            payload = response.json()
        except ValueError:
            return []
        if not isinstance(payload, list):
            return []
        return [int(item) for item in payload]

    async def playback(self, infohash: str) -> dict[str, Any]:
        from .files import file_byte_offset

        info = await self.info(infohash)
        if info is None:
            raise QbitError("Torrent is not in qBittorrent", 404)
        listing = await self.files(infohash)
        video = pick_video_file(listing)
        file_name = str(video.get("name") or "") if video else ""
        path = resolve_video_path(
            str(info.get("save_path") or ""),
            str(info.get("content_path") or ""),
            file_name,
        ) if file_name else None
        piece_size = 0
        props = await self._request("GET", "/api/v2/torrents/properties", params={"hash": infohash})
        if props.status_code < 400:
            try:
                piece_size = int(props.json().get("piece_size") or 0)
            except (ValueError, AttributeError):
                piece_size = 0
        return {
            "path": path,
            "name": file_name,
            "mode": stream_mode(file_name) if file_name else "",
            "final_size": int(video.get("size") or 0) if video else 0,
            "piece_size": piece_size,
            "states": await self.piece_states(infohash),
            "file_offset": file_byte_offset(listing, video) if video else 0,
        }

    async def files(self, infohash: str) -> list[dict[str, Any]]:
        response = await self._request("GET", "/api/v2/torrents/files", params={"hash": infohash})
        if response.status_code >= 400:
            return []
        try:
            payload = response.json()
        except ValueError:
            return []
        return payload if isinstance(payload, list) else []

    async def _post_optional(self, path: str, data: dict[str, str]) -> bool:
        response = await self._request("POST", path, data=data)
        if response.status_code == 404:
            return False
        if response.status_code >= 400:
            logger.info("qBittorrent %s returned HTTP %s", path, response.status_code)
            return False
        return True

    async def ensure_flags(self, infohash: str, info: dict[str, Any]) -> None:
        if not info.get("seq_dl"):
            enabled = await self._post_optional(
                "/api/v2/torrents/setSequentialDownload",
                {"hashes": infohash, "value": "true"},
            )
            if not enabled:
                await self._post_optional("/api/v2/torrents/toggleSequentialDownload", {"hashes": infohash})
        if not info.get("f_l_piece_prio"):
            enabled = await self._post_optional(
                "/api/v2/torrents/setFirstLastPiecePriority",
                {"hashes": infohash, "value": "true"},
            )
            if not enabled:
                await self._post_optional("/api/v2/torrents/toggleFirstLastPiecePrio", {"hashes": infohash})

    async def prioritize(self, infohash: str, files: list[dict[str, Any]]) -> None:
        chosen = pick_video_file(files)
        if chosen is None or len(files) > 400:
            if len(files) > 400:
                logger.info("skip file priority for %s (%s files)", infohash, len(files))
            return

        def file_id(item: dict[str, Any], fallback: int) -> str:
            if item.get("index") is not None:
                return str(item["index"])
            if item.get("id") is not None:
                return str(item["id"])
            return str(fallback)

        ids: list[str] = []
        priorities: list[str] = []
        for fallback, item in enumerate(files):
            ids.append(file_id(item, fallback))
            priorities.append("7" if item is chosen else "0")
        await self._post_optional(
            "/api/v2/torrents/filePrio",
            {"hash": infohash, "id": "|".join(ids), "priority": "|".join(priorities)},
        )

    async def prepare_stream(self, infohash: str) -> None:
        try:
            for _ in range(16):
                info = await self.info(infohash)
                if not info:
                    await asyncio.sleep(0.5)
                    continue
                await self.ensure_flags(infohash, info)
                listing = await self.files(infohash)
                if listing:
                    await self.prioritize(infohash, listing)
                    logger.info("stream prep ready hash=%s files=%s", infohash, len(listing))
                    return
                await asyncio.sleep(0.6)
            logger.info("stream prep gave up waiting for metadata hash=%s", infohash)
        except Exception:
            logger.exception("stream prep failed hash=%s", infohash)

    async def status(self, infohash: str) -> dict[str, Any]:
        info = await self.info(infohash)
        if info is None:
            raise QbitError("Torrent is not in qBittorrent", 404)
        listing = await self.files(infohash)
        video = pick_video_file(listing)
        file_name = str(video.get("name") or "") if video else ""
        path = resolve_video_path(
            str(info.get("save_path") or ""),
            str(info.get("content_path") or ""),
            file_name,
        ) if file_name else None
        file_progress = float(video.get("progress") or 0) if video else 0.0
        on_disk = path.stat().st_size if path else 0
        progress = float(info.get("progress") or 0)
        state = str(info.get("state") or "unknown")
        ready = bool(
            path
            and (
                on_disk >= STREAM_MIN_BYTES
                or (file_progress >= 0.005 and on_disk >= 512 * 1024)
            )
        )
        eta = info.get("eta")
        eta_value = int(eta) if isinstance(eta, (int, float)) and int(eta) < 8_640_000 else None
        return {
            "hash": infohash,
            "name": info.get("name") or file_name or infohash,
            "state": state,
            "progress": round(progress, 4),
            "progress_pct": round(progress * 100, 2),
            "speed": int(info.get("dlspeed") or 0),
            "eta": eta_value,
            "downloaded": int(info.get("downloaded") or info.get("completed") or 0),
            "size": int(info.get("size") or info.get("total_size") or 0),
            "file": file_name,
            "file_progress": round(file_progress, 4),
            "on_disk": on_disk,
            "stream_ready": ready,
            "stream_mode": stream_mode(file_name) if file_name else "",
            "stream_url": f"/api/torrent/stream?hash={infohash}" if ready else "",
            "archive": has_archive(listing) and video is None,
            "sequential": bool(info.get("seq_dl")),
            "edges_first": bool(info.get("f_l_piece_prio")),
        }


_client: QbitClient | None = None
_client_key: tuple[str, str, str] | None = None


def get_client() -> QbitClient:
    global _client, _client_key
    settings = load_settings()
    if not settings.qbit_configured:
        raise QbitError("Set QBIT_URL and QBIT_USER in .env", 503)
    key = (settings.qbit_url, settings.qbit_user, settings.qbit_pass)
    if _client is None or _client_key != key:
        _client = QbitClient(settings)
        _client_key = key
    return _client


def _spawn(coro: Any) -> None:
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
