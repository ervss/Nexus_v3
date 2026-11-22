"""Lokálny GPU-akcelerovaný multimodálny index (SigLIP 2 / OpenCLIP) pre vizuálne a sémantické vyhľadávanie."""
from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import os
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx
import numpy as np
from PIL import Image

from .related_media import _CBIR_UA, resolve_local_thumb_path

logger = logging.getLogger(__name__)

_MODEL_LOCK = threading.Lock()
_INFER_LOCK = threading.Lock()
_INDEX_LOCK = threading.Lock()
_SYNC_LOCK = threading.Lock()

_MODEL_BUNDLE: Optional[Dict[str, Any]] = None
_MODEL_FAILED: bool = False
_INDEX_LOADED: bool = False
_SYNC_RUNNING: bool = False

# In-memory matice pre bleskové (<5ms) vyhľadávanie v knižnici
_VID_IDS: Optional[np.ndarray] = None
_IMG_MAT: Optional[np.ndarray] = None
_TXT_MAT: Optional[np.ndarray] = None
_META_MAP: Dict[int, Dict[str, Any]] = {}
_DIM: int = 0
_ACTIVE_MODEL_NAME: str = ""

_SYNC_STATS: Dict[str, Any] = {
    "running": False,
    "indexed": 0,
    "total": 0,
    "device": "cpu",
    "model": "",
    "last_duration_sec": 0.0,
    "last_error": "",
}


def _select_openclip_spec() -> Tuple[str, str]:
    """Vyberie najlepší dostupný SigLIP 2 / SigLIP / CLIP model z open_clip."""
    import open_clip

    preferred = [
        ("ViT-B-16-SigLIP2", "webli"),
        ("ViT-B-16-SigLIP", "webli"),
        ("MobileCLIP-S2", "datacompdr"),
        ("ViT-B-32", "laion2b_s34b_b79k"),
    ]
    available = set(open_clip.list_pretrained())
    for arch, pretrained in preferred:
        if (arch, pretrained) in available:
            return arch, pretrained
    # Fallback na prvý dostupný SigLIP2 alebo SigLIP variant
    for arch, pretrained in available:
        if "siglip2" in arch.lower():
            return arch, pretrained
    for arch, pretrained in available:
        if "siglip" in arch.lower():
            return arch, pretrained
    return "ViT-B-32", "laion2b_s34b_b79k"


def _get_model_bundle() -> Optional[Dict[str, Any]]:
    """Lazy-load SigLIP2/OpenCLIP modelu na GPU (RTX 3070) alebo CPU."""
    global _MODEL_BUNDLE, _MODEL_FAILED, _ACTIVE_MODEL_NAME
    if _MODEL_BUNDLE is not None:
        return _MODEL_BUNDLE
    if _MODEL_FAILED:
        return None

    with _MODEL_LOCK:
        if _MODEL_BUNDLE is not None:
            return _MODEL_BUNDLE
        if _MODEL_FAILED:
            return None
        try:
            import torch
            import open_clip

            arch, pretrained = _select_openclip_spec()
            device = "cuda" if torch.cuda.is_available() else "cpu"
            model, _, preprocess = open_clip.create_model_and_transforms(arch, pretrained=pretrained)
            tokenizer = open_clip.get_tokenizer(arch)
            model = model.to(device)
            model.eval()
            model_id = f"{arch}:{pretrained}"
            _ACTIVE_MODEL_NAME = model_id
            _SYNC_STATS["device"] = device
            _SYNC_STATS["model"] = model_id
            _MODEL_BUNDLE = {
                "torch": torch,
                "model": model,
                "preprocess": preprocess,
                "tokenizer": tokenizer,
                "device": device,
                "model_id": model_id,
            }
            logger.info("[VISUAL_INDEX] Načítaný model %s na zariadení %s", model_id, device)
            return _MODEL_BUNDLE
        except Exception as exc:
            logger.warning("[VISUAL_INDEX] Nepodarilo sa načítať OpenCLIP/SigLIP2: %s", exc)
            _SYNC_STATS["last_error"] = str(exc)[:200]
            _MODEL_FAILED = True
            return None


