import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, ForumLink, ForumPost, ForumSyncJob, ForumThread, utcnow
from app.forums.boards import Board, load_cookies, merge_cookie_rows, write_cookie_rows, write_cookies
from app.forums.client import ForumAuthError, ForumChallengeError, ForumClient
from app.forums.parser import next_page_url
from app.forums import service
from app.routers import forum_hub


def _db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(
        engine,
        tables=[
            ForumThread.__table__, ForumPost.__table__, ForumLink.__table__,
            ForumSyncJob.__table__,
        ],
    )
    return sessionmaker(bind=engine)()


def test_cookie_merge_preserves_session_metadata_and_session_expiry(tmp_path):
    jar = tmp_path / "cookies.txt"
    board = Board("simpcity", "SimpCity", "https://simpcity.cr", str(jar))
    write_cookie_rows(board, [{
        "domain": ".simpcity.cr",
        "includeSubdomains": True,
        "path": "/",
        "secure": True,
        "expirationDate": 0,
        "httpOnly": True,
        "name": "xf_session",
        "value": "old-session",
    }])

    merge_cookie_rows(board, [{
        "domain": ".simpcity.cr",
        "includeSubdomains": True,
        "path": "/",
        "secure": True,
        "expirationDate": 0,
        "httpOnly": True,
        "name": "xf_user",
        "value": "user-token",
    }])
    write_cookies(board, {"xf_session": "new-session", "xf_user": "user-token"})

    rows = jar.read_text(encoding="utf-8").splitlines()
    session_line = next(line for line in rows if "xf_session" in line)
    assert session_line.startswith("#HttpOnly_.simpcity.cr\tTRUE\t/\tTRUE\t0\t")
    assert session_line.endswith("\txf_session\tnew-session")
    assert any("xf_user" in line for line in rows)


def test_cookie_sync_replaces_full_export_but_partial_merge_keeps_existing_auth(tmp_path):
    jar = tmp_path / "cookies.txt"
    board = Board("simpcity", "SimpCity", "https://simpcity.cr", str(jar))
    old = {
        "domain": ".simpcity.cr", "includeSubdomains": True, "path": "/",
        "secure": True, "expirationDate": 123, "httpOnly": True,
        "name": "xf_session", "value": "secret-session",
    }
    write_cookie_rows(board, [old])
    merge_cookie_rows(board, [{
        "domain": ".simpcity.cr", "includeSubdomains": True, "path": "/",
        "secure": True, "expirationDate": 0, "httpOnly": False,
        "name": "xf_csrf", "value": "csrf",
    }])
    assert "secret-session" in jar.read_text(encoding="utf-8")
    assert "xf_session" in jar.read_text(encoding="utf-8")

    write_cookie_rows(board, [{
        "domain": ".simpcity.cr", "includeSubdomains": True, "path": "/",
        "secure": True, "expirationDate": 456, "httpOnly": True,
        "name": "xf_user", "value": "user",
    }])
    assert "xf_session" not in jar.read_text(encoding="utf-8")
    assert "xf_csrf" not in jar.read_text(encoding="utf-8")
    assert "xf_user" in jar.read_text(encoding="utf-8")


def test_legacy_full_cookie_export_prunes_absent_names_and_keeps_metadata(tmp_path):
    jar = tmp_path / "cookies.txt"
    board = Board("simpcity", "SimpCity", "https://simpcity.cr", str(jar))
    write_cookie_rows(board, [
        {
            "domain": ".simpcity.cr", "includeSubdomains": True, "path": "/",
            "secure": True, "expirationDate": 123, "httpOnly": True,
            "name": "xf_session", "value": "old",
        },
        {
            "domain": ".simpcity.cr", "includeSubdomains": True, "path": "/",
            "secure": True, "expirationDate": 456, "httpOnly": False,
            "name": "stale", "value": "old",
        },
    ])

    write_cookies(board, {"xf_session": "new"})

    content = jar.read_text(encoding="utf-8")
    assert "#HttpOnly_.simpcity.cr\tTRUE\t/\tTRUE\t123\txf_session\tnew" in content
    assert "stale" not in content


