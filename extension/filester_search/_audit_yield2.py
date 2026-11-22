"""Deeper yield experiment: is the bottleneck discovery diversity or validation?"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

desk = Path.home() / "Desktop" / "Filester Search Data"
con = sqlite3.connect(f"file:{desk / 'filester_index.db'}?mode=ro", uri=True)
con.row_factory = sqlite3.Row


def main():
    jobs = list(con.execute(
        """SELECT job_id, keywords, sources, candidates, new_candidates, content,
                  validated, discovery_requests, status
           FROM jobs WHERE status='completed' ORDER BY created_at"""
    ))
    print(f"completed_jobs={len(jobs)}")
    zero_new = sum(1 for j in jobs if (j["new_candidates"] or 0) == 0)
    with_new = [j for j in jobs if (j["new_candidates"] or 0) > 0]
    print(f"jobs_with_0_new={zero_new}/{len(jobs)} ({100*zero_new/max(len(jobs),1):.0f}%)")
    print(f"jobs_with_new={len(with_new)}")
    if with_new:
        print("avg_new_when_hit", sum(j["new_candidates"] for j in with_new)/len(with_new))
        print("avg_content_when_hit", sum(j["content"] or 0 for j in with_new)/len(with_new))
        print("sum_new", sum(j["new_candidates"] for j in with_new))
        print("sum_content", sum(j["content"] or 0 for j in with_new))

    # Saturation: candidates found vs already known
    print("\n=== SATURATION PATTERN ===")
    for j in jobs:
        cands = j["candidates"] or 0
        new = j["new_candidates"] or 0
        already = cands - new if cands >= new else None
        print(
            f"  {j['job_id'][:8]} cand={cands:4d} new={new:3d} "
            f"content={j['content'] or 0:3d} sources={j['sources']} "
            f"kw={(j['keywords'] or '')[:50]}"
        )

    # Source diversity in jobs vs available collectors
    job_sources = Counter()
    for j in jobs:
        try:
            for s in json.loads(j["sources"] or "[]"):
                job_sources[s] += 1
        except Exception:
            pass
    print("\n=== SOURCES USED IN JOBS ===")
    for s, n in job_sources.most_common():
        print(f"  {s}: {n} jobs")
    print("available_collectors: wayback, urlscan, commoncrawl, duckduckgo_html, bing_html, brave")

    # Content rate of validated pool
    tot = con.execute("SELECT COUNT(*) FROM candidates WHERE status='validated'").fetchone()[0]
    content = con.execute(
        "SELECT COUNT(*) FROM candidates WHERE folder_type='CONTENT_FOLDER'"
    ).fetchone()[0]
    print(f"\nvalidated={tot} content={content} content_rate={content/max(tot,1):.1%}")

    # Keyword metric bug signal
    kw_nonzero = con.execute(
        "SELECT COUNT(*) FROM keywords WHERE unique_candidates>0 OR verified_content>0"
    ).fetchone()[0]
    kw_total = con.execute("SELECT COUNT(*) FROM keywords").fetchone()[0]
    print(f"keywords_with_any_yield_metric={kw_nonzero}/{kw_total}")
    print("=> rotation learning is effectively blind" if kw_nonzero == 0 else "=> rotation has signal")

    # Would expanding sources help? Estimate: pages already indexed vs candidate source tags
    print("\n=== HYPOTHESIS CHECK ===")
    print("H1 stability-first: interrupted/error jobs / error messages")
    print("  interrupted=", con.execute(
        "SELECT COUNT(*) FROM jobs WHERE status='interrupted'"
    ).fetchone()[0])
    print("  errors_sum=", con.execute("SELECT SUM(errors) FROM jobs").fetchone()[0])
    print("H2 yield via unused collectors: commoncrawl/ddg/bing rarely/never in job sources")
    unused = {"commoncrawl", "duckduckgo_html", "bing_html"} - set(job_sources)
    print("  never_used_in_jobs=", sorted(unused))
    print("H3 pool saturation: most jobs find candidates but new=0")
    print(f"  saturation_jobs={zero_new}/{len(jobs)}")
    print("H4 keyword rotator feedback broken: all metrics zero")
    print(f"  blind_keywords={kw_total - kw_nonzero}")


if __name__ == "__main__":
    main()
