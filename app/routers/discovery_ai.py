"""Local image scoring for the temporary Discovery Hub album viewer."""
import asyncio
import base64
import binascii
import io

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from PIL import Image, UnidentifiedImageError

router = APIRouter(prefix="/api/v1/discovery-hub/ai", tags=["discovery-hub"])


class AnalyzeRequest(BaseModel):
    category: str = Field(max_length=64)
    images: list[str] = Field(min_length=1, max_length=6)


def _score(category: str, images: list[str]) -> dict:
    from app.ai_tagger_batch import LOCAL_VISION_TAXONOMY, _get_local_vision_classifier
    from app import visual_semantic_index as vsi

    matching = [(i, row) for i, row in enumerate(LOCAL_VISION_TAXONOMY)
                if row[0] == "action" and row[1] == category]
    if not matching:
        raise HTTPException(422, "Neznáma kategória")
    decoded = []
    for image in images:
        if len(image) > 1_500_000:
            raise HTTPException(413, "Snímka je príliš veľká")
        try:
            payload = image.split(",", 1)[1] if image.startswith("data:image/") else image
            raw = base64.b64decode(payload, validate=True)
            with Image.open(io.BytesIO(raw)) as im:
                if im.width * im.height > 4_000_000:
                    raise ValueError("Image too large")
                decoded.append(im.convert("RGB"))
        except (ValueError, binascii.Error, UnidentifiedImageError, OSError, IndexError):
            raise HTTPException(422, "Neplatná snímka")
    clf = _get_local_vision_classifier()
    if not clf:
        raise HTTPException(503, "Lokálny AI model nie je dostupný")
    vectors = vsi._encode_images_sync(decoded)
    if vectors is None or len(vectors) != len(decoded):
        raise HTTPException(503, "Lokálny AI model nedokázal spracovať snímky")
    idx, row = matching[0]
    scores = (vectors @ clf["t_vecs"][idx] - clf["mu"][idx]) / clf["sigma"][idx]
    score = float(np.max(scores))
    if not np.isfinite(score):
        raise HTTPException(503, "Lokálny AI model vrátil neplatný výsledok")
    threshold = row[3]
    # Existing dashboard thresholds are initial heuristics, not probabilities.
    status = "match" if score >= threshold else "uncertain" if score >= threshold - 0.6 else "unlikely"
    return {"status": status, "score": score, "frames": len(decoded)}


@router.get("/categories")
def categories():
    from app.ai_tagger_batch import LOCAL_VISION_TAXONOMY
    return {"categories": [row[1] for row in LOCAL_VISION_TAXONOMY if row[0] == "action"]}


@router.post("/analyze")
async def analyze(body: AnalyzeRequest):
    return await asyncio.to_thread(_score, body.category, body.images)
