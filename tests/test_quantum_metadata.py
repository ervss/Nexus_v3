import asyncio
from unittest.mock import AsyncMock

import pytest
from app.routers import link_tester
from app.hubs import registry


def test_size_probe_runs_when_duration_and_height_are_already_known(monkeypatch):
    class Response:
        headers = {'content-range': 'bytes 0-0/2000000'}
    client = type('Client', (), {'get': AsyncMock(return_value=Response())})()
    monkeypatch.setattr(link_tester, '_probe_mp4_http', AsyncMock(return_value={}))
    meta = {'ok': True, 'stream_url': 'https://cdn.example/video.mp4', 'height': 720, 'duration': 60}
    asyncio.run(link_tester._enrich_duration_height(meta, client, 'https://example.com/'))
    assert meta['size_bytes'] == 2000000


def test_quantum_camwhores_defers_watch_requests_to_full_metadata(monkeypatch):
    from app.search_engine import ExternalSearchEngine
    engine = ExternalSearchEngine.__new__(ExternalSearchEngine)
    search = AsyncMock(return_value=[{'title': 'Example', 'source': 'Camwhores',
                                    'url': 'https://www.camwhores.tv/videos/1/example/'}])
    monkeypatch.setattr(engine, 'search_camwhores_async', search)
    rows = asyncio.run(engine._run_single_discovery_source('example', 'camwhores',
                         expand_variants=False, enrich=False))
    assert rows
    search.assert_awaited_once_with('example', result_limit=60, enrich_quality=False)


@pytest.mark.parametrize('source', ['porntrex', 'whoreshub'])
def test_search_retains_listing_duration(source, monkeypatch):
    from app.search_engine import ExternalSearchEngine
    from app import porntrex_discovery, whoreshub_discovery
    module = porntrex_discovery if source == 'porntrex' else whoreshub_discovery
    monkeypatch.setattr(module, f'scrape_{source}_discovery', lambda **kwargs: [{
        'title': 'Example', 'url': f'https://{source}.com/video/1/',
        'duration': 2159, 'quality': '1080p', 'upload_date': '2026-10-01',
    }])
    engine = ExternalSearchEngine.__new__(ExternalSearchEngine)
    rows = asyncio.run(getattr(engine, f'search_{source}_async')('example', result_limit=4))
    assert rows[0]['duration'] == 2159
    assert rows[0]['upload_date'] == '2026-10-01'


def test_porntrex_duration_ignores_tag_timestamps_and_keeps_relative_date(monkeypatch):
    from app.hubs.porntrex import PornTrexHub
    monkeypatch.setenv('HUB_DETAIL_CACHE', '0')
    hub = PornTrexHub()
    monkeypatch.setattr(hub, '_get_html', AsyncMock(return_value=(200, '''
        <h1>Example</h1><div class="video-info">
        <a href="/tags/example/">0:02</a>
        <em class="badge">4 weeks ago</em><em class="badge">35min 59sec</em>
        <a>MP4 1080p, 200.5 Mb</a></div>''', 'https://porntrex.com/video/1/example/')))
    meta = asyncio.run(hub._detail_metadata('https://porntrex.com/video/1/example/'))
    assert meta['duration_sec'] == 2159
    assert meta['upload_date'] == '4 weeks ago'
    assert meta['height'] == 1080
    assert meta['size_mb'] == 200.5


@pytest.mark.parametrize('host', ['porntrex.com', 'whoreshub.com'])
def test_tester_fast_meta_uses_watch_metadata_without_playback(host, monkeypatch):
    url = f'https://www.{host}/videos/123/example/'
    hub = type('Hub', (), {})()
    hub._detail_metadata = AsyncMock(return_value={
        'duration_sec': 1234, 'quality': '1080p', 'height': 1080,
        'size_mb': 200.5, 'upload_date': '2026-10-01',
    })
    monkeypatch.setattr(registry, 'init_hubs', lambda: None)
    monkeypatch.setattr(registry, 'get', lambda source: hub)
    resolver = AsyncMock(side_effect=AssertionError('Playback should not be resolved'))
    monkeypatch.setattr(link_tester, 'resolve_single_url', resolver)
    sem = asyncio.Semaphore(1)
    row = asyncio.run(link_tester._fetch_any_meta(url, None, sem, sem, metadata_only=True))
    assert row['ok']
    assert row['duration'] == 1234
    assert row['size_bytes'] == round(200.5 * 1048576)
    assert row['upload_date'] == '2026-10-01'
    assert row['quality'] == '1080p'
    resolver.assert_not_called()


def test_watch_fetch_failure_returns_retryable_error(monkeypatch):
    hub = type('Hub', (), {})()
    hub._detail_metadata = AsyncMock(side_effect=RuntimeError('HTTP 503'))
    monkeypatch.setattr(registry, 'init_hubs', lambda: None)
    monkeypatch.setattr(registry, 'get', lambda source: hub)
    sem = asyncio.Semaphore(1)
    row = asyncio.run(link_tester._fetch_any_meta('https://whoreshub.com/videos/1/test/', None, sem, sem, metadata_only=True))
    assert row['ok'] is False
    assert row['error'] == 'HTTP 503'


