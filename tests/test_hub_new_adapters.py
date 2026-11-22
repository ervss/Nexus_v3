"""Tests for the new Fusion Hub adapters (tnaflix, redtube).

Follows the pattern of test_hub_fetch_optimizations.py: IsolatedAsyncioTestCase,
mocked HTTP (no live network), inline HTML fixtures derived from the selectors the
existing extractors already rely on. Imports stay confined to app.hubs.* /
app.extractors.* — never app.main/app.config/app.database, whose dotenv override=True
would drag tests onto the real DB.
"""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


# One listing card in the shape TnaflixExtractor.discover()/_fetch_and_parse expects.
_TNAFLIX_LISTING_HTML = """
<html><body>
<div data-vid="111">
  <a class="video-thumb" href="/video/foo/111">
    <img data-original="https://cdnl.tnaflix.com/thumb111.jpg" alt="Foo Clip">
  </a>
  <a class="video-title" href="/video/foo/111">Foo Clip</a>
  <span class="video-duration">12:34</span>
  <span class="max-quality">1080p</span>
</div>
<div data-vid="222">
  <a class="video-thumb" href="/video/bar/222">
    <img data-src="https://cdnl.tnaflix.com/thumb222.jpg" alt="Bar Clip">
  </a>
  <a class="video-title" href="/video/bar/222">Bar Clip</a>
  <span class="video-duration">1:02:03</span>
  <span class="max-quality">4K</span>
</div>
</body></html>
"""


class TnaflixHubTests(unittest.IsolatedAsyncioTestCase):
    async def test_search_maps_listing_cards_to_tiles(self):
        from app.hubs.tnaflix import TnaflixHub

        # The listing fetch now goes through a reused `requests.Session()` (one
        # per thread, built with a local `import requests` inside `_http()`,
        # which binds the same cached module object as any other import of it) —
        # patching the extractor's own `requests.get` no longer intercepts it.
        resp = SimpleNamespace(status_code=200, text=_TNAFLIX_LISTING_HTML)
        with patch("requests.Session") as session_cls:
            session_cls.return_value.get.return_value = resp
            page = await TnaflixHub().search("", sort="recent", page=1)

        self.assertEqual(2, len(page.items))
        by_url = {it["url"]: it for it in page.items}
        foo = by_url["https://www.tnaflix.com/video/foo/111"]
        self.assertEqual("Foo Clip", foo["title"])
        self.assertEqual(12 * 60 + 34, foo["duration_sec"])
        self.assertEqual(1080, foo["height"])
        self.assertEqual("1080p", foo["quality"])
        self.assertTrue(foo["hd"])
        self.assertEqual("https://cdnl.tnaflix.com/thumb111.jpg", foo["thumb"])

        bar = by_url["https://www.tnaflix.com/video/bar/222"]
        self.assertEqual(3723, bar["duration_sec"])  # 1:02:03
        self.assertEqual(2160, bar["height"])
        self.assertEqual("4K", bar["quality"])

    async def test_search_page_two_uses_single_page_fetch(self):
        from app.hubs.tnaflix import TnaflixHub

        resp = SimpleNamespace(status_code=200, text=_TNAFLIX_LISTING_HTML)
        with patch("requests.Session") as session_cls:
            getter = session_cls.return_value.get
            getter.return_value = resp
            page = await TnaflixHub().search("kittens", sort="views", page=2)

        self.assertEqual(2, page.page)
        self.assertEqual(2, len(page.items))
        # page>1 must hit the search.php URL with page=2 and the mapped sort.
        called_url = getter.call_args[0][0]
        self.assertIn("search.php", called_url)
        self.assertIn("page=2", called_url)
        self.assertIn("sort=views", called_url)

    async def test_enrich_maps_size_and_upload_date(self):
        from app.hubs.tnaflix import TnaflixHub

        rows = [{
            "page_url": "https://www.tnaflix.com/video/foo/111",
            "ok": True, "size_bytes": 734003200, "size": "700.0 MB",
            "quality": 1080, "duration": 754, "upload_date": "2026-07-10",
            "thumbnail": "", "stream_url": "https://cdnl.tnaflix.com/f.mp4",
        }]
        with patch("app.extractors.tnaflix.TnaflixExtractor.enrich_cards_batch", return_value=rows):
            out = await TnaflixHub().enrich(["https://www.tnaflix.com/video/foo/111"])

        meta = out["https://www.tnaflix.com/video/foo/111"]
        self.assertEqual(1080, meta["height"])
        self.assertEqual("1080p", meta["quality"])
        self.assertEqual(700.0, meta["size_mb"])
        self.assertEqual(754, meta["duration_sec"])
        self.assertEqual("2026-07-10", meta["added"])

    async def test_enrich_skips_not_ok_rows(self):
        from app.hubs.tnaflix import TnaflixHub

        rows = [{"page_url": "u1", "ok": False}, {"page_url": None, "ok": True}]
        with patch("app.extractors.tnaflix.TnaflixExtractor.enrich_cards_batch", return_value=rows):
            out = await TnaflixHub().enrich(["u1", "u2"])
        self.assertEqual({}, out)

    async def test_resolve_maps_stream_and_detects_hls(self):
        from app.hubs.tnaflix import TnaflixHub

        data = {"title": "Foo", "duration": 100, "thumbnail": "t.jpg",
                "stream_url": "https://cdnl.tnaflix.com/x.m3u8", "tags": ""}
        with patch("app.extractors.tnaflix.TnaflixExtractor.extract", return_value=data):
            out = await TnaflixHub().resolve("https://www.tnaflix.com/video/foo/111")
        self.assertEqual("https://cdnl.tnaflix.com/x.m3u8", out["stream_url"])
        self.assertTrue(out["is_hls"])
        self.assertEqual(100, out["duration"])

    async def test_resolve_raises_without_stream(self):
        from app.hubs.tnaflix import TnaflixHub

        with patch("app.extractors.tnaflix.TnaflixExtractor.extract", return_value={"stream_url": None}):
            with self.assertRaises(RuntimeError):
                await TnaflixHub().resolve("https://www.tnaflix.com/video/foo/111")


