from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app import database, telegram_catalog as catalog, telegram_service
from app.telegram_index import search_telegram_fts, upsert_telegram_media_batch


@pytest.fixture
def sessions(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'catalog.db'}")
    monkeypatch.setattr(database, 'engine', engine)
    database.init_db()
    # init_db also performs legacy migrations; create FTS for a fresh database
    # if this deployment only initializes it when upgrading an existing one.
    with engine.begin() as conn:
        if not conn.execute(text("SELECT 1 FROM sqlite_master WHERE name='telegram_media_fts'")).scalar():
            conn.execute(text('CREATE VIRTUAL TABLE telegram_media_fts USING fts5(title, caption, file_name, channel, author)'))
            conn.execute(text('''CREATE TRIGGER telegram_media_ai AFTER INSERT ON telegram_media_index BEGIN
                INSERT INTO telegram_media_fts(rowid,title,caption,file_name,channel,author)
                VALUES(new.id,new.title,new.caption,new.file_name,new.channel,new.author); END'''))
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr(catalog, 'SessionLocal', factory)
    yield factory
    engine.dispose()


def add_channel(db, peer='-10042', **kwargs):
    row = database.TelegramCatalogChannel(peer_id=peer, title=peer, **kwargs)
    db.add(row)
    db.commit()
    return row


def message(id, caption='clip'):
    from telethon.tl.types import DocumentAttributeVideo, DocumentAttributeFilename
    return SimpleNamespace(id=id, message=caption, date=None, views=0, forwards=0,
        document=SimpleNamespace(id=id + 100, mime_type='video/mp4', size=1024,
            thumbs=[], attributes=[DocumentAttributeVideo(duration=30, w=1280, h=720),
                                   DocumentAttributeFilename(file_name='example.mp4')]))


ENTITY = SimpleNamespace(id=42, username='sample', title='Sample')


def test_atomic_checkpoint_replay_and_full_text(sessions):
    with sessions() as db:
        add_channel(db)
        caption = 'x ' * 400 + 'needleatend'
        catalog.apply_page(db, '-10042', [message(10, caption)], ENTITY, mode='history')
        catalog.apply_page(db, '-10042', [message(10, caption)], ENTITY, mode='history')
        assert db.query(database.TelegramMediaIndex).count() == 1
        assert db.get(database.TelegramCatalogChannel, '-10042').cursor == 10
        assert search_telegram_fts(db, 'needleatend', chat_ids=[42])[0]['message_id'] == 10
        assert search_telegram_fts(db, 'needleatend', chat_ids=[99]) == []
        assert not db.get(database.TelegramCatalogChannel, '-10042').complete
        catalog.apply_page(db, '-10042', [], ENTITY, mode='history')
        assert db.get(database.TelegramCatalogChannel, '-10042').complete


def test_new_videos_exclude_library_before_pagination_and_only_joined(sessions):
    from app.telegram_index import upsert_telegram_media_batch
    with sessions() as db:
        add_channel(db, '-10042', username='sample')
        add_channel(db, '-10043')
        add_channel(db, '-10044', active=False)
        upsert_telegram_media_batch(db, [
            {'chat_id': chat, 'message_id': mid, 'date': f'2026-01-{mid:02d}'}
            for chat, mid in [(42, 1), (42, 2), (42, 3), (42, 4), (43, 5), (44, 6)]
        ])
        db.add_all([
            database.Video(url='/api/v1/telegram/stream/42/4', telegram_chat_id='-10042', telegram_message_id=4),
            database.Video(url='https://t.me/c/42/3'),
            database.Video(source_url='https://t.me/sample/2'),
        ])
        db.commit()
        first = search_telegram_fts(db, 'ignored', limit=1, new_only=True, chat_ids=[42], min_duration=999)
        second = search_telegram_fts(db, '', limit=1, new_only=True, before_date=first[-1]['date'], before_id=first[-1]['_catalog_id'])
        assert [(v['chat_id'], v['message_id']) for v in first + second] == [(43, 5), (42, 1)]
        db.add(database.Video(telegram_chat_id='43', telegram_message_id=5))
        db.commit()
        assert [v['message_id'] for v in search_telegram_fts(db, '', new_only=True)] == [1]


