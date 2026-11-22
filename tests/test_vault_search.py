import sqlite3
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import check_auth
from app.database import (
    Base,
    DiscoveredVideo,
    ForumLink,
    ForumPost,
    ForumThread,
    ImportJob,
    ImportJobItem,
    MegaHubEntry,
    TelegramMediaIndex,
    Video,
    get_db,
)
from app.routers.vault import router as vault_router
from app.vault_search import get_vault_stats, search_local_vault


def _build_filester_db(path: Path, rows: list[tuple]) -> None:
    conn = sqlite3.connect(str(path))
    conn.execute(
        """
        CREATE TABLE pages (
            url TEXT, folder_id TEXT, kind TEXT, title TEXT, description TEXT,
            file_count INTEGER, filenames TEXT, tags TEXT, source TEXT, last_seen REAL
        )
        """
    )
    conn.execute(
        "CREATE VIRTUAL TABLE pages_fts USING fts5(url, folder_id, title, description, filenames, tags)"
    )
    for url, fid, title, desc, fcnt, fnames, tags, src in rows:
        conn.execute(
            "INSERT INTO pages VALUES (?, ?, 'folder', ?, ?, ?, ?, ?, ?, 1.0)",
            (url, fid, title, desc, fcnt, fnames, tags, src),
        )
        conn.execute(
            "INSERT INTO pages_fts VALUES (?, ?, ?, ?, ?, ?)",
            (url, fid, title, desc, fnames, tags),
        )
    conn.commit()
    conn.close()


@pytest.fixture
def vault_env(tmp_path: Path, monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)

    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE VIRTUAL TABLE telegram_media_fts USING fts5("
                "title, caption, file_name, channel, author, "
                "content='telegram_media_index', content_rowid='id')"
            )
        )
        conn.execute(
            text(
                "CREATE VIRTUAL TABLE videos_fts USING fts5("
                "title, tags, ai_tags, batch_name, "
                "content='videos', content_rowid='id')"
            )
        )

    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    filester_a = tmp_path / "filester_a.db"
    filester_b = tmp_path / "filester_b.db"
    _build_filester_db(
        filester_a,
        [
            ("https://filester.me/f/abc111", "abc111", "StellaPack 2026", "pack", 12, "stella_1080p.mp4", "stella", "crawl"),
        ],
    )
    # Duplicate folder_id abc111 across two DBs must deduplicate
    _build_filester_db(
        filester_b,
        [
            ("https://filester.me/f/abc111", "abc111", "StellaPack 2026", "pack", 12, "stella_1080p.mp4", "stella", "crawl"),
            ("https://filester.me/f/xyz222", "xyz222", "OtherModel 720p", "pack", 4, "clip_720p.mp4", "other", "crawl"),
        ],
    )
    monkeypatch.setenv("NEXUS_FILESTER_DB_PATHS", f"{filester_a}{';' if Path.home().drive else ':'}{filester_b}")

    with TestingSessionLocal() as db:
        v = Video(
            title="Stella Library 4K Clip",
            url="https://cdn.example.com/stella_4k.mp4",
            source_url="https://eporner.com/video-123/stella",
            height=2160,
            quality="4K",
            tags="stella, blonde",
            storage_type="remote",
        )
        db.add(v)
        db.flush()
        db.execute(
            text("INSERT INTO videos_fts(rowid, title, tags, ai_tags, batch_name) VALUES (:id, :t, :tg, '', '')"),
            {"id": v.id, "t": v.title, "tg": v.tags},
        )

        tg = TelegramMediaIndex(
            chat_id=100999,
            message_id=77,
            channel="@vip_leaks",
            channel_title="VIP Leaks",
            author="admin",
            title="Stella Exclusive TG",
            caption="Fresh #stella clip",
            file_name="stella_tg_1080p.mp4",
            duration_sec=185,
            width=1920,
            height=1080,
            effective_res=1080,
            quality="1080p",
            size_bytes=52428800,
            url="https://t.me/vip_leaks/77",
            stream_url="/api/v1/telegram/stream/100999/77",
            has_thumb=True,
        )
        db.add(tg)
        db.flush()
        db.execute(
            text(
                "INSERT INTO telegram_media_fts(rowid, title, caption, file_name, channel, author) "
                "VALUES (:id, :t, :c, :f, :ch, :au)"
            ),
            {"id": tg.id, "t": tg.title, "c": tg.caption, "f": tg.file_name, "ch": tg.channel, "au": tg.author},
        )

        thread = ForumThread(
            board="simpcity",
            url="https://simpcity.cr/threads/stella-thread.1/",
            title="Stella Creator Thread",
        )
        db.add(thread)
        db.flush()
        post = ForumPost(
            thread_id=thread.id,
            post_id="p100",
            permalink="https://simpcity.cr/posts/100/",
            author="PosterOne",
            body_text="New bunkr mirror for Stella 1080p",
        )
        db.add(post)
        db.flush()
        flink = ForumLink(
            thread_id=thread.id,
            post_id=post.id,
            url="https://bunkr.cr/a/STELLA99",
            platform="bunkr",
            title="Spoiler:",
            quality="1080p",
            status="new",
        )
        db.add(flink)

        mega = MegaHubEntry(
            url="https://mega.nz/folder/AAAABBBB#CCCCCCCCCCCCCCCCCCCCCC",
            title="Creator Archive 2026",
            kind="folder",
            snapshot={
                "title": "Creator Archive 2026",
                "videos": [
                    {"ref": "mega:n:AAAABBBB:11112222:key", "name": "Stella_Backstage_720p.mp4", "size": 20971520}
                ],
            },
        )
        db.add(mega)

        job = ImportJob(batch_name="Test Batch", source_mode="mixed", status="failed")
        db.add(job)
        db.flush()
        db.add(
            ImportJobItem(
                job_id=job.id,
                url="https://pixeldrain.com/u/stella77",
                source_url="https://pixeldrain.com/u/stella77",
                title="Stella Failed Queue Item",
                height=720,
                status="failed",
            )
        )
        db.add(
            DiscoveredVideo(
                profile_id=1,
                profile_name="Daily",
                title="Stella Discovered 1080p",
                url="https://porntrex.com/video/999/stella",
                source_url="https://porntrex.com/video/999/stella",
                height=1080,
                source="porntrex",
                imported=False,
            )
        )
        db.commit()

    def override_get_db():
        s = TestingSessionLocal()
        try:
            yield s
        finally:
            s.close()

    app = FastAPI()
    app.include_router(vault_router)
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[check_auth] = lambda: True

    with TestClient(app) as client:
        yield client, TestingSessionLocal, [filester_a, filester_b]

    Base.metadata.drop_all(engine)


