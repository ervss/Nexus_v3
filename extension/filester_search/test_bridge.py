"""Deterministic integration checks: use an isolated disposable database."""
import asyncio
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

async def check():
    import httpx
    import filester_api as backend
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=backend.app), base_url="http://test") as client:
        assert (await client.get("/bridge")).status_code == 200
        assert (await client.post("/open-slot",json={"url":"file:///test"})).status_code==400
        assert (await client.post("/open-slot",json={"url":"https://example.com/test"})).status_code==200
        assert (await client.get("/network")).status_code==200
        url = "https://example.com/f/test"
        backend.DB.upsert_page({
            "url":url,"kind":"folder","title":"Test folder","file_count":2,
            "file_meta":[{"name":"one.mp4","size":1024},{"name":"two.mp4","size":2048}],
            "thumb_ids":["12345678-1234-1234-1234-123456789012"],
        })
        backend.DB.upsert_candidate("abcd000000000001",["test"],["test"],score=1)
        r = await client.post("/annotations",json={"url":url,"favorite":True,"note":"persistent note","relevance":1})
        assert r.status_code == 200
        await client.post("/opened",json={"urls":[url]})
        snapshot = (await client.get("/bridge")).json()
        assert snapshot["items"][0]["note"] == "persistent note"
        assert snapshot["items"][0]["relevance"] == 1
        assert snapshot["items"][0]["filenames"] == []
        assert snapshot["items"][0]["file_meta"] == [{"name":"one.mp4","size":1024},{"name":"two.mp4","size":2048}]
        assert snapshot["items"][0]["thumb_ids"] == ["12345678-1234-1234-1234-123456789012"]
        file_search = await client.get("/search?q=one")
        assert any(result["url"] == url and "one.mp4" in result["sample_files"] for result in file_search.json()["results"])
        excluded_root = "442dd49c4567186e"
        excluded_child = "abcd000000000099"
        excluded_url = f"https://filester.me/f/{excluded_child}"
        backend.DB._conn.execute(
            "INSERT INTO pages(url,folder_id,kind,title,file_count,last_seen) VALUES (?,?,?,?,?,?)",
            (excluded_url,excluded_child,"folder","CAM hidden fixture",3,__import__("time").time()),
        )
        backend.DB._conn.commit()
        backend.DB.add_link(f"https://filester.me/f/{excluded_root}",excluded_url)
        assert backend.DB.is_folder_excluded(excluded_child)
        assert excluded_url not in [item["url"] for item in (await client.get("/bridge")).json()["items"]]
        assert excluded_url not in [item["url"] for item in (await client.get("/recent")).json()["items"]]
        assert excluded_url not in [item["url"] for item in (await client.get("/search?q=CAM")).json()["results"]]
        assert (await client.post("/folder-metadata",json={"folder_id":excluded_child})).status_code == 404
        backend.DB.upsert_page({"url":url,"kind":"folder","title":"Updated title"})
        preserved = (await client.get("/bridge")).json()["items"][0]
        assert preserved["file_meta"] == snapshot["items"][0]["file_meta"]
        assert preserved["thumb_ids"] == snapshot["items"][0]["thumb_ids"]
        class MockGuardedClient:
            requests = 0
            def __init__(self,**kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self,*args): pass
            async def get(self,url,**kwargs):
                MockGuardedClient.requests += 1
                html = '<meta property="og:description" content="with 2 files"><div class="file-item" data-name="one.mp4" data-size="1024" data-type="video"><a href="/d/AB12CD3">Open</a><img src="/t/12345678-1234-1234-1234-123456789099"></div>'
                return httpx.Response(200,text=html,request=httpx.Request("GET",url))
        with patch.object(backend,"GuardedClient",MockGuardedClient):
            preview = await client.post("/folder-metadata",json={"folder_id":"abcdef1234567890"})
            assert preview.status_code == 200
            assert preview.json()["file_meta"] == [{"name":"one.mp4","size":1024,"type":"video","date":"","slug":"AB12CD3","thumb_id":"12345678-1234-1234-1234-123456789099"}]
            assert preview.json()["thumb_ids"] == ["12345678-1234-1234-1234-123456789099"]
            old_meta = [{"name":"one.mp4","size":1024,"type":"video","date":"","slug":"AB12CD3"}]
            backend.DB._conn.execute("UPDATE pages SET file_meta=? WHERE url=?",(__import__("json").dumps(old_meta),"https://filester.me/f/abcdef1234567890"))
            backend.DB._conn.commit()
            refreshed = await client.post("/folder-metadata",json={"folder_id":"abcdef1234567890"})
        assert preview.status_code == 200
        assert refreshed.status_code == 200
        with patch.object(backend,"GuardedClient",MockGuardedClient):
            videos = await client.post("/folder-videos",json={"folder_id":"abcdef1234567890"})
            forced_videos = await client.post("/folder-videos",json={"folder_id":"abcdef1234567890","refresh":True})
        assert videos.status_code == 200
        assert videos.json()["files"][0]["slug"] == "AB12CD3"
        assert forced_videos.status_code == 200
        assert forced_videos.json()["refreshed"] is True
        assert forced_videos.json()["files"][0]["thumb_id"] == "12345678-1234-1234-1234-123456789099"
        assert (await client.post("/folder-videos",json={"folder_id":excluded_child})).status_code == 404
        stored_page = backend.DB.get_page("https://filester.me/f/abcdef1234567890")
        assert MockGuardedClient.requests >= 2
        assert "thumb_id" in __import__("json").loads(stored_page["file_meta"])[0]
        # Existing index folders can be refreshed independently of discovery.
        with patch.object(backend,"GuardedClient",MockGuardedClient):
            refresh = await client.post("/refresh-folders",json={"folder_ids":["abcdef1234567890"]})
            assert refresh.status_code == 200
            refresh_job_id = refresh.json()["job_id"]
            await asyncio.gather(*list(backend._tasks.values()))
        refreshed_job = (await client.get("/jobs/"+refresh_job_id)).json()
        assert refreshed_job["status"] == "completed"
        assert refreshed_job["refresh_only"] is True
        assert refreshed_job["processed"] == 1
        assert refreshed_job["updated"] == 1
        assert (await client.get("/jobs/"+refresh_job_id+"/results")).json()["items"]
        class MockTokenClient:
            server = "https://fsc1.cdn.cr"
            def __init__(self,**kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self,*args): pass
            async def post(self,url,**kwargs):
                return httpx.Response(200,json={
                    "success":True,"file":"video-key","token":"short-lived-token",
                    "server":self.server,"expires_in":300,
                },request=httpx.Request("POST",url))
        with patch.object(backend.httpx,"AsyncClient",MockTokenClient):
            playback = await client.post("/playback-token",json={"slug":"AB12CD3"})
            invalid_playback = await client.post("/playback-token",json={"slug":"../private"})
            MockTokenClient.server = "http://127.0.0.1"
            rejected_host = await client.post("/playback-token",json={"slug":"AB12CD3"})
        assert playback.status_code == 200
        assert playback.json() == {
            "url":"https://fsc1.cdn.cr/v2/video-key?token=short-lived-token",
            "expires_in":300,
        }
        assert invalid_playback.status_code == 422
        assert rejected_host.status_code == 502
        assert snapshot["items"][0]["favorite"] == 1
        assert snapshot["items"][0]["opened_at"]
        collection = await client.post("/collections",json={"name":"Top picks"})
        assert collection.status_code == 200
        collection_id = collection.json()["id"]
        added = await client.post(f"/collections/{collection_id}/items",json={"urls":[url,url]})
        assert added.status_code == 200
        assert (await client.get("/bridge")).json()["collections"][0]["urls"] == [url]
        assert (await client.delete(f"/collections/{collection_id}/items",params={"url":url})).status_code == 200
        temporary = await client.post("/collections",json={"name":"Temporary"})
        assert (await client.delete(f"/collections/{temporary.json()['id']}")).status_code == 200
        assert (await client.post("/discover",json={"max_queries":0})).status_code == 422
        release = asyncio.Event()
        async def collect(**kwargs):
            await release.wait()
            return []
        async def validate(*args,**kwargs):
            return {"validated":1,"CONTENT":1}
        with patch.object(backend,"run_collectors",collect), patch.object(backend,"validate_pool",validate):
            response = await client.post("/discover",json={"keywords":["test"],"max_queries":1,"max_validate":1})
            job_id = response.json()["job_id"]
            await asyncio.sleep(0)
            assert (await client.get("/jobs/"+job_id)).json()["status"] == "running"
            assert (await client.post("/discover",json={"keywords":["test"]})).status_code == 409
            # The originating HTTP call has returned; the backend task still runs.
            release.set()
            for _ in range(100):
                await asyncio.sleep(.01)
                if backend.JOBS[job_id]["status"] == "completed": break
            assert backend.JOBS[job_id]["status"] == "completed"
            assert backend.JOBS[job_id]["indexed_results"] == 1
            results = (await client.get("/jobs/"+job_id+"/results")).json()["items"]
            # Existing index matches are counted, but do not become this job's results.
            assert results == []
            assert not (await client.get("/jobs/unknown/results")).json()["items"]
            legacy_job = await client.post("/discover",json={"keywords":["test"],"max_queries":1,"max_validate":0})
            legacy_job_id = legacy_job.json()["job_id"]
            for _ in range(100):
                await asyncio.sleep(.01)
                if backend.JOBS[legacy_job_id]["status"] == "completed": break
        backend.DB._conn.execute("DELETE FROM bridge_results WHERE job_id=?",(legacy_job_id,))
        backend.DB._conn.commit()
        fallback = await client.get("/jobs/"+legacy_job_id+"/results")
        assert fallback.json()["indexed_fallback"] is False
        assert fallback.json()["items"] == []
        await asyncio.gather(*backend._tasks.values(),return_exceptions=True)
        # Exercise the production discovery pool through the API while keeping
        # the test offline and deterministic.
        from discovery import pool
        from benchmark_discovery import fid, page
        requests = []
        class GraphClient:
            def __init__(self, **kwargs): self.network_requests = 0
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def get(self, url, **kwargs):
                self.network_requests += 1
                requests.append(url)
                body = page(71, links=[72]) if url.endswith(fid(71)) else page(72, 2)
                return httpx.Response(200, text=body, request=httpx.Request("GET", url))
        backend.DB.upsert_candidate(fid(71), ["urlscan"], ["test"], score=1)
        from discovery.web_sources import Hit
        async def graph_collect(**kwargs):
            hit = Hit(fid(71), "urlscan", "fixture", "kw_graph", "graph")
            await kwargs["on_source"]("urlscan", [hit], {"status":"completed","seconds":0,"hits":1})
            return [hit]
        with patch.object(backend,"run_collectors",graph_collect), patch.object(pool,"GuardedClient",GraphClient):
            response = await client.post("/discover",json={"keywords":["graph"],"max_queries":1,"max_validate":3})
            graph_job_id = response.json()["job_id"]
            await asyncio.gather(*list(backend._tasks.values()))
        graph_job = (await client.get("/jobs/"+graph_job_id)).json()
        assert graph_job["status"] == "completed"
        assert graph_job["content"] == 1
        assert graph_job["collections"] == 1
        assert graph_job["discovery_metrics"]["snowball_candidates"] == 1
        assert graph_job["discovery_metrics"]["preferred_validated"] == 2
        assert graph_job["discovery_metrics"]["backlog_validated"] == 0
        assert graph_job["external_candidates"] == 1
        assert graph_job["external_existing_candidates"] == 1
        assert graph_job["network_requests"] == 2
        assert len(requests) == 2
        graph_results = (await client.get("/jobs/"+graph_job_id+"/results")).json()["items"]
        assert {item["folder_id"] for item in graph_results} == {fid(71), fid(72)}
        saved_graph = backend.DB._conn.execute(
            "SELECT snapshot FROM bridge_jobmeta WHERE job_id=?", (graph_job_id,)
        ).fetchone()[0]
        assert __import__("json").loads(saved_graph)["discovery_metrics"]["snowball_candidates"] == 1

        # A fast source should start validation before slower collectors finish.
        async def incremental_collect(**kwargs):
            await asyncio.sleep(.03)
            await kwargs["on_source"](
                "urlscan", [Hit(fid(73),"urlscan","fixture","test","q")],
                {"status":"completed","hits":1},
            )
            for _ in range(100):
                await asyncio.sleep(.01)
                if any(job.get("content") == 1 and job.get("status") == "running" for job in backend.JOBS.values()):
                    return []
            raise AssertionError("fast source was held behind collector completion")
        with patch.object(backend,"run_collectors",incremental_collect), patch.object(pool,"GuardedClient",GraphClient):
            response = await client.post("/discover",json={"keywords":["incremental"],"max_queries":1,"max_validate":1})
            incremental_id = response.json()["job_id"]
            await asyncio.gather(*list(backend._tasks.values()))
        assert backend.JOBS[incremental_id]["status"] == "completed"
        assert backend.JOBS[incremental_id]["content"] == 1
        from discovery.pool import _feedback_adjusted_candidates
        for source, relevance in (("wayback_cdx",1),("urlscan",-1)):
            for index in range(3):
                feedback_url = f"https://example.com/feedback/{source}/{index}"
                backend.DB._conn.execute(
                    "INSERT INTO pages(url,kind,source) VALUES (?,?,?)",
                    (feedback_url,"folder","web:"+source),
                )
                backend.DB._conn.execute(
                    "INSERT INTO bridge_notes(url,relevance) VALUES (?,?)",
                    (feedback_url,relevance),
                )
        backend.DB._conn.commit()
        ranked = _feedback_adjusted_candidates(backend.DB,[
            {"folder_id":"negative","sources":"[\"urlscan\"]","score":10},
            {"folder_id":"positive","sources":"[\"wayback_cdx\"]","score":10},
        ])
        assert ranked[0]["folder_id"] == "positive"
        backend.DB.close()
        # Fresh process reads the same persisted index and history.
        script = "import filester_api as b; assert b.DB._conn.execute('select note from bridge_notes').fetchone()[0]=='persistent note'; assert b.DB._conn.execute('select relevance from bridge_notes').fetchone()[0]==1; assert b.DB._conn.execute('select name from bridge_collections').fetchone()[0]=='Top picks'; assert b.DB._conn.execute('select status from jobs').fetchone()[0]=='completed'; b.DB.close()"
        subprocess.run([sys.executable,"-c",script],check=True)
        print("PASS: cache snapshot, notes, favorites, opened history, bounds, independent jobs, duplicate-start guard, per-job results and restart persistence")

if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="filester-bridge-test-") as tmp:
        os.environ["FILESTER_DB"] = str(Path(tmp)/"test.db")
        os.environ["FILESTER_DATA_DIR"] = tmp
        asyncio.run(check())
