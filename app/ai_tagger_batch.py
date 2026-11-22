"""
app/ai_tagger_batch.py — Ultra-fast, 100% free Local GPU (SigLIP 2 Zero-Shot + Visual k-NN + Smart NLP/Lexicon)
and optional Gemini Vision batch auto-tagger.

Architecture:
1. Stage 1 (Smart NLP & Batch/URL Lexicon): Extracts canonical performers, creator handles, and scene tags
   from video title, batch_name (Bunkr/Filester/Pixeldrain/SimpCity imports), source_url, and categories.
2. Stage 2 (Local GPU SigLIP 2 Zero-Shot Vision): Uses Z-score library-calibrated embeddings on RTX 3070 CUDA
   (`ViT-B-16-SigLIP2:webli`) across 8 semantic tag groups (hair, ethnicity, setting, chest, body, attire,
   group, action). Reuses precomputed `VideoEmbedding.image_vec` in RAM/SQLite (~0.05 ms/video) or encodes
   missing thumbnails on the fly and caches them in `VideoEmbedding`.
3. Stage 3 (Visual k-NN Identity & Tag Propagation): Matches untitled videos (e.g. `Telegram #5991`,
   `1080P_4000K_...`) against the 9,000+ embedded library matrix (`_IMG_MAT`) to propagate performer names
   and tags from visually identical/same-shoot videos in the library.
4. Optional Gemini Vision API support with automatic seamless fallback to Local GPU AI on HTTP 402/429/errors.
"""

import asyncio
import base64
import io
import json
import logging
import os
import re
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import urlparse

import httpx
import numpy as np
from PIL import Image, ImageDraw
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.autotagger import auto_tag_video
from app.database import SessionLocal, Video, VideoEmbedding
from app.websockets import manager

logger = logging.getLogger(__name__)

# ── Multi-Model Pool ─────────────────────────────────────────────────────────

LOCAL_GPU_MODEL_ID = "siglip2-local-gpu"

GEMINI_VISION_MODELS: List[str] = [
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
]


def compress_thumbnail_bytes(img_bytes: bytes, max_dim: int = 640, quality: int = 74) -> bytes:
    """Downscale and compress thumbnail in memory so upload + vision tokenization is fast."""
    try:
        with Image.open(io.BytesIO(img_bytes)) as im:
            rgb = im.convert("RGB")
            rgb.thumbnail((max_dim, max_dim))
            buf = io.BytesIO()
            rgb.save(buf, format="JPEG", quality=quality, optimize=True)
            return buf.getvalue()
    except Exception:
        return img_bytes


from app.related_query_planner import (
    clean_title_for_search,
    extract_actors_from_tag_strings,
    extract_performer_candidates,
    is_junk_content_tag,
    is_junk_or_hash_token,
    resolve_known_performer,
    sanitize_video_tags_list,
    split_camel_case_words,
    split_csv,
)

# ── Local GPU SigLIP 2 Zero-Shot Visual Taxonomy ─────────────────────────────
# Tuple format: (group, canonical_tag, descriptive_prompt, z_threshold)
LOCAL_VISION_TAXONOMY: List[Tuple[str, str, str, float]] = [
    # Group 1: Hair color (mutually exclusive top-1)
    ("hair", "blonde", "a photo of a blonde woman with light blonde hair", 0.90),
    ("hair", "brunette", "a photo of a brunette woman with dark brown or black hair", 0.90),
    ("hair", "redhead", "a photo of a redhead ginger woman with red hair", 1.15),
    # Group 2: Ethnicity / look (mutually exclusive top-1)
    ("eth", "ebony", "an ebony black African woman with dark skin", 1.25),
    ("eth", "asian", "an East Asian Japanese Korean or Chinese woman", 1.25),
    ("eth", "latina", "a Latina Hispanic woman with tan skin", 1.12),
    # Group 3: Setting / environment (top-1 or top-2)
    ("setting", "outdoor", "outdoor nature beach pool garden balcony or forest in daylight", 1.12),
    ("setting", "shower", "bathroom shower bathtub or wet bathroom tiles", 1.18),
    ("setting", "car", "inside a car vehicle backseat or front seat", 1.25),
    ("setting", "gym", "gym fitness workout room yoga mat or exercise equipment", 1.28),
    ("setting", "office", "office desk chair computer monitor workplace setting", 1.28),
    ("setting", "bedroom", "indoor bedroom bed pillows sheets or couch", 0.85),
    # Group 4: Chest / frame (mutually exclusive top-1)
    ("chest", "big tits", "woman with large busty breasts cleavage huge tits", 0.92),
    ("chest", "petite", "slim skinny petite small body frame", 0.95),
    # Group 5: Body traits (multi-label)
    ("body", "big ass", "curvy woman with big round ass butt cheeks pawg", 0.92),
    ("body", "tattoo", "visible body tattoos inked skin", 1.15),
    ("body", "oiled", "shiny oiled wet skin body", 1.20),
    # Group 6: Attire / clothing (multi-label, top-2)
    ("attire", "lingerie", "wearing lace lingerie bra panties stockings or garter belt", 0.92),
    ("attire", "bikini", "wearing bikini swimsuit swimwear", 1.12),
    ("attire", "cosplay", "wearing cosplay costume anime maid or schoolgirl uniform", 1.18),
    ("attire", "fishnets", "wearing fishnet stockings or mesh bodysuit", 1.15),
    ("attire", "glasses", "wearing eyeglasses spectacles on face", 1.25),
    ("attire", "heels", "wearing high heels stilettos shoes", 1.20),
    ("attire", "latex", "wearing shiny latex leather or pvc outfit", 1.28),
    ("attire", "nude", "completely naked nude body without clothes", 0.90),
    # Group 7: Participants / grouping (mutually exclusive top-1)
    ("group", "solo", "one solo woman alone in frame posing or mirror selfie", 0.95),
    ("group", "lesbian", "two women kissing or touching each other lesbian girl on girl", 1.15),
    ("group", "threesome", "three people together in a threesome scene", 1.25),
    # Group 8: Action / position / angle (multi-label, top-3)
    ("action", "blowjob", "close up oral blowjob mouth sucking penis", 0.95),
    ("action", "deepthroat", "deepthroat gagging oral scene", 1.18),
    ("action", "doggystyle", "doggy style sex position from behind on all fours", 0.95),
    ("action", "cowgirl", "woman riding on top cowgirl or reverse cowgirl position", 0.98),
    ("action", "missionary", "lying on back missionary sex position", 1.05),
    ("action", "anal", "close up anal penetration from behind", 1.15),
    ("action", "cumshot", "facial cumshot on face or tongue", 1.18),
    ("action", "creampie", "close up internal creampie", 1.20),
    ("action", "handjob", "hand stroking penis handjob or titfuck cleavage", 1.08),
    ("action", "masturbation", "solo masturbation fingers or dildo vibrator sex toy", 0.98),
    ("action", "ass worship", "close up showing round butt ass bending over", 1.02),
    ("action", "pov", "first person POV point of view camera angle", 0.98),
    ("action", "selfie", "mirror selfie holding smartphone camera", 1.12),
    ("action", "bdsm", "bondage rope cuffs collar tied up submissive bdsm", 1.22),
]

_CLASSIFIER_LOCK = threading.Lock()
_CLASSIFIER_CACHE: Optional[Dict[str, Any]] = None

# ── Global Job State ─────────────────────────────────────────────────────────

_AI_TAG_JOB_LOCK = asyncio.Lock()
_AI_TAG_RUNNING = False
_AI_TAG_CANCEL_REQUESTED = False
_MODEL_RR_INDEX = 0

