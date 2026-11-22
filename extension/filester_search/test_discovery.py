"""Offline regressions for bounded discovery and persisted frontier ownership."""
import asyncio
import io
import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from benchmark_discovery import fid, page
from discovery import pool, web_sources
from discovery.network import GuardedClient, NetworkStore, RequestBudgetExceeded
from discovery.prioritize import Prioritizer
from discovery.validate import validate_folder
from discovery.web_extract import canonical_folder_url, normalize_folder_id
from index.database import Database, SCHEMA
from exclusions import EXCLUDED_FOLDER_ROOTS


class DiscoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="filester-graph-test-")
        self.path = Path(self.tmp.name)/"index.db"
        self.db = Database(self.path)
        self.pages = {}
        self.calls = []
        self.active = self.max_active = 0
        self.started = asyncio.Event()
        self.release = None
        test = self

        class FakeClient:
            def __init__(self, **kwargs):
                self.network_requests = 0
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            async def get(self, url, **kwargs):
                self.network_requests += 1
                test.calls.append(url)
                test.active += 1
                test.max_active = max(test.max_active, test.active)
                test.started.set()
                try:
                    if test.release:
                        await test.release.wait()
                    await asyncio.sleep(.001)
                    value = test.pages.get(normalize_folder_id(url), 404)
                    if isinstance(value, Exception):
                        raise value
                    return httpx.Response(value if isinstance(value, int) else 200,
                                          text=value if isinstance(value, str) else "",
                                          request=httpx.Request("GET", url))
                finally:
                    test.active -= 1
        self.client = FakeClient
        self.client_patch = patch.object(pool, "GuardedClient", FakeClient)
        self.prior_patch = patch.object(pool, "PRIOR", Prioritizer())
        self.client_patch.start()
        self.prior_patch.start()

    def tearDown(self):
        self.client_patch.stop()
        self.prior_patch.stop()
        self.db.close()
        self.tmp.cleanup()

    def seed(self, n, score=.35):
        self.db.upsert_candidate(fid(n), ["urlscan"], ["test"], score=score)

    def row(self, n):
        return self.db._conn.execute("SELECT * FROM candidates WHERE folder_id=?", (fid(n),)).fetchone()

    async def test_outbound_survives_validation_and_normalizes(self):
        self.pages[fid(1)] = page(1, 2, [1, 2, 2]) + f'<a href="https://filester.sh/f/{fid(2).upper()}">mirror</a>'
        result = await validate_folder(self.client(), fid(1))
        self.assertEqual(result.outbound_folders, [fid(2)])
        self.assertEqual(result.folder_type, "CONTENT_FOLDER")
        self.assertIsNone(normalize_folder_id("https://example.org/f/"+fid(2)))

    async def test_graph_cycle_depth_and_provenance(self):
        self.seed(1)
        self.pages.update({fid(1): page(1, links=[2, 2]), fid(2): page(2, links=[1, 3]), fid(3): page(3, 3)})
        result = await pool.validate_pool(self.db, budget=10)
        self.assertEqual(result["processed"], 3)
        self.assertEqual(result["CONTENT"], 1)
        self.assertEqual(result["snowball_candidates"], 2)
        self.assertEqual(result["snowball_CONTENT"], 1)
        self.assertEqual(result["max_discovery_depth"], 2)
        self.assertEqual(len(self.calls), len(set(self.calls)))
        self.assertEqual(json.loads(self.row(3)["sources"]), ["snowball", "collection"])
        self.assertEqual(self.db._conn.execute("SELECT COUNT(*) FROM links").fetchone()[0], 3)
        self.assertLessEqual(self.max_active, 2)

    async def test_validation_budget_and_frontier_survive_restart(self):
        self.seed(1)
        self.pages.update({fid(1): page(1, links=[2]), fid(2): page(2, links=[3]), fid(3): page(3, 3)})
        result = await pool.validate_pool(self.db, budget=1)
        self.assertEqual(result["processed"], 1)
        self.assertEqual(self.row(2)["status"], "unvalidated")
        self.db.close()
        self.db = Database(self.path)
        result = await pool.validate_pool(self.db, budget=2)
        self.assertEqual(result["CONTENT"], 1)
        self.assertEqual(len(set(self.calls)), 3)

    async def test_depth_and_growth_caps(self):
        self.seed(1)
        self.pages.update({fid(1): page(1, links=[2, 3, 4]), fid(2): page(2, links=[5])})
        await pool.validate_pool(self.db, budget=8, max_depth=1, max_new_candidates=1)
        self.assertEqual(self.db.candidate_stats()["total"], 2)
        self.assertIsNone(self.row(5))
        self.assertEqual(len(self.calls), 2)

    async def test_zero_budget_no_network(self):
        self.seed(1)
        result = await pool.validate_pool(self.db, budget=0)
        self.assertEqual(result["processed"], 0)
        self.assertEqual(self.calls, [])
        with self.assertRaises(ValueError):
            await pool.validate_pool(self.db, budget=-1)

    async def test_separate_request_budget(self):
        for n in range(1, 6):
            self.seed(n)
            self.pages[fid(n)] = page(n, 1)
        result = await pool.validate_pool(self.db, budget=5, request_budget=1)
        self.assertEqual(result["processed"], 1)
        self.assertEqual(len(self.calls), 1)

    async def test_transient_errors_are_deferred_and_recover(self):
        for n, error in enumerate([httpx.ReadTimeout("fixture"), 429, 503, httpx.ConnectError("reset")], 1):
            self.seed(n)
            self.pages[fid(n)] = error
        result = await pool.validate_pool(self.db, budget=4)
        self.assertEqual(result["deferred"], 4)
        self.assertEqual(result["DEAD"], 0)
        self.assertEqual(self.db.candidate_stats()["unvalidated"], 4)
        again = await pool.validate_pool(self.db, budget=4)
        self.assertEqual(again["processed"], 0)
        self.assertEqual(len(self.calls), 4)
        self.db._conn.execute("UPDATE candidates SET retry_after=0")
        self.db._conn.commit()
        self.pages = {fid(n): page(n, 1) for n in range(1, 5)}
        recovered = await pool.validate_pool(self.db, budget=4)
        self.assertEqual(recovered["CONTENT"], 4)

    async def test_unicode_title_does_not_fail_on_legacy_windows_console(self):
        self.seed(1)
        self.pages[fid(1)] = page(1, 1).replace("Fixture 1", "한글 제목 🔞")
        raw = io.BytesIO()
        console = io.TextIOWrapper(raw, encoding="cp1250", errors="strict")
        try:
            with patch.object(pool.sys, "stdout", console):
                result = await pool.validate_pool(self.db, budget=1)
            console.flush()
            output = raw.getvalue().decode("cp1250")
        finally:
            console.detach()
        self.assertEqual(result["CONTENT"], 1)
        self.assertEqual(result["ERROR"], 0)
        self.assertEqual(self.row(1)["status"], "validated")
        self.assertIn("\\ud55c", output)

    async def test_unexpected_candidate_error_does_not_cancel_pool(self):
        for n in (1, 2):
            self.seed(n)
            self.pages[fid(n)] = page(n, 1)
        real_validate = pool.validate_folder

        async def one_bad_candidate(client, candidate):
            if candidate == fid(1):
                raise RuntimeError("unexpected parser edge case")
            return await real_validate(client, candidate)

        with patch.object(pool, "validate_folder", one_bad_candidate):
            result = await pool.validate_pool(self.db, budget=2)
        self.assertEqual(result["processed"], 2)
        self.assertEqual(result["CONTENT"], 1)
        self.assertEqual(result["ERROR"], 1)
        self.assertEqual(result["deferred"], 1)
        self.assertEqual(self.row(1)["status"], "unvalidated")
        self.assertGreater(self.row(1)["retry_after"], time.time())
        self.assertEqual(self.row(2)["status"], "validated")

    async def test_permanent_dead_requires_404_or_410(self):
        for n, status in enumerate([404, 410], 1):
            self.seed(n)
            self.pages[fid(n)] = status
        result = await pool.validate_pool(self.db, budget=2)
        self.assertEqual(result["DEAD"], 2)
        self.assertEqual(self.db.candidate_stats()["unvalidated"], 0)

    async def test_deterministic_priority_ties(self):
        for n in (3, 1, 2):
            self.seed(n)
        self.db._conn.execute("UPDATE candidates SET first_seen=1")
        self.db._conn.commit()
        self.assertEqual([r["folder_id"] for r in self.db.list_candidates()], [fid(1), fid(2), fid(3)])
        await pool.validate_pool(self.db, budget=2)
        self.assertEqual(self.calls, [canonical_folder_url(fid(1)), canonical_folder_url(fid(2))])

    async def test_collector_merges_provenance_during_validation(self):
        self.seed(1)
        self.pages[fid(1)] = page(1, 1)
        self.release = asyncio.Event()
        task = asyncio.create_task(pool.validate_pool(self.db, budget=2))
        await self.started.wait()
        hits = [web_sources.Hit(fid(1).upper(), "wayback_cdx", "fixture", "history", "q")]*3
        self.assertEqual(await pool.ingest_hits_to_db(self.db, hits), 0)
        self.release.set()
        await task
        self.assertEqual(await pool.ingest_hits_to_db(self.db, hits), 0)
        self.assertEqual(self.row(1)["status"], "validated")
        self.assertEqual(set(json.loads(self.row(1)["sources"])), {"urlscan", "wayback_cdx"})
        self.assertEqual(len(self.calls), 1)

    async def test_two_database_connections_do_not_double_validate(self):
        for n in range(1, 5):
            self.seed(n)
            self.pages[fid(n)] = page(n, 1)
        other = Database(self.path)
        try:
            results = await asyncio.gather(pool.validate_pool(self.db, budget=4), pool.validate_pool(other, budget=4))
        finally:
            other.close()
        self.assertEqual(sum(r["processed"] for r in results), 4)
        self.assertEqual(len(self.calls), len(set(self.calls)))

    async def test_cancellation_releases_claims_and_preserves_pending(self):
        self.seed(1)
        self.release = asyncio.Event()
        task = asyncio.create_task(pool.validate_pool(self.db, budget=1))
        await self.started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.row(1)["claim_token"], "")
        self.assertEqual(self.row(1)["status"], "unvalidated")
        self.assertEqual(self.active, 0)

    async def test_expired_claim_is_recoverable(self):
        self.seed(1)
        self.assertTrue(self.db.claim_candidate(fid(1), "crashed", lease_seconds=-1))
        self.assertTrue(self.db.claim_candidate(fid(1), "new-owner"))
        self.assertFalse(self.db.claim_candidate(fid(1), "another-owner"))
        self.db.release_claims("new-owner")

    async def test_local_edges_and_unexpanded_hubs(self):
        parent = canonical_folder_url(fid(1))
        self.db.upsert_page({"url": parent, "folder_id": fid(1), "kind": "folder", "is_collection": True, "http_status": 200})
        self.db.add_link(parent, canonical_folder_url(fid(2)))
        self.pages[fid(2)] = page(2, 2)
        result = await pool.validate_pool(self.db, budget=1)
        self.assertEqual(result["local_candidates"], 1)
        self.assertEqual(result["CONTENT"], 1)
        self.assertEqual(result["snowball_CONTENT"], 0)
        self.assertEqual(self.calls, [canonical_folder_url(fid(2))])
        self.assertIn("existing_index", json.loads(self.row(2)["sources"]))
        hub = canonical_folder_url(fid(3))
        self.db.upsert_page({"url": hub, "folder_id": fid(3), "kind": "folder", "is_collection": True, "http_status": 200})
        self.assertEqual(pool.seed_local_frontier(self.db, 10, 3), 1)
        self.assertEqual(pool.seed_local_frontier(self.db, 10, 3), 0)

    async def test_operator_exclusion_cascades_without_network_requests(self):
        root_id = next(iter(EXCLUDED_FOLDER_ROOTS))
        root_url = canonical_folder_url(root_id)
        child_id, grandchild_id, unrelated_id = fid(91), fid(92), fid(93)
        self.db.upsert_candidate(child_id, ["existing_index"], ["graph"], score=10)
        self.db.add_link(root_url, canonical_folder_url(child_id))
        self.db.add_link(canonical_folder_url(child_id), canonical_folder_url(grandchild_id))

        self.assertTrue(self.db.is_folder_excluded(root_id))
        self.assertTrue(self.db.is_folder_excluded(child_id))
        self.assertTrue(self.db.is_folder_excluded(grandchild_id))
        self.assertEqual(self.row(91)["status"], "excluded")
        self.assertFalse(self.db.upsert_candidate(grandchild_id, ["urlscan"], ["test"], score=10))
        self.assertFalse(self.db.enqueue(canonical_folder_url(grandchild_id)))
        excluded_hit = web_sources.Hit(grandchild_id, "urlscan", "fixture", "test", "q")
        self.assertEqual(await pool.ingest_hits_to_db(self.db, [excluded_hit]), 0)

        self.db.upsert_candidate(unrelated_id, ["urlscan"], ["test"], score=1)
        self.pages[unrelated_id] = page(93, 1)
        result = await pool.validate_pool(self.db, budget=3)
        self.assertEqual(result["processed"], 1)
        self.assertEqual(self.calls, [canonical_folder_url(unrelated_id)])

        future_id = fid(94)
        self.db.add_link(canonical_folder_url(grandchild_id), canonical_folder_url(future_id))
        self.assertTrue(self.db.is_folder_excluded(future_id))

    async def test_schema_upgrade_preserves_existing_candidates(self):
        path = Path(self.tmp.name)/"legacy.db"
        with sqlite3.connect(path) as conn:
            conn.executescript(SCHEMA)
            conn.execute("INSERT INTO candidates(folder_id,sources,status) VALUES (?,?,?)", (fid(1), '["old"]', "validated"))
        conn.close()
        upgraded = Database(path)
        try:
            row = upgraded.list_candidates(status="validated")[0]
            self.assertEqual(row["sources"], '["old"]')
            self.assertEqual(row["discovery_depth"], 0)
            self.assertFalse(upgraded.claim_candidate(fid(1), "test"))
        finally:
            upgraded.close()

    async def test_guard_counts_redirects_and_enforces_wire_budget(self):
        store = NetworkStore(Path(self.tmp.name)/"network.db")
        wire = []
        def handler(request):
            wire.append(str(request.url))
            return httpx.Response(302, headers={"Location": "https://filester.me/f/"+fid(2)})
        try:
            async with GuardedClient(store=store, transport=httpx.MockTransport(handler), max_requests=1) as client:
                with self.assertRaises(RequestBudgetExceeded):
                    await client.get(canonical_folder_url(fid(1)))
                self.assertEqual(client.network_requests, 1)
            self.assertEqual(len(wire), 1)
        finally:
            store.close()

    async def test_collector_alias_deduplication(self):
        called = []
        async def collect(client, limit):
            called.append("wayback")
            return []
        with patch.object(web_sources, "GuardedClient", self.client), patch.dict(web_sources.COLLECTORS, {"wayback": collect}):
            await web_sources.run_collectors(["wayback", "archive", "wayback"])
        self.assertEqual(called, ["wayback"])


    async def test_current_job_preference_excludes_unrelated_backlog_and_keeps_graph(self):
        self.seed(1, score=100)
        self.seed(2, score=1)
        self.pages[fid(1)] = page(1, 4)
        self.pages[fid(2)] = page(2, links=[3])
        self.pages[fid(3)] = page(3, 2)
        preferred = {fid(2)}
        result = await pool.validate_pool(
            self.db, budget=2, preferred_ids=preferred, allow_unpreferred=False,
            recover_local=False,
        )
        self.assertEqual(result["preferred_validated"], 2)
        self.assertEqual(result["backlog_validated"], 0)
        self.assertEqual(result["snowball_candidates"], 1)
        self.assertEqual(self.row(1)["status"], "unvalidated")
        self.assertEqual(self.row(2)["status"], "validated")
        self.assertEqual(self.row(3)["status"], "validated")

    async def test_public_hub_is_bounded_and_deduplicated(self):
        calls = []
        async def get(client, url):
            calls.append(url)
            body = canonical_folder_url(fid(1)) + " " + canonical_folder_url(fid(1)) + " " + canonical_folder_url(fid(2))
            return 200, body
        with patch.object(web_sources, "_get", get), patch.object(
            web_sources, "PUBLIC_HUB_PAGES", ("https://example.test/hub",)
        ):
            hits = await web_sources.collect_public_hubs(self.client(), limit=10)
        self.assertEqual(calls, ["https://example.test/hub"])
        self.assertEqual([hit.folder_id for hit in hits], [fid(1), fid(2)])
        self.assertTrue(all(hit.source_name == "public_hubs" for hit in hits))

    async def test_legacy_ab_errors_remain_retryable(self):
        for n in (1, 2):
            self.seed(n)
            self.pages[fid(n)] = 429
        result = await pool.ab_test_pool(self.db, budget=1)
        self.assertEqual(result["fifo"]["ERROR"]+result["priority"]["ERROR"], 2)
        self.assertEqual(self.db.candidate_stats()["unvalidated"], 2)

    async def test_legacy_web_errors_do_not_enter_index(self):
        from discovery import web_engine
        self.seed(1)
        self.pages[fid(1)] = 503
        engine = web_engine.WebDiscoveryEngine(self.db)
        hit = web_sources.Hit(fid(1), "urlscan", "fixture", "test", "q")
        with patch.object(web_engine, "GuardedClient", self.client):
            result = await engine._validate_batch([fid(1)], {fid(1): [hit]}, time.time(), 1, 0, quiet_scoreboard=True)
        self.assertEqual(result["errors"], 1)
        self.assertNotIn(fid(1), engine.known_ids)
        self.assertEqual(self.db._conn.execute("SELECT COUNT(*) FROM pages").fetchone()[0], 0)
        self.assertEqual(self.row(1)["status"], "unvalidated")

    async def test_urlscan_repeated_cursor_stops_pagination(self):
        urls = []
        async def get(client, url):
            urls.append(url)
            return 200, json.dumps({"results": [{"page": {"url": canonical_folder_url(fid(1))}, "sort": [1, "x"]}]*100})
        async def no_sleep(seconds):
            pass
        with patch.object(web_sources, "_get", get), patch.object(web_sources, "asyncio_sleep", no_sleep):
            hits = await web_sources.collect_urlscan(self.client(), limit=10)
        self.assertEqual(len(hits), 1)
        self.assertEqual(len(urls), 14)  # two pages per distinct query, never 15
        self.assertIn("page.domain%3Afilester.me", urls[0])
        self.assertIn("domain%3Afilester.me", urls[2])


if __name__ == "__main__":
    unittest.main(verbosity=2)
