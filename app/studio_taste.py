"""
Studio taste — what your heat ratings actually say about you.

Everything else in the app infers taste from what you *saved*. That is a weak
signal: an import is a bet placed before watching. A moment is the opposite —
you had already seen it, you stopped, and you marked it. Heat and replays on
top of that are as close to ground truth as this library gets.

So the profile is built only from kept moments, weighted by how strongly you
reacted, and it feeds two things:

  * the daily reel's ordering — your own material, resurfaced by affinity
    rather than by date;
  * taste picks — a live fan-out across the hub sources using your top terms,
    i.e. new material chosen by the same signal.

The profile is derived, never stored. It is cheap to rebuild (one pass over a
few hundred rows) and a cached copy would go stale the moment you rate anything.
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from datetime import date
from typing import Any, Optional

from .database import Moment, SessionLocal, Video

logger = logging.getLogger(__name__)

#: Words that describe every video ever and so describe none of them.
_STOP = frozenset("""
the and with from this that for her his she him you your are was get its our their
xxx porn video videos free full part scene clip hd sd 4k 1080p 720p com www net
new hot best big com onlyfans leaked leak mp4 avi source watch online
""".split())

_WORD_RE = re.compile(r"[a-z0-9]{3,}")


def _is_noise(word: str) -> bool:
    """True for filename debris that is not a preference.

    Library titles are full of upload ids, hashes and timecode fragments
    ("0hua741l45oud0q6t4x9d", "000", "179"). Left in, they outrank real terms
    the moment two moments share a parent — and taste picks then searches the
    hub sources for a hash, which returns nothing at all.
    """
    if word.isdigit():
        return True
    if len(word) > 14:
        return True
    has_digit = any(c.isdigit() for c in word)
    if has_digit and len(word) >= 7:
        return True
    # A token with no vowel at that length is an id, not a word ("dsddywdo").
    return len(word) >= 6 and not set(word) & set("aeiouy")

#: Rebuilding on every request would be wasteful during a reel; a minute is far
#: shorter than it takes anyone to change their mind about what they like.
_CACHE: dict[str, Any] = {"at": 0.0, "profile": None}
_CACHE_TTL = 60.0


def _weight(m: Moment) -> float:
    """How loudly this moment speaks.

    Heat dominates because it is the only deliberate rating; replays back it up
    but saturate, so one obsessively re-watched clip cannot drown out the rest.
    """
    w = 1.0
    w += 2.0 * int(m.heat or 0)
    w += 0.5 * min(int(m.play_count or 0), 6)
    if m.is_favorite:
        w += 2.0
    return w


def _terms_from(text: str) -> list[str]:
    return [w for w in _WORD_RE.findall((text or "").lower())
            if w not in _STOP and not _is_noise(w)]


def build_profile(limit: int = 800) -> dict:
    """Aggregate kept moments into weighted term / source / model rankings."""
    db = SessionLocal()
    try:
        moments = (db.query(Moment).filter(Moment.status == "kept")
                   .order_by(Moment.created_at.desc()).limit(limit).all())
        if not moments:
            return {"terms": [], "tags": [], "sources": [], "models": [],
                    "moments_used": 0, "confident": False}

        parent_ids = {m.video_id for m in moments if m.video_id}
        parents = {}
        if parent_ids:
            parents = {v.id: v for v in db.query(Video).filter(Video.id.in_(parent_ids)).all()}

        terms: dict[str, float] = {}
        tags: dict[str, float] = {}
        sources: dict[str, float] = {}
        models: dict[str, float] = {}

        for m in moments:
            w = _weight(m)
            for t in (m.tags or "").replace("|", ",").split(","):
                t = t.strip().lower()
                if t and t not in _STOP and not _is_noise(t):
                    tags[t] = tags.get(t, 0) + w
            for word in _terms_from(m.title or m.parent_title or ""):
                terms[word] = terms.get(word, 0) + w
            src = (m.source or "").lower()
            parent = parents.get(m.video_id) if m.video_id else None
            if not src and parent:
                src = (parent.batch_name or "knižnica").lower()
            if src:
                sources[src] = sources.get(src, 0) + w
            if parent:
                for field in (parent.models, parent.categories, parent.tags):
                    for t in (field or "").split(","):
                        t = t.strip().lower()
                        if not t or t in _STOP or _is_noise(t):
                            continue
                        bucket = models if field is parent.models else tags
                        bucket[t] = bucket.get(t, 0) + w * 0.6

        def rank(d: dict[str, float], n: int) -> list[dict]:
            return [{"name": k, "score": round(v, 1)}
                    for k, v in sorted(d.items(), key=lambda kv: -kv[1])[:n]]

        return {
            "terms": rank(terms, 25),
            "tags": rank(tags, 25),
            "sources": rank(sources, 12),
            "models": rank(models, 15),
            "moments_used": len(moments),
            # Under a handful of rated moments the ranking is basically one video's
            # title repeated; say so rather than dressing it up as a taste profile.
            "confident": sum(1 for m in moments if (m.heat or 0) or m.is_favorite) >= 5,
        }
    finally:
        db.close()


def get_profile() -> dict:
    if _CACHE["profile"] is not None and time.monotonic() - _CACHE["at"] < _CACHE_TTL:
        return _CACHE["profile"]
    profile = build_profile()
    _CACHE.update(at=time.monotonic(), profile=profile)
    return profile


def invalidate() -> None:
    """Called whenever a moment's rating changes, so the next read is fresh."""
    _CACHE.update(at=0.0, profile=None)


