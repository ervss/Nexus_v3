"""
Nexus Hub API — one router for every source hub.

    GET  /hub/sources                list registered hubs
    GET  /hub/all                    every hub at once, one JSON body
    GET  /hub/all/stream             every hub at once, NDJSON as each lands
    GET  /hub/{source}/search        keyword search (+ sort, page, filters)
    GET  /hub/{source}/feed          browse (sort, category, page)
    GET  /hub/{source}/categories    category chips
    POST /hub/{source}/enrich        heavy quality/size pass (meta-poor sources)
    GET  /hub/{source}/resolve       JIT watch URL -> playable stream
    GET  /hub/{source}/related       related tiles for a watch URL
    GET  /hub/{source}/media         referer-bypassing thumb/preview proxy

Every path is generic over {source}; the adapter (app/hubs/*) does the work.
Duration filtering is intentionally NOT here — tiles carry duration_sec, so the
frontend filters instantly and exactly without a round-trip.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from ..hubs import registry
from ..cookie_jar import build_cookie_header
#: Module-level so it can be a Query() default; the heavier prime helpers stay
#: function-local imports to keep router import time down.
from ..hubs.prime import DEFAULT_RELEVANCE

logger = logging.getLogger(__name__)
router = APIRouter(tags=["hub"])

_UA_STREAM = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def _adapter(source: str):
    registry.init_hubs()
    a = registry.get(source)
    if a is None:
        raise HTTPException(404, detail=f"Unknown hub source '{source}'")
    return a


@router.get("/hub/sources")
async def hub_sources():
    registry.init_hubs()
    return {"sources": registry.all_sources()}


@router.get("/hub/health")
async def hub_health(
    sources: str = Query(""),
    timeout: float = Query(12.0, ge=2.0, le=30.0),
):
    """Fast smoke-check across Fusion Hub adapters (browse page 1)."""
    registry.init_hubs()
    all_meta = registry.all_sources()
    wanted = {s.strip().lower() for s in (sources or "").split(",") if s.strip()}
    targets = [m for m in all_meta if not wanted or m["source"] in wanted]

    sem = asyncio.Semaphore(6)

    async def _probe(meta: dict) -> dict:
        src = meta["source"]
        a = registry.get(src)
        t0 = time.monotonic()
        if a is None:
            return {"source": src, "label": meta.get("label", src), "status": "error", "count": 0, "took_ms": 0, "error": "not registered"}
        async with sem:
            try:
                page = await asyncio.wait_for(a.browse(page=1), timeout=timeout)
                items = page.items or []
                took_ms = int((time.monotonic() - t0) * 1000)
                return {
                    "source": src,
                    "label": a.label or src,
                    "status": "ok" if items else "empty",
                    "count": len(items),
                    "took_ms": took_ms,
                    "error": None if items else "0 items returned",
                }
            except Exception as exc:  # noqa: BLE001
                return {
                    "source": src,
                    "label": a.label or src,
                    "status": "error",
                    "count": 0,
                    "took_ms": int((time.monotonic() - t0) * 1000),
                    "error": str(exc)[:200],
                }

    results = await asyncio.gather(*(_probe(m) for m in targets))
    ok_count = sum(1 for r in results if r["status"] == "ok")
    return {
        "status": "ok" if ok_count == len(results) else "degraded",
        "ok_count": ok_count,
        "total": len(results),
        "results": results,
    }


@router.get("/hub/presets")
async def hub_presets():
    """The curated tag-mix presets the UI renders as one-click chips."""
    from ..hubs.presets import all_presets

    return {"presets": all_presets()}


@router.get("/hub/preset/stream")
async def hub_preset_stream(
    preset: str = Query(..., min_length=1),
    sources: str = Query(""),
    min_height: int = Query(1080, ge=0, le=4320),
    per_source: int = Query(8, ge=1, le=50),
    pages: int = Query(1, ge=1, le=3),
    allow_unverified: bool = False,
    deadline: float = Query(90.0, ge=5.0, le=180.0),
):
    """Run a preset as a streamed Prime Cut.

    Thin wrapper: the preset only supplies the query and its own relevance bar,
    everything else is the Prime Cut the user could have typed by hand. Declared
    before /hub/{source}/… so "preset" is not swallowed as a source id.
    """
    from ..hubs.presets import get_preset
    from ..hubs.prime import prime_cut_iter

    row = get_preset(preset)
    if row is None:
        raise HTTPException(404, detail=f"Unknown preset '{preset}'")

    wanted = [s.strip().lower() for s in (sources or "").split(",") if s.strip()]

    async def _gen():
        try:
            yield json.dumps({"type": "preset", "preset": row["id"],
                              "label": row["label"], "query": row["query"],
                              "tags": list(row["tags"])}, ensure_ascii=False) + "\n"
            async for event in prime_cut_iter(
                row["query"], sources=wanted or None, min_height=min_height,
                per_source=per_source, pages=pages,
                allow_unverified=allow_unverified, deadline=deadline,
                relevance_min=row["relevance_min"],
            ):
                yield json.dumps(event, ensure_ascii=False) + "\n"
        except Exception as exc:  # noqa: BLE001
            logger.warning("[Hub:preset/stream] %s failed: %s", preset, exc)
            yield json.dumps({"type": "error", "detail": str(exc)}) + "\n"

    return StreamingResponse(
        _gen(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/hub/prime")
async def hub_prime(
    q: str = Query("", min_length=0),
    sources: str = Query("", description="CSV of source ids; empty = every hub"),
    min_height: int = Query(1080, ge=0, le=4320),
    per_source: int = Query(10, ge=1, le=50),
    pages: int = Query(1, ge=1, le=3),
    allow_unverified: bool = False,
    deadline: float = Query(45.0, ge=5.0, le=120.0),
    relevance_min: float = Query(DEFAULT_RELEVANCE, ge=0.0, le=1.0),
):
    """Prime Cut — one keyword, every hub, `per_source` best tiles each.

    Combines each source's newest and most-relevant passes, then gates on real
    quality (verifying via enrich where the listing cannot be trusted). Declared
    before /hub/{source}/… so "prime" is not swallowed as a source id.
    """
    from ..hubs.prime import prime_cut

    wanted = [s.strip().lower() for s in (sources or "").split(",") if s.strip()]
    try:
        return await prime_cut(
            q.strip(), sources=wanted or None, min_height=min_height,
            per_source=per_source, pages=pages,
            allow_unverified=allow_unverified, deadline=deadline,
            relevance_min=relevance_min,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[Hub:prime] failed: %s", exc)
        raise HTTPException(502, detail=f"Prime Cut failed: {exc}")


@router.get("/hub/prime/stream")
async def hub_prime_stream(
    q: str = Query("", min_length=0),
    sources: str = Query(""),
    min_height: int = Query(1080, ge=0, le=4320),
    per_source: int = Query(10, ge=1, le=50),
    pages: int = Query(1, ge=1, le=3),
    allow_unverified: bool = False,
    deadline: float = Query(45.0, ge=5.0, le=120.0),
    relevance_min: float = Query(DEFAULT_RELEVANCE, ge=0.0, le=1.0),
):
    """Prime Cut, streamed one source at a time so the UI can show live progress."""
    from ..hubs.prime import prime_cut_iter

    wanted = [s.strip().lower() for s in (sources or "").split(",") if s.strip()]

    async def _gen():
        try:
            async for event in prime_cut_iter(
                q.strip(), sources=wanted or None, min_height=min_height,
                per_source=per_source, pages=pages,
                allow_unverified=allow_unverified, deadline=deadline,
                relevance_min=relevance_min,
            ):
                yield json.dumps(event, ensure_ascii=False) + "\n"
        except Exception as exc:  # noqa: BLE001
            logger.warning("[Hub:prime/stream] failed: %s", exc)
            yield json.dumps({"type": "error", "detail": str(exc)}) + "\n"

    return StreamingResponse(
        _gen(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ══════════════════════════════════════════════════════════════════════════════
# ALL — every source, one query, server-side fan-out.
#
# The frontend used to run its own Promise.allSettled over every source, which
# means the whole grid waits for the slowest adapter: TNAFlix runs on sync
# `requests` with a 20s timeout, so eleven sources that mostly answer in two
# seconds still read as a twenty-second stall. Doing the fan-out here lets each
# source's tiles go out the moment they land, and lets a wall-clock budget
# cancel the stragglers instead of letting them hold the page hostage.
# ══════════════════════════════════════════════════════════════════════════════


def _tile_dict(item: Any) -> dict:
    """A mutable dict for a tile that may arrive as a Tile dataclass.

    Page.items is typed list[dict] but several adapters hand back Tile objects.
    Copying rather than using the tile in place matters here too: we stamp
    `source` and `relevance` onto it, and adapters cache their parsed pages.
    """
    if isinstance(item, dict):
        return dict(item)
    to_dict = getattr(item, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    return dict(getattr(item, "__dict__", {}) or {})


def _relevance_bar(value: Any, default: float) -> float:
    """The gate's threshold as a real float, whatever the caller handed us.

    FastAPI resolves a Query() default per request, but these endpoint functions
    are also called directly — from tests and from other server-side code — and
    there the parameter is still the Query object. Coercing at the one place
    that compares against it beats an isinstance check in every endpoint.
    """
    try:
        return min(1.0, max(0.0, float(value)))
    except (TypeError, ValueError):
        return default


def _score_and_gate(items: list[dict], q: str,
                    relevance_min: Any) -> tuple[list[dict], bool, float]:
    """Score every tile, sort best-first, keep what clears the bar.

    Returns (kept, fallback, bar) — the bar comes back so the response can echo
    the threshold that was actually applied rather than the one that was asked
    for.

    The fallback exists because a hard gate has a uniquely bad failure mode: a
    source fetches 34 tiles, none score high enough, and the UI shows an empty
    grid that is indistinguishable from a dead adapter. So when the gate would
    empty a non-empty result we keep its three best tiles and flag it.

    Those three carry `below_threshold`, and that flag is the whole point: an
    ALL run over eleven sources for a name only one of them actually hosts
    would otherwise put thirty near-random tiles next to the two real hits, and
    a grid that answers a specific search with mostly noise is worse than one
    that answers it with two. The client keeps them out of the grid until the
    user asks for them, and reports the count either way. The sort is stable, so
    tiles that tie on score keep the order the source itself chose.
    """
    from ..hubs.prime import DEFAULT_RELEVANCE, relevance_score

    bar = _relevance_bar(relevance_min, DEFAULT_RELEVANCE)
    for item in items:
        item["relevance"] = round(relevance_score(item, q), 3)
    ranked = sorted(items, key=lambda it: it["relevance"], reverse=True)
    kept = [it for it in ranked if it["relevance"] >= bar]
    if not kept and ranked:
        weak = ranked[:3]
        for item in weak:
            item["below_threshold"] = True
        return weak, True, bar
    return kept, False, bar


async def _all_one_source(source: str, *, q: str, sort: str, page: int, per_source: int,
                          strict: bool, relevance_min: float) -> dict:
    """One source's contribution to an ALL run, as the NDJSON `source` line.

    Never raises: a source that 502s, times out or parses to nothing reports its
    own error and the rest of the stream carries on. `error` is always present
    (empty when fine) so the frontend never has to distinguish missing from OK.
    """
    started = time.monotonic()
    a = registry.get(source)
    if a is None:
        return {"type": "source", "source": source, "label": source, "raw": 0,
                "shown": 0, "took_ms": 0, "error": "unknown source", "items": []}
    label = getattr(a, "label", source) or source
    try:
        pg = await (a.search(q, sort=sort, page=page) if q
                    else a.browse(sort=sort, page=page))
        items = [_tile_dict(i) for i in (pg.items or [])]
    except Exception as exc:  # noqa: BLE001 — one dead source must not end the stream
        logger.info("[Hub:all] %s failed: %s", source, exc)
        return {"type": "source", "source": source, "label": label, "raw": 0,
                "shown": 0, "took_ms": int((time.monotonic() - started) * 1000),
                "error": str(exc), "items": []}

    raw = len(items)
    fallback = False
    if strict and q:
        items, fallback, _bar = _score_and_gate(items, q, relevance_min)
    # Cap AFTER scoring so the cap keeps the best tiles, not the first ones the
    # source happened to print.
    items = items[:per_source]
    for item in items:
        item["source"] = source
    row = {"type": "source", "source": source, "label": label, "raw": raw,
           "shown": len(items), "took_ms": int((time.monotonic() - started) * 1000),
           "error": "", "items": items}
    if fallback:
        row["relevance_fallback"] = True
    return row


#: Sources kept fully registered and browsable on their own tab, but left out
#: of the DEFAULT ALL fan-out. Every ALL search pays for every included source
#: on every request — a slow or low-signal source is never "free" just because
#: it usually returns little, it is a fixed latency + enrich-bandwidth tax on
#: every single search. TNAFlix and RedTube earned that exclusion on measured
#: grounds, not merely "gives few results":
#:   TNAFlix  — every live probe this session returned the same category of
#:              generic content PornTrex/WhoresHub/Camwhores already cover, at
#:              the same volume as any other source (not rare, just redundant),
#:              on the slowest/least reliable code path of the eleven adapters.
#:   RedTube  — same Aylo/MindGeek content network as the PornHub adapter,
#:              capped lower and with the thinnest listing (no tags/date/views
#:              — see RedTubeHub.listing_fields), so once PornHub is registered
#:              it is close to pure overlap with strictly worse metadata.
#: NoodleMagazine and XXBrits stayed IN by contrast: both have a genuinely
#: different catalogue (VK-reuploaded amateur content; British-specific
#: content respectively) rather than a redundant copy of a bigger source.
#: An explicit `sources=` request (or opening the tab directly) still reaches
#: either of these two — nothing about them was removed, only the default.
_ALL_DEFAULT_EXCLUDE = frozenset({"tnaflix", "redtube"})


async def _all_iter(*, q: str, sort: str, page: int, per_source: int, strict: bool,
                    relevance_min: float, deadline: float, sources: str):
    """Yield one `source` event per hub as it finishes, then a `done` summary.

    Both /hub/all/stream and /hub/all drain this, so the two cannot drift into
    reporting different things for the same request.
    """
    registry.init_hubs()
    wanted = [s.strip().lower() for s in (sources or "").split(",") if s.strip()]
    default_roster = [r["source"] for r in registry.all_sources()
                      if r["source"] not in _ALL_DEFAULT_EXCLUDE]
    wanted = [s for s in (wanted or default_roster) if registry.get(s) is not None]
    started = time.monotonic()
    ends_at = started + deadline
    total = 0

    tasks = {
        asyncio.create_task(_all_one_source(
            src, q=q, sort=sort, page=page, per_source=per_source,
            strict=strict, relevance_min=relevance_min)): src
        for src in wanted
    }
    pending = set(tasks)
    try:
        while pending:
            remaining = ends_at - time.monotonic()
            if remaining <= 0:
                break
            done, pending = await asyncio.wait(
                pending, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                break
            for task in done:
                row = task.result()
                total += len(row.get("items") or [])
                yield row
        # Whatever is still running when the budget expires is cancelled, not
        # merely abandoned: an orphaned sync-requests call would keep a thread
        # busy long after the client stopped listening.
        for task in pending:
            task.cancel()
        for task in pending:
            yield {"type": "source", "source": tasks[task],
                   "label": getattr(registry.get(tasks[task]), "label", tasks[task]),
                   "raw": 0, "shown": 0,
                   "took_ms": int((time.monotonic() - started) * 1000),
                   "error": "timeout", "items": []}
        yield {"type": "done", "took_ms": int((time.monotonic() - started) * 1000),
               "total": total, "sources": len(wanted)}
    finally:
        # Covers the client disconnecting mid-stream, which closes the generator
        # without ever reaching the cancellation above.
        for task in tasks:
            if not task.done():
                task.cancel()


@router.get("/hub/all/stream")
async def hub_all_stream(
    q: str = Query("", min_length=0),
    sort: str = "recent",
    page: int = 1,
    per_source: int = Query(12, ge=1, le=50),
    strict_relevance: bool = True,
    relevance_min: float = Query(0.45, ge=0.0, le=1.0),
    deadline: float = Query(8.0, ge=2.0, le=60.0),
    sources: str = Query("", description="CSV of source ids; empty = every hub"),
):
    """Every hub, streamed source-by-source as NDJSON.

    Declared before /hub/{source}/… for the same reason as /hub/prime: otherwise
    "all" is matched as a source id and 404s.
    """
    async def _gen():
        try:
            async for event in _all_iter(
                q=q.strip(), sort=sort, page=page, per_source=per_source,
                strict=strict_relevance, relevance_min=relevance_min,
                deadline=deadline, sources=sources,
            ):
                yield json.dumps(event, ensure_ascii=False, default=str) + "\n"
        except Exception as exc:  # noqa: BLE001
            logger.warning("[Hub:all/stream] failed: %s", exc)
            yield json.dumps({"type": "error", "detail": str(exc)}) + "\n"

    return StreamingResponse(
        _gen(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/hub/all")
async def hub_all(
    q: str = Query("", min_length=0),
    sort: str = "recent",
    page: int = 1,
    per_source: int = Query(12, ge=1, le=50),
    strict_relevance: bool = True,
    relevance_min: float = Query(0.45, ge=0.0, le=1.0),
    deadline: float = Query(8.0, ge=2.0, le=60.0),
    sources: str = Query(""),
):
    """The same fan-out drained into one JSON body.

    Kept for clients that cannot read a stream. Items stay in arrival order —
    exactly what the stream would have appended — so switching between the two
    paths never reorders the grid. `diagnostics` is the per-source line minus
    its tiles, which is where a timeout or a dead adapter stays visible.
    """
    items: list[dict] = []
    diagnostics: list[dict] = []
    took_ms = 0
    async for event in _all_iter(
        q=q.strip(), sort=sort, page=page, per_source=per_source,
        strict=strict_relevance, relevance_min=relevance_min,
        deadline=deadline, sources=sources,
    ):
        if event.get("type") == "source":
            items.extend(event.get("items") or [])
            diagnostics.append({k: v for k, v in event.items() if k != "items"})
        elif event.get("type") == "done":
            took_ms = event.get("took_ms", 0)
    return {"items": items, "diagnostics": diagnostics, "took_ms": took_ms,
            "total": len(items), "sources": len(diagnostics)}


# ══════════════════════════════════════════════════════════════════════════════
# V2 "what's new" — the topics you actually care about, across every source, in
# one grid. /hub/all answers "search X everywhere"; follows answer "did MY
# subscriptions move". Neither answers the question you open the hub with —
# "show me new stuff I'd like" — without first picking a source, a query or a
# subscription. This runs your standing topics as the query and merges the lot.
# ══════════════════════════════════════════════════════════════════════════════

#: Same standing interests the Forum V2 feed labels by, so a topic means the
#: same thing on both pages. Each is the query actually sent to the sources —
#: hub search engines match phrases, not the hyphenated tag slugs a forum uses.
#:
#: ONE query per topic, deliberately. Synonyms ("deepthroat" + "sloppy blowjob"
#: + "face fuck") multiply requests to the SAME host, and hosts queue per-IP:
#: measured live, eight hits on one domain took 3.4s where eight hits spread
#: over eight domains took 0.54s — the extra queries cost wall-clock without
#: buying much, and Bunkr started answering 503 under six topics. The site's
#: own search already stems and expands, so the second synonym mostly returns
#: what the first did.
HUB_TOPICS: dict[str, list[str]] = {
    "deepthroat": ["deepthroat"],
    "fake tits": ["big tits"],
    "bimbo": ["bimbo"],
    "b/g": ["sextape"],
    "anal": ["anal"],
    "4k": ["4k"],
}

#: Hosts serialize concurrent requests from one IP, so firing every topic at a
#: source at once just builds a queue on their side (and trips rate limits).
#: One in flight per source keeps each site's own pipeline clear while
#: DIFFERENT sources still run fully in parallel — which is where the real
#: speed is: 21 sources hit once each finish together, not one after another.
_HOST_GATES: dict[str, asyncio.Semaphore] = {}

#: Per-source ceiling for ONE topic's search, so a slow site can't own the tail
#: of the run. Measured live: every other source answers a topic in well under
#: 2s, while Bunkr needs ~15s per query — serialized behind its own gate that
#: turned six topics into a 49s tail on an otherwise-21s feed. Cutting it off
#: costs Bunkr's later topics, not the feed; it still contributes whatever it
#: returns in time, and the grid is complete for everyone else far sooner.
_SOURCE_QUERY_TIMEOUT: dict[str, float] = {"bunkr": 8.0}
_DEFAULT_QUERY_TIMEOUT = 25.0

#: Sources slow enough that running every topic through them serializes into
#: the run's tail. They get ONE topic per feed (the first requested) instead of
#: all six: measured live, Bunkr alone stretched a 9s feed to 23s because its
#: ~15s-per-query cost is paid once per topic behind its own gate. Everything
#: else still queries it normally — this only caps the standing-topics fan-out.
_SLOW_SOURCES = frozenset({"bunkr"})


def _host_gate(source: str) -> asyncio.Semaphore:
    gate = _HOST_GATES.get(source)
    if gate is None:
        gate = _HOST_GATES[source] = asyncio.Semaphore(1)
    return gate


def _query_timeout(source: str) -> float:
    return _SOURCE_QUERY_TIMEOUT.get(source, _DEFAULT_QUERY_TIMEOUT)


@router.get("/hub/v2/feed")
async def hub_v2_feed(
    topics: str = Query("", description="CSV of topic names; empty = all of them"),
    per_source: int = Query(6, ge=1, le=20),
    deadline: float = Query(20.0, ge=3.0, le=90.0),
    sources: str = Query("", description="CSV of source ids; empty = the ALL roster"),
    relevance_min: float = Query(0.45, ge=0.0, le=1.0),
):
    """Newest tiles for every standing topic, fanned out over every source.

    Cost is the reason this is one endpoint and not N client calls: it is
    (topics x sources) live fetches, so it shares a single deadline across the
    whole run and takes whatever has landed when time is up — the same
    partial-results-beat-a-timeout rule the rest of the hub follows.
    """
    registry.init_hubs()
    wanted_topics = [t.strip().lower() for t in (topics or "").split(",") if t.strip()]
    picked = {name: qs for name, qs in HUB_TOPICS.items()
              if not wanted_topics or name in wanted_topics}
    if not picked:
        raise HTTPException(400, detail=f"Unknown topic(s). Known: {', '.join(HUB_TOPICS)}")

    roster = [s.strip().lower() for s in (sources or "").split(",") if s.strip()]
    if not roster:
        roster = [r["source"] for r in registry.all_sources()
                  if r["source"] not in _ALL_DEFAULT_EXCLUDE]
    roster = [s for s in roster if registry.get(s) is not None]

    started = time.monotonic()

    async def _gated(source: str, query: str) -> dict:
        # See _host_gate: one request per source at a time, sources in parallel.
        async with _host_gate(source):
            try:
                return await asyncio.wait_for(
                    _all_one_source(source, q=query, sort="recent", page=1,
                                    per_source=per_source, strict=True,
                                    relevance_min=relevance_min),
                    timeout=_query_timeout(source))
            except asyncio.TimeoutError:
                return {"type": "source", "source": source, "items": [],
                        "error": f"timeout >{_query_timeout(source):.0f}s"}

    jobs: list[tuple[str, str, Any]] = []
    for idx, (topic, queries) in enumerate(picked.items()):
        for query in queries:
            for source in roster:
                # Slow sources answer the first topic only; see _SLOW_SOURCES.
                if idx > 0 and source in _SLOW_SOURCES:
                    continue
                jobs.append((topic, query,
                             asyncio.ensure_future(_gated(source, query))))

    try:
        await asyncio.wait([j[2] for j in jobs], timeout=deadline)
    finally:
        for _, _, task in jobs:
            if not task.done():
                task.cancel()

    # One tile can answer several topics (a 4K anal clip is both). Merge on URL
    # and collect the labels instead of emitting the same card once per topic.
    by_url: dict[str, dict] = {}
    topic_counts: dict[str, int] = {name: 0 for name in picked}
    per_source_counts: dict[str, int] = {}
    errors: list[dict] = []
    for topic, _query, task in jobs:
        if not task.done() or task.cancelled():
            continue
        try:
            row = task.result()
        except Exception:  # noqa: BLE001 — a dead source must not sink the feed
            continue
        if row.get("error"):
            errors.append({"source": row.get("source"), "error": row.get("error")})
        for item in row.get("items") or []:
            url = item.get("url")
            if not url:
                continue
            existing = by_url.get(url)
            if existing is None:
                item = dict(item)
                item["topics"] = [topic]
                item["source"] = item.get("source") or row.get("source")
                by_url[url] = item
                topic_counts[topic] += 1
                src = item.get("source") or "?"
                per_source_counts[src] = per_source_counts.get(src, 0) + 1
            elif topic not in existing["topics"]:
                existing["topics"].append(topic)
                topic_counts[topic] += 1

    items = list(by_url.values())
    # Sources are asked for their "recent" listing, but few expose a real date,
    # so ordering is by how well the tile answers its topic and then by the
    # source's own listing order — not a date we'd be inventing.
    items.sort(key=lambda it: float(it.get("relevance") or 0), reverse=True)

    return {
        "items": items,
        "topics": topic_counts,
        "sources": per_source_counts,
        "errors": errors,
        "total": len(items),
        "took_ms": int((time.monotonic() - started) * 1000),
    }


@router.get("/hub/v2/stream")
async def hub_v2_stream(
    topics: str = Query("", description="CSV of topic names; empty = all of them"),
    per_source: int = Query(6, ge=1, le=20),
    deadline: float = Query(35.0, ge=3.0, le=120.0),
    sources: str = Query("", description="CSV of source ids; empty = the ALL roster"),
    relevance_min: float = Query(0.45, ge=0.0, le=1.0),
):
    """The same feed, but each source's tiles are emitted the moment they land.

    Waiting for the whole fan-out means every card waits for the slowest site,
    so the grid sat empty for ~29s even though the first source answered in
    ~0.5s. Streaming turns that into "cards start appearing immediately" — the
    total is unchanged, but the time to something-on-screen collapses, which is
    the number that actually matters when you are browsing.
    """
    registry.init_hubs()
    wanted_topics = [t.strip().lower() for t in (topics or "").split(",") if t.strip()]
    picked = {name: qs for name, qs in HUB_TOPICS.items()
              if not wanted_topics or name in wanted_topics}
    if not picked:
        raise HTTPException(400, detail=f"Unknown topic(s). Known: {', '.join(HUB_TOPICS)}")

    roster = [s.strip().lower() for s in (sources or "").split(",") if s.strip()]
    if not roster:
        roster = [r["source"] for r in registry.all_sources()
                  if r["source"] not in _ALL_DEFAULT_EXCLUDE]
    roster = [s for s in roster if registry.get(s) is not None]

    async def _job(source: str, topic: str, query: str) -> dict:
        # One request per source at a time; different sources stay parallel.
        async with _host_gate(source):
            try:
                row = await asyncio.wait_for(
                    _all_one_source(source, q=query, sort="recent", page=1,
                                    per_source=per_source, strict=True,
                                    relevance_min=relevance_min),
                    timeout=_query_timeout(source))
            except asyncio.TimeoutError:
                row = {"type": "source", "source": source, "items": [],
                       "error": f"timeout >{_query_timeout(source):.0f}s"}
        row["_topic"] = topic
        return row

    async def _gen():
        started = time.monotonic()
        ends_at = started + deadline
        seen_urls: set[str] = set()
        topic_counts: dict[str, int] = {name: 0 for name in picked}
        sent = 0

        tasks: dict[Any, tuple[str, str]] = {}
        for idx, (topic, queries) in enumerate(picked.items()):
            for query in queries:
                for source in roster:
                    # Slow sources answer the first topic only; see _SLOW_SOURCES.
                    if idx > 0 and source in _SLOW_SOURCES:
                        continue
                    task = asyncio.ensure_future(_job(source, topic, query))
                    tasks[task] = (source, topic)

        yield json.dumps({"type": "start", "sources": len(roster),
                          "topics": list(picked), "jobs": len(tasks)}) + "\n"
        pending = set(tasks)
        try:
            while pending:
                remaining = ends_at - time.monotonic()
                if remaining <= 0:
                    break
                done, pending = await asyncio.wait(
                    pending, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
                if not done:
                    break
                for task in done:
                    source, topic = tasks[task]
                    try:
                        row = task.result()
                    except Exception as exc:  # noqa: BLE001 — one bad source, not the run
                        yield json.dumps({"type": "source", "source": source,
                                          "topic": topic, "error": str(exc)[:200],
                                          "items": []}, ensure_ascii=False) + "\n"
                        continue
                    fresh = []
                    for item in row.get("items") or []:
                        url = item.get("url")
                        if not url or url in seen_urls:
                            continue
                        seen_urls.add(url)
                        item = dict(item)
                        item["topics"] = [topic]
                        item["source"] = item.get("source") or source
                        fresh.append(item)
                    topic_counts[topic] = topic_counts.get(topic, 0) + len(fresh)
                    sent += len(fresh)
                    yield json.dumps({"type": "source", "source": source, "topic": topic,
                                      "error": row.get("error") or "", "items": fresh,
                                      "total_so_far": sent,
                                      "took_ms": int((time.monotonic() - started) * 1000)},
                                     ensure_ascii=False) + "\n"
        finally:
            for task in pending:
                task.cancel()
        yield json.dumps({"type": "done", "total": sent, "topics": topic_counts,
                          "took_ms": int((time.monotonic() - started) * 1000)}) + "\n"

    return StreamingResponse(_gen(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/hub/{source}/search")
async def hub_search(
    source: str,
    q: str = Query("", min_length=0),
    sort: str = "recent",
    page: int = 1,
    category: str = "",
    strict_relevance: bool = False,
    relevance_min: float = Query(0.45, ge=0.0, le=1.0),
):
    a = _adapter(source)
    try:
        pg = await a.search(q, sort=sort, page=page, category=category)
        payload = pg.to_dict()
        # ALL is a discovery surface, but for a named search a source returning
        # its generic feed is worse than returning fewer cards.  Keep this opt-in
        # so individual-source browsing retains the site's native behaviour.
        if strict_relevance and q.strip():
            items = payload.get("items") or []
            kept, fallback, bar = _score_and_gate(items, q, relevance_min)
            payload["raw_count"] = len(items)
            payload["strict_count"] = len(kept)
            payload["relevance_min"] = bar
            payload["items"] = kept
            if fallback:
                payload["relevance_fallback"] = True
        return payload
    except Exception as exc:  # noqa: BLE001
        logger.warning("[Hub:%s] search failed: %s", source, exc)
        raise HTTPException(502, detail=f"{a.label} search failed: {exc}")


@router.get("/hub/{source}/feed")
async def hub_feed(source: str, sort: str = "recent", category: str = "", page: int = 1):
    a = _adapter(source)
    try:
        pg = await a.browse(sort=sort, category=category, page=page)
        return pg.to_dict()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[Hub:%s] feed failed: %s", source, exc)
        raise HTTPException(502, detail=f"{a.label} feed failed: {exc}")


@router.get("/hub/{source}/categories")
async def hub_categories(source: str):
    a = _adapter(source)
    return {"categories": await a.categories()}


@router.get("/hub/{source}/netstatus")
async def hub_netstatus(source: str):
    """Report whether scraping for this hub is IP-protected (Tor/proxy/direct)."""
    a = _adapter(source)
    if hasattr(a, "net_status"):
        return a.net_status()
    return {"mode": "direct", "protected": False}


@router.get("/hub/{source}/pornstar")
async def hub_pornstar(source: str, slug: str = Query(..., min_length=1),
                       sort: str = "", page: int = 1):
    a = _adapter(source)
    if not hasattr(a, "pornstar_videos"):
        raise HTTPException(501, detail=f"{a.label} has no pornstar browsing")
    try:
        return (await a.pornstar_videos(slug, sort=sort, page=page)).to_dict()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"{a.label} pornstar failed: {exc}")


@router.get("/hub/{source}/pornstar-find")
async def hub_pornstar_find(source: str, q: str = Query(..., min_length=1)):
    a = _adapter(source)
    if not hasattr(a, "find_pornstar"):
        raise HTTPException(501, detail=f"{a.label} has no pornstar search")
    try:
        return await a.find_pornstar(q)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"{a.label} pornstar-find failed: {exc}")


@router.get("/hub/{source}/member")
async def hub_member(source: str, ref: str = Query(..., min_length=1)):
    """Member (uploader/curator) summary: counts, public/private split, playlists."""
    a = _adapter(source)
    if not hasattr(a, "member_profile"):
        raise HTTPException(501, detail=f"{a.label} has no member profiles")
    try:
        return await a.member_profile(ref)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"{a.label} member failed: {exc}")


@router.get("/hub/{source}/member-videos")
async def hub_member_videos(source: str, ref: str = Query(..., min_length=1),
                            kind: str = "posted", page: int = 1):
    """A member's posted or favourite videos (kind=posted|favourites)."""
    a = _adapter(source)
    if not hasattr(a, "member_videos"):
        raise HTTPException(501, detail=f"{a.label} has no member videos")
    try:
        return (await a.member_videos(ref, kind=kind, page=page)).to_dict()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"{a.label} member-videos failed: {exc}")


