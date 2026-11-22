from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app import telegram_discovery as discovery


@pytest.fixture
def sessions(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'discovery.db'}")
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr(discovery, "SessionLocal", factory)
    yield factory
    engine.dispose()


def test_only_public_usernames_and_result_profile_links():
    assert discovery.username("https://t.me/s/example_channel") == "example_channel"
    assert discovery.username("https://evil.test/example_channel") is None
    assert discovery.username("https://t.me/+privateInvite") is None
    parser = discovery.ChannelLinks()
    parser.feed('<a href="https://t.me/tgstat_bot">bot</a><a href="/channel/@real_channel">result</a>')
    assert parser.names == ["real_channel"]


@pytest.mark.asyncio
async def test_submit_rejects_concurrent_and_resume_preserves_checkpoint(sessions, monkeypatch):
    worker = discovery.DiscoveryWorker()
    monkeypatch.setattr(worker, "start", AsyncMock())
    payload = dict(keywords="news", date_from="2026-01-01", max_joins=2, delay=5, manual_channels=[])
    await worker.submit(payload.copy())
    with pytest.raises(ValueError): await worker.submit(payload.copy())
    state = discovery.status(); state.update(status="failed", phase="process", channels=[{"username":"test_channel", "state":"indexing", "cursor":123}])
    discovery.save(state)
    resumed = await worker.submit({**payload, "resume": True})
    assert resumed["channels"][0]["cursor"] == 123
    assert resumed["status"] == "running"


@pytest.mark.asyncio
async def test_index_recent_page_commits_cursor_and_stops_at_date(sessions, monkeypatch):
    worker = discovery.DiscoveryWorker()
    state = dict(status="running", phase="process", date_from="2026-01-01", delay=5, max_joins=3,
        channels=[{"username":"test_channel", "state":"indexing", "cursor":0}], messages_indexed=0, failed=0, log=[])
    discovery.save(state)
    entity = SimpleNamespace(id=42, username="test_channel", title="Test")
    connection = SimpleNamespace(get_entity=AsyncMock(return_value=entity))
    monkeypatch.setattr(discovery, "client", AsyncMock(return_value=connection))
    messages = [SimpleNamespace(id=5, date=datetime(2026, 2, 1, tzinfo=timezone.utc)), SimpleNamespace(id=3, date=datetime(2025, 1, 1, tzinfo=timezone.utc))]
    monkeypatch.setattr(discovery, "_get_messages", AsyncMock(return_value=messages))
    monkeypatch.setattr(discovery, "_row", lambda msg, entity, name: {"message_id":msg.id})
    def upsert(db, rows, commit):
        db.execute(text("CREATE TABLE IF NOT EXISTS test_media (id INTEGER)"))
        for row in rows: db.execute(text("INSERT INTO test_media VALUES (:id)"), {"id": row["message_id"]})
    monkeypatch.setattr(discovery, "upsert_telegram_media_batch", upsert)
    await worker.step(state)
    persisted = discovery.status()
    assert persisted["channels"][0]["cursor"] == 3
    assert persisted["channels"][0]["state"] == "done"
    assert persisted["messages_indexed"] == 1
    with sessions() as db: assert db.execute(text("SELECT id FROM test_media")).scalars().all() == [5]


@pytest.mark.asyncio
async def test_failed_index_write_does_not_advance_cursor(sessions, monkeypatch):
    state = dict(status="running", phase="process", date_from="2026-01-01", delay=5, max_joins=3,
        channels=[{"username":"test_channel", "state":"indexing", "cursor":44}], messages_indexed=0, failed=0, log=[])
    discovery.save(state)
    entity = SimpleNamespace(id=42, username="test_channel")
    monkeypatch.setattr(discovery, "client", AsyncMock(return_value=SimpleNamespace(get_entity=AsyncMock(return_value=entity))))
    monkeypatch.setattr(discovery, "_get_messages", AsyncMock(return_value=[SimpleNamespace(id=33, date=datetime(2026, 2, 1, tzinfo=timezone.utc))]))
    monkeypatch.setattr(discovery, "_row", lambda *args: {"message_id":33})
    def fail(*args, **kwargs): raise RuntimeError("disk error")
    monkeypatch.setattr(discovery, "upsert_telegram_media_batch", fail)
    await discovery.DiscoveryWorker().step(state)
    assert discovery.status()["channels"][0]["cursor"] == 44
    assert discovery.status()["status"] == "failed"


def test_api_validation_and_status(sessions, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers.telegram import router
    from app.auth import check_auth
    application = FastAPI()
    application.include_router(router, prefix="/api")
    application.dependency_overrides[check_auth] = lambda: True
    monkeypatch.setattr(discovery.worker, "start", AsyncMock())
    http = TestClient(application)
    assert http.get("/api/telegram/discover/status").json()["status"] == "idle"
    assert http.post("/api/telegram/discover", json={"date_from":"2026-01-01"}).status_code == 400
    assert http.post("/api/telegram/discover", json={"date_from":"2026-01-01", "manual_channels":["https://t.me/+private"]}).status_code == 400
    response = http.post("/api/telegram/discover", json={"date_from":"2026-01-01", "manual_channels":["@example_channel"]})
    assert response.status_code == 200 and response.json()["status"] == "running"
    assert http.post("/api/telegram/discover", json={"date_from":"2026-01-01", "keywords":"test"}).status_code == 409


@pytest.mark.asyncio
async def test_indexed_video_is_immediately_searchable(tmp_path, monkeypatch):
    from app import database
    from app.telegram_index import search_telegram_fts
    from telethon.tl.types import DocumentAttributeVideo, DocumentAttributeFilename
    engine = create_engine(f"sqlite:///{tmp_path / 'fts.db'}")
    monkeypatch.setattr(database, "engine", engine)
    database.init_db()
    with engine.begin() as conn:
        if not conn.execute(text("SELECT 1 FROM sqlite_master WHERE name='telegram_media_fts'")).scalar():
            conn.execute(text("CREATE VIRTUAL TABLE telegram_media_fts USING fts5(title, caption, file_name, channel, author)"))
            conn.execute(text("""CREATE TRIGGER telegram_media_ai AFTER INSERT ON telegram_media_index BEGIN
                INSERT INTO telegram_media_fts(rowid,title,caption,file_name,channel,author)
                VALUES(new.id,new.title,new.caption,new.file_name,new.channel,new.author); END"""))
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr(discovery, "SessionLocal", factory)
    state = dict(status="running", phase="process", date_from="2026-01-01", delay=5, max_joins=3,
        channels=[{"username":"test_channel", "state":"indexing", "cursor":0}], messages_indexed=0, failed=0, log=[])
    discovery.save(state)
    entity = SimpleNamespace(id=42, username="test_channel", title="Test")
    msg = SimpleNamespace(id=7, date=datetime(2026, 2, 1, tzinfo=timezone.utc), message="unique discoveryneedle", views=0, forwards=0,
        document=SimpleNamespace(id=9, mime_type="video/mp4", size=1024, thumbs=[], attributes=[DocumentAttributeVideo(duration=30, w=1280, h=720), DocumentAttributeFilename(file_name="clip.mp4")]))
    monkeypatch.setattr(discovery, "client", AsyncMock(return_value=SimpleNamespace(get_entity=AsyncMock(return_value=entity))))
    monkeypatch.setattr(discovery, "_get_messages", AsyncMock(return_value=[msg]))
    await discovery.DiscoveryWorker().step(state)
    with factory() as db:
        assert search_telegram_fts(db, "discoveryneedle")[0]["message_id"] == 7
    engine.dispose()
