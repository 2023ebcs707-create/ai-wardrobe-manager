"""Rule-based outfit suggestions: colour, category and season, and nothing else.

TC-10 names exactly three rule families, and this module implements exactly
those three. They are kept separable on purpose -- one can be changed without
touching the others, and each has its own test:

  * CATEGORY PAIRING decides *what may combine*. A declared table
    (`SLOT_CATEGORIES` + `OUTFIT_TEMPLATES`), never ad-hoc conditionals.
  * SEASON decides *what is eligible*. See `_in_season`.
  * COLOUR COMPATIBILITY *ranks* what remains. See `_pair_score`.

Deliberately NOT machine learning. Phase 3 states twice that ML
personalisation is not integrated and grades this module Partially
Implemented, so an embedding model or a learned ranker here would make the
submitted document less accurate rather than more. There are no learned
weights below, no training data, and no model: every number is a declared
constant and every decision is traceable to a named rule. That is also why
each suggestion carries a `rationale` -- a rule engine that cannot say which
rule fired is indistinguishable from an arbitrary one.

Nothing here loads the CLIP classifier or touches the network. `/suggest` is
pure arithmetic over data the caller already has, and must stay that way:
a model load would put a 3-5s cold start in front of a request that needs
none of it.

Not decided here, on purpose:
  * IN-LAUNDRY EXCLUSION. Stage 7's ruling 3 excludes in-laundry garments
    from suggestions, but laundry state lives in Mongo and never reaches this
    service -- the request shape carries no `laundryStatus`. The caller
    filters before calling and reports the exclusion in its own response.
    Duplicating the filter here would mean two places to get it wrong.
  * OCCASION. `suggest()` accepts it because the spec's interface declares
    it, and ignores it because no item in this system carries occasion data.
    Any occasion rule would have to be invented from nothing, and TC-10 does
    not name one. See the note on the parameter itself.
"""

import colorsys
import itertools
from typing import NamedTuple

from app.colour import NAMED_COLOURS, name_colour

# --- The data this engine reads ---------------------------------------------


class Colour(NamedTuple):
    hex: str
    name: str
    share: float = 0.0


class Item(NamedTuple):
    id: str
    category: str
    colours: tuple[Colour, ...] = ()
    seasons: tuple[str, ...] = ()


class Suggestion(NamedTuple):
    item_ids: tuple[str, ...]
    score: float
    rationale: str


# `suggest()` reads attributes rather than dict keys, so the request models in
# main.py are passed straight through with no conversion layer -- one fewer
# place for a field to be dropped in translation. `Item`/`Colour` above are
# the shape a direct caller (and every test) builds.


# --- Rule family 1: category pairing ----------------------------------------

# Which categories can occupy which slot of an outfit. This is the whole of
# the category rule: a declared table, so "can these two things be worn
# together" is answered by looking something up rather than by reading
# conditionals scattered through a scoring loop.
#
# Every category appears in exactly ONE slot. A category in two slots would
# let a single item fill a required slot and an optional one in the same
# outfit; a category in none would be silently unwearable. Tested.
#
# `other` sits in `extra`, never in `top` or `bottom`, and that placement is
# load-bearing: `other` is the bucket the classifier falls back to when it
# recognises nothing, so treating it as a top would let an unclassifiable
# photo masquerade as a shirt in a suggestion the system is claiming to have
# reasoned about.
SLOT_CATEGORIES: dict[str, tuple[str, ...]] = {
    "top": ("tshirt", "shirt"),
    "bottom": ("trousers", "shorts", "skirt"),
    "dress": ("dress",),
    "shoes": ("shoes",),
    "outerwear": ("jacket",),
    "extra": ("accessory", "other"),
}

# Keep in sync with ITEM_CATEGORIES in packages/shared/src/items.ts and with
# CATEGORY_PROMPTS in app/classifier.py -- the drift guard is a test.
KNOWN_CATEGORIES: tuple[str, ...] = tuple(
    sorted({c for categories in SLOT_CATEGORIES.values() for c in categories})
)

