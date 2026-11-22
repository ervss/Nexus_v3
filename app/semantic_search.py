"""
Semantic search over the owned library (#4).

Builds a local text-embedding index over each video's title + tags + models +
categories, so the user can search by *meaning* — "blonde outdoors pov sunset"
finds matching scenes even when none of those words are in the title. No
external API; everything runs locally and incrementally on the scheduler.

Design notes
------------
* Embeddings come from `sentence-transformers` if installed (model
  `all-MiniLM-L6-v2`, ~80MB, CPU-fine). If it isn't installed we degrade to a
  deterministic hashing-bag vector so the feature still works (lower quality)
  and the app never hard-depends on the heavy package.
* The index is an in-memory matrix rebuilt incrementally; vectors are persisted
  per-video as JSON in the existing DB so restarts don't re-embed everything.
"""
from __future__ import annotations

import json
import logging
import math
import re
import threading
from typing import Optional

logger = logging.getLogger(__name__)

_model = None
_model_lock = threading.Lock()
# A single SentenceTransformer instance is NOT safe to call from multiple
# threads at once (especially on CUDA — concurrent .encode() calls can wedge
# the process). The boot-time reindex job and any request-path embed() would
# otherwise race on the same model and deadlock the whole server. Serialize all
# inference through this lock. It's separate from _model_lock so model loading
# and inference don't contend needlessly.
_encode_lock = threading.Lock()
_DIM_FALLBACK = 256

# in-memory index: parallel arrays
_ids: list[int] = []
_titles: list[str] = []
_vecs: list[list[float]] = []
_index_lock = threading.Lock()

_word_re = re.compile(r"[a-z0-9]+")


def _get_model():
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        try:
            from sentence_transformers import SentenceTransformer
            _model = SentenceTransformer("all-MiniLM-L6-v2")
            logger.info("[semantic] loaded sentence-transformers model")
        except Exception as exc:  # noqa: BLE001
            logger.info("[semantic] ST unavailable (%s) — using hashing fallback", exc)
            _model = False  # sentinel: use fallback
    return _model


def _hash_embed(text: str) -> list[float]:
    """Deterministic bag-of-hashed-tokens vector (l2-normalized)."""
    vec = [0.0] * _DIM_FALLBACK
    for tok in _word_re.findall(text.lower()):
        h = hash(tok) % _DIM_FALLBACK
        vec[h] += 1.0
    n = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / n for x in vec]


def embed(text: str) -> list[float]:
    m = _get_model()
    if m:
        try:
            with _encode_lock:
                v = m.encode(text, normalize_embeddings=True)
            return v.tolist() if hasattr(v, "tolist") else list(v)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[semantic] encode failed: %s", exc)
    return _hash_embed(text)


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed many texts at once. Uses the ST model's batched encode when
    available (far faster than one-by-one), else the hashing fallback."""
    if not texts:
        return []
    m = _get_model()
    if m:
        try:
            with _encode_lock:
                vs = m.encode(texts, normalize_embeddings=True, batch_size=64)
            return [v.tolist() if hasattr(v, "tolist") else list(v) for v in vs]
        except Exception as exc:  # noqa: BLE001
            logger.debug("[semantic] batch encode failed: %s", exc)
    return [_hash_embed(t) for t in texts]


def cosine(a: list[float], b: list[float]) -> float:
    return _cosine(a, b)


def _doc_text(v) -> str:
    parts = [v.title or "", v.tags or "", v.ai_tags or "",
             getattr(v, "models", "") or "", getattr(v, "categories", "") or ""]
    return " ".join(p for p in parts if p)


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    return sum(x * y for x, y in zip(a, b))  # both normalized


def build_index(rebuild: bool = False) -> dict:
    """(Re)build the in-memory index from the library.

    Embeds any video missing a stored vector and persists it back to the row
    (reusing the `subtitle`-adjacent JSON-free columns would be intrusive, so we
    keep vectors in a side column added lazily). Safe to call repeatedly.
    """
    from .database import SessionLocal, Video
    db = SessionLocal()
    embedded = 0
    try:
        _ensure_vector_column(db)
        rows = db.query(Video).filter(
            Video.duplicate_of.is_(None), Video.link_status != "broken",
        ).all()
        new_ids, new_titles, new_vecs = [], [], []
        for v in rows:
            stored = getattr(v, "semantic_vec", None)
            vec = None
            if stored and not rebuild:
                try:
                    vec = json.loads(stored)
                except Exception:  # noqa: BLE001
                    vec = None
            if vec is None:
                vec = embed(_doc_text(v))
                try:
                    v.semantic_vec = json.dumps(vec)
                    embedded += 1
                except Exception:  # noqa: BLE001
                    pass
            new_ids.append(v.id)
            new_titles.append(v.title or "")
            new_vecs.append(vec)
        if embedded:
            db.commit()
        with _index_lock:
            _ids[:] = new_ids
            _titles[:] = new_titles
            _vecs[:] = new_vecs
    except Exception as exc:  # noqa: BLE001
        logger.warning("[semantic] build_index failed: %s", exc)
        db.rollback()
    finally:
        db.close()
    return {"indexed": len(_ids), "newly_embedded": embedded,
            "model": "sentence-transformers" if _get_model() else "hashing-fallback"}


def _ensure_vector_column(db) -> None:
    from sqlalchemy import text
    try:
        cols = [r[1] for r in db.execute(text("PRAGMA table_info(videos)")).fetchall()]
        if "semantic_vec" not in cols:
            db.execute(text("ALTER TABLE videos ADD COLUMN semantic_vec TEXT"))
            db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.debug("[semantic] ensure column: %s", exc)


def search(query: str, top_k: int = 40) -> list[dict]:
    """Return the top_k library videos most semantically similar to *query*."""
    if not _ids:
        build_index()
    if not _ids:
        return []
    qv = embed(query)
    with _index_lock:
        scored = [(i, _cosine(qv, vec)) for i, vec in zip(_ids, _vecs)]
    scored.sort(key=lambda t: t[1], reverse=True)
    top = scored[:top_k]

    from .database import SessionLocal, Video
    db = SessionLocal()
    try:
        by_id = {v.id: v for v in db.query(Video).filter(
            Video.id.in_([i for i, _ in top])).all()}
        out = []
        for vid, score in top:
            v = by_id.get(vid)
            if not v:
                continue
            out.append({
                "id": v.id, "title": v.title, "score": round(float(score), 4),
                "thumbnail": v.thumbnail_path, "url": v.url,
                "duration": v.duration, "tags": v.tags,
            })
        return out
    finally:
        db.close()
