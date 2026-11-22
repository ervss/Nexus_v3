"""Quality Hunt — find the same clip elsewhere, preferably in higher resolution.

Pipeline:
  1. Parse identity from a messy filename/title (scene, studio, date, quality).
  2. Search library + sniper sources + optional Yandex CBIR.
  3. Fuse independent evidence signals (scene, studio/date, duration, visual).
  4. Cluster mirrors into Better / Other / Maybe groups for the panel.
"""
from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse, unquote, parse_qsl

from .media_match import media_name_key, thumb_fingerprint

logger = logging.getLogger(__name__)

def _dbg(hypothesis_id: str, message: str, data: Dict[str, Any]) -> None:
    logger.debug("[quality_hunt] %s %s %s", hypothesis_id, message, data)

# ── constants ────────────────────────────────────────────────────────────────

SNIPER_SOURCES = [
    "hqporner",
    "spankbang",
    "pornhub",
    "xvideos",
    "xhamster",
    "eporner",
    "porntrex",
    "noodlemagazine",
    "simpcity",
    "reddit",
    "camwhores",
    "whoreshub",
    "pornone",
    "pimpbunny",
    "hornysimp",
    "ixxx",
    "fpo",
    "internetchicks",
]

# Embed-only hosts: no usable thumbs or player in the hunt window.
HUNT_SKIP_SOURCES = frozenset({"leakporner", "mypornerleak", "pornerleak"})
HUNT_SKIP_HOSTS = ("leakporner.", "mypornerleak.")

VISUAL_CONFIRM_SCORE = 55  # matches _visual_rank_results "same frame" tier
VISUAL_WEAK_SCORE = 30
DURATION_PCT = 0.08
DURATION_FLOOR_SEC = 20.0
MIN_CONFIRMED_BEFORE_WIDE = 3
MIN_DISTINCT_SOURCES = 5
PROBE_TOP_N = 8
CACHE_TTL_SEC = 3600
JOB_TTL_SEC = 1800

_SOFT_BRACKET_TAGS = frozenset({
    "hd", "sd", "uhd", "fhd", "fullhd", "full", "hq", "lq", "cam", "ts",
    "xxx", "porn", "nsfw", "uncensored", "censored", "eng", "engsub",
    "multi", "dual", "sub", "soft", "hard",
})
_CODEC_TAGS = frozenset({
    "x264", "x265", "h264", "h265", "hevc", "avc", "aac", "ac3", "mp3",
    "opus", "vp9", "av1", "webm", "mkv", "mp4", "mov",
})
_QUALITY_RE = re.compile(
    r"(?:^|[\s\[\(\._-])(2160|1440|1080|720|480|360|240)\s*p?\b|(?:^|[\s\[\(\._-])(4k|8k)\b",
    re.I,
)
_DATE_RE = re.compile(
    r"(?:^|[\s\[\(\._-])("
    r"\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}"
    r"|"
    r"\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}"
    r")(?:$|[\s\]\)\._-])"
)
_BRACKET_RE = re.compile(r"[\[\(]([^\]\)]{1,60})[\]\)]")
_EXT_RE = re.compile(r"\.(mp4|mkv|webm|mov|m4v|avi|ts)$", re.I)
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_WORD_RE = re.compile(r"[a-z0-9]+")
_STOP = frozenset({
    "the", "a", "an", "and", "of", "with", "her", "his", "in", "on", "to",
    "for", "gets", "get", "from", "hd", "4k", "1080p", "720p", "480p",
    "porn", "video", "scene", "full", "xxx", "mp4", "mkv", "webm",
})
_PLATFORM_RE = re.compile(
    r'\b(?:'
    r'[0o]nly\s*f[@a4]ns(?:\.com)?|f[@a4]nsly(?:\.com)?|m[@a4]nyvids|ch[@a4]turb[@a4]te|'
    r'stripchat|bongacams|camsoda|justforfans|loyalfans|patreon|'
    r'camwhores(?:\s*\.\s*tv)?|pornhub|xvideos|xhamster|spankbang|eporner|'
    r'porntrex|noodlemagazine|pimpbunny|whoreshub|filester|bunkr'
    r')\b',
    re.I,
)
_NAME_ACTIONS = frozenset({'makes', 'does', 'feat', 'featuring', 'gets', 'gives', 'receives', 'pussy', 'dildo', 'fuck', 'fucks', 'solo', 'masturbation', 'smoking', 'blowjob'})

_CYRILLIC_MAP = str.maketrans({
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    'і': 'i', 'ї': 'yi', 'є': 'ye', 'ґ': 'g',
})


def _transliterate_text(text: str) -> str:
    low = (text or '').lower()
    return low.translate(_CYRILLIC_MAP) if any('\u0400' <= ch <= '\u04ff' for ch in low) else low


def _phonetic_fold(token: str) -> str:
    t = _transliterate_text(token)
    if len(t) < 4:
        return t
    t = t.replace('yu', 'u').replace('ya', 'a').replace('ye', 'e').replace('ph', 'f')
    t = re.sub(r'(.)\1+', r'\1', t)
    return t


def performer_identity(scene: str) -> str:
    words = scene.split()
    if not words:
        return ''
    # A large class of creator names arrives as a possessive in page titles
    # ("Ssamibaby's ..." / "Ssamibaby’s ...").  Keep the creator token but
    # drop the possessive suffix before matching/searching.  Without this,
    # the title parser returns no performer and the hunt is left with one
    # over-specific query that many mirrors do not index.
    first = words[0].strip('@')
    first = re.sub(r"(?:['’]s|['’])$", "", first, flags=re.I).strip(".,:;!?()[]{}")
    if not first:
        return ''
    # Creator handles preserve a much stronger identity than generic scene tags.
    if re.search(r'[a-z][A-Z]', first) or first != words[0]:
        return first
    if len(words) >= 3 and len(first) >= 6 and re.fullmatch(r'[A-Z][a-z]+', first) and words[1].lower() in _NAME_ACTIONS:
        return first
    if len(words) >= 3 and all(re.fullmatch(r'[A-Z][a-z]{2,}', w) for w in words[:2]) and (words[2].lower() in _NAME_ACTIONS or words[2].isdigit()):
        return ' '.join(words[:2])
    return ''


