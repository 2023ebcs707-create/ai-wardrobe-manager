import glob
import os
import threading
import time
import warnings

import pytest
from PIL import Image

import app.classifier as classifier_module
from app.classifier import MODEL_NAME, PRETRAINED, classify, load_classifier

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
EXIF_FIXTURES = os.path.join(FIXTURES, "exif")

# Mirrors ITEM_CATEGORIES in packages/shared/src/items.ts. Keep in sync —
# the API rejects anything not in that union, so a prompt with no fixture
# coverage (skirt/shorts/accessory/other) is otherwise unverified in either
# direction: whether it's reachable at all, and whether it silently absorbs
# probability mass from the specific labels.
ITEM_CATEGORIES = (
    "tshirt",
    "shirt",
    "trousers",
    "jacket",
    "dress",
    "skirt",
    "shorts",
    "shoes",
    "accessory",
    "other",
)


def fixture_files():
    return sorted(glob.glob(os.path.join(FIXTURES, "*.jpg")))


def truth_of(path):
    return os.path.basename(path).rsplit("-", 1)[0]


def test_fixture_set_is_present():
    files = fixture_files()
    assert len(files) >= 18, "the committed fixture set is missing or incomplete"


@pytest.mark.parametrize("path", fixture_files(), ids=os.path.basename)
def test_each_fixture_gets_a_known_category(path):
    category, confidence = classify(Image.open(path).convert("RGB"))
    assert isinstance(category, str) and category
    assert 0.0 <= confidence <= 1.0


def test_category_accuracy_meets_the_documented_claim():
    """TC-04. Phase 3 claims ~80% of common items are categorised correctly.

    Measured at 94.4% (17/18) when this plan was written. The threshold is set
    at the DOCUMENTED claim, not at the measured figure, so this test asserts
    what was promised rather than merely locking in today's result.
    """
    files = fixture_files()
    hits = [f for f in files if classify(Image.open(f).convert("RGB"))[0] == truth_of(f)]
    accuracy = len(hits) / len(files)
    assert accuracy >= 0.80, (
        f"category accuracy {accuracy:.1%} is below the documented ~80% claim; "
        f"missed: {[os.path.basename(f) for f in files if f not in hits]}"
    )


def test_a_confident_prediction_is_more_confident_than_an_ambiguous_one():
    """A folded flat-lay is genuinely harder than a hanging garment; the
    confidence score must reflect that, or it is not a useful signal for the
    UI to decide when to prompt the user to check the tag."""
    hanging = classify(Image.open(os.path.join(FIXTURES, "tshirt-2.jpg")).convert("RGB"))
    folded = classify(Image.open(os.path.join(FIXTURES, "tshirt-1.jpg")).convert("RGB"))
    assert hanging[1] > folded[1]


def test_a_clear_cut_prediction_has_meaningfully_high_confidence():
    """Bounds-checking confidence (0.0-1.0) and confidence *ordering* both
    pass under a broken softmax temperature: dropping the scaling factor from
    100.0 to 10.0 keeps accuracy at 17/18 and keeps hanging > folded, but
    collapses every confidence into a flat ~0.13-0.22 band — destroying the
    exact signal Task 5's UI uses to decide when to prompt a human to check
    the tag. shoes-1.jpg measures 0.94 confidence; 0.6 is comfortably below
    that (loose enough not to be brittle to minor prompt/model tuning) and
    comfortably above the ~0.22 ceiling the flattened-temperature mutant
    produces (tight enough to actually catch it).
    """
    category, confidence = classify(Image.open(os.path.join(FIXTURES, "shoes-1.jpg")).convert("RGB"))
    assert confidence > 0.6, f"expected a confident prediction, got {category!r} at {confidence:.2f}"


def test_model_id_is_pinned_to_the_quickgelu_variant():
    """ViT-B-32 (without -quickgelu) silently mismatches OpenAI's QuickGELU-
    trained weights. Measured directly: on this 18-image fixture set, that
    mismatch does NOT move accuracy below 0.80 (both variants score 17/18,
    missing the same fixture) — so the accuracy test alone would not catch a
    reversion. Pin the model id and pretrained tag directly instead.
    """
    assert MODEL_NAME == "ViT-B-32-quickgelu"
    assert PRETRAINED == "openai"


