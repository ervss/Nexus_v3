import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
import pytest
import httpx
from starlette.requests import Request
from fastapi import HTTPException
from app import main
from app.stream_cache import StreamLruCache

def request(value=None):
    return Request({'type':'http','headers':[(b'range',value.encode())] if value else [],'query_string':b'', 'scheme':'http','server':('localhost',8000),'path':'/'})

@pytest.mark.parametrize('range_value',[None,'bytes=0-','bytes=-50','bytes=0-99999999'])
def test_large_and_open_ranges_use_streaming(monkeypatch,range_value):
    monkeypatch.setattr(main,'_require_public_proxy_url',lambda url:url)
    proxy=AsyncMock(return_value='streamed');monkeypatch.setattr(main,'video_stream_proxy',proxy)
    assert asyncio.run(main.stream_cached_chunk('https://cdn.example/a.mp4',request(range_value)))=='streamed'
    proxy.assert_awaited_once()

def test_cache_key_does_not_mix_query_resources(tmp_path):
    cache=StreamLruCache(tmp_path)
    assert cache.get_chunk_path('https://cdn.example/file?id=1',0,7)!=cache.get_chunk_path('https://cdn.example/file?id=2',0,7)

def test_proxy_closes_client_when_connect_times_out(monkeypatch):
    monkeypatch.setattr(main,'_require_public_proxy_url',lambda url:url)
    client=MagicMock();client.send=AsyncMock(side_effect=httpx.ConnectTimeout('connect'));client.aclose=AsyncMock()
    monkeypatch.setattr(main.httpx,'AsyncClient',lambda **kwargs:client)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.video_stream_proxy('https://cdn.example/a.mp4',request()))
    assert exc.value.status_code==502
    client.aclose.assert_awaited_once()

@pytest.mark.parametrize('status,headers,chunks',[(200,{},[b'not range']), (206,{'content-range':'bytes 0-7/100'},[b'too long data']), (206,{'content-range':'bytes 0-7/100'},[b'short']), (503,{},[])])
def test_cache_rejects_ignored_range_truncation_overflow_and_503(monkeypatch,tmp_path,status,headers,chunks):
    import app.stream_cache as module
    monkeypatch.setattr(module,'stream_cache',StreamLruCache(tmp_path))
    monkeypatch.setattr(main,'_require_public_proxy_url',lambda url:url)
    async def iterator(size):
        for chunk in chunks: yield chunk
    response=SimpleNamespace(status_code=status,headers=headers,aiter_bytes=iterator,aclose=AsyncMock())
    client=MagicMock();client.send=AsyncMock(return_value=response);client.aclose=AsyncMock()
    monkeypatch.setattr(main.httpx,'AsyncClient',lambda **kwargs:client)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.stream_cached_chunk('https://cdn.example/a.mp4',request('bytes=0-7')))
    assert exc.value.status_code==(503 if status==503 else 502)
    assert not list(tmp_path.glob('*.part'))
    response.aclose.assert_awaited_once();client.aclose.assert_awaited_once()


@pytest.mark.parametrize('requested_end',[7,15])
def test_valid_range_is_cached_and_served_without_second_fetch(monkeypatch,tmp_path,requested_end):
    import app.stream_cache as module
    monkeypatch.setattr(module,'stream_cache',StreamLruCache(tmp_path))
    monkeypatch.setattr(main,'_require_public_proxy_url',lambda url:url)
    async def chunks(size): yield b'12345678'
    response=SimpleNamespace(status_code=206,headers={'content-range':'bytes 0-7/8','content-length':'8'},aiter_bytes=chunks,aclose=AsyncMock())
    client=MagicMock();client.send=AsyncMock(return_value=response);client.aclose=AsyncMock()
    monkeypatch.setattr(main.httpx,'AsyncClient',lambda **kwargs:client)
    async def run():
        first=await main.stream_cached_chunk('https://cdn.example/a.mp4',request(f'bytes=0-{requested_end}'))
        second=await main.stream_cached_chunk('https://cdn.example/a.mp4',request('bytes=0-7'))
        assert first.body==second.body==b'12345678'
        assert first.headers['x-cache-lookup']=='MISS'
        assert second.headers['x-cache-lookup']=='HIT'
    asyncio.run(run())
    client.send.assert_awaited_once()
