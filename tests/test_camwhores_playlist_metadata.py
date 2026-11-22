import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest

from app.camwhores_discovery import _CW_DETAIL_CACHE, async_extract_detail_metadata


def _page(player: str, duration: str = "1:04:00") -> str:
    return (
        '<html><head><meta property="og:title" content="Test clip" /></head>'
        '<body><input name="video_id" value="123" />'
        f'<span>Duration: <em>{duration}</em></span>'
        f'<div class="player-holder">{player}</div>'
        + ('<p>video information</p>' * 70)
        + '</body></html>'
    )


def test_external_embed_keeps_duration_without_inventing_size_or_quality(monkeypatch):
    async def fake_ntc(*args, **kwargs):
        return _page('<iframe src="https://www.camvideos.org/embed/50930"></iframe>')

    def external_unavailable(request):
        assert str(request.url) == 'https://www.camvideos.org/videos/50930/dummystring/'
        return httpx.Response(403)

    monkeypatch.setattr('app.extractors.base.ntc_get', fake_ntc)
    _CW_DETAIL_CACHE.clear()
    url = 'https://www.camwhores.tv/videos/123/test/'

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(external_unavailable)) as client:
            return await async_extract_detail_metadata(url, client, {'url': url, 'duration': 0})

    result = asyncio.run(run())
    assert result['duration'] == 3840
    assert result['enriched'] is True
    assert result['size_status'] == 'unavailable'
    assert result['size_bytes'] == 0
    assert result['resolution'] == 0
    assert result['stream_url'] == ''


@pytest.mark.parametrize('width,height,quality', [
    (800, 600, '600p'),
    (720, 1280, '720p'),
])
def test_external_camvideos_page_provides_exact_size(monkeypatch, width, height, quality):
    stream_url = 'https://www.camvideos.org/get_file/12/token/50000/50930/50930.mp4/'

    async def fake_ntc(*args, **kwargs):
        return _page('<iframe src="https://www.camvideos.org/embed/50930"></iframe>')

    def respond(request):
        if '/videos/50930/' in str(request.url):
            assert request.headers['referer'] == watch_url
            return httpx.Response(
                200,
                text=_page(f'<script>var flashvars = {{video_url: "{stream_url}"}};</script>'),
                request=request,
            )
        assert str(request.url).split('?')[0] == stream_url
        assert request.url.params.get('rnd', '').isdigit()
        assert request.headers['range'] == 'bytes=0-0'
        assert '/videos/50930/' in request.headers['referer']
        return httpx.Response(206, headers={'Content-Range': 'bytes 0-0/664416961'})

    monkeypatch.setattr('app.extractors.base.ntc_get', fake_ntc)
    dimension_probe = AsyncMock(return_value={
        'duration': 3840, 'size': 664416961, 'width': width, 'height': height,
    })
    monkeypatch.setattr('app.camwhores_discovery.probe_mp4_cached', dimension_probe)
    _CW_DETAIL_CACHE.clear()
    watch_url = 'https://www.camwhores.tv/videos/123/test/'

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await async_extract_detail_metadata(watch_url, client)

    result = asyncio.run(run())
    assert result['duration'] == 3840
    assert result['size_status'] == 'exact'
    assert result['size_bytes'] == 664416961
    assert result['stream_url'].split('?')[0] == stream_url
    assert result['resolution'] == height
    assert result['width'] == width
    assert result['quality'] == quality
    assert dimension_probe.await_args.kwargs['headers']['Referer'].endswith('/videos/50930/dummystring/')


def test_direct_file_uses_content_range_for_exact_size(monkeypatch):
    stream_url = 'https://www.camwhores.tv/get_file/123/720p.mp4'

    async def fake_ntc(*args, **kwargs):
        return _page(f'<script>var flashvars = {{video_url_hd: "{stream_url}"}};</script>', '12:34')

    def respond(request):
        assert request.headers['range'] == 'bytes=0-0'
        return httpx.Response(206, headers={'Content-Range': 'bytes 0-0/104857600'})

    monkeypatch.setattr('app.extractors.base.ntc_get', fake_ntc)
    _CW_DETAIL_CACHE.clear()
    url = 'https://www.camwhores.tv/videos/124/test/'

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await async_extract_detail_metadata(url, client)

    result = asyncio.run(run())
    assert result['duration'] == 754
    assert result['size_status'] == 'exact'
    assert result['size_bytes'] == 104857600
    assert result['size_human'] == '100.0 MB'
    assert result['quality'] == '720p'


