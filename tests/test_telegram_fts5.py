import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from app import database
from app.telegram_index import (
    upsert_telegram_media_batch,
    search_telegram_fts,
    get_telegram_index_stats,
    clear_telegram_index,
    _build_fts5_query_string,
)


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'fts_test.db'}", connect_args={"check_same_thread": False})
    monkeypatch.setattr(database, "engine", engine)
    factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    monkeypatch.setattr(database, "SessionLocal", factory)
    database.init_db()
    with engine.begin() as conn:
        if not conn.execute(text("SELECT 1 FROM sqlite_master WHERE name='telegram_media_fts'")).scalar():
            conn.execute(text("CREATE VIRTUAL TABLE telegram_media_fts USING fts5(title, caption, file_name, channel, author)"))
            conn.execute(text("""
                CREATE TRIGGER IF NOT EXISTS telegram_media_ai AFTER INSERT ON telegram_media_index BEGIN
                  INSERT INTO telegram_media_fts(rowid, title, caption, file_name, channel, author)
                  VALUES (new.id, coalesce(new.title, ''), coalesce(new.caption, ''), coalesce(new.file_name, ''), coalesce(new.channel, ''), coalesce(new.author, ''));
                END;
            """))
            conn.execute(text("""
                CREATE TRIGGER IF NOT EXISTS telegram_media_ad AFTER DELETE ON telegram_media_index BEGIN
                  DELETE FROM telegram_media_fts WHERE rowid = old.id;
                END;
            """))
            conn.execute(text("""
                CREATE TRIGGER IF NOT EXISTS telegram_media_au AFTER UPDATE ON telegram_media_index
                FOR EACH ROW
                WHEN (old.title IS NOT new.title OR old.caption IS NOT new.caption OR old.file_name IS NOT new.file_name OR old.channel IS NOT new.channel OR old.author IS NOT new.author)
                BEGIN
                  DELETE FROM telegram_media_fts WHERE rowid = old.id;
                  INSERT INTO telegram_media_fts(rowid, title, caption, file_name, channel, author)
                  VALUES (new.id, coalesce(new.title, ''), coalesce(new.caption, ''), coalesce(new.file_name, ''), coalesce(new.channel, ''), coalesce(new.author, ''));
                END;
            """))
    yield factory
    engine.dispose()


def test_fts5_query_builder():
    assert _build_fts5_query_string("") == ""
    assert _build_fts5_query_string("blonde") == '"blonde"*'
    assert _build_fts5_query_string("blonde bimbo") == '"blonde"* AND "bimbo"*'
    or_query = _build_fts5_query_string("blonde, brunette")
    assert '"blonde"*' in or_query
    assert '"brunette"*' in or_query
    assert "OR" in or_query


def test_upsert_and_triggers(isolated_db):
    with isolated_db() as db:
        sample_videos = [
            {
                "chat_id": 1001,
                "message_id": 42,
                "channel": "vip_leaks",
                "channel_title": "VIP Leaks Channel",
                "author": "Alice",
                "title": "Stunning Blonde Vacation Video",
                "text": "Exclusive POV clip at the beach",
                "file_name": "blonde_beach_4k.mp4",
                "duration_sec": 720,
                "duration": "12:00",
                "size_bytes": 104857600,  # 100 MB
                "width": 3840,
                "height": 2160,
                "effective_res": 2160,
                "quality": "4K",
                "date": "2026-10-25T12:00:00",
                "thumbnail": "/thumb/1001/42.jpg",
                "has_thumb": True,
            },
            {
                "chat_id": 1001,
                "message_id": 43,
                "channel": "vip_leaks",
                "channel_title": "VIP Leaks Channel",
                "author": "Alice",
                "title": "Brunette Fitness Workout",
                "text": "Gym training session in studio",
                "file_name": "gym_workout_1080p.mp4",
                "duration_sec": 300,
                "duration": "05:00",
                "size_bytes": 52428800,  # 50 MB
                "width": 1920,
                "height": 1080,
                "effective_res": 1080,
                "quality": "1080p",
                "date": "2026-10-25T13:00:00",
                "thumbnail": "/thumb/1001/43.jpg",
                "has_thumb": True,
            },
        ]

        count = upsert_telegram_media_batch(db, sample_videos)
        assert count == 2

        # Verify FTS table was populated automatically by DB triggers
        fts_rows = db.execute(text("SELECT count(*) FROM telegram_media_fts")).scalar()
        assert fts_rows == 2

        # Test search matching title
        results = search_telegram_fts(db, "blonde")
        assert len(results) == 1
        assert results[0]["message_id"] == 42
        assert results[0]["quality"] == "4K"
        assert results[0]["effective_res"] == 2160

        # Test search matching caption/text
        results_pov = search_telegram_fts(db, "beach")
        assert len(results_pov) == 1
        assert results_pov[0]["message_id"] == 42

        # Test search matching file name
        results_fn = search_telegram_fts(db, "workout")
        assert len(results_fn) == 1
        assert results_fn[0]["message_id"] == 43

        # Test search with multiple words (AND)
        results_and = search_telegram_fts(db, "brunette gym")
        assert len(results_and) == 1
        assert results_and[0]["message_id"] == 43