# Keep in sync with SEASONS in packages/shared/src/items.ts.
SEASONS: tuple[str, ...] = ("spring", "summer", "autumn", "winter")


class OutfitTemplate(NamedTuple):
    name: str
    #: Slots that MUST be filled, one item each. Because a slot contributes
    #: exactly one item, "never two items from the same required slot" is a
    #: property of the structure rather than a check that could be forgotten:
    #: two pairs of trousers is not an outfit.
    required: tuple[str, ...]
    #: Slots that MAY be filled -- see `_compose` for when they are.
    optional: tuple[str, ...]
    #: Plain-language name of the rule, for the rationale.
    description: str


OUTFIT_TEMPLATES: tuple[OutfitTemplate, ...] = (
    OutfitTemplate(
        name="top_and_bottom",
        required=("top", "bottom"),
        optional=("shoes", "outerwear", "extra"),
        description="top with bottom",
    ),
    OutfitTemplate(
        name="one_piece",
        required=("dress",),
        optional=("shoes", "outerwear", "extra"),
        description="a dress as a one-piece",
    ),
)

# Optional slots filled whether or not the best candidate is a colour match.
# A complete outfit includes shoes when the wardrobe has any (Stage 7 ruling
# 4's structural-validity definition says so in as many words), so the best
# available pair goes on even when it is the least bad of a clashing set --
# the score reports that honestly instead of the outfit hiding it by going
# barefoot. Every other optional slot must earn its place; see `_compose`.
ALWAYS_FILLED_SLOTS: tuple[str, ...] = ("shoes",)

# The optional slots that must EARN their place: every optional slot except
# the ones filled unconditionally. `_compose` already declines a candidate
# here that matches no colour relation, and `_pools` applies the same standard
# to the season rule -- see `_in_season`'s `unspecified_counts`.
GATED_OPTIONAL_SLOTS: tuple[str, ...] = tuple(
    slot
    for slot in dict.fromkeys(s for t in OUTFIT_TEMPLATES for s in t.optional)
    if slot not in ALWAYS_FILLED_SLOTS
)


# --- Rule family 2: season ---------------------------------------------------


def _in_season(item, season: str | None, unspecified_counts: bool = True) -> bool:
    """Is `item` eligible for `season`?

    An item with NO seasons is eligible in every season, which is what
    `unspecified_counts` defaults to. Absence means "unspecified", not
    "never": seasons are optional on every write path in this system, so the
    common case for a wardrobe someone has just started filling is that
    nothing has any. Read the other way round -- absent means ineligible -- a
    fresh wardrobe suggests nothing, which is precisely the moment a user
    first tries the feature and concludes it is broken.

    `unspecified_counts=False` is that SAME rule applied to a slot that has to
    earn its place, not a new rule family. The protection above is about
    whether an outfit EXISTS at all, and that is decided entirely by the
    required slots; an optional addition that has never claimed the season has
    no such claim on the outfit. Measured before this existed: 50 of 50
    suggestions from a seeded 200-item `season="summer"` request carried a
    jacket that had never said it was for summer -- 100% of the sample, not an
    edge case.

    `ALWAYS_FILLED_SLOTS` is exempt (see `GATED_OPTIONAL_SLOTS`): ruling 4
    makes shoes part of a complete outfit, so they do not earn their place and
    this predicate does not apply to them. Applying it there would strip shoes
    off every outfit in a fresh wardrobe, which is the same harm the default
    reading exists to prevent.
    """
    if season is None:
        return True
    if not item.seasons:
        return unspecified_counts
    return season in item.seasons


# --- Rule family 3: colour compatibility ------------------------------------

# Colours that go with anything. Judged by NAME, from colour.py's own fixed
# palette, because that is the vocabulary the rest of the system already
# speaks -- these four are the palette entries separated by value and
# saturation rather than by hue, which is exactly what makes them neutral.
NEUTRAL_COLOUR_NAMES = frozenset({"black", "white", "grey", "beige"})

