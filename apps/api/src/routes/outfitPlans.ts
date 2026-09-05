import { Router } from 'express';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { MAX_OCCASION_LENGTH, type PublicOutfitPlan } from '@wardrobe/shared';
import type { Config } from '../config';
import { ApiError } from '../http/errors';
import { parseBody } from '../http/validate';
import { requireAuth } from '../auth/requireAuth';
import { Outfit, type OutfitDoc } from '../models/Outfit';
import { OutfitPlan, toPublicOutfitPlan, type OutfitPlanDoc } from '../models/OutfitPlan';

// Trim BEFORE the bound, the same way `POST /wear-history` treats an occasion:
// 64 characters of padding is a 60-character occasion the user asked for.
const occasionSchema = z.string().trim().max(MAX_OCCASION_LENGTH);

const createSchema = z.object({
  outfitId: z.string(),
  // Accepted as a raw string and parsed below rather than coerced by zod, so
  // that "unparseable" and "in the past" produce the same shaped error every
  // other field on this route produces — identical treatment to `wornAt`.
  plannedFor: z.string(),
  occasion: occasionSchema.optional(),
});

/**
 * The one rejection this route gives for an `outfitId` it will not accept.
 *
 * An unknown id, a foreign one and a malformed one all land here with a
 * byte-identical body — the same reasoning as `unknownOutfit` in
 * `wearHistory.ts`: distinguishing them would confirm through the response
 * alone that an outfit exists at an id the caller has no business knowing
 * about. A 400 rather than a 404 because `outfitId` is a field of the request
 * body, not the resource being addressed.
 */
function unknownOutfit(): ApiError {
  return new ApiError(400, 'VALIDATION_FAILED', 'Unknown outfit', [
    { path: 'outfitId', message: 'That outfit could not be found' },
  ]);
}

/**
 * Load the caller's outfit for a plan, or throw that one rejection.
 *
 * Its own copy rather than an import, matching the precedent already set in
 * this codebase: `routes/outfits.ts` and `routes/wearHistory.ts` each keep an
 * independent `findOwnedOutfit`, because each owns its own not-found contract
 * (a 404 there, a 400 here) and sharing one would mean a helper that has to
 * take its own error as a parameter.
 */
async function findOwnedOutfit(rawId: string, userId: string): Promise<OutfitDoc> {
  if (!mongoose.isValidObjectId(rawId)) {
    throw unknownOutfit();
  }
  const doc = (await Outfit.findOne({
    // Canonicalised before the query: an ObjectId's hex form is
    // case-insensitive, so the caller's casing must never be what a query
    // keys on.
    _id: new Types.ObjectId(rawId),
    userId,
  })) as OutfitDoc | null;
  if (!doc) {
    throw unknownOutfit();
  }
  return doc;
}

/**
 * Resolve the `plannedFor` a request is asking for.
 *
 * THE EXACT MIRROR of `resolveWornAt` (`routes/wearHistory.ts`), and the
 * symmetry is the point: that function rejects the future because a wear that
 * has not happened is not a wear; this rejects the PAST because a plan for a
 * day already gone is not a plan. Both compare against a `now` taken after the
 * request landed, and both do so strictly, so an instant equal to `now` is
 * accepted as describing the present rather than either direction.
 *
 * There is deliberately no skew tolerance, for the reason `resolveWornAt`
 * gives at length: a window would have to be a number nobody can justify and
 * would still be wrong for a client whose clock is further out than it.
 *
 * WHAT THE COMPARISON IS AGAINST, and why a client must send local noon: this
 * compares instants, not days. A client that sends local MIDNIGHT for "today"
 * is sending an instant that is already several hours in the past, and would
 * be rejected for planning today. Local noon is the value that is unambiguous
 * on the day it names, which is what `PublicOutfitPlan.plannedFor` tells the
 * client to send.
 *
 * Exported for its unit test only. Nothing else should call it.
 */
export function resolvePlannedFor(raw: string, now: Date): Date {
  const parsed = new Date(raw);
  // An invalid Date is not an error in JS — it is a Date whose time is NaN.
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Malformed plannedFor', [
      { path: 'plannedFor', message: 'Expected an ISO 8601 date-time' },
    ]);
  }
  if (parsed.getTime() < now.getTime()) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'plannedFor cannot be in the past', [
      { path: 'plannedFor', message: 'A day that has already passed cannot be planned' },
    ]);
  }
  return parsed;
}

/** The one 404 `DELETE /outfit-plans/:id` returns. */
function planNotFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Plan not found');
}

/**
 * One end of the `?from=`/`?to=` range, or the 400 that says what was wrong.
 *
 * Required rather than defaulted: this endpoint is deliberately unpaginated
 * (see the route), and a missing bound would make it an unbounded read of
 * every plan the user has ever made.
 */