def test_vault_stats_and_cross_bucket_search(vault_env):
    _client, SessionCls, filester_paths = vault_env
    with SessionCls() as db:
        stats = get_vault_stats(db, filester_db_paths=filester_paths)
        counts = {b["id"]: b["count"] for b in stats["buckets"]}
        assert counts == {
            "library": 1,
            "telegram": 1,
            "forum": 1,
            "filester": 2,
            "mega": 2,
            "queue": 2,
        }
        assert stats["total_records"] == 9

        res = search_local_vault(db, "Stella", filester_db_paths=filester_paths)
        assert res["bucket_counts"] == {
            "library": 1,
            "telegram": 1,
            "forum": 1,
            "filester": 1,
            "mega": 1,
            "queue": 2,
        }
        assert res["total"] == 7
        assert res["errors"] == {}

        # Library items must route through /stream_proxy/{id}.mp4 (handles Telegram & referer proxies)
        lib_item = next(i for i in res["items"] if i["bucket"] == "library")
        assert lib_item["playable_url"] == f"/stream_proxy/{lib_item['video_id']}.mp4"

        # Forum link with generic "Spoiler:" title should inherit thread title
        forum_item = next(i for i in res["items"] if i["bucket"] == "forum")
        assert "Stella Creator Thread" in forum_item["title"]

        # Quality filter: 1080p+ drops 720p mega/queue items
        hd_res = search_local_vault(db, "Stella", min_height=1080, filester_db_paths=filester_paths)
        assert hd_res["bucket_counts"]["mega"] == 0
        assert hd_res["bucket_counts"]["queue"] == 1
        assert hd_res["bucket_counts"]["library"] == 1
        assert hd_res["bucket_counts"]["telegram"] == 1


