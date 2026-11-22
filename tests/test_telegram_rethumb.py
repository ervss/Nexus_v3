import asyncio
import functools
import http.server
import os
import shutil
import socketserver
import subprocess
import threading
from types import SimpleNamespace

import pytest
from PIL import Image

from app import telegram_rethumb as tr
from app import maintenance
from app.database import Video
from app.routers import maintenance_endpoints
from fastapi import BackgroundTasks


def test_inspect_distinguishes_black_and_unloaded(tmp_path, monkeypatch):
    monkeypatch.setattr(tr, 'thumb_path', lambda chat, msg: tmp_path / f'{chat}_{msg}.jpg')
    assert tr.inspect_thumbnail(10, 1, True)['status'] == 'unchecked'
    assert tr.inspect_thumbnail(10, 1, False)['status'] == 'missing'
    Image.new('RGB', (320, 180), 'black').save(tmp_path / '10_1.jpg')
    assert tr.inspect_thumbnail(10, 1)['status'] == 'poor'


def test_dashboard_accepts_telegram_relative_stream(monkeypatch):
    class Db:
        def get(self, *_):
            return Video(id=21, url='/api/v1/telegram/stream/100/7', storage_type='telegram', telegram_chat_id='100', telegram_message_id=7)
    monkeypatch.setattr(maintenance, 'reserve_smart_rethumb', lambda: True)
    result = asyncio.run(maintenance_endpoints.smart_rethumb_card_route(21, BackgroundTasks(), Db()))
    assert result['ok'] and result['queued']


@pytest.mark.asyncio
async def test_generic_preview_processing_preserves_telegram_stream_and_thumbnail(monkeypatch):
    from app import services

    video = Video(
        id=21,
        url='/api/v1/telegram/stream/100/7',
        source_url='https://t.me/sample/7',
        thumbnail_path='/api/v1/telegram/thumb/100/7?cache=1',
        storage_type='telegram',
        telegram_chat_id='100',
        telegram_message_id=7,
        status='pending',
        preview_retry_needed=True,
        preview_retry_count=2,
        preview_last_error='Thumbnail/preview generation produced no usable output',
    )

    class Query:
        def get(self, video_id):
            return video if video_id == video.id else None

    class Db:
        def query(self, _model):
            return Query()
        def commit(self):
            pass
        def close(self):
            pass

    monkeypatch.setattr(services, 'SessionLocal', Db)
    processor = services.VIPVideoProcessor()
    updates = []

    async def broadcast(video_id, status, extra_data=None):
        updates.append((video_id, status, extra_data))

    monkeypatch.setattr(processor, '_broadcast_status', broadcast)
    await processor._process_single_video_internal(video.id, force=True)

    assert video.url == '/api/v1/telegram/stream/100/7'
    assert video.thumbnail_path == '/api/v1/telegram/thumb/100/7?cache=1'
    assert video.storage_type == 'telegram'
    assert video.status == 'ready_to_stream'
    assert not video.preview_retry_needed
    assert video.preview_retry_count == 0
    assert video.preview_last_error is None
    assert updates == [(21, 'ready_to_stream', {
        'thumbnail_path': '/api/v1/telegram/thumb/100/7?cache=1',
        'storage_type': 'telegram',
    })]


def test_dashboard_dispatches_telegram_stream_to_repair(tmp_path, monkeypatch):
    source = tmp_path / 'generated.jpg'
    source.write_bytes(b'frame')
    async def fake_repair(chat, msg, duration):
        assert (chat, msg, duration) == (100, 7, 100)
        return source
    monkeypatch.setattr(tr, 'repair_thumbnail', fake_repair)
    video = Video(id=21, url='/api/v1/telegram/stream/100/7', storage_type='telegram', telegram_chat_id='100', telegram_message_id=7, duration=100)
    assert asyncio.run(maintenance._generate_thumb_from_stream_impl(video, str(tmp_path)))
    assert (tmp_path / 'thumb_21.jpg').read_bytes() == b'frame'
    assert video.url == '/api/v1/telegram/stream/100/7'


def test_repair_keeps_previous_thumbnail_on_decode_failure(tmp_path, monkeypatch):
    old = tmp_path / '100_7.jpg'
    old.write_bytes(b'original')
    monkeypatch.setattr(tr, 'thumb_path', lambda chat, msg: old)
    async def fail(*args, **kwargs): return False, 'bad stream'
    monkeypatch.setattr(maintenance, '_run_thumb_process', fail)
    with pytest.raises(RuntimeError): asyncio.run(tr.repair_thumbnail(100, 7, 100))
    assert old.read_bytes() == b'original'


def test_preview_pump_does_not_schedule_without_readers(tmp_path, monkeypatch):
    from app import telegram_stream as stream
    monkeypatch.setattr(stream, 'CACHE_DIR', tmp_path)
    pump = stream.TelegramPump(10, 11, 100 * 1024 * 1024, 'video/mp4')
    pump.fill_background = False
    assert pump._priority_origin() is None
    pump.readers[1] = 0
    assert pump._priority_origin() == 0
    pump.ranges = [(0, stream.PREFETCH_BYTES)]
    assert pump._priority_origin() is None


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg unavailable')
def test_real_ffmpeg_extracts_through_range_http(tmp_path, monkeypatch):
    from app.config import config
    video = tmp_path / 'sample.mp4'
    subprocess.run([shutil.which('ffmpeg'), '-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
                    'testsrc2=size=320x180:rate=5', '-t', '35', '-c:v', 'mpeg4', '-movflags', '+faststart', str(video)], check=True)
    data = video.read_bytes()
    requests = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            value = self.headers.get('Range', 'bytes=0-')
            start = int(value.split('=')[1].split('-')[0] or 0)
            endpart = value.split('-')[1]
            end = min(len(data)-1, int(endpart)) if endpart else len(data)-1
            self.send_response(206)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
            self.send_header('Content-Length', str(end-start+1))
            self.end_headers()
            try: self.wfile.write(data[start:end+1])
            except (ConnectionResetError, BrokenPipeError): pass
        def log_message(self, *args): pass
    with socketserver.TCPServer(('127.0.0.1', 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            monkeypatch.setattr(config, 'SERVER_PORT', server.server_address[1])
            target = tmp_path / '100_7.jpg'
            monkeypatch.setattr(tr, 'thumb_path', lambda chat, msg: target)
            result = asyncio.run(tr.repair_thumbnail(100, 7, 35))
            assert result == target and target.stat().st_size > 0
            assert requests and all('preview=1' in path for path in requests)
            assert tr.inspect_thumbnail(100, 7)['status'] == 'ok'
        finally:
            server.shutdown()
            thread.join()
