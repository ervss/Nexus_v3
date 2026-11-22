import sqlite3
from unittest.mock import patch

import pytest

from app.routers import telegram as telegram_router
from app.telegram_auth import ResilientSQLiteSession
from app.telegram_service import normalize_channel_name


def test_normalize_channel_name_strips_nbsp_and_whitespace():
    assert normalize_channel_name("2\xa0154\xa0919\xa0612") == "2154919612"
    assert normalize_channel_name(" @2154919612 ") == "2154919612"
    assert normalize_channel_name("https://t.me/s/my_channel") == "my_channel"


def test_resilient_sqlite_session_enables_wal_and_timeout(tmp_path):
    db_file = tmp_path / "test_tg.session"
    session = ResilientSQLiteSession(str(db_file))
    try:
        mode = session._conn.execute("PRAGMA journal_mode").fetchone()[0]
        timeout = session._conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert str(mode).lower() == "wal"
        assert int(timeout) == 30000
    finally:
        session.close()


@pytest.mark.asyncio
async def test_stream_scrape_reports_db_locked_instead_of_18plus_error():
    async def failing_telethon(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")
        yield  # pragma: no cover

    with patch("app.telegram_service.stream_scrape_channel_via_telethon", side_effect=failing_telethon):
        events = [
            evt async for evt in telegram_router.stream_channel_scrape("2154919612", limit=10)
        ]

    errors = [e for e in events if e.get("status") == "error"]
    assert len(errors) == 1
    assert "uzamknutá" in errors[0]["error"]
    assert "18+" not in errors[0]["error"]


@pytest.mark.asyncio
async def test_stream_scrape_numeric_id_auth_error_does_not_hit_web_preview():
    async def failing_telethon(*args, **kwargs):
        raise PermissionError("Telegram session is not authorized")
        yield  # pragma: no cover

    with patch("app.telegram_service.stream_scrape_channel_via_telethon", side_effect=failing_telethon):
        events = [
            evt async for evt in telegram_router.stream_channel_scrape("2154919612", limit=10)
        ]

    errors = [e for e in events if e.get("status") == "error"]
    assert len(errors) == 1
    assert errors[0].get("needs_auth") is True
    assert "numerickým ID" in errors[0]["error"]
    assert "18+" not in errors[0]["error"]


@pytest.mark.asyncio
async def test_resilient_sqlite_session_does_not_block_event_loop_when_locked(tmp_path):
    import time

    db_file = tmp_path / "locked_tg.session"
    seed = ResilientSQLiteSession(str(db_file))
    seed.set_dc(2, "149.154.167.50", 443)
    seed.save()
    seed.close()

    locker = sqlite3.connect(str(db_file), timeout=5.0)
    locker.execute("BEGIN IMMEDIATE")
    try:
        session = ResilientSQLiteSession(str(db_file))
        try:
            t0 = time.monotonic()
            # Re-assigning the unchanged DC/address must be a no-op and never block.
            session._update_session_table()
            # Even when an actual write hits the lock on the running loop, it must return quickly.
            session.set_dc(4, "149.154.167.92", 443)
            elapsed = time.monotonic() - t0
            assert elapsed < 2.0
        finally:
            session.close()
    finally:
        locker.rollback()
        locker.close()
