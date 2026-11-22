import asyncio
import subprocess
from types import SimpleNamespace

import pytest

from app.database import Video
from app import maintenance as m
from app.extractors.bunkr import BunkrExtractor


def test_album_identity_beats_duplicate_title():
    key = "df3beefd-14af-49a8-951c-6c2228451955"
    video = Video(url=f"https://cdn.cr/{key}.mp4", title="1.mp4")
    items = [dict(url="https://bunkr.cr/f/right", thumb=f"https://img/{key}.png", title="1.mp4"),
             dict(url="https://bunkr.cr/f/wrong", thumb="https://img/other.png", title="1.mp4")]
    assert m._match_bunkr_album_item(video, items).endswith("/right")
    video.url = "https://cdn.cr/no-identity.mp4"
    assert m._match_bunkr_album_item(video, items) == ""


def test_album_resolution_saves_durable_file_page(monkeypatch):
    m._BUNKR_ALBUM_LISTINGS.clear()
    video = Video(id=999, source_url="https://bunkr.cr/a/album", url="https://x.cdn.cr/old.mp4", title="unique.mp4")
    async def album(self, url, **kwargs):
        assert kwargs["listing_only"]
        return [dict(url="https://bunkr.cr/f/file", title="unique.mp4")]
    async def extract(self, url):
        assert url == "https://bunkr.cr/f/file"
        return {"stream_url": "https://x.cdn.cr/fresh.mp4"}
    monkeypatch.setattr(BunkrExtractor, "extract_album", album)
    monkeypatch.setattr(BunkrExtractor, "extract", extract)
    assert asyncio.run(m._fresh_stream_for_thumb(video))[0].endswith("fresh.mp4")
    assert video.source_url.endswith("/f/file")


def test_album_shared_bucket_uuid_is_not_file_identity():
    bucket = "c7a9b5d3-1e4f-4c82-a6d8-3b7e9f0c2a1d"
    video = Video(url="https://media.cdn.cr/clip-KGKiQSUT.mp4?token=expired",
                  original_thumbnail_url=f"https://static.scdn.st/{bucket}/thumbs/clip-KGKiQSUT.png",
                  title="clip.mp4")
    items = [dict(url="https://bunkr.cr/f/right", title="clip.mp4",
                  thumb=f"https://static.scdn.st/{bucket}/thumbs/clip-KGKiQSUT.png"),
             dict(url="https://bunkr.cr/f/wrong", title="other.mp4",
                  thumb=f"https://static.scdn.st/{bucket}/thumbs/other-12345678.png")]
    assert m._match_bunkr_album_item(video, items).endswith("/right")
    video.url = "https://media.cdn.cr/missing.mp4"
    video.original_thumbnail_url = f"https://static.scdn.st/{bucket}/thumbs/missing.png"
    video.title = "missing.mp4"
    assert m._match_bunkr_album_item(video, items) == ""


@pytest.mark.parametrize("status,retries", [(410, 1), (429, 1)])
def test_generic_ffmpeg_4xx_is_verified_and_other_seeks_stop(monkeypatch, tmp_path, status, retries):
    video = Video(id=998, url="https://x.cdn.cr/old.mp4", source_url="https://bunkr.cr/f/file", duration=100)
    calls = []
    async def fresh(video):
        return "https://x.cdn.cr/fresh.mp4", "https://bunkr.cr/"
    async def http_status(*args):
        return status
    async def run(*args, **kwargs):
        calls.append(args)
        return False, "Server returned 4XX Client Error, but not one of 40{0,1,3,4}"
    monkeypatch.setattr(m, "_fresh_stream_for_thumb", fresh)
    monkeypatch.setattr(m, "_thumb_http_status", http_status)
    # Keep asyncio scheduling real: replacing global sleep also affects curl's
    # live background loop and can turn its maintenance task into a busy loop.
    monkeypatch.setattr(m, "_run_thumb_process", run)
    assert not asyncio.run(m._generate_thumb_from_stream(video, str(tmp_path)))
    assert len(calls) == retries  # No repeated retry cycle at all five seek positions.
    assert str(status) in m._THUMB_FAIL_DETAIL[video.id]
    assert m._is_rate_limited(m._THUMB_FAIL_DETAIL[video.id]) == (status == 429)


def test_ambiguous_ffmpeg_4xx_is_not_assumed_to_be_rate_limit():
    assert not m._is_rate_limited("Server returned 4XX Client Error, but not one of 40{0,1,3,4}")


