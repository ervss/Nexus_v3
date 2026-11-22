import asyncio
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image, ImageFilter
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import maintenance as m
from app.database import Video


def detailed_image():
    # Fixed texture: independent of JPEG compression or random noise seeds.
    image = Image.new('RGB', (640, 360))
    image.putdata([((x * 3 + y) % 256, (y * 2) % 256, (x + y * 3) % 256)
                   for y in range(360) for x in range(640)])
    return image


def test_scores_pixels_and_rejects_blank_or_corrupt_images(tmp_path):
    image = detailed_image()
    sharp, blur = tmp_path / 'sharp.jpg', tmp_path / 'blur.jpg'
    image.save(sharp)
    image.filter(ImageFilter.GaussianBlur(12)).save(blur)
    assert m._image_score(str(sharp)) > m._image_score(str(blur)) > 0
    for color in ('black', 'white', '#777777'):
        path = tmp_path / f'{color.replace("#", "")}.jpg'
        Image.new('RGB', (640, 360), color).save(path)
        assert m._image_score(str(path)) == 0
    bad = tmp_path / 'bad.jpg'
    bad.write_bytes(b'not an image' * 2000)
    assert m._image_score(str(bad)) == 0


def test_compression_and_portrait_are_not_mislabelled_as_poor(tmp_path, monkeypatch):
    path = tmp_path / 'portrait.jpg'
    detailed_image().resize((270, 480)).save(path, quality=15)
    assert path.stat().st_size < 10_000
    monkeypatch.setattr(m, '_video_path_from_static', lambda _: str(path))
    assert m.thumbnail_quality(Video(thumbnail_path='/static/test.jpg'))['status'] == 'ok'


