import asyncio
from io import BytesIO
from types import SimpleNamespace

from PIL import Image

from app import bunkr_cache, maintenance as m
from app.database import Video


def test_bunkr_cached_sprite_is_used_before_stream_resolution(monkeypatch, tmp_path):
    video = Video(id=123, url='https://a.cdn.cr/video.mp4', source_url='https://bunkr.cr/f/abc')
    image = Image.new('RGB', (2400, 1440), 'black')
    for y in range(360, 720):
        for x in range(600, 1200):
            image.putpixel((x, y), ((x * 7) % 256, (y * 3) % 256, (x + y) % 256))
    data = BytesIO()
    image.save(data, 'PNG')
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def get(self, url, **kwargs):
            assert url == 'https://static.example/sprite.png'
            return SimpleNamespace(status_code=200, content=data.getvalue())
    async def forbidden(*args):
        raise AssertionError('video stream must not be opened')
    monkeypatch.setattr(bunkr_cache, 'file_meta_get', lambda _: {'storyboard_url': 'https://static.example/sprite.png', 'storyboard_kind': 'sprite'})
    monkeypatch.setattr(m.httpx, 'AsyncClient', Client)
    monkeypatch.setattr(m, '_fresh_stream_for_thumb', forbidden)
    assert asyncio.run(m._generate_thumb_from_stream(video, str(tmp_path)))
    with Image.open(tmp_path / 'thumb_123.jpg') as result:
        assert result.size == (600, 360)
        assert m._image_score(str(tmp_path / 'thumb_123.jpg')) > 0


def test_stop_preserves_completed_work_and_cancels_waiting_jobs(monkeypatch):
    class Store:
        def __init__(self): self.states = {}
        def enqueue(self, ids): self.states.update({i: 'pending' for i in ids})
        def mark(self, video_id, state, error=None): self.states[video_id] = state
    store = Store()
    monkeypatch.setattr(m.fast_thumb, 'get_store', lambda: store)
    monkeypatch.setattr(m, '_start_prefetch', lambda *args: None)
    monkeypatch.setattr(m, '_SMART_THUMB_RUNNING', False)
    monkeypatch.setattr(m, '_SMART_THUMB_PENDING', False)
    monkeypatch.setattr(m, '_SMART_THUMB_AUTO_PAUSED', False)
    m._SMART_THUMB_STOP.clear()
    class Db:
        def query(self, *args): return self
        def get(self, key): return None
        def close(self): pass
    monkeypatch.setattr('app.database.SessionLocal', Db)
    async def run():
        started = asyncio.Event()
        finish = asyncio.Event()
        calls = []
        async def generate(video, *args, **kwargs):
            calls.append(video.id)
            started.set()
            await finish.wait()
            return False
        monkeypatch.setattr(m, '_generate_thumb_from_stream', generate)
        videos = [Video(id=i, url='https://example.com/a.mp4') for i in (1, 2, 3)]
        task = asyncio.create_task(m.smart_rethumb_videos(videos, concurrency=1))
        await started.wait()
        assert m.stop_smart_rethumb()
        result = await asyncio.wait_for(task, timeout=2)
        assert len(calls) == 1
        assert result['failed'] == 0
        assert sorted(store.states.values()) == ['cancelled', 'cancelled', 'cancelled']
        assert m._SMART_THUMB_PROGRESS['cancelled']
        assert not m._SMART_THUMB_PROGRESS['queued']
        assert (await m.auto_smart_rethumb_tick())['status'] == 'paused'
    try:
        asyncio.run(run())
    finally:
        m._SMART_THUMB_STOP.clear()


def test_small_bunkr_cover_falls_back_to_full_video_frame(monkeypatch, tmp_path):
    video = Video(id=124, url='https://a.cdn.cr/video.mp4', source_url='https://bunkr.cr/f/abc', duration=100)
    image = Image.new('RGB', (400, 225))
    image.putdata([((x * 3 + y) % 256, (y * 2) % 256, (x + y * 3) % 256) for y in range(225) for x in range(400)])
    payload = BytesIO()
    image.save(payload, 'JPEG')
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def get(self, url, **kwargs):
            return SimpleNamespace(status_code=200, content=payload.getvalue())
    calls = []
    async def fresh(_):
        calls.append('stream')
        return 'https://a.cdn.cr/fresh.mp4', 'https://bunkr.cr/'
    async def extract(url, headers, duration, fractions, directory):
        output = str(__import__('pathlib').Path(directory) / 'frame.jpg')
        image.resize((854, 480)).save(output)
        return [output]
    monkeypatch.setattr(bunkr_cache, 'file_meta_get', lambda _: {'storyboard_url': 'https://static.example/cover.jpg', 'storyboard_kind': 'cover'})
    monkeypatch.setattr(m.httpx, 'AsyncClient', Client)
    monkeypatch.setattr(m, '_fresh_stream_for_thumb', fresh)
    monkeypatch.setattr(m.fast_thumb, 'eligible', lambda _: True)
    monkeypatch.setattr(m.fast_thumb, 'extract_candidates', extract)
    assert asyncio.run(m._generate_thumb_from_stream(video, str(tmp_path)))
    assert calls == ['stream']
    with Image.open(tmp_path / 'thumb_124.jpg') as result:
        assert result.size == (854, 480)


def test_small_frame_does_not_replace_existing_preview(monkeypatch, tmp_path):
    output = tmp_path / 'thumb_125.jpg'
    output.write_bytes(b'existing preview')
    video = Video(id=125, url='https://example.com/video.mp4', duration=100)
    async def fresh(_): return '', ''
    async def extract(url, headers, duration, fractions, directory):
        path = str(__import__('pathlib').Path(directory) / 'small.jpg')
        image = Image.new('RGB', (400, 225))
        image.putdata([((x * 3 + y) % 256, (y * 2) % 256, (x + y * 3) % 256) for y in range(225) for x in range(400)])
        image.save(path)
        return [path]
    async def ffmpeg(*args, **kwargs): return False, ''
    monkeypatch.setattr(m, '_fresh_stream_for_thumb', fresh)
    monkeypatch.setattr(m.fast_thumb, 'eligible', lambda _: True)
    monkeypatch.setattr(m.fast_thumb, 'extract_candidates', extract)
    monkeypatch.setattr(m, '_run_thumb_process', ffmpeg)
    assert not asyncio.run(m._generate_thumb_from_stream(video, str(tmp_path)))
    assert output.read_bytes() == b'existing preview'
    assert 'dostatočným rozlíšením' in m._THUMB_FAIL_DETAIL[125]
