import asyncio
import json
from unittest.mock import Mock


def test_large_album_pipelines_resolve_and_probe_without_detail_pages(monkeypatch):
    from app import bunkr_cache, database, main, mp4_probe
    from app.extractors.bunkr import BunkrExtractor

    count = 120
    album_url = "https://bunkr.cr/a/turbo-test"
    rows = [
        {
            "url": f"https://bunkr.cr/f/video-{i}.mp4",
            "title": f"video-{i}.mp4",
            "thumb": f"https://thumbs.example/{i}.jpg",
            "size": "10 MB",
        }
        for i in range(count)
    ]
    monkeypatch.setattr(BunkrExtractor, "extract_album", _async_return(rows))
    monkeypatch.setattr(bunkr_cache, "album_snapshot_get", lambda *_: None)
    monkeypatch.setattr(bunkr_cache, "album_snapshot_put", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(bunkr_cache, "album_put", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(bunkr_cache, "file_meta_get", lambda *_: None)
    monkeypatch.setattr(bunkr_cache, "file_meta_put", lambda *_: None)
    monkeypatch.setattr(bunkr_cache, "file_meta_flush", lambda: None)

    class EmptyDb:
        def execute(self, *_args, **_kwargs):
            return self

        def fetchall(self):
            return []

    def fake_db():
        yield EmptyDb()

    monkeypatch.setattr(database, "get_db", fake_db)

    active_resolves = 0
    peak_resolves = 0
    probe_during_resolve = False
    full_page_calls = 0

    async def fake_extract(self, url, *, metadata_only=False):
        nonlocal active_resolves, peak_resolves, full_page_calls
        if not metadata_only:
            full_page_calls += 1
        active_resolves += 1
        peak_resolves = max(peak_resolves, active_resolves)
        await asyncio.sleep(0.01)
        active_resolves -= 1
        return {"title": "slug", "stream_url": url.replace("bunkr.cr/f", "cdn.example")}

    async def fake_probe(*_args, **kwargs):
        nonlocal probe_during_resolve
        assert kwargs["persist"] is False
        probe_during_resolve |= active_resolves > 0
        await asyncio.sleep(0.025)
        return {"duration": 60, "size": 10_000_000, "width": 1920, "height": 1080}

    monkeypatch.setattr(BunkrExtractor, "extract", fake_extract)
    monkeypatch.setattr(mp4_probe, "probe_mp4_cached", fake_probe)
    flush = Mock()
    monkeypatch.setattr(mp4_probe, "cache_flush", flush)

    async def run():
        events = []
        async for event in main._album_files_events(album_url):
            events.append(event)
        return events

    events = asyncio.run(run())
    assert events[0]["type"] == "base" and events[0]["total"] == count
    patches = [event for event in events if event["type"] == "patch"]
    assert len(patches) == count
    assert all(event["data"]["duration"] == 60 for event in patches)
    assert peak_resolves == 12
    assert probe_during_resolve
    assert full_page_calls == 0
    flush.assert_called_once()


def _async_return(value):
    async def implementation(*_args, **_kwargs):
        return value
    return implementation


def test_mp4_probe_batch_persists_all_results_once(monkeypatch):
    from app import mp4_probe

    cache_path = Mock()
    monkeypatch.setattr(mp4_probe, "_CACHE_PATH", cache_path)
    monkeypatch.setattr(mp4_probe, "_cache", {})
    monkeypatch.setattr(mp4_probe, "_cache_loaded", True)
    monkeypatch.setattr(mp4_probe, "_cache_dirty", False)

    for i in range(120):
        mp4_probe.cache_put(f"file-{i}", 60, 10_000_000, 1920, 1080, persist=False)
    cache_path.write_text.assert_not_called()

    mp4_probe.cache_flush()
    cache_path.write_text.assert_called_once()
    assert len(json.loads(cache_path.write_text.call_args.args[0])) == 120
    assert mp4_probe._cache_dirty is False
