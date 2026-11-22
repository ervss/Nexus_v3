"""Fusion Hub presets — curated multi-tag queries run through Prime Cut.

A preset is a named tag-mix ("deepthroat + big tits + POV") that expands into a
Prime Cut run. It exists because the useful query on these sources is rarely one
word: "deepthroat" alone returns everything ever tagged deepthroat, sorted by
whatever the source felt like, while the intersection of three tags is the thing
actually worth importing.

Why this is a preset table and not just a longer search box
-----------------------------------------------------------
`relevance_score` degrades smoothly for multi-token queries: every token found
scores 0.75, and a partial match scores 0.6 * (matched / total). That is exactly
the behaviour a tag-mix wants — but it also means the DEFAULT bar (0.45) sits in
a bad spot for a 3-tag preset: 2-of-3 tokens scores 0.40 and is dropped, while
1-of-2 scores 0.30. So each preset carries its own `relevance_min`, tuned to how
many tags it mixes, rather than leaving the caller to guess.

Measured live 2026-08-02, `deepthroat big tits` at min_height=1080 returned 27
tiles across 8 sources (eporner, xvideos, spankbang, porntrex, pornhub, tnaflix,
xhamster, noodlemagazine), every one of them 1080p or 4K.

`query` is what the sources are asked. It is deliberately plain space-separated
words, not a boolean expression: every adapter forwards the string to its own
site search, and none of them parse operators. The mixing happens in the scoring,
not in the query syntax.
"""
from __future__ import annotations

from typing import Any, Optional

__all__ = ["PRESETS", "get_preset", "all_presets"]


#: Relevance bars per tag count. A 3-tag preset must not demand all three tokens
#: (0.75) or it throws away good 2-of-3 tiles, and must not sit at the 0.45
#: default either, which lets 1-of-3 (0.20) nowhere near but keeps 2-of-3 (0.40)
#: out by a hair. 0.38 is just under the 2-of-3 score, 0.28 just under 1-of-2.
_BAR_3TAG = 0.38
_BAR_2TAG = 0.28

#: Ordered — the UI renders them in this order. `id` is the API contract and
#: must stay stable; `label` is free to be reworded.
PRESETS: tuple[dict[str, Any], ...] = (
    {
        "id": "deepthroat-bigtits-pov",
        "label": "Deepthroat · Big Tits · POV",
        "query": "deepthroat big tits pov",
        "tags": ("deepthroat", "big tits", "pov"),
        "relevance_min": _BAR_3TAG,
        "icon": "local_fire_department",
    },
    {
        "id": "sloppy-facefuck-deepthroat",
        "label": "Sloppy · Face Fuck · Deepthroat",
        "query": "sloppy face fuck deepthroat",
        "tags": ("sloppy", "face fuck", "deepthroat"),
        "relevance_min": _BAR_3TAG,
        "icon": "water_drop",
    },
    {
        "id": "bbc-deepthroat-bigtits",
        "label": "BBC · Deepthroat · Big Tits",
        "query": "bbc deepthroat big tits",
        "tags": ("bbc", "deepthroat", "big tits"),
        "relevance_min": _BAR_3TAG,
        "icon": "bolt",
    },
    {
        "id": "bimbo-faketits-deepthroat",
        "label": "Bimbo · Fake Tits · Deepthroat",
        "query": "bimbo fake tits deepthroat",
        "tags": ("bimbo", "fake tits", "deepthroat"),
        "relevance_min": _BAR_3TAG,
        "icon": "auto_awesome",
    },
    {
        "id": "pov-blowjob-faketits",
        "label": "POV · Blowjob · Fake Tits",
        "query": "pov blowjob fake tits",
        "tags": ("pov", "blowjob", "fake tits"),
        "relevance_min": _BAR_3TAG,
        "icon": "videocam",
    },
    {
        "id": "sloppy-bbc-bimbo",
        "label": "Sloppy · BBC · Bimbo",
        "query": "sloppy bbc bimbo",
        "tags": ("sloppy", "bbc", "bimbo"),
        "relevance_min": _BAR_3TAG,
        "icon": "whatshot",
    },
    {
        "id": "deepthroat-facefuck",
        "label": "Deepthroat · Face Fuck",
        "query": "deepthroat face fuck",
        "tags": ("deepthroat", "face fuck"),
        "relevance_min": _BAR_2TAG,
        "icon": "flash_on",
    },
    {
        "id": "bigtits-pov-blowjob",
        "label": "Big Tits · POV Blowjob",
        "query": "big tits pov blowjob",
        "tags": ("big tits", "pov", "blowjob"),
        "relevance_min": _BAR_3TAG,
        "icon": "star",
    },
)

_BY_ID = {p["id"]: p for p in PRESETS}


def get_preset(preset_id: str) -> Optional[dict[str, Any]]:
    """The preset row for an id, or None. Case/space tolerant."""
    return _BY_ID.get((preset_id or "").strip().lower())


def all_presets() -> list[dict[str, Any]]:
    """Every preset, shaped for the UI (tags as a list, not a tuple)."""
    return [
        {
            "id": p["id"],
            "label": p["label"],
            "query": p["query"],
            "tags": list(p["tags"]),
            "relevance_min": p["relevance_min"],
            "icon": p.get("icon", "bolt"),
        }
        for p in PRESETS
    ]
