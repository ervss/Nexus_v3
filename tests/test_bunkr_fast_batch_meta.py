import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app import mp4_probe
from app.extractors import bunkr
from app.routers import link_tester


PAGE = "https://bunkr.cr/f/example"
STREAM = "https://cdn.example/video.mp4"
COMPLETE = {"duration": 120, "size": 12_000_000, "width": 1920, "height": 1080}


def test_complete_metadata_cache_hit_skips_network_and_semaphore(monkeypatch):
    monkeypatch.setattr(link_tester, "mp4_probe_cache_get", Mock(return_value=COMPLETE))
    extract = AsyncMock(side_effect=AssertionError("cache hit must not resolve"))
    probe = AsyncMock(side_effect=AssertionError("cache hit must not probe"))
    monkeypatch.setattr(link_tester._bunkr_extractor, "extract", extract)
    monkeypatch.setattr(link_tester, "probe_mp4_cached", probe)

    async def run():
        return await asyncio.wait_for(
            link_tester._fetch_bunkr_meta(PAGE, asyncio.Semaphore(0), metadata_only=True),
            timeout=1,
        )

    result = asyncio.run(run())
    assert result["cached"] is True
    assert result["duration"] == 120
    assert result["quality"] == "1080p"
    assert result["bitrate_bps"] == 800_000
    assert result["stream_url"] == ""
    extract.assert_not_awaited()
    probe.assert_not_awaited()


@pytest.mark.parametrize("missing", ["duration", "size", "width", "height"])
def test_incomplete_metadata_cache_falls_through(monkeypatch, missing):
    partial = {**COMPLETE, missing: 0}
    monkeypatch.setattr(link_tester, "mp4_probe_cache_get", Mock(return_value=partial))
    extract = AsyncMock(return_value={"stream_url": STREAM})
    probe = AsyncMock(return_value=COMPLETE)
    monkeypatch.setattr(link_tester._bunkr_extractor, "extract", extract)
    monkeypatch.setattr(link_tester, "probe_mp4_cached", probe)

    result = asyncio.run(link_tester._fetch_bunkr_meta(
        PAGE, asyncio.Semaphore(1), metadata_only=True,
    ))
    extract.assert_awaited_once_with(PAGE, metadata_only=True)
    probe.assert_awaited_once()
    assert result["duration"] == 120
    assert result["stream_url"] == STREAM


def test_normal_tester_metadata_still_resolves_full_fields(monkeypatch):
    monkeypatch.setattr(link_tester, "mp4_probe_cache_get",
                        Mock(side_effect=AssertionError("normal mode must resolve")))
    extract = AsyncMock(return_value={
        "stream_url": STREAM, "title": "Real title", "thumbnail": "cover.jpg",
    })
    monkeypatch.setattr(link_tester._bunkr_extractor, "extract", extract)
    monkeypatch.setattr(link_tester, "probe_mp4_cached", AsyncMock(return_value=COMPLETE))

    result = asyncio.run(link_tester._fetch_bunkr_meta(PAGE, asyncio.Semaphore(1)))
    extract.assert_awaited_once_with(PAGE)
    assert result["title"] == "Real title"
    assert result["thumbnail"] == "cover.jpg"
    assert result["stream_url"] == STREAM


def test_metadata_only_successful_api_skips_html(monkeypatch):
    extractor = bunkr.BunkrExtractor()
    ntc_mock = AsyncMock(side_effect=AssertionError("no HTML needed"))
    monkeypatch.setattr(bunkr, "ntc_get", ntc_mock)
    api = AsyncMock(return_value=STREAM)
    monkeypatch.setattr(extractor, "_api_resolve", api)

    result = asyncio.run(extractor.extract(PAGE, metadata_only=True))
    assert result["stream_url"] == STREAM
    api.assert_awaited_once()
    ntc_mock.assert_not_awaited()


@pytest.mark.parametrize("api_url", [None, "https://cdn.example/images/cover.jpg"])
def test_metadata_only_api_failure_keeps_html_fallback(monkeypatch, api_url):
    extractor = bunkr.BunkrExtractor()
    html = ('<title>Real title - Bunkr</title>'
            '<script>var jsCDN = "https://cdn.example/video.mp4";</script>')
    ntc_mock = AsyncMock(return_value=html)
    monkeypatch.setattr(bunkr, "ntc_get", ntc_mock)
    monkeypatch.setattr(extractor, "_api_resolve", AsyncMock(return_value=api_url))

    result = asyncio.run(extractor.extract(PAGE, metadata_only=True))
    assert result["stream_url"] == STREAM
    assert result["title"] == "Real title"
    ntc_mock.assert_awaited_once()


