import ast
import asyncio
import logging
import os
from pathlib import Path
import re
from typing import Any, Dict, List, Optional
import urllib.parse

import pytest

from app.discovery_hub_runtime import HubRuntime, TTLCache, hub_deadline, hub_runtime
from app.ntc.bunkr_scheduler import get_bunkr_scheduler


def test_cached_album_card_uses_saved_listing_and_snapshot(tmp_path, monkeypatch):
    from app import bunkr_cache, main
    monkeypatch.setattr(bunkr_cache, '_ALBUMS_DIR', tmp_path / 'albums')
    monkeypatch.setattr(bunkr_cache, '_ALBUM_SNAPSHOTS_DIR', tmp_path / 'snapshots')
    url = 'https://bunkr.cr/a/cached-test'
    bunkr_cache.album_put(url, [{'url': 'https://bunkr.cr/f/1', 'title': 'clip.mp4', 'size': '120 MB'}])
    bunkr_cache.album_snapshot_put(url, [{'url': 'https://bunkr.cr/f/1', 'thumbnail': 'https://example.test/preview.jpg', 'duration': 90}])
    result = main._dh_cached_album_card({'url': url, 'type': 'album'})
    assert result['cached_album'] and result['file_count'] == result['video_count'] == 1
    assert result['total_size_bytes'] == 120 * 1048576
    assert result['sample_files'][0]['duration'] == 90


def test_video_samples_skip_images_archives_and_placeholder_thumbnails():
    from app.main import _dh_video_samples
    rows = [
        {'title': 'archive.zip', 'thumb': 'https://cdn/test.jpg'},
        {'title': 'image.jpg', 'thumb': 'https://cdn/photo.jpg'},
        {'title': 'bad.mp4', 'thumb': 'https://cdn/video.svg'},
        {'title': 'good.mp4', 'thumb': 'https://cdn/real.jpg'},
    ]
    assert [item['title'] for item in _dh_video_samples(rows)] == ['good.mp4']


def test_album_enrichment_recovers_video_samples(tmp_path, monkeypatch):
    from app import bunkr_cache, main
    from app.extractors.bunkr import BunkrExtractor
    monkeypatch.setattr(bunkr_cache, '_ALBUMS_DIR', tmp_path / 'albums')
    monkeypatch.setattr(bunkr_cache, '_ALBUM_SNAPSHOTS_DIR', tmp_path / 'snapshots')
    monkeypatch.setattr(bunkr_cache, 'file_meta_get', lambda url: None)
    monkeypatch.setattr(bunkr_cache, 'file_meta_put', lambda *args: None)
    monkeypatch.setattr(bunkr_cache, 'file_meta_flush', lambda: None)
    async def listing(self, url, listing_only=False):
        return [{'url': 'https://bunkr.cr/f/video', 'title': 'video.mp4', 'thumb': 'video.svg'},
                {'url': 'https://bunkr.cr/f/photo', 'title': 'photo.jpg', 'thumb': 'photo.jpg'}]
    async def extract(self, url, metadata_only=False):
        return {'thumbnail': 'https://cdn.example/video.jpg'}
    async def detail(url):
        return {}
    monkeypatch.setattr(BunkrExtractor, 'extract_album', listing)
    monkeypatch.setattr(BunkrExtractor, 'extract', extract)
    monkeypatch.setattr(main, '_dh_fetch_bunkrr_detail_meta', detail)
    result = asyncio.run(main._dh_fetch_bunkr_enrichment(
        {'url': 'https://bunkr.cr/a/test-video', 'type': 'album'}, asyncio.Semaphore(1)))
    assert [(sample['title'], sample['thumbnail']) for sample in result['sample_files']] == [
        ('video.mp4', 'https://cdn.example/video.jpg')]


def listing_route():
    node = next(n for n in ast.parse(Path('app/main.py').read_text(encoding='utf-8')).body
                if isinstance(n, ast.AsyncFunctionDef) and n.name == 'discovery_hub_bunkr')
    node.decorator_list = []
    ns = dict(__name__='app.main', asyncio=asyncio, logging=logging, os=os, re=re,
              urllib=urllib, Any=Any, Dict=Dict, List=List, Optional=Optional,
              _dh_make_item=lambda **kw: dict(kw, type=kw['item_type']),
              _dh_canonical_url=lambda url: url, _dh_cached_album_card=lambda item: item,
              _dh_cached_file_card=lambda item: item)
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'app/main.py', 'exec'), ns)
    return ns['discovery_hub_bunkr']


