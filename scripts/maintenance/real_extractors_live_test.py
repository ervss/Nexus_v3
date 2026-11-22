"""
Real Live Video Extraction & Stream Test for all Nexus Extractors
================================================================
Pre každý extraktor:
1. Nájde reálnu URL (z lokálnej DB alebo z live homepage).
2. Spustí skutočnú metódu ex.extract(url).
3. Overí, či získal title, thumbnail a najmä funkčný stream_url.
4. Overí dostupnosť stream_url (HTTP 200/206).
"""

import asyncio
import datetime
import inspect
import json
import logging
import re
import sqlite3
import sys
import time
import urllib.parse
from pathlib import Path
from bs4 import BeautifulSoup

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

import httpx
from app.extractors import ExtractorRegistry, register_extended_extractors

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("nexus.real_test")

# Získanie URL z DB
def get_db_urls():
    db_path = BASE_DIR / "nexus_test.db"
    if not db_path.exists():
        return {}
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute("SELECT source_url, url FROM videos ORDER BY id DESC")
    rows = c.fetchall()
    conn.close()

    register_extended_extractors()
    all_exts = ExtractorRegistry.get_all()
    found = {}
    for s, u in rows:
        candidate = s or u
        if not candidate:
            continue
        for ex in all_exts:
            if ex.name not in found:
                try:
                    if ex.can_handle(candidate):
                        found[ex.name] = candidate
                except Exception:
                    pass
    return found


# Známe domovské stránky pre scraping prvého reálneho linku
KNOWN_HOMEPAGES = {
    "1Porn": "https://1porn.tv",
    "69Tubed": "https://69tubed.com",
    "8KPorner": "https://8kporner.com",
    "Archivebate": "https://archivebate.com",
    "BaddieHub": "https://baddiehub.com",
    "Beeg": "https://beeg.com",
    "BigPorn": "https://bigporn.com",
    "Bunkr": "https://bunkr.cr",
    "Camwhores": "https://www.camwhores.tv",
    "CamWhoresBay": "https://camwhoresbay.com",
    "Civitai": "https://civitai.com",
    "Coomerfans": "https://coomerfans.com",
    "CyberFile": "https://cyberfile.me",
    "CyberLeaks": "https://cyberleaks.top",
    "Eporner": "https://www.eporner.com",
    "Erome": "https://www.erome.com",
    "Faphouse": "https://faphouse.com",
    "FNXTube": "https://fnxtube.com",
    "Fpo": "https://fpo.xxx",
    "FreePornFun": "https://freepornfun.com",
    "Freeuseporn": "https://freeuseporn.com",
    "GoFile": "https://gofile.io",
    "HornySimp": "https://hornysimp.com",
    "HQPorner": "https://hqporner.com",
    "InternetChicks": "https://internetchicks.com",
    "iXXX": "https://ixxx.com",
    "KrakenFiles": "https://krakenfiles.com",
    "Leakedzone": "https://leakedzone.com",
    "LeakPorner": "https://tv.leakporner.com",
    "LuluStream": "https://luluvdo.com",
    "MyPornerLeak": "https://mypornerleak.com",
    "NoodleMagazine": "https://noodlemagazine.com",
    "NSFW247": "https://nsfw247.to",
    "PimpBunny": "https://pimpbunny.com",
    "Pixeldrain": "https://pixeldrain.com",
    "Porneec": "https://porneec.com",
    "PornFans": "https://pornfans.net",
    "PornHat": "https://pornhat.com",
    "PornHD4K": "https://pornhd4k.net",
    "PornHoarder": "https://pornhoarder.tv",
    "Pornhub": "https://www.pornhub.com",
    "PornOne": "https://pornone.com",
    "Porntrex": "https://www.porntrex.com",
    "Recurbate": "https://recurbate.com",
    "RedGifs": "https://www.redgifs.com",
    "RedTube": "https://www.redtube.com",
    "Shareanynudes": "https://shareanynudes.com",
    "SlutVids": "https://slutvids.net.lv",
    "SpankBang": "https://spankbang.com",
    "SxyPrn": "https://www.sxyprn.com",
    "ThisVid": "https://thisvid.com",
    "Thothub": "https://thothub.to",
    "ThotsTv": "https://thots.tv",
    "Turbo": "https://turbo.cr",
    "Vidara": "https://vidara.so",
    "VK": "https://vk.com",
    "vTube": "https://vtbe.to",
    "WhoresHub": "https://www.whoreshub.com",
    "Xfree": "https://xfree.com",
    "XGroovy": "https://xgroovy.com",
    "xHamster": "https://xhamster.com",
    "XNXX": "https://www.xnxx.com",
    "XVideos": "https://www.xvideos.com",
    "XXBrits": "https://xxbrits.com",
    "Xxxdbx": "https://xxxdbx.com",
}