def test_vault_api_endpoints_and_import(vault_env, monkeypatch):
    client, SessionCls, _paths = vault_env
    # Avoid spawning real background intake worker thread in tests
    import app.routers.vault as vault_mod
    monkeypatch.setattr(vault_mod.intake_worker, "start", lambda: None)

    stats_resp = client.get("/api/vault/stats")
    assert stats_resp.status_code == 200
    assert stats_resp.json()["total_records"] == 9

    search_resp = client.get("/api/vault/search", params={"q": "Stella", "buckets": "forum,telegram"})
    assert search_resp.status_code == 200
    payload = search_resp.json()
    assert payload["total"] == 2
    items = payload["items"]

    # Import both the Telegram hit and the Forum link
    imp_resp = client.post("/api/vault/import", json={"items": items, "batch_name": "Vault Test"})
    assert imp_resp.status_code == 200
    imp_data = imp_resp.json()
    assert imp_data["success"] is True
    assert imp_data["telegram_imported"] == 1
    assert imp_data["queued_urls"] == 1
    assert imp_data["job"]["total_items"] == 1

    with SessionCls() as db:
        link = db.query(ForumLink).first()
        assert link.status == "imported"
        tg_vid = db.query(Video).filter(Video.storage_type == "telegram").first()
        assert tg_vid is not None
        assert tg_vid.telegram_message_id == 77


