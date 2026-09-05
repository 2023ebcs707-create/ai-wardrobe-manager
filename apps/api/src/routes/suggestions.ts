import { Router } from 'express';
import mongoose, { Types } from 'mongoose';
import {
  DEFAULT_SUGGESTION_LIMIT,
  MAX_SUGGESTION_LIMIT,
  SEASONS,
  type ItemColor,
  type LaundryStatus,
  type PublicClothingItem,
  type PublicSuggestion,
  type PublicSuggestions,
  type Season,
} from '@wardrobe/shared';
import type { Config } from '../config';
import { ApiError } from '../http/errors';
import { requireAuth } from '../auth/requireAuth';
import { ClothingItem, type ClothingItemDoc } from '../models/ClothingItem';
import type { StorageProvider } from '../storage/StorageProvider';
import { requestSuggestions, type SuggestEngineItem } from '../ai/suggestClient';
import { parseLimit } from './pagination';
import { signItemUrls } from './signing';

/**
 * The one status this endpoint withholds from the engine.
 *
 * Annotated with the shared union rather than left as a bare string — the
 * same guard `GET /analytics/usage` puts on its own copy — so a typo here is
 * a compile error instead of a filter that silently never matches and an
 * `excludedInLaundry` that is silently always zero.
 */
const IN_LAUNDRY: LaundryStatus = 'in_laundry';

/**
 * The colour hex the AI service will accept, copied from its own
 * `SuggestColour.hex` pattern.
 *
 * `tagImage` validates that a colour's `hex` is a STRING and never that it is
 * `#rrggbb`, so a drifted AI response can persist 'navy' or '#fff' on a real
 * item. The engine validates the pattern and 422s the WHOLE wardrobe over one
 * bad field on one garment — which this API can then only report to the user
 * as "suggestions are unavailable". Dropping the colour instead degrades that
 * one item to "colour unknown", a state the engine already supports and tests
 * (an item with no colours at all), and leaves the rest of the wardrobe
 * working.
 */
const ENGINE_HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * `share` is `float | None` bounded to [0,1] on the engine's side too.
 *
 * The parameter is typed as the STORED shape, whose `share` is
 * `number | null | undefined` — mongoose models an explicitly-null path
 * differently from an absent one, and `ItemColor.share` cannot express null.
 * Sending `null` would fail the engine's `ge=0.0` bound on a field that means
 * "not measured", so both absences collapse to omitting the key.
 */
function engineColour(colour: { hex: string; name: string; share?: number | null }): ItemColor {
  const share = colour.share;
  const usable = typeof share === 'number' && Number.isFinite(share) && share >= 0 && share <= 1;
  return { hex: colour.hex, name: colour.name, ...(usable ? { share } : {}) };
}

/**
 * A stored item in the shape the engine reads.
 *
 * NOTE THE RENAME: Mongo stores `colors`, the Python service reads `colours`.
 * Getting that wrong is not an error anywhere — the engine treats a missing
 * key as "this garment has no colours", which is a supported case — it simply
 * turns off the only rule family that RANKS. The suggestions would still look
 * fine: same outfits, plausible scores, and a rationale reading "no colour
 * rule matched" that nobody would necessarily read. An integration test
 * asserts the rationale names a hue relation for exactly this reason.
 */
function toEngineItem(doc: ClothingItemDoc): SuggestEngineItem {
  return {
    id: doc._id.toHexString(),
    category: doc.category as PublicClothingItem['category'],
    colours: doc.colors.filter((c) => ENGINE_HEX.test(c.hex)).map(engineColour),
    seasons: doc.seasons as Season[],
  };
}

/**
 * `?season=`, or the 400 that says which values exist.
 *
 * The vocabulary is `SEASONS` from `@wardrobe/shared` — the same array that
 * guards `ClothingItem.seasons` and that the engine's own `SEASONS` is
 * documented to mirror. Never re-declared here: a fourth hand-written copy is
 * where a typo becomes a season the API accepts and the engine 422s.
 */
