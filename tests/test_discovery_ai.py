import base64
import io
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app.routers.discovery_ai import router
from fastapi import FastAPI

app = FastAPI()
app.include_router(router)
client = TestClient(app)


def image():
    data = io.BytesIO()
    Image.new("RGB", (8, 8), "red").save(data, format="JPEG")
    return base64.b64encode(data.getvalue()).decode()


def test_score_uses_strongest_frame_and_existing_threshold():
    from app.ai_tagger_batch import LOCAL_VISION_TAXONOMY
    count = len(LOCAL_VISION_TAXONOMY)
    idx = next(i for i, row in enumerate(LOCAL_VISION_TAXONOMY) if row[1] == "blowjob")
    vecs = np.zeros((count, 2), dtype=np.float32)
    vecs[idx] = [1, 0]
    classifier = {"t_vecs": vecs, "mu": np.zeros(count), "sigma": np.ones(count)}
    with patch("app.ai_tagger_batch._get_local_vision_classifier", return_value=classifier), \
         patch("app.visual_semantic_index._encode_images_sync", return_value=np.array([[0.2, 0.8], [1.2, 0]], dtype=np.float32)):
        res = client.post("/api/v1/discovery-hub/ai/analyze", json={"category": "blowjob", "images": [image(), image()]})
    assert res.status_code == 200
    assert res.json()["status"] == "match"
    assert res.json()["frames"] == 2
    assert res.json()["score"] > 1.1


def test_invalid_image_unknown_category_and_missing_model():
    assert client.post("/api/v1/discovery-hub/ai/analyze", json={"category": "bogus", "images": [image()]}).status_code == 422
    assert client.post("/api/v1/discovery-hub/ai/analyze", json={"category": "blowjob", "images": ["not base64"]}).status_code == 422
    with patch("app.ai_tagger_batch._get_local_vision_classifier", return_value=None):
        assert client.post("/api/v1/discovery-hub/ai/analyze", json={"category": "blowjob", "images": [image()]}).status_code == 503