class RedTubeHubTests(unittest.IsolatedAsyncioTestCase):
    async def test_resolve_maps_extractor_output(self):
        from app.hubs.redtube import RedTubeHub

        data = {"title": "Clip", "duration": 321, "thumbnail": "th.jpg",
                "stream_url": "https://dl.rdtcdn.com/x.mp4", "is_hls": False}
        hub = RedTubeHub()
        with patch("app.extractors.redtube.RedTubeExtractor.extract",
                   new=AsyncMock(return_value=data)):
            out = await hub.resolve("https://www.redtube.com/12345")
        self.assertEqual("https://dl.rdtcdn.com/x.mp4", out["stream_url"])
        self.assertFalse(out["is_hls"])
        self.assertEqual("Clip", out["title"])
        self.assertEqual(321, out["duration"])

    async def test_enrich_maps_height_and_size(self):
        from app.hubs.redtube import RedTubeHub

        data = {"height": 1080, "quality": "1080p", "size_bytes": 524288000,
                "duration": 600, "tags": ["a", "b"], "upload_date": "2026-01-02"}
        hub = RedTubeHub()
        with patch("app.extractors.redtube.RedTubeExtractor.extract",
                   new=AsyncMock(return_value=data)):
            out = await hub.enrich(["https://www.redtube.com/12345"])
        meta = out["https://www.redtube.com/12345"]
        self.assertEqual(1080, meta["height"])
        self.assertEqual("1080p", meta["quality"])
        self.assertEqual(500.0, meta["size_mb"])
        self.assertEqual(600, meta["duration_sec"])
        self.assertEqual(["a", "b"], meta["tags"])

    # RedTube's card classes are unknown (browser capture hit a consent gate), so the
    # parser anchors on the verified numeric watch URL and climbs to the thumbnail.
    LISTING_HTML = """
    <html><body>
    <ul><li class="whatever-hashed-abc">
      <a href="/191025191" title="Some Clip">
        <img data-src="https://ci.rdtcdn.com/m=e/1.jpg" alt="Some Clip">
      </a>
      <span class="x">13:41</span><span class="y">HD</span>
    </li>
    <li class="whatever-hashed-abc">
      <a href="https://www.redtube.com/103102861" title="Other Clip">
        <img src="https://ci.rdtcdn.com/m=e/2.jpg" alt="Other Clip">
      </a>
      <span class="x">16:06</span>
    </li></ul>
    <a href="/about">About us</a>
    </body></html>
    """

    async def test_search_parses_numeric_watch_cards(self):
        from app.hubs.redtube import RedTubeHub

        hub = RedTubeHub()
        hub._get_html = AsyncMock(return_value=(200, self.LISTING_HTML))
        page = await hub.search("kiss")

        self.assertEqual(2, len(page.items))  # the /about nav link must not become a tile
        first = page.items[0]
        self.assertEqual("https://www.redtube.com/191025191", first["url"])
        self.assertEqual("191025191", first["id"])
        self.assertEqual("Some Clip", first["title"])
        self.assertEqual(13 * 60 + 41, first["duration_sec"])
        self.assertEqual("https://ci.rdtcdn.com/m=e/1.jpg", first["thumb"])
        self.assertTrue(first["hd"])
        # Absolute hrefs normalise to the same canonical watch URL.
        self.assertEqual("https://www.redtube.com/103102861", page.items[1]["url"])
        self.assertFalse(page.items[1]["hd"])

    async def test_search_pagination_matches_verified_shape(self):
        from app.hubs.redtube import RedTubeHub

        hub = RedTubeHub()
        # Default recent sort for search goes to /newest
        self.assertEqual("https://www.redtube.com/newest?search=kiss", hub._list_url("kiss", 1, sort="recent"))
        self.assertEqual("https://www.redtube.com/newest?search=kiss&page=2", hub._list_url("kiss", 2, sort="recent"))
        # `_SEARCH_PATH` only routes recent/longest to a real listing (a free-text
        # query has no genuine relevance/top-rated ordering on RedTube); "longest"
        # is the other real one, and an id outside that pair falls back to /newest
        # rather than 404ing or silently claiming an ordering that doesn't exist.
        self.assertEqual("https://www.redtube.com/longest?search=kiss", hub._list_url("kiss", 1, sort="longest"))
        self.assertEqual("https://www.redtube.com/newest?search=kiss", hub._list_url("kiss", 1, sort="top_rated"))

    async def test_consent_gate_raises_instead_of_empty_page(self):
        from app.hubs.redtube import RedTubeHub

        hub = RedTubeHub()
        hub._get_html = AsyncMock(
            return_value=(200, '<div id="cookie_consent_wrapper">consent</div>'))
        with self.assertRaises(RuntimeError) as ctx:
            await hub.search("kiss")
        self.assertIn("gate", str(ctx.exception).lower())