def is_gpu_ready() -> bool:
    """Vráti True, ak je nainštalovaný PyTorch s OpenCLIP (bez nutnosti načítať váhy)."""
    try:
        import importlib.util
        return bool(importlib.util.find_spec("torch") and importlib.util.find_spec("open_clip"))
    except Exception:
        return False


def get_status() -> Dict[str, Any]:
    """Vráti stav vizuálno-sémantického indexu pre diagnostiku a UI."""
    with _INDEX_LOCK:
        indexed_count = int(len(_VID_IDS)) if _VID_IDS is not None else 0
    return {
        "available": is_gpu_ready(),
        "loaded": _MODEL_BUNDLE is not None,
        "index_loaded": _INDEX_LOADED,
        "indexed_videos": indexed_count,
        "dim": _DIM,
        "model": _ACTIVE_MODEL_NAME or _SYNC_STATS.get("model") or "",
        "device": _SYNC_STATS.get("device") or "unknown",
        "syncing": _SYNC_RUNNING,
        "sync_stats": dict(_SYNC_STATS),
    }


def _encode_images_sync(images: List[Image.Image]) -> Optional[np.ndarray]:
    """Zakóduje zoznam PIL obrázkov na L2-normalizované float32 vektory."""
    if not images:
        return None
    bundle = _get_model_bundle()
    if not bundle:
        return None
    torch = bundle["torch"]
    model = bundle["model"]
    preprocess = bundle["preprocess"]
    device = bundle["device"]

    tensors = [preprocess(img.convert("RGB")) for img in images]
    batch = torch.stack(tensors).to(device)
    with _INFER_LOCK:
        with torch.no_grad():
            if device == "cuda":
                with torch.amp.autocast("cuda", dtype=torch.float16):
                    feats = model.encode_image(batch)
            else:
                feats = model.encode_image(batch)
            feats = feats.float()
            feats = feats / feats.norm(dim=-1, keepdim=True).clamp(min=1e-6)
            return feats.cpu().numpy().astype(np.float32)


def _encode_texts_sync(texts: List[str]) -> Optional[np.ndarray]:
    """Zakóduje zoznam textov na L2-normalizované float32 vektory."""
    if not texts:
        return None
    bundle = _get_model_bundle()
    if not bundle:
        return None
    torch = bundle["torch"]
    model = bundle["model"]
    tokenizer = bundle["tokenizer"]
    device = bundle["device"]

    tokens = tokenizer([t[:240] for t in texts]).to(device)
    with _INFER_LOCK:
        with torch.no_grad():
            if device == "cuda":
                with torch.amp.autocast("cuda", dtype=torch.float16):
                    feats = model.encode_text(tokens)
            else:
                feats = model.encode_text(tokens)
            feats = feats.float()
            feats = feats / feats.norm(dim=-1, keepdim=True).clamp(min=1e-6)
            return feats.cpu().numpy().astype(np.float32)


def _decode_image(img_bytes: bytes) -> Optional[Image.Image]:
    try:
        with Image.open(io.BytesIO(img_bytes)) as im:
            return im.convert("RGB")
    except Exception:
        return None


def _video_text_payload(video: Any) -> str:
    from .related_query_planner import extract_actors_from_tag_strings, sanitize_video_tags_csv

    raw_tags = str(getattr(video, "tags", "") or "")
    raw_ai = str(getattr(video, "ai_tags", "") or "")
    actors = extract_actors_from_tag_strings(raw_ai, raw_tags)
    parts = [
        str(getattr(video, "title", "") or ""),
        str(getattr(video, "models", "") or ""),
        " ".join(actors),
        sanitize_video_tags_csv(raw_tags),
        sanitize_video_tags_csv(raw_ai),
        sanitize_video_tags_csv(str(getattr(video, "categories", "") or "")),
    ]
    return re_clean_spaces(" ".join(p for p in parts if p))