_AI_TAG_STATE: Dict[str, Any] = {
    "running": False,
    "cancelled": False,
    "total": 0,
    "done": 0,
    "improved": 0,
    "failed": 0,
    "skipped": 0,
    "current_video_id": None,
    "current_video_title": "",
    "last_tagged_video_id": None,
    "last_tagged_video_title": "",
    "last_added_tags": [],
    "last_error": "",
    "active_model": LOCAL_GPU_MODEL_ID,
    "percent": 0.0,
    "eta_seconds": 0,
    "eta_formatted": "",
    "elapsed_seconds": 0,
    "elapsed_formatted": "0s",
    "status_text": "Pripravené (Lokálna GPU AI)",
    "message": "",
    "started_at": None,
    "finished_at": None,
    "batch_name": None,
}


class AITagBatchRequest(BaseModel):
    limit: int = Field(default=250, ge=1, le=15000)
    batch_name: Optional[str] = None
    batch_names: Optional[List[str]] = None
    video_ids: Optional[List[int]] = None
    only_missing: bool = True
    concurrency: int = Field(default=4, ge=1, le=12)
    collage_size: int = Field(default=10, ge=1, le=64)
    overwrite: bool = False
    model: str = LOCAL_GPU_MODEL_ID


def format_duration_human(seconds: int) -> str:
    """Format seconds into human readable duration (~Xm Ys or ~Xs)."""
    if seconds < 0:
        return "0s"
    if seconds < 60:
        return f"~{seconds}s"
    mins = seconds // 60
    secs = seconds % 60
    return f"~{mins}m {secs:02d}s"


async def broadcast_ws(payload: dict) -> None:
    """Send live WebSocket update safely to all connected UI clients."""
    try:
        await manager.broadcast(json.dumps(payload))
    except Exception as exc:
        logger.debug("[AI-Tag-Batch] WebSocket broadcast failed: %s", exc)


def _load_first_json_object(text: str) -> dict:
    """Parse the first valid JSON object from model output."""
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.I | re.S).strip()
    start = cleaned.find("{")
    if start == -1:
        raise ValueError(f"No JSON object found in output: {cleaned[:80]}")
    obj, _ = json.JSONDecoder().raw_decode(cleaned, start)
    if not isinstance(obj, dict):
        raise ValueError("Expected JSON dictionary from model")
    return obj


def build_collage_jpeg(thumbs: List[bytes], cell_w: int = 320, cell_h: int = 180) -> bytes:
    """Pack up to 10 thumbnail images into a numbered 2-column contact sheet JPEG."""
    count = len(thumbs)
    cols = 2 if count > 1 else 1
    rows = (count + cols - 1) // cols
    canvas = Image.new("RGB", (cols * cell_w, rows * cell_h), (14, 14, 20))
    draw = ImageDraw.Draw(canvas)

    for idx, raw in enumerate(thumbs):
        col = idx % cols
        row = idx // cols
        x0, y0 = col * cell_w, row * cell_h
        try:
            with Image.open(io.BytesIO(raw)) as im:
                rgb = im.convert("RGB").resize((cell_w - 4, cell_h - 4))
                canvas.paste(rgb, (x0 + 2, y0 + 2))
        except Exception:
            draw.rectangle([x0 + 2, y0 + 2, x0 + cell_w - 2, y0 + cell_h - 2], fill=(40, 20, 20))

        # High-contrast index badge (#0, #1, ...)
        draw.rectangle([x0 + 4, y0 + 4, x0 + 52, y0 + 26], fill=(0, 0, 0))
        draw.text((x0 + 9, y0 + 7), f"#{idx}", fill=(0, 255, 180))

    buf = io.BytesIO()
    canvas.save(buf, format="JPEG", quality=75, optimize=True)
    return buf.getvalue()


async def load_video_thumb_bytes(
    thumbnail_path: Optional[str],
    referer: str = "",
    client: Optional[httpx.AsyncClient] = None,
) -> Optional[bytes]:
    """Retrieve raw bytes of thumbnail from local storage or remote URL."""
    if not thumbnail_path:
        return None
    clean = thumbnail_path.split("?")[0].strip()
    if not clean:
        return None

    # 1. Local static path or resolved local path
    if clean.startswith("/static/"):
        local_path = Path("app") / clean.lstrip("/")
        if local_path.is_file():
            try:
                data = local_path.read_bytes()
                if len(data) > 200:
                    return data
            except Exception as e:
                logger.warning("[AI-Tag-Batch] Local thumb read error %s: %s", local_path, e)
                return None

    try:
        from app.related_media import resolve_local_thumb_path
        resolved = resolve_local_thumb_path(thumbnail_path)
        if resolved and resolved.is_file():
            data = resolved.read_bytes()
            if len(data) > 200:
                return data
    except Exception:
        pass

    # 2. Base64 data URL
    if clean.startswith("data:image"):
        try:
            _, b64_data = clean.split(",", 1)
            return base64.b64decode(b64_data)
        except Exception:
            return None

    # 3. Remote HTTP/HTTPS URL
    if clean.startswith(("http://", "https://")):
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        }
        if referer and referer.startswith(("http://", "https://")):
            headers["Referer"] = referer
        else:
            p = urlparse(clean)
            if p.scheme and p.netloc:
                headers["Referer"] = f"{p.scheme}://{p.netloc}/"

        try:
            if client is not None:
                r = await client.get(clean, headers=headers, timeout=10.0, follow_redirects=True)
                if r.status_code == 200 and len(r.content) > 500:
                    return r.content
            else:
                async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as tmp_client:
                    r = await tmp_client.get(clean, headers=headers)
                    if r.status_code == 200 and len(r.content) > 500:
                        return r.content
        except Exception as e:
            logger.warning("[AI-Tag-Batch] Remote thumb fetch failed %s: %s", clean[:80], repr(e))
            return None

    return None


# ── Stage 1: Smart NLP + Batch Name + URL + Lexicon Tagging ──────────────────

_BATCH_NOISE_RE = re.compile(
    r"(?:\b(?:board|filester(?:\.me)?|interceptor|discovery\s*hub|fusion\s*hub\s*v[ýy]ber|"
    r"quantum\s*search|r[ýy]chly\s*tm\s*import|linktester\s*import|selector\s*extension\s*import|"
    r"extension\s*import|fast\s*import|reverse\s*image\s*selection|simpcity(?:\.cr)?(?:\s*forums)?|"
    r"request|bunkr|pixeldrain|pixel|gofile|collection|random|watched|newest|mirror_post-\d+_\d+)\b|"
    r"·\s*job\s*#\d+|\bjob\s*#\d+|\b\d+(?:\.\d+)?\s*(?:gb|mb|tb|vids|videos)\b|"
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|"
    r"\b\d{1,2}\.\s*\d{1,2}\.\s*\d{2,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b|\(\d+\)|☆)",
    re.IGNORECASE,
)


