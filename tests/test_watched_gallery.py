"""Browser contract for the SimpCity watched gallery with isolated forum fixtures."""

from pathlib import Path
import json
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import pytest

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extensions" / "nexus_thread_intake"


def watched_page(rows, more=False, page_hints=None):
    page_hints = page_hints or {}
    pager = '<div class="pageNav"><a href="/watched/threads?page=2">2</a></div>' if more else ""
    items = "".join(
        f'<div class="structItem structItem--thread"><div class="structItem-title">'
        f'<a href="/threads/{slug}.{ident}/">{title}</a></div>'
        f'{f"<span class=structItem-pageJump><a href=/threads/{slug}.{ident}/page-{page_hints[ident]}>{page_hints[ident]}</a></span>" if ident in page_hints else ""}'
        f'<div class="structItem-cell--latest"><a href="/forums/onlyfans.8/">Forum</a>'
        f'<a href="/threads/{slug}.{ident}/latest"><time datetime="2026-10-26T00:{int(last) % 60:02d}:00+0100">Latest</time></a></div></div>'
        for slug, ident, title, last in rows
    )
    return f'<html><body><div class="p-title"><h1>Watched Threads</h1></div>{pager}{items}</body></html>'


def thread_page(title, posts, second=False):
    pager = '<div class="pageNav"><a href="/threads/alpha.101/page-2">2</a></div>' if second else ""
    items = "".join(
        f'<article class="message" id="post-{ident}"><a href="/threads/alpha.101/post-{ident}">#{ident}</a>'
        f'<div class="message-body"><a href="{url}">{label}</a>'
        f'<img class="bbImage" src="https://simpcity.cr/thumbs/{ident}.jpg"></div></article>'
        for ident, url, label in posts
    )
    return f'<html><head><title>{title}</title></head><body>{pager}{items}</body></html>'


def test_watched_scan_delta_filters_and_tester_handoff(tmp_path):
    forum = {"alpha_latest": "202", "alpha_posts": [
        (201, "https://turbo.cr/v/abc", "Turbo clip"),
        (202, "https://gofile.io/d/album1", "Gofile album"),
    ]}
    routes = []

    def serve(route):
        url = route.request.url
        routes.append(url)
        if url.endswith("/watched/threads"):
            html = watched_page([("alpha", 101, "Alpha", forum["alpha_latest"])], more=True, page_hints={101: 2})
        elif url.endswith("/watched/threads?page=2"):
            html = watched_page([("beta", 102, "Beta", "301")])
        elif url.endswith("/threads/alpha.101/"):
            html = thread_page("Alpha", [(100, "https://turbo.cr/v/old", "Old")], second=True)
        elif url.endswith("/threads/alpha.101/page-2"):
            html = thread_page("Alpha", forum["alpha_posts"])
        elif url.endswith("/threads/beta.102/"):
            html = thread_page("Beta", [(301, "https://pixeldrain.com/u/file1", "Pixel file")])
        else:
            route.fulfill(status=404, body="missing")
            return
        route.fulfill(status=200, content_type="text/html", body=html)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        context.route("https://simpcity.cr/**", serve)
        context.add_init_script("""
            window.chrome = {
              storage: {local: {
                async get(key) { return {[key]: JSON.parse(localStorage.getItem(key) || 'null')}; },
                async set(value) { for (const [key, data] of Object.entries(value)) localStorage.setItem(key, JSON.stringify(data)); }
              }},
              runtime: {
                onMessage: {addListener() {}},
                async sendMessage(message) {
                  if (message.action === 'nexusThreadIntake.sourceMeta') {
                    (window.__metaCalls ||= []).push(message);
                    return {ok:true,meta:{title:'Source title',duration:3723,size_bytes:1572864000,
                      width:1920,height:1080,upload_date:'2026-10-25',kind:'video'}};
                  }
                  window.__lastHandoff = message;
                  return {ok:true,count:message.links.length,sessionId:'fixture'};
                }
              }
            };
        """)
        page = context.new_page()
        page.goto("https://simpcity.cr/watched/threads")
        page.add_script_tag(path=str(EXT / "content.js"))
        page.add_style_tag(path=str(EXT / "watched.css"))
        page.add_script_tag(path=str(EXT / "watched.js"))
        page.get_by_role("button", name="Novinky v sledovaných").click()
        page.get_by_role("button", name="Skontrolovať nové").click()
        expect(page.locator('[data-part="status"]')).to_contain_text("Hotovo:", timeout=15000)

        assert page.locator(".nti-card").count() == 3
        assert not any("/v/old" in value for value in page.locator(".nti-card").all_text_contents())
        assert page.get_by_role("heading", name="Alpha · 2").count() == 1
        assert page.get_by_role("heading", name="Beta · 1").count() == 1
        page.locator('.nti-card').first.locator('input[type="checkbox"]').check()
        page.get_by_role('button', name='Načítať údaje vybraných (1)').click()
        expect(page.locator('.nti-card').first.locator('.nti-source-meta')).to_contain_text('1:02:03')
        expect(page.locator('.nti-card').first.locator('.nti-source-meta')).to_contain_text('1920 × 1080')
        expect(page.locator('.nti-card').first.locator('.nti-source-meta')).to_contain_text('2026-10-25')
        assert page.evaluate('window.__metaCalls.length') == 1
        page.get_by_role('button', name='Zrušiť výber').click()
        first_routes = len(routes)
        page.get_by_role("button", name="Skontrolovať nové").click()
        expect(page.locator('[data-part="status"]')).to_contain_text("Hotovo: 0 zmenených threadov", timeout=15000)
        expect(page.locator('[data-action="scan"]')).to_be_enabled(timeout=15000)
        assert len([url for url in routes[first_routes:] if url.startswith("https://simpcity.cr/threads/")]) == 0

        forum["alpha_latest"] = "203"
        forum["alpha_posts"].append((203, "https://bunkr.site/a/newalbum", "Bunkr album"))
        page.get_by_role("button", name="Skontrolovať nové").click()
        expect(page.locator(".nti-card")).to_have_count(4, timeout=15000)
        page.locator('[data-filter="host"]').select_option("bunkr")
        assert page.locator(".nti-card").count() == 1
        page.get_by_role("button", name="Vybrať zobrazené").click()
        page.get_by_role("button", name="Poslať vybrané do Testera (1)").click()
        page.get_by_text("Import sa nespustil.").wait_for()
        handoff = page.evaluate("window.__lastHandoff")
        assert handoff["action"] == "nexusThreadIntake.pushWatched"
        assert handoff["links"][0]["threadTitle"] == "Alpha"
        assert handoff["links"][0]["postUrl"].endswith("post-203")
        assert handoff["links"][0]["occurrences"][0]["threadId"] == "101"
        page.screenshot(path=str(tmp_path / "watched-gallery-fixture.png"))
        browser.close()