def test_balbums_outage_falls_back_and_pins_pagination(monkeypatch):
    import app.discovery_hub_runtime as runtime
    calls = []
    async def provider(url, **kwargs):
        calls.append((url, kwargs.get('params') or {}))
        if 'balbums.st' in url:
            raise TimeoutError('primary unavailable')
        page = (kwargs.get('params') or {}).get('page', 1)
        return runtime.HubResponse(200, __import__('json').dumps({
            'albums':[{'id':page, 'name':f'album {page}', 'original_url':f'https://bunkr.cr/a/{page}', 'file_count':2}, {'id':99, 'name':'unsupported', 'original_url':'https://turbo.cr/a/foreign'}],
            'total':40, 'total_pages':4, 'next_cursor':f'cursor-{page}', 'page':page}))
    monkeypatch.setattr(runtime, 'hub_get', provider)
    async def run():
        route = listing_route()
        first = await route(mode='latest')
        assert first['fallback'] and first['pagination_provider'] == 'findr_api'
        assert first['results'][0]['url'] == 'https://bunkr.cr/a/1'
        assert first['has_more'] and first['next_cursor'] == 'cursor-1'
        assert len(first['results']) == 1 and first['available_total'] == 0
        calls.clear()
        runtime.hub_runtime().providers.entries.clear()  # primary may have recovered
        second = await route(mode='latest', page=2, provider='findr_api', cursor='cursor-1')
        assert second['results'][0]['url'] == 'https://bunkr.cr/a/2'
        assert all('balbums.st' not in url for url, _ in calls)
        assert calls[0][1]['cursor'] == 'cursor-1'
        # Failed primary is not retried for every new search during cooldown.
        calls.clear()
        runtime.hub_runtime().providers.put('balbums', {'unavailable': True}, ttl=60)
        await route(mode='search', query='studio')
        assert calls[0][0].endswith('api/albums/search')
        assert calls[0][1]['q'] == 'studio'
    asyncio.run(run())


def test_valid_empty_fallback_is_not_an_outage(monkeypatch):
    import app.discovery_hub_runtime as runtime
    async def provider(url, **kwargs):
        if 'balbums.st' in url: raise TimeoutError()
        return runtime.HubResponse(200, '{"albums":[],"total":0,"total_pages":1}')
    monkeypatch.setattr(runtime, 'hub_get', provider)
    result = asyncio.run(listing_route()(mode='search', query='no matches'))
    assert result['status'] == 'success' and result['results'] == []
    assert result['fallback']


def test_provider_failure_is_not_empty_success(monkeypatch):
    import app.discovery_hub_runtime as runtime
    async def failed(*args, **kwargs):
        raise RuntimeError('provider: HTTP 503')
    monkeypatch.setattr(runtime, 'hub_get', failed)
    result = asyncio.run(listing_route()(query='studio', mode='latest'))
    assert result['status'] == 'error'
    assert result['errors'][0]['provider'] == 'balbums.st'


def test_ttl_cache_bounds_and_negative_expiry(monkeypatch):
    import app.discovery_hub_runtime as runtime
    now = [10]
    monkeypatch.setattr(runtime.time, 'monotonic', lambda: now[0])
    cache = TTLCache(capacity=2)
    cache.put('failed', {}, ttl=15)
    assert cache.get('failed') == {}
    now[0] = 26
    assert cache.get('failed') is None
    for i in range(10): cache.put(i, i)
    assert len(cache.entries) == 2 and cache.get(9) == 9


def test_total_deadline_cancels_and_cleans_up():
    from fastapi import HTTPException
    async def run():
        finished = []
        @hub_deadline(0.01)
        async def slow():
            try: await asyncio.sleep(10)
            finally: finished.append(True)
        with pytest.raises(HTTPException) as error: await slow()
        assert error.value.status_code == 504 and finished == [True]
    asyncio.run(run())


def test_http_cancellation_releases_scheduler_and_runtime_budget():
    async def run():
        entered = asyncio.Event()
        exited = []
        class Response:
            async def __aenter__(self):
                entered.set()
                return self
            async def __aexit__(self, *args): exited.append(True)
            @property
            def content_length(self): raise asyncio.CancelledError()
        class Session:
            closed = False
            def get(self, *args, **kwargs):
                assert 'ssl' not in kwargs
                return Response()
        runtime = HubRuntime()
        runtime.session = Session()
        with pytest.raises(asyncio.CancelledError):
            await runtime.get('https://balbums.st/')
        assert runtime.pending_http == 0
        assert get_bunkr_scheduler().active == 0
        assert exited == [True]
    asyncio.run(run())


