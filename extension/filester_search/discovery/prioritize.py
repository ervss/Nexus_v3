
from __future__ import annotations
"""Candidate prioritization learned from validation outcomes."""

import math
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class PriorStats:
    validated: int = 0
    content: int = 0
    dead: int = 0
    collection: int = 0

    @property
    def content_rate(self) -> float:
        return self.content / self.validated if self.validated else 0.35  # prior


class Prioritizer:
    def __init__(self) -> None:
        self.by_source: dict[str, PriorStats] = defaultdict(PriorStats)
        self.by_qclass: dict[str, PriorStats] = defaultdict(PriorStats)
        self.by_age: dict[str, PriorStats] = defaultdict(PriorStats)
        self.multi_source_bonus = 0.15

    def observe(self, *, source: str, query_class: str, age_bucket: str, folder_type: str) -> None:
        for bag, key in (
            (self.by_source, source),
            (self.by_qclass, query_class),
            (self.by_age, age_bucket),
        ):
            st = bag[key]
            st.validated += 1
            if folder_type == "CONTENT_FOLDER":
                st.content += 1
            elif folder_type == "DEAD":
                st.dead += 1
            elif folder_type == "COLLECTION":
                st.collection += 1

    def age_bucket(self, external_ts: str) -> str:
        """external_ts: wayback YYYYMMDDhhmmss or empty."""
        if not external_ts or len(external_ts) < 8:
            return "unknown"
        try:
            y, m, d = int(external_ts[:4]), int(external_ts[4:6]), int(external_ts[6:8])
            # rough days since 2026-09-30
            from datetime import date
            days = (date(2026, 9, 30) - date(y, m, d)).days
        except Exception:
            return "unknown"
        if days < 30:
            return "<30d"
        if days < 180:
            return "30-180d"
        if days < 365:
            return "180-365d"
        return ">1y"

    def score_candidate(
        self,
        *,
        sources: list[str],
        query_classes: list[str],
        external_ts: str = "",
        independent_source_count: int = 1,
    ) -> float:
        """Higher = validate sooner. Learns from observe()."""
        src_rates = [self.by_source[s].content_rate for s in sources] or [0.35]
        qc_rates = [self.by_qclass[q].content_rate for q in query_classes] or [0.35]
        age = self.age_bucket(external_ts)
        age_rate = self.by_age[age].content_rate

        base = 0.5 * max(src_rates) + 0.3 * max(qc_rates) + 0.2 * age_rate
        if independent_source_count > 1:
            base += self.multi_source_bonus * min(3, independent_source_count - 1)
        # slight preference for having any timestamp (historical observation exists)
        if external_ts:
            base += 0.05
        return base


# module-level prioritizer persists within process
PRIOR = Prioritizer()