def test_duplicate_start_is_rejected_before_background_task_runs(monkeypatch):
    monkeypatch.setattr(m, "_SMART_THUMB_RUNNING", False)
    monkeypatch.setattr(m, "_SMART_THUMB_PENDING", False)
    assert m.reserve_smart_rethumb()
    assert not m.reserve_smart_rethumb()
    m.release_smart_rethumb_reservation()


def test_auto_rethumb_tick_reserves_the_worker(monkeypatch):
    calls = []

    async def fake_worker(db, limit):
        calls.append(limit)
        return {"status": "ok"}

    class FakeDb:
        def close(self):
            calls.append("closed")

    monkeypatch.setattr(m, "smart_rethumb_worker", fake_worker)
    monkeypatch.setattr("app.database.SessionLocal", lambda: FakeDb())
    monkeypatch.setattr(m, "_SMART_THUMB_RUNNING", False)
    monkeypatch.setattr(m, "_SMART_THUMB_PENDING", False)

    assert asyncio.run(m.auto_smart_rethumb_tick(limit=1)) == {
        "status": "completed", "scanned": 0, "improved": 0, "failed": 0,
        "skipped": 0, "batches": 1,
    }
    assert calls == [100, "closed"]
    assert not m._SMART_THUMB_PENDING


def test_auto_rethumb_tick_continues_until_final_short_batch(monkeypatch):
    calls = []
    results = iter([
        {"scanned": 100, "improved": 98, "failed": 2, "skipped": 0},
        {"scanned": 17, "improved": 17, "failed": 0, "skipped": 0},
    ])

    async def fake_worker(db, limit):
        calls.append(limit)
        return next(results)

    class FakeDb:
        def close(self):
            pass

    monkeypatch.setattr(m, "smart_rethumb_worker", fake_worker)
    monkeypatch.setattr("app.database.SessionLocal", lambda: FakeDb())
    monkeypatch.setattr(m, "_SMART_THUMB_RUNNING", False)
    monkeypatch.setattr(m, "_SMART_THUMB_PENDING", False)

    result = asyncio.run(m.auto_smart_rethumb_tick())
    assert calls == [100, 100]
    assert result == {"status": "completed", "scanned": 117, "improved": 115,
                      "failed": 2, "skipped": 0, "batches": 2}
    assert m.reserve_smart_rethumb()
    m.release_smart_rethumb_reservation()


def test_timeout_returns_explained_failure(monkeypatch, tmp_path):
    video = Video(id=997)
    async def expired(*args):
        raise asyncio.TimeoutError()
    monkeypatch.setattr(m, "_generate_thumb_from_stream_impl", expired)
    assert not asyncio.run(m._generate_thumb_from_stream(video, str(tmp_path)))
    assert "150" in m._THUMB_FAIL_DETAIL[video.id]


def test_erome_rethumb_refreshes_matching_stream_and_uses_source_referer(monkeypatch):
    from app.extractors.erome import EromeExtractor

    source_page = "https://www.erome.com/a/example"
    refreshed = "https://v55.erome.com/4688/0PE9UxMb/XqbWgY9k_720p.mp4?fresh=1"

    async def entries(self, url):
        assert url == source_page
        return [
            {"stream_url": "https://v55.erome.com/4688/other/wrong_720p.mp4"},
            {"stream_url": refreshed},
        ]

    monkeypatch.setattr(EromeExtractor, "extract_album_entries", entries)
    video = Video(
        id=10396,
        url="https://v55.erome.com/4688/0PE9UxMb/XqbWgY9k_720p.mp4",
        source_url=source_page,
    )

    assert asyncio.run(m._fresh_stream_for_thumb(video)) == (refreshed, source_page)
    headers = m._thumb_request_headers(refreshed, source_page)
    assert headers["Referer"] == source_page


def test_erome_rethumb_does_not_guess_between_unmatched_album_streams(monkeypatch):
    from app.extractors.erome import EromeExtractor

    async def entries(self, url):
        return [
            {"stream_url": "https://v55.erome.com/a/first.mp4"},
            {"stream_url": "https://v55.erome.com/a/second.mp4"},
        ]

    monkeypatch.setattr(EromeExtractor, "extract_album_entries", entries)
    video = Video(
        id=10397,
        url="https://v55.erome.com/a/missing.mp4",
        source_url="https://www.erome.com/a/example",
    )
    m._THUMB_FAIL_DETAIL.pop(video.id, None)

    assert asyncio.run(m._fresh_stream_for_thumb(video)) == ("", "")
    assert "jednoznačne" in m._THUMB_FAIL_DETAIL[video.id]
