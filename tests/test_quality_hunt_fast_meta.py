import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from app import quality_hunt as qh
from app.routers.quality_hunt import QualityMetaRequest, quality_hunt_meta

class FastMetaTests(unittest.IsolatedAsyncioTestCase):
    async def test_fast_fetch_updates_live_candidates_while_search_is_running(self):
        identity=qh.ClipIdentity(scene='Test Recording',duration_sec=90)
        candidate=qh.HuntCandidate(url='https://site.test/watch',title=identity.scene)
        job={'identity':qh.asdict(identity),'status':'running','_candidate_objects':{candidate.url:candidate}}
        qh.refresh_job(job,[candidate])
        with patch('app.routers.quality_hunt.ensure_bridge_token'), patch.object(qh,'get_job',return_value=job), \
             patch('app.nexus_intel.resolve_cached',AsyncMock(return_value={'stream_url':'https://cdn.test/media.mp4','height':720,'duration':90,'size_bytes':1234567})):
            result=await quality_hunt_meta(QualityMetaRequest(urls=[candidate.url],job_id='test',fast=True))
        self.assertEqual(candidate.size_bytes,1234567)
        self.assertEqual(candidate.height,720)
        self.assertEqual(result['candidates'][0]['size_bytes'],1234567)

    async def test_fast_fetch_preserves_measured_fields_and_adds_size(self):
        with patch('app.routers.quality_hunt.ensure_bridge_token'), \
             patch('app.nexus_intel.resolve_cached', AsyncMock(return_value={'stream_url':'https://cdn.test/media.mp4', 'height':720,'duration':90})), \
             patch.object(qh,'probe_media_size',AsyncMock(return_value=10485760)) as probe:
            result=await quality_hunt_meta(QualityMetaRequest(urls=['https://site.test/watch'],fast=True))
        self.assertEqual(result['items'][0]['size_bytes'],10485760)
        self.assertEqual(result['items'][0]['duration_sec'],90)
        probe.assert_awaited_once()

    async def test_hls_has_no_invented_total_size(self):
        with patch('app.routers.quality_hunt.ensure_bridge_token'), \
             patch('app.nexus_intel.resolve_cached',AsyncMock(return_value={'stream_url':'https://cdn.test/media.m3u8','is_hls':True})), \
             patch.object(qh,'probe_media_size',AsyncMock()) as probe:
            result=await quality_hunt_meta(QualityMetaRequest(urls=['https://site.test/watch'],fast=True))
        self.assertEqual(result['items'][0]['size_bytes'],0)
        probe.assert_not_awaited()

    async def test_size_probe_rejects_html_error_page(self):
        client=AsyncMock()
        client.head.return_value=SimpleNamespace(status_code=200,headers={'content-type':'text/html','content-length':'5120'})
        factory=AsyncMock();factory.__aenter__.return_value=client
        with patch('httpx.AsyncClient',return_value=factory):
            self.assertEqual(await qh.probe_media_size('https://cdn.test/media.mp4'),0)
        client.stream.assert_not_called()

    async def test_size_probe_uses_head_without_downloading_media(self):
        client=AsyncMock()
        client.head.return_value=SimpleNamespace(status_code=200,headers={'content-type':'video/mp4','content-length':'987654321'})
        factory=AsyncMock();factory.__aenter__.return_value=client
        with patch('httpx.AsyncClient',return_value=factory):
            self.assertEqual(await qh.probe_media_size('https://cdn.test/media.mp4'),987654321)
        client.stream.assert_not_called()
