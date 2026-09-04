import io
import os
import threading
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import app.classifier as classifier_module
import app.main as main_module
from app.classifier import CATEGORY_PROMPTS, classify
from app.colour import dominant_colours
from app.main import MAX_UPLOAD_BYTES, app

client = TestClient(app)

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
VALID_JPEG_PATH = os.path.join(FIXTURES, "tshirt-0.jpg")

# Deliberately NOT all tshirt-0.jpg. The documented example response payload
# (in this very task's brief) uses category "tshirt" -- a hardcoded/constant
# category of exactly that value would silently pass a comparison test that
# only ever posted a t-shirt fixture. Spanning three fixtures with three
# different ground-truth categories means any single hardcoded constant
# mismatches at least two of them.
DIVERSE_FIXTURES = ("shoes-1.jpg", "trousers-0.jpg", "jacket-0.jpg")


def _post_image(data: bytes, filename: str = "upload.jpg", content_type: str = "image/jpeg"):
    """POST to /tag with the multipart field named 'image' -- this is the
    exact field name Task 4's Express client sends
    (`form.append('image', new Blob(...), 'upload.jpg')`), so a mismatch
    here would only ever surface against the real client, not this suite.
    """
    return client.post("/tag", files={"image": (filename, io.BytesIO(data), content_type)})


# --- Happy path --------------------------------------------------------------


def test_valid_jpeg_returns_200_with_the_documented_shape():
    with open(VALID_JPEG_PATH, "rb") as f:
        response = _post_image(f.read())

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"category", "confidence", "colours"}

    assert body["category"] in CATEGORY_PROMPTS
    assert isinstance(body["confidence"], float)
    assert 0.0 <= body["confidence"] <= 1.0

    assert isinstance(body["colours"], list)
    assert len(body["colours"]) >= 1
    for colour in body["colours"]:
        assert set(colour) == {"hex", "name", "share"}
        assert isinstance(colour["hex"], str) and colour["hex"].startswith("#") and len(colour["hex"]) == 7
        assert isinstance(colour["name"], str) and colour["name"]
        assert 0.0 <= colour["share"] <= 1.0


@pytest.mark.parametrize("fixture_name", DIVERSE_FIXTURES)
def test_response_category_and_confidence_match_classify_output_directly(fixture_name):
    """Guards against a hardcoded/constant category OR confidence: the
    endpoint's answer must equal calling classify() directly on the same
    bytes. Run across fixtures with different ground truths (see
    DIVERSE_FIXTURES) so a constant that happens to match one of them still
    gets caught by the others. classify() is deterministic in eval mode (no
    dropout, no augmentation), so calling it twice on identical bytes -- once
    here, once inside the endpoint -- is expected to agree exactly, not just
    approximately.
    """
    with open(os.path.join(FIXTURES, fixture_name), "rb") as f:
        data = f.read()
    expected_category, expected_confidence = classify(Image.open(io.BytesIO(data)))

    response = _post_image(data)
    body = response.json()

    assert body["category"] == expected_category
    assert body["confidence"] == pytest.approx(expected_confidence)


def test_a_hardcoded_constant_category_would_be_caught():
    """Sanity check on the parametrized test above: confirms the three
    DIVERSE_FIXTURES really do produce at least two different categories,
    so a single hardcoded constant could not coincidentally satisfy all of
    them."""
    categories = {
        classify(Image.open(os.path.join(FIXTURES, name)))[0] for name in DIVERSE_FIXTURES
    }
    assert len(categories) > 1, (
        "DIVERSE_FIXTURES all share one ground-truth category -- a hardcoded "
        "constant would slip through test_response_category_and_confidence_match_classify_output_directly"
    )


@pytest.mark.parametrize("fixture_name", DIVERSE_FIXTURES)
def test_response_colours_match_dominant_colours_directly(fixture_name):
    """Guards against colours always coming back empty or hardcoded --
    every field of every returned colour (not just colours[0].hex) must
    match dominant_colours() called directly on the same bytes."""
    with open(os.path.join(FIXTURES, fixture_name), "rb") as f:
        data = f.read()
    expected = dominant_colours(Image.open(io.BytesIO(data)).convert("RGB"))

    response = _post_image(data)
    body_colours = response.json()["colours"]

    assert len(body_colours) == len(expected)
    for actual, exp in zip(body_colours, expected):
        assert actual["hex"] == exp.hex
        assert actual["name"] == exp.name
        assert actual["share"] == pytest.approx(exp.share)


