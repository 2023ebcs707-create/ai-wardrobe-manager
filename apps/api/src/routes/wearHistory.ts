import { Router } from 'express';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { MAX_OCCASION_LENGTH, type PublicWearEvent } from '@wardrobe/shared';
import type { Config } from '../config';
import { ApiError } from '../http/errors';
import { parseBody } from '../http/validate';
import { requireAuth } from '../auth/requireAuth';
import { ClothingItem } from '../models/ClothingItem';
import { Outfit, type OutfitDoc } from '../models/Outfit';
import { WearHistory, toPublicWearEvent, type WearHistoryDoc } from '../models/WearHistory';
import { encodeCursor, decodeCursor, parseLimit } from './pagination';

// Trim BEFORE the bound, the same way `POST /outfits` treats a name: an
// occasion padded with whitespace to 64 characters is a 60-character occasion
// the user asked for, not an over-long one.
const occasionSchema = z.string().trim().max(MAX_OCCASION_LENGTH);

const createSchema = z.object({
  outfitId: z.string(),
  // Accepted as a raw string and parsed below rather than coerced by zod, so
  // that "unparseable" and "in the future" produce the same shaped error every
  // other field on this route produces.
  wornAt: z.string().optional(),
  occasion: occasionSchema.optional(),
});

/**
 * The one rejection `POST /wear-history` gives for an outfitId it will not
 * accept.
 *
 * An unknown id, a foreign one and a malformed one all land here with a byte
 * identical body, deliberately. Distinguishing them would confirm through the
 * response alone that an outfit exists at an id the caller has no business
 * knowing about — the same reasoning behind this codebase's 404-rather-than-403
 * rule for a foreign resource, and behind `resolveOwnedItems` refusing to say
 * whether an item is missing or merely someone else's.
 *
 * It is a 400 rather than a 404 because `outfitId` is a field of the request
 * body, not the resource being addressed: the route being asked for exists.
 */
function unknownOutfit(): ApiError {
  return new ApiError(400, 'VALIDATION_FAILED', 'Unknown outfit', [
    { path: 'outfitId', message: 'That outfit could not be found' },
  ]);
}

/**
 * Load the caller's outfit for a wear, or throw that one rejection.
 *
 * Ownership is part of the QUERY rather than a check afterwards, so "belongs
 * to someone else" and "does not exist at all" take the same code path and
 * cannot drift apart. The shape check has to happen first: a malformed id can
 * never match a document, and without it Mongoose rejects with a CastError, so
 * a client typo would read as a 500.
 */
async function findOwnedOutfit(rawId: string, userId: string): Promise<OutfitDoc> {
  if (!mongoose.isValidObjectId(rawId)) {
    throw unknownOutfit();
  }
  const doc = (await Outfit.findOne({
    // Canonicalised before the query, for the reason `resolveOwnedItems`
    // documents: an ObjectId's hex form is case-insensitive, so the caller's
    // casing must never be what a query keys on.
    _id: new Types.ObjectId(rawId),
    userId,
  })) as OutfitDoc | null;
  if (!doc) {
    throw unknownOutfit();
  }
  return doc;
}

/**
 * Resolve the `wornAt` a request is asking for, defaulting to now.
 *
 * Back-dating is ordinary use — a user logs yesterday's outfit this morning —
 * so a past date is accepted without limit. A FUTURE date is not: a wear that
 * has not happened yet is not a wear, and because `wornAt` is both the list's
 * sort key and the source of `lastWornAt`, one future row would take permanent
 * possession of the top of the history and of "most recently worn" on every
 * item in the outfit.
 *
 * There is deliberately no skew tolerance. A window would have to be a number
 * nobody can justify, and it would still be wrong for a client whose clock is
 * further out than the window — the honest fix for a skewed client is to omit
 * `wornAt` and let the server date it. That is stated as a request rule on
 * `PublicWearEvent.wornAt` in `@wardrobe/shared`, where the client author will
 * read it, rather than only here.
 *
 * The comparison is STRICTLY `>`, so `wornAt === now` is accepted: a request
 * that names this exact instant is describing the present, not the future.
 * The distinction is unobservable over HTTP — `now` is taken after the request
 * lands, so a client's timestamp is always at least transit time in the past —
 * which is precisely why this function is exported and unit-tested directly.
 * `wearHistory.test.ts` pins both sides of the boundary; over HTTP alone,
 * relaxing `>` to `>=` passes every integration test there is.
 *
 * Exported for that test only. Nothing else should call it.
 */
export function resolveWornAt(raw: string | undefined, now: Date): Date {
  if (raw === undefined) return now;

  const parsed = new Date(raw);
  // An invalid Date is not an error in JS — it is a Date whose time is NaN.
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Malformed wornAt', [
      { path: 'wornAt', message: 'Expected an ISO 8601 date-time' },
    ]);
  }
  if (parsed.getTime() > now.getTime()) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'wornAt cannot be in the future', [
      { path: 'wornAt', message: 'A wear that has not happened yet cannot be logged' },
    ]);
  }
  return parsed;
}