@router.get("/hub/{source}/playlists")
async def hub_playlists(source: str, page: int = 1):
    """Recently-updated public playlists for this hub (browse list)."""
    a = _adapter(source)
    if not hasattr(a, "playlists"):
        raise HTTPException(501, detail=f"{a.label} has no playlists")
    try:
        return (await a.playlists(page=page)).to_dict()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"{a.label} playlists failed: {exc}")


@router.get("/hub/{source}/playlist")
async def hub_playlist(source: str, pid: str = Query(..., min_length=1), page: int = 1):
    """The videos inside one playlist."""
    a = _adapter(source)
    if not hasattr(a, "playlist_videos"):
        raise HTTPException(501, detail=f"{a.label} has no playlist videos")
    try:
        return (await a.playlist_videos(pid, page=page)).to_dict()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"{a.label} playlist failed: {exc}")


@router.get("/hub/{source}/playlist-find")
async def hub_playlist_find(source: str, q: str = Query(..., min_length=1)):
    """Resolve a pasted playlist URL/id or a title search to a playlist id."""
    a = _adapter(source)
    if not hasattr(a, "find_playlist"):
        raise HTTPException(501, detail=f"{a.label} has no playlist search")
    try:
        return await a.find_playlist(q)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"{a.label} playlist-find failed: {exc}")


