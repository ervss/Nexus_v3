#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import csv
import logging
import sys

from config import Config
from crawler.discovery import BOUNDARY_NOTES
from crawler.scheduler import CrawlScheduler
from index.database import Database
from index.search import SearchEngine


def setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def cmd_crawl(args: argparse.Namespace) -> int:
    cfg = Config.from_env()
    if args.db:
        cfg.db_path = args.db
    if args.workers:
        cfg.max_workers = args.workers
        cfg.max_concurrency = max(cfg.max_concurrency, args.workers)
    if args.max_rps:
        cfg.max_rps = args.max_rps
    if args.max_pages:
        cfg.max_pages = args.max_pages
    if args.max_depth is not None:
        cfg.max_depth = args.max_depth

    db = Database(cfg.resolve_db())
    seeds = list(cfg.default_seeds)
    if args.seed:
        seeds.extend(args.seed)

    sched = CrawlScheduler(cfg, db)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def _sig():
        logging.getLogger("filester").info("stop requested")
        sched.request_stop()

    try:
        for sig in (
            getattr(__import__("signal"), "SIGINT", None),
            getattr(__import__("signal"), "SIGTERM", None),
        ):
            if sig:
                try:
                    loop.add_signal_handler(sig, _sig)
                except NotImplementedError:
                    pass
        result = loop.run_until_complete(sched.run(seeds=seeds, max_pages=cfg.max_pages))
    finally:
        db.close()
        loop.close()

    print("\n=== crawl summary (v2) ===")
    for k, v in result.items():
        if k == "db" and isinstance(v, dict):
            print("  db:")
            for dk, dv in v.items():
                print(f"    {dk}: {dv}")
        else:
            print(f"  {k}: {v}")
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    cfg = Config.from_env()
    if args.db:
        cfg.db_path = args.db
    db = Database(cfg.resolve_db())
    eng = SearchEngine(db)
    hits = eng.search(args.query, limit=args.limit or 30)
    db.close()
    if not hits:
        print("No matches.")
        return 0
    print(f"\nQUERY: {args.query}\n")
    print(f"{'Score':>7}  {'Title':<36}  {'Files':>6}  {'Out':>4}  URL")
    print("-" * 110)
    for h in hits:
        title = (h["title"] or "")[:36]
        coll = "*" if h.get("is_collection") else " "
        print(f"{h['score']:>7.2f}  {title:<36}  {h['files']:>6}  {h.get('out_degree', 0):>3}{coll}  {h['url']}")
        if args.verbose and h.get("sample_files"):
            for fn in h["sample_files"][:3]:
                print(f"         · {fn}")
    print()
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    cfg = Config.from_env()
    if args.db:
        cfg.db_path = args.db
    db = Database(cfg.resolve_db())
    st = db.stats()
    db.close()
    print("=== index stats (v2) ===")
    for k, v in st.items():
        print(f"  {k}: {v}")
    return 0


