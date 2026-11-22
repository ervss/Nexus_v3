from pathlib import Path

from app.database import Video
from app.maintenance import _local_video_file_path


def test_local_rethumb_resolves_file_url(tmp_path: Path):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"not a real video")
    video = Video(url=source.as_uri(), storage_type="local_direct")
    assert Path(_local_video_file_path(video)) == source


def test_local_rethumb_resolves_uploaded_static_path(tmp_path: Path, monkeypatch):
    # Static uploads are browser URLs but must resolve to app/static on disk.
    source = tmp_path / "uploaded.mp4"
    source.write_bytes(b"not a real video")
    video = Video(url="/static/local_videos/uploaded.mp4", storage_type="local")
    monkeypatch.setattr("app.maintenance._video_path_from_static", lambda _: str(source))
    assert _local_video_file_path(video) == str(source)