class _EnrichBody(BaseModel):
    urls: list[str] = []
    deep: bool = False
    #: Ask for the resolve()+HEAD size fallback on sources whose enrich() cannot
    #: state a byte count. Off by default: it costs two extra round-trips per
    #: card, so the caller opts in for the passes where the size actually matters.
    fill_size: bool = False


@router.post("/hub/{source}/enrich")
async def hub_enrich(source: str, body: _EnrichBody):
    from ..hubs.metafill import fill_missing

    a = _adapter(source)
    urls = [u for u in (body.urls or []) if u][:60]
    if not urls:
        return {"results": {}}
    try:
        if body.deep and getattr(a, "supports_deep_enrich", False):
            results = await a.enrich(urls, deep=True)
        else:
            results = await a.enrich(urls)
        results = await fill_missing(a, results, want_size=body.fill_size,
                                     urls=urls if body.fill_size else None)
        return {"results": results}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"{a.label} enrich failed: {exc}")


@router.post("/hub/{source}/enrich-stream")
async def hub_enrich_stream(source: str, body: _EnrichBody):
    """NDJSON streaming enrich: one line per tile the moment its watch page
    resolves (cached tiles first, then fastest-finishing pages), so the grid
    fills progressively instead of waiting for a whole batch. Falls back to the
    blocking /enrich if the adapter has no streaming path."""
    from ..hubs.metafill import SIZE_IMPOSSIBLE, fill_missing, size_via_head

    a = _adapter(source)
    urls = [u for u in (body.urls or []) if u][:120]
    if not urls:
        return StreamingResponse(iter(["{}\n"]), media_type="application/x-ndjson")
    if not hasattr(a, "enrich_stream"):
        results = await a.enrich(urls)
        results = await fill_missing(a, results, want_size=body.fill_size,
                                     urls=urls if body.fill_size else None)
        lines = "".join(
            json.dumps({"url": u, "data": d}, ensure_ascii=False, default=str) + "\n"
            for u, d in results.items()
        )
        return StreamingResponse(iter([lines]), media_type="application/x-ndjson")

    async def _gen():
        # Cards whose size the adapter could not state. The size fallback costs
        # a resolve + a HEAD each, so it must not sit in front of the stream:
        # the quality/date line goes out immediately and the size arrives as a
        # second patch for the same url once it lands.
        pending_size: list[str] = []
        seen: set[str] = set()
        size_reason = SIZE_IMPOSSIBLE.get(getattr(a, "source", "") or "")
        try:
            stream = (
                a.enrich_stream(urls, deep=True)
                if body.deep and getattr(a, "supports_deep_enrich", False)
                else a.enrich_stream(urls)
            )
            async for u, d in stream:
                seen.add(u)
                if isinstance(d, dict):
                    # One row through the same normaliser the blocking path uses,
                    # so a streamed card and a batched card never disagree.
                    await fill_missing(a, {u: d}, want_size=False)
                    if d.get("size_mb"):
                        d.setdefault("size_basis", "source")
                    elif size_reason:
                        d["size_basis"] = "impossible"
                        d["size_note"] = size_reason
                    elif body.fill_size:
                        pending_size.append(u)
                yield json.dumps({"url": u, "data": d}, ensure_ascii=False, default=str) + "\n"
        except Exception as exc:  # noqa: BLE001
            logger.warning("[%s] enrich-stream failed: %s", a.label, exc)
            yield json.dumps({"error": str(exc)}) + "\n"
            return

        # Urls the adapter's stream never emitted at all (several adapters have
        # no enrich() and yield nothing). Without this they would never reach the
        # size fallback and their cards would stay blank forever.
        if body.fill_size and not size_reason:
            pending_size.extend(u for u in urls if u not in seen)

        if not pending_size:
            return
        # Second wave: sizes for the cards the adapter left blank. Bounded
        # concurrency — this is two requests per card against one host.
        sem = asyncio.Semaphore(4)

        async def _size(u: str) -> tuple[str, float | None]:
            async with sem:
                return u, await size_via_head(a, u)

        for fut in asyncio.as_completed([_size(u) for u in pending_size]):
            try:
                u, mb = await fut
            except Exception:  # noqa: BLE001
                continue
            patch = ({"size_mb": mb, "size_basis": "head"} if mb
                     else {"size_basis": "unavailable"})
            yield json.dumps({"url": u, "data": patch}, ensure_ascii=False) + "\n"

    return StreamingResponse(_gen(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/hub/{source}/resolve")
async def hub_resolve(source: str, url: str = Query(..., min_length=8)):
    a = _adapter(source)
    try:
        return await a.resolve(url)
    except NotImplementedError:
        raise HTTPException(501, detail=f"{a.label} has no resolver")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"{a.label} resolve failed: {exc}")


@router.get("/hub/{source}/related")
async def hub_related(source: str, url: str = Query(..., min_length=8)):
    a = _adapter(source)
    try:
        return (await a.related(url)).to_dict()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"{a.label} related failed: {exc}")


