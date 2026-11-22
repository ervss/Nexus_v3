"""Regression tests for the Fusion Hub metadata filler (quality / size / date).

Two things here are easy to break and invisible when broken:

  * date normalisation — adapters report `added` or `upload_date`, ISO or
    "9 months ago". If the relative branch regresses, the grid silently sorts
    half its cards to the bottom instead of erroring.
  * the size fallback's *bookkeeping* — a card whose source can never report a
    size must end up flagged `impossible`, not left blank. A blank field is
    indistinguishable from "still loading", so the progress bar would never
    honestly reach its total.
"""
import unittest
from datetime import date

from app.hubs.metafill import SIZE_IMPOSSIBLE, fill_missing, normalise_date


class _FakeAdapter:
    """Minimal stand-in; `resolve` is what the size fallback reaches for."""

    def __init__(self, source="fake", stream=None, is_hls=False, origin="https://fake.tld"):
        self.source = source
        self.origin = origin
        self._stream = stream
        self._is_hls = is_hls
        self.resolve_calls = 0

    async def resolve(self, url):
        self.resolve_calls += 1
        return {"stream_url": self._stream, "is_hls": self._is_hls}


class _NoResolver:
    source = "fake"
    origin = "https://fake.tld"


class NormaliseDateTests(unittest.TestCase):
    TODAY = date(2026, 8, 2)

    def test_iso_passes_through(self):
        self.assertEqual(normalise_date("2024-02-14", today=self.TODAY), "2024-02-14")
        self.assertEqual(normalise_date("2026-08-02T10:00:00Z", today=self.TODAY), "2026-08-02")

    def test_relative_is_resolved_against_today(self):
        cases = {
            "22 hours ago": "2026-08-02",
            "3 days ago": "2026-07-30",
            "1 week ago": "2026-07-26",
            "1 year ago": "2025-08-02",
        }
        for text, expected in cases.items():
            self.assertEqual(normalise_date(text, today=self.TODAY), expected, text)

    def test_named_month_forms(self):
        self.assertEqual(normalise_date("Jun 7, 2026", today=self.TODAY), "2026-06-07")
        self.assertEqual(normalise_date("7 June 2026", today=self.TODAY), "2026-06-07")

    def test_unreadable_yields_empty_not_a_guess(self):
        for junk in ("", None, "garbage", "soon"):
            self.assertEqual(normalise_date(junk, today=self.TODAY), "")

    def test_date_objects_are_accepted(self):
        self.assertEqual(normalise_date(date(2025, 1, 9)), "2025-01-09")


class FillMissingTests(unittest.IsolatedAsyncioTestCase):
    async def test_date_is_normalised_and_mirrored_to_both_keys(self):
        adapter = _FakeAdapter()
        results = {"u1": {"added": "9 months ago"}}
        out = await fill_missing(adapter, results, want_size=False)
        # Both keys carry it: the UI reads `added`, newer adapters write
        # `upload_date`, and neither should have to know about the other.
        self.assertEqual(out["u1"]["upload_date"], out["u1"]["added"])
        self.assertRegex(out["u1"]["added"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertEqual(out["u1"]["date_basis"], "source")

    async def test_listing_date_is_used_when_enrich_omits_it(self):
        adapter = _FakeAdapter()
        results = {"u1": {}}
        out = await fill_missing(adapter, results, want_size=False,
                                 tiles={"u1": {"added": "2024-02-14"}})
        self.assertEqual(out["u1"]["added"], "2024-02-14")

    async def test_impossible_source_is_flagged_not_probed(self):
        source = next(iter(SIZE_IMPOSSIBLE))
        adapter = _FakeAdapter(source=source, stream="https://cdn.tld/a.mp4")
        out = await fill_missing(adapter, {"u1": {}}, want_size=True)
        self.assertEqual(out["u1"]["size_basis"], "impossible")
        self.assertTrue(out["u1"]["size_note"])
        # The whole point of the table: do not pay for a probe that cannot work.
        self.assertEqual(adapter.resolve_calls, 0)

    async def test_existing_size_is_kept_and_labelled(self):
        adapter = _FakeAdapter(stream="https://cdn.tld/a.mp4")
        out = await fill_missing(adapter, {"u1": {"size_mb": 512.0}}, want_size=True)
        self.assertEqual(out["u1"]["size_mb"], 512.0)
        self.assertEqual(out["u1"]["size_basis"], "source")
        self.assertEqual(adapter.resolve_calls, 0)

    async def test_hls_stream_reports_unavailable_rather_than_a_wrong_number(self):
        adapter = _FakeAdapter(stream="https://cdn.tld/master.m3u8", is_hls=True)
        out = await fill_missing(adapter, {"u1": {}}, want_size=True)
        self.assertEqual(out["u1"]["size_basis"], "unavailable")
        self.assertIsNone(out["u1"].get("size_mb"))

    async def test_urls_seed_rows_for_adapters_with_no_enrich(self):
        """Adapters without enrich() return {} — without seeding, the fallback
        would have nothing to iterate and the card would stay blank forever."""
        adapter = _FakeAdapter(source=next(iter(SIZE_IMPOSSIBLE)))
        out = await fill_missing(adapter, {}, want_size=True, urls=["u1", "u2"])
        self.assertEqual(set(out), {"u1", "u2"})

    async def test_missing_resolver_is_reported_not_retried(self):
        out = await fill_missing(_NoResolver(), {"u1": {}}, want_size=True)
        self.assertEqual(out["u1"]["size_basis"], "impossible")

    async def test_want_size_false_leaves_sizes_untouched(self):
        adapter = _FakeAdapter(stream="https://cdn.tld/a.mp4")
        out = await fill_missing(adapter, {"u1": {}}, want_size=False)
        self.assertNotIn("size_basis", out["u1"])
        self.assertEqual(adapter.resolve_calls, 0)


if __name__ == "__main__":
    unittest.main()
