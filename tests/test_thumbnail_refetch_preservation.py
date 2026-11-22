import asyncio

from app import services


def test_failed_visual_regeneration_keeps_existing_thumbnail(tmp_path, monkeypatch):
    """A stream refetch must not blank an already visible Gallery card."""
    monkeypatch.setattr(services, "THUMB_DIR", str(tmp_path))
    monkeypatch.setattr(services.shutil, "which", lambda _command: "ffmpeg")

    async def failed_ffmpeg(*_args, **_kwargs):
        return 1, b"", b"expired stream token"

    monkeypatch.setattr(services, "run_subprocess_capture", failed_ffmpeg)
    original = tmp_path / "thumb_42.jpg"
    original_bytes = b"previous-valid-thumbnail" * 40
    original.write_bytes(original_bytes)

    asyncio.run(
        services.VIPVideoProcessor()._generate_visuals(
            "https://cdn.example/video.mp4?fresh_token=1", 42, 0
        )
    )

    assert original.read_bytes() == original_bytes
    assert not (tmp_path / "thumb_42.next.jpg").exists()
