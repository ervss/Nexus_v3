from pathlib import Path

from PIL import Image

from app.database import Video
from app import maintenance as m


def _save_jpeg(path: Path, size: tuple[int, int], quality: int = 92) -> None:
    # Noise ensures the fixture is not accidentally below the byte threshold.
    image = Image.effect_noise(size, 100).convert("RGB")
    image.save(path, "JPEG", quality=quality)


def test_thumbnail_quality_marks_small_preview_as_poor(tmp_path: Path, monkeypatch):
    image = tmp_path / "small.jpg"
    _save_jpeg(image, (320, 180))
    monkeypatch.setattr(m, "_video_path_from_static", lambda _: str(image))

    result = m.thumbnail_quality(Video(thumbnail_path="/static/thumbnails/small.jpg"))

    assert result["status"] == "poor"
    assert result["label"] == "SLABÝ"
    assert m._is_poor_thumbnail(Video(thumbnail_path="/static/thumbnails/small.jpg"))


def test_thumbnail_quality_marks_large_preview_as_high(tmp_path: Path, monkeypatch):
    image = tmp_path / "sharp.jpg"
    _save_jpeg(image, (1280, 720))
    monkeypatch.setattr(m, "_video_path_from_static", lambda _: str(image))

    result = m.thumbnail_quality(Video(thumbnail_path="/static/thumbnails/sharp.jpg"))

    assert result["status"] == "high"
    assert result["label"] == "HQ"
    assert not m._is_poor_thumbnail(Video(thumbnail_path="/static/thumbnails/sharp.jpg"))


def test_thumbnail_quality_leaves_remote_poster_unverified():
    result = m.thumbnail_quality(Video(thumbnail_path="https://cdn.example/preview.jpg"))
    assert result["status"] == "unknown"
