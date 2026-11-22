from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.middleware.sessions import SessionMiddleware

from app.auth import check_auth
from app.creator_radar import (
    follow_creator,
    get_creator_dossier,
    list_radar_creators,
    probe_companion_targets,
    unfollow_creator,
)
from app.database import Base, ForumLink, ForumPost, ForumThread, Video, get_db
from app.routers.creator_radar import router as creator_radar_router


@pytest.fixture()
def radar_db(monkeypatch):
    monkeypatch.setenv("NEXUS_FILESTER_DB_PATHS", str(Path("nonexistent_filester.db")))
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    db = TestingSession()
    try:
        # Seed library videos
        v1 = Video(
            title="Milan Cheek Studio Session",
            url="https://cdn.example.com/milan-1080.mp4",
            source_url="https://example.com/watch/milan-1",
            models="Milan Cheek, Amirah Adara",
            tags="pov,studio",
            height=1080,
            quality="1080p",
            storage_type="local",
            file_size_mb=420.5,
            thumbnail_path="/static/thumbs/1.jpg",
        )
        v2 = Video(
            title="Milan Cheek Outdoor Clip",
            url="https://cdn.example.com/milan-4k.mp4",
            source_url="https://example.com/watch/milan-2",
            models="Milan Cheek",
            tags="outdoor",
            height=2160,
            quality="4K",
            storage_type="remote",
            file_size_mb=1200.0,
        )
        db.add_all([v1, v2])

        # Seed forum thread + links (one duplicate of v1, one brand new hidden discovery)
        th = ForumThread(
            board="simpcity",
            url="https://simpcity.example/threads/milan-cheek.123/",
            title="Milan Cheek Megathread",
        )
        db.add(th)
        db.flush()
        post = ForumPost(
            thread_id=th.id,
            post_id="p1",
            permalink="https://simpcity.example/posts/1",
            author="Poster",
            body_text="Milan Cheek pack",
        )
        db.add(post)
        db.flush()
        db.add_all([
            ForumLink(
                thread_id=th.id,
                post_id=post.id,
                url="https://example.com/watch/milan-1",
                platform="example",
                title="Milan Cheek Mirror",
                quality="1080p",
                status="new",
            ),
            ForumLink(
                thread_id=th.id,
                post_id=post.id,
                url="https://bunkr.cr/v/milan-cheek-hidden-4k",
                platform="bunkr",
                title="Milan Cheek Hidden 4K",
                quality="4K",
                status="new",
            ),
        ])
        db.commit()
        yield db
    finally:
        db.close()
        engine.dispose()


def test_follow_unfollow_and_discover_creators(radar_db):
    initial = list_radar_creators(radar_db)
    names = {c["name"]: c for c in initial["creators"]}
    assert "Milan Cheek" in names
    assert names["Milan Cheek"]["video_count"] == 2
    assert names["Milan Cheek"]["local_count"] == 1
    assert names["Milan Cheek"]["best_quality"] == "4K"

    pin = follow_creator(radar_db, "  Milan   Cheek ", notes="Top picks", source_hint="eporner")
    assert pin["followed"] is True
    assert pin["created"] is True

    pin_again = follow_creator(radar_db, "milan cheek", notes="Updated note")
    assert pin_again["id"] == pin["id"]
    assert pin_again["created"] is False

    only_f = list_radar_creators(radar_db, only_followed=True)
    assert only_f["followed_count"] == 1
    assert only_f["creators"][0]["name"] == "milan cheek" or only_f["creators"][0]["slug"] == "milan cheek"

    assert unfollow_creator(radar_db, pin["id"]) is True
    assert unfollow_creator(radar_db, pin["id"]) is False


def test_creator_dossier_separates_library_and_hidden_vault_findings(radar_db):
    follow_creator(radar_db, "Milan Cheek")
    dossier = get_creator_dossier(radar_db, "Milan Cheek")
    assert dossier["creator"]["followed"] is True
    assert dossier["creator"]["video_count"] == 2
    assert dossier["creator"]["local_count"] == 1
    assert len(dossier["library_videos"]) == 2
    assert all(v.get("playable_url") for v in dossier["library_videos"])
    # Existing library URL https://example.com/watch/milan-1 should be excluded from vault_findings
    hidden_urls = [it.get("url") for it in dossier["vault_findings"]]
    assert "https://example.com/watch/milan-1" not in hidden_urls
    assert "https://bunkr.cr/v/milan-cheek-hidden-4k" in hidden_urls


