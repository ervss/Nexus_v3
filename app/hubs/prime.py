"""Prime Cut — one keyword, every hub, only the good stuff.

The plain ALL fan-out asks each source for its newest page and interleaves the
result. That answers "what is new" but not "what is worth importing": it runs a
single sort, so a keyword's best matches never surface, and it trusts whatever
quality the listing claims — which for several sources is a guess.

Prime Cut runs, per source and in parallel:

  1. Two passes — `recent` (newest) and relevance (the site's own default search
     order). A tile found by both is, by construction, both fresh and on-topic.
  2. A quality gate that knows how much each listing can be trusted:

       EXACT   the listing carries a real height (Eporner's API, AnySex's
               hd1080/hd2160 spans, HQPorner's labels, Camwhores' preview
               height). Filter directly, no extra request.
       NONE    no height at all until enrich() runs.

     Only what the gate cannot decide is sent to enrich(), newest-and-most-
     relevant first, and only until the per-source quota is filled. That keeps
     the expensive pass proportional to the answer, not to the search.
  3. A blended score so the returned N are the intersection of fresh, relevant
     and high-quality rather than the top of any single axis.

Sources that can neither report a real height nor enrich (PornTrex, XXBrits)
cannot honestly claim 1080p. They are still harvested, but their tiles are
marked `quality_verified: false` and kept out of the strict result unless the
caller opts in — a claim we cannot check is not a claim we make.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import re
import time
import unicodedata
from typing import Any, Iterable, Optional
from urllib.parse import urlsplit

from . import registry

__all__ = [
    "DEFAULT_RELEVANCE",
    "harvest_source",
    "interleave",
    "matches_query",
    "prime_cut",
    "prime_cut_iter",
    "relevance_score",
    "tile_height",
]

logger = logging.getLogger(__name__)

#: Listing height is the real thing — no verification round-trip needed.
_TRUST_EXACT = frozenset({"eporner", "anysex", "hqporner", "camwhores"})

#: A source is never promoted to a quality floor merely by its branding.
# Do not promote a whole source based on its branding.  A live audit found
# 4KPorno cards presented as only "HD", so its old catalogue-wide 2160p
# assumption could make Prime claim a quality that the individual tile did not
# prove.  Sources still pass whenever their listing or enrich result gives a
# concrete height.
_DECLARED_FLOOR: dict[str, int] = {}

#: Relevance is the site's own default search order; every adapter falls through
#: to it when no sort is requested. Eporner additionally ranks locally.
_SORT_RELEVANCE = ""
_SORT_RECENT = "recent"

_QUALITY_RE = re.compile(r"(\d{3,4})\s*p", re.I)
# ``\w`` includes an underscore, but aliases such as bad_girl_sandra need to
# compare the same way as badgirlsandra.
_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)
#: URL path separators. Sources join slug words with any of these.
_PATH_SPLIT_RE = re.compile(r"[/\-_.]+")

#: Score at which a tile is considered to have earned its place in a strict
#: result. Kept as one constant because the router echoes it to the frontend and
#: a second literal would drift away from the gate it is supposed to describe.
DEFAULT_RELEVANCE = 0.45

# Wall-clock budgets. A slow source must never hold the whole answer hostage:
# whatever has arrived when the deadline hits is what gets returned.
DEFAULT_DEADLINE = 45.0
PER_SOURCE_DEADLINE = 30.0
ENRICH_CHUNK = 12
#: Hard cap on verification work per source, so a source full of 720p cannot
#: turn one search into an unbounded crawl.
MAX_ENRICH_PER_SOURCE = 48


def tile_height(tile: dict) -> int:
    """Best-known height for a tile, from the numeric field or a "1080p"/"4K" label."""
    height = int(tile.get("height") or 0)
    if height:
        return height
    label = str(tile.get("quality") or "")
    if re.search(r"\b4\s*k\b", label, re.I):
        return 2160
    match = _QUALITY_RE.search(label)
    return int(match.group(1)) if match else 0


def _normalise_text(value: object) -> str:
    """Lower-case text for a stable, punctuation-insensitive query match."""
    plain = unicodedata.normalize("NFKD", str(value or ""))
    plain = "".join(ch for ch in plain if not unicodedata.combining(ch))
    return " ".join(_WORD_RE.findall(plain.casefold()))


def _is_id_segment(word: str) -> bool:
    """True for a URL fragment that is an identifier rather than a word.

    Pure digits are always an id (``/videos/123/``). A hex blob is only treated
    as one when it mixes in a digit and is long enough to be improbable as
    text — ``decade`` and ``facade`` are spelled entirely with hex letters, and
    dropping them would blind the gate to real query words.
    """
    if word.isdigit():
        return True
    return (len(word) >= 6 and any(ch.isdigit() for ch in word)
            and all(ch in "0123456789abcdef" for ch in word.casefold()))


def _slug_text(url: object) -> str:
    """The words a source hid in its own watch URL.

    Only Eporner fills ``tags`` on a LISTING tile, so for ten of eleven sources
    the haystack was the title and nothing else — a search whose words lived in
    the path (``/videos/kenzie-jayy-rides-bbc/``) scored a flat zero and the
    whole source was discarded as irrelevant. Every source encodes the title in
    the path, which makes this the one piece of extra evidence that costs no
    request. Ids are stripped first so a numeric segment cannot accidentally
    satisfy a query token.
    """
    path = urlsplit(str(url or "")).path
    if not path:
        return ""
    words = [w for w in _PATH_SPLIT_RE.split(path) if w and not _is_id_segment(w)]
    return _normalise_text(" ".join(words))


def _tile_search_text(tile: dict) -> str:
    """Text we can honestly use as evidence that a tile matches a query."""
    parts: list[object] = [tile.get("title") or ""]
    for key in ("tags", "videoTags", "categories", "performers"):
        value = tile.get(key) or []
        if not isinstance(value, (list, tuple)):
            value = [value]
        for row in value:
            if isinstance(row, dict):
                parts.append(row.get("name") or row.get("title") or row.get("slug") or "")
            else:
                parts.append(row)
    parts.append(_slug_text(tile.get("url")))
    return _normalise_text(" ".join(str(part) for part in parts if part))


def _edit_allowance(token: str) -> int:
    """How many typos a token of this length can absorb without changing meaning.

    Short tokens have no slack: one edit turns ``ass`` into a different word
    entirely, so they must match exactly. Longer tokens are where users actually
    slip (``kenziee``), and a name that long cannot become another name in one
    or two edits.
    """
    length = len(token)
    if length <= 3:
        return 0
    return 1 if length <= 6 else 2


def _within_edits(a: str, b: str, allowance: int) -> bool:
    """True when `a` reaches `b` in at most `allowance` edits.

    A plain iterative Levenshtein with two exits: an up-front length check, and
    a per-row minimum that abandons the pair as soon as every alignment already
    costs more than the allowance. This runs once per (query token, haystack
    token) pair for every tile of every source, so the early bail is what keeps
    the gate free. difflib is deliberately not used — its ratio is a similarity,
    not an edit budget, and it is quadratic with no way out.
    """
    if allowance <= 0:
        return a == b
    if abs(len(a) - len(b)) > allowance:
        return False
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        best = i
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            step = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
            current.append(step)
            if step < best:
                best = step
        if best > allowance:
            return False
        previous = current
    return previous[-1] <= allowance


def _has_phrase(haystack: str, phrase: str) -> bool:
    """Whole-word containment, so "art" does not match inside "party"."""
    return f" {phrase} " in f" {haystack} "


def relevance_score(tile: dict, query: str) -> float:
    """0.0 (no evidence) .. 1.0 (exact phrase in the title).

    Site search pages degrade into a generic feed for an unknown name, so Prime
    and the strict search mode need to tell "the source answered my question"
    apart from "the source handed me its front page". A boolean answer to that
    was too brittle in both directions: a single typo dropped an entire source,
    and a source that matched on weaker evidence than the title could not say
    so. The score keeps the ordering information the boolean threw away — the
    caller filters on it AND sorts by it.

    The tiers are ordered by how much the evidence is worth, not by how much
    text matched: the phrase in the title is the source agreeing with the query,
    the same phrase in a tag or the URL slug is nearly as good, and a bag of
    matched tokens is the weakest thing we still call a match.
    """
    wanted = _normalise_text(query)
    if not wanted:
        return 1.0
    haystack = _tile_search_text(tile)
    if not haystack:
        return 0.0
    if _has_phrase(_normalise_text(tile.get("title")), wanted):
        return 1.0
    if _has_phrase(haystack, wanted):
        return 0.9
    # Aliases are written both ways: bad_girl_sandra must equal badgirlsandra.
    compact_wanted = wanted.replace(" ", "")
    if compact_wanted and compact_wanted in haystack.replace(" ", ""):
        return 0.85
    hay_tokens = set(haystack.split())
    tokens = wanted.split()
    exact = fuzzy = 0
    for token in tokens:
        if token in hay_tokens:
            exact += 1
        elif any(_within_edits(token, other, _edit_allowance(token)) for other in hay_tokens):
            fuzzy += 1
    matched = exact + fuzzy
    if matched == len(tokens):
        # Everything the user asked for is here; a typo on the way makes the
        # evidence weaker, not absent.
        return 0.6 if fuzzy else 0.75
    # Partial evidence degrades smoothly. Falling straight to zero is what made
    # one unmatched token of five look identical to a completely unrelated tile.
    return 0.6 * (matched / len(tokens))


def matches_query(tile: dict, query: str, threshold: float = DEFAULT_RELEVANCE) -> bool:
    """True when a tile clears the relevance bar. Thin wrapper over the score."""
    return relevance_score(tile, query) >= threshold


def _trust(source: str, tile: dict) -> str:
    """How much this tile's stated height can be believed: exact | coarse | none."""
    if not tile_height(tile):
        return "none"
    if source in _TRUST_EXACT:
        return "exact"
    # Coarse sources derive height from a badge, not from the media. DrTuber was
    # observed labelling an entire result page 2160p this way, so not even its
    # 4K claim earns the exact tier — everything here must be verified.
    return "coarse"


