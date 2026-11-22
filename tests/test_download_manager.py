import json
from unittest.mock import AsyncMock

import pytest

from app.download_manager import Aria2DownloadManager, sanitize_filename


def test_sanitize_filename_removes_paths_and_reserved_characters():
    assert sanitize_filename(r"C:\unsafe\clip?.mp4") == "clip_.mp4"
    with pytest.raises(ValueError):
        sanitize_filename(" .. ")


def test_serialize_task_includes_live_progress_and_eta():
    task = Aria2DownloadManager._serialize_task(
        {
            "gid": "abc123",
            "status": "active",
            "totalLength": "10485760",
            "completedLength": "5242880",
            "downloadSpeed": "1048576",
            "connections": "8",
            "files": [{"path": r"C:\Downloads\clip.mp4", "uris": [{"uri": "https://cdn.example/clip.mp4"}]}],
        },
        {"url": "https://cdn.example/clip.mp4"},
    )

    assert task["status"] == "active"
    assert task["filename"] == "clip.mp4"
    assert task["progress"] == 50
    assert task["eta"] == 5
    assert task["connections"] == 8
    assert task["errorMessage"] is None


def test_cancelled_task_has_error_status_and_message():
    task = Aria2DownloadManager._serialize_task(
        {"gid": "abc123", "status": "error", "files": []},
        {"state": "cancelled", "error_message": "Cancelled"},
    )

    assert task["status"] == "error"
    assert task["errorMessage"] == "Cancelled"


@pytest.mark.asyncio
async def test_settings_are_saved_and_connections_are_bounded(tmp_path):
    manager = Aria2DownloadManager(state_dir=tmp_path / "state")
    settings = await manager.update_settings({
        "max_concurrent_downloads": 9,
        "connections_per_file": 16,
        "download_path": str(tmp_path / "downloads"),
        "auto_clear_completed": True,
    })

    assert settings["connections_per_file"] == 16
    assert settings["auto_clear_completed"] is True
    assert (tmp_path / "downloads").is_dir()
    assert json.loads((tmp_path / "state" / "manager_settings.json").read_text()) == settings

    with pytest.raises(ValueError):
        await manager.update_settings({**settings, "connections_per_file": 17})


def test_legacy_connection_limit_is_migrated_to_aria2_max(tmp_path):
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    settings_path = state_dir / "manager_settings.json"
    settings_path.write_text(json.dumps({
        "max_concurrent_downloads": 5,
        "connections_per_file": 32,
        "download_path": str(tmp_path / "downloads"),
        "auto_clear_completed": False,
    }), encoding="utf-8")

    manager = Aria2DownloadManager(state_dir=state_dir)

    assert manager._settings["connections_per_file"] == 16
    assert json.loads(settings_path.read_text(encoding="utf-8"))["connections_per_file"] == 16


@pytest.mark.asyncio
async def test_local_stream_urls_require_explicit_permission_and_are_retryable(tmp_path):
    manager = Aria2DownloadManager(state_dir=tmp_path / "state")
    manager.ensure_started = AsyncMock()
    manager._rpc = AsyncMock(return_value="local-gid")
    url = "http://127.0.0.1:8000/api/v1/telegram/stream/1/2"

    with pytest.raises(ValueError, match="Private or reserved"):
        await manager.add_url(url)

    await manager.add_url(url, source="telegram", allow_localhost=True)
    assert manager._metadata["local-gid"]["allow_localhost"] is True
