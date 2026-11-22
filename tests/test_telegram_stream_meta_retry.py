import asyncio
from pathlib import Path

import pytest

from app import telegram_stream


def test_metadata_replace_retries_windows_file_lock(tmp_path, monkeypatch):
    monkeypatch.setattr(telegram_stream, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(telegram_stream.time, "sleep", lambda _: None)
    pump = telegram_stream.TelegramPump(12, 34, 8, "video/mp4")
    original_replace = Path.replace
    attempts = 0

    def transient_lock(path, target):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise PermissionError(5, "Access is denied")
        return original_replace(path, target)

    monkeypatch.setattr(Path, "replace", transient_lock)
    pump._write_meta([[0, 8]])

    assert attempts == 3
    assert telegram_stream._load_meta(12, 34)["ranges"] == [[0, 8]]


def test_trailing_mp4_metadata_range_gets_priority(tmp_path, monkeypatch):
    monkeypatch.setattr(telegram_stream, "CACHE_DIR", tmp_path)
    pump = telegram_stream.TelegramPump(12, 35, 100 * 1024 * 1024, "video/mp4")
    pump.ranges = [(0, telegram_stream.HEAD_BYTES)]
    pump.readers = {1: telegram_stream.HEAD_BYTES, 2: pump.size - telegram_stream.PART}

    assert pump._priority_origin() == pump.size - telegram_stream.PART

    pump.readers = {1: telegram_stream.HEAD_BYTES}
    assert pump._priority_origin() == telegram_stream.HEAD_BYTES


def test_metadata_failure_does_not_stop_cache_writer(tmp_path, monkeypatch):
    monkeypatch.setattr(telegram_stream, "CACHE_DIR", tmp_path)
    pump = telegram_stream.TelegramPump(12, 34, 8, "video/mp4")
    pump._faststarted = True
    snapshots = []
    monkeypatch.setattr(pump, "_write_disk", lambda offset, data: None)

    def flaky_meta(ranges):
        snapshots.append(ranges)
        if len(snapshots) == 1:
            raise PermissionError(5, "Access is denied")

    monkeypatch.setattr(pump, "_write_meta", flaky_meta)
    async def run():
        task = asyncio.create_task(pump._commit())
        await pump.chunks.put((0, b"abcd"))
        await pump.chunks.put((4, b"efgh"))
        try:
            await asyncio.wait_for(_until(lambda: len(snapshots) == 2), timeout=3)
            assert pump.ranges == [(0, 8)]
            assert not task.done()
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(run())


async def _until(predicate):
    while not predicate():
        await asyncio.sleep(0.01)
