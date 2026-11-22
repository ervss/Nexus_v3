import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app import telegram_service


@pytest.mark.asyncio
async def test_joined_video_chats_counts_video_filter_and_keeps_private_ids(monkeypatch):
    channel = SimpleNamespace(id=42, username="public_channel")
    group = SimpleNamespace(id=84, username=None)
    dialogs = [
        SimpleNamespace(id=-10042, title="Public", entity=channel, is_channel=True, is_group=False),
        SimpleNamespace(id=-10084, title="Private group", entity=group, is_channel=True, is_group=True),
        SimpleNamespace(id=7, title="Person", entity=None, is_channel=False, is_group=False),
    ]

    class Connection:
        async def iter_dialogs(self):
            for dialog in dialogs:
                yield dialog

    calls = []

    async def count(_connection, entity, **kwargs):
        calls.append((entity, kwargs))
        return SimpleNamespace(total=12 if entity is channel else 3)

    monkeypatch.setattr(telegram_service, "client", AsyncMock(return_value=Connection()))
    monkeypatch.setattr(telegram_service, "_get_messages", count)

    result = await telegram_service.joined_video_chats()

    assert [(item["id"], item["video_count"]) for item in result] == [("-10042", 12), ("-10084", 3)]
    assert result[1]["kind"] == "group"
    assert all(call[1]["limit"] == 0 and call[1]["filter"] is telegram_service.InputMessagesFilterVideo for call in calls)