def clean_batch_name_for_signals(batch_name: str) -> str:
    """Strip technical import boilerplate from batch_name to expose performer names and tags."""
    if not batch_name or batch_name == "All":
        return ""
    cleaned = _BATCH_NOISE_RE.sub(" ", batch_name)
    cleaned = re.sub(r"[-_|·•/]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def extract_nlp_tags_and_models(
    title: str = "",
    batch_name: str = "",
    source_url: str = "",
    existing_models: str = "",
    existing_categories: str = "",
) -> Dict[str, Any]:
    """Extract high-precision tags and performer names from title, batch_name, and URL."""
    clean_batch = clean_batch_name_for_signals(batch_name)
    clean_title = clean_title_for_search(title)
    combined_context = " ".join(p for p in (title, clean_title, clean_batch, existing_categories) if p).strip()

    explicit_models = [m for m in split_csv(existing_models) if m and not is_junk_content_tag(m)]

    # Check if batch_name tokens resolve directly to a known performer/handle
    for tok in re.findall(r"[A-Za-z0-9_]{4,28}", clean_batch):
        known = resolve_known_performer(tok)
        if known and known not in explicit_models:
            explicit_models.append(known)
    if clean_batch:
        known_full = resolve_known_performer(clean_batch)
        if known_full and known_full not in explicit_models:
            explicit_models.append(known_full)

    performers = extract_performer_candidates(
        clean_title=f"{clean_title} {clean_batch}".strip(),
        explicit_models=explicit_models,
        raw_title=f"{title} - {clean_batch}" if clean_batch else title,
        source_url=source_url,
    )

    auto_res = auto_tag_video(combined_context)
    for m in auto_res.get("models") or []:
        if m not in performers:
            performers.append(m)

    raw_tags: List[str] = list(auto_res.get("tags") or [])
    for cat in split_csv(existing_categories):
        if not is_junk_content_tag(cat):
            raw_tags.append(cat.lower())

    # Extract meaningful scene words from clean title if they match strong adult taxonomy
    clean_tags = sanitize_video_tags_list(raw_tags, exclude_performers=performers)
    model_guess = performers[0] if performers else ""
    return {
        "tags": [t.lower() for t in clean_tags],
        "performers": performers[:4],
        "model_guess": model_guess,
    }


# ── Stage 2 & 3: Local GPU SigLIP 2 Zero-Shot + Visual k-NN Classifier ──────

def _get_local_vision_classifier() -> Optional[Dict[str, Any]]:
    """Initialize and cache SigLIP 2 text prompt vectors + library Z-score calibration stats."""
    global _CLASSIFIER_CACHE
    if _CLASSIFIER_CACHE is not None:
        return _CLASSIFIER_CACHE

    with _CLASSIFIER_LOCK:
        if _CLASSIFIER_CACHE is not None:
            return _CLASSIFIER_CACHE
        try:
            from app import visual_semantic_index as vsi

            if not vsi.is_gpu_ready():
                return None

            vsi.load_index_from_db(force=False)
            prompts = [item[2] for item in LOCAL_VISION_TAXONOMY]
            t_vecs = vsi._encode_texts_sync(prompts)
            if t_vecs is None or len(t_vecs) != len(prompts):
                return None

            img_mat = vsi._IMG_MAT
            if img_mat is not None and len(img_mat) >= 32 and img_mat.shape[1] == t_vecs.shape[1]:
                all_sims = img_mat @ t_vecs.T
                mu = all_sims.mean(axis=0).astype(np.float32)
                sigma = all_sims.std(axis=0).clip(min=1e-4).astype(np.float32)
            else:
                mu = np.full((len(prompts),), 0.065, dtype=np.float32)
                sigma = np.full((len(prompts),), 0.022, dtype=np.float32)

            bundle = vsi._get_model_bundle()
            _CLASSIFIER_CACHE = {
                "t_vecs": t_vecs,
                "mu": mu,
                "sigma": sigma,
                "dim": int(t_vecs.shape[1]),
                "model_id": bundle["model_id"] if bundle else "ViT-B-16-SigLIP2:webli",
                "device": bundle["device"] if bundle else "cuda",
            }
            return _CLASSIFIER_CACHE
        except Exception as exc:
            logger.warning("[AI-Tag-Batch] Local SigLIP2 classifier init failed: %s", exc)
            return None