def test_expired_cookies_are_not_sent_as_live_auth(tmp_path):
    jar = tmp_path / "cookies.txt"
    board = Board("simpcity", "SimpCity", "https://simpcity.cr", str(jar))
    write_cookie_rows(board, [
        {
            "domain": ".simpcity.cr", "includeSubdomains": True, "path": "/",
            "secure": True, "expirationDate": 1, "httpOnly": True,
            "name": "xf_session", "value": "expired",
        },
        {
            "domain": ".simpcity.cr", "includeSubdomains": True, "path": "/",
            "secure": True, "expirationDate": 1, "httpOnly": True,
            "name": "xf_user", "value": "expired",
        },
    ])

    assert load_cookies(board) == {}


def test_cookie_sync_route_merges_partial_and_replaces_complete_export(tmp_path, monkeypatch):
    jar = tmp_path / "cookies.txt"
    board = Board("simpcity", "SimpCity", "https://simpcity.cr", str(jar))
    write_cookie_rows(board, [
        {
            "domain": ".simpcity.cr", "includeSubdomains": True, "path": "/",
            "secure": True, "expirationDate": 0, "httpOnly": True,
            "name": "xf_session", "value": "session",
        },
        {
            "domain": ".simpcity.cr", "includeSubdomains": True, "path": "/",
            "secure": True, "expirationDate": 0, "httpOnly": True,
            "name": "xf_user", "value": "user",
        },
    ])
    monkeypatch.setattr(forum_hub, "get_board", lambda _key: board)
    monkeypatch.setattr(forum_hub, "load_cookies", load_cookies)
    partial = forum_hub.sync_cookies(forum_hub.CookieSyncRequest(
        board="simpcity",
        cookie_rows=[{
            "domain": ".simpcity.cr", "path": "/", "secure": True,
            "expirationDate": 0, "httpOnly": False, "name": "xf_csrf", "value": "csrf",
        }],
    ))
    assert partial["preserved_existing_auth"] is True
    assert {"xf_session", "xf_user", "xf_csrf"} <= set(load_cookies(board))

    complete = forum_hub.sync_cookies(forum_hub.CookieSyncRequest(
        board="simpcity",
        cookie_rows=[
            {
                "domain": ".simpcity.cr", "path": "/", "secure": True,
                "expirationDate": 0, "httpOnly": True, "name": "xf_session", "value": "fresh-session",
            },
            {
                "domain": ".simpcity.cr", "path": "/", "secure": True,
                "expirationDate": 0, "httpOnly": True, "name": "xf_user", "value": "fresh-user",
            },
        ],
    ))
    assert complete["authenticated"] is True
    assert set(load_cookies(board)) == {"xf_session", "xf_user"}


def test_next_page_parser_resolves_listing_page():
    html = '<a class="pageNav-jump--next" href="/watched/threads?page=2">Next</a>'
    assert next_page_url(html, "https://simpcity.cr") == "https://simpcity.cr/watched/threads?page=2"
    assert next_page_url("<html></html>", "https://simpcity.cr") == ""


def test_thread_scan_returns_continuation_after_page_limit(monkeypatch):
    class _Client:
        board = SimpleNamespace(base_url="https://simpcity.cr")

        async def get(self, url):
            return url.rsplit("/", 1)[-1]

    monkeypatch.setattr(service, "parse_posts", lambda html, base: [{
        "post_id": "1" if html == "latest" else "2", "posted_at": None,
    }])
    monkeypatch.setattr(service, "prev_page_url", lambda html, base: "https://simpcity.cr/threads/x/page-2")

    posts, truncated, continuation = asyncio.run(service._fetch_new_posts(
        _Client(), "https://simpcity.cr/threads/x/", max_pages=1,
    ))
    assert [post["post_id"] for post in posts] == ["1"]
    assert truncated is True
    assert continuation.endswith("/page-2")


