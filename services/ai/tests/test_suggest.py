import colorsys
import inspect

import pytest
from fastapi.testclient import TestClient

import app.classifier as classifier_module
import app.main as main_module
from app.classifier import CATEGORY_PROMPTS
from app.colour import NAMED_COLOURS, to_hex
from app.main import app
from app.suggest import (
    ANALOGOUS_MAX_DEGREES,
    ANALOGOUS_SCORE,
    COMPLEMENTARY_MAX_DEGREES,
    COMPLEMENTARY_MIN_DEGREES,
    COMPLEMENTARY_SCORE,
    DEFAULT_SUGGESTION_LIMIT,
    NEUTRAL_SCORE,
    SCORE_DECIMALS,
    SINGLE_ITEM_SCORE,
    UNMATCHED_SCORE,
    KNOWN_CATEGORIES,
    MAX_ITEMS_PER_SLOT,
    MAX_SUGGESTION_LIMIT,
    SEASONS,
    SLOT_CATEGORIES,
    Colour,
    Item,
    suggest,
)

client = TestClient(app)


# --- Builders ----------------------------------------------------------------


def _hex_at_hue(degrees: float) -> str:
    """A fully saturated, fully bright colour at `degrees` on the hue circle.

    Used instead of hand-picked hex literals so a test that says "40 degrees
    apart" is provably 40 degrees apart rather than approximately so. The
    8-bit round trip is not lossless -- 41 degrees comes back as 40.941 --
    which is exactly why the boundary tests below use 40/41 and 149/150 and
    not, say, 40.5.
    """
    r, g, b = colorsys.hsv_to_rgb((degrees % 360) / 360.0, 1.0, 1.0)
    return to_hex((r * 255, g * 255, b * 255))


def _colour(name: str, hue: float | None = None, hex_value: str | None = None, share: float = 1.0) -> Colour:
    """A colour named `name`. With no hue and no hex, the palette anchor for
    `name` is used, so `_colour("white")` really is white."""
    if hex_value is None:
        hex_value = _hex_at_hue(hue) if hue is not None else to_hex(NAMED_COLOURS[name])
    return Colour(hex=hex_value, name=name, share=share)


def _item(item_id: str, category: str, colours=(), seasons=()) -> Item:
    return Item(id=item_id, category=category, colours=tuple(colours), seasons=tuple(seasons))


def _mixed_wardrobe() -> list[Item]:
    """A wardrobe that exercises every slot and every colour relation, with
    ids deliberately NOT in the order the items are listed."""
    return [
        _item("m-shirt", "shirt", [_colour("white")], ("summer",)),
        _item("a-tshirt", "tshirt", [_colour("red", 0)]),
        _item("z-trousers", "trousers", [_colour("navy", 220)], ("summer", "winter")),
        _item("c-shorts", "shorts", [_colour("orange", 30)], ("summer",)),
        _item("k-skirt", "skirt", [_colour("yellow", 90)]),
        _item("b-dress", "dress", [_colour("green", 140)], ("spring",)),
        _item("y-shoes", "shoes", [_colour("black")]),
        _item("d-jacket", "jacket", [_colour("grey")], ("winter",)),
        _item("f-accessory", "accessory", [_colour("beige")]),
        _item("e-other", "other", [_colour("purple", 315)]),
    ]


def _categories_by_id(items):
    return {item.id: item.category for item in items}


# --- Category pairing --------------------------------------------------------


def test_pairs_a_top_with_a_bottom():
    suggestions = suggest(
        [
            _item("b1", "trousers", [_colour("navy", 220)]),
            _item("t1", "shirt", [_colour("white")]),
        ]
    )

    assert [s.item_ids for s in suggestions] == [("t1", "b1")]


def test_a_dress_is_a_complete_outfit_without_a_bottom():
    suggestions = suggest([_item("d1", "dress", [_colour("red", 0)])])

    assert [s.item_ids for s in suggestions] == [("d1",)]


