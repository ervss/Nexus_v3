"""Contract regressions found by the discovery audit. Never use live HTTP."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import httpx

from discovery import extract, pool, web_extract, web_sources
from discovery.rotation import KeywordRotator
from crawler.parser import folder_id_from_url
from index.database import Database
from benchmark_discovery import fid


class IDContractTests(unittest.TestCase):
    def test_all_supported_lengths_reach_both_extractors(self):
        for length in (8, 9, 10, 11, 12, 16, 64):
            folder = "a" * length
            url = f"https://filester.me/f/{folder}"
            with self.subTest(length=length):
                self.assertEqual(web_extract.normalize_folder_id(url), folder)
                self.assertEqual(folder_id_from_url(url), folder)
                self.assertEqual(web_extract.extract_folder_ids(url), [folder])
                self.assertEqual(extract.extract_folder_ids(url), [folder])

    def test_web_extractor_rejects_partial_and_foreign_ids(self):
        for url in (
            "https://filester.me/f/" + "a" * 7,
            "https://filester.me/f/" + "a" * 65,
            "https://filester.me/f/" + "a" * 16 + "g",
            "https://evilfilester.me/f/" + fid(1),
            "https://filester.me.evil.org/f/" + fid(1),
            "https://evil.org/f/" + fid(1),
            "https://evil.org/filester.me/f/" + fid(1),
            "https://filester.me/f/442dd49c4567186e",
        ):
            with self.subTest(url=url):
                self.assertEqual(web_extract.extract_folder_ids(url), [])

    def test_json_escaped_mirrors_deduplicate(self):
        url = f"https://filester.sh/f/{fid(1).upper()}?page=2"
        self.assertEqual(web_extract.extract_folder_ids(url.replace("/", "\\/")), [fid(1)])
        text = json.dumps([url.replace("/", "\\/"), web_extract.canonical_folder_url(fid(1))])
        self.assertEqual(web_extract.extract_folder_ids(text), [fid(1)])

    def test_normalization_requires_folder_path(self):
        self.assertIsNone(web_extract.normalize_folder_id("https://filester.me/" + fid(1)))

    def test_legacy_relative_links_and_foreign_hosts(self):
        self.assertEqual(extract.extract_folder_ids('<a href="/f/ABCDEF12">folder</a>'), ["abcdef12"])
        self.assertEqual(extract.extract_folder_ids("https://evil.org/f/abcdef12"), [])
        self.assertEqual(extract.extract_folder_ids("https://filester.me/f/" + "a" * 65), [])

    def test_cli_short_relative_seed_reaches_canonical_fetch(self):
        from discovery.engine import DiscoveryEngine
        from config import Config
        import asyncio
        with tempfile.TemporaryDirectory() as tmp:
            db = Database(Path(tmp)/"index.db")
            engine = DiscoveryEngine(Config(), db)
            class FakeFetcher:
                async def start(self): pass
                async def close(self): pass
            async def process(url, depth, **kwargs):
                fetched.append(url)
                db.mark_done(url)
            fetched = []
            try:
                with patch.object(engine, "fetcher", FakeFetcher()), patch.object(engine, "_process", process):
                    asyncio.run(engine.run(["/f/ABCDEF12"], max_requests=1))
                self.assertEqual(fetched, ["https://filester.me/f/abcdef12"])
            finally:
                db.close()


class FrontierContractTests(unittest.TestCase):
    def test_known_live_mirror_edge_does_not_seed_or_hide_new_edge(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Database(Path(tmp)/"index.db")
            try:
                parent = web_extract.canonical_folder_url(fid(1))
                db.upsert_page({"url": parent, "folder_id": fid(1), "kind": "folder", "is_collection": True, "http_status": 200})
                db.upsert_page({"url": web_extract.canonical_folder_url(fid(2)), "folder_id": fid(2), "kind": "folder", "file_count": 2, "http_status": 200})
                # Legacy stored edges can retain mirror/case/query variations.
                for n in range(8):
                    db.add_link(parent, f"https://filester.sh/f/{fid(2).upper()}?page={n+1}")
                db.add_link(parent, web_extract.canonical_folder_url(fid(3)))
                self.assertEqual(pool.seed_local_frontier(db, 1, 3), 1)
                self.assertIsNone(db._conn.execute("SELECT 1 FROM candidates WHERE folder_id=?", (fid(2),)).fetchone())
                self.assertIsNotNone(db._conn.execute("SELECT 1 FROM candidates WHERE folder_id=?", (fid(3),)).fetchone())
                self.assertEqual(pool.seed_local_frontier(db, 1, 3), 0)
            finally:
                db.close()


class QueryContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_api_forwards_planned_queries_including_pairs(self):
        with tempfile.TemporaryDirectory() as tmp:
            # API import opens and migrates a DB: explicitly isolate both paths.
            with patch.dict(os.environ, {"FILESTER_DB": str(Path(tmp)/"api.db"), "FILESTER_DATA_DIR": tmp}):
                import filester_api as api
                # Initialize bridge/job tables through the already isolated API connection.
                captured = {}
                plan = [("alpha+beta", "site:filester.me/f alpha beta"), ("alpha", '"filester.me/f/" alpha')]
                async def collect(**kwargs):
                    captured.update(kwargs)
                    return []
                try:
                    with patch.object(api.ROT, "pick_queries", return_value=plan), patch.object(api, "run_collectors", collect):
                        body = api.DiscoverBody(keywords=["alpha"], sources=["bing_html"], max_queries=2, max_validate=0)
                        response = await api.discover(body)
                        await api._tasks[response["job_id"]]
                finally:
                    api.DB.close()
                self.assertEqual(captured.get("queries"), plan)

    async def test_full_queries_reach_html_collectors_and_stay_out_of_archives(self):
        plan = [("alpha+beta", "site:filester.me/f alpha beta"), ("alpha", '"filester.me/f/" alpha')]
        calls = []
        class FakeClient:
            def __init__(self, **kwargs):
                self.network_requests = 0
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def get(self, url, **kwargs):
                self.network_requests += 1
                calls.append(url)
                return httpx.Response(200, text="[]", request=httpx.Request("GET", url))
        with patch.object(web_sources, "GuardedClient", FakeClient), patch.dict(os.environ, {"BRAVE_API_KEY": "", "BRAVE_SEARCH_API_KEY": ""}), patch.object(web_sources, "asyncio_sleep", return_value=None):
            await web_sources.run_collectors(sources=["duckduckgo_html", "bing_html", "brave", "wayback"], keywords=["alpha"], queries=plan)
        for host in ("html.duckduckgo.com", "www.bing.com", "search.brave.com"):
            queries = [parse_qs(urlsplit(url).query)["q"][0] for url in calls if urlsplit(url).hostname == host]
            self.assertEqual(queries[:2], [query for _, query in plan])
            self.assertEqual(len(queries), len(set(queries)))
        archive_urls = [url for url in calls if urlsplit(url).hostname == "web.archive.org"]
        self.assertTrue(archive_urls)
        self.assertTrue(all("alpha" not in url for url in archive_urls))

    async def test_query_forwarding_respects_wire_budget(self):
        from discovery.network import GuardedClient
        plan = [("alpha+beta", "site:filester.me/f alpha beta"), ("alpha", '"filester.me/f/" alpha')]
        calls = []
        def response(request):
            calls.append(str(request.url))
            return httpx.Response(200, text="no folders", headers={"content-type": "text/html"})
        original_client = httpx.AsyncClient
        def client_factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(response)
            return original_client(*args, **kwargs)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"FILESTER_DATA_DIR": tmp}), patch("httpx.AsyncClient", client_factory):
            metrics = {}
            await web_sources.run_collectors(sources=["bing_html"], queries=plan, max_requests=2, metrics=metrics, source_timeout=10)
        self.assertEqual(metrics["network_requests"], 2)
        self.assertEqual([parse_qs(urlsplit(url).query)["q"][0] for url in calls], [query for _, query in plan])

    async def test_rotator_keeps_manual_query_pair_and_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Database(Path(tmp)/"index.db")
            try:
                rot = KeywordRotator(db)
                self.assertEqual(rot.pick_queries(["Alpha Beta"], limit=2), [
                    ("alpha beta", "site:filester.me/f alpha beta"),
                    ("alpha beta", '"filester.me/f/" alpha beta'),
                ])
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
