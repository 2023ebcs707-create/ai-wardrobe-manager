import { Router } from 'express';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import {
  MAX_OUTFIT_ITEMS,
  MAX_OUTFIT_NAME_LENGTH,
  MIN_OUTFIT_ITEMS,
  type PublicClothingItem,
  type PublicOutfit,
  type PublicOutfitDetail,
} from '@wardrobe/shared';
import type { Config } from '../config';
import { ApiError } from '../http/errors';
import { parseBody } from '../http/validate';
import { requireAuth } from '../auth/requireAuth';
import { ClothingItem, type ClothingItemDoc } from '../models/ClothingItem';
import {
  Outfit,
  toPublicOutfit,
  toPublicOutfitDetail,
  type OutfitDoc,
} from '../models/Outfit';
import type { StorageProvider } from '../storage/StorageProvider';
import { encodeCursor, decodeCursor, parseLimit } from './pagination';
import { signItemUrls, SIGNED_URL_TTL_SECONDS } from './signing';

// The bounds live in `@wardrobe/shared` so that this route and the mobile
// composer that has to respect them cannot drift apart — see the comment on
// MAX_OUTFIT_ITEMS there. Aliased locally so the schemas below read as they
// always have.
const MIN_ITEMS = MIN_OUTFIT_ITEMS;
const MAX_ITEMS = MAX_OUTFIT_ITEMS;
const MAX_NAME_LENGTH = MAX_OUTFIT_NAME_LENGTH;

// Trim BEFORE the bound: a name padded with whitespace to 84 characters is
// an 80-character name the user asked for, not an over-long one.
const nameSchema = z.string().trim().max(MAX_NAME_LENGTH);
// One definition, used by both POST and PATCH. An edit that accepted more
// items than a create -- or fewer -- would be a bound that exists only until
// someone edits their way past it.
const itemIdsSchema = z.array(z.string()).min(MIN_ITEMS).max(MAX_ITEMS);

const createSchema = z.object({
  name: nameSchema.optional(),
  itemIds: itemIdsSchema,
});

/**
 * A patch is partial: `name`, `itemIds`, or both.
 *
 * Both keys are optional here and a body with neither is rejected in the
 * handler instead. Expressing "at least one" as a zod refinement would emit an
 * issue shape unlike every other error this file returns, for a rule that is
 * one line to state where it is actually enforced.
 */
const patchSchema = z.object({
  name: nameSchema.optional(),
  itemIds: itemIdsSchema.optional(),
});

/**
 * Blank names are stored absent rather than as ''.
 *
 * Otherwise "no name" has two representations that render differently, and a
 * user who clears a name gets an empty string where a placeholder belongs.
 */
function normaliseName(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the caller's items for a set of ids, in the order the ids were given.
 *
 * This is the security boundary of the whole outfits feature. `GET /outfits/:id`
 * returns signed URLs for an outfit's items, so if an outfit could reference
 * items the caller does not own, any authenticated user could compose an outfit
 * from another user's item ids and receive working links to their photographs.
 *
 * `userId` in the query is what closes that, and it is the part most easily
 * lost: `find({ _id: { $in: ids } })` looks correct, passes every test written
 * with one user's own items, and leaks everything.
 *
 * The rejection deliberately does not distinguish "no such item" from "not
 * your item" — the same reason this codebase returns 404 rather than 403 for a
 * foreign resource.
 */
async function resolveOwnedItems(
  ids: string[],
  userId: string,
  path: string,
): Promise<ClothingItemDoc[]> {
  const malformed = ids.find((id) => !mongoose.isValidObjectId(id));
  if (malformed !== undefined) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Unknown item', [
      { path, message: 'One or more items could not be found' },
    ]);
  }

  // Canonicalise before doing anything that compares ids as strings.
  //
  // An ObjectId's hex form is case-insensitive, so '507F...' and '507f...' are
  // the SAME id: both pass `isValidObjectId`, both cast to one ObjectId in a
  // `$in`, and mongoose stores the canonical lowercase form. Comparing the
  // caller's raw strings therefore gets two things wrong at once — a
  // case-variant duplicate slips past the `Set` and is then misreported as a
  // missing item, and a lookup keyed on `String(doc._id)` misses an uppercase
  // request id and yields `undefined` where a document belongs.
  const canonical = ids.map((id) => new Types.ObjectId(id).toHexString());

  const unique = new Set(canonical);
  // Rejected rather than deduped: a silent dedup means the outfit the client
  // saved differs from the one it sent, with nothing to tell it so.
  if (unique.size !== canonical.length) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Duplicate items', [
      { path, message: 'An outfit cannot contain the same item twice' },
    ]);
  }

  const docs = (await ClothingItem.find({
    _id: { $in: canonical },
    userId,
  })) as ClothingItemDoc[];

  // `$in` returns index order, not request order. Reapply the caller's order:
  // it is what the user composed and what every read path must reproduce.
  //
  // The per-id throw below is the ONLY ownership gate, deliberately. An
  // earlier draft also compared `docs.length` to `canonical.length` first;
  // that check was provably redundant — `$in` over distinct ids cannot return
  // more documents than ids, so a short result always leaves some id absent
  // from the map — and a mutation proved it: deleting the count check failed
  // no test, because this throw already covered every case it did. A guard
  // that cannot fail alone is not defence in depth, it is untestable weight.
  const byId = new Map(docs.map((doc) => [doc._id.toHexString(), doc]));
  return canonical.map((id) => {
    const doc = byId.get(id);
    if (!doc) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Unknown item', [
        { path, message: 'One or more items could not be found' },
      ]);
    }
    return doc;
  });
}

