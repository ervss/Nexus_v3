import asyncio
from types import SimpleNamespace

from telethon.errors import FileReferenceExpiredError, LimitInvalidError

from app import telegram_stream


def test_direct_stream_respects_range_and_closes_without_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(telegram_stream, "CACHE_DIR", tmp_path)
    data = b"0123456789"

    class Iterator:
        def __init__(self, offset):
            self.offset = offset
            self.closed = False

        def __aiter__(self):
            return self

        async def __anext__(self):
            if self.offset >= len(data):
                raise StopAsyncIteration
            chunk = data[self.offset:self.offset + 3]
            self.offset += len(chunk)
            return chunk

        async def close(self):
            self.closed = True

    class Connection:
        def iter_download(self, document, **kwargs):
            self.stream = Iterator(kwargs["offset"])
            return self.stream

    async def run():
        connection = Connection()
        document = SimpleNamespace(size=len(data))
        result = b"".join([chunk async for chunk in telegram_stream.iter_video(
            connection, document, 2, 6, chat_id=1, message_id=2
        )])
        assert result == b"23456"
        assert connection.stream.closed
        assert list(tmp_path.iterdir()) == []

    asyncio.run(run())


def test_direct_stream_aligns_offset_to_avoid_telethon_limit_invalid():
    """Regression for video 12789 (size=50187698, offset=50036736).

    50036736 is divisible by 4096 and by chunk count 96, which triggers
    Telethon's _DirectDownloadIter bug and crosses a 1 MiB boundary.
    iter_video must pass a request_size-aligned offset that never crosses 1 MiB.
    """
    file_size = 50_187_698
    req_start = 50_036_736
    req_end = file_size - 1
    part = telegram_stream.PART
    expected_aligned = (req_start // part) * part  # 49_807_360
    tail_len = file_size - expected_aligned
    payload = bytes((i % 251) for i in range(tail_len))

    seen_calls = []

    class Iterator:
        def __init__(self, offset, request_size):
            self.offset = offset
            self.request_size = request_size
            self.closed = False
            self.sent = False

        def __aiter__(self):
            return self

        async def __anext__(self):
            if self.sent:
                raise StopAsyncIteration
            self.sent = True
            # Enforce Telegram's upload.getFile 1 MiB boundary rule.
            assert self.offset % self.request_size == 0
            assert (self.offset % (1024 * 1024)) + self.request_size <= 1024 * 1024
            rel = self.offset - expected_aligned
            return memoryview(payload[rel:])

        async def close(self):
            self.closed = True

    class Connection:
        def iter_download(self, document, **kwargs):
            seen_calls.append(kwargs)
            return Iterator(kwargs["offset"], kwargs["request_size"])

    async def run():
        document = SimpleNamespace(size=file_size)
        result = b"".join([chunk async for chunk in telegram_stream.iter_video(
            Connection(), document, req_start, req_end, chat_id=3931751368, message_id=105168
        )])
        assert seen_calls[0]["offset"] == expected_aligned
        assert seen_calls[0]["request_size"] == part
        skip = req_start - expected_aligned
        assert result == payload[skip:]

    asyncio.run(run())


def test_direct_stream_falls_back_on_limit_invalid_without_duplication():
    payload = bytes((i % 251) for i in range(600_000))
    req_start = 10_000
    req_end = 590_000
    calls = []

    class Iterator:
        def __init__(self, offset, request_size):
            self.offset = offset
            self.request_size = request_size
            self.closed = False

        def __aiter__(self):
            return self

        async def __anext__(self):
            if self.request_size == telegram_stream.PART:
                raise LimitInvalidError(request=None)
            if self.offset >= len(payload):
                raise StopAsyncIteration
            chunk = payload[self.offset:self.offset + self.request_size]
            self.offset += len(chunk)
            return chunk

        async def close(self):
            self.closed = True

    class Connection:
        def iter_download(self, document, **kwargs):
            calls.append((kwargs["offset"], kwargs["request_size"]))
            return Iterator(kwargs["offset"], kwargs["request_size"])

    async def run():
        document = SimpleNamespace(size=len(payload))
        result = b"".join([chunk async for chunk in telegram_stream.iter_video(
            Connection(), document, req_start, req_end, chat_id=1, message_id=2
        )])
        assert calls[0] == (0, telegram_stream.PART)
        assert calls[1] == (0, 256 * 1024)
        assert result == payload[req_start:req_end + 1]

    asyncio.run(run())


def test_direct_stream_refreshes_expired_file_reference_mid_stream(monkeypatch):
    payload = bytes((i % 251) for i in range(20))
    old_doc = SimpleNamespace(size=len(payload), tag="old")
    new_doc = SimpleNamespace(size=len(payload), tag="new")
    refresh_calls = []

    class Iterator:
        def __init__(self, doc, offset):
            self.doc = doc
            self.offset = offset
            self.closed = False

        def __aiter__(self):
            return self

        async def __anext__(self):
            if self.doc.tag == "old":
                if self.offset == 0:
                    self.offset = 8
                    return payload[:8]
                raise FileReferenceExpiredError(request=None)
            if self.offset >= len(payload):
                raise StopAsyncIteration
            chunk = payload[self.offset:]
            self.offset = len(payload)
            return chunk

        async def close(self):
            self.closed = True

    class Connection:
        def iter_download(self, document, **kwargs):
            return Iterator(document, kwargs["offset"])

    conn = Connection()

    async def fake_get_video_message(chat_id, message_id, *, force_refresh=False):
        refresh_calls.append((chat_id, message_id, force_refresh))
        return conn, SimpleNamespace(), new_doc

    monkeypatch.setattr(telegram_stream, "get_video_message", fake_get_video_message)

    async def run():
        result = b"".join([chunk async for chunk in telegram_stream.iter_video(
            conn, old_doc, 3, 17, chat_id=99, message_id=100
        )])
        assert result == payload[3:18]
        assert refresh_calls == [(99, 100, True)]

    asyncio.run(run())


def test_get_video_message_caches_and_invalidates(monkeypatch):
    telegram_stream._message_cache.clear()
    fetch_count = 0

    class FakeClient:
        async def is_user_authorized(self):
            return True

        async def get_messages(self, peer, ids):
            nonlocal fetch_count
            fetch_count += 1
            return SimpleNamespace(
                document=SimpleNamespace(mime_type="video/mp4", size=1234, version=fetch_count)
            )

    fake_client = FakeClient()

    async def fake_client_fn():
        return fake_client

    monkeypatch.setattr(telegram_stream, "client", fake_client_fn)

    async def run():
        _c, _m, d1 = await telegram_stream.get_video_message(3931751368, 105168)
        _c, _m, d2 = await telegram_stream.get_video_message(-1003931751368, 105168)
        assert fetch_count == 1
        assert d1.version == d2.version == 1

        _c, _m, d3 = await telegram_stream.get_video_message(3931751368, 105168, force_refresh=True)
        assert fetch_count == 2
        assert d3.version == 2

    asyncio.run(run())