class XXBritsHubTests(unittest.IsolatedAsyncioTestCase):
    """XXBrits runs the KVS engine, so KvsHub's parser must handle its cards unchanged."""

    # KVS-shaped listing: /videos/{id}/{slug}/ links inside `.video-item` cards.
    LISTING_HTML = """
    <html><body>
    <div class="video-item">
      <a href="/videos/15645/sophie-clip/" title="Sophie Clip">
        <img data-src="https://www.xxbrits.com/contents/videos_screenshots/15000/15645/320x180/1.jpg" alt="Sophie Clip">
      </a>
      <span class="duration">7:09</span>
      <span class="quality">1080p</span>
    </div>
    <div class="video-item">
      <a href="/videos/15646/other-clip/" title="Other Clip">
        <img data-src="https://www.xxbrits.com/contents/videos_screenshots/15000/15646/320x180/1.jpg" alt="Other Clip">
      </a>
      <span class="duration">22:29</span>
      <span class="quality">4K</span>
    </div>
    </body></html>
    """

    async def test_kvs_parser_handles_xxbrits_cards(self):
        from app.hubs.xxbrits import XXBritsHub

        hub = XXBritsHub()
        hub._get_html = AsyncMock(return_value=(200, self.LISTING_HTML, hub.origin))
        page = await hub.search("", page=1)

        self.assertEqual(2, len(page.items))
        first = page.items[0]
        self.assertEqual("https://www.xxbrits.com/videos/15645/sophie-clip/", first["url"])
        self.assertEqual("15645", first["id"])
        self.assertEqual("Sophie Clip", first["title"])
        self.assertEqual(7 * 60 + 9, first["duration_sec"])
        self.assertEqual(1080, first["height"])
        self.assertTrue(first["hd"])
        self.assertEqual(2160, page.items[1]["height"])
        self.assertEqual("4K", page.items[1]["quality"])

    async def test_url_policy_matches_kvs_shapes(self):
        from app.hubs.xxbrits import XXBritsHub

        hub = XXBritsHub()
        # search -> /search/{slug}/ ; category -> /ct/{slug}/ ; page N -> trailing /N/
        self.assertEqual("https://www.xxbrits.com/search/kiss/",
                         hub._base_url("kiss", "", "recent"))
        self.assertEqual("https://www.xxbrits.com/ct/milf/",
                         hub._base_url("", "milf", "recent"))
        self.assertEqual("https://www.xxbrits.com/search/kiss/2/",
                         hub._page_url(hub._base_url("kiss", "", "recent"), 2))

    async def test_resolve_maps_shared_kvs_router_output(self):
        from app.hubs.xxbrits import XXBritsHub

        data = {"title": "Clip", "duration": 429, "thumbnail": "t.jpg",
                "stream_url": "https://edge.xxbrits.com/get_file/x.mp4", "is_hls": False}
        with patch("app.extractors.xxbrits.XXBritsExtractor.extract",
                   new=AsyncMock(return_value=data)):
            out = await XXBritsHub().resolve("https://www.xxbrits.com/videos/15645/sophie-clip/")
        self.assertEqual("https://edge.xxbrits.com/get_file/x.mp4", out["stream_url"])
        self.assertEqual(429, out["duration"])
        self.assertFalse(out["is_hls"])

    def test_domain_routed_to_shared_kvs_extractor(self):
        from app.extractors.media_router import CyberDropKVSExtractor

        self.assertTrue(CyberDropKVSExtractor().can_handle(
            "https://www.xxbrits.com/videos/15645/sophie-clip/"))