# The two hue relations, in degrees on the hue circle.
#
# ANALOGOUS: hues within 40 degrees of each other.
# COMPLEMENTARY: hues 150-210 degrees apart. Separation below is measured on
# the SHORTER arc, so it never exceeds 180 -- "210 degrees apart" is the same
# pair of colours measured the other way round, and the band is therefore
# tested at 149/150 (its real edge) as well as at 180.
ANALOGOUS_MAX_DEGREES = 40.0
COMPLEMENTARY_MIN_DEGREES = 150.0
COMPLEMENTARY_MAX_DEGREES = 210.0

# Scores for each named relation.
#
# A HUE RELATION SCORES ABOVE A NEUTRAL, which is the reverse of this module's
# first draft, and the reason is a measurement rather than a taste. Black,
# white, grey and beige are 4 of colour.py's 13 names and real wardrobes are
# full of them, so scoring neutral at the maximum put 373 of the 757 candidate
# outfits from a seeded 200-item wardrobe into ONE tie at 1.0: a `limit=50`
# response was fifty outfits ordered alphabetically by item id and presented
# to the user as "the best". No style rule was operating at the top of the
# list at all, which is precisely what TC-10 claims about.
#
# The principle underneath: a neutral is not a match, it is the ABSENCE of a
# conflict. Black goes with everything, and that is exactly why it says
# nothing about THIS pairing -- whereas an analogous or complementary hue is a
# positive statement about these two garments. Ranking real relations first
# puts the outfits the engine actually has a reason for at the top.
#
# Analogous and complementary score the SAME on purpose. Both are deliberate,
# named relations; this engine has no basis for ranking one above the other,
# and inventing a difference would be a preference dressed up as a rule.
#
# UNMATCHED is what a pair scores when no named relation fires. It is LOW, not
# excluding: a wardrobe of clashing garments must still return its best
# option, because returning nothing is the one outcome a user reads as
# "broken". It is deliberately above zero so a clashing outfit is still
# ranked, and deliberately far below the named relations so any real match
# outranks it.
ANALOGOUS_SCORE = 1.0
COMPLEMENTARY_SCORE = 1.0
NEUTRAL_SCORE = 0.7
UNMATCHED_SCORE = 0.35

# An outfit of ONE garment -- a dress in a wardrobe with no shoes -- has no
# pair to score, so no rule has fired on it at all. It sits between a
# demonstrated clash and a demonstrated absence of conflict: better than a
# pair known to clash, worse than a pair known not to.
#
# It MUST stay below ANALOGOUS_SCORE. The score is a mean over pairs and so is
# not comparable across outfit sizes; a garment evaluated against nothing
# receiving the top score meant a lone dress outranked a genuine analogous
# pair, which it did when this constant was 1.0.
SINGLE_ITEM_SCORE = 0.5

# Reported scores are rounded, and the ranking sorts on the ROUNDED value, so
# the number a user sees and the order they see it in cannot disagree.
SCORE_DECIMALS = 3


def _rgb(hex_value: str) -> tuple[int, int, int] | None:
    """Parse '#rrggbb'. None when the string is not that.

    Deliberately does NOT raise. The endpoint rejects a malformed hex with a
    422 because it has a caller to tell; `suggest()` is also the public
    library interface the spec names, and it has no error channel to a user,
    so an unparseable hex becomes colour data that is not there -- exactly the
    state an item with no colours at all is already in, which is a supported
    and tested case. Raising would turn one bad field on one garment into a
    failed request for the whole wardrobe.
    """
    value = hex_value.lstrip("#")
    if len(value) != 6:
        return None
    try:
        return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
    except ValueError:
        return None


def _resolve(colour) -> tuple[str, float] | None:
    """The (name, hue-in-degrees) this engine will reason about.

    The caller's `name` is trusted only when it is one of colour.py's own
    names -- that is the palette this service produced in the first place, and
    it is the label the UI is showing beside the garment. Anything else is
    re-derived from the hex with colour.py's own namer, so a client that
    invents a label cannot invent a colour relation along with it.

    Hue always comes from the hex. It is the pixel value; the name is a label
    for it.
    """
    rgb = _rgb(colour.hex)
    if rgb is None:
        return None
    name = colour.name if colour.name in NAMED_COLOURS else name_colour(rgb)
    hue, _saturation, _value = colorsys.rgb_to_hsv(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)
    return name, hue * 360.0


