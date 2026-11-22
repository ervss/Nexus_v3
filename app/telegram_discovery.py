"""Persistent, sequential Telegram channel discovery and video indexing."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
from sqlalchemy import text
from telethon.errors import FloodWaitError, UserAlreadyParticipantError
from telethon.tl.functions.channels import JoinChannelRequest
from telethon.tl.types import Channel, InputMessagesFilterVideo

from .database import SessionLocal
from .telegram_index import upsert_telegram_media_batch
from .telegram_service import _get_messages, _row
from .telegram_stream import client

log = logging.getLogger(__name__)
USERNAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{4,31}$")
PAGE = 100


def username(value):
    value = value.strip()
    if value.startswith("@"): value = value[1:]
    elif "://" in value or value.lower().startswith(("t.me/", "telegram.me/")):
        url = urlparse(value if "://" in value else "https://" + value)
        if url.hostname not in ("t.me", "telegram.me", "www.t.me"): return None
        value = url.path.strip("/")
        if value.startswith("s/"): value = value[2:]
    return value if USERNAME.fullmatch(value) else None


class ChannelLinks(HTMLParser):
    def __init__(self):
        super().__init__(); self.names = []
    def handle_starttag(self, tag, attrs):
        if tag != "a": return
        href = dict(attrs).get("href", "")
        # Only actual public channel links or TGStat channel profile links.
        match = re.search(r"(?:^|tgstat\.com)/channel/@([A-Za-z][A-Za-z0-9_]{4,31})(?:/|$|\?)", href, re.I)
        name = match.group(1) if match else None
        if name and name.lower() not in {"tgstat_bot", "searcheebot", "tgstat_en"}: self.names.append(name)


async def _discover_tgstat(keywords):
    """Search TGStat; use the official API when configured, otherwise scrape.

    Scraping failures return no discovered channels so the caller can still
    process its manual list. Never log proxy URLs, which may contain passwords.
    """
    import random

    if not keywords.strip():
        return []
    token = os.getenv("TGSTAT_TOKEN", "").strip()
    if token:
        params = {"token": token, "q": keywords, "limit": 100, "country": os.getenv("TGSTAT_COUNTRY", "ru")}
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            async with session.get("https://api.tgstat.ru/channels/search", params=params) as response:
                if response.status != 200:
                    raise RuntimeError(f"TGStat API HTTP {response.status}")
                data = await response.json(content_type=None)
        if data.get("status") != "ok":
            raise RuntimeError("TGStat API: " + str(data.get("error", "search failed"))[:200])
        return [n for item in data.get("response", {}).get("items", []) if (n := username(item.get("username") or item.get("link") or ""))]

    # Keep the UA and client hints consistent with the impersonated browser.
    browsers = [
        ("chrome124", "124", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
        ("chrome131", "131", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
        ("chrome133a", "133", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"),
    ]
    random.shuffle(browsers)
    proxies = [p.strip() for p in os.getenv("TGSTAT_PROXIES", "").split(",") if p.strip()]
    if proxies:
        random.shuffle(proxies)
    try:
        from curl_cffi.requests import AsyncSession as CurlSession
    except ImportError:
        CurlSession = None
    try:
        import cloudscraper
    except ImportError:
        cloudscraper = None

    async def request(headers, impersonate, proxy):
        url = "https://tgstat.com/channels/search"
        params = {"q": keywords}
        if CurlSession is not None:
            async with CurlSession(timeout=30, impersonate=impersonate) as session:
                response = await session.get(url, params=params, headers=headers, proxy=proxy, allow_redirects=True)
                return response.status_code, response.text, response.headers.get("Retry-After")
        if cloudscraper is not None:
            def fetch():
                session = cloudscraper.create_scraper()
                try:
                    response = session.get(url, params=params, headers=headers, proxies={"http": proxy, "https": proxy} if proxy else None, timeout=30)
                    return response.status_code, response.text, response.headers.get("Retry-After")
                finally:
                    session.close()
            return await asyncio.to_thread(fetch)
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            async with session.get(url, params=params, headers=headers, proxy=proxy) as response:
                return response.status, await response.text(), response.headers.get("Retry-After")

    last_reason = "neznáma chyba"
    # Initial request plus three retries; pace every consecutive request.
    for attempt in range(4):
        impersonate, version, user_agent = browsers[attempt % len(browsers)]
        headers = {
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9,sk;q=0.8",
            "Referer": "https://tgstat.com/",
            "sec-ch-ua": f'"Chromium";v="{version}", "Google Chrome";v="{version}", "Not_A Brand";v="24"',
            "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin", "sec-fetch-user": "?1",
            "Upgrade-Insecure-Requests": "1",
        }
        proxy = proxies[attempt % len(proxies)] if proxies else None
        retry_after = None
        try:
            status_code, body, retry_after = await request(headers, impersonate, proxy)
            if status_code == 200:
                parser = ChannelLinks()
                parser.feed(body)
                if parser.names:
                    return parser.names
                last_reason = "žiadne čitateľné výsledky (stránka môže vyžadovať prihlásenie)"
                break
            last_reason = f"HTTP {status_code}"
            if status_code not in (403, 429):
                break
        except (asyncio.CancelledError, KeyboardInterrupt):
            raise
        except Exception as exc:
            # Exception messages from proxy clients may contain credentials.
            last_reason = type(exc).__name__
        if attempt < 3:
            delay = min(10, random.uniform(3, 5) * (2 ** attempt))
            try:
                delay = max(delay, min(float(retry_after), 300))
            except (TypeError, ValueError):
                pass
            log.warning("TGStat discovery: %s, opakujem (%s/3) po %.1f s", last_reason, attempt + 1, delay)
            await asyncio.sleep(delay)
    log.warning("TGStat discovery zlyhalo: %s. Pokračujem s ostatnými zdrojmi; zvážte TGSTAT_TOKEN.", last_reason)
    return []


async def _discover_telemetr(keywords):
    """Use Telemetr.io's documented channel search and public-link lookup.

    Search responses contain Telemetr IDs, not Telegram usernames. The batch
    info endpoint resolves them to links. Both calls can consume paid credits.
    """
    import random

    api_key = os.getenv("TELEMETRIO_API_KEY", "").strip()
    if not api_key:
        log.warning("Telemetr.io: TELEMETRIO_API_KEY nie je nastavený; zdroj preskakujem")
        return []
    headers = {
        "x-api-key": api_key,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://telemetr.io/",
    }
    results = []
    ids = []
    timeout = aiohttp.ClientTimeout(total=30)
    try:
        async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
            for page in range(3):
                if page:
                    await asyncio.sleep(random.uniform(1, 3))
                params = {"term": keywords, "limit": 30, "skip": page * 30}
                try:
                    async with session.get("https://api.tlmtr.io/v1/channels/search", params=params) as response:
                        if response.status != 200:
                            log.warning("Telemetr.io vyhľadávanie strana %d: HTTP %d; pokračujem s ostatnými zdrojmi", page + 1, response.status)
                            break
                        rows = await response.json(content_type=None)
                    if not isinstance(rows, list):
                        log.warning("Telemetr.io: neočakávaná odpoveď vyhľadávania")
                        break
                    for row in rows:
                        if not isinstance(row, dict):
                            continue
                        direct = username(str(row.get("username") or row.get("link") or ""))
                        if direct and str(row.get("privacy", "")).lower() != "private":
                            results.append(direct)
                        internal_id = row.get("internal_id")
                        if isinstance(internal_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", internal_id):
                            ids.append(internal_id)
                    if len(rows) < 30:
                        break
                except Exception as exc:
                    log.warning("Telemetr.io vyhľadávanie strana %d: %s; pokračujem s ostatnými zdrojmi", page + 1, type(exc).__name__)
                    break
            ids = list(dict.fromkeys(ids))[:90]
            if ids:
                await asyncio.sleep(random.uniform(1, 3))
                try:
                    async with session.get("https://api.tlmtr.io/v1/channels/info-batch", params={"ids": ",".join(ids)}) as response:
                        if response.status != 200:
                            log.warning("Telemetr.io údaje kanálov: HTTP %d; pokračujem s ostatnými zdrojmi", response.status)
                            return results
                        data = await response.json(content_type=None)
                    channels = data.get("channels", []) if isinstance(data, dict) else []
                    for channel in channels:
                        if (not isinstance(channel, dict) or channel.get("internal_id") not in ids
                                or str(channel.get("privacy", "")).lower() == "private"):
                            continue
                        name = username(str(channel.get("username") or channel.get("link") or ""))
                        if name:
                            results.append(name)
                except Exception as exc:
                    log.warning("Telemetr.io údaje kanálov: %s; pokračujem s ostatnými zdrojmi", type(exc).__name__)
    except Exception as exc:
        log.warning("Telemetr.io pripojenie: %s; pokračujem s ostatnými zdrojmi", type(exc).__name__)
    return results


async def discover(keywords):
    """Combine independent discovery sources; never discard a successful one."""
    if not keywords.strip():
        return []
    names = []
    for label, source in (("Telemetr.io", _discover_telemetr), ("TGStat", _discover_tgstat)):
        try:
            names.extend(await source(keywords))
        except Exception as exc:
            log.warning("%s discovery zlyhalo: %s; pokračujem s ostatnými zdrojmi", label, type(exc).__name__)
    unique = []
    seen = set()
    for item in names:
        name = username(item)
        if name and name.lower() not in seen:
            seen.add(name.lower())
            unique.append(name)
    return unique


def ensure(db):
    db.execute(text("CREATE TABLE IF NOT EXISTS telegram_discovery_job (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)"))
    db.commit()


def read(db):
    ensure(db)
    raw = db.execute(text("SELECT payload FROM telegram_discovery_job WHERE id=1")).scalar()
    return json.loads(raw) if raw else {"status": "idle", "channels_found": 0, "joined": 0, "failed": 0, "messages_indexed": 0, "current_action": "Pripravené", "log": []}


def write(db, state, commit=True):
    db.execute(text("INSERT INTO telegram_discovery_job(id,payload) VALUES(1,:payload) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload"), {"payload": json.dumps(state, ensure_ascii=False)})
    if commit: db.commit()


def event(state, message):
    state["current_action"] = message
    state.setdefault("log", []).append(message)
    state["log"] = state["log"][-100:]
    log.info("Telegram discovery: %s", message)


def status():
    with SessionLocal() as db: return read(db)


def save(state):
    with SessionLocal() as db:
        ensure(db)
        write(db, state)


class DiscoveryWorker:
    def __init__(self): self.task = None; self.lock_file = None
    async def start(self):
        if self.task and not self.task.done(): return
        path = Path(__file__).resolve().parent.parent / "data" / "telegram_discovery.lock"
        path.parent.mkdir(parents=True, exist_ok=True); handle = path.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                handle.seek(0); handle.write(b"0"); handle.flush(); handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close(); return
        self.lock_file = handle
        self.task = asyncio.create_task(self.run(), name="telegram-discovery")

    async def stop(self):
        if self.task:
            self.task.cancel()
            try: await self.task
            except asyncio.CancelledError: pass
            self.task = None
        if self.lock_file: self.lock_file.close(); self.lock_file = None

    async def submit(self, payload):
        # Serialize creation across processes, including API workers.
        with SessionLocal() as db:
            ensure(db)
            db.execute(text("BEGIN IMMEDIATE"))
            raw = db.execute(text("SELECT payload FROM telegram_discovery_job WHERE id=1")).scalar()
            old = json.loads(raw) if raw else {}
            if old.get("status") == "running":
                db.rollback(); raise ValueError("Discovery už prebieha")
            if payload.pop("resume", False):
                if old.get("status") != "failed":
                    db.rollback(); raise ValueError("Žiadna prerušená úloha na pokračovanie")
                state = old
                state["status"] = "running"
                state["wait_until"] = 0
                event(state, "Pokračujem od poslednej uloženej stránky")
            else:
                state = dict(payload, status="running", phase="discover", channels=[], channels_found=0, joined=0, failed=0, messages_indexed=0, join_attempts=0, current_action="Pripravujem", log=[], wait_until=0)
            write(db, state)
        await self.start()
        return state

    async def run(self):
        try:
            while True:
                state = status()
                if state.get("status") != "running":
                    await asyncio.sleep(2); continue
                remaining = state.get("wait_until", 0) - time.time()
                if remaining > 0:
                    await asyncio.sleep(min(remaining, 5)); continue
                try: await self.step(state)
                except FloodWaitError as exc:
                    state = status(); state["wait_until"] = time.time() + int(exc.seconds) + 1
                    event(state, f"Telegram FloodWait: čakám {exc.seconds} s"); save(state)
                except Exception as exc:
                    log.exception("Discovery job failed")
                    state = status(); state["status"] = "failed"; event(state, f"Chyba: {type(exc).__name__}: {str(exc)[:250]}"); save(state)
        finally:
            pass

    async def step(self, state):
        if state["phase"] == "discover":
            names = list(state["manual_channels"])
            try: names += await discover(state["keywords"])
            except Exception as exc:
                event(state, f"TGStat: {str(exc)[:200]}")
                if not names: state["status"] = "failed"; save(state); return
            seen = set(); channels = []
            for name in names:
                n = username(name)
                if n and n.lower() not in seen:
                    seen.add(n.lower()); channels.append({"username": n, "state": "pending", "cursor": 0})
            state["channels"] = channels; state["channels_found"] = len(channels); state["phase"] = "process"
            event(state, f"Nájdených {len(channels)} verejných kanálov"); save(state); return
        channel = next((c for c in state["channels"] if c["state"] in ("pending", "indexing")), None)
        if not channel:
            state["status"] = "completed"; event(state, "Dokončené"); save(state); return
        connection = await client(); name = channel["username"]
        if channel["state"] == "pending":
            try:
                entity = await connection.get_entity(name)
                if not isinstance(entity, Channel): raise ValueError("Nie je verejný kanál alebo skupina")
                if getattr(entity, "left", True) and not channel.get("join_attempted") and state.get("join_attempts", 0) >= state["max_joins"]:
                    channel["state"] = "skipped"; event(state, f"Limit pripojení: @{name} preskočený"); save(state); return
                if not getattr(entity, "left", True):
                    if channel.get("join_attempted"):
                        state["joined"] += 1
                    else:
                        channel["already_joined"] = True
                else:
                    if not channel.get("join_attempted"):
                        channel["join_attempted"] = True
                        state["join_attempts"] = state.get("join_attempts", 0) + 1
                        event(state, f"Pripájam @{name}"); save(state)
                    try: await connection(JoinChannelRequest(entity))
                    except UserAlreadyParticipantError: channel["already_joined"] = True
                    else: state["joined"] += 1
                channel["state"] = "indexing"; event(state, f"Indexujem @{name}")
                state["wait_until"] = time.time() + state["delay"]
            except FloodWaitError: raise
            except Exception as exc:
                channel["state"] = "failed"; state["failed"] += 1
                event(state, f"@{name}: {type(exc).__name__}: {str(exc)[:120]}")
                state["wait_until"] = time.time() + state["delay"]
            save(state); return
        try:
            entity = await connection.get_entity(name)
            messages = await _get_messages(connection, entity, limit=PAGE, offset_id=channel["cursor"], filter=InputMessagesFilterVideo(), _background=True)
            cutoff = datetime.combine(date.fromisoformat(state["date_from"]), datetime.min.time(), tzinfo=timezone.utc)
            valid = [m for m in messages if getattr(m, "date", None) and m.date >= cutoff]
            rows = [r for m in valid if (r := _row(m, entity, name))]
            if messages: channel["cursor"] = min(m.id for m in messages)
            if not messages or len(valid) < len(messages): channel["state"] = "done"
            state["messages_indexed"] += len(rows)
            event(state, f"@{name}: uložených {len(rows)} videí" + (" · hotovo" if channel["state"] == "done" else ""))
            with SessionLocal() as db:
                upsert_telegram_media_batch(db, rows, commit=False)
                write(db, state, commit=False); db.commit()
            await asyncio.sleep(0.5)
        except FloodWaitError: raise
        except Exception as exc:
            # Reload committed state so a failed page never advances its cursor.
            state = status()
            state["status"] = "failed"
            event(state, f"Index @{name}: {type(exc).__name__}: {str(exc)[:120]}"); save(state)


worker = DiscoveryWorker()
