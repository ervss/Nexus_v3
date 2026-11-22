import asyncio

from app.database import Video
from app.extractors.cyberfile import CyberFileExtractor
from app.maintenance import (
    _fresh_stream_for_thumb,
    _is_serial_thumb_cdn,
    _thumb_probe_positions,
)


def test_serial_cdn_treats_cyberfile_as_fragile():
    assert _is_serial_thumb_cdn("https://cyberfile.me/abcd")
    assert _is_serial_thumb_cdn("https://p1.cyberfile.me/x/clip.mp4?download_token=a")
    assert not _is_serial_thumb_cdn("https://example.com/clip.mp4")


def test_unknown_duration_on_cyberfile_uses_one_early_probe():
    probes = _thumb_probe_positions(0.0, "https://cyberfile.me/abcd")
    assert probes == [1.5]


def test_fresh_stream_resolves_cyberfile_page_before_ffmpeg(monkeypatch):
    video = Video(
        id=71,
        url="https://cyberfile.me/abcd",
        source_url="https://cyberfile.me/abcd",
    )
    seen = {}

    async def fake_extract(self, url):
        seen["url"] = url
        return {"stream_url": "https://p1.cyberfile.me/x/clip.mp4?download_token=fresh"}

    monkeypatch.setattr(CyberFileExtractor, "extract", fake_extract)
    stream, referer = asyncio.run(_fresh_stream_for_thumb(video))

    assert seen["url"] == "https://cyberfile.me/abcd"
    assert stream == "https://p1.cyberfile.me/x/clip.mp4?download_token=fresh"
    assert referer == "https://cyberfile.me/"