@router.get("/hub/{source}/stream")
async def hub_stream(source: str, request: Request, url: str = Query(..., min_length=8)):
    """Proxy a resolved CDN video stream through the dashboard.

    Eporner (and similar) bind a stream URL to the resolving IP + a Referer, so
    a browser hitting the CDN directly gets the "only available at …" placeholder.
    Piping it through the server — same IP that resolved it, correct Referer, with
    the browser's Range header passed through for seeking — makes it play reliably.
    """
    a = _adapter(source)
    host = (urlparse(url).hostname or "").lower()
    if a.media_hosts and not any(host == h or host.endswith("." + h) for h in a.media_hosts):
        raise HTTPException(400, detail="Host not allowed for this hub's stream proxy")

    referer = getattr(a, "stream_referer", "") or ""
    upstream_headers = {"User-Agent": _UA_STREAM, "Accept": "*/*"}
    if referer:
        upstream_headers["Referer"] = referer
    if getattr(a, "source", "") == "faphouse":
        # Faphouse's signed MP4 fallback is authenticated on some CDN edges.
        # Keep this proxy on the same session as the resolver, matching the HLS
        # proxy path and preventing a freshly resolved stream from failing only
        # when the browser starts fetching it.
        cookie_file = getattr(a, "_cookie_file", lambda: None)()
        cookie_header = build_cookie_header(cookie_file)
        if cookie_header:
            upstream_headers["Cookie"] = cookie_header
    rng = request.headers.get("range")
    if rng:
        upstream_headers["Range"] = rng

    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None), follow_redirects=True)
    try:
        req = client.build_request("GET", url, headers=upstream_headers)
        resp = await client.send(req, stream=True)
    except Exception as exc:  # noqa: BLE001
        await client.aclose()
        raise HTTPException(502, detail=f"stream connect failed: {exc}")

    if resp.status_code >= 400:
        code = resp.status_code
        await resp.aclose()
        await client.aclose()
        raise HTTPException(502, detail=f"upstream {code}")

    async def _body():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    passthrough = {}
    for h in ("content-length", "content-range", "content-type", "accept-ranges"):
        if h in resp.headers:
            passthrough[h.title()] = resp.headers[h]
    passthrough.setdefault("Accept-Ranges", "bytes")
    passthrough.setdefault("Content-Type", "video/mp4")
    passthrough["Cache-Control"] = "no-store"
    return StreamingResponse(_body(), status_code=resp.status_code, headers=passthrough)