def _hyphen_performer_hint(raw_title: str) -> str:
    """Extract 'Performer Name - ... - Scene' when explicit hyphen segments are used."""
    cleaned = _EXT_RE.sub('', (raw_title or '').strip())
    cleaned = _PLATFORM_RE.sub(' ', cleaned)
    parts = [re.sub(r'\s+', ' ', p).strip(' []()_.,|') for p in re.split(r'\s+-\s+', cleaned)]
    parts = [p for p in parts if p and not _QUALITY_RE.fullmatch(p) and not _DATE_RE.fullmatch(p)]
    if len(parts) < 2:
        return ''
    head = parts[0]
    head_words = head.split()
    if not (1 <= len(head_words) <= 2):
        return ''
    if not all(re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{2,}', w) for w in head_words):
        return ''
    if len(head_words) == 1 and not re.search(r'[a-z][A-Z]|_|\d', head_words[0]):
        return ''
    rest = ' '.join(parts[1:])
    if len(_tokens(rest)) >= 2 and any(w.islower() for w in rest.split()):
        return head
    return ''


def performer_present(performer: str, title: str) -> bool:
    if not performer or not title:
        return False
    compact = lambda s: _NON_ALNUM_RE.sub('', _transliterate_text(s))
    c_perf = compact(performer)
    c_title = compact(title)
    if c_perf and c_perf in c_title:
        return True
    # Try phonetic/transliterated token match for multi-word names (e.g. Ksyusha Krasivchik vs ksusha / Ксения красивчик)
    p_words = [w for w in _WORD_RE.findall(_transliterate_text(performer)) if len(w) >= 3]
    t_words = _WORD_RE.findall(_transliterate_text(title))
    if not p_words or not t_words:
        return False
    t_folded = {_phonetic_fold(w) for w in t_words}
    if len(p_words) == 1:
        return _phonetic_fold(p_words[0]) in t_folded
    # Require surname/longer token match + first token phonetic or initial match,
    # or a distinctive 8+ character surname/handle token.
    longest = max(p_words, key=len)
    if len(longest) >= 6 and _phonetic_fold(longest) in t_folded:
        if len(longest) >= 8 and longest not in _STOP:
            return True
        others = [w for w in p_words if w != longest]
        if all(_phonetic_fold(o) in t_folded or any(tw.startswith(o[:2]) for tw in t_words) for o in others):
            return True
    return False


def hunt_queries(identity: 'ClipIdentity') -> List[str]:
    """Search the scene first; a performer name alone retrieves unrelated scenes."""
    scene = identity.scene.strip()
    performer = identity.performer or performer_identity(scene)
    queries = [scene] if scene else []
    if performer:
        actions = scene_action_hints(scene)
        if {'oral', 'facial'} <= actions:
            queries.append(f'{performer} blowjob facial')
        performer_words = {
            _NON_ALNUM_RE.sub('', re.sub(r"(?:['’]s|['’])$", '', word.lower()))
            for word in performer.split()
        }
        descriptors = [w for w in scene.split() if w.lower() not in _STOP
            and w.lower() not in _QUERY_FILLER
            and _NON_ALNUM_RE.sub('', re.sub(r"(?:['’]s|['’])$", '', w.lower())) not in performer_words]
        # A shorter, still scene-specific query catches altered upload titles.
        # Bare performer searches are reserved for the visual fallback.
        if len(descriptors) >= 2:
            compact = f'{performer} {" ".join(descriptors[:max(2, min(3, len(descriptors) - 1))])}'
            if compact.lower() != scene.lower():
                queries.append(compact)
        elif descriptors:
            queries.append(f'{performer} {descriptors[0]}')
    return list(dict.fromkeys(queries))[:3]


_ACTION_QUERY_SYNONYMS = {
    'sextape': 'sextape homemade',
    'oral': 'blowjob oral',
    'facial': 'facial cumshot',
    'anal': 'anal',
    'toy': 'dildo solo',
    'hard_sex': 'fuck hardcore',
    'massage': 'massage',
    'lesbian': 'lesbian',
}


def hunt_cascade_queries(identity: 'ClipIdentity') -> List[str]:
    """Relaxed 2nd-tier queries when strict full-scene queries miss altered titles."""
    scene = identity.scene.strip()
    performer = (identity.performer or performer_identity(scene)).strip()
    if not performer:
        return []
    primary_lower = {q.lower() for q in hunt_queries(identity)}
    perf_words = [
        _NON_ALNUM_RE.sub('', re.sub(r"(?:['’]s|['’])$", '', w.lower()))
        for w in performer.split()
    ]
    perf_set = set(perf_words)
    descriptors = [
        w for w in scene.split()
        if w.lower() not in _STOP and w.lower() not in _QUERY_FILLER
        and _NON_ALNUM_RE.sub('', re.sub(r"(?:['’]s|['’])$", '', w.lower())) not in perf_set
    ]
    cascade: List[str] = []
    # 1. Core query: performer + single strongest descriptor word
    if descriptors:
        strongest = max(descriptors, key=len)
        cascade.append(f"{performer} {strongest}")
        # 2. Phonetic or surname variant + strongest descriptor (e.g. Ksusha Krasivchik / Krasivchik ball)
        folded_perf = ' '.join(_phonetic_fold(w) for w in performer.split())
        if folded_perf.lower() != performer.lower():
            cascade.append(f"{folded_perf} {strongest}")
        elif len(perf_words) >= 2:
            longest_name = max(performer.split(), key=len)
            if len(longest_name) >= 7:
                cascade.append(f"{longest_name} {strongest}")
    # 3. Performer + detected action category synonym
    for act in sorted(scene_action_hints(scene)):
        syn = _ACTION_QUERY_SYNONYMS.get(act)
        if syn:
            cascade.append(f"{performer} {syn.split()[0]}")
            break
    out: List[str] = []
    seen = set(primary_lower)
    for q in cascade:
        ql = q.strip().lower()
        if ql and ql not in seen:
            seen.add(ql)
            out.append(q.strip())
    return out[:2]


# ── identity ─────────────────────────────────────────────────────────────────

@dataclass
class ClipIdentity:
    raw_title: str = ""
    scene: str = ""
    studio: str = ""
    date: str = ""
    quality_height: int = 0
    duration_sec: float = 0.0
    height: int = 0
    size_bytes: int = 0
    page_url: str = ""
    thumbnail_url: str = ""
    poster_url: str = ""
    performer: str = ""

    @property
    def effective_height(self) -> int:
        return int(self.height or self.quality_height or 0)

    @property
    def scene_tokens(self) -> Set[str]:
        return _tokens(self.scene or self.raw_title)


def parse_title_identity(raw: str) -> ClipIdentity:
    """Pull scene / studio / date / quality out of a messy release filename."""
    original = (raw or "").strip()
    text = original
    text = _EXT_RE.sub("", text)

    quality_height = 0
    for m in _QUALITY_RE.finditer(text):
        g = (m.group(1) or m.group(2) or "").lower()
        if g in ("4k",):
            quality_height = max(quality_height, 2160)
        elif g in ("8k",):
            quality_height = max(quality_height, 4320)
        else:
            try:
                quality_height = max(quality_height, int(g))
            except ValueError:
                pass

    date = ""
    dm = _DATE_RE.search(text)
    if dm:
        date = dm.group(1).strip(" .-_/")

    studio = ""
    soft_or_noise: List[str] = []
    for m in _BRACKET_RE.finditer(text):
        inner = m.group(1).strip()
        low = inner.lower().replace(" ", "")
        low_spaced = inner.lower().strip()
        if low in _SOFT_BRACKET_TAGS or low_spaced in _SOFT_BRACKET_TAGS:
            soft_or_noise.append(m.group(0))
            continue
        if low in _CODEC_TAGS or re.fullmatch(r"x?26[45]|h\.?26[45]|hevc|avc", low):
            soft_or_noise.append(m.group(0))
            continue
        if _QUALITY_RE.search(inner) and len(inner) <= 8:
            soft_or_noise.append(m.group(0))
            continue
        if _DATE_RE.search(f" {inner} "):
            soft_or_noise.append(m.group(0))
            continue
        # Short all-alpha bracket without spaces → often release group (oforus)
        if re.fullmatch(r"[A-Za-z0-9._-]{2,14}", inner) and " " not in inner:
            # Prefer longer CamelCase / Media-looking tokens as studio
            if any(c.isupper() for c in inner[1:]) or "media" in low or len(inner) >= 8:
                if not studio:
                    studio = inner
                soft_or_noise.append(m.group(0))
                continue
            soft_or_noise.append(m.group(0))
            continue
        if " " in inner or any(c.isupper() for c in inner[1:]):
            if not studio:
                studio = inner
            soft_or_noise.append(m.group(0))
            continue
        soft_or_noise.append(m.group(0))

    scene = text
    for junk in soft_or_noise:
        scene = scene.replace(junk, " ")
    if date:
        scene = re.sub(re.escape(date), " ", scene, flags=re.I)
    scene = _QUALITY_RE.sub(" ", scene)
    scene = _PLATFORM_RE.sub(' ', scene)
    scene = re.sub(r"[\[\]\(\)_./\\-]+", " ", scene)
    scene = re.sub(r"\s+", " ", scene).strip(" -_|")

    performer = performer_identity(scene) or _hyphen_performer_hint(original)
    return ClipIdentity(
        raw_title=original,
        scene=scene or original,
        studio=studio,
        date=date,
        quality_height=quality_height,
        performer=performer,
    )


def _tokens(title: str) -> Set[str]:
    title = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', title or '')
    return {
        w for w in _WORD_RE.findall(_transliterate_text(title))
        if len(w) > 2 and w not in _STOP
    }


def scene_overlap(a: str, b: str) -> float:
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _height_from_quality_label(value: Any) -> int:
    text = str(value or "")
    if re.search(r"\b4k\b", text, re.I):
        return 2160
    match = re.search(r"(2160|1440|1080|720|480)", text)
    return int(match.group(1)) if match else 0


def _parse_height(value: Any, title: str = "") -> int:
    try:
        h = int(float(value or 0))
        if h > 0:
            return h
    except (TypeError, ValueError):
        pass
    return height_from_title(title or "") or _height_from_quality_label(value)


def _parse_duration(value: Any) -> float:
    """Accept seconds as number, or strings like '21:38' / '1:02:03'."""
    if value is None or value == "":
        return 0.0
    if isinstance(value, (int, float)):
        try:
            f = float(value)
            return f if f > 0 else 0.0
        except (TypeError, ValueError):
            return 0.0
    text = str(value).strip()
    if not text:
        return 0.0
    if re.fullmatch(r"\d+(\.\d+)?", text):
        try:
            return float(text)
        except ValueError:
            return 0.0
    if ":" in text:
        parts = text.split(":")
        try:
            nums = [float(p) for p in parts]
        except ValueError:
            return 0.0
        if len(nums) == 3:
            return nums[0] * 3600 + nums[1] * 60 + nums[2]
        if len(nums) == 2:
            return nums[0] * 60 + nums[1]
    return 0.0


def scene_significant_overlap(a: str, b: str) -> bool:
    """True when overlap covers most of the shorter token set (same scene, not just a name)."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return False
    inter = ta & tb
    if not inter:
        return False
    shorter = min(len(ta), len(tb))
    # Generic filler tokens alone must not count as "same scene"
    meaningful = {t for t in inter if t not in {"makes", "make", "bbc", "cum", "sex", "fuck", "hard", "soft"}}
    if len(meaningful) < 2 and len(inter) < 4:
        return False
    if len(inter) == 1:
        only = next(iter(inter))
        if len(only) < 8:
            return False
    return len(inter) / shorter >= 0.55 and scene_overlap(a, b) >= 0.34


_QUERY_FILLER = frozenset({
    "feat", "ft", "featuring", "vs", "vol", "part", "episode", "ep",
    "presents", "starring", "and", "with", "the",
})


def _content_tokens(text: str) -> Set[str]:
    return {t for t in _tokens(text) if t not in _QUERY_FILLER}


def scene_action_hints(text: str) -> Set[str]:
    """Conservative action families for secondary performer recommendations."""
    words = _tokens(text)
    groups = {
        'oral': {'blowjob', 'bj', 'suck', 'sucking', 'oral', 'deepthroat', 'throat'},
        'facial': {'facial', 'cumshot', 'creampie'},
        'toy': {'dildo', 'vibrator', 'toy', 'masturbation'},
        'anal': {'anal', 'assfuck'},
        'massage': {'massage', 'massaging'},
        'ride': {'ride', 'rides', 'riding'},
        # Uploaders routinely rename the same hard-sex scene with a different
        # verb (rammed/smashed/drilled/railed).  Keep this as a secondary
        # scene signal; it must never outrank a title+duration match.
        'hard_sex': {'smashed', 'rammed', 'drilled', 'railed', 'pounded',
                     'wrecked', 'destroyed', 'fucked', 'fucks', 'fucking'},
        'sextape': {'sextape', 'tape', 'leaked', 'leak', 'homemade', 'amateur'},
        'lesbian': {'lesbian', 'girls', 'scissoring'},
    }
    matched = {key for key, aliases in groups.items() if words & aliases}
    if re.search(r'\b(?:gives?|giving|gets?|receives?)\s+head\b', text, re.I):
        matched.add('oral')
    return matched


def _matched_query_tokens(ta: Set[str], tb: Set[str]) -> Set[str]:
    direct = ta & tb
    if len(direct) == len(ta):
        return direct
    tb_folded = {_phonetic_fold(t) for t in tb if len(t) >= 5}
    matched = set(direct)
    for t in ta - direct:
        if len(t) >= 5 and _phonetic_fold(t) in tb_folded:
            matched.add(t)
    return matched


def query_coverage(scene: str, title: str) -> float:
    """Share of the meaningful query that appears in a longer result title.

    Words like feat/ft/vs are ignored so 'Celina Powell Feat CGT' still matches
    a title that only says 'Celina Powell'.
    """
    ta = _content_tokens(scene) or _tokens(scene)
    tb = _content_tokens(title) or _tokens(title)
    if not ta or not tb:
        return 0.0
    return len(_matched_query_tokens(ta, tb)) / len(ta)


def scene_query_hit(scene: str, title: str) -> bool:
    """Same scene, including a short title buried in a longer upload name."""
    if scene_significant_overlap(scene, title):
        return True
    ta = _content_tokens(scene) or _tokens(scene)
    tb = _content_tokens(title) or _tokens(title)
    if not ta or not tb:
        return False
    inter = _matched_query_tokens(ta, tb)
    if len(inter) < 2 and not (len(inter) == 1 and len(next(iter(inter))) >= 8):
        return False
    if len(inter) / len(ta) >= 0.66:
        return True
    # Performer pair: the two longest query words both present (other scenes of
    # the same people still belong in Maybe, ranked below a full title hit).
    longest = sorted(ta, key=len, reverse=True)[:2]
    tb_folded = tb | {_phonetic_fold(t) for t in tb if len(t) >= 5}
    return len(longest) == 2 and all((tok in tb or (len(tok) >= 5 and _phonetic_fold(tok) in tb_folded)) for tok in longest) and min(len(t) for t in longest) >= 4


_STANDARD_HEIGHTS = (240, 360, 480, 540, 720, 1080, 1440, 2160, 4320)


def snap_height(height: int) -> int:
    """Map a player pixel height onto a real resolution. Odd values like 1252 are ignored."""
    h = int(height or 0)
    if h <= 0:
        return 0
    for std in _STANDARD_HEIGHTS:
        if abs(h - std) <= max(40, int(std * 0.08)):
            return std
    return 0


# ── candidates & evidence ────────────────────────────────────────────────────

def page_identity(url: str) -> Tuple:
    """Identify a watch page across canonical/search URL variants."""
    parsed = urlparse(str(url or '').strip())
    host = (parsed.hostname or '').lower()
    host = re.sub(r'^(?:www\.|m\.)', '', host)
    path = unquote(parsed.path).rstrip('/')
    if host == 'eporner.com':
        match = re.match(r'^/(?:video-|hd-porn/|embed/)([A-Za-z0-9]+)(?:/|$)', path)
        if match:
            return host, match.group(1)
    if host.startswith('camwhores.'):
        match = re.match(r'^/videos/(\d+)(?:/|$)', path)
        if match:
            return 'camwhores.tv', match.group(1)
    # Retain identity-bearing query parameters; ignore tracking and fragments.
    keys = tuple(sorted((k, v) for k, v in parse_qsl(parsed.query) if k in {'v', 'id', 'video_id'}))
    return host, parsed.port, path, keys


_NON_VIDEO_PATH_RE = re.compile(
    r'^/(?:search(?:/|$)|s(?:/|$)|tags?(?:/|$)|categor(?:y|ies)(?:/|$)|'
    r'pornstars(?:/|$)|models(?:/|$)|channels(?:/|$)|users(?:/|$)|'
    r'profiles(?:/|$)|albums(?:/|$)|galleries(?:/|$)|photos(?:/|$)|'
    r'pics(?:/|$)|images(?:/|$))',
    re.I,
)
_NON_VIDEO_TITLE_RE = re.compile(
    r"^(?:most relevant for:|search results for|'.+?' search\s*-|videos tagged with\b)|"
    r"\bsearch\s*[-–|]\s*(?:xvideos|pornhub|xhamster|spankbang|porntrex|eporner|pimpbunny)\b",
    re.I,
)


def _is_non_video_hunt_hit(url: str, title: str, hit: Dict[str, Any]) -> bool:
    if hit.get('kind') == 'image':
        return True
    parsed = urlparse(url)
    path = unquote(parsed.path or '')
    if _NON_VIDEO_TITLE_RE.search(title or ''):
        return True
    # Query-based search pages on tube sites (e.g. xvideos.com/?k=..., spankbang.com/s/...)
    query_keys = {k.lower() for k, _ in parse_qsl(parsed.query)}
    if (path in ('', '/') and ('k' in query_keys or 'q' in query_keys or 'search' in query_keys)):
        return True
    if _NON_VIDEO_PATH_RE.search(path) and not re.search(r'/(?:video|watch|embed|vid|v)[s/_-]', path, re.I):
        return True
    return False


def is_original_page(identity: ClipIdentity, url: str) -> bool:
    return bool(identity.page_url and page_identity(identity.page_url) == page_identity(url))

@dataclass
class HuntCandidate:
    url: str
    title: str = ""
    source: str = ""
    thumbnail: str = ""
    duration_sec: float = 0.0
    height: int = 0
    height_source: str = "unknown"
    stream_url: str = ""
    is_hls: bool = False
    size_bytes: int = 0
    upload_date: str = ""
    visual_score: Optional[float] = None
    match_coverage: float = 0.0
    signals: List[str] = field(default_factory=list)
    confirmed: bool = False
    match_status: str = "possible"
    quality_status: str = "unknown"
    reason: str = ""
    library_id: Optional[int] = None
    from_library: bool = False
    requires_login: bool = False
    discovered_at: float = field(default_factory=time.time)
    metadata_status: str = 'pending'
    metadata_reason: str = ''
    metadata_checked_at: float = 0
    visual_status: str = 'pending'
    visual_reason: str = ''
    visual_checked_at: float = 0
    availability_state: str = 'unknown'
    availability_reason: str = ''
    availability_checked_at: float = 0
    identity_state: str = 'unverified'
    variant_kind: str = ''
    rejection_reason: str = ''

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d['id'] = hashlib.sha256(repr(page_identity(self.url)).encode()).hexdigest()[:20]
        d['quality_state'] = ('measured' if self.height and self.height_source in {'metadata', 'library'}
            else 'estimated' if self.height else 'unknown')
        d['availability_state'] = 'login_required' if self.requires_login and self.availability_state != 'playable' else self.availability_state
        d['evidence'] = [
            {'kind': signal, 'source': 'local_phash' if signal == 'thumbnail' else
                'metadata' if signal == 'duration' and self.metadata_status == 'ok' else self.source or 'search',
             'checked_at': self.visual_checked_at if signal == 'thumbnail' else
                self.metadata_checked_at if signal == 'duration' and self.metadata_status == 'ok' else self.discovered_at,
             'reason': self.reason} for signal in self.signals
        ]
        if self.height:
            d['evidence'].append({'kind': 'resolution', 'source': self.height_source,
                'checked_at': self.metadata_checked_at or self.discovered_at,
                'reason': f'{self.height}p', 'value': self.height})
        d['verification'] = {
            'metadata': {'status': self.metadata_status, 'reason': self.metadata_reason, 'checked_at': self.metadata_checked_at},
            'visual': {'status': self.visual_status, 'reason': self.visual_reason, 'checked_at': self.visual_checked_at},
            'availability': {'status': ('pending' if not self.availability_checked_at else
                'unverified' if self.availability_reason.startswith('Playlist dostupný') else
                'error' if d['availability_state'] == 'unknown' else 'ok'),
                'reason': self.availability_reason, 'checked_at': self.availability_checked_at},
        }
        return d


def duration_within(a: float, b: float) -> bool:
    if a <= 0 or b <= 0:
        return False
    window = max(2.0, min(DURATION_FLOOR_SEC, DURATION_PCT * max(a, b)))
    return abs(a - b) <= window


def height_from_title(title: str) -> int:
    ident = parse_title_identity(title or "")
    return int(ident.quality_height or 0)


def fuse_evidence(
    identity: ClipIdentity,
    candidate: HuntCandidate,
    *,
    ref_thumb_fp: str = "",
) -> HuntCandidate:
    """Separate exact runtime matches, plausible edits and actor-only results."""
    signals: List[str] = []
    cand_title = candidate.title or ""
    candidate.match_coverage = query_coverage(identity.scene, cand_title)
    performer = identity.performer or performer_identity(identity.scene)
    name_matches = performer_present(performer, cand_title)
    similar_action = bool(name_matches and scene_action_hints(identity.scene) & scene_action_hints(cand_title))
    if name_matches:
        signals.append('performer')

    # Scene overlap. Short queries ("Celina Powell 3") fail Jaccard against
    # long titles even when every query token is present.
    cand_tokens = _content_tokens(cand_title)
    descriptors = _content_tokens(identity.scene) - _content_tokens(performer)
    matched_descriptors = _matched_query_tokens(descriptors, cand_tokens)
    descriptor_hit = not descriptors or bool(matched_descriptors)
    pivot_tokens: Set[str] = getattr(identity, '_pivot_tokens', None) or set()
    pivot_hit = bool(pivot_tokens and _matched_query_tokens(pivot_tokens, cand_tokens))
    visual_similar_env = (
        candidate.visual_score is not None
        and VISUAL_WEAK_SCORE <= candidate.visual_score < VISUAL_CONFIRM_SCORE
    )
    if scene_query_hit(identity.scene, cand_title) and (not performer or (name_matches and descriptor_hit)):
        signals.append("scene")
    if similar_action or (name_matches and (visual_similar_env or pivot_hit)):
        signals.append('similar_scene')
        similar_action = True
    if pivot_hit:
        candidate.match_coverage = max(candidate.match_coverage, 0.55)

    # Studio / date from identity present in candidate title
    if identity.studio:
        studio_key = _NON_ALNUM_RE.sub("", identity.studio.lower())
        cand_key = _NON_ALNUM_RE.sub("", cand_title.lower())
        if studio_key and studio_key in cand_key:
            signals.append("studio")
    if identity.date:
        date_compact = re.sub(r"[^\d]", "", identity.date)
        cand_digits = re.sub(r"[^\d]", "", cand_title)
        # Accept same digits in any punctuation form
        if len(date_compact) >= 6 and date_compact in cand_digits:
            signals.append("date")
        else:
            # Also try YYMMDD reorder variants loosely via substring of day+month+year pieces
            parts = re.findall(r"\d+", identity.date)
            if len(parts) >= 3 and all(p in cand_title for p in parts):
                signals.append("date")

    # Duration
    if duration_within(identity.duration_sec, candidate.duration_sec):
        signals.append("duration")

    # URL filenames are not image evidence (many unrelated clips use poster.jpg).
    if candidate.visual_score is not None and candidate.visual_score >= VISUAL_CONFIRM_SCORE:
        signals.append("thumbnail")

    # Deduplicate while preserving order
    seen: Set[str] = set()
    ordered: List[str] = []
    for s in signals:
        if s not in seen:
            seen.add(s)
            ordered.append(s)

    # Hard veto: duration broken AND scene clearly different AND weak/no visual
    scene_ok = "scene" in ordered
    dur_broken = (
        identity.duration_sec > 0
        and candidate.duration_sec > 0
        and not duration_within(identity.duration_sec, candidate.duration_sec)
    )
    visual_bad = (
        candidate.visual_score is not None
        and candidate.visual_score < VISUAL_WEAK_SCORE
    )
    if dur_broken and not scene_ok and visual_bad:
        ordered = []

    candidate.signals = ordered
    query_tokens = _content_tokens(identity.scene)
    query_numbers = set(re.findall(r"\b\d+\b", identity.scene))
    result_numbers = set(re.findall(r"\b\d+\b", parse_title_identity(cand_title).scene))
    numbered_conflict = bool(query_numbers and result_numbers and query_numbers != result_numbers)
    strong_scene = (
        "scene" in ordered and candidate.match_coverage >= 0.9
        and len(query_tokens) + len(query_numbers) >= 3 and query_numbers <= result_numbers
        and not numbered_conflict
    )
    # A renamed mirror often drops the partner or a grammatical filler from
    # its title.  Surface it as a candidate for review when at least three
    # meaningful tokens still agree, without certifying it as the same clip.
    likely_scene = (
        "scene" in ordered and candidate.match_coverage >= 0.66
        and len(_matched_query_tokens(_content_tokens(identity.scene), cand_tokens)) >= 3
        and not numbered_conflict
    )
    visual_ok = "thumbnail" in ordered
    visual_rescue = (
        candidate.visual_score is not None and candidate.visual_score >= 42.0
        and ("duration" in ordered or ( descriptors and bool(matched_descriptors) ) or pivot_hit)
    )
    candidate.confirmed = not dur_broken and not numbered_conflict and (
        (strong_scene and ("duration" in ordered or visual_ok))
        or (visual_ok and "duration" in ordered)
    )
    candidate.match_status = "confirmed" if candidate.confirmed else "possible"
    candidate.rejection_reason = ''
    candidate.variant_kind = ''
    if candidate.confirmed:
        candidate.identity_state = 'confirmed'
    elif dur_broken and strong_scene and visual_ok:
        candidate.identity_state = 'variant'
        candidate.variant_kind = 'shorter' if candidate.duration_sec < identity.duration_sec else 'longer'
    elif not numbered_conflict and (strong_scene or likely_scene or visual_ok or visual_rescue):
        # Title-only cuts are candidates, never certified copies.
        candidate.identity_state = 'possible'
    elif (similar_action or pivot_hit) and not numbered_conflict:
        candidate.identity_state = 'similar'
    elif name_matches:
        candidate.identity_state = 'related'
    else:
        candidate.identity_state = 'unverified'
    if not candidate.confirmed and (
        numbered_conflict or (performer and not name_matches and not visual_ok and not visual_rescue and not pivot_hit and cand_title)
    ):
        candidate.identity_state = 'rejected'
        candidate.variant_kind = ''
        candidate.rejection_reason = 'Odlišné číslo časti alebo identita scény'
    if re.search(r'\b(?:explore full videos at|this video is only available at|watch full video at)\b', cand_title, re.I):
        candidate.confirmed = False
        candidate.match_status = 'rejected'
        candidate.identity_state = 'rejected'
        candidate.variant_kind = ''
        candidate.rejection_reason = 'Propagačná ukážka namiesto hľadaného videa'
    candidate.reason = _format_reason(identity, candidate, ordered)

    # Fill height from title if missing
    if not candidate.height:
        candidate.height = height_from_title(cand_title)
        if candidate.height:
            candidate.height_source = "title"
    candidate.quality_status = quality_status(identity, candidate)

    return candidate


def _format_reason(identity: ClipIdentity, cand: HuntCandidate, signals: List[str]) -> str:
    parts: List[str] = []
    labels = {
        "performer": "rovnaký tvorca",
        "scene": "scéna",
        "similar_scene": "podobný typ scény (nie zhoda videa)",
        "studio": "štúdio",
        "date": "dátum",
        "duration": "dĺžka",
        "thumbnail": "náhľad",
    }
    for s in signals:
        if s == "duration" and identity.duration_sec and cand.duration_sec:
            parts.append(
                f"dĺžka {_fmt_dur(identity.duration_sec)} vs {_fmt_dur(cand.duration_sec)}"
            )
        elif s == "thumbnail" and cand.visual_score is not None:
            parts.append("podobný obraz")
        else:
            parts.append(labels.get(s, s))
    if identity.duration_sec and cand.duration_sec and not duration_within(identity.duration_sec, cand.duration_sec):
        parts.append("odlišná dĺžka – skontroluj zostrih")
    return " + ".join(parts) if parts else "zhoda nepotvrdená"


def _fmt_dur(sec: float) -> str:
    s = int(round(sec))
    return f"{s // 60}:{s % 60:02d}"


def is_better_quality(identity: ClipIdentity, cand: HuntCandidate) -> bool:
    return cand.confirmed and quality_status(identity, cand) == "higher"


def quality_status(identity: ClipIdentity, cand: HuntCandidate) -> str:
    if not identity.height or not cand.height:
        return "unknown"
    if cand.height_source not in {"metadata", "library"}:
        return "estimated"
    if cand.height > identity.height:
        return "higher"
    return "same" if cand.height == identity.height else "lower"


def _cluster_key(title: str, url: str, duration_sec: float = 0.0, visual_score: Optional[float] = None) -> str:
    """Name key with quality tokens stripped so 720p/1080p mirrors still group."""
    cleaned = parse_title_identity(title or "").scene or title
    key = media_name_key(cleaned, url)
    if key:
        return key
    dur_bucket = int(duration_sec // 5) if duration_sec else 0
    vis = int((visual_score or 0) // 10)
    return f"fb:{dur_bucket}:{vis}:{urlparse(url).netloc}"


def cluster_mirrors(candidates: List[HuntCandidate]) -> List[Dict[str, Any]]:
    """Group mirrors of the same upload; pick best height as primary."""
    groups: Dict[str, List[HuntCandidate]] = {}
    order: List[str] = []

    for c in candidates:
        key = _cluster_key(c.title, c.url, c.duration_sec, c.visual_score)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(c)

    cards: List[Dict[str, Any]] = []
    for key in order:
        members = groups[key]
        members.sort(
            key=lambda m: (
                int(m.height_source in {"metadata", "library"}),
                int(m.height or 0),
                int(m.size_bytes or 0),
                float(m.visual_score or 0),
            ),
            reverse=True,
        )
        primary = members[0]
        mirrors = [m.to_dict() for m in members[1:]]
        cards.append({
            **primary.to_dict(),
            "mirrors": mirrors,
            "mirror_count": len(members),
            "cluster_key": key,
        })
    return cards


def bucket_cards(
    identity: ClipIdentity,
    candidates: List[HuntCandidate],
) -> Dict[str, List[Dict[str, Any]]]:
    candidates = [c for c in candidates if not is_original_page(identity, c.url)]
    confirmed = [c for c in candidates if c.confirmed]
    # Equal runtime, studio or date cannot make an unrelated video relevant.
    maybe_raw = [c for c in candidates if not c.confirmed and (
        'thumbnail' in c.signals or ('scene' in c.signals and c.match_coverage >= 0.9)
    )]

    # Cluster all confirmed first so 720 mirrors join the 1080 primary card
    confirmed_cards = cluster_mirrors(confirmed)

    better: List[Dict[str, Any]] = []
    other: List[Dict[str, Any]] = []
    for card in confirmed_cards:
        # Rebuild a lightweight candidate view for is_better_quality
        primary = HuntCandidate(
            url=card["url"],
            title=card.get("title") or "",
            source=card.get("source") or "",
            thumbnail=card.get("thumbnail") or "",
            duration_sec=float(card.get("duration_sec") or 0),
            height=int(card.get("height") or 0),
            height_source=card.get("height_source") or "unknown",
            size_bytes=int(card.get("size_bytes") or 0),
            visual_score=card.get("visual_score"),
            signals=list(card.get("signals") or []),
            confirmed=True,
            reason=card.get("reason") or "",
        )
        if is_better_quality(identity, primary):
            better.append(card)
        else:
            other.append(card)

    def _card_rank(card: Dict[str, Any]) -> Tuple:
        return (
            len(card.get("signals") or []),
            float(card.get("match_coverage") or 0),
            float(card.get("visual_score") or 0),
            int(card.get("height") or 0),
            int(card.get("size_bytes") or 0),
        )

    better.sort(key=_card_rank, reverse=True)
    other.sort(key=_card_rank, reverse=True)
    maybe = cluster_mirrors(maybe_raw)
    maybe.sort(key=_card_rank, reverse=True)

    return {
        "better": better,
        "other": other,
        "maybe": maybe[:40],
    }


def source_domain(url: str) -> str:
    host = (urlparse(url).hostname or '').lower().removeprefix('www.')
    parts = host.split('.')
    # Ignore CDN/mobile/language subdomains when counting independent sources.
    suffix = '.'.join(parts[-2:])
    if suffix.startswith('camwhores.'):
        return 'camwhores.tv'
    if suffix in {'co.uk', 'com.au', 'co.jp', 'com.br'}:
        return '.'.join(parts[-3:])
    return suffix if len(parts) > 2 else host


def source_coverage(groups: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    confirmed, relevant = set(), set()
    for key, cards in groups.items():
        for card in cards:
            for item in [card, *(card.get('mirrors') or [])]:
                host = source_domain(item.get('url') or '')
                if not host:
                    continue
                relevant.add(host)
                if key in {'better', 'other'}:
                    confirmed.add(host)
    return {'target': MIN_DISTINCT_SOURCES, 'confirmed_sources': sorted(confirmed),
        'candidate_sources': sorted(relevant), 'target_met': len(confirmed) >= MIN_DISTINCT_SOURCES}


# ── jobs & cache ─────────────────────────────────────────────────────────────

FAILED_STATUSES = {'timeout', 'rate_limited', 'auth_required', 'parse_error', 'unavailable', 'error', 'cancelled'}


def diagnostic_status(item: Dict[str, Any]) -> str:
    status = item.get('status') or 'unavailable'
    reason = str(item.get('error') or '').lower()
    if status in {'error', 'skip'} and reason:
        if '429' in reason or 'rate limit' in reason:
            return 'rate_limited'
        if '401' in reason or '403' in reason or 'login' in reason:
            return 'auth_required'
        if 'timeout' in reason or 'timeouterror' in reason:
            return 'timeout'
        if 'parse' in reason or 'json' in reason:
            return 'parse_error'
        return 'unavailable' if status == 'error' else status
    return status


def refresh_job(job: Dict[str, Any], candidates: List[HuntCandidate]) -> None:
    identity = ClipIdentity(**job['identity'])
    unique = {}
    for candidate in candidates:
        if is_original_page(identity, candidate.url):
            continue
        fuse_evidence(identity, candidate)
        view = candidate.to_dict()
        previous = unique.get(view['id'])
        if not previous or len(view['signals']) > len(previous['signals']):
            unique[view['id']] = view
    views = list(unique.values())
    job['candidates'] = views
    job['groups'] = bucket_cards(identity, candidates)  # Backward-compatible bridge.
    confirmed = [c for c in views if c['identity_state'] == 'confirmed']
    variants = [c for c in views if c['identity_state'] == 'variant']
    scene_matches = confirmed + variants
    playable = [c for c in scene_matches if c['availability_state'] == 'playable']
    domains = sorted({source_domain(c['url']) for c in scene_matches})
    exact_domains = sorted({source_domain(c['url']) for c in confirmed})
    usable = [c for c in playable if c['quality_state'] == 'measured' and c['quality_status'] == 'higher']
    job['counts'] = {'candidates': len(views), 'confirmed': len(confirmed), 'variants': len(variants),
        'playable': len(playable), 'sources': len(domains), 'improvements': len(usable),
        'unverified': sum(c['identity_state'] in {'unverified', 'possible'} for c in views),
        'possible': sum(c['identity_state'] == 'possible' for c in views),
        'similar': sum(c['identity_state'] == 'similar' for c in views),
        'related': sum(c['identity_state'] == 'related' for c in views),
        'rejected': sum(c['identity_state'] == 'rejected' for c in views)}
    target = job.get('coverage_target', MIN_DISTINCT_SOURCES)
    job['coverage'] = {'target': target, 'confirmed_sources': domains, 'exact_sources': exact_domains,
        'target_met': bool(target and len(domains) >= target)}
    job['usable_improvement'] = bool(usable)
    metrics = job.setdefault('metrics', {})
    elapsed = round(max(0, time.time() - job.get('created_at', time.time())) * 1000)
    if not job.get('cache', {}).get('hit'):
        if job.get('status') == 'running' or 'elapsed_ms' not in metrics:
            metrics['elapsed_ms'] = elapsed
        for key, ready in [('first_candidate_ms', bool(views)), ('first_confirmed_ms', bool(confirmed)),
                ('first_improvement_ms', bool(usable))]:
            if ready:
                metrics.setdefault(key, elapsed)
    balance = job.setdefault('balance', {})
    balance.update(retained=len(views), rejected=job['counts']['rejected'],
        unverified=job['counts']['unverified'],
        metadata_unverified=sum(c['metadata_status'] != 'ok' for c in views),
        visual_unverified=sum(c['visual_status'] != 'ok' for c in views),
        verification_failures=sum(c['metadata_status'] in {'timeout', 'error', 'parse_error', 'empty', 'budget_exhausted'}
            or c['visual_status'] in {'timeout', 'error', 'budget_exhausted'}
            or c['verification']['availability']['status'] == 'error' for c in views))
    balance['provider_parsed'] = sum(d.get('raw_count', d.get('count', 0)) for d in job.get('diagnostics', []))
    balance['provider_identity_filtered'] = sum(d.get('identity_filtered', 0) for d in job.get('diagnostics', []))


def job_response(job: Dict[str, Any]) -> Dict[str, Any]:
    return {key: copy.deepcopy(job.get(key)) for key in ('job_id', 'status', 'identity', 'groups',
        'candidates', 'counts', 'coverage', 'usable_improvement', 'diagnostics', 'steps',
        'balance', 'metrics', 'progress', 'error', 'cache', 'termination_reason')}

_jobs: Dict[str, Dict[str, Any]] = {}
_cache: Dict[str, Dict[str, Any]] = {}
_tasks: Dict[str, asyncio.Task] = {}
MAX_ACTIVE_HUNTS = 3
QUICK_HUNT_TIMEOUT = 75
DEEP_HUNT_TIMEOUT = 150


def _cache_key(identity: ClipIdentity, frame_phash: str = "", *, mode: str = "quick", allow_visual_search: bool = False, visual_only: bool = False) -> str:
    raw = json.dumps(['workbench-v4-scene-versions', asdict(identity), frame_phash, mode, allow_visual_search, visual_only], sort_keys=True)
    return hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()


def _purge_stale() -> None:
    now = time.time()
    dead_jobs = [k for k, v in _jobs.items() if now - v.get("created_at", 0) > JOB_TTL_SEC]
    for k in dead_jobs:
        task = _tasks.get(k)
        if task:
            task.cancel()
        _jobs.pop(k, None)
    dead_cache = [k for k, v in _cache.items() if now - v.get("ts", 0) > CACHE_TTL_SEC]
    for k in dead_cache:
        _cache.pop(k, None)


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    _purge_stale()
    return _jobs.get(job_id)


async def start_hunt(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Create a job and kick off background search. Returns {job_id, status}."""
    _purge_stale()
    identity = _identity_from_payload(payload)
    frames = _decode_frames(payload.get("frames") or payload.get("frame_jpegs") or [])
    single = payload.get("frame_jpeg") or ""
    if single and not frames:
        frames = _decode_frames([single])

    frame_phash = hashlib.sha256(b"".join(frames)).hexdigest() if frames else ""

    mode = "deep" if payload.get("mode") == "deep" else "quick"
    ck = _cache_key(
        identity, frame_phash, mode=mode,
        allow_visual_search=bool(payload.get("allow_visual_search")),
        visual_only=bool(payload.get("visual_only")),
    )
    cached = _cache.get(ck)
    if cached and not payload.get('force_refresh') and not payload.get('retry_job_id') and time.time() - cached.get("ts", 0) < cached.get('ttl', CACHE_TTL_SEC):
        job_id = uuid.uuid4().hex[:12]
        _jobs[job_id] = {
            **copy.deepcopy(cached.get('snapshot') or {}),
            "job_id": job_id,
            "status": cached.get('status', 'done'),
            "created_at": time.time(),
            "identity": asdict(identity),
            "groups": copy.deepcopy(cached["groups"]),
            "diagnostics": cached.get("diagnostics", []),
            "progress": {"phase": "cache", "message": "Z cache"},
            "error": None,
            "_cache_key": ck,
            'coverage_target': payload.get('coverage_target', MIN_DISTINCT_SOURCES),
            'cache': {'hit': True, 'age_sec': round(time.time() - cached['ts'], 1),
                'expires_at': cached['ts'] + cached.get('ttl', CACHE_TTL_SEC), 'kind': cached.get('status', 'done')},
        }
        return {"job_id": job_id, "status": _jobs[job_id]['status'], "cached": True}

    for existing in _jobs.values():
        if existing.get("status") == "running" and existing.get("_cache_key") == ck:
            return {"job_id": existing["job_id"], "status": "running", "cached": False}
    if sum(j.get("status") == "running" for j in _jobs.values()) >= MAX_ACTIVE_HUNTS:
        raise ValueError("Už bežia tri hľadania. Zastav jedno alebo počkaj.")

    job_id = uuid.uuid4().hex[:12]
    _jobs[job_id] = {
        "job_id": job_id,
        "status": "running",
        "created_at": time.time(),
        "identity": asdict(identity),
        "groups": {"better": [], "other": [], "maybe": []},
        "diagnostics": [],
        "progress": {"phase": "start", "message": "Štart"},
        "error": None,
        "_cache_key": ck,
        "_frame_phash": frame_phash,
        "mode": mode,
        'candidates': [], 'counts': {}, 'steps': [],
        'balance': {'fetched': 0, 'original_excluded': 0, 'duplicate': 0, 'source_excluded': 0},
        'coverage_target': payload.get('coverage_target', MIN_DISTINCT_SOURCES),
        'cache': {'hit': False, 'age_sec': 0, 'kind': 'fresh'},
    }
    retry = get_job(str(payload.get('retry_job_id') or ''))
    if payload.get('retry_job_id') and not retry:
        _jobs.pop(job_id, None)
        raise ValueError('Pôvodné hľadanie už nie je dostupné; spusti nové overenie.')
    if retry:
        if retry.get('identity') != asdict(identity):
            _jobs.pop(job_id, None)
            raise ValueError('Opakovanie zlyhaných krokov vyžaduje rovnaké vstupné video.')
        payload['_seed_candidates'] = copy.deepcopy(retry.get('candidates') or [])
        payload['_seed_diagnostics'] = copy.deepcopy([d for d in retry.get('diagnostics', []) if diagnostic_status(d) not in FAILED_STATUSES])
        payload['_retry_sources'] = sorted({d.get('source_key') or d.get('source') for d in retry.get('diagnostics', [])
            if diagnostic_status(d) in FAILED_STATUSES and (d.get('source_key') or d.get('source'))})

    _tasks[job_id] = asyncio.create_task(_run_bounded(job_id, identity, frames, payload))
    return {"job_id": job_id, "status": "running", "cached": False}


def cancel_hunt(job_id: str) -> Optional[Dict[str, Any]]:
    job = get_job(job_id)
    if job and job["status"] == "running":
        job["status"] = "cancelled"
        job['termination_reason'] = 'user_cancelled'
        job["progress"] = {"phase": "cancelled", "message": "Zastavené – priebežné výsledky zostali"}
        task = _tasks.get(job_id)
        if task:
            task.cancel()
    return job


async def _run_bounded(job_id: str, identity: ClipIdentity, frames: List[bytes], payload: Dict[str, Any]) -> None:
    try:
        budget = DEEP_HUNT_TIMEOUT if payload.get('mode') == 'deep' else QUICK_HUNT_TIMEOUT
        payload['_deadline'] = time.monotonic() + budget - 1
        async with asyncio.timeout(max(0.001, budget - 0.5)):
            await _run_hunt(job_id, identity, frames, payload)
    except TimeoutError:
        job = _jobs.get(job_id)
        if job:
            job["status"] = "partial"
            job['termination_reason'] = 'deadline'
            job["progress"] = {"phase": "timeout", "message": "Časový limit – dostupné výsledky zostali"}
    except asyncio.CancelledError:
        pass
    finally:
        job = _jobs.get(job_id)
        if job and job.get('status') in {'partial', 'cancelled', 'error'} and job.get('steps'):
            step = job['steps'][-1]
            step.update(status=job['status'], ended_at=time.time(), reason=job.get('termination_reason') or job['status'],
                elapsed_ms=round((time.time() - step['started_at']) * 1000))
        _tasks.pop(job_id, None)


def _identity_from_payload(payload: Dict[str, Any]) -> ClipIdentity:
    title = str(payload.get("title") or "").strip()
    ident = parse_title_identity(title)
    ident.duration_sec = float(payload.get("duration_sec") or 0) or 0.0
    ident.height = int(payload.get("height") or 0) or 0
    ident.size_bytes = int(payload.get("size_bytes") or 0) or 0
    ident.page_url = str(payload.get("page_url") or "").strip()
    ident.thumbnail_url = str(payload.get("thumbnail_url") or "").strip()
    ident.poster_url = str(payload.get("poster_url") or "").strip()
    manual_keywords = re.sub(r"\s+", " ", str(payload.get("manual_keywords") or "")).strip()[:300]
    manual_performer = re.sub(r"\s+", " ", str(payload.get("performer") or "")).strip()[:120]
    if manual_keywords:
        # An explicit query replaces the title-derived scene only for this
        # hunt.  The raw title and measured media metadata remain intact.
        ident.scene = manual_keywords
    if manual_performer:
        ident.performer = manual_performer
    # Prefer measured height from player over parsed quality tag when present
    return ident


def _decode_frames(items: List[Any]) -> List[bytes]:
    out: List[bytes] = []
    for item in items[:3]:
        if not item:
            continue
        raw = str(item)
        if len(raw) > 2_800_000:
            continue
        if "," in raw and raw.strip().lower().startswith("data:"):
            raw = raw.split(",", 1)[1]
        try:
            data = base64.b64decode(raw, validate=False)
            if len(data) >= 256:
                out.append(data)
        except Exception:
            continue
    return out


def _pick_best_frame(frames: List[bytes]) -> Optional[bytes]:
    """Choose the sharpest/most detailed JPEG frame (largest byte density) to avoid dark/blurry cuts."""
    if not frames:
        return None
    if len(frames) == 1:
        return frames[0]
    return max(frames, key=len)


async def _extract_stream_frames_ffmpeg(
    stream_url: str,
    duration_sec: float = 0.0,
    referer: str = "",
) -> List[bytes]:
    """Extract up to 3 frames (20%, 50%, 78%) from a direct/HLS stream via HTTP range requests."""
    url = (stream_url or "").strip()
    if not url.startswith(("http://", "https://")):
        return []
    host = (urlparse(url).hostname or "").lower()
    if not host or host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".test") or "example." in host:
        return []
    dur = float(duration_sec or 0)
    timestamps = [round(dur * p, 1) for p in (0.20, 0.50, 0.78)] if dur >= 15 else [2.0, 10.0, 25.0]
    headers_arg = f"User-Agent: Mozilla/5.0\r\nReferer: {referer}\r\n" if referer else "User-Agent: Mozilla/5.0\r\n"

    async def _one_ts(ts: float) -> Optional[bytes]:
        cmd = [
            "ffmpeg", "-nostdin", "-loglevel", "error",
            "-headers", headers_arg,
            "-ss", str(max(0.5, ts)),
            "-i", url,
            "-frames:v", "1",
            "-vf", "scale=480:-2",
            "-f", "image2pipe", "-vcodec", "mjpeg", "-",
        ]
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=4.2)
            if stdout and len(stdout) >= 800 and stdout.startswith(b"\xff\xd8"):
                return stdout
        except Exception:
            if proc and proc.returncode is None:
                try:
                    proc.kill()
                except Exception:
                    pass
        return None

    results = await asyncio.gather(*(_one_ts(ts) for ts in timestamps), return_exceptions=True)
    return [r for r in results if isinstance(r, (bytes, bytearray)) and len(r) >= 800]


