"""Identity discovery regressions; all external calls are mocked."""
import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from app.search_engine import ExternalSearchEngine


def hit(title, slug):
    return {"title": title, "url": "https://example.test/" + slug, "source": "Camwhores"}


class SearchIdentityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = ExternalSearchEngine()
        self.noise = hit("Unrelated recommendation", "noise")
        self.match = hit("Sophia Dreams new upload", "match")
        self.engine.search_camwhores_async = AsyncMock(return_value=[self.noise])
        self.engine._fallback_search_for_source = AsyncMock(return_value=[self.noise, self.match])

    async def test_noise_triggers_fallback_and_spaced_handle_matches(self):
        results = await self.engine._run_single_discovery_source(
            "SophiaDreams", "camwhores", required_identity="SophiaDreams")
        self.assertEqual(results, [self.match])
        self.engine._fallback_search_for_source.assert_awaited_once()

    async def test_default_does_not_filter_or_trigger_fallback(self):
        results = await self.engine._run_single_discovery_source("SophiaDreams", "camwhores")
        self.assertEqual(results, [self.noise])
        self.engine._fallback_search_for_source.assert_not_awaited()
        self.assertNotIn("enrich_quality", self.engine.search_camwhores_async.call_args.kwargs)

    async def test_identity_search_skips_camwhores_enrichment(self):
        self.engine.search_camwhores_async.return_value = [self.match]
        await self.engine._run_single_discovery_source(
            "SophiaDreams", "camwhores", required_identity="SophiaDreams")
        self.assertIs(self.engine.search_camwhores_async.call_args.kwargs["enrich_quality"], False)
        self.assertIs(self.engine.search_camwhores_async.call_args.kwargs["include_private"], True)
        self.engine._fallback_search_for_source.assert_not_awaited()

    async def test_search_sources_forwards_identity_and_filters_direct_hits(self):
        self.engine.search_camwhores_async.return_value = [self.match, self.noise]
        response = await self.engine.search_sources(
            "SophiaDreams", ["camwhores"], required_identity="SophiaDreams",
            return_diagnostics=True)
        self.assertEqual(response["results"], [self.match])
        self.assertEqual(response["diagnostics"][0]["count"], 1)

    async def test_outer_timeout_preserves_empty_and_error_diagnostics(self):
        ready = asyncio.Event()
        finished = set()

        async def source(query, key, **kwargs):
            if key == "camwhores":
                await ready.wait()
                await asyncio.sleep(10)
                return []
            finished.add(key)
            if len(finished) == 2:
                ready.set()
            if key == "pornhub":
                raise ValueError("mock blocked")
            return []

        self.engine._run_single_discovery_source = source
        sink = {"results": [], "diagnostics": []}
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(self.engine.search_sources(
                "SophiaDreams", ["xvideos", "pornhub", "camwhores"], partial_sink=sink),
                timeout=0.2)
        self.assertEqual({d["source_key"]: d["status"] for d in sink["diagnostics"]},
                         {"xvideos": "empty", "pornhub": "error"})
        error = next(d for d in sink["diagnostics"] if d["source_key"] == "pornhub")
        self.assertEqual(error["error"], "mock blocked")

    async def test_camwhores_canonical_path_and_optional_private_tile(self):
        html = '''<div class="item private">
            <a href="/videos/9557776/sophiadreams-onlyfans-pussy-dildo-fuck/"
               title="SophiaDreams Onlyfans Pussy Dildo Fuck">watch</a>
            <img data-original="https://example.test/poster.jpg">
            <span class="duration">4:50</span></div>'''
        engine = ExternalSearchEngine()
        with patch("curl_cffi.requests.get", return_value=Mock(status_code=200, text=html)) as get:
            public = await engine.search_camwhores_async("SophiaDreams", enrich_quality=False)
            private = await engine.search_camwhores_async(
                "SophiaDreams", enrich_quality=False, include_private=True)
        self.assertEqual(public, [])
        self.assertEqual(len(private), 1)
        self.assertEqual(private[0]["title"], "SophiaDreams Onlyfans Pussy Dildo Fuck")
        self.assertEqual(private[0]["duration"], "4:50")
        self.assertTrue(private[0]["requires_login"])
        self.assertEqual(private[0]["url"],
                         "https://www.camwhores.tv/videos/9557776/sophiadreams-onlyfans-pussy-dildo-fuck/")
        self.assertEqual(get.call_args.args[0], "https://www.camwhores.tv/search/sophiadreams/")
        self.assertEqual(get.call_args.kwargs["impersonate"], "chrome")


if __name__ == "__main__":
    unittest.main()