def test_colours_are_sorted_by_descending_share_in_the_response():
    with open(VALID_JPEG_PATH, "rb") as f:
        response = _post_image(f.read())
    shares = [c["share"] for c in response.json()["colours"]]
    assert shares == sorted(shares, reverse=True)


# --- Missing field: FastAPI's own validation, 422 -----------------------------


def test_missing_file_returns_422():
    response = client.post("/tag")
    assert response.status_code == 422


def test_wrong_field_name_returns_422():
    """Posting the file under some other field name (e.g. 'file') must not
    be silently accepted -- the field name is part of the contract."""
    with open(VALID_JPEG_PATH, "rb") as f:
        response = client.post("/tag", files={"file": ("upload.jpg", f, "image/jpeg")})
    assert response.status_code == 422


# --- Corrupt input: 400, never a 500 -------------------------------------------


def test_garbage_bytes_returns_400_with_a_useful_message():
    response = _post_image(b"this is not an image, just plain text bytes")
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert isinstance(detail, str) and detail


def test_empty_body_returns_400():
    response = _post_image(b"")
    assert response.status_code == 400


def test_truncated_image_returns_400_not_500():
    """classify() raises a raw OSError('image file is truncated') on bytes
    that Image.open() accepts but can't fully decode -- Task 1's review
    flagged this as having no exception-to-HTTP contract. Cutting a real
    JPEG fixture in half reproduces exactly that failure mode.
    """
    with open(VALID_JPEG_PATH, "rb") as f:
        data = f.read()
    truncated = data[: len(data) // 2]

    response = _post_image(truncated)

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert isinstance(detail, str) and detail


def test_non_image_file_of_a_known_type_returns_400():
    """A plausible-looking upload (has a filename, a content-type header)
    that is nonetheless not decodable image data -- e.g. a client sending a
    text file with a spoofed content-type -- must still be rejected on the
    actual bytes, not accepted on the strength of the header."""
    response = _post_image(b"%PDF-1.4 not really a pdf either", filename="upload.pdf", content_type="application/pdf")
    assert response.status_code == 400


# --- Oversized upload: 413, and never a full unbounded buffer -----------------


def test_upload_over_the_size_cap_returns_413():
    oversized = b"x" * (MAX_UPLOAD_BYTES + 1)
    response = _post_image(oversized)
    assert response.status_code == 413
    detail = response.json()["detail"]
    assert isinstance(detail, str) and detail


def test_upload_exactly_at_the_size_cap_is_not_rejected_for_size():
    """Boundary check: exactly MAX_UPLOAD_BYTES must not trip the 413 --
    only bytes that push the running total OVER the limit should. This
    payload is garbage (not a real image), so it should still fail, but
    with 400 (unreadable image), not 413 (too large) -- proving the size
    check uses a strict '>' and isn't off-by-one in the rejecting direction.
    """
    at_limit = b"x" * MAX_UPLOAD_BYTES
    response = _post_image(at_limit)
    assert response.status_code == 400


# --- model_loaded truthfulness (also covered from the /health side in test_health.py) --


def test_model_loaded_is_true_after_a_successful_tag_call():
    classifier_module._classifier_bundle = None
    with open(VALID_JPEG_PATH, "rb") as f:
        _post_image(f.read())
    assert classifier_module._classifier_bundle is not None


def test_model_loaded_stays_false_after_a_rejected_corrupt_upload():
    """A 400 on bad input must not be reported as 'the model is loaded' if
    the corrupt bytes were rejected before classify() ever got a chance to
    load it -- Image.open() on garbage bytes fails before classify() runs."""
    classifier_module._classifier_bundle = None
    _post_image(b"garbage, not an image")
    assert classifier_module._classifier_bundle is None


# --- Concurrency: the event loop must not block on inference -------------------
#
# classify() and dominant_colours() are synchronous and CPU-bound. tag()
# offloads both via starlette.concurrency.run_in_threadpool specifically so
# the single asyncio event loop stays free while an inference runs. These
# tests monkeypatch classify()/dominant_colours() with a controlled sleep
# (rather than relying on the real ~50-200ms inference, which is too fast to
# assert timing against reliably) so the proof isn't flaky and doesn't
# depend on the real model's speed.


def _install_slow_classify(monkeypatch, sleep_seconds: float):
    def slow_classify(image):
        time.sleep(sleep_seconds)
        return "tshirt", 0.9

    monkeypatch.setattr(main_module, "classify", slow_classify)
    monkeypatch.setattr(main_module, "dominant_colours", lambda image: [])


def test_health_stays_responsive_while_a_slow_tag_call_is_in_flight(monkeypatch):
    """At minimum, per the review: /health must keep responding while an
    inference is in flight. If tag() ran classify() inline on the event
    loop (e.g. reverted to not using run_in_threadpool), this sleep would
    block the loop and /health would take ~SLEEP too, instead of returning
    almost immediately.

    Uses TestClient as a context manager (`with TestClient(app) as c`)
    rather than the bare module-level `client`. Starlette's TestClient only
    reuses one persistent event loop (its "portal") across calls when
    entered as a context manager; the bare form spins up a brand new
    background event loop for every single call
    (starlette/testclient.py:_portal_factory checks `self.portal is not
    None`, which is only set by __enter__). Two "concurrent" calls against
    the bare client run on two independent event loops no matter what the
    endpoint does, which cannot detect event-loop blocking at all --
    verified directly: this test against the inline (unfixed) mutation
    passed incorrectly under the bare client and only fails correctly once
    the client is entered as a context manager, matching how a real uvicorn
    process serves every connection off one shared loop.
    """
    SLEEP = 1.0
    _install_slow_classify(monkeypatch, SLEEP)

    with open(VALID_JPEG_PATH, "rb") as f:
        data = f.read()

    result = {}

    with TestClient(app) as shared_loop_client:

        def do_tag():
            r = shared_loop_client.post("/tag", files={"image": ("upload.jpg", io.BytesIO(data), "image/jpeg")})
            result["status"] = r.status_code

        tag_thread = threading.Thread(target=do_tag)
        tag_thread.start()
        time.sleep(SLEEP / 4)  # let the /tag request actually enter its "inference"

        start = time.monotonic()
        health_response = shared_loop_client.get("/health")
        health_elapsed = time.monotonic() - start

        tag_thread.join()

    assert result["status"] == 200
    assert health_response.status_code == 200
    assert health_elapsed < SLEEP / 2, (
        f"/health took {health_elapsed:.2f}s while a {SLEEP}s inference was in "
        "flight -- the event loop was blocked"
    )


def test_concurrent_tag_requests_overlap_rather_than_serialise(monkeypatch):
    """Stronger claim than the /health test above: multiple /tag calls
    themselves must run concurrently, not queue up one at a time. Three
    calls each "taking" SLEEP seconds should finish in well under 3*SLEEP
    if they overlap; a fully serialised implementation would take ~3*SLEEP.

    Must use a context-managed TestClient for the same reason as the
    /health test above -- see its docstring. A bare `client.post(...)` call
    gets its own private event loop per call and cannot observe serialisation
    either way.
    """
    SLEEP = 0.5
    _install_slow_classify(monkeypatch, SLEEP)

    with open(VALID_JPEG_PATH, "rb") as f:
        data = f.read()

    results = []

    with TestClient(app) as shared_loop_client:

        def do_tag():
            r = shared_loop_client.post("/tag", files={"image": ("upload.jpg", io.BytesIO(data), "image/jpeg")})
            results.append(r.status_code)

        threads = [threading.Thread(target=do_tag) for _ in range(3)]
        start = time.monotonic()
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        elapsed = time.monotonic() - start

    assert results == [200, 200, 200]
    assert elapsed < SLEEP * 2, (
        f"3 concurrent /tag calls took {elapsed:.2f}s (~{elapsed / SLEEP:.1f}x SLEEP) "
        "-- looks serialised rather than overlapping"
    )


# --- Finding 3: torch's intra-op thread pool must stay bounded -----------------


def test_torch_thread_count_is_bounded():
    """Regression guard for the set_num_threads(2) call in main.py.
    Unbounded, torch claims every core in the container (measured: 7) per
    inference, which now matters more than it used to -- see the concurrency
    tests above -- because concurrent inferences are genuinely possible, so
    N unbounded inferences would try to claim 7N threads at once."""
    import torch

    assert torch.get_num_threads() <= 2