_PIVOT_IGNORE_TOKENS = frozenset({
    "video", "videos", "porn", "porno", "free", "watch", "online", "full",
    "hd", "mp4", "sex", "xxx", "fuck", "fucking", "hot", "girl", "girls",
    "babe", "amateur", "homemade", "leaked", "leak", "onlyfans", "fansly",
    "camwhores", "pornhub", "xvideos", "xhamster", "spankbang", "eporner",
    "porntrex", "noodlemagazine", "pimpbunny", "whoreshub", "simpcity",
    "reddit", "bunkr", "filester", "gofile", "com", "net", "org", "tv",
})


def _extract_visual_pivot_queries(
    visual_hits: List[Dict[str, Any]],
    identity: ClipIdentity,
) -> Tuple[List[str], Set[str]]:
    """Extract recurring aliases, handles, and scene keywords from Yandex/Vision hit titles & OCR."""
    scene_low = _transliterate_text(identity.scene or "")
    scene_toks = _content_tokens(identity.scene) | _content_tokens(identity.performer)
    scene_folded = {_phonetic_fold(t) for t in scene_toks}

    queries: List[str] = []
    pivot_tokens: Set[str] = set()
    token_doc_freq: Dict[str, int] = {}

    for h in visual_hits:
        ocr = str(h.get("ocr_text") or "")
        for wm in re.findall(r"(?:onlyfans\.com|fansly\.com|t\.me)/([a-z0-9_.-]{4,32})", ocr, re.I):
            wm_clean = wm.strip("._-").lower()
            if len(wm_clean) >= 4 and wm_clean not in scene_low:
                queries.append(wm_clean)
                pivot_tokens.update(_WORD_RE.findall(wm_clean))
        for ent in h.get("web_entities") or []:
            ent_s = _transliterate_text(str(ent or "").strip())
            ent_toks = [t for t in _WORD_RE.findall(ent_s) if len(t) >= 5 and t not in _STOP and t not in _PIVOT_IGNORE_TOKENS]
            if ent_toks and not all(_phonetic_fold(t) in scene_folded for t in ent_toks):
                queries.append(" ".join(ent_toks[:3]))
                pivot_tokens.update(ent_toks[:3])

        title = _transliterate_text(str(h.get("title") or ""))
        if not title or _NON_VIDEO_TITLE_RE.search(title):
            continue
        doc_tokens = {
            t for t in _WORD_RE.findall(title)
            if len(t) >= 5 and not t.isdigit()
            and t not in _STOP and t not in _QUERY_FILLER and t not in _PIVOT_IGNORE_TOKENS
            and _phonetic_fold(t) not in scene_folded
        }
        for tok in doc_tokens:
            token_doc_freq[tok] = token_doc_freq.get(tok, 0) + 1

    # Tokens appearing in at least 2 visual hits (or a long distinctive handle >= 10 chars in 1 hit)
    recurring = sorted(
        (tok for tok, cnt in token_doc_freq.items() if cnt >= 2 or (cnt == 1 and len(tok) >= 12)),
        key=lambda t: (token_doc_freq[t], len(t)),
        reverse=True,
    )[:3]
    for tok in recurring:
        pivot_tokens.add(tok)
        if identity.performer:
            queries.append(f"{identity.performer} {tok}")
        else:
            queries.append(tok)

    dedup_queries: List[str] = []
    seen_q: Set[str] = set()
    for q in queries:
        ql = q.strip().lower()
        if ql and ql not in seen_q:
            seen_q.add(ql)
            dedup_queries.append(q.strip())
    return dedup_queries[:2], pivot_tokens


