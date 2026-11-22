from __future__ import annotations

from collections import Counter

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import Video, get_db
from app.source_catalog import classify_library_source_name, unknown_domain_from_urls


router = APIRouter(tags=["library-health"])


@router.get("/health/sources")
async def get_health_by_source(db: Session = Depends(get_db)):
    """Get health statistics grouped by source plus Unknown domain backlog."""
    videos = db.query(Video).all()

    sources = {}
    domain_counts: Counter = Counter()

    for video in videos:
        label = classify_library_source_name(video.url, video.source_url)
        if label == "Unknown":
            host = unknown_domain_from_urls(video.url, video.source_url)
            if host:
                domain_counts[host] += 1

        if label not in sources:
            sources[label] = {"total": 0, "working": 0, "broken": 0, "unknown": 0}

        sources[label]["total"] += 1
        status = video.link_status or "unknown"
        sources[label][status] = sources[label].get(status, 0) + 1

    source_list = []
    for name, stats in sources.items():
        score = (stats["working"] / stats["total"] * 100) if stats["total"] > 0 else 0
        source_list.append({
            "name": name,
            "score": round(score, 1),
            "stats": stats,
        })

    source_list.sort(key=lambda x: x["score"], reverse=True)

    unknown_domains = [
        {"host": host, "count": count}
        for host, count in domain_counts.most_common(50)
    ]

    return {"sources": source_list, "unknown_domains": unknown_domains}
