
from __future__ import annotations
"""Scale validation + A/B on persisted candidate pool. No rediscovery required."""

import asyncio
import json
import logging
import random
import sqlite3
import sys
import time
import uuid

from discovery.prioritize import PRIOR
from discovery.validate import validate_folder
from discovery.network import GuardedClient
from discovery.web_extract import normalize_folder_id, canonical_folder_url
from index.database import Database

logger = logging.getLogger("filester.pool")


def _safe_console(message: object) -> None:
    """Write diagnostics without letting a legacy Windows code page stop work."""
    stream = sys.stdout
    encoding = getattr(stream, "encoding", None) or "utf-8"
    text = str(message)
    try:
        safe = text.encode(encoding, errors="backslashreplace").decode(encoding)
        print(safe, file=stream, flush=True)
    except (OSError, UnicodeError):
        # Logging receives ASCII only, so even a broken/reconfigured console
        # cannot turn an optional progress line into a failed discovery job.
        logger.info("%s", text.encode("ascii", errors="backslashreplace").decode("ascii"))


def _feedback_adjusted_candidates(db: Database, rows):
    try:
        feedback = db._conn.execute(
            """SELECT p.source,AVG(n.relevance) AS average,COUNT(*) AS votes
               FROM pages p JOIN bridge_notes n ON n.url=p.url
               WHERE n.relevance IN (-1,1) AND p.source LIKE 'web:%'
               GROUP BY p.source HAVING COUNT(*)>=3"""
        ).fetchall()
    except sqlite3.OperationalError:
        return rows
    preferences = {
        str(row["source"]).removeprefix("web:").lower(): float(row["average"])
        for row in feedback
    }
    if not preferences:
        return rows

    def adjusted_score(row):
        try:
            sources = json.loads(row["sources"] or "[]")
        except (TypeError, json.JSONDecodeError):
            sources = []
        boosts = [preferences[source.lower()] * 12 for source in sources if source.lower() in preferences]
        return float(row["score"] or 0) + (sum(boosts) / len(boosts) if boosts else 0)

    return sorted(rows, key=adjusted_score, reverse=True)


async def ingest_hits_to_db(db: Database, hits) -> int:
    """Merge provenance even for validated/claimed IDs; return actual inserts."""
    from collections import defaultdict
    by_id = defaultdict(list)
    for hit in hits:
        fid = normalize_folder_id(hit.folder_id)
        if fid:
            by_id[fid].append(hit)
    inserted = 0
    for fid, hits_for_id in by_id.items():
        if db.is_folder_excluded(fid):
            continue
        sources = list(dict.fromkeys(h.source_name for h in hits_for_id))
        qcs = list(dict.fromkeys(h.query_class for h in hits_for_id))
        ts = next((h.external_ts for h in hits_for_id if h.external_ts), "")
        inserted += db.upsert_candidate(fid, sources, qcs, external_ts=ts)
        row = db._conn.execute("SELECT * FROM candidates WHERE folder_id=?", (fid,)).fetchone()
        merged_sources = json.loads(row["sources"])
        # Graph relation labels are not independent external observations.
        independent = [s for s in merged_sources if s not in {"snowball", "outbound", "collection"}]
        score = PRIOR.score_candidate(
            sources=independent, query_classes=json.loads(row["query_classes"]),
            external_ts=row["external_ts"], independent_source_count=len(independent),
        )
        with db.tx() as conn:
            conn.execute("UPDATE candidates SET score=MAX(score,?) WHERE folder_id=?", (score, fid))
    return inserted


def seed_local_frontier(db: Database, limit: int, max_depth: int) -> int:
    """Reuse captured graph edges and unexpanded hubs; no network requests.

    Previously indexed live content is not revalidated. Stored links preserve
    the parent URL, and successful candidate state is never reset.
    """
    if limit <= 0:
        return 0
    # Match identity, not stored URL spelling: legacy edges can include mirror
    # hosts, uppercase IDs, trailing slashes, pagination and fragments.
    live_ids = {
        fid for row in db._conn.execute("SELECT folder_id,url FROM pages WHERE http_status=200")
        if (fid := normalize_folder_id(row["folder_id"] or row["url"]))
    }
    evidence = db._conn.execute("""
        SELECT l.dst_url AS url,COALESCE(p.depth,0)+1 AS depth,
               COALESCE(p.is_collection,0) AS collection,0 AS unexpanded_hub
        FROM links l LEFT JOIN pages p ON p.url=l.src_url
        WHERE l.link_type='folder'
          AND NOT EXISTS (SELECT 1 FROM pages known WHERE known.url=l.dst_url AND known.http_status=200)
          AND NOT EXISTS (SELECT 1 FROM candidates c
                          WHERE c.folder_id=LOWER(RTRIM(SUBSTR(l.dst_url,INSTR(l.dst_url,'/f/')+3),'/')))
        UNION ALL
        SELECT p.url,0,1,1 FROM pages p
        WHERE p.kind='folder' AND p.is_collection=1 AND p.http_status=200
          AND NOT EXISTS (SELECT 1 FROM links l WHERE l.src_url=p.url)
          AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.folder_id=p.folder_id)
        ORDER BY collection DESC,depth ASC,url ASC LIMIT 10000
    """)
    inserted = 0
    for row in evidence:
        fid = normalize_folder_id(row["url"])
        if not fid or row["depth"] > max_depth:
            continue
        if (fid in live_ids and not row["unexpanded_hub"]) or db._conn.execute(
            "SELECT 1 FROM candidates WHERE folder_id=?", (fid,)
        ).fetchone():
            continue
        sources = ["existing_index", "collection" if row["collection"] else "outbound"]
        inserted += db.upsert_candidate(fid, sources, ["graph"], score=.6,
                                        discovery_depth=row["depth"])
        if inserted >= limit:
            break
    return inserted


