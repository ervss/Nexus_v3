"""Cross-host "is this the same upload?" matching.

Python port of the Link Tester's client-side dedupe logic
(app/templates/tester.html: dupeFactsFor / thumbFingerprint / looksLikeSameVideo),
kept here as the one server-side copy so every import path — the dashboard's
fast-import, Source Boards, Forum Hub, the Link Tester's bulk import, and
whatever imports next — resolves "have I already got this?" the same way.

The problem this solves: a re-host on bunkr/pixeldrain/filester/etc. rarely
matches byte-for-byte. The URL always differs, the runtime can drift a second
or two through re-encoding, and each host generates its OWN thumbnail from its
own frame grab — so naive matching on any single field misses real matches or
merges unrelated ones. See the Link Tester's on-screen verification (three
cross-host pairs found, zero false merges on lookalike-but-different clips)
for the empirical basis of these thresholds.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

_HOST_SUFFIX_RE = re.compile(
    r"\s*[|–—-]\s*(bunkr|filester|pixeldrain|turbo\.?cr|gofile)\b.*$",
    re.IGNORECASE,
)
_EXT_RE = re.compile(r"\.(mp4|mkv|webm|mov|m4v|avi|ts)$", re.IGNORECASE)
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_THUMB_EXT_RE = re.compile(r"\.(jpe?g|png|webp|gif|svg)$", re.IGNORECASE)
_GENERIC_SINGLE_TITLE_RE = re.compile(
    r"^(?:bez\s+názvu|untitled|external\s+link|>external\s+link!<|no\s+title|video|clip|file|album|folder|playlist|priečinok|súbor)(?:\s*#?\d+|\s*\([^)]*\))?$",
    re.IGNORECASE,
)
_GENERIC_HOST_CONTAINER_RE = re.compile(
    r"^(?:(?:go\s*file|bunkr|bunkrr|filester|fileditch|pixeldrain|turbo(?:\.?cr)?|erome|cyberdrop|cyberfile|xxbrits|xvideos|eporner|whoreshub)\s+)+(?:priečinok|folder|album|playlist|video|clip|file|súbor)(?:\s*\(\s*\d+\s*(?:videos?|vide[aoí]|files?|súbor(?:y|ov)?|items?|položiek)?\s*\))?$",
    re.IGNORECASE,
)
_GENERIC_THUMB_LEAVES = frozenset({
    "thumb", "thumbnail", "poster", "preview", "cover", "logo", "default",
    "placeholder", "no-thumb", "nothumb", "image", "img", "index", "video",
})

# A key shorter than this ("video", "clip", a lone id) is common enough across
# unrelated uploads that trusting it would over-merge — same floor as the
# tester's client-side version.
_MIN_NAME_KEY_LEN = 8


def is_generic_container_title(title: str) -> bool:
    """True for placeholder/host labels like 'Turbo album' or 'GoFile priečinok'."""
    label = (title or "").strip()
    if not label:
        return True
    return bool(_GENERIC_SINGLE_TITLE_RE.match(label) or _GENERIC_HOST_CONTAINER_RE.match(label))


def media_name_key(title: str, url: str = "") -> str:
    """Reduce a title (or, failing that, a URL's last path segment) to a
    comparable key: strip the extension, any host suffix a card appends
    (" | Bunkr", " — turbo.cr"), and non-alphanumerics. Empty/too-short keys
    are discarded rather than returned, since they're what would cause
    unrelated clips ("video.mp4" vs "video.mp4") to falsely match.
    """
    base = (title or "").strip()
    if is_generic_container_title(base):
        return ""
    if not base and url:
        try:
            path = urlparse(url).path
            base = path.rsplit("/", 1)[-1]
        except Exception:
            base = ""
    if not base:
        return ""
    base = _HOST_SUFFIX_RE.sub("", base)
    base = _EXT_RE.sub("", base)
    base = _NON_ALNUM_RE.sub("", base.lower())
    return base if len(base) >= _MIN_NAME_KEY_LEN else ""


def thumb_fingerprint(url: str) -> str:
    """Identical stills served from different CDN nodes differ only in host
    and query string, so compare the stable part: the last path segment."""
    if not url or url == "/static/no-thumb.png":
        return ""
    try:
        path = urlparse(url).path
        leaf = path.rsplit("/", 1)[-1] if path else ""
        stem = _THUMB_EXT_RE.sub("", leaf).lower()
        if not stem or len(stem) < 6 or stem in _GENERIC_THUMB_LEAVES:
            return ""
        return stem
    except Exception:
        return ""


@dataclass
class MediaFacts:
    """The evidence used to decide "same upload?" for one candidate. Mirrors
    the tester's dupeFactsFor() shape so the two implementations stay easy to
    compare/keep in sync."""
    name: str = ""
    thumb_fp: str = ""
    size_bytes: int = 0
    duration_sec: float = 0.0
    height: int = 0

    @classmethod
    def from_fields(
        cls,
        *,
        title: str = "",
        url: str = "",
        thumbnail: str = "",
        size_bytes: Optional[float] = None,
        duration: Optional[float] = None,
        height: Optional[float] = None,
    ) -> "MediaFacts":
        def num(v) -> float:
            try:
                f = float(v or 0)
                return f if f > 0 else 0.0
            except (TypeError, ValueError):
                return 0.0

        return cls(
            name=media_name_key(title, url),
            thumb_fp=thumb_fingerprint(thumbnail),
            size_bytes=int(num(size_bytes)),
            duration_sec=num(duration),
            height=int(num(height)),
        )


def looks_like_same_video(a: MediaFacts, b: MediaFacts) -> bool:
    """True if `a` and `b` are almost certainly the same upload.

    Priority mirrors the tester exactly:
      1. Filename key, if both sides have one — decisive either way, because
         it is the one signal that survives a cross-host re-upload intact.
      2. Thumbnail fingerprint, if both sides have one — same logic.
      3. Otherwise, size within ~0.3% AND duration within 3s (a real re-host
         lands within a fraction of a percent on size; anything looser starts
         catching unrelated clips from the same shoot).
    """
    if a.name and b.name:
        return a.name == b.name

    if a.thumb_fp and b.thumb_fp:
        return a.thumb_fp == b.thumb_fp

    have_size = a.size_bytes > 0 and b.size_bytes > 0
    have_dur = a.duration_sec > 0 and b.duration_sec > 0
    if not have_size and not have_dur:
        return False

    if have_size and have_dur:
        size_delta = abs(a.size_bytes - b.size_bytes) / max(a.size_bytes, b.size_bytes)
        dur_delta = abs(a.duration_sec - b.duration_sec)
        return size_delta <= 0.003 and dur_delta <= 3
    if have_size:
        size_delta = abs(a.size_bytes - b.size_bytes) / max(a.size_bytes, b.size_bytes)
        return size_delta <= 0.001
    return abs(a.duration_sec - b.duration_sec) <= 1
