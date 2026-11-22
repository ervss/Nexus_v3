import asyncio
import json
from pathlib import Path

from fastapi import BackgroundTasks
from playwright.sync_api import expect, sync_playwright

from app.routers.extension_bridge import HunterPushRequest, hunter_push, hunter_session


def test_hunter_session_preserves_multiple_thread_origins():
    payload = HunterPushRequest(
        thread_title="SimpCity Watched – novinky",
        thread_url="https://simpcity.cr/watched/threads",
        links=[
            {
                "url": "https://gofile.io/d/example",
                "host": "gofile",
                "threadTitle": "Alpha",
                "threadUrl": "https://simpcity.cr/threads/alpha.101/",
                "threadForum": "OnlyFans",
                "threadLabels": ["OnlyFans", "XXX"],
                "postUrl": "https://simpcity.cr/threads/alpha.101/post-201",
                "postId": "201",
                "occurrences": [
                    {"threadId": "101", "threadTitle": "Alpha", "threadUrl": "https://simpcity.cr/threads/alpha.101/", "postId": "201"},
                    {"threadId": "102", "threadTitle": "Beta", "threadUrl": "https://simpcity.cr/threads/beta.102/", "postId": "301"},
                ],
            },
            {
                "url": "https://pixeldrain.com/u/example",
                "host": "pixeldrain",
                "threadTitle": "Beta",
                "threadUrl": "https://simpcity.cr/threads/beta.102/",
                "postUrl": "https://simpcity.cr/threads/beta.102/post-302",
                "postId": "302",
            },
        ],
    )
    response = asyncio.run(hunter_push(payload, BackgroundTasks()))
    session = asyncio.run(hunter_session(response["session_id"]))
    assert session["count"] == 2
    assert response["thread_count"] == 2
    assert [link["threadTitle"] for link in session["links"]] == ["Alpha", "Beta"]
    assert session["links"][0]["threadId"] == "101"
    assert session["links"][0]["occurrences"][1]["postId"] == "301"
    assert session["links"][1]["postUrl"].endswith("post-302")
    assert [t["id"] for t in session["threads"]] == ["101", "102"]
    assert session["threads"][0]["linkCount"] == 1
    assert session["threads"][1]["linkCount"] == 2
    assert session["threads"][0]["forum"] == "OnlyFans"


