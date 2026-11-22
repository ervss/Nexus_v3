import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.sessions import SessionMiddleware

from app.streaming.playback_control import PlaybackControl, interactive
from app.streaming.resolution import PlaybackResolver
from app.ntc.bunkr_scheduler import fetch_priority


def test_bunkr_endpoint_shares_extraction_but_keeps_database_sessions_separate(monkeypatch):
    from unittest.mock import MagicMock
    from app import main
    from app.extractors.bunkr import BunkrExtractor
    async def run():
        calls = 0
        async def extract(self, url):
            nonlocal calls
            calls += 1
            assert fetch_priority.get() == 'high'
            await asyncio.sleep(0.01)
            return {'stream_url':'https://cdn.example/a?ex=9999999999'}
        monkeypatch.setattr(BunkrExtractor, 'extract', extract)
        def database():
            db = MagicMock()
            db.query.return_value.get.return_value = SimpleNamespace(url='https://old.example/a', source_url='https://bunkr.cr/f/a')
            return db
        first, second = database(), database()
        results = await asyncio.gather(main.get_bunkr_stream(1, db=first), main.get_bunkr_stream(1, db=second))
        assert calls == 1 and results[0]['stream_url'] == results[1]['stream_url']
        first.commit.assert_called_once()
        second.commit.assert_called_once()
        assert (await main.get_bunkr_stream(1, db=database()))['cached'] is True
        await main.get_bunkr_stream(1, db=database(), force=True)
        assert calls == 2
    asyncio.run(run())


def test_shared_cdn_cooldown_defers_thumbnails_without_sleeping(monkeypatch, tmp_path):
    from app import maintenance
    from app.database import Video
    from app.streaming import playback_control
    control = playback_control.control
    control.cooldown('https://cdn.example/a', 503, 60)
    async def forbidden(*args, **kwargs): pytest.fail('must defer before network or decode')
    monkeypatch.setattr(maintenance, '_generate_thumb_from_stream_impl', forbidden)
    assert asyncio.run(maintenance._generate_thumb_from_stream(Video(id=800, url='https://cdn.example/b'), str(tmp_path))) is False


def test_lease_reduces_budget_and_expires_without_a_tab():
    now = [0.0]
    control = PlaybackControl(clock=lambda: now[0], lease_seconds=20)
    assert control.snapshot()['background_limit'] == 8
    control.report('player', 'playing')
    assert control.snapshot()['background_limit'] == 2
    control.report('second', 'buffering')
    assert control.snapshot()['background_limit'] == 1
    control.report('second', 'stopped')
    assert control.snapshot()['background_limit'] == 2
    now[0] = 21
    assert control.snapshot()['active_players'] == 0
    assert control.snapshot()['background_limit'] == 8


def test_pressure_caps_new_work_and_cancellation_releases_queue():
    async def run():
        control = PlaybackControl()
        control.report('player', 'buffering')
        started, finish = asyncio.Event(), asyncio.Event()
        async def first():
            async with control.background('https://a.example/'):
                started.set()
                await finish.wait()
        task = asyncio.create_task(first())
        await started.wait()
        async def queued():
            async with control.background('https://b.example/'):
                pytest.fail('admitted before first work finished')
        waiting = asyncio.create_task(queued())
        await asyncio.sleep(0)
        assert control.snapshot()['background_waiting'] == 1
        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)
        finish.set()
        await task
        assert control.active == 0 and control.waiting == 0
    asyncio.run(run())


def test_nested_work_and_independent_network_budget_do_not_deadlock():
    async def run():
        control = PlaybackControl()
        control.report('player', 'loading')
        async with control.background():
            async with control.background():
                async with control.background(lane='network'):
                    assert control.active == control.network_active == 1
        assert control.active == control.network_active == 0
    asyncio.run(asyncio.wait_for(run(), 1))


def test_cooldown_is_host_local_and_respects_retry_after():
    now = [0.0]
    control = PlaybackControl(clock=lambda: now[0])
    control.cooldown('https://cdn.example/a', 429, 90)
    control.cooldown('https://cdn.example/b', 503, 5)
    assert control.remaining('https://cdn.example/c') == 90
    assert control.remaining('https://other.example/c') == 0
    now[0] = 91
    assert control.remaining('https://cdn.example/c') == 0


def test_bunkr_reserves_capacity_for_playback(monkeypatch):
    from app.streaming import playback_control
    from app.ntc.bunkr_scheduler import BunkrScheduler
    from app.ntc.intent import Priority
    async def run():
        control = PlaybackControl()
        control.report('player', 'playing')
        monkeypatch.setattr(playback_control, 'control', control)
        scheduler = BunkrScheduler(concurrency=3, host_cap=3, rate=10000, burst=100)
        await scheduler.acquire('bunkr.cr', Priority.NORMAL)
        normal = asyncio.create_task(scheduler.acquire('bunkr.cr', Priority.NORMAL))
        await asyncio.sleep(0)
        assert not normal.done()
        await asyncio.wait_for(scheduler.acquire('bunkr.cr', Priority.HIGH), 0.1)
        assert scheduler.active == 2
        normal.cancel()
        await asyncio.gather(normal, return_exceptions=True)
        await scheduler.release('bunkr.cr', status=200)
        await scheduler.release('bunkr.cr', status=200)
        assert not scheduler.waiters
    asyncio.run(run())


