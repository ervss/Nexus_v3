"""Extract useful, conservative metadata from Telegram video captions."""
from __future__ import annotations

import re
from pathlib import PurePath

_PLATFORM = re.compile(r"\[(OnlyFans|Fansly|ManyVids|Patreon)\]", re.I)
_HASHTAG = re.compile(r"(?<!\w)#([\w]+)", re.UNICODE)
_PROMO = re.compile(r"(?:https?://|t\.me/|@\w+|\$\s*\d|\b(?:lifetime access|access to vip|subscribe|subscription|join (?:us|our|the)|how to get access|all information|questions|discount|promo code)\b)", re.I)
_GENERIC = re.compile(r"^(?:video|clip|telegram|download|untitled|img|vid)[\s_#\d.-]*$", re.I)


def _key(value: str) -> str:
    return re.sub(r"[^\w]", "", value, flags=re.UNICODE).casefold()


def _human_tag(value: str) -> str:
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", value.replace('_', ' ')).strip()


def extract_telegram_metadata(caption: str = '', file_name: str = '', fallback_title: str = '', message_id=None) -> dict:
    raw = str(caption or '').strip()
    platform_match = _PLATFORM.search(raw)
    platform = platform_match.group(1) if platform_match else ''
    hashtags = [_human_tag(m.group(1)) for m in _HASHTAG.finditer(raw)]
    title = ''
    performers = []
    scene = ''
    # A platform label followed by a name and a bracketed scene is a strong signal,
    # even in legacy captions whose line breaks were flattened.
    if platform_match:
        tail = raw[platform_match.end():]
        match = re.match(r"\s*([^\[\]#\n]{2,80}?)\s*\[([^\[\]\n]{2,160})\]", tail)
        if match and not _PROMO.search(match.group(1)):
            name = match.group(1).strip(' -–—:|')
            if name and len(name.split()) <= 5:
                performers = [name]
                scene = match.group(2).strip()
                title = name
    # Select non-promotional lines; headings and scene text may occur after ads.
    if not title:
        candidates = []
        for line in raw.splitlines():
            line = _HASHTAG.sub('', line).strip(' \t-–—|')
            if not line or _PROMO.search(line) or _GENERIC.match(line):
                continue
            if len(line) <= 180:
                candidates.append(line)
        if candidates:
            title = candidates[-1]
    # Prefer a stored title when it is meaningful; legacy promo titles should
    # yield to the scene title extracted from the caption.
    if fallback_title and not _PROMO.search(fallback_title) and not _GENERIC.match(fallback_title.strip()):
        title = fallback_title.strip()
    if not title and file_name:
        name = PurePath(file_name.replace('\\', '/')).stem.replace('_', ' ').strip()
        if name and not _GENERIC.match(name):
            title = name
    if not title:
        title = f'Telegram #{message_id}' if message_id else 'Telegram video'

    tags = []
    seen = {_key(x) for x in performers}
    if platform:
        seen.add(_key(platform))
    for tag in hashtags:
        key = _key(tag)
        if key and key not in seen:
            tags.append(tag)
            seen.add(key)
    return {'title': title[:180], 'performers': performers, 'scene_title': scene,
            'platform': platform, 'tags': tags[:20]}