def test_never_returns_two_items_from_the_same_required_slot():
    items = [
        _item("b1", "trousers", [_colour("navy", 220)]),
        _item("b2", "shorts", [_colour("black")]),
        _item("t1", "shirt", [_colour("white")]),
        _item("t2", "tshirt", [_colour("grey")]),
    ]
    categories = _categories_by_id(items)

    suggestions = suggest(items, limit=MAX_SUGGESTION_LIMIT)

    assert len(suggestions) == 4
    for suggestion in suggestions:
        assert len(set(suggestion.item_ids)) == len(suggestion.item_ids)
        chosen = [categories[i] for i in suggestion.item_ids]
        for slot in ("top", "bottom", "dress"):
            occupants = [c for c in chosen if c in SLOT_CATEGORIES[slot]]
            assert len(occupants) <= 1, (slot, chosen)


def test_other_never_satisfies_a_required_slot():
    """`other` is the classifier's fallback bucket. If it could stand in for a
    top, one unclassifiable photo would masquerade as a shirt."""
    with_a_bottom = suggest(
        [
            _item("o1", "other", [_colour("white")]),
            _item("b1", "trousers", [_colour("navy", 220)]),
        ]
    )
    with_a_top = suggest(
        [
            _item("o1", "other", [_colour("white")]),
            _item("t1", "shirt", [_colour("white")]),
        ]
    )

    assert with_a_bottom == []
    assert with_a_top == []


def test_every_category_belongs_to_exactly_one_slot():
    """The slot table is the category vocabulary. A category in two slots would
    let one item fill a required slot AND an optional one in the same outfit;
    a category in none would be silently unwearable."""
    placements = [c for categories in SLOT_CATEGORIES.values() for c in categories]

    assert len(placements) == len(set(placements))
    assert KNOWN_CATEGORIES == tuple(sorted(CATEGORY_PROMPTS))


# --- Season ------------------------------------------------------------------


def test_an_item_with_no_seasons_is_eligible_in_every_season():
    """Absence means "unspecified", not "never". Backwards, this makes a fresh
    wardrobe suggest nothing -- which is exactly when a user first tries it."""
    items = [
        _item("t1", "shirt", [_colour("white")]),
        _item("b1", "trousers", [_colour("navy", 220)]),
    ]

    for season in SEASONS:
        assert [s.item_ids for s in suggest(items, season=season)] == [("t1", "b1")], season


def test_filters_to_the_requested_season():
    items = [
        _item("t-sum", "shirt", [_colour("white")], ("summer",)),
        _item("b-sum", "shorts", [_colour("navy", 220)], ("summer",)),
        _item("t-win", "tshirt", [_colour("black")], ("winter",)),
        _item("b-win", "trousers", [_colour("grey")], ("winter",)),
    ]

    summer = suggest(items, season="summer", limit=MAX_SUGGESTION_LIMIT)
    winter = suggest(items, season="winter", limit=MAX_SUGGESTION_LIMIT)
    unfiltered = suggest(items, limit=MAX_SUGGESTION_LIMIT)

    assert [s.item_ids for s in summer] == [("t-sum", "b-sum")]
    assert [s.item_ids for s in winter] == [("t-win", "b-win")]
    assert len(unfiltered) == 4


# --- Colour compatibility ----------------------------------------------------


def test_neutral_colours_pair_with_anything():
    suggestions = suggest(
        [
            _item("t1", "shirt", [_colour("white")]),
            _item("b1", "trousers", [_colour("yellow", 90)]),
        ]
    )

    assert suggestions[0].score == 0.7
    assert "neutral pairing" in suggestions[0].rationale


def test_a_hue_relation_outranks_a_neutral():
    """A neutral is not a match, it is the absence of a conflict -- black goes
    with everything, which is exactly why it says nothing about THIS pairing.
    Scoring it at the maximum put 373 of 757 candidate outfits from a seeded
    200-item wardrobe into one tie, so `limit=50` returned fifty outfits
    ordered alphabetically by id and called them the best."""
    neutral = suggest(
        [
            _item("t1", "shirt", [_colour("white")]),
            _item("b1", "trousers", [_colour("red", 0)]),
        ]
    )
    analogous = suggest(
        [
            _item("t1", "shirt", [_colour("red", 0)]),
            _item("b1", "trousers", [_colour("orange", 30)]),
        ]
    )

    assert analogous[0].score > neutral[0].score


