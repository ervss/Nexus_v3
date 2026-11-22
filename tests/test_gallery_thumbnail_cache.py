from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app import main
from app.database import Video


def test_gallery_thumbnail_uses_new_url_after_file_replaced(tmp_path, monkeypatch):
    thumbs = tmp_path / 'static' / 'thumbnails'
    thumbs.mkdir(parents=True)
    image = thumbs / 'thumb_42.jpg'
    Image.new('RGB', (10, 10), 'red').save(image)
    monkeypatch.setattr(main, 'APP_DIR', str(tmp_path))
    video = Video(id=42, title='Test', thumbnail_path='/static/thumbnails/thumb_42.jpg')
    first = main._gallery_card_payload(video)['thumbnail_path']
    Image.new('RGB', (12, 10), 'blue').save(image)
    second = main._gallery_card_payload(video)['thumbnail_path']
    assert first.startswith('/static/thumbnails/thumb_42.jpg?v=')
    assert second != first
    assert main._gallery_card_payload(video)['thumbnail_path'] == second
    assert main._versioned_gallery_thumbnail('https://example.org/image.jpg') == 'https://example.org/image.jpg'
    assert main._versioned_gallery_thumbnail('/static/thumbnails/../private.jpg') == '/static/thumbnails/../private.jpg'


def test_mutable_thumbnail_cache_requires_revalidation(tmp_path):
    (tmp_path / 'thumbnails').mkdir()
    (tmp_path / 'thumbnails' / 'thumb_42.jpg').write_bytes(b'old')
    (tmp_path / 'asset.js').write_text('asset')
    (tmp_path / 'asset.png').write_bytes(b'png')
    app = FastAPI()
    app.mount('/static', main.CachedStaticFiles(directory=tmp_path))
    client = TestClient(app)
    thumb = client.get('/static/thumbnails/thumb_42.jpg')
    assert thumb.headers['cache-control'] == 'no-cache'
    assert client.get('/static/thumbnails/thumb_42.jpg', headers={'If-None-Match': thumb.headers['etag']}).headers['cache-control'] == 'no-cache'
    assert client.get('/static/asset.js').headers['cache-control'] == 'no-cache'
    assert client.get('/static/asset.png').headers['cache-control'] == 'public, max-age=86400'