async def discover_real_url(ex, client):
    name = ex.name
    homepage = KNOWN_HOMEPAGES.get(name)
    if not homepage:
        return None

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
        resp = await client.get(homepage, headers=headers)
        if resp.status_code >= 400:
            return None

        soup = BeautifulSoup(resp.text, "html.parser")
        links = [a.get("href") for a in soup.find_all("a", href=True)]

        # Filtrujeme a hľadáme link, ktorý zvládne can_handle
        for link in links:
            if not link or link in ("#", "/", ""):
                continue
            full_url = urllib.parse.urljoin(homepage, link)
            try:
                if ex.can_handle(full_url):
                    return full_url
            except Exception:
                pass
    except Exception as e:
        logger.debug("Discovery zlyhalo pre %s: %s", name, e)

    return None


async def test_extractor_real_extraction(ex, sem, client, db_urls):
    async with sem:
        name = ex.name
        real_url = db_urls.get(name)

        # Ak nemáme v DB, pokúsime sa objaviť z live homepage
        if not real_url:
            real_url = await discover_real_url(ex, client)

        if not real_url:
            return {
                "name": name,
                "real_url": None,
                "status": "NO_LIVE_URL",
                "detail": "Nepodarilo sa automaticky získať živý odkaz (Cloudflare / chýba v DB)",
                "extracted_title": None,
                "stream_url": None,
                "stream_valid": False,
                "ms": 0,
            }

        t0 = time.perf_counter()
        extracted_data = None
        extract_err = None

        try:
            # Spustenie skutočného extract(url)
            extract_task = ex.extract(real_url)
            extracted_data = await asyncio.wait_for(extract_task, timeout=14.0)
        except asyncio.TimeoutError:
            extract_err = "Timeout pri extrakcii (14s)"
        except Exception as e:
            extract_err = f"{type(e).__name__}: {str(e)[:100]}"

        ms = round((time.perf_counter() - t0) * 1000)

        if not extracted_data:
            return {
                "name": name,
                "real_url": real_url,
                "status": "EXTRACT_FAILED",
                "detail": extract_err or "extract() vrátil prázdny výsledok (None)",
                "extracted_title": None,
                "stream_url": None,
                "stream_valid": False,
                "ms": ms,
            }

        # Skontrolujeme, čo sme získali
        title = extracted_data.get("title") or extracted_data.get("name")
        stream_url = (
            extracted_data.get("stream_url")
            or extracted_data.get("direct_url")
            or extracted_data.get("url")
            or (extracted_data.get("video_urls", [{}])[0].get("url") if extracted_data.get("video_urls") else None)
        )

        stream_valid = False
        stream_status = "NO_STREAM_URL"

        if stream_url and str(stream_url).startswith("http"):
            # Overíme stream_url cez HEAD alebo GET na prvých 1024 bajtov
            try:
                s_resp = await client.get(
                    stream_url,
                    headers={
                        "Range": "bytes=0-1024",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                        "Referer": real_url
                    },
                    timeout=8.0
                )
                c_type = s_resp.headers.get("content-type", "").lower()
                if s_resp.status_code in (200, 206) and ("video" in c_type or "mpegurl" in c_type or "octet-stream" in c_type or len(s_resp.content) > 100):
                    stream_valid = True
                    stream_status = f"STREAM_OK ({s_resp.status_code}, {c_type})"
                else:
                    stream_status = f"HTTP {s_resp.status_code} ({c_type})"
            except Exception as e:
                stream_status = f"Stream probe error: {type(e).__name__}"

        status = "SUCCESS_FULLY_PLAYABLE" if (title and stream_valid) else ("EXTRACTED_METADATA_ONLY" if title else "INVALID_OUTPUT")

        return {
            "name": name,
            "real_url": real_url,
            "status": status,
            "detail": stream_status,
            "extracted_title": title,
            "stream_url": stream_url[:120] if stream_url else None,
            "stream_valid": stream_valid,
            "ms": ms,
        }


