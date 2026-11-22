"""Disk snapshots of completed Quantum Search Telegram searches."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

HISTORY_DIR = Path(__file__).resolve().parent.parent / "data" / "quantum_telegram_history"


def save_search(query: str, chats: list[dict], results: list[dict], displayed_results: list[dict], filters: dict) -> dict:
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    record = {
        "id": str(uuid4()),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "query": query,
        "chats": chats,
        "result_count": len(results),
        "filters": filters,
        "results": results,
        "displayed_results": displayed_results,
    }
    target = HISTORY_DIR / f"{record['id']}.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    temporary.replace(target)
    return {key: value for key, value in record.items() if key not in ("results", "displayed_results")}


def list_searches() -> list[dict]:
    if not HISTORY_DIR.exists():
        return []
    records = []
    for path in HISTORY_DIR.glob("*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            records.append({key: value for key, value in record.items() if key not in ("results", "displayed_results")})
        except (OSError, ValueError, TypeError):
            continue
    return sorted(records, key=lambda item: item.get("created_at", ""), reverse=True)


def get_search(search_id: str) -> dict | None:
    try:
        safe_id = str(UUID(search_id))
    except ValueError:
        return None
    path = HISTORY_DIR / f"{safe_id}.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))
