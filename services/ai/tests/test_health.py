import io

from fastapi.testclient import TestClient
from PIL import Image

import app.classifier as classifier_module
from app.main import app

client = TestClient(app)


def _valid_jpeg_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), (10, 20, 30)).save(buf, format="JPEG")
    return buf.getvalue()


def test_health_returns_ok():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_health_reports_model_not_loaded_when_bundle_is_unset():
    """Stage 0 hardcoded model_loaded to False with a comment saying Stage 3
    would make it real. This asserts the real thing: with no model bundle
    loaded, /health must say so. The bundle is reset explicitly rather than
    relying on this test running before any classifier test in the same
    pytest session -- other test modules loading the model first would
    otherwise make this test order-dependent and eventually wrong.
    """
    classifier_module._classifier_bundle = None
    response = client.get("/health")
    assert response.json()["model_loaded"] is False


def test_health_reports_model_loaded_true_after_a_tag_call():
    """The other half of the truthfulness contract: if /health always
    reported False, this is the test that would catch it."""
    classifier_module._classifier_bundle = None
    client.post("/tag", files={"image": ("upload.jpg", io.BytesIO(_valid_jpeg_bytes()), "image/jpeg")})
    response = client.get("/health")
    assert response.json()["model_loaded"] is True


def test_unknown_route_returns_404():
    assert client.get("/nope").status_code == 404
