
#!/usr/bin/env python3
"""Filester Discovery API — localhost only. Extension talks here."""
from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
import os
import sqlite3
import httpx
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlencode, urlsplit

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from config import Config
from discovery.pool import ingest_hits_to_db, validate_pool
from discovery.validate import validate_folder
from discovery.rotation import KeywordRotator, normalize_kw
from discovery.web_extract import extract_folder_ids
from discovery.web_sources import run_collectors
from discovery.network import GuardedClient, NetworkStore, CoolingDown, host_key
from crawler.parser import parse_html, folder_page_url, page_num_from_url
from index.database import Database
from index.search import SearchEngine

CFG = Config.from_env()
# Baseline was wayback+urlscan only; expanded defaults diversify candidate IDs.
DEFAULT_DISCOVERY_SOURCES = [
    "public_hubs",
    "wayback",
    "urlscan",
    "commoncrawl",
    "duckduckgo_html",
    "bing_html",
]
DATA_DIR = Path(os.getenv("FILESTER_DATA_DIR", str(Path.home() / "Desktop" / "Filester Search Data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)
if not os.getenv("FILESTER_DB"):
    original = CFG.resolve_db()
    destination = DATA_DIR / "filester_index.db"
    if not destination.exists() and original.exists():
        with sqlite3.connect(original) as source, sqlite3.connect(destination) as target:
            source.backup(target)
    CFG.db_path = str(destination)
DB = Database(CFG.resolve_db())
ROT = KeywordRotator(DB)


def attribute_hits_to_keywords(hits, keywords: list[str]) -> dict[str, set[str]]:
    """Map each keyword to folder IDs it should learn from.

    Only keyword-specific collector queries are attributed. Generic archive
    and hub hits carry no evidence about a keyword and must not inflate it.
    """
    kws = [normalize_kw(k) for k in keywords if normalize_kw(k)]
    by_kw: dict[str, set[str]] = {k: set() for k in kws}
    for hit in hits:
        blob = f"{getattr(hit, 'query', '') or ''} {getattr(hit, 'query_class', '') or ''}".lower()
        matched = False
        for kw in kws:
            if kw and kw in blob:
                by_kw[kw].add(hit.folder_id)
                matched = True
    return by_kw


def record_keyword_feedback(hits, keywords: list[str], *, before: set[str], content_ids: set[str]) -> None:
    """Persist discovery + validated-content signal into the keyword rotator."""
    attributed = attribute_hits_to_keywords(hits, keywords)
    for kw, ids in attributed.items():
        unseen = sum(1 for folder_id in ids if folder_id not in before)
        content = sum(1 for folder_id in ids if folder_id in content_ids)
        ROT.record_query_result(
            kw,
            unique_cands=len(ids),
            unseen=unseen,
            content=content,
            duplicates=sum(1 for folder_id in ids if folder_id in before),
        )
DB._conn.executescript("""
CREATE TABLE IF NOT EXISTS bridge_results (job_id TEXT, url TEXT, PRIMARY KEY(job_id,url));
CREATE TABLE IF NOT EXISTS bridge_notes (url TEXT PRIMARY KEY, favorite INTEGER DEFAULT 0, note TEXT DEFAULT '', opened_at REAL, relevance INTEGER);
CREATE TABLE IF NOT EXISTS bridge_history (id INTEGER PRIMARY KEY, query TEXT, ts REAL, result_count INTEGER);
CREATE TABLE IF NOT EXISTS bridge_jobmeta (job_id TEXT PRIMARY KEY, snapshot TEXT);
CREATE TABLE IF NOT EXISTS bridge_collections (collection_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS bridge_collection_items (collection_id TEXT NOT NULL, url TEXT NOT NULL, added_at REAL NOT NULL, PRIMARY KEY(collection_id,url));
""")
try:
    DB._conn.execute("ALTER TABLE bridge_notes ADD COLUMN relevance INTEGER")
except sqlite3.OperationalError:
    pass
DB._conn.execute("UPDATE jobs SET status='interrupted', message='Server restarted; run again from history' WHERE status IN ('queued','running')")
DB._conn.commit()
JOBS: dict[str, dict[str, Any]] = {}
_tasks: dict[str, asyncio.Task] = {}
@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    for t in list(_tasks.values()):
        t.cancel()
    await asyncio.gather(*list(_tasks.values()), return_exceptions=True)
    DB.close()


app = FastAPI(title="Filester Discovery Bridge", version="13.1", lifespan=lifespan)
app.mount("/ui", StaticFiles(directory=Path(__file__).parent / "extension"), name="ui")


@app.get("/")
def dashboard_redirect():
    return RedirectResponse("/ui/dashboard.html")


def bridge_item(row):
    item = dict(row)
    for field in ("file_meta", "thumb_ids", "filenames"):
        try:
            item[field] = json.loads(item[field] or "[]")
        except (TypeError, json.JSONDecodeError):
            item[field] = []
    return item


@app.get("/bridge")
async def bridge():
    rows = DB._conn.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200").fetchall()
    jobs = [saved_job(r) for r in rows]
    items = DB._conn.execute("""SELECT p.title,p.folder_id,p.file_count,p.filenames,p.file_meta,p.thumb_ids,p.out_degree,p.url,p.source,p.last_seen,
        COALESCE(n.favorite,0) AS favorite, COALESCE(n.note,'') AS note,n.opened_at,n.relevance
        FROM pages p LEFT JOIN bridge_notes n ON p.url=n.url
        WHERE p.kind='folder' AND NOT EXISTS (
            SELECT 1 FROM excluded_folders e WHERE e.folder_id=p.folder_id
        ) ORDER BY p.last_seen DESC""").fetchall()
    collections = [dict(row) for row in DB._conn.execute(
        "SELECT collection_id AS id,name,created_at FROM bridge_collections ORDER BY name COLLATE NOCASE"
    ).fetchall()]
    for collection in collections:
        collection["urls"] = [row[0] for row in DB._conn.execute(
            """SELECT i.url FROM bridge_collection_items i JOIN pages p ON p.url=i.url
               WHERE i.collection_id=? AND NOT EXISTS (
                   SELECT 1 FROM excluded_folders e WHERE e.folder_id=p.folder_id
               ) ORDER BY i.added_at DESC""",
            (collection["id"],),
        ).fetchall()]
    return {"jobs": jobs, "items": [bridge_item(r) for r in items], "collections": collections, "data_dir": str(DATA_DIR),
        "history": [dict(r) for r in DB._conn.execute("SELECT * FROM bridge_history ORDER BY ts DESC LIMIT 200")],
        "pool": DB.candidate_stats(), "network": network_snapshot(), "updated_at": time.time(), "version": "14.1"}


def saved_job(row):
    if row["job_id"] in JOBS: return JOBS[row["job_id"]]
    meta=DB._conn.execute("SELECT snapshot FROM bridge_jobmeta WHERE job_id=?", (row["job_id"],)).fetchone()
    job=json.loads(meta["snapshot"]) if meta else dict(row)
    job["status"]=row["status"]
    if row["status"]=="interrupted": job["message"]=row["message"]
    return job


def persist_job(job):
    DB._conn.execute("INSERT OR REPLACE INTO bridge_jobmeta VALUES (?,?)", (job["job_id"],json.dumps(job)))
    DB._conn.execute("UPDATE jobs SET status=? WHERE job_id=?", (job["status"],job["job_id"]))
    DB._conn.commit()


def network_snapshot():
    store=NetworkStore()
    try: return store.snapshot()
    finally: store.close()


@app.get("/network")
async def network_health():
    return network_snapshot()


class NoteBody(BaseModel):
    url: str
    favorite: bool = False
    note: str = Field(default="", max_length=4000)
    opened: bool = False
    relevance: Optional[int] = Field(default=None, ge=-1, le=1)


class CollectionBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class CollectionItemsBody(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=1000)


class OpenedBody(BaseModel):
    urls: list[str] = Field(max_length=100000)


class OpenSlotBody(BaseModel):
    url: str = Field(max_length=4096)


class FolderMetadataBody(BaseModel):
    folder_id: str = Field(min_length=8, max_length=64, pattern=r"^[a-fA-F0-9]+$")


class FolderVideosBody(FolderMetadataBody):
    refresh: bool = False


class PlaybackTokenBody(BaseModel):
    slug: str = Field(min_length=4, max_length=16, pattern=r"^[A-Za-z0-9]+$")


@app.post("/playback-token")
async def playback_token(body: PlaybackTokenBody):
    token_endpoint = "https://filester.me/v2/api/public/view"
    host = host_key(token_endpoint)
    store = NetworkStore()
    try:
        wait = store.reserve(host, 1.5)
        if wait > 15:
            raise HTTPException(429, "Zdroj má aktívnu prestávku. Skús to o chvíľu.")
        if wait:
            await asyncio.sleep(wait)
        store.check_cooldown(host)
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(12, connect=5),
                follow_redirects=False,
                headers={"User-Agent": "Mozilla/5.0 Filester Discovery/1.0"},
            ) as client:
                response = await client.post(token_endpoint, json={"file_slug": body.slug})
        except (httpx.HTTPError, TimeoutError) as error:
            elapsed = (time.perf_counter() - started) * 1000
            store.report(host, 0, elapsed, 1.5)
            store.event(host, 0, elapsed, "network")
            raise HTTPException(502, "Nepodarilo sa pripraviť video stream.") from error

        elapsed = (time.perf_counter() - started) * 1000
        store.report(host, response.status_code, elapsed, 1.5, response.headers)
        store.event(host, response.status_code, elapsed, "network")
        if response.status_code in (401, 403, 429):
            raise HTTPException(429, "Filester dočasne obmedzil prehrávanie.")
        if response.status_code != 200:
            raise HTTPException(502, "Filester nevedel pripraviť video stream.")

        try:
            data = response.json()
            media_file = str(data.get("file") or "")
            access_token = str(data.get("token") or "")
            server = str(data.get("server") or "https://cn1.filester.me").rstrip("/")
            server_url = urlsplit(server)
        except (ValueError, TypeError, AttributeError) as error:
            raise HTTPException(502, "Filester vrátil neplatné údaje prehrávania.") from error

        allowed_hosts = {"cn1.filester.me", "p1.filester.me", "rs2.filester.me"}
        allowed_host = bool(server_url.hostname) and (
            server_url.hostname in allowed_hosts
            or bool(re.fullmatch(r"fsc\d+\.cdn\.cr", server_url.hostname))
        )
        if (
            server_url.scheme != "https"
            or not allowed_host
            or server_url.username
            or server_url.password
            or not re.fullmatch(r"[A-Za-z0-9._-]{1,256}", media_file)
            or media_file in (".", "..")
            or not access_token
            or len(access_token) > 4096
        ):
            raise HTTPException(502, "Filester vrátil neplatnú adresu prehrávania.")

        stream_url = f"{server}/v2/{media_file}?{urlencode({'token': access_token})}"
        return {"url": stream_url, "expires_in": max(1, int(data.get("expires_in") or 300))}
    except CoolingDown as error:
        raise HTTPException(429, str(error)) from error
    finally:
        store.close()


@app.post("/folder-metadata")
async def folder_metadata(body: FolderMetadataBody):
    fid = body.folder_id.lower()
    if DB.is_folder_excluded(fid):
        raise HTTPException(404, "Tento priečinok patrí do vylúčenej vetvy.")
    url = f"https://filester.me/f/{fid}"
    existing = DB.get_page(url)
    if existing:
        cached = bridge_item(existing)
        file_meta_current = bool(cached["file_meta"]) and all(
            isinstance(file, dict) and "thumb_id" in file for file in cached["file_meta"]
        )
        navigation_only = not existing["file_count"] and int(existing["out_degree"] or 0) > 0
        if file_meta_current or (navigation_only and cached["thumb_ids"]):
            return {"file_count": existing["file_count"] or 0, **cached}

    async with GuardedClient(headers={"User-Agent": "FilesterPublicIndexer/8.0 (+preview)"}) as client:
        result = await validate_folder(client, fid)
    if result.folder_type == "ERROR":
        raise HTTPException(503, "Zdroj je dočasne nedostupný alebo obmedzil požiadavky.")

    page = dict(existing) if existing else {
        "url": url, "folder_id": fid, "kind": "folder", "source": "web:preview", "depth": 0,
    }
    page.update({
        "title": result.title or page.get("title"),
        "file_count": max(int(page.get("file_count") or 0), result.file_count),
        "filenames": result.filenames,
        "file_meta": result.file_meta,
        "thumb_ids": result.thumb_ids,
        "out_degree": max(int(page.get("out_degree") or 0), result.subfolder_count),
        "http_status": result.http_status,
    })
    DB.upsert_page(page)
    return {
        "file_count": page["file_count"],
        "file_meta": result.file_meta,
        "thumb_ids": result.thumb_ids,
    }


@app.post("/folder-videos")
async def folder_videos(body: FolderVideosBody):
    fid = body.folder_id.lower()
    if DB.is_folder_excluded(fid):
        raise HTTPException(404, "Vylúčený priečinok.")
    url = folder_page_url(fid)
    existing = DB.get_page(url)
    if not existing or existing["kind"] != "folder":
        raise HTTPException(404, "Priečinok nie je v indexe.")
    expected = int(existing["file_count"] or 0)
    cached = bridge_item(existing)["file_meta"]
    if not body.refresh and expected and len(cached) >= expected:
        return {"files": cached, "expected": expected, "complete": True, "pages": 0, "refreshed": False}
    # A forced refresh starts with cached metadata so a temporarily incomplete
    # remote response can fill missing thumbnails without discarding old files.
    files = {
        file.get("slug") or file.get("name"): file
        for file in cached if isinstance(file, dict) and (file.get("slug") or file.get("name"))
    }
    pending = [1]
    seen = set()
    try:
        async with GuardedClient(headers={"User-Agent": "FilesterPublicIndexer/8.0 (+review)"}) as client:
            while pending and len(seen) < 40:
                number = pending.pop(0)
                if number in seen or number > 40:
                    continue
                seen.add(number)
                response = await client.get(folder_page_url(fid, number))
                if response.status_code != 200:
                    raise HTTPException(503, "Stránka priečinka je nedostupná.")
                parsed = parse_html(folder_page_url(fid, number), response.text, status=200)
                expected = max(expected, parsed.file_count)
                for file in parsed.file_meta:
                    key = file.get("slug") or file.get("name")
                    if key:
                        merged = dict(files.get(key, {}))
                        # A page occasionally omits a thumbnail on a later
                        # fetch. Keep an already known value in that case.
                        for field, value in file.items():
                            if value not in ("", None, 0) or field in ("name", "type"):
                                merged[field] = value
                        files[key] = merged
                for link in parsed.pagination_urls:
                    page = page_num_from_url(link)
                    if page not in seen and page not in pending and page <= 40: pending.append(page)
                if not body.refresh and expected and len(files) >= expected: break
    except CoolingDown as error:
        raise HTTPException(429, str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(503, "Zdroj je nedostupný.") from error
    complete = (not expected or len(files) >= expected) and (not pending or len(files) >= expected)
    result = list(files.values())
    if complete or body.refresh:
        DB.upsert_page({"url": url, "kind": "folder", "folder_id": fid,
                        "file_meta": result, "filenames": [f["name"] for f in result],
                        "file_count": max(expected, len(result))})
    return {"files": result, "expected": expected, "complete": complete, "pages": len(seen), "refreshed": body.refresh}


@app.post("/open-slot")
async def open_slot(body: OpenSlotBody):
    from urllib.parse import urlsplit
    if urlsplit(body.url).scheme not in ("http","https") or not urlsplit(body.url).hostname:
        raise HTTPException(400,"Only HTTP(S) result links can be opened")
    store=NetworkStore()
    try:
        host=host_key(body.url)
        wait=store.reserve(host,1.5 if host=="filester" else .5)
        if wait>10: raise HTTPException(429,"Opening queue is busy; try the next batch")
        if wait: await asyncio.sleep(wait)
        store.check_cooldown(host)
        store.event(host,202,0,"browser_slot")
        return {"ok":True}
    except CoolingDown as error:
        raise HTTPException(429,str(error)) from error
    finally:
        store.close()


@app.post("/opened")
async def mark_opened(body: OpenedBody):
    DB._conn.executemany("""INSERT INTO bridge_notes(url,opened_at) VALUES (?,?)
        ON CONFLICT(url) DO UPDATE SET opened_at=excluded.opened_at""",
        [(url,time.time()) for url in set(body.urls)])
    DB._conn.commit()
    return {"ok": True}


@app.post("/annotations")
async def annotate(body: NoteBody):
    DB._conn.execute("""INSERT INTO bridge_notes(url,favorite,note,opened_at,relevance) VALUES (?,?,?,?,?)
        ON CONFLICT(url) DO UPDATE SET favorite=excluded.favorite,note=excluded.note,
        opened_at=COALESCE(excluded.opened_at,bridge_notes.opened_at),
        relevance=COALESCE(excluded.relevance,bridge_notes.relevance)""",
        (body.url, int(body.favorite), body.note, time.time() if body.opened else None, body.relevance))
    DB._conn.commit()
    return {"ok": True}


@app.post("/collections")
async def create_collection(body: CollectionBody):
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "Zadaj názov kolekcie.")
    collection_id = uuid.uuid4().hex[:12]
    created_at = time.time()
    DB._conn.execute(
        "INSERT INTO bridge_collections(collection_id,name,created_at) VALUES (?,?,?)",
        (collection_id, name, created_at),
    )
    DB._conn.commit()
    return {"id": collection_id, "name": name, "created_at": created_at, "urls": []}


@app.post("/collections/{collection_id}/items")
async def add_collection_items(collection_id: str, body: CollectionItemsBody):
    collection = DB._conn.execute(
        "SELECT collection_id FROM bridge_collections WHERE collection_id=?", (collection_id,)
    ).fetchone()
    if not collection:
        raise HTTPException(404, "Kolekcia neexistuje.")
    urls = list(dict.fromkeys(body.urls))
    DB._conn.executemany(
        "INSERT OR IGNORE INTO bridge_collection_items(collection_id,url,added_at) "
        "SELECT ?,url,? FROM pages WHERE url=? AND kind='folder'",
        [(collection_id, time.time(), url) for url in urls],
    )
    DB._conn.commit()
    return {"ok": True, "count": len(urls)}


@app.delete("/collections/{collection_id}/items")
async def remove_collection_item(collection_id: str, url: str = Query(..., max_length=4096)):
    DB._conn.execute(
        "DELETE FROM bridge_collection_items WHERE collection_id=? AND url=?", (collection_id, url)
    )
    DB._conn.commit()
    return {"ok": True}


@app.delete("/collections/{collection_id}")
async def delete_collection(collection_id: str):
    exists = DB._conn.execute(
        "SELECT 1 FROM bridge_collections WHERE collection_id=?", (collection_id,)
    ).fetchone()
    if not exists:
        raise HTTPException(404, "Kolekcia neexistuje.")
    DB._conn.execute("DELETE FROM bridge_collection_items WHERE collection_id=?", (collection_id,))
    DB._conn.execute("DELETE FROM bridge_collections WHERE collection_id=?", (collection_id,))
    DB._conn.commit()
    return {"ok": True}
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "chrome-extension://*",
        "http://127.0.0.1:8765",
        "http://localhost:8765",
    ],
    allow_origin_regex=r"chrome-extension://.*",
    allow_methods=["*"],
    allow_headers=["*"],
)