async def _run_hunt(
    job_id: str,
    identity: ClipIdentity,
    frames: List[bytes],
    payload: Dict[str, Any],
) -> None:
    job = _jobs.get(job_id)
    if not job:
        return

    candidates: Dict[str, HuntCandidate] = {}
    job['_candidate_objects'] = candidates
    diagnostics: List[Dict[str, Any]] = payload.get('_seed_diagnostics') or []
    ref_thumb_fp = thumb_fingerprint(identity.thumbnail_url or identity.poster_url)
    ref_hashes: List[str] = []

    def _set_progress(phase: str, message: str) -> None:
        if job_id in _jobs:
            now = time.time()
            steps = job.setdefault('steps', [])
            if steps and steps[-1]['status'] == 'running':
                failed = any(diagnostic_status(d) in FAILED_STATUSES for d in diagnostics[steps[-1].get('diagnostic_offset', 0):])
                skipped = diagnostics[steps[-1].get('diagnostic_offset', 0):]
                status = 'partial' if failed else 'skip' if skipped and all(diagnostic_status(d) == 'skip' for d in skipped) else 'done'
                steps[-1].update(status=status, ended_at=now, elapsed_ms=round((now - steps[-1]['started_at']) * 1000))
            steps.append({'id': phase, 'status': 'running', 'started_at': now,
                'budget_sec': max(0, round(payload.get('_deadline', time.monotonic()) - time.monotonic(), 1)), 'reason': message, 'diagnostic_offset': len(diagnostics)})
            _jobs[job_id]["progress"] = {"phase": phase, "message": message}

    def _publish() -> None:
        if job_id not in _jobs:
            return
        _jobs[job_id]["diagnostics"] = [{**d, 'status': diagnostic_status(d)} for d in diagnostics]
        fused = [fuse_evidence(identity, c, ref_thumb_fp=ref_thumb_fp) for c in candidates.values()]
        refresh_job(job, fused)

    verification_tasks = []
    verification_sem = asyncio.Semaphore(4)
    observed_hits = set()

    async def verify_candidate(candidate):
        async with verification_sem:
            await _probe_candidates([candidate])
            await _score_visuals([candidate], ref_hashes, budget=5)
        _publish()

    def _add_hit(hit: Dict[str, Any]) -> None:
        observation = (hit.get('url'), hit.get('title'), hit.get('duration'), hit.get('source') or hit.get('source_key'))
        if observation in observed_hits:
            return
        observed_hits.add(observation)
        job['balance']['fetched'] += 1
        url = str(hit.get("url") or "").strip()
        if not url or not url.startswith("http"):
            return
        if is_original_page(identity, url):
            job['balance']['original_excluded'] += 1
            return
        title_str = str(hit.get("title") or "")
        if _is_non_video_hunt_hit(url, title_str, hit):
            job['balance']['source_excluded'] += 1
            return
        source_key = str(hit.get("source") or hit.get("source_key") or "").lower()
        host = urlparse(url).netloc.lower()
        if source_key in HUNT_SKIP_SOURCES or any(bit in host for bit in HUNT_SKIP_HOSTS):
            job['balance']['source_excluded'] += 1
            return
        if url in candidates:
            job['balance']['duplicate'] += 1
            existing = candidates[url]
            # Merge richer meta
            if not existing.title and hit.get("title"):
                existing.title = str(hit["title"])
            if not existing.thumbnail and hit.get("thumbnail"):
                existing.thumbnail = str(hit["thumbnail"])
            if not existing.height and hit.get("height"):
                existing.height = int(hit["height"] or 0)
            if not existing.duration_sec:
                existing.duration_sec = _parse_duration(hit.get("duration") or hit.get("duration_sec"))
            if not existing.size_bytes and hit.get("size_bytes"):
                existing.size_bytes = int(hit["size_bytes"] or 0)
            return
        candidates[url] = HuntCandidate(
            url=url,
            title=str(hit.get("title") or ""),
            source=str(hit.get("source") or hit.get("source_key") or ""),
            thumbnail=str(hit.get("thumbnail") or hit.get("thumb") or ""),
            duration_sec=_parse_duration(hit.get("duration") or hit.get("duration_sec")),
            height=_parse_height(hit.get("height"), str(hit.get("title") or ""))
                or _height_from_quality_label(hit.get("quality")),
            height_source="library" if hit.get("from_library") else "title",
            stream_url=str(hit.get("stream_url") or ""),
            size_bytes=int(hit.get("size_bytes") or 0) if hit.get("size_bytes") else 0,
            library_id=hit.get("library_id"),
            from_library=bool(hit.get("from_library")),
            requires_login=bool(hit.get('requires_login')),
        )
        verification_tasks.append(asyncio.create_task(verify_candidate(candidates[url])))

    try:
        for view in payload.get('_seed_candidates') or []:
            c = HuntCandidate(**{k: v for k, v in view.items() if k in HuntCandidate.__dataclass_fields__})
            candidates[c.url] = c
            if c.metadata_status != 'ok' or c.visual_status in {'timeout', 'error', 'budget_exhausted'} or (c.stream_url and c.availability_state == 'unknown'):
                verification_tasks.append(asyncio.create_task(verify_candidate(c)))
        _publish()
        # Build reference phashes from frames (and extract multi-frame via ffmpeg when stream_url is known)
        if len(frames) < 2 and payload.get("stream_url"):
            try:
                ff_frames = await _extract_stream_frames_ffmpeg(
                    str(payload.get("stream_url") or ""),
                    identity.duration_sec,
                    referer=identity.page_url,
                )
                for f_bytes in ff_frames:
                    if len(frames) < 3:
                        frames.append(f_bytes)
            except Exception:
                pass
        if frames:
            from .nexus_intel import _phash_bytes
            for fr in frames:
                h = _phash_bytes(fr)
                if h and h not in ref_hashes:
                    ref_hashes.append(h)

        if identity.thumbnail_url or identity.poster_url:
            from .nexus_intel import phash_url
            try:
                reference_hash = await asyncio.wait_for(phash_url(identity.thumbnail_url or identity.poster_url,
                    referer=identity.page_url), timeout=4)
                if reference_hash:
                    ref_hashes.append(reference_hash)
            except Exception:
                pass

        # ── 1. Library ───────────────────────────────────────────────────────
        _set_progress("library", "Knižnica")
        try:
            lib_hits = [] if payload.get('visual_only') or (payload.get('retry_job_id') and 'library' not in payload.get('_retry_sources', [])) else await asyncio.to_thread(_search_library, identity)
            for h in lib_hits:
                _add_hit(h)
            diagnostics.append({"source": "library", "status": "skip" if payload.get('visual_only') else "ok", "count": len(lib_hits), "error": "iba podľa náhľadu" if payload.get('visual_only') else ""})
        except Exception as exc:
            logger.info("[quality_hunt] library: %s", exc)
            diagnostics.append({"source": "library", "status": "error", "error": str(exc)})
        _publish()

        # ── 2. Sniper text search ────────────────────────────────────────────
        _dbg("H4", "identity", {
            "scene": identity.scene[:120],
            "studio": identity.studio,
            "date": identity.date,
            "height": identity.effective_height,
            "duration": identity.duration_sec,
            "has_thumb": bool(identity.thumbnail_url or identity.poster_url),
            "frames": len(frames),
        })
        _set_progress("sniper", "Presný lov")
        query = identity.scene.strip()
        queries = [] if payload.get('visual_only') else hunt_queries(identity)

        async def _search_keep_partial(engine, q, keys, per_source, global_limit, timeout_s, req_identity=None):
            if payload.get('retry_job_id'):
                keys = [k for k in keys if k in payload.get('_retry_sources', [])]
            if not keys:
                return [], [], False
            sink: Dict[str, Any] = {"results": [], "diagnostics": []}
            consumed = 0
            recorded = set()
            def record(items):
                for d in items:
                    key = d.get('source_key') or d.get('source')
                    if key not in recorded:
                        diagnostics.append({**d, 'query': q})
                        recorded.add(key)
            async def source_finished(*_):
                nonlocal consumed
                for hit in sink['results'][consumed:]:
                    _add_hit(hit)
                consumed = len(sink['results'])
                record(sink['diagnostics'])
                _publish()
            try:
                payload_res = await asyncio.wait_for(
                    engine.search_sources(
                        q,
                        keys,
                        result_limit=per_source,
                        return_diagnostics=True,
                        per_source_limit=per_source,
                        global_limit=global_limit,
                        partial_sink=sink,
                        required_identity=identity.performer if req_identity is None else req_identity,
                        source_timeout=max(1, timeout_s - 4),
                        progress_callback=source_finished,
                        trace_filters=True,
                        stream_candidates=True,
                    ),
                    timeout=timeout_s,
                )
                if isinstance(payload_res, dict):
                    results = payload_res.get("results") or sink["results"]
                    diags = payload_res.get("diagnostics") or sink["diagnostics"]
                else:
                    results = payload_res or sink["results"]
                    diags = sink["diagnostics"]
                record(diags)
                return list(results or []), list(diags or []), False
            except asyncio.TimeoutError:
                finished = {d.get('source_key') for d in sink['diagnostics']}
                sink['diagnostics'].extend({'source_key': k, 'status': 'timeout', 'count': 0,
                    'error': 'Vonkajší deadline zdroja'} for k in keys if k not in finished)
                record(sink['diagnostics'])
                return list(sink["results"]), list(sink["diagnostics"]), True
            except asyncio.CancelledError:
                finished = {d.get('source_key') for d in sink['diagnostics']}
                state = 'cancelled' if job.get('status') == 'cancelled' else 'timeout'
                record([{'source_key': k, 'status': state, 'count': 0,
                    'error': 'Prerušené zastavením' if state == 'cancelled' else 'Celkový deadline hľadania'}
                    for k in keys if k not in finished])
                for hit in sink['results'][consumed:]:
                    _add_hit(hit)
                _publish()
                raise

        try:
            from .search_engine import ExternalSearchEngine
            engine = ExternalSearchEngine()
            async def search_query(q):
                try:
                    results, diags, timed_out = await _search_keep_partial(
                        engine, q, SNIPER_SOURCES, 12, 120, 18.0,
                    )
                    for r in results:
                        _add_hit({
                            "url": r.get("url"),
                            "title": r.get("title"),
                            "thumbnail": r.get("thumbnail") or r.get("thumb"),
                            "duration": r.get("duration"),
                            "source": r.get("source_key") or r.get("source"),
                            "quality": r.get("quality"),
                            "requires_login": r.get('requires_login'),
                            "height": height_from_title(r.get("title") or "") or _height_from_quality_label(r.get("quality")),
                        })
                    if timed_out:
                        diagnostics.append({
                            "source": "sniper", "status": "timeout", "query": q,
                            "kept": len(results),
                        })
                except Exception as exc:
                    diagnostics.append({"source": "sniper", "status": "error", "error": str(exc)})
                _publish()
            await asyncio.gather(*(search_query(q) for q in queries))
        except Exception as exc:
            diagnostics.append({"source": "sniper", "status": "error", "error": str(exc)})
        _dbg("H1", "after_sniper", {
            "candidates": len(candidates),
            "sniper_diag": [d for d in diagnostics if d.get("source") in ("sniper", "library") or d.get("source_key")][:24],
        })
        _publish()

        async def _extra_search(source: str) -> None:
            if payload.get('retry_job_id') and source not in payload.get('_retry_sources', []):
                return
            try:
                if source == "google":
                    hits = await asyncio.wait_for(_search_google(query), timeout=10)
                else:
                    from .search_engine import ExternalSearchEngine
                    hits = await asyncio.wait_for(ExternalSearchEngine().search_telegram_async(query), timeout=30)
                for hit in hits or []:
                    _add_hit({**hit, "source": source})
                diagnostics.append({"source": source, "status": "ok", "count": len(hits or [])})
            except Exception as exc:
                diagnostics.append({"source": source, "status": 'timeout' if isinstance(exc, asyncio.TimeoutError) else 'error', "error": str(exc)})
            _publish()

        if payload.get('visual_only'):
            diagnostics.extend({"source": s, "status": "skip", "error": "iba podľa náhľadu"} for s in ("sniper", "google", "telegram"))
        else:
            extra = [_extra_search("telegram")]
            if payload.get("mode") == "deep":
                _set_progress("extra", "Google a Telegram")
                extra.append(_extra_search("google"))
            else:
                diagnostics.append({"source": "google", "status": "skip", "error": "rýchle hľadanie"})
            await asyncio.gather(*extra)
        _publish()

        # ── 3. Visual web search ─────────────────────────────────────────────
        # Google Vision accepts the captured frame directly, unlike SerpApi's
        # Lens endpoint which requires a public thumbnail URL.  Keep Yandex as
        # a complementary visual provider; every hit still goes through the
        # normal pHash, duration, and playback verification below.
        _set_progress("vision", "Google Vision a Yandex náhľad")
        seed_bytes: Optional[bytes] = None
        retry_sources = set(payload.get('_retry_sources') or [])
        visual_enabled = payload.get('allow_visual_search') and (
            not payload.get('retry_job_id')
            or bool({'vision', 'yandex', 'visual_web'} & retry_sources)
        )
        if visual_enabled and frames:
            seed_bytes = _pick_best_frame(frames)
        if visual_enabled and seed_bytes is None:
            thumb = identity.thumbnail_url or identity.poster_url
            if thumb:
                seed_bytes = await _download_bytes(thumb, referer=identity.page_url)
        vision_extra_queries: List[str] = []
        if seed_bytes:
            try:
                async def vision_reference_hits():
                    import sys
                    main_mod = sys.modules.get("app.main")
                    search_fn = getattr(main_mod, "_google_vision_web_search", None)
                    if not search_fn:
                        raise RuntimeError("Google Vision vyžaduje spustený plný Nexus server")
                    query_frames = frames[:3] if frames else [seed_bytes]
                    return await search_fn(query_frames, limit=40)

                # A confirmed title+runtime match can supply another frame of
                # this clip; renamed mirrors often index that frame instead.
                async def confirmed_reference_hits():
                    anchor = next((c for c in candidates.values() if c.confirmed and c.thumbnail), None)
                    if not anchor or anchor.thumbnail in {identity.thumbnail_url, identity.poster_url}:
                        return []
                    image = await _download_bytes(anchor.thumbnail, referer=anchor.url)
                    return await _yandex_hits(image, text=identity.performer or query) if image else []
                batches = await asyncio.wait_for(asyncio.gather(
                    vision_reference_hits(),
                    _yandex_hits(seed_bytes, text=identity.performer or query),
                    confirmed_reference_hits(), return_exceptions=True), timeout=24.0)
                for source, batch in zip(('vision', 'yandex', 'confirmed_reference'), batches):
                    if isinstance(batch, Exception):
                        diagnostics.append({'source': source, 'status': 'error', 'error': str(batch)})
                visual_hits = [hit for batch in batches if isinstance(batch, list) for hit in batch]
                vision_extra_queries, pivot_tokens = _extract_visual_pivot_queries(visual_hits, identity)
                if pivot_tokens:
                    identity._pivot_tokens = pivot_tokens
                for h in visual_hits:
                    _add_hit(h)
                vision_count = sum(1 for h in visual_hits if h.get("source") == "google_vision")
                yandex_count = sum(1 for h in visual_hits if h.get("source") == "yandex")
                diagnostics.extend((
                    {"source": "vision", "status": "ok", "count": vision_count},
                    {"source": "yandex", "status": "ok", "count": yandex_count},
                ))
            except Exception as exc:
                diagnostics.append({"source": "visual_web", "status": "error", "error": str(exc)})
        else:
            reason = "bez snímky" if payload.get("allow_visual_search") else "vypnuté používateľom"
            diagnostics.extend((
                {"source": "vision", "status": "skip", "error": reason},
                {"source": "yandex", "status": "skip", "error": reason},
            ))
        _publish()

        if vision_extra_queries and not payload.get('visual_only') and payload.get('_deadline', 0) - time.monotonic() > 14:
            _set_progress("visual_pivot", "Dohľadávanie podľa vizuálnych aliasov")
            try:
                from .search_engine import ExternalSearchEngine
                extra_engine = ExternalSearchEngine()
                for eq in vision_extra_queries:
                    extra_res, _, _ = await _search_keep_partial(extra_engine, eq, SNIPER_SOURCES[:12], 6, 42, 10.0, req_identity="")
                    for r in extra_res:
                        _add_hit({
                            "url": r.get("url"),
                            "title": r.get("title"),
                            "thumbnail": r.get("thumbnail") or r.get("thumb"),
                            "duration": r.get("duration"),
                            "source": r.get("source_key") or r.get("source"),
                            "quality": r.get("quality"),
                            "requires_login": r.get('requires_login'),
                            "height": height_from_title(r.get("title") or "") or _height_from_quality_label(r.get("quality")),
                        })
                diagnostics.append({"source": "vision_ocr_followup", "status": "ok", "count": len(vision_extra_queries), "query": ", ".join(vision_extra_queries)})
            except Exception as exc:
                diagnostics.append({"source": "vision_ocr_followup", "status": "error", "error": type(exc).__name__})
            _publish()

        # ── Visual score all candidates with thumbs ──────────────────────────
        _set_progress("visual", "Porovnanie náhľadov")
        await _score_visuals(list(candidates.values()), ref_hashes, budget=15 if payload.get("mode") == "deep" else 8)
        _publish()

        # Relaxed query cascade when strict scene queries returned very few hits in deep mode
        scene_domains = {source_domain(c.url) for c in candidates.values()
            if fuse_evidence(identity, c).identity_state in {'confirmed', 'variant'}}
        cascade_qs = hunt_cascade_queries(identity) if (not payload.get('visual_only') and payload.get('mode') == 'deep' and len(scene_domains) < MIN_DISTINCT_SOURCES and len(candidates) < 16) else []
        if cascade_qs and payload.get('_deadline', 0) - time.monotonic() > 16:
            _set_progress('cascade', 'Kaskádové uvoľnenie dopytu')
            try:
                from .search_engine import ExternalSearchEngine
                casc_engine = ExternalSearchEngine()
                for cq in cascade_qs:
                    casc_hits, _, _ = await _search_keep_partial(casc_engine, cq, SNIPER_SOURCES[:12], 5, 36, 10.0)
                    for hit in casc_hits:
                        _add_hit(hit)
                if ref_hashes:
                    await _score_visuals(list(candidates.values()), ref_hashes, budget=4)
                diagnostics.append({'source': 'cascade', 'status': 'ok', 'count': len(cascade_qs), 'query': ', '.join(cascade_qs)})
            except Exception as exc:
                diagnostics.append({'source': 'cascade', 'status': 'error', 'error': type(exc).__name__})
            _publish()

        # Search renamed uploads while there is still time to compare images.
        # Keep this bounded: a performer's other scenes are not version results.
        scene_domains = {source_domain(c.url) for c in candidates.values()
            if fuse_evidence(identity, c).identity_state in {'confirmed', 'variant'}}
        if (not payload.get('visual_only') and identity.performer and (ref_hashes or len(candidates) < 12) and len(scene_domains) < MIN_DISTINCT_SOURCES
                and payload.get('_deadline', 0) - time.monotonic() > 12):
            _set_progress('performer_visual', 'Hľadanie súvisiacich videí účinkujúceho')
            try:
                from .search_engine import ExternalSearchEngine
                actor_hits, _, _ = await _search_keep_partial(
                    ExternalSearchEngine(), identity.performer, SNIPER_SOURCES, 2, 24, 11.0,
                )
                for hit in actor_hits:
                    _add_hit(hit)
                if ref_hashes:
                    await _score_visuals(list(candidates.values()), ref_hashes, budget=4)
                diagnostics.append({'source': 'performer_visual', 'status': 'ok', 'count': len(actor_hits)})
            except Exception as exc:
                diagnostics.append({'source': 'performer_visual', 'status': 'error', 'error': type(exc).__name__})
            _publish()

        # ── 4. Wide search if few confirmed ──────────────────────────────────
        fused_now = [fuse_evidence(identity, c, ref_thumb_fp=ref_thumb_fp) for c in candidates.values()]
        confirmed_n = sum(1 for c in fused_now if c.confirmed)
        signal_hist: Dict[str, int] = {}
        for c in fused_now:
            key = "+".join(c.signals) or "none"
            signal_hist[key] = signal_hist.get(key, 0) + 1
        _dbg("H2", "before_wide", {
            "candidates": len(fused_now),
            "confirmed": confirmed_n,
            "signals": signal_hist,
        })
        scene_domains = {source_domain(c.url) for c in fused_now if c.identity_state in {'confirmed', 'variant'}}
        if not payload.get('visual_only') and len(scene_domains) < MIN_DISTINCT_SOURCES and query:
            _set_progress("wide", "Široký lov")
            try:
                from .source_catalog import DISCOVERY_SEARCH_SOURCE_KEYS
                wide_keys = [
                    k for k in DISCOVERY_SEARCH_SOURCE_KEYS
                    if k not in SNIPER_SOURCES and k not in HUNT_SKIP_SOURCES
                ]
                from .search_engine import ExternalSearchEngine
                engine = ExternalSearchEngine()
                results, diags, timed_out = await _search_keep_partial(
                    engine, query, wide_keys, 12, 160, 18.0,
                )
                for r in results:
                    _add_hit({
                        "url": r.get("url"),
                        "title": r.get("title"),
                        "thumbnail": r.get("thumbnail") or r.get("thumb"),
                        "duration": r.get("duration"),
                        "source": r.get("source_key") or r.get("source"),
                        "requires_login": r.get('requires_login'),
                        "quality": r.get("quality"),
                        "height": height_from_title(r.get("title") or "") or _height_from_quality_label(r.get("quality")),
                    })
                if timed_out:
                    diagnostics.append({
                        "source": "wide", "status": "timeout", "kept": len(results),
                    })
            except Exception as exc:
                diagnostics.append({"source": "wide", "status": "error", "error": f"{type(exc).__name__}: {exc}"})
                _dbg("H3", "wide_error", {"type": type(exc).__name__, "error": str(exc), "candidates": len(candidates)})
            _dbg("H3", "after_wide", {"candidates": len(candidates)})
            await _score_visuals(list(candidates.values()), ref_hashes, budget=12 if payload.get('mode') == 'deep' else 4)
            _publish()

        # Verification has run concurrently with discovery; drain within reserve.
        _set_progress('verify', 'Dokončujem overenie kandidátov')
        if verification_tasks:
            remaining = max(0.01, payload.get('_deadline', time.monotonic() + 15) - time.monotonic() - 0.5)
            _, pending = await asyncio.wait(verification_tasks, timeout=remaining)
            for task in pending:
                task.cancel()
            await asyncio.gather(*verification_tasks, return_exceptions=True)
        for c in candidates.values():
            if c.metadata_status in {'pending', 'running'}:
                c.metadata_status, c.metadata_reason = 'budget_exhausted', 'Celkový deadline overenia'
        _publish()

        # Final
        fused = [fuse_evidence(identity, c, ref_thumb_fp=ref_thumb_fp) for c in candidates.values()]
        groups = bucket_cards(identity, fused)
        _dbg("H5", "final_groups", {
            "raw": len(fused),
            "better": len(groups["better"]),
            "other": len(groups["other"]),
            "maybe": len(groups["maybe"]),
            "with_signals": sum(1 for c in fused if c.signals),
        })
        _jobs[job_id]["groups"] = groups
        _jobs[job_id]["diagnostics"] = diagnostics
        degraded = any(diagnostic_status(d) in FAILED_STATUSES for d in diagnostics) or job['balance']['verification_failures'] > 0
        _jobs[job_id]["status"] = 'degraded' if degraded else 'done'
        _jobs[job_id]['termination_reason'] = 'failed_steps' if degraded else 'completed'
        coverage = _jobs[job_id]['coverage']
        _jobs[job_id]["progress"] = {"phase": "done", "message":
            f"Zdroje rovnakej scény {len(coverage['confirmed_sources'])}" + (f"/{coverage['target']}" if coverage['target'] else '')}
        if job.get('steps'):
            step = job['steps'][-1]
            step.update(status='partial' if degraded else 'done', ended_at=time.time(), elapsed_ms=round((time.time() - step['started_at']) * 1000), reason=job['termination_reason'])
        job['diagnostics'] = [{**d, 'status': diagnostic_status(d)} for d in diagnostics]
        ttl = 20 if degraded else CACHE_TTL_SEC
        job['cache'] = {'hit': False, 'kind': job['status'], 'age_sec': 0, 'expires_at': time.time() + ttl}
        _cache[_jobs[job_id]["_cache_key"]] = {
            "ts": time.time(),
            "groups": copy.deepcopy(groups),
            "diagnostics": diagnostics,
            'ttl': ttl, 'status': job['status'], 'snapshot': job_response(job),
        }
    except Exception as exc:
        logger.exception("[quality_hunt] job %s failed", job_id)
        if job_id in _jobs:
            _jobs[job_id]["status"] = "error"
            _jobs[job_id]["error"] = str(exc)
            _jobs[job_id]["progress"] = {"phase": "error", "message": str(exc)}
    finally:
        for task in verification_tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*verification_tasks, return_exceptions=True)
        for c in candidates.values():
            if c.metadata_status in {'pending', 'running'}:
                c.metadata_status, c.metadata_reason = 'budget_exhausted', 'Overenie prerušené'
        _publish()


