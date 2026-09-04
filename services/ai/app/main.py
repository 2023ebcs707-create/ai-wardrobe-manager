import io
import logging
from typing import Literal

import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from app import classifier as classifier_module
from app.classifier import classify
from app.colour import dominant_colours
from app.suggest import (
    DEFAULT_SUGGESTION_LIMIT,
    KNOWN_CATEGORIES,
    MAX_SUGGESTION_LIMIT,
    SEASONS,
    suggest,
)

logger = logging.getLogger(__name__)

# Bounds PyTorch's intra-op thread pool. Measured in-container: this VM's
# container sees 7 cores (os.cpu_count()), and torch defaults to using all
# of them per inference. Left unbounded, every /tag call would compete for
# every core against MongoDB and MinIO running alongside it -- and once
# concurrent inferences are actually possible (see the async/threadpool
# comment on tag() below), N concurrent requests would try to claim 7N
# threads at once, not just 7.
# Measured cost of capping it: classify() latency across 15 runs each at
# thread counts 1/2/3/4/7 was 51-67ms median in every case -- this model is
# small enough that intra-op parallelism buys almost nothing, while 7
# (unbounded) showed the widest variance (34-196ms), consistent with
# contention rather than genuine speedup. 2 threads keeps each inference
# using more than one core without letting a handful of concurrent requests
# claim the whole machine. Stage 9 owns further tuning if load testing says
# otherwise.
torch.set_num_threads(2)

app = FastAPI(title="Wardrobe AI Service")

# Deliberately NOT pre-loading the model at import. Phase 3 §4 documents a
# 3-5s cold start as a known bottleneck and Stage 9 must measure it; warming
# here would erase the measurement. Stage 9 decides whether to keep-alive.

# Matches Express's multer limit exactly (apps/api/src/routes/items.ts,
# MAX_UPLOAD_BYTES = 10 * 1024 * 1024), so the two services agree on what
# "too big" means instead of this one silently trusting a limit enforced
# only on the other side of the network.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
_READ_CHUNK_BYTES = 1024 * 1024


@app.get("/health")
def health() -> dict:
    # Reads the classifier module's load state directly rather than calling
    # load_classifier() -- calling it would itself trigger the ~2.9s load,
    # which would defeat the entire purpose of reporting whether it has
    # happened yet.
    return {
        "status": "ok",
        "model_loaded": classifier_module._classifier_bundle is not None,
    }


