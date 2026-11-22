from __future__ import annotations

import asyncio
import time
from typing import Optional

from fastapi import APIRouter, Query

from app.extractors import register_extended_extractors
from app.extractors.circuit_breaker import extractor_circuit_breaker
from app.extractors.registry import ExtractorRegistry

router = APIRouter(tags=["extractor-health"])

# Curated canary URLs per extractor name. These are representative page URLs the
# extractor's can_handle() should match; the probe checks that extract() runs
# without raising and returns something. Sites break weekly, so this is a quick
# "is this extractor still alive" signal, not a correctness test.
#
# Only extractors we can safely poke are listed. Missing ones report probe=None
# (registered but not probed) instead of a misleading failure.
CANARY_URLS = {
    "1Porn": "https://1porn.tv/videos/test-video-123",
    "69Tubed": "https://69tubed.com/videos/12345/test/",
    "8KPorner": "https://8kporner.com/video/12345/test",
    "Archivebate": "https://archivebate.com/watch/12345",
    "BaddieHub": "https://baddiehub.com/post/12345",
    "Beeg": "https://beeg.com/12345678",
    "BigPorn": "https://bigporn.com/video/12345",
    "Bunkr": "https://bunkr.cr/v/test",
    "CamWhoresBay": "https://camwhoresbay.com/videos/12345/test/",
    "Camwhores": "https://www.camwhores.tv/videos/12345/test/",
    "Civitai": "https://civitai.com/images/12345",
    "Coomerfans": "https://coomerfans.com/post/12345",
    "CyberDrop": "https://cyberdrop.me/a/test",
    "CyberFile": "https://cyberfile.me/file/test",
    "CyberLeaks": "https://cyberleaks.top/watch/12345",
    "Eporner": "https://www.eporner.com/video-6Nsp2r5qK9b/test/",
    "Erome": "https://www.erome.com/a/test",
    "FNXTube": "https://fnxtube.com/video/12345",
    "Faphouse": "https://faphouse.com/videos/test",
    "Filester": "https://filester.me/d/test",
    "Fpo": "https://fpo.xxx/video/12345",
    "FreePornFun": "https://freepornfun.com/video/12345",
    "Freeuseporn": "https://freeuseporn.com/post/12345",
    "GoFile": "https://gofile.io/d/test",
    "Gofile": "https://gofile.io/d/test",
    "HQPorner": "https://hqporner.com/hdporn/12345-test.html",
    "HornySimp": "https://hornysimp.com/video/12345",
    "InternetChicks": "https://internetchicks.com/post/12345",
    "KrakenFiles": "https://krakenfiles.com/view/12345/file.html",
    "LeakPorner": "https://leakporner.com/video/12345",
    "Leakedzone": "https://leakedzone.com/post/12345",
    "LuluStream": "https://luluvdo.com/e/12345",
    "MyPornerLeak": "https://mypornerleak.com/video/12345",
    "NSFW247": "https://nsfw247.to/video/12345",
    "NoodleMagazine": "https://noodlemagazine.com/watch/-123456_789",
    "PimpBunny": "https://pimpbunny.com/video/12345",
    "Pixeldrain": "https://pixeldrain.com/u/test",
    "PornFans": "https://pornfans.net/post/12345",
    "PornHD4K": "https://pornhd4k.net/video/12345",
    "PornHat": "https://pornhat.com/video/12345",
    "PornHoarder": "https://pornhoarder.tv/video/12345",
    "PornOne": "https://pornone.com/video/12345",
    "PornTrex": "https://www.porntrex.com/video/12345/test",
    "Porneec": "https://porneec.com/video/12345",
    "Pornhub": "https://www.pornhub.com/view_video.php?viewkey=64f51e04cfad6",
    "Pornonahobka": "https://pornonahobka.icu/video/12345",
    "Porntrex": "https://www.porntrex.com/video/12345/test",
    "Recurbate": "https://recurbate.com/watch/12345",
    "RedGifs": "https://www.redgifs.com/watch/test",
    "RedTube": "https://www.redtube.com/12345",
    "Shareanynudes": "https://shareanynudes.com/post/12345",
    "SlutVids": "https://slutvids.net.lv/watch/12345",
    "SpankBang": "https://spankbang.com/8f413/video/test",
    "SxyPrn": "https://www.sxyprn.com/post/test.html",
    "ThisVid": "https://thisvid.com/videos/test/",
    "Thothub": "https://thothub.to/video/12345",
    "ThotsTv": "https://thots.tv/watch/12345",
    "Turbo": "https://turbo.cr/v/test",
    "VK": "https://vk.com/video-123456_789",
    "Vidara": "https://vidara.so/v/12345",
    "WhoresHub": "https://www.whoreshub.com/video/12345",
    "XGroovy": "https://xgroovy.com/video/12345",
    "XNXX": "https://www.xnxx.com/video-12345/test",
    "XVideos": "https://www.xvideos.com/video73549219/test",
    "XXBrits": "https://xxbrits.com/video/12345",
    "Xfree": "https://xfree.com/video/12345",
    "Xxxdbx": "https://xxxdbx.com/post/12345",
    "iXXX": "https://ixxx.com/video/12345",
    "vTube": "https://vtbe.to/video/12345",
    "xHamster": "https://xhamster.com/videos/test-16472819",
}