def test_the_score_table_is_the_documented_one():
    """Literal values, so any of them moving is a failure rather than merely a
    different number."""
    assert (ANALOGOUS_SCORE, COMPLEMENTARY_SCORE) == (1.0, 1.0)
    assert NEUTRAL_SCORE == 0.7
    assert SINGLE_ITEM_SCORE == 0.5
    assert UNMATCHED_SCORE == 0.35
    assert UNMATCHED_SCORE < SINGLE_ITEM_SCORE < NEUTRAL_SCORE < ANALOGOUS_SCORE
    assert (DEFAULT_SUGGESTION_LIMIT, MAX_SUGGESTION_LIMIT, SCORE_DECIMALS) == (5, 50, 3)


def test_analogous_hues_score_above_clashing_ones():
    analogous = suggest(
        [
            _item("t1", "shirt", [_colour("red", 0)]),
            _item("b1", "trousers", [_colour("orange", 30)]),
        ]
    )
    clashing = suggest(
        [
            _item("t1", "shirt", [_colour("red", 0)]),
            _item("b1", "trousers", [_colour("yellow", 90)]),
        ]
    )

    assert analogous[0].score > clashing[0].score
    assert "analogous colours" in analogous[0].rationale
    assert "analogous colours" not in clashing[0].rationale


def test_complementary_hues_score_above_clashing_ones():
    complementary = suggest(
        [
            _item("t1", "shirt", [_colour("red", 0)]),
            _item("b1", "trousers", [_colour("blue", 180)]),
        ]
    )
    clashing = suggest(
        [
            _item("t1", "shirt", [_colour("red", 0)]),
            _item("b1", "trousers", [_colour("yellow", 90)]),
        ]
    )

    assert complementary[0].score > clashing[0].score
    assert "complementary colours" in complementary[0].rationale
    assert "complementary colours" not in clashing[0].rationale


def test_the_named_hue_bands_are_the_documented_ones():
    """Analogous is "within 40 degrees" and complementary is "150-210 degrees
    apart". Spelled out here as literals so widening a band is a test failure
    and not merely a different number."""
    assert ANALOGOUS_MAX_DEGREES == 40.0
    assert (COMPLEMENTARY_MIN_DEGREES, COMPLEMENTARY_MAX_DEGREES) == (150.0, 210.0)


@pytest.mark.parametrize(
    "hue, relation",
    [
        (40, "analogous colours"),
        (41, "no colour rule matched"),
        (149, "no colour rule matched"),
        (150, "complementary colours"),
        (210, "complementary colours"),
        (211, "no colour rule matched"),
        # Wrap-around. Every case above is measured against red at hue 0 where
        # the raw difference and the shorter arc agree, so none of them can
        # tell whether the arc is being normalised at all. These two can.
        (320, "analogous colours"),
        (359, "analogous colours"),
    ],
)
def test_the_hue_bands_hold_at_their_boundaries(hue, relation):
    """Pins all four band edges with literal hues -- deriving them from the
    constants would move the test whenever the constant moved, which is
    exactly the case it is meant to catch. (150 and 210 are the same edge
    seen from either side: separation is measured on the shorter arc.)"""
    suggestions = suggest(
        [
            _item("t1", "shirt", [_colour("red", 0)]),
            _item("b1", "trousers", [_colour("green", hue)]),
        ]
    )

    assert relation in suggestions[0].rationale


def test_the_dominant_colour_is_the_one_with_the_largest_share():
    """A patterned garment carries several clusters. The rules must reason
    about the biggest one, not whichever the caller listed first."""
    patterned = _item(
        "t1", "shirt", [_colour("yellow", 90, share=0.3), _colour("white", share=0.7)]
    )

    suggestions = suggest([patterned, _item("b1", "trousers", [_colour("red", 0)])])

    assert suggestions[0].score == 0.7
    assert "white shirt" in suggestions[0].rationale


