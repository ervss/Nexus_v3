import asyncio

from app.routers import library_health


class _BackgroundTasks:
    def __init__(self):
        self.calls = []

    def add_task(self, function, *args, **kwargs):
        self.calls.append((function, args, kwargs))


def test_health_sweep_schedules_async_callable(monkeypatch):
    called = []

    async def fake_check(db, max_age_hours):
        called.append((db, max_age_hours))

    class FakeSession:
        def close(self):
            called.append('closed')

    monkeypatch.setattr(library_health, 'SessionLocal', FakeSession)
    monkeypatch.setattr(library_health, 'check_all_videos_health', fake_check)

    tasks = _BackgroundTasks()
    result = asyncio.run(library_health.check_all_health(tasks, max_age_hours=6))

    assert result['status'] == 'checking'
    assert len(tasks.calls) == 1
    function, args, kwargs = tasks.calls[0]
    assert args == ()
    assert kwargs == {}
    asyncio.run(function())
    assert called == [(called_db := called[0][0], 6), 'closed']
    assert isinstance(called_db, FakeSession)


def test_broken_refresh_schedules_async_callable(monkeypatch):
    called = []

    async def fake_refresh(db):
        called.append(db)
        return {'refreshed': 2, 'total_broken': 3}

    class FakeSession:
        def close(self):
            called.append('closed')

    monkeypatch.setattr(library_health, 'SessionLocal', FakeSession)
    monkeypatch.setattr(library_health, 'refresh_broken_links', fake_refresh)

    tasks = _BackgroundTasks()
    result = asyncio.run(library_health.refresh_broken(tasks))

    assert result['status'] == 'refreshing'
    function, args, kwargs = tasks.calls[0]
    assert args == ()
    assert kwargs == {}
    asyncio.run(function())
    assert isinstance(called[0], FakeSession)
    assert called[1] == 'closed'