async def main():
    print("=" * 75)
    print("  SKUTOČNÝ END-TO-END AUDIT EXTRAKCIE A STREAMOVANIA PRE EXTRAKTORY")
    print("=" * 75)

    register_extended_extractors()
    all_exts = ExtractorRegistry.get_all()
    print(f"Registrovaných extraktorov: {len(all_exts)}")

    db_urls = get_db_urls()
    print(f"Reálnych overených URL nájdených v lokálnej DB: {len(db_urls)}")

    sem = asyncio.Semaphore(6)  # Max 6 súčasných extrakcií
    timeout = httpx.Timeout(18.0, connect=8.0)

    async with httpx.AsyncClient(timeout=timeout, verify=False, follow_redirects=True) as client:
        tasks = [test_extractor_real_extraction(ex, sem, client, db_urls) for ex in all_exts]
        results = await asyncio.gather(*tasks)

    # Zoradenie
    results = sorted(results, key=lambda x: x["name"].lower())

    # Štatistiky
    playable = [r for r in results if r["status"] == "SUCCESS_FULLY_PLAYABLE"]
    meta_only = [r for r in results if r["status"] == "EXTRACTED_METADATA_ONLY"]
    failed = [r for r in results if r["status"] == "EXTRACT_FAILED"]
    no_url = [r for r in results if r["status"] == "NO_LIVE_URL"]

    print("\n" + "=" * 95)
    print("{:<18} | {:<24} | {:<22} | {:<20}".format("Extraktor", "Stav extrakcie", "Detail streamu", "Názov videa"))
    print("-" * 95)

    for r in results:
        status_label = r["status"]
        if r["status"] == "SUCCESS_FULLY_PLAYABLE":
            status_label = "🟢 PLAYABLE"
        elif r["status"] == "EXTRACTED_METADATA_ONLY":
            status_label = "🟡 LEN METADÁTA"
        elif r["status"] == "EXTRACT_FAILED":
            status_label = "🔴 ZLYHALA EXTRAKCIA"
        elif r["status"] == "NO_LIVE_URL":
            status_label = "⚪ NENÁJDENÝ ŽIVÝ LINK"

        title_prev = (r["extracted_title"] or "-")[:20]
        print("{:<18} | {:<24} | {:<22} | {:<20}".format(
            r["name"], status_label, str(r["detail"])[:22], title_prev
        ))

    print("\n" + "=" * 75)
    print("                 VÝSLEDKY REÁLNEHO TESTU EXTRAKCIÍ")
    print("=" * 75)
    print(f" 🟢 Plne funkčné & streamovateľné (Playable): {len(playable)} ({len(playable)/len(results)*100:.1f} %)")
    print(f" 🟡 Získané metadáta (stream chránený/token): {len(meta_only)} ({len(meta_only)/len(results)*100:.1f} %)")
    print(f" 🔴 Extrakcia zlyhala (chyba parsovania):     {len(failed)} ({len(failed)/len(results)*100:.1f} %)")
    print(f" ⚪ Chýba živý odkaz (Cloudflare/403 block):    {len(no_url)} ({len(no_url)/len(results)*100:.1f} %)")
    print("=" * 75)

    out_file = BASE_DIR / "scripts" / "real_live_extraction_results.json"
    out_file.write_text(json.dumps({
        "timestamp": datetime.datetime.now().isoformat(),
        "total": len(results),
        "summary": {
            "fully_playable": len(playable),
            "metadata_only": len(meta_only),
            "extract_failed": len(failed),
            "no_live_url": len(no_url)
        },
        "results": results
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Podrobný JSON report uložený do: {out_file}")


if __name__ == "__main__":
    asyncio.run(main())
