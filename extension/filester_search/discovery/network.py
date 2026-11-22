"""Polite persistent HTTP guard for the dashboard discovery hot path.

No identity rotation: respect remote limits, isolate backend cookies, cache public
responses and stop a failing origin rather than retrying every candidate.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
import time
import zlib
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit

import httpx


class CoolingDown(httpx.HTTPError):
    pass


class RequestBudgetExceeded(httpx.HTTPError):
    pass


def data_directory() -> Path:
    directory = Path(os.getenv("FILESTER_DATA_DIR", str(Path.home()/"Desktop"/"Filester Search Data")))
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def host_key(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    # Mirrors share a budget: changing the domain must not bypass a cooldown.
    return "filester" if host in {"filester.me", "www.filester.me", "filester.si", "filester.sh", "filester.gg"} else host


def retry_delay(value: str | None, now: float) -> float | None:
    if not value:
        return None
    try:
        return max(0, float(value))
    except ValueError:
        try:
            return max(0, parsedate_to_datetime(value).timestamp()-now)
        except (ValueError, TypeError, OverflowError):
            return None


def is_challenge(response: httpx.Response) -> bool:
    # JSON search results can mention captchas; that is not a blocking page.
    if "text/html" not in response.headers.get("content-type", ""):
        return False
    text = response.text[:12000].lower()
    return any(marker in text for marker in (
        "<title>just a moment", "<title>ddos-guard", "<title>attention required",
        "verify you are human", "checking your browser before accessing",
    ))


class NetworkStore:
    def __init__(self, path: Path | None = None):
        self.conn = sqlite3.connect(path or data_directory()/"network_cache.db", timeout=5)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS hosts (
          host TEXT PRIMARY KEY, cooldown REAL DEFAULT 0, next_start REAL DEFAULT 0,
          rps REAL DEFAULT 1.5, failures INTEGER DEFAULT 0, reason TEXT DEFAULT '');
        CREATE TABLE IF NOT EXISTS cache (
          key TEXT PRIMARY KEY, status INTEGER, headers TEXT, body BLOB, expires REAL, fetched REAL);
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY, ts REAL, host TEXT, status INTEGER, ms REAL, kind TEXT);
        CREATE INDEX IF NOT EXISTS event_ts ON events(ts);
        """)
        self.conn.execute("DELETE FROM cache WHERE fetched<?", (time.time()-7*86400,))
        self.conn.execute("DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0)-5000 FROM events)")
        self.conn.commit()

    def close(self):
        self.conn.close()

    def event(self, host, status, ms, kind):
        self.conn.execute("INSERT INTO events(ts,host,status,ms,kind) VALUES (?,?,?,?,?)", (time.time(),host,status,round(ms,2),kind))
        self.conn.commit()

    def reserve(self, host, base_rps):
        now = time.time()
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            self.conn.execute("INSERT OR IGNORE INTO hosts(host,rps) VALUES (?,?)", (host,base_rps))
            row = self.conn.execute("SELECT * FROM hosts WHERE host=?", (host,)).fetchone()
            if row["cooldown"] > now:
                raise CoolingDown(f"{host}: {row['reason']}; pause {int(row['cooldown']-now)+1}s")
            start = max(now,row["next_start"])
            self.conn.execute("UPDATE hosts SET next_start=? WHERE host=?", (start+1/max(.25,min(base_rps,row["rps"])),host))
            self.conn.commit()
            return max(0,start-now)
        except BaseException:
            self.conn.rollback()
            raise

    def check_cooldown(self, host):
        row = self.conn.execute("SELECT * FROM hosts WHERE host=?",(host,)).fetchone()
        if row and row["cooldown"] > time.time():
            raise CoolingDown(f"{host}: {row['reason']}; pause {int(row['cooldown']-time.time())+1}s")

    def report(self, host, status, ms, base_rps, headers=None, challenge=False):
        now = time.time()
        row = self.conn.execute("SELECT * FROM hosts WHERE host=?",(host,)).fetchone()
        rate = row["rps"]
        failures = row["failures"]
        cooldown = row["cooldown"]
        reason = row["reason"]
        if status in (401,403,429) or challenge:
            failures += 1
            wait = retry_delay((headers or {}).get("retry-after"),now)
            fallback = 900 if status in (401,403) or challenge else 60
            cooldown = max(cooldown,now+max(fallback,wait or 0))
            reason = "challenge" if challenge else f"HTTP {status}"
            rate = max(.25,rate*.5)
        elif status == 0 or status >= 500:
            failures += 1
            rate = max(.25,rate*.7)
            wait = retry_delay((headers or {}).get("retry-after"),now)
            if failures >= 2 or wait is not None:
                cooldown = max(cooldown,now+max(wait or 0,min(300,15*2**min(failures-2,4))))
                reason = "timeout / network failure" if status==0 else f"HTTP {status}"
        else:
            failures = 0
            rate = max(.25,rate*.8) if ms>2500 else min(base_rps,rate*1.05)
            if cooldown<=now: reason=""
        if (headers or {}).get("x-rate-limit-remaining")=="0":
            reset=(headers or {}).get("x-rate-limit-reset","")
            try:
                reset_at=float(reset) if reset.isdigit() else datetime.fromisoformat(reset.replace("Z","+00:00")).timestamp()
                if reset_at>now:
                    cooldown=max(cooldown,reset_at)
                    reason="quota exhausted"
            except (ValueError,TypeError,OverflowError): pass
        self.conn.execute("UPDATE hosts SET cooldown=?,rps=?,failures=?,reason=? WHERE host=?",(cooldown,rate,failures,reason,host))
        self.conn.commit()

    def cache_get(self, key):
        return self.conn.execute("SELECT * FROM cache WHERE key=?", (key,)).fetchone()

    def cache_put(self,key,response,ttl):
        directives = response.headers.get("cache-control", "").lower()
        if "no-store" in directives or response.headers.get("vary")=="*" or len(response.content)>2_000_000:
            return
        if "no-cache" in directives: ttl=0
        for directive in directives.split(","):
            if directive.strip().startswith("max-age="):
                try: ttl=min(ttl,max(0,int(directive.strip().split("=",1)[1])))
                except ValueError: pass
        headers = {k:v for k,v in response.headers.items() if k in ("content-type","etag","last-modified","cache-control")}
        self.conn.execute("INSERT OR REPLACE INTO cache VALUES (?,?,?,?,?,?)",(key,response.status_code,json.dumps(headers),zlib.compress(response.content),time.time()+ttl,time.time()))
        count,size=self.conn.execute("SELECT COUNT(*),COALESCE(SUM(length(body)),0) FROM cache").fetchone()
        while count>512 or size>64*1024*1024:
            self.conn.execute("DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY fetched LIMIT 32)")
            count,size=self.conn.execute("SELECT COUNT(*),COALESCE(SUM(length(body)),0) FROM cache").fetchone()
        self.conn.commit()

    def snapshot(self):
        rows = self.conn.execute("SELECT * FROM events ORDER BY id DESC LIMIT 1000").fetchall()
        network = [r for r in rows if r["kind"]=="network"]
        times=sorted(r["ms"] for r in network)
        return {"requests":len(network),"cache_hits":sum(r["kind"] in ("cache","revalidated") for r in rows),
            "errors":sum(r["status"]==0 or r["status"]>=400 for r in network),
            "p95_ms":round(times[min(len(times)-1,int(len(times)*.95))],1) if times else 0,
            "hosts":[dict(r) for r in self.conn.execute("SELECT host,cooldown,rps,failures,reason FROM hosts")],
            "recent":[dict(r) for r in rows[:20]]}