class XVideosHubTests(unittest.IsolatedAsyncioTestCase):
    """Fixtures mirror the live DOM capture (2026-07-16)."""

    # Real shape: hashed wrapper + data-id/data-eid/data-nvs-url, dotted watch URL.
    LISTING_HTML = """
    <div id="video_iadvbao06bd" data-id="44932005" data-eid="iadvbao06bd"
         class="frame-block thumb-block tb_full_init"
         data-nvs-url="https://www.xvideos.com/video.iadvbao06bd/kissing">
      <div class="thumb-inside"><a href="/video.iadvbao06bd/kissing">
        <img data-videoid="44932005" data-src="https://cdn.xvideos.com/t.jpg"
             data-pvv="https://cdn.xvideos.com/preview.mp4"></a></div>
      <p class="title"><a href="/video.iadvbao06bd/kissing" title="Kissing">Kissing</a>
        <span class="duration">7:09</span></p>
    </div>
    """

    # Legacy shape XVideos still rotates back to — must parse identically.
    LEGACY_LISTING_HTML = """
    <div class="thumb-block" data-id="4588838">
      <div class="thumb-inside"><a href="/video4588838/biker_takes_his_girl">
        <img data-src="https://cdn.xvideos.com/t2.jpg"></a></div>
      <p class="title"><a href="/video4588838/biker_takes_his_girl" title="Biker">Biker</a>
        <span class="duration">10 min</span></p>
    </div>
    """

    async def test_parses_current_dotted_url_shape(self):
        from app.hubs.xvideos import XVideosHub

        hub = XVideosHub()
        hub._get_html = AsyncMock(return_value=(200, self.LISTING_HTML))
        page = await hub.search("kiss")

        self.assertEqual(1, len(page.items))
        tile = page.items[0]
        self.assertEqual("https://www.xvideos.com/video.iadvbao06bd/kissing", tile["url"])
        self.assertEqual("44932005", tile["id"])
        self.assertEqual("Kissing", tile["title"])
        self.assertEqual(7 * 60 + 9, tile["duration_sec"])
        self.assertEqual("https://cdn.xvideos.com/t.jpg", tile["thumb"])

    async def test_parses_legacy_numeric_url_shape(self):
        # XVideos rotates URL shapes; the parser must not pin to one.
        from app.hubs.xvideos import XVideosHub

        hub = XVideosHub()
        hub._get_html = AsyncMock(return_value=(200, self.LEGACY_LISTING_HTML))
        page = await hub.search("biker")

        self.assertEqual(1, len(page.items))
        tile = page.items[0]
        self.assertEqual("https://www.xvideos.com/video4588838/biker_takes_his_girl", tile["url"])
        self.assertEqual(600, tile["duration_sec"])  # "10 min"

    async def test_search_pagination_is_zero_indexed(self):
        from app.hubs.xvideos import XVideosHub

        hub = XVideosHub()
        # Live-verified: page 1 => p=0, page 2 => p=1.
        self.assertEqual("https://www.xvideos.com/?k=kiss&p=0", hub._search_url("kiss", 1))
        self.assertEqual("https://www.xvideos.com/?k=kiss&p=1", hub._search_url("kiss", 2))

    async def test_enrich_reads_ldjson_videoobject(self):
        from app.hubs.xvideos import XVideosHub

        # The real ld+json has NO `height` — this fixture used to invent one, which hid
        # the fact that quality came back empty in production. Resolution only exists in
        # the HLS master playlist, and the size only on the progressive mp4.
        html = ('<script type="application/ld+json">'
                '{"@type":"VideoObject","name":"X","uploadDate":"2017-03-20T10:55:04+00:00",'
                '"duration":"PT00H08M16S",'
                '"contentUrl":"https://mp4-gcore.xvideos-cdn.com/a.mp4"}</script>'
                "html5player.setVideoHLS('https://hls.xvideos-cdn.com/x/master.m3u8');"
                "html5player.setVideoUrlHigh('https://mp4-gcore.xvideos-cdn.com/a/mp4_sd.mp4');")
        hub = XVideosHub()
        hub._get_html = AsyncMock(return_value=(200, html))
        hub._hls_height = AsyncMock(return_value=1080)
        hub._head_size = AsyncMock(return_value=73_701_000)
        out = await hub.enrich(["https://www.xvideos.com/video.abc/x"])

        meta = out["https://www.xvideos.com/video.abc/x"]
        self.assertEqual(8 * 60 + 16, meta["duration_sec"])
        self.assertEqual("2017-03-20", meta["added"])
        self.assertEqual(1080, meta["height"])
        self.assertEqual("1080p", meta["quality"])
        self.assertEqual(70.3, meta["size_mb"])
        hub._hls_height.assert_awaited_once_with("https://hls.xvideos-cdn.com/x/master.m3u8")

    async def test_hls_master_gives_the_best_resolution(self):
        from app.hubs.xvideos import XVideosHub

        # Real master playlist shape; renditions are NOT listed in height order.
        manifest = (
            "#EXTM3U\n"
            '#EXT-X-STREAM-INF:BANDWIDTH=815104,RESOLUTION=854x480,NAME="480p"\n'
            "hls-480p.m3u8\n"
            '#EXT-X-STREAM-INF:BANDWIDTH=3375104,RESOLUTION=1920x1080,NAME="1080p"\n'
            "hls-1080p.m3u8\n"
            '#EXT-X-STREAM-INF:BANDWIDTH=475136,RESOLUTION=640x360,NAME="360p"\n'
            "hls-360p.m3u8\n"
        )
        # `_hls_height` reuses a per-thread curl_cffi Session, created lazily on
        # whichever executor thread runs it — patching `curl_cffi.requests.get`
        # no longer intercepts anything, since the code path is session.get().
        hub = XVideosHub()
        with patch("app.hubs.xvideos.cr.Session") as session_cls:
            session_cls.return_value.get.return_value = SimpleNamespace(status_code=200, text=manifest)
            self.assertEqual(1080, await hub._hls_height("https://x/master.m3u8"))


