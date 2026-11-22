import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import eporner_playlist_index as index
from app import eporner_transport as transport
from app.extractors.eporner import EpornerExtractor
from app.routers import link_tester


@pytest.fixture(autouse=True)
def _force_fetch_listing_route(monkeypatch):
    # Ensure EpornerExtractor.extract_album_entries uses the mocked transport.fetch_listing.
    monkeypatch.setenv("EPORNER_NETWORK_MODE", "tor")


def client():
    app = FastAPI()
    app.include_router(link_tester.router)
    return TestClient(app)


def events(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]


def card(video_id, title):
    return f'<div class="mb"><p class="mbtit"><a href="/hd-porn/{video_id}/clip/">{title}</a></p><span class="mbtim">1:02</span></div>'


def test_fifty_playlists_stream_all_paginated_titles_without_watch_resolution(monkeypatch):
    calls = []
    active = peak = 0

    async def fetch(url):
        nonlocal active, peak
        calls.append(url)
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.001)
        active -= 1
        second = url.endswith('/2/')
        pid = url.split('/playlist/')[1].split('/')[0]
        html = '<div class="streamevents">' + card(pid + ('B' if second else 'A'), 'BBC clip' if second else 'Other clip')
        if not second:
            html += '<div class="numlist2"><a href="2/">2</a></div>'
        return SimpleNamespace(status_code=200, text=html + '</div>')

    monkeypatch.setattr(transport, 'fetch_listing', fetch)
    monkeypatch.setattr(index, '_load_cache', lambda url: None)
    save = Mock()
    monkeypatch.setattr(index, '_save_cache', save)
    resolve = AsyncMock(side_effect=AssertionError('Title index must not resolve watch streams'))
    monkeypatch.setattr(EpornerExtractor, 'extract', resolve)
    urls = [f'https://www.eporner.com/profile/demo/playlist/p{i}/clips/' for i in range(50)]

    response = client().post('/api/tester/eporner-playlists/titles/stream', json={'urls': urls})
    data = events(response)
    pages = [row for row in data if row['type'] == 'page']
    assert response.status_code == 200
    assert len(pages) == len(calls) == 100
    assert peak <= index.INDEX_CONCURRENCY
    assert set(calls[:50]) == set(urls)  # broad first-page coverage before deep pagination
    assert all('/playlist/' in url for url in calls)
    assert sum('BBC' in item['title'] for page in pages for item in page['items']) == 50
    assert all(not item.get('stream_url') for page in pages for item in page['items'])
    assert data[-1] == {'type': 'done', 'done': 50, 'total': 50, 'failed': 0, 'cached': 0}
    assert save.call_count == 50
    resolve.assert_not_awaited()


def test_cache_and_playlist_alias_dedup_require_no_listing_requests(monkeypatch):
    row = {'items': [{'url': 'https://www.eporner.com/video-abc/clip/', 'title': 'BBC clip'}], 'pages': 1, 'complete': True}
    monkeypatch.setattr(index, '_load_cache', lambda url: row)
    fetch = AsyncMock(side_effect=AssertionError('Cache hit must not fetch'))
    monkeypatch.setattr(transport, 'fetch_listing', fetch)
    urls = ['https://www.eporner.com/profile/demo/playlist/abc/clips/', 'https://eporner.com/playlist/abc/alias/']

    data = events(client().post('/api/tester/eporner-playlists/titles/stream', json={'urls': urls}))
    assert data[0]['total'] == 1
    assert data[1]['cached'] is True
    assert data[-1] == {'type': 'done', 'done': 1, 'total': 1, 'failed': 0, 'cached': 1}
    fetch.assert_not_awaited()


def test_playlist_summary_is_listing_only_and_marks_size_as_estimate():
    items = [
        {"url": "https://www.eporner.com/hd-porn/a/one/", "duration": 60, "height": 1080, "rating": "90%"},
        {"url": "https://www.eporner.com/hd-porn/b/two/", "duration": 120, "height": 720, "rating": "80%"},
    ]
    summary = index.summarize_playlist_items(items, complete=True)
    assert summary["video_count"] == 2
    assert summary["total_duration"] == 180
    assert summary["quality_histogram"] == {"720": 1, "1080": 1}
    assert summary["average_rating"] == 85.0
    assert summary["size_estimated"] is True
    assert summary["estimated_size_high_bytes"] > summary["estimated_size_low_bytes"] > 0
    assert summary["complete"] is True


def test_later_page_failure_preserves_partial_titles_without_caching_as_complete(monkeypatch):
    first = '<div class="streamevents">' + card('abc', 'BBC first') + '<div class="numlist2"><a href="2/">2</a></div></div>'
    monkeypatch.setattr(transport, 'fetch_listing', AsyncMock(side_effect=[
        SimpleNamespace(status_code=200, text=first), transport.EpornerListingError('HTTP 429; počkaj')]))
    monkeypatch.setattr(index, '_load_cache', lambda url: None)
    save = Mock()
    monkeypatch.setattr(index, '_save_cache', save)

    async def run():
        return [row async for row in index.stream_playlist_titles(['https://www.eporner.com/playlist/abc/clips/'])]

    data = asyncio.run(run())
    assert data[0]['type'] == 'page'
    assert data[0]['items'][0]['title'] == 'BBC first'
    assert data[1]['complete'] is False
    assert data[1]['summary']['complete'] is False
    assert data[1]['summary']['video_count'] == 1
    assert '429' in data[1]['error']
    assert data[-1]['failed'] == 1
    save.assert_not_called()