def test_companion_probe_and_follow_endpoints(radar_db, monkeypatch):
    from app.routers import creator_radar as cr_router

    monkeypatch.setattr(cr_router, "ensure_bridge_token", lambda token: None)

    app = FastAPI()
    app.add_middleware(SessionMiddleware, secret_key="test-secret")
    app.include_router(creator_radar_router)
    app.dependency_overrides[get_db] = lambda: radar_db
    app.dependency_overrides[check_auth] = lambda: True

    client = TestClient(app)

    res = client.post(
        "/api/v1/companion/probe",
        json={
            "query": "Milan Cheek",
            "page_url": "https://example.com/watch/milan-1/",
            "candidates": [
                {"url": "https://example.com/watch/milan-2", "title": "Milan 4K"},
                {"url": "https://other.example/watch/999", "title": "Other"},
            ],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["library_count"] == 2
    assert body["library_local_count"] == 1
    assert body["page_in_library"]["quality"] == "1080p"
    assert "https://example.com/watch/milan-2" in body["url_matches"]
    assert body["url_matches"]["https://example.com/watch/milan-2"]["quality"] == "4K"
    assert body["vault_count"] >= 1

    follow_res = client.post(
        "/api/v1/companion/follow",
        json={"name": "Amirah Adara", "source_hint": "porntrex.com"},
    )
    assert follow_res.status_code == 200
    assert follow_res.json()["followed"] is True

    creators_res = client.get("/api/v1/radar/creators?only_followed=true")
    assert creators_res.status_code == 200
    assert creators_res.json()["followed_count"] == 1


def test_creator_thumb_cache_ttl_rethumb_and_vault_import_promotion(radar_db, tmp_path, monkeypatch):
    import json
    import os
    import time

    from app import creator_thumbs
    from app.database import TelegramMediaIndex
    from app.routers import vault as vault_router
    from sqlalchemy.orm import sessionmaker

    TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=radar_db.get_bind())
    monkeypatch.setattr("app.database.SessionLocal", TestingSession)

    cache_dir = tmp_path / "creator_thumbs"
    lib_thumb_dir = tmp_path / "lib_thumbs"
    tg_thumb_dir = tmp_path / "tg_thumbs"
    monkeypatch.setenv("NEXUS_CREATOR_THUMB_DIR", str(cache_dir))
    monkeypatch.setenv("NEXUS_LIBRARY_THUMB_DIR", str(lib_thumb_dir))
    monkeypatch.setattr("app.telegram_stream.THUMB_DIR", tg_thumb_dir)

    # Seed Telegram item for Milan Cheek without an existing thumbnail
    radar_db.add(
        TelegramMediaIndex(
            chat_id=123456,
            message_id=77,
            channel="porndrive",
            title="Milan Cheek Telegram Scene",
            duration_sec=620,
            height=1080,
            quality="1080p",
            effective_res=1080,
            has_thumb=False,
        )
    )
    radar_db.commit()

    async def fake_repair_thumbnail(chat_id, message_id, duration=0, *, reroll=False):
        tg_thumb_dir.mkdir(parents=True, exist_ok=True)
        out = tg_thumb_dir / f"{chat_id}_{message_id}.jpg"
        out.write_bytes(b"\xff\xd8\xff\xe0" + (b"REROLL" if reroll else b"INIT") * 60)
        return out

    async def fake_extract_frame(stream_url, dest_path, *, duration=0.0, referer="", reroll=False):
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(b"\xff\xd8\xff\xe0" + b"FRAME" * 60)
        return 72.5

    monkeypatch.setattr("app.telegram_rethumb.repair_thumbnail", fake_repair_thumbnail)
    monkeypatch.setattr(creator_thumbs, "_extract_best_frame_from_stream", fake_extract_frame)

    app = FastAPI()
    app.add_middleware(SessionMiddleware, secret_key="test-secret")
    app.include_router(creator_radar_router)
    app.include_router(vault_router.router)
    app.dependency_overrides[get_db] = lambda: radar_db
    app.dependency_overrides[check_auth] = lambda: True

    class DummyJob:
        id = 1
        batch_name = "Radar · Milan Cheek"
        status = "queued"
        total_items = 1

    monkeypatch.setattr(vault_router, "create_import_job", lambda req, db: DummyJob())
    monkeypatch.setattr(vault_router, "serialize_job", lambda job: {"id": job.id, "batch_name": job.batch_name})
    monkeypatch.setattr(vault_router.intake_worker, "start", lambda: None)

    client = TestClient(app)

    # 1. Single rethumb for Telegram finding
    tg_item = {
        "id": "telegram:123456:77",
        "bucket": "telegram",
        "url": "/api/v1/telegram/stream/123456/77",
        "title": "Milan Cheek Telegram Scene",
        "duration_sec": 620,
        "telegram_meta": {
            "chat_id": 123456,
            "message_id": 77,
            "duration": 620,
            "stream_url": "/api/v1/telegram/stream/123456/77",
        },
    }
    res = client.post("/api/v1/radar/rethumb", json={"item": tg_item, "reroll": False})
    assert res.status_code == 200
    payload = res.json()
    assert payload["ok"] is True
    assert payload["thumbnail"].startswith("/api/v1/radar/thumb/tg_123456_77.jpg")

    # 2. Cached thumb is served via HTTP and visible in dossier findings
    thumb_res = client.get(payload["thumbnail"])
    assert thumb_res.status_code == 200
    assert b"INIT" in thumb_res.content

    dossier = get_creator_dossier(radar_db, "Milan Cheek")
    tg_findings = [it for it in dossier["vault_findings"] if it.get("bucket") == "telegram"]
    assert tg_findings
    assert tg_findings[0]["thumbnail"].startswith("/api/v1/radar/thumb/tg_123456_77.jpg")
    assert tg_findings[0].get("thumb_enhanced") is True

    # 3. Batch NDJSON rethumb supports non-Telegram stream item too
    forum_item = {
        "id": "forum:99",
        "bucket": "forum",
        "url": "https://cdn.example.com/hidden-scene.mp4",
        "source_url": "https://cdn.example.com/hidden-scene.mp4",
        "title": "Milan Cheek Forum Direct",
        "duration_sec": 300,
    }
    batch_res = client.post("/api/v1/radar/rethumb-batch", json={"items": [tg_item, forum_item], "reroll": True})
    assert batch_res.status_code == 200
    events = [json.loads(line) for line in batch_res.text.splitlines() if line.strip()]
    progress = [e for e in events if e.get("type") == "progress"]
    done_ev = [e for e in events if e.get("type") == "done"][-1]
    assert len(progress) == 2
    assert all(e["ok"] for e in progress)
    assert done_ev["done"] == 2 and done_ev["failed"] == 0

    forum_thumb_url = next(e["thumbnail"] for e in progress if e["index"] == 1)

    # 4. Importing with enhanced thumb promotes it to durable library/telegram storage for Dashboard
    captured_reqs = []
    monkeypatch.setattr(vault_router, "create_import_job", lambda req, db: captured_reqs.append(req) or DummyJob())
    imp_res = client.post(
        "/api/vault/import",
        json={
            "batch_name": "Radar · Milan Cheek",
            "items": [
                {**tg_item, "thumbnail": payload["thumbnail"], "telegram_meta": {**tg_item["telegram_meta"], "thumbnail": payload["thumbnail"]}},
                {**forum_item, "thumbnail": forum_thumb_url},
            ],
        },
    )
    assert imp_res.status_code == 200
    imp_body = imp_res.json()
    assert imp_body["telegram_imported"] == 1
    assert imp_body["telegram_items"][0]["thumbnail"] == "/api/v1/telegram/thumb/123456/77"
    assert len(captured_reqs) == 1
    promoted_forum_thumb = captured_reqs[0].candidates[0].thumbnail
    assert promoted_forum_thumb.startswith("/static/thumbnails/cr_")
    promoted_file = lib_thumb_dir / promoted_forum_thumb.rsplit("/", 1)[-1]
    assert promoted_file.is_file()

    # 5. TTL cleanup purges expired cache files cleanly
    cached_forum_file = cache_dir / f"{creator_thumbs.cache_key_for_item(forum_item)}.jpg"
    assert cached_forum_file.is_file()
    old_ts = time.time() - (creator_thumbs.CREATOR_THUMB_TTL_SECONDS + 120)
    os.utime(cached_forum_file, (old_ts, old_ts))
    assert creator_thumbs.resolve_cached_thumb_file(creator_thumbs.cache_key_for_item(forum_item)) is None
    assert not cached_forum_file.exists()
