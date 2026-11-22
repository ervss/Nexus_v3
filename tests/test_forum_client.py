import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace

from app.forums.boards import load_cookies, missing_auth_cookies
from app.forums.client import ForumClient, ForumRateLimitError, _retry_after_seconds
from app.forums.service import _thread_needs_fetch


class _Resp:
    def __init__(self, status, text="", headers=None):
        self.status_code = status
        self.text = text
        self.headers = headers or {}
        self.url = "https://simpcity.cr/watched/threads"


class _Session:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

    async def get(self, *args, **kwargs):
        self.calls += 1
        return self._responses.pop(0)

    async def close(self):
        pass


def test_httponly_netscape_lines_are_not_dropped():
    from pathlib import Path
    import tempfile

    raw = (
        "# Netscape HTTP Cookie File\n"
        "#HttpOnly_.simpcity.cr\tTRUE\t/\tTRUE\t0\tyMziCv8BrCZz1o7_session\tabc\n"
        "simpcity.cr\tFALSE\t/\tTRUE\t0\tyMziCv8BrCZz1o7_user\t4200074%2Ctoken\n"
        "simpcity.cr\tFALSE\t/\tTRUE\t0\tyMziCv8BrCZz1o7_csrf\tx\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "jar.txt"
        path.write_text(raw, encoding="utf-8")
        board = SimpleNamespace(cookie_file=str(path), base_url="https://simpcity.cr")
        cookies = load_cookies(board)
    assert "yMziCv8BrCZz1o7_session" in cookies
    assert missing_auth_cookies(cookies) == []


def test_retry_after_uses_long_default():
    assert _retry_after_seconds(_Resp(429, headers={"Retry-After": "200"})) == 200.0
    assert _retry_after_seconds(_Resp(429, headers={"Retry-After": "999"})) == 300.0
    assert _retry_after_seconds(_Resp(429)) == 180.0


def test_429_stops_immediately_and_blocks_next_call():
    from app.forums import client as forum_client
    forum_client._COOLDOWN_UNTIL.clear()

    session = _Session([_Resp(429)])
    board = SimpleNamespace(
        key="simpcity-test-stop",
        label="SimpCity",
        base_url="https://simpcity.cr",
        cookie_file="missing.netscape.txt",
    )
    client = ForumClient(board, session=session)
    client.cookies = {"a": "b"}
    client.missing = []

    async def _go():
        await client.get("https://simpcity.cr/x", require_auth=False)

    try:
        asyncio.run(_go())
        raise AssertionError("expected ForumRateLimitError")
    except ForumRateLimitError:
        pass
    assert session.calls == 1

    try:
        asyncio.run(_go())
        raise AssertionError("expected cooldown ForumRateLimitError")
    except ForumRateLimitError as exc:
        assert "Ďalší pokus" in str(exc) or "throttle" in str(exc)
    assert session.calls == 1  # did not hit the forum again


def test_fresh_unchanged_thread_is_skipped():
    now = datetime.utcnow()
    data = {"url": "https://simpcity.cr/threads/x.1/", "last_post_at": now - timedelta(hours=2)}
    row = SimpleNamespace(
        last_post_at=now - timedelta(hours=2),
        last_checked_at=now - timedelta(minutes=3),
    )
    assert _thread_needs_fetch(row, data) is False
    row.scan_cursor_url = "https://simpcity.cr/threads/x/page-2"
    assert _thread_needs_fetch(row, data) is True
    row.scan_cursor_url = ""
    row.last_checked_at = now - timedelta(hours=2)
    assert _thread_needs_fetch(row, data) is True
    row.last_checked_at = now - timedelta(minutes=3)
    data["last_post_at"] = now
    assert _thread_needs_fetch(row, data) is True
    assert _thread_needs_fetch(None, data) is True