def cmd_frontier(args: argparse.Namespace) -> int:
    cfg = Config.from_env()
    if args.db:
        cfg.db_path = args.db
    db = Database(cfg.resolve_db())
    rows = db.frontier(limit=args.limit or 25)
    q = db.queue_stats()
    db.close()
    print(f"=== frontier (queue={q}) ===")
    for r in rows:
        print(f"  prio={r['priority']:>3}  depth={r['depth']}  {r['url']}")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    cfg = Config.from_env()
    if args.db:
        cfg.db_path = args.db
    db = Database(cfg.resolve_db())
    path = args.output or "results.csv"
    rows = db._conn.execute(
        "SELECT folder_id, title, file_count, out_degree, is_collection, url, description, last_seen "
        "FROM pages WHERE kind='folder' ORDER BY out_degree DESC, file_count DESC"
    ).fetchall()
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["folder_id", "title", "file_count", "out_degree", "is_collection", "url", "description", "last_seen"])
        for r in rows:
            w.writerow([r["folder_id"], r["title"], r["file_count"], r["out_degree"], r["is_collection"], r["url"], r["description"], r["last_seen"]])
    db.close()
    print(f"exported {len(rows)} folders → {path}")
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    cfg = Config.from_env()
    if args.db:
        cfg.db_path = args.db
    if args.workers:
        cfg.max_workers = args.workers
    if args.max_rps:
        cfg.max_rps = args.max_rps
    db = Database(cfg.resolve_db())
    eng = SearchEngine(db)
    seen = {h["url"] for h in eng.search(args.query, limit=500)}
    seeds = list(cfg.default_seeds)
    if args.seed:
        seeds.extend(args.seed)

    async def _loop():
        sched = CrawlScheduler(cfg, db)
        while True:
            cfg.max_pages = args.batch or 25
            await sched.run(seeds=seeds, max_pages=cfg.max_pages)
            hits = eng.search(args.query, limit=50)
            for h in hits:
                if h["url"] not in seen:
                    seen.add(h["url"])
                    print(f"[NEW] {h['score']:.1f}  {h['title']}  ({h['files']} files, out={h.get('out_degree', 0)})  {h['url']}", flush=True)
            if args.once:
                break
            await asyncio.sleep(args.interval or 30)

    try:
        asyncio.run(_loop())
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        db.close()
    return 0





def cmd_source_stats(args: argparse.Namespace) -> int:
    """Show last discover-web source/query health (runs a lightweight collect if needed)."""
    import asyncio
    from discovery import web_sources

    async def _run():
        sources = None if getattr(args, "all_sources", False) else (args.source if getattr(args, "source", None) else None)
        hits = await web_sources.run_collectors(sources=sources, per_source_limit=args.limit or 200)
        return hits, web_sources.HEALTH.summary()

    hits, health = asyncio.run(_run())
    uniq = len({h.folder_id for h in hits})
    print(f"unique_candidates: {uniq}  hit_rows: {len(hits)}")
    print()
    print(f"{'SOURCE':16} {'QUERY_CLASS':22} {'REQS':5} {'CANDS':6} {'HEALTH'}")
    print("-" * 70)
    for row in health:
        print(f"{row['source'][:16]:16} {row['query_class'][:22]:22} {row['requests']:5} {row['candidates']:6} {row['health']}")
    return 0


def cmd_validate_pool(args: argparse.Namespace) -> int:
    """Validate persisted unvalidated candidates at scale (no rediscovery)."""
    cfg = Config.from_env()
    if args.db:
        cfg.db_path = args.db
    from discovery.pool import validate_pool
    db = Database(cfg.resolve_db())
    order = getattr(args, "strategy", None) or "fifo"
    if getattr(args, "fifo", False):
        order = "fifo"
    if getattr(args, "random_order", False):
        order = "random"
    result = asyncio.run(validate_pool(db, budget=args.budget or 50, order=order))
    db.close()
    print("\n=== VALIDATE-POOL ===")
    for k, v in result.items():
        print(f"  {k}: {v}")
    return 0


def cmd_ab_pool(args: argparse.Namespace) -> int:
    """Fair A/B FIFO vs PRIORITY on disjoint halves of unvalidated pool."""
    cfg = Config.from_env()
    if args.db:
        cfg.db_path = args.db
    from discovery.pool import ab_test_pool
    db = Database(cfg.resolve_db())
    result = asyncio.run(ab_test_pool(db, budget=args.budget or 25))
    db.close()
    print("\n=== POOL STATS ===")
    print(result.get("pool"))
    return 0


def cmd_pool_stats(args: argparse.Namespace) -> int:
    cfg = Config.from_env()
    if args.db:
        cfg.db_path = args.db
    db = Database(cfg.resolve_db())
    st = db.candidate_stats()
    unval = db.list_candidates(status="unvalidated", limit=10000, order_by_score=True)
    high = sum(1 for r in unval if (r["score"] or 0) >= 0.5)
    med = sum(1 for r in unval if 0.3 <= (r["score"] or 0) < 0.5)
    low = sum(1 for r in unval if (r["score"] or 0) < 0.3)
    print("=== CANDIDATE POOL ===")
    print(f"  total: {st.get('total')}")
    print(f"  unvalidated: {st.get('unvalidated')}")
    print(f"  by_status_type: {st.get('by_status_type')}")
    print(f"  remaining_high_confidence: {high}")
    print(f"  remaining_medium_confidence: {med}")
    print(f"  remaining_low_confidence: {low}")
    db.close()
    return 0