def test_still_returns_a_best_option_when_every_pair_clashes():
    """Six garments, all nine top/bottom pairs outside every named relation.
    Returning nothing is the one outcome a user reads as "broken"."""
    items = [
        _item("t1", "shirt", [_colour("red", 0)]),
        _item("t2", "tshirt", [_colour("orange", 45)]),
        _item("t3", "shirt", [_colour("yellow", 90)]),
        _item("b1", "trousers", [_colour("green", 135)]),
        _item("b2", "skirt", [_colour("green", 140)]),
        _item("b3", "shorts", [_colour("purple", 315)]),
    ]

    suggestions = suggest(items, limit=MAX_SUGGESTION_LIMIT)

    assert len(suggestions) == 9
    assert all(0.0 < s.score < 0.5 for s in suggestions)
    assert "no colour rule matched" in suggestions[0].rationale


def test_a_colour_name_outside_the_palette_falls_back_to_the_hex():
    """The `name` a caller sends is trusted only when it is one of colour.py's
    own names. Anything else is re-derived from the hex, so a client that
    invents a label cannot invent a colour relation with it."""
    suggestions = suggest(
        [
            _item("t1", "shirt", [_colour("cerulean", hex_value="#ffffff")]),
            _item("b1", "trousers", [_colour("yellow", 90)]),
        ]
    )

    assert suggestions[0].score == 0.7
    assert "neutral pairing" in suggestions[0].rationale
    assert "white shirt" in suggestions[0].rationale


def test_an_item_with_no_colours_is_still_wearable():
    suggestions = suggest(
        [
            _item("t1", "shirt"),
            _item("b1", "trousers", [_colour("navy", 220)]),
        ]
    )

    assert [s.item_ids for s in suggestions] == [("t1", "b1")]
    assert "no colour rule matched" in suggestions[0].rationale


def test_a_malformed_hex_is_treated_as_absent_colour_rather_than_raising():
    """`suggest()` is the public library interface the spec names and has no
    error channel to a user, so one bad field on one garment must not fail the
    whole wardrobe. The ENDPOINT is where a malformed hex becomes a 422."""
    suggestions = suggest(
        [
            _item("t1", "shirt", [_colour("white", hex_value="#fff")]),
            _item("b1", "trousers", [_colour("navy", 220)]),
        ]
    )

    assert [s.item_ids for s in suggestions] == [("t1", "b1")]
    assert suggestions[0].score == 0.35
    # No colour word before "shirt": the hex is the ground truth and the name
    # is a label for it, so an unreadable hex takes the label with it.
    assert suggestions[0].rationale.startswith("shirt and navy trousers — ")


def test_equal_shares_resolve_to_the_colour_the_item_lists_first():
    """A two-tone garment splits 0.50/0.50. Which half wins has to come from
    the item's own data and nothing else -- `_dominant`'s comment says so, so
    here is the case that would falsify it."""
    white_first = _item(
        "t1", "shirt", [_colour("white", share=0.5), _colour("yellow", 90, share=0.5)]
    )
    yellow_first = _item(
        "t1", "shirt", [_colour("yellow", 90, share=0.5), _colour("white", share=0.5)]
    )
    trousers = _item("b1", "trousers", [_colour("red", 0)])

    assert "white shirt" in suggest([white_first, trousers])[0].rationale
    assert "yellow shirt" in suggest([yellow_first, trousers])[0].rationale


# --- Optional slots ----------------------------------------------------------


def test_shoes_are_added_when_the_wardrobe_has_any_even_if_they_clash():
    """A complete outfit includes shoes. These clash with both garments, so
    the only reason they go on is the rule that says they do -- and the score
    reports the clash rather than the outfit hiding it by going barefoot."""
    suggestions = suggest(
        [
            _item("t1", "shirt", [_colour("red", 0)]),
            _item("b1", "trousers", [_colour("orange", 30)]),
            _item("s1", "shoes", [_colour("yellow", 90)]),
        ]
    )

    assert [s.item_ids for s in suggestions] == [("t1", "b1", "s1")]
    # (1.0 analogous + 0.35 + 0.35) / 3, rounded to SCORE_DECIMALS=3. Spelled
    # out to the third decimal so rounding to fewer places is a failure.
    assert suggestions[0].score == 0.567


