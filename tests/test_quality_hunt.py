"""Unit tests for Quality Hunt — parser, evidence fusion, mirror clustering.

No network. Uses the screenshot-style release filename from the plan.
"""
from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app.quality_hunt import (
    ClipIdentity,
    HuntCandidate,
    bucket_cards,
    cluster_mirrors,
    fuse_evidence,
    is_better_quality,
    parse_title_identity,
    scene_overlap,
    scene_significant_overlap,
    hunt_queries,
    source_coverage,
)


SCREEN_TITLE = (
    "[HD] [FreakMobMedia] Zoey Foxx Makes BBC Cum (26.09.25)(720p)(x264)[oforus].mp4"
)


class ReportedRegressionTests(unittest.TestCase):
    def setUp(self):
        self.identity = parse_title_identity('SophiaDreams Onlyfans Pussy Dildo Fuck - CamWhores.mp4')
        self.identity.duration_sec = 290

    def test_clean_identity_and_multiple_queries(self):
        self.assertEqual(self.identity.performer, 'SophiaDreams')
        self.assertNotIn('Onlyfans', self.identity.scene)
        self.assertNotIn('CamWhores', self.identity.scene)
        self.assertEqual(len(hunt_queries(self.identity)), 2)
        self.assertNotIn('SophiaDreams', hunt_queries(self.identity))

    def test_screenshot_noise_and_different_scene_are_excluded(self):
        candidates = []
        for title, duration in [('POV Hairy Pussy Dildo Fuck', 290),
                ('Keilymaddams Pussy Dildo Fuck In Car', 290),
                ('Lustful devil trains his little ass', 283),
                ('SophiaDreams smoking bj', 71),
                ('SophiaDreams Onlyfans Pussy Fuck Cumshot - CamWhores', 600)]:
            candidate = HuntCandidate(url='https://example.com/' + str(len(candidates)),
                title=title, source='example', duration_sec=duration)
            fuse_evidence(self.identity, candidate)
            candidates.append(candidate)
        self.assertEqual(bucket_cards(self.identity, candidates), {'better': [], 'other': [], 'maybe': []})

    def test_clean_renamed_copy_confirms(self):
        candidate = HuntCandidate(url='https://example.com/exact',
            title='Sophia Dreams Pussy Dildo Fuck 1080p', source='example', duration_sec=290)
        fuse_evidence(self.identity, candidate)
        self.assertTrue(candidate.confirmed)

    def test_five_independent_sources_not_five_subdomains(self):
        cards = [{'url': f'https://s{i}.same.com/video', 'mirrors': []} for i in range(5)]
        self.assertFalse(source_coverage({'other': cards})['target_met'])
        cards = [{'url': f'https://source{i}.com/video', 'mirrors': []} for i in range(5)]
        self.assertTrue(source_coverage({'other': cards})['target_met'])
        aliases = [{'url': f'https://www.camwhores.{tld}/videos/9557776/'} for tld in ['tv', 'stream', 'guru', 'video', 'dance']]
        self.assertEqual(source_coverage({'other': aliases})['confirmed_sources'], ['camwhores.tv'])


class GoogleDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def test_rate_limit_diagnostic_does_not_expose_request_key(self):
        from app.quality_hunt import _search_google
        from app.config import config
        response = MagicMock(status_code=429)
        client = MagicMock()
        client.get = AsyncMock(return_value=response)
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(return_value=client)
        manager.__aexit__ = AsyncMock(return_value=False)
        with patch.object(config, 'SERPAPI_API_KEY', 'test-private-key'), patch('httpx.AsyncClient', return_value=manager):
            with self.assertRaisesRegex(RuntimeError, '^Google HTTP 429$'):
                await _search_google('example')
        response.json.assert_not_called()


class ParseTitleIdentityTests(unittest.TestCase):
    def test_screenshot_filename(self):
        ident = parse_title_identity(SCREEN_TITLE)
        self.assertEqual(ident.scene, "Zoey Foxx Makes BBC Cum")
        self.assertEqual(ident.studio, "FreakMobMedia")
        self.assertEqual(ident.date, "26.09.25")
        self.assertEqual(ident.quality_height, 720)

    def test_strips_codec_and_release_group(self):
        ident = parse_title_identity(SCREEN_TITLE)
        self.assertNotIn("x264", ident.scene.lower())
        self.assertNotIn("oforus", ident.scene.lower())
        self.assertNotIn("720", ident.scene)

    def test_4k_tag(self):
        ident = parse_title_identity("Some Scene Title [4K] [StudioX]")
        self.assertEqual(ident.quality_height, 2160)
        self.assertIn("Some Scene Title", ident.scene)