def _search_library(identity: ClipIdentity) -> List[Dict[str, Any]]:
    from .database import SessionLocal, Video

    tokens = sorted(identity.scene_tokens, key=len, reverse=True)[:5]
    if not tokens:
        return []
    db = SessionLocal()
    try:
        q = db.query(Video)
        # Require the longest token at least
        primary = tokens[0]
        rows = (
            q.filter(Video.title.ilike(f"%{primary}%"))
            .order_by(Video.id.desc())
            .limit(80)
            .all()
        )
        out: List[Dict[str, Any]] = []
        for v in rows:
            title = v.title or ""
            if not scene_significant_overlap(identity.scene, title) and scene_overlap(identity.scene, title) < 0.4:
                continue
            thumb = ""
            if v.original_thumbnail_url:
                thumb = v.original_thumbnail_url
            elif v.thumbnail_path and str(v.thumbnail_path).startswith("http"):
                thumb = v.thumbnail_path
            out.append({
                "url": v.source_url or v.url,
                "title": title,
                "thumbnail": thumb,
                "duration": float(v.duration or 0),
                "height": int(v.height or 0),
                "size_bytes": int((v.file_size_mb or 0) * 1024 * 1024),
                "source": "library",
                "library_id": v.id,
                "from_library": True,
            })
        return out
    finally:
        db.close()