async def _read_capped(upload: UploadFile, limit: int) -> bytes:
    """Read `upload` in bounded chunks, rejecting anything over `limit`
    bytes with a 413 instead of materialising the whole body first and
    measuring it afterwards.

    A multipart part's own Content-Length isn't reliably sent by every
    client, so a header check alone isn't a real guarantee here -- reading
    incrementally and bailing the moment the running total crosses `limit`
    holds regardless of what any client claims, and this endpoint has no
    auth in front of it (Express is the only intended caller, but it is not
    the only possible one inside the compose network).
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(_READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise HTTPException(
                status_code=413,
                detail=f"uploaded file exceeds the {limit} byte limit",
            )
        chunks.append(chunk)
    return b"".join(chunks)


@app.post("/tag")
async def tag(image: UploadFile = File(...)) -> dict:
    """Classify an uploaded garment photo and extract its dominant colours.

    Kept `async def`, with the CPU-bound work explicitly handed to
    run_in_threadpool -- NOT run inline. classify() (a CLIP forward pass)
    and dominant_colours() (a k-means fit) are synchronous and CPU-bound;
    running them directly in an `async def` body executes them on the
    single asyncio event loop, blocking it for the call's full duration.
    That would serialise every /tag request AND stall /health (and
    everything else this process serves) while any one inference is in
    flight -- concretely, the compose healthcheck polls /health every 5s
    and would start failing under real load. Declaring `tag` as a plain
    `def` was the other option (FastAPI threadpools sync endpoint bodies
    automatically), but FastAPI still resolves the `UploadFile` parameter
    itself via async multipart parsing on the event loop either way, and
    the incremental capped read below is naturally async
    (`UploadFile.read()` is a coroutine) -- keeping `async def` and
    threadpooling only the two calls that are actually CPU-bound is more
    surgical than moving the whole function, parsing included, to a worker
    thread. See test_health_stays_responsive_while_a_slow_tag_call_is_in_flight
    and test_concurrent_tag_requests_overlap_rather_than_serialise in
    test_tag_endpoint.py for the verification that this actually holds.

    Exception-to-HTTP contract: classify() and Image.open() raise raw PIL
    exceptions on bad input -- UnidentifiedImageError (itself an OSError
    subclass) when Image.open() can't identify the format at all, and a
    plain OSError ("image file is truncated") once something actually reads
    pixel data on bytes that opened but don't fully decode. That decode can
    happen either here or inside classify()'s image.convert("RGB"), so both
    calls sit inside the same try block. Any OSError from either one means
    "this is not usable image data" and becomes a 400 -- never an unhandled
    500. classify() applies EXIF orientation correction internally (Task 1);
    nothing about orientation belongs in this endpoint.
    """
    body = await _read_capped(image, MAX_UPLOAD_BYTES)

    try:
        pil_image = Image.open(io.BytesIO(body))
        category, confidence = await run_in_threadpool(classify, pil_image)
    except OSError as exc:
        logger.warning("rejected unreadable upload %r: %s", image.filename, exc)
        raise HTTPException(
            status_code=400, detail="uploaded file could not be read as an image"
        ) from exc

    colours = await run_in_threadpool(dominant_colours, pil_image)

    return {
        "category": category,
        "confidence": confidence,
        "colours": [c._asdict() for c in colours],
    }


# --- POST /suggest -----------------------------------------------------------

# Both vocabularies are derived from the rule engine's own tables rather than
# spelled out again here, so the endpoint cannot come to accept a category or
# a season that the engine has no rule for.
SuggestionCategory = Literal[KNOWN_CATEGORIES]
SuggestionSeason = Literal[SEASONS]


class SuggestColour(BaseModel):
    # The hex is the only colour datum the engine treats as ground truth (the
    # name is a label it will re-derive if it does not recognise it), so an
    # unparseable hex is a malformed body, not something to guess at.
    hex: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    name: str
    share: float | None = Field(default=None, ge=0.0, le=1.0)


class SuggestItem(BaseModel):
    id: str = Field(min_length=1)
    category: SuggestionCategory
    # Both default to empty rather than being required: an item with no
    # colours is still wearable, and an item with no seasons is eligible in
    # every season (see app.suggest._in_season).
    colours: list[SuggestColour] = Field(default_factory=list)
    seasons: list[SuggestionSeason] = Field(default_factory=list)


class SuggestRequest(BaseModel):
    items: list[SuggestItem]
    season: SuggestionSeason | None = None
    occasion: str | None = None
    limit: int = Field(default=DEFAULT_SUGGESTION_LIMIT, ge=1, le=MAX_SUGGESTION_LIMIT)

    @field_validator("items")
    @classmethod
    def _ids_must_be_unique(cls, items: list[SuggestItem]) -> list[SuggestItem]:
        """Two garments cannot share an id.

        A wardrobe with a repeated id is meaningless, and it is the one thing
        every other field's validation did not already exclude -- this
        endpoint has no auth in front of it inside the compose network, so
        "Express would never send that" is not a guarantee. Left unchecked it
        produced an outfit whose `itemIds` named the same garment twice, from
        the module whose whole defence is structural validity.
        """
        duplicates = sorted({i.id for i in items if [x.id for x in items].count(i.id) > 1})
        if duplicates:
            raise ValueError(f"item ids must be unique; repeated: {', '.join(duplicates)}")
        return items


@app.post("/suggest")
def suggest_outfits(request: SuggestRequest) -> dict:
    """Rank the outfits this wardrobe can form, by colour, category and season.

    A plain `def`, unlike /tag: FastAPI threadpools synchronous endpoint
    bodies automatically, so this cannot block the event loop, and there is
    nothing async to interleave with -- the whole request is arithmetic over
    the body that was just parsed.

    Deliberately does NOT touch the classifier. `app.suggest` imports nothing
    from `app.classifier`, so no code path here can trigger the 3-5s model
    load; /health must still report `model_loaded: false` after a call to this
    endpoint, and a test asserts exactly that.

    In-laundry filtering is the CALLER's job, per Stage 7's ruling 3: laundry
    state lives in Mongo and is not part of this request shape at all.
    """
    suggestions = suggest(
        request.items,
        season=request.season,
        occasion=request.occasion,
        limit=request.limit,
    )
    body: dict = {
        "suggestions": [
            {"itemIds": list(s.item_ids), "score": s.score, "rationale": s.rationale}
            for s in suggestions
        ]
    }
    # Say so when an input was discarded. Ruling 3 requires the in-laundry
    # exclusion be stated in the response for exactly this reason, and an
    # accepted-but-inert parameter has the same shape of problem: a caller
    # sending `occasion=formal` and getting a 200 has no way to learn that
    # nothing in the ranking was affected by it. Present only when the caller
    # actually sent the thing, so a caller who sent nothing sees the
    # documented `{ suggestions }` shape unchanged.
    if request.occasion is not None:
        body["ignored"] = ["occasion"]
    return body
