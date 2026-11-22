from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

from .database import Database


def _normalize_query(q: str) -> str:
    return re.sub(r"\s+", " ", (q or "").strip())


def _fts_query(q: str) -> str:
    q = _normalize_query(q)
    if not q:
        return ""
    if q.startswith('"') and q.endswith('"') and len(q) > 2:
        return q
    tokens = re.findall(r"[\w\-]{2,}", q, flags=re.UNICODE)
    if not tokens:
        return q
    return " ".join(f'"{t}"*' for t in tokens)


class SearchEngine:
    def __init__(self, db: Database):
        self.db = db

    def search(self, query: str, limit: int = 30) -> list[dict[str, Any]]:
        q = _normalize_query(query)
        if not q:
            return []
        fts = _fts_query(q)
        conn = self.db._conn
        rows: list[sqlite3.Row] = []
        try:
            rows = conn.execute(
                """
                SELECT p.url, p.folder_id, p.title, p.description, p.file_count,
                      p.filenames, p.file_meta, p.kind, p.last_seen, p.out_degree, p.is_collection,
                       bm25(pages_fts) AS rank
                FROM pages_fts
                JOIN pages p ON p.rowid = pages_fts.rowid
                WHERE pages_fts MATCH ? AND p.kind = 'folder'
                  AND NOT EXISTS (SELECT 1 FROM excluded_folders e WHERE e.folder_id=p.folder_id)
                ORDER BY rank LIMIT ?
                """,
                (fts, limit * 2),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []
        if not rows:
            like = f"%{q}%"
            rows = conn.execute(
                """
                  SELECT url, folder_id, title, description, file_count, filenames, file_meta, kind,
                       last_seen, out_degree, is_collection, 0.0 AS rank
                FROM pages WHERE kind='folder'
                  AND NOT EXISTS (SELECT 1 FROM excluded_folders e WHERE e.folder_id=pages.folder_id) AND (
                    title LIKE ? OR description LIKE ? OR filenames LIKE ?
                ) ORDER BY file_count DESC LIMIT ?
                """,
                (like, like, like, limit * 2),
            ).fetchall()

        tokens = re.findall(r"[\w\-]{2,}", q.lower(), flags=re.UNICODE)
        if tokens:
            file_name_matches = conn.execute(
                """
                SELECT p.url, p.folder_id, p.title, p.description, p.file_count,
                       p.filenames, p.file_meta, p.kind, p.last_seen, p.out_degree,
                       p.is_collection, 0.0 AS rank
                FROM pages p
                WHERE p.kind='folder'
                  AND NOT EXISTS (SELECT 1 FROM excluded_folders e WHERE e.folder_id=p.folder_id) AND """ + " AND ".join(
                    """EXISTS (
                        SELECT 1 FROM json_each(
                            CASE WHEN json_valid(p.file_meta) THEN p.file_meta ELSE '[]' END
                        ) AS file
                        WHERE lower(COALESCE(json_extract(file.value,'$.name'),'')) LIKE ?
                    )""" for _ in tokens
                ) + " ORDER BY p.file_count DESC LIMIT ?",
                tuple([f"%{token}%" for token in tokens] + [limit * 2]),
            ).fetchall()
            known_urls = {row["url"] for row in rows}
            rows.extend(row for row in file_name_matches if row["url"] not in known_urls)

        results = []
        q_lower = q.lower()
        for r in rows:
            title = r["title"] or ""
            desc = r["description"] or ""
            try:
                names = json.loads(r["filenames"] or "[]")
            except Exception:
                names = []
            try:
                file_meta = json.loads(r["file_meta"] or "[]")
            except Exception:
                file_meta = []
            names = list(dict.fromkeys([
                *[str(name) for name in names],
                *[str(file.get("name")) for file in file_meta if isinstance(file, dict) and file.get("name")],
            ]))
            names_l = [str(n).lower() for n in names]
            bm = float(r["rank"] or 0.0)
            score = max(0.0, 20.0 - bm) if bm else 1.0
            title_l = title.lower()
            if title_l == q_lower:
                score += 12.0
            elif q_lower in title_l:
                score += 6.0
            for t in tokens:
                if t in title_l:
                    score += 2.0
                if any(t in n for n in names_l):
                    score += 1.5
            if q_lower in desc.lower():
                score += 1.0
            score += min(3.0, (r["file_count"] or 0) / 50.0)
            if r["is_collection"] and len(tokens) <= 2:
                score += 0.5
            results.append({
                "score": round(score, 2),
                "title": title or r["folder_id"] or r["url"],
                "files": r["file_count"] or 0,
                "out_degree": r["out_degree"] or 0,
                "is_collection": bool(r["is_collection"]),
                "url": r["url"],
                "folder_id": r["folder_id"],
                "description": desc,
                "sample_files": names[:5],
            })
        results.sort(key=lambda x: (-x["score"], -x["files"]))
        return results[:limit]
