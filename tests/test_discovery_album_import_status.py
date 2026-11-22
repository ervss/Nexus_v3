from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, ImportJobItem, Video
from app.main import DuplicateCheckRequest, discovery_hub_import_status


def test_status_uses_exact_file_and_latest_job_not_batch_name():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as db:
        first = Video(url='https://cdn.test/one.mp4', source_url='https://bunkr.cr/f/one', status='ready')
        db.add(first)
        db.flush()
        db.add_all([
            ImportJobItem(job_id=11, url='https://cdn.test/one.mp4', source_url='https://bunkr.cr/f/one', status='imported', video_id=first.id),
            ImportJobItem(job_id=12, url='https://cdn.test/two.mp4', source_url='https://bunkr.cr/f/two', status='failed', error='timeout'),
            ImportJobItem(job_id=13, url='https://cdn.test/one.mp4', source_url='https://bunkr.cr/f/one', status='duplicate', video_id=first.id),
            ImportJobItem(job_id=14, url='https://bunkr.cr/f/missing', status='imported', video_id=999),
        ])
        db.commit()
        result = discovery_hub_import_status(DuplicateCheckRequest(urls=[
            'https://bunkr.cr/f/one', 'https://bunkr.cr/f/two', 'https://bunkr.cr/f/missing', 'https://bunkr.cr/f/new'
        ]), db=db, auth=True)['matches']
        assert result['https://bunkr.cr/f/one']['status'] == 'duplicate'
        assert result['https://bunkr.cr/f/one']['job_id'] == 13
        assert result['https://bunkr.cr/f/one']['in_dashboard'] is True
        assert result['https://bunkr.cr/f/two']['error'] == 'timeout'
        assert result['https://bunkr.cr/f/missing']['status'] == 'unverified'
        assert 'https://bunkr.cr/f/new' not in result
    engine.dispose()