function parseSeason(raw: unknown): Season | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !SEASONS.includes(raw as Season)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Unknown season', [
      { path: 'season', message: `Expected one of ${SEASONS.join(', ')}` },
    ]);
  }
  return raw as Season;
}

/**
 * The longest `?occasion=` this API will forward.
 *
 * The engine accepts any string and ignores it, so nothing downstream bounds
 * this — which makes an unbounded query parameter a free way to put arbitrary
 * bytes into another service's request body. 64 characters is far more than
 * any word a UI would send.
 */
const MAX_OCCASION_LENGTH = 64;

function parseOccasion(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_OCCASION_LENGTH) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Malformed occasion', [
      { path: 'occasion', message: `Expected 1..${MAX_OCCASION_LENGTH} characters` },
    ]);
  }
  return raw;
}

/**
 * Canonicalise an id the engine echoed back, before it is compared as a
 * string.
 *
 * An ObjectId's hex form is CASE-INSENSITIVE, so '507F…' and '507f…' are the
 * same id. Stage 5 shipped a bug from exactly this: a map keyed on
 * `String(doc._id)` missed an uppercase request id and yielded `undefined`
 * where a document belonged. These ids are ones this route itself sent, so
 * today they come back in canonical form — but "the other service happens to
 * echo my exact bytes" is a guarantee nothing enforces, and the failure mode
 * is a suggestion with `itemIds` and no `items`: an outfit of nothing.
 *
 * Anything that is not a well-formed ObjectId is returned unchanged and will
 * simply fail to resolve, rather than throwing out of a constructor.
 */
function canonicalId(raw: string): string {
  return mongoose.isValidObjectId(raw) ? new Types.ObjectId(raw).toHexString() : raw;
}

