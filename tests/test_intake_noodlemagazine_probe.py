from types import SimpleNamespace

from app.intake import _needs_noodlemagazine_duration_probe


def test_long_noodlemagazine_stream_gets_background_duration_probe():
    video = SimpleNamespace(
        source_url="https://noodlemagazine.com/watch/-1_2",
        url="https://cdn.pvvstream.pro/video.mp4",
        duration=120,
    )

    assert _needs_noodlemagazine_duration_probe(video)


def test_short_or_non_noodle_stream_does_not_get_probe():
    short_noodle = SimpleNamespace(
        source_url="https://noodlemagazine.com/watch/-1_2",
        url="https://cdn.pvvstream.pro/video.mp4",
        duration=30,
    )
    other_source = SimpleNamespace(
        source_url="https://www.eporner.com/video/test/",
        url="https://cdn.example/video.mp4",
        duration=120,
    )

    assert not _needs_noodlemagazine_duration_probe(short_noodle)
    assert not _needs_noodlemagazine_duration_probe(other_source)