class XHamsterHubTests(unittest.IsolatedAsyncioTestCase):
    # Real shape: build-hashed sibling classes around the stable `video-thumb` token.
    LISTING_HTML = """
    <div class="container-c9dbd thumb-list__item video-thumb video-thumb--type-video"
         data-video-id="29176675" data-video-type="video">
      <a class="video-thumb__image-container"
         href="https://xhamster.com/videos/stranger-touch-her-butt-xhABC123">
        <img src="https://thumb.xhcdn.com/a.jpg" alt="Stranger">
        <span class="thumb-image__duration">14:53</span>
        <span class="thumb-image__hd">HD</span>
      </a>
      <a class="video-thumb__name" href="https://xhamster.com/videos/stranger-touch-her-butt-xhABC123">Stranger Clip</a>
    </div>
    """

    # The real listing is JSON-driven; only ~8 of 46 cards are server-rendered HTML and
    # the rest are skeletons. Parsing the DOM returned 7 tiles + 39 empty placeholders.
    LISTING_JSON_HTML = """
    <script id='initials-script'>window.initials={"layoutPage":{"videoListProps":{
      "videoThumbProps":[
        {"id":30219665,"duration":1209,"created":1584232486,"title":"Smile After",
         "pageURL":"https://xhamster.com/videos/smile-after-xhcZhsJ",
         "thumbURL":"https://ic-vt-nss.xhcdn.com/a/hash/030/219/665/526x298.jpg",
         "trailerURL":"https://thumb-v5.xhcdn.com/a/h/030/219/665/526x298.t.mp4",
         "views":42,"isUHD":true},
        {"id":30219666,"duration":300,"created":1584232486,"title":"Second Clip",
         "pageURL":"https://xhamster.com/videos/second-clip-xhAAA",
         "thumbURL":"https://ic-vt-nss.xhcdn.com/a/hash/030/219/666/526x298.jpg",
         "views":0}
      ]}}};</script>
    <div class="video-thumb" data-video-id="30219665">
      <a class="video-thumb__image-container" href="https://xhamster.com/videos/smile-after-xhcZhsJ"></a>
    </div>
    """

    async def test_listing_comes_from_json_not_the_placeholder_dom(self):
        from app.hubs.xhamster import XHamsterHub

        hub = XHamsterHub()
        hub._get_html = AsyncMock(return_value=(200, self.LISTING_JSON_HTML))
        page = await hub.search("kiss")

        # Both cards, including the one with no server-rendered HTML at all.
        self.assertEqual(2, len(page.items))
        first, second = page.items
        self.assertEqual("Smile After", first["title"])
        self.assertEqual("https://ic-vt-nss.xhcdn.com/a/hash/030/219/665/526x298.jpg",
                         first["thumb"])
        self.assertEqual(1209, first["duration_sec"])
        self.assertEqual("2020-03-15", first["added"])   # date now comes free of enrich
        self.assertEqual("42 views", first["views"])
        self.assertEqual("4K", first["quality"])         # isUHD is the only listing hint
        # isUHD absent means "not 4K", not "unknown" — quality stays empty for enrich.
        self.assertEqual("", second["quality"])
        self.assertEqual("Second Clip", second["title"])

    async def test_dom_fallback_when_the_json_shape_moves(self):
        from app.hubs.xhamster import XHamsterHub

        hub = XHamsterHub()
        hub._get_html = AsyncMock(return_value=(200, self.LISTING_HTML))
        page = await hub.search("kiss")

        self.assertEqual(1, len(page.items))
        self.assertEqual("Stranger Clip", page.items[0]["title"])

    async def test_parses_hashed_card_via_stable_token(self):
        from app.hubs.xhamster import XHamsterHub

        hub = XHamsterHub()
        hub._get_html = AsyncMock(return_value=(200, self.LISTING_HTML))
        page = await hub.search("kiss")

        self.assertEqual(1, len(page.items))
        tile = page.items[0]
        self.assertEqual("https://xhamster.com/videos/stranger-touch-her-butt-xhABC123", tile["url"])
        self.assertEqual("29176675", tile["id"])
        self.assertEqual("Stranger Clip", tile["title"])
        self.assertEqual(14 * 60 + 53, tile["duration_sec"])
        self.assertTrue(tile["hd"])

    async def test_pagination_uses_page_param(self):
        from app.hubs.xhamster import XHamsterHub

        hub = XHamsterHub()
        # Live-verified 2026-07-25 (supersedes the "?page=N" note below): search
        # pages with `?page=`, but `_list_url`'s untouched default sort ("recent")
        # always maps to a real `sort=newest` on a search URL — there is no
        # sort-less search state to fall back to. Category/browse listings page
        # as a trailing PATH segment instead; `?page=` there 200s but silently
        # re-serves page 1 (see the class docstring).
        self.assertEqual("https://xhamster.com/search/kiss?sort=newest", hub._list_url("kiss", "", 1))
        self.assertEqual("https://xhamster.com/search/kiss?sort=newest&page=2",
                         hub._list_url("kiss", "", 2))
        self.assertEqual("https://xhamster.com/categories/amateur/newest/3",
                         hub._list_url("", "amateur", 3))

    # Trimmed from a live watch page (2026-07-17): xHamster serves no ld+json, so every
    # enrichable field lives in window.initials. `sources` is present but deliberately
    # untouched — its URLs are hex-scrambled and enrich must not need the decode.
    WATCH_HTML = """
    <script>window.initials = {"videoModel":{"id":30215850,
      "title":"Mature Brunette MILF","duration":284,"created":1584232486,
      "isHD":false,"resolution":[1280,720],"views":192},
      "videoTagsComponent":{"videoId":30215850,"tags":[
        {"id":1,"name":"Amateur","url":"https://xhamster.com/categories/amateur"},
        {"id":2,"name":"Anal","url":"https://xhamster.com/categories/anal"}]},
      "xplayerSettings":{"sources":{"standard":{"h264":[{"url":"060c9df3725ca8"}]}}}
    };</script>
    """

    async def test_enrich_reads_initials_without_decoding_the_stream(self):
        from app.hubs.xhamster import XHamsterHub

        hub = XHamsterHub()
        hub._get_html = AsyncMock(return_value=(200, self.WATCH_HTML))
        out = await hub.enrich(["https://xhamster.com/videos/x-xhABC"])

        meta = out["https://xhamster.com/videos/x-xhABC"]
        # resolution is [width, height] — the height is the second element.
        self.assertEqual(720, meta["height"])
        self.assertEqual("720p", meta["quality"])
        self.assertTrue(meta["hd"])              # derived from height, not the isHD flag
        self.assertEqual(284, meta["duration_sec"])
        self.assertEqual("2020-03-15", meta["added"])   # unix `created` -> ISO date
        self.assertEqual(["Amateur", "Anal"], meta["tags"])
        # No size: it would cost the scrambled-URL decode plus a HEAD.
        self.assertIsNone(meta.get("size_mb"))

    async def test_enrich_skips_a_page_with_no_initials(self):
        from app.hubs.xhamster import XHamsterHub

        hub = XHamsterHub()
        hub._get_html = AsyncMock(return_value=(200, "<html>gate</html>"))
        self.assertEqual({}, await hub.enrich(["https://xhamster.com/videos/x-xhABC"]))

    async def test_size_is_deep_only_and_flagged_as_an_estimate(self):
        from app.hubs.xhamster import XHamsterHub

        hub = XHamsterHub()
        hub._get_html = AsyncMock(return_value=(200, self.WATCH_HTML))
        hub._estimated_size_mb = AsyncMock(return_value=(64.2, True))

        # Default pass must stay cheap: no yt-dlp resolve, so no size.
        fast = await hub.enrich(["https://xhamster.com/videos/x-xhABC"])
        self.assertIsNone(fast["https://xhamster.com/videos/x-xhABC"].get("size_mb"))
        hub._estimated_size_mb.assert_not_awaited()

        deep = await hub.enrich(["https://xhamster.com/videos/x-xhABC"], deep=True)
        meta = deep["https://xhamster.com/videos/x-xhABC"]
        self.assertEqual(64.2, meta["size_mb"])
        # HLS has no byte count — the UI must be able to show this as approximate.
        self.assertTrue(meta["size_estimated"])

    async def test_bitrate_size_estimate_is_derived_from_tbr_and_duration(self):
        from app.extractors.xhamster import XHamsterExtractor
        import yt_dlp

        # Real xHamster shape: HLS renditions with a bitrate but no filesize at all.
        info = {
            "id": "1", "title": "X", "duration": 192.0, "height": 1080, "width": 1920,
            "upload_date": "20260315",
            "url": "https://cdn/x.m3u8",
            "formats": [
                {"height": 480, "tbr": 472.074, "url": "https://cdn/480.m3u8"},
                {"height": 1080, "tbr": 2803.83, "url": "https://cdn/1080.m3u8"},
            ],
        }

        class _FakeYDL:
            def __init__(self, *a, **k): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def extract_info(self, url, download=False): return info

        with patch.object(yt_dlp, "YoutubeDL", _FakeYDL):
            data = await XHamsterExtractor().extract("https://xhamster.com/videos/x-xhABC")

        # 2803.83 kbit/s * 192s / 8 = ~64.2 MB, taken from the best rendition.
        self.assertEqual(int(2803.83 * 1000 * 192 / 8), data["size_bytes"])
        self.assertTrue(data["size_estimated"])
        self.assertEqual("20260315", data["upload_date"])


