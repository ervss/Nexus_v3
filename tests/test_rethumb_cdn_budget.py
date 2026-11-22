import asyncio
import pytest
from app import maintenance as m, fast_thumb
from app.database import Video


def test_moov_is_not_a_deleted_file():
    v = Video(id=991, url='https://pc9.scdn.st/a.mp4')
    m._THUMB_FAIL_DETAIL[v.id] = 'moov atom not found'
    assert 'moov' in m._classify_rethumb_failure(v)['reason']
    m._THUMB_FAIL_DETAIL[v.id] = 'HTTP 404: CDN odmietol stream'
    assert '404' in m._classify_rethumb_failure(v)['reason']


def test_retry_after_supports_http_date(monkeypatch):
    monkeypatch.setattr(fast_thumb.time, 'time', lambda: 0)
    assert fast_thumb._retry_after({'retry-after': 'Thu, 01 Jan 1970 00:10:00 GMT'}) == 600
    assert fast_thumb._retry_after({'retry-after': '900'}) == 900


def test_deferred_jobs_survive_reopen(tmp_path, monkeypatch):
    path = str(tmp_path / 'jobs.db')
    store = fast_thumb.JobStore(path)
    store.enqueue([1])
    store.defer(1, 'HTTP 503', delay=600)
    store.close()
    store = fast_thumb.JobStore(path)
    assert store.due() == []
    assert store.recover() == []
    monkeypatch.setattr(fast_thumb.time, 'time', lambda: 10**12)
    assert store.due() == [1]
    store.close()


def test_provider_gate_also_respects_global_limit():
    async def run():
        global_gate, host_gate = asyncio.Semaphore(1), asyncio.Semaphore(2)
        active = peak = 0
        async def one():
            nonlocal active, peak
            async with m._rethumb_gate(global_gate, host_gate):
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.01)
                active -= 1
        await asyncio.gather(*(one() for _ in range(6)))
        assert peak == 1
    asyncio.run(run())


def test_throttled_range_does_not_launch_ffmpeg(monkeypatch, tmp_path):
    v = Video(id=992, url='https://a.cdn.cr/a.mp4?token=x&ex=9999999999', duration=100)
    async def no_cover(*args): return False
    async def extract(*args): raise fast_thumb.FastThumbThrottled(503)
    async def forbidden(*args, **kwargs): pytest.fail('FFmpeg must not bypass a refused Range request')
    monkeypatch.setattr(m, '_bunkr_cover_to_thumb', no_cover)
    monkeypatch.setattr(fast_thumb, 'eligible', lambda _: True)
    monkeypatch.setattr(fast_thumb, 'extract_candidates', extract)
    monkeypatch.setattr(m, '_run_thumb_process', forbidden)
    assert not asyncio.run(m._generate_thumb_from_stream(v, str(tmp_path)))
    assert m._is_rate_limited(m._THUMB_FAIL_DETAIL[v.id])
