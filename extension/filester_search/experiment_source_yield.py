"""Measure whether expanded collectors find IDs beyond the saturated wayback+urlscan pool.

Does NOT write to the production index — read-only against known folder IDs.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from pathlib import Path

from discovery.web_sources import run_collectors

DESK = Path.home() / "Desktop" / "Filester Search Data"
DB = DESK / "filester_index.db"


def known_ids() -> set[str]:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT folder_id FROM candidates UNION SELECT folder_id FROM pages WHERE folder_id IS NOT NULL"
    )
    return {r[0] for r in rows if r[0]}


async def measure(label: str, sources: list[str], keywords: list[str]) -> dict:
    t0 = time.perf_counter()
    hits = await run_collectors(
        sources=sources,
        per_source_limit=120,
        keywords=keywords,
        source_timeout=20.0,
    )
    elapsed = round(time.perf_counter() - t0, 2)
    ids = {h.folder_id for h in hits}
    known = known_ids()
    by_source: dict[str, set[str]] = {}
    for h in hits:
        by_source.setdefault(h.source_name, set()).add(h.folder_id)
    new_ids = ids - known
    return {
        "label": label,
        "sources": sources,
        "seconds": elapsed,
        "hits": len(hits),
        "unique": len(ids),
        "new_vs_index": len(new_ids),
        "already_known": len(ids & known),
        "per_source": {
            name: {
                "unique": len(fids),
                "new": len(fids - known),
            }
            for name, fids in sorted(by_source.items())
        },
    }


async def main():
    keywords = ["videos", "porn", "random"]
    baseline = await measure("baseline", ["wayback", "urlscan"], keywords)
    expanded = await measure(
        "expanded",
        ["wayback", "urlscan", "commoncrawl", "duckduckgo_html", "bing_html"],
        keywords,
    )
    print(json.dumps({"baseline": baseline, "expanded": expanded}, indent=2))
    delta = expanded["new_vs_index"] - baseline["new_vs_index"]
    print(
        f"\nDELTA new_vs_index: {delta:+d} "
        f"(baseline {baseline['new_vs_index']} -> expanded {expanded['new_vs_index']})"
    )


if __name__ == "__main__":
    asyncio.run(main())