def test_admission_wait_does_not_spend_ntc_transport_timeout(monkeypatch):
    from app.streaming import playback_control
    from app.ntc.controller import NexusTrafficController, NTCResponse
    from app.ntc.intent import RequestIntent
    async def run():
        control = PlaybackControl()
        control.report('player', 'buffering')
        monkeypatch.setattr(playback_control, 'control', control)
        client = NexusTrafficController()
        async def transport(intent, exit): return NTCResponse('', 200, intent.url)
        monkeypatch.setattr(client, '_transport_raw', transport)
        started, finish = asyncio.Event(), asyncio.Event()
        async def blocker():
            async with control.background(lane='network'):
                started.set()
                await finish.wait()
        blocking = asyncio.create_task(blocker())
        await started.wait()
        task = asyncio.create_task(client._transport(RequestIntent(url='https://a.example/', deadline=0.01), None))
        await asyncio.sleep(0.03)
        assert not task.done()
        finish.set()
        await blocking
        assert (await task).status_code == 200
    asyncio.run(run())


def test_interactive_work_bypasses_background_capacity_but_not_cooldown():
    async def run():
        control = PlaybackControl()
        control.report('player', 'buffering')
        async with control.background():
            token = interactive.set(True)
            try:
                async with control.background(lane='network'):
                    assert control.active == 1 and control.network_active == 0
                control.cooldown('https://cdn.example/a', 503, 90)
                with pytest.raises(TimeoutError):
                    await control.wait_host('https://cdn.example/b', timeout=1)
            finally:
                interactive.reset(token)
    asyncio.run(run())


def test_resolver_coalesces_requests_and_returns_independent_data():
    async def run():
        resolver = PlaybackResolver()
        calls = 0
        async def factory():
            nonlocal calls
            calls += 1
            assert interactive.get() and fetch_priority.get() == 'high'
            await asyncio.sleep(0.01)
            return {'stream_url':'https://cdn.example/a?ex=9999999999', 'nested':{'x':1}}
        results = await asyncio.gather(*(resolver.resolve('video', factory, reusable=True) for _ in range(20)))
        assert calls == 1
        results[0][0]['nested']['x'] = 99
        assert results[1][0]['nested']['x'] == 1
        assert (await resolver.resolve('video', factory, reusable=True))[1] is True
        await resolver.resolve('video', factory, reusable=True, force=True)
        assert calls == 2
        assert not interactive.get() and fetch_priority.get() == 'normal'
    asyncio.run(run())


def test_near_expiry_and_single_use_sources_are_not_cached():
    async def run():
        resolver = PlaybackResolver(clock=lambda: 1000)
        async def expiring(): return {'stream_url':'https://cdn.example/a?ex=1050'}
        async def opaque(): return {'stream_url':'https://cdn.example/a'}
        await resolver.resolve('near', expiring, reusable=True)
        await resolver.resolve('single', opaque, reusable=False)
        assert not resolver.cache
    asyncio.run(run())


def test_cancelled_subscriber_does_not_cancel_another_player():
    async def run():
        resolver = PlaybackResolver()
        start, finish = asyncio.Event(), asyncio.Event()
        async def factory():
            start.set()
            await finish.wait()
            return {'stream_url':'https://cdn.example/a'}
        first = asyncio.create_task(resolver.resolve('video', factory))
        await start.wait()
        second = asyncio.create_task(resolver.resolve('video', factory))
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        finish.set()
        assert (await second)[0]['stream_url'].endswith('/a')
        assert not resolver.coalescer._inflight
    asyncio.run(run())


def test_failed_resolve_is_not_cached_and_restores_context():
    async def run():
        resolver = PlaybackResolver()
        async def factory(): raise RuntimeError('503')
        with pytest.raises(RuntimeError):
            await resolver.resolve('video', factory, reusable=True)
        assert not resolver.cache and not resolver.coalescer._inflight
        assert not interactive.get()
    asyncio.run(run())


def test_ntc_shares_provider_cooldown_with_other_network_clients(monkeypatch):
    from app.streaming import playback_control
    from app.ntc.controller import NexusTrafficController, NTCResponse
    from app.ntc.intent import RequestIntent, Priority
    async def run():
        control = PlaybackControl()
        monkeypatch.setattr(playback_control, 'control', control)
        ntc = NexusTrafficController()
        async def transport(intent, exit):
            assert interactive.get()
            return NTCResponse('', 503, intent.url, {'Retry-After':'45'})
        monkeypatch.setattr(ntc, '_transport_raw', transport)
        result = await ntc._transport(RequestIntent(url='https://cdn.example/a', priority=Priority.HIGH), None)
        assert result.status_code == 503
        assert 44 < control.remaining('https://cdn.example/b') <= 45
        assert control.network_active == 0
    asyncio.run(run())


def test_telemetry_requires_login_and_rejects_out_of_order_heartbeats(monkeypatch):
    from app.routers import playback
    from app.auth import check_auth
    control = PlaybackControl()
    monkeypatch.setattr(playback, 'control', control)
    monkeypatch.setattr(playback, '_recent', {})
    # OrderedDict is part of the bounded telemetry contract.
    from collections import OrderedDict
    monkeypatch.setattr(playback, '_recent', OrderedDict())
    app = FastAPI()
    app.add_middleware(SessionMiddleware, secret_key='local-test-only')
    app.include_router(playback.router, prefix='/api/v1')
    with TestClient(app) as client:
        body = {'session_id':'test_player_1234', 'phase':'playing', 'sequence':1}
        assert client.post('/api/v1/playback/activity', json=body).status_code == 401
        app.dependency_overrides[check_auth] = lambda: True
        assert client.post('/api/v1/playback/activity', json=body).json()['background_limit'] == 2
        body.update(phase='stopped', sequence=3)
        assert client.post('/api/v1/playback/activity', json=body).json()['active_players'] == 0
        body.update(phase='buffering', sequence=2)
        assert client.post('/api/v1/playback/activity', json=body).json()['active_players'] == 0
        body['metrics'] = {'startup_ms':-1}
        assert client.post('/api/v1/playback/activity', json=body).status_code == 422
