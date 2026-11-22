"""Regression tests for strict Fusion Hub query matching and quality claims."""
import unittest
from unittest.mock import patch

from app.hubs.base import Page


class _FakeAdapter:
    def __init__(self, source, items):
        self.source = source
        self.label = source
        self._items = items

    async def search(self, query, sort="", page=1, category=""):
        return Page(items=[dict(item) for item in self._items], page=page, has_more=False)


class PrimeRelevanceTests(unittest.IsolatedAsyncioTestCase):
    def test_matches_normalised_alias_and_rejects_generic_feed_tile(self):
        from app.hubs.prime import matches_query

        self.assertTrue(matches_query(
            {"title": "Poolside party with Bad_girl_sandra"}, "badgirlsandra"
        ))
        self.assertTrue(matches_query(
            {"title": "Scene", "performers": [{"name": "Carla Boom"}]}, "Carla Boom"
        ))
        self.assertFalse(matches_query(
            {"title": "Boom Boom Angela"}, "Carla Boom"
        ))

    async def test_prime_drops_irrelevant_high_quality_tile_before_quality_gate(self):
        from app.hubs.prime import harvest_source

        adapter = _FakeAdapter("eporner", [
            {"url": "https://example.test/feed", "title": "Boom Boom Angela", "height": 2160, "quality": "4K"},
            {"url": "https://example.test/match", "title": "Carla Boom in 4K", "height": 2160, "quality": "4K"},
        ])
        with patch("app.hubs.prime.registry.get", return_value=adapter):
            result = await harvest_source(
                "eporner", "Carla Boom", min_height=1080, per_source=10,
                pages=1, allow_unverified=False, deadline=10**9,
            )

        self.assertEqual(["https://example.test/match"], [row["url"] for row in result["items"]])
        self.assertEqual(2, result["stats"]["harvested"])
        self.assertEqual(1, result["stats"]["relevant"])
        self.assertEqual(1, result["stats"]["dropped_irrelevant"])

    async def test_unknown_4kporno_tile_is_not_promoted_without_a_concrete_height(self):
        from app.hubs.prime import harvest_source

        adapter = _FakeAdapter("4kporno", [
            {"url": "https://example.test/match", "title": "Carla Boom scene", "quality": "", "height": 0},
        ])
        with patch("app.hubs.prime.registry.get", return_value=adapter):
            result = await harvest_source(
                "4kporno", "Carla Boom", min_height=1080, per_source=10,
                pages=1, allow_unverified=False, deadline=10**9,
            )

        self.assertEqual([], result["items"])
        self.assertEqual(1, result["stats"]["relevant"])


class HubSearchStrictRelevanceTests(unittest.IsolatedAsyncioTestCase):
    async def test_strict_search_returns_counts_and_filters_generic_feed_tiles(self):
        from app.routers.hub import hub_search

        adapter = _FakeAdapter("fake", [
            {"url": "https://example.test/match", "title": "Carla Boom scene"},
            {"url": "https://example.test/feed", "title": "Boom Boom Angela"},
        ])
        with patch("app.routers.hub._adapter", return_value=adapter):
            payload = await hub_search("fake", q="Carla Boom", strict_relevance=True)

        self.assertEqual(2, payload["raw_count"])
        self.assertEqual(1, payload["strict_count"])
        self.assertEqual(["Carla Boom scene"], [row["title"] for row in payload["items"]])
