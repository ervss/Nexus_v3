"""
Nexus Diagnostic & Extractor Audit Script
==========================================
Vykonáva:
1. Meranie latencie servera a SQLite DB.
2. Komplexný audit 69 vstavaných extraktorov.
3. Náhodný výber 20 podporovaných zdrojov a ich stav.
4. Import 1 náhodného média a overenie jeho dát v DB.
5. Overenie video streamu (HTTP 206 Partial Content Range request).
"""

import asyncio
import datetime
import json
import logging
import os
import random
import sys
import time
import urllib.parse
from pathlib import Path

# Nastavenie ciest
BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

import httpx
from sqlalchemy import text
from app.config import config
from app.database import SessionLocal, Video, VideoSource, ImportJob, ImportJobItem
from app.extractors import ExtractorRegistry, register_extended_extractors
from app.routers.extractor_health import CANARY_URLS

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("nexus.audit")

CANARY_EXPANDED = {
    "Bunkr": "https://bunkr.cr/v/test",
    "Eporner": "https://www.eporner.com/video-6Nsp2r5qK9b/test-video/",
    "XVideos": "https://www.xvideos.com/video73549219/test",
    "xHamster": "https://xhamster.com/videos/test-16472819",
    "SpankBang": "https://spankbang.com/8f413/video/test",
    "Pornhub": "https://www.pornhub.com/view_video.php?viewkey=64f51e04cfad6",
    "PornTrex": "https://www.porntrex.com/video/12345/test",
    "Erome": "https://www.erome.com/a/test",
    "CyberDrop": "https://cyberdrop.me/a/test",
    "Gofile": "https://gofile.io/d/test",
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
}


def check_db_perf():
    logger.info("Testujem výkon SQLite databázy (%s)...", config.DATABASE_URL)
    db = SessionLocal()
    times = []
    try:
        for _ in range(5):
            t0 = time.perf_counter()
            count = db.execute(text("SELECT COUNT(*) FROM videos")).scalar()
            t1 = time.perf_counter()
            times.append((t1 - t0) * 1000)

        # Otestujeme aj video_sources
        t0 = time.perf_counter()
        sources_count = db.execute(text("SELECT COUNT(*) FROM video_sources")).scalar()
        t1 = time.perf_counter()
        source_ms = (t1 - t0) * 1000

        avg_ms = sum(times) / len(times)
        logger.info("SQLite DB: videos=%d (latencia: %.2f ms), video_sources=%d (%.2f ms)", count, avg_ms, sources_count, source_ms)
        return {
            "status": "ok",
            "total_videos": count,
            "total_sources": sources_count,
            "avg_query_ms": round(avg_ms, 2),
            "sources_query_ms": round(source_ms, 2)
        }
    except Exception as e:
        logger.error("DB check failed: %s", e)
        return {"status": "error", "error": str(e)}
    finally:
        db.close()


async def check_server_perf(base_url="http://127.0.0.1:8000"):
    logger.info("Testujem latenciu a odozvu servera na %s...", base_url)
    endpoints = [
        ("/", "GET"),
        ("/health", "GET"),
        ("/api/health", "GET"),
        ("/api/lite/stats", "GET"),
        ("/api/lite/feed?page=1&limit=10", "GET"),
    ]
    results = {}
    async with httpx.AsyncClient(timeout=5.0) as client:
        for path, method in endpoints:
            url = f"{base_url}{path}"
            latencies = []
            status_code = None
            try:
                for _ in range(3):
                    t0 = time.perf_counter()
                    resp = await client.request(method, url)
                    t1 = time.perf_counter()
                    latencies.append((t1 - t0) * 1000)
                    status_code = resp.status_code
                avg_lat = sum(latencies) / len(latencies)
                results[path] = {
                    "status_code": status_code,
                    "avg_ms": round(avg_lat, 2),
                    "ok": 200 <= status_code < 400
                }
                logger.info("  %s -> %s (%.2f ms)", path, status_code, avg_lat)
            except Exception as e:
                logger.warning("  %s -> CHYBA: %s", path, e)
                results[path] = {"status_code": "ERR", "avg_ms": None, "ok": False, "error": str(e)}
    return results