class GuardedClient:
    """Drop-in get() client; cookies live only in this backend session."""
    def __init__(self, *, headers=None, ttl=3600, store=None, transport=None, max_requests=None):
        self.store=store or NetworkStore()
        self.owns_store=store is None
        self.ttl=ttl
        self.semaphores={}
        self.url_locks={}
        self.max_requests = max_requests
        self.network_requests = 0
        async def count_request(request):
            # HTTPX calls hooks for redirects too. Reserve before the wire;
            # transport errors still cost a request, cache hits do not.
            if self.max_requests is not None and self.network_requests >= self.max_requests:
                raise RequestBudgetExceeded("network request budget exhausted")
            self.network_requests += 1
        self.client=httpx.AsyncClient(headers=headers,follow_redirects=True,
            event_hooks={"request": [count_request]},
            timeout=httpx.Timeout(8,connect=5),limits=httpx.Limits(max_connections=8,max_keepalive_connections=8),
            **({"transport":transport} if transport is not None else {}))

    async def __aenter__(self):
        await self.client.__aenter__()
        return self

    async def __aexit__(self,*args):
        await self.client.__aexit__(*args)
        if self.owns_store: self.store.close()

    async def get(self,url,**kwargs):
        lock=self.url_locks.setdefault(url,asyncio.Lock())
        async with lock:
            return await self._get(url,**kwargs)

    async def _get(self,url,**kwargs):
        host=host_key(url)
        # Authenticated responses are not shared through the public-response cache.
        secret=any(k.lower() in ("authorization","x-subscription-token","api-key","cookie") for k in list(self.client.headers)+list(kwargs.get("headers") or {}))
        key=hashlib.sha256(url.encode()).hexdigest()
        cached=None if secret else self.store.cache_get(key)
        request=httpx.Request("GET",url)
        if cached and cached["expires"]>time.time():
            self.store.event(host,cached["status"],0,"cache")
            return httpx.Response(cached["status"],content=zlib.decompress(cached["body"]),headers=json.loads(cached["headers"]),request=request,extensions={"cache_hit":True})
        base_rps=1.5 if host=="filester" else .5
        semaphore=self.semaphores.setdefault(host,asyncio.Semaphore(2 if host=="filester" else 1))
        async with semaphore:
            wait=self.store.reserve(host,base_rps)
            if wait: await asyncio.sleep(wait)
            self.store.check_cooldown(host)
            headers=dict(kwargs.pop("headers",{}) or {})
            if cached:
                old_headers=json.loads(cached["headers"])
                if old_headers.get("etag"): headers["If-None-Match"]=old_headers["etag"]
                elif old_headers.get("last-modified"): headers["If-Modified-Since"]=old_headers["last-modified"]
            start=time.perf_counter()
            try:
                async with asyncio.timeout(12):
                    response=await self.client.get(url,headers=headers,**kwargs)
            except RequestBudgetExceeded:
                raise
            except (httpx.HTTPError,TimeoutError) as error:
                ms=(time.perf_counter()-start)*1000
                self.store.report(host,0,ms,base_rps)
                self.store.event(host,0,ms,type(error).__name__)
                # Count transport failures in network statistics as well.
                self.store.event(host,0,ms,"network")
                raise httpx.TransportError(type(error).__name__) from error
            ms=(time.perf_counter()-start)*1000
            challenge=is_challenge(response)
            self.store.report(host,response.status_code,ms,base_rps,response.headers,challenge)
            self.store.event(host,response.status_code,ms,"network")
            if challenge:
                raise CoolingDown(f"{host}: challenge page; paused")
            if response.status_code==304 and cached:
                merged=json.loads(cached["headers"])
                merged.update({k:v for k,v in response.headers.items() if k in ("etag","last-modified","cache-control")})
                response=httpx.Response(cached["status"],content=zlib.decompress(cached["body"]),headers=merged,request=request,extensions={"cache_hit":True})
                self.store.event(host,304,ms,"revalidated")
            if not secret and response.status_code in (200,404,410):
                self.store.cache_put(key,response,min(self.ttl,300) if response.status_code!=200 else self.ttl)
            return response