def _as_dict(item: Any) -> dict:
    """Tiles reach us as dicts from some adapters and as Tile objects from others.

    Page.items is typed list[dict], but several adapters hand back Tile
    dataclasses. Normalising here keeps that inconsistency from turning into an
    AttributeError that silently zeroes out a whole source.
    """
    if isinstance(item, dict):
        return item
    to_dict = getattr(item, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    return dict(getattr(item, "__dict__", {}) or {})


def _has_real_enrich(adapter) -> bool:
    """True only if the adapter can actually verify quality for a list of URLs.

    Two things disqualify an adapter. The base class defines a no-op enrich(),
    so hasattr() always says yes. Some adapters override it with a
    different contract entirely — `enrich(self, video: Tile) -> Tile`, a stub
    that hands its argument straight back. Calling that returns the URL list we
    passed in, which verifies nothing; believing it would let unchecked tiles be
    labelled as meeting the quality bar.
    """
    fn = None
    for base in type(adapter).__mro__:
        if base.__name__ == "HubAdapter":
            break
        if "enrich" in base.__dict__:
            fn = base.__dict__["enrich"]
            break
    if fn is None:
        return False
    try:
        params = [p for p in inspect.signature(fn).parameters if p != "self"]
    except (TypeError, ValueError):
        return False
    # The contract is enrich(urls: list[str]); a stub taking a single Tile is not it.
    return bool(params) and params[0] == "urls"


async def _one_pass(adapter, query: str, sort: str, pages: int) -> list[dict]:
    """One sort, `pages` pages, flattened in rank order. Failures yield nothing."""
    out: list[dict] = []
    for page in range(1, max(1, pages) + 1):
        try:
            if query:
                pg = await adapter.search(query, sort=sort, page=page)
            else:
                pg = await adapter.browse(sort=sort, page=page)
        except Exception as exc:  # noqa: BLE001 — one bad page must not kill the source
            logger.info("[Prime:%s] %s page %s failed: %s", adapter.source, sort or "relevance", page, exc)
            break
        items = [_as_dict(i) for i in (pg.items or [])]
        out.extend(items)
        if not items or not pg.has_more:
            break
    return out


def _merge_passes(recent: list[dict], relevant: list[dict]) -> list[dict]:
    """Union of both passes, each tile tagged with its rank on each axis.

    Rank is where the source itself put the tile, so "fresh" and "on-topic" stay
    the source's own judgement; we only combine them.
    """
    merged: dict[str, dict] = {}
    for rank, tile in enumerate(recent):
        url = str(tile.get("url") or "")
        if not url:
            continue
        row = merged.setdefault(url, dict(tile))
        row["_rank_recent"] = rank
    for rank, tile in enumerate(relevant):
        url = str(tile.get("url") or "")
        if not url:
            continue
        row = merged.get(url)
        if row is None:
            row = merged[url] = dict(tile)
        row["_rank_relevant"] = rank
    return list(merged.values())


def _score(tile: dict, pool: int) -> float:
    """Blend freshness, relevance and quality into one ordering.

    Ranks are normalised against the pool so a source that returned 200 tiles is
    not automatically outranked by one that returned 20. A tile present in both
    passes scores on both axes and therefore beats a tile that only topped one.
    """
    span = max(pool, 1)
    fresh = 1.0 - (tile.get("_rank_recent", span) / span)
    relevant = 1.0 - (tile.get("_rank_relevant", span) / span)
    height = tile_height(tile)
    quality = 1.0 if height >= 2160 else 0.72 if height >= 1440 else 0.5 if height >= 1080 else 0.0
    both = 0.18 if ("_rank_recent" in tile and "_rank_relevant" in tile) else 0.0
    return (0.4 * relevant) + (0.32 * fresh) + (0.28 * quality) + both


async def _verify(adapter, tiles: list[dict], min_height: int, want: int,
                  deadline: float) -> tuple[list[dict], int]:
    """Enrich tiles in score order until `want` pass the bar. Returns (passed, checked).

    Stops as soon as the quota is filled — the whole point of the gate is that
    verification cost tracks the answer size, not the candidate pool.
    """
    passed: list[dict] = []
    checked = 0
    if not _has_real_enrich(adapter):
        return passed, checked

    for start in range(0, min(len(tiles), MAX_ENRICH_PER_SOURCE), ENRICH_CHUNK):
        if len(passed) >= want or time.monotonic() > deadline:
            break
        chunk = tiles[start:start + ENRICH_CHUNK]
        urls = [str(t.get("url") or "") for t in chunk if t.get("url")]
        if not urls:
            continue
        try:
            meta = await adapter.enrich(urls)
        except Exception as exc:  # noqa: BLE001
            logger.info("[Prime:%s] enrich failed: %s", adapter.source, exc)
            break
        if not isinstance(meta, dict):
            # Contract is url -> meta. Anything else verifies nothing, so stop
            # rather than pass unchecked tiles off as confirmed.
            logger.info("[Prime:%s] enrich returned %s, not a dict — cannot verify",
                        adapter.source, type(meta).__name__)
            break
        checked += len(urls)
        for tile in chunk:
            info = (meta or {}).get(str(tile.get("url") or "")) or {}
            if info:
                tile.update({k: v for k, v in info.items() if v not in (None, "", 0)})
                tile["enriched"] = True
            if tile_height(tile) >= min_height:
                tile["quality_verified"] = True
                tile["quality_basis"] = "enriched"
                passed.append(tile)
    return passed, checked


async def harvest_source(source: str, query: str, *, min_height: int, per_source: int,
                         pages: int, allow_unverified: bool,
                         deadline: float,
                         relevance_min: float = DEFAULT_RELEVANCE) -> dict[str, Any]:
    """Run both passes + the quality gate for one source. Never raises.

    `relevance_min` is the bar a tile must clear to count as on-topic. It is a
    parameter rather than the constant because a multi-tag preset scores
    differently from a one-word search: `relevance_score` gives 0.6 * (matched /
    total) for a partial hit, so 2-of-3 tags scores 0.40 and would be dropped by
    the 0.45 default even though it is exactly the kind of tile the preset wants.
    Callers that do not care keep the default and behave as before.
    """
    started = time.monotonic()
    adapter = registry.get(source)
    if adapter is None:
        return {"source": source, "items": [], "error": "unknown source"}

    stats = {
        "harvested": 0,
        "relevant": 0,
        "dropped_irrelevant": 0,
        "exact": 0,
        "verified": 0,
        "checked": 0,
        "unverified": 0,
    }
    try:
        recent, relevant = await asyncio.gather(
            _one_pass(adapter, query, _SORT_RECENT, pages),
            _one_pass(adapter, query, _SORT_RELEVANCE, pages),
            return_exceptions=False,
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("[Prime:%s] harvest failed: %s", source, exc)
        return {"source": source, "items": [], "error": str(exc), "stats": stats}

    pool = _merge_passes(recent, relevant)
    stats["harvested"] = len(pool)
    # Do this before the quality/enrichment pass.  Otherwise a generic site
    # feed can spend the verification budget on unrelated 4K videos and crowd
    # out the exact matches the user actually asked for.
    pool = [tile for tile in pool if matches_query(tile, query, relevance_min)]
    stats["relevant"] = len(pool)
    stats["dropped_irrelevant"] = stats["harvested"] - stats["relevant"]
    if not pool:
        return {"source": source, "items": [], "stats": stats,
                "took_ms": int((time.monotonic() - started) * 1000)}

    for tile in pool:
        tile["source"] = source
    pool.sort(key=lambda t: _score(t, len(pool)), reverse=True)

    # Split by how much the listing can be believed.
    accepted: list[dict] = []
    needs_check: list[dict] = []
    floor = _DECLARED_FLOOR.get(source, 0)
    for tile in pool:
        if floor >= min_height and not tile_height(tile):
            # Whole-catalogue guarantee stands in for a missing listing height.
            tile["height"] = tile["height"] or floor
            tile["quality_verified"] = True
            tile["quality_basis"] = "declared"
            accepted.append(tile)
            continue
        if _trust(source, tile) == "exact":
            if tile_height(tile) >= min_height:
                tile["quality_verified"] = True
                tile["quality_basis"] = "listing"
                accepted.append(tile)
        else:
            needs_check.append(tile)
    stats["exact"] = len(accepted)

    if len(accepted) < per_source and needs_check:
        verified, checked = await _verify(
            adapter, needs_check, min_height, per_source - len(accepted),
            min(deadline, started + PER_SOURCE_DEADLINE),
        )
        stats["verified"] = len(verified)
        stats["checked"] = checked
        accepted.extend(verified)

    # Sources that can neither state nor verify a height: surfaced only on request
    # and never labelled as meeting the bar.
    if allow_unverified and len(accepted) < per_source and not _has_real_enrich(adapter):
        for tile in needs_check:
            if len(accepted) >= per_source:
                break
            if tile.get("quality_verified"):
                continue
            tile["quality_verified"] = False
            accepted.append(tile)
            stats["unverified"] += 1

    accepted.sort(key=lambda t: _score(t, len(pool)), reverse=True)
    items = accepted[:per_source]
    for tile in items:
        tile.pop("_rank_recent", None)
        tile.pop("_rank_relevant", None)
    return {
        "source": source,
        "label": getattr(adapter, "label", source),
        "items": items,
        "stats": stats,
        "took_ms": int((time.monotonic() - started) * 1000),
    }


def interleave(groups: Iterable[dict]) -> list[dict]:
    """Round-robin the per-source lists so the grid reads as a mix, not blocks."""
    lists = [list(g.get("items") or []) for g in groups]
    out: list[dict] = []
    seen: set[str] = set()
    for i in range(max((len(l) for l in lists), default=0)):
        for lst in lists:
            if i >= len(lst):
                continue
            url = str(lst[i].get("url") or "")
            if url and url not in seen:
                seen.add(url)
                out.append(lst[i])
    return out


def _plan(sources: Optional[list[str]]) -> list[str]:
    registry.init_hubs()
    return [s for s in (sources or [r["source"] for r in registry.all_sources()])
            if registry.get(s) is not None]


async def prime_cut_iter(query: str, *, sources: Optional[list[str]] = None,
                         min_height: int = 1080, per_source: int = 10, pages: int = 1,
                         allow_unverified: bool = False,
                         deadline: float = DEFAULT_DEADLINE,
                         relevance_min: float = DEFAULT_RELEVANCE):
    """Yield each source's result as it lands, then a final summary.

    Sources finish at wildly different speeds (2s to 30s), so a single blocking
    call leaves the UI staring at a spinner with nothing to show. Streaming lets
    the grid fill in as each source reports, and makes a slow or dead source
    visible instead of indistinguishable from "still working".
    """
    started = time.monotonic()
    wanted = _plan(sources)
    ends_at = started + deadline
    yield {"type": "start", "sources": wanted, "total_sources": len(wanted)}

    async def _one(src: str) -> dict:
        try:
            return await asyncio.wait_for(
                harvest_source(src, query, min_height=min_height, per_source=per_source,
                               pages=pages, allow_unverified=allow_unverified,
                               deadline=ends_at, relevance_min=relevance_min),
                timeout=max(1.0, ends_at - time.monotonic()),
            )
        except asyncio.TimeoutError:
            return {"source": src, "items": [], "error": "timeout"}
        except Exception as exc:  # noqa: BLE001
            return {"source": src, "items": [], "error": str(exc)}

    groups: list[dict] = []
    tasks = [asyncio.create_task(_one(s)) for s in wanted]
    try:
        done_n = 0
        for fut in asyncio.as_completed(tasks):
            group = await fut
            groups.append(group)
            done_n += 1
            yield {
                "type": "source",
                "done": done_n,
                "total_sources": len(wanted),
                "group": group,
                "tiles_so_far": sum(len(g.get("items") or []) for g in groups),
            }
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()

    groups = sorted(groups, key=lambda g: len(g.get("items") or []), reverse=True)
    merged = interleave(groups)
    yield {
        "type": "done",
        "query": query,
        "min_height": min_height,
        "per_source": per_source,
        "items": merged,
        "groups": groups,
        "total": len(merged),
        "sources_ok": sum(1 for g in groups if g.get("items")),
        "sources_total": len(groups),
        "took_ms": int((time.monotonic() - started) * 1000),
    }


async def prime_cut(query: str, *, sources: Optional[list[str]] = None,
                    min_height: int = 1080, per_source: int = 10, pages: int = 1,
                    allow_unverified: bool = False,
                    deadline: float = DEFAULT_DEADLINE,
                    relevance_min: float = DEFAULT_RELEVANCE) -> dict[str, Any]:
    """Fan out across sources and return each one's best `per_source` tiles."""
    registry.init_hubs()
    started = time.monotonic()
    wanted = [s for s in (sources or [r["source"] for r in registry.all_sources()])
              if registry.get(s) is not None]
    ends_at = started + deadline

    async def _one(src: str) -> dict:
        try:
            return await asyncio.wait_for(
                harvest_source(src, query, min_height=min_height, per_source=per_source,
                               pages=pages, allow_unverified=allow_unverified,
                               deadline=ends_at, relevance_min=relevance_min),
                timeout=max(1.0, ends_at - time.monotonic()),
            )
        except asyncio.TimeoutError:
            logger.info("[Prime:%s] deadline hit — returning nothing for this source", src)
            return {"source": src, "items": [], "error": "timeout"}
        except Exception as exc:  # noqa: BLE001
            return {"source": src, "items": [], "error": str(exc)}

    groups = await asyncio.gather(*[_one(s) for s in wanted])
    groups = sorted(groups, key=lambda g: len(g.get("items") or []), reverse=True)
    merged = interleave(groups)
    return {
        "query": query,
        "min_height": min_height,
        "per_source": per_source,
        "items": merged,
        "groups": groups,
        "total": len(merged),
        "sources_ok": sum(1 for g in groups if g.get("items")),
        "sources_total": len(groups),
        "took_ms": int((time.monotonic() - started) * 1000),
    }
