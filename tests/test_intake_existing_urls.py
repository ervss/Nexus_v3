from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, DiscoveredVideo, Video
from app.intake import _existing_normalized_urls


def test_existing_urls_streams_and_normalizes_both_library_sources():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[Video.__table__, DiscoveredVideo.__table__])
    session = sessionmaker(bind=engine)()
    try:
        session.add(Video(
            title="one",
            url="HTTPS://Example.com/video/?utm_source=test",
            source_url="https://example.com/watch/1#player",
        ))
        session.add(DiscoveredVideo(
            title="two",
            url="https://cdn.example.com/two.mp4",
            source_url="https://example.com/watch/2/",
        ))
        session.commit()

        urls = _existing_normalized_urls(session)

        assert "https://example.com/video?utm_source=test" in urls
        assert "https://example.com/watch/1" in urls
        assert "https://cdn.example.com/two.mp4" in urls
        assert "https://example.com/watch/2" in urls
    finally:
        session.close()
