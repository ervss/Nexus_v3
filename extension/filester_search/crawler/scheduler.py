from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Optional

from config import Config
from index.database import Database
from .discovery import expand_seeds, prioritize_url
from .fetcher import Fetcher
from .parser import folder_id_from_url, parse_html
from .rate_limit import AdaptiveLimiter

logger = logging.getLogger("filester.crawler")


class CrawlScheduler:
    def __init__(self, cfg: Config, db: Database):
        self.cfg = cfg
        self.db = db
        self.limiter = AdaptiveLimiter(
            max_rps=cfg.max_rps,
            min_rps=cfg.min_rps,
            concurrency=cfg.start_concurrency,
            min_concurrency=cfg.min_concurrency,
            max_concurrency=cfg.max_concurrency,
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
        self._pages_done = 0
        self._folders_found = 0
        self._new_edges = 0
        self._started = 0.0
        self._allowed = cfg.allowed_hosts()

    def request_stop(self) -> None:
        self._stop.set()

    async def run(self, seeds: list[str] | None = None, max_pages: Optional[int] = None) -> dict:
        max_pages = self.cfg.max_pages if max_pages is None else max_pages
        self._started = time.time()
        recovered = self.db.recover_inflight()
        if recovered:
            logger.info("recovered_inflight count=%s", recovered)

        seed_list = expand_seeds(seeds or self.cfg.default_seeds, self._allowed)
        for u in seed_list:
            self.db.enqueue(u, depth=0, priority=prioritize_url(u))

        await self.fetcher.start()
        try:
            workers = [asyncio.create_task(self._worker(i, max_pages)) for i in range(self.cfg.max_workers)]
            await asyncio.gather(*workers)
        finally:
            await self.fetcher.close()

        try:
            self.db.recompute_in_degrees()
        except Exception as exc:
            logger.debug("in_degree recompute failed: %s", exc)

        return {
            "pages_done": self._pages_done,
            "folders_found": self._folders_found,
            "new_edges": self._new_edges,
            "elapsed_s": round(time.time() - self._started, 1),
            "limiter": self.limiter.stats,
            "db": self.db.stats(),
        }

    async def _worker(self, wid: int, max_pages: int) -> None:
        idle_rounds = 0
        while not self._stop.is_set():
            if max_pages and self._pages_done >= max_pages:
                self._stop.set()
                break
            batch = self.db.claim_batch(limit=1)
            if not batch:
                idle_rounds += 1
                if idle_rounds > 15:
                    break
                await asyncio.sleep(0.4)
                continue
            idle_rounds = 0
            row = batch[0]
            await self._process(row["url"], row["depth"], row["attempts"])

    async def _process(self, url: str, depth: int, attempts: int) -> None:
        base_url = url.split("?")[0]
        existing = self.db.get_page(url) or self.db.get_page(base_url)
        etag = existing["etag"] if existing else None
        last_mod = existing["last_modified"] if existing else None

        result = await self.fetcher.get(url, etag=etag, last_mod=last_mod)
        self.db.log_fetch(url, result.status, result.latency_ms, len(result.text or ""))

        if result.error and result.status in (401, 403):
            logger.warning("boundary_skip url=%s status=%s", url, result.status)
            self.db.mark_error(url, result.error, requeue=False)
            self.db.upsert_page({
                "url": base_url, "kind": "page", "http_status": result.status,
                "error": result.error, "depth": depth, "source": "boundary",
            })
            self._pages_done += 1
            return

        if result.error or result.status == 0:
            requeue = attempts < self.cfg.max_retries
            self.db.mark_error(url, result.error or "unknown", requeue=requeue)
            logger.warning("fetch_fail url=%s err=%s requeue=%s", url, result.error, requeue)
            return

        if result.status == 304 and existing:
            self.db.mark_done(url)
            self._pages_done += 1
            return

        if result.status == 404:
            self.db.upsert_page({
                "url": base_url, "kind": "page", "http_status": 404,
                "error": "not_found", "depth": depth, "source": "crawl",
            })
            self.db.mark_done(url)
            self._pages_done += 1
            return

        parsed = parse_html(url, result.text, status=result.status, allowed_hosts=self._allowed)
        store_url = base_url if parsed.kind == "folder" else parsed.url
        merged_names = list(parsed.filenames)
        merged_slugs = list(parsed.file_slugs)
        merged_meta = list(parsed.file_meta)
        merged_thumbs = list(parsed.thumb_ids)
        merged_count = parsed.file_count
        merged_hash = parsed.content_hash

        if parsed.kind == "folder" and parsed.page_number > 1 and existing:
            try:
                prev = json.loads(existing["filenames"] or "[]")
            except Exception:
                prev = []
            seen = set(prev)
            for n in parsed.filenames:
                if n not in seen:
                    prev.append(n)
                    seen.add(n)
            merged_names = prev
            try:
                prev_s = json.loads(existing["file_slugs"] or "[]") if existing["file_slugs"] else []
            except Exception:
                prev_s = []
            ss = set(prev_s)
            for s in parsed.file_slugs:
                if s not in ss:
                    prev_s.append(s)
                    ss.add(s)
            merged_slugs = prev_s
            try:
                prev_meta = json.loads(existing["file_meta"] or "[]") if existing["file_meta"] else []
            except Exception:
                prev_meta = []
            meta_by_name = {item.get("name"): item for item in prev_meta if item.get("name")}
            meta_by_name.update({item["name"]: item for item in parsed.file_meta if item.get("name")})
            merged_meta = list(meta_by_name.values())
            try:
                prev_thumbs = json.loads(existing["thumb_ids"] or "[]") if existing["thumb_ids"] else []
            except Exception:
                prev_thumbs = []
            merged_thumbs = list(dict.fromkeys([*prev_thumbs, *parsed.thumb_ids]))
            merged_count = max(int(existing["file_count"] or 0), parsed.file_count, len(merged_names))
            if existing["out_degree"] and existing["out_degree"] > parsed.out_degree:
                parsed.out_degree = existing["out_degree"]
                parsed.is_collection = bool(existing["is_collection"]) or parsed.is_collection

        try:
            stored_meta = json.loads(existing["file_meta"] or "[]") if existing else []
        except Exception:
            stored_meta = []
        needs_metadata = existing and (
            (parsed.file_meta and not stored_meta)
            or (parsed.file_meta and any("thumb_id" not in item for item in stored_meta if isinstance(item, dict)))
            or (parsed.thumb_ids and not existing["thumb_ids"])
        )
        if existing and existing["content_hash"] == merged_hash and parsed.page_number <= 1 and not needs_metadata:
            self.db.mark_done(url)
            self._pages_done += 1
            return

        self.db.upsert_page({
            "url": store_url,
            "folder_id": parsed.folder_id,
            "kind": parsed.kind,
            "title": parsed.title or (existing["title"] if existing else ""),
            "description": parsed.description or (existing["description"] if existing else ""),
            "file_count": merged_count,
            "filenames": merged_names,
            "file_slugs": merged_slugs,
            "file_meta": merged_meta,
            "thumb_ids": merged_thumbs,
            "tags": parsed.tags,
            "out_degree": parsed.out_degree,
            "is_collection": parsed.is_collection,
            "content_hash": merged_hash,
            "http_status": parsed.http_status,
            "etag": result.headers.get("etag") or result.headers.get("ETag"),
            "last_modified": result.headers.get("last-modified") or result.headers.get("Last-Modified"),
            "depth": depth,
            "source": "crawl",
            "error": None,
        })

        if parsed.kind == "folder" and parsed.page_number <= 1:
            self._folders_found += 1
            logger.info(
                "folder id=%s title=%r files=%s out_degree=%s collection=%s",
                parsed.folder_id, parsed.title, merged_count,
                parsed.out_degree, parsed.is_collection,
            )

        batch: list[tuple[str, int, int]] = []
        if depth < self.cfg.max_depth:
            for link in parsed.outbound_folders:
                self.db.add_link(store_url, link, "folder")
                self._new_edges += 1
                batch.append((
                    link, depth + 1,
                    prioritize_url(link, out_degree_hint=parsed.out_degree, is_collection=parsed.is_collection),
                ))
            for link in parsed.outbound_pages:
                self.db.add_link(store_url, link, "page")
                batch.append((link, depth + 1, prioritize_url(link)))

        if parsed.folder_id and parsed.pagination_urls:
            capped = 0
            for pu in parsed.pagination_urls:
                if capped >= self.cfg.max_pages_per_folder:
                    break
                if folder_id_from_url(pu) != parsed.folder_id:
                    continue
                self.db.add_link(store_url, pu, "pagination")
                batch.append((pu, depth, prioritize_url(pu)))
                capped += 1

        if batch:
            n = self.db.enqueue_many(batch)
            if n:
                logger.debug("enqueued_new=%s from=%s", n, url)

        self.db.mark_done(url)
        self._pages_done += 1
