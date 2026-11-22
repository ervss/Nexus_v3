"""
Comprehensive 100% Audit of all 68 Registered Extractors
=========================================================
Tests every single registered extractor in Nexus:
- can_handle matching
- target domain resolution
- network HTTP probe (live status, Cloudflare detection, timeouts)
"""

import asyncio
import datetime
import json
import logging
import re
import sys
import time
import urllib.parse
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

import httpx
from app.extractors import ExtractorRegistry, register_extended_extractors

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("nexus.all_audit")

# Map of representative canary / test URLs for all 68 extractors
ALL_CANARIES = {
    # 24 už skôr testovaných
    "Bunkr": "https://bunkr.cr/v/test",
    "Eporner": "https://www.eporner.com/video-6Nsp2r5qK9b/test/",
    "XVideos": "https://www.xvideos.com/video73549219/test",
    "xHamster": "https://xhamster.com/videos/test-16472819",
    "SpankBang": "https://spankbang.com/8f413/video/test",
    "Pornhub": "https://www.pornhub.com/view_video.php?viewkey=64f51e04cfad6",
    "PornTrex": "https://www.porntrex.com/video/12345/test",
    "Porntrex": "https://www.porntrex.com/video/12345/test",
    "Erome": "https://www.erome.com/a/test",
    "CyberDrop": "https://cyberdrop.me/a/test",
    "Gofile": "https://gofile.io/d/test",
    "GoFile": "https://gofile.io/d/test",
    "Pixeldrain": "https://pixeldrain.com/u/test",
    "RedGifs": "https://www.redgifs.com/watch/test",
    "Faphouse": "https://faphouse.com/videos/test",
    "NoodleMagazine": "https://noodlemagazine.com/watch/-123456_789",
    "SxyPrn": "https://www.sxyprn.com/post/test.html",
    "VK": "https://vk.com/video-123456_789",
    "ThisVid": "https://thisvid.com/videos/test/",
    "Filester": "https://filester.me/v/test",
    "Camwhores": "https://www.camwhores.tv/videos/12345/test/",
    "Turbo": "https://turbo.cr/v/test",
    "HQPorner": "https://hqporner.com/hdporn/12345-test.html",
    "Beeg": "https://beeg.com/12345678",
    "XNXX": "https://www.xnxx.com/video-12345/test",
    "RedTube": "https://www.redtube.com/12345",

    # 44 predtým neotestovaných
    "1Porn": "https://1porn.tv/videos/test-video-123",
    "69Tubed": "https://69tubed.com/videos/12345/test/",
    "8KPorner": "https://8kporner.com/video/12345/test",
    "Archivebate": "https://archivebate.com/watch/12345",
    "BaddieHub": "https://baddiehub.com/post/12345",
    "BigPorn": "https://bigporn.com/video/12345",
    "CamWhoresBay": "https://camwhoresbay.com/videos/12345/test/",
    "Civitai": "https://civitai.com/images/12345",
    "Coomerfans": "https://coomerfans.com/post/12345",
    "CyberFile": "https://cyberfile.me/file/test",
    "CyberLeaks": "https://cyberleaks.top/watch/12345",
    "FNXTube": "https://fnxtube.com/video/12345",
    "Fpo": "https://fpo.xxx/video/12345",
    "FreePornFun": "https://freepornfun.com/video/12345",
    "Freeuseporn": "https://freeuseporn.com/post/12345",
    "HornySimp": "https://hornysimp.com/video/12345",
    "InternetChicks": "https://internetchicks.com/post/12345",
    "KrakenFiles": "https://krakenfiles.com/view/12345/file.html",
    "LeakPorner": "https://leakporner.com/video/12345",
    "Leakedzone": "https://leakedzone.com/post/12345",
    "LuluStream": "https://luluvdo.com/e/12345",
    "MyPornerLeak": "https://mypornerleak.com/video/12345",
    "NSFW247": "https://nsfw247.to/video/12345",
    "PimpBunny": "https://pimpbunny.com/video/12345",
    "PornFans": "https://pornfans.net/post/12345",
    "PornHD4K": "https://pornhd4k.net/video/12345",
    "PornHat": "https://pornhat.com/video/12345",
    "PornHoarder": "https://pornhoarder.tv/video/12345",
    "PornOne": "https://pornone.com/video/12345",
    "Porneec": "https://porneec.com/video/12345",
    "Pornonahobka": "https://pornonahobka.icu/video/12345",
    "Recurbate": "https://recurbate.com/watch/12345",
    "Shareanynudes": "https://shareanynudes.com/post/12345",
    "SlutVids": "https://slutvids.net.lv/watch/12345",
    "Thothub": "https://thothub.to/video/12345",
    "ThotsTv": "https://thots.tv/watch/12345",
    "Vidara": "https://vidara.so/v/12345",
    "WhoresHub": "https://www.whoreshub.com/video/12345",
    "XGroovy": "https://xgroovy.com/video/12345",
    "XXBrits": "https://xxbrits.com/video/12345",
    "Xfree": "https://xfree.com/video/12345",
    "Xxxdbx": "https://xxxdbx.com/post/12345",
    "iXXX": "https://ixxx.com/video/12345",
    "vTube": "https://vtbe.to/video/12345",
}