def _dominant(item) -> tuple[str, float] | None:
    """The item's dominant colour, or None when it has no colours at all.

    `share` picks the dominant cluster and is used for nothing else: a
    patterned garment whose top cluster is 0.37 is treated exactly like a
    solid one whose top cluster is 1.00. Phase 3 already records reduced
    accuracy for multi-colour items under TC-05, and this engine does not
    pretend to compensate for it.
    """
    colours = tuple(item.colours or ())
    if not colours:
        return None
    # max() returns the first maximal element, so equal shares resolve to the
    # order the item itself lists its colours in -- the item's own data, not
    # anything about the wardrobe around it.
    return _resolve(max(colours, key=lambda c: c.share or 0.0))


def _hue_separation(first: float, second: float) -> float:
    """Degrees between two hues along the shorter arc: 0 to 180."""
    difference = abs(first - second) % 360.0
    return min(difference, 360.0 - difference)


def _pair_score(a, b, cache: dict) -> tuple[float, str | None]:
    """Compatibility of two garments' dominant colours, and which relation
    fired. Returns `UNMATCHED_SCORE` and no relation when none did."""
    # Keyed on OBJECT IDENTITY, not on the item id. Two DISTINCT garments
    # sharing an id string would otherwise collide -- and a collision here
    # does not merely mis-score, it hands back the other pair's relation, so
    # the rationale names a rule that never fired on the garments it names.
    # The endpoint now rejects duplicate ids outright, but this function is
    # the library interface and cannot rely on that. Every item stays alive in
    # the caller's list and in `pools` for the whole call, so no id() can be
    # recycled underneath the cache.
    key = (id(a), id(b)) if id(a) <= id(b) else (id(b), id(a))
    cached = cache.get(key)
    if cached is not None:
        return cached

    result = _relation(_dominant(a), _dominant(b))
    cache[key] = result
    return result


def _relation(first: tuple[str, float] | None, second: tuple[str, float] | None) -> tuple[float, str | None]:
    if first is None or second is None:
        # No colour data on one side. Nothing to match, so nothing is claimed.
        return UNMATCHED_SCORE, None

    (first_name, first_hue), (second_name, second_hue) = first, second

    if first_name in NEUTRAL_COLOUR_NAMES or second_name in NEUTRAL_COLOUR_NAMES:
        return NEUTRAL_SCORE, "neutral"

    separation = _hue_separation(first_hue, second_hue)
    if separation <= ANALOGOUS_MAX_DEGREES:
        return ANALOGOUS_SCORE, "analogous"
    if COMPLEMENTARY_MIN_DEGREES <= separation <= COMPLEMENTARY_MAX_DEGREES:
        return COMPLEMENTARY_SCORE, "complementary"

    # Nothing matched. Scored low, NOT excluded -- see UNMATCHED_SCORE.
    return UNMATCHED_SCORE, None


def _mean_pair_score(candidate, chosen: list, cache: dict) -> float:
    return sum(_pair_score(candidate, item, cache)[0] for item in chosen) / len(chosen)


def _outfit_score(items: list, cache: dict) -> tuple[float, tuple[str, ...]]:
    """Mean compatibility over every pair in the outfit, and the relations that
    fired. Every pair counts, so a jacket that clashes with the trousers costs
    the outfit exactly as much as a top that clashes with them."""
    pairs = list(itertools.combinations(items, 2))
    if not pairs:
        return SINGLE_ITEM_SCORE, ()

    scored = [_pair_score(a, b, cache) for a, b in pairs]
    mean = sum(score for score, _ in scored) / len(scored)
    return mean, tuple(relation for _, relation in scored if relation is not None)


# --- Rationale ---------------------------------------------------------------