export function createWearHistoryRouter(config: Config): Router {
  const router = Router();

  /**
   * FR6/TC-08: log that an outfit was worn.
   *
   * This is the only writer of `ClothingItem.wearCount` and
   * `ClothingItem.lastWornAt` in the system. Those fields have been declared
   * since Stage 2 and written by nothing, which is why every item currently
   * reports zero wears; the fan-out below is what makes them real, and it is
   * what the "most/least worn items" analytics claim rests on.
   */
  router.post('/', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const body = parseBody(createSchema, req.body);

    // One `now` for the whole request, so the future check and the default
    // cannot disagree by the millisecond between two `new Date()` calls.
    const now = new Date();
    const wornAt = resolveWornAt(body.wornAt, now);
    // Blank stores absent rather than as '', so "no occasion" is one state
    // rather than two that render differently — the same treatment
    // `Outfit.name` gets.
    const occasion = body.occasion?.trim() ? body.occasion.trim() : undefined;

    // Ownership is verified before anything is written, so a rejected request
    // leaves nothing behind — no event and no incremented counter.
    const outfit = await findOwnedOutfit(body.outfitId, userId);

    // The composition AT THIS MOMENT, snapshotted onto the event. Read once
    // here and used for both the row and the fan-out, so the items counted are
    // exactly the items recorded. See PublicWearEvent.itemIds for why the
    // event must not read this back through the outfit later.
    const itemIds = outfit.itemIds;

    // The event is written FIRST, and the fan-out second. This database is a
    // standalone mongod, so there is no transaction to make the pair atomic
    // and one of the two orders has to be chosen deliberately. The event is
    // the record of truth FR6 asks for; the counters are a denormalisation of
    // it (ruling 4). A crash between the two therefore leaves a wear that is
    // logged but not yet counted — recoverable by replaying the log — rather
    // than counters that moved for a wear no row can explain.
    const doc = (await WearHistory.create({
      userId,
      outfitId: outfit._id,
      itemIds,
      wornAt,
      ...(occasion ? { occasion } : {}),
    })) as WearHistoryDoc;

    // THE FAN-OUT. One `updateMany`, not a loop: a loop would be N round trips
    // and would leave the wardrobe half-updated if it threw in the middle.
    //
    // `userId` in this filter is a SECURITY BOUNDARY, not hygiene. Without it,
    // `{ _id: { $in: itemIds } }` increments whatever ids happen to be in that
    // array, and an outfit row that references a foreign item — reachable by a
    // crafted write, and cheap to reach if any future path relaxes composition
    // — would let one user move counters and dates on another user's wardrobe.
    // This is the same shape as `resolveOwnedItems`: nobody omits the check
    // outright, they write the `$in` and forget the scope.
    //
    // `$inc`, not `$set`: a set would make every item's count 1 forever, and
    // "most worn" would rank nothing.
    //
    // `$max`, not `$set`, for `lastWornAt`: the field means "the date of the
    // most recent wear", not "the date on the most recently typed row". Since
    // back-dating is ordinary use, a `$set` would let logging Monday's outfit
    // on Wednesday overwrite an already-recorded Tuesday and make the item
    // report a last wear that is not its latest. `$max` also sets the field
    // when it is missing, which is every item before its first wear.
    //
    // The one thing `$max` costs, considered and accepted: it makes
    // `lastWornAt` monotonic, so a date mistyped too far forward (but still in
    // the past, or this write would have been rejected) can never be corrected
    // downward through any endpoint. That is a wash rather than a regression —
    // `wearCount` is equally unrepairable, since no endpoint deletes or edits a
    // wear event — and a repair path, if one is ever wanted, has to recompute
    // both fields from the log rather than patch either in place.
    const fanOut = await ClothingItem.updateMany(
      { _id: { $in: itemIds }, userId },
      { $inc: { wearCount: 1 }, $max: { lastWornAt: wornAt } },
    );

    // A fan-out that matched fewer items than the event snapshotted is a
    // DATA-INTEGRITY divergence, and it is otherwise completely silent: it
    // throws nothing, still answers 201, and leaves the unmatched items
    // under-reporting their wear count for good, which is the number Task 2's
    // "most/least worn" ranks on.
    //
    // A mismatch is now ORDINARY rather than impossible: `DELETE /items/:id`
    // removes a garment without touching the outfits that reference it, so an
    // outfit worn after one of its items was deleted snapshots more ids than
    // the fan-out can match. `resolveOwnedItems` still guarantees the ids were
    // owned and distinct when the outfit was composed, so a mismatch means a
    // deleted item (expected) or a direct database write (not) -- and the line
    // below is what tells the two apart after the fact.
    //
    // Logged rather than thrown, deliberately. The event is written and the
    // wear DID happen; failing the request now would tell the client to retry,
    // and a retry writes a SECOND event and increments a second time. The log
    // line carries the event id so the row can be replayed by hand.
    //
    // `console.error`, not `warn`: this is the same "something is wrong with
    // the data, not the request" severity as `errorHandler`'s unhandled-error
    // line, and it is the stream this project's tests already assert on.
    if (fanOut.matchedCount !== itemIds.length) {
      console.error(
        `Partial wear fan-out: event ${String(doc._id)} snapshotted ${itemIds.length} item(s) ` +
          `but matched ${fanOut.matchedCount}. Wear counts for the unmatched items are now low.`,
      );
    }

    // `outfit.name` rather than a re-read: it was just loaded, and this is the
    // one path that is guaranteed to still have it.
    const event: PublicWearEvent = toPublicWearEvent(doc, outfit.name);
    res.status(201).json({ event });
  });

  /**
   * FR6: the history list Task 5 renders on the Profile tab.
   *
   * Limit, cursor and tiebreaker semantics are identical to `GET /items` and
   * `GET /outfits` — deliberately, because a client that learns paging from
   * one list and applies it to another must not mis-page. The one difference
   * is the sort KEY: `wornAt`, not `createdAt`, because a back-dated entry
   * belongs where it happened rather than where it was typed.
   */
  router.get('/', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const limit = parseLimit(req.query.limit);

    // Ownership comes from the verified token, never from a query parameter.
    const filter: Record<string, unknown> = { userId };

    const rawCursor = req.query.cursor;
    if (rawCursor !== undefined) {
      if (typeof rawCursor !== 'string') {
        throw new ApiError(400, 'VALIDATION_FAILED', 'Malformed cursor', [
          { path: 'cursor', message: 'Expected a string' },
        ]);
      }
      const cursor = decodeCursor(rawCursor);
      // A bad cursor is an error, not a silent restart from page 1: restarting
      // makes an infinite scroll loop forever with no signal.
      if (!cursor) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'Malformed cursor', [
          { path: 'cursor', message: 'Cursor could not be decoded' },
        ]);
      }
      // `cursor.createdAt` is the shared helper's name for "the sort key's
      // value"; here that value is a `wornAt`. The cursor is opaque to clients
      // precisely so the two lists can key on different fields.
      const from = cursor.createdAt;
      // Strictly "older than the cursor", with _id breaking ties inside the
      // same millisecond. Both branches are required: the first alone loses
      // same-ms siblings, the second alone matches nothing across timestamps.
      filter.$or = [
        { wornAt: { $lt: from } },
        { wornAt: from, _id: { $lt: new Types.ObjectId(cursor.id) } },
      ];
    }

    // limit + 1 tells us whether another page exists without a second query.
    const docs = (await WearHistory.find(filter)
      .sort({ wornAt: -1, _id: -1 })
      .limit(limit + 1)) as WearHistoryDoc[];

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    const names = await outfitNames(page, userId);

    const events = page.map((doc) => toPublicWearEvent(doc, names.get(doc.outfitId.toHexString())));

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.wornAt, String(last._id)) : undefined;

    res.json({ events, ...(nextCursor ? { nextCursor } : {}) });
  });

  return router;
}

