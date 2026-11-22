import asyncio
import struct
from unittest.mock import patch, AsyncMock

from app.extractors import mega_native as mn


def test_fast_probe_jumps_over_media_and_reads_only_metadata():
    def atom(kind, data):
        return struct.pack('>I', len(data) + 8) + kind + data

    sample = bytearray(40)
    sample[24:28] = struct.pack('>HH', 1920, 1080)
    moov = atom(b'moov', atom(b'avc1', sample))
    mdat_size = 100_000_000
    prefix = atom(b'ftyp', b'isom') + struct.pack('>I', mdat_size) + b'mdat'
    tail_offset = 12 + mdat_size
    size = tail_offset + len(moov)
    calls = []
    ref = mn.MegaRef('file', 'abcd1234', (1, 2, 3, 4, 5, 6, 7, 8))

    class Response:
        status_code = 206
        def __init__(self, start, end):
            self.start, self.end = start, end
            self.headers = {'content-range': f'bytes {start}-{end}/{size}'}
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def raise_for_status(self):
            pass
        async def aiter_bytes(self, **kwargs):
            data = bytearray(self.end - self.start + 1)
            for offset, part in [(0, prefix), (tail_offset, moov)]:
                lo, hi = max(self.start, offset), min(self.end + 1, offset + len(part))
                if lo < hi:
                    data[lo - self.start:hi - self.start] = part[lo - offset:hi - offset]
            yield mn.MegaCTRDecryptor(ref.key_a32, self.start).decrypt(bytes(data))

    class Client:
        def __init__(self, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def stream(self, method, url, headers):
            start, end = map(int, headers['Range'][6:].split('-'))
            calls.append((start, end))
            return Response(start, end)

    with patch.object(mn, 'resolve_cdn', AsyncMock(return_value={'size': size, 'url': 'https://example.invalid'})), patch.object(mn.httpx, 'AsyncClient', Client):
        meta = asyncio.run(mn.probe_metadata(ref, fast=True))
    assert (meta['width'], meta['height']) == (1920, 1080)
    assert len(calls) == 3
    assert sum(end - start + 1 for start, end in calls) < 66000


def test_metadata_endpoint_rejects_invalid_refs_and_caches_success():
    from fastapi import HTTPException
    from app.routers import mega
    ref = mn.MegaRef('file', 'abcd1234', (1, 2, 3, 4, 5, 6, 7, 8)).to_compact()
    mega._METADATA_CACHE.clear()

    probe = AsyncMock(return_value={'width': 1080, 'height': 1920, 'duration': 60})
    async def run():
        with patch.object(mn, 'probe_metadata', probe):
            first = await mega.mega_card_metadata(mega.MegaMetadataRequest(ref=ref))
            second = await mega.mega_card_metadata(mega.MegaMetadataRequest(ref=ref))
            assert first == second
            assert first['quality'] == '1080p'
            assert probe.await_count == 1
            try:
                await mega.mega_card_metadata(mega.MegaMetadataRequest(ref='invalid'))
            except HTTPException as exc:
                assert exc.status_code == 400
            else:
                raise AssertionError('invalid reference accepted')
    asyncio.run(run())
    mega._METADATA_CACHE.clear()


def test_fast_probe_does_not_consume_a_server_response_ignoring_range():
    class Response:
        status_code = 200
        headers = {}
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def raise_for_status(self):
            pass
        async def aiter_bytes(self, **kwargs):
            raise AssertionError('Must reject response before consuming media')
            yield b''

    class Client:
        def __init__(self, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def stream(self, *args, **kwargs):
            return Response()

    ref = mn.MegaRef('file', 'abcd1234', (1, 2, 3, 4, 5, 6, 7, 8))
    with patch.object(mn, 'resolve_cdn', AsyncMock(return_value={'size': 100_000_000, 'url': 'https://example.invalid'})), patch.object(mn.httpx, 'AsyncClient', Client):
        result = asyncio.run(mn.probe_metadata(ref, fast=True))
    assert result == {'width': 0, 'height': 0, 'duration': 0.0}
