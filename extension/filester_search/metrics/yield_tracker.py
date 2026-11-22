
from __future__ import annotations
import time
from collections import defaultdict
from dataclasses import dataclass, field

@dataclass
class ChannelStats:
    requests: int = 0
    total_ids: int = 0
    unique_new: int = 0
    duplicates: int = 0
    errors: int = 0
    latency_ms_sum: float = 0.0

    @property
    def ids_per_request(self) -> float:
        return self.unique_new / self.requests if self.requests else 0.0

    @property
    def avg_latency(self) -> float:
        return self.latency_ms_sum / self.requests if self.requests else 0.0


class YieldTracker:
    """Compete discovery channels by measured novelty yield."""

    def __init__(self) -> None:
        self.channels: dict[str, ChannelStats] = defaultdict(ChannelStats)
        self.session_new: set[str] = set()
        self.seed_ids: set[str] = set()
        self.t0 = time.time()
        self.requests = 0

    def mark_seed(self, folder_id: str) -> None:
        if folder_id:
            self.seed_ids.add(folder_id.lower())

    def record(
        self,
        channel: str,
        *,
        ids: list[str],
        already_known: set[str],
        latency_ms: float,
        error: bool = False,
    ) -> list[str]:
        st = self.channels[channel]
        st.requests += 1
        self.requests += 1
        st.latency_ms_sum += latency_ms
        if error:
            st.errors += 1
            return []
        novel = []
        for i in ids:
            i = i.lower()
            st.total_ids += 1
            if i in self.seed_ids:
                st.duplicates += 1
                continue
            if i in already_known or i in self.session_new:
                st.duplicates += 1
                continue
            st.unique_new += 1
            self.session_new.add(i)
            novel.append(i)
        return novel

    def best_channel(self) -> str:
        best, score = "none", -1.0
        for name, st in self.channels.items():
            if st.requests < 1:
                continue
            if st.ids_per_request > score:
                score = st.ids_per_request
                best = name
        return best

    def summary(self) -> dict:
        elapsed = max(0.001, time.time() - self.t0)
        ch = {
            n: {
                "requests": s.requests,
                "unique_new": s.unique_new,
                "duplicates": s.duplicates,
                "ids_per_request": round(s.ids_per_request, 2),
                "avg_latency_ms": round(s.avg_latency, 1),
                "errors": s.errors,
            }
            for n, s in sorted(self.channels.items(), key=lambda x: -x[1].unique_new)
        }
        return {
            "session_new_ids": len(self.session_new),
            "seed_ids_excluded": len(self.seed_ids),
            "requests": self.requests,
            "ids_per_request": round(len(self.session_new) / max(1, self.requests), 2),
            "ids_per_minute": round(len(self.session_new) / (elapsed / 60.0), 1),
            "elapsed_s": round(elapsed, 1),
            "best_channel": self.best_channel(),
            "channels": ch,
        }