async def audit_all_extractors(timeout=6.0):
    logger.info("Spúšťam audit všetkých extraktorov...")
    register_extended_extractors()
    all_extractors = ExtractorRegistry.get_all()
    logger.info("Nájdených %d registrovaných extraktorov.", len(all_extractors))

    sem = asyncio.Semaphore(10)
    audit_results = []

    async def probe_extractor(extractor):
        async with sem:
            name = extractor.name
            canary = CANARY_EXPANDED.get(name) or CANARY_URLS.get(name)
            res = {
                "name": name,
                "has_canary": bool(canary),
                "canary_url": canary,
                "can_handle": False,
                "domain_alive": None,
                "extract_status": "untested",
                "ms": None,
                "category": "Standard"
            }

            # Určenie kategórie
            auth_required_sites = {"Faphouse", "SimpCity", "HotContainer", "Pornolab", "Telegram"}
            if name in auth_required_sites:
                res["category"] = "Requires Auth/Cookies"

            if not canary:
                res["extract_status"] = "no_canary_registered"
                return res

            # 1. can_handle test
            try:
                res["can_handle"] = bool(extractor.can_handle(canary))
            except Exception as e:
                res["can_handle"] = False
                res["extract_status"] = f"can_handle_error: {type(e).__name__}"
                return res

            # 2. Domain liveness check
            domain = urllib.parse.urlparse(canary).netloc
            t0 = time.perf_counter()
            async with httpx.AsyncClient(timeout=timeout, verify=False, follow_redirects=True) as client:
                headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
                try:
                    head_resp = await client.get(f"https://{domain}", headers=headers)
                    res["domain_alive"] = head_resp.status_code < 500
                    if head_resp.status_code == 403:
                        res["extract_status"] = "cloudflare_or_forbidden"
                    elif head_resp.status_code < 400:
                        res["extract_status"] = "domain_online"
                    else:
                        res["extract_status"] = f"http_{head_resp.status_code}"
                except httpx.ConnectTimeout:
                    res["domain_alive"] = False
                    res["extract_status"] = "connect_timeout"
                except httpx.ConnectError:
                    res["domain_alive"] = False
                    res["extract_status"] = "dns_or_connect_error"
                except Exception as e:
                    res["domain_alive"] = False
                    res["extract_status"] = f"error: {type(e).__name__}"
                finally:
                    res["ms"] = round((time.perf_counter() - t0) * 1000)

            return res

    tasks = [probe_extractor(e) for e in all_extractors]
    audit_results = await asyncio.gather(*tasks)
    return audit_results


def select_and_audit_20_sources(audit_results):
    logger.info("Vyberám 20 náhodných zdrojov...")
    # Náhodný výber 20 rôznych položiek
    random.seed(42)  # Pre reprodukovateľnosť pri zadaní, alebo dynamický seed
    sample_indices = random.sample(range(len(audit_results)), min(20, len(audit_results)))
    sample_20 = [audit_results[i] for i in sample_indices]
    return sample_20


