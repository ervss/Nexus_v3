"""One-shot audit: does stability/yield work make sense on real data?"""
from __future__ import annotations

import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path

desk = Path.home() / "Desktop" / "Filester Search Data"
dbp = desk / "filester_index.db"
cachep = desk / "network_cache.db"


def main() -> int:
    print("db", dbp, "exists", dbp.exists())
    if not dbp.exists():
        return 1
    con = sqlite3.connect(f"file:{dbp}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    tables = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1"
    )]
    print("tables", tables)

    def q(sql, args=()):
        try:
            return list(con.execute(sql, args))
        except Exception as e:
            print("ERR", sql[:70], "->", e)
            return []

    print("\n=== CANDIDATES ===")
    for r in q("SELECT status, COUNT(*) c FROM candidates GROUP BY status ORDER BY c DESC"):
        print(dict(r))
    for r in q(
        "SELECT folder_type, COUNT(*) c FROM candidates "
        "WHERE status!='unvalidated' GROUP BY folder_type ORDER BY c DESC"
    ):
        print("type", dict(r))

    print("\n=== PAGES ===")
    for r in q("SELECT kind, COUNT(*) c FROM pages GROUP BY kind ORDER BY c DESC"):
        print(dict(r))
    if q("SELECT COUNT(*) c FROM pages"):
        print("pages_total", q("SELECT COUNT(*) c FROM pages")[0]["c"])
        print("pages_with_files", q("SELECT COUNT(*) c FROM pages WHERE file_count>0")[0]["c"])

    print("\n=== JOBS (last 15) ===")
    rows = q(
        """SELECT job_id, status,
                  datetime(created_at,'unixepoch','localtime') ts,
                  keywords, sources, candidates, new_candidates, validated,
                  content, collections, dead, errors, discovery_requests, message
           FROM jobs ORDER BY created_at DESC LIMIT 15"""
    )
    for r in rows:
        d = dict(r)
        for k in ("keywords", "sources", "message"):
            d[k] = (d.get(k) or "")[:90]
        print(d)

    print("\n=== JOB AGG ===")
    for r in q(
        """SELECT status, COUNT(*) c,
                  SUM(candidates), SUM(new_candidates), SUM(content),
                  SUM(errors), AVG(validated)
           FROM jobs GROUP BY status"""
    ):
        print(tuple(r))

    print("\n=== KEYWORDS ===")
    for r in q(
        """SELECT keyword, status, times_used, unique_candidates,
                  unseen_candidates, verified_content, duplicates
           FROM keywords
           ORDER BY verified_content DESC, unique_candidates DESC LIMIT 12"""
    ):
        print(dict(r))
    print("--- by status ---")
    for r in q(
        """SELECT status, COUNT(*) c, SUM(unique_candidates), SUM(verified_content)
           FROM keywords GROUP BY status"""
    ):
        print(tuple(r))

    print("\n=== SOURCE YIELD ===")
    src_c: Counter[str] = Counter()
    src_content: Counter[str] = Counter()
    for r in q("SELECT sources, folder_type, status FROM candidates"):
        try:
            srcs = json.loads(r["sources"] or "[]")
        except Exception:
            srcs = []
        for s in srcs:
            src_c[s] += 1
            if r["folder_type"] == "CONTENT_FOLDER":
                src_content[s] += 1
    for s, c in src_c.most_common(15):
        print(f"  {s}: {c} cand, {src_content[s]} content")

    print("\n=== UNVALIDATED backlog ===")
    for r in q(
        "SELECT COUNT(*) c, AVG(score) avg_s, MIN(score) min_s, MAX(score) max_s "
        "FROM candidates WHERE status='unvalidated'"
    ):
        print(dict(r))

    # Interrupted / error jobs signal stability pain
    print("\n=== STABILITY SIGNALS ===")
    for r in q(
        """SELECT status, COUNT(*) c FROM jobs
           WHERE status IN ('interrupted','error','failed','running')
           GROUP BY status"""
    ):
        print(dict(r))
    for r in q(
        """SELECT COUNT(*) c FROM jobs
           WHERE message LIKE '%error%' OR message LIKE '%timeout%'
              OR message LIKE '%locked%' OR message LIKE '%interrupt%'"""
    ):
        print("jobs_with_errorish_message", r["c"])

    if cachep.exists():
        ccon = sqlite3.connect(f"file:{cachep}?mode=ro", uri=True)
        print("\n=== NETWORK CACHE ===")
        for (t,) in ccon.execute("SELECT name FROM sqlite_master WHERE type='table'"):
            try:
                n = ccon.execute(f"SELECT COUNT(*) FROM [{t}]").fetchone()[0]
                print(f"  {t}: {n}")
            except Exception as e:
                print(t, e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
