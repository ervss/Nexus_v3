import asyncio
import time

import pytest
from sqlalchemy import create_engine, update, select

from app.fetch_jobs import FetchStore, FetchRuntime, tasks
from app.ntc.bunkr_scheduler import DeferredFetch


@pytest.fixture
def store(tmp_path):
    engine = create_engine(f'sqlite:///{tmp_path / "jobs.db"}', connect_args={'check_same_thread': False})
    result = FetchStore(engine, lease_seconds=0.3)
    result.initialize()
    yield result
    engine.dispose()


def test_submission_is_idempotent_and_rejects_key_reuse(store):
    job = store.submit(['https://bunkr.cr/a/a'], 'index', request_key='client-1')
    assert store.submit(['https://bunkr.cr/a/a'], 'index', request_key='client-2') == job
    assert store.submit(['https://bunkr.cr/a/a'], 'index', request_key='client-1') == job
    row = store.claim('worker')
    store.finish(row, {'items': []})
    assert store.submit(['https://bunkr.cr/a/a'], 'index', request_key='client-2') == job
    with pytest.raises(ValueError, match='different request'):
        store.submit(['https://bunkr.cr/a/b'], 'index', request_key='client-1')


def test_cached_files_mode_creates_file_tasks(store):
    store.submit(['https://bunkr.cr/f/a'], 'files_cached')
    row = store.claim('worker')
    assert row['operation'] == 'file' and row['mode'] == 'files_cached'


def test_listing_fanout_deduplicates_files_and_retains_album_membership(store):
    job = store.submit(['https://bunkr.cr/a/a', 'https://bunkr.cr/a/b'], 'enrich')
    first = store.claim('worker-a')
    second = store.claim('worker-b')
    item = {'url': 'https://bunkr.cr/f/same', 'title': 'same.mp4'}
    assert store.finish(first, {'items': [item]})
    assert store.finish(second, {'items': [item]})
    rows = store.results(job)['items']
    assert len(rows) == 1 and len(rows[0]['source_album_urls']) == 2
    file = store.claim('worker-c')
    assert file['operation'] == 'file'
    store.finish(file, {'duration': 60, 'height': 1080, 'stream_url': 'https://cdn/token'})
    snapshot = store.snapshot(job)
    assert snapshot['state'] == 'completed'
    assert 'stream_url' not in store.results(job)['items'][0]
    events = snapshot['events']
    assert len({e['seq'] for e in events}) == len(events)
    assert store.snapshot(job, after=events[-1]['seq'])['events'] == []


def test_expired_lease_is_reclaimed_and_late_worker_cannot_commit(store):
    job = store.submit(['https://bunkr.cr/f/a'], 'files')
    old = store.claim('dead-worker')
    with store.engine.begin() as db:
        db.execute(update(tasks).where(tasks.c.id == old['id']).values(lease_until=0))
    fresh = store.claim('new-worker')
    assert fresh['generation'] > old['generation']
    assert not store.finish(old, {'duration': 1})
    assert store.finish(fresh, {'duration': 60})
    assert store.results(job)['items'][0]['duration'] == 60


def test_cancel_fences_running_results_and_preserves_completed_items(store):
    job = store.submit(['https://bunkr.cr/f/a', 'https://bunkr.cr/f/b'], 'files')
    first = store.claim('worker')
    store.finish(first, {'duration': 60})
    second = store.claim('worker')
    store.cancel(job)
    assert not store.finish(second, {'duration': 100})
    assert not store.heartbeat(second)
    assert store.snapshot(job)['state'] == 'cancelled'
    assert store.results(job)['items'][0]['duration'] == 60


def test_deferred_admission_does_not_consume_retry_budget(store):
    job = store.submit(['https://bunkr.cr/f/a'], 'files')
    row = store.claim('worker')
    retry_at = time.time()+60
    store.finish(row, error=DeferredFetch(retry_at))
    assert store.claim('worker') is None
    with store.engine.connect() as db:
        item = db.execute(select(tasks)).mappings().one()
    assert item['attempts'] == 0 and item['next_at'] == retry_at
    assert store.snapshot(job)['counts']['file:retry_wait'] == 1


def test_failed_retry_budget_produces_honest_terminal_summary(store):
    job = store.submit(['https://bunkr.cr/f/a'], 'files')
    for attempt in range(3):
        row = store.claim('worker')
        store.finish(row, error=RuntimeError('CDN unavailable'))
        with store.engine.begin() as db:
            db.execute(update(tasks).where(tasks.c.job_id == job).values(next_at=0))
    assert store.snapshot(job)['state'] == 'completed_with_errors'
    assert store.results(job)['items'][0]['fetch_state'] == 'failed'


def test_outbox_and_paginated_replay_survive_store_reopen(store):
    job = store.submit(['https://bunkr.cr/a/a'], 'index')
    row = store.claim('worker')
    store.finish(row, {'items': [{'url': f'https://bunkr.cr/f/{i}', 'title': f'{i}.mp4'} for i in range(501)]})
    reopened = FetchStore(store.engine)
    replay, cursor = [], 0
    while True:
        page = reopened.snapshot(job, after=cursor, limit=2)
        replay.extend(page['events'])
        cursor = page['cursor']
        if not page['has_more']:
            break
    assert sum(len(e['items']) for e in replay if e['type'] == 'listing') == 501
    assert reopened.outbox()
    reopened.published([e['id'] for e in reopened.outbox()])
    assert not reopened.outbox()
    assert reopened.results(job, limit=200)['has_more']


def test_worker_shutdown_and_restart_resumes_saved_work(store):
    async def run():
        job = store.submit(['https://bunkr.cr/f/a'], 'files')
        started = asyncio.Event()
        async def blocked(row):
            started.set()
            await asyncio.Event().wait()
        old = FetchRuntime(store, blocked, workers=1)
        await old.start()
        await asyncio.wait_for(started.wait(), 2)
        await old.stop()
        async def finish(row):
            return {'duration': 60}
        new = FetchRuntime(store, finish, workers=1)
        await new.start()
        try:
            for _ in range(100):
                snapshot = await asyncio.to_thread(store.snapshot, job)
                if snapshot['state'] == 'completed':
                    break
                await asyncio.sleep(0.01)
            assert snapshot['state'] == 'completed'
        finally:
            await new.stop()
        assert not old.active and not new.active
    asyncio.run(run())


def test_concurrent_claimers_never_own_same_task(store):
    from concurrent.futures import ThreadPoolExecutor
    store.submit(['https://bunkr.cr/f/a'], 'files')
    with ThreadPoolExecutor(max_workers=8) as pool:
        claimed = [row for row in pool.map(store.claim, [f'worker-{i}' for i in range(8)]) if row]
    assert len(claimed) == 1


def test_job_fairness_prevents_large_album_from_starving_new_batch(store):
    large = store.submit(['https://bunkr.cr/a/large'], 'enrich')
    row = store.claim('worker')
    store.finish(row, {'items': [{'url': f'https://bunkr.cr/f/{i}'} for i in range(100)]})
    small = store.submit(['https://bunkr.si/a/small'], 'index')
    assert store.claim('worker')['job_id'] == small