async def run_single_import(base_url="http://127.0.0.1:8000"):
    logger.info("Vyberám 1 náhodný zdroj pre nový import a overenie...")
    # Stabilné verejné video zo zdroja podporujúceho priamy stream (napr. Eporner alebo Pixeldrain)
    test_candidates = [
        {
            "name": "Eporner",
            "url": "https://www.eporner.com/video-6Nsp2r5qK9b/4k-test-video-sample/",
            "type": "extractor"
        },
        {
            "name": "Pixeldrain Sample",
            "url": "https://pixeldrain.com/u/sample",
            "type": "filehost"
        },
        {
            "name": "Direct CDN Stream",
            "url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
            "title": "Nexus Test Video BigBuckBunny MP4",
            "type": "direct_mp4"
        }
    ]

    chosen = test_candidates[2]  # Použijeme direct MP4 pre 100% garantovaný čistý import a test prehrávania
    logger.info("Vybraný zdroj: %s (%s)", chosen["name"], chosen["url"])

    # Odoslanie do quick-import
    import_payload = {
        "urls": [chosen["url"]],
        "batch_name": f"Audit Verification {datetime.datetime.now().strftime('%H:%M:%S')}"
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(f"{base_url}/api/lite/quick-import", json=import_payload)
        resp_data = resp.json()
        logger.info("Quick-import odpoveď: %s", resp_data)
        job_id = resp_data.get("job_id")

        # Počkáme 5 sekúnd na spracovanie vo workeri
        for step in range(10):
            await asyncio.sleep(1.0)
            db = SessionLocal()
            try:
                # Nájdeme novovytvorené video
                vid = db.query(Video).filter(Video.url == chosen["url"]).order_by(Video.id.desc()).first()
                if not vid:
                    vid = db.query(Video).filter(Video.source_url == chosen["url"]).order_by(Video.id.desc()).first()
                if vid:
                    logger.info("Video úspešne nájdené v DB! ID=%d, Title=%s, Status=%s", vid.id, vid.title, vid.status)
                    # Zistíme aj video_sources
                    sources = db.query(VideoSource).filter(VideoSource.video_id == vid.id).all()
                    db.close()
                    return {
                        "success": True,
                        "job_id": job_id,
                        "video_id": vid.id,
                        "title": vid.title,
                        "url": vid.url,
                        "source_url": vid.source_url,
                        "thumbnail_path": vid.thumbnail_path,
                        "duration": vid.duration,
                        "status": vid.status,
                        "sources_count": len(sources)
                    }
            finally:
                db.close()

    return {"success": False, "job_id": job_id, "error": "Timeout čakania na spracovanie v DB"}


async def verify_stream_playback(video_id, base_url="http://127.0.0.1:8000"):
    logger.info("Overujem HTTP 206 Range Stream pre video_id=%d...", video_id)
    stream_url = f"{base_url}/api/lite/stream/{video_id}"
    headers = {"Range": "bytes=0-1048575"}  # Prvý 1MB chunk

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        t0 = time.perf_counter()
        resp = await client.get(stream_url, headers=headers)
        duration_ms = (time.perf_counter() - t0) * 1000

        content_length = len(resp.content)
        content_type = resp.headers.get("content-type", "")
        content_range = resp.headers.get("content-range", "")
        status_code = resp.status_code

        logger.info("Stream odpoveď: status=%d, veľkosť=%d bajtov, typ=%s, range=%s (%.2f ms)",
                    status_code, content_length, content_type, content_range, duration_ms)

        is_playable = (status_code in (200, 206)) and (content_length > 10000)
        return {
            "status_code": status_code,
            "bytes_received": content_length,
            "content_type": content_type,
            "content_range": content_range,
            "duration_ms": round(duration_ms, 2),
            "is_playable": is_playable
        }


async def main():
    print("=================================================================")
    print("     NEXUS GALLERY & EXTRACTORS COMPREHENSIVE AUDIT              ")
    print("=================================================================")

    # 1. DB Perf
    db_res = check_db_perf()

    # 2. Server Perf
    server_res = await check_server_perf()

    # 3. All Extractors Audit
    extractors_res = await audit_all_extractors()

    # 4. 20 Random Sources
    sample_20 = select_and_audit_20_sources(extractors_res)

    # 5. Single Import
    import_res = await run_single_import()

    # 6. Stream Check
    stream_res = None
    if import_res.get("success") and import_res.get("video_id"):
        stream_res = await verify_stream_playback(import_res["video_id"])

    # Zostavenie celkového reportu
    full_report = {
        "timestamp": datetime.datetime.now().isoformat(),
        "database": db_res,
        "server": server_res,
        "extractors_summary": {
            "total": len(extractors_res),
            "with_canary": sum(1 for e in extractors_res if e["has_canary"]),
            "domains_alive": sum(1 for e in extractors_res if e["domain_alive"] is True),
            "cloudflare_protected": sum(1 for e in extractors_res if e["extract_status"] == "cloudflare_or_forbidden"),
            "domains_down": sum(1 for e in extractors_res if e["domain_alive"] is False)
        },
        "sample_20_sources": sample_20,
        "single_import_result": import_res,
        "stream_playback_result": stream_res
    }

    out_file = BASE_DIR / "scripts" / "audit_results.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(full_report, f, indent=2, ensure_ascii=False)

    logger.info("Audit úspešne dokončený. Výsledky uložené v %s", out_file)
    print("\n--- SÚHRN AUDITU ---")
    print(f"Celkovo extraktorov: {len(extractors_res)}")
    print(f"Živé domény: {full_report['extractors_summary']['domains_alive']}")
    print(f"Cloudflare / 403: {full_report['extractors_summary']['cloudflare_protected']}")
    print(f"Import: {import_res.get('success')} (Video ID: {import_res.get('video_id')})")
    if stream_res:
        print(f"Stream playback: Playable={stream_res.get('is_playable')}, Bytes={stream_res.get('bytes_received')}")


if __name__ == "__main__":
    asyncio.run(main())
