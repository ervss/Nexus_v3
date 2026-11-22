"""
BitTorrent Web Integration – Service Layer
==========================================
Všetka helper logika pre BitTorrent Web integráciu.
Vyčlenené z app/main.py pre lepšiu prehľadnosť.
"""

from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
import socket
import sqlite3 as _sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Konštanty
# ---------------------------------------------------------------------------

BITTORRENT_WEB_EXE_PATH = os.getenv(
    "BITTORRENT_WEB_EXE_PATH",
    r"C:\Users\Peto\AppData\Roaming\BitTorrent Web\btweb.exe",
)
BITTORRENT_WEB_UI_PORT = int(os.getenv("BITTORRENT_WEB_UI_PORT", "19575"))
BITTORRENT_WEB_UI_URL = f"http://127.0.0.1:{BITTORRENT_WEB_UI_PORT}/gui/index.html"
BITTORRENT_WEB_RESUME_DB = Path(r"C:\Users\Peto\AppData\Roaming\BitTorrent Web\resume.dat")
BITTORRENT_WEB_SETTINGS_PATH = Path(r"C:\Users\Peto\AppData\Roaming\BitTorrent Web\settings.dat")
BITTORRENT_VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v",
                               ".ts", ".m2ts", ".mts"}
BITTORRENT_MIN_READY_BYTES = 64 * 1024 * 1024
BITTORRENT_GROW_WAIT_SECONDS = 12.0
BITTORRENT_GROW_POLL_SECONDS = 0.35
BITTORRENT_META_MIN_BYTES = 24 * 1024 * 1024
BITTORRENT_THUMB_DIR = Path("app/static/thumbnails/bittorrent")
BITTORRENT_META_CACHE: dict[str, dict[str, Any]] = {}

# ---------------------------------------------------------------------------
# Bencode parser
# ---------------------------------------------------------------------------

def _bdecode(data: bytes):
    def parse(idx: int):
        token = data[idx:idx + 1]
        if token == b"i":
            end = data.index(b"e", idx)
            return int(data[idx + 1:end]), end + 1
        if token == b"l":
            idx2 = idx + 1
            out: list = []
            while data[idx2:idx2 + 1] != b"e":
                item, idx2 = parse(idx2)
                out.append(item)
            return out, idx2 + 1
        if token == b"d":
            idx2 = idx + 1
            out2: dict = {}
            while data[idx2:idx2 + 1] != b"e":
                key, idx2 = parse(idx2)
                value, idx2 = parse(idx2)
                out2[key] = value
            return out2, idx2 + 1
        if token.isdigit():
            colon = data.index(b":", idx)
            size = int(data[idx:colon])
            start = colon + 1
            end = start + size
            return data[start:end], end
        raise ValueError(f"Unsupported bencode token at {idx}: {token!r}")

    value, end = parse(0)
    if end != len(data):
        raise ValueError("Trailing data in bencode payload")
    return value


def _bt_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="ignore")
    return str(value or "")


# ---------------------------------------------------------------------------
# Settings / status
# ---------------------------------------------------------------------------

def _load_bittorrent_settings() -> dict[str, Any]:
    if not BITTORRENT_WEB_SETTINGS_PATH.exists():
        return {}
    try:
        raw = BITTORRENT_WEB_SETTINGS_PATH.read_bytes()
        decoded = _bdecode(raw)
        return {_bt_text(k): v for k, v in decoded.items()} if isinstance(decoded, dict) else {}
    except Exception as exc:
        logging.warning("Failed to parse BitTorrent Web settings.dat: %s", exc)
        return {}


def _is_local_port_open(host: str, port: int, timeout: float = 0.35) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def get_bittorrent_web_status() -> dict[str, Any]:
    installed = os.path.exists(BITTORRENT_WEB_EXE_PATH)
    ui_reachable = _is_local_port_open("127.0.0.1", BITTORRENT_WEB_UI_PORT)
    settings = _load_bittorrent_settings()
    save_path = _bt_text(settings.get("save_path", "")).strip() or r"E:\mega aug"
    return {
        "installed": installed,
        "running": ui_reachable,
        "ui_reachable": ui_reachable,
        "exe_path": BITTORRENT_WEB_EXE_PATH if installed else None,
        "ui_url": BITTORRENT_WEB_UI_URL,
        "ui_port": BITTORRENT_WEB_UI_PORT,
        "save_path": save_path,
    }


