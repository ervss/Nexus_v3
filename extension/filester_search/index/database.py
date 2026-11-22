from __future__ import annotations

import json
import sqlite3
import time
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

from exclusions import EXCLUDED_FOLDER_ROOTS, canonical_folder_url, folder_id_from_url


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA temp_store=MEMORY;
PRAGMA mmap_size=268435456;

CREATE TABLE IF NOT EXISTS pages (
    url           TEXT PRIMARY KEY,
    folder_id     TEXT,
    kind          TEXT NOT NULL DEFAULT 'page',
    title         TEXT,
    description   TEXT,
    file_count    INTEGER DEFAULT 0,
    filenames     TEXT,
    file_slugs    TEXT,
    file_meta     TEXT,
    thumb_ids     TEXT,
    tags          TEXT,
    out_degree    INTEGER DEFAULT 0,
    in_degree     INTEGER DEFAULT 0,
    is_collection INTEGER DEFAULT 0,
    content_hash  TEXT,
    http_status   INTEGER,
    etag          TEXT,
    last_modified TEXT,
    depth         INTEGER DEFAULT 0,
    source        TEXT,
    first_seen    REAL,
    last_seen     REAL,
    last_crawled  REAL,
    error         TEXT
);

CREATE TABLE IF NOT EXISTS links (
    src_url    TEXT NOT NULL,
    dst_url    TEXT NOT NULL,
    link_type  TEXT DEFAULT 'folder',
    first_seen REAL,
    PRIMARY KEY (src_url, dst_url)
);

CREATE TABLE IF NOT EXISTS crawl_queue (
    url        TEXT PRIMARY KEY,
    depth      INTEGER NOT NULL DEFAULT 0,
    priority   INTEGER NOT NULL DEFAULT 100,
    enqueued   REAL NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT
);

CREATE TABLE IF NOT EXISTS crawl_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url        TEXT NOT NULL,
    status     INTEGER,
    latency_ms REAL,
    bytes      INTEGER,
    ts         REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pages_folder ON pages(folder_id);
CREATE INDEX IF NOT EXISTS idx_pages_kind ON pages(kind);
CREATE INDEX IF NOT EXISTS idx_queue_status ON crawl_queue(status, priority, enqueued);
CREATE INDEX IF NOT EXISTS idx_history_ts ON crawl_history(ts);

CREATE TABLE IF NOT EXISTS candidates (
    folder_id     TEXT PRIMARY KEY,
    first_source  TEXT,
    sources       TEXT,
    query_classes TEXT,
    external_ts   TEXT,
    score         REAL DEFAULT 0,
    status        TEXT DEFAULT 'unvalidated',
    folder_type   TEXT,
    title         TEXT,
    file_count    INTEGER DEFAULT 0,
    subfolder_count INTEGER DEFAULT 0,
    first_seen    REAL,
    last_seen     REAL,
    validated_at  REAL
);
CREATE INDEX IF NOT EXISTS idx_cand_status ON candidates(status, score);

CREATE TABLE IF NOT EXISTS excluded_folders (
    folder_id  TEXT PRIMARY KEY,
    root_id    TEXT NOT NULL,
    reason     TEXT,
    first_seen REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_excluded_root ON excluded_folders(root_id);


CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    url, folder_id, title, description, filenames, tags,
    content='pages', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, url, folder_id, title, description, filenames, tags)
  VALUES (new.rowid, new.url, new.folder_id, new.title, new.description, new.filenames, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, url, folder_id, title, description, filenames, tags)
  VALUES ('delete', old.rowid, old.url, old.folder_id, old.title, old.description, old.filenames, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, url, folder_id, title, description, filenames, tags)
  VALUES ('delete', old.rowid, old.url, old.folder_id, old.title, old.description, old.filenames, old.tags);
  INSERT INTO pages_fts(rowid, url, folder_id, title, description, filenames, tags)
  VALUES (new.rowid, new.url, new.folder_id, new.title, new.description, new.filenames, new.tags);