def test_vault_filters_and_sorting(vault_env):
    client, SessionCls, filester_paths = vault_env
    with SessionCls() as db:
        # only_playable returns library + telegram
        playable = search_local_vault(db, "Stella", only_playable=True, filester_db_paths=filester_paths)
        assert {i["bucket"] for i in playable["items"]} == {"library", "telegram"}

        # min_duration filters out 0s items and keeps Telegram (185s)
        dur = search_local_vault(db, "Stella", min_duration=120, filester_db_paths=filester_paths)
        assert dur["total"] == 1
        assert dur["items"][0]["bucket"] == "telegram"

        # min_size_mb filters out 20MB mega item and keeps 50MB Telegram item
        sz = search_local_vault(db, "Stella", min_size_mb=30, filester_db_paths=filester_paths)
        assert sz["total"] == 1
        assert sz["items"][0]["bucket"] == "telegram"

        # source_filter narrows down to bunkr / simpcity
        src = search_local_vault(db, "Stella", source_filter="bunkr", filester_db_paths=filester_paths)
        assert src["total"] == 1
        assert src["items"][0]["bucket"] == "forum"

        # sort=quality_desc puts 4K (2160) first
        by_q = search_local_vault(db, "Stella", sort="quality_desc", filester_db_paths=filester_paths)
        assert by_q["items"][0]["height"] == 2160

        # sort=title_asc sorts alphabetically
        by_title = search_local_vault(db, "Stella", sort="title_asc", filester_db_paths=filester_paths)
        titles = [i["title"] for i in by_title["items"]]
        assert titles == sorted(titles, key=str.casefold)

    # API query params pass through cleanly
    resp = client.get(
        "/api/vault/search",
        params={"q": "Stella", "only_playable": "true", "sort": "duration_desc"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert data["items"][0]["duration_sec"] == 185


def test_vault_library_hls_routes_through_hls_proxy(vault_env):
    _client, SessionCls, filester_paths = vault_env
    with SessionCls() as db:
        hls_v = Video(
            title="XHamster HLS Sex Demon Clip",
            url="https://ip123.ahcdn.com/key=abc/media=hls4/index.m3u8",
            source_url="https://ita.xhamster.com/videos/pov-you-ordered-a-sex-demon-xhpyHuQ",
            height=2160,
            quality="4K",
            tags="hls",
            storage_type="remote",
        )
        db.add(hls_v)
        db.flush()
        db.execute(
            text("INSERT INTO videos_fts(rowid, title, tags, ai_tags, batch_name) VALUES (:id, :t, :tg, '', '')"),
            {"id": hls_v.id, "t": hls_v.title, "tg": hls_v.tags},
        )
        db.commit()

        res = search_local_vault(db, "Demon", buckets=["library"], filester_db_paths=filester_paths)
        assert res["total"] == 1
        item = res["items"][0]
        assert item["is_hls"] is True
        assert item["playable_url"].startswith("/hls_proxy?url=")
        assert "index.m3u8" in item["playable_url"] or "index.m3u8" in item["url"]


def test_vault_pushdown_filters_pagination_browse_and_dedupe(vault_env):
    client, SessionCls, filester_paths = vault_env
    with SessionCls() as db:
        # Add 3 videos to library where the longest/largest has the lowest id/rank
        v_long = Video(
            title="Pushdown Target Long 4K",
            url="https://cdn.example.com/pd_long.mp4",
            source_url="https://cdn.example.com/pd_long",
            duration=900,
            height=2160,
            quality="4K",
            file_size_mb=850.0,
            tags="pushdown",
            storage_type="remote",
        )
        v_short1 = Video(
            title="Pushdown Target Short A",
            url="https://cdn.example.com/pd_s1.mp4",
            source_url="https://cdn.example.com/pd_s1",
            duration=15,
            height=1080,
            quality="1080p",
            file_size_mb=5.0,
            tags="pushdown",
            storage_type="remote",
        )
        v_short2 = Video(
            title="Pushdown Target Short B",
            url="https://cdn.example.com/pd_s2.mp4",
            source_url="https://cdn.example.com/pd_s2",
            duration=20,
            height=1080,
            quality="1080p",
            file_size_mb=8.0,
            tags="pushdown",
            storage_type="remote",
        )
        # Add duplicate discovered video sharing source_url with existing library video
        dup_disc = DiscoveredVideo(
            profile_id=1,
            profile_name="Daily",
            title="Stella Library Duplicate",
            url="https://eporner.com/video-123/stella/",
            source_url="https://eporner.com/video-123/stella/",
            height=2160,
            source="eporner",
            imported=False,
        )
        db.add_all([v_long, v_short1, v_short2, dup_disc])
        db.flush()
        for v in (v_long, v_short1, v_short2):
            db.execute(
                text("INSERT INTO videos_fts(rowid, title, tags, ai_tags, batch_name) VALUES (:id, :t, :tg, '', '')"),
                {"id": v.id, "t": v.title, "tg": v.tags},
            )
        db.commit()

        # 1) Push-down filter: limit=1 must still find the 900s video even when 2 shorter videos exist
        dur_res = search_local_vault(
            db,
            "Pushdown",
            buckets=["library"],
            min_duration=300,
            min_size_mb=500,
            limit_per_bucket=1,
            filester_db_paths=filester_paths,
        )
        assert dur_res["total"] == 1
        assert dur_res["items"][0]["title"] == "Pushdown Target Long 4K"
        assert dur_res["has_more"] is False

        # 2) Pagination: limit=2 on 3 items -> page 0 has_more=True, page 1 has 1 item and has_more=False
        p0 = search_local_vault(
            db,
            "Pushdown",
            buckets=["library"],
            sort="duration_desc",
            limit_per_bucket=2,
            offset=0,
            filester_db_paths=filester_paths,
        )
        assert p0["total"] == 2
        assert p0["has_more"] is True
        assert p0["bucket_has_more"]["library"] is True
        assert p0["items"][0]["duration_sec"] == 900

        p1 = search_local_vault(
            db,
            "Pushdown",
            buckets=["library"],
            sort="duration_desc",
            limit_per_bucket=2,
            offset=2,
            filester_db_paths=filester_paths,
        )
        assert p1["total"] == 1
        assert p1["has_more"] is False
        assert p1["items"][0]["duration_sec"] == 15

        # 3) Cross-bucket deduplication suppresses discovered duplicate of library video
        deduped = search_local_vault(db, "Stella", buckets=["library", "queue"], deduplicate=True, filester_db_paths=filester_paths)
        raw = search_local_vault(db, "Stella", buckets=["library", "queue"], deduplicate=False, filester_db_paths=filester_paths)
        assert deduped["bucket_counts"]["library"] == 1
        assert deduped["bucket_counts"]["queue"] == 2
        assert raw["bucket_counts"]["queue"] == 3

    # 4) Browse mode via API with empty query
    no_browse = client.get("/api/vault/search", params={"q": "", "buckets": "library,telegram"})
    assert no_browse.status_code == 200
    assert no_browse.json()["total"] == 0

    browse_resp = client.get("/api/vault/search", params={"q": "", "browse": "true", "buckets": "library,telegram"})
    assert browse_resp.status_code == 200
    browse_data = browse_resp.json()
    assert browse_data["browse"] is True
    assert browse_data["total"] >= 2
