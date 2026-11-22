import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from app import quality_hunt as qh
from app.routers.quality_hunt import QualityMetaRequest, QualityHuntRequest, quality_hunt_meta
from pydantic import ValidationError


class MatchRegressionTests(unittest.TestCase):
    def test_original_eporner_is_excluded_across_url_variants(self):
        ident = qh.ClipIdentity(scene='Best Haley Bimbo Of 2025', duration_sec=1330,
            page_url='https://eporner.com/video-vdKCmmOCwku/best-haley-bimbo-of-2025/')
        for url in ['http://www.eporner.com/video-vdKCmmOCwku/renamed-title/?utm_source=test#player',
                    'https://www.eporner.com/hd-porn/vdKCmmOCwku/another-slug/',
                    'https://m.eporner.com/embed/vdKCmmOCwku/']:
            candidate = qh.HuntCandidate(url=url, title=ident.scene, duration_sec=1330)
            qh.fuse_evidence(ident, candidate)
            self.assertTrue(candidate.confirmed)
            self.assertEqual(qh.bucket_cards(ident, [candidate]), {'better': [], 'other': [], 'maybe': []})
        other = qh.HuntCandidate(url='https://eporner.com/video-DIFFERENTID/another-upload/', title=ident.scene, duration_sec=1330)
        qh.fuse_evidence(ident, other)
        self.assertEqual(len(qh.bucket_cards(ident, [other])['other']), 1)

    def test_generic_query_identity_is_not_collapsed(self):
        self.assertNotEqual(qh.page_identity('https://example.com/watch?v=first'), qh.page_identity('https://example.com/watch?v=second'))

    def candidate(self, **kwargs):
        return qh.HuntCandidate(url="https://example.com/watch", height=1080, height_source="metadata", **kwargs)

    def test_generic_poster_does_not_confirm_even_exact_title(self):
        ident = qh.ClipIdentity(scene="Exact Interview Recording", height=720, thumbnail_url="https://a.test/1/poster.jpg")
        candidate = self.candidate(title=ident.scene, thumbnail="https://b.test/2/poster.jpg")
        qh.fuse_evidence(ident, candidate, ref_thumb_fp="poster")
        self.assertFalse(candidate.confirmed)
        self.assertIsNone(candidate.visual_score)

    def test_performer_pair_and_duration_do_not_confirm_other_scene(self):
        ident = qh.ClipIdentity(scene="Celina Powell Feat CGT", duration_sec=600, height=720)
        candidate = self.candidate(title="Celina Powell Different Scene", duration_sec=610)
        qh.fuse_evidence(ident, candidate)
        self.assertFalse(candidate.confirmed)

    def test_studio_and_date_do_not_confirm_other_scene(self):
        ident = qh.ClipIdentity(scene="Exact Interview Recording", studio="StudioX", date="2025-09-26", height=720)
        candidate = self.candidate(title="StudioX Unrelated Upload 2025-09-26")
        qh.fuse_evidence(ident, candidate)
        self.assertFalse(candidate.confirmed)

    def test_duration_conflict_vetoes_title_and_real_visual(self):
        ident = qh.ClipIdentity(scene="Exact Interview Recording", duration_sec=600, height=720)
        candidate = self.candidate(title=ident.scene, duration_sec=1200, visual_score=95)
        qh.fuse_evidence(ident, candidate)
        self.assertFalse(candidate.confirmed)
        self.assertEqual(candidate.identity_state, 'variant')
        self.assertEqual(candidate.variant_kind, 'longer')

    def test_short_and_long_cuts_keep_scene_identity_without_claiming_exact_match(self):
        ident = qh.ClipIdentity(scene='Wettmelons Gives Head And Receives A Facial',
            performer='Wettmelons', duration_sec=358)
        short = self.candidate(title=ident.scene, duration_sec=286)
        long = self.candidate(title=ident.scene, duration_sec=430, visual_score=80)
        actor = self.candidate(title='Wettmelons Other Scene', duration_sec=358)
        for candidate in (short, long, actor):
            qh.fuse_evidence(ident, candidate)
        self.assertEqual(short.identity_state, 'possible')
        self.assertEqual(long.identity_state, 'variant')
        self.assertEqual(long.variant_kind, 'longer')
        self.assertEqual(actor.identity_state, 'related')
        job = {'identity': qh.asdict(ident), 'coverage_target': 5}
        qh.refresh_job(job, [long])
        self.assertEqual(job['counts']['variants'], 1)
        self.assertEqual(job['counts']['sources'], 1)
        self.assertFalse(job['coverage']['target_met'])

    def test_abbreviated_query_still_keeps_scene_terms(self):
        ident = qh.parse_title_identity('Wettmelons Gives Head And Receives A Facial')
        queries = qh.hunt_queries(ident)
        self.assertEqual(len(queries), 3)
        self.assertNotIn('Wettmelons', queries)
        self.assertTrue(all('Wettmelons' in query for query in queries))
        self.assertIn('Wettmelons blowjob facial', queries)

    def test_possessive_creator_title_gets_scene_fallback_queries(self):
        ident = qh.parse_title_identity("Ssamibaby\u2019s Pussy Gets Smashed By Damion Dayski\u2019s BBC")
        self.assertEqual(ident.performer, 'Ssamibaby')
        queries = qh.hunt_queries(ident)
        self.assertGreaterEqual(len(queries), 2)
        self.assertTrue(any('Ssamibaby' in query and 'pussy' in query.lower() for query in queries))

    def test_possessive_creator_match_can_be_related_scene(self):
        ident = qh.parse_title_identity("Ssamibaby\u2019s Pussy Gets Smashed By Damion Dayski\u2019s BBC")
        ident.duration_sec = 1385
        candidate = qh.HuntCandidate(
            url='https://fpo.xxx/video/ssamibaby-gets-rammed-by-damion-dayski-bbc',
            title="Ssamibaby Gets Rammed By Damion Dayski's BBC",
            duration_sec=1327,
        )
        qh.fuse_evidence(ident, candidate)
        self.assertEqual(candidate.identity_state, 'possible')
        self.assertIn('performer', candidate.signals)

    def test_renamed_hard_sex_title_is_secondary_similar_scene(self):
        ident = qh.ClipIdentity(scene="Ssamibaby\u2019s Pussy Gets Smashed By Damion Dayski\u2019s BBC", performer='Ssamibaby')
        candidate = qh.HuntCandidate(
            url='https://camwhores.tv/videos/123/ssamibaby-pussy-railed-by-bbc',
            title="Ssamibaby Juicy Milf's Pussy Railed By BBC",
        )
        qh.fuse_evidence(ident, candidate)
        self.assertEqual(candidate.identity_state, 'similar')
        self.assertFalse(candidate.confirmed)

    def test_same_performer_similar_action_is_secondary_not_a_source(self):
        ident = qh.ClipIdentity(scene='Wettmelons Gives Head And Receives A Facial',
            performer='Wettmelons', duration_sec=358)
        similar = self.candidate(title='Wettmelons blowjob and titfuck', duration_sec=1007)
        qh.fuse_evidence(ident, similar)
        self.assertEqual(similar.identity_state, 'similar')
        self.assertFalse(similar.confirmed)
        job = {'identity': qh.asdict(ident)}
        qh.refresh_job(job, [similar])
        self.assertEqual(job['counts']['similar'], 1)
        self.assertEqual(job['counts']['sources'], 0)

    def test_promotional_preview_is_not_a_candidate_version(self):
        ident = qh.ClipIdentity(scene='Wettmelons Gives Head And Receives A Facial',
            performer='Wettmelons', duration_sec=358)
        preview = self.candidate(title='Wettmelons receives a facial Explore Full Videos At',
            duration_sec=842)
        qh.fuse_evidence(ident, preview)
        self.assertEqual(preview.identity_state, 'rejected')
        self.assertIn('ukážka', preview.rejection_reason)

    def test_numbered_scene_requires_number(self):
        ident = qh.ClipIdentity(scene="Celina Powell 3", duration_sec=600)
        candidate = self.candidate(title="Celina Powell 4", duration_sec=600)
        qh.fuse_evidence(ident, candidate)
        self.assertFalse(candidate.confirmed)
        self.assertEqual(candidate.identity_state, 'rejected')

    def test_short_clip_tolerance_is_not_twenty_seconds(self):
        self.assertFalse(qh.duration_within(10, 29))
        self.assertTrue(qh.duration_within(600, 610))

    def test_measured_height_wins_and_unknown_source_is_not_better(self):
        self.assertEqual(qh.ClipIdentity(height=480, quality_height=1080).effective_height, 480)
        candidate = self.candidate(confirmed=True)
        self.assertFalse(qh.is_better_quality(qh.ClipIdentity(), candidate))

    def test_title_height_and_larger_file_do_not_prove_improvement(self):
        ident = qh.ClipIdentity(height=720, size_bytes=100)
        candidate = self.candidate(confirmed=True, size_bytes=200)
        candidate.height_source = "title"
        self.assertFalse(qh.is_better_quality(ident, candidate))
        candidate.height_source = "metadata"
        candidate.height = 720
        self.assertFalse(qh.is_better_quality(ident, candidate))

    def test_cache_uses_all_reference_facts_and_search_options(self):
        ident = qh.ClipIdentity(scene="Exact Scene", height=720)
        baseline = qh._cache_key(ident)
        for field, value in [("studio", "StudioX"), ("size_bytes", 42), ("thumbnail_url", "https://a.test/poster.jpg"), ("date", "2025-09-26")]:
            changed = qh.ClipIdentity(**{**qh.asdict(ident), field: value})
            self.assertNotEqual(baseline, qh._cache_key(changed))
        self.assertNotEqual(baseline, qh._cache_key(ident, mode="deep"))
        self.assertNotEqual(baseline, qh._cache_key(ident, allow_visual_search=True))

    def test_request_rejects_invalid_measurements_and_oversized_frames(self):
        for extra in [{"duration_sec": float("inf")}, {"height": -1}, {"frames": ["x"] * 4}, {"frames": ["x" * 2_800_001]}]:
            with self.assertRaises(ValidationError):
                QualityHuntRequest(title="Exact Interview Recording", **extra)

    def test_obfuscated_platform_and_hyphen_performer_and_transliteration(self):
        ident = qh.parse_title_identity("Ksyusha Krasivchik - OnlyF@ns - Ball sex tape.mp4")
        self.assertEqual(ident.performer, "Ksyusha Krasivchik")
        self.assertNotIn("onlyf", ident.scene.lower())
        cand = self.candidate(title="Ксения красивчик | ksusha krasivchik ball sex tape", duration_sec=624)
        ident.duration_sec = 624
        qh.fuse_evidence(ident, cand)
        self.assertIn("performer", cand.signals)
        self.assertIn("scene", cand.signals)
        self.assertTrue(cand.confirmed)

    def test_search_and_tag_pages_and_direct_images_are_filtered(self):
        self.assertTrue(qh._is_non_video_hunt_hit("https://www.porntrex.com/search/krasivchik/", "Most Relevant for: krasivchik_ksusha onlyfans - PornTrex", {}))
        self.assertTrue(qh._is_non_video_hunt_hit("https://www.xvideos.com/?k=Ksyusha+Krasivchik", "'Ksyusha Krasivchik' Search - XVIDEOS.COM", {}))
        self.assertTrue(qh._is_non_video_hunt_hit("https://cdn.test/frame.jpg", "Frame", {"kind": "image"}))
        self.assertFalse(qh._is_non_video_hunt_hit("https://www.noodlemagazine.com/watch/-123_456", "Ksusha Krasivchik Ball Sex Tape", {}))

    def test_visual_pivot_queries_and_cascade_and_visual_similarity_rescue(self):
        ident = qh.parse_title_identity("Ksyusha Krasivchik - OnlyF@ns - Ball sex tape.mp4")
        ident.duration_sec = 624
        cascade = qh.hunt_cascade_queries(ident)
        self.assertTrue(any("Ksyusha Krasivchik" in q or "ksusha" in q.lower() for q in cascade), cascade)

        visual_hits = [
            {"title": "Ксения красивчик | ksusha krasivchik / sunnyq / crazycrazycrazycouple", "ocr_text": "OnlyFans.com/crazycrazycrazycouple"},
            {"title": "sunnyq crazycrazycrazycouple leaked clip"},
        ]
        pivot_qs, pivot_toks = qh._extract_visual_pivot_queries(visual_hits, ident)
        self.assertIn("crazycrazycrazycouple", pivot_toks)
        self.assertIn("sunnyq", pivot_toks)
        self.assertTrue(any("crazycrazycrazycouple" in q for q in pivot_qs), pivot_qs)

        ident._pivot_tokens = pivot_toks
        pivot_cand = self.candidate(title="Sunnyq Crazycrazycrazycouple bedroom video", duration_sec=210)
        qh.fuse_evidence(ident, pivot_cand)
        self.assertEqual(pivot_cand.identity_state, "similar")

        env_cand = self.candidate(title="Ksyusha Krasivchik bedroom clip", duration_sec=300, visual_score=38.0)
        qh.fuse_evidence(ident, env_cand)
        self.assertEqual(env_cand.identity_state, "similar")

        rescued = self.candidate(title="Renamed upload without actor name", duration_sec=620, visual_score=46.0)
        qh.fuse_evidence(ident, rescued)
        self.assertEqual(rescued.identity_state, "possible")

        self.assertEqual(qh._pick_best_frame([b"short", b"much_longer_sharp_frame_bytes", b"mid"]), b"much_longer_sharp_frame_bytes")


class JobRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        qh._jobs.clear()
        qh._cache.clear()
        qh._tasks.clear()

    async def asyncTearDown(self):
        tasks = list(qh._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        qh._jobs.clear()
        qh._cache.clear()

    async def test_cancel_stops_task_and_preserves_partial_results(self):
        async def blocked(*args):
            await asyncio.Event().wait()
        with patch.object(qh, "_run_hunt", side_effect=blocked):
            first = await qh.start_hunt({"title": "Exact Interview Recording"})
            second = await qh.start_hunt({"title": "Exact Interview Recording"})
            self.assertEqual(first["job_id"], second["job_id"])
            await asyncio.sleep(0)
            job = qh.get_job(first["job_id"])
            job["groups"]["maybe"] = [{"url": "https://example.com/partial"}]
            qh.cancel_hunt(first["job_id"])
            await asyncio.sleep(0)
            self.assertEqual(job["status"], "cancelled")
            self.assertEqual(len(job["groups"]["maybe"]), 1)
            self.assertNotIn(first["job_id"], qh._tasks)

    async def test_timeout_preserves_partial_results_without_success_cache(self):
        async def blocked(job_id, *args):
            qh._jobs[job_id]["groups"]["maybe"] = [{"url": "https://example.com/partial"}]
            await asyncio.Event().wait()
        with patch.object(qh, "_run_hunt", side_effect=blocked), patch.object(qh, "QUICK_HUNT_TIMEOUT", 0.01):
            started = await qh.start_hunt({"title": "Exact Interview Recording"})
            await qh._tasks[started["job_id"]]
        job = qh.get_job(started["job_id"])
        self.assertEqual(job["status"], "partial")
        self.assertEqual(len(job["groups"]["maybe"]), 1)
        self.assertEqual(qh._cache, {})

    async def test_active_job_limit(self):
        async def blocked(*args):
            await asyncio.Event().wait()
        with patch.object(qh, "_run_hunt", side_effect=blocked):
            for index in range(3):
                await qh.start_hunt({"title": f"Unique Interview Recording {index}"})
            with self.assertRaises(ValueError):
                await qh.start_hunt({"title": "Fourth Interview Recording"})

    async def test_quick_search_never_uploads_frames_without_opt_in(self):
        engine = Mock(search_sources=AsyncMock(return_value={"results": [], "diagnostics": []}),
            search_telegram_async=AsyncMock(return_value=[]))
        with patch.object(qh, "_search_library", return_value=[]), patch("app.search_engine.ExternalSearchEngine", return_value=engine), \
             patch.object(qh, "_yandex_hits", new_callable=AsyncMock) as yandex, \
             patch.object(qh, "_search_google", new_callable=AsyncMock) as google:
            import base64
            started = await qh.start_hunt({"title": "Exact Interview Recording", "mode": "quick", "allow_visual_search": False,
                "frames": [base64.b64encode(b"x" * 512).decode()]})
            await qh._tasks[started["job_id"]]
        yandex.assert_not_awaited()
        google.assert_not_awaited()
        engine.search_telegram_async.assert_awaited()
        self.assertEqual(qh.get_job(started["job_id"])["status"], "done")

    async def test_metadata_downgrade_rebuckets_and_preserves_mirrors(self):
        ident = qh.ClipIdentity(scene="Exact Interview Recording", height=720, duration_sec=600)
        candidates = [qh.fuse_evidence(ident, qh.HuntCandidate(url=f"https://example.com/{i}", title=ident.scene,
            height=1080, height_source="metadata", duration_sec=600)) for i in range(2)]
        qh._jobs["job"] = {"job_id": "job", "created_at": qh.time.time(), "status": "done",
            "identity": qh.asdict(ident), "groups": qh.bucket_cards(ident, candidates)}
        resolve = AsyncMock(return_value={"height": 480, "stream_url": "https://cdn.test/video.mp4", "duration": 600})
        with patch("app.nexus_intel.resolve_cached", resolve), patch("app.routers.quality_hunt.ensure_bridge_token"):
            result = await quality_hunt_meta(QualityMetaRequest(urls=[c.url for c in candidates], job_id="job"))
        # Both primary and mirrors must receive their own metadata.
        self.assertEqual(result["groups"]["better"], [])
        self.assertEqual(result["groups"]["other"][0]["height"], 480)
        self.assertEqual(result["groups"]["other"][0]["mirror_count"], 2)

    async def test_probe_replaces_claimed_height_with_lower_metadata(self):
        candidate = qh.HuntCandidate(url="https://example.com/watch", height=2160, height_source="title")
        extractor = type("Extractor", (), {"extract": AsyncMock(return_value={"height": 480})})()
        with patch("app.extractors.registry.ExtractorRegistry.find_extractor", return_value=extractor):
            await qh._probe_candidates([candidate])
        self.assertEqual(candidate.height, 480)
        self.assertEqual(candidate.height_source, "metadata")