def test_full_extraction_keeps_html_even_with_successful_api(monkeypatch):
    extractor = bunkr.BunkrExtractor()
    html = '<title>Real title - Bunkr</title><meta property="og:image" content="cover.jpg"><time datetime="2026-10-02">2 October</time>'
    ntc_mock = AsyncMock(return_value=html)
    monkeypatch.setattr(bunkr, "ntc_get", ntc_mock)
    monkeypatch.setattr(extractor, "_api_resolve", AsyncMock(return_value=STREAM))

    result = asyncio.run(extractor.extract(PAGE))
    assert result["title"] == "Real title"
    assert result["thumbnail"] == "cover.jpg"
    assert result["stream_url"] == STREAM
    assert result["upload_date"] == "2026-10-02"
    ntc_mock.assert_awaited_once()


def test_full_metadata_preserves_extracted_date(monkeypatch):
    monkeypatch.setattr(link_tester._bunkr_extractor, "extract", AsyncMock(return_value={"stream_url": STREAM, "upload_date": "2026-10-02"}))
    monkeypatch.setattr(link_tester, "probe_mp4_cached", AsyncMock(return_value=COMPLETE))
    result = asyncio.run(link_tester._fetch_bunkr_meta(PAGE, asyncio.Semaphore(1)))
    assert result["upload_date"] == "2026-10-02"


def test_cached_fast_metadata_keeps_listing_date(monkeypatch):
    monkeypatch.setattr(link_tester, "mp4_probe_cache_get", Mock(return_value=COMPLETE))
    monkeypatch.setattr(link_tester, "_listing_meta_get", Mock(return_value={"upload_date": "2026-10-02"}))
    result = asyncio.run(link_tester._fetch_bunkr_meta(PAGE, asyncio.Semaphore(0), metadata_only=True))
    assert result["upload_date"] == "2026-10-02"


def test_50_url_fast_batch_uses_cache_without_network(monkeypatch):
    urls = [f"https://bunkr.cr/f/file{i}" for i in range(50)]
    cache = Mock(return_value=COMPLETE)
    monkeypatch.setattr(link_tester, "mp4_probe_cache_get", cache)
    extract = AsyncMock(side_effect=AssertionError("cached batch must not resolve"))
    monkeypatch.setattr(link_tester._bunkr_extractor, "extract", extract)
    monkeypatch.setattr(link_tester.httpx, "AsyncClient",
                        Mock(side_effect=AssertionError("Bunkr batch needs no generic client")))

    result = asyncio.run(link_tester.batch_meta(
        link_tester.BatchMetaRequest(urls=urls, metadata_only=True),
    ))
    assert result["total"] == result["ok"] == 50
    assert result["failed"] == 0
    assert [row["url"] for row in result["results"]] == urls
    assert all(row["cached"] for row in result["results"])
    assert cache.call_count == 50
    extract.assert_not_awaited()


@pytest.mark.parametrize("metadata_only", [False, True])
def test_batch_forwards_requested_mode(monkeypatch, metadata_only):
    fetch = AsyncMock(return_value={"url": PAGE, "ok": True})
    monkeypatch.setattr(link_tester, "_fetch_any_meta", fetch)
    request = link_tester.BatchMetaRequest(urls=["https://example.com/video.mp4"],
                                         metadata_only=metadata_only)
    result = asyncio.run(link_tester.batch_meta(request))
    assert result["ok"] == 1
    assert fetch.await_args.kwargs["metadata_only"] is metadata_only
    assert isinstance(fetch.await_args.kwargs["filester_semaphore"], asyncio.Semaphore)
    assert link_tester.BatchMetaRequest(urls=[PAGE]).metadata_only is False


@pytest.mark.parametrize("missing", ["duration", "size", "width", "height"])
def test_incomplete_mp4_cache_is_reprobed(monkeypatch, missing):
    monkeypatch.setattr(mp4_probe, "cache_get", Mock(return_value={**COMPLETE, missing: 0}))
    probe = AsyncMock(return_value=COMPLETE)
    monkeypatch.setattr(mp4_probe, "probe_mp4", probe)
    put = Mock()
    monkeypatch.setattr(mp4_probe, "cache_put", put)

    assert asyncio.run(mp4_probe.probe_mp4_cached(PAGE, STREAM)) == COMPLETE
    probe.assert_awaited_once()
    put.assert_called_once()
