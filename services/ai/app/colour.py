"""Dominant colour extraction via k-means clustering.

Downsamples the image to a small fixed size, clusters pixel colours with
k-means, and reports each cluster as a hex colour, a human-readable name
from a small fixed palette, and its share of the image's pixels.

Deliberately simple per Phase 3's TC-05 scope: no perceptual colour space
for clustering, no palette beyond the top few clusters, no background/
garment segmentation.

Sampling-density tradeoff (read before "fixing" this): the downsample
means a coloured region much smaller than roughly image_size / 100 pixels
per axis can be skipped entirely rather than blended into a cluster --
e.g. a small logo can vanish from the result. That is deliberate, not a
bug. NEAREST resampling is used specifically because the alternative,
blending filters (BILINEAR/LANCZOS), would invent colours that are not
actually present in the garment -- a red logo averaged against a white
shirt yields pink, and reporting "pink" for a white shirt is worse than
omitting a region too small to be dominant by definition. Do not switch
to a blending filter without re-measuring; see the downsampling-behaviour
tests in test_colour.py.
"""

import colorsys
from typing import NamedTuple

import numpy as np
from PIL import Image
from sklearn.cluster import KMeans

# Downsample target. Small enough to keep clustering fast (measured 5-11ms
# at this size vs. hundreds of ms to seconds without it); large enough that
# solid- and near-solid-colour garments still cluster cleanly. NEAREST
# resampling is used deliberately (see module docstring) so a same-size
# image resizes as a true identity and hard colour boundaries are never
# blurred into extra, spurious clusters.
DOWNSAMPLE_SIZE = (100, 100)

# A small fixed palette for nearest-neighbour naming. This is a UI label,
# not a colorimetric claim -- values are the standard CSS colour keywords.
NAMED_COLOURS: dict[str, tuple[int, int, int]] = {
    "black": (0, 0, 0),
    "white": (255, 255, 255),
    "grey": (128, 128, 128),
    "navy": (0, 0, 128),
    "blue": (0, 0, 255),
    "red": (255, 0, 0),
    "green": (0, 128, 0),
    "yellow": (255, 255, 0),
    "brown": (165, 42, 42),
    "pink": (255, 192, 203),
    "purple": (128, 0, 128),
    "orange": (255, 165, 0),
    "beige": (245, 245, 220),
}

# name_colour compares in HSV, not raw RGB -- see its docstring. Weights
# tuned empirically against the palette anchors (each must round-trip to
# its own name) and a handful of real garment pastels; not derived from
# first principles. HUE dominates once a colour has real saturation; VALUE
# barely counts on its own, since black/white/grey/beige are already
# separated well enough by SATURATION plus the small residual VALUE term.
_HUE_WEIGHT = 30.0
_SATURATION_WEIGHT = 0.5
_VALUE_WEIGHT = 0.05

_NAMED_COLOURS_HSV = {
    name: colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    for name, (r, g, b) in NAMED_COLOURS.items()
}


class ColourResult(NamedTuple):
    hex: str
    name: str
    share: float


def to_hex(rgb) -> str:
    """Format an RGB triple as a '#rrggbb' string."""
    r, g, b = (int(round(c)) for c in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def name_colour(rgb) -> str:
    """Nearest-neighbour label for `rgb` from the fixed NAMED_COLOURS palette.

    Distance is computed in HSV, not raw RGB. Plain RGB Euclidean distance
    is dominated by lightness, because that is the axis RGB spreads pixel
    values across the most: a pastel sky-blue (135,206,235) or mint
    (152,255,152) both land nearer to "beige" than to "blue"/"green" under
    RGB distance, purely because they are bright and pale, not because a
    person would call either of them beige. Comparing hue separately, and
    weighting it heavily once a colour actually has some saturation, fixes
    the common "light X" case while leaving black/white/grey/beige -- which
    are mostly separated by value and saturation, not hue -- unaffected.
    (The hue term is scaled by the candidate's own saturation for exactly
    this reason: a genuinely grey/near-white pixel has no reliable hue to
    weight in the first place.)

    This does not fully solve colour naming. A few real colours -- teal,
    very low-saturation pastels like pale lavender -- sit close to equidistant
    in hue between two anchors and have no dedicated entry in this fixed
    13-name palette; which neighbour they land on is close to arbitrary and
    can flip with small input changes. That is a genuine palette-coverage
    gap, not a metric bug -- see test_colour.py's naming tests for what is
    and is not guaranteed.
    """
    r, g, b = rgb
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)

    def distance(name: str) -> float:
        anchor_h, anchor_s, anchor_v = _NAMED_COLOURS_HSV[name]
        hue_diff = min(abs(h - anchor_h), 1 - abs(h - anchor_h))
        return (
            _HUE_WEIGHT * s * hue_diff**2
            + _SATURATION_WEIGHT * (s - anchor_s) ** 2
            + _VALUE_WEIGHT * (v - anchor_v) ** 2
        )

    return min(NAMED_COLOURS, key=distance)


def dominant_colours(image: Image.Image, k: int = 3) -> list[ColourResult]:
    """Cluster `image`'s pixels into up to `k` dominant colours.

    Returns a list of ColourResult sorted by descending share. `k` is
    clamped to the number of distinct colours present so that k-means is
    never asked for more clusters than the data can support -- asking for
    more raises sklearn's ConvergenceWarning, which would violate this
    project's pristine-output rule.
    """
    small = image.convert("RGB").resize(DOWNSAMPLE_SIZE, Image.Resampling.NEAREST)
    pixels = np.asarray(small).reshape(-1, 3)

    distinct = len(np.unique(pixels, axis=0))
    clamped_k = max(1, min(k, distinct))

    kmeans = KMeans(n_clusters=clamped_k, n_init="auto", random_state=0)
    labels = kmeans.fit_predict(pixels)

    counts = np.bincount(labels, minlength=clamped_k)
    total = int(counts.sum())

    results = [
        ColourResult(
            hex=to_hex(centre),
            name=name_colour(centre),
            share=count / total,
        )
        for centre, count in zip(kmeans.cluster_centers_, counts)
    ]
    results.sort(key=lambda r: r.share, reverse=True)
    return results