def launch_bittorrent_web() -> dict[str, Any]:
    if not os.path.exists(BITTORRENT_WEB_EXE_PATH):
        raise FileNotFoundError(BITTORRENT_WEB_EXE_PATH)
    if os.name == "nt":
        os.startfile(BITTORRENT_WEB_EXE_PATH)
    else:
        subprocess.Popen([BITTORRENT_WEB_EXE_PATH], cwd=os.path.dirname(BITTORRENT_WEB_EXE_PATH))
    return get_bittorrent_web_status()


# ---------------------------------------------------------------------------
# Thumbnail / media metadata
# ---------------------------------------------------------------------------

def _normalize_windows_path(path: str) -> str:
    if os.name == "nt" and path.startswith("/") and ":" in path:
        return path[1:]
    return path


def _safe_bittorrent_thumb_relpath(file_path: Path) -> str:
    thumb_name = f"bt_{hashlib.sha1(str(file_path).encode('utf-8', errors='ignore')).hexdigest()[:16]}.jpg"
    return f"/static/thumbnails/bittorrent/{thumb_name}"


def _get_bittorrent_media_meta(file_path: Path, file_size_bytes: int) -> dict[str, Any]:
    if file_size_bytes < BITTORRENT_META_MIN_BYTES or not file_path.exists():
        return {}
    try:
        stat = file_path.stat()
    except OSError:
        return {}

    cache_key = str(file_path).lower()
    signature = (int(stat.st_mtime), int(stat.st_size))
    cached = BITTORRENT_META_CACHE.get(cache_key)
    if cached and cached.get("signature") == signature:
        return dict(cached.get("data") or {})

    meta: dict[str, Any] = {}
    try:
        probe = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height:format=duration",
                "-of", "json",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=12,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if probe.returncode == 0 and probe.stdout.strip():
            import json
            payload = json.loads(probe.stdout)
            stream = (payload.get("streams") or [{}])[0]
            width = int(float(stream.get("width") or 0))
            height = int(float(stream.get("height") or 0))
            duration = int(float(payload.get("format", {}).get("duration") or 0))
            if width:
                meta["width"] = width
            if height:
                meta["height"] = height
            if duration:
                meta["duration"] = duration
    except Exception as exc:
        logging.debug("BitTorrent ffprobe failed for %s: %s", file_path, exc)

    try:
        BITTORRENT_THUMB_DIR.mkdir(parents=True, exist_ok=True)
        thumb_rel = _safe_bittorrent_thumb_relpath(file_path)
        thumb_path = Path("app") / thumb_rel.lstrip("/").replace("/", os.sep)
        if not thumb_path.exists():
            capture_offset = "00:00:08"
            if meta.get("duration"):
                capture_secs = max(2, min(int(meta["duration"] * 0.12), 45))
                capture_offset = (
                    f"00:00:{capture_secs:02d}"
                    if capture_secs < 60
                    else time.strftime("%H:%M:%S", time.gmtime(capture_secs))
                )
            thumb = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-ss", capture_offset,
                    "-i", str(file_path),
                    "-frames:v", "1",
                    "-vf", "scale=320:-1",
                    str(thumb_path),
                ],
                capture_output=True,
                text=True,
                timeout=18,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            if thumb.returncode == 0 and thumb_path.exists():
                meta["thumbnail_path"] = thumb_rel
        elif thumb_path.exists():
            meta["thumbnail_path"] = thumb_rel
    except Exception as exc:
        logging.debug("BitTorrent thumbnail generation failed for %s: %s", file_path, exc)

    BITTORRENT_META_CACHE[cache_key] = {"signature": signature, "data": dict(meta)}
    return meta


# ---------------------------------------------------------------------------
# Torrent item extraction
# ---------------------------------------------------------------------------