def test_failed_commit_does_not_advance_cursor(sessions, monkeypatch):
    with sessions() as db:
        add_channel(db)
        def fail():
            raise RuntimeError('disk full')
        monkeypatch.setattr(db, 'commit', fail)
        with pytest.raises(RuntimeError):
            catalog.apply_page(db, '-10042', [message(10)], ENTITY, mode='history')
        db.rollback()
    with sessions() as db:
        assert db.get(database.TelegramCatalogChannel, '-10042').cursor == 0
        assert db.query(database.TelegramMediaIndex).count() == 0


def test_breadth_first_then_history_and_priority(sessions):
    worker = catalog.CatalogWorker()
    with sessions() as db:
        add_channel(db, '-10042', scanned=200, head_id=1000, last_sync=10**12)
        add_channel(db, '-10043', scanned=100)
        add_channel(db, '-10044', scanned=0, priority=1)
        assert worker.next_channel(db)[0].peer_id == '-10044'
        db.get(database.TelegramCatalogChannel, '-10044').scanned = 200
        assert worker.next_channel(db)[0].peer_id == '-10043'
        db.get(database.TelegramCatalogChannel, '-10043').scanned = 200
        # Completed recent pass; backfill remains available.
        assert worker.next_channel(db)[1] == 'history'


@pytest.mark.asyncio
async def test_resume_uses_persisted_offset_and_pause(sessions, monkeypatch):
    connection = SimpleNamespace(get_entity=AsyncMock(return_value=ENTITY))
    monkeypatch.setattr(catalog, 'client', AsyncMock(return_value=connection))
    fetch = AsyncMock(return_value=[message(400)])
    monkeypatch.setattr(catalog, '_get_messages', fetch)
    with sessions() as db:
        add_channel(db, cursor=500, scanned=100)
        job = catalog.control(db)
        job.enabled = True
        job.discovered_at = 10**12
        db.commit()
    await catalog.CatalogWorker().step()
    assert fetch.call_args.kwargs['offset_id'] == 500
    with sessions() as db:
        assert db.get(database.TelegramCatalogChannel, '-10042').cursor == 400
    catalog.set_enabled(False)
    await catalog.CatalogWorker().step()
    assert fetch.await_count == 1


def test_recent_reconciliation_preserves_unseen_archive(sessions):
    with sessions() as db:
        row = add_channel(db)
        catalog.apply_page(db, '-10042', [message(n) for n in (10, 20, 30, 40)], ENTITY, mode='history')
        row.refresh_target = 20
        row.head_id = 40
        catalog.apply_page(db, '-10042', [message(30, 'edited'), message(20)], ENTITY, mode='refresh')
        ids = {m.message_id for m in db.query(database.TelegramMediaIndex)}
        assert ids == {10, 20, 30}  # deleted recent 40, untouched archive 10
        assert row.refresh_cursor == 0
        assert db.query(database.TelegramMediaIndex).filter_by(message_id=30).one().caption == 'edited'


@pytest.mark.asyncio
async def test_background_flood_wait_keeps_full_duration(monkeypatch):
    from telethon.errors import FloodWaitError
    monkeypatch.setattr(telegram_service, '_SEARCH_COOLDOWN', 0)
    monkeypatch.setattr(telegram_service, '_SEARCH_SEM', None)
    connection = SimpleNamespace(get_messages=AsyncMock(side_effect=FloodWaitError(request=None, capture=3600)))
    with pytest.raises(FloodWaitError):
        await telegram_service._get_messages(connection, ENTITY, _background=True)
    import time
    assert telegram_service._SEARCH_COOLDOWN - time.monotonic() > 3590
    assert connection.get_messages.await_count == 1


def test_status_counts_real_index_and_restart_control(sessions):
    with sessions() as db:
        add_channel(db, total=50)
        add_channel(db, peer='-10099', total=20, scanned=8, active=False)
        catalog.apply_page(db, '-10042', [message(1)], ENTITY, mode='history')
        upsert_telegram_media_batch(db, [{'chat_id': 99, 'message_id': 2, 'title': 'inactive'}])
    catalog.set_enabled(True, ['-10042'])
    with sessions() as db:
        status = catalog.catalog_status(db)
        assert status['enabled']
        assert status['indexed'] == 2
        assert status['indexed_active'] == 1
        assert status['indexed_inactive'] == 1
        assert status['scanned'] == 1
        assert status['channels'][0]['indexed'] == 1
        assert status['channels'][0]['scanned'] == 1
        assert status['channels'][0]['priority']
        assert status['channels'][0]['last_post_at'] is not None