class DiscoverBody(BaseModel):
    keywords: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=lambda: list(DEFAULT_DISCOVERY_SOURCES))
    max_queries: int = Field(default=30, ge=1, le=200)
    max_validate: int = Field(default=50, ge=0, le=500)
    target_new: int = Field(default=50, ge=1, le=500)
    backlog_only: bool = False


class RefreshFoldersBody(BaseModel):
    """A bounded refresh of folders that are already present in the local index."""
    folder_ids: list[str] = Field(min_length=1, max_length=500)


class KeywordBody(BaseModel):
    keyword: str
    category: str = "manual"


@app.get("/health")
def health():
    st = DB.candidate_stats() if hasattr(DB, "candidate_stats") else {}
    pages = DB._conn.execute("""SELECT COUNT(*) FROM pages p WHERE kind='folder' AND NOT EXISTS (
        SELECT 1 FROM excluded_folders e WHERE e.folder_id=p.folder_id
    )""").fetchone()[0]
    return {
        "ok": True,
        "backend": "filester_api",
        "folders": pages,
        "candidates": st,
        "ts": time.time(),
    }


@app.get("/stats")
def stats():
    return {
        "db": DB.stats(),
        "pool": DB.candidate_stats(),
        "keywords": ROT.stats()[:30],
    }