/**
 * The one 404 every `/outfits/:id` route returns.
 *
 * A foreign outfit and a malformed id produce an identical body, deliberately:
 * a 403 for someone else's outfit, or a distinct "malformed id" message,
 * would each confirm through the response alone that an outfit exists at an id
 * the caller has no business knowing about.
 */
function outfitNotFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Outfit not found');
}

/**
 * The `:id` every outfit route queries by, or that same 404.
 *
 * One predicate for all three routes, so they cannot drift on what counts as
 * a well-formed id -- the reason `GET /items/:id` and `PATCH /items/:id`
 * already share theirs. The shape check has to happen before the query: a
 * malformed id can never match a document, and without the check Mongoose
 * rejects with a CastError, so a client typo reads as a server failure.
 *
 * `raw` is `unknown` rather than `string` because Express 5 types a route
 * parameter as `string | string[]`. Narrowing it would be an unreachable
 * branch -- `/:id` cannot repeat -- so the shape check does that job instead:
 * anything that is not a well-formed ObjectId, of any type at all, is a 404.
 *
 * The result is canonical for the reason `resolveOwnedItems` documents: an
 * ObjectId's hex form is case-insensitive, so the caller's casing must never
 * be what a query keys on. Verified in this exact version of mongoose:
 * `isValidObjectId` is precisely "constructible" -- 'abcdefghijkl' and
 * 'not-an-object-id' both fail it and both throw from the constructor -- so
 * this cannot reject an id the guard accepted.
 */
function outfitObjectId(raw: unknown): Types.ObjectId {
  if (!mongoose.isValidObjectId(raw)) {
    throw outfitNotFound();
  }
  return new Types.ObjectId(String(raw));
}

/**
 * Load one of the caller's outfits, or throw that 404.
 *
 * Ownership is part of the query rather than a check afterwards, so "belongs
 * to someone else" and "does not exist at all" take the same code path --
 * the same reasoning `GET /items/:id` and `/auth/login` already apply.
 */
async function findOwnedOutfit(id: unknown, userId: string): Promise<OutfitDoc> {
  const doc = (await Outfit.findOne({
    _id: outfitObjectId(id),
    userId,
  })) as OutfitDoc | null;
  if (!doc) {
    throw outfitNotFound();
  }
  return doc;
}

