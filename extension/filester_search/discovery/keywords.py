
from __future__ import annotations
import re
from collections import defaultdict

# Seed keywords — not special-cased beyond bootstrap; yields measured
DEFAULT_KEYWORDS = [
    "bbc", "school", "annie", "camera", "model", "cam", "onlyfans",
    "fit", "amateur", "collection", "video", "mp4", "photos",
]

# stopwords from titles that shouldn't become keywords
_STOP = {
    "the", "and", "for", "with", "from", "filester", "folder", "file",
    "video", "videos", "photo", "photos", "page", "all", "new",
}


def tokenize_title(title: str) -> list[str]:
    toks = re.findall(r"[a-zA-Z][a-zA-Z0-9_\-]{2,}", title or "")
    out = []
    for t in toks:
        tl = t.lower()
        if tl in _STOP or len(tl) < 3:
            continue
        out.append(tl)
    return out


class KeywordTracker:
    def __init__(self) -> None:
        self.stats: dict[str, dict] = defaultdict(lambda: {
            "queries": 0, "candidates": 0, "unique": set(), "content": 0,
        })

    def record_query(self, keyword: str, candidate_ids: list[str]) -> None:
        st = self.stats[keyword]
        st["queries"] += 1
        st["candidates"] += len(candidate_ids)
        st["unique"].update(candidate_ids)

    def record_content(self, keyword: str) -> None:
        self.stats[keyword]["content"] += 1

    def ranked(self) -> list[tuple[str, float]]:
        rows = []
        for kw, st in self.stats.items():
            y = st["content"] / st["queries"] if st["queries"] else 0.0
            rows.append((kw, y, st["queries"], len(st["unique"]), st["content"]))
        rows.sort(key=lambda x: (-x[1], -x[3]))
        return rows

    def expand_from_titles(self, titles: list[str], limit: int = 20) -> list[str]:
        counts: dict[str, int] = defaultdict(int)
        for t in titles:
            for tok in tokenize_title(t):
                counts[tok] += 1
        ranked = sorted(counts.items(), key=lambda x: -x[1])
        return [w for w, _ in ranked[:limit]]


KEYWORDS = KeywordTracker()
