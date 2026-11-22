"""Exercise the production proxy without importing the full dashboard app."""
import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest
import urllib.parse


class QualityHuntProxyTests(unittest.TestCase):
    def test_all_playlist_resources_keep_source_context(self):
        playlist = '\n'.join([
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=AUDIO,URI="https://audio.phncdn.com/audio.m3u8"',
            '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
            '#EXT-X-MAP:URI="init.mp4"',
            'https://other.phncdn.com/segment.ts?token=a+b',
        ])
        calls = []

        class Upstream:
            status = 200
            headers = {'Content-Type': 'application/vnd.apple.mpegurl'}
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def read(self): return playlist.encode()

        def get(url, **kwargs):
            calls.append(kwargs['headers'])
            return Upstream()

        tree = ast.parse((Path(__file__).parents[1] / 'app/main.py').read_text(encoding='utf-8-sig'))
        function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'hls_proxy')
        function.decorator_list = []
        namespace = {
            'Request': object, 'Optional': __import__('typing').Optional,
            'HTTPException': Exception,
            'asyncio': asyncio,
            'logging': __import__('logging'),
            '_require_public_proxy_url': lambda url: url,
            '_is_lulu_cdn_url': lambda url: False,
            '_lulu_cdn_headers': lambda extra=None: extra or {},
            '_is_pornhub_cdn': lambda url: False,
            'urllib': urllib, '_embed_proxy_sessions': {},
            'http_session': SimpleNamespace(get=get),
            'aiohttp': SimpleNamespace(ClientTimeout=lambda **kwargs: None),
            'Response': lambda **kwargs: kwargs,
        }
        # The function imports re at module scope in production.
        namespace['re'] = __import__('re')
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'hls_proxy', 'exec'), namespace)
        result = asyncio.run(namespace['hls_proxy'](
            request=SimpleNamespace(headers={}, query_params={}),
            url='https://video.phncdn.com/path/master.m3u8',
            referer='https://www.pornhub.com/',
        ))
        body = result['content']
        self.assertEqual(body.count('/hls_proxy?url='), 4)
        self.assertEqual(body.count('referer=https%3A%2F%2Fwww.pornhub.com%2F'), 4)
        self.assertIn('token%3Da%2Bb', body)
        self.assertEqual(calls[0]['Referer'], 'https://www.pornhub.com/')
        self.assertEqual(calls[0]['Origin'], 'https://www.pornhub.com')


if __name__ == '__main__':
    unittest.main()