def re_clean_spaces(text: str) -> str:
    return " ".join((text or "").replace("_", " ").replace(",", " ").split())[:300]


def _thumb_signature(video: Any) -> str:
    thumb = str(getattr(video, "thumbnail_path", "") or "").strip()
    if not thumb:
        return ""
    local = resolve_local_thumb_path(thumb)
    if local is not None:
        try:
            st = local.stat()
            return hashlib.sha1(f"{local}:{st.st_size}:{int(st.st_mtime)}".encode()).hexdigest()[:24]
        except Exception:
            pass
    return hashlib.sha1(thumb.encode("utf-8", errors="ignore")).hexdigest()[:24]


def _text_signature(text: str) -> str:
    return hashlib.sha1((text or "").encode("utf-8", errors="ignore")).hexdigest()[:24]


def load_index_from_db(force: bool = False) -> int:
    """Načíta uložené embeddingy a základné metadáta videí z SQLite do RAM matíc."""
    global _VID_IDS, _IMG_MAT, _TXT_MAT, _META_MAP, _DIM, _INDEX_LOADED, _ACTIVE_MODEL_NAME
    if _INDEX_LOADED and not force:
        return int(len(_VID_IDS)) if _VID_IDS is not None else 0

    from .database import SessionLocal, Video, VideoEmbedding

    db = SessionLocal()
    try:
        emb_rows = db.query(VideoEmbedding).all()
        if not emb_rows:
            with _INDEX_LOCK:
                _VID_IDS = np.zeros((0,), dtype=np.int64)
                _IMG_MAT = None
                _TXT_MAT = None
                _META_MAP = {}
                _INDEX_LOADED = True
            return 0

        # Načítame metadáta videí v jednom rýchlom SELECTe
        video_rows = db.query(
            Video.id, Video.title, Video.url, Video.source_url,
            Video.thumbnail_path, Video.duration, Video.height,
            Video.views, Video.tags, Video.ai_tags, Video.models,
        ).filter(Video.duplicate_of.is_(None)).all()

        meta_lookup: Dict[int, Dict[str, Any]] = {}
        for r in video_rows:
            meta_lookup[int(r[0])] = {
                "video_id": int(r[0]),
                "title": r[1] or "Video v knižnici",
                "url": r[3] or r[2] or "",
                "thumbnail": r[4] or "",
                "duration": int(r[5] or 0),
                "height": int(r[6] or 0),
                "views": int(r[7] or 0),
                "tags": r[8] or "",
                "ai_tags": r[9] or "",
                "models": r[10] or "",
            }

        ids: List[int] = []
        img_vecs: List[np.ndarray] = []
        txt_vecs: List[np.ndarray] = []
        target_dim = 0
        target_model = ""

        # Zistíme dominantný model/dim, aby mali všetky riadky rovnaký tvar
        for row in emb_rows:
            if row.image_vec and row.dim and row.video_id in meta_lookup:
                target_dim = int(row.dim)
                target_model = str(row.model_name or "")
                break

        if not target_dim:
            with _INDEX_LOCK:
                _INDEX_LOADED = True
            return 0

        zero_vec = np.zeros((target_dim,), dtype=np.float32)
        for row in emb_rows:
            vid = int(row.video_id)
            if vid not in meta_lookup or int(row.dim or 0) != target_dim:
                continue
            if target_model and row.model_name and row.model_name != target_model:
                continue
            try:
                iv = np.frombuffer(row.image_vec, dtype=np.float16).astype(np.float32) if row.image_vec else zero_vec
                tv = np.frombuffer(row.text_vec, dtype=np.float16).astype(np.float32) if row.text_vec else zero_vec
                if iv.shape[0] != target_dim or tv.shape[0] != target_dim:
                    continue
                ids.append(vid)
                img_vecs.append(iv)
                txt_vecs.append(tv)
            except Exception:
                continue

        with _INDEX_LOCK:
            if ids:
                _VID_IDS = np.array(ids, dtype=np.int64)
                _IMG_MAT = np.vstack(img_vecs)
                _TXT_MAT = np.vstack(txt_vecs)
                _META_MAP = {vid: meta_lookup[vid] for vid in ids if vid in meta_lookup}
                _DIM = target_dim
                if not _ACTIVE_MODEL_NAME:
                    _ACTIVE_MODEL_NAME = target_model
            else:
                _VID_IDS = np.zeros((0,), dtype=np.int64)
                _IMG_MAT = None
                _TXT_MAT = None
                _META_MAP = {}
            _INDEX_LOADED = True
            return len(ids)
    except Exception as exc:
        logger.debug("[VISUAL_INDEX] Načítanie z DB zlyhalo: %s", exc)
        return 0
    finally:
        db.close()