CATEGORY_LABELS: dict[str, str] = {
    "tshirt": "t-shirt",
    "shirt": "shirt",
    "trousers": "trousers",
    "shorts": "shorts",
    "skirt": "skirt",
    "dress": "dress",
    "jacket": "jacket",
    "shoes": "shoes",
    "accessory": "accessory",
    # "other" is the classifier's fallback bucket; naming it "other item" in a
    # sentence a user reads is worse than naming it nothing in particular.
    "other": "item",
}

RELATION_PHRASES: dict[str, str] = {
    "neutral": "neutral pairing",
    "analogous": "analogous colours",
    "complementary": "complementary colours",
}
# Fixed order, so the same set of relations always reads the same way.
RELATION_ORDER: tuple[str, ...] = ("neutral", "analogous", "complementary")
NO_RELATION_PHRASE = "no colour rule matched"


def _describe(item) -> str:
    label = CATEGORY_LABELS.get(item.category, item.category)
    dominant = _dominant(item)
    return f"{dominant[0]} {label}" if dominant else label


def _join(phrases: list[str]) -> str:
    if len(phrases) == 1:
        return phrases[0]
    return f"{', '.join(phrases[:-1])} and {phrases[-1]}"


def _rationale(template: OutfitTemplate, items: list, relations: tuple[str, ...], season: str | None) -> str:
    """Name every rule that fired, in plain language.

    This is what makes the engine defensible rather than arbitrary: a user who
    disagrees with a suggestion can see which rule produced it, and so can a
    reviewer. A suggestion that cannot explain itself is indistinguishable
    from a random pair of garments.
    """
    clauses = [template.description]

    if len(items) > 1:
        fired = [RELATION_PHRASES[r] for r in RELATION_ORDER if r in relations]
        clauses.extend(fired or [NO_RELATION_PHRASE])

    if season is not None:
        # "all summer" is a stronger claim than "suitable for summer" and is
        # only made when every item actually says so. An item with no seasons
        # is eligible (see _in_season) but has not claimed anything.
        stated = all(season in (item.seasons or ()) for item in items)
        clauses.append(f"all {season}" if stated else f"suitable for {season}")

    return f"{_join([_describe(item) for item in items])} — {', '.join(clauses)}"


# --- Assembly ----------------------------------------------------------------

# The bound on work. After season filtering, each slot considers at most this
# many items, chosen as the lowest ids -- an arbitrary rule, but a stated and
# deterministic one, so the same wardrobe always drops the same garments.
#
# What this costs: a wardrobe with more than 40 eligible tops will never see
# the 41st in a suggestion. What it buys: at most 40 x 40 top/bottom pairs
# plus 40 dresses, so ~1,640 candidate outfits regardless of wardrobe size,
# which is what stops a 200-item wardrobe from turning a request into a hang.
MAX_ITEMS_PER_SLOT = 40

DEFAULT_SUGGESTION_LIMIT = 5
#: Bounds the response, not the engine. Enforced by the endpoint's validation.
MAX_SUGGESTION_LIMIT = 50


def _pools(items, season: str | None) -> dict[str, list]:
    """Season-eligible items per slot, ordered and capped.

    Sorted by id BEFORE the cap so that which items survive it depends on the
    wardrobe, not on the order the caller happened to list it in.
    """
    pools = {}
    for slot, categories in SLOT_CATEGORIES.items():
        eligible = [
            i
            for i in items
            if i.category in categories
            and _in_season(i, season, slot not in GATED_OPTIONAL_SLOTS)
        ]
        eligible.sort(key=lambda i: i.id)
        pools[slot] = eligible[:MAX_ITEMS_PER_SLOT]
    return pools


def _best_candidate(pool: list, chosen: list, cache: dict):
    """Highest-scoring item in `pool` against `chosen`. Ties break on item id."""
    if not pool:
        return None, 0.0
    best = min(pool, key=lambda c: (-_mean_pair_score(c, chosen, cache), c.id))
    return best, _mean_pair_score(best, chosen, cache)


