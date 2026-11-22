"""Deterministic protection regression tests; never access external websites."""
import asyncio
import json
import tempfile
import time
import unittest
from email.utils import formatdate
from pathlib import Path
from unittest.mock import patch
import httpx
from discovery.network import GuardedClient, NetworkStore, CoolingDown, retry_delay, is_challenge
from discovery.validate import validate_folder, classify
from discovery.pool import validate_pool
from index.database import Database

class NetworkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix="filester-net-test-")
        self.store=NetworkStore(Path(self.tmp.name)/"network.db")
    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    async def test_duplicate_and_persistent_cache(self):
        calls=[]
        async def handler(request):
            calls.append(request)
            await asyncio.sleep(.02)
            return httpx.Response(200,text="public content",headers={"content-type":"text/html","set-cookie":"test=isolated; Path=/"})
        async with GuardedClient(store=self.store,transport=httpx.MockTransport(handler)) as client:
            a,b=await asyncio.gather(client.get("https://filester.me/f/a"),client.get("https://filester.me/f/a"))
            self.assertEqual(a.text,b.text)
            self.assertTrue(b.extensions.get("cache_hit"))
        self.assertEqual(len(calls),1)
        row=self.store.conn.execute("SELECT headers FROM cache").fetchone()
        self.assertNotIn("cookie",row["headers"])
        async with GuardedClient(store=self.store,transport=httpx.MockTransport(handler)) as client:
            await client.get("https://filester.me/f/a")
        self.assertEqual(len(calls),1)

    async def test_rate_limit_survives_restart_and_covers_mirrors(self):
        calls=[]
        def handler(request):
            calls.append(request)
            return httpx.Response(429,headers={"Retry-After":"1000"})
        async with GuardedClient(store=self.store,transport=httpx.MockTransport(handler)) as client:
            self.assertEqual((await client.get("https://filester.me/f/a")).status_code,429)
            with self.assertRaises(CoolingDown): await client.get("https://filester.sh/f/b")
        self.store.close()
        self.store=NetworkStore(Path(self.tmp.name)/"network.db")
        row=self.store.conn.execute("SELECT * FROM hosts WHERE host='filester'").fetchone()
        self.assertGreater(row["cooldown"]-time.time(),990)
        async with GuardedClient(store=self.store,transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(CoolingDown): await client.get("https://filester.si/f/c")
        self.assertEqual(len(calls),1)

    async def test_quota_exhaustion_pauses_before_another_request(self):
        async with GuardedClient(store=self.store,transport=httpx.MockTransport(lambda request:httpx.Response(200,json={"results":[]},headers={"x-rate-limit-remaining":"0","x-rate-limit-reset":str(int(time.time()+100))}))) as client:
            await client.get("https://urlscan.io/one")
            with self.assertRaises(CoolingDown):await client.get("https://urlscan.io/two")
        self.assertEqual(self.store.conn.execute("SELECT reason FROM hosts").fetchone()[0],"quota exhausted")

    async def test_revalidation_and_secret_headers(self):
        calls=[]
        def handler(request):
            calls.append(request)
            if request.headers.get("if-none-match"):
                return httpx.Response(304,headers={"cache-control":"max-age=600"})
            return httpx.Response(200,text="cached body",headers={"etag":"v1","content-type":"text/plain"})
        async with GuardedClient(store=self.store,transport=httpx.MockTransport(handler)) as client:
            await client.get("https://filester.me/f/a")
            self.store.conn.execute("UPDATE cache SET expires=0")
            self.store.conn.execute("UPDATE hosts SET next_start=0")
            self.store.conn.commit()
            r=await client.get("https://filester.me/f/a")
            self.assertEqual(r.text,"cached body")
            self.assertEqual(calls[-1].headers["if-none-match"],"v1")
        async with GuardedClient(headers={"Authorization":"test-only"},store=self.store,transport=httpx.MockTransport(handler)) as client:
            self.store.conn.execute("UPDATE hosts SET next_start=0");self.store.conn.commit()
            r=await client.get("https://filester.me/f/a")
            self.assertFalse(r.extensions.get("cache_hit",False))
        self.assertEqual(len(calls),3)

    async def test_timeout_is_not_dead_and_circuit_opens(self):
        calls=[]
        def handler(request):
            calls.append(request)
            raise httpx.ReadTimeout("test timeout")
        async with GuardedClient(store=self.store,transport=httpx.MockTransport(handler)) as client:
            for i in range(3):
                self.store.conn.execute("UPDATE hosts SET next_start=0");self.store.conn.commit()
                result=await validate_folder(client,f"abcd{i:012x}")
                self.assertEqual(result.folder_type,"ERROR")
        self.assertEqual(len(calls),2)
        self.assertEqual(classify(0,0,404),"DEAD")
        self.assertEqual(classify(0,0,429),"ERROR")

    async def test_503_is_deferred_and_opens_persistent_cooldown(self):
        calls=[]
        def handler(request):
            calls.append(request)
            return httpx.Response(503)
        async with GuardedClient(store=self.store,transport=httpx.MockTransport(handler)) as client:
            for i in range(3):
                self.store.conn.execute("UPDATE hosts SET next_start=0")
                self.store.conn.commit()
                result=await validate_folder(client,f"abcd{i:012x}")
                self.assertEqual(result.folder_type,"ERROR")
        self.assertEqual(len(calls),2)
        self.assertGreater(self.store.conn.execute("SELECT cooldown FROM hosts").fetchone()[0],time.time())

    async def test_challenge_json_is_not_a_false_positive(self):
        self.assertFalse(is_challenge(httpx.Response(200,json={"title":"verify you are human"})))
        self.assertTrue(is_challenge(httpx.Response(200,text="<title>Just a moment</title>",headers={"content-type":"text/html"})))
        now=time.time()
        self.assertAlmostEqual(retry_delay(formatdate(now+120,usegmt=True),now),120,delta=1)

    async def test_failed_candidates_stay_pending(self):
        db=Database(Path(self.tmp.name)/"index.db")
        db.upsert_candidate("abcd000000000001",["test"],["test"],score=1)
        original=httpx.AsyncClient
        def factory(*args,**kwargs):
            kwargs["transport"]=httpx.MockTransport(lambda request:httpx.Response(429,headers={"Retry-After":"100"}))
            return original(*args,**kwargs)
        with patch.dict("os.environ",{"FILESTER_DATA_DIR":self.tmp.name}),patch("httpx.AsyncClient",factory):
            result=await validate_pool(db,budget=1)
        self.assertEqual(result["deferred"],1)
        self.assertEqual(result["validated"],0)
        self.assertEqual(db.candidate_stats()["unvalidated"],1)
        db.close()

    async def test_source_deadline_and_parallel_results(self):
        from discovery import web_sources as sources
        async def slow(client,limit):
            sources._record("test_slow","test",200,"",["abcd000000000001"],"https://example.org","test")
            await asyncio.sleep(10)
            return []
        async def fast(client,limit): await asyncio.sleep(.02);return []
        completed=[]
        async def callback(name,part,info): completed.append((name,info["status"]))
        with patch.dict("os.environ",{"FILESTER_DATA_DIR":self.tmp.name}),patch.dict(sources.COLLECTORS,{"test_slow":slow,"test_fast":fast}):
            started=time.perf_counter()
            hits=await sources.run_collectors(["test_slow","test_fast"],source_timeout=.08,on_source=callback)
        # Includes first client/TLS-context construction on Windows.
        self.assertLess(time.perf_counter()-started,1.5)
        self.assertEqual(completed[0],("test_fast","completed"))
        self.assertEqual(completed[1],("test_slow","timeout"))
        self.assertEqual([hit.folder_id for hit in hits],["abcd000000000001"])

if __name__=="__main__": unittest.main(verbosity=2)
