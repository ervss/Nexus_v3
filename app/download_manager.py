from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any

import httpx

from app.url_safety import require_public_http_url


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_DOWNLOAD_DIR = ROOT_DIR / "data" / "downloads"
DEFAULT_STATE_DIR = ROOT_DIR / "data" / "download-manager"
MAX_CONNECTIONS_PER_FILE = 16
SETTING_DEFAULTS: dict[str, Any] = {
    "max_concurrent_downloads": 5,
    "connections_per_file": MAX_CONNECTIONS_PER_FILE,
    "download_path": str(DEFAULT_DOWNLOAD_DIR),
    "auto_clear_completed": False,
}
ARIA2_STATUS_KEYS = ["gid", "status", "totalLength", "completedLength", "downloadSpeed",
                     "connections", "errorCode", "errorMessage", "files", "numSeeders"]


class DownloadManagerError(RuntimeError):
    """An aria2 JSON-RPC or download-manager operation failed."""


class Aria2TransportError(DownloadManagerError):
    """aria2's local RPC service is not currently reachable."""


def sanitize_filename(value: str) -> str:
    name = Path(str(value or "").replace("\\", "/")).name
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    if not name or name in {".", ".."}:
        raise ValueError("Filename must contain at least one valid character")
    return name[:240]


def _integer(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


class Aria2DownloadManager:
    def __init__(self, state_dir: Path | None = None) -> None:
        self.state_dir = Path(state_dir or DEFAULT_STATE_DIR).resolve()
        self.settings_path = self.state_dir / "manager_settings.json"
        self.token_path = self.state_dir / "aria2_rpc.token"
        self.session_path = self.state_dir / "aria2.session"
        self.metadata_path = self.state_dir / "download_metadata.json"
        self.rpc_url = os.getenv("ARIA2_RPC_URL", "http://127.0.0.1:6800/jsonrpc")
        self.executable = os.getenv("ARIA2C_PATH", "").strip()
        self._client: httpx.AsyncClient | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._start_lock = asyncio.Lock()
        self._file_lock = asyncio.Lock()
        self._completed_seen: dict[str, float] = {}
        self._auto_clear_task: asyncio.Task[None] | None = None
        self._settings = self._load_settings()
        self._metadata = self._load_metadata()
        self._token: str | None = None

    def _load_settings(self) -> dict[str, Any]:
        if not self.settings_path.exists():
            return dict(SETTING_DEFAULTS)
        try:
            data = json.loads(self.settings_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise DownloadManagerError(f"Could not read download settings: {exc}") from exc
        if not isinstance(data, dict):
            raise DownloadManagerError("Download settings must be a JSON object")
        settings = {**SETTING_DEFAULTS, **data}
        try:
            settings["max_concurrent_downloads"] = int(settings["max_concurrent_downloads"])
            settings["connections_per_file"] = int(settings["connections_per_file"])
            settings["download_path"] = str(Path(settings["download_path"]).expanduser().resolve())
            settings["auto_clear_completed"] = bool(settings["auto_clear_completed"])
        except (TypeError, ValueError, OSError) as exc:
            raise DownloadManagerError(f"Download settings contain invalid values: {exc}") from exc
        if settings["max_concurrent_downloads"] < 1:
            raise DownloadManagerError("Max concurrent downloads must be at least 1")
        if settings["connections_per_file"] > MAX_CONNECTIONS_PER_FILE:
            settings["connections_per_file"] = MAX_CONNECTIONS_PER_FILE
            try:
                self._write_json(self.settings_path, settings)
            except OSError as exc:
                raise DownloadManagerError(f"Could not update download settings: {exc}") from exc
        if not 1 <= settings["connections_per_file"] <= MAX_CONNECTIONS_PER_FILE:
            raise DownloadManagerError(
                f"Connections per file must be between 1 and {MAX_CONNECTIONS_PER_FILE}"
            )
        return settings

    def _load_metadata(self) -> dict[str, dict[str, Any]]:
        if not self.metadata_path.exists():
            return {}
        try:
            data = json.loads(self.metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise DownloadManagerError(f"Could not read download metadata: {exc}") from exc
        if not isinstance(data, dict):
            raise DownloadManagerError("Download metadata must be a JSON object")
        return {str(gid): value for gid, value in data.items() if isinstance(value, dict)}

    def _write_json(self, path: Path, data: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)

    async def get_settings(self) -> dict[str, Any]:
        return dict(self._settings)

    async def update_settings(self, values: dict[str, Any]) -> dict[str, Any]:
        updated = {**self._settings, **values}
        if not str(updated.get("download_path") or "").strip():
            raise ValueError("Downloads folder cannot be empty")
        try:
            updated["max_concurrent_downloads"] = int(updated["max_concurrent_downloads"])
            updated["connections_per_file"] = int(updated["connections_per_file"])
            updated["download_path"] = str(Path(updated["download_path"]).expanduser().resolve())
        except (TypeError, ValueError, OSError) as exc:
            raise ValueError(f"Invalid download settings: {exc}") from exc
        if updated["max_concurrent_downloads"] < 1:
            raise ValueError("Max concurrent downloads must be at least 1")
        if not 1 <= updated["connections_per_file"] <= MAX_CONNECTIONS_PER_FILE:
            raise ValueError(
                f"Connections per file must be between 1 and {MAX_CONNECTIONS_PER_FILE}"
            )
        updated["auto_clear_completed"] = bool(updated["auto_clear_completed"])
        if self._client is not None:
            await self.ensure_started()
            await self._rpc("changeGlobalOption", {
                "max-concurrent-downloads": str(updated["max_concurrent_downloads"]),
            })
        try:
            Path(updated["download_path"]).mkdir(parents=True, exist_ok=True)
            self._write_json(self.settings_path, updated)
        except OSError as exc:
            raise DownloadManagerError(f"Could not save download settings: {exc}") from exc

        self._settings = updated
        return dict(updated)

    def _load_rpc_token(self) -> str:
        if self._token:
            return self._token
        try:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            if self.token_path.exists():
                token = self.token_path.read_text(encoding="utf-8").strip()
            else:
                token = secrets.token_urlsafe(32)
                self.token_path.write_text(token, encoding="utf-8")
        except OSError as exc:
            raise DownloadManagerError(f"Could not initialize aria2 RPC credentials: {exc}") from exc
        if not token:
            raise DownloadManagerError("aria2 RPC credential file is empty")
        self._token = token
        return token

    async def _rpc(self, method: str, *args: Any) -> Any:
        if self._client is None:
            raise DownloadManagerError("aria2 RPC client is not initialized")
        try:
            response = await self._client.post(
                self.rpc_url,
                json={
                    "jsonrpc": "2.0",
                    "id": "nexus-download-manager",
                    "method": f"aria2.{method}",
                    "params": [f"token:{self._load_rpc_token()}", *args],
                },
            )
        except httpx.RequestError as exc:
            raise Aria2TransportError(f"aria2 RPC transport failed: {exc}") from exc
        try:
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPStatusError, ValueError) as exc:
            raise DownloadManagerError(f"aria2 {method} returned an invalid RPC response: {exc}") from exc
        if "error" in payload:
            error = payload["error"]
            raise DownloadManagerError(
                f"aria2 {method} failed ({error.get('code', 'unknown')}): "
                f"{error.get('message', 'unknown RPC error')}"
            )
        if "result" not in payload:
            raise DownloadManagerError(f"aria2 {method} returned an invalid RPC response")
        return payload["result"]

    def _find_executable(self) -> str:
        candidates = [self.executable] if self.executable else []
        candidates.extend([
            str(ROOT_DIR / "aria2c.exe"),
            str(ROOT_DIR / "app" / "aria2c.exe"),
            shutil.which("aria2c") or "",
            shutil.which("aria2c.exe") or "",
        ])
        for candidate in candidates:
            if candidate and (Path(candidate).is_file() or shutil.which(candidate)):
                return candidate
        raise DownloadManagerError(
            "aria2c was not found. Install aria2 and add aria2c to PATH, "
            "or set ARIA2C_PATH to its executable."
        )

    async def ensure_started(self) -> None:
        try:
            parsed_rpc = urllib.parse.urlsplit(self.rpc_url)
            rpc_port = parsed_rpc.port or 6800
        except ValueError as exc:
            raise DownloadManagerError(f"Invalid ARIA2_RPC_URL: {exc}") from exc
        if parsed_rpc.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise DownloadManagerError("aria2 RPC must listen on localhost")
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(4.0), trust_env=False)
        async with self._start_lock:
            try:
                await self._rpc("getVersion")
                self._start_auto_clear_monitor()
                return
            except Aria2TransportError:
                pass

            executable = self._find_executable()
            settings = self._settings
            download_path = Path(settings["download_path"])
            download_path.mkdir(parents=True, exist_ok=True)
            self.state_dir.mkdir(parents=True, exist_ok=True)
            self.session_path.touch(exist_ok=True)


            connections = int(settings["connections_per_file"])
            user_agent = (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            )
            command = [
                executable,
                "--no-conf=true",
                "--all-proxy=",
                "--enable-rpc=true",
                "--rpc-listen-all=false",
                f"--rpc-listen-port={rpc_port}",
                f"--rpc-secret={self._load_rpc_token()}",
                f"--dir={download_path}",
                f"--input-file={self.session_path}",
                f"--save-session={self.session_path}",
                "--save-session-interval=60",
                "--continue=true",
                "--check-integrity=true",
                "--file-allocation=none",
                f"--user-agent={user_agent}",
                f"--max-concurrent-downloads={settings['max_concurrent_downloads']}",
                f"--max-connection-per-server={connections}",
                f"--split={connections}",
                "--min-split-size=1M",
                "--console-log-level=warn",
            ]
            creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            try:
                self._process = subprocess.Popen(
                    command,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=creationflags,
                )
            except OSError as exc:
                raise DownloadManagerError(f"Could not start aria2c: {exc}") from exc

            last_error: Exception | None = None
            for _ in range(40):
                if self._process.poll() is not None:
                    raise DownloadManagerError(
                        f"aria2c exited during startup with code {self._process.returncode}"
                    )
                try:
                    await self._rpc("getVersion")
                    logging.info("aria2 RPC manager is ready on %s", self.rpc_url)
                    self._start_auto_clear_monitor()
                    return
                except DownloadManagerError as exc:
                    last_error = exc
                    await asyncio.sleep(0.1)
            raise DownloadManagerError(f"aria2c did not become ready: {last_error}")

    def _start_auto_clear_monitor(self) -> None:
        if self._auto_clear_task is None or self._auto_clear_task.done():
            self._auto_clear_task = asyncio.create_task(
                self._auto_clear_completed(),
                name="aria2-auto-clear-completed",
            )

    async def _auto_clear_completed(self) -> None:
        while True:
            try:
                tasks = await self._all_tasks()
                await self._snapshot_finished(tasks)
                if self._settings["auto_clear_completed"]:
                    now = time.monotonic()
                    task_ids = {str(task.get("gid") or "") for task in tasks}
                    self._completed_seen = {
                        gid: first_seen for gid, first_seen in self._completed_seen.items()
                        if gid in task_ids
                    }
                    for task in tasks:
                        gid = str(task.get("gid") or "")
                        if task.get("status") != "complete":
                            continue
                        first_seen = self._completed_seen.setdefault(gid, now)
                        if now - first_seen >= 10:
                            await self.remove(gid)
                            self._completed_seen.pop(gid, None)
            except (DownloadManagerError, OSError) as exc:
                logging.warning("aria2 completed-download cleanup failed: %s", exc)
            await asyncio.sleep(1)

    async def _snapshot_finished(self, records: list[dict[str, Any]]) -> None:
        updated = False
        async with self._file_lock:
            for record in records:
                gid = str(record.get("gid") or "")
                metadata = self._metadata.get(gid)
                if not metadata or record.get("status") not in {"complete", "error"}:
                    continue
                snapshot = self._serialize_task(record, metadata)
                if metadata.get("snapshot") != snapshot:
                    metadata["snapshot"] = snapshot
                    updated = True
            if updated:
                try:
                    self._write_json(self.metadata_path, self._metadata)
                except OSError as exc:
                    logging.error("Could not persist completed aria2 tasks: %s", exc)

    async def close(self) -> None:
        if self._auto_clear_task is not None:
            self._auto_clear_task.cancel()
            try:
                await self._auto_clear_task
            except asyncio.CancelledError:
                pass
            self._auto_clear_task = None
        if self._client is None:
            return
        try:
            await self._rpc("saveSession")
            await self._rpc("shutdown")
            if self._process is not None:
                await asyncio.to_thread(self._process.wait, timeout=10)
        except (DownloadManagerError, subprocess.TimeoutExpired, OSError, ValueError) as exc:
            logging.warning("Could not gracefully stop aria2: %s", exc)
        finally:
            await self._client.aclose()
            self._client = None
            self._process = None

    def _options(self, filename: str | None = None) -> dict[str, Any]:
        settings = self._settings
        options = {
            "dir": str(settings["download_path"]),
            "continue": "true",
            "check-integrity": "true",
            "file-allocation": "none",
            "max-connection-per-server": str(settings["connections_per_file"]),
            "split": str(settings["connections_per_file"]),
            "min-split-size": "1M",
            "allow-overwrite": "false",
            "auto-file-renaming": "true",
            "user-agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
        }
        if filename:
            options["out"] = sanitize_filename(filename)
        return options

    async def add_url(
        self,
        url: str,
        *,
        filename: str | None = None,
        title: str | None = None,
        video_id: int | None = None,
        source: str | None = None,
        referer: str | None = None,
        allow_localhost: bool = False,
    ) -> dict[str, Any]:
        if any(ord(character) < 32 or ord(character) == 127 for character in url):
            raise ValueError("Download URL contains invalid control characters")
        if allow_localhost:
            parsed_url = urllib.parse.urlsplit(url)
            try:
                valid_local_url = (
                    parsed_url.scheme == "http"
                    and parsed_url.hostname in {"127.0.0.1", "localhost", "::1"}
                    and parsed_url.username is None
                    and parsed_url.password is None
                    and parsed_url.port is not None
                )
            except ValueError:
                valid_local_url = False
            if not valid_local_url:
                raise ValueError("Internal downloads must use an HTTP localhost URL")
            safe_url = url
        else:
            try:
                safe_url = require_public_http_url(url)
            except ValueError as exc:
                raise ValueError(str(exc)) from exc
        await self.ensure_started()
        options = self._options(filename)
        if referer:
            if any(character in referer for character in "\r\n"):
                raise ValueError("Download referer contains invalid header characters")
            try:
                safe_referer = require_public_http_url(referer)
            except ValueError as exc:
                raise ValueError(f"Invalid download referer: {exc}") from exc
            options["header"] = [f"Referer: {safe_referer}"]
        gid = await self._rpc("addUri", [safe_url], options)
        async with self._file_lock:
            self._metadata[gid] = {
                "url": safe_url,
                "filename": sanitize_filename(filename) if filename else "",
                "title": (title or "").strip(),
                "video_id": video_id,
                "source": source or "",
                "referer": referer or "",
                "allow_localhost": allow_localhost,
                "added_at": int(time.time()),
            }
            try:
                self._write_json(self.metadata_path, self._metadata)
            except OSError as exc:
                self._metadata.pop(gid, None)
                try:
                    await self._rpc("forceRemove", gid)
                except DownloadManagerError as cleanup_error:
                    logging.error("Could not remove untracked aria2 download %s: %s", gid, cleanup_error)
                raise DownloadManagerError(f"Could not persist download queue metadata: {exc}") from exc
        return {"gid": gid, "url": safe_url, "filename": filename or ""}

    async def _all_tasks(self) -> list[dict[str, Any]]:
        await self.ensure_started()
        tasks = list(await self._rpc("tellActive", ARIA2_STATUS_KEYS))
        for method in ("tellWaiting", "tellStopped"):
            offset = 0
            while True:
                page = list(await self._rpc(method, offset, 1000, ARIA2_STATUS_KEYS))
                tasks.extend(page)
                if len(page) < 1000:
                    break
                offset += len(page)
        return tasks

    @staticmethod
    def _serialize_task(item: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
        gid = str(item.get("gid") or "")
        total = _integer(item.get("totalLength"))
        completed = _integer(item.get("completedLength"))
        speed = _integer(item.get("downloadSpeed"))
        raw_status = str(item.get("status") or "error")
        if metadata.get("state") == "cancelled":
            status = "error"
            error_message = metadata.get("error_message") or "Cancelled"
        else:
            status = {
                "active": "active",
                "waiting": "waiting",
                "paused": "paused",
                "complete": "complete",
                "error": "error",
            }.get(raw_status, "error")
            error_message = item.get("errorMessage") or (
                "Download stopped unexpectedly" if status == "error" and raw_status != "error" else None
            )
        files = item.get("files") or []
        file_info = files[0] if files else {}
        path = str(file_info.get("path") or "")
        filename = metadata.get("filename") or item.get("filename") or (Path(path).name if path else "")
        uris = file_info.get("uris") or []
        url = metadata.get("url") or (uris[0].get("uri") if uris else "")
        connections = _integer(item.get("connections"))
        eta = (total - completed) / speed if speed > 0 and total > completed else None
        return {
            "gid": gid,
            "url": url,
            "filename": filename or metadata.get("title") or url,
            "status": status,
            "totalLength": total,
            "completedLength": completed,
            "downloadSpeed": speed,
            "progress": round(min(100.0, completed * 100 / total), 2) if total else 0.0,
            "eta": round(eta) if eta is not None else None,
            "connections": connections,
            "errorMessage": error_message,
            "videoId": metadata.get("video_id"),
            "source": metadata.get("source") or None,
        }

    async def status(self) -> dict[str, Any]:
        records = await self._all_tasks()
        await self._snapshot_finished(records)
        present = {str(item.get("gid") or "") for item in records}
        tasks = [self._serialize_task(item, self._metadata.get(str(item.get("gid") or ""), {}))
                 for item in records]
        for gid, metadata in self._metadata.items():
            if gid in present:
                continue
            snapshot = metadata.get("snapshot")
            if isinstance(snapshot, dict):
                tasks.append(self._serialize_task(snapshot, metadata))
            elif metadata.get("state") == "cancelled":
                tasks.append(self._serialize_task(
                    {"gid": gid, "status": "error", "errorMessage": "Cancelled", "files": []},
                    metadata,
                ))
        counts = {key: 0 for key in ("active", "waiting", "paused", "complete", "error")}
        for task in tasks:
            counts[task["status"]] += 1
        total_length = sum(task["totalLength"] for task in tasks)
        completed_length = sum(task["completedLength"] for task in tasks)
        return {
            "tasks": tasks,
            "summary": {
                **counts,
                "remaining": counts["active"] + counts["waiting"] + counts["paused"],
                "completed": counts["complete"],
                "total": len(tasks),
                "downloadSpeed": sum(task["downloadSpeed"] for task in tasks),
                "progress": round(completed_length * 100 / total_length, 2) if total_length else 0.0,
            },
        }

    async def pause(self, gid: str) -> None:
        await self.ensure_started()
        await self._rpc("pause", gid)

    async def resume(self, gid: str) -> None:
        await self.ensure_started()
        await self._rpc("unpause", gid)

    async def cancel(self, gid: str) -> None:
        await self.ensure_started()
        task = await self._rpc("tellStatus", gid, ["status"])
        if task.get("status") not in {"active", "waiting", "paused"}:
            raise ValueError("Only active, waiting, or paused downloads can be cancelled")
        try:
            await self._rpc("forceRemove", gid)
        except DownloadManagerError as exc:
            if "not found" not in str(exc).lower():
                raise
        async with self._file_lock:
            if gid in self._metadata:
                self._metadata[gid]["state"] = "cancelled"
                self._metadata[gid]["error_message"] = "Cancelled"
                self._write_json(self.metadata_path, self._metadata)

    async def remove(self, gid: str) -> None:
        await self.ensure_started()
        try:
            task = await self._rpc("tellStatus", gid, ["status"])
        except DownloadManagerError as exc:
            if "not found" not in str(exc).lower():
                raise
            task = {}
        if task.get("status") in {"active", "waiting", "paused"}:
            await self._rpc("forceRemove", gid)
        if task:
            try:
                await self._rpc("removeDownloadResult", gid)
            except DownloadManagerError as exc:
                if "not found" not in str(exc).lower():
                    raise
        async with self._file_lock:
            self._metadata.pop(gid, None)
            self._write_json(self.metadata_path, self._metadata)

    async def retry(self, gid: str) -> dict[str, Any]:
        metadata = self._metadata.get(gid)
        if not metadata or not metadata.get("url"):
            raise KeyError(gid)
        return await self.add_url(
            metadata["url"],
            filename=metadata.get("filename") or None,
            title=metadata.get("title") or None,
            video_id=metadata.get("video_id"),
            source=metadata.get("source") or None,
            referer=metadata.get("referer") or None,
            allow_localhost=bool(metadata.get("allow_localhost")),
        )

    async def open_folder(self) -> str:
        folder = Path(self._settings["download_path"])
        folder.mkdir(parents=True, exist_ok=True)
        try:
            if sys.platform == "win32":
                os.startfile(str(folder))
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(folder)])
            else:
                subprocess.Popen(["xdg-open", str(folder)])
        except OSError as exc:
            logging.exception("Could not open download directory %s", folder)
            raise DownloadManagerError(f"Could not open downloads folder: {exc}") from exc
        return str(folder)


download_manager = Aria2DownloadManager()