def test_watched_partial_failure_and_retry_after():
    attempts = {"beta": 0, "alpha": 0}

    def serve(route):
        url = route.request.url
        if url.endswith("/watched/threads"):
            route.fulfill(status=200, content_type="text/html", body=watched_page([
                ("alpha", 101, "Alpha", "101"), ("beta", 102, "Beta", "201")
            ]))
        elif url.endswith("/threads/alpha.101/"):
            attempts["alpha"] += 1
            route.fulfill(status=200, content_type="text/html", body=thread_page(
                "Alpha", [(101, "https://turbo.cr/v/shared", "Shared")]))
        elif url.endswith("/threads/beta.102/"):
            attempts["beta"] += 1
            if attempts["beta"] == 1:
                route.fulfill(status=503, body="temporarily unavailable")
            elif attempts["beta"] == 2:
                route.fulfill(status=429, headers={"Retry-After": "0"}, body="slow down")
            else:
                route.fulfill(status=200, content_type="text/html", body=thread_page(
                    "Beta", [(201, "https://turbo.cr/v/shared", "Shared")]))
        else:
            route.fulfill(status=404, body="missing")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        context.route("https://simpcity.cr/**", serve)
        context.add_init_script("""
          window.chrome = {
            storage:{local:{
              async get(key){return {[key]:JSON.parse(localStorage.getItem(key)||'null')};},
              async set(values){for(const [key,value] of Object.entries(values)) localStorage.setItem(key,JSON.stringify(value));}
            }}, runtime:{onMessage:{addListener(){}},async sendMessage(){return {ok:true};}}
          };
        """)
        page = context.new_page()
        page.goto("https://simpcity.cr/watched/threads")
        page.add_script_tag(path=str(EXT / "content.js"))
        page.add_style_tag(path=str(EXT / "watched.css"))
        page.add_script_tag(path=str(EXT / "watched.js"))
        page.get_by_role("button", name="Novinky v sledovaných").click()
        page.get_by_role("button", name="Skontrolovať nové").click()
        expect(page.locator('[data-part="status"]')).to_contain_text("1 chýb", timeout=15000)
        assert page.locator(".nti-card").count() == 1
        assert attempts == {"alpha": 1, "beta": 1}

        page.get_by_role("button", name="Pokračovať v skene").click()
        expect(page.locator('[data-part="status"]')).to_contain_text("Čakám 10 s", timeout=15000)
        expect(page.locator('[data-part="status"]')).to_contain_text("Hotovo:", timeout=15000)
        assert attempts == {"alpha": 1, "beta": 3}
        assert page.locator(".nti-card").count() == 1
        stored = page.evaluate("JSON.parse(localStorage.getItem('nexusThreadIntake.watched.v1.simpcity.cr'))")
        assert len(stored["cards"][0]["occurrences"]) == 2
        assert stored["cursors"]["102"]["postId"] == "201"
        page.locator('[data-filter="thread"]').fill("Beta")
        expect(page.get_by_role("heading", name="Beta · 1")).to_be_visible()
        browser.close()


