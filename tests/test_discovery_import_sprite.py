import asyncio
import base64
import io

from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, ImportJobEvent, ImportJobItem, Video
from app import intake


def test_discovery_sprite_survives_queue_and_worker(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(intake, '_existing_normalized_urls', lambda db: set())
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, autoflush=False)
    monkeypatch.setattr(intake, 'SessionLocal', sessions)
    image = Image.new('RGB', (5120, 180), 'red')
    buffer = io.BytesIO()
    image.save(buffer, format='JPEG')
    data = 'data:image/jpeg;base64,' + base64.b64encode(buffer.getvalue()).decode()
    with sessions() as db:
        job = intake.create_import_job(intake.IntakeImportRequest(
            candidates=[intake.IntakeCandidate(url='https://bunkr.cr/f/test', discovery_sprite=data)],
            auto_metadata=False), db)
        item = db.query(ImportJobItem).filter_by(job_id=job.id).one()
        event = db.query(ImportJobEvent).filter_by(item_id=item.id, event_type='discovery_sprite').one()
        path = event.payload['sprite_path']
        item_id = item.id
        assert (tmp_path / 'app' / path.lstrip('/')).is_file()
    worker = intake.IntakeWorker()
    async def ignore_progress(*args):
        pass
    monkeypatch.setattr(worker, '_emit_progress', ignore_progress)
    asyncio.run(worker._process_item_inner(item_id))
    with sessions() as db:
        assert db.query(Video).one().sprite_path == path
        assert db.get(ImportJobItem, item_id).status == 'imported'
    assert intake._store_discovery_sprite('data:image/jpeg;base64,invalid') == ''
    engine.dispose()
