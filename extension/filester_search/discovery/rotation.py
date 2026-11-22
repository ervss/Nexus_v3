
from __future__ import annotations
"""Adaptive keyword rotation — HOT/WARM/COLD/EXHAUSTED with cooldowns."""

import re
import time
from collections import defaultdict
from typing import Iterable, Optional

from index.database import Database

SEED_KEYWORDS = [
    ("bbc", "category"), ("blonde", "appearance"), ("skinny", "appearance"),
    ("doll", "style"), ("brunette", "appearance"), ("petite", "appearance"),
    ("cosplay", "style"), ("amateur", "category"), ("solo", "category"),
    ("model", "category"), ("school", "category"), ("annie", "creator"),
    ("camera", "category"),
]

_STOP = {
    "the", "and", "for", "with", "from", "filester", "folder", "file",
    "video", "videos", "photo", "photos", "page", "all", "new", "amp",
}


def normalize_kw(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9_\-\s]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def tokenize(text: str) -> list[str]:
    toks = re.findall(r"[a-zA-Z][a-zA-Z0-9_\-]{2,}", text or "")
    out = []
    for t in toks:
        tl = t.lower()
        if tl in _STOP or len(tl) < 3:
            continue
        out.append(tl)
    return out


class KeywordRotator:
    def __init__(self, db: Database):
        self.db = db
        self._ensure_schema()
        self.ensure_seeds()

    def _ensure_schema(self) -> None:
        self.db._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS keywords (
                keyword TEXT PRIMARY KEY,
                normalized TEXT,
                category TEXT DEFAULT 'manual',
                source TEXT DEFAULT 'seed',
                parent_keyword TEXT,
                first_seen REAL,
                last_used REAL,
                times_used INTEGER DEFAULT 0,
                discovery_requests INTEGER DEFAULT 0,
                unique_candidates INTEGER DEFAULT 0,
                unseen_candidates INTEGER DEFAULT 0,
                verified_content INTEGER DEFAULT 0,
                duplicates INTEGER DEFAULT 0,
                cooldown_until REAL DEFAULT 0,
                status TEXT DEFAULT 'WARM'
            );
            CREATE TABLE IF NOT EXISTS keyword_cooc (
                term_a TEXT,
                term_b TEXT,
                count INTEGER DEFAULT 0,
                content_count INTEGER DEFAULT 0,
                PRIMARY KEY (term_a, term_b)
            );
            CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY,
                created_at REAL,
                status TEXT,
                keywords TEXT,
                sources TEXT,
                max_queries INTEGER,
                max_validate INTEGER,
                target_new INTEGER,
                discovery_requests INTEGER DEFAULT 0,
                candidates INTEGER DEFAULT 0,
                new_candidates INTEGER DEFAULT 0,
                validated INTEGER DEFAULT 0,
                content INTEGER DEFAULT 0,
                collections INTEGER DEFAULT 0,
                dead INTEGER DEFAULT 0,
                errors INTEGER DEFAULT 0,
                current_keyword TEXT,
                current_source TEXT,
                message TEXT
            );
            """
        )
        self.db._conn.commit()

    def ensure_seeds(self) -> None:
        now = time.time()
        for kw, cat in SEED_KEYWORDS:
            n = normalize_kw(kw)
            self.db._conn.execute(
                """
                INSERT OR IGNORE INTO keywords(
                    keyword, normalized, category, source, first_seen, status
                ) VALUES (?,?,?,?,?,'WARM')
                """,
                (n, n, cat, "seed", now),
            )
        self.db._conn.commit()

    def add_keyword(self, keyword: str, category: str = "manual",
                    source: str = "manual", parent: str = "") -> str:
        n = normalize_kw(keyword)
        if not n:
            return ""
        now = time.time()
        self.db._conn.execute(
            """
            INSERT INTO keywords(keyword, normalized, category, source, parent_keyword, first_seen, status)
            VALUES (?,?,?,?,?,?, 'WARM')
            ON CONFLICT(keyword) DO UPDATE SET last_used=excluded.first_seen
            """,
            (n, n, category, source, parent or None, now),
        )
        self.db._conn.commit()
        return n

    def pause(self, keyword: str) -> None:
        self.db._conn.execute(
            "UPDATE keywords SET status='EXHAUSTED', cooldown_until=? WHERE keyword=?",
            (time.time() + 86400 * 7, normalize_kw(keyword)),
        )
        self.db._conn.commit()

    def resume(self, keyword: str) -> None:
        self.db._conn.execute(
            "UPDATE keywords SET status='WARM', cooldown_until=0 WHERE keyword=?",
            (normalize_kw(keyword),),
        )
        self.db._conn.commit()

    def record_query_result(
        self, keyword: str, *, unique_cands: int, unseen: int,
        content: int, duplicates: int,
    ) -> None:
        n = normalize_kw(keyword)
        now = time.time()
        row = self.db._conn.execute(
            "SELECT * FROM keywords WHERE keyword=?", (n,)
        ).fetchone()
        if not row:
            self.add_keyword(n, "learned", "learned")
            row = self.db._conn.execute(
                "SELECT * FROM keywords WHERE keyword=?", (n,)
            ).fetchone()
        times = (row["times_used"] or 0) + 1
        reqs = (row["discovery_requests"] or 0) + 1
        uniq = (row["unique_candidates"] or 0) + unique_cands
        unsn = (row["unseen_candidates"] or 0) + unseen
        cont = (row["verified_content"] or 0) + content
        dups = (row["duplicates"] or 0) + duplicates
        # classify
        novelty = unseen / max(1, unique_cands + duplicates)
        if unseen == 0 and unique_cands > 0:
            status, cool = "EXHAUSTED", now + 3600 * 12
        elif novelty >= 0.4 or content > 0:
            status, cool = "HOT", 0
        elif novelty >= 0.1:
            status, cool = "WARM", 0
        else:
            status, cool = "COLD", now + 3600 * 3
        self.db._conn.execute(
            """
            UPDATE keywords SET times_used=?, discovery_requests=?, unique_candidates=?,
            unseen_candidates=?, verified_content=?, duplicates=?, last_used=?,
            status=?, cooldown_until=? WHERE keyword=?
            """,
            (times, reqs, uniq, unsn, cont, dups, now, status, cool, n),
        )
        self.db._conn.commit()

    def learn_from_title(self, title: str, parent: str = "") -> list[str]:
        added = []
        for tok in tokenize(title)[:5]:
            if tok not in {k for k, _ in SEED_KEYWORDS}:
                self.add_keyword(tok, "title_token", "learned", parent)
                added.append(tok)
        # co-occurrence
        toks = tokenize(title)
        for i, a in enumerate(toks):
            for b in toks[i + 1 :]:
                if a > b:
                    a, b = b, a
                self.db._conn.execute(
                    """
                    INSERT INTO keyword_cooc(term_a, term_b, count, content_count)
                    VALUES (?,?,1,1)
                    ON CONFLICT(term_a, term_b) DO UPDATE SET
                      count=count+1, content_count=content_count+1
                    """,
                    (a, b),
                )
        self.db._conn.commit()
        return added

    def pick_queries(self, manual: list[str] | None, limit: int = 20) -> list[tuple[str, str]]:
        """Return list of (keyword, query_string) up to limit."""
        now = time.time()
        out: list[tuple[str, str]] = []
        seen_q = set()

        # manual first
        for m in manual or []:
            n = normalize_kw(m)
            if not n:
                continue
            self.add_keyword(n, "manual", "manual")
            for q in self._families(n):
                if q not in seen_q:
                    seen_q.add(q)
                    out.append((n, q))

        # HOT then WARM from DB
        rows = self.db._conn.execute(
            """
            SELECT keyword, status FROM keywords
            WHERE (cooldown_until IS NULL OR cooldown_until < ?)
              AND status IN ('HOT','WARM','COLD')
            ORDER BY
              CASE status WHEN 'HOT' THEN 0 WHEN 'WARM' THEN 1 ELSE 2 END,
              unseen_candidates DESC,
              verified_content DESC
            LIMIT 40
            """,
            (now,),
        ).fetchall()
        for r in rows:
            for q in self._families(r["keyword"]):
                if q not in seen_q:
                    seen_q.add(q)
                    out.append((r["keyword"], q))
            if len(out) >= limit:
                break

        # co-occurrence pairs (top)
        pairs = self.db._conn.execute(
            """
            SELECT term_a, term_b, content_count FROM keyword_cooc
            ORDER BY content_count DESC LIMIT 10
            """
        ).fetchall()
        for p in pairs:
            q = f'site:filester.me/f {p["term_a"]} {p["term_b"]}'
            if q not in seen_q:
                seen_q.add(q)
                out.append((f'{p["term_a"]}+{p["term_b"]}', q))

        return out[:limit]

    def _families(self, kw: str) -> list[str]:
        return [
            f"site:filester.me/f {kw}",
            f'"filester.me/f/" {kw}',
        ]

    def stats(self) -> list[dict]:
        rows = self.db._conn.execute(
            """
            SELECT keyword, category, status, discovery_requests, unique_candidates,
                   unseen_candidates, verified_content, times_used
            FROM keywords ORDER BY
              CASE status WHEN 'HOT' THEN 0 WHEN 'WARM' THEN 1 WHEN 'COLD' THEN 2 ELSE 3 END,
              verified_content DESC
            """
        ).fetchall()
        return [dict(r) for r in rows]