class NoodleMagazineHubTests(unittest.IsolatedAsyncioTestCase):
    # Copied from a live card (2026-07-17). The previous fixture here was invented: it
    # put a `data-nvs-url` on .item (no live card has one) and the duration in a
    # `<span class="duration">`. The parser had been written from the same invention, so
    # the two agreed and the real bug — every title coming out as "HD 38.22M 43:40 …" —
    # stayed invisible. Keep this fixture byte-faithful to the site.
    LISTING_HTML = """
    <div class="item">
      <a class="item_link" href="/watch/-204180429_456239224">
        <div class="i_img" data-trailer_url="https://cdn2.pvvstream.pro/videos/tr_240p.mp4">
          <img alt="Kiss Clip alt" class="lazyload widescreen"
               data-src="https://cdn2.pvvstream.pro/preview_320.jpg"
               src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
          <i class="hd_mark">HD</i>
          <div class="m_views"><svg class="icon icon-eye"><use xlink:href="#eye"></use></svg>38.22M</div>
          <div class="m_time"><svg class="icon icon-clock-o"><use xlink:href="#clock-o"></use></svg>15:03</div>
          <div class="preview" title="Preview available on hover"></div>
        </div>
        <div class="i_info"><div class="title">Kiss Clip</div></div>
      </a>
    </div>
    """

    async def test_parses_item_card_from_the_link_href(self):
        from app.hubs.noodlemagazine import NoodleMagazineHub

        hub = NoodleMagazineHub()
        hub._get_html = AsyncMock(return_value=(200, self.LISTING_HTML))
        page = await hub.search("kiss")

        self.assertEqual(1, len(page.items))
        tile = page.items[0]
        self.assertEqual("https://noodlemagazine.com/watch/-204180429_456239224", tile["url"])
        self.assertEqual("-204180429_456239224", tile["id"])
        self.assertEqual(15 * 60 + 3, tile["duration_sec"])
        self.assertEqual("https://cdn2.pvvstream.pro/videos/tr_240p.mp4", tile["preview"])
        self.assertTrue(tile["hd"])

    async def test_title_excludes_the_badge_text(self):
        from app.hubs.noodlemagazine import NoodleMagazineHub

        # The regression: a comma selector group matches in DOCUMENT order, so
        # `a.title, .title, a.item_link` picked the wrapping anchor and glued the HD /
        # views / duration badges onto every title.
        hub = NoodleMagazineHub()
        hub._get_html = AsyncMock(return_value=(200, self.LISTING_HTML))
        page = await hub.search("kiss")

        self.assertEqual("Kiss Clip", page.items[0]["title"])
        # 38.22M is the view count (eye icon), not a file size — it belongs here.
        self.assertEqual("38.22M views", page.items[0]["views"])

    async def test_pagination_uses_p_param(self):
        from app.hubs.noodlemagazine import NoodleMagazineHub

        hub = NoodleMagazineHub()
        # Live-verified: /video/{q} with ?p=N (an earlier report wrongly claimed ?page=N).
        self.assertEqual("https://noodlemagazine.com/video/kiss", hub._list_url("kiss", 1))
        self.assertEqual("https://noodlemagazine.com/video/kiss?p=2", hub._list_url("kiss", 2))

    async def test_enrich_reads_height_size_tags_and_date(self):
        from app.hubs.noodlemagazine import NoodleMagazineHub

        watch = """
        <script type="application/ld+json">
        {"@type":"VideoObject","name":"X","uploadDate":"2020-06-29",
         "duration":"PT43M40S","keywords":"anal, group, mom"}
        </script>
        <script>window.playlist = {"image":"x.jpg","sources":[
          {"file":"https://cdn.pvvstream.pro/v/vid_720p.mp4?secure=a","label":"720","type":"mp4"},
          {"file":"https://cdn.pvvstream.pro/v/vid_480p.mp4?secure=b","label":"480","type":"mp4","default":true}
        ]};</script>
        """
        hub = NoodleMagazineHub()
        hub._get_html = AsyncMock(return_value=(200, watch))
        hub._head_size = AsyncMock(return_value=654400837)
        out = await hub.enrich(["https://noodlemagazine.com/watch/-1_2"])

        meta = out["https://noodlemagazine.com/watch/-1_2"]
        self.assertEqual(720, meta["height"])          # best rendition wins, not `default`
        self.assertEqual("720p", meta["quality"])
        self.assertEqual(624.1, meta["size_mb"])
        self.assertEqual("2020-06-29", meta["added"])
        self.assertEqual(43 * 60 + 40, meta["duration_sec"])
        self.assertEqual(["anal", "group", "mom"], meta["tags"])
        # The size is probed against the highest rendition the page already signed.
        hub._head_size.assert_awaited_once_with(
            "https://cdn.pvvstream.pro/v/vid_720p.mp4?secure=a")

    async def test_enrich_survives_a_page_without_metadata(self):
        from app.hubs.noodlemagazine import NoodleMagazineHub

        hub = NoodleMagazineHub()
        hub._get_html = AsyncMock(return_value=(200, "<html>nothing here</html>"))
        self.assertEqual({}, await hub.enrich(["https://noodlemagazine.com/watch/-1_2"]))