def _list_extractors():
    # Keep health reporting aligned with the Lite runtime, which registers the
    # extended extractor set during startup.
    register_extended_extractors()
    return ExtractorRegistry.get_all()


async def _probe_one(ex, url: str, timeout: float):
    """Run a single extractor's extract() under a timeout, never raising."""
    started = time.perf_counter()
    entry = {
        "name": ex.name,
        "registered": True,
        "canary_url": url,
        "can_handle": False,
        "probe": None,
        "ms": None,
    }
    try:
        entry["can_handle"] = bool(ex.can_handle(url))
    except Exception as e:  # noqa: BLE001 - defensive, report don't crash
        entry["probe"] = f"can_handle error: {type(e).__name__}"
        return entry

    if not entry["can_handle"]:
        entry["probe"] = "can_handle=false"
        return entry

    try:
        result = await asyncio.wait_for(ex.extract(url), timeout=timeout)
        entry["probe"] = "ok" if result else "empty"
    except asyncio.TimeoutError:
        entry["probe"] = "timeout"
    except Exception as e:  # noqa: BLE001
        entry["probe"] = f"error: {type(e).__name__}"
    finally:
        entry["ms"] = round((time.perf_counter() - started) * 1000)
    return entry


@router.get("/api/extractors/health")
@router.get("/api/v1/extractors/health")
async def extractors_health(
    probe: bool = Query(False, description="Run live canary probes (slower)"),
    timeout: float = Query(12.0, ge=2.0, le=30.0),
    only: Optional[str] = Query(None, description="Comma-separated extractor names to probe"),
):
    """Report every registered extractor and, optionally, a live liveness probe.

    - probe=false (default): instant list of what's registered. Reveals gaps
      (e.g. an extractor file that exists but was never added to init_registry).
    - probe=true: fires a canary request per extractor that has a canary URL,
      each under its own timeout so one dead site can't stall the report.
    """
    extractors = _list_extractors()
    only_set = {s.strip() for s in only.split(",")} if only else None

    if not probe:
        return {
            "count": len(extractors),
            "probed": False,
            "extractors": [
                {"name": ex.name, "registered": True, "has_canary": ex.name in CANARY_URLS}
                for ex in extractors
            ],
        }

    tasks = []
    passthrough = []
    for ex in extractors:
        if only_set is not None and ex.name not in only_set:
            continue
        url = CANARY_URLS.get(ex.name)
        if url is None:
            passthrough.append(
                {"name": ex.name, "registered": True, "canary_url": None, "probe": None, "ms": None}
            )
            continue
        tasks.append(_probe_one(ex, url, timeout))

    probed = await asyncio.gather(*tasks) if tasks else []
    results = sorted(probed + passthrough, key=lambda e: e["name"].lower())

    summary = {"ok": 0, "empty": 0, "error": 0, "timeout": 0, "unprobed": 0}
    for r in results:
        p = r.get("probe")
        if p == "ok":
            summary["ok"] += 1
        elif p == "empty":
            summary["empty"] += 1
        elif p == "timeout":
            summary["timeout"] += 1
        elif p is None:
            summary["unprobed"] += 1
        else:
            summary["error"] += 1

    return {
        "count": len(results),
        "probed": True,
        "summary": summary,
        "extractors": results,
        "circuit_breaker": extractor_circuit_breaker.snapshot(),
    }


@router.get("/api/extractors/circuit-breaker")
@router.get("/api/v1/extractors/circuit-breaker")
async def get_circuit_breaker_state():
    """Return current per-domain circuit breaker state for extractors."""
    entries = extractor_circuit_breaker.snapshot()
    open_count = sum(1 for e in entries if e["state"] == "open")
    return {"open_count": open_count, "domains": entries}


@router.post("/api/extractors/circuit-breaker/reset")
@router.post("/api/v1/extractors/circuit-breaker/reset")
async def reset_circuit_breaker_state(domain: Optional[str] = Query(None)):
    """Reset one domain or all domains in the extractor circuit breaker."""
    cleared = extractor_circuit_breaker.reset(domain)
    return {"cleared": cleared, "domain": domain or "*"}
