import asyncio
from unittest.mock import AsyncMock

from app import filester_cookie_sync as sync


def test_cookie_event_burst_verifies_and_writes_once(tmp_path, monkeypatch):
    verify = AsyncMock(return_value=True)
    monkeypatch.setattr(sync, "_looks_signed_in", verify)
    cookies = [{"name": "auth_token", "value": "test-token", "domain": ".filester.me"}]

    async def burst():
        return await asyncio.gather(*[
            sync.write_filester_cookies(cookies, root=tmp_path) for _ in range(100)
        ])

    results = asyncio.run(burst())
    assert verify.await_count == 1
    assert sum(result["written"] for result in results) == 1
    assert all(result["success"] for result in results)


def test_changed_or_deleted_cookie_file_is_synced(tmp_path, monkeypatch):
    verify = AsyncMock(return_value=True)
    monkeypatch.setattr(sync, "_looks_signed_in", verify)

    async def scenario():
        for value in ("old-token", "new-token"):
            result = await sync.write_filester_cookies(
                [{"name": "auth_token", "value": value}], root=tmp_path)
            assert result["written"] == 1
        path = tmp_path / sync.FILESTER_COOKIE_FILE
        assert "new-token" in path.read_text()
        path.unlink()
        result = await sync.write_filester_cookies(
            [{"name": "auth_token", "value": "new-token"}], root=tmp_path)
        assert result["written"] == 1

    asyncio.run(scenario())
    assert verify.await_count == 3