def test_http_pool_is_reused_and_closed(monkeypatch):
    import app.discovery_hub_runtime as module
    created = []
    class Body:
        async def iter_chunked(self, size): yield b'{"ok": true}'
    class Response:
        content_length = 12
        charset = 'utf-8'
        status = 200
        headers = {}
        content = Body()
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
    class Session:
        closed = False
        def __init__(self, **kwargs): created.append(self)
        def get(self, *args, **kwargs): return Response()
        async def close(self): self.closed = True
    monkeypatch.setattr(module.aiohttp, 'ClientSession', Session)
    monkeypatch.setattr(module.aiohttp, 'TCPConnector', lambda **kwargs: None)
    async def run():
        runtime = HubRuntime()
        for _ in range(2):
            assert (await runtime.get('https://balbums.st/')).json() == {'ok': True}
        assert len(created) == 1
        await runtime.close()
        assert created[0].closed and runtime.session is None
    asyncio.run(run())


def test_import_expands_album_before_job_creation(monkeypatch):
    from app.discovery_hub_import import build_import_request, BunkrExtractor
    async def extract(self, url, *, listing_only=False):
        assert listing_only
        return [{'url':'https://bunkr.cr/f/one','title':'one'}, {'url':'https://bunkr.cr/f/two','title':'two'}]
    monkeypatch.setattr(BunkrExtractor, 'extract_album', extract)
    request = asyncio.run(build_import_request({'url':'https://bunkr.cr/a/album', 'type':'album'}))
    assert len(request.candidates) == 2
    assert request.candidates[0].source_url == request.candidates[0].url
    assert request.batch_name == 'Discovery Hub'


def test_import_empty_album_does_not_create_placeholder(monkeypatch):
    from app.discovery_hub_import import build_import_request, BunkrExtractor
    async def empty(*args, **kwargs): return []
    monkeypatch.setattr(BunkrExtractor, 'extract_album', empty)
    with pytest.raises(ValueError):
        asyncio.run(build_import_request({'url':'https://bunkr.cr/a/empty'}))


def test_durable_job_identity_and_retry_preserve_successes(monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.database import Base, ImportJobItem
    from app.intake import IntakeCandidate, IntakeImportRequest, create_import_job, retry_job, serialize_job, _refresh_job_counts
    import app.intake as intake
    monkeypatch.setattr(intake, '_existing_normalized_urls', lambda db: set())
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine, autoflush=False)() as session:
        request = IntakeImportRequest(batch_name='Discovery Hub', candidates=[
            IntakeCandidate(url='https://bunkr.cr/f/one'), IntakeCandidate(url='https://bunkr.cr/f/two')])
        first = create_import_job(request, session)
        second = create_import_job(request, session)
        assert first.id != second.id and first.batch_name != second.batch_name
        items = session.query(ImportJobItem).filter_by(job_id=first.id).all()
        items[0].status = 'imported'
        items[1].status = 'failed'
        _refresh_job_counts(session, first)
        session.commit()
        assert serialize_job(first)['status'] == 'completed_with_errors'
        job_id = first.id
        retry_job(job_id, session)
        session.expire_all()
        items = session.query(ImportJobItem).filter_by(job_id=job_id).order_by(ImportJobItem.id).all()
        assert [item.status for item in items] == ['imported', 'pending_retry']
        assert items[0].job_id == job_id
    engine.dispose()


def test_balbums_cache_reuses_only_complete_success(monkeypatch):
    from app.discovery_hub_runtime import HubResponse
    import app.discovery_hub_runtime as runtime
    async def run():
        owner = HubRuntime()
        owner.session = type('Session', (), {'closed': False})()
        calls = []
        replies = [HubResponse(200, '<html>listing</html>'),
                   HubResponse(200, '<html>Just a moment</html>'),
                   HubResponse(200, '<html>recovered</html>')]
        async def request(intent, transport):
            calls.append(intent.url)
            return replies.pop(0)
        monkeypatch.setattr(runtime, 'get_bunkr_scheduler', lambda: type('Scheduler', (), {'run': staticmethod(request)})())
        first = await owner.get('https://balbums.st/?page=1')
        assert await owner.get('https://balbums.st/?page=1') is first
        assert len(calls) == 1
        await owner.get('https://balbums.st/?page=2')
        recovered = await owner.get('https://balbums.st/?page=2')
        assert 'recovered' in recovered.text and len(calls) == 3
        assert owner.pending_http == 0
    asyncio.run(run())

@pytest.mark.parametrize('content,expected', [('video','mp4'), ('image','jpg'), ('all','')])
def test_file_search_filters_at_provider_before_pagination(monkeypatch, content, expected):
    import app.discovery_hub_runtime as runtime
    calls = []
    async def provider(url, **kwargs):
        calls.append(kwargs.get('params', {}))
        return runtime.HubResponse(200, '{"files":[],"total":0,"total_pages":1,"has_more":false}')
    monkeypatch.setattr(runtime, 'hub_get', provider)
    result = asyncio.run(listing_route()(mode='files', query='studio', content=content, page=2))
    assert calls[0].get('ext', '').split(',')[0] == expected
    assert calls[0]['page'] == 2
    assert result['results'] == [] and result['has_more'] is False