class EvidenceFusionTests(unittest.TestCase):
    def setUp(self):
        self.identity = parse_title_identity(SCREEN_TITLE)
        self.identity.duration_sec = 42 * 60 + 3  # 42:03
        self.identity.height = 720  # measured source height

    def test_other_scene_same_performer_is_maybe(self):
        cand = HuntCandidate(
            url="https://xvideos.com/other",
            title="Zoey Foxx Does Something Else Entirely",
            source="xvideos",
            duration_sec=1800,
            height=1080,
        )
        fuse_evidence(self.identity, cand)
        groups = bucket_cards(self.identity, [cand])
        self.assertFalse(cand.confirmed)
        self.assertEqual(cand.identity_state, 'related')
        self.assertEqual(groups["better"], [])
        # May land in maybe if one weak signal, or nowhere — never in better
        for card in groups["better"] + groups["other"]:
            self.assertNotEqual(card["url"], cand.url)

    def test_scene_is_primary_and_actor_only_is_secondary(self):
        identity = parse_title_identity('Wettmelons Gives Head And Receives A Facial')
        identity.duration_sec = 358
        self.assertEqual(identity.performer, 'Wettmelons')
        self.assertNotIn('Wettmelons', hunt_queries(identity))
        same = HuntCandidate(url='https://a.test/same', title='Wettmelons Gives Head And Receives A Facial', duration_sec=358)
        actor = HuntCandidate(url='https://b.test/actor', title='Wettmelons Other Scene', duration_sec=359)
        unrelated = HuntCandidate(url='https://c.test/other', title='Amirah Adara nailed and cum facialed', duration_sec=372)
        for candidate in (same, actor, unrelated):
            fuse_evidence(identity, candidate)
        self.assertEqual(same.identity_state, 'confirmed')
        self.assertEqual(actor.identity_state, 'related')
        self.assertEqual(unrelated.identity_state, 'rejected')

    def test_scene_plus_duration_confirms_without_thumb(self):
        cand = HuntCandidate(
            url="https://hqporner.com/same",
            title="Zoey Foxx Makes BBC Cum 1080p",
            source="hqporner",
            duration_sec=42 * 60 + 11,
            height=1080,
            height_source="metadata",
        )
        fuse_evidence(self.identity, cand)
        self.assertTrue(cand.confirmed)
        self.assertIn("scene", cand.signals)
        self.assertIn("duration", cand.signals)
        self.assertTrue(is_better_quality(self.identity, cand))
        groups = bucket_cards(self.identity, [cand])
        self.assertEqual(len(groups["better"]), 1)

    def test_best_of_three_visual_saves_match(self):
        # Weak title but strong visual_score (best of 3 frames already picked)
        cand = HuntCandidate(
            url="https://eporner.com/renamed",
            title="FMM Zoey BBC scene",
            source="eporner",
            duration_sec=42 * 60 + 5,
            height=1080,
            visual_score=72.0,
        )
        fuse_evidence(self.identity, cand)
        self.assertIn("thumbnail", cand.signals)
        self.assertIn("duration", cand.signals)
        self.assertTrue(cand.confirmed)

    def test_low_visual_does_not_alone_confirm(self):
        cand = HuntCandidate(
            url="https://x.com/noise",
            title="Completely Unrelated Upload Name Here",
            source="xvideos",
            visual_score=20.0,
            height=1080,
        )
        fuse_evidence(self.identity, cand)
        self.assertFalse(cand.confirmed)

    def test_same_thumb_filename_is_not_image_evidence(self):
        thumb = "https://cdn.example/abc123def.jpg?x=1"
        self.identity.thumbnail_url = thumb
        from app.media_match import thumb_fingerprint
        fp = thumb_fingerprint(thumb)
        cand = HuntCandidate(
            url="https://bunkr.example/file",
            title="Zoey Foxx Makes BBC Cum",
            source="bunkr",
            thumbnail="https://other.cdn/abc123def.jpg",
            duration_sec=0,
            height=1080,
        )
        fuse_evidence(self.identity, cand, ref_thumb_fp=fp)
        self.assertNotIn("thumbnail", cand.signals)
        self.assertIn("scene", cand.signals)
        self.assertFalse(cand.confirmed)


