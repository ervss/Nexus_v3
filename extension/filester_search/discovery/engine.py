from __future__ import annotations

"""
Discovery engine v3 — maximize NOVEL_PUBLIC_FOLDER_IDS / request.

Measured baseline (recon):
  collection_html: 1 GET -> ~467 unique /f/ IDs (full grid in HTML)
  leaf_html:       1 GET -> 1-2 IDs (self + parent)
  mirror_*:        0 differential vs filester.me
  public API feed: absent (404/401)
  blog/static:     0 /f/ IDs

Strategy:
  1. Seed URLs cost 0 novelty points (operator-supplied).
  2. Prefer FETCH only nodes that may be collections / unknown.
  3. From every response, generic-extract all /f/ IDs; credit channel.
  4. Enqueue unknown IDs; prioritize suspected collections.
  5. Optional sample of leaves only for parent-backlink bridges.
"""


import asyncio
import logging
import re
import time
from typing import Optional
from urllib.parse import urlparse

from config import Config
from crawler.fetcher import Fetcher
from crawler.rate_limit import AdaptiveLimiter
from discovery.extract import (
    extract_download_slugs,
    extract_folder_ids,
    looks_like_collection,
    subfolder_count_meta,
)
from index.database import Database
from metrics.yield_tracker import YieldTracker
from discovery.web_extract import normalize_folder_id

logger = logging.getLogger("filester.discover")


def fid_url(fid: str) -> str:
    return f"https://filester.me/f/{fid.lower()}"


