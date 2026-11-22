from pathlib import Path


def test_combined_album_index_stops_before_expensive_file_enrichment():
    """The combined-workbench route must expose the generator's base listing only."""
    source = Path("app/main.py").read_text(encoding="utf-8")
    start = source.index('async def discovery_hub_album_files_index')
    end = source.index('@api_v1_router.get("/discovery-hub/album-files-stream")', start)
    route = source[start:end]

    assert 'async for ev in _album_files_events(url, limit=0)' in route
    assert 'if ev["type"] == "base"' in route
    assert '"pending_metadata"' in route
    assert 'stream_url' not in route


def test_album_base_listing_does_not_open_each_file_page():
    extractor = Path("app/extractors/bunkr.py").read_text(encoding="utf-8")
    events = Path("app/main.py").read_text(encoding="utf-8")

    assert 'async def extract_album(self, url: str, *, listing_only: bool = False)' in extractor
    assert 'if results and not listing_only:' in extractor
    assert 'extractor.extract_album(url, listing_only=True)' in events


def test_combined_view_preserves_sources_and_exposes_duplicate_inspection():
    source = Path("app/static/main.js").read_text(encoding="utf-8")

    assert 'source_album_titles' in source
    assert 'albumViewerDetectDuplicates()' in source
    assert "albumViewerRefetchMeta('all')" in source
    assert "if (scope === 'all')" in source
    assert "refetchActive" in source
    assert "ev.type === 'start' || ev.type === 'progress'" in source


def test_refetch_stream_reports_liveness_before_first_completed_probe():
    source = Path("app/main.py").read_text(encoding="utf-8")

    assert '"type": "start"' in source
    assert '"type": "progress"' in source
    assert "asyncio.wait(" in source


def test_full_fetch_prefers_per_file_cdn_size_over_listing_size():
    source = Path("app/main.py").read_text(encoding="utf-8")
    route = source[source.index('async def discovery_hub_refetch_meta'):]

    assert route.index("if size_b:") < route.index('elif result.get("size")')
    assert 'data["size_verified"] = True' in route


def test_full_album_enrichment_probes_missing_video_dimensions_for_quality():
    source = Path("app/main.py").read_text(encoding="utf-8")
    start = source.index('async def _album_files_events')
    end = source.index('@api_v1_router.get("/discovery-hub/album-files")', start)
    events = source[start:end]

    assert 'not duration or not result.get("height")' in events
    assert '"quality": _quality(title) or item.get("quality") or _h2q(h)' in events


def test_refetch_considers_duration_and_resolution_independently():
    source = Path("app/static/main.js").read_text(encoding="utf-8")
    start = source.index('albumViewerIsMissingMeta(i)')
    end = source.index('albumViewerMissingMetaCount()', start)
    method = source[start:end]

    assert '(!(i.duration > 0) || !(i.height > 0))' in method


def test_combined_view_can_filter_back_to_an_original_album():
    source = Path("app/static/main.js").read_text(encoding="utf-8")

    assert "sourceAlbumFilter: 'all'" in source
    assert 'albumViewerSourceAlbumFileCount(albumUrl)' in source
    assert "av.sourceAlbumFilter !== 'all'" in source