def test_a_compatible_extra_is_added_and_a_clashing_one_is_not():
    base = [
        _item("t1", "shirt", [_colour("red", 0)]),
        _item("b1", "trousers", [_colour("orange", 30)]),
    ]

    compatible = suggest(base + [_item("x1", "accessory", [_colour("red", 15)])])
    clashing = suggest(base + [_item("x1", "accessory", [_colour("yellow", 90)])])

    assert [s.item_ids for s in compatible] == [("t1", "b1", "x1")]
    assert [s.item_ids for s in clashing] == [("t1", "b1")]


def test_optional_slots_are_filled_in_the_declared_order():
    """`_compose` claims each optional slot is judged against everything
    already chosen, shoes first. This accessory matches the SHOES and nothing
    else, so it earns its place only if the shoes were placed before it --
    reverse the declared order and it is declined."""
    suggestions = suggest(
        [
            _item("t1", "shirt", [_colour("red", 0)]),
            _item("b1", "trousers", [_colour("red", 20)]),
            _item("s1", "shoes", [_colour("yellow", 90)]),
            _item("x1", "accessory", [_colour("yellow", 100)]),
        ]
    )

    assert [s.item_ids for s in suggestions] == [("t1", "b1", "s1", "x1")]


def test_an_optional_slot_declines_a_garment_that_made_no_seasonal_claim():
    """The season rule applied to a slot that has to earn its place -- not a
    new rule family. Absent-means-eligible protects whether an outfit EXISTS,
    which the required slots alone decide; an addition that never claimed the
    season has no such claim on the outfit. Before this, 50 of 50 suggestions
    from a seeded 200-item summer request carried a jacket that had never said
    it was for summer."""
    base = [
        _item("t1", "shirt", [_colour("white")], ("summer",)),
        _item("b1", "trousers", [_colour("black")], ("summer",)),
    ]
    unstated = _item("j0", "jacket", [_colour("grey")])
    summery = _item("j1", "jacket", [_colour("grey")], ("summer",))

    assert suggest(base + [unstated], season="summer")[0].item_ids == ("t1", "b1")
    assert suggest(base + [summery], season="summer")[0].item_ids == ("t1", "b1", "j1")
    assert suggest(base + [unstated, summery], season="summer")[0].item_ids == ("t1", "b1", "j1")
    # Nothing was asked, so there was nothing to claim.
    assert suggest(base + [unstated])[0].item_ids == ("t1", "b1", "j0")


def test_a_required_slot_still_accepts_a_garment_with_no_seasonal_claim():
    """The other half of the pair above: the gate must not leak into the slots
    that decide whether an outfit exists at all."""
    items = [
        _item("t1", "shirt", [_colour("white")]),
        _item("b1", "trousers", [_colour("black")]),
        _item("s1", "shoes", [_colour("beige")]),
    ]

    assert suggest(items, season="summer")[0].item_ids == ("t1", "b1", "s1")


# --- Rationale ---------------------------------------------------------------


def test_rationale_names_the_rules_that_fired():
    stated = suggest(
        [
            _item("t1", "shirt", [_colour("white")], ("summer",)),
            _item("b1", "trousers", [_colour("navy", 220)], ("summer",)),
        ],
        season="summer",
    )
    unstated = suggest(
        [
            _item("t1", "shirt", [_colour("white")]),
            _item("b1", "trousers", [_colour("navy", 220)]),
        ],
        season="summer",
    )

    assert stated[0].rationale == "white shirt and navy trousers — top with bottom, neutral pairing, all summer"
    assert unstated[0].rationale == "white shirt and navy trousers — top with bottom, neutral pairing, suitable for summer"


def test_relations_are_named_in_a_fixed_order():
    """Two relations fire here. The order they read in is RELATION_ORDER's,
    not the order the pairs happened to be scored in, so the same set of
    relations always produces the same sentence."""
    suggestions = suggest(
        [
            _item("t1", "shirt", [_colour("red", 0)]),
            _item("b1", "trousers", [_colour("red", 20)]),
            _item("s1", "shoes", [_colour("white")]),
        ]
    )

    assert suggestions[0].rationale == (
        "red shirt, red trousers and white shoes"
        " — top with bottom, neutral pairing, analogous colours"
    )