def test_network_failure_preserves_unverified_card(monkeypatch):
    async def failing_ntc(*args, **kwargs):
        raise TimeoutError('deadline')

    monkeypatch.setattr('app.extractors.base.ntc_get', failing_ntc)
    _CW_DETAIL_CACHE.clear()
    url = 'https://www.camwhores.tv/videos/125/test/'
    card = {'url': url, 'title': 'From playlist', 'duration': 0}

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200))) as client:
            return await async_extract_detail_metadata(url, client, card)

    result = asyncio.run(run())
    assert result == {**card, 'enriched': False}


def test_shared_watch_session_reuses_successful_metadata(monkeypatch):
    async def unexpected_ntc(*args, **kwargs):
        raise AssertionError('NTC should not run after a successful shared fetch')

    class WatchClient:
        calls = 0

        async def get(self, *args, **kwargs):
            self.calls += 1
            assert 'Cookie' not in kwargs['headers']
            stream_url = 'https://www.camwhores.tv/get_file/123/720p.mp4'
            return httpx.Response(200, text=_page(f'<script>var flashvars = {{video_url_hd: "{stream_url}"}};</script>'))

    monkeypatch.setattr('app.extractors.base.ntc_get', unexpected_ntc)
    _CW_DETAIL_CACHE.clear()
    url = 'https://www.camwhores.tv/videos/126/test/'
    watch = WatchClient()

    async def run():
        transport = httpx.MockTransport(lambda request: httpx.Response(
            206, headers={'Content-Range': 'bytes 0-0/104857600', 'Content-Type': 'video/mp4'}
        ))
        async with httpx.AsyncClient(transport=transport) as client:
            first = await async_extract_detail_metadata(url, client, watch_client=watch)
            second = await async_extract_detail_metadata(url, client, watch_client=watch)
            return first, second

    first, second = asyncio.run(run())
    assert first['duration'] == 3840
    assert second['duration'] == 3840
    assert watch.calls == 1


def test_bitrate_calculation_and_multi_playlist_pagination(monkeypatch):
    from app.camwhores_discovery import fetch_multiple_playlists

    stream_url = 'https://www.camwhores.tv/get_file/123/1080p.mp4'

    async def fake_ntc(*args, **kwargs):
        # 1 hour duration
        return _page(f'<script>var flashvars = {{video_url_hd: "{stream_url}"}};</script>', '1:00:00')

    monkeypatch.setattr('app.extractors.base.ntc_get', fake_ntc)
    _CW_DETAIL_CACHE.clear()
    url = 'https://www.camwhores.tv/videos/999/test/'

    async def run():
        # 450 MB file size
        file_size = 450 * 1024 * 1024
        transport = httpx.MockTransport(lambda request: httpx.Response(
            206, headers={'Content-Range': f'bytes 0-0/{file_size}', 'Content-Type': 'video/mp4'}
        ))
        async with httpx.AsyncClient(transport=transport) as client:
            return await async_extract_detail_metadata(url, client)

    result = asyncio.run(run())
    assert result['size_bytes'] == 450 * 1024 * 1024
    assert result['duration'] == 3600
    # Bitrate = (450 * 1024 * 1024 * 8) / (3600 * 1000) ~= 1048 kbps -> 1.0 Mbps
    assert result['bitrate_kbps'] > 1000
    assert 'Mbps' in result['bitrate_human']

    # Test multi-playlist pagination signature and result structure
    def fake_fetch_pl(pl_url, only_public, batch_size, batch_offset):
        return {
            'playlist_url': pl_url,
            'playlist_title': 'PL',
            'public_count': 10,
            'private_count': 0,
            'has_more': batch_offset < 10,
            'videos': [{'url': f'{pl_url}/v/{i}', 'is_public': True} for i in range(batch_size)],
        }

    monkeypatch.setattr('app.camwhores_discovery.fetch_playlist_videos', fake_fetch_pl)
    multi_res = fetch_multiple_playlists(['https://cw.tv/pl1', 'https://cw.tv/pl2'], batch_size=5, batch_offset=0)
    assert multi_res['has_more'] is True
    assert multi_res['batch_offset'] == 0
    assert len(multi_res['videos']) == 10