@app.get("/search")
async def search(q: str = Query(..., min_length=1, max_length=500), limit: int = Query(default=30, ge=1, le=1000)):
    eng = SearchEngine(DB)
    results = eng.search(q, limit=limit)
    DB._conn.execute("INSERT INTO bridge_history(query,ts,result_count) VALUES (?,?,?)", (q,time.time(),len(results)))
    DB._conn.commit()
    return {"query": q, "results": results}


@app.get("/recent")
def recent(limit: int = 30):
    rows = DB._conn.execute(
        """
        SELECT title, folder_id, file_count, out_degree, url, source, last_seen
        FROM pages p WHERE kind='folder' AND COALESCE(is_collection,0)=0
          AND NOT EXISTS (SELECT 1 FROM excluded_folders e WHERE e.folder_id=p.folder_id)
        ORDER BY last_seen DESC LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return {"items": [dict(r) for r in rows]}


@app.get("/keywords")
def keywords():
    return {"keywords": ROT.stats()}


@app.post("/keywords")
def add_keyword(body: KeywordBody):
    k = ROT.add_keyword(body.keyword, body.category, "manual")
    return {"ok": True, "keyword": k}


@app.post("/keywords/{keyword}/pause")
def pause_keyword(keyword: str):
    ROT.pause(keyword)
    return {"ok": True}


@app.post("/keywords/{keyword}/resume")
def resume_keyword(keyword: str):
    ROT.resume(keyword)
    return {"ok": True}


@app.get("/keyword-stats")
def keyword_stats():
    return {"keywords": ROT.stats()}


@app.get("/source-stats")
def source_stats():
    # lightweight: counts from pages.source
    rows = DB._conn.execute(
        """
        SELECT COALESCE(source,'unknown') AS source, COUNT(*) AS n
        FROM pages p WHERE kind='folder'
          AND NOT EXISTS (SELECT 1 FROM excluded_folders e WHERE e.folder_id=p.folder_id)
        GROUP BY source ORDER BY n DESC
        """
    ).fetchall()
    return {"sources": [dict(r) for r in rows]}


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        # try sqlite
        row = DB._conn.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(404, "job not found")
        return saved_job(row)
    return job


@app.get("/jobs/{job_id}/results")
def job_results(job_id: str, limit: int = 50):
    rows = DB._conn.execute(
        """
        SELECT title, folder_id, file_count, out_degree, url, source, last_seen
        FROM pages p WHERE url IN (SELECT url FROM bridge_results WHERE job_id=?)
          AND NOT EXISTS (SELECT 1 FROM excluded_folders e WHERE e.folder_id=p.folder_id)
        ORDER BY last_seen DESC LIMIT ?
        """,
        (job_id, limit),
    ).fetchall()
    return {"job_id": job_id, "items": [dict(r) for r in rows], "indexed_fallback": False}



@app.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = JOBS.get(job_id)
    if job:
        job["status"] = "cancelled"
    t = _tasks.get(job_id)
    if t:
        t.cancel()
    DB._conn.execute("UPDATE jobs SET status='cancelled' WHERE job_id=?", (job_id,))
    DB._conn.commit()
    return {"ok": True}


@app.post("/refresh-folders")
async def refresh_folders(body: RefreshFoldersBody):
    """Refresh existing folder records without rediscovering any external links."""
    if any(j["status"] in ("queued", "running") for j in JOBS.values()):
        raise HTTPException(409, "A discovery or refresh job is already running")
    requested = list(dict.fromkeys(folder_id.lower() for folder_id in body.folder_ids))
    indexed = {row["folder_id"] for row in DB._conn.execute(
        "SELECT DISTINCT folder_id FROM pages WHERE kind='folder' AND folder_id IS NOT NULL"
    )}
    folder_ids = [folder_id for folder_id in requested if folder_id in indexed and not DB.is_folder_excluded(folder_id)]
    if not folder_ids:
        raise HTTPException(404, "Žiadny z vybraných priečinkov už nie je v indexe.")
    job_id, now = uuid.uuid4().hex[:12], time.time()
    job = {
        "job_id": job_id, "created_at": now, "status": "queued", "keywords": [],
        "sources": ["index_refresh"], "max_queries": 0, "max_validate": len(folder_ids),
        "target_new": 0, "backlog_only": False, "refresh_only": True,
        "requested": len(folder_ids), "processed": 0, "validated": 0, "content": 0,
        "collections": 0, "dead": 0, "errors": 0, "updated": 0,
        "current_keyword": "", "current_source": "index_refresh", "message": "",
    }
    JOBS[job_id] = job
    DB._conn.execute(
        """INSERT INTO jobs(job_id, created_at, status, keywords, sources, max_queries, max_validate, target_new)
           VALUES (?,?,?,?,?,?,?,?)""",
        (job_id, now, "queued", "[]", json.dumps(["index_refresh"]), 0, len(folder_ids), 0),
    )
    DB._conn.commit()
    _tasks[job_id] = asyncio.create_task(_run_refresh_job(job_id, folder_ids))
    return {"job_id": job_id, "status": "queued", "requested": len(folder_ids)}


async def _run_refresh_job(job_id: str, folder_ids: list[str]):
    """Update existing records from public folder pages, preserving them on errors."""
    job = JOBS[job_id]
    job.update(status="running", started_at=time.time(), stage="refreshing indexed folders", timings={})
    persist_job(job)
    counts = {"CONTENT_FOLDER": 0, "COLLECTION": 0, "MIXED": 0, "DEAD": 0, "ERROR": 0, "UNKNOWN": 0}
    try:
        async with GuardedClient(headers={"User-Agent": "FilesterPublicIndexer/8.0 (+index refresh)"}, max_requests=len(folder_ids)) as client:
            for folder_id in folder_ids:
                if job["status"] == "cancelled": break
                result = await validate_folder(client, folder_id)
                job["processed"] += 1
                counts[result.folder_type] = counts.get(result.folder_type, 0) + 1
                if result.folder_type == "ERROR":
                    job["errors"] += 1
                else:
                    job["validated"] += 1
                    if result.folder_type == "CONTENT_FOLDER": job["content"] += 1
                    elif result.folder_type == "COLLECTION": job["collections"] += 1
                    elif result.folder_type == "DEAD": job["dead"] += 1
                    DB.mark_candidate(folder_id, "validated", result.folder_type, result.title, result.file_count, result.subfolder_count)
                    if result.folder_type != "DEAD":
                        existing = DB.get_page(result.url)
                        if existing:
                            DB.upsert_page({
                                "url": result.url, "folder_id": folder_id, "kind": "folder",
                                "title": result.title or existing["title"], "file_count": result.file_count,
                                "filenames": result.filenames, "file_meta": result.file_meta,
                                "thumb_ids": result.thumb_ids, "out_degree": result.subfolder_count,
                                "is_collection": result.folder_type == "COLLECTION", "http_status": result.http_status,
                                "source": "refresh:index",
                            })
                            DB._conn.execute("INSERT OR IGNORE INTO bridge_results(job_id,url) VALUES (?,?)", (job_id, result.url))
                            job["updated"] += 1
                job["message"] = f"Obnovené {job['processed']}/{job['requested']} · aktualizované {job['updated']} · chyby {job['errors']}"
                persist_job(job)
                await asyncio.sleep(0.25)
        if job["status"] != "cancelled":
            job["status"] = "completed"
            job["message"] = f"Obnovenie hotové: {job['updated']} aktualizovaných, {job['dead']} nedostupných, {job['errors']} dočasných chýb"
    except asyncio.CancelledError:
        job["status"], job["message"] = "cancelled", "Obnovovanie zrušené. Už aktualizované priečinky ostali uložené."
    except Exception as exc:
        job["status"], job["message"] = "failed", str(exc)[:300]
        logger_exc(exc)
    finally:
        job["finished_at"] = time.time()
        job["stage"] = job["status"]
        job["timings"]["total_seconds"] = round(job["finished_at"] - job["started_at"], 3)
        job["refresh_counts"] = counts
        persist_job(job)
        DB._conn.execute(
            """UPDATE jobs SET status=?, validated=?, content=?, collections=?, dead=?, errors=?, current_source=?, message=? WHERE job_id=?""",
            (job["status"], job["validated"], job["content"], job["collections"], job["dead"], job["errors"], "index_refresh", job["message"], job_id),
        )
        DB._conn.commit()
        _tasks.pop(job_id, None)


@app.post("/discover")
async def discover(body: DiscoverBody):
    if any(j["status"] in ("queued", "running") for j in JOBS.values()):
        raise HTTPException(409, "A discovery job is already running")
    job_id = uuid.uuid4().hex[:12]
    now = time.time()
    job = {
        "job_id": job_id,
        "created_at": now,
        "status": "queued",
        "keywords": body.keywords,
        "sources": body.sources,
        "max_queries": body.max_queries,
        "max_validate": body.max_validate,
        "target_new": body.target_new,
        "backlog_only": body.backlog_only,
        "discovery_requests": 0,
        "candidates": 0,
        "new_candidates": 0,
        "external_candidates": 0,
        "external_new_candidates": 0,
        "external_existing_candidates": 0,
        "validated": 0,
        "content": 0,
        "collections": 0,
        "dead": 0,
        "errors": 0,
        "current_keyword": "",
        "current_source": "",
        "message": "",
    }
    JOBS[job_id] = job
    DB._conn.execute(
        """
        INSERT INTO jobs(job_id, created_at, status, keywords, sources, max_queries, max_validate, target_new)
        VALUES (?,?,?,?,?,?,?,?)
        """,
        (
            job_id, now, "queued",
            json.dumps(body.keywords), json.dumps(body.sources),
            body.max_queries, body.max_validate, body.target_new,
        ),
    )
    DB._conn.commit()
    _tasks[job_id] = asyncio.create_task(_run_job(job_id, body))
    return {"job_id": job_id, "status": "queued"}


async def _run_job(job_id: str, body: DiscoverBody):
    job = JOBS[job_id]
    job["status"] = "running"
    backlog_only = bool(body.backlog_only or body.sources == ["local_frontier"])
    before_pages = {r["url"]: r["last_seen"] for r in DB._conn.execute("SELECT url,last_seen FROM pages")}
    before = {r["folder_id"] for r in DB._conn.execute(
        "SELECT folder_id FROM candidates UNION SELECT folder_id FROM pages WHERE folder_id IS NOT NULL"
    )}
    validation_task = None
    validation_seen: set[str] = set()
    preferred_ids: set[str] = set()
    job_hits: dict[tuple[str, str], Any] = {}
    validation_metrics = {key: 0 for key in (
        "network_requests", "snowball_candidates", "local_candidates",
        "snowball_CONTENT", "duplicates_suppressed", "preferred_validated",
        "backlog_validated", "processed", "validated", "CONTENT", "MIXED",
        "COLLECTION", "DEAD", "ERROR", "UNKNOWN", "deferred",
    )}
    validation_metrics["max_discovery_depth"] = 0
    discovery_metrics = {}
    job.update(
        stage="validating backlog" if backlog_only else "collecting",
        processed=0, source_progress={}, timings={}, started_at=time.time(),
        backlog_only=backlog_only,
    )
    persist_job(job)
    indexed_urls = set()
    engine = SearchEngine(DB)
    if not backlog_only:
        for keyword in body.keywords:
            indexed_urls.update(result["url"] for result in engine.search(keyword, limit=1000))
    job["indexed_results"] = len(indexed_urls)
    job["candidates"] = len(indexed_urls)
    try:
        queries = [] if backlog_only else ROT.pick_queries(body.keywords, limit=body.max_queries)
        kws = [] if backlog_only else list(dict.fromkeys(
            [normalize_kw(keyword) for keyword in body.keywords] +
            [q[0].replace("+", " ") for q in queries]
        ))
        job["current_keyword"] = "" if backlog_only else ",".join(kws[:5])
        job["current_source"] = "local_frontier" if backlog_only else ",".join(body.sources)

        def progress(update):
            job.update(
                validated=update["validated"], content=update["content"],
                errors=update["errors"], processed=update["processed"],
            )
            label = "zásobníka" if backlog_only else "kandidátov úlohy"
            job["message"] = f"Overené {update['processed']}/{body.max_validate} z {label}; výsledky sa ukladajú priebežne"
            if update["content"] and "first_content_seconds" not in job["timings"]:
                job["timings"]["first_content_seconds"] = round(time.time() - job["started_at"], 3)
            persist_job(job)

        async def validation(budget):
            started = time.perf_counter()
            base = {key: validation_metrics.get(key, 0) for key in ("processed", "validated", "CONTENT", "ERROR")}

            def report(update):
                progress({
                    "processed": base["processed"] + update.get("processed", 0),
                    "validated": base["validated"] + update.get("validated", 0),
                    "content": base["CONTENT"] + update.get("content", 0),
                    "errors": base["ERROR"] + update.get("errors", 0),
                })

            result = await validate_pool(
                DB, budget=budget, order="priority", arm_label="",
                on_progress=report, seen=validation_seen,
                request_budget=max(0, body.max_validate - validation_metrics["network_requests"]),
                max_new_candidates=max(
                    0, 1000 - validation_metrics["snowball_candidates"] - validation_metrics["local_candidates"],
                ),
                recover_local=backlog_only,
                preferred_ids=None if backlog_only else preferred_ids,
                allow_unpreferred=backlog_only,
            )
            for key in validation_metrics:
                if key == "max_discovery_depth":
                    validation_metrics[key] = max(validation_metrics[key], result.get(key, 0))
                else:
                    validation_metrics[key] += result.get(key, 0)
            job["timings"]["validation_seconds"] = round(
                job["timings"].get("validation_seconds", 0) + time.perf_counter() - started, 3
            )
            return result

        def launch_validation():
            nonlocal validation_task
            if validation_task is not None and validation_task.done():
                if validation_task.cancelled() or validation_task.exception() is not None:
                    return
                validation_task = None
            if validation_task is None and body.max_validate > validation_metrics["processed"]:
                if backlog_only or preferred_ids:
                    job["stage"] = "validating backlog" if backlog_only else "collecting + validating"
                    validation_task = asyncio.create_task(
                        validation(body.max_validate - validation_metrics["processed"])
                    )

        async def source_finished(name, part, info):
            ids = {h.folder_id for h in part if getattr(h, "folder_id", None)}
            for hit in part:
                job_hits[(hit.folder_id, hit.source_name)] = hit
            info = dict(info)
            info.update(
                unique=len(ids),
                new=len(ids - before),
                existing_overlap=len(ids & before),
            )
            job["source_progress"][name] = info
            preferred_ids.update(ids)
            await ingest_hits_to_db(DB, part)
            job["external_candidates"] = len(preferred_ids)
            job["external_new_candidates"] = len(preferred_ids - before)
            job["external_existing_candidates"] = len(preferred_ids & before)
            job["candidates"] = len(preferred_ids) + len(indexed_urls)
            launch_validation()
            persist_job(job)

        collect_started = time.perf_counter()
        if backlog_only:
            job["source_progress"]["local_frontier"] = {
                "status": "completed", "seconds": 0, "hits": 0,
                "unique": 0, "new": 0, "existing_overlap": 0,
            }
            hits = []
            launch_validation()
        else:
            hits = await run_collectors(
                sources=body.sources or list(DEFAULT_DISCOVERY_SOURCES),
                per_source_limit=max(100, body.max_queries * 5),
                keywords=kws, queries=queries, on_source=source_finished,
                max_requests=body.max_queries, metrics=discovery_metrics,
            )
            # Custom/test collectors may return hits without invoking the callback.
            missing = [h for h in hits if (h.folder_id, h.source_name) not in job_hits]
            if missing:
                await source_finished("collector_return", missing, {
                    "status": "completed", "seconds": 0, "hits": len(missing),
                })
        job["timings"]["discovery_seconds"] = round(time.perf_counter() - collect_started, 3)
        job["discovery_requests"] = discovery_metrics.get("network_requests", 0)

        all_hits = list(job_hits.values())
        await ingest_hits_to_db(DB, all_hits)
        external_ids = {h.folder_id for h in all_hits}
        preferred_ids.update(external_ids)
        job["external_candidates"] = len(external_ids)
        job["external_new_candidates"] = len(external_ids - before)
        job["external_existing_candidates"] = len(external_ids & before)

        if body.max_validate > 0 and job["status"] != "cancelled":
            job["stage"] = "validating backlog" if backlog_only else "validating current job"
            launch_validation()
            if validation_task:
                await validation_task
                validation_task = None
            remaining = body.max_validate - validation_metrics["processed"]
            if remaining > 0:
                if backlog_only and DB.candidate_stats().get("unvalidated", 0):
                    await validation(remaining)
                elif not backlog_only:
                    ready_preferred = any(
                        row["folder_id"] in preferred_ids
                        for row in DB.list_candidates(limit=10000, ready_only=True)
                    )
                    if ready_preferred:
                        await validation(remaining)
            job["validated"] = validation_metrics["validated"]
            job["content"] = validation_metrics["CONTENT"]
            job["collections"] = validation_metrics["COLLECTION"]
            job["dead"] = validation_metrics["DEAD"]
            job["errors"] = validation_metrics["ERROR"]
            job["processed"] = validation_metrics["processed"]
            rows = DB._conn.execute(
                "SELECT title FROM pages WHERE kind='folder' ORDER BY last_seen DESC LIMIT ?",
                (validation_metrics["CONTENT"],),
            ).fetchall()
            for row in rows:
                ROT.learn_from_title(row["title"] or "")

        hit_ids = {h.folder_id for h in all_hits}
        content_ids = {
            row["folder_id"] for row in DB._conn.execute(
                "SELECT folder_id FROM candidates WHERE folder_type='CONTENT_FOLDER'"
            ) if row["folder_id"] in hit_ids
        }
        record_keyword_feedback(all_hits, kws, before=before, content_ids=content_ids)

        if job["status"] != "cancelled":
            job["status"] = "completed"
        if backlog_only:
            job["message"] = f"Zásobník: {job['validated']} overených, {job['content']} priečinkov s obsahom"
        elif indexed_urls:
            job["message"] = f"{len(indexed_urls)} výsledkov už v indexe; {job['content']} overených priečinkov s obsahom"
        else:
            job["message"] = f"done; {job['errors']} odložených sieťových chýb" if job["errors"] else "done"
    except asyncio.CancelledError:
        job["status"] = "cancelled"
        job["message"] = "cancelled"
    except Exception as exc:
        job["status"] = "failed"
        job["message"] = str(exc)[:300]
        logger_exc(exc)
    finally:
        if validation_task:
            if not validation_task.done():
                validation_task.cancel()
            await asyncio.gather(validation_task, return_exceptions=True)
        discovered = {
            row["folder_id"] for row in DB._conn.execute("SELECT folder_id FROM candidates")
        } - before
        job["new_candidates"] = len(discovered)
        job["candidates"] = job.get("external_candidates", 0) + len(indexed_urls)
        job["discovery_metrics"] = validation_metrics
        job["discovery_requests"] = discovery_metrics.get("network_requests", 0)
        job["network_requests"] = job["discovery_requests"] + validation_metrics["network_requests"]
        job["stage"] = job["status"]
        job["finished_at"] = time.time()
        job["timings"]["total_seconds"] = round(job["finished_at"] - job["started_at"], 3)
        persist_job(job)
        for row in DB._conn.execute("SELECT url,folder_id,last_seen FROM pages WHERE kind='folder'").fetchall():
            # A regular discovery owns folders returned by its collectors. Backlog
            # validation owns only pages actually added or refreshed in that run.
            belongs_to_job = (
                row["url"] not in before_pages or row["last_seen"] != before_pages[row["url"]]
            ) if backlog_only else (
                row["folder_id"] in preferred_ids or
                row["folder_id"] in validation_seen and
                (row["url"] not in before_pages or row["last_seen"] != before_pages[row["url"]])
            )
            if belongs_to_job:
                DB._conn.execute(
                    "INSERT OR IGNORE INTO bridge_results(job_id,url) VALUES (?,?)",
                    (job_id, row["url"]),
                )
        DB._conn.execute(
            """
            UPDATE jobs SET status=?, discovery_requests=?, candidates=?, new_candidates=?,
            validated=?, content=?, collections=?, dead=?, errors=?, current_keyword=?,
            current_source=?, message=? WHERE job_id=?
            """,
            (
                job["status"], job["discovery_requests"], job["candidates"],
                job["new_candidates"], job["validated"], job["content"],
                job["collections"], job["dead"], job["errors"],
                job["current_keyword"], job["current_source"], job.get("message", ""),
                job_id,
            ),
        )
        DB._conn.commit()
        _tasks.pop(job_id, None)


def logger_exc(e):
    import logging
    logging.getLogger("filester.api").exception("job failed: %s", e)


def main():
    import uvicorn
    uvicorn.run(
        "filester_api:app",
        host="127.0.0.1",
        port=8765,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