def cmd_discover_web(args: argparse.Namespace) -> int:
    """External public OSINT -> extract /f/ ids -> validate standalone content folders."""
    cfg = Config.from_env()
    if args.db:
        cfg.db_path = args.db

    from discovery.web_engine import WebDiscoveryEngine

    db = Database(cfg.resolve_db())
    eng = WebDiscoveryEngine(db)
    sources = None if getattr(args, "all_sources", False) else (args.source if getattr(args, "source", None) else None)

    print("NEW  TITLE                             FILES  SUBS  SOURCE")
    print("-" * 90)

    async def _run():
        kws = list(args.keyword or []) if getattr(args, "keyword", None) else []
        return await eng.run(
            limit=args.limit or 200,
            sources=sources,
            max_validate=args.max_validate or 80,
            keywords=kws or None,
            prioritize=getattr(args, "strategy", "fifo") == "priority",
            ab_test=getattr(args, "ab_test", False),
        )

    result = asyncio.run(_run())
    db.close()

    print()
    print("=== DISCOVER-WEB SCOREBOARD ===")
    for k in (
        "candidate_ids", "unique_candidates", "skipped_already_known",
        "validated", "dead_links", "collections_skipped_score", "mixed",
        "NEW_standalone_content_folders", "discovery_query_units",
        "validation_requests", "new_content_per_validation", "elapsed_s",
    ):
        print(f"  {k}: {result.get(k)}")
    print("  by_source:")
    for s, st in (result.get("by_source") or {}).items():
        print(f"    {s}: {st}")
    print("  source_health:")
    for row in (result.get("source_health") or []):
        print(f"    {row['source']:12} {row['query_class']:20} reqs={row['requests']} cands={row['candidates']} health={row['health']}")
    return 0

def cmd_discover(args: argparse.Namespace) -> int:
    """Maximize novel /f/ IDs per request (seeds score 0)."""
    cfg = Config.from_env()
    if args.db:
        cfg.db_path = args.db
    if args.workers:
        cfg.max_workers = args.workers
        cfg.max_concurrency = max(cfg.max_concurrency, args.workers)
    if args.max_rps:
        cfg.max_rps = args.max_rps

    from discovery.engine import DiscoveryEngine

    db = Database(cfg.resolve_db())
    seeds = list(args.seed or [])
    if not seeds:
        print("Need at least one --seed URL as graph entry (seed itself scores 0 novelty).")
        db.close()
        return 2

    eng = DiscoveryEngine(cfg, db)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def _sig():
        eng.request_stop()

    try:
        for sig in (
            getattr(__import__("signal"), "SIGINT", None),
            getattr(__import__("signal"), "SIGTERM", None),
        ):
            if sig:
                try:
                    loop.add_signal_handler(sig, _sig)
                except NotImplementedError:
                    pass
        result = loop.run_until_complete(
            eng.run(seeds, max_requests=args.max_requests or 40)
        )
    finally:
        db.close()
        loop.close()

    print("\n=== DISCOVERY SCOREBOARD ===")
    print(f"  NEW unique folder IDs : {result.get('session_new_ids')}")
    print(f"  requests              : {result.get('requests')}")
    print(f"  IDs / request          : {result.get('ids_per_request')}")
    print(f"  IDs / minute          : {result.get('ids_per_minute')}")
    print(f"  best channel          : {result.get('best_channel')}")
    print(f"  elapsed_s             : {result.get('elapsed_s')}")
    print("  channels:")
    for name, st in (result.get("channels") or {}).items():
        print(f"    {name}: {st}")
    print(f"  known_total           : {result.get('known_total')}")
    return 0


