import asyncio
from unittest.mock import AsyncMock

from app.routers import link_tester
from tests.test_eporner_playlists import WATCH_HTML


def test_batch_meta_routes_all_eporner_links_through_one_paced_lane(monkeypatch):
    seen = []

    async def fetch(url, client, semaphore, bunkr_semaphore, *, metadata_only=False, **_kw):
        seen.append((url, semaphore))
        return {"url": url, "ok": True}

    monkeypatch.setattr(link_tester, "_fetch_any_meta", fetch)
    urls = [
        "https://www.eporner.com/video-a/example/",
        "https://eporner.com/video-b/example/",
        "https://example.com/video.mp4",
    ]

    result = asyncio.run(link_tester.batch_meta(link_tester.BatchMetaRequest(urls=urls)))

    assert result["ok"] == 3
    assert isinstance(seen[0][1], link_tester.EpornerPacer)
    assert seen[0][1] is seen[1][1]
    assert not isinstance(seen[2][1], link_tester.EpornerPacer)


def test_batch_meta_listed_sizes_skip_the_slow_pacer(monkeypatch):
    seen = []

    async def fetch(url, client, semaphore, bunkr_semaphore, *, metadata_only=False, **_kw):
        seen.append((url, semaphore, metadata_only))
        return {"url": url, "ok": True}

    monkeypatch.setattr(link_tester, "_fetch_any_meta", fetch)
    urls = [
        "https://www.eporner.com/video-a/example/",
        "https://eporner.com/video-b/example/",
    ]
    result = asyncio.run(link_tester.batch_meta(
        link_tester.BatchMetaRequest(urls=urls, metadata_only=True),
    ))

    assert result["ok"] == 2
    assert seen[0][2] is True
    assert not isinstance(seen[0][1], link_tester.EpornerPacer)
    assert seen[0][1] is seen[1][1]


def test_eporner_listed_meta_parses_watch_html_without_resolve(monkeypatch):
    monkeypatch.setattr("app.eporner_playlist_index._load_video_meta", lambda key: None)
    monkeypatch.setattr(link_tester, "_ntc_page", AsyncMock(return_value=(200, WATCH_HTML, "https://example.com/video")))

    class FakeResp:
        status_code = 200
        text = WATCH_HTML

    class FakeClient:
        async def get(self, url, headers=None):
            return FakeResp()

    result = asyncio.run(link_tester._fetch_eporner_listed_meta(
        "https://www.eporner.com/video-abc/clip/",
        FakeClient(),
        asyncio.Semaphore(4),
    ))
    assert result["ok"] is True
    assert result["size_mb"] == 2744.2
    assert result["duration"] == 90
    assert not result["stream_url"]


def test_eporner_failure_retries_once_after_shared_backoff(monkeypatch):
    first = {"url": "https://eporner.com/video-a/example/", "status": "error"}
    second = {"url": "https://eporner.com/video-a/example/", "status": "success"}
    resolve = AsyncMock(side_effect=[first, second])
    sleep = AsyncMock()
    monkeypatch.setattr(link_tester, "_resolve_single_url_inner", resolve)
    monkeypatch.setattr(link_tester.asyncio, "sleep", sleep)
    monkeypatch.setattr(link_tester, "EPORNER_RETRY_ATTEMPTS", 2)
    monkeypatch.setattr(link_tester, "_EPORNER_NEXT_START", 0.0)

    result = asyncio.run(link_tester.resolve_single_url(
        first["url"], link_tester.EpornerPacer(min_gap_seconds=0),
    ))

    assert result is second
    assert resolve.await_count == 2
    sleep.assert_awaited_once_with(8.0)


def test_fast_meta_fetches_missing_fields_instead_of_reusing_playlist_title(monkeypatch, tmp_path):
    from app import eporner_playlist_index as index
    monkeypatch.setattr(index, "VIDEO_META_DIR", tmp_path)
    monkeypatch.setattr(index, "_VIDEO_META", {})
    monkeypatch.setattr(link_tester, "_listing_meta_get", lambda url: {"title": "Card", "duration": 90})
    page = AsyncMock(return_value=(200, WATCH_HTML, ""))
    resolve = AsyncMock(side_effect=AssertionError("Fast meta must never resolve a stream"))
    monkeypatch.setattr(link_tester, "_ntc_page", page)
    monkeypatch.setattr(link_tester, "resolve_single_url", resolve)
    urls = [f"https://www.eporner.com/video-fasttest{i}/clip/" for i in range(40)]

    result = asyncio.run(link_tester.batch_meta(
        link_tester.BatchMetaRequest(urls=urls, metadata_only=True)))
    assert result["ok"] == 40
    assert page.await_count == 40
    assert all(row["size_bytes"] > 0 and row["upload_date"] for row in result["results"])
    assert all(not row["stream_url"] for row in result["results"])
    resolve.assert_not_awaited()

    # A second pass reuses full metadata without any HTTP work.
    page.reset_mock()
    result = asyncio.run(link_tester.batch_meta(
        link_tester.BatchMetaRequest(urls=urls, metadata_only=True)))
    assert result["ok"] == 40
    assert all(row.get("cached") for row in result["results"])
    page.assert_not_awaited()


def test_fast_meta_does_not_treat_date_only_cache_as_complete(monkeypatch):
    monkeypatch.setattr("app.eporner_playlist_index._load_video_meta", lambda key: {"upload_date": "2026-10-01"})
    page = AsyncMock(return_value=(200, WATCH_HTML, ""))
    monkeypatch.setattr(link_tester, "_ntc_page", page)
    result = asyncio.run(link_tester._fetch_eporner_listed_meta(
        "https://www.eporner.com/video-partial/clip/", None, asyncio.Semaphore(4)))
    assert result["size_bytes"] > 0
    page.assert_awaited_once()