def _compose(template: OutfitTemplate, base: tuple, pools: dict, season: str | None, cache: dict) -> Suggestion:
    """Fill `template`'s optional slots around a required-slot `base`.

    Slots are filled one at a time in the template's declared order, each
    against everything chosen so far -- so a jacket is judged against the
    shoes that were already added, not only against the top and bottom. Fixed
    order, so the result is reproducible.

    An optional slot outside `ALWAYS_FILLED_SLOTS` is filled only if its best
    candidate actually matches a named relation against what is already
    chosen. Adding a garment that clashes with everything, purely because the
    wardrobe contains one, makes the suggestion worse rather than fuller.
    """
    chosen = list(base)
    for slot in template.optional:
        candidate, score = _best_candidate(pools[slot], chosen, cache)
        if candidate is None:
            continue
        if slot not in ALWAYS_FILLED_SLOTS and score <= UNMATCHED_SCORE:
            continue
        chosen.append(candidate)

    score, relations = _outfit_score(chosen, cache)
    return Suggestion(
        item_ids=tuple(item.id for item in chosen),
        score=round(score, SCORE_DECIMALS),
        rationale=_rationale(template, chosen, relations, season),
    )


def suggest(items, season=None, occasion=None, limit=DEFAULT_SUGGESTION_LIMIT) -> list[Suggestion]:
    """Rank the outfits this wardrobe can form, best first.

    `occasion` is accepted and deliberately ignored. TC-10 names colour,
    category and season -- not occasion -- and no item in this system carries
    occasion data, so any rule keyed on it would be invented from nothing and
    would rank real garments by a fiction. The parameter exists because the
    spec's `POST /suggest` interface declares it; the absence is the honest
    implementation, and it is tested rather than merely asserted here.

    Returns at most `limit` suggestions, and an empty list when the wardrobe
    cannot form an outfit at all (no top-and-bottom pair and no dress). That
    is the ONLY reason this returns nothing: clashing colours never remove an
    outfit from the list, they only push it down it.
    """
    if limit <= 0:
        return []

    pools = _pools(items, season)
    cache: dict = {}

    ranked = [
        _compose(template, base, pools, season, cache)
        for template, base in _base_combinations(pools)
    ]

    # KNOWN LIMIT, measured, not argued: the top of this list contains a real
    # tie and it is ordered by item id.
    #
    # The score is a mean over three possible pair values, so means collide.
    # On a seeded 200-item wardrobe with a realistic half-neutral palette,
    # 33 of the 50 returned outfits share the leading score. Moving a hue
    # relation above a neutral (see the score table) is what makes this as
    # small as it is -- the previous ordering gave 3 distinct scores across
    # the whole candidate set and put all 50 in one tie at every wardrobe
    # composition tested. A second sort key on how many pairs matched was
    # built and measured: it moved 36 ties to 33, 8 to 7 and 14 to 14, which
    # does not earn a permanent mechanism, so it was removed again.
    #
    # Ranking further WITHIN a genuine tie needs to know which of two equally
    # valid outfits this particular user prefers, and nothing in this system
    # records that. That is personalisation, and Phase 3 states twice that it
    # is not integrated -- so the honest engine stops here and says so, rather
    # than inventing a preference and presenting it as a rule.
    #
    # Ties break on the item ids. Two outfits drawn from one wardrobe cannot
    # share an id tuple, so the ordering is total; and were a caller to send
    # duplicate ids, Python's sort is stable, so two identical calls would
    # still agree. Without the tie-break the order of equal-scoring outfits
    # falls back to the order they were generated in, which is an
    # implementation detail rather than a contract -- and a suggestion list
    # that reshuffles between two identical requests reads as broken however
    # good its contents are.
    ranked.sort(key=lambda s: (-s.score, s.item_ids))
    return ranked[:limit]


def _base_combinations(pools: dict):
    """Every filled combination of required slots, one item per slot."""
    for template in OUTFIT_TEMPLATES:
        required = [pools[slot] for slot in template.required]
        if not all(required):
            continue
        for base in itertools.product(*required):
            yield template, base