export function createSuggestionsRouter(config: Config, storage: StorageProvider): Router {
  const router = Router();

  /**
   * FR8: "AI-generated outfit suggestions based on wardrobe data." TC-10.
   *
   * The engine lives in the Python AI service (ruling 2) and this route is
   * its only caller. What it owns, and the AI service deliberately does not:
   *
   *  1. THE OWNERSHIP SCOPE. Every item sent to the engine and every item
   *     signed on the way back comes from `find({ userId })`. A missing
   *     `userId` does not degrade the answer — it ships a stranger's wardrobe
   *     to another service and hands the caller working signed URLs for their
   *     photographs. Same shape as Stage 5's `resolveOwnedItems` and Stage
   *     6's fan-out `updateMany`; it has its own cross-user test.
   *  2. THE IN-LAUNDRY EXCLUSION (ruling 3). Laundry state lives in Mongo and
   *     is not part of the engine's request shape at all — `suggest.py` says
   *     so at its header rather than ignoring the field silently — so if this
   *     filter is lost, nothing anywhere complains and the app cheerfully
   *     proposes a garment sitting in the wash.
   *  3. THE FAILURE STORY. See `requestSuggestions`: 503, never an empty list.
   *
   * Nothing is written. A suggestion becomes an outfit only when the user
   * saves one through `POST /outfits`, which already validates ownership
   * (ruling 5) — so there is no new write path and no second security
   * boundary to keep in step with this one.
   */
  router.get('/', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // Same parser, same rejection-not-clamping behaviour and same error body
    // as every other list endpoint; different bounds, because a shortlist is
    // not a page. The maximum is shared with the engine's own limit ceiling —
    // see MAX_SUGGESTION_LIMIT.
    const limit = parseLimit(req.query.limit, DEFAULT_SUGGESTION_LIMIT, MAX_SUGGESTION_LIMIT);
    const season = parseSeason(req.query.season);
    const occasion = parseOccasion(req.query.occasion);

    // Ownership comes from the verified token, never from a query parameter.
    // The whole wardrobe, unpaginated: the engine ranks combinations, so it
    // needs the candidates, not a page of them. It applies its own per-slot
    // cap (MAX_ITEMS_PER_SLOT) to bound the combinatorics.
    const docs = (await ClothingItem.find({ userId })) as ClothingItemDoc[];

    // RULING 3, at the one line that implements it. Stage 6 ruled the
    // composer must SHOW in-laundry items, because hiding them removes a
    // choice the user is entitled to make. This is not that: a suggestion is
    // the SYSTEM choosing, and a system that proposes a garment sitting in
    // the wash is unhelpful. Filtering what the system proposes is a
    // different act from hiding what the user may pick.
    // A retired item is withheld for a different reason than an in-laundry
    // one and the two counts must stay independently readable (see
    // `PublicSuggestions.excludedRetired`), so each filter's own removals are
    // counted against the stage before it rather than against `docs` twice.
    const notRetired = docs.filter((doc) => !doc.retired);
    const excludedRetired = docs.length - notRetired.length;
    const wearable = notRetired.filter((doc) => doc.laundryStatus !== IN_LAUNDRY);
    // Derived from the same partition rather than counted separately, so the
    // number and the filter cannot disagree about what was withheld.
    const excludedInLaundry = notRetired.length - wearable.length;

    const result = await requestSuggestions(
      wearable.map(toEngineItem),
      { season, occasion, limit },
      config,
    );

    // Resolved from the documents already in hand, NOT re-queried. That saves
    // a round trip, and more importantly it makes it structurally impossible
    // to sign an item this request did not send: an id the engine invented,
    // or one belonging to someone else, resolves to nothing here because it
    // was never in `wearable`. Keyed off `wearable` rather than `docs` for
    // the same reason — the laundry exclusion holds on the way back as well
    // as on the way out.
    const byId = new Map(wearable.map((doc) => [doc._id.toHexString(), doc]));

    // Sign each DISTINCT item once. A limit of 50 suggestions over a small
    // wardrobe names the same handful of garments repeatedly, and signing is
    // per-key work that would otherwise be repeated ~150 times for a dozen
    // items.
    const wanted = new Set(
      result.suggestions.flatMap((s) => s.itemIds.map(canonicalId)).filter((id) => byId.has(id)),
    );
    const signed = new Map<string, PublicClothingItem>(
      await Promise.all(
        [...wanted].map(
          async (id) =>
            [id, await signItemUrls(storage, byId.get(id) as ClothingItemDoc)] as const,
        ),
      ),
    );

    const suggestions: PublicSuggestion[] = result.suggestions.map((suggestion) => {
      // The ENGINE's order, which is the outfit — top, bottom, shoes. Mongo
      // hands documents back in index order, so mapping over `itemIds` rather
      // than filtering the fetched list is what keeps "top with bottom" from
      // silently becoming "whatever was created first".
      const itemIds = suggestion.itemIds.map(canonicalId);
      return {
        itemIds,
        // Tolerant of an id that does not resolve, like `GET /outfits/:id`:
        // `items` may be shorter than `itemIds`, and both are returned so a
        // client can see the gap. Unreachable today — every id was sent from
        // `wearable` — but a screen that 500s on one stale reference is worse
        // than one that renders the rest.
        items: itemIds
          .map((id) => signed.get(id))
          .filter((item): item is PublicClothingItem => item !== undefined),
        score: suggestion.score,
        rationale: suggestion.rationale,
      };
    });

    const body: PublicSuggestions = {
      suggestions,
      excludedInLaundry,
      excludedRetired,
      // Passed through only when the engine actually disclosed something, so
      // a caller who sent no `occasion` sees the documented two-field shape
      // unchanged. See `PublicSuggestions.ignored` for why an inert parameter
      // is disclosed rather than silently dropped.
      ...(result.ignored ? { ignored: result.ignored } : {}),
    };
    res.json(body);
  });

  return router;
}