class ClusterMirrorsTests(unittest.TestCase):
    def test_five_mirrors_one_card_1080_on_top(self):
        identity = parse_title_identity(SCREEN_TITLE)
        identity.duration_sec = 2520
        identity.height = 720
        cands = []
        for i, h in enumerate([720, 720, 1080, 480, 720]):
            c = HuntCandidate(
                url=f"https://host{i}.example/Zoey_Foxx_Makes_BBC_Cum_{h}p.mp4",
                title=f"Zoey Foxx Makes BBC Cum {h}p",
                source=f"host{i}",
                duration_sec=2523,
                height=h,
                height_source="metadata",
            )
            fuse_evidence(identity, c)
            cands.append(c)
        groups = bucket_cards(identity, cands)
        # All confirmed (scene+duration) and 1080 is better
        self.assertGreaterEqual(len(groups["better"]), 1)
        top = groups["better"][0]
        self.assertEqual(top["height"], 1080)
        self.assertEqual(top["mirror_count"], 5)

    def test_short_query_inside_long_title_is_scene(self):
        cand = HuntCandidate(
            url="https://xvideos.com/celina",
            title="Celina Powell Late Night Extra Long Upload Name",
            source="xvideos",
            height=1080,
        )
        ident = ClipIdentity(scene="Celina Powell 3", duration_sec=1000, height=1252)
        fuse_evidence(ident, cand)
        self.assertIn("scene", cand.signals)
        self.assertGreaterEqual(cand.match_coverage, 0.66)

    def test_unknown_nonstandard_source_is_not_assumed_worse(self):
        ident = ClipIdentity(scene="Celina Powell 3", duration_sec=4000, height=1252)
        cand = HuntCandidate(
            url="https://hqporner.com/hd",
            title="Celina Powell 3 1080p",
            source="hqporner",
            duration_sec=4010,
            height=1080,
        )
        fuse_evidence(ident, cand)
        self.assertTrue(cand.confirmed)
        self.assertFalse(is_better_quality(ident, cand))
        groups = bucket_cards(ident, [cand])
        self.assertEqual(len(groups["better"]), 0)

    def test_scene_overlap_helpers(self):
        a = "Zoey Foxx Makes BBC Cum"
        b = "Zoey Foxx Makes BBC Cum 1080p"
        c = "Zoey Foxx Solo Masturbation Tape"
        self.assertTrue(scene_significant_overlap(a, b))
        self.assertFalse(scene_significant_overlap(a, c))
        self.assertGreater(scene_overlap(a, b), scene_overlap(a, c))

    def test_feat_filler_does_not_hide_performer_match(self):
        ident = ClipIdentity(scene="Celina Powell Feat CGT", duration_sec=2100, height=720)
        close = HuntCandidate(
            url="https://porntrex.com/exact",
            title="Celina Powell Feat CGT 1080p",
            source="porntrex",
            height=1080,
            duration_sec=2110,
        )
        other_scene = HuntCandidate(
            url="https://xvideos.com/other",
            title="Celina Powell Late Night Extra",
            source="xvideos",
            height=1080,
        )
        unrelated = HuntCandidate(
            url="https://hqporner.com/noise",
            title="Clara Lawson Art of Blowjob",
            source="hqporner",
        )
        fuse_evidence(ident, close)
        fuse_evidence(ident, other_scene)
        fuse_evidence(ident, unrelated)
        self.assertIn("scene", close.signals)
        self.assertTrue(close.confirmed)
        self.assertIn("performer", other_scene.signals)
        self.assertNotIn("scene", other_scene.signals)
        self.assertFalse(unrelated.confirmed)
        self.assertNotIn("scene", unrelated.signals)


if __name__ == "__main__":
    unittest.main()
