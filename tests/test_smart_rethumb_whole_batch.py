from datetime import datetime

from fastapi import BackgroundTasks
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import maintenance
from app.database import Video
from app.routers import maintenance_endpoints as endpoints


def test_whole_batch_skips_hd_and_completed_and_has_no_300_video_limit(monkeypatch):
    engine = create_engine('sqlite://')
    Video.__table__.create(engine)
    sessions = sessionmaker(bind=engine)
    with sessions() as db:
        db.add_all([Video(id=i, batch_name='Batch A', url=f'https://example.test/{i}.mp4')
                    for i in range(1, 306)])
        db.add(Video(id=400, batch_name='Batch B', url='https://example.test/400.mp4'))
        db.get(Video, 2).smart_rethumb_at = datetime.utcnow()
        db.commit()
    monkeypatch.setattr(endpoints, 'SessionLocal', sessions)
    monkeypatch.setattr(endpoints, 'thumbnail_quality',
                        lambda v: {'status': 'high' if v.id == 1 else 'ok'})
    monkeypatch.setattr(maintenance, '_SMART_THUMB_RUNNING', False)
    monkeypatch.setattr(maintenance, '_SMART_THUMB_PENDING', False)
    tasks = BackgroundTasks()
    try:
        result = endpoints.smart_rethumb_batch_route(
            tasks, endpoints.RethumbBatchBody(batch_name='Batch A', all_batch=True, skip_hd=True))
        assert result['status'] == 'started'
        assert result['count'] == 303
        assert result['skipped_done'] == 2
        assert len(tasks.tasks) == 1
    finally:
        maintenance.release_smart_rethumb_reservation()
        engine.dispose()
