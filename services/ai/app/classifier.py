import threading

import open_clip
import torch
from PIL import Image, ImageOps

MODEL_NAME = "ViT-B-32-quickgelu"
PRETRAINED = "openai"

# Order defines the label set. Keep in sync with ITEM_CATEGORIES in
# packages/shared/src/items.ts — the API rejects anything not in that union.
CATEGORY_PROMPTS = {
    "tshirt": "a photo of a t-shirt",
    "shirt": "a photo of a button-up dress shirt",
    "trousers": "a photo of trousers or jeans",
    "jacket": "a photo of a jacket or coat",
    "dress": "a photo of a dress",
    "skirt": "a photo of a skirt",
    "shorts": "a photo of shorts",
    "shoes": "a photo of shoes",
    "accessory": "a photo of a fashion accessory",
    "other": "a photo of a clothing item",
}

# Guards the one-time load below. functools.lru_cache's internal locking
# only protects its own bookkeeping — on a cache miss it releases the lock
# before calling the wrapped function, so concurrent first-callers can each
# decide "not cached yet" and each run the ~0.9s, ~1.6GB load at once. Under
# FastAPI's threadpool a burst of first requests to /tag could do exactly
# that; on a VM that already runs MongoDB and MinIO, two concurrent loads is
# an OOM, not a slowdown. Double-checked locking makes every caller after
# the first one just wait for the in-flight load instead of starting its own.
_load_lock = threading.Lock()
_classifier_bundle = None


def load_classifier():
    """Load the model once per process, even under concurrent first callers."""
    global _classifier_bundle
    if _classifier_bundle is None:
        with _load_lock:
            if _classifier_bundle is None:
                _classifier_bundle = _load_classifier_once()
    return _classifier_bundle


def _load_classifier_once():
    """The actual load. Roughly 0.9s and ~1.6GB resident. Only ever called
    once per process — see the locking in load_classifier() above."""
    model, _, preprocess = open_clip.create_model_and_transforms(
        MODEL_NAME, pretrained=PRETRAINED
    )
    tokenizer = open_clip.get_tokenizer(MODEL_NAME)
    model.eval()

    labels = list(CATEGORY_PROMPTS)
    with torch.no_grad():
        text_features = model.encode_text(tokenizer([CATEGORY_PROMPTS[l] for l in labels]))
        text_features /= text_features.norm(dim=-1, keepdim=True)

    return model, preprocess, labels, text_features


def classify(image: Image.Image) -> tuple[str, float]:
    model, preprocess, labels, text_features = load_classifier()
    # A phone held in portrait writes landscape sensor data plus an EXIF
    # orientation tag telling viewers how to rotate it. Without correcting
    # for that tag before preprocessing, CLIP sees a genuinely rotated image
    # and can pick the wrong category — measured across the fixture set,
    # uncorrected portrait input drops accuracy from 94.4% to 77.8%, below
    # the documented ~80% claim. Portrait is the primary capture mode for
    # this product, not an edge case.
    image = ImageOps.exif_transpose(image)
    with torch.no_grad():
        tensor = preprocess(image.convert("RGB")).unsqueeze(0)
        features = model.encode_image(tensor)
        features /= features.norm(dim=-1, keepdim=True)
        probs = (100.0 * features @ text_features.T).softmax(dim=-1)[0]
    index = int(probs.argmax())
    return labels[index], float(probs[index])
