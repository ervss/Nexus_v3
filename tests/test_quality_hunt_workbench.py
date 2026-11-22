import asyncio
import base64
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch
from app import quality_hunt as qh
from app.routers.quality_hunt import PlaybackReport, quality_hunt_playback


class ModelTests(unittest.TestCase):
    def test_identity_availability_quality_are_independent_and_ids_are_stable(self):
        identity = qh.ClipIdentity(scene='Exact Interview Recording', duration_sec=600, height=720)
        a = qh.fuse_evidence(identity, qh.HuntCandidate(url='https://eporner.com/video-ABC/a/',
            title=identity.scene, duration_sec=600, height=1080, height_source='title', requires_login=True))
        b = qh.HuntCandidate(url='https://www.eporner.com/hd-porn/ABC/b/?utm_source=test')
        self.assertEqual(a.to_dict()['id'], b.to_dict()['id'])
        view = a.to_dict()
        self.assertEqual((view['identity_state'], view['availability_state'], view['quality_state']), ('confirmed', 'login_required', 'estimated'))
        self.assertTrue(all({'source', 'checked_at', 'reason'} <= set(e) for e in view['evidence']))

    def test_rejected_candidates_remain_in_balance_and_unknown_is_not_failure(self):
        identity = qh.ClipIdentity(scene='SophiaDreams Dildo Scene', performer='SophiaDreams', duration_sec=290)
        wrong = qh.HuntCandidate(url='https://host.test/1', title='Another Person Scene', duration_sec=290)
        unknown = qh.HuntCandidate(url='https://host.test/2')
        job = {'identity': qh.asdict(identity)}
        qh.refresh_job(job, [wrong, unknown])
        self.assertEqual(job['counts']['candidates'], 2)
        self.assertEqual(job['counts']['rejected'], 1)
        self.assertEqual(job['counts']['unverified'], 1)
        self.assertFalse(job['usable_improvement'])

    def test_failed_visual_verification_is_counted_even_with_valid_metadata(self):
        c = qh.HuntCandidate(url='https://host.test/1', metadata_status='ok', visual_status='timeout')
        job = {'identity': qh.asdict(qh.ClipIdentity())}
        qh.refresh_job(job, [c])
        self.assertEqual(job['balance']['verification_failures'], 1)

    def test_failed_media_probe_is_not_an_unverified_playlist(self):
        failed = qh.HuntCandidate(url='https://host.test/1', metadata_status='ok', availability_checked_at=time.time(), availability_reason='Overenie streamu: TimeoutError')
        playlist = qh.HuntCandidate(url='https://host.test/2', metadata_status='ok', availability_checked_at=time.time(), availability_reason='Playlist dostupný; segmenty a prehratie treba overiť')
        job = {'identity': qh.asdict(qh.ClipIdentity())}
        qh.refresh_job(job, [failed, playlist])
        self.assertEqual(job['balance']['verification_failures'], 1)


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        qh._jobs.clear(); qh._cache.clear(); qh._tasks.clear()

    async def asyncTearDown(self):
        tasks = list(qh._tasks.values())
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        qh._jobs.clear(); qh._cache.clear(); qh._tasks.clear()

    async def test_all_candidates_receive_metadata_before_identity_confirmation(self):
        hits = [{'url': f'https://example.test/{i}', 'title': 'Weak index caption'} for i in range(25)]
        engine = Mock(search_sources=AsyncMock(return_value={'results': hits, 'diagnostics': []}))
        extractor = Mock(extract=AsyncMock(return_value={'title': 'Exact Interview Recording', 'duration': 600,
            'height': 1080, 'stream_url': 'https://cdn.test/file.mp4'}))
        with patch.object(qh, '_search_library', return_value=[]), patch('app.search_engine.ExternalSearchEngine', return_value=engine), \
             patch('app.extractors.registry.ExtractorRegistry.find_extractor', return_value=extractor), \
             patch.object(qh, 'verify_stream', AsyncMock(return_value=('playable', 'test media bytes'))):
            result = await qh.start_hunt({'title': 'Exact Interview Recording', 'duration_sec': 600, 'height': 720})
            await qh._tasks[result['job_id']]
        job = qh.get_job(result['job_id'])
        self.assertEqual(extractor.extract.await_count, 25)
        self.assertEqual(job['counts']['confirmed'], 25)
        self.assertEqual(job['counts']['improvements'], 25)
        self.assertTrue(job['usable_improvement'])

    async def test_performer_fallback_rescues_only_visual_match_with_bounded_search(self):
        actor_hit = {'url': 'https://other.test/actor', 'title': 'Wettmelons Other Scene',
                     'duration': 359, 'thumbnail': 'https://other.test/poster.jpg', 'source': 'mock'}
        async def search(query, *args, **kwargs):
            return {'results': [actor_hit] if query == 'Wettmelons' else [], 'diagnostics': []}
        async def score(candidates, *args, **kwargs):
            for candidate in candidates:
                if candidate.url == actor_hit['url']:
                    candidate.visual_score = 72
                    candidate.visual_status = 'ok'
        engine = Mock(search_sources=AsyncMock(side_effect=search))
        payload = {'title': 'Wettmelons Gives Head And Receives A Facial', 'duration_sec': 358,
                   'frames': [base64.b64encode(b'x' * 256).decode()]}
        with patch.object(qh, '_search_library', return_value=[]), \
             patch('app.search_engine.ExternalSearchEngine', return_value=engine), \
             patch('app.nexus_intel._phash_bytes', return_value='0' * 16), \
             patch.object(qh, '_score_visuals', AsyncMock(side_effect=score)), \
             patch.object(qh, '_probe_candidates', AsyncMock()):
            result = await qh.start_hunt(payload)
            await qh._tasks[result['job_id']]
        actor_calls = [call for call in engine.search_sources.call_args_list if call.args[0] == 'Wettmelons']
        self.assertEqual(len(actor_calls), 1)
        self.assertEqual(actor_calls[0].kwargs['per_source_limit'], 2)
        self.assertEqual(actor_calls[0].kwargs['global_limit'], 24)
        self.assertEqual(qh.get_job(result['job_id'])['candidates'][0]['identity_state'], 'confirmed')

    async def test_degraded_cache_short_ttl_force_refresh_and_retry_only_failed_sources(self):
        engine = Mock(
            search_sources=AsyncMock(return_value={'results': [],
                'diagnostics': [{'source_key': 'eporner', 'status': 'timeout', 'error': 'deadline'}]}),
            search_telegram_async=AsyncMock(return_value=[]),
        )
        payload = {'title': 'Exact Interview Recording'}
        with patch.object(qh, '_search_library', return_value=[]), patch('app.search_engine.ExternalSearchEngine', return_value=engine):
            first = await qh.start_hunt(dict(payload)); await qh._tasks[first['job_id']]
            job = qh.get_job(first['job_id'])
            self.assertEqual(job['status'], 'degraded')
            self.assertEqual(qh._cache[job['_cache_key']]['ttl'], 20)
            cached = await qh.start_hunt(dict(payload))
            self.assertTrue(cached['cached']); self.assertEqual(cached['status'], 'degraded')
            retry = await qh.start_hunt({**payload, 'retry_job_id': first['job_id'], 'force_refresh': True})
            await qh._tasks[retry['job_id']]
            self.assertEqual(engine.search_sources.call_args.args[1], ['eporner'])
            fresh = await qh.start_hunt({**payload, 'force_refresh': True})
            self.assertFalse(fresh['cached']); await qh._tasks[fresh['job_id']]

    async def test_playback_report_updates_counts_without_conflating_identity(self):
        identity = qh.ClipIdentity(scene='Exact Interview Recording', height=720, duration_sec=600)
        candidate = qh.HuntCandidate(url='https://host.test/video', title=identity.scene, duration_sec=600)
        job = {'job_id': 'test', 'created_at': time.time(), 'identity': qh.asdict(identity), 'status': 'done', '_cache_key': 'test', 'coverage_target': 0}
        qh._cache['test'] = {'ts': time.time(), 'ttl': 3600}
        qh.refresh_job(job, [candidate]); qh._jobs['test'] = job
        with patch('app.routers.quality_hunt.ensure_bridge_token'):
            result = await quality_hunt_playback('test', PlaybackReport(candidate_id=job['candidates'][0]['id'], outcome='playing', height=1080, duration_sec=600))
        self.assertEqual(result['counts']['playable'], 1)
        self.assertEqual(result['counts']['improvements'], 1)
        self.assertEqual(qh._cache['test']['snapshot']['counts']['improvements'], 1)
        self.assertEqual(result['coverage']['target'], 0)

    async def test_playback_of_short_preview_clears_stale_file_size(self):
        identity = qh.ClipIdentity(scene='Exact Interview Recording', duration_sec=600)
        candidate = qh.HuntCandidate(url='https://host.test/clip', title=identity.scene,
            duration_sec=600, size_bytes=246_800_000, height=720, height_source='metadata')
        job = {'job_id': 'preview', 'created_at': time.time(), 'identity': qh.asdict(identity),
            'status': 'done', 'coverage_target': 5}
        qh.refresh_job(job, [candidate]); qh._jobs['preview'] = job
        with patch('app.routers.quality_hunt.ensure_bridge_token'):
            result = await quality_hunt_playback('preview', PlaybackReport(
                candidate_id=job['candidates'][0]['id'], outcome='playing',
                height=360, duration_sec=61, size_bytes=0))
        actual = result['candidates'][0]
        self.assertEqual(actual['size_bytes'], 0)
        self.assertEqual(actual['height'], 360)
        self.assertEqual(actual['duration_sec'], 61)
        self.assertEqual(actual['identity_state'], 'possible')

    async def test_retry_availability_does_not_extract_valid_metadata_again(self):
        c = qh.HuntCandidate(url='https://host.test/1', stream_url='https://cdn.test/1.mp4', metadata_status='ok')
        with patch('app.extractors.registry.ExtractorRegistry.find_extractor') as find, \
             patch.object(qh, 'verify_stream', AsyncMock(return_value=('playable', 'verified'))):
            await qh._probe_candidates([c])
        find.assert_not_called()
        self.assertEqual(c.availability_state, 'playable')

    async def test_visual_budget_failures_are_visible(self):
        candidate = qh.HuntCandidate(url='https://host.test/video', thumbnail='https://host.test/image')
        with patch('app.nexus_intel.phash_url', AsyncMock(side_effect=TimeoutError)):
            await qh._score_visuals([candidate], ['123'], budget=.1)
        self.assertEqual(candidate.visual_status, 'timeout')
        self.assertTrue(candidate.visual_reason)

    async def test_visual_verification_has_no_twenty_four_candidate_cap(self):
        candidates = [qh.HuntCandidate(url=f'https://host.test/{i}', thumbnail=f'https://host.test/{i}.jpg') for i in range(30)]
        with patch('app.nexus_intel.phash_url', AsyncMock(return_value='0' * 16)) as phash:
            await qh._score_visuals(candidates, ['0' * 16], budget=2)
        self.assertEqual(phash.await_count, 30)
        self.assertTrue(all(c.visual_status == 'ok' for c in candidates))

    async def test_source_http_failures_survive_empty_adapter_result(self):
        from app.search_engine import ExternalSearchEngine, _record_source_http, _source_trace
        engine = ExternalSearchEngine()
        async def throttled(*args, **kwargs):
            _record_source_http(429)
            return []
        engine.search_eporner_async = throttled
        engine._fallback_search_for_source = AsyncMock(return_value=[])
        response = await engine.search_sources('Exact Interview Recording', ['eporner'], return_diagnostics=True, trace_filters=True)
        self.assertEqual(response['diagnostics'][0]['status'], 'rate_limited')
        self.assertEqual(response['diagnostics'][0]['http_failures'], [429])
        self.assertIsNone(_source_trace.get())

    async def test_overall_deadline_keeps_candidates_and_records_unfinished_sources(self):
        async def stalled(*args, **kwargs):
            await asyncio.sleep(5)
        engine = Mock(search_sources=stalled)
        hit = {'url': 'https://host.test/1', 'title': 'Exact Interview Recording', 'duration_sec': 600}
        with patch.object(qh, 'QUICK_HUNT_TIMEOUT', 1.2), patch.object(qh, '_search_library', return_value=[hit]), \
             patch('app.search_engine.ExternalSearchEngine', return_value=engine), \
             patch('app.extractors.registry.ExtractorRegistry.find_extractor', return_value=None):
            result = await qh.start_hunt({'title': hit['title'], 'duration_sec': 600})
            await qh._tasks[result['job_id']]
        job = qh.get_job(result['job_id'])
        self.assertEqual(job['status'], 'partial')
        self.assertEqual(job['counts']['candidates'], 1)
        self.assertTrue(any(d['status'] == 'timeout' for d in job['diagnostics']))
        self.assertNotIn(job['_cache_key'], qh._cache)

    async def test_fast_variant_is_streamed_before_slow_variant_times_out(self):
        from app.search_engine import ExternalSearchEngine
        engine = ExternalSearchEngine()
        async def source(query, **kwargs):
            if query == 'slow':
                await asyncio.sleep(5)
            return [{'url': 'https://host.test/1', 'title': 'Exact Interview Recording'}]
        engine.search_eporner_async = source
        streamed = []
        async def received(batch):
            streamed.extend(batch)
        with patch.object(engine, '_build_query_variants', return_value=['fast', 'slow']):
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(engine._run_single_discovery_source('query', 'eporner', candidate_callback=received), .1)
        self.assertEqual(len(streamed), 1)