END;
"""

MIGRATIONS = [
    "ALTER TABLE candidates ADD COLUMN discovery_depth INTEGER DEFAULT 0",
    "ALTER TABLE candidates ADD COLUMN retry_after REAL DEFAULT 0",
    "ALTER TABLE candidates ADD COLUMN claim_token TEXT DEFAULT ''",
    "ALTER TABLE candidates ADD COLUMN claim_until REAL DEFAULT 0",
    "ALTER TABLE pages ADD COLUMN file_slugs TEXT",
    "ALTER TABLE pages ADD COLUMN file_meta TEXT",
    "ALTER TABLE pages ADD COLUMN thumb_ids TEXT",
    "ALTER TABLE pages ADD COLUMN out_degree INTEGER DEFAULT 0",
    "ALTER TABLE pages ADD COLUMN in_degree INTEGER DEFAULT 0",
    "ALTER TABLE pages ADD COLUMN is_collection INTEGER DEFAULT 0",
    "ALTER TABLE links ADD COLUMN link_type TEXT DEFAULT 'folder'",
]


class Database:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._write_lock = threading.RLock()
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._init()

    def _init(self) -> None:
        # 1) core tables (IF NOT EXISTS — keeps existing v1 data)
        self._conn.executescript(SCHEMA)
        # 2) additive column migrations BEFORE secondary indexes that need them
        for stmt in MIGRATIONS:
            try:
                self._conn.execute(stmt)
            except sqlite3.OperationalError:
                pass
        # 3) indexes that depend on v2 columns (safe if columns just added)
        for stmt in (
            "CREATE INDEX IF NOT EXISTS idx_pages_collection ON pages(is_collection, out_degree)",
            "CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_url)",
        ):
            try:
                self._conn.execute(stmt)
            except sqlite3.OperationalError:
                pass
        self._conn.commit()
        self.refresh_excluded_folder_trees()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._write_lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                yield self._conn
                self._conn.commit()
            except BaseException:
                self._conn.rollback()
                raise


    def upsert_candidate(self, folder_id: str, sources: list, query_classes: list,
                         external_ts: str = "", score: float = 0.0,
                         discovery_depth: int = 0) -> bool:
        import json, time
        now = time.time()
        fid = folder_id.lower()
        with self.tx() as c:
            if c.execute("SELECT 1 FROM excluded_folders WHERE folder_id=?", (fid,)).fetchone():
                c.execute(
                    "UPDATE candidates SET status='excluded',claim_token='',claim_until=0,retry_after=0 WHERE folder_id=?",
                    (fid,),
                )
                return False
            row = c.execute("SELECT sources, query_classes FROM candidates WHERE folder_id=?", (fid,)).fetchone()
            if row:
                try:
                    srcs = list(dict.fromkeys(json.loads(row["sources"] or "[]") + list(sources)))
                except Exception:
                    srcs = list(sources)
                try:
                    qcs = list(dict.fromkeys(json.loads(row["query_classes"] or "[]") + list(query_classes)))
                except Exception:
                    qcs = list(query_classes)
                c.execute(
                    """UPDATE candidates SET sources=?, query_classes=?, last_seen=?, score=MAX(score,?),
                       discovery_depth=MIN(discovery_depth,?), external_ts=CASE WHEN external_ts='' THEN ? ELSE external_ts END
                       WHERE folder_id=?""",
                    (json.dumps(srcs), json.dumps(qcs), now, score, discovery_depth, external_ts, fid),
                )
            else:
                c.execute(
                    """INSERT INTO candidates(folder_id, first_source, sources, query_classes, external_ts, score,
                       status, first_seen, last_seen, discovery_depth) VALUES (?,?,?,?,?,?,'unvalidated',?,?,?)""",
                    (fid, sources[0] if sources else "", json.dumps(list(sources)),
                     json.dumps(list(query_classes)), external_ts, score, now, now, discovery_depth),
                )
            return row is None

    def claim_candidate(self, folder_id: str, token: str, lease_seconds: float = 120) -> bool:
        """Atomic across database connections; no SQLite transaction spans an await."""
        now = time.time()
        with self.tx() as c:
            return c.execute(
                """UPDATE candidates SET claim_token=?,claim_until=? WHERE folder_id=?
                   AND status='unvalidated' AND COALESCE(retry_after,0)<=?
                   AND COALESCE(claim_until,0)<=?
                   AND NOT EXISTS (SELECT 1 FROM excluded_folders e WHERE e.folder_id=candidates.folder_id)""",
                (token, now+lease_seconds, folder_id, now, now),
            ).rowcount == 1

    def release_claims(self, token: str) -> None:
        with self.tx() as c:
            c.execute("UPDATE candidates SET claim_token='',claim_until=0 WHERE claim_token=?", (token,))

    def defer_candidate(self, folder_id: str, delay: float) -> None:
        with self.tx() as c:
            c.execute("""UPDATE candidates SET folder_type='ERROR',retry_after=?
                         WHERE folder_id=? AND status='unvalidated'""",
                      (time.time()+delay, folder_id))

    def list_candidates(self, status: str | None = "unvalidated", limit: int = 500, order_by_score: bool = True,
                        ready_only: bool = False):
        q = "SELECT * FROM candidates"
        params = []
        if status:
            q += " WHERE status=?"
            params.append(status)
        if ready_only:
            q += " AND" if status else " WHERE"
            q += " COALESCE(claim_until,0)<=? AND COALESCE(retry_after,0)<=?"
            params.extend([time.time(), time.time()])
        q += " ORDER BY score DESC, first_seen ASC, folder_id ASC" if order_by_score else " ORDER BY first_seen ASC, folder_id ASC"
        q += " LIMIT ?"
        params.append(limit)
        return list(self._conn.execute(q, params).fetchall())

    def mark_candidate(self, folder_id: str, status: str, folder_type: str = "",
                       title: str = "", file_count: int = 0, subfolder_count: int = 0) -> None:
        import time
        with self.tx() as c:
            c.execute(
                """UPDATE candidates SET status=?, folder_type=?, title=?, file_count=?,
                   subfolder_count=?, validated_at=? WHERE folder_id=?""",
                (status, folder_type, title, file_count, subfolder_count, time.time(), folder_id.lower()),
            )

    def candidate_stats(self) -> dict:
        rows = self._conn.execute(
            "SELECT status, folder_type, COUNT(*) AS n FROM candidates GROUP BY status, folder_type"
        ).fetchall()
        out = {"by_status_type": {}, "total": 0, "unvalidated": 0}
        for r in rows:
            key = f"{r['status']}:{r['folder_type'] or '-'}"
            out["by_status_type"][key] = r["n"]
            out["total"] += r["n"]
            if r["status"] == "unvalidated":
                out["unvalidated"] += r["n"]
        return out


    def close(self) -> None:
        self._conn.close()

    def enqueue(self, url: str, depth: int = 0, priority: int = 100) -> bool:
        fid = folder_id_from_url(url)
        if fid and self.is_folder_excluded(fid):
            return False
        now = time.time()
        with self.tx() as c:
            cur = c.execute(
                "INSERT OR IGNORE INTO crawl_queue(url, depth, priority, enqueued, status) VALUES (?, ?, ?, ?, 'pending')",
                (url, depth, priority, now),
            )
            return cur.rowcount > 0

    def enqueue_many(self, items: Iterable[tuple[str, int, int]]) -> int:
        now = time.time()
        with self.tx() as c:
            n = 0
            for url, depth, prio in items:
                fid = folder_id_from_url(url)
                if fid and c.execute("SELECT 1 FROM excluded_folders WHERE folder_id=?", (fid,)).fetchone():
                    continue
                cur = c.execute(
                    "INSERT OR IGNORE INTO crawl_queue(url, depth, priority, enqueued, status) VALUES (?, ?, ?, ?, 'pending')",
                    (url, depth, prio, now),
                )
                n += cur.rowcount
            return n

    def claim_batch(self, limit: int = 4) -> list[sqlite3.Row]:
        with self.tx() as c:
            rows = c.execute(
                "SELECT url, depth, attempts FROM crawl_queue WHERE status='pending' ORDER BY priority ASC, enqueued ASC LIMIT ?",
                (limit,),
            ).fetchall()
            for r in rows:
                c.execute("UPDATE crawl_queue SET status='inflight' WHERE url=?", (r["url"],))
            return list(rows)

    def mark_done(self, url: str) -> None:
        with self.tx() as c:
            c.execute("UPDATE crawl_queue SET status='done', last_error=NULL WHERE url=?", (url,))

    def mark_error(self, url: str, err: str, requeue: bool = False, priority_bump: int = 50) -> None:
        with self.tx() as c:
            if requeue:
                c.execute(
                    "UPDATE crawl_queue SET status='pending', attempts=attempts+1, last_error=?, priority=priority+?, enqueued=? WHERE url=?",
                    (err[:500], priority_bump, time.time(), url),
                )
            else:
                c.execute(
                    "UPDATE crawl_queue SET status='error', attempts=attempts+1, last_error=? WHERE url=?",
                    (err[:500], url),
                )

    def recover_inflight(self) -> int:
        with self.tx() as c:
            return c.execute("UPDATE crawl_queue SET status='pending' WHERE status='inflight'").rowcount

    def queue_stats(self) -> dict[str, int]:
        rows = self._conn.execute("SELECT status, COUNT(*) AS n FROM crawl_queue GROUP BY status").fetchall()
        return {r["status"]: r["n"] for r in rows}

    def upsert_page(self, data: dict[str, Any]) -> None:
        now = time.time()
        data = dict(data)
        fid = (data.get("folder_id") or folder_id_from_url(data.get("url") or "") or "").lower()
        if fid and self.is_folder_excluded(fid):
            return
        data.setdefault("first_seen", now)
        data["last_seen"] = now
        data["last_crawled"] = now
        for k in ("filenames", "tags", "file_slugs", "file_meta", "thumb_ids"):
            if isinstance(data.get(k), (list, tuple)):
                data[k] = json.dumps(data[k], ensure_ascii=False)
        if "is_collection" in data:
            data["is_collection"] = 1 if data["is_collection"] else 0

        cols = [
            "url", "folder_id", "kind", "title", "description", "file_count",
            "filenames", "file_slugs", "file_meta", "thumb_ids", "tags", "out_degree", "in_degree",
            "is_collection", "content_hash", "http_status", "etag",
            "last_modified", "depth", "source", "first_seen", "last_seen",
            "last_crawled", "error",
        ]
        vals = [data.get(c) for c in cols]
        placeholders = ",".join("?" * len(cols))
        updates = ",".join(
            f"{c}=COALESCE(excluded.{c},pages.{c})" if c in ("file_meta", "thumb_ids") else f"{c}=excluded.{c}"
            for c in cols if c not in ("url", "first_seen", "in_degree")
        )
        with self.tx() as c:
            c.execute(
                f"INSERT INTO pages ({','.join(cols)}) VALUES ({placeholders}) "
                f"ON CONFLICT(url) DO UPDATE SET {updates}, first_seen=MIN(pages.first_seen, excluded.first_seen)",
                vals,
            )

    def get_page(self, url: str) -> Optional[sqlite3.Row]:
        return self._conn.execute(
            """SELECT p.* FROM pages p WHERE p.url=? AND NOT EXISTS (
                SELECT 1 FROM excluded_folders e WHERE e.folder_id=p.folder_id
            )""",
            (url,),
        ).fetchone()

    def add_link(self, src: str, dst: str, link_type: str = "folder") -> None:
        with self.tx() as c:
            c.execute(
                "INSERT OR IGNORE INTO links(src_url, dst_url, link_type, first_seen) VALUES (?,?,?,?)",
                (src, dst, link_type, time.time()),
            )
            src_id = folder_id_from_url(src)
            dst_id = folder_id_from_url(dst)
            if src_id and dst_id:
                parent = c.execute(
                    "SELECT root_id,reason FROM excluded_folders WHERE folder_id=?", (src_id,)
                ).fetchone()
                if parent:
                    c.execute(
                        "INSERT OR IGNORE INTO excluded_folders(folder_id,root_id,reason,first_seen) VALUES (?,?,?,?)",
                        (dst_id, parent["root_id"], parent["reason"], time.time()),
                    )
                    self._cascade_exclusion(c, dst_id, parent["root_id"], parent["reason"])

    def _cascade_exclusion(self, c: sqlite3.Connection, folder_id: str, root_id: str, reason: str) -> set[str]:
        now = time.time()
        pending = [folder_id]
        added: set[str] = set()
        while pending:
            current = pending.pop()
            if current in added:
                continue
            added.add(current)
            c.execute(
                "INSERT OR IGNORE INTO excluded_folders(folder_id,root_id,reason,first_seen) VALUES (?,?,?,?)",
                (current, root_id, reason, now),
            )
            c.execute(
                """UPDATE candidates SET status='excluded',claim_token='',claim_until=0,retry_after=0
                   WHERE folder_id=?""",
                (current,),
            )
            c.execute(
                "UPDATE crawl_queue SET status='excluded' WHERE url=? AND status IN ('pending','inflight')",
                (canonical_folder_url(current),),
            )
            for link in c.execute("SELECT dst_url FROM links WHERE src_url=?", (canonical_folder_url(current),)):
                child = folder_id_from_url(link["dst_url"])
                if child and child not in added:
                    pending.append(child)
        return added

    def _refresh_exclusions(self, c: sqlite3.Connection) -> int:
        seen: set[str] = set()
        for root_id, reason in EXCLUDED_FOLDER_ROOTS.items():
            seen.update(self._cascade_exclusion(c, root_id, root_id, reason))
        c.execute(
            """UPDATE candidates SET status='excluded',claim_token='',claim_until=0,retry_after=0
               WHERE folder_id IN (SELECT folder_id FROM excluded_folders)"""
        )
        for row in c.execute("SELECT folder_id FROM excluded_folders"):
            c.execute(
                "UPDATE crawl_queue SET status='excluded' WHERE url=? AND status IN ('pending','inflight')",
                (canonical_folder_url(row["folder_id"]),),
            )
        return len(seen)

    def refresh_excluded_folder_trees(self) -> int:
        with self.tx() as c:
            return self._refresh_exclusions(c)

    def is_folder_excluded(self, folder_id: str) -> bool:
        return self._conn.execute(
            "SELECT 1 FROM excluded_folders WHERE folder_id=?", ((folder_id or "").lower(),)
        ).fetchone() is not None

    def excluded_folder_count(self) -> int:
        return int(self._conn.execute("SELECT COUNT(*) FROM excluded_folders").fetchone()[0])

    def recompute_in_degrees(self) -> None:
        with self.tx() as c:
            c.execute("UPDATE pages SET in_degree=0")
            c.execute(
                """
                UPDATE pages SET in_degree = (
                    SELECT COUNT(*) FROM links
                    WHERE links.dst_url = pages.url AND links.link_type='folder'
                ) WHERE kind='folder'
                """
            )

    def log_fetch(self, url: str, status: int, latency_ms: float, nbytes: int) -> None:
        with self.tx() as c:
            c.execute(
                "INSERT INTO crawl_history(url, status, latency_ms, bytes, ts) VALUES (?,?,?,?,?)",
                (url, status, latency_ms, nbytes, time.time()),
            )

    def stats(self) -> dict[str, Any]:
        q = self.queue_stats()
        visible = "NOT EXISTS (SELECT 1 FROM excluded_folders e WHERE e.folder_id=pages.folder_id)"
        folders = self._conn.execute(f"SELECT COUNT(*) FROM pages WHERE kind='folder' AND {visible}").fetchone()[0]
        collections = self._conn.execute("SELECT COUNT(*) FROM pages WHERE is_collection=1").fetchone()[0]
        pages = self._conn.execute("SELECT COUNT(*) FROM pages").fetchone()[0]
        files = self._conn.execute(f"SELECT COALESCE(SUM(file_count),0) FROM pages WHERE kind='folder' AND {visible}").fetchone()[0]
        edges = self._conn.execute("SELECT COUNT(*) FROM links").fetchone()[0]
        recent = self._conn.execute("SELECT COUNT(*) FROM crawl_history WHERE ts > ?", (time.time() - 60,)).fetchone()[0]
        top = self._conn.execute(
            f"SELECT title, folder_id, out_degree, file_count, url FROM pages WHERE kind='folder' AND {visible} "
            "ORDER BY out_degree DESC, file_count DESC LIMIT 5"
        ).fetchall()
        return {
            "pages": pages,
            "folders": folders,
            "collections": collections,
            "files_indexed": files,
            "graph_edges": edges,
            "excluded_folders": self.excluded_folder_count(),
            "queue": q,
            "fetches_last_60s": recent,
            "top_fanout": [
                {"title": r["title"], "folder_id": r["folder_id"], "out_degree": r["out_degree"],
                 "files": r["file_count"], "url": r["url"]}
                for r in top
            ],
        }

    def frontier(self, limit: int = 20) -> list[dict]:
        rows = self._conn.execute(
            "SELECT url, depth, priority, attempts, enqueued FROM crawl_queue "
            "WHERE status='pending' ORDER BY priority ASC, enqueued ASC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