export function createOutfitsRouter(config: Config, storage: StorageProvider): Router {
  const router = Router();

  /**
   * Sign the cover for one outfit: the first item's thumbnail, or its full
   * image when it has none.
   *
   * Returns undefined rather than throwing when the item cannot be resolved.
   * There is no cascade delete in this system, so that is only reachable by a
   * direct database deletion — but a gallery that 500s on one stale reference
   * is worse than one that shows a placeholder.
   */
  function signCover(item: ClothingItemDoc | null): Promise<string | undefined> {
    const key = item?.thumbnailKey ?? item?.imageKey;
    if (!key) return Promise.resolve(undefined);
    return storage.signUrl(key, SIGNED_URL_TTL_SECONDS);
  }

  /**
   * Cover for an outfit read back from the database, which carries ids only.
   *
   * The create path does NOT use this: it already holds the resolved items in
   * the caller's order, so re-querying would be a wasted round trip *and*
   * would leave that ordering unobservable, which is how it silently rotted
   * into dead code once already.
   */
  async function coverUrlFor(doc: OutfitDoc): Promise<string | undefined> {
    const firstId = doc.itemIds[0];
    if (!firstId) return undefined;

    const item = (await ClothingItem.findOne({
      _id: firstId,
      userId: doc.userId,
    })) as ClothingItemDoc | null;
    return signCover(item);
  }

  /**
   * Sign a run of resolved items into the wire shape the detail response
   * carries. Shared with `GET /items` through `signing.ts`, so the outfit
   * detail screen and the wardrobe grid render the same object.
   */
  function signItems(docs: ClothingItemDoc[]): Promise<PublicClothingItem[]> {
    return Promise.all(docs.map((doc) => signItemUrls(storage, doc)));
  }

  /**
   * Resolve an outfit's items for a READ, in the order the outfit stores them.
   *
   * Deliberately tolerant where `resolveOwnedItems` is strict: an id that no
   * longer resolves is skipped rather than fatal, so `items` may be shorter
   * than `itemIds`. Both are returned, which is what lets a client see the
   * gap. There is no cascade delete in this system, so this is only reachable
   * by a direct database deletion — but a detail screen that 500s on one stale
   * reference is worse than one that renders the rest.
   *
   * `userId` is in the query for the same reason it is in `resolveOwnedItems`:
   * this is the path that hands back signed URLs, and it must not depend on a
   * write-time guarantee made in another function to stay safe.
   *
   * Both sides of the string-keyed lookup below come from
   * `ObjectId.toHexString()`, which is canonical lowercase. That is what keeps
   * this map from repeating the case-sensitivity bug `resolveOwnedItems`
   * documents: an ObjectId's hex form is case-insensitive, so a key taken from
   * anything other than a real ObjectId could miss its own document.
   */
  async function detailItems(outfit: OutfitDoc): Promise<PublicClothingItem[]> {
    const ids = outfit.itemIds.map((id) => id.toHexString());

    const docs = (await ClothingItem.find({
      _id: { $in: ids },
      userId: outfit.userId,
    })) as ClothingItemDoc[];

    // `$in` returns index order, not the order the outfit was composed in.
    const byId = new Map(docs.map((doc) => [doc._id.toHexString(), doc]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((doc): doc is ClothingItemDoc => doc !== undefined);

    return signItems(ordered);
  }

  router.post('/', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const body = parseBody(createSchema, req.body);
    const name = normaliseName(body.name);

    // Ownership is verified before anything is written, so a rejected outfit
    // leaves nothing behind. The resolved items come back in the caller's
    // order and are used for the cover below -- that is what keeps the
    // ordering observable rather than dead.
    const items = await resolveOwnedItems(body.itemIds, userId, 'itemIds');

    const doc = (await Outfit.create({
      userId,
      ...(name ? { name } : {}),
      // The resolved documents' ids, not the caller's raw strings: those may
      // differ in case, and what gets stored must be what was validated.
      itemIds: items.map((item) => item._id),
    })) as OutfitDoc;

    const outfit: PublicOutfit = toPublicOutfit(doc, await signCover(items[0] ?? null));
    res.status(201).json({ outfit });
  });

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
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: new Types.ObjectId(cursor.id) } },
      ];
    }

    // limit + 1 tells us whether another page exists without a second query.
    const docs = (await Outfit.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)) as OutfitDoc[];

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    // Each cover is a lookup plus a signing round trip, so a page's worth runs
    // concurrently rather than in a sequential loop.
    const outfits = await Promise.all(
      page.map(async (doc) => toPublicOutfit(doc, await coverUrlFor(doc))),
    );

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor((last as OutfitDoc & { createdAt: Date }).createdAt, String(last._id))
        : undefined;

    res.json({ outfits, ...(nextCursor ? { nextCursor } : {}) });
  });

  // FR5 (edit/delete), and the detail screen Task 5 renders from.
  router.get('/:id', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const doc = await findOwnedOutfit(req.params.id, userId);

    // The heavy read: the items themselves rather than a cover. A client that
    // had to fetch N items separately would issue N round trips to render one
    // screen. The list endpoint stays light; this asymmetry is deliberate.
    const outfit: PublicOutfitDetail = toPublicOutfitDetail(doc, await detailItems(doc));
    res.json({ outfit });
  });

  router.patch('/:id', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // The outfit is resolved BEFORE the body is inspected, so the 404 answer
    // never depends on what the body happened to contain: a malformed id or a
    // foreign outfit answers 404 whether or not the patch itself was valid.
    // Validating first read as reasonable -- it avoids a query for a request
    // that is doomed anyway -- but it made `PATCH /outfits/<malformed>` with an
    // empty body a 400, contradicting "all three routes return 404 for a
    // malformed id". It leaks nothing either way; one of the two had to give,
    // and a contract that holds unconditionally is worth more than one query.
    const doc = await findOwnedOutfit(req.params.id, userId);

    const patch = parseBody(patchSchema, req.body);

    // JSON cannot carry `undefined`, so `!== undefined` is exactly "the client
    // sent this key". That distinction IS the name semantics: `name: ''` (or
    // whitespace) clears the name, an omitted `name` leaves it alone. Treating
    // an omitted name as a clear would mean a rename could never be partial;
    // treating a blank one as absent would mean a name could never be removed.
    const hasName = patch.name !== undefined;

    // An empty patch is a client bug. Returning 200 for it hides that bug and
    // reports a write that never happened.
    if (!hasName && patch.itemIds === undefined) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Nothing to update', [
        { path: '(body)', message: 'Provide at least one of name or itemIds' },
      ]);
    }

    // The SAME ownership gate POST uses. Sharing the helper is not what makes
    // this safe -- calling it is, which is why this route carries its own
    // cross-user test rather than leaning on POST's. Resolved before anything
    // is written, so a rejected edit leaves the outfit exactly as it was.
    const replacement =
      patch.itemIds !== undefined
        ? await resolveOwnedItems(patch.itemIds, userId, 'itemIds')
        : undefined;

    if (replacement) {
      // The resolved documents' ids, not the caller's raw strings: those may
      // differ in case, and what gets stored must be what was validated.
      doc.itemIds = replacement.map((item) => item._id);
    }
    if (hasName) {
      // `undefined` unsets the path, which is how a cleared name becomes
      // absent rather than ''.
      doc.name = normaliseName(patch.name);
    }

    // `save()` lets the schema's timestamps move `updatedAt` and leave
    // `createdAt` alone.
    try {
      await doc.save();
    } catch (err) {
      // This handler is read-modify-write, so the outfit can be deleted
      // between the read above and this write -- one user on two devices is
      // enough. mongoose rejects with DocumentNotFoundError, which left
      // unmapped is a client-visible 500 plus a stack trace for an ordinary
      // race. The outfit is, in fact, not found: answer like every other
      // not-found on this route.
      if (err instanceof mongoose.Error.DocumentNotFoundError) {
        throw outfitNotFound();
      }
      throw err;
    }

    // Reuse the items just resolved rather than re-reading them, for the same
    // reason POST does: it is a wasted round trip, and re-reading would leave
    // the ordering unobservable. A name-only patch has nothing resolved, so
    // that one reads.
    const items = replacement ? await signItems(replacement) : await detailItems(doc);

    const outfit: PublicOutfitDetail = toPublicOutfitDetail(doc, items);
    res.json({ outfit });
  });

  router.delete('/:id', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // `userId` is part of the delete filter rather than a check before it, so
    // a foreign outfit is never deleted and never distinguished from one that
    // does not exist. Deliberately NOT idempotent-silent: a 204 for an id that
    // never existed hides a client bug with nothing to signal it.
    //
    // Nothing else is deleted. Items belong to the wardrobe, not to the outfit
    // that happens to reference them -- another outfit may reference the same
    // item, and deleting an outfit must never empty a wardrobe.
    const result = await Outfit.deleteOne({ _id: outfitObjectId(req.params.id), userId });
    if (result.deletedCount === 0) {
      throw outfitNotFound();
    }

    res.status(204).end();
  });

  return router;
}
