"""Live check: after patch, a job must write non-zero keyword metrics."""
from __future__ import annotations

import json
import sqlite3
import time
import urllib.request
from pathlib import Path

DB = Path.home() / "Desktop" / "Filester Search Data" / "filester_index.db"
BASE = "http://127.0.0.1:8765"
PROBE = ["yieldprobe_a", "yieldprobe_b"]


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=60) as r:
        return json.loads(r.read().decode())


def post(path: str, body: dict):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def kw_rows():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    q = "SELECT keyword, unique_candidates, unseen_candidates, verified_content, status, times_used FROM keywords WHERE keyword IN (?,?)"
    return {r["keyword"]: dict(r) for r in con.execute(q, PROBE)}


def main():
    print("BEFORE", kw_rows())
    job = post(
        "/discover",
        {
            "keywords": PROBE,
            "sources": ["urlscan"],
            "max_queries": 2,
            "max_validate": 3,
            "target_new": 5,
        },
    )
    jid = job["job_id"]
    print("JOB", jid)
    st = None
    for _ in range(90):
        st = get(f"/jobs/{jid}")
        if st.get("status") in ("completed", "failed", "cancelled", "interrupted"):
            break
        time.sleep(1)
    print(
        "STATUS",
        {
            k: st.get(k)
            for k in (
                "status",
                "candidates",
                "new_candidates",
                "validated",
                "content",
                "errors",
                "message",
                "sources",
            )
        },
    )
    after = kw_rows()
    print("AFTER", after)
    ok = all((after.get(k) or {}).get("unique_candidates", 0) > 0 for k in PROBE)
    print("FEEDBACK_OK" if ok else "FEEDBACK_STILL_BLIND")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
