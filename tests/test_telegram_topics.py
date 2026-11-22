from types import SimpleNamespace

import pytest
from telethon.tl.types import DocumentAttributeVideo

from app import telegram_service


def test_topic_id_comes_from_the_thread_root():
    message = SimpleNamespace(id=50, reply_to=SimpleNamespace(reply_to_top_id=92078, forum_topic=True))
    assert telegram_service.topic_id_from_message(message) == 92078


def test_general_topic_stays_unlabeled():
    message = SimpleNamespace(id=5, reply_to=SimpleNamespace(reply_to_top_id=1, forum_topic=True))
    assert telegram_service.topic_id_from_message(message) is None


def test_topic_root_message_uses_its_own_id():
    message = SimpleNamespace(
        id=92078,
        reply_to=SimpleNamespace(reply_to_top_id=None, forum_topic=True, reply_to_msg_id=92078),
    )
    assert telegram_service.topic_id_from_message(message) == 92078


def test_direct_forum_topic_post_uses_reply_to_msg_id():
    message = SimpleNamespace(
        id=92150,
        reply_to=SimpleNamespace(reply_to_top_id=None, forum_topic=True, reply_to_msg_id=92078),
    )
    assert telegram_service.topic_id_from_message(message) == 92078


def test_row_keeps_topic_id_for_a_forum_video():
    document = SimpleNamespace(
        id=7,
        attributes=[DocumentAttributeVideo(duration=1152, w=1280, h=720)],
        mime_type="video/mp4",
        thumbs=[1],
        size=440_000_000,
    )
    message = SimpleNamespace(
        id=99,
        document=document,
        message="clip",
        date=None,
        views=0,
        forwards=0,
        reactions=None,
        post_author=None,
        reply_to=SimpleNamespace(reply_to_top_id=92078, forum_topic=True),
    )
    entity = SimpleNamespace(id=55, username="bimbo_central", title="BIMBO CENTRAL")
    row = telegram_service._row(message, entity, "bimbo_central")
    assert row["topic_id"] == 92078
    assert row["topic_url"] == "https://t.me/bimbo_central/92078"
    assert row["topic_channel"] == "bimbo_central"
    assert row["topic_title"] is None


def test_scoped_scrape_stamps_the_requested_topic_when_the_message_has_none():
    document = SimpleNamespace(
        id=8,
        attributes=[DocumentAttributeVideo(duration=10, w=720, h=1280)],
        mime_type="video/mp4",
        thumbs=None,
        size=1000,
    )
    message = SimpleNamespace(
        id=12,
        document=document,
        message="",
        date=None,
        views=0,
        forwards=0,
        reactions=None,
        post_author=None,
        reply_to=None,
    )
    entity = SimpleNamespace(id=55, username="bimbo_central", title="BIMBO CENTRAL")
    row = telegram_service._row(message, entity, "bimbo_central", forced_topic_id=92078)
    assert row["topic_id"] == 92078


@pytest.mark.asyncio
async def test_topic_page_searches_with_top_msg_id():
    seen = []

    class Connection:
        async def __call__(self, request):
            seen.append(request)
            return SimpleNamespace(messages=[])

        async def get_messages(self, *args, **kwargs):
            raise AssertionError("a topic scrape must not read the whole channel")

    batch = await telegram_service._get_messages(
        Connection(),
        SimpleNamespace(id=1),
        limit=20,
        offset_id=0,
        search=None,
        filter=telegram_service.InputMessagesFilterVideo,
        topic_id=92078,
    )
    assert batch == []
    assert seen[0].top_msg_id == 92078
    assert seen[0].q == ""


@pytest.mark.asyncio
async def test_channel_page_still_uses_get_messages():
    called = []

    class Connection:
        async def get_messages(self, entity, **kwargs):
            called.append(kwargs)
            return []

    await telegram_service._get_messages(
        Connection(),
        SimpleNamespace(id=1),
        limit=20,
        offset_id=0,
        search="cherry",
        filter=telegram_service.InputMessagesFilterVideo,
    )
    assert called[0]["search"] == "cherry"
    assert "topic_id" not in called[0]


