"""Offline OLD/NEW benchmark. Run the SAME file against either source tree.

Uses real parser, collectors, SQLite, pool and HTTP guard, with MockTransport.
No external traffic. Wall times include real host pacing, TLS setup and SQLite.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import inspect
import json
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import httpx


def fid(n):
    return f"abcd{n:012x}"


def page(n, files=0, links=()):
    return (f'<meta property="og:title" content="Fixture {n}">'
            f'<meta property="og:description" content="with {files} files; {len(set(links))} subfolders">'
            + ''.join(f'<a href="/f/{fid(i)}">folder</a>' for i in links)
            + (f'<a href="/f/{fid(n)}?page=2">Next</a>' if files else ''))


PAGES = {
    1: page(1, links=[13, 14, 15, 13, 1]),
    2: page(2, 3),
    3: page(3),
    **{n: 404 for n in range(4, 10)},
    10: "timeout", 11: 503, 12: 429,
    13: page(13, links=[1, 16, 17, 18]),
    14: page(14, 4, [1]), 15: page(15, 2, [1]),
    16: page(16, 5, [13]), 17: page(17, 2, [13]),
    18: page(18, links=[13, 19]), 19: page(19, 6, [18]),
    21: page(21, 7), 22: page(22, 8),
}
SETTINGS = {"validation_budget": 12, "request_budget": 15,
            "seed_queries": ["page.domain:filester.me", "fixture wayback"],
            "transport_latency_seconds": .02, "guard": "production defaults"}
INITIAL_LINKS = [(20, 21), (20, 22)]


async def run(order, recover_local=True):
    from discovery import pool, web_sources
    from discovery.network import GuardedClient
    from discovery.web_extract import extract_folder_ids
    from index.database import Database
    calls, attempts, observations = [], [], []
    first_content = None
    start = time.perf_counter()

    async def response(request):
        if len(calls) >= SETTINGS["request_budget"]:
            raise AssertionError("request budget exceeded")
        calls.append(str(request.url))
        await asyncio.sleep(SETTINGS["transport_latency_seconds"])
        if request.url.host == "urlscan.io":
            nums = list(range(1, 11)) * 10 if "search_after" not in request.url.params else [11, 12]
            return httpx.Response(200, json={"results": [
                {"page": {"url": f"https://filester.me/f/{fid(n)}"}, "sort": [100-i, str(i)]}
                for i, n in enumerate(nums)]})
        if request.url.host == "web.archive.org":
            return httpx.Response(200, text=f'https://filester.me/f/{fid(1)}')
        n = int(request.url.path.rsplit('/', 1)[1][4:], 16)
        body = PAGES[n]
        if body == "timeout":
            raise httpx.ReadTimeout("fixture timeout", request=request)
        if isinstance(body, int):
            return httpx.Response(body, headers={"Retry-After": "60"} if body == 429 else {})
        return httpx.Response(200, text=body, headers={"Content-Type": "text/html"})

    original_client = httpx.AsyncClient
    original_validate = pool.validate_folder
    def client_factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(response)
        return original_client(*args, **kwargs)
    async def validate(client, folder_id):
        nonlocal first_content
        attempts.append(folder_id)
        result = await original_validate(client, folder_id)
        if result.folder_type == "CONTENT_FOLDER" and first_content is None:
            first_content = time.perf_counter() - start
        observations.append((folder_id, result.folder_type))
        return result

    with tempfile.TemporaryDirectory(prefix="filester-discovery-bench-") as tmp:
        with patch.dict("os.environ", {"FILESTER_DATA_DIR": tmp}), patch("httpx.AsyncClient", client_factory), patch.object(pool, "validate_folder", validate):
            db = Database(Path(tmp) / "index.db")
            try:
                # Historical crawler evidence available to BOTH implementations.
                parent_url = f"https://filester.me/f/{fid(20)}"
                db.upsert_page({"url": parent_url, "folder_id": fid(20), "kind": "folder",
                                "is_collection": True, "http_status": 200, "depth": 0})
                for _, n in INITIAL_LINKS:
                    db.add_link(parent_url, f"https://filester.me/f/{fid(n)}")
                async with GuardedClient(ttl=1800) as client:
                    hits = await web_sources.collect_urlscan(client, limit=12)
                    extra = await client.get("https://web.archive.org/fixture")
                    hits += [web_sources.Hit(i, "wayback_cdx", str(extra.url), "fixture", "fixture wayback")
                             for i in extract_folder_ids(extra.text)]
                # Replay completed-source callbacks as happens in the API.
                for source in ("urlscan", "wayback_cdx"):
                    await pool.ingest_hits_to_db(db, [h for h in hits if h.source_name == source])
                await pool.ingest_hits_to_db(db, hits)
                # Stable arrival order, independent of wall-clock resolution and
                # SQLite's unspecified order when first_seen values tie.
                db._conn.executemany("UPDATE candidates SET first_seen=? WHERE folder_id=?",
                                     [(1000+n, fid(n)) for n in range(1, 13)])
                db._conn.commit()
                kwargs = {"recover_local": recover_local} if "recover_local" in inspect.signature(pool.validate_pool).parameters else {}
                result = await pool.validate_pool(db, budget=SETTINGS["validation_budget"], order=order, **kwargs)
                rows = list(db._conn.execute("SELECT * FROM candidates"))
                seeds = {h.folder_id for h in hits}
                local = {r["folder_id"] for r in rows if "existing_index" in json.loads(r["sources"] or "[]")}
                snowball = {r["folder_id"] for r in rows} - seeds - local
                elapsed = time.perf_counter() - start
                metrics = {
                    "unique_candidates": len(rows), "new_candidates": len(rows),
                    "validated": result["validated"], "CONTENT": result["CONTENT"],
                    "COLLECTION": result["COLLECTION"], "snowball_candidates": len(snowball),
                    "local_candidates": len(local),
                    "snowball_CONTENT": sum(i in snowball and t == "CONTENT_FOLDER" for i, t in observations),
                    "max_discovery_depth": max((r["discovery_depth"] for r in rows), default=0) if rows and "discovery_depth" in rows[0].keys() else 0,
                    "duplicates_suppressed": len(hits)*2-len(seeds)+result.get("duplicates_suppressed", 0),
                    "network_requests": len(calls), "requests_per_CONTENT": round(len(calls)/result["CONTENT"], 3) if result["CONTENT"] else None,
                    "deferred": result["deferred"], "DEAD": result["DEAD"],
                    "first_content_seconds": round(first_content, 3) if first_content is not None else None,
                    "total_seconds": round(elapsed, 3),
                }
                assert len(attempts) <= SETTINGS["validation_budget"]
                assert len(attempts) == len(set(attempts)), "duplicate validation"
                dataset = {"pages": PAGES, "initial_links": INITIAL_LINKS, "settings": SETTINGS}
                return {"settings": SETTINGS, "dataset_sha256": hashlib.sha256(json.dumps(dataset, sort_keys=True).encode()).hexdigest(),
                        "order": order, "recover_local": recover_local, "metrics": metrics, "attempts": attempts, "requests": calls}
            finally:
                db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).parent)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--order", choices=["priority", "fifo"], default="priority")
    parser.add_argument("--no-local", action="store_true")
    args = parser.parse_args()
    sys.path.insert(0, str(args.source_root.resolve()))
    report = asyncio.run(run(args.order, not args.no_local))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["metrics"], indent=2))
