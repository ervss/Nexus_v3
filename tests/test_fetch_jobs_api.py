from contextlib import asynccontextmanager
import asyncio
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.sessions import SessionMiddleware
from sqlalchemy import create_engine

from app.auth import check_auth
from app.fetch_jobs import FetchStore, FetchRuntime
from app.routers import fetch_jobs as api


def test_cached_full_fetch_uses_complete_metadata_without_network(monkeypatch):
    from app import bunkr_cache
    from app.extractors.bunkr import BunkrExtractor
    cached = {'duration': 90, 'height': 1080, 'thumbnail': 'thumb', 'size_bytes': 200000000}
    monkeypatch.setattr(bunkr_cache, 'file_meta_get', lambda url: cached)
    async def unexpected_network(*args, **kwargs):
        raise AssertionError('cached metadata should not use network')
    monkeypatch.setattr(BunkrExtractor, 'extract', unexpected_network)
    result = asyncio.run(api.execute({'operation': 'file', 'mode': 'files_cached', 'seed': '{}', 'url': 'https://bunkr.cr/f/one'}))
    assert result['metadata_from_cache'] and result['duration'] == 90 and result['enriched']


def test_control_api_is_authenticated_validated_short_and_cancelable(tmp_path, monkeypatch):
    engine = create_engine(f'sqlite:///{tmp_path / "api.db"}', connect_args={'check_same_thread': False})
    store = FetchStore(engine)
    async def blocked(row):
        await asyncio.Event().wait()
    runtime = FetchRuntime(store, blocked, workers=1)
    monkeypatch.setattr(api, 'store', store)
    monkeypatch.setattr(api, 'runtime', runtime)
    @asynccontextmanager
    async def lifespan(app):
        await runtime.start()
        yield
        await runtime.stop()
    app = FastAPI(lifespan=lifespan)
    app.add_middleware(SessionMiddleware, secret_key='isolated-test-session')
    app.include_router(api.router)
    with TestClient(app) as client:
        assert client.post('/api/v1/fetch-jobs', json={'urls': ['https://bunkr.cr/a/a']}).status_code == 401
        app.dependency_overrides[check_auth] = lambda: True
        for url in ['https://bunkr.cr.evil.example/a/a', 'http://bunkr.cr/a/a',
                    'https://user:pass@bunkr.cr/a/a', 'https://bunkr.cr:8080/a/a', 'https://bunkr.cr/f/a']:
            assert client.post('/api/v1/fetch-jobs', json={'urls': [url]}).status_code == 422
        start = time.monotonic()
        response = client.post('/api/v1/fetch-jobs', json={'urls': ['https://bunkr.cr/a/a'], 'request_key': 'client'})
        assert response.status_code == 200
        assert time.monotonic()-start < 2  # Does not await a blocked extractor.
        job = response.json()['job_id']
        assert client.post('/api/v1/fetch-jobs', json={'urls': ['https://bunkr.cr/a/a'], 'request_key': 'client'}).json()['job_id'] == job
        snapshot = client.get(f'/api/v1/fetch-jobs/{job}').json()
        assert snapshot['state'] in ('queued', 'running')
        assert client.post(f'/api/v1/fetch-jobs/{job}/cancel').status_code == 200
        assert client.get(f'/api/v1/fetch-jobs/{job}').json()['state'] == 'cancelled'
        assert client.get('/api/v1/fetch-jobs/missing').status_code == 404
    engine.dispose()