class RegistryTests(unittest.IsolatedAsyncioTestCase):
    def test_new_adapters_registered_and_idempotent(self):
        from app.hubs import registry

        registry.init_hubs()
        registry.init_hubs()  # idempotent
        sources = {s["source"] for s in registry.all_sources()}
        self.assertIn("tnaflix", sources)
        self.assertIn("redtube", sources)
        self.assertIn("xxbrits", sources)
        self.assertIsNotNone(registry.get("TNAFLIX"))  # case-insensitive get

    def test_one_bad_adapter_does_not_break_others(self):
        from app.hubs import registry

        # Force a fresh registration cycle with one adapter whose constructor raises.
        original = dict(registry._ADAPTERS)
        registry._ADAPTERS.clear()
        try:
            class Boom:
                def __init__(self):
                    raise RuntimeError("boom")

            with patch("app.hubs.registry.logger"):
                # Re-run the registration body manually with a poisoned factory mixed in.
                from app.hubs.eporner import EpornerHub
                for factory in (Boom, EpornerHub):
                    try:
                        registry.register(factory())
                    except Exception:
                        pass
            self.assertIsNotNone(registry.get("eporner"))
            self.assertIsNone(registry.get("boom"))
        finally:
            registry._ADAPTERS.clear()
            registry._ADAPTERS.update(original)


class CategoryHelperTests(unittest.TestCase):
    """The shared label/slug rules that the per-source category parsers lean on."""

    def test_label_without_count_strips_the_badge_node(self):
        from bs4 import BeautifulSoup
        from app.hubs.base import label_without_count

        # Real xxbrits shape: name and count are separate children of the anchor.
        anchor = BeautifulSoup(
            '<a href="/ct/onlyfans/"><span>Onlyfans</span><b>15040</b></a>',
            "html.parser").a
        self.assertEqual("Onlyfans", label_without_count(anchor))
        # The caller's soup must survive — categories() reads the href afterwards.
        self.assertEqual("/ct/onlyfans/", anchor.get("href"))

    def test_label_without_count_keeps_a_name_ending_in_a_numeral(self):
        from bs4 import BeautifulSoup
        from app.hubs.base import label_without_count

        # Why this is structural and not a trailing-digits regex: "1 on 1" would lose
        # its last token to one. Only a child that is ENTIRELY a number is a badge.
        anchor = BeautifulSoup(
            '<a href="/tags/1-on-1"><b>1 on 1</b><span class="navbadge">212,137</span></a>',
            "html.parser").a
        self.assertEqual("1 on 1", label_without_count(anchor))

    def test_dedupe_categories_drops_repeats_and_falls_back_to_the_slug(self):
        from app.hubs.base import dedupe_categories

        rows = [("amateur", "Amateur"), ("amateur", "Amateur again"),
                ("old-young", ""), ("", "junk")]
        self.assertEqual(
            [{"slug": "amateur", "name": "Amateur"},
             {"slug": "old-young", "name": "Old Young"}],
            dedupe_categories(rows))

    def test_dedupe_categories_caps_the_list(self):
        from app.hubs.base import dedupe_categories

        rows = [(f"tag-{i}", f"Tag {i}") for i in range(500)]
        self.assertEqual(120, len(dedupe_categories(rows)))

    def test_tnaflix_category_slug_is_used_verbatim(self):
        from app.extractors.tnaflix import tnaflix_category_slug

        # Live fact: TNAFlix slugs carry no single suffix, so a slug from categories()
        # is the path as-is. Appending "-porn" here would 404 the -videos/-sex ones.
        self.assertEqual("babe-videos", tnaflix_category_slug("babe-videos"))
        self.assertEqual("double-penetration", tnaflix_category_slug("double-penetration"))
        # Only a bare one-word category has to be guessed at, and "-porn" is the
        # majority shape (49 of 74).
        self.assertEqual("amateur-porn", tnaflix_category_slug("amateur"))
        self.assertEqual("big-cock", tnaflix_category_slug("Big Cock"))
        self.assertEqual("", tnaflix_category_slug(""))


