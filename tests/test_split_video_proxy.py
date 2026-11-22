import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from starlette.requests import Request
from app import main


def test_pornhub_segment_uses_verified_transport_and_preserves_range(monkeypatch):
    upstream = MagicMock()
    upstream.status_code = 206
    upstream.headers = {'Content-Type': 'video/MP2T', 'Content-Range': 'bytes 0-7/200', 'Content-Length': '8'}
    upstream.raw.read.side_effect = [b'ts-bytes', b'']
    get = MagicMock(return_value=upstream)
    monkeypatch.setattr(main.requests, 'get', get)
    async def run():
        response = await main._hls_proxy_stream_segment(
            'https://ev-h.phncdn.com/segment.ts?hash=a%2Fb',
            {'Range': 'bytes=0-7'}, {'session-cookie': 'test'})
        assert response.status_code == 206
        assert response.headers['content-range'] == 'bytes 0-7/200'
        assert b''.join([chunk async for chunk in response.body_iterator]) == b'ts-bytes'
    asyncio.run(run())
    assert get.call_args.args[0].endswith('hash=a%2Fb')
    assert get.call_args.kwargs['cookies'] == {'session-cookie': 'test'}
    assert get.call_args.kwargs['headers']['Range'] == 'bytes=0-7'
    upstream.close.assert_called_once()
    assert not main._is_pornhub_cdn('https://phncdn.com.evil.example/video.ts')

def test_mp4_proxy_preserves_range_and_normalizes_mime(monkeypatch):
    upstream = SimpleNamespace(status_code=206, headers={'content-type':'application/octet-stream', 'content-range':'bytes 0-7/200', 'content-length':'8'}, aclose=AsyncMock())
    async def chunks(size):
        yield b'mp4bytes'
    upstream.aiter_bytes=chunks
    client=MagicMock();client.send=AsyncMock(return_value=upstream);client.aclose=AsyncMock()
    monkeypatch.setattr(main.httpx,'AsyncClient',lambda **kwargs:client)
    monkeypatch.setattr(main,'_require_public_proxy_url',lambda url:url)
    request=Request({'type':'http','headers':[(b'range',b'bytes=0-7')], 'scheme':'http','server':('localhost',8000),'path':'/'})
    async def run():
        result=await main.video_stream_proxy('https://cdn.example/file.mp4?token=x',request,'https://bunkr.cr/f/test')
        assert result.status_code == 206
        assert result.headers['content-type'] == 'video/mp4'
        assert result.headers['content-encoding'] == 'identity'
        assert result.headers['content-range'] == 'bytes 0-7/200'
        assert result.headers['content-length'] == '8'
        assert b''.join([b async for b in result.body_iterator]) == b'mp4bytes'
    asyncio.run(run())
    assert client.build_request.call_args.kwargs['headers']['Accept-Encoding'] == 'identity'
    assert client.build_request.call_args.kwargs['headers']['Range'] == 'bytes=0-7'

def test_bunkr_proxy_short_timeout_and_visible_range_headers(monkeypatch):
    upstream = SimpleNamespace(status_code=206, headers={'content-type':'video/mp4', 'content-range':'bytes 0-7/200'}, aclose=AsyncMock())
    async def chunks(size):
        yield b'mp4bytes'
    upstream.aiter_bytes = chunks
    client = MagicMock(); client.send = AsyncMock(return_value=upstream); client.aclose = AsyncMock()
    settings = []
    def factory(**kwargs):
        settings.append(kwargs)
        return client
    monkeypatch.setattr(main.httpx, 'AsyncClient', factory)
    monkeypatch.setattr(main, '_require_public_proxy_url', lambda url: url)
    request = Request({'type':'http','headers':[(b'range',b'bytes=0-7')], 'scheme':'http','server':('localhost',8000),'path':'/'})
    async def run():
        result = await main.video_stream_proxy('https://cdn.example/file.mp4?token=new', request, 'https://bunkr.cr/f/test', upstream_timeout=2)
        assert 'Content-Range' in result.headers['access-control-expose-headers']
        assert b''.join([b async for b in result.body_iterator]) == b'mp4bytes'
    asyncio.run(run())
    assert settings[0]['timeout'].read == 2
    assert settings[0]['timeout'].connect == 2
    assert client.build_request.call_args.kwargs['headers']['Referer'] == 'https://bunkr.cr/f/test'