async def _search_google(query: str) -> List[Dict[str, Any]]:
    from .config import config
    if not getattr(config, "SERPAPI_API_KEY", None):
        return []
    if not query:
        return []
    import httpx
    q = f'"{query}"'
    params = {
        "engine": "google",
        "q": q,
        "api_key": config.SERPAPI_API_KEY,
        "num": 10,
        "safe": "off",
    }
    async with httpx.AsyncClient(timeout=12.0) as client:
        r = await client.get("https://serpapi.com/search", params=params)
        if r.status_code >= 400:
            # HTTPStatusError includes the request URL containing the API key.
            raise RuntimeError(f"Google HTTP {r.status_code}")
        data = r.json()
    out: List[Dict[str, Any]] = []
    for item in data.get("organic_results") or []:
        link = item.get("link")
        if not link:
            continue
        out.append({
            "url": link,
            "title": item.get("title") or "",
            "thumbnail": (item.get("thumbnail") or ""),
            "source": "google",
            "height": height_from_title(item.get("title") or ""),
        })
    return out


async def _yandex_hits(image_bytes: bytes, text: str = "") -> List[Dict[str, Any]]:
    # Prefer shared CBIR helper on full dashboard; skip cleanly on LITE-only.
    try:
        import sys
        main_mod = sys.modules.get("app.main")
        search_fn = getattr(main_mod, "_yandex_cbir_search", None)
        if not search_fn:
            raise RuntimeError("Yandex obrazové hľadanie vyžaduje spustený plný Nexus server")
        results = await search_fn(image_bytes, limit=40, text=text)
    except Exception as exc:
        logger.info("[quality_hunt] yandex unavailable: %s", exc)
        raise
    out: List[Dict[str, Any]] = []
    for r in results or []:
        url = r.get("url") or r.get("page_url") or r.get("link")
        if not url:
            continue
        out.append({
            "url": url,
            "title": r.get("title") or r.get("domain") or "",
            "thumbnail": r.get("thumbnail") or r.get("image") or "",
            "source": "yandex",
            "height": height_from_title(r.get("title") or ""),
        })
    return out


