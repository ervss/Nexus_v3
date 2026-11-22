import asyncio
from unittest.mock import AsyncMock

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, Video, DiscoveredVideo, ImportJobItem
from app.routers.vk import import_videos, ImportVideosRequest
from app import intake


def test_vk_import_persists_work_and_reuses_shell(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    monkeypatch.setattr(intake.intake_worker, "start", lambda: None)
    discovered = DiscoveredVideo(url="https://vk.com/video-1_2", title="VK test", imported=False)
    db.add(discovered)
    db.commit()
    request = ImportVideosRequest(discovered_ids=[discovered.id])
    result = asyncio.run(import_videos(request, db))
    assert result["imported_count"] == 1
    video_id = discovered.video_id
    item = db.query(ImportJobItem).one()
    assert item.video_id == video_id and item.status == "pending"
    assert asyncio.run(import_videos(request, db))["imported_count"] == 0
    assert db.query(Video).count() == 1
    assert db.query(ImportJobItem).count() == 1

    # A persisted item must process its linked card, not discard it as a duplicate.
    monkeypatch.setattr(intake, "SessionLocal", factory)
    worker = intake.IntakeWorker()
    async def process(vid, force=False):
        assert vid == video_id and force
        with factory() as other:
            video = other.get(Video, vid)
            video.status = "ready_to_stream"
            video.duration = 123
            other.commit()
    worker._processor.process_single_video = process
    worker._emit_progress = AsyncMock()
    asyncio.run(worker._process_item_inner(item.id))
    db.expire_all()
    assert db.get(ImportJobItem, item.id).status == "imported"
    assert db.query(Video).count() == 1
    assert db.get(Video, video_id).duration == 123
    # A timeout/failure must leave a visible error instead of an endless pending card.
    video = db.get(Video, video_id)
    video.status = "pending"
    item.attempts = item.max_attempts
    db.commit()
    worker._mark_failed_or_retry(item.id, TimeoutError("VK timed out"))
    db.expire_all()
    assert db.get(ImportJobItem, item.id).status == "failed"
    assert db.get(Video, video_id).status == "error"
    assert "VK timed out" in db.get(Video, video_id).error_msg
    db.close()
    engine.dispose()