def sync_library_embeddings(
    limit: int = 0,
    batch_size: int = 64,
    progress_cb: Optional[Callable[[int, int], None]] = None,
) -> Dict[str, Any]:
    """Inkrementálne zakóduje chýbajúce alebo zmenené videá z knižnice na RTX 3070."""
    global _SYNC_RUNNING
    if not is_gpu_ready():
        return {"status": "unavailable", "indexed": 0, "total": 0}
    if not _SYNC_LOCK.acquire(blocking=False):
        return {"status": "already_running", "indexed": _SYNC_STATS.get("indexed", 0), "total": _SYNC_STATS.get("total", 0)}

    started = time.perf_counter()
    _SYNC_RUNNING = True
    _SYNC_STATS["running"] = True
    _SYNC_STATS["last_error"] = ""
    indexed = 0
    total_todo = 0

    try:
        bundle = _get_model_bundle()
        if not bundle:
            return {"status": "model_error", "indexed": 0, "total": 0, "error": _SYNC_STATS.get("last_error", "")}

        model_id = bundle["model_id"]
        from .database import SessionLocal, Video, VideoEmbedding

        db = SessionLocal()
        try:
            existing = {
                int(r[0]): (r[1], r[2], r[3])
                for r in db.query(
                    VideoEmbedding.video_id,
                    VideoEmbedding.model_name,
                    VideoEmbedding.thumb_sig,
                    VideoEmbedding.text_sig,
                ).all()
            }
            q = db.query(Video).filter(Video.duplicate_of.is_(None)).order_by(Video.id.desc())
            if limit and limit > 0:
                q = q.limit(limit)
            videos = q.all()

            todo: List[Tuple[Any, str, str, str]] = []
            for v in videos:
                t_sig = _thumb_signature(v)
                txt = _video_text_payload(v)
                x_sig = _text_signature(txt)
                prev = existing.get(int(v.id))
                if prev and prev[0] == model_id and prev[1] == t_sig and prev[2] == x_sig:
                    continue
                if not t_sig and not txt:
                    continue
                todo.append((v, t_sig, txt, x_sig))

            total_todo = len(todo)
            _SYNC_STATS["total"] = total_todo
            _SYNC_STATS["indexed"] = 0

            for start in range(0, total_todo, batch_size):
                chunk = todo[start:start + batch_size]
                imgs: List[Image.Image] = []
                img_positions: List[int] = []
                texts: List[str] = []
                txt_positions: List[int] = []

                for idx, (v, _t_sig, txt, _x_sig) in enumerate(chunk):
                    local_path = resolve_local_thumb_path(str(v.thumbnail_path or ""))
                    if local_path is not None:
                        try:
                            with Image.open(local_path) as im:
                                imgs.append(im.convert("RGB"))
                                img_positions.append(idx)
                        except Exception:
                            pass
                    if txt:
                        texts.append(txt)
                        txt_positions.append(idx)

                img_vecs = _encode_images_sync(imgs) if imgs else None
                txt_vecs = _encode_texts_sync(texts) if texts else None

                dim = 0
                if img_vecs is not None and len(img_vecs) > 0:
                    dim = int(img_vecs.shape[1])
                elif txt_vecs is not None and len(txt_vecs) > 0:
                    dim = int(txt_vecs.shape[1])
                if not dim:
                    continue

                img_by_idx = {pos: img_vecs[i] for i, pos in enumerate(img_positions)} if img_vecs is not None else {}
                txt_by_idx = {pos: txt_vecs[i] for i, pos in enumerate(txt_positions)} if txt_vecs is not None else {}

                for idx, (v, t_sig, _txt, x_sig) in enumerate(chunk):
                    iv = img_by_idx.get(idx)
                    tv = txt_by_idx.get(idx)
                    iv_blob = iv.astype(np.float16).tobytes() if iv is not None else None
                    tv_blob = tv.astype(np.float16).tobytes() if tv is not None else None

                    row = db.query(VideoEmbedding).filter(VideoEmbedding.video_id == int(v.id)).first()
                    if not row:
                        row = VideoEmbedding(
                            video_id=int(v.id),
                            model_name=model_id,
                            dim=dim,
                            thumb_sig=t_sig,
                            text_sig=x_sig,
                            image_vec=iv_blob,
                            text_vec=tv_blob,
                        )
                        db.add(row)
                    else:
                        row.model_name = model_id
                        row.dim = dim
                        row.thumb_sig = t_sig
                        row.text_sig = x_sig
                        if iv_blob is not None:
                            row.image_vec = iv_blob
                        if tv_blob is not None:
                            row.text_vec = tv_blob
                    indexed += 1

                db.commit()
                _SYNC_STATS["indexed"] = indexed
                if progress_cb:
                    try:
                        progress_cb(indexed, total_todo)
                    except Exception:
                        pass

            load_index_from_db(force=True)
        finally:
            db.close()

        elapsed = round(time.perf_counter() - started, 2)
        _SYNC_STATS["last_duration_sec"] = elapsed
        logger.info("[VISUAL_INDEX] Sync dokončený: %d/%d videí za %.2fs", indexed, total_todo, elapsed)
        return {"status": "ok", "indexed": indexed, "total": total_todo, "elapsed_sec": elapsed}
    except Exception as exc:
        logger.warning("[VISUAL_INDEX] Sync zlyhal: %s", exc)
        _SYNC_STATS["last_error"] = str(exc)[:200]
        return {"status": "error", "indexed": indexed, "total": total_todo, "error": str(exc)}
    finally:
        _SYNC_RUNNING = False
        _SYNC_STATS["running"] = False
        _SYNC_LOCK.release()