/**
 * Resolve the names of the outfits a page of events refers to.
 *
 * One query for the whole page rather than one per row, and distinct ids only:
 * wearing the same outfit five times is the normal case, not an edge one.
 *
 * A missing entry is not an error. Ruling 3: deleting an outfit does not
 * un-happen a wear, so history rows outlive their outfits and this map is
 * simply short — the event then renders from its own snapshotted `itemIds`
 * with no name. Throwing here would turn one deleted outfit into a 500 for the
 * whole history.
 *
 * `userId` is in the query for the same reason it is in every other read on
 * this route: a second query is a second place to forget the scope, and this
 * one would leak another user's outfit NAME through a history row that happens
 * to reference it.
 *
 * Both sides of the string-keyed lookup come from `ObjectId.toHexString()`,
 * which is canonical lowercase — an ObjectId's hex form is case-insensitive,
 * so a key taken from anything else could miss its own document.
 */
async function outfitNames(
  page: WearHistoryDoc[],
  userId: string,
): Promise<Map<string, string>> {
  const ids = [...new Set(page.map((doc) => doc.outfitId.toHexString()))];
  if (ids.length === 0) return new Map();

  const outfits = (await Outfit.find({ _id: { $in: ids }, userId }).select(
    'name',
  )) as OutfitDoc[];

  const names = new Map<string, string>();
  for (const outfit of outfits) {
    // Only real names go in the map. An outfit with no name and an outfit that
    // no longer exists both mean "no name to show", and collapsing them here
    // keeps the response shape from having two ways to say so.
    if (outfit.name) names.set(outfit._id.toHexString(), outfit.name);
  }
  return names;
}