def test_watchlist_follows_listing_pages(monkeypatch):
    db = _db()
    board = service.get_board("simpcity")
    requests = []

    class _Client:
        def __init__(self):
            self.board = board

        async def get(self, url, params=None):
            requests.append((url, params))
            return "page-2" if "page=2" in url else "page-1"

    def parse_listing(html, base_url):
        index = 1 if html == "page-1" else 2
        return [{
            "url": f"{base_url}/threads/{index}/",
            "title": f"Thread {index}", "slug": str(index),
            "tags": [], "last_post_at": None,
        }]

    monkeypatch.setattr(service, "parse_thread_list", parse_listing)
    monkeypatch.setattr(
        service, "next_page_url",
        lambda html, base: f"{base}/watched/threads?page=2" if html == "page-1" else "",
    )
    monkeypatch.setattr(
        service, "_fetch_thread_posts",
        lambda *args, **kwargs: asyncio.sleep(0, result=([], False, "")),
    )

    result = asyncio.run(service.sync_watchlist(
        db, "simpcity", client=_Client(),
    ))
    assert result["threads_listed"] == 2
    assert result["threads_checked"] == 2
    assert any(url.endswith("?page=2") for url, _ in requests)
    assert all(params is None for _, params in requests)
    db.close()


def test_forum_client_distinguishes_challenge_from_expired_session():
    from app.forums import client as client_module

    client_module._AUTH_HEALTH.clear()
    board = SimpleNamespace(
        key="forum-test-challenge", label="Forum", base_url="https://forum.invalid",
        cookie_file="unused",
    )
    client = ForumClient(board, session=None)
    client.cookies = {"xf_session": "session", "xf_user": "user"}
    client.missing = []

    class _Session:
        def __init__(self, response):
            self.response = response

        async def get(self, *args, **kwargs):
            return self.response

    async def expect_error(response, expected):
        client._session = _Session(response)
        try:
            await client.get("https://forum.invalid/watched/threads")
        except expected:
            return
        raise AssertionError(f"expected {expected.__name__}")

    asyncio.run(expect_error(
        SimpleNamespace(status_code=403, text="DDoS-Guard challenge", headers={}),
        ForumChallengeError,
    ))
    asyncio.run(expect_error(
        SimpleNamespace(status_code=200, text='<html data-logged-in="false"></html>', headers={}),
        ForumAuthError,
    ))
    assert client_module.auth_health(board.key, True)["auth_state"] == "expired"
    client._session = None


def test_forum_client_marks_auth_only_after_explicit_login_marker(monkeypatch):
    from app.forums import client as client_module

    board = SimpleNamespace(
        key="forum-test-authenticated", label="Forum", base_url="https://forum.invalid",
        cookie_file="unused",
    )
    client = ForumClient(board)
    client.cookies = {"xf_session": "session", "xf_user": "user"}
    client.missing = []

    class _Session:
        async def get(self, *args, **kwargs):
            return SimpleNamespace(
                status_code=200,
                text='<html data-logged-in="true"></html>',
                headers={},
            )

    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(client_module.asyncio, "sleep", no_wait)
    client._session = _Session()
    asyncio.run(client.get("https://forum.invalid/watched/threads"))

    assert client_module.auth_health(board.key, True)["auth_state"] == "authenticated"


def test_board_status_does_not_expose_cookie_file_or_names(tmp_path, monkeypatch):
    board = Board("forum-status-test", "Forum", "https://forum.invalid", str(tmp_path / "cookies.txt"))
    monkeypatch.setattr(forum_hub, "BOARDS", {board.key: board})

    result = forum_hub.list_boards()["boards"][0]

    assert result["auth_state"] == "missing_cookies"
    assert "cookie_file" not in result
    assert "cookie_names" not in result
    assert "missing_cookies" not in result


