"""Regression coverage for Faphouse's HLS-only size handling."""

import asyncio

from app.hubs.metafill import fill_missing


class _FaphouseAdapter:
    source = "faphouse"

    async def resolve(self, url: str) -> dict:  # pragma: no cover - must not run
        raise AssertionError("Faphouse HLS cards must not be resolved just for size")


def test_faphouse_skips_size_resolution_for_hls_cards():
    results = asyncio.run(
        fill_missing(
            _FaphouseAdapter(),
            {"https://faphouse.com/videos/example-abc": {"duration_sec": 120}},
        )
    )

    assert results["https://faphouse.com/videos/example-abc"] == {
        "duration_sec": 120,
        "size_basis": "impossible",
        "size_note": "HLS stream — nemá jeden súbor",
        "orientation": "unknown",
        "orientation_evidence": "unknown",
    }