async def _download_bytes(url: str, referer: str = "") -> Optional[bytes]:
    if not url:
        return None
    try:
        from .nexus_intel import phash_url  # noqa: F401 — ensure module loads
        from curl_cffi import requests as cr
        headers = {"User-Agent": "Mozilla/5.0"}
        if referer:
            headers["Referer"] = referer

        def _do() -> Optional[bytes]:
            r = cr.get(url, headers=headers, impersonate="chrome", timeout=12)
            if r.status_code == 200 and len(r.content) >= 256:
                return r.content
            return None

        return await asyncio.to_thread(_do)
    except Exception:
        return None


async def _score_visuals(cands: List[HuntCandidate], ref_hashes: List[str], *, budget: float = 15) -> None:
    if not ref_hashes:
        for c in cands:
            c.visual_status, c.visual_reason = 'not_requested', 'Chýba referenčný obraz'
        return
    from .nexus_intel import phash_url, _hamming

    sem = asyncio.Semaphore(6)

    async def _one(c: HuntCandidate) -> None:
        if c.visual_status == 'ok':
            return
        if not c.thumbnail:
            c.visual_status, c.visual_reason = 'unavailable', 'Zdroj neposkytol náhľad'
            return
        try:
            async with sem:
                c.visual_status = 'running'
                ch = await asyncio.wait_for(phash_url(c.thumbnail), timeout=min(8, budget))
            if not ch:
                c.visual_status, c.visual_reason = 'error', 'Náhľad sa nepodarilo načítať'
                return
            best = min(_hamming(rh, ch) for rh in ref_hashes)
            # Map hamming 0..64 → score 100..0 with confirm around dist<=12 → ~55+
            score = max(0.0, (1.0 - best / 24.0) * 100.0)
            c.visual_score = round(score, 1)
            c.visual_status, c.visual_reason = 'ok', f'Podobnosť náhľadu {c.visual_score}%'
        except asyncio.TimeoutError:
            c.visual_status, c.visual_reason = 'timeout', 'Časový limit načítania náhľadu'
        except Exception as exc:
            c.visual_status, c.visual_reason = 'error', type(exc).__name__
        finally:
            c.visual_checked_at = time.time()

    ranked = sorted(cands, key=lambda c: (c.match_coverage, len(c.signals)), reverse=True)
    try:
        async with asyncio.timeout(budget):
            await asyncio.gather(*[_one(c) for c in ranked], return_exceptions=True)
    except TimeoutError:
        for c in ranked:
            if c.visual_status in {'pending', 'running'}:
                c.visual_status, c.visual_reason = 'budget_exhausted', 'Rozpočet obrazového overenia vyčerpaný'