def test_rationale_omits_the_season_clause_when_no_season_was_requested():
    suggestions = suggest(
        [
            _item("d1", "dress", [_colour("green", 140)], ("spring",)),
        ]
    )

    assert suggestions[0].rationale == "green dress — a dress as a one-piece"


# --- Scoring, ordering, limit ------------------------------------------------


def test_scores_are_between_zero_and_one():
    suggestions = suggest(_mixed_wardrobe(), limit=MAX_SUGGESTION_LIMIT)

    # Two tops x three bottoms, plus the dress on its own.
    assert len(suggestions) == 7
    for suggestion in suggestions:
        assert 0.0 <= suggestion.score <= 1.0


def test_ranking_is_deterministic_across_two_identical_calls():
    items = _mixed_wardrobe()

    assert suggest(items, limit=10) == suggest(items, limit=10)


def test_ranking_is_independent_of_the_order_items_arrive_in():
    items = _mixed_wardrobe()

    assert suggest(items, limit=10) == suggest(list(reversed(items)), limit=10)


def test_ties_are_broken_on_item_id():
    """Every outfit here scores 1.0, so only the tie-break decides the order.
    The dress is generated AFTER the top/bottom pair and sorts BEFORE it, so
    generation order and id order genuinely disagree."""
    items = [
        _item("m-top", "shirt", [_colour("white")]),
        _item("n-bottom", "trousers", [_colour("black")]),
        _item("a-dress", "dress", [_colour("grey")]),
        _item("s-shoes", "shoes", [_colour("beige")]),
    ]

    suggestions = suggest(items, limit=MAX_SUGGESTION_LIMIT)

    assert [s.score for s in suggestions] == [0.7, 0.7]
    assert [s.item_ids for s in suggestions] == [
        ("a-dress", "s-shoes"),
        ("m-top", "n-bottom", "s-shoes"),
    ]


def test_higher_scoring_outfits_rank_first():
    items = [
        _item("t1", "shirt", [_colour("red", 0)]),
        _item("b-clash", "trousers", [_colour("yellow", 90)]),
        _item("b-near", "shorts", [_colour("orange", 30)]),
        _item("b-neutral", "skirt", [_colour("white")]),
    ]

    suggestions = suggest(items, limit=MAX_SUGGESTION_LIMIT)

    assert [s.item_ids for s in suggestions] == [
        ("t1", "b-near"),
        ("t1", "b-neutral"),
        ("t1", "b-clash"),
    ]
    assert [s.score for s in suggestions] == [1.0, 0.7, 0.35]


def test_a_lone_garment_ranks_below_a_matched_pair():
    """The score is a mean over PAIRS and so is not comparable across outfit
    sizes. A dress with nothing to pair against has had no rule fire on it at
    all, so it must not outrank two garments that genuinely match. It scored
    1.0 and did exactly that."""
    suggestions = suggest(
        [
            _item("t1", "shirt", [_colour("red", 0)]),
            _item("b1", "trousers", [_colour("orange", 30)]),
            _item("d1", "dress", [_colour("yellow", 90)]),
        ],
        limit=MAX_SUGGESTION_LIMIT,
    )

    assert [s.item_ids for s in suggestions] == [("t1", "b1"), ("d1",)]
    assert [s.score for s in suggestions] == [1.0, 0.5]


def test_a_duplicate_item_id_cannot_corrupt_another_pairs_score():
    """Two DISTINCT garments sharing an id. The pair-score cache must not hand
    (trousers, shoes) the result it computed for (shirt, shoes) -- that does
    not merely mis-score, it names a relation in the rationale that never
    fired on the garments the rationale names. The endpoint rejects duplicate
    ids; `suggest()` is the library interface and cannot rely on that.
    """
    suggestions = suggest(
        [
            _item("x", "shirt", [_colour("red", 0)]),
            _item("x", "trousers", [_colour("green", 120)]),
            _item("y", "shoes", [_colour("red", 0)]),
        ]
    )

    assert suggestions[0].item_ids == ("x", "x", "y")
    # shirt/shoes analogous (1.0); shirt/trousers and trousers/shoes clash.
    assert suggestions[0].score == 0.567
    assert "analogous colours" in suggestions[0].rationale