function parseRangeBound(raw: unknown, path: 'from' | 'to'): Date {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ApiError(400, 'VALIDATION_FAILED', `Missing ${path}`, [
      { path, message: 'Expected an ISO 8601 date-time' },
    ]);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, 'VALIDATION_FAILED', `Malformed ${path}`, [
      { path, message: 'Expected an ISO 8601 date-time' },
    ]);
  }
  return parsed;
}

export function createOutfitPlansRouter(config: Config): Router {
  const router = Router();

  /**
   * Plan an outfit for a future day.
   *
   * NOTHING IS FANNED OUT. Unlike `POST /wear-history`, this touches no
   * `ClothingItem`: a plan is not a wear, so no `wearCount` moves and no
   * `lastWornAt` is stamped. That is the entire reason plans are a separate
   * collection — see `PublicOutfitPlan`'s header.
   */
  router.post('/', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const body = parseBody(createSchema, req.body);

    // One `now` for the whole request, so nothing in it can disagree by the
    // millisecond between two `new Date()` calls.
    const now = new Date();
    const plannedFor = resolvePlannedFor(body.plannedFor, now);
    const occasion = body.occasion?.trim() ? body.occasion.trim() : undefined;

    // Ownership is verified before anything is written, so a rejected request
    // leaves nothing behind.
    const outfit = await findOwnedOutfit(body.outfitId, userId);

    const doc = (await OutfitPlan.create({
      userId,
      outfitId: outfit._id,
      // The composition AT THIS MOMENT, snapshotted onto the plan.
      itemIds: outfit.itemIds,
      plannedFor,
      ...(occasion ? { occasion } : {}),
    })) as OutfitPlanDoc;

    // `outfit.name` rather than a re-read: it was just loaded, and this is the
    // one path guaranteed to still have it.
    const plan: PublicOutfitPlan = toPublicOutfitPlan(doc, outfit.name);
    res.status(201).json({ plan });
  });

  /**
   * The plans inside one date range — what the calendar's visible month reads.
   *
   * DELIBERATELY UNPAGINATED, and that is a property of the question rather
   * than an omission: the caller names a bounded range (a month), so the
   * result is naturally small, and there is nothing to scroll. The same
   * reasoning `GET /suggestions` uses for having no cursor. The bounds are
   * REQUIRED, which is what keeps "unpaginated" from meaning "unbounded".
   *
   * Sorted ascending — soonest first. A plan queue reads forwards; only a log
   * reads backwards.
   */
  router.get('/', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const from = parseRangeBound(req.query.from, 'from');
    const to = parseRangeBound(req.query.to, 'to');
    if (to.getTime() < from.getTime()) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Range ends before it starts', [
        { path: 'to', message: 'to must not be earlier than from' },
      ]);
    }

    // Ownership comes from the verified token, never from a query parameter.
    const docs = (await OutfitPlan.find({
      userId,
      plannedFor: { $gte: from, $lte: to },
    }).sort({ plannedFor: 1, _id: 1 })) as OutfitPlanDoc[];

    const names = await outfitNames(docs, userId);
    const plans = docs.map((doc) =>
      toPublicOutfitPlan(doc, names.get(doc.outfitId.toHexString())),
    );

    res.json({ plans });
  });

  /**
   * Cancel a plan.
   *
   * `userId` is part of the delete filter rather than a check before it, so a
   * foreign plan is never deleted and never distinguished from one that does
   * not exist. Deliberately NOT idempotent-silent, matching
   * `DELETE /outfits/:id`: a 204 for an id that never existed hides a client
   * bug with nothing to signal it.
   */
  router.delete('/:id', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const rawId = req.params.id;
    if (!mongoose.isValidObjectId(rawId)) {
      throw planNotFound();
    }

    const result = await OutfitPlan.deleteOne({
      _id: new Types.ObjectId(String(rawId)),
      userId,
    });
    if (result.deletedCount === 0) {
      throw planNotFound();
    }

    res.status(204).end();
  });

  return router;
}

/**
 * Resolve the names of the outfits a set of plans refers to.
 *
 * One query for the whole range rather than one per row, and distinct ids
 * only. A missing entry is not an error: an outfit can be deleted after it was
 * planned, and the plan survives it — the same tolerance `outfitNames` in
 * `wearHistory.ts` has, and for the same reason.
 *
 * `userId` is in the query for the same reason it is in every other read here:
 * a second query is a second place to forget the scope, and this one would
 * leak another user's outfit NAME through a plan that happens to reference it.
 */
async function outfitNames(
  docs: OutfitPlanDoc[],
  userId: string,
): Promise<Map<string, string>> {
  const ids = [...new Set(docs.map((doc) => doc.outfitId.toHexString()))];
  if (ids.length === 0) return new Map();

  const outfits = (await Outfit.find({ _id: { $in: ids }, userId }).select('name')) as OutfitDoc[];

  const names = new Map<string, string>();
  for (const outfit of outfits) {
    // Only real names go in the map — an outfit with no name and one that no
    // longer exists both mean "no name to show".
    if (outfit.name) names.set(outfit._id.toHexString(), outfit.name);
  }
  return names;
}
