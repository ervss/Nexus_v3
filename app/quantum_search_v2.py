"""Bounded concept matching and ranking for the optional Quantum Search 2 mode."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from difflib import SequenceMatcher

from .search_pipeline import normalized_words, quality_height


# Aliases describe equivalent search concepts. Keep this small and curated;
# fuzzy matching below handles spelling variants without broad query expansion.
ALIASES = (
    ("fake tits", "fake boobs", "faketits", "fake breasts"),
    ("deepthroat", "deep throat", "deepthorat", "facefuck"),
    ("pov", "point of view", "first person"),
)


def compact(value: str) -> str:
    return "".join(normalized_words(value))


def concepts(query: str) -> list[tuple[str, ...]]:
    words = normalized_words(query)
    found = []
    index = 0
    while index < len(words):
        match = None
        width = 0
        for group in ALIASES:
            for alias in group:
                parts = normalized_words(alias)
                if words[index:index + len(parts)] == parts and len(parts) > width:
                    match, width = group, len(parts)
        if match:
            entered = " ".join(words[index:index + width])
            found.append((entered, *(alias for alias in match if alias != entered)))
            index += width
        else:
            found.append((words[index],))
            index += 1
    return found


def variants(query: str) -> list[str]:
    """At most four query variants, including the original."""
    output = [query]
    for group in concepts(query):
        if len(group) < 2:
            continue
        for original in sorted(group, key=len, reverse=True):
            if re.search(re.escape(original), query, flags=re.I):
                alias = next((v for v in group if v.lower() != original.lower()), None)
                if alias:
                    changed = re.sub(re.escape(original), alias, query, count=1, flags=re.I)
                    if changed not in output:
                        output.append(changed)
                break
        if len(output) >= 4:
            return output
    return output


def _field(value) -> str:
    if isinstance(value, (list, tuple, set)):
        return " ".join(map(str, value))
    return str(value or "")


def _strength(group, words) -> int:
    text = f" {' '.join(words)} "
    for index, alias_words in enumerate(group):
        if f" {' '.join(alias_words)} " in text or (
            len(alias_words) > 1 and "".join(alias_words) in words
        ):
            return 3 if index == 0 else 2
    # Typo tolerance only for reasonably long tokens, with a high threshold.
    if len(group) == 1 and len(group[0]) == 1 and len(group[0][0]) >= 5:
        term = group[0][0]
        if any(abs(len(word) - len(term)) <= 2 and
               SequenceMatcher(None, term, word).ratio() >= .87 for word in words):
            return 1
    return 0


def compile_rank(query: str):
    groups = [[normalized_words(alias) for alias in group] for group in concepts(query)]
    phrase = " ".join(normalized_words(query))
    fields = (("title", 5), ("tags", 3), ("categories", 3),
              ("description", 1), ("performers", 2), ("models", 2),
              ("creator", 1), ("uploader", 1))

    def score(item: dict) -> tuple:
        tokens = [(normalized_words(_field(item.get(field))), weight) for field, weight in fields]
        matched = [max(_strength(group, words) * weight for words, weight in tokens)
                   for group in groups]
        coverage = sum(bool(value) for value in matched)
        exact_title = int(bool(phrase) and f" {phrase} " in f" {' '.join(tokens[0][0])} ")
        raw_date = item.get("upload_date") or item.get("published_at") or item.get("created_at")
        try:
            timestamp = datetime.fromisoformat(str(raw_date).replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            freshness = timestamp.timestamp()
        except (TypeError, ValueError, OverflowError, OSError):
            freshness = 0
        return (coverage == len(groups), coverage, exact_title, sum(matched),
                quality_height(item), freshness)

    return score


def rank(item: dict, query: str) -> tuple:
    return compile_rank(query)(item)