@router.get("/hub/{source}/media")
async def hub_media(source: str, url: str = Query(..., min_length=8)):
    a = _adapter(source)
    host = (urlparse(url).hostname or "").lower()
    if a.media_hosts and not any(host == h or host.endswith("." + h) for h in a.media_hosts):
        raise HTTPException(400, detail="Host not allowed for this hub's media proxy")
    from ..hubs.base import media_cache_get, media_cache_put

    cache_key = f"{a.source}:{url}"
    cached = media_cache_get(cache_key)
    if cached is not None:
        content, ctype = cached
    else:
        try:
            content, ctype = await a.fetch_media(url)
        except NotImplementedError:
            raise HTTPException(501, detail=f"{a.label} has no media proxy")
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail=f"{a.label} media failed: {exc}")
        if content and len(content) >= 64:
            media_cache_put(cache_key, content, ctype)
    if not content or len(content) < 64:
        raise HTTPException(404, detail="Empty media")
    return Response(
        content=content,
        media_type=ctype,
        headers={
            "Cache-Control": "public, max-age=86400",
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
        },
    )


# ══════════════════════════════════════════════════════════════════════════════
# Follows + inbox — subscribe to a performer / category / playlist / search on a
# hub, and get a "new since you last looked" count. Turns the hub from pull into
# push. Stored as one JSON file (a handful of follows; no DB table needed).
# ══════════════════════════════════════════════════════════════════════════════

