"""Controlled audit workloads, optionally against a saved source snapshot.

All HTTP uses MockTransport, all databases/cache are disposable. Collection
first is an experimental ordering patch, never a production policy switch.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch

import httpx

SETTINGS = {"transport_latency_seconds": .02, "guard": "production defaults",
            "graph_validation_budget": 6, "graph_request_budget": 6,
            "id_lengths": [8, 9, 10, 11, 12, 16, 64]}


async def run_case(case, order="priority"):
    from benchmark_discovery import fid, page
    from discovery import pool, web_sources
    from discovery.prioritize import Prioritizer
    from discovery.network import GuardedClient
    from discovery.web_extract import canonical_folder_url, normalize_folder_id
    from index.database import Database

    calls, attempts, observations = [], [], []
    first_useful = None
    start = time.perf_counter()
    lengths = SETTINGS["id_lengths"]
    short_ids = ["a" * length for length in lengths]
    known = ({fid(1), fid(2)} if case == "local_reuse" else
             {fid(4)} if case in {"collection_late", "content_first"} else set())
    pages = {}
    candidates = []
    budget = SETTINGS["graph_validation_budget"]
    recover = case == "local_reuse"
    if case == "id_lengths":
        # Link-free leaf pages avoid introducing unrelated 16-character fixture
        # IDs through page()'s pagination helper when testing short IDs.
        pages = {folder: f'<meta property="og:title" content="Length {len(folder)}"><meta property="og:description" content="with 2 files; 0 subfolders">' for folder in short_ids}
        budget = len(short_ids)
    elif case == "local_reuse":
        pages = {fid(2): page(2, 2), fid(3): page(3, 3)}
        budget = 1
    else:
        # Known collection is later than three dead leaves in the same arrival
        # order. In the control case those leaves are useful content instead.
        candidates = [1, 2, 3, 4]
        pages = {fid(n): page(n, 2) if case == "content_first" else 404 for n in (1, 2, 3)}
        pages[fid(4)] = page(4, links=[5, 6, 7, 8])
        pages.update({fid(n): page(n, 3) for n in (5, 6, 7, 8)})

    async def response(request):
        calls.append(str(request.url))
        await asyncio.sleep(SETTINGS["transport_latency_seconds"])
        if request.url.host == "text.is":
            return httpx.Response(200, text="\n".join(canonical_folder_url(folder) for folder in short_ids))
        body = pages[normalize_folder_id(str(request.url))]
        return httpx.Response(body if isinstance(body, int) else 200,
                              text=body if isinstance(body, str) else "", headers={"Content-Type": "text/html"})

    original_client = httpx.AsyncClient
    original_validate = pool.validate_folder
    def client_factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(response)
        return original_client(*args, **kwargs)
    async def validate(client, folder):
        nonlocal first_useful
        attempts.append(folder)
        result = await original_validate(client, folder)
        observations.append((folder, result.folder_type))
        if result.folder_type == "CONTENT_FOLDER" and folder not in known and first_useful is None:
            first_useful = time.perf_counter() - start
        return result

    with tempfile.TemporaryDirectory(prefix="filester-audit-bench-") as tmp:
        with patch.dict(os.environ, {"FILESTER_DATA_DIR": tmp}), patch("httpx.AsyncClient", client_factory), patch.object(pool, "validate_folder", validate), patch.object(pool, "PRIOR", Prioritizer()):
            db = Database(Path(tmp)/"index.db")
            try:
                if case == "id_lengths":
                    async with GuardedClient() as client:
                        hits = await web_sources.collect_public_hubs(client, limit=20)
                    await pool.ingest_hits_to_db(db, hits)
                elif case == "local_reuse":
                    parent = canonical_folder_url(fid(1))
                    db.upsert_page({"url": parent, "folder_id": fid(1), "kind": "folder", "is_collection": True, "http_status": 200})
                    db.upsert_page({"url": canonical_folder_url(fid(2)), "folder_id": fid(2), "kind": "folder", "file_count": 2, "http_status": 200})
                    for index in range(8):
                        db.add_link(parent, f"https://filester.sh/f/{fid(2).upper()}?page={index+1}")
                    db.add_link(parent, f"https://filester.sh/f/{fid(3).upper()}?page=1")
                else:
                    for n in candidates:
                        db.upsert_candidate(fid(n), ["urlscan"], ["fixture"], score=.35)
                    db._conn.executemany("UPDATE candidates SET first_seen=? WHERE folder_id=?", [(n, fid(n)) for n in candidates])
                    db._conn.commit()
                    # A prior successful page marks the known collection. It
                    # stays an unvalidated candidate so the ordering can act.
                    db.upsert_page({"url": canonical_folder_url(fid(4)), "folder_id": fid(4), "kind": "folder", "is_collection": True, "http_status": 200})

                original_list = db.list_candidates
                def collection_first(*args, **kwargs):
                    rows = original_list(*args, **kwargs)
                    hubs = {row[0] for row in db._conn.execute("SELECT folder_id FROM pages WHERE is_collection=1 AND http_status=200")}
                    return sorted(rows, key=lambda row: row["folder_id"] not in hubs)
                with patch.object(db, "list_candidates", collection_first if order == "collection_first" else original_list):
                    result = await pool.validate_pool(db, budget=budget, request_budget=budget,
                                                     recover_local=recover, max_new_candidates=1 if recover else 100,
                                                     order="priority" if order == "collection_first" else order)
                useful = sum(folder not in known and kind == "CONTENT_FOLDER" for folder, kind in observations)
                rows = list(db._conn.execute("SELECT folder_id FROM candidates"))
                assert len(attempts) == len(set(attempts))
                assert len(attempts) <= budget
                assert len(calls) <= budget + int(case == "id_lengths")
                workload = {"pages": pages, "candidates": candidates, "known": sorted(known), "settings": SETTINGS, "case": case}
                return {"case": case, "order": order,
                        "workload_sha256": hashlib.sha256(json.dumps(workload, sort_keys=True).encode()).hexdigest(),
                        "unique_new_valid_ids": len({row[0] for row in rows} - known),
                        "validated_CONTENT_FOLDER": result["CONTENT"], "new_validated_CONTENT_FOLDER": useful,
                        "network_requests": len(calls), "requests_per_CONTENT": len(calls)/result["CONTENT"] if result["CONTENT"] else None,
                        "requests_per_new_CONTENT": len(calls)/useful if useful else None,
                        "duplicate_validation_attempts": len(attempts)-len(set(attempts)),
                        "duplicates_suppressed": result["duplicates_suppressed"],
                        "known_content_requests": sum(folder in known and kind == "CONTENT_FOLDER" for folder, kind in observations),
                        "first_useful_seconds": first_useful, "total_seconds": time.perf_counter()-start,
                        "attempts": attempts, "requests": calls}
            finally:
                db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).parent)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    sys.path.insert(0, str(args.source_root.resolve()))
    runs = []
    for case in ("id_lengths", "local_reuse", "collection_late", "content_first"):
        for order in (["priority"] if case in {"id_lengths", "local_reuse"} else ["fifo", "priority", "collection_first"]):
            for _ in range(args.repeats):
                runs.append(asyncio.run(run_case(case, order)))
    report = {"settings": SETTINGS, "dataset_sha256": hashlib.sha256(json.dumps(SETTINGS, sort_keys=True).encode()).hexdigest(), "runs": runs}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    print(f"Saved {len(runs)} mocked runs to {args.output}")
