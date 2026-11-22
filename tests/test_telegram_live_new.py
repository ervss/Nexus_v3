from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from telethon.errors import FloodWaitError

from app import telegram_live_new as live


class FakeConnection:
    async def iter_dialogs(self):
        for i in (1, 2, 3):
            yield SimpleNamespace(id=-1000000000000-i, title=f'Chat {i}',
                entity=SimpleNamespace(id=1000000000000+i, username=f'chat{i}'),
                is_channel=True, is_group=False)


class FakeSession:
    def __enter__(self): return self
    def __exit__(self, *args): pass


@pytest.mark.asyncio
async def test_live_pass_limits_each_chat_and_excludes_library(monkeypatch):
    monkeypatch.setattr(live, 'client', AsyncMock(return_value=FakeConnection()))
    monkeypatch.setattr(live, 'SessionLocal', FakeSession)
    monkeypatch.setattr(live, 'telegram_library_identities', lambda db, names: {f'{names["chat1"]}:1'})
    calls = []
    async def fetch(conn, entity, **kwargs):
        calls.append(kwargs)
        if entity.username == 'chat2':
            raise ValueError('inaccessible')
        return [SimpleNamespace(id=i) for i in range(1, 11)]
    monkeypatch.setattr(live, '_get_messages', fetch)
    monkeypatch.setattr(live, '_row', lambda msg, entity, name: {
        'chat_id': live.public_chat_id(int(name)), 'message_id': msg.id})
    events = [event async for event in live.stream_new_videos()]
    progress = [event for event in events if event['status'] == 'progress']
    assert len(progress) == 3
    assert [v['message_id'] for v in progress[0]['videos']] == [2, 3, 4, 5, 6]
    assert progress[1]['errors'] == 1
    assert len(progress[2]['videos']) == 5
    assert events[-1] == {'status':'done', 'completed':3, 'total':3, 'found':10, 'errors':1, 'limited':False}
    assert all(call['limit'] == 20 and call['_background'] for call in calls)


@pytest.mark.asyncio
async def test_live_pass_stops_on_flood_wait(monkeypatch):
    monkeypatch.setattr(live, 'client', AsyncMock(return_value=FakeConnection()))
    monkeypatch.setattr(live, '_get_messages', AsyncMock(side_effect=FloodWaitError(request=None, capture=30)))
    events = [event async for event in live.stream_new_videos()]
    assert [event['status'] for event in events] == ['start', 'flood_wait']
    assert events[-1]['seconds'] == 30