def test_fts_filters_and_quality(isolated_db):
    with isolated_db() as db:
        videos = [
            {
                "chat_id": 2001,
                "message_id": 1,
                "channel": "clips_channel",
                "title": "Short SD Clip",
                "text": "Fun dance in living room",
                "duration_sec": 45,
                "duration": "00:45",
                "size_bytes": 10485760,  # 10 MB
                "effective_res": 480,
                "quality": "480p",
            },
            {
                "chat_id": 2001,
                "message_id": 2,
                "channel": "clips_channel",
                "title": "Long HD Movie",
                "text": "Full length party celebration",
                "duration_sec": 1800,
                "duration": "30:00",
                "size_bytes": 524288000,  # 500 MB
                "effective_res": 1080,
                "quality": "1080p",
            },
        ]
        upsert_telegram_media_batch(db, videos)

        # Filter by min_duration: 60s should exclude message 1
        dur_results = search_telegram_fts(db, "*", min_duration=60)
        assert len(dur_results) == 1
        assert dur_results[0]["message_id"] == 2

        # Filter by min_quality: 1080p should only return message 2
        qual_results = search_telegram_fts(db, "*", min_quality=1080)
        assert len(qual_results) == 1
        assert qual_results[0]["message_id"] == 2

        # Filter by min_size_mb: 100 MB should only return message 2
        size_results = search_telegram_fts(db, "*", min_size_mb=100)
        assert len(size_results) == 1
        assert size_results[0]["message_id"] == 2


def test_stats_and_clear(isolated_db):
    with isolated_db() as db:
        stats_empty = get_telegram_index_stats(db)
        assert stats_empty["total_videos"] == 0

        upsert_telegram_media_batch(db, [
            {
                "chat_id": 3001,
                "message_id": 10,
                "channel": "test_chan",
                "title": "Indexed Test Video",
                "size_bytes": 1000000,
            }
        ])

        stats = get_telegram_index_stats(db)
        assert stats["total_videos"] == 1
        assert stats["total_channels"] == 1
        assert stats["fts_enabled"] is True

        cleared = clear_telegram_index(db)
        assert cleared == 1
        assert get_telegram_index_stats(db)["total_videos"] == 0


def test_search_global_api_route(isolated_db):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers.telegram import router
    from app.auth import check_auth

    with isolated_db() as db:
        upsert_telegram_media_batch(db, [
            {
                "chat_id": 4001,
                "message_id": 99,
                "channel": "fast_channel",
                "title": "Quantum Speed Showcase",
                "text": "Testing sub-millisecond local indexing",
                "duration_sec": 120,
                "duration": "02:00",
                "effective_res": 1080,
                "quality": "1080p",
            }
        ])

    app = FastAPI()
    app.include_router(router, prefix="/api/v1")

    def db_dependency():
        with isolated_db() as db:
            yield db

    app.dependency_overrides[database.get_db] = db_dependency
    app.dependency_overrides[check_auth] = lambda: True

    client = TestClient(app)
    response = client.get("/api/v1/telegram/search_global?query=Quantum")
    assert response.status_code == 200
    data = response.json()
    assert data["source"] == "fts5_local"
    assert data["count"] == 1
    assert data["videos"][0]["message_id"] == 99
    assert data["videos"][0]["title"] == "Quantum Speed Showcase"


def test_hybrid_compound_recall_exclusions_dedup_and_sort(isolated_db):
    with isolated_db() as db:
        upsert_telegram_media_batch(db, [
            {
                "chat_id": 5001,
                "message_id": 1,
                "channel": "chan_a",
                "channel_title": "Channel A",
                "file_id": "fid_shared",
                "title": "Exact Kiss Scene",
                "text": "Direct word match",
                "views": 100,
                "duration_sec": 120,
                "effective_res": 720,
                "size_bytes": 10_000_000,
                "date": "2026-10-01",
            },
            {
                "chat_id": 5002,
                "message_id": 2,
                "channel": "chan_b",
                "channel_title": "Channel B",
                "file_id": "fid_shared",
                "title": "Exact Kiss Scene",
                "text": "Repost with higher views",
                "views": 9500,
                "duration_sec": 120,
                "effective_res": 720,
                "size_bytes": 10_000_000,
                "date": "2026-10-02",
            },
            {
                "chat_id": 5003,
                "message_id": 3,
                "channel": "chan_c",
                "channel_title": "Channel C",
                "file_id": "fid_camel",
                "title": "Studio Reel",
                "text": "Starring #CherryKiss_Official #Gia_Derza",
                "file_name": "CherryKiss_4K.mp4",
                "views": 50000,
                "duration_sec": 900,
                "effective_res": 2160,
                "size_bytes": 500_000_000,
                "date": "2026-10-03",
            },
            {
                "chat_id": 5004,
                "message_id": 4,
                "channel": "chan_d",
                "channel_title": "Channel D",
                "file_id": "fid_excluded",
                "title": "Excluded Kiss Clip",
                "text": "#NoSpam unwanted_tag",
                "views": 99999,
                "duration_sec": 60,
                "effective_res": 1080,
                "size_bytes": 50_000_000,
                "date": "2026-10-04",
            },
        ])

        # Hybrid FTS5 + LIKE matches CamelCase #CherryKiss_Official & deduplicates fid_shared
        res = search_telegram_fts(db, "kiss -unwanted", limit=50)
        fids = [r["file_id"] for r in res]
        assert "fid_shared" in fids
        assert "fid_camel" in fids
        assert "fid_excluded" not in fids
        assert len(res) == 2

        shared = next(r for r in res if r["file_id"] == "fid_shared")
        assert shared["views"] == 9500
        assert set(shared["source_channels"]) == {"Channel A", "Channel B"}

        # Compound hashtag search ("derza" inside #Gia_Derza) + exclude param
        derza = search_telegram_fts(db, "derza", exclude="unwanted")
        assert [r["file_id"] for r in derza] == ["fid_camel"]

        # Pipe OR syntax
        pipe_res = search_telegram_fts(db, "derza | kiss", exclude="unwanted")
        assert len(pipe_res) == 2

        # Server-side sort by views
        by_views = search_telegram_fts(db, "kiss", exclude="unwanted", sort="views")
        assert [r["file_id"] for r in by_views] == ["fid_camel", "fid_shared"]

        # Pure punctuation returns empty
        assert search_telegram_fts(db, "!!!") == []


