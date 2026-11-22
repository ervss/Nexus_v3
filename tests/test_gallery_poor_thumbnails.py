from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.database import Video, VideoSource
from app.main import get_videos


def test_poor_thumbnail_filter_precedes_pagination_and_combines_with_batch():
    engine = create_engine('sqlite://')
    Video.__table__.create(engine)
    VideoSource.__table__.create(engine)
    with Session(engine) as db:
        db.add_all([
            Video(id=1, title='Missing one', duration=10, batch_name='A', thumbnail_path=''),
            Video(id=2, title='Unknown remote', duration=10, batch_name='A', thumbnail_path='https://example.test/image.jpg'),
            Video(id=3, title='Missing two', duration=10, batch_name='A', thumbnail_path='/static/placeholder.jpg'),
            Video(id=4, title='Other batch', duration=10, batch_name='B', thumbnail_path=''),
        ])
        db.commit()
        first = get_videos(page=1, limit=1, batch='A', poor_thumb_only=True, db=db)
        second = get_videos(page=2, limit=1, batch='A', poor_thumb_only=True, db=db)
        third = get_videos(page=3, limit=1, batch='A', poor_thumb_only=True, db=db)
        assert [v['id'] for v in first] == [3]
        assert [v['id'] for v in second] == [1]
        assert third == []