def test_status_does_not_scan_library_images(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('polling must never scan the library')
    monkeypatch.setattr(m, '_smart_thumb_candidates', forbidden)
    db = SimpleNamespace(query=lambda *args: SimpleNamespace(
        filter=lambda *args: SimpleNamespace(scalar=lambda: 5)))
    assert m.smart_rethumb_status(db)['done'] == 5


def test_automatic_selection_excludes_completed_and_html_pages(tmp_path, monkeypatch):
    engine = create_engine('sqlite://')
    Video.__table__.create(engine)
    monkeypatch.setattr(m, '_is_poor_thumbnail', lambda _: True)
    with Session(engine) as db:
        from datetime import datetime
        db.add_all([
            Video(id=1, status='ready', url='https://example.test/1.mp4'),
            Video(id=2, status='ready', url='https://example.test/2.mp4', smart_rethumb_at=datetime.utcnow()),
            Video(id=3, status='ready', url='https://example.test/embed/abc'),
        ])
        db.commit()
        assert [v.id for v in m._smart_thumb_candidates(db)] == [1]


def test_manual_selection_retries_failed_only_once(monkeypatch):
    engine = create_engine('sqlite://')
    Video.__table__.create(engine)
    monkeypatch.setattr(m, '_is_poor_thumbnail', lambda _: True)
    with Session(engine) as db:
        db.add_all([
            Video(id=1, status='ready', url='https://example.test/1.mp4', smart_rethumb_error='403'),
            Video(id=2, status='ready', url='https://example.test/2.mp4'),
        ])
        db.commit()
        assert [v.id for v in m._smart_thumb_candidates(db)] == [2]
        assert [v.id for v in m._smart_thumb_candidates(db, retry_failed=True)] == [2, 1]
        assert [v.id for v in m._smart_thumb_candidates(db, retry_failed=True, exclude_ids={1, 2})] == []


def test_mega_smart_rethumb_uses_decrypted_stream_and_keeps_reference(tmp_path, monkeypatch):
    from app.config import config
    video = Video(id=987, status='ready', storage_type='remote',
                  url='mega:n:folder:handle:key', duration=100)
    seen = []
    async def run(cmd, timeout):
        seen.append(cmd[cmd.index('-i') + 1])
        detailed_image().save(cmd[-1])
        return True, ''
    monkeypatch.setattr(m, '_run_thumb_process', run)
    assert asyncio.run(m._generate_thumb_from_stream(video, str(tmp_path), seek_frac=0.4))
    assert seen and all(url == f'http://127.0.0.1:{config.SERVER_PORT}/api/v1/mega/stream/987' for url in seen)
    assert video.url == 'mega:n:folder:handle:key'
    assert (tmp_path / 'thumb_987.jpg').exists()


def test_mega_targets_include_card_batch_and_library(monkeypatch):
    from fastapi import BackgroundTasks
    from app.routers import maintenance_endpoints as endpoints
    engine = create_engine('sqlite://')
    Video.__table__.create(engine)
    monkeypatch.setattr(m, '_is_poor_thumbnail', lambda _: True)
    monkeypatch.setattr(m, '_SMART_THUMB_RUNNING', False)
    monkeypatch.setattr(m, '_SMART_THUMB_PENDING', False)
    with Session(engine) as db:
        db.add(Video(id=987, status='ready', storage_type='remote', url='mega:n:folder:handle:key', batch_name='MEGA test'))
        db.commit()
        assert [v.id for v in m._smart_thumb_candidates(db)] == [987]
        assert [v.id for v in m._resolve_rethumb_targets(db, batch_name='MEGA test')] == [987]
        result = asyncio.run(endpoints.smart_rethumb_card_route(987, BackgroundTasks(), db))
        assert result['queued']
        m.release_smart_rethumb_reservation()
        m._THUMB_FAIL_DETAIL[987] = 'MEGA stream failed'
        assert 'Lokálny súbor' not in m._classify_rethumb_failure(db.get(Video, 987))['reason']
        m._THUMB_FAIL_DETAIL.pop(987, None)


def test_serial_cdn_compares_frames_and_preserves_better_existing_preview(tmp_path, monkeypatch):
    video = Video(id=8877, url='https://a.cdn.cr/clip.mp4', source_url='https://bunkr.cr/f/file', duration=100)
    output = tmp_path / 'thumb_8877.jpg'
    seen = []
    async def fresh(_):
        return 'https://a.cdn.cr/fresh.mp4', 'https://bunkr.cr/'
    async def run(cmd, timeout):
        seek = float(cmd[cmd.index('-ss') + 1])
        seen.append(seek)
        image = detailed_image()
        if seek == 25:
            image = image.filter(ImageFilter.GaussianBlur(12))
        image.save(cmd[-1])
        return True, ''
    monkeypatch.setattr(m, '_fresh_stream_for_thumb', fresh)
    monkeypatch.setattr(m, '_run_thumb_process', run)
    assert asyncio.run(m._generate_thumb_from_stream(video, str(tmp_path)))
    assert seen == [25, 50]
    expected_score = m._image_score(str(output))
    assert expected_score > 0
    original = output.read_bytes()
    video.thumbnail_path = '/static/thumbnails/thumb_8877.jpg'
    monkeypatch.setattr(m, '_video_path_from_static', lambda _: str(output))
    async def worse(cmd, timeout):
        detailed_image().filter(ImageFilter.GaussianBlur(12)).save(cmd[-1])
        return True, ''
    monkeypatch.setattr(m, '_run_thumb_process', worse)
    assert not asyncio.run(m._generate_thumb_from_stream(video, str(tmp_path)))
    assert video.id in m._THUMB_KEEP_EXISTING
    assert output.read_bytes() == original
    m._THUMB_KEEP_EXISTING.discard(video.id)


def test_valid_signature_avoids_resolution_but_revoked_signature_is_refreshed(tmp_path, monkeypatch):
    video = Video(id=8878, duration=100, url=f'https://a.cdn.cr/clip.mp4?token=x&ex={int(time.time()) + 3600}')
    seen = []
    async def fresh(_):
        seen.append('resolved')
        return 'https://a.cdn.cr/renewed.mp4', 'https://bunkr.cr/'
    async def run(cmd, timeout):
        url = cmd[cmd.index('-i') + 1]
        if 'token=x' in url:
            return False, 'HTTP 403 forbidden'
        detailed_image().save(cmd[-1])
        return True, ''
    monkeypatch.setattr(m, '_fresh_stream_for_thumb', fresh)
    monkeypatch.setattr(m, '_run_thumb_process', run)
    assert asyncio.run(m._generate_thumb_from_stream(video, str(tmp_path)))
    assert seen == ['resolved']
    assert video.url.endswith('renewed.mp4')


def test_cancellation_kills_and_reaps_child_process(monkeypatch):
    children = []
    real_popen = subprocess.Popen
    def popen(*args, **kwargs):
        process = real_popen(*args, **kwargs)
        children.append(process)
        return process
    monkeypatch.setattr(subprocess, 'Popen', popen)
    async def cancel():
        task = asyncio.create_task(m._run_thumb_process([sys.executable, '-c', 'import time; time.sleep(30)'], 40))
        await asyncio.sleep(.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(cancel())
    assert len(children) == 1
    assert children[0].poll() is not None


def test_corrupt_poster_response_never_overwrites_existing_thumbnail(tmp_path, monkeypatch):
    output = tmp_path / 'existing.jpg'
    detailed_image().save(output)
    original = output.read_bytes()
    class Client:
        def __init__(self, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def get(self, *args, **kwargs):
            return SimpleNamespace(status_code=200, content=b'HTML error page' * 1000)
    monkeypatch.setattr(m.httpx, 'AsyncClient', Client)
    assert not asyncio.run(m._download_poster_to_thumb('https://example.test/poster', str(output)))
    assert output.read_bytes() == original


def test_single_card_returns_immediately_and_reserves_before_background_work(monkeypatch):
    from fastapi import BackgroundTasks
    from app.routers import maintenance_endpoints as endpoints
    video = Video(id=87, url='https://cdn.example.test/video.mp4')
    db = SimpleNamespace(get=lambda *args: video)
    monkeypatch.setattr(m, '_SMART_THUMB_RUNNING', False)
    monkeypatch.setattr(m, '_SMART_THUMB_PENDING', False)
    tasks = BackgroundTasks()
    result = asyncio.run(endpoints.smart_rethumb_card_route(87, tasks, db))
    assert result['ok'] and result['queued']
    assert len(tasks.tasks) == 1
    assert m._SMART_THUMB_PENDING
    duplicate = asyncio.run(endpoints.smart_rethumb_card_route(87, BackgroundTasks(), db))
    assert not duplicate['ok']
    m.release_smart_rethumb_reservation()


def test_gofile_rethumb_resolves_folder_and_injects_auth_headers(monkeypatch):
    from app.extractors.gofile import GoFileExtractor

    monkeypatch.setattr(GoFileExtractor, '_cached_token', 'gf_test_token_123')
    monkeypatch.setattr(
        GoFileExtractor,
        'extract_album_entries',
        classmethod(lambda cls, url: asyncio.sleep(0, result=[
            {
                'id': '11111111-1111-1111-1111-111111111111',
                'title': 'First.mp4',
                'stream_url': 'https://cold1.gofile.io/download/web/11111111-1111-1111-1111-111111111111/First.mp4',
            },
            {
                'id': '58f9aef0-e7ed-48bf-834c-55c220f43503',
                'title': 'Target.mp4',
                'stream_url': 'https://cold-eu-par-4.gofile.io/download/web/58f9aef0-e7ed-48bf-834c-55c220f43503/Target.mp4',
                'duration': 185,
            },
        ])),
    )

    video = Video(
        id=4696,
        title='yExdGt - Gofile',
        url='https://cold-eu-par-4.gofile.io/download/web/58f9aef0-e7ed-48bf-834c-55c220f43503/Target.mp4',
        source_url='https://gofile.io/d/yExdGt',
    )
    stream_url, referer = asyncio.run(m._fresh_stream_for_thumb(video))
    assert stream_url == 'https://cold-eu-par-4.gofile.io/download/web/58f9aef0-e7ed-48bf-834c-55c220f43503/Target.mp4'
    assert referer == 'https://gofile.io/d/yExdGt'
    assert video.duration == 185.0

    hdrs = m._thumb_request_headers(stream_url, referer)
    assert hdrs.get('Authorization') == 'Bearer gf_test_token_123'
    assert hdrs.get('Cookie') == 'accountToken=gf_test_token_123'
    assert hdrs.get('X-Website-Token')
    assert hdrs.get('User-Agent') == GoFileExtractor._user_agent