async def probe_media_size(url: str, referer: str = '') -> int:
    """Bounded HEAD/one-byte range probe; never download a video to find its size."""
    try:
        import httpx
        async with httpx.AsyncClient(follow_redirects=True, timeout=3) as client:
            headers = {'User-Agent': 'Mozilla/5.0', 'Referer': referer}
            response = await client.head(url, headers=headers)
            if 'text/html' in response.headers.get('content-type', '') or 'application/json' in response.headers.get('content-type', ''):
                return 0
            if response.status_code == 200 and response.headers.get('content-length'):
                return int(response.headers['content-length'])
            async with client.stream('GET', url, headers={**headers, 'Range': 'bytes=0-0'}) as response:
                if 'text/html' in response.headers.get('content-type', '') or 'application/json' in response.headers.get('content-type', ''):
                    return 0
                if response.status_code == 206:
                    total = response.headers.get('content-range', '').rsplit('/', 1)[-1]
                    return int(total) if total.isdigit() else 0
                if response.status_code == 200:
                    return int(response.headers.get('content-length') or 0)
    except Exception:
        pass
    return 0


async def verify_stream(url: str, referer: str = '') -> Tuple[str, str]:
    """Check media bytes without downloading a whole video or claiming decode QA."""
    if not url.startswith(('http://', 'https://')):
        return 'unknown', 'Stream nie je dostupný na sieťové overenie'
    try:
        import httpx
        async with httpx.AsyncClient(follow_redirects=True, timeout=5,
                headers={'User-Agent': 'Mozilla/5.0', 'Referer': referer, 'Range': 'bytes=0-16383'}) as client:
            async with client.stream('GET', url) as response:
                if response.status_code in {401, 403}:
                    return 'login_required', f'Zdroj HTTP {response.status_code}'
                if response.status_code in {404, 410}:
                    return 'unavailable', f'Zdroj HTTP {response.status_code}'
                if response.status_code not in {200, 206}:
                    return 'unknown', f'Overenie HTTP {response.status_code}'
                body = b''
                async for chunk in response.aiter_bytes():
                    body += chunk[:16384 - len(body)]
                    if len(body) >= 1024:
                        break
                if b'ftyp' in body[:64] or body.startswith(b'\x1aE\xdf\xa3') or body.startswith(b'FLV'):
                    return 'playable', 'Overené bajty mediálneho súboru; dekódovanie overí prehrávač'
                if body.lstrip().startswith(b'#EXTM3U'):
                    return 'unknown', 'Playlist dostupný; segmenty a prehratie treba overiť'
                return 'unknown', 'Odpoveď neobsahuje rozpoznané médium'
    except Exception as exc:
        return 'unknown', f'Overenie streamu: {type(exc).__name__}'


async def _probe_candidates(cands: List[HuntCandidate]) -> None:
    try:
        from .extractors.registry import ExtractorRegistry
    except Exception:
        for c in cands:
            c.metadata_status, c.metadata_reason = 'unsupported', 'Register extraktorov sa nepodarilo načítať'
            c.metadata_checked_at = time.time()
        return

    sem = asyncio.Semaphore(4)

    async def _one(c: HuntCandidate) -> None:
        if c.metadata_status == 'ok':
            if c.stream_url and c.availability_state == 'unknown':
                c.availability_state, c.availability_reason = await verify_stream(c.stream_url, c.url)
                c.availability_checked_at = time.time()
            return
        try:
            ext = ExtractorRegistry.find_extractor(c.url)
            if not ext:
                c.metadata_status, c.metadata_reason = 'unsupported', 'Pre zdroj chýba extraktor'
                return
            async with sem:
                c.metadata_status = 'running'
                meta = await asyncio.wait_for(ext.extract(c.url), timeout=8.0)
            if not meta:
                c.metadata_status, c.metadata_reason = 'empty', 'Extraktor neposkytol metadáta'
                return
            if isinstance(meta, dict):
                if meta.get("upload_date"):
                    c.upload_date = str(meta["upload_date"])
                if meta.get("duration"):
                    c.duration_sec = float(meta["duration"] or 0)
                if meta.get("height"):
                    c.height = int(meta.get("height") or 0)
                    c.height_source = "metadata"
                c.stream_url = str(meta.get("stream_url") or meta.get('direct_url') or '')
                if c.stream_url:
                    c.requires_login = False
                c.is_hls = bool(meta.get("is_hls"))
                if meta.get("thumbnail") and not c.thumbnail:
                    c.thumbnail = str(meta["thumbnail"])
                if meta.get("title"):
                    c.title = str(meta["title"])
                if meta.get('size_bytes'):
                    c.size_bytes = int(meta['size_bytes'])
                # quality variants
                variant_heights = []
                for q in meta.get("quality_variants") or meta.get("qualities") or []:
                    try:
                        h = int(re.sub(r"\D", "", str(q.get("height") or q.get("label") or "")) or 0)
                        if h in _STANDARD_HEIGHTS:
                            variant_heights.append(h)
                    except Exception:
                        pass
                if variant_heights:
                    c.height = max(variant_heights)
                    c.height_source = "metadata"
                c.metadata_status, c.metadata_reason = 'ok', 'Metadáta extraktora overené'
                if c.stream_url and c.availability_state != 'playable':
                    c.availability_state, c.availability_reason = await verify_stream(c.stream_url, c.url)
                    c.availability_checked_at = time.time()
                elif c.requires_login:
                    c.availability_state, c.availability_reason = 'login_required', 'Súkromný zdroj'
            else:
                c.metadata_status, c.metadata_reason = 'parse_error', 'Neplatný formát metadát'
        except asyncio.TimeoutError:
            c.metadata_status, c.metadata_reason = 'timeout', 'Časový limit extrakcie metadát'
        except (ValueError, TypeError, KeyError) as exc:
            c.metadata_status, c.metadata_reason = 'parse_error', type(exc).__name__
        except Exception as exc:
            c.metadata_status, c.metadata_reason = 'error', type(exc).__name__
        finally:
            c.metadata_checked_at = time.time()

    await asyncio.gather(*[_one(c) for c in cands], return_exceptions=True)