class DiscoveryEngine:
    def __init__(self, cfg: Config, db: Database):
        self.cfg = cfg
        self.db = db
        self.tracker = YieldTracker()
        self.limiter = AdaptiveLimiter(
            max_rps=cfg.max_rps,
            min_rps=cfg.min_rps,
            concurrency=cfg.start_concurrency,
            min_concurrency=cfg.min_concurrency,
            max_concurrency=min(cfg.max_concurrency, 4),
            latency_high_ms=cfg.latency_high_ms,
        )
        self.fetcher = Fetcher(
            self.limiter,
            user_agent=cfg.user_agent,
            connect_timeout=cfg.connect_timeout,
            read_timeout=cfg.read_timeout,
            max_retries=cfg.max_retries,
            backoff_base=cfg.backoff_base,
            backoff_cap=cfg.backoff_cap,
        )
        self._stop = asyncio.Event()
        self._known: set[str] = set()
        self._allowed = cfg.allowed_hosts()

    def request_stop(self) -> None:
        self._stop.set()

    def _load_known(self) -> None:
        rows = self.db._conn.execute(
            "SELECT folder_id FROM pages WHERE folder_id IS NOT NULL"
        ).fetchall()
        for r in rows:
            if r["folder_id"]:
                self._known.add(r["folder_id"].lower())
        # also anything already done in queue
        for r in self.db._conn.execute("SELECT url FROM crawl_queue WHERE status='done'").fetchall():
            if fid := normalize_folder_id(r["url"]):
                self._known.add(fid)

    async def run(
        self,
        seeds: list[str],
        *,
        max_requests: int = 50,
        sample_leaves: bool = True,
    ) -> dict:
        self._load_known()
        seed_fids: list[str] = []
        for s in seeds:
            if fid := normalize_folder_id("https://filester.me" + s if s.startswith("/f/") else s):
                seed_fids.append(fid)
                self.tracker.mark_seed(fid)
                # seeds themselves are 0 points but must be fetched as entry
                self.db.enqueue(fid_url(fid), depth=0, priority=1)

        await self.fetcher.start()
        reqs = 0
        try:
            while not self._stop.is_set() and reqs < max_requests:
                batch = self.db.claim_batch(limit=1)
                if not batch:
                    break
                url = batch[0]["url"]
                depth = batch[0]["depth"]
                await self._process(url, depth, sample_leaves=sample_leaves)
                reqs += 1
        finally:
            await self.fetcher.close()

        try:
            self.db.recompute_in_degrees()
        except Exception:
            pass

        summary = self.tracker.summary()
        summary["db"] = self.db.stats()
        summary["known_total"] = len(self._known)
        return summary

    async def _process(self, url: str, depth: int, sample_leaves: bool) -> None:
        t0 = time.perf_counter()
        result = await self.fetcher.get(url)
        latency = (time.perf_counter() - t0) * 1000
        self.db.log_fetch(url, result.status, latency, len(result.text or ""))

        page_fid = normalize_folder_id(url)

        if result.error or result.status in (0, 401, 403, 404):
            channel = "error"
            self.tracker.record(channel, ids=[], already_known=self._known, latency_ms=latency, error=True)
            self.db.mark_error(url, result.error or f"status:{result.status}", requeue=False)
            return

        html = result.text or ""
        ids = extract_folder_ids(html)
        is_coll = looks_like_collection(html, len(ids))
        sub_meta = subfolder_count_meta(html)
        channel = "collection_html" if is_coll else "leaf_html"

        novel = self.tracker.record(
            channel, ids=ids, already_known=self._known, latency_ms=latency
        )

        # persist page row (lightweight)
        title = ""
        mt = re.search(r'og:title" content="([^"]+)"', html)
        if mt:
            title = mt.group(1)
        ft = re.search(r'class="folder-title"[^>]*>([^<]+)', html)
        if ft:
            title = ft.group(1).strip() or title
        desc = ""
        md = re.search(r'og:description" content="([^"]+)"', html)
        if md:
            desc = md.group(1)
        fc = 0
        mfc = re.search(r"with\s+(\d+)\s+files?", desc, re.I)
        if mfc:
            fc = int(mfc.group(1))

        self.db.upsert_page({
            "url": url.split("?")[0],
            "folder_id": page_fid,
            "kind": "folder" if page_fid else "page",
            "title": title,
            "description": desc,
            "file_count": fc,
            "filenames": [],
            "file_slugs": extract_download_slugs(html)[:50],
            "out_degree": max(0, len(ids) - (1 if page_fid in ids else 0)),
            "is_collection": is_coll,
            "http_status": result.status,
            "depth": depth,
            "source": channel,
            "content_hash": str(len(html)) + ":" + (page_fid or ""),
        })

        if page_fid:
            self._known.add(page_fid)

        # Enqueue novel IDs — collections first (priority 2), unknown next (5), 
        # leaves only sampled for bridge (40)
        batch = []
        for fid in novel:
            self._known.add(fid)
            self.db.add_link(url.split("?")[0], fid_url(fid), "folder")
            # don't fetch every leaf: if parent was collection, children already "discovered"
            # only queue child fetch if we need bridges / confirm nested collections
            # Nested collection probe: queue with medium priority
            batch.append((fid_url(fid), depth + 1, 12))

        # Also register non-novel ids as known graph edges
        for fid in ids:
            fid = fid.lower()
            self.db.add_link(url.split("?")[0], fid_url(fid), "folder")
            if fid not in self._known:
                self._known.add(fid)
                batch.append((fid_url(fid), depth + 1, 12))

        if batch:
            # Cap leaf fetches: if this page WAS a collection, we already got IDs.
            # Only probe a fraction of children for nested collections (high yield check).
            if is_coll:
                # Sort stable; take first N probes for nested collections
                probe_n = min(15, len(batch))
                batch = batch[:probe_n]
                logger.info(
                    "collection id=%s title=%r subfolders_meta=%s ids_in_html=%s novel=%s probe_children=%s",
                    page_fid, title, sub_meta, len(ids), len(novel), probe_n,
                )
            else:
                logger.info(
                    "leaf id=%s title=%r ids=%s novel=%s",
                    page_fid, title, len(ids), len(novel),
                )

            self.db.enqueue_many(batch)

        self.db.mark_done(url)
