import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


class NetworkFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_eporner_auto_retries_blocked_request_through_tor(self):
        from app.hubs import eporner as module

        responses = [
            SimpleNamespace(status_code=429, text="blocked"),
            SimpleNamespace(status_code=200, text="ok"),
        ]
        with patch.dict(module.os.environ, {"EPORNER_NETWORK_MODE": "auto", "EPORNER_MIN_GAP": "0"}, clear=False):
            with patch.object(module, "_cget", side_effect=responses) as request:
                with patch("app.tor_service.tor_service.start", return_value={"ready": True}):
                    status, text = await module.EpornerHub()._fetch("https://www.eporner.com/test")
        self.assertEqual((200, "ok"), (status, text))
        self.assertFalse(request.call_args_list[0].kwargs["force_tor"])
        self.assertTrue(request.call_args_list[1].kwargs["force_tor"])

    async def test_whoreshub_auto_retries_403_through_tor(self):
        from app.hubs import kvs as module
        from app.hubs.whoreshub import WhoresHub

        responses = [
            SimpleNamespace(status_code=403, text="blocked", url="https://www.whoreshub.com/"),
            SimpleNamespace(status_code=200, text="ok", url="https://www.whoreshub.com/"),
        ]
        # `_get_html` runs its request inside asyncio.to_thread, so the reused
        # session is created lazily on whichever executor thread picks up the
        # job — patching an instance the test thread built would miss it.
        # Patching the Session *class* means every thread's lazy `cr.Session(...)`
        # call returns the same mock (a class mock's `return_value` is shared).
        with patch.dict(module.os.environ, {"WHORESHUB_NETWORK_MODE": "auto"}, clear=False):
            with patch.object(module.cr, "Session") as session_cls:
                request = session_cls.return_value.get
                request.side_effect = responses
                with patch("app.tor_service.tor_service.start", return_value={"ready": True}):
                    status, text, _ = await WhoresHub()._get_html("https://www.whoreshub.com/")
        self.assertEqual((200, "ok"), (status, text))
        self.assertNotIn("proxies", request.call_args_list[0].kwargs)
        self.assertIn("proxies", request.call_args_list[1].kwargs)


class EpornerPlaylistTests(unittest.IsolatedAsyncioTestCase):
    async def test_playlist_uses_canonical_profile_url_and_excludes_sidebar(self):
        from app.hubs import eporner as module

        pid = "abc123XYZ"
        canonical = f"https://www.eporner.com/profile/user/playlist/{pid}/sample/"
        module._PLAYLIST_META[pid] = {"url": canonical, "title": "Sample", "count": 2}
        card = lambda ident: (
            f'<div class="mb" data-id="{ident}"><div class="mbcontent">'
            f'<a href="/video-{ident}/sample/"><img alt="Video {ident}" src="/x.jpg"></a>'
            '</div><span class="mbtim">01:00</span><div class="mvhdico"><span>720p</span></div></div>'
        )
        html = f'<div id="profile_sidebar">{card("9")}</div><div class="profilemain">{card("1")}{card("2")}</div>'
        hub = module.EpornerHub()
        hub._get_html = AsyncMock(return_value=(200, html))

        page = await hub.playlist_videos(pid)

        self.assertEqual(2, len(page.items))
        self.assertEqual(2, page.total)
        hub._get_html.assert_awaited_once_with(canonical)


class KvsMetadataTests(unittest.IsolatedAsyncioTestCase):
    async def test_whoreshub_supports_pornstars_performer_links(self):
        from app.hubs.whoreshub import WhoresHub

        html = '''
        <html><head><meta property="og:title" content="Demo"></head><body>
        <div class="video-info">Duration: 01:20 MP4 1080p, 123 MB
          <a href="/pornstars/jane-doe/">Jane Doe</a>
          <a href="/categories/amateur/">Amateur</a>
          <a href="/tags/demo/">Demo</a>
        </div></body></html>
        '''
        hub = WhoresHub()
        hub._detail_cache_get = lambda *_args, **_kwargs: None
        hub._detail_cache_put = lambda _url, data, **_kwargs: data
        hub._get_html = AsyncMock(return_value=(200, html, "https://www.whoreshub.com/videos/1/"))

        result = await hub._detail_metadata("https://www.whoreshub.com/videos/1/")

        self.assertEqual("Jane Doe", result["performers"][0]["name"])


class CamwhoresMetadataTests(unittest.IsolatedAsyncioTestCase):
    async def test_fast_metadata_does_not_run_stream_extractor(self):
        from app.hubs.camwhores import CamwhoresHub

        html = '''
        <meta property="og:title" content="Fast Demo"><meta property="og:image" content="https://cdn/x.jpg">
        <meta property="video:duration" content="125">
        <a href="/members/42/">Uploader</a>
        <script>var flashvars = {video_tags:'tag1,tag2',video_categories:'Amateur',video_models:'Jane Doe',preview_height1:'1080',video_url:'https://www.camwhores.tv/get_file/1/test.mp4'};</script>
        '''
        hub = CamwhoresHub()
        hub._detail_cache_get = lambda *_args, **_kwargs: None
        hub._detail_cache_put = lambda _url, data, **_kwargs: data
        hub._get_html = AsyncMock(return_value=(200, html, "https://www.camwhores.tv/videos/1/"))
        hub._extract = AsyncMock()

        result = await hub._detail_metadata("https://www.camwhores.tv/videos/1/")

        hub._extract.assert_not_awaited()
        self.assertEqual("fast", result["metadata_level"])
        self.assertEqual(1080, result["height"])
        self.assertIsNone(result["size_mb"])
        self.assertEqual("Jane Doe", result["performers"][0]["name"])

    async def test_deep_metadata_keeps_exact_size_probe_result(self):
        from app.hubs.camwhores import CamwhoresHub

        hub = CamwhoresHub()
        hub._detail_cache_get = lambda *_args, **_kwargs: None
        hub._detail_cache_put = lambda _url, data, **_kwargs: data
        hub._extract = AsyncMock(return_value={
            "title": "Deep Demo", "height": 1080, "duration": 60,
            "size_bytes": 104857600, "stream_url": "https://cdn/video.mp4",
            "models": "Jane Doe", "categories": "Amateur", "tags": ["demo"],
        })

        result = await hub._detail_metadata("https://www.camwhores.tv/videos/1/", deep=True)

        self.assertEqual("deep", result["metadata_level"])
        self.assertEqual(100.0, result["size_mb"])