class CategoriesFetchTests(unittest.IsolatedAsyncioTestCase):
    """Per-source category parsing, against the live DOM shapes captured 2026-07-16."""

    async def test_xvideos_ranks_by_count_and_drops_stopwords(self):
        from app.hubs.xvideos import XVideosHub

        # The alphabet index sits OUTSIDE ul.tags-list and must not become a chip;
        # "and" outranks everything because the counts are search-MATCH counts.
        html = """
        <a href="/tags/a">a</a>
        <ul class="tags-list">
          <li><a href="/tags/0-pussy"><b>0-pussy </b><span class="navbadge">104,458</span></a></li>
          <li><a href="/tags/and"><b>and </b><span class="navbadge">545,819</span></a></li>
          <li><a href="/tags/amateur"><b>amateur </b><span class="navbadge">64,019</span></a></li>
          <li><a href="/tags/cum-in-pussy"><b>cum-in-pussy </b><span class="navbadge">419,825</span></a></li>
        </ul>
        """
        hub = XVideosHub()
        hub._get_html = AsyncMock(return_value=(200, html))
        cats = await hub.categories()

        self.assertEqual(["cum-in-pussy", "0-pussy", "amateur"],
                         [c["slug"] for c in cats])

    async def test_xvideos_category_browse_is_zero_indexed(self):
        from app.hubs.xvideos import XVideosHub

        hub = XVideosHub()
        self.assertEqual("https://www.xvideos.com/tags/amateur",
                         hub._search_url("", 1, "amateur"))
        # The trap: page 2 is /1, not /2 — same 0-indexing as ?p= search paging.
        self.assertEqual("https://www.xvideos.com/tags/amateur/1",
                         hub._search_url("", 2, "amateur"))
        # A query still wins over a category.
        self.assertEqual("https://www.xvideos.com/?k=kiss&p=0",
                         hub._search_url("kiss", 1, "amateur"))

    async def test_redtube_categories_and_category_browse_path(self):
        from app.hubs.redtube import RedTubeHub

        html = """
        <li class="category_item"><div class="category_item_wrapper">
          <a class="category_thumb_link" aria-label="Amateur" href="/redtube/amateur">
            <img alt="Amateur" data-src="https://ei.rdtcdn.com/a.jpg"></a>
        </div></li>
        <li class="category_item"><div class="category_item_wrapper">
          <a class="category_thumb_link" aria-label="Trans" href="/redtube/transgender">
            <img alt="Trans" data-src="https://ei.rdtcdn.com/t.jpg"></a>
        </div></li>
        """
        hub = RedTubeHub()
        hub._get_html = AsyncMock(return_value=(200, html))
        cats = await hub.categories()

        self.assertEqual([{"slug": "amateur", "name": "Amateur"},
                          {"slug": "transgender", "name": "Trans"}], cats)
        # Category browse is /redtube/{slug}; /categories only lists them. Default recent sort uses ?sorting=newest
        self.assertEqual("https://www.redtube.com/redtube/amateur?sorting=newest",
                         hub._list_url("", 1, "amateur", sort="recent"))
        self.assertEqual("https://www.redtube.com/redtube/amateur?sorting=newest&page=2",
                         hub._list_url("", 2, "amateur", sort="recent"))

    async def test_xhamster_categories_ignore_build_hashed_classes(self):
        from app.hubs.xhamster import XHamsterHub

        # Classes are hashed per deploy, so only the href shape may be matched.
        html = """
        <ul class="dropdown container-12755">
          <li><a class="itemContent-12755" href="https://xhamster.com/categories/amateur">Amateur</a></li>
          <li><a class="itemContent-99999" href="https://xhamster.com/categories/old-young">Old &amp; Young</a></li>
        </ul>
        <a href="https://xhamster.com/categories/amateur?page=2">pager, not a chip</a>
        """
        hub = XHamsterHub()
        hub._get_html = AsyncMock(return_value=(200, html))
        cats = await hub.categories()

        self.assertEqual([{"slug": "amateur", "name": "Amateur"},
                          {"slug": "old-young", "name": "Old & Young"}], cats)

    async def test_tnaflix_categories_take_the_full_path_segment(self):
        from app.hubs.tnaflix import TnaflixHub

        html = """
        <div class="category-index">
          <div class="category-item">
            <a href="https://www.tnaflix.com/amateur-porn">Amateur Porn <span>1.2M</span></a>
          </div>
          <div class="category-item">
            <a href="https://www.tnaflix.com/babe-videos">Babes Fucking <span>883.5K</span></a>
          </div>
        </div>
        """
        resp = SimpleNamespace(status_code=200, text=html)
        with patch("requests.Session") as session_cls:
            session_cls.return_value.get.return_value = resp
            cats = await TnaflixHub().categories()

        self.assertEqual([{"slug": "amateur-porn", "name": "Amateur Porn"},
                          {"slug": "babe-videos", "name": "Babes Fucking"}], cats)

    async def test_noodlemagazine_has_no_taxonomy(self):
        from app.hubs.noodlemagazine import NoodleMagazineHub

        # Deliberate: /categories and /tags both 404 upstream, so [] is the honest
        # answer rather than a hand-written chip list.
        self.assertEqual([], await NoodleMagazineHub().categories())

    async def test_categories_serves_stale_rows_when_a_refetch_fails(self):
        from app.hubs.xhamster import XHamsterHub

        html = '<a href="https://xhamster.com/categories/amateur">Amateur</a>'
        hub = XHamsterHub()
        hub._get_html = AsyncMock(return_value=(200, html))
        first = await hub.categories()

        hub._categories_ttl = -1  # force the cache to look expired
        hub._get_html = AsyncMock(side_effect=RuntimeError("network died"))
        self.assertEqual(first, await hub.categories())


if __name__ == "__main__":
    unittest.main()