async def validate_pool(
    db: Database,
    *,
    budget: int = 50,
    order: str = "priority",
    arm_label: str = "",
    on_progress=None,
    max_depth: int = 3,
    max_new_candidates: int = 1000,
    request_budget: int | None = None,
    seen: set[str] | None = None,
    graph_priority: bool = True,
    recover_local: bool = True,
    preferred_ids: set[str] | None = None,
    allow_unpreferred: bool = True,
) -> dict:
    """Bounded live frontier; two workers, atomic leases and no in-run retries.

    The caller can share `seen` between validation waves of one discovery job.
    Outbound evidence is persisted in links and candidate sources. Depth and
    frontier caps apply before inserts; candidates left over survive restart.
    """
    if budget < 0 or max_depth < 0 or max_new_candidates < 0:
        raise ValueError("discovery budgets must be non-negative")
    if order not in {"priority", "fifo", "random"}:
        raise ValueError("unknown validation order")
    request_budget = budget if request_budget is None else max(0, request_budget)
    seen = seen if seen is not None else set()
    token = uuid.uuid4().hex
    started = time.perf_counter()
    first_content = None
    counts = {k: 0 for k in ("CONTENT_FOLDER", "MIXED", "COLLECTION", "DEAD", "ERROR", "UNKNOWN")}
    validated = processed = deferred = new_candidates = duplicates = snowball_content = 0
    preferred_validated = backlog_validated = 0
    max_seen_depth = 0
    attempted_ids = []
    processed_ids = set()
    local_candidates = seed_local_frontier(db, max_new_candidates, max_depth) if recover_local and budget and request_budget else 0

    def report():
        if on_progress:
            on_progress({"processed": processed, "validated": validated,
                         "content": counts["CONTENT_FOLDER"], "errors": deferred, "total": budget})

    async with GuardedClient(
        headers={"User-Agent": "FilesterPublicIndexer/8.0 (+pool-validate)"},
        max_requests=request_budget,
    ) as client:
        async def validate_one(row):
            nonlocal processed, validated, deferred, new_candidates, duplicates
            nonlocal first_content, snowball_content, max_seen_depth
            nonlocal preferred_validated, backlog_validated
            fid = row["folder_id"]
            v = await validate_folder(client, fid)
            processed += 1
            processed_ids.add(fid)
            counts[v.folder_type] += 1
            depth = row["discovery_depth"]
            max_seen_depth = max(max_seen_depth, depth)
            if v.folder_type == "ERROR":
                deferred += 1
                db.defer_candidate(fid, 60 if v.http_status in (0, 401, 403, 429) else 30)
                report()
                return
            validated += 1
            if preferred_ids is not None and fid in preferred_ids:
                preferred_validated += 1
            else:
                backlog_validated += 1
            # Read again: a collector may have merged provenance during GET.
            current = db._conn.execute("SELECT * FROM candidates WHERE folder_id=?", (fid,)).fetchone()
            srcs = json.loads(current["sources"] or "[]")
            qcs = json.loads(current["query_classes"] or "[]")
            PRIOR.observe(source=srcs[0] if srcs else "unknown",
                          query_class=qcs[0] if qcs else "unknown",
                          age_bucket=PRIOR.age_bucket(current["external_ts"] or ""),
                          folder_type=v.folder_type)
            if v.folder_type in {"CONTENT_FOLDER", "COLLECTION", "MIXED"}:
                db.upsert_page({
                    "url": v.url, "folder_id": fid, "kind": "folder", "title": v.title,
                    "description": f"pool type={v.folder_type}", "file_count": v.file_count,
                    "filenames": v.filenames, "file_meta": v.file_meta, "thumb_ids": v.thumb_ids,
                    "out_degree": v.subfolder_count, "is_collection": v.folder_type == "COLLECTION",
                    "http_status": v.http_status, "depth": depth,
                    "source": f"web:{srcs[0] if srcs else 'pool'}",
                    "content_hash": f"pool:{fid}:{v.file_count}:{v.folder_type}",
                })
            if v.folder_type == "CONTENT_FOLDER":
                if first_content is None:
                    first_content = time.perf_counter() - started
                snowball_content += int(depth > 0 and "snowball" in srcs and "existing_index" not in srcs)
                _safe_console(f"+{arm_label} {v.title[:30]:30} {v.file_count:5} {v.subfolder_count:3} {v.url}")
            if depth < max_depth and v.folder_type in {"CONTENT_FOLDER", "COLLECTION", "MIXED"}:
                # The parser already deduplicates links; keep this boundary
                # defensive for alternate validators and old stored inputs.
                links_seen = set()
                for raw in v.outbound_folders:
                    child = normalize_folder_id(raw)
                    if not child:
                        continue
                    if child == fid or child in links_seen:
                        duplicates += 1
                        continue
                    links_seen.add(child)
                    existing = db._conn.execute("SELECT status FROM candidates WHERE folder_id=?", (child,)).fetchone()
                    if existing:
                        duplicates += 1
                    elif new_candidates+local_candidates >= max_new_candidates:
                        continue
                    relation = "collection" if v.folder_type == "COLLECTION" else "outbound"
                    # Fixed evidence bonus, diminishing with depth. Do not
                    # learn from graph labels as if they were external sources.
                    score = .35 + (.25 / (depth+1) if graph_priority else 0)
                    inserted = db.upsert_candidate(child, ["snowball", relation], ["graph"],
                                                   score=score, discovery_depth=depth+1)
                    new_candidates += int(inserted)
                    if preferred_ids is not None:
                        preferred_ids.add(child)
                    db.add_link(v.url, canonical_folder_url(child), "folder")
            # Mark only after persistence, so an interrupted write can be retried.
            db.mark_candidate(fid, "validated", v.folder_type, v.title, v.file_count, v.subfolder_count)
            report()

        workers = {}
        try:
            while True:
                available = min(2-len(workers), budget-len(attempted_ids),
                                request_budget-client.network_requests)
                rows = db.list_candidates(limit=10000, order_by_score=(order == "priority"), ready_only=True) if available > 0 else []
                if order == "priority":
                    rows = _feedback_adjusted_candidates(db, rows)
                elif order == "random":
                    random.shuffle(rows)
                if preferred_ids is not None:
                    # Stable partition keeps the existing deterministic score/FIFO
                    # order inside each group while moving this job's graph first.
                    rows = sorted(rows, key=lambda row: row["folder_id"] not in preferred_ids)
                    if not allow_unpreferred:
                        rows = [row for row in rows if row["folder_id"] in preferred_ids]
                selected = []
                batch_limit = available
                for row in rows:
                    fid = row["folder_id"]
                    if fid in seen:
                        continue
                    if normalize_folder_id(fid) is None:
                        db.mark_candidate(fid, "blocked", "DEAD")
                        continue
                    if db.claim_candidate(fid, token):
                        seen.add(fid)
                        attempted_ids.append(fid)
                        selected.append(row)
                    if len(selected) >= batch_limit:
                        break
                for row in selected:
                    task = asyncio.create_task(validate_one(row))
                    workers[task] = row["folder_id"]
                if not workers:
                    break
                # Refill each free worker promptly. Selection is deterministic
                # for the currently available frontier, regardless of GET order.
                done, _ = await asyncio.wait(workers, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    fid = workers.pop(task)
                    try:
                        task.result()
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        # A malformed page, diagnostic failure, or unexpected
                        # parser/DB edge case belongs to this candidate only.
                        # Keep the rest of the bounded pool running and make
                        # the candidate safely retryable after a short delay.
                        if fid not in processed_ids:
                            processed += 1
                            processed_ids.add(fid)
                        deferred += 1
                        counts["ERROR"] += 1
                        db.defer_candidate(fid, 60)
                        safe_error = str(exc).encode("ascii", errors="backslashreplace").decode("ascii")
                        logger.exception("candidate validation failed fid=%s error=%s", fid, safe_error)
                        report()
        finally:
            for task in workers:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
            db.release_claims(token)

    return {
        "arm": order, "budget": budget, "validated": validated, "processed": processed,
        "deferred": deferred, "CONTENT": counts["CONTENT_FOLDER"],
        **{k: counts[k] for k in ("MIXED", "COLLECTION", "DEAD", "ERROR", "UNKNOWN")},
        "content_per_validation": round(counts["CONTENT_FOLDER"] / max(1, validated), 3),
        "dead_per_validation": round(counts["DEAD"] / max(1, validated), 3),
        "new_candidates": new_candidates+local_candidates, "snowball_candidates": new_candidates,
        "local_candidates": local_candidates,
        "preferred_validated": preferred_validated,
        "backlog_validated": backlog_validated,
        "snowball_CONTENT": snowball_content, "max_discovery_depth": max_seen_depth,
        "duplicates_suppressed": duplicates, "network_requests": client.network_requests,
        "requests_per_CONTENT": round(client.network_requests / counts["CONTENT_FOLDER"], 3) if counts["CONTENT_FOLDER"] else None,
        "first_content_seconds": first_content, "total_seconds": time.perf_counter()-started,
        "pool": db.candidate_stats(),
    }


async def ab_test_pool(db: Database, budget: int = 50) -> dict:
    """
    Fair A/B: split unvalidated pool into two equal halves by shuffle,
    assign arm A=FIFO order within half, B=priority order within half.
    Same budget each side, no shared validation.
    """
    rows = list(db.list_candidates(status="unvalidated", limit=10000, order_by_score=False))
    random.shuffle(rows)
    half = len(rows) // 2
    # Temporarily we validate from full pool with different orderings on disjoint ID sets
    set_a = {r["folder_id"] for r in rows[:half]}
    set_b = {r["folder_id"] for r in rows[half:]}

    # Build ordered lists
    fifo_a = [r for r in rows if r["folder_id"] in set_a][:budget]
    prio_all = db.list_candidates(status="unvalidated", limit=10000, order_by_score=True)
    prio_b = [r for r in prio_all if r["folder_id"] in set_b][:budget]

    async def _run_list(selected, label, order_name):
        # reuse validate logic on explicit list by temporarily marking others
        counts = {"CONTENT_FOLDER": 0, "MIXED": 0, "COLLECTION": 0, "DEAD": 0, "ERROR": 0, "UNKNOWN": 0}
        validated = 0
        async with GuardedClient(
            headers={"User-Agent": "FilesterPublicIndexer/8.0 (+ab)"},
            max_requests=budget,
        ) as client:
            for row in selected:
                fid = row["folder_id"]
                v = await validate_folder(client, fid)
                validated += 1
                counts[v.folder_type] = counts.get(v.folder_type, 0) + 1
                if v.folder_type == "ERROR":
                    db.defer_candidate(fid, 60)
                    continue
                db.mark_candidate(fid, "validated", v.folder_type, v.title, v.file_count, v.subfolder_count)
                if v.folder_type == "CONTENT_FOLDER":
                    db.upsert_page({
                        "url": v.url, "folder_id": fid, "kind": "folder", "title": v.title,
                        "file_count": v.file_count, "out_degree": v.subfolder_count,
                        "filenames": v.filenames, "file_meta": v.file_meta, "thumb_ids": v.thumb_ids,
                        "is_collection": False, "http_status": v.http_status,
                        "source": f"ab:{label}", "content_hash": f"ab:{fid}",
                    })
                    _safe_console(f"+[{label}] {v.title[:28]:28} {v.file_count:5} {v.url}")
                await asyncio.sleep(0.3)
        return {
            "arm": order_name,
            "validated": validated,
            "CONTENT": counts.get("CONTENT_FOLDER", 0),
            "MIXED": counts.get("MIXED", 0),
            "COLLECTION": counts.get("COLLECTION", 0),
            "DEAD": counts.get("DEAD", 0),
            "ERROR": counts.get("ERROR", 0),
            "content_per_request": round(counts.get("CONTENT_FOLDER", 0) / max(1, validated), 3),
            "dead_per_request": round(counts.get("DEAD", 0) / max(1, validated), 3),
        }

    print(f"\n=== A/B pool split: {len(set_a)} vs {len(set_b)} IDs, budget={budget} each ===\n")
    print("--- FIFO arm ---", flush=True)
    a = await _run_list(fifo_a, "FIFO", "fifo")
    print("\n--- PRIORITY arm ---", flush=True)
    b = await _run_list(prio_b, "PRIO", "priority")
    print("\n=== A/B RESULTS ===")
    print(f"{'metric':22} {'FIFO':>10} {'PRIORITY':>10}")
    for k in ("validated", "CONTENT", "MIXED", "COLLECTION", "DEAD", "ERROR", "content_per_request", "dead_per_request"):
        print(f"{k:22} {a.get(k):>10} {b.get(k):>10}")
    return {"fifo": a, "priority": b, "pool": db.candidate_stats()}