async def test_single_extractor(ex, sem, client):
    async with sem:
        name = ex.name
        canary = ALL_CANARIES.get(name)
        if not canary:
            return {
                "name": name,
                "canary": None,
                "can_handle": False,
                "domain": None,
                "http_status": "NoCanary",
                "classification": "UNTESTED",
                "ms": 0,
            }

        domain = urllib.parse.urlparse(canary).netloc

        # 1. can_handle check
        try:
            can_h = bool(ex.can_handle(canary))
        except Exception:
            can_h = False

        # 2. network probe
        t0 = time.perf_counter()
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        }
        classification = "UNKNOWN"
        http_status = "ERR"
        try:
            resp = await client.get(f"https://{domain}", headers=headers)
            code = resp.status_code
            http_status = f"HTTP {code}"

            if code in (200, 301, 302, 307, 308):
                classification = "ONLINE"
            elif code == 403:
                classification = "CLOUDFLARE_403"
            elif code == 410:
                classification = "RESTRICTED_410"
            elif code == 404:
                classification = "ONLINE_404"  # domain alive, root 404
            elif code >= 500:
                classification = "SERVER_ERROR_5XX"
            else:
                classification = f"HTTP_{code}"
        except httpx.ConnectTimeout:
            http_status = "Timeout"
            classification = "TIMEOUT"
        except httpx.ConnectError:
            http_status = "ConnectError"
            classification = "OFFLINE_OR_DNS"
        except Exception as e:
            http_status = type(e).__name__
            classification = "ERROR"

        ms = round((time.perf_counter() - t0) * 1000)

        # Doplnenie kategórie ak vyžaduje prihlásenie
        auth_sites = {"Faphouse", "SimpCity", "HotContainer", "VK", "Pornolab", "Telegram"}
        if name in auth_sites and classification == "ONLINE":
            classification = "ONLINE_NEEDS_AUTH"

        return {
            "name": name,
            "canary": canary,
            "can_handle": can_h,
            "domain": domain,
            "http_status": http_status,
            "classification": classification,
            "ms": ms,
        }


async def main():
    print("=" * 70)
    print("   KOMPLETNÝ AUDIT VŠETKÝCH 68 EXTRAKTOROV V NEXUS SYSTÉME")
    print("=" * 70)

    register_extended_extractors()
    all_exts = ExtractorRegistry.get_all()
    print(f"Celkovo nájdených extraktorov: {len(all_exts)}")

    sem = asyncio.Semaphore(8)  # max 8 súčasných požiadaviek
    timeout = httpx.Timeout(8.0, connect=5.0)

    async with httpx.AsyncClient(timeout=timeout, verify=False, follow_redirects=True) as client:
        tasks = [test_single_extractor(ex, sem, client) for ex in all_exts]
        results = await asyncio.gather(*tasks)

    # Zoradenie podľa mena
    results = sorted(results, key=lambda x: x["name"].lower())

    # Štatistiky
    online_count = sum(1 for r in results if r["classification"].startswith("ONLINE"))
    cf_count = sum(1 for r in results if r["classification"] == "CLOUDFLARE_403")
    timeout_count = sum(1 for r in results if r["classification"] == "TIMEOUT")
    offline_count = sum(1 for r in results if r["classification"] == "OFFLINE_OR_DNS")
    restricted_count = sum(1 for r in results if r["classification"] == "RESTRICTED_410")
    error_count = sum(1 for r in results if r["classification"] in ("ERROR", "SERVER_ERROR_5XX"))

    print("\n{:<18} | {:<10} | {:<25} | {:<14} | {:<16}".format("Extraktor", "can_handle", "Doména", "HTTP Odozva", "Stav"))
    print("-" * 90)

    for r in results:
        can_h_icon = "ÁNO" if r["can_handle"] else "NIE"
        status_color = r["classification"]
        print("{:<18} | {:<10} | {:<25} | {:<14} | {:<16}".format(
            r["name"], can_h_icon, str(r["domain"])[:25], r["http_status"], status_color
        ))

    print("\n" + "=" * 70)
    print("                      SÚHRNNÁ ŠTATISTIKA AUDITU")
    print("=" * 70)
    print(f" Celkovo otestovaných extraktorov: {len(results)}")
    print(f" 🟢 ONLINE a dostupné domény:     {online_count} ({online_count/len(results)*100:.1f} %)")
    print(f" 🟡 Cloudflare ochrana (HTTP 403): {cf_count} ({cf_count/len(results)*100:.1f} %)")
    print(f" 🟡 Veková / Geo reštrikcia (410): {restricted_count} ({restricted_count/len(results)*100:.1f} %)")
    print(f" 🔴 Offline / Neexistujúca doména: {offline_count} ({offline_count/len(results)*100:.1f} %)")
    print(f" 🔴 Timeout pripojenia:           {timeout_count} ({timeout_count/len(results)*100:.1f} %)")
    print(f" 🔴 Iná chyba servera (5xx):       {error_count} ({error_count/len(results)*100:.1f} %)")
    print("=" * 70)

    # Uloženie do JSON
    out_path = BASE_DIR / "scripts" / "full_68_audit_results.json"
    out_path.write_text(json.dumps({
        "timestamp": datetime.datetime.now().isoformat(),
        "total": len(results),
        "summary": {
            "online": online_count,
            "cloudflare_403": cf_count,
            "restricted_410": restricted_count,
            "offline_or_dns": offline_count,
            "timeout": timeout_count,
            "server_errors": error_count,
        },
        "results": results
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nVýsledky boli uložené do: {out_path}")


if __name__ == "__main__":
    asyncio.run(main())