def test_watched_stop_keeps_cursor_and_resumes_across_pages():
    forum = {"phase": 0, "page_two_calls": 0}

    def serve(route):
        url = route.request.url
        if url.endswith("/watched/threads"):
            marker = "102" if forum["phase"] else "100"
            html = watched_page([("alpha", 101, "Alpha", marker)], page_hints={101: 2} if forum["phase"] else None)
        elif url.endswith("/threads/alpha.101/"):
            html = thread_page("Alpha", [(100, "https://turbo.cr/v/old", "Old")], second=forum["phase"] > 0)
        elif url.endswith("/threads/alpha.101/page-2"):
            forum["page_two_calls"] += 1
            if forum["page_two_calls"] == 1:
                route.fulfill(status=429, headers={"Retry-After": "5"}, body="slow down")
                return
            html = thread_page("Alpha", [
                (101, "https://gofile.io/d/new1", "New album"),
                (102, "https://pixeldrain.com/u/new2", "New file"),
            ])
        else:
            route.fulfill(status=404, body="missing")
            return
        route.fulfill(status=200, content_type="text/html", body=html)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        context.route("https://simpcity.cr/**", serve)
        context.add_init_script("""
          window.chrome={storage:{local:{
            async get(key){return {[key]:JSON.parse(localStorage.getItem(key)||'null')};},
            async set(values){for(const [key,value] of Object.entries(values)) localStorage.setItem(key,JSON.stringify(value));}
          }},runtime:{onMessage:{addListener(){}},async sendMessage(){return {ok:true};}}};
        """)
        page = context.new_page()
        page.goto("https://simpcity.cr/watched/threads")
        page.add_script_tag(path=str(EXT / "content.js"))
        page.add_style_tag(path=str(EXT / "watched.css"))
        page.add_script_tag(path=str(EXT / "watched.js"))
        page.get_by_role("button", name="Novinky v sledovaných").click()
        page.get_by_role("button", name="Skontrolovať nové").click()
        expect(page.locator('[data-part="status"]')).to_contain_text("Hotovo:", timeout=15000)
        forum["phase"] = 1
        page.get_by_role("button", name="Skontrolovať nové").click()
        expect(page.locator('[data-part="status"]')).to_contain_text("Čakám 10 s", timeout=15000)
        page.get_by_role("button", name="Stop").click()
        expect(page.locator('[data-part="status"]')).to_contain_text("Sken zastavený", timeout=15000)
        stored = page.evaluate("JSON.parse(localStorage.getItem('nexusThreadIntake.watched.v1.simpcity.cr'))")
        assert stored["cursors"]["101"]["postId"] == "100"

        page.get_by_role("button", name="Pokračovať v skene").click()
        expect(page.locator(".nti-card")).to_have_count(3, timeout=15000)
        stored = page.evaluate("JSON.parse(localStorage.getItem('nexusThreadIntake.watched.v1.simpcity.cr'))")
        assert stored["cursors"]["101"]["postId"] == "102"
        browser.close()