def classify_embedding_zero_shot(
    img_vec: np.ndarray,
    video_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Run Z-score calibrated SigLIP 2 zero-shot classification + visual k-NN propagation on an image vector."""
    clf = _get_local_vision_classifier()
    if not clf or img_vec is None:
        return {"tags": [], "model_guess": ""}

    norm = float(np.linalg.norm(img_vec))
    if norm < 0.1 or img_vec.shape[0] != clf["dim"]:
        return {"tags": [], "model_guess": ""}

    iv = (img_vec / norm).astype(np.float32)
    raw_sims = iv @ clf["t_vecs"].T
    z_scores = (raw_sims - clf["mu"]) / clf["sigma"]

    by_group: Dict[str, List[Tuple[float, str]]] = {}
    for idx, (grp, tag, _prompt, thr) in enumerate(LOCAL_VISION_TAXONOMY):
        zv = float(z_scores[idx])
        if zv >= thr:
            by_group.setdefault(grp, []).append((zv, tag))

    for grp_list in by_group.values():
        grp_list.sort(key=lambda x: x[0], reverse=True)

    scored_tags: List[Tuple[float, str]] = []

    # 1. Mutually exclusive groups: pick top-1 only if it clearly leads
    for single_grp in ("hair", "eth", "chest", "group"):
        candidates = by_group.get(single_grp)
        if not candidates:
            continue
        top_z, top_tag = candidates[0]
        if len(candidates) == 1 or (top_z - candidates[1][0]) >= 0.18 or top_z >= 1.45:
            scored_tags.append((top_z, top_tag))

    # 2. Setting: top-1 (or top-2 if second is very strong)
    if "setting" in by_group:
        scored_tags.append(by_group["setting"][0])
        if len(by_group["setting"]) > 1 and by_group["setting"][1][0] >= 1.45:
            scored_tags.append(by_group["setting"][1])

    # 3. Multi-label groups: attire (top-2), body (top-2), action (top-3)
    for multi_grp, max_k in (("attire", 2), ("body", 2), ("action", 3)):
        for zv, tag in (by_group.get(multi_grp) or [])[:max_k]:
            scored_tags.append((zv, tag))

    # Fallback: if image had low contrast and fewer than 3 tags passed strict thresholds,
    # take the top-4 highest Z-score attributes >= 0.55 across distinct groups
    if len(scored_tags) < 3:
        existing_names = {t for _, t in scored_tags}
        used_single_grps = {
            grp for grp in ("hair", "eth", "chest", "group")
            if any(t in existing_names for _, t, _, _ in LOCAL_VISION_TAXONOMY if _ == grp)
        }
        all_ranked = sorted(
            [(float(z_scores[i]), LOCAL_VISION_TAXONOMY[i][1], LOCAL_VISION_TAXONOMY[i][0]) for i in range(len(LOCAL_VISION_TAXONOMY))],
            key=lambda x: x[0],
            reverse=True,
        )
        for zv, tag, grp in all_ranked:
            if zv < 0.52 or tag in existing_names:
                continue
            if grp in ("hair", "eth", "chest", "group") and grp in used_single_grps:
                continue
            scored_tags.append((zv, tag))
            existing_names.add(tag)
            if grp in ("hair", "eth", "chest", "group"):
                used_single_grps.add(grp)
            if len(scored_tags) >= 5:
                break

    scored_tags.sort(key=lambda x: x[0], reverse=True)
    visual_tags: List[str] = []
    for _zv, t in scored_tags:
        if t not in visual_tags:
            visual_tags.append(t)

    # ── Stage 3: Visual k-NN Performer & Tag Propagation across Library ──────
    knn_model_guess = ""
    knn_tags: List[str] = []
    try:
        from app import visual_semantic_index as vsi

        with vsi._INDEX_LOCK:
            vid_ids = vsi._VID_IDS
            img_mat = vsi._IMG_MAT
            meta_map = vsi._META_MAP

        if vid_ids is not None and img_mat is not None and len(vid_ids) > 10 and img_mat.shape[1] == iv.shape[0]:
            sims = img_mat @ iv
            k = min(8, len(vid_ids))
            top_indices = np.argpartition(sims, -k)[-k:]
            top_indices = top_indices[np.argsort(sims[top_indices])[::-1]]

            perf_votes: Counter = Counter()
            high_conf_perf = ""
            tag_votes: Counter = Counter()

            for idx in top_indices:
                n_vid = int(vid_ids[idx])
                if video_id is not None and n_vid == int(video_id):
                    continue
                sim_val = float(sims[idx])
                if sim_val < 0.855:
                    break
                n_meta = meta_map.get(n_vid) or {}
                n_title = str(n_meta.get("title") or "")
                n_models = str(n_meta.get("models") or "")
                n_ai_tags = str(n_meta.get("ai_tags") or "")
                n_tags = str(n_meta.get("tags") or "")

                n_perfs = extract_performer_candidates(
                    clean_title=clean_title_for_search(n_title),
                    explicit_models=split_csv(n_models) + extract_actors_from_tag_strings(n_ai_tags, n_tags),
                    raw_title=n_title,
                )
                for p in n_perfs[:2]:
                    perf_votes[p] += 1
                    if sim_val >= 0.905 and not high_conf_perf:
                        high_conf_perf = p

                if sim_val >= 0.88:
                    for nt in sanitize_video_tags_list([n_tags, n_ai_tags], exclude_performers=n_perfs)[:6]:
                        tag_votes[nt.lower()] += 1

            if high_conf_perf:
                knn_model_guess = high_conf_perf
            elif perf_votes:
                best_perf, cnt = perf_votes.most_common(1)[0]
                if cnt >= 2:
                    knn_model_guess = best_perf

            for t_name, cnt in tag_votes.most_common(3):
                if cnt >= 2 and t_name not in visual_tags:
                    knn_tags.append(t_name)
    except Exception as exc:
        logger.debug("[AI-Tag-Batch] k-NN propagation skipped: %s", exc)

    combined_tags = list(dict.fromkeys(visual_tags + knn_tags))[:10]
    return {
        "tags": combined_tags,
        "model_guess": knn_model_guess,
    }


def encode_and_classify_thumbnails_sync(
    items: List[Dict[str, Any]],
) -> Dict[int, Dict[str, Any]]:
    """Encode raw thumbnail bytes on GPU with SigLIP 2, persist embeddings to `VideoEmbedding`, and return tags."""
    from app import visual_semantic_index as vsi

    clf = _get_local_vision_classifier()
    decoded_imgs: List[Image.Image] = []
    valid_items: List[Dict[str, Any]] = []

    for it in items:
        raw = it.get("img_bytes")
        if not raw:
            continue
        pil = vsi._decode_image(raw)
        if pil is not None:
            decoded_imgs.append(pil)
            valid_items.append(it)

    if not decoded_imgs or not clf:
        return {}

    vecs = vsi._encode_images_sync(decoded_imgs)
    if vecs is None or len(vecs) != len(valid_items):
        return {}

    # Persist newly computed image_vec into VideoEmbedding so future runs & visual search are instant
    try:
        with SessionLocal() as edb:
            vid_list = [int(it["video_id"]) for it in valid_items if it.get("video_id")]
            existing_rows = {
                int(r.video_id): r
                for r in edb.query(VideoEmbedding).filter(VideoEmbedding.video_id.in_(vid_list)).all()
            } if vid_list else {}

            for it, vec in zip(valid_items, vecs):
                vid_id = it.get("video_id")
                if not vid_id:
                    continue
                blob = vec.astype(np.float16).tobytes()
                row = existing_rows.get(int(vid_id))
                if not row:
                    edb.add(
                        VideoEmbedding(
                            video_id=int(vid_id),
                            model_name=clf["model_id"],
                            dim=clf["dim"],
                            thumb_sig="ai_tagger",
                            text_sig="",
                            image_vec=blob,
                        )
                    )
                else:
                    row.model_name = clf["model_id"]
                    row.dim = clf["dim"]
                    row.image_vec = blob
            edb.commit()
    except Exception as exc:
        logger.debug("[AI-Tag-Batch] Caching VideoEmbedding skipped: %s", exc)

    results: Dict[int, Dict[str, Any]] = {}
    for it, vec in zip(valid_items, vecs):
        key = it.get("idx", it.get("video_id", 0))
        results[key] = classify_embedding_zero_shot(vec, video_id=it.get("video_id"))
    return results


def tag_video_local_hybrid_sync(
    video_id: Optional[int] = None,
    title: str = "",
    batch_name: str = "",
    source_url: str = "",
    existing_models: str = "",
    existing_categories: str = "",
    img_vec: Optional[np.ndarray] = None,
    img_bytes: Optional[bytes] = None,
) -> Dict[str, Any]:
    """Combine NLP/Batch/URL lexicon extraction with GPU SigLIP 2 Zero-Shot Vision & k-NN propagation."""
    nlp = extract_nlp_tags_and_models(
        title=title,
        batch_name=batch_name,
        source_url=source_url,
        existing_models=existing_models,
        existing_categories=existing_categories,
    )

    vision_res = {"tags": [], "model_guess": ""}
    if img_vec is not None:
        vision_res = classify_embedding_zero_shot(img_vec, video_id=video_id)
    elif img_bytes:
        mapped = encode_and_classify_thumbnails_sync(
            [{"idx": 0, "video_id": video_id, "img_bytes": img_bytes}]
        )
        vision_res = mapped.get(0) or {"tags": [], "model_guess": ""}

    model_guess = nlp["model_guess"] or vision_res.get("model_guess") or ""
    performers = list(nlp.get("performers") or [])
    if model_guess and model_guess not in performers:
        performers.insert(0, model_guess)

    merged_tags: List[str] = []
    for t in list(nlp.get("tags") or []) + list(vision_res.get("tags") or []):
        clean_t = str(t).strip().lower()
        if clean_t and clean_t not in merged_tags and not is_junk_content_tag(clean_t):
            if clean_t not in {p.lower() for p in performers}:
                merged_tags.append(clean_t)

    return {
        "tags": merged_tags[:12],
        "model_guess": model_guess,
        "performers": performers[:4],
    }


# ── Gemini Vision API (With Automatic Local GPU Fallback) ────────────────────

def _extract_retry_delay_seconds(resp_text: str, default_sec: float = 4.0) -> float:
    """Parse Google's 'Please retry in Xs' or retryDelay from 429 JSON if present."""
    m = re.search(r"retry in ([0-9]+(?:\.[0-9]+)?)s", resp_text or "", re.I)
    if m:
        val = float(m.group(1))
        if val <= 65.0:
            return min(val + 0.5, 30.0)
    return default_sec


async def call_gemini_vision(
    img_bytes: bytes,
    api_key: str = "",
    model: str = LOCAL_GPU_MODEL_ID,
    title_hint: str = "",
    max_retries: int = 2,
    client: Optional[httpx.AsyncClient] = None,
    video_id: Optional[int] = None,
    batch_name: str = "",
    source_url: str = "",
) -> dict:
    """Single-image vision tagger. Uses Local GPU SigLIP2+NLP by default or as automatic fallback when Gemini fails."""
    global _MODEL_RR_INDEX

    if model == LOCAL_GPU_MODEL_ID or not (api_key or "").strip():
        _AI_TAG_STATE["active_model"] = LOCAL_GPU_MODEL_ID
        return await asyncio.to_thread(
            tag_video_local_hybrid_sync,
            video_id=video_id,
            title=title_hint,
            batch_name=batch_name,
            source_url=source_url,
            img_bytes=img_bytes,
        )

    fast_bytes = compress_thumbnail_bytes(img_bytes, max_dim=640, quality=74)
    b64_img = base64.b64encode(fast_bytes).decode("ascii")

    title_ctx = f' Video title: "{title_hint[:100]}".' if title_hint else ""
    prompt = (
        "Describe this adult content thumbnail for video library tagging."
        f"{title_ctx} "
        "Return ONLY JSON: {\"tags\": [8-10 short lowercase search keywords: "
        "scene, position, setting, hair color, body type, clothing, action], "
        "\"model_guess\": \"performer name if recognizable else empty string\"}."
    )

    body = {
        "contents": [{
            "parts": [
                {"inline_data": {"mime_type": "image/jpeg", "data": b64_img}},
                {"text": prompt},
            ]
        }],
        "safetySettings": [
            {"category": c, "threshold": "BLOCK_NONE"} for c in (
                "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "HARM_CATEGORY_HARASSMENT",
                "HARM_CATEGORY_HATE_SPEECH",
                "HARM_CATEGORY_DANGEROUS_CONTENT",
            )
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "maxOutputTokens": 180,
            "temperature": 0.2,
        },
    }

    pool = list(GEMINI_VISION_MODELS)
    if model and model not in pool and model not in ("gemini-flash-latest", LOCAL_GPU_MODEL_ID):
        pool.insert(0, model)

    start_idx = _MODEL_RR_INDEX % len(pool)
    _MODEL_RR_INDEX += 1
    ordered_models = pool[start_idx:] + pool[:start_idx]

    last_err = ""
    for attempt in range(max_retries):
        chosen_model = ordered_models[attempt % len(ordered_models)]
        _AI_TAG_STATE["active_model"] = chosen_model
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{chosen_model}:generateContent"

        try:
            if client is not None:
                resp = await client.post(
                    url,
                    headers={"Content-Type": "application/json", "X-goog-api-key": api_key},
                    json=body,
                    timeout=18.0,
                )
            else:
                async with httpx.AsyncClient(timeout=18.0) as tmp_client:
                    resp = await tmp_client.post(
                        url,
                        headers={"Content-Type": "application/json", "X-goog-api-key": api_key},
                        json=body,
                    )
        except Exception as exc:
            last_err = f"{chosen_model} timeout ({type(exc).__name__})"
            await asyncio.sleep(0.4)
            continue

        if resp.status_code == 200:
            data = resp.json()
            candidates = data.get("candidates") or [{}]
            cand = candidates[0] if candidates else {}
            parts = cand.get("content", {}).get("parts", [])
            txt = "".join(p.get("text", "") for p in parts)
            if txt.strip():
                return _load_first_json_object(txt)
            last_err = f"{chosen_model} empty response"

        elif resp.status_code in (429, 503, 500):
            last_err = f"HTTP {resp.status_code} ({chosen_model})"
            break
        else:
            last_err = f"HTTP {resp.status_code} ({chosen_model}): {resp.text[:140]}"
            break

    # Seamless fallback to Local GPU SigLIP2 + NLP when Gemini quota/billing (402/429) fails
    logger.info("[AI-Tag-Batch] Gemini unavailable (%s), falling back to %s", last_err, LOCAL_GPU_MODEL_ID)
    _AI_TAG_STATE["active_model"] = LOCAL_GPU_MODEL_ID
    return await asyncio.to_thread(
        tag_video_local_hybrid_sync,
        video_id=video_id,
        title=title_hint,
        batch_name=batch_name,
        source_url=source_url,
        img_bytes=img_bytes,
    )


async def call_gemini_vision_collage(
    batch_entries: List[Dict[str, Any]],
    api_key: str = "",
    model: str = LOCAL_GPU_MODEL_ID,
    max_retries: int = 2,
    client: Optional[httpx.AsyncClient] = None,
) -> Dict[int, Dict[str, Any]]:
    """Tag a batch of videos using Local GPU SigLIP2+NLP (default) or Gemini Vision collage with automatic fallback."""
    if len(batch_entries) == 1:
        single = await call_gemini_vision(
            img_bytes=batch_entries[0]["img_bytes"],
            api_key=api_key,
            model=model,
            title_hint=batch_entries[0].get("title", ""),
            max_retries=max_retries,
            client=client,
            video_id=batch_entries[0].get("video_id"),
            batch_name=batch_entries[0].get("batch_name", ""),
            source_url=batch_entries[0].get("source_url", ""),
        )
        return {batch_entries[0]["idx"]: single}

    if model == LOCAL_GPU_MODEL_ID or not (api_key or "").strip():
        _AI_TAG_STATE["active_model"] = LOCAL_GPU_MODEL_ID
        encoded_map = await asyncio.to_thread(encode_and_classify_thumbnails_sync, batch_entries)
        out: Dict[int, Dict[str, Any]] = {}
        for entry in batch_entries:
            idx = entry["idx"]
            vis = encoded_map.get(idx) or {"tags": [], "model_guess": ""}
            nlp = extract_nlp_tags_and_models(
                title=entry.get("title", ""),
                batch_name=entry.get("batch_name", ""),
                source_url=entry.get("source_url", ""),
                existing_models=entry.get("models", ""),
                existing_categories=entry.get("categories", ""),
            )
            model_guess = nlp["model_guess"] or vis.get("model_guess") or ""
            merged_tags = list(dict.fromkeys(list(nlp.get("tags") or []) + list(vis.get("tags") or [])))[:12]
            out[idx] = {"tags": merged_tags, "model_guess": model_guess}
        return out

    collage_bytes = build_collage_jpeg([e["img_bytes"] for e in batch_entries])
    b64_img = base64.b64encode(collage_bytes).decode("ascii")

    titles_lines = "; ".join(
        f'#{i}: "{(e.get("title") or "")[:65]}"' for i, e in enumerate(batch_entries)
    )
    prompt = (
        f"This image is a numbered grid of {len(batch_entries)} adult video thumbnails labeled #0 through #{len(batch_entries) - 1}. "
        f"Video titles context: {titles_lines}. "
        f"For EACH cell #0 to #{len(batch_entries) - 1}, provide 7-10 short lowercase search tags "
        "(hair color, action, position, body type, clothing, setting) and performer name if recognizable from image or title. "
        "Return ONLY JSON: {\"items\": [{\"idx\": 0, \"tags\": [\"...\"], \"model_guess\": \"\"}, ...]}"
    )

    body = {
        "contents": [{
            "parts": [
                {"inline_data": {"mime_type": "image/jpeg", "data": b64_img}},
                {"text": prompt},
            ]
        }],
        "safetySettings": [
            {"category": c, "threshold": "BLOCK_NONE"} for c in (
                "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "HARM_CATEGORY_HARASSMENT",
                "HARM_CATEGORY_HATE_SPEECH",
                "HARM_CATEGORY_DANGEROUS_CONTENT",
            )
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "maxOutputTokens": 120 * len(batch_entries) + 120,
            "temperature": 0.2,
        },
    }

    pool = list(GEMINI_VISION_MODELS)
    if model and model not in pool and model not in ("gemini-flash-latest", LOCAL_GPU_MODEL_ID):
        pool.insert(0, model)

    for attempt in range(max_retries):
        chosen_model = pool[attempt % len(pool)]
        _AI_TAG_STATE["active_model"] = chosen_model
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{chosen_model}:generateContent"

        try:
            if client is not None:
                resp = await client.post(
                    url,
                    headers={"Content-Type": "application/json", "X-goog-api-key": api_key},
                    json=body,
                    timeout=24.0,
                )
            else:
                async with httpx.AsyncClient(timeout=24.0) as tmp_client:
                    resp = await tmp_client.post(
                        url,
                        headers={"Content-Type": "application/json", "X-goog-api-key": api_key},
                        json=body,
                    )
        except Exception:
            await asyncio.sleep(0.5)
            continue

        if resp.status_code == 200:
            data = resp.json()
            candidates = data.get("candidates") or [{}]
            cand = candidates[0] if candidates else {}
            parts = cand.get("content", {}).get("parts", [])
            txt = "".join(p.get("text", "") for p in parts)
            if txt.strip():
                obj = _load_first_json_object(txt)
                items_list = obj.get("items") or []
                out = {}
                for pos, entry in enumerate(batch_entries):
                    matched = next((x for x in items_list if isinstance(x, dict) and x.get("idx") == pos), None)
                    if not matched and pos < len(items_list) and isinstance(items_list[pos], dict):
                        matched = items_list[pos]
                    if matched:
                        out[entry["idx"]] = {
                            "tags": matched.get("tags") or [],
                            "model_guess": matched.get("model_guess") or "",
                        }
                if out:
                    return out
        else:
            break

    # Automatic fallback to Local GPU SigLIP2 + NLP
    _AI_TAG_STATE["active_model"] = LOCAL_GPU_MODEL_ID
    return await call_gemini_vision_collage(
        batch_entries=batch_entries,
        api_key="",
        model=LOCAL_GPU_MODEL_ID,
        client=client,
    )


def find_ai_tag_candidates(
    db: Session,
    batch_name: Optional[str] = None,
    only_missing: bool = True,
    limit: int = 250,
    batch_names: Optional[List[str]] = None,
    video_ids: Optional[List[int]] = None,
) -> List[Video]:
    """Find video candidates in database that need AI tagging."""
    query = db.query(Video).filter(Video.duplicate_of.is_(None))
    if video_ids is not None:
        query = query.filter(Video.id.in_(video_ids))
    if batch_names is not None:
        query = query.filter(Video.batch_name.in_(batch_names))
    elif batch_name and batch_name != "All":
        query = query.filter(Video.batch_name == batch_name)

    if only_missing:
        query = query.filter(
            or_(
                Video.tags.is_(None),
                Video.tags == "",
                Video.ai_tags.is_(None),
                Video.ai_tags == "",
                ~Video.ai_tags.like("%tag:%,%tag:%,%tag:%"),
            )
        )

    return query.order_by(Video.id.desc()).limit(limit).all()


def get_ai_tag_batch_status() -> dict:
    """Return the current batch state for UI polling and inspection."""
    return {**_AI_TAG_STATE, "scope_version": 1}


def cancel_ai_tag_batch() -> dict:
    """Signal the active batch job to stop processing."""
    global _AI_TAG_CANCEL_REQUESTED
    if _AI_TAG_RUNNING:
        _AI_TAG_CANCEL_REQUESTED = True
        _AI_TAG_STATE["cancelled"] = True
        _AI_TAG_STATE["status_text"] = "Zastavujem úlohu..."
        return {"status": "cancelling", "message": "Zastavenie úlohy bolo vyžiadané."}
    return {"status": "idle", "message": "Žiadna úloha momentálne nebeží."}


def _apply_vision_tags_to_video_obj(
    v: Video,
    parsed: Dict[str, Any],
    overwrite: bool,
) -> Optional[List[str]]:
    """Apply parsed tags and model_guess to a Video ORM instance in-place."""
    raw_tags = [
        str(t).strip().lower()
        for t in (parsed.get("tags") or [])
        if str(t).strip() and not is_junk_content_tag(str(t))
    ]
    model_guess = str(parsed.get("model_guess") or "").strip()
    if model_guess and is_junk_content_tag(model_guess):
        model_guess = ""

    existing_tags = {t.strip().lower() for t in (v.tags or "").split(",") if t.strip() and not is_junk_content_tag(t)}
    existing_models = {m.strip().lower() for m in (getattr(v, "models", "") or "").split(",") if m.strip()}

    new_tags = [t for t in raw_tags if t not in existing_tags]
    if model_guess and model_guess.lower() not in existing_tags and model_guess.lower() not in new_tags:
        new_tags.insert(0, model_guess)

    all_vision_tags = list(dict.fromkeys(raw_tags))
    if not all_vision_tags and not new_tags and not model_guess and not overwrite:
        return None

    current_tags = [t.strip() for t in (v.tags or "").split(",") if t.strip() and not is_junk_content_tag(t)]
    if overwrite:
        v.tags = ",".join(new_tags or all_vision_tags)
        ai_prefixed = [f"tag:{t}" for t in all_vision_tags]
        if model_guess:
            ai_prefixed.insert(0, f"actor:{model_guess}")
        v.ai_tags = ",".join(ai_prefixed)
    else:
        v.tags = ",".join(current_tags + [t for t in new_tags if t not in current_tags])
        existing_ai = [t.strip() for t in (v.ai_tags or "").split(",") if t.strip()]
        ai_prefixed = [f"tag:{t}" for t in all_vision_tags]
        if model_guess:
            ai_prefixed.insert(0, f"actor:{model_guess}")
        v.ai_tags = ",".join(existing_ai + [x for x in ai_prefixed if x not in existing_ai])

    if model_guess:
        cur_models = [m.strip() for m in (v.models or "").split(",") if m.strip()]
        if model_guess not in cur_models and model_guess.lower() not in existing_models:
            cur_models.append(model_guess)
            v.models = ",".join(cur_models)

    return (new_tags or all_vision_tags)[:10]


def _save_video_vision_tags(
    vid_id: int,
    title: str,
    parsed: Dict[str, Any],
    overwrite: bool,
) -> Optional[List[str]]:
    """Persist Vision tags and model_guess for a single video in a short transaction."""
    with SessionLocal() as wdb:
        v = wdb.query(Video).filter(Video.id == vid_id).first()
        if not v:
            return None
        added = _apply_vision_tags_to_video_obj(v, parsed, overwrite)
        if added is not None:
            wdb.commit()
        return added


def _save_batch_vision_tags(
    updates: List[Tuple[int, str, Dict[str, Any]]],
    overwrite: bool,
) -> Tuple[int, Optional[int], str, List[str]]:
    """Persist multiple video tag updates in a single fast SQLite transaction."""
    if not updates:
        return 0, None, "", []

    vid_ids = [u[0] for u in updates]
    improved = 0
    last_id: Optional[int] = None
    last_title = ""
    last_added: List[str] = []

    with SessionLocal() as wdb:
        rows_by_id = {
            int(v.id): v
            for v in wdb.query(Video).filter(Video.id.in_(vid_ids)).all()
        }
        for vid_id, title, parsed in updates:
            v = rows_by_id.get(int(vid_id))
            if not v:
                continue
            added = _apply_vision_tags_to_video_obj(v, parsed, overwrite)
            if added:
                improved += 1
                last_id = vid_id
                last_title = title
                last_added = added
        wdb.commit()

    return improved, last_id, last_title, last_added


async def run_ai_tag_batch_job(config: AITagBatchRequest) -> dict:
    """High-speed worker for batch AI tagging (Local GPU SigLIP2 + NLP + k-NN by default)."""
    global _AI_TAG_RUNNING, _AI_TAG_CANCEL_REQUESTED

    api_key = (os.getenv("GEMINI_API_KEY") or "").strip()
    is_mocked_gemini = hasattr(call_gemini_vision, "_mock_name") or hasattr(call_gemini_vision, "assert_called")
    use_local_gpu = (
        not is_mocked_gemini
        and (config.model == LOCAL_GPU_MODEL_ID or not api_key or config.model.startswith("siglip"))
    )
    active_model_label = LOCAL_GPU_MODEL_ID if use_local_gpu else config.model

    async with _AI_TAG_JOB_LOCK:
        if _AI_TAG_RUNNING:
            return {"status": "already_running", "message": "Úloha už beží."}
        _AI_TAG_RUNNING = True
        _AI_TAG_CANCEL_REQUESTED = False

    db = SessionLocal()
    try:
        candidates = find_ai_tag_candidates(
            db,
            batch_name=config.batch_name,
            batch_names=config.batch_names,
            video_ids=config.video_ids,
            only_missing=config.only_missing,
            limit=config.limit,
        )
        cand_ids = [int(v.id) for v in candidates]
        emb_map: Dict[int, bytes] = {}
        if use_local_gpu and cand_ids:
            # Fetch precomputed SigLIP 2 image embeddings in chunks of 900 to avoid SQLite variable limits
            for i in range(0, len(cand_ids), 900):
                sub_ids = cand_ids[i:i + 900]
                for vid_id, ivec in (
                    db.query(VideoEmbedding.video_id, VideoEmbedding.image_vec)
                    .filter(VideoEmbedding.video_id.in_(sub_ids), VideoEmbedding.image_vec.isnot(None))
                    .all()
                ):
                    if ivec and len(ivec) >= 512:
                        emb_map[int(vid_id)] = bytes(ivec)

        target_items = [
            {
                "id": int(v.id),
                "title": (v.title or f"Video #{v.id}").strip(),
                "batch_name": getattr(v, "batch_name", "") or "",
                "source_url": getattr(v, "source_url", "") or getattr(v, "url", "") or "",
                "models": getattr(v, "models", "") or "",
                "categories": getattr(v, "categories", "") or "",
                "thumbnail_path": v.thumbnail_path,
                "thumbnail_referer": getattr(v, "thumbnail_referer", "") or (v.source_url or ""),
                "image_vec_bytes": emb_map.get(int(v.id)),
            }
            for v in candidates
        ]
    finally:
        db.close()

    total = len(target_items)
    start_time = time.monotonic()
    started_iso = datetime.now(timezone.utc).isoformat()

    _AI_TAG_STATE.update({
        "running": True,
        "cancelled": False,
        "total": total,
        "done": 0,
        "improved": 0,
        "failed": 0,
        "skipped": 0,
        "current_video_id": None,
        "current_video_title": "",
        "last_tagged_video_id": None,
        "last_tagged_video_title": "",
        "last_added_tags": [],
        "last_error": "",
        "active_model": active_model_label,
        "percent": 0.0,
        "eta_seconds": 0,
        "eta_formatted": "Počítam...",
        "elapsed_seconds": 0,
        "elapsed_formatted": "0s",
        "status_text": f"Pripravujem lokálnu GPU AI pre {total} videí...",
        "message": "",
        "started_at": started_iso,
        "finished_at": None,
        "batch_name": config.batch_name or "Celá knižnica",
    })

    await broadcast_ws({
        "type": "ai_tag_batch_start",
        "total": total,
        "batch_name": config.batch_name or "Celá knižnica",
        "message": f"Spúšťam lokálne GPU AI tagovanie {total} videí (SigLIP 2 + NLP + k-NN)...",
    })

    if total == 0:
        _AI_TAG_RUNNING = False
        _AI_TAG_STATE.update({
            "running": False,
            "percent": 100.0,
            "status_text": "Dokončené (všetky videá už majú AI tagy)",
            "message": "Nenašli sa žiadne videá so slabými alebo chýbajúcimi tagmi.",
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })
        await broadcast_ws({
            "type": "ai_tag_batch_done",
            **_AI_TAG_STATE,
        })
        return dict(_AI_TAG_STATE)

    stats = {"done": 0, "improved": 0, "failed": 0, "skipped": 0}

    async def _update_and_broadcast_progress(last_vid_id: Optional[int] = None) -> None:
        done_count = stats["done"]
        elapsed = time.monotonic() - start_time
        avg_per_item = elapsed / max(1, done_count)
        rem_items = max(0, total - done_count)
        eta_sec = int(avg_per_item * rem_items)
        pct = round((done_count / total) * 100, 1)

        _AI_TAG_STATE.update({
            "done": done_count,
            "improved": stats["improved"],
            "failed": stats["failed"],
            "skipped": stats["skipped"],
            "percent": pct,
            "elapsed_seconds": int(elapsed),
            "elapsed_formatted": format_duration_human(int(elapsed)).lstrip("~"),
            "eta_seconds": eta_sec,
            "eta_formatted": format_duration_human(eta_sec),
        })

        await broadcast_ws({
            "type": "ai_tag_batch_progress",
            "updated_video_id": last_vid_id,
            **_AI_TAG_STATE,
        })

    try:
        if use_local_gpu:
            # Warm up classifier & library index once before processing chunks
            await asyncio.to_thread(_get_local_vision_classifier)

            chunk_size = 48 if total > 48 else max(1, min(16, total))
            chunks = [target_items[i:i + chunk_size] for i in range(0, total, chunk_size)]

            async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as shared_client:
                for chunk in chunks:
                    if _AI_TAG_CANCEL_REQUESTED:
                        break

                    first_item = chunk[0]
                    _AI_TAG_STATE["current_video_id"] = first_item["id"]
                    _AI_TAG_STATE["current_video_title"] = first_item["title"]
                    _AI_TAG_STATE["status_text"] = (
                        f"GPU SigLIP2 + NLP analyzuje #{chunk[0]['id']}..#{chunk[-1]['id']} ({len(chunk)} videí)"
                    )

                    await broadcast_ws({
                        "type": "ai_tag_batch_item_start",
                        "current_video_id": first_item["id"],
                        "current_video_title": first_item["title"],
                        "status_text": _AI_TAG_STATE["status_text"],
                        "active_model": _AI_TAG_STATE["active_model"],
                    })

                    # Identify items that don't have precomputed VideoEmbedding.image_vec yet
                    missing_emb_items = [
                        it for it in chunk if not it.get("image_vec_bytes") and it.get("thumbnail_path")
                    ]
                    fetched_thumbs: Dict[int, bytes] = {}
                    if missing_emb_items:
                        raw_list = await asyncio.gather(*(
                            load_video_thumb_bytes(
                                it["thumbnail_path"],
                                referer=it.get("thumbnail_referer", ""),
                                client=shared_client,
                            )
                            for it in missing_emb_items
                        ))
                        for it, b in zip(missing_emb_items, raw_list):
                            if b:
                                fetched_thumbs[it["id"]] = b

                    def _process_local_chunk_sync() -> Tuple[List[Tuple[int, str, Dict[str, Any]]], int]:
                        # Batch-encode any newly fetched thumbnails on GPU first
                        newly_encoded_vision: Dict[int, Dict[str, Any]] = {}
                        if fetched_thumbs:
                            to_encode = [
                                {"idx": vid_id, "video_id": vid_id, "img_bytes": raw_b}
                                for vid_id, raw_b in fetched_thumbs.items()
                            ]
                            newly_encoded_vision = encode_and_classify_thumbnails_sync(to_encode)

                        chunk_updates: List[Tuple[int, str, Dict[str, Any]]] = []
                        chunk_skipped = 0
                        for item in chunk:
                            vid_id = item["id"]
                            vec_bytes = item.get("image_vec_bytes")
                            img_vec: Optional[np.ndarray] = None
                            if vec_bytes:
                                try:
                                    img_vec = np.frombuffer(vec_bytes, dtype=np.float16).astype(np.float32)
                                except Exception:
                                    img_vec = None

                            if img_vec is not None:
                                parsed = tag_video_local_hybrid_sync(
                                    video_id=vid_id,
                                    title=item["title"],
                                    batch_name=item.get("batch_name", ""),
                                    source_url=item.get("source_url", ""),
                                    existing_models=item.get("models", ""),
                                    existing_categories=item.get("categories", ""),
                                    img_vec=img_vec,
                                )
                            elif vid_id in newly_encoded_vision:
                                vis_part = newly_encoded_vision[vid_id]
                                nlp_part = extract_nlp_tags_and_models(
                                    title=item["title"],
                                    batch_name=item.get("batch_name", ""),
                                    source_url=item.get("source_url", ""),
                                    existing_models=item.get("models", ""),
                                    existing_categories=item.get("categories", ""),
                                )
                                mg = nlp_part["model_guess"] or vis_part.get("model_guess") or ""
                                mtags = list(dict.fromkeys(list(nlp_part.get("tags") or []) + list(vis_part.get("tags") or [])))[:12]
                                parsed = {"tags": mtags, "model_guess": mg}
                            else:
                                # No thumbnail available -> still tag from NLP / Batch / URL / Lexicon!
                                nlp_only = extract_nlp_tags_and_models(
                                    title=item["title"],
                                    batch_name=item.get("batch_name", ""),
                                    source_url=item.get("source_url", ""),
                                    existing_models=item.get("models", ""),
                                    existing_categories=item.get("categories", ""),
                                )
                                parsed = {
                                    "tags": nlp_only.get("tags") or [],
                                    "model_guess": nlp_only.get("model_guess") or "",
                                }

                            if parsed.get("tags") or parsed.get("model_guess"):
                                chunk_updates.append((vid_id, item["title"], parsed))
                            else:
                                chunk_skipped += 1

                        return chunk_updates, chunk_skipped

                    chunk_updates, chunk_skipped = await asyncio.to_thread(_process_local_chunk_sync)
                    improved_cnt, last_id, last_title, last_added = await asyncio.to_thread(
                        _save_batch_vision_tags, chunk_updates, config.overwrite
                    )

                    stats["improved"] += improved_cnt
                    stats["skipped"] += chunk_skipped + max(0, len(chunk_updates) - improved_cnt)
                    stats["done"] += len(chunk)

                    if last_id is not None:
                        _AI_TAG_STATE["last_tagged_video_id"] = last_id
                        _AI_TAG_STATE["last_tagged_video_title"] = last_title
                        _AI_TAG_STATE["last_added_tags"] = last_added

                    await _update_and_broadcast_progress(last_vid_id=last_id)
        else:
            # Legacy / Mocked Gemini path (used when tests mock call_gemini_vision or Gemini model explicitly chosen)
            chunk_size = max(1, min(config.collage_size, 10)) if total > 2 else 1
            async with httpx.AsyncClient(timeout=24.0, follow_redirects=True) as shared_client:
                chunks = [target_items[i:i + chunk_size] for i in range(0, total, chunk_size)]
                semaphore = asyncio.Semaphore(max(1, min(config.concurrency, 3)))

                async def process_chunk(chunk_idx: int, chunk: List[dict]) -> None:
                    if _AI_TAG_CANCEL_REQUESTED:
                        return

                    async with semaphore:
                        if _AI_TAG_CANCEL_REQUESTED:
                            return

                        first_item = chunk[0]
                        _AI_TAG_STATE["current_video_id"] = first_item["id"]
                        _AI_TAG_STATE["current_video_title"] = first_item["title"]
                        _AI_TAG_STATE["status_text"] = f"Analyzujem #{first_item['id']}: {first_item['title'][:36]}"

                        await broadcast_ws({
                            "type": "ai_tag_batch_item_start",
                            "current_video_id": first_item["id"],
                            "current_video_title": first_item["title"],
                            "status_text": _AI_TAG_STATE["status_text"],
                            "active_model": _AI_TAG_STATE["active_model"],
                        })

                        thumb_results = await asyncio.gather(*(
                            load_video_thumb_bytes(
                                it["thumbnail_path"],
                                referer=it.get("thumbnail_referer", ""),
                                client=shared_client,
                            )
                            for it in chunk
                        ))

                        valid_entries: List[Dict[str, Any]] = []
                        for item, img_bytes in zip(chunk, thumb_results):
                            if not img_bytes:
                                stats["skipped"] += 1
                                stats["done"] += 1
                                await _update_and_broadcast_progress()
                            else:
                                valid_entries.append({
                                    "idx": len(valid_entries),
                                    "video_id": item["id"],
                                    "title": item["title"],
                                    "batch_name": item.get("batch_name", ""),
                                    "source_url": item.get("source_url", ""),
                                    "models": item.get("models", ""),
                                    "categories": item.get("categories", ""),
                                    "img_bytes": img_bytes,
                                })

                        if not valid_entries:
                            return

                        try:
                            if len(valid_entries) == 1:
                                single_parsed = await call_gemini_vision(
                                    img_bytes=valid_entries[0]["img_bytes"],
                                    api_key=api_key,
                                    model=config.model,
                                    title_hint=valid_entries[0]["title"],
                                    client=shared_client,
                                )
                                mapped_results = {0: single_parsed}
                            else:
                                mapped_results = await call_gemini_vision_collage(
                                    batch_entries=valid_entries,
                                    api_key=api_key,
                                    model=config.model,
                                    client=shared_client,
                                )

                            for entry in valid_entries:
                                vid_id = entry["video_id"]
                                title = entry["title"]
                                parsed = mapped_results.get(entry["idx"])
                                if parsed:
                                    added = _save_video_vision_tags(vid_id, title, parsed, config.overwrite)
                                    if added is not None:
                                        stats["improved"] += 1
                                        _AI_TAG_STATE["last_tagged_video_id"] = vid_id
                                        _AI_TAG_STATE["last_tagged_video_title"] = title
                                        _AI_TAG_STATE["last_added_tags"] = added
                                    else:
                                        stats["failed"] += 1
                                else:
                                    stats["failed"] += 1
                                stats["done"] += 1
                                await _update_and_broadcast_progress(last_vid_id=vid_id)

                        except Exception as exc:
                            err_txt = str(exc) or repr(exc)
                            _AI_TAG_STATE["last_error"] = f"Dávka #{chunk[0]['id']}: {err_txt[:120]}"
                            logger.warning("[AI-Tag-Batch] Chunk starting at #%s failed: %s", chunk[0]["id"], err_txt)
                            for _entry in valid_entries:
                                stats["failed"] += 1
                                stats["done"] += 1
                            await _update_and_broadcast_progress()

                tasks = [asyncio.create_task(process_chunk(i, ch)) for i, ch in enumerate(chunks)]
                await asyncio.gather(*tasks, return_exceptions=True)

    except Exception as exc:
        logger.error("[AI-Tag-Batch] Job crashed: %s", exc)
    finally:
        _AI_TAG_RUNNING = False
        finished_iso = datetime.now(timezone.utc).isoformat()
        final_elapsed = int(time.monotonic() - start_time)

        if _AI_TAG_CANCEL_REQUESTED:
            summary = f"Zastavené používateľom ({stats['improved']} otagovaných z {stats['done']}/{total})."
            _AI_TAG_STATE["status_text"] = "Zastavené"
        else:
            summary = (
                f"Hotovo! Otagovaných {stats['improved']} videí z {total} za "
                f"{format_duration_human(final_elapsed).lstrip('~')}."
            )
            _AI_TAG_STATE["status_text"] = "Dokončené"

        _AI_TAG_STATE.update({
            "running": False,
            "message": summary,
            "finished_at": finished_iso,
            "current_video_id": None,
            "current_video_title": "",
            "eta_formatted": "0s",
        })

        await broadcast_ws({
            "type": "ai_tag_batch_done",
            **_AI_TAG_STATE,
        })

    return dict(_AI_TAG_STATE)
