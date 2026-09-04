import re
import warnings

import numpy as np
import pytest
from PIL import Image

from app.colour import NAMED_COLOURS, dominant_colours, name_colour

HEX_RE = re.compile(r"^#[0-9a-f]{6}$")

# Matches Task 3's documented example payload (hex "#1c2a5c") exactly, so
# this fixture's measured values can be cross-checked against that brief.
NAVY_RGB = (28, 42, 92)

# Matches the top colour measured in the plan's pre-verification table for
# the "two-tone stripe" regime.
STRIPE_TOP = (180, 31, 41)
STRIPE_SECOND = (31, 90, 180)


def _solid(rgb, size=(100, 100)):
    return Image.new("RGB", size, rgb)


def _bands(bands, size=(100, 100)):
    """Build an image of horizontal solid-colour bands.

    `bands` is a list of (rgb, row_count) pairs whose row_counts must sum
    to the image height. Built directly as a numpy array (not drawn) so
    there is no anti-aliasing at the band boundaries -- every pixel is
    exactly one of the given colours, which keeps the resulting cluster
    shares exactly predictable.
    """
    width, height = size
    assert sum(rows for _, rows in bands) == height
    arr = np.zeros((height, width, 3), dtype=np.uint8)
    y = 0
    for rgb, rows in bands:
        arr[y : y + rows, :, :] = rgb
        y += rows
    return Image.fromarray(arr, mode="RGB")


def _noise(size=(100, 100), seed=42):
    rng = np.random.default_rng(seed)
    arr = rng.integers(0, 256, size=(size[1], size[0], 3), dtype=np.uint8)
    return Image.fromarray(arr, mode="RGB")


def _fine_alternating_columns(color_a, color_b, size=(1200, 1200)):
    """Every other column solid `color_a`/`color_b`.

    Fixture review finding: every other helper in this file defaults to
    size=(100, 100), exactly DOWNSAMPLE_SIZE, so `.resize(DOWNSAMPLE_SIZE,
    ...)` is a no-op on them -- deleting the resize call entirely produces
    byte-identical output on every one of those fixtures. This helper is
    12x that size (matching DOWNSAMPLE_SIZE's stride cleanly) so the resize
    is genuinely exercised.

    At full resolution this is an exact 50/50 split. A NEAREST downsample
    samples one column out of every 12 (verified empirically for this
    Pillow build: columns 6, 18, 30, ... -- see
    test_downsampling_is_actually_applied_to_large_images). Since 12 is
    even and the colours alternate with period 2, every sampled column
    lands on the same parity, so the downsampled image aliases entirely
    into a single colour. That is only true if a resize to a coarser grid
    actually happens first -- on the raw 1200x1200 array the split stays
    an honest 50/50, so this fixture makes "was the image actually
    downsampled" a directly observable, deterministic fact rather than a
    timing guess.
    """
    width, height = size
    arr = np.empty((height, width, 3), dtype=np.uint8)
    arr[:, 0::2] = color_a
    arr[:, 1::2] = color_b
    return Image.fromarray(arr, mode="RGB")


def _solid_with_patch(background, patch_colour, patch_box, size=(1200, 1200)):
    """A solid background with a small rectangular patch of a second colour.

    `patch_box` is (row_start, row_end, col_start, col_end), half-open.
    """
    width, height = size
    arr = np.empty((height, width, 3), dtype=np.uint8)
    arr[:, :] = background
    r0, r1, c0, c1 = patch_box
    arr[r0:r1, c0:c1] = patch_colour
    return Image.fromarray(arr, mode="RGB")


# --- Regime 1: solid colour -> share should be exactly 1.0 -----------------


def test_solid_navy_image_is_a_single_full_share_colour():
    result = dominant_colours(_solid(NAVY_RGB))
    assert len(result) == 1
    assert result[0].hex == "#1c2a5c"
    assert result[0].share == 1.0


def test_solid_navy_maps_to_a_sensible_name():
    result = dominant_colours(_solid(NAVY_RGB))
    assert result[0].name in ("navy", "blue")


def test_k_is_clamped_to_the_number_of_distinct_colours():
    """Asking for k=5 clusters on a solid-colour image must not invent
    phantom clusters -- there is only one colour to find, and a naive
    KMeans(n_clusters=5) here is exactly what triggers sklearn's
    ConvergenceWarning."""
    result = dominant_colours(_solid(NAVY_RGB), k=5)
    assert len(result) == 1
    assert result[0].share == 1.0