def test_normalized_fts_tokens_like_coverage_and_better_quality_duration(isolated_db, monkeypatch):
    import asyncio
    from app.telegram_index import (
        _extract_normalized_fts_tokens,
        measure_telegram_like_coverage,
        search_telegram_fts,
        upsert_telegram_media_batch,
    )
    import app.nexus_intel as ni

    tokens = _extract_normalized_fts_tokens(
        "Exclusive Scene",
        "#CherryKiss_Official #4KUltraHD",
        "GiaDerza_Scene02_1080p.mp4",
    )
    for expected in ("cherry", "kiss", "official", "gia", "derza", "scene", "1080p"):
        assert expected in tokens

    with isolated_db() as db:
        upsert_telegram_media_batch(
            db,
            [
                {
                    "chat_id": 7001,
                    "message_id": 10,
                    "channel": "c1",
                    "title": "Clip 1",
                    "text": "#Angelique_VIP",
                    "file_name": "Angelique_Part1.mp4",
                    "duration_sec": 300,
                    "effective_res": 1080,
                    "date": "2026-10-10T10:00:00",
                },
                {
                    "chat_id": 7001,
                    "message_id": 11,
                    "channel": "c1",
                    "title": "Clip 2",
                    "text": "#Angelique_VIP",
                    "file_name": "Angelique_Part2.mp4",
                    "duration_sec": 420,
                    "effective_res": 1080,
                    "date": "2026-10-11T10:00:00",
                },
            ],
        )
        cov = measure_telegram_like_coverage(db, ["angelique", "part1"])
        assert len(cov["queries"]) == 2
        assert cov["overall_fts_coverage"] == 1.0
        assert all(q["like_only_hits"] == 0 for q in cov["queries"])

        # Chronological cursor pagination with bound filters on normal catalog queries
        page1 = search_telegram_fts(db, "angelique", limit=1, sort="date", min_quality=1080)
        assert len(page1) == 1
        assert page1[0]["message_id"] == 11
        page2 = search_telegram_fts(
            db,
            "angelique",
            limit=1,
            sort="date",
            min_quality=1080,
            before_date=page1[0]["date"],
            before_id=page1[0]["_catalog_id"],
        )
        assert len(page2) == 1
        assert page2[0]["message_id"] == 10

    # Better Quality Finder: short trailer must not be chosen as quality upgrade for a full video
    async def _fake_searcher(_q):
        return [
            {
                "source": "eporner",
                "url": "https://eporner.com/trailer-4k",
                "title": "Angelique VIP Full Studio Scene",
                "thumb": "",
                "height": 2160,
                "duration": 35,
            },
            {
                "source": "pornhub",
                "url": "https://pornhub.com/full-1080p",
                "title": "Angelique VIP Full Studio Scene",
                "thumb": "",
                "height": 1080,
                "duration": 1805,
            },
        ]

    monkeypatch.setattr(ni, "_CROSS_SEARCHERS", {"fake": _fake_searcher})
    res = asyncio.run(
        ni.find_better_quality(
            "Angelique VIP Full Studio Scene",
            source_height=720,
            source_duration=1800,
        )
    )
    assert res["better"] is not None
    assert res["better"]["url"] == "https://pornhub.com/full-1080p"
    assert res["better"]["relation"] == "upgrade_quality"
    assert len(res["compare_candidates"]) == 1
    assert res["compare_candidates"][0]["url"] == "https://eporner.com/trailer-4k"
    assert res["compare_candidates"][0]["relation"] == "probable_cut"