_FOLLOWS_PATH = Path(__file__).resolve().parents[2] / "data" / "hub_follows.json"
_FOLLOWS_LOCK = threading.Lock()
_SEEN_CAP = 60  # top URLs remembered per follow to diff against


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _follow_key(source: str, kind: str, ref: str) -> str:
    return f"{source}:{kind}:{(ref or '').strip().lower()}"


def _load_follows() -> list[dict]:
    with _FOLLOWS_LOCK:
        try:
            raw = json.loads(_FOLLOWS_PATH.read_text(encoding="utf-8"))
            return raw if isinstance(raw, list) else []
        except Exception:  # noqa: BLE001 — missing/corrupt file = no follows yet
            return []


def _save_follows(rows: list[dict]) -> None:
    with _FOLLOWS_LOCK:
        try:
            _FOLLOWS_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = _FOLLOWS_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(_FOLLOWS_PATH)
        except Exception as exc:  # noqa: BLE001
            logger.warning("hub follows save failed: %s", exc)


class _FollowBody(BaseModel):
    source: str
    kind: str            # performer | category | playlist | search | feed
    ref: str = ""        # slug / pid / query (empty for a plain feed)
    name: str = ""


class _FollowKeyBody(BaseModel):
    key: str


async def _follow_top_items(follow: dict) -> list[dict]:
    """Fetch page 1 of whatever a follow points at, as uniform tiles."""
    a = registry.get(follow.get("source", ""))
    if a is None:
        return []
    kind, ref = follow.get("kind", ""), (follow.get("ref") or "").strip()
    try:
        if kind == "performer" and hasattr(a, "pornstar_videos"):
            pg = await a.pornstar_videos(ref, sort="recent", page=1)
        elif kind == "playlist" and hasattr(a, "playlist_videos"):
            pg = await a.playlist_videos(ref, page=1)
        elif kind == "search":
            pg = await a.search(ref, sort="recent", page=1)
        elif kind == "category":
            pg = await a.browse(sort="recent", category=ref, page=1)
        else:
            pg = await a.browse(sort="recent", page=1)
        return pg.items or []
    except Exception as exc:  # noqa: BLE001 — one bad follow must not sink the batch
        logger.info("follow fetch failed (%s/%s): %s", follow.get("source"), kind, exc)
        return []


