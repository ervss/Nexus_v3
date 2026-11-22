import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.database import ImportJob, ImportJobItem, SourceBoard, Video
from app.routers.source_boards import _board_counts, board_video_ids


def test_board_resolves_jobs_and_duplicates_without_matching_unrelated_jobs():
    engine = create_engine('sqlite:///:memory:')
    for table in (SourceBoard.__table__, Video.__table__, ImportJob.__table__, ImportJobItem.__table__):
        table.create(engine)
    with Session(engine) as db:
        board = SourceBoard(id=1, name='Album', slug='album', batch_name='Album', source_url='https://filester.me/f/one', last_sync_at=datetime.datetime(2026, 1, 1, 0, 0, 10))
        db.add(board)
        db.add_all([Video(id=1, url='https://file/one', source_url='https://file/one', batch_name='Album · job #1'),
                    Video(id=2, url='https://cdn/two', source_url='https://file/two', batch_name='Other'),
                    Video(id=3, url='https://file/three', source_url='https://file/three', batch_name='Album · job #2'),
                    Video(id=4, url='https://file/four', source_url='https://file/four', batch_name='Album · job #3')])
        db.add_all([ImportJob(id=1, batch_name='Album · job #1', created_at=datetime.datetime(2026, 1, 1)),
                    ImportJob(id=2, batch_name='Album · job #2', created_at=datetime.datetime(2026, 1, 2)),
                    ImportJob(id=3, batch_name='Album · job #3', created_at=datetime.datetime(2026, 1, 1, 0, 0, 11))])
        db.add_all([ImportJobItem(job_id=1, url='https://file/one', source_url=board.source_url, status='imported', video_id=1),
                    ImportJobItem(job_id=1, url='https://file/two', source_url=board.source_url, status='duplicate'),
                    ImportJobItem(job_id=2, url='https://file/three', source_url='https://filester.me/f/other', status='imported', video_id=3),
                    ImportJobItem(job_id=3, url='https://file/four', source_url='https://file/four', status='imported', video_id=4)])
        db.commit()
        assert board_video_ids(db, board) == {1, 2}
        assert _board_counts(db, board)[0] == 2


def test_explicit_board_job_includes_items_from_other_sources():
    engine = create_engine('sqlite:///:memory:')
    for table in (SourceBoard.__table__, Video.__table__, ImportJob.__table__, ImportJobItem.__table__):
        table.create(engine)
    with Session(engine) as db:
        board = SourceBoard(id=1, name='Album', slug='album', batch_name='Album', source_url='https://folder')
        db.add_all([board, Video(id=1, url='https://file', batch_name='Album · job #1'),
                    ImportJob(id=1, batch_name='Album · job #1', options={'source_board_id': 1}),
                    ImportJobItem(job_id=1, url='https://file', source_url='https://file', status='imported', video_id=1)])
        db.commit()
        assert board_video_ids(db, board) == {1}
