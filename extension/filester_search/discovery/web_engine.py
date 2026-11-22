
from __future__ import annotations

import asyncio
import logging
import random
import time
from collections import defaultdict
from typing import Optional

import httpx

from discovery.keywords import DEFAULT_KEYWORDS, KEYWORDS, tokenize_title
from discovery.prioritize import PRIOR
from discovery.validate import ValidatedFolder, validate_folder
from discovery.web_extract import BLOCKED_IDS, canonical_folder_url
from discovery.web_sources import HEALTH, Hit, run_collectors
from discovery.pool import ingest_hits_to_db
from discovery.network import GuardedClient
from index.database import Database

logger = logging.getLogger("filester.discover_web")


class WebDiscoveryEngine:
    def __init__(self, db: Database):
        self.db = db
        self.known_ids: set[str] = set()
        self.dead_ids: set[str] = set()
        self._load_known()

    def _load_known(self) -> None:
        rows = self.db._conn.execute(
            "SELECT folder_id FROM pages WHERE folder_id IS NOT NULL"
        ).fetchall()
        for r in rows:
            if r["folder_id"]:
                fid = r["folder_id"].lower()
                if fid in BLOCKED_IDS:
                    continue
                self.known_ids.add(fid)

    async def run(
        self,
        *,
        limit: int = 200,
        sources: Optional[list[str]] = None,
        max_validate: int = 80,
        keywords: Optional[list[str]] = None,
        prioritize: bool = True,
        ab_test: bool = False,
    ) -> dict:
        t0 = time.time()
        kws = list(keywords or [])
        if not kws:
            kws = list(DEFAULT_KEYWORDS[:6])

        hits = await run_collectors(
            sources=sources,
            per_source_limit=max(limit, 100),
            keywords=kws,
        )
        await ingest_hits_to_db(self.db, hits)
        discovery_units = len({(h.source_name, h.query) for h in hits})

        by_id: dict[str, list[Hit]] = defaultdict(list)
        for h in hits:
            if h.folder_id in BLOCKED_IDS or self.db.is_folder_excluded(h.folder_id):
                continue
            by_id[h.folder_id].append(h)

        unique_candidates = list(by_id.keys())
        skipped_known = 0
        candidates: list[str] = []
        for fid in unique_candidates:
            if fid in self.known_ids or fid in self.dead_ids:
                skipped_known += 1
                continue
            candidates.append(fid)

        # score each candidate
        scored: list[tuple[float, str]] = []
        for fid in candidates:
            srcs = by_id[fid]
            sources_n = list({h.source_name for h in srcs})
            qclasses = list({h.query_class for h in srcs})
            ts = next((h.external_ts for h in srcs if h.external_ts), "")
            sc = PRIOR.score_candidate(
                sources=sources_n,
                query_classes=qclasses,
                external_ts=ts,
                independent_source_count=len(sources_n),
            )
            scored.append((sc, fid))

        if ab_test:
            return await self._ab_test(scored, by_id, max_validate, t0, discovery_units, skipped_known)

        if prioritize:
            scored.sort(key=lambda x: -x[0])
            ordered = [fid for _, fid in scored]
        else:
            ordered = [fid for _, fid in scored]
            random.shuffle(ordered)

        ordered = ordered[:max_validate]
        return await self._validate_batch(
            ordered, by_id, t0, discovery_units, skipped_known, mode="priority" if prioritize else "fifo"
        )

    async def _ab_test(self, scored, by_id, max_validate, t0, discovery_units, skipped_known):
        budget = max(1, max_validate // 2)
        # FIFO = original order
        fifo_ids = [fid for _, fid in scored][:budget]
        # Priority = sorted
        prio_ids = [fid for _, fid in sorted(scored, key=lambda x: -x[0])][:budget]

        print("\n--- A/B: FIFO validation ---", flush=True)
        fifo = await self._validate_batch(
            fifo_ids, by_id, t0, discovery_units, skipped_known, mode="fifo", quiet_scoreboard=True
        )
        print("\n--- A/B: PRIORITY validation ---", flush=True)
        # avoid re-validating overlap: use separate unknown set - for fair A/B same pool
        # reset known for second arm only for IDs not in fifo... actually same pool means
        # second arm would skip. Run priority on same list scoring only report.
        # Fair comparison: validate priority set; if overlap with fifo already validated, count as hit without re-GET
        prio_content = 0
        prio_dead = 0
        prio_coll = 0
        prio_val = 0
        for fid in prio_ids:
            if fid in self.known_ids and fid not in self.dead_ids:
                # already validated in FIFO arm
                prio_val += 1
                # look up type from db
                row = self.db.get_page(f"https://filester.me/f/{fid}")
                if row and row["is_collection"]:
                    prio_coll += 1
                elif row and (row["file_count"] or 0) > 0:
                    prio_content += 1
                continue
            # validate remaining
            async with httpx.AsyncClient(
                headers={"User-Agent": "FilesterPublicIndexer/6.1 (+ab)"},
                timeout=httpx.Timeout(20.0),
                follow_redirects=True,
            ) as client:
                v = await validate_folder(client, fid)
            prio_val += 1
            if v.folder_type == "CONTENT_FOLDER":
                prio_content += 1
            elif v.folder_type == "DEAD":
                prio_dead += 1
            elif v.folder_type == "COLLECTION":
                prio_coll += 1

        print("\n=== A/B SCOREBOARD (same candidate pool) ===")
        print(f"{'metric':28} {'FIFO':>10} {'PRIORITY':>10}")
        print(f"{'validations':28} {fifo.get('validation_requests'):>10} {prio_val:>10}")
        print(f"{'CONTENT_FOLDER':28} {fifo.get('NEW_standalone_content_folders'):>10} {prio_content:>10}")
        print(f"{'collections':28} {fifo.get('collections_skipped_score'):>10} {prio_coll:>10}")
        print(f"{'dead':28} {fifo.get('dead_links'):>10} {prio_dead:>10}")
        fr = fifo.get('NEW_standalone_content_folders', 0) / max(1, fifo.get('validation_requests', 1))
        pr = prio_content / max(1, prio_val)
        print(f"{'content/request':28} {fr:>10.3f} {pr:>10.3f}")
        fifo["ab"] = {
            "fifo_content": fifo.get("NEW_standalone_content_folders"),
            "priority_content": prio_content,
            "fifo_cpr": round(fr, 3),
            "priority_cpr": round(pr, 3),
        }
        return fifo

    async def _validate_batch(
        self,
        ordered: list[str],
        by_id: dict,
        t0: float,
        discovery_units: int,
        skipped_known: int,
        mode: str = "priority",
        quiet_scoreboard: bool = False,
    ) -> dict:
        verified: list[ValidatedFolder] = []
        new_content: list[tuple[ValidatedFolder, list]] = []
        dead = collections = mixed = errors = 0

        async with GuardedClient(
            headers={"User-Agent": "FilesterPublicIndexer/6.1 (+validate)"},
            max_requests=len(ordered),
        ) as client:
            for fid in ordered:
                srcs = by_id[fid]
                v = await validate_folder(client, fid)
                verified.append(v)
                if v.folder_type == "ERROR":
                    errors += 1
                    self.db.defer_candidate(fid, 60)
                    continue
                await asyncio.sleep(0.3)

                age_b = PRIOR.age_bucket(next((h.external_ts for h in srcs if h.external_ts), ""))
                PRIOR.observe(
                    source=srcs[0].source_name,
                    query_class=srcs[0].query_class,
                    age_bucket=age_b,
                    folder_type=v.folder_type,
                )

                if v.folder_type == "DEAD":
                    dead += 1
                    self.dead_ids.add(fid)
                    continue
                if v.folder_type == "COLLECTION":
                    collections += 1
                elif v.folder_type == "MIXED":
                    mixed += 1
                elif v.folder_type == "ERROR":
                    errors += 1

                primary = srcs[0]
                self.db.upsert_page({
                    "url": v.url,
                    "folder_id": v.folder_id,
                    "kind": "folder",
                    "title": v.title,
                    "description": f"source={primary.source_name} type={v.folder_type}",
                    "file_count": v.file_count,
                    "filenames": [],
                    "out_degree": v.subfolder_count,
                    "is_collection": v.folder_type == "COLLECTION",
                    "http_status": v.http_status,
                    "depth": 0,
                    "source": f"web:{primary.source_name}",
                    "content_hash": f"web:{v.folder_id}:{v.file_count}:{int(time.time())}",
                })
                self.known_ids.add(fid)

                if v.folder_type == "CONTENT_FOLDER":
                    new_content.append((v, srcs))
                    # keyword credit
                    for h in srcs:
                        for kw in DEFAULT_KEYWORDS:
                            if kw in (h.query or "").lower():
                                KEYWORDS.record_content(kw)
                    # expand keywords from title
                    for tok in tokenize_title(v.title)[:3]:
                        KEYWORDS.record_query(tok, [fid])
                    print(
                        f"+  {v.title[:32]:32}  {v.file_count:5}  {v.subfolder_count:3}  "
                        f"{primary.source_name}/{primary.query_class}  {v.url}",
                        flush=True,
                    )

        elapsed = time.time() - t0
        source_new: dict[str, int] = defaultdict(int)
        source_req: dict[str, int] = defaultdict(int)
        for fid, srcs in by_id.items():
            for h in srcs:
                source_req[h.source_name] += 1
        for v, srcs in new_content:
            source_new[srcs[0].source_name] += 1

        scoreboard = {
            "mode": mode,
            "unique_candidates": len(by_id),
            "skipped_already_known": skipped_known,
            "validated": len(verified),
            "dead_links": dead,
            "collections_skipped_score": collections,
            "mixed": mixed,
            "errors": errors,
            "NEW_standalone_content_folders": len(new_content),
            "discovery_query_units": discovery_units,
            "validation_requests": len(ordered),
            "new_content_per_validation": round(len(new_content) / max(1, len(ordered)), 3),
            "new_content_per_discovery_unit": round(len(new_content) / max(1, discovery_units), 3),
            "elapsed_s": round(elapsed, 1),
            "by_source": {
                s: {"hit_rows": source_req.get(s, 0), "new_content": source_new.get(s, 0)}
                for s in sorted(set(list(source_req) + list(source_new)))
            },
            "source_health": HEALTH.summary(),
            "folders": [
                {
                    "title": v.title,
                    "url": v.url,
                    "files": v.file_count,
                    "subs": v.subfolder_count,
                    "source": srcs[0].source_name,
                    "query_class": srcs[0].query_class,
                }
                for v, srcs in new_content
            ],
        }
        if not quiet_scoreboard:
            pass
        return scoreboard