def test_loading_the_model_raises_no_warnings():
    """A quick_gelu/pretrained-tag mismatch (e.g. reverting MODEL_NAME to
    'ViT-B-32') raises open_clip's UserWarning at load time and quietly
    degrades accuracy without necessarily failing the accuracy assertion
    above. Belt-and-braces for the same regression as the previous test,
    and a direct check on the project's "no warnings" constraint.
    """
    classifier_module._classifier_bundle = None
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        load_classifier()
    assert caught == [], [str(w.message) for w in caught]


def test_category_prompts_cover_every_item_category():
    """skirt/shorts/accessory/other have no fixture coverage in this set —
    this is the only thing keeping their prompts honest: that all ten exist,
    in the order the API union expects."""
    assert list(classifier_module.CATEGORY_PROMPTS) == list(ITEM_CATEGORIES)


def test_other_does_not_dominate_a_fixture_with_a_specific_ground_truth():
    """'other' is the catch-all prompt ("a photo of a clothing item"). None
    of the 18 committed fixtures has ground truth 'other', so none of them
    should be classified as 'other' either — otherwise the catch-all is
    silently absorbing probability mass it shouldn't."""
    files = fixture_files()
    dominated = [
        os.path.basename(f)
        for f in files
        if classify(Image.open(f).convert("RGB"))[0] == "other"
    ]
    assert dominated == [], f"'other' incorrectly won for: {dominated}"


def test_exif_rotated_photo_classifies_the_same_as_its_upright_original():
    """A phone held in portrait writes landscape sensor data plus an EXIF
    orientation tag telling viewers how to rotate it. Measured directly:
    across all 18 fixtures, simulating that rotation without correcting for
    it drops accuracy from 94.4% to 77.8% — BELOW the documented ~80% claim
    — and specifically flips dress-1 (dress->shirt) and tshirt-3
    (tshirt->other). No committed fixture carries a real orientation tag, so
    nothing previously caught this. These three fixtures do: each is the
    corresponding upright original's raw sensor data, rotated 90 CCW and
    tagged EXIF orientation=6 (the tag a portrait phone actually writes),
    exactly as measured above. classify() must correct for it internally —
    the raw file is passed straight through, not pre-corrected here.
    """
    pairs = [
        ("dress-0.jpg", "dress-0-orientation6.jpg"),
        ("dress-1.jpg", "dress-1-orientation6.jpg"),
        ("tshirt-3.jpg", "tshirt-3-orientation6.jpg"),
    ]
    for original_name, rotated_name in pairs:
        original_category, _ = classify(
            Image.open(os.path.join(FIXTURES, original_name)).convert("RGB")
        )
        rotated_category, _ = classify(Image.open(os.path.join(EXIF_FIXTURES, rotated_name)))
        assert rotated_category == original_category, (
            f"{rotated_name}: expected {original_category!r} (matching upright "
            f"{original_name}), got {rotated_category!r} — EXIF orientation was "
            f"not corrected before classification"
        )


def test_concurrent_first_callers_load_the_model_only_once():
    """FastAPI serves /tag from a threadpool; a burst of simultaneous first
    requests must not each independently load a ~1.6GB model — on a VM that
    already runs MongoDB and MinIO, that is an OOM, not a slowdown.
    functools.lru_cache does not protect against this: it only serializes its
    own bookkeeping, not the wrapped call, so concurrent misses each run the
    load. Force a fresh load and inject a delay to widen the race window,
    then confirm exactly one thread actually performed it.
    """
    classifier_module._classifier_bundle = None
    real_load_once = classifier_module._load_classifier_once
    calls = []
    call_lock = threading.Lock()

    def counting_load_once():
        with call_lock:
            calls.append(1)
        time.sleep(0.05)
        return real_load_once()

    classifier_module._load_classifier_once = counting_load_once
    try:
        threads = [threading.Thread(target=classifier_module.load_classifier) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    finally:
        classifier_module._load_classifier_once = real_load_once

    assert len(calls) == 1, f"expected exactly one load across 5 concurrent first-callers, got {len(calls)}"