def test_merge_keeps_saved_topics_and_adds_new_ones():
    saved = [
        {"id": 1, "title": "Cyrish", "video_count": 4, "url": "https://t.me/bimbo_central/1", "last_message_at": 1700000000.0},
        {"id": 9, "title": "Old thread", "video_count": 2},
    ]
    fresh = [
        {"id": 2, "title": "BIMBO ARTWORKS", "video_count": 6, "last_message_at": 1700001000.0},
        {"id": 1, "title": "Cyrish", "video_count": None, "pinned": True, "last_message_at": 0},
    ]
    merged = telegram_service.merge_forum_topics(saved, fresh)
    assert [item["id"] for item in merged] == [2, 1, 9]
    by_id = {item["id"]: item for item in merged}
    assert by_id[1]["video_count"] == 4
    assert by_id[1]["pinned"] is True
    assert by_id[1]["url"] == "https://t.me/bimbo_central/1"
    assert by_id[1]["last_message_at"] == 1700000000.0
    assert by_id[2]["title"] == "BIMBO ARTWORKS"
    assert by_id[2]["last_message_at"] == 1700001000.0
    assert by_id[9]["video_count"] == 2


def test_saved_topics_roundtrip_keeps_a_count_when_the_new_read_has_none(monkeypatch, tmp_path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.database import Base, TelegramForumTopic

    engine = create_engine(f"sqlite:///{tmp_path / 'topics.db'}")
    Base.metadata.create_all(bind=engine, tables=[TelegramForumTopic.__table__])
    monkeypatch.setattr("app.database.SessionLocal", sessionmaker(bind=engine))
    telegram_service.save_forum_topics("-1001", [
        {"id": 7, "title": "Cyrish", "video_count": 12, "url": "https://t.me/c/1/7", "pinned": True, "last_message_at": 1700000000.0},
    ])
    telegram_service.save_forum_topics("-1001", [
        {"id": 7, "title": "Cyrish", "video_count": None, "closed": True, "last_message_at": 0},
        {"id": 8, "title": "BIMBO GIFS", "video_count": 3, "last_message_at": 1700002222.0},
    ])
    loaded = telegram_service.load_saved_forum_topics("-1001")["-1001"]
    by_id = {item["id"]: item for item in loaded}
    assert by_id[7]["video_count"] == 12
    assert by_id[7]["closed"] is True
    assert by_id[7]["pinned"] is False
    assert by_id[7]["url"] == "https://t.me/c/1/7"
    assert by_id[7]["last_message_at"] == 1700000000.0
    assert by_id[8]["title"] == "BIMBO GIFS"
    assert by_id[8]["video_count"] == 3
    assert by_id[8]["last_message_at"] == 1700002222.0
    assert telegram_service.load_saved_forum_topics("-1002") == {}


def test_topic_timestamp_uses_the_latest_message():
    from datetime import datetime, timezone

    latest = datetime(2026, 11, 16, 12, 30, tzinfo=timezone.utc)
    older = datetime(2020, 1, 1, tzinfo=timezone.utc)
    topic = SimpleNamespace(id=5, top_message=90)
    assert telegram_service._topic_timestamp(topic, {90: latest, 3: older}) == latest.timestamp()
    assert telegram_service._topic_timestamp(SimpleNamespace(top_message=1), {90: latest}) is None
    assert telegram_service._topic_timestamp(SimpleNamespace(top_message=90), {90: "nie"}) is None


@pytest.mark.asyncio
async def test_topic_counts_stop_after_the_requested_batch():
    asked = []

    class Connection:
        async def __call__(self, request):
            asked.append(request.top_msg_id)
            return [SimpleNamespace(count=3)]

    book = telegram_service._TopicBook()
    finished = await telegram_service._load_topic_counts(Connection(), SimpleNamespace(), [1, 2, 3], book, limit=2)
    assert finished is False
    assert asked == [1, 2]
    assert book.counts == {1: 3, 2: 3}


@pytest.mark.asyncio
async def test_missing_counts_skip_the_cache_and_keep_known_numbers(monkeypatch):
    telegram_service._TOPIC_LIST_CACHE.clear()
    saved = [
        {"id": 1, "title": "Cyrish", "video_count": 4, "url": "", "closed": False, "pinned": False, "last_message_at": 1700000000.0},
        {"id": 2, "title": "BIMBO GIFS", "video_count": None, "url": "", "closed": False, "pinned": False, "last_message_at": 1700000001.0},
    ]
    asked = []

    async def open_channel(_name):
        return SimpleNamespace(), SimpleNamespace(id=5, username="group", forum=True, title="Group"), "group"

    async def load_counts(_connection, _entity, topic_ids, book, limit=None):
        asked.extend(topic_ids)
        assert limit == telegram_service._TOPIC_COUNT_BATCH
        for topic_id in topic_ids:
            book.counts[int(topic_id)] = 9
        return True

    monkeypatch.setattr(telegram_service, "_open_channel", open_channel)
    monkeypatch.setattr(telegram_service, "load_saved_forum_topics", lambda peer_id=None: {"group": [dict(item) for item in saved]})
    monkeypatch.setattr(telegram_service, "_load_topic_counts", load_counts)
    monkeypatch.setattr(telegram_service, "save_forum_topics", lambda peer_id, topics: None)
    telegram_service._TOPIC_LIST_CACHE["group"] = (telegram_service.time.monotonic(), {
        "channel": "group", "forum": True, "topics": [{"id": 1, "video_count": 1}], "counts_partial": True, "stale": False,
    })
    try:
        result = await telegram_service.list_forum_topics("group", counts="missing")
    finally:
        telegram_service._TOPIC_LIST_CACHE.pop("group", None)
    assert asked == [2]
    assert {item["id"]: item["video_count"] for item in result["topics"]} == {1: 4, 2: 9}
    assert result["counts_partial"] is False
    assert result["counts_limited"] is False
    assert result["filled"] == 1
    assert result["asked"] == 1


@pytest.mark.asyncio
async def test_recount_all_skips_ahead_in_topic_id_order(monkeypatch):
    telegram_service._TOPIC_LIST_CACHE.clear()
    saved = [
        {"id": 3, "title": "C", "video_count": 1, "url": "", "closed": False, "pinned": False, "last_message_at": 12.0},
        {"id": 1, "title": "A", "video_count": 2, "url": "", "closed": False, "pinned": False, "last_message_at": 10.0},
        {"id": 2, "title": "B", "video_count": 3, "url": "", "closed": False, "pinned": False, "last_message_at": 11.0},
    ]
    seen = {}

    async def open_channel(_name):
        return SimpleNamespace(), SimpleNamespace(id=5, username="group", forum=True, title="Group"), "group"

    async def load_counts(_connection, _entity, topic_ids, book, limit=None):
        seen["ids"] = list(topic_ids)
        seen["limit"] = limit
        for topic_id in topic_ids:
            book.counts[int(topic_id)] = 8
        return True

    monkeypatch.setattr(telegram_service, "_open_channel", open_channel)
    monkeypatch.setattr(telegram_service, "load_saved_forum_topics", lambda peer_id=None: {"group": [dict(item) for item in saved]})
    monkeypatch.setattr(telegram_service, "_load_topic_counts", load_counts)
    monkeypatch.setattr(telegram_service, "save_forum_topics", lambda peer_id, topics: None)
    result = await telegram_service.list_forum_topics("group", counts="all", batch=20, skip=1)
    assert seen == {"ids": [2, 3], "limit": 20}
    assert result["asked"] == 2
    assert {item["id"]: item["video_count"] for item in result["topics"]} == {1: 2, 2: 8, 3: 8}


@pytest.mark.asyncio
async def test_plain_channel_has_no_topics(monkeypatch):
    telegram_service._TOPIC_LIST_CACHE.clear()

    async def open_channel(_name):
        return SimpleNamespace(), SimpleNamespace(id=5, username="plain", forum=False), "plain"

    monkeypatch.setattr(telegram_service, "_open_channel", open_channel)
    monkeypatch.setattr(telegram_service, "load_saved_forum_topics", lambda peer_id=None: {})
    result = await telegram_service.list_forum_topics("plain")
    assert result["forum"] is False
    assert result["topics"] == []