def affinity(moment: Moment, profile: dict) -> float:
    """How well one moment matches the profile. Used to order the daily reel."""
    if not profile.get("terms") and not profile.get("tags"):
        return 0.0
    tag_scores = {r["name"]: r["score"] for r in profile["tags"]}
    term_scores = {r["name"]: r["score"] for r in profile["terms"]}
    top = max([*tag_scores.values(), *term_scores.values(), 1.0])
    score = 0.0
    for t in (moment.tags or "").replace("|", ",").split(","):
        score += tag_scores.get(t.strip().lower(), 0)
    for word in _terms_from(moment.title or moment.parent_title or ""):
        score += term_scores.get(word, 0) * 0.5
    return score / top


def taste_query(profile: dict, words: int = 3) -> str:
    """A short search string built from the strongest terms.

    Deliberately short: hub search engines treat extra words as extra AND-ish
    constraints, and a six-word query reliably returns nothing at all.
    """
    pool = [r["name"] for r in profile.get("tags", [])[:6]] or \
           [r["name"] for r in profile.get("terms", [])[:6]]
    return " ".join(pool[:words])


# ------------------------------------------------------------------ daily reel

def daily_reel(limit: int = 40, day: Optional[str] = None) -> list[Moment]:
    """Today's mix: affinity-ranked, but shuffled with a per-day seed.

    Seeded by the date so the same day always gives the same reel — reloading
    the page mid-session should not silently swap the list out from under you —
    while tomorrow is genuinely different. Unplayed moments get a bonus so the
    feed keeps reaching past the same twenty favourites.
    """
    profile = get_profile()
    db = SessionLocal()
    try:
        rows = db.query(Moment).filter(Moment.status == "kept").all()
        if not rows:
            return []
        scored = []
        for m in rows:
            score = affinity(m, profile) * 2.0 + 0.6 * int(m.heat or 0)
            if not (m.play_count or 0):
                score += 1.2
            if m.is_favorite:
                score += 0.8
            scored.append((score, m))

        rng = random.Random(day or date.today().isoformat())
        # Jitter before sorting: a pure affinity sort would serve an identical
        # top ten for weeks, which is the opposite of a daily feed.
        scored = [(s + rng.random() * 1.5, m) for s, m in scored]
        scored.sort(key=lambda pair: -pair[0])
        return [m for _, m in scored[:limit]]
    finally:
        db.close()


# ------------------------------------------------------------------ taste picks

async def taste_picks(*, per_source: int = 6, sources: int = 5,
                      timeout_sec: float = 18.0) -> dict:
    """Live hub search driven by the profile — new material, your signal.

    Sources are chosen by where your moments already come from, then topped up
    with known-rich defaults so a library-only profile still reaches outward.
    Each adapter gets its own timeout and a failure is dropped silently: a
    discovery rail that shows five sources' worth of results is a success even
    when the sixth site is down.
    """
    from .hubs import registry
    registry.init_hubs()

    profile = get_profile()
    query = taste_query(profile)
    if not query:
        return {"query": "", "items": [], "reason":
                "Zatiaľ nemám z čoho čítať tvoj vkus — ohodnoť pár momentov 🔥."}

    known = {r["name"] for r in profile.get("sources", [])}
    picked = [s for s in known if registry.get(s) is not None]
    for fallback in ("eporner", "porntrex", "xhamster", "whoreshub", "camwhores"):
        if len(picked) >= sources:
            break
        if fallback not in picked and registry.get(fallback) is not None:
            picked.append(fallback)
    picked = picked[:sources]

    async def one(source: str) -> list[dict]:
        adapter = registry.get(source)
        try:
            page = await asyncio.wait_for(
                adapter.search(query, sort="relevance", page=1), timeout=timeout_sec)
        except Exception as exc:  # noqa: BLE001
            logger.info("[studio] taste pick %s failed: %s", source, exc)
            return []
        out = []
        for tile in (page.items or [])[:per_source]:
            row = dict(tile)
            row["source"] = source
            out.append(row)
        return out

    batches = await asyncio.gather(*[one(s) for s in picked], return_exceptions=True)
    items: list[dict] = []
    seen: set[str] = set()
    for batch in batches:
        if isinstance(batch, Exception):
            continue
        for row in batch:
            url = row.get("url") or ""
            if url and url not in seen:
                seen.add(url)
                items.append(row)

    # Interleave sources so the rail does not open with six eporner tiles.
    by_source: dict[str, list[dict]] = {}
    for row in items:
        by_source.setdefault(row["source"], []).append(row)
    woven: list[dict] = []
    for i in range(max((len(v) for v in by_source.values()), default=0)):
        for src in picked:
            bucket = by_source.get(src) or []
            if i < len(bucket):
                woven.append(bucket[i])

    return {"query": query, "items": woven, "sources": picked,
            "confident": profile.get("confident", False), "reason": ""}