def test_refresh_runs_as_background_job_with_pollable_progress(monkeypatch):
    async def fake_refresh(db, boards, progress=None, unread_only=False):
        assert boards == ["simpcity"]
        assert unread_only is False
        progress({"message": "SimpCity: vlákno 1/1.", "completed": 1, "total": 1})
        return {"new_links": 2, "partial": False}

    monkeypatch.setattr(service, "refresh_all", fake_refresh)
    db = _db()
    session_factory = sessionmaker(bind=db.get_bind())
    monkeypatch.setattr(forum_hub, "SessionLocal", session_factory)
    tasks = BackgroundTasks()
    request = forum_hub.RefreshRequest(boards=["simpcity"])
    started = asyncio.run(forum_hub.start_refresh(request, tasks, db))
    job_id = started["job_id"]

    with pytest.raises(HTTPException) as busy:
        asyncio.run(forum_hub.start_refresh(request, BackgroundTasks(), db))
    assert busy.value.status_code == 409

    task = tasks.tasks[0]
    asyncio.run(task.func(*task.args, **task.kwargs))
    status_db = session_factory()
    result = forum_hub.refresh_job_status(job_id, status_db)
    assert result["status"] == "completed"
    assert result["result"]["new_links"] == 2
    assert result["progress"]["message"] == "SimpCity: vlákno 1/1."
    status_db.close()
    db.close()


def test_discovery_accepts_post_scan_result_and_unsupported_posts_advance_cursor(monkeypatch):
    db = _db()
    board = service.get_board("simpcity")
    thread_data = {
        "url": "https://simpcity.cr/threads/recent.1/",
        "title": "Recent", "slug": "recent.1", "tags": ["sample"],
        "last_post_at": utcnow(),
    }
    post = {
        "post_id": "42", "permalink": thread_data["url"] + "post-42",
        "author": "poster", "posted_at": utcnow(),
        "body_text": "unsupported link", "hashtags": [], "links": [],
    }
    monkeypatch.setattr(service, "_threads_for_tags", lambda *args, **kwargs: asyncio.sleep(0, result=[thread_data]))
    monkeypatch.setattr(service, "_thread_needs_fetch", lambda *args: True)
    continuation = "https://simpcity.cr/threads/recent.1/page-2"
    monkeypatch.setattr(
        service, "_fetch_thread_posts",
        lambda *args, **kwargs: asyncio.sleep(0, result=([post], True, continuation)),
    )

    result = asyncio.run(service.discover_by_tags(
        db, board.key, ["sample"], client=SimpleNamespace(board=board, aclose=lambda: asyncio.sleep(0)),
    ))
    thread = db.query(ForumThread).filter_by(url=thread_data["url"]).one()
    assert result["new_links"] == 0
    assert result["errors"] and "limit" in result["errors"][0]
    assert thread.last_seen_post_id == "42"
    assert thread.scan_cursor_url == continuation
    assert db.query(ForumPost).filter_by(post_id="42").count() == 1
    db.close()


def test_v2_feed_exposes_next_offset_across_thread_origins():
    db = _db()
    for index, origin in enumerate(("watched", "tag", "tag"), start=1):
        thread = ForumThread(
            board="simpcity", url=f"https://simpcity.cr/threads/{index}/",
            title=f"Thread {index}", origin=origin,
        )
        db.add(thread)
        db.flush()
        db.add(ForumLink(
            thread_id=thread.id, url=f"https://bunkr.cr/v/{index}",
            platform="bunkr", link_type="video", status="new",
            posted_at=datetime(2026, 1, index),
        ))
    db.commit()

    first = forum_hub.v2_feed(board="simpcity", window_days=0, topic="", limit=2, offset=0, db=db)
    second = forum_hub.v2_feed(board="simpcity", window_days=0, topic="", limit=2, offset=2, db=db)
    assert first["total"] == 3
    assert first["has_more"] is True
    assert first["next_offset"] == 2
    assert second["page_count"] == 1
    assert second["next_offset"] == 3
    all_items = first["items"] + second["items"]
    assert len(all_items) == 3
    assert sum(item["watched"] for item in all_items) == 1
    db.close()