def test_index_rejects_external_hosts_watch_pages_and_oversized_requests():
    for urls in [[], ['https://example.com/playlist/abc/'],
                 ['https://eporner.com.evil.example/playlist/abc/'],
                 ['http://www.eporner.com/playlist/abc/'],
                 ['https://www.eporner.com/video-abc/clip/'],
                 ['https://www.eporner.com/playlist/abc/'] * 201]:
        assert client().post('/api/tester/eporner-playlists/titles/stream', json={'urls': urls}).status_code == 400


def test_scan_indexes_first_playlist_before_later_search_pages(monkeypatch):
    import app.eporner_playlist_search as playlist_search

    order = []

    def playlist_card(pid, title):
        return (
            f'<div class="mb"><a href="/playlist/{pid}/clips/">'
            f'<img alt="{title}" src="https://static.example/{pid}.jpg"></a>'
            f'<span class="mbphoto2_playlistico">3</span></div>'
        )

    def video_card(vid, title):
        return (
            f'<div class="mb"><p class="mbtit"><a href="/hd-porn/{vid}/clip/">{title}</a></p>'
            f'<span class="mbtim">1:02</span><div class="mvhdico">720p</div>'
            f'<span class="mbvie">12K</span></div>'
        )

    async def fetch(url):
        order.append(url)
        if '/search-playlists/' in url:
            page = 2 if '/2/' in url or url.rstrip('/').endswith('/2') else 1
            if page == 1:
                pads = ''.join(f'<div class="mb"><a href="/playlist/pad{i}/x/"><img alt="pad {i}"></a></div>' for i in range(40))
                return SimpleNamespace(status_code=200, text=playlist_card('aaa', 'BBC mix') + pads, headers={})
            await asyncio.sleep(0.08)
            return SimpleNamespace(status_code=200, text=playlist_card('bbb', 'BBC later'), headers={})
        html = '<div class="streamevents">' + video_card('pawg1', 'PAWG bbc') + '</div>'
        return SimpleNamespace(status_code=200, text=html, headers={})

    monkeypatch.setattr(transport, 'fetch_listing', fetch)
    monkeypatch.setattr(playlist_search, '_load_cache', lambda path: None)
    monkeypatch.setattr(playlist_search, '_save_cache', lambda path, html: None)
    monkeypatch.setattr(index, '_load_cache', lambda url: None)
    monkeypatch.setattr(index, '_save_cache', Mock())

    async def run():
        events = [row async for row in index.stream_playlist_scan('bbc', 2, result_limit=5)]
        return events

    events = asyncio.run(run())
    types = [row['type'] for row in events]
    assert 'playlist' in types
    assert 'page' in types
    first_page = next(row for row in events if row['type'] == 'page')
    playlist_fetch = next(url for url in order if '/playlist/aaa/' in url)
    search_page2 = next(url for url in order if '/search-playlists/' in url and ('/2/' in url or url.rstrip('/').endswith('/2')))
    assert order.index(playlist_fetch) < order.index(search_page2)
    assert first_page['items'][0]['title'] == 'PAWG bbc'
    assert first_page['items'][0]['views'] == 12000
    assert events[-1]['type'] == 'done'


def test_scan_stream_endpoint_emits_playlists_then_pages(monkeypatch):
    import app.eporner_playlist_search as playlist_search

    async def fake_scan(keyword, max_pages, result_limit=0, sort_mode='newest', **_kwargs):
        yield {'type': 'playlist', 'item': {'id': 'aaa', 'url': 'https://www.eporner.com/playlist/aaa/clips/', 'title': 'BBC mix', 'thumb': '', 'count': 3}}
        yield {'type': 'page', 'url': 'https://www.eporner.com/playlist/aaa/clips/', 'items': [{'url': 'https://www.eporner.com/hd-porn/pawg1/clip/', 'title': 'PAWG', 'duration': 62, 'stream_url': ''}], 'page': 1, 'cached': False}
        yield {'type': 'done', 'playlists': 1, 'pages_scanned': 1, 'stopped_by_rate_limit': False, 'failed': 0}

    monkeypatch.setattr(index, 'stream_playlist_scan', fake_scan)
    monkeypatch.setattr(playlist_search, 'search_playlists', AsyncMock())
    response = client().post('/api/tester/eporner-playlists/scan/stream', json={'keyword': 'bbc', 'limit': 5, 'pages': 2})
    data = events(response)
    assert response.status_code == 200
    assert data[0]['type'] == 'start'
    assert data[1]['type'] == 'playlist'
    assert data[2]['type'] == 'page'
    assert data[-1]['type'] == 'done'