def test_returns_nothing_when_the_wardrobe_cannot_form_an_outfit():
    assert suggest([]) == []
    assert suggest([_item("s1", "shoes", [_colour("black")])]) == []
    assert suggest([_item("t1", "shirt", [_colour("white")])]) == []
    assert suggest([_item("b1", "trousers", [_colour("navy", 220)])]) == []


def test_respects_the_limit():
    items = [
        _item(f"t{i}", "shirt", [_colour("white")]) for i in range(3)
    ] + [_item(f"b{i}", "trousers", [_colour("black")]) for i in range(3)]

    assert len(suggest(items, limit=MAX_SUGGESTION_LIMIT)) == 9
    assert len(suggest(items, limit=2)) == 2
    assert len(suggest(items)) == DEFAULT_SUGGESTION_LIMIT
    assert suggest(items, limit=0) == []


def test_a_slot_is_capped_so_a_large_wardrobe_cannot_hang_the_request():
    """The documented cap, and the documented drop: the lowest ids survive.

    The wardrobe arrives in DESCENDING id order, so which items survive the
    cap has to come from the ids rather than from the caller's ordering --
    otherwise two clients holding the same wardrobe get different suggestions.
    """
    tops = [
        _item(f"t{i:03d}", "shirt", [_colour("white")]) for i in range(MAX_ITEMS_PER_SLOT + 20)
    ]
    wardrobe = list(reversed(tops)) + [_item("b000", "trousers", [_colour("black")])]
    suggestions = suggest(wardrobe, limit=10_000)

    assert len(suggestions) == MAX_ITEMS_PER_SLOT
    assert {s.item_ids[0] for s in suggestions} == {f"t{i:03d}" for i in range(MAX_ITEMS_PER_SLOT)}


def test_occasion_is_accepted_and_deliberately_ignored():
    """TC-10 names colour, category and season -- not occasion, and no item in
    this system carries occasion data. The parameter exists because the spec's
    interface declares it; inventing a rule for it would be a preference
    dressed as a rule."""
    items = _mixed_wardrobe()

    assert suggest(items, occasion="formal", limit=10) == suggest(items, limit=10)
    assert suggest(items, occasion="casual", limit=10) == suggest(items, limit=10)


# --- Endpoint ----------------------------------------------------------------


def _body(**overrides) -> dict:
    body = {
        "items": [
            {"id": "t1", "category": "shirt", "colours": [{"hex": "#ffffff", "name": "white"}], "seasons": ["summer"]},
            {"id": "b1", "category": "trousers", "colours": [{"hex": "#000080", "name": "navy"}], "seasons": []},
        ],
    }
    body.update(overrides)
    return body


def test_endpoint_returns_the_documented_shape():
    response = client.post("/suggest", json=_body(season="summer", limit=3))

    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {"suggestions"}
    assert len(payload["suggestions"]) == 1
    suggestion = payload["suggestions"][0]
    assert set(suggestion) == {"itemIds", "score", "rationale"}
    assert suggestion["itemIds"] == ["t1", "b1"]
    assert 0.0 <= suggestion["score"] <= 1.0
    assert isinstance(suggestion["rationale"], str) and suggestion["rationale"]


def test_endpoint_matches_calling_suggest_directly():
    response = client.post("/suggest", json=_body(season="summer", limit=3))

    direct = suggest(
        [
            Item("t1", "shirt", (Colour("#ffffff", "white"),), ("summer",)),
            Item("b1", "trousers", (Colour("#000080", "navy"),), ()),
        ],
        season="summer",
        limit=3,
    )

    assert response.json()["suggestions"] == [
        {"itemIds": list(s.item_ids), "score": s.score, "rationale": s.rationale} for s in direct
    ]


