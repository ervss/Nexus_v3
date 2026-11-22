"""
Tnaflix profile & search cache — stores scraped results to disk so they can be
reopened instantly without re-fetching.

Folder layout (relative to project root):
  data/tnaflix_cache/
    profiles/
      <slug>.json          — profile cards + metadata
    searches/
      keyword/
        <slug>.json        — keyword search results
      category/
        <slug>.json        — category browse results
"""
import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from ..auth import check_auth

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tnaflix-cache"])

# ── Paths ──────────────────────────────────────────────────────────────────────
_BASE = Path(__file__).resolve().parent.parent.parent / "data" / "tnaflix_cache"
_PROFILES_DIR = _BASE / "profiles"
_SEARCHES_DIR = _BASE / "searches" / "keyword"
_CATEGORIES_DIR = _BASE / "searches" / "category"

for _d in (_PROFILES_DIR, _SEARCHES_DIR, _CATEGORIES_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def _slugify(text: str) -> str:
    """Turn any URL or text into a safe filename."""
    s = re.sub(r"https?://", "", str(text))
    s = re.sub(r"[^\w\-]", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s[:120] or "unknown"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ── Profile endpoints ──────────────────────────────────────────────────────────

@router.get("/tnaflix-cache/profiles")
async def list_cached_profiles(auth: bool = Depends(check_auth)):
    """Return summary list of all cached Tnaflix profiles, newest first."""
    items = []
    for p in sorted(_PROFILES_DIR.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True):
        data = _read_json(p)
        if not data:
            continue
        items.append({
            "slug": p.stem,
            "profile_url": data.get("profile_url", ""),
            "username": data.get("username", p.stem),
            "avatar": data.get("avatar", ""),
            "total_cards": data.get("total_cards", 0),
            "enriched_cards": data.get("enriched_cards", 0),
            "saved_at": data.get("saved_at", ""),
            "updated_at": data.get("updated_at", ""),
        })
    return {"profiles": items, "total": len(items)}


@router.get("/tnaflix-cache/profiles/{slug}")
async def get_cached_profile(slug: str, auth: bool = Depends(check_auth)):
    """Load a cached profile by slug."""
    path = _PROFILES_DIR / f"{slug}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Profile not cached")
    data = _read_json(path)
    if not data:
        raise HTTPException(status_code=500, detail="Corrupt cache file")
    return data


@router.put("/tnaflix-cache/profiles/{slug}")
async def save_cached_profile(slug: str, body: dict, auth: bool = Depends(check_auth)):
    """Create or update a cached profile on disk."""
    path = _PROFILES_DIR / f"{slug}.json"
    existing = _read_json(path) or {}
    cards = body.get("cards") or existing.get("cards") or []
    enriched = sum(1 for c in cards if c.get("_enriched"))
    payload = {
        **existing,
        **body,
        "slug": slug,
        "total_cards": len(cards),
        "enriched_cards": enriched,
        "updated_at": _now_iso(),
    }
    if not existing:
        payload["saved_at"] = _now_iso()
    _write_json(path, payload)
    return {"ok": True, "slug": slug, "total_cards": len(cards), "enriched_cards": enriched}


@router.delete("/tnaflix-cache/profiles/{slug}")
async def delete_cached_profile(slug: str, auth: bool = Depends(check_auth)):
    path = _PROFILES_DIR / f"{slug}.json"
    if path.exists():
        path.unlink()
    return {"ok": True}


# ── Slug helper (called from frontend to derive slug from URL) ─────────────────

@router.get("/tnaflix-cache/slug")
async def get_slug(url: str = "", keyword: str = "", category: str = "", auth: bool = Depends(check_auth)):
    """Return the canonical slug for a given profile URL, keyword, or category."""
    if url:
        return {"slug": _slugify(url), "type": "profile"}
    if keyword:
        return {"slug": _slugify(keyword), "type": "keyword"}
    if category:
        return {"slug": _slugify(category), "type": "category"}
    raise HTTPException(status_code=400, detail="Provide url, keyword or category")


# ── Search / Category cache endpoints ─────────────────────────────────────────

@router.get("/tnaflix-cache/searches")
async def list_cached_searches(auth: bool = Depends(check_auth)):
    """Return list of cached keyword searches and category browses, newest first."""
    def _read_dir(folder: Path, search_type: str):
        out = []
        for p in sorted(folder.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True):
            data = _read_json(p)
            if not data:
                continue
            out.append({
                "slug": p.stem,
                "type": search_type,
                "query": data.get("query", p.stem),
                "total_cards": data.get("total_cards", 0),
                "enriched_cards": data.get("enriched_cards", 0),
                "saved_at": data.get("saved_at", ""),
                "updated_at": data.get("updated_at", ""),
            })
        return out

    keyword_items = _read_dir(_SEARCHES_DIR, "keyword")
    category_items = _read_dir(_CATEGORIES_DIR, "category")
    items = sorted(keyword_items + category_items, key=lambda x: x.get("updated_at", ""), reverse=True)
    return {"searches": items, "total": len(items)}


@router.get("/tnaflix-cache/searches/{search_type}/{slug}")
async def get_cached_search(search_type: str, slug: str, auth: bool = Depends(check_auth)):
    """Load cached search results."""
    folder = _SEARCHES_DIR if search_type == "keyword" else _CATEGORIES_DIR
    path = folder / f"{slug}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Search not cached")
    data = _read_json(path)
    if not data:
        raise HTTPException(status_code=500, detail="Corrupt cache file")
    return data


@router.put("/tnaflix-cache/searches/{search_type}/{slug}")
async def save_cached_search(search_type: str, slug: str, body: dict, auth: bool = Depends(check_auth)):
    """Create or update cached search results on disk."""
    folder = _SEARCHES_DIR if search_type == "keyword" else _CATEGORIES_DIR
    path = folder / f"{slug}.json"
    existing = _read_json(path) or {}
    cards = body.get("cards") or existing.get("cards") or []
    enriched = sum(1 for c in cards if c.get("_enriched"))
    payload = {
        **existing,
        **body,
        "slug": slug,
        "type": search_type,
        "total_cards": len(cards),
        "enriched_cards": enriched,
        "updated_at": _now_iso(),
    }
    if not existing:
        payload["saved_at"] = _now_iso()
    _write_json(path, payload)
    return {"ok": True, "slug": slug, "total_cards": len(cards), "enriched_cards": enriched}


@router.delete("/tnaflix-cache/searches/{search_type}/{slug}")
async def delete_cached_search(search_type: str, slug: str, auth: bool = Depends(check_auth)):
    folder = _SEARCHES_DIR if search_type == "keyword" else _CATEGORIES_DIR
    path = folder / f"{slug}.json"
    if path.exists():
        path.unlink()
    return {"ok": True}
