import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from app import services
from app.config import config


def test_batch_timeout_releases_slot_and_marks_retryable(monkeypatch):
    video = SimpleNamespace(status='pending', error_msg='', preview_retry_needed=False)
    db = MagicMock()
    db.query.return_value.filter.return_value.count.return_value = 0
    db.query.return_value.filter.return_value.first.return_value = video
    monkeypatch.setattr(services, 'SessionLocal', lambda: db)
    monkeypatch.setattr(config, 'INTAKE_ITEM_TIMEOUT_SECONDS', 1)
    processor = services.VIPVideoProcessor()
    async def stuck(_video_id):
        await asyncio.sleep(10)
    processor.process_single_video = stuck
    processor._broadcast_status = AsyncMock()
    asyncio.run(processor.process_batch([123]))
    assert video.status == 'error'
    assert video.preview_retry_needed is True
    assert 'timed out' in video.error_msg
    db.commit.assert_called()
    processor._broadcast_status.assert_awaited_once()
