import asyncio
from unittest.mock import Mock

from app import bunkr_cache
from app.extractors import bunkr


def test_twelve_album_listings_fetch_all_files_without_detail_storm(monkeypatch):
    calls = []
    monkeypatch.setattr(bunkr_cache, 'album_get', lambda *args, **kwargs: None)
    monkeypatch.setattr(bunkr_cache, 'album_put', Mock())
    async def page(url, **kwargs):
        calls.append(url)
        assert '/a/' in url, 'listing must not fetch individual file pages'
        return ''.join(f'<div class="theItem" title="Clip {i}.mp4"><a href="/f/file-{i}">'
                       f'<img src="https://thumb.example/{i}.jpg"></a><span class="theSize">10 MB</span></div>'
                       for i in range(120))
    monkeypatch.setattr(bunkr, 'ntc_get', page)
    async def run():
        return await asyncio.gather(*(bunkr.BunkrExtractor().extract_album(
            f'https://bunkr.cr/a/album-{i}', listing_only=True) for i in range(12)))
    albums = asyncio.run(run())
    assert len(calls) == 12
    assert sum(len(items) for items in albums) == 1440
    assert all(item['title'].endswith('.mp4') for items in albums for item in items)
    assert bunkr_cache.album_put.call_count == 12
