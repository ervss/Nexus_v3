import pytest


@pytest.fixture(autouse=True)
def _isolate_fast_thumb(monkeypatch, tmp_path):
    """Staré testy mockujú ffmpeg; rýchla Range cesta je v nich vypnutá a stav úloh ide do tmp."""
    from app import fast_thumb
    from app import maintenance
    from app.streaming import playback_control
    monkeypatch.setattr(playback_control, 'control', playback_control.PlaybackControl())
    monkeypatch.setattr(maintenance, '_THUMB_HOST_RETRY_AT', {})
    monkeypatch.setenv("NEXUS_FAST_THUMB", "0")
    monkeypatch.setenv("NEXUS_THUMB_JOBS_DB", str(tmp_path / "thumb_jobs.db"))
    monkeypatch.setenv("NEXUS_THUMB_CACHE_DIR", str(tmp_path / "frame_cache"))
    fast_thumb.reset_store()
    fast_thumb.CACHE.clear()
    yield
    fast_thumb.reset_store()