def _siglip_cosine_to_pct(cos_sim: float) -> int:
    """Kalibrovaný prevod SigLIP2 kosínovej podobnosti na percento (100% len pre takmer identický rám)."""
    v = float(cos_sim or 0.0)
    if v >= 0.95:
        pct = 88.0 + ((v - 0.95) / 0.05) * 12.0
    elif v >= 0.82:
        pct = 52.0 + ((v - 0.82) / 0.13) * 35.0
    elif v >= 0.62:
        pct = 18.0 + ((v - 0.62) / 0.20) * 33.0
    else:
        pct = max(0.0, (v - 0.35) / 0.27 * 18.0)
    return int(max(0, min(100, round(pct))))


def search_similar_in_library_sync(
    image_bytes: Optional[bytes] = None,
    query_text: str = "",
    top_k: int = 36,
    exclude_video_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Vyhľadá vizuálne a sémanticky podobné videá v lokálnej knižnici za < 5 ms."""
    if not is_gpu_ready():
        return []
    load_index_from_db(force=False)

    with _INDEX_LOCK:
        if _VID_IDS is None or len(_VID_IDS) == 0 or _IMG_MAT is None:
            return []
        vid_ids = _VID_IDS
        img_mat = _IMG_MAT
        txt_mat = _TXT_MAT
        meta_map = _META_MAP

    q_img_vec: Optional[np.ndarray] = None
    q_txt_vec: Optional[np.ndarray] = None

    if image_bytes:
        pil_img = _decode_image(image_bytes)
        if pil_img is not None:
            enc = _encode_images_sync([pil_img])
            if enc is not None and len(enc) > 0:
                q_img_vec = enc[0]

    clean_q = (query_text or "").strip()
    if clean_q:
        enc_t = _encode_texts_sync([clean_q])
        if enc_t is not None and len(enc_t) > 0:
            q_txt_vec = enc_t[0]

    if q_img_vec is None and q_txt_vec is None:
        return []

    # Spočítame kosínové podobnosti voči celej matici v RAM
    img_scores = (img_mat @ q_img_vec) if q_img_vec is not None else np.zeros((len(vid_ids),), dtype=np.float32)
    txt_scores = np.zeros((len(vid_ids),), dtype=np.float32)
    if txt_mat is not None:
        if q_txt_vec is not None:
            txt_scores = np.maximum(txt_scores, txt_mat @ q_txt_vec)
        if q_img_vec is not None:
            # Cross-modal: obrázok vs textové tagy v knižnici
            txt_scores = np.maximum(txt_scores, txt_mat @ q_img_vec)

    # Vážená kombinácia vizuálnej (70 %) a textovo-sémantickej (30 %) zhody
    if q_img_vec is not None and q_txt_vec is not None:
        combined = 0.72 * img_scores + 0.28 * txt_scores
    elif q_img_vec is not None:
        combined = 0.85 * img_scores + 0.15 * txt_scores
    else:
        combined = 0.55 * (img_mat @ q_txt_vec) + 0.45 * txt_scores

    k = min(len(vid_ids), max(top_k + 24, 48))
    top_indices = np.argpartition(combined, -k)[-k:]
    top_indices = top_indices[np.argsort(combined[top_indices])[::-1]]

    seed_meta = meta_map.get(int(exclude_video_id)) if exclude_video_id is not None else None
    seed_thumb = str((seed_meta or {}).get("thumbnail") or "").strip()
    seed_title = str((seed_meta or {}).get("title") or "").strip().lower()
    seed_dur = int((seed_meta or {}).get("duration") or 0)
    seen_clones = set()
    seen_titles = set()

    results: List[Dict[str, Any]] = []
    for idx in top_indices:
        vid = int(vid_ids[idx])
        if exclude_video_id is not None and vid == int(exclude_video_id):
            continue
        raw_sim = float(combined[idx])
        vis_sim = float(img_scores[idx])
        norm_vis = _siglip_cosine_to_pct(vis_sim)
        norm_comb = float(max(0.0, min(100.0, round(_siglip_cosine_to_pct(raw_sim), 1))))
        if norm_comb < 12.0:
            continue

        meta = dict(meta_map.get(vid) or {})
        if not meta:
            continue
        m_thumb = str(meta.get("thumbnail") or "").strip()
        m_title = str(meta.get("title") or "").strip().lower()
        m_dur = int(meta.get("duration") or 0)
        if seed_meta is not None:
            if seed_thumb and m_thumb and m_thumb == seed_thumb:
                continue
            if seed_title and m_title == seed_title and (seed_dur <= 0 or m_dur <= 0 or abs(seed_dur - m_dur) <= 2):
                continue
        clone_key = (m_title, m_thumb)
        if clone_key in seen_clones and (m_thumb or m_title):
            continue
        if len(m_title) >= 6 and m_title in seen_titles:
            continue
        seen_clones.add(clone_key)
        if len(m_title) >= 6:
            seen_titles.add(m_title)

        meta["is_library"] = True
        meta["source"] = "library"
        meta["visual_score"] = norm_vis
        meta["semantic_sim"] = round(raw_sim, 3)
        meta["relevancy_score"] = norm_comb
        meta["reason"] = f"V knižnici · vizuálna zhoda {norm_vis}%" if norm_vis >= 45 else "V knižnici · sémantická zhoda"
        results.append(meta)
        if len(results) >= top_k:
            break

    return results


def _compute_dhash64(img: Image.Image) -> int:
    """Rýchly 64-bitový difference hash (dHash) na rozoznanie identických záberov."""
    gray = img.convert("L").resize((9, 8), Image.Resampling.BILINEAR)
    px = list(gray.getdata())
    bits = 0
    for row in range(8):
        off = row * 9
        for col in range(8):
            if px[off + col] > px[off + col + 1]:
                bits |= 1 << (row * 8 + col)
    return bits


def _hamming64(a: int, b: int) -> int:
    return (a ^ b).bit_count()


async def score_candidate_thumbnails(
    ref_bytes: bytes,
    candidates: List[Dict[str, Any]],
    max_fetch: int = 64,
) -> int:
    """Stiahne náhľady externých kandidátov a spočíta GPU SigLIP2 + dHash zhodu."""
    if not ref_bytes or not candidates or not is_gpu_ready():
        return 0
    ref_img = _decode_image(ref_bytes)
    if ref_img is None:
        return 0
    ref_dhash = _compute_dhash64(ref_img)

    # Prioritizujeme výsledky z vizuálnych CBIR enginov (SerpApi/Yandex/Vision), aby ich nevytlačili keyword hity
    with_thumb = [c for c in candidates if str(c.get("thumbnail") or "").startswith(("http", "//"))]
    with_thumb.sort(
        key=lambda c: (
            1 if str(c.get("source") or "").lower() in {"serpapi", "yandex", "google_vision", "browser_lens", "namethatporn"} else 0,
            1 if c.get("match_type") in {"exact", "partial"} else 0,
        ),
        reverse=True,
    )
    targets = with_thumb[:max_fetch]
    if not targets:
        return 0

    sem = asyncio.Semaphore(12)
    fetched: List[Tuple[Dict[str, Any], Image.Image]] = []

    async def _fetch_one(cl: httpx.AsyncClient, item: Dict[str, Any]) -> None:
        thumb = str(item.get("thumbnail") or "")
        if thumb.startswith("//"):
            thumb = "https:" + thumb
        try:
            async with sem:
                resp = await cl.get(thumb)
                if resp.status_code == 200 and len(resp.content) > 500:
                    pil = _decode_image(resp.content)
                    if pil is not None:
                        fetched.append((item, pil))
        except Exception:
            pass

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(4.5, connect=2.5),
        follow_redirects=True,
        headers={"User-Agent": _CBIR_UA, "Accept": "image/*,*/*;q=0.8"},
    ) as cl:
        await asyncio.gather(*[_fetch_one(cl, t) for t in targets], return_exceptions=True)

    if not fetched:
        return 0

    def _run_gpu() -> int:
        all_imgs = [ref_img] + [pil for _, pil in fetched]
        vecs = _encode_images_sync(all_imgs)
        if vecs is None or len(vecs) != len(all_imgs):
            return 0
        ref_v = vecs[0]
        cand_vs = vecs[1:]
        sims = cand_vs @ ref_v
        scored = 0
        for (item, pil), sim in zip(fetched, sims):
            s_val = float(sim)
            pct = _siglip_cosine_to_pct(s_val)
            dhash_dist = _hamming64(ref_dhash, _compute_dhash64(pil))
            item["dhash_dist"] = dhash_dist
            item["gpu_visual_sim"] = round(s_val, 3)

            # Skutočná zhoda totožného záberu: nízka dHash vzdialenosť + vysoký SigLIP2, alebo veľmi vysoký SigLIP2 >= 0.94
            if (dhash_dist <= 10 and s_val >= 0.84) or s_val >= 0.945:
                item["exact_frame"] = True
                item["match_type"] = "exact"
                pct = max(pct, min(99, 91 + max(0, 10 - dhash_dist)))
            item["visual_score"] = max(int(item.get("visual_score") or 0), pct)
            scored += 1
        return scored

    return await asyncio.to_thread(_run_gpu)