@router.get("/hub/follows")
async def hub_follows_list():
    return {"follows": _load_follows()}


@router.post("/hub/follows")
async def hub_follows_add(body: _FollowBody):
    source = (body.source or "").strip().lower()
    if registry.get(source) is None:
        registry.init_hubs()
    if registry.get(source) is None:
        raise HTTPException(404, detail=f"Unknown hub source '{source}'")
    key = _follow_key(source, body.kind, body.ref)
    rows = _load_follows()
    if any(r.get("key") == key for r in rows):
        return {"ok": True, "already": True, "follows": rows}
    follow = {
        "key": key, "source": source, "kind": body.kind,
        "ref": (body.ref or "").strip(), "name": body.name or body.ref or source,
        "added_at": _now_iso(), "checked_at": "", "new_count": 0, "seen_urls": [],
    }
    # seed seen_urls with the current top so we only alert on things added AFTER now
    try:
        items = await _follow_top_items(follow)
        follow["seen_urls"] = [it.get("url") for it in items[:_SEEN_CAP] if it.get("url")]
        follow["checked_at"] = _now_iso()
    except Exception:  # noqa: BLE001
        pass
    rows.append(follow)
    _save_follows(rows)
    return {"ok": True, "follows": rows}


@router.post("/hub/follows/remove")
async def hub_follows_remove(body: _FollowKeyBody):
    rows = [r for r in _load_follows() if r.get("key") != body.key]
    _save_follows(rows)
    return {"ok": True, "follows": rows}


