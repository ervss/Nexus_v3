import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from app import nexus_intel
from app import proxy_sessions
from app.extractors import ExtractorRegistry
from app.extractors.fpo import FpoExtractor
from app.extractors.pornone import PornOneExtractor
from app.extractors.media_router import MediaResult


class QualityResolveTests(unittest.IsolatedAsyncioTestCase):
    async def test_pornhub_resolve_keeps_proxy_session_and_alternate_quality(self):
        page = 'https://www.pornhub.com/view_video.php?viewkey=test'
        primary = 'https://ev-h.phncdn.com/master.m3u8'
        fallback = 'https://ev-h.phncdn.com/video_480.mp4'
        extracted = {'stream_url': primary, 'stream_candidates': [{'url': primary}, {'url': fallback}],
                     'proxy_cookies': {'age_verified': '1'}, 'height': 720}
        with patch('app.extractors.pornhub.PornhubExtractor.extract', new_callable=AsyncMock, return_value=extracted), \
             patch.object(nexus_intel, '_select_pornhub_proxy_stream', new_callable=AsyncMock, return_value=fallback):
            data = await nexus_intel._do_resolve(page)
        try:
            self.assertEqual(data['stream_url'], fallback)
            self.assertFalse(data['is_hls'])
            self.assertEqual(data['fallback_urls'], [primary])
            self.assertEqual(proxy_sessions.SESSIONS[data['proxy_session']]['cookies']['age_verified'], '1')
            self.assertEqual(proxy_sessions.SESSIONS[data['proxy_session']]['referer'], page)
        finally:
            proxy_sessions.SESSIONS.pop(data['proxy_session'], None)

    async def test_refresh_discards_an_expired_signed_stream_in_cache(self):
        url='https://site.example/signed-stream-refresh-test'
        nexus_intel._resolve_put(url, {'stream_url':'https://cdn.example/expired.mp4'})
        try:
            with patch.object(nexus_intel,'_do_resolve',AsyncMock(return_value={'stream_url':'https://cdn.example/fresh.mp4'})) as resolve:
                self.assertEqual((await nexus_intel.resolve_cached(url))['stream_url'],'https://cdn.example/expired.mp4')
                resolve.assert_not_awaited()
                self.assertEqual((await nexus_intel.resolve_cached(url,refresh=True))['stream_url'],'https://cdn.example/fresh.mp4')
                resolve.assert_awaited_once()
        finally:
            nexus_intel._resolve_cache.pop(url,None)

    def test_pornone_registered(self):
        self.assertIsInstance(ExtractorRegistry.find_extractor('https://pornone.com/video/123/'), PornOneExtractor)

    async def test_unknown_google_destination_uses_generic_router(self):
        result = MediaResult(stream_url='https://cdn.example/master.m3u8', is_hls=True)
        with patch.object(ExtractorRegistry, 'find_extractor', return_value=None), patch(
            'app.extractors.media_router.default_router.extract', return_value=result
        ) as fallback:
            data = await nexus_intel._do_resolve('https://unknown.example/watch/123')
        fallback.assert_called_once_with('https://unknown.example/watch/123')
        self.assertTrue(data['is_hls'])

    async def test_failed_site_extractor_also_uses_fallback(self):
        site = SimpleNamespace(extract=AsyncMock(side_effect=ValueError('bad page')))
        result = MediaResult(stream_url='https://cdn.example/video.mp4')
        with patch.object(ExtractorRegistry, 'find_extractor', return_value=site), patch(
            'app.extractors.media_router.default_router.extract', return_value=result
        ):
            self.assertEqual((await nexus_intel._do_resolve('https://site.example/video/123'))['stream_url'], result.stream_url)

    async def test_pornone_relative_source_is_normalized(self):
        extractor = PornOneExtractor()
        response = SimpleNamespace(text='<h1>Clip</h1><video><source src="//cdn.example/movie.mp4"></video>', url='https://pornone.com/video/1/', raise_for_status=lambda: None)
        extractor.session.get = Mock(return_value=response)
        data = await extractor.extract(response.url)
        self.assertEqual(data['stream_url'], 'https://cdn.example/movie.mp4')

    async def test_fpo_decodes_kvs_instead_of_returning_function_url(self):
        html = "video_alt_url: 'function/0/https://cdn.example/get_file/1/0123456789abcdef0123456789abcdef/video_1080p.mp4/', license_code: '1234567890123456'"
        response = SimpleNamespace(status_code=200, text=html)
        with patch('app.extractors.fpo.cffi_req', SimpleNamespace(get=Mock(return_value=response))):
            data = await FpoExtractor().extract('https://www.fpo.xxx/video/123/')
        self.assertTrue(data['stream_url'].startswith('https://cdn.example/get_file/'))
        self.assertNotIn('/0123456789abcdef0123456789abcdef/', data['stream_url'])
        self.assertEqual(data['height'], 1080)

    async def test_fpo_keeps_other_renditions_for_playback_fallback(self):
        html = "video_alt_url: 'https://cdn.test/main_1080p.mp4', video_url: 'https://cdn.test/low_480p.mp4'"
        with patch('app.extractors.fpo.cffi_req', SimpleNamespace(get=Mock(return_value=SimpleNamespace(status_code=200, text=html)))), \
             patch('app.extractors.pimpbunny.PimpBunnyExtractor._stream_candidates', return_value=[
                 {'url':'https://cdn.test/main_1080p.mp4','height':1080},
                 {'url':'https://cdn.test/low_480p.mp4','height':480}]):
            result=await FpoExtractor().extract('https://www.fpo.xxx/video/123/')
        self.assertEqual(result['fallback_urls'],['https://cdn.test/low_480p.mp4'])


if __name__ == '__main__':
    unittest.main()
