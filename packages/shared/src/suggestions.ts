import type { PublicClothingItem } from './items';

/**
 * FR8 / TC-10: one outfit the rule engine proposes, resolved for the client.
 *
 * A suggestion is COMPUTED, never persisted (ruling 5) — it becomes an
 * `Outfit` only when the user saves it through the existing `POST /outfits`.
 * That is why this type is not `PublicOutfit`: it has no id, and asking for
 * one would imply a row exists somewhere.
 *
 * `itemIds` and `items` are both present on purpose. `items` is what a client
 * renders AND what it saves from — the same `PublicClothingItem` the wardrobe
 * grid and the outfit detail screen already draw, so no new renderer is
 * needed. `itemIds` is the engine's unedited answer, kept so a client can see
 * that a gap exists; it is NOT the save payload. See the field comments.
 *
 * THEY ARE NOT PARALLEL ARRAYS. `items` is compacted and `itemIds` is not, so
 * `items` can be shorter and `items[i]` is not `itemIds[i]`. Read both field
 * comments below before indexing either.
 */
export interface PublicSuggestion {
  /**
   * EVERY item id the engine named, in the order it composed them (top,
   * bottom, shoes …) — the engine's unedited answer, INCLUDING ids that did
   * not resolve.
   *
   * NOT the save payload. Posting this to `POST /outfits` saves the outfit the
   * ENGINE proposed, which is not the outfit the user was shown whenever
   * `items` is shorter. Save from `items` — see its comment.
   *
   * The order is meaningful, and it is the ENGINE's, not MongoDB's. There is
   * no second query: the API resolves these against the documents it already
   * loaded and sent to the engine, which is what makes it structurally
   * impossible to hand back an item this request never sent. It maps over
   * `itemIds` rather than filtering the fetched list precisely so that Mongo's
   * index order cannot reassert itself.
   */
  itemIds: string[];
  /**
   * The resolved items, in `itemIds` order but COMPACTED: an id that does not
   * resolve is dropped, so `items` may be SHORTER than `itemIds` and
   * `items[i]` does NOT in general correspond to `itemIds[i]`.
   *
   * RENDER FROM `items`, ALWAYS — every element is a whole item that carries
   * its own `id`. NEVER index `itemIds` in parallel with it: the moment one
   * id fails to resolve, every later pairing is off by one and the screen
   * shows the wrong garment under the wrong id. Read an id from `item.id`, not
   * from `itemIds[i]`.
   *
   * An id fails to resolve when it is not in the wardrobe this request sent —
   * an id the engine invented, one belonging to another user, or one the
   * caller had put in the wash. Unreachable today, because every id the engine
   * sees came from that same set, but a screen that 500s on one stale
   * reference is worse than one that renders the rest, so the gap is reported
   * rather than papered over. `GET /outfits/:id` applies the same tolerance.
   *
   * `itemIds` is deliberately NOT compacted to match: it stays the engine's
   * full answer so a client can see that a gap exists. That also means posting
   * `itemIds` to `POST /outfits` saves the outfit the ENGINE proposed, which —
   * when `items` is shorter — is not the outfit the user was shown. A client
   * that wants to save only what it displayed must post `items.map((i) => i.id)`.
   */
  items: PublicClothingItem[];
  /** 0..1, rounded by the engine. Higher is a stronger colour match. */
  score: number;
  /**
   * Plain-language names of the rules that fired, e.g.
   * "navy shirt and beige trousers — top with bottom, neutral pairing".
   *
   * Carried through to the client rather than kept server-side: a suggestion
   * that cannot say why it was made is indistinguishable from a random pair
   * of garments, which is exactly what TC-10 claims it is not.
   */
  rationale: string;
}

/** The body of `GET /suggestions`. */
export interface PublicSuggestions {
  suggestions: PublicSuggestion[];
  /**
   * How many of the caller's items were withheld from the engine because
   * they are in the wash (ruling 3).
   *
   * Always present, including as 0.
   *
   * READ THE COUNT'S SCOPE BEFORE WORDING ANYTHING FROM IT. This is every
   * in-laundry item in the wardrobe — NOT the number of suggestions that were
   * withheld. The two differ: one shirt plus three in-laundry accessories
   * yields `suggestions: []` with `excludedInLaundry: 3`, and none of those
   * three could have produced a suggestion, because there was no bottom to
   * pair with. So a UI may say "3 items are in the laundry" and must NEVER say
   * or imply "3 suggestions were hidden" — that asserts a causation this
   * number does not carry. It exists so a thin result can be given CONTEXT,
   * not an explanation, instead of reading as a broken feature. Suggestions are the SYSTEM
   * choosing, and a system that proposes a garment sitting in the wash is
   * unhelpful; that is a different act from Stage 6's composer, which must
   * still SHOW in-laundry items because there the user is choosing.
   */
  excludedInLaundry: number;
  /**
   * How many of the caller's items were withheld from the engine because they
   * are retired (`PublicClothingItem.retired`).
   *
   * Always present, including as 0. The same scope warning as
   * `excludedInLaundry` applies verbatim: this is every retired item in the
   * wardrobe, NOT the number of suggestions that were withheld — the two can
   * diverge for the identical reason (an excluded item might never have paired
   * with anything anyway). Kept as its OWN count rather than merged into
   * `excludedInLaundry`, because a wardrobe can have items excluded for both
   * reasons and a merged number could not be un-added into "how many were in
   * the wash" versus "how many were retired" — two different, unrelated
   * actions a user might take in response.
   */
  excludedRetired: number;
  /**
   * Parameters this API accepted and did not act on. Present only when the
   * caller actually sent one, so the documented `{ suggestions,
   * excludedInLaundry }` shape is unchanged for everyone else.
   *
   * Today the only member is `occasion`: spec §3.2 declares it on the
   * interface, and no item in this system carries occasion data, so any
   * occasion rule would have to be invented from nothing. Accepting it and
   * saying nothing would leave a caller who sent `occasion=formal` unable to
   * learn that nothing in the ranking was affected by it — the AI service
   * discloses the same fact at its own layer for the same reason.
   */
  ignored?: string[];
}

/**
 * `?limit=` bounds for `GET /suggestions`.
 *
 * These MUST NOT exceed the AI service's own `MAX_SUGGESTION_LIMIT`
 * (`services/ai/app/suggest.py`), which rejects a larger limit with 422 —
 * which this API would then have to report as a 503, i.e. a permanent failure
 * dressed as an outage. The default is small because a suggestion list is a
 * shortlist the user reads, not a page they scroll.
 */
export const DEFAULT_SUGGESTION_LIMIT = 5;
export const MAX_SUGGESTION_LIMIT = 50;
