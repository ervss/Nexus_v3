from sqlalchemy import create_engine, select

from app.database import Video
from app.main import _gallery_source_filter_clause


def _matching_sources(selected_sources, videos):
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE videos (source_url VARCHAR, tags VARCHAR)"
        )
        connection.exec_driver_sql(
            "INSERT INTO videos (source_url, tags) VALUES (?, ?)",
            videos,
        )
        rows = connection.execute(
            select(Video.source_url, Video.tags).where(
                _gallery_source_filter_clause(selected_sources)
            )
        ).all()
    engine.dispose()
    return rows


def test_source_filter_matches_hostname_and_not_substrings():
    videos = [
        ("https://t.me/channel/123", ""),
        ("https://www.t.me/channel/456", ""),
        ("https://gofile.io/d/abc", "gofile.io"),
        ("https://example.com/watch?t.me/channel", "twitch, extension"),
        ("https://example.com/watch", "gofile.io"),
    ]

    matches = _matching_sources(["T"], videos)

    assert matches == videos[:2]


def test_source_filter_matches_complete_tag_tokens():
    videos = [
        ("https://example.com/one", "twitch, extension"),
        ("https://example.com/two", "T, extension"),
        ("https://example.com/three", "extension, t"),
    ]

    matches = _matching_sources(["T"], videos)

    assert matches == videos[1:]