def cmd_boundaries(args: argparse.Namespace) -> int:

    print(BOUNDARY_NOTES)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="filester_search", description="Filester public folder discovery v2")
    p.add_argument("--db", help="SQLite DB path")
    p.add_argument("--verbose", "-v", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("crawl", help="Run resumable graph crawler")
    c.add_argument("--seed", action="append", default=[])
    c.add_argument("--workers", type=int)
    c.add_argument("--max-rps", type=float)
    c.add_argument("--max-pages", type=int, default=0)
    c.add_argument("--max-depth", type=int)
    c.set_defaults(func=cmd_crawl)

    s = sub.add_parser("search", help="FTS search")
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=30)
    s.set_defaults(func=cmd_search)

    st = sub.add_parser("stats", help="Index/graph stats")
    st.set_defaults(func=cmd_stats)

    fr = sub.add_parser("frontier", help="Pending crawl frontier")
    fr.add_argument("--limit", type=int, default=25)
    fr.set_defaults(func=cmd_frontier)

    e = sub.add_parser("export", help="Export CSV")
    e.add_argument("-o", "--output", default="results.csv")
    e.set_defaults(func=cmd_export)

    w = sub.add_parser("watch", help="Live match watch")
    w.add_argument("query")
    w.add_argument("--seed", action="append", default=[])
    w.add_argument("--workers", type=int)
    w.add_argument("--max-rps", type=float)
    w.add_argument("--batch", type=int, default=25)
    w.add_argument("--interval", type=int, default=30)
    w.add_argument("--once", action="store_true")
    w.set_defaults(func=cmd_watch)

    d = sub.add_parser("discover", help="Maximize novel /f/ IDs per request")
    d.add_argument("--seed", action="append", default=[], required=False)
    d.add_argument("--workers", type=int)
    d.add_argument("--max-rps", type=float)
    d.add_argument("--max-requests", type=int, default=40)
    d.set_defaults(func=cmd_discover)

    dw = sub.add_parser("discover-web", help="External OSINT discovery of standalone /f/ folders")
    dw.add_argument("--limit", type=int, default=200, help="Per-source candidate budget")
    dw.add_argument("--max-validate", type=int, default=80, help="Max live Filester GETs")
    dw.add_argument("--all-sources", action="store_true", help="Run all collectors")
    dw.add_argument("--source", action="append", default=None,
                    help="urlscan, wayback, archive, commoncrawl, brave, duckduckgo_html, bing_html")
    dw.add_argument("--keyword", action="append", default=[], help="Keyword for search-family queries")
    dw.add_argument("--fifo", action="store_true", help="Disable prioritization (FIFO order)")
    dw.add_argument("--ab-test", action="store_true", help="A/B FIFO vs priority on same pool")
    dw.set_defaults(func=cmd_discover_web)

    ss = sub.add_parser("source-stats", help="Collector/query health and candidate counts")
    ss.add_argument("--source", action="append", default=None)
    ss.add_argument("--limit", type=int, default=200)
    ss.set_defaults(func=cmd_source_stats)

    vp = sub.add_parser("validate-pool", help="Validate persisted candidates (scale)")
    vp.add_argument("--budget", type=int, default=50)
    vp.add_argument("--strategy", choices=["fifo", "priority", "random"], default="fifo")
    vp.add_argument("--fifo", action="store_true", help="alias for --strategy fifo")
    vp.add_argument("--random-order", action="store_true", help="alias for --strategy random")
    vp.set_defaults(func=cmd_validate_pool)

    ab = sub.add_parser("ab-pool", help="A/B FIFO vs PRIORITY on disjoint pool halves")
    ab.add_argument("--budget", type=int, default=25)
    ab.set_defaults(func=cmd_ab_pool)

    ps = sub.add_parser("pool-stats", help="Candidate pool saturation stats")
    ps.set_defaults(func=cmd_pool_stats)

    b = sub.add_parser("boundaries", help="Print auth/anti-abuse boundaries")
    b.set_defaults(func=cmd_boundaries)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    setup_logging(getattr(args, "verbose", False))
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