def test_tester_thread_grouping_filtering_and_per_thread_import():
    tester_html = Path("app/templates/tester.html").read_text(encoding="utf-8")
    session_payload = {
        "thread_title": "SimpCity Search (2 threadov)",
        "thread_url": "https://simpcity.cr/search/123/",
        "enriching": False,
        "threads": [
            {"id": "101", "title": "Ari Kytsya", "url": "https://simpcity.cr/threads/ari-kytsya.101/", "forum": "OnlyFans", "labels": ["OnlyFans"], "linkCount": 2},
            {"id": "102", "title": "Rachel Cook", "url": "https://simpcity.cr/threads/rachel-cook.102/", "forum": "OnlyFans", "labels": ["XXX"], "linkCount": 2},
        ],
        "links": [
            {
                "url": "https://pixeldrain.com/u/ari1",
                "host": "pixeldrain",
                "text": "Ari clip 1",
                "threadId": "101",
                "threadTitle": "Ari Kytsya",
                "threadUrl": "https://simpcity.cr/threads/ari-kytsya.101/",
                "threadForum": "OnlyFans",
                "postId": "501",
                "postUrl": "https://simpcity.cr/threads/ari-kytsya.101/post-501",
                "occurrences": [{"threadId": "101", "threadTitle": "Ari Kytsya", "threadUrl": "https://simpcity.cr/threads/ari-kytsya.101/", "postId": "501", "postUrl": "https://simpcity.cr/threads/ari-kytsya.101/post-501"}],
            },
            {
                "url": "https://pixeldrain.com/u/shared1",
                "host": "pixeldrain",
                "text": "Shared clip",
                "threadId": "101",
                "threadTitle": "Ari Kytsya",
                "threadUrl": "https://simpcity.cr/threads/ari-kytsya.101/",
                "postId": "502",
                "postUrl": "https://simpcity.cr/threads/ari-kytsya.101/post-502",
                "occurrences": [
                    {"threadId": "101", "threadTitle": "Ari Kytsya", "threadUrl": "https://simpcity.cr/threads/ari-kytsya.101/", "postId": "502", "postUrl": "https://simpcity.cr/threads/ari-kytsya.101/post-502"},
                    {"threadId": "102", "threadTitle": "Rachel Cook", "threadUrl": "https://simpcity.cr/threads/rachel-cook.102/", "postId": "601", "postUrl": "https://simpcity.cr/threads/rachel-cook.102/post-601"},
                ],
            },
            {
                "url": "https://bunkr.site/v/rachel1",
                "host": "bunkr",
                "text": "Rachel clip 1",
                "threadId": "102",
                "threadTitle": "Rachel Cook",
                "threadUrl": "https://simpcity.cr/threads/rachel-cook.102/",
                "postId": "602",
                "postUrl": "https://simpcity.cr/threads/rachel-cook.102/post-602",
                "occurrences": [{"threadId": "102", "threadTitle": "Rachel Cook", "threadUrl": "https://simpcity.cr/threads/rachel-cook.102/", "postId": "602", "postUrl": "https://simpcity.cr/threads/rachel-cook.102/post-602"}],
            },
        ],
    }
    import_calls = []

    def handle_route(route):
        url = route.request.url
        if "/tester?" in url or url.endswith("/tester"):
            route.fulfill(status=200, content_type="text/html; charset=utf-8", body=tester_html)
        elif "/api/v1/hunter/session/sess1" in url:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(session_payload))
        elif "/api/tester/resolve/stream" in url:
            body = json.loads(route.request.post_data or "{}")
            events = []
            for idx, target in enumerate(body.get("urls", [])):
                res = {
                    "url": target,
                    "status": "success",
                    "extractor": "Pixeldrain" if "pixeldrain" in target else "Bunkr",
                    "message": "OK",
                    "data": {
                        "title": f"Video {idx + 1}",
                        "kind": "video",
                        "duration": 120 + idx * 10,
                        "height": 1080,
                        "size_mb": 50 + idx * 15,
                        "stream_url": target,
                    },
                }
                events.append(f"data: {json.dumps({'type': 'result', 'result': res})}\n\n")
            events.append(f"data: {json.dumps({'type': 'done'})}\n\n")
            route.fulfill(status=200, content_type="text/event-stream", body="".join(events))
        elif "/api/v1/import/bulk" in url:
            payload = json.loads(route.request.post_data or "{}")
            import_calls.append(payload)
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"imported": len(payload.get("videos", []))}))
        elif "/api/v1/batches" in url:
            route.fulfill(status=200, content_type="application/json", body="[]")
        else:
            route.fulfill(status=200, content_type="application/json", body="{}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.route("http://127.0.0.1:8999/**", handle_route)
        page.goto("http://127.0.0.1:8999/tester?hunter=1&session=sess1&autostart=1&autoselect=1")

        # Auto-grouped into 2 thread sections + thread filter dropdown + context pills
        expect(page.locator(".thread-group")).to_have_count(2, timeout=15000)
        expect(page.locator("#threadFilter")).to_be_visible()
        expect(page.locator("#threadContextBar .thread-pill")).to_have_count(3)

        # Shared clip appears in both thread groups, Rachel Cook group has 2 cards (shared + rachel1)
        rachel_group = page.locator('.thread-group[data-thread-key="id:102"]')
        expect(rachel_group.locator(".card")).to_have_count(2)

        # Filter dropdown to Rachel Cook only -> shows only Rachel Cook group / 2 cards
        page.locator("#threadFilter").select_option("id:102")
        expect(page.locator(".thread-group")).to_have_count(1)
        expect(page.locator(".thread-group .card")).to_have_count(2)

        # Switch back to all threads & test split-by-thread import in batch popover
        page.locator("#threadFilter").select_option("all")
        expect(page.locator(".thread-group")).to_have_count(2)
        page.locator("#importBatchToggleBtn").click()
        expect(page.locator("#importByThreadBtn")).to_be_visible()
        page.locator("#importByThreadBtn").click()
        page.wait_for_timeout(400)
        assert len(import_calls) == 2
        assert [c["batch_name"] for c in import_calls] == ["Ari Kytsya", "Rachel Cook"]
        browser.close()


def test_search_panel_sends_thread_origins_and_filters_by_thread():
    ext_root = Path("extensions/nexus_thread_intake")
    watched_html = """
    <html><head><title>Watched threads | SimpCity</title></head><body>
      <div class="structItem structItem--thread">
        <div class="structItem-title"><a href="/threads/ari-kytsya.101/"><span class="label">OnlyFans</span> Ari Kytsya</a></div>
        <div class="structItem-minor"><a href="/forums/onlyfans.8/">OnlyFans</a></div>
      </div>
      <div class="structItem structItem--thread">
        <div class="structItem-title"><a href="/threads/rachel-cook.102/"><span class="label">XXX</span> Rachel Cook</a></div>
        <div class="structItem-minor"><a href="/forums/onlyfans.8/">OnlyFans</a></div>
      </div>
    </body></html>
    """
    thread_101 = """
    <html><head><title>Ari Kytsya</title></head><body>
      <article class="message" id="post-501"><a href="/threads/ari-kytsya.101/post-501">#501</a>
        <div class="message-body"><a href="https://pixeldrain.com/u/ari1">Ari clip</a></div></article>
    </body></html>
    """
    thread_102 = """
    <html><head><title>Rachel Cook</title></head><body>
      <article class="message" id="post-601"><a href="/threads/rachel-cook.102/post-601">#601</a>
        <div class="message-body"><a href="https://bunkr.site/v/rachel1">Rachel clip</a></div></article>
    </body></html>
    """

    def serve(route):
        url = route.request.url
        if url.endswith("/watched/threads"):
            body = watched_html
        elif url.endswith("/threads/ari-kytsya.101/"):
            body = thread_101
        elif url.endswith("/threads/rachel-cook.102/"):
            body = thread_102
        else:
            route.fulfill(status=404, body="missing")
            return
        route.fulfill(status=200, content_type="text/html", body=body)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        context.route("https://simpcity.cr/**", serve)
        context.add_init_script("""
          window.chrome = {
            storage: { local: {
              async get() { return {}; },
              async set() {}
            }},
            runtime: {
              onMessage: { addListener() {} },
              async sendMessage(msg) {
                window.__sentPush = msg;
                return { ok: true, count: msg.links.length, sessionId: "s-search" };
              }
            }
          };
        """)
        page = context.new_page()
        page.goto("https://simpcity.cr/watched/threads")
        page.add_script_tag(path=str(ext_root / "content.js"))
        page.add_style_tag(path=str(ext_root / "search.css"))
        page.add_script_tag(path=str(ext_root / "search.js"))

        page.get_by_role("button", name="Nexus Search").click()
        page.get_by_role("button", name="Vybrať zobrazené").click()
        page.get_by_role("button", name="Skenovať vybrané").click()
        expect(page.locator('[data-part="status"]')).to_contain_text("Hotovo: 2 unikátnych odkazov", timeout=15000)

        # Thread dropdown in search.js footer lists both threads
        thread_opts = page.locator('[data-f="thread"] option').all_text_contents()
        assert any("Ari Kytsya (1)" in opt for opt in thread_opts)
        assert any("Rachel Cook (1)" in opt for opt in thread_opts)

        # Send all 2 links and inspect payload
        page.get_by_role("button", name="Poslať do Testera (2)").click()
        expect(page.locator('[data-part="status"]')).to_contain_text("2 odkazov otvorených v Testeri", timeout=10000)
        sent = page.evaluate("window.__sentPush")
        assert sent["action"] == "nexusThreadIntake.pushWatched"
        assert len(sent["threads"]) == 2
        assert [t["title"] for t in sent["threads"]] == ["Ari Kytsya", "Rachel Cook"]
        assert sent["links"][0]["threadId"] == "101"
        assert sent["links"][0]["threadTitle"] == "Ari Kytsya"
        assert sent["links"][0]["threadForum"] == "OnlyFans"
        assert sent["links"][1]["threadId"] == "102"
        assert sent["links"][1]["threadTitle"] == "Rachel Cook"
        browser.close()


def test_library_check_distinguishes_exact_and_content_matches():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.database import Base, Video, VideoSource
    from app.routers.link_tester import LibraryCheckItem, LibraryCheckRequest, check_library_duplicates

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    db = Session()
    try:
        v1 = Video(
            id=11,
            title="stephanie-love-p2160.mp4",
            url="https://cdn.example/stephanie.mp4",
            source_url="https://bunkr.site/v/stephanie11",
            original_thumbnail_url="https://cdn.example/logo.png",
            duration=600,
            height=2160,
            file_size_mb=4096.0,
            batch_name="Stephanie Love",
            quality="4K",
            storage_type="remote",
        )
        v2 = Video(
            id=12,
            title="ari-clip-unique.mp4",
            url="https://cdn.example/ari.mp4",
            source_url="https://pixeldrain.com/u/ari12",
            original_thumbnail_url="https://cdn.example/ari_frame_abc123.jpg",
            duration=120,
            height=1080,
            file_size_mb=250.0,
            batch_name="Ari Kytsya",
            quality="1080p",
            storage_type="local",
        )
        db.add_all([v1, v2])
        db.commit()
        db.add(VideoSource(video_id=12, url="https://mirror.example/ari.mp4", source_url="https://filester.me/d/ari12"))
        db.commit()

        req = LibraryCheckRequest(
            items=[
                LibraryCheckItem(url="https://bunkr.site/v/stephanie11", title="Other"),
                LibraryCheckItem(url="https://filester.me/d/ari12", title="Mirror"),
                LibraryCheckItem(url="https://whoreshub.com/videos/999", title="stephanie-love-p2160", thumbnail="https://whoreshub.com/logo.png", size_mb=4096.0, duration=600),
                LibraryCheckItem(url="https://whoreshub.com/videos/other", title="completely-different-clip-xyz", thumbnail="https://other.example/logo.png", size_mb=50.0, duration=90),
            ],
            include_content=True,
        )
        out = check_library_duplicates(req, db=db)
        matches = out["matches"]
        assert matches["https://bunkr.site/v/stephanie11"]["match_type"] == "exact_url"
        assert matches["https://filester.me/d/ari12"]["match_type"] == "exact_url"
        assert matches["https://filester.me/d/ari12"]["video"]["id"] == 12
        assert matches["https://whoreshub.com/videos/999"]["match_type"] == "content_match"
        assert "názov" in matches["https://whoreshub.com/videos/999"]["reason"]
        # Generic logo.png must NOT falsely match v1
        assert "https://whoreshub.com/videos/other" not in matches
    finally:
        db.close()


def test_tester_distinguishes_batch_and_library_duplicates():
    tester_html = Path("app/templates/tester.html").read_text(encoding="utf-8")
    session_payload = {
        "thread_title": "Watched Mix",
        "thread_url": "https://simpcity.cr/watched/threads",
        "enriching": False,
        "threads": [
            {"id": "101", "title": "Stephanie Love", "url": "https://simpcity.cr/threads/stephanie.101/", "linkCount": 2},
            {"id": "102", "title": "Rachel Cook", "url": "https://simpcity.cr/threads/rachel.102/", "linkCount": 1},
        ],
        "links": [
            {"url": "https://pixeldrain.com/u/copy1", "host": "pixeldrain", "text": "stephanie-love-p2160.mp4", "threadId": "102", "threadTitle": "Rachel Cook"},
            {"url": "https://bunkr.site/v/copy2", "host": "bunkr", "text": "stephanie-love-p2160", "threadId": "101", "threadTitle": "Stephanie Love"},
            {"url": "https://gofile.io/d/lib1", "host": "gofile", "text": "already-in-db.mp4", "threadId": "101", "threadTitle": "Stephanie Love"},
        ],
    }

    def handle_route(route):
        url = route.request.url
        if "/tester?" in url or url.endswith("/tester"):
            route.fulfill(status=200, content_type="text/html; charset=utf-8", body=tester_html)
        elif "/api/v1/hunter/session/sess-dupe" in url:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(session_payload))
        elif "/api/tester/resolve/stream" in url:
            results = [
                {
                    "url": "https://pixeldrain.com/u/copy1",
                    "status": "success",
                    "extractor": "Pixeldrain",
                    "message": "OK",
                    "data": {"title": "stephanie-love-p2160.mp4", "kind": "video", "height": 2160, "size_bytes": 4300000000, "duration": 600, "thumbnail": "https://cdn.example/logo.png"},
                },
                {
                    "url": "https://bunkr.site/v/copy2",
                    "status": "success",
                    "extractor": "Bunkr",
                    "message": "OK",
                    "data": {"title": "stephanie-love-p2160", "kind": "video", "height": 1080, "size_bytes": 2100000000, "duration": 600, "thumbnail": "https://other.example/logo.png"},
                },
                {
                    "url": "https://gofile.io/d/lib1",
                    "status": "success",
                    "extractor": "GoFile",
                    "message": "OK",
                    "data": {"title": "already-in-db.mp4", "kind": "video", "height": 1080, "size_bytes": 500000000, "duration": 180},
                },
            ]
            body = "".join(f"data: {json.dumps({'type': 'result', 'result': r})}\n\n" for r in results) + f"data: {json.dumps({'type': 'done'})}\n\n"
            route.fulfill(status=200, content_type="text/event-stream", body=body)
        elif "/api/tester/library-check" in url:
            lib_resp = {
                "matches": {
                    "https://gofile.io/d/lib1": {
                        "match_type": "exact_url",
                        "reason": "zhodná URL v Dashboarde",
                        "video": {
                            "id": 77,
                            "title": "Already In Dashboard",
                            "batch_name": "Stephanie Old",
                            "quality": "1080p",
                            "file_size_mb": 476.8,
                            "duration": 180,
                            "storage_type": "local",
                        },
                    }
                },
                "checked": 3,
                "library_total": 100,
            }
            route.fulfill(status=200, content_type="application/json", body=json.dumps(lib_resp))
        else:
            route.fulfill(status=200, content_type="application/json", body="{}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.route("http://127.0.0.1:8999/**", handle_route)
        page.goto("http://127.0.0.1:8999/tester?hunter=1&session=sess-dupe&autostart=1&autoselect=1")

        # Distinct badges: 1 batch duplicate (copy2), 1 library match (lib1), 1 keeper (copy1)
        expect(page.locator(".dupe-badge.is-batch")).to_have_count(1, timeout=15000)
        expect(page.locator(".dupe-badge.is-library")).to_have_count(1)
        expect(page.locator(".dupe-badge.is-keeper")).to_have_count(1)
        expect(page.locator(".dupe-compare-box.is-batch")).to_contain_text("rovnaký názov súboru")
        expect(page.locator(".dupe-compare-box.is-batch")).to_contain_text("Originál v dávke:")
        expect(page.locator(".dupe-compare-box.is-library")).to_contain_text("#77 Already In Dashboard")

        # Auto-select picks only copy1 (skips copy2 batch dupe and lib1 library dupe)
        expect(page.locator("#selectedResultsCount")).to_have_text("1")

        # Filter to library dupes only -> 1 card; batch dupes only -> 1 card; unique only -> 1 card
        page.locator("#dupeScopeFilter").select_option("library_dupes")
        expect(page.locator(".card")).to_have_count(1)
        page.locator("#dupeScopeFilter").select_option("batch_dupes")
        expect(page.locator(".card")).to_have_count(1)
        page.locator("#dupeScopeFilter").select_option("unique")
        expect(page.locator(".card")).to_have_count(1)

        # Pair comparison mode shows keeper + dupe side by side
        page.locator("#dupeScopeFilter").select_option("all")
        page.locator(".dupe-compare-box.is-batch [data-compare-dupe-url]").click()
        expect(page.locator("#dupeCompareBanner")).to_be_visible()
        expect(page.locator(".card")).to_have_count(2)
        page.locator("[data-exit-dupe-compare]").click()
        expect(page.locator(".card")).to_have_count(3)

        # Jump-to-original uncollapses the keeper's thread group (102) and reveals the keeper card
        page.locator('.thread-group[data-thread-key="id:102"] .thread-group-collapse').click()
        expect(page.locator('.thread-group[data-thread-key="id:102"] .thread-group-grid')).to_be_hidden()
        page.locator(".dupe-compare-box.is-batch [data-jump-to-url]").click()
        expect(page.locator('.thread-group[data-thread-key="id:102"] .thread-group-grid')).to_be_visible()
        browser.close()


def test_generic_turbo_albums_across_threads_are_not_grouped_as_duplicates():
    from app.media_match import media_name_key

    assert media_name_key("Turbo album") == ""
    assert media_name_key("Turbo video") == ""

    tester_html = Path("app/templates/tester.html").read_text(encoding="utf-8")
    session_payload = {
        "thread_title": "Watched Mix",
        "thread_url": "https://simpcity.cr/watched/threads",
        "enriching": False,
        "threads": [
            {"id": "t1", "title": "BabyGirlBella", "url": "https://simpcity.cr/threads/bella.1/", "linkCount": 2},
            {"id": "t2", "title": "Rachel Cook", "url": "https://simpcity.cr/threads/rachel.2/", "linkCount": 1},
        ],
        "links": [
            {"url": "https://turbo.cr/a/baby-album-1", "host": "turbo", "text": "Turbo album", "threadId": "t1", "threadTitle": "BabyGirlBella"},
            {"url": "https://turbo.cr/a/baby-album-2", "host": "turbo", "text": "Turbo album", "threadId": "t1", "threadTitle": "BabyGirlBella"},
            {"url": "https://turbo.cr/a/rachel-album-3", "host": "turbo", "text": "Turbo album", "threadId": "t2", "threadTitle": "Rachel Cook"},
        ],
    }

    def handle_route(route):
        url = route.request.url
        if "/tester?" in url or url.endswith("/tester"):
            route.fulfill(status=200, content_type="text/html; charset=utf-8", body=tester_html)
        elif "/api/v1/hunter/session/sess-turbo" in url:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(session_payload))
        elif "/api/tester/resolve/stream" in url:
            body = json.loads(route.request.post_data or "{}")
            events = []
            for idx, target in enumerate(body.get("urls", [])):
                res = {
                    "url": target,
                    "status": "success",
                    "extractor": "turbo",
                    "message": "OK",
                    "data": {
                        "title": "Turbo album",
                        "kind": "album",
                        "thumbnail": f"https://cdn.example.com/poster_{idx}_unique9876.jpg",
                        "items": [{"title": f"Clip {idx + 1}", "url": f"{target}/clip{idx + 1}.mp4"}],
                    },
                }
                events.append(f"data: {json.dumps({'type': 'result', 'result': res})}\n\n")
            events.append(f"data: {json.dumps({'type': 'done'})}\n\n")
            route.fulfill(status=200, content_type="text/event-stream", body="".join(events))
        elif "/api/tester/library-check" in url:
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"matches": {}, "checked": 3, "library_total": 0}))
        else:
            route.fulfill(status=200, content_type="application/json", body="{}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.route("http://127.0.0.1:8999/**", handle_route)
        page.goto("http://127.0.0.1:8999/tester?hunter=1&session=sess-turbo&autostart=1&autoselect=1")

        expect(page.locator(".card")).to_have_count(3, timeout=15000)
        expect(page.locator(".dupe-badge.is-batch")).to_have_count(0)
        expect(page.locator(".dupe-badge.is-keeper")).to_have_count(0)
        expect(page.locator("#selectedResultsCount")).to_have_text("3")
        browser.close()