def test_solid_colour_extraction_emits_no_warnings():
    """A naive k-means asked for more clusters than distinct colours emits
    sklearn's ConvergenceWarning. That must be fixed at the cause (clamping
    k), not filtered -- so this asserts zero warnings recorded, not just
    the absence of one named warning class."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        dominant_colours(_solid(NAVY_RGB))
    assert caught == [], [str(w.message) for w in caught]


# --- Regime 2: two-tone stripe -> top colour near 0.5, second close behind -


def test_two_tone_stripe_top_colour_share_is_near_half_with_second_close_behind():
    image = _bands([(STRIPE_TOP, 55), (STRIPE_SECOND, 45)])
    result = dominant_colours(image)
    assert len(result) == 2
    assert result[0].share == pytest.approx(0.55)
    assert result[1].share == pytest.approx(0.45)
    assert result[0].hex == "#b41f29"


# --- Regime 3: random noise -> no colour dominates --------------------------


def test_random_noise_has_no_dominant_colour():
    result = dominant_colours(_noise(), k=3)
    assert len(result) == 3
    # This is the whole point of TC-05's "share" field: it lets a caller
    # distinguish a trustworthy solid-colour read (share == 1.0) from a
    # patterned item where the "dominant" colour barely beats the rest.
    assert result[0].share < 0.5
    for r in result:
        assert 0.2 <= r.share <= 0.45


def test_noise_fixture_hex_values_are_rounded_not_truncated():
    """This fixture's cluster centroids are k-means means over many distinct
    integer pixel values, so they have real, substantial fractional parts
    (e.g. one channel lands at ~78.6). A reviewer confirmed truncating
    instead of rounding in `to_hex` changes all three of these hex strings
    (e.g. this fixture's second colour would read `#3c4e8a` instead of
    `#3c4f8a`) with nothing here noticing, because the only prior assertion
    on noise hexes was a format regex. Pinning the exact, previously-
    measured values closes that gap.

    (Even the two-tone stripe fixture's "obviously exact" centroids turn
    out to carry floating-point noise from k-means's internal arithmetic --
    e.g. 30.999999999999936, not a clean 31.0 -- so
    test_two_tone_stripe_top_colour_share_is_near_half_with_second_close_behind's
    hardcoded hex assertion independently catches this same mutation too.
    This test exists anyway because that fixture's noise is a sub-ULP
    accident of arithmetic, not a deliberately fractional value, so relying
    on it alone would be fragile to unrelated implementation changes.)
    """
    result = dominant_colours(_noise(), k=3)
    assert [r.hex for r in result] == ["#7ccc7d", "#3c4f8a", "#c55076"]


# --- Sort order --------------------------------------------------------------


def test_results_are_sorted_by_descending_share():
    image = _bands([(STRIPE_TOP, 50), ((20, 160, 60), 30), ((230, 210, 40), 20)])
    result = dominant_colours(image)
    shares = [r.share for r in result]
    assert shares == sorted(shares, reverse=True)
    assert shares == [pytest.approx(0.5), pytest.approx(0.3), pytest.approx(0.2)]


# --- Hex format ---------------------------------------------------------------


@pytest.mark.parametrize(
    "image",
    [
        _solid(NAVY_RGB),
        _bands([(STRIPE_TOP, 55), (STRIPE_SECOND, 45)]),
        _noise(),
    ],
    ids=["solid", "stripe", "noise"],
)
def test_hex_is_a_valid_rrggbb_string(image):
    for r in dominant_colours(image):
        assert HEX_RE.match(r.hex)


# --- Downsampling behaviour ---------------------------------------------------
#
# Every fixture above is built at size=(100, 100), exactly DOWNSAMPLE_SIZE, so
# `.resize(DOWNSAMPLE_SIZE, ...)` is a no-op there -- a reviewer deleted the
# resize call entirely and got byte-identical output on all of them. These
# tests use materially larger (1200x1200) images specifically so the resize
# is exercised, and assert on effects that only hold if it actually runs.


def test_downsampling_is_actually_applied_to_large_images():
    """Fails if the resize call is removed. See _fine_alternating_columns."""
    image = _fine_alternating_columns((200, 30, 30), (30, 30, 200))
    result = dominant_colours(image)
    # Full resolution is an exact 50/50 split; the aliased, downsampled
    # image is not -- it collapses to a single colour. Confirmed by mutation:
    # removing the resize call restores the true 50/50 (two-result) split.
    assert len(result) == 1
    assert result[0].share == 1.0


def test_small_colour_region_below_sampling_density_is_not_reported():
    """Documents the sampling-density tradeoff explained in the module
    docstring: a region smaller than the downsample's sampling density can
    be skipped entirely rather than blended into a cluster. This is
    intended, not a bug -- see the module docstring for why blending
    filters are worse. The patch here is a solid 6x6 square positioned at
    rows/cols 0-5; empirically confirmed (see
    test_downsampling_is_actually_applied_to_large_images's derivation)
    that this build's NEAREST resize samples source rows/cols 6, 18, 30,
    ... -- so a patch confined to indices 0-5 contains none of them and is
    never seen by the clustering step.
    """
    image = _solid_with_patch(
        background=(240, 240, 240),
        patch_colour=(200, 30, 30),
        patch_box=(0, 6, 0, 6),
    )
    result = dominant_colours(image)
    assert len(result) == 1
    assert result[0].share == 1.0


def test_colour_region_at_least_one_sample_cell_wide_is_reported():
    """Contrast for the test above: a patch at least as wide as the sample
    stride (12px, for this 1200->100 downsample) is guaranteed to contain
    a sample point by pigeonhole, regardless of where it is placed -- this
    does not depend on empirically locating a specific offset, unlike the
    small-patch test. It should always show up in the result, even at a
    tiny share.
    """
    image = _solid_with_patch(
        background=(240, 240, 240),
        patch_colour=(200, 30, 30),
        patch_box=(0, 12, 0, 12),
    )
    result = dominant_colours(image)
    assert len(result) == 2
    assert result[-1].share > 0.0


# --- Naming --------------------------------------------------------------------


def test_pure_white_maps_to_white():
    result = dominant_colours(_solid((255, 255, 255)))
    assert result[0].name == "white"


def test_pure_black_maps_to_black():
    result = dominant_colours(_solid((0, 0, 0)))
    assert result[0].name == "black"


@pytest.mark.parametrize("name,rgb", list(NAMED_COLOURS.items()))
def test_every_palette_anchor_names_itself(name, rgb):
    """Guards against a namer that always returns one label (e.g. always
    'black') -- every anchor colour in the palette must round-trip to its
    own name, not just the dark ones."""
    assert name_colour(rgb) == name


# --- Naming: pastel/muted garment colours (reviewer finding) -------------------
#
# Plain RGB nearest-neighbour is dominated by lightness, so bright pastels and
# muted mid-tones drift to whichever anchor happens to be close in raw
# brightness rather than hue: a reviewer measured sky-blue (135,206,235) and
# mint (152,255,152) both landing on "beige", lavender (230,230,250) on
# "white", and teal (0,128,128) -- fully saturated -- on "grey". These are
# ordinary garment colours, not contrived ones, so this matters for real UI
# labels. name_colour now compares in HSV instead (see its docstring for the
# reasoning); these tests pin the measured improvement and are honest about
# what remains genuinely ambiguous.


def test_sky_blue_maps_to_blue_not_a_neutral():
    """Clean, stable win: sky-blue has real hue and moderate saturation and
    should read as a light blue, not beige. Confirmed stable under +/-8
    per-channel perturbation, i.e. this is not a knife-edge result."""
    assert name_colour((135, 206, 235)) == "blue"


def test_mint_maps_to_green_not_a_neutral():
    """Clean, stable win, same reasoning as sky-blue."""
    assert name_colour((152, 255, 152)) == "green"


def test_teal_maps_to_a_saturated_hue_not_grey():
    """Teal is fully saturated (min channel is 0) but its hue sits almost
    exactly midway between green and blue/navy in this 13-name palette,
    which has no dedicated teal/cyan entry -- which of the two neighbours
    it lands on can flip with small input changes (confirmed empirically),
    and that is an honest palette-coverage gap, not something this test
    tries to pin down further. What is not defensible is 'grey': grey has
    zero saturation and teal has full saturation, so landing there means
    saturation was ignored entirely, which is the actual regression this
    guards against.
    """
    assert name_colour((0, 128, 128)) not in {"white", "black", "grey", "beige"}


def test_pale_lavender_no_longer_collapses_to_a_neutral():
    """(230,230,250) has very low saturation (~8%) -- genuinely close to
    grey/white -- so which chromatic bucket it lands in is close to
    arbitrary and this test does not force a specific one (confirmed to
    flip between at least two plausible answers under small input
    perturbation). What it must not do is collapse to a neutral purely
    because it is bright and low-saturation, which is exactly what plain
    RGB distance did.
    """
    assert name_colour((230, 230, 250)) not in {"white", "black", "grey", "beige"}