@pytest.mark.parametrize('source,host', [
    ('porntrex', 'porntrex.com'), ('whoreshub', 'whoreshub.com'),
    ('xhamster', 'xhamster.com'), ('xvideos', 'xvideos.com'),
    ('noodlemagazine', 'noodlemagazine.com'), ('camwhores', 'camwhores.tv'),
    ('pimpbunny', 'pimpbunny.com'),
])
def test_full_meta_routes_and_normalizes_provider_fields(source, host, monkeypatch):
    url = f'https://www.{host}/videos/123/full-meta/'
    metadata = {'duration_sec': 2159, 'quality': '1080p', 'height': 1080,
                'size_mb': 200.5, 'added': '2026-10-01', 'size_estimated': True}
    hub = type('Hub', (), {})()
    hub.enrich = AsyncMock(return_value={url: metadata})
    hub._detail_metadata = AsyncMock(return_value=metadata)
    monkeypatch.setattr(link_tester, '_FULL_CARD_META', {})
    monkeypatch.setattr(registry, 'init_hubs', lambda: None)
    monkeypatch.setattr(registry, 'get', lambda key: hub if key == source else None)
    sem = asyncio.Semaphore(1)
    row = asyncio.run(link_tester._fetch_any_meta(url, None, sem, sem, metadata_only=True, full_metadata=True))
    assert row['ok']
    assert row['duration'] == 2159
    assert row['upload_date'] == '2026-10-01'
    assert row['size_bytes'] == round(200.5 * 1048576)
    assert row['size_estimated'] is True
    if source == 'xhamster':
        hub.enrich.assert_awaited_once_with([url], deep=True)
    elif source in {'xvideos', 'noodlemagazine'}:
        hub.enrich.assert_awaited_once_with([url])
    elif source == 'camwhores':
        hub._detail_metadata.assert_awaited_once_with(url, deep=True)
    else:
        hub._detail_metadata.assert_awaited_once_with(url)


@pytest.mark.parametrize('host', ['tv.leakporner.com', 'tv.mypornerleak.com'])
def test_leak_metadata_uses_watch_page_without_resolving_player(host, monkeypatch):
    from app.extractors.leakporner import LeakPornerExtractor

    url = f'https://{host}/example/'
    html = '''<meta property="og:title" content="Example">
        <meta property="og:image" content="/poster.jpg">
        <meta itemprop="duration" content="P0DT0H5M0S">
        <meta itemprop="uploadDate" content="2026-05-14T08:25:00+08:00">'''
    monkeypatch.setattr(LeakPornerExtractor, '_fetch_native_watch_page', AsyncMock(return_value=(html, url)))
    resolver = AsyncMock(side_effect=AssertionError('Playback should not be resolved'))
    monkeypatch.setattr(link_tester, 'resolve_single_url', resolver)

    sem = asyncio.Semaphore(1)
    row = asyncio.run(link_tester._fetch_any_meta(url, None, sem, sem, metadata_only=True, full_metadata=True))
    assert row['ok']
    assert row['duration'] == 300
    assert row['upload_date'] == '2026-05-14'
    assert row['thumbnail'] == f'https://{host}/poster.jpg'
    assert row['height'] == row['size_bytes'] == 0
    resolver.assert_not_called()


def test_pornone_uses_current_video_and_actual_source_resolution():
    html = '''<script type="application/ld+json">{"@type":"VideoObject",
      "name":"Current video", "duration":"P0DT0H29M2S", "uploadDate":"2025-09-16T21:27:48Z",
      "thumbnailUrl":["https://img.test/current.jpg"]}</script>
      <video id="pornone-video-player"><source label="720p"
      src="https://cdn.test/123_1920x1080_4000k.mp4"></video>'''
    row = link_tester._parse_pornone_card_meta('https://pornone.com/video/1/', html)
    assert row['duration'] == 1742
    assert row['height'] == 1080
    assert row['width'] == 1920
    assert row['upload_date'] == '2025-09-16'
    assert row['thumbnail'] == 'https://img.test/current.jpg'


def test_partial_full_meta_is_not_cached_as_complete(monkeypatch):
    url = 'https://www.noodlemagazine.com/watch/123'
    hub = type('Hub', (), {})()
    hub.enrich = AsyncMock(return_value={url: {'duration_sec': 60, 'height': 1080}})
    cache = {}
    monkeypatch.setattr(link_tester, '_FULL_CARD_META', cache)
    monkeypatch.setattr(registry, 'init_hubs', lambda: None)
    monkeypatch.setattr(registry, 'get', lambda key: hub)
    row = asyncio.run(link_tester._fetch_full_card_meta(url, 'noodlemagazine', None, asyncio.Semaphore(1)))
    assert row['ok']
    assert row['size_bytes'] == 0
    assert url not in cache