def test_refresh_never_starves_backfill(sessions):
    worker = catalog.CatalogWorker()
    with sessions() as db:
        add_channel(db, scanned=200, head_id=500, last_sync=0)
        modes = [worker.next_channel(db)[1] for _ in range(10)]
        assert modes.count('history') == 8
        assert modes.count('refresh') == 2


@pytest.mark.asyncio
async def test_empty_completed_channel_is_checked_for_new_videos(sessions, monkeypatch):
    connection = SimpleNamespace(get_entity=AsyncMock(return_value=ENTITY))
    monkeypatch.setattr(catalog, 'client', AsyncMock(return_value=connection))
    monkeypatch.setattr(catalog, '_get_messages', AsyncMock(side_effect=[[message(10)], []]))
    with sessions() as db:
        add_channel(db, complete=True, head_id=0, last_sync=0)
        job = catalog.control(db)
        job.enabled = True
        job.discovered_at = 10**12
        job.rate = 10
        db.commit()
        status = catalog.catalog_status(db)
        assert status['state'] == 'maintaining'
        assert status['videos_per_minute'] == 0
        assert status['eta_seconds'] is None
    worker = catalog.CatalogWorker()
    await worker.step()
    await worker.step()
    with sessions() as db:
        channel = db.get(database.TelegramCatalogChannel, '-10042')
        assert channel.head_id == 10
        assert channel.refresh_cursor == 0
        assert channel.last_sync > 0
        assert db.query(database.TelegramMediaIndex).count() == 1


def test_authenticated_api_local_search_and_control(sessions, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers.telegram import router
    from app.auth import check_auth
    from app.database import get_db
    app = FastAPI()
    app.include_router(router)
    def db_dependency():
        with sessions() as db:
            yield db
    app.dependency_overrides[get_db] = db_dependency
    app.dependency_overrides[check_auth] = lambda: True
    monkeypatch.setattr(catalog.worker, 'start', AsyncMock())
    with sessions() as db:
        add_channel(db)
        catalog.apply_page(db, '-10042', [message(7, 'findable')], ENTITY, mode='history')
    client = TestClient(app)
    result = client.get('/telegram/catalog/search?query=findable&chat_ids=-10042').json()
    assert result['videos'][0]['message_id'] == 7
    assert result['coverage']['indexed'] == 1
    assert client.get('/telegram/catalog/search?query=findable&chat_ids=-10099').json()['videos'] == []
    assert client.get('/telegram/catalog/search?chat_ids=invalid').status_code == 400
    assert client.post('/telegram/catalog', json={'enabled': True}).json()['enabled']
    assert not client.post('/telegram/catalog', json={'enabled': False}).json()['enabled']


def test_reconcile_desynced_channels_repairs_wiped_index(sessions):
    with sessions() as db:
        add_channel(db, '-10077', total=5000, scanned=4800, cursor=10, complete=True)
        add_channel(db, '-10078', total=50, scanned=50, cursor=0, complete=True)
        upsert_telegram_media_batch(db, [
            {'chat_id': 77, 'message_id': 4950, 'title': 'Recent A'},
            {'chat_id': 77, 'message_id': 4980, 'title': 'Recent B'},
        ] + [{'chat_id': 78, 'message_id': i, 'title': f'Full {i}'} for i in range(1, 51)])

        repaired = catalog.reconcile_desynced_channels(db)
        db.commit()
        assert repaired == 1
        ch77 = db.get(database.TelegramCatalogChannel, '-10077')
        ch78 = db.get(database.TelegramCatalogChannel, '-10078')
        assert ch77.complete is False
        assert ch77.cursor == 4950
        assert ch77.scanned == 2
        assert ch78.complete is True
        assert ch78.scanned == 50