def _pick_bittorrent_video_path(info: dict[str, Any], save_path: Path) -> Optional[Path]:
    info_dict = info.get("info") if isinstance(info.get("info"), dict) else {}
    torrent_name = _bt_text(info_dict.get(b"name") or info_dict.get("name")).strip()
    files = info_dict.get(b"files") or info_dict.get("files")

    candidates: list[Path] = []
    if isinstance(files, list):
        for file_entry in files:
            if not isinstance(file_entry, dict):
                continue
            path_parts = file_entry.get(b"path") or file_entry.get("path") or []
            parts = [_bt_text(part).strip() for part in path_parts if _bt_text(part).strip()]
            if not parts:
                continue
            suffix = Path(*parts)
            direct_path = save_path / suffix
            nested_path = (save_path / torrent_name / suffix) if torrent_name else direct_path
            for candidate in (direct_path, nested_path):
                if candidate.suffix.lower() in BITTORRENT_VIDEO_EXTENSIONS:
                    candidates.append(candidate)
    elif torrent_name:
        direct_path = save_path / torrent_name
        if direct_path.suffix.lower() in BITTORRENT_VIDEO_EXTENSIONS:
            candidates.append(direct_path)

    for candidate in candidates:
        if candidate.exists():
            return candidate

    search_roots = []
    if torrent_name:
        search_roots.extend([save_path / torrent_name, save_path])
    else:
        search_roots.append(save_path)

    seen: set[str] = set()
    for root in search_roots:
        if not root.exists():
            continue
        root_key = str(root).lower()
        if root_key in seen:
            continue
        seen.add(root_key)
        if root.is_file() and root.suffix.lower() in BITTORRENT_VIDEO_EXTENSIONS:
            return root
        if root.is_dir():
            matches = [
                p for p in root.rglob("*")
                if p.is_file() and p.suffix.lower() in BITTORRENT_VIDEO_EXTENSIONS
            ]
            if matches:
                matches.sort(key=lambda p: p.stat().st_size, reverse=True)
                return matches[0]
    return None


def extract_bittorrent_items(limit: int = 50) -> list[dict[str, Any]]:
    settings = _load_bittorrent_settings()
    default_save_path = _bt_text(settings.get("save_path", "")).strip() or r"E:\mega aug"
    if not BITTORRENT_WEB_RESUME_DB.exists():
        return []

    items: list[dict[str, Any]] = []
    conn = _sqlite3.connect(str(BITTORRENT_WEB_RESUME_DB))
    try:
        rows = conn.execute(
            "SELECT INFOHASH, RESUME, COALESCE(SAVE_PATH, '') AS SAVE_PATH FROM TORRENTS ORDER BY rowid DESC"
        ).fetchall()
    finally:
        conn.close()

    for infohash, resume_blob, row_save_path in rows[:limit]:
        save_path_str = (row_save_path or default_save_path or "").strip()
        if not save_path_str:
            continue
        save_path = Path(save_path_str)
        item: dict[str, Any] = {
            "infohash": infohash,
            "save_path": save_path_str,
            "title": "",
            "progress": 0.0,
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "sequential_download": False,
            "path": None,
            "playable": False,
            "stream_ready": False,
            "status": "downloading",
            "storage_type": "bittorrent",
            "source": "BitTorrent Web",
            "thumbnail_path": "/static/placeholder.jpg",
        }

        parsed_resume: dict[str, Any] = {}
        if isinstance(resume_blob, str):
            item["title"] = resume_blob
        else:
            try:
                raw = bytes(resume_blob)
                decoded = _bdecode(raw)
                if isinstance(decoded, dict):
                    parsed_resume = {_bt_text(k): v for k, v in decoded.items()}
            except Exception as exc:
                logging.warning("Failed to parse BitTorrent resume blob for %s: %s", infohash, exc)

            info_dict = parsed_resume.get("info") if isinstance(parsed_resume.get("info"), dict) else {}
            if isinstance(info_dict, dict):
                info_dict = {_bt_text(k): v for k, v in info_dict.items()}
            torrent_name = _bt_text(info_dict.get("name")).strip()
            item["title"] = torrent_name or item["title"] or infohash
            item["downloaded_bytes"] = int(parsed_resume.get("total_downloaded") or 0)
            item["sequential_download"] = bool(int(parsed_resume.get("sequential_download") or 0))
            if "length" in info_dict:
                item["total_bytes"] = int(info_dict.get("length") or 0)
            elif isinstance(info_dict.get("files"), list):
                item["total_bytes"] = sum(
                    int(file_entry.get("length") or 0)
                    for file_entry in info_dict["files"]
                    if isinstance(file_entry, dict)
                )

            resolved_path = _pick_bittorrent_video_path({"info": info_dict}, save_path)
            if resolved_path:
                item["path"] = str(resolved_path)
                try:
                    item["file_size_bytes"] = resolved_path.stat().st_size
                except OSError:
                    item["file_size_bytes"] = 0
                item["playable"] = True
                media_meta = _get_bittorrent_media_meta(resolved_path, int(item["file_size_bytes"] or 0))
                if media_meta:
                    item.update(media_meta)

        if not item["title"]:
            item["title"] = infohash

        total_bytes = int(item.get("total_bytes") or 0)
        downloaded_bytes = int(item.get("downloaded_bytes") or 0)
        file_size_bytes = int(item.get("file_size_bytes") or 0)
        if total_bytes > 0:
            item["progress"] = round(min(100.0, (downloaded_bytes / total_bytes) * 100.0), 2)
        elif item["playable"]:
            item["progress"] = 100.0

        ready_threshold = BITTORRENT_MIN_READY_BYTES
        if total_bytes > 0:
            ready_threshold = min(BITTORRENT_MIN_READY_BYTES, max(16 * 1024 * 1024, int(total_bytes * 0.03)))
        item["stream_ready"] = bool(
            item["playable"] and (file_size_bytes >= ready_threshold or item["progress"] >= 15.0)
        )
        if item["playable"] and item["progress"] >= 99.5:
            item["status"] = "ready"
        elif item["stream_ready"]:
            item["status"] = "ready_to_stream"
        elif item["playable"]:
            item["status"] = "buffering"
        else:
            item["status"] = "downloading"
        item["thumbnail_path"] = item.get("thumbnail_path") or "/static/placeholder.jpg"
        items.append(item)

    return items