def test_endpoint_defaults_the_limit_and_the_season():
    response = client.post("/suggest", json=_body())

    assert response.status_code == 200
    assert len(response.json()["suggestions"]) == 1


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"items": "not-a-list"},
        {"items": [{"category": "shirt"}]},
        {"items": [{"id": "t1"}]},
        {"items": [{"id": "t1", "category": "hat"}]},
        {"items": [{"id": "", "category": "shirt"}]},
        {"items": [{"id": "t1", "category": "shirt", "colours": [{"hex": "not-a-hex", "name": "white"}]}]},
        {"items": [{"id": "t1", "category": "shirt", "colours": [{"hex": "#ffffff"}]}]},
        {"items": [{"id": "t1", "category": "shirt", "seasons": ["monsoon"]}]},
        {"items": [], "season": "monsoon"},
        {"items": [], "limit": 0},
        {"items": [], "limit": 51},
        {
            "items": [
                {"id": "t1", "category": "shirt"},
                {"id": "t1", "category": "trousers"},
            ]
        },
        {"items": [], "limit": "five"},
    ],
)
def test_endpoint_rejects_a_malformed_body_with_422(body):
    assert client.post("/suggest", json=body).status_code == 422


def test_endpoint_accepts_a_wardrobe_that_yields_nothing():
    response = client.post("/suggest", json={"items": []})

    assert response.status_code == 200
    assert response.json() == {"suggestions": []}


def test_endpoint_does_not_load_the_classifier_model():
    """/suggest is pure arithmetic. A model load here would put a 3-5s cold
    start in front of a request that needs none of it."""
    classifier_module._classifier_bundle = None

    response = client.post("/suggest", json=_body())

    assert response.status_code == 200
    assert classifier_module._classifier_bundle is None
    assert client.get("/health").json()["model_loaded"] is False


def test_endpoint_accepts_an_occasion_ignores_it_and_says_so():
    """Accepted-and-inert is the right answer, but silence about it is not: a
    caller sending `occasion=formal` and getting a 200 would otherwise have no
    way to learn that nothing in the ranking was affected by it. Ruling 3
    requires the in-laundry exclusion be stated in the response for exactly
    this reason."""
    with_occasion = client.post("/suggest", json=_body(occasion="formal"))
    without = client.post("/suggest", json=_body())

    assert with_occasion.status_code == 200
    assert with_occasion.json()["suggestions"] == without.json()["suggestions"]
    assert with_occasion.json()["ignored"] == ["occasion"]
    assert "ignored" not in without.json()


def test_the_engine_does_not_filter_on_laundry_status_itself():
    """Stage 7's ruling 3 excludes in-laundry garments from suggestions, and
    the CALLER does that: laundry state lives in Mongo and is not part of this
    request shape at all.

    Pinned here rather than left as a comment, because "the other side does
    it" is the kind of claim nobody can falsify by running something. What is
    actually true is this: an unknown field is ignored rather than rejected,
    so a caller may post its whole item record -- and an in-laundry garment it
    forgot to filter out WILL be suggested.
    """
    response = client.post(
        "/suggest",
        json={
            "items": [
                {
                    "id": "t1",
                    "category": "shirt",
                    "colours": [{"hex": "#ffffff", "name": "white"}],
                    "laundryStatus": "in_laundry",
                },
                {
                    "id": "b1",
                    "category": "trousers",
                    "colours": [{"hex": "#000080", "name": "navy"}],
                    "laundryStatus": "in_laundry",
                },
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["suggestions"][0]["itemIds"] == ["t1", "b1"]


def test_the_endpoint_is_synchronous_so_fastapi_threadpools_it():
    """The claim in suggest_outfits' docstring, pinned. FastAPI runs a
    non-coroutine endpoint body in a worker thread; an `async def` body doing
    the same arithmetic would run it on the event loop and stall /health for
    its duration -- measured at 264ms for a 1,000-item wardrobe, which the
    5-second compose healthcheck would eventually notice under load.
    """
    assert not inspect.iscoroutinefunction(main_module.suggest_outfits)