@router.post("/hub/follows/seen")
async def hub_follows_seen(body: _FollowKeyBody):
    """Mark a follow's current top as seen (clears its new badge)."""
    rows = _load_follows()
    for r in rows:
        if r.get("key") != body.key:
            continue
        items = await _follow_top_items(r)
        r["seen_urls"] = [it.get("url") for it in items[:_SEEN_CAP] if it.get("url")]
        r["new_count"] = 0
        r["checked_at"] = _now_iso()
        break
    _save_follows(rows)
    return {"ok": True, "follows": rows}


@router.post("/hub/follows/check")
async def hub_follows_check():
    """Recompute the "new since last seen" count for every follow, in parallel."""
    registry.init_hubs()
    rows = _load_follows()
    if not rows:
        return {"follows": [], "total_new": 0}

    async def _one(r: dict) -> dict:
        items = await _follow_top_items(r)
        seen = set(r.get("seen_urls") or [])
        urls = [it.get("url") for it in items if it.get("url")]
        new_items = [it for it in items if it.get("url") and it["url"] not in seen]
        r["new_count"] = len(new_items) if seen else 0
        r["checked_at"] = _now_iso()
        # first-ever check (no baseline) seeds the baseline silently
        if not seen and urls:
            r["seen_urls"] = urls[:_SEEN_CAP]
        r["_preview"] = [
            {"title": it.get("title", ""), "url": it.get("url", ""),
             "thumb": it.get("thumb", ""), "source": r.get("source")}
            for it in new_items[:6]
        ]
        return r

    updated = await asyncio.gather(*[_one(dict(r)) for r in rows])
    _save_follows([{k: v for k, v in r.items() if k != "_preview"} for r in updated])
    total_new = sum(int(r.get("new_count") or 0) for r in updated)
    return {"follows": updated, "total_new": total_new}


@router.get("/hub/library-similar")
async def hub_library_similar(q: str = Query(..., min_length=2), limit: int = 12):
    """Videos from the user's OWN library most similar to a hub video's title —
    the "you might already have something like this" bridge. Uses the existing
    semantic index; degrades to an empty list if it isn't built."""
    limit = max(1, min(40, int(limit or 12)))
    try:
        from .. import semantic_search as _sem
        # Never trigger a full index build from a play-click: it's heavy and can race
        # SentenceTransformer.encode() (see the dashboard-freeze memo). Only serve when
        # the index already exists; otherwise degrade to empty and let the normal
        # build path warm it up elsewhere.
        if not getattr(_sem, "_ids", None):
            return {"items": [], "index_ready": False}
        rows = await asyncio.to_thread(_sem.search, q, limit)
    except Exception as exc:  # noqa: BLE001
        logger.info("library-similar failed: %s", exc)
        return {"items": []}
    items = [
        {
            "id": r.get("id"), "title": r.get("title") or "",
            "thumbnail_path": r.get("thumbnail"), "duration": r.get("duration") or 0,
            "score": r.get("score"), "url": r.get("url") or "",
        }
        for r in rows
    ]
    return {"items": items}