# ---------------------------------------------------------------------------
# File streaming
# ---------------------------------------------------------------------------

def stream_file_response(file_path: str, request_headers: dict, *, allow_growing: bool = False):
    """
    Vráti (status_code, headers, generator) tuple pre streamovanie súboru.
    Router si z toho zostaví StreamingResponse sám.
    """
    from fastapi import HTTPException
    from fastapi.responses import StreamingResponse

    normalized_path = _normalize_windows_path(file_path)
    if not os.path.exists(normalized_path):
        raise HTTPException(status_code=404, detail="Source file not found")

    def current_file_size() -> int:
        return os.path.getsize(normalized_path)

    def wait_for_size(min_size: int, timeout: float = BITTORRENT_GROW_WAIT_SECONDS) -> int:
        deadline = time.time() + timeout
        latest = current_file_size()
        while latest < min_size and time.time() < deadline:
            time.sleep(BITTORRENT_GROW_POLL_SECONDS)
            latest = current_file_size()
        return latest

    file_size = current_file_size()
    mime_type, _ = mimetypes.guess_type(normalized_path)
    mime_type = mime_type or "video/mp4"
    range_header = request_headers.get("range")

    if range_header:
        range_match = range_header.replace("bytes=", "").split("-")
        start = int(range_match[0]) if range_match[0] else 0
        if allow_growing and start >= file_size:
            file_size = wait_for_size(start + 1)
        end = int(range_match[1]) if len(range_match) > 1 and range_match[1] else file_size - 1
        if allow_growing and end >= file_size:
            target_end = min(end, start + (8 * 1024 * 1024) - 1)
            file_size = wait_for_size(target_end + 1, timeout=4.0)
        start = max(0, start)
        end = min(file_size - 1, end)
        if end < start:
            raise HTTPException(status_code=416, detail="Requested range not yet available")
        content_length = max(0, end - start + 1)

        def iterfile_range():
            with open(normalized_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = f.read(min(1024 * 1024, remaining))
                    if not chunk:
                        if allow_growing and wait_for_size(f.tell() + 1, timeout=3.0) > f.tell():
                            continue
                        break
                    remaining -= len(chunk)
                    yield chunk

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(content_length),
        }
        return StreamingResponse(iterfile_range(), status_code=206, media_type=mime_type, headers=headers)

    def iterfile_full():
        with open(normalized_path, "rb") as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    if allow_growing and wait_for_size(f.tell() + 1, timeout=3.0) > f.tell():
                        continue
                    break
                yield chunk

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(file_size),
    }
    return StreamingResponse(iterfile_full(), media_type=mime_type, headers=headers)
