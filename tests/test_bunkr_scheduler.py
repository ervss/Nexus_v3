import asyncio
from types import SimpleNamespace

import pytest

from app.ntc.bunkr_scheduler import BunkrScheduler, DeferredFetch, fetch_durable, is_bunkr_host
from app.ntc.intent import Priority, RequestIntent
from app.ntc.coalesce import Coalescer


def response(status=200, headers=None):
    return SimpleNamespace(status_code=status, headers=headers or {})


def test_family_and_host_caps_hold_for_entire_transport():
    async def run():
        scheduler = BunkrScheduler(concurrency=4, rate=10000, burst=100, host_cap=2)
        active = peak = 0
        hosts = {}
        async def one(index):
            host = ['bunkr.cr', 'bunkr.si', 'balbums.st'][index % 3]
            async def transport():
                nonlocal active, peak
                active += 1
                peak = max(peak, active)
                hosts[host] = hosts.get(host, 0)+1
                assert hosts[host] <= 2
                await asyncio.sleep(0.005)
                hosts[host] -= 1
                active -= 1
                return response()
            return await scheduler.run(RequestIntent(url=f'https://{host}/f/{index}'), transport)
        await asyncio.gather(*(one(i) for i in range(120)))
        assert peak == scheduler.peak_active == 4
        assert scheduler.active == 0 and not scheduler.waiters
    asyncio.run(run())


def test_interactive_priority_overtakes_bulk_and_cancel_removes_waiter():
    async def run():
        scheduler = BunkrScheduler(concurrency=1, rate=10000, burst=100)
        await scheduler.acquire('bunkr.cr', Priority.NORMAL)
        order = []
        async def one(name, priority):
            await scheduler.acquire('bunkr.cr', priority)
            order.append(name)
            await scheduler.release('bunkr.cr', status=200)
        low = asyncio.create_task(one('bulk', Priority.LOW))
        cancelled = asyncio.create_task(one('cancelled', Priority.NORMAL))
        high = asyncio.create_task(one('play', Priority.HIGH))
        await asyncio.sleep(0.01)
        cancelled.cancel()
        await asyncio.gather(cancelled, return_exceptions=True)
        await scheduler.release('bunkr.cr', status=200)
        await asyncio.gather(low, high)
        assert order == ['play', 'bulk']
        assert scheduler.active == 0 and not scheduler.waiters
    asyncio.run(run())


def test_attempt_deadline_excludes_admission_queue_time():
    async def run():
        scheduler = BunkrScheduler(concurrency=1, rate=10000, burst=100)
        await scheduler.acquire('bunkr.cr', Priority.NORMAL)
        async def transport():
            return response()
        task = asyncio.create_task(scheduler.run(RequestIntent(url='https://bunkr.cr/f/a', deadline=0.01), transport))
        await asyncio.sleep(0.04)
        assert not task.done()
        await scheduler.release('bunkr.cr', status=200)
        assert (await task).status_code == 200
    asyncio.run(run())


def test_durable_throttle_is_deferred_without_nested_retries():
    async def run():
        scheduler = BunkrScheduler(rate=10000, burst=100)
        calls = 0
        async def transport():
            nonlocal calls
            calls += 1
            return response(429, {'Retry-After': '60'})
        token = fetch_durable.set(True)
        try:
            with pytest.raises(DeferredFetch):
                await scheduler.run(RequestIntent(url='https://bunkr.cr/f/a'), transport)
            with pytest.raises(DeferredFetch):
                await scheduler.acquire('bunkr.cr', Priority.LOW)
        finally:
            fetch_durable.reset(token)
        assert calls == 1 and scheduler.active == 0
    asyncio.run(run())


def test_transport_cancellation_releases_all_permits():
    async def run():
        scheduler = BunkrScheduler(rate=10000, burst=100)
        started = asyncio.Event()
        async def transport():
            started.set()
            await asyncio.Event().wait()
        task = asyncio.create_task(scheduler.run(RequestIntent(url='https://bunkr.cr/f/a'), transport))
        await started.wait()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert scheduler.active == scheduler.hosts['bunkr.cr'].active == 0
    asyncio.run(run())


def test_coalesced_request_survives_first_subscriber_cancellation():
    async def run():
        coalescer = Coalescer()
        started, finish = asyncio.Event(), asyncio.Event()
        calls = 0
        async def transport():
            nonlocal calls
            calls += 1
            started.set()
            await finish.wait()
            return 'shared'
        first = asyncio.create_task(coalescer.do('same', transport))
        await started.wait()
        second = asyncio.create_task(coalescer.do('same', transport))
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        finish.set()
        assert await second == 'shared'
        assert calls == 1 and not coalescer._inflight
    asyncio.run(run())


def test_host_family_does_not_match_unrelated_or_spoofed_hosts():
    assert is_bunkr_host('www.bunkr.cr') and is_bunkr_host('balbums.st')
    assert not is_bunkr_host('bunkr.cr.example.com')
    assert not is_bunkr_host('gofile.io')


def test_ntc_routes_bunkr_api_and_html_through_same_family_budget(monkeypatch):
    from app.ntc.controller import NexusTrafficController, NTCResponse
    from app.ntc import bunkr_scheduler
    controller = NexusTrafficController()
    async def run():
        scheduler = BunkrScheduler(concurrency=3, rate=10000, burst=100, host_cap=2)
        monkeypatch.setattr(bunkr_scheduler, 'get_bunkr_scheduler', lambda: scheduler)
        seen = []
        async def transport(intent, exit):
            seen.append((intent.method, intent.url, intent.json))
            await asyncio.sleep(0.01)
            return NTCResponse(text='{"url":"https://cdn.example/a.mp4"}', status_code=200, url=intent.url)
        monkeypatch.setattr(controller, '_transport', transport)
        await asyncio.gather(*[
            controller.request('https://bunkr.si/api/vs', method='POST', idempotent=True, cache=False, json={'slug': 'same'}),
            controller.request('https://bunkr.si/api/vs', method='POST', idempotent=True, cache=False, json={'slug': 'same'}),
            controller.request('https://balbums.st/f/a', domain='bunkr.cr'),
            controller.request('https://bunkr.si/api/vs', method='POST', idempotent=True, cache=False, json={'slug': 'different'}),
        ])
        assert len(seen) == 3
        assert scheduler.peak_active <= 3
        assert set(scheduler.hosts) == {'bunkr.si', 'balbums.st'}
        assert not controller.gates
    asyncio.run(run())
