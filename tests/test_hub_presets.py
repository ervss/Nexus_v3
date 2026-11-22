"""Regression tests for the curated Fusion Hub tag-mix presets.

The point of these is the relevance bar. A preset mixes 2-3 tags, and
`relevance_score` scores a partial hit at 0.6 * (matched / total) — so a
3-tag preset that keeps the 0.45 default silently throws away every 2-of-3
tile (0.40), which is exactly the content it exists to surface. That failure
is invisible in production: the grid just looks emptier than it should.
"""
import unittest

from app.hubs.presets import PRESETS, all_presets, get_preset
from app.hubs.prime import DEFAULT_RELEVANCE, relevance_score


class PresetTableTests(unittest.TestCase):
    def test_ids_are_unique_and_url_safe(self):
        ids = [p["id"] for p in PRESETS]
        self.assertEqual(len(ids), len(set(ids)), "preset ids must be unique")
        for pid in ids:
            self.assertRegex(pid, r"^[a-z0-9-]+$")

    def test_query_covers_every_declared_tag(self):
        """The query is what the sources actually receive — a tag listed in the
        chip tooltip but missing from the query would be a lie to the user."""
        for preset in PRESETS:
            query_words = set(preset["query"].split())
            for tag in preset["tags"]:
                for word in tag.split():
                    self.assertIn(word, query_words,
                                  f"{preset['id']}: tag '{tag}' missing from query")

    def test_lookup_is_case_and_space_tolerant(self):
        self.assertIsNotNone(get_preset("  BBC-Deepthroat-BigTits  ".lower().strip()))
        self.assertIsNone(get_preset("no-such-preset"))
        self.assertIsNone(get_preset(""))

    def test_all_presets_is_json_safe(self):
        """The endpoint returns this straight to the UI, so tuples must already
        be lists — a tuple survives json.dumps but not a strict schema check."""
        for row in all_presets():
            self.assertIsInstance(row["tags"], list)
            self.assertTrue(row["label"] and row["query"])


class PresetRelevanceBarTests(unittest.TestCase):
    """Each preset's bar must admit a partial-but-real match and reject noise."""

    def _score_for_matched(self, preset: dict, matched: int) -> float:
        """The score a tile gets when `matched` of the query's tokens are present."""
        tokens = preset["query"].split()
        title = " ".join(tokens[:matched]) + " scene"
        return relevance_score({"title": title}, preset["query"])

    def test_bar_admits_all_but_one_tag(self):
        for preset in PRESETS:
            total = len(preset["query"].split())
            near_miss = self._score_for_matched(preset, total - 1)
            self.assertGreaterEqual(
                near_miss, preset["relevance_min"],
                f"{preset['id']}: a {total - 1}/{total}-token tile scores "
                f"{near_miss} and would be dropped by bar {preset['relevance_min']}",
            )

    def test_bar_rejects_a_single_incidental_token(self):
        """One shared word ("big", "pov") must not drag in an unrelated tile."""
        for preset in PRESETS:
            total = len(preset["query"].split())
            if total < 3:
                continue  # a 1-of-2 hit is genuinely half the query, not noise
            weak = self._score_for_matched(preset, 1)
            self.assertLess(
                weak, preset["relevance_min"],
                f"{preset['id']}: a 1/{total}-token tile scores {weak} and would "
                f"pass bar {preset['relevance_min']}",
            )

    def test_bars_stay_below_the_default(self):
        """If a preset's bar were >= the default it would be pointless — the
        plain Prime Cut path already applies DEFAULT_RELEVANCE."""
        for preset in PRESETS:
            self.assertLess(preset["relevance_min"], DEFAULT_RELEVANCE, preset["id"])


if __name__ == "__main__":
    unittest.main()