def test_unpacked_extension_injects_watched_button(tmp_path):
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(tmp_path / "chrome-profile"),
            headless=True,
            channel="chromium",
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        )
        def serve(route):
            html = (thread_page("Alpha", [(201, "https://turbo.cr/v/clip", "Turbo clip")])
                    if route.request.url.endswith("/threads/alpha.101/")
                    else watched_page([("alpha", 101, "Alpha", "201")]))
            route.fulfill(status=200, content_type="text/html", body=html)

        context.route("https://simpcity.cr/**", serve)
        page = context.new_page()
        page.goto("https://simpcity.cr/watched/threads")
        expect(page.get_by_role("button", name="Novinky v sledovaných")).to_be_visible(timeout=10000)
        page.get_by_role("button", name="Novinky v sledovaných").click()
        expect(page.get_by_role("heading", name="Novinky v sledovaných threadoch")).to_be_visible()
        page.get_by_role("button", name="Skontrolovať nové").click()
        expect(page.locator(".nti-card")).to_have_count(1, timeout=15000)
        page.screenshot(path=str(tmp_path / "unpacked-extension-fixture.png"))
        context.close()


def test_unpacked_extension_source_metadata_and_inline_player(tmp_path):
    media = tmp_path / 'sample.webm'
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'color=c=blue:s=320x180:r=12', '-t', '1', '-c:v', 'libvpx-vp9',
        '-an', '-y', str(media),
    ], check=True, timeout=30)
    calls = []
    sample = media.read_bytes()

    class NexusFixture(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            calls.append(self.path)
            length = int(self.headers.get('Content-Length', '0'))
            body = json.loads(self.rfile.read(length))
            if self.path != '/api/tester/batch-meta':
                self.send_error(404)
                return
            row = {'url': body['urls'][0], 'ok': True, 'title': 'Real source video',
                   'duration': 83, 'size_bytes': 10485760, 'width': 320,
                   'height': 180, 'upload_date': '2026-10-24', 'kind': 'video',
                   'stream_url': 'https://media.example/clip.webm'}
            payload = json.dumps({'results': [row]}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            calls.append(self.path)
            if not self.path.startswith('/api/v1/video_proxy?'):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'video/webm')
            self.send_header('Content-Length', str(len(sample)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(sample)

    server = None
    for port in (8001, 8002, 8000):
        try:
            server = ThreadingHTTPServer(('127.0.0.1', port), NexusFixture)
            break
        except OSError:
            continue
    if server is None:
        pytest.skip('Nexus test ports are already in use')
    server_thread = Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    try:
      with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(tmp_path / 'chrome-player-profile'), headless=True, channel='chromium',
            args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'],
        )

        def forum(route):
            html = (thread_page('Alpha', [(201, 'https://turbo.cr/v/clip', 'Turbo clip')])
                    if route.request.url.endswith('/threads/alpha.101/')
                    else watched_page([('alpha', 101, 'Alpha', '201')]))
            route.fulfill(status=200, content_type='text/html', body=html)

        context.route('https://simpcity.cr/**', forum)
        page = context.new_page()
        page.goto('https://simpcity.cr/watched/threads')
        page.get_by_role('button', name='Novinky v sledovaných').click()
        page.get_by_role('button', name='Skontrolovať nové').click()
        expect(page.locator('.nti-card')).to_have_count(1, timeout=15000)
        page.locator('.nti-card input[type="checkbox"]').check()
        page.get_by_role('dialog', name='Novinky v sledovaných').locator('[data-part="port"]').select_option(str(port))
        page.get_by_role('button', name='Načítať údaje vybraných (1)').click()
        expect(page.locator('[data-action="fetch-meta"]')).to_be_enabled(timeout=15000)
        assert calls, page.locator('[data-part="status"]').inner_text()
        expect(page.locator('.nti-source-meta')).to_contain_text('1:23', timeout=15000)
        expect(page.locator('.nti-source-meta')).to_contain_text('10.0 MB')
        expect(page.locator('.nti-source-meta')).to_contain_text('320 × 180')
        expect(page.locator('.nti-source-meta')).to_contain_text('2026-10-24')
        page.get_by_role('button', name='▶ Play').click()
        expect(page.locator('.nti-player-modal')).to_be_visible()
        frame = page.frame_locator('.nti-player-modal iframe')
        expect(frame.locator('#video')).to_have_attribute('src', re.compile(r'/api/v1/video_proxy\?'), timeout=15000)
        frame.locator('#video').evaluate('(video) => video.play()')
        expect(frame.locator('#state')).to_be_hidden(timeout=15000)
        page.screenshot(path=str(tmp_path / 'watched-player-fixture.png'))
        page.get_by_role('button', name='Zatvoriť prehrávač').click()
        expect(page.locator('.nti-player-modal')).to_be_hidden()
        assert any('/api/tester/batch-meta' in call for call in calls)
        assert any('/api/v1/video_proxy?' in call for call in calls)
        context.close()
    finally:
        server.shutdown()
        server.server_close()
