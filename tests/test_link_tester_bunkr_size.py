import asyncio
import subprocess
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.routers import link_tester
from app.routers.link_tester import _album_total_size_bytes, _parse_size_bytes, _shape_album_items


def test_parse_public_bunkr_size_text_to_bytes():
    assert _parse_size_bytes("1.25 GB") == int(1.25 * 1024 ** 3)
    assert _parse_size_bytes("700 MB") == 700 * 1024 ** 2
    assert _parse_size_bytes("512 KiB") == 512 * 1024


def test_bunkr_album_card_sizes_are_summed_for_tester():
    album_url = "https://bunkr.cr/a/example"
    entries = [
        {"url": "https://bunkr.cr/f/first", "title": "First", "size": "1.25 GB"},
        {"url": "https://bunkr.cr/f/second", "title": "Second", "size": "700 MB"},
    ]

    shaped = _shape_album_items(entries, album_url)

    assert [item["size_bytes"] for item in shaped] == [
        int(1.25 * 1024 ** 3),
        700 * 1024 ** 2,
    ]
    assert _album_total_size_bytes(shaped) == int(1.25 * 1024 ** 3) + 700 * 1024 ** 2


def test_bunkr_album_date_survives_shaping_and_full_meta(monkeypatch):
    url = "https://bunkr.cr/a/dates"
    entries = [{"url": "https://bunkr.cr/f/dated", "title": "Video", "date": "2026-10-02"}]
    monkeypatch.setattr(link_tester._bunkr_extractor, "extract_album", AsyncMock(return_value=entries))
    result = asyncio.run(link_tester._fetch_bunkr_meta(url, asyncio.Semaphore(1)))
    assert result["album_items"][0]["upload_date"] == "2026-10-02"
    assert result["upload_date"] == "2026-10-02"


def test_filester_uploaded_at_is_preserved_for_expanded_cards():
    shaped = _shape_album_items([
        {
            "url": "https://filester.me/d/example",
            "title": "Example",
            "uploaded_at": "2026-10-02T14:37:00+00:00",
        },
    ], "https://filester.me/f/example")

    assert shaped[0]["upload_date"] == "2026-10-02T14:37:00+00:00"


def test_filester_folder_full_meta_returns_newest_file_date(monkeypatch):
    entries = [
        {"url": "https://filester.me/d/old", "title": "Old", "uploaded_at": "2026-09-30T11:00:00+00:00"},
        {"url": "https://filester.me/d/new", "title": "New", "uploaded_at": "2026-10-02T14:37:00+00:00"},
    ]
    monkeypatch.setattr(link_tester._filester_extractor, "extract_album_entries", AsyncMock(return_value=entries))

    result = asyncio.run(link_tester._fetch_filester_meta(
        "https://filester.me/f/example", asyncio.Semaphore(1),
    ))

    assert result["upload_date"] == "2026-10-02T14:37:00+00:00"
    assert [item["upload_date"] for item in result["album_items"]] == [
        "2026-09-30T11:00:00+00:00", "2026-10-02T14:37:00+00:00",
    ]


def test_quick_meta_returns_public_bunkr_album_total(monkeypatch):
    entries = [
        {"url": "https://bunkr.cr/f/first", "title": "First", "size": "1.25 GB"},
        {"url": "https://bunkr.cr/f/second", "title": "Second", "size": "700 MB"},
    ]
    monkeypatch.setattr(link_tester._bunkr_extractor, "extract_album", AsyncMock(return_value=entries))

    result = asyncio.run(
        link_tester._fetch_bunkr_meta("https://bunkr.cr/a/example", asyncio.Semaphore(1))
    )

    expected = int(1.25 * 1024 ** 3) + 700 * 1024 ** 2
    assert result["size_bytes"] == expected
    assert result["album_size_bytes"] == expected
    assert [item["size_bytes"] for item in result["album_items"]] == [
        int(1.25 * 1024 ** 3),
        700 * 1024 ** 2,
    ]


def test_frame_thumbnail_uses_requested_width_without_upscaling(monkeypatch):
    commands = []

    def fake_run(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout=b"jpeg", stderr=b"")

    monkeypatch.setattr(link_tester.subprocess, "run", fake_run)
    result = asyncio.run(link_tester.frame_thumbnail(
        "https://cache1.filester.me/video.mp4", at=10, width=1280,
    ))

    assert result.body == b"jpeg"
    filter_args = commands[0][commands[0].index("-vf") + 1]
    assert filter_args == "scale=w='min(iw,1280)':h=-2"
    assert "-q:v" in commands[0]


def test_frame_thumbnail_still_rejects_untrusted_hosts():
    with pytest.raises(HTTPException) as error:
        asyncio.run(link_tester.frame_thumbnail("http://127.0.0.1/private.mp4", width=1280))

    assert error.value.status_code == 403


def test_stream_frame_captures_source_resolution_with_filester_referer(monkeypatch):
    commands = []
    approved_urls = []

    def fake_run(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout=b"jpeg", stderr=b"")

    monkeypatch.setenv("FFMPEG_PATH", "ffmpeg-test")
    monkeypatch.setattr(link_tester.os.path, "isfile", lambda path: True)
    monkeypatch.setattr(link_tester.subprocess, "run", fake_run)
    monkeypatch.setattr(
        link_tester, "_require_public_proxy_url",
        lambda value: approved_urls.append(value) or value,
    )
    link_tester._STREAM_FRAME_CACHE.clear()

    result = asyncio.run(link_tester.stream_frame_proxy(
        "https://cache1.filester.me/v2/video.mp4?token=signed",
        at=7,
        width=3840,
    ))

    assert result.body == b"jpeg"
    assert approved_urls == ["https://cache1.filester.me/v2/video.mp4?token=signed"]
    assert "Referer: https://filester.me/\r\n" in commands[0]
    filter_args = commands[0][commands[0].index("-vf") + 1]
    assert filter_args == "scale=w='min(iw,3840)':h=-2"
    assert commands[0][commands[0].index("-ss") + 1] == "7"
    assert "-q:v" in commands[0]
    link_tester._STREAM_FRAME_CACHE.clear()
