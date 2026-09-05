import { Router } from 'express';
import multer from 'multer';
import mongoose, { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ITEM_CATEGORIES,
  LAUNDRY_STATUSES,
  SEASONS,
  type ItemCategory,
  type PublicClothingItem,
} from '@wardrobe/shared';
import type { Config } from '../config';
import { ApiError } from '../http/errors';
import { parseBody } from '../http/validate';
import { requireAuth } from '../auth/requireAuth';
import { ClothingItem, type ClothingItemDoc } from '../models/ClothingItem';
import { LaundryStatus, type LaundryStatusDoc } from '../models/LaundryStatus';
import type { StorageProvider } from '../storage/StorageProvider';
import { tagImage } from '../ai/tagClient';
import { encodeCursor, decodeCursor, parseLimit } from './pagination';
import { signItemUrls } from './signing';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Size bound for the `thumbnail` part, separate from the image's.
 *
 * multer's `limits.fileSize` is a per-file cap, so without this the thumbnail
 * inherits the image's 10MB budget -- and magic-byte validation proves only
 * that a part *is* an image, never that it is a small one. A client could
 * send a valid 10MB JPEG under `thumbnail` and the server would store it and
 * then sign it as the grid's tile source, which defeats the entire reason the
 * thumbnail exists and doubles per-item storage.
 *
 * 512KB is deliberate headroom, not a measurement: a 320px q0.6 JPEG (what
 * `createThumbnail` produces) is tens of KB, so this leaves well over an
 * order of magnitude of slack for an unusually noisy image or a future
 * format change, while still being ~20x smaller than the image cap.
 *
 * What this does NOT bound: pixel dimensions (that needs a decoder, which is
 * exactly what this API refuses to add), and peak per-request memory --
 * multer has already buffered the part before `size` can be read, and offers
 * no per-field byte limit, so two parts can still buffer up to
 * MAX_UPLOAD_BYTES each. This bounds what gets stored and served, not what
 * gets buffered.
 */
export const MAX_THUMBNAIL_BYTES = 512 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Multipart text fields always arrive as strings, so `seasons` may be absent,
// a single value, or repeated. Normalise before validating.
const metadataSchema = z.object({
  category: z.enum(ITEM_CATEGORIES),
  seasons: z.array(z.enum(SEASONS)).default([]),
});

function normaliseSeasons(raw: unknown): unknown {
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// Task 5 (FR3): the mobile Add screen saves with the user's chosen category
// first, then offers to correct it once the AI's guess comes back with the
// created item -- see the task report for why "save, then offer to
// correct" was chosen over tagging before the first write. This is the
// correction endpoint that flow PATCHes. Deliberately narrow: only
// `category` is settable here. Anything else (e.g. `userId`, `wearCount`)
// is silently stripped by this schema rather than accepted.
const patchItemSchema = z.object({
  category: z.enum(ITEM_CATEGORIES),
});

// FR7 / TC-09. The union comes from `@wardrobe/shared`'s LAUNDRY_STATUSES,
// which is also what guards the field on `ClothingItem` and the field on the
// `LaundryStatus` log -- one array, three consumers, so a status the route
// accepts cannot be one the model rejects or the client cannot render.
//
// Exactly one settable key, like patchItemSchema above: anything else a client
// sends is stripped rather than accepted, so this endpoint can never become a
// second way to write `category` or `wearCount`.
const laundrySchema = z.object({
  status: z.enum(LAUNDRY_STATUSES),
});

/**
 * `PATCH /items/:id/retire`. One settable key, same discipline as
 * `laundrySchema` above: anything else a client sends is stripped rather than
 * accepted.
 */
const retireSchema = z.object({
  retired: z.boolean(),
});

// A multipart part's `mimetype` is a client-declared header — an attacker can
// upload arbitrary bytes and simply lie about the Content-Type. Stage 3 feeds
// every stored object to a CLIP model trusting it is an image, and signed
// URLs serve objects back with whatever Content-Type was declared at upload
// time, so the declared header cannot be the authority for what gets stored.
// Detect the real format from the file's own magic bytes instead.
function detectImageType(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

type DetectedImageType = NonNullable<ReturnType<typeof detectImageType>>;

/**
 * Runs the full "is this really an image, and is it the one it claims to be"
 * check on a single multipart file part, and returns the type its own bytes
 * prove it to be.
 *
 * Shared by the `image` and `thumbnail` parts deliberately: the thumbnail is
 * still a client-supplied file written to storage under the user's prefix, and
 * declaring it a thumbnail does not make it trustworthy. Two hand-written
 * copies of this check could drift, and the one that drifted would be the one
 * nobody was looking at.
 */
function validateImagePart(file: Express.Multer.File, path: 'image' | 'thumbnail'): DetectedImageType {
  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Unsupported image type', [
      { path, message: `Expected one of ${ALLOWED_TYPES.join(', ')}` },
    ]);
  }

  // The declared mimetype only narrows candidates; the file's own magic
  // bytes are what actually decide what gets stored.
  const actualType = detectImageType(file.buffer);
  if (!actualType) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The uploaded file is not a recognised image', [
      { path, message: 'File contents did not match a supported image signature' },
    ]);
  }
  if (actualType !== file.mimetype) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Declared content type does not match the file contents', [
      { path, message: `Declared ${file.mimetype} but the file signature indicates ${actualType}` },
    ]);
  }

  return actualType;
}

// Derived from the signature-verified type, never the client-declared one,
// for the same reason the signature is the storage authority above.
function extensionFor(type: DetectedImageType): string {
  return type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
}

/**
 * The one 404 every `/items/:id` route returns.
 *
 * A malformed id, an id with no document, and another user's id all produce
 * this byte-identical body. Distinguishing them would confirm through the
 * response alone that an item exists at an id the caller has no business
 * knowing about -- the same reasoning `/auth/login` applies to a wrong
 * password versus an unknown email.
 */
function itemNotFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Item not found');
}

/**
 * Load one of the caller's items, or throw that 404.
 *
 * Ownership is part of the QUERY rather than a check afterwards, so "belongs to
 * someone else" and "does not exist at all" take the same code path and cannot
 * drift apart. A separate ownership check returning 403 would leak, through
 * the status code alone, that some other user's item exists at this id.
 *
 * The shape check has to come first: a malformed id can never match a
 * document, and without it Mongoose rejects with a CastError, so a client typo
 * would read as a 500.
 *
 * Extracted rather than written out a third time for the laundry route.
 * `GET /:id` and `PATCH /:id` had two hand-written copies of this exact
 * sequence already; a third would have been three places to forget the
 * `userId`, and the forgotten one would be whichever nobody was reading.
 *
 * The id is canonicalised before it reaches the query, for the reason
 * `resolveOwnedItems` documents: an ObjectId's hex form is case-insensitive,
 * so the caller's casing must never be what a query -- or anything derived
 * from it, such as the `itemId` written onto a transition row -- keys on.
 */
async function findOwnedItem(rawId: unknown, userId: string): Promise<ClothingItemDoc> {
  if (!mongoose.isValidObjectId(rawId)) {
    throw itemNotFound();
  }
  const doc = (await ClothingItem.findOne({
    _id: new Types.ObjectId(String(rawId)),
    userId,
  })) as ClothingItemDoc | null;
  if (!doc) {
    throw itemNotFound();
  }
  return doc;
}

export function createItemsRouter(config: Config, storage: StorageProvider): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth(config),
    // Two named parts: the item's photo, and the optional grid thumbnail the
    // client produced from the same capture (see the mobile app's
    // `createThumbnail` — the API deliberately does not decode images, which
    // is what keeps `sharp` and its native binary out of this container).
    // `limits.fileSize` is a per-file cap, so each part gets its own
    // MAX_UPLOAD_BYTES budget rather than sharing one.
    upload.fields([
      { name: 'image', maxCount: 1 },
      { name: 'thumbnail', maxCount: 1 },
    ]),
    async (req, res) => {
      // `upload.fields` populates `req.files` — a record of per-field arrays —
      // and leaves `req.file` undefined. Both slots can be absent, so narrow
      // through optional access rather than indexing an array that may not
      // exist: `req.files` itself is truthy even for a request that uploaded
      // no files at all, so testing it directly would let an image-less
      // request past the guard below.
      const files = req.files as Record<string, Express.Multer.File[] | undefined> | undefined;
      const imageFile = files?.image?.[0];
      const thumbnailFile = files?.thumbnail?.[0];

      if (!imageFile) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'An image file is required', [
          { path: 'image', message: 'No file was uploaded' },
        ]);
      }

      // Both parts are validated before anything is written, so a bad
      // thumbnail cannot leave the image behind as an orphan.
      const actualType = validateImagePart(imageFile, 'image');
      const thumbnailType = thumbnailFile ? validateImagePart(thumbnailFile, 'thumbnail') : undefined;

      // Magic bytes prove the part is an image; they say nothing about how
      // big it is. Checked here rather than folded into `validateImagePart`
      // because the bound is specific to the thumbnail -- the image part is
      // supposed to be large. 413 rather than 400 to match the response the
      // image's own oversize path already produces.
      if (thumbnailFile && thumbnailFile.size > MAX_THUMBNAIL_BYTES) {
        throw new ApiError(413, 'VALIDATION_FAILED', 'That thumbnail is too large', [
          {
            path: 'thumbnail',
            message: `Expected at most ${MAX_THUMBNAIL_BYTES} bytes, received ${thumbnailFile.size}`,
          },
        ]);
      }

      const meta = parseBody(metadataSchema, {
        category: req.body.category,
        seasons: normaliseSeasons(req.body.seasons),
      });

      // `req.userId` is typed `string | undefined` by the global Express augmentation,
      // so narrow it explicitly. Without this the template literal below would happily
      // produce `items/undefined/...` if the guard were ever removed or reordered —
      // TypeScript does not flag interpolating `undefined`.
      const userId = req.userId;
      if (!userId) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
      }

      // Ownership comes from the verified token, never from the request body.
      const key = `items/${userId}/${randomUUID()}.${extensionFor(actualType)}`;
      // Its own object with its own uuid, under the same user prefix. Never
      // derived from `key`: a shared stem would tie the two objects' lifetimes
      // together in a way nothing here actually guarantees.
      const thumbnailKey =
        thumbnailFile && thumbnailType
          ? `items/${userId}/${randomUUID()}-thumb.${extensionFor(thumbnailType)}`
          : undefined;

      // Everything that actually reached storage, so a later failure can undo
      // exactly that much — no more (deleting a key that was never written
      // would mask the real failure) and no less (an untracked object is a
      // silent orphan, which is the whole reason this cleanup exists).
      const storedObjectKeys: string[] = [];

      let doc: ClothingItemDoc;
      try {
        await storage.put(key, imageFile.buffer, imageFile.mimetype);
        storedObjectKeys.push(key);

        if (thumbnailKey && thumbnailFile) {
          await storage.put(thumbnailKey, thumbnailFile.buffer, thumbnailFile.mimetype);
          storedObjectKeys.push(thumbnailKey);
        }

        // Tagging is best-effort. `tagImage` never throws; null means "no tags",
        // not "upload failed". It reads the full-size image, not the
        // thumbnail — 320px is a grid tile, not something to classify from.
        const tags = await tagImage(imageFile.buffer, imageFile.mimetype, config);

        doc = (await ClothingItem.create({
          userId,
          imageKey: key,
          ...(thumbnailKey ? { thumbnailKey } : {}),
          category: tags?.category ?? meta.category,
          colors: tags?.colours ?? [],
          seasons: meta.seasons,
          source: tags ? 'ai' : 'manual',
          ...(tags ? { aiConfidence: tags.confidence } : {}),
          // Written alongside the confidence and, unlike `category`, never
          // written again. `category` above is what the item is filed under
          // and PATCH may change it; this is what the model actually said.
          // Keeping both is what lets a reader tell a category the model
          // chose from one the user corrected -- `source` cannot, because it
          // deliberately stays 'ai' through an override (Stage 3 Task 5), and
          // a confidence shown beside a corrected category is a number that
          // was never about that category. See `packages/shared/src/items.ts`.
          ...(tags ? { aiCategory: tags.category } : {}),
        })) as ClothingItemDoc;
      } catch (err) {
        // The bytes are already stored; do not leave an orphan behind. The
        // original error must still propagate, so each delete failure is
        // swallowed — but logged first, so a delete failure here doesn't
        // vanish with no signal at all (that would be exactly the silent
        // orphan this cleanup exists to prevent).
        await Promise.all(
          storedObjectKeys.map((orphanKey) =>
            storage.delete(orphanKey).catch((deleteErr) => {
              console.error(
                `Failed to delete orphaned object after a failed database write: ${orphanKey}`,
                deleteErr,
              );
            }),
          ),
        );
        throw err;
      }

      const item: PublicClothingItem = await signItemUrls(storage, doc);
      res.status(201).json({ item });
    },
  );

  // FR4 / TC-06: the wardrobe grid reads the whole collection from here.
  router.get('/', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const limit = parseLimit(req.query.limit);

    // Ownership comes from the verified token, never from a query parameter.
    const filter: Record<string, unknown> = { userId };

    const rawCategory = req.query.category;
    if (rawCategory !== undefined) {
      // An unknown category must not fall through as "no filter" -- that would
      // silently return the whole wardrobe when the client meant to narrow it.
      if (typeof rawCategory !== 'string' || !ITEM_CATEGORIES.includes(rawCategory as ItemCategory)) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'Unknown category', [
          { path: 'category', message: `Expected one of ${ITEM_CATEGORIES.join(', ')}` },
        ]);
      }
      filter.category = rawCategory;
    }

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
      // Strictly "older than the cursor", with _id breaking ties inside the
      // same millisecond. Both branches are required: the first alone loses
      // same-ms siblings, the second alone matches nothing across timestamps.
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: new Types.ObjectId(cursor.id) } },
      ];
    }

    // limit + 1 tells us whether another page exists without a second query.
    const docs = (await ClothingItem.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)) as ClothingItemDoc[];

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    // Signing is one network round trip per key, so a page's worth runs
    // concurrently rather than in a sequential loop.
    const items = await Promise.all(page.map((doc) => signItemUrls(storage, doc)));

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor((last as ClothingItemDoc & { createdAt: Date }).createdAt, String(last._id))
        : undefined;

    res.json({ items, ...(nextCursor ? { nextCursor } : {}) });
  });

  router.get('/:id', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const doc = await findOwnedItem(req.params.id, userId);

    res.json({ item: await signItemUrls(storage, doc) });
  });

  /**
   * FR7 / TC-09: move one item into or out of the laundry.
   *
   * WHY THIS LIVES ON THE ITEMS ROUTER. `/items/:id/laundry` is a sub-path of
   * the item resource, not a resource of its own: the caller addresses an
   * item, the ownership rule is the item's ownership rule, and the response is
   * a `PublicClothingItem` signed exactly the way `GET /items/:id` signs one.
   * A separate router mounted at the same `/items` prefix would have split one
   * resource across two files, given the 404 contract two homes to drift
   * between, and made correct behaviour depend on the order the two were
   * `app.use`'d. The `LaundryStatus` MODEL is its own file; the route is not.
   *
   * Registered before `PATCH /:id` as a habit rather than a necessity --
   * Express 5's `:id` matches a single path segment, so `/items/x/laundry`
   * cannot reach the generic handler today. Specific-before-generic stays
   * correct if that pattern is ever widened.
   */
  router.patch('/:id/laundry', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const patch = parseBody(laundrySchema, req.body);

    // Ownership is verified before anything is written, so a rejected request
    // leaves neither write behind -- no transition row and no moved status.
    const doc = await findOwnedItem(req.params.id, userId);

    // Server-stamped, and there is deliberately NO client-supplied
    // alternative. `POST /wear-history` has to accept a client date because
    // back-dating a wear is a real user action, and that is exactly why it
    // carries a clock-skew hazard that is invisible on a dev machine (where
    // the emulator and the API share one clock) and appears only on handsets.
    // A laundry transition has no back-dating story at all: it happens when
    // the user presses the button. Taking the time here rather than from the
    // request means this route has no clock to disagree with, so there is
    // nothing for a device gate to fail to see.
    const changedAt = new Date();

    // BOTH WRITES, OR THE REQUEST IS A LIE (ruling 2). The transition row and
    // the denormalised `ClothingItem.laundryStatus` are two views of one fact,
    // and `itemsLaundry.integration.test.ts`'s "APPENDS a transition row and
    // updates the item together" asserts both halves so that removing either
    // one fails it.
    //
    // The LOG IS WRITTEN FIRST, for the same reason `POST /wear-history`
    // writes its event before its fan-out: this mongod is standalone, so there
    // is no transaction to make the pair atomic and one order has to be chosen
    // deliberately. The log is the record of what happened; the field on the
    // item is a denormalisation of its latest row. A crash between the two
    // therefore leaves a transition that the item has not caught up to --
    // recoverable by replaying the log -- rather than a current status that no
    // row explains, which nothing can reconstruct.
    //
    // A NO-OP TRANSITION STILL RECORDS. Marking an already-in-laundry item as
    // in-laundry appends a row with the same status, on purpose. This is a log
    // of EVENTS, and "the user pressed it again" is a real event; suppressing
    // the row because the value did not change would silently lose that
    // provenance and make the history imply that nothing happened in a window
    // where something did. That is why there is no `if (doc.laundryStatus !==
    // patch.status)` guard here, and why a test asserts its absence.
    //
    // The consequence, for whoever reads this log later: IT RECORDS REQUESTS,
    // NOT PRESSES. There is no idempotency key and no rate cap, so an HTTP
    // retry after a client timeout is indistinguishable from a second
    // deliberate press. Row count is therefore an upper bound on user intent,
    // not a measure of it.
    const row = (await LaundryStatus.create({
      userId,
      // `doc._id`, never `req.params.id`: canonical, and guaranteed to be an
      // id this caller owns, because it came back from the ownership query.
      itemId: doc._id,
      status: patch.status,
      changedAt,
    })) as LaundryStatusDoc;

    // COMPENSATION, because ordering alone does NOT hold the invariant.
    //
    // The dangerous interleaving is not a crash. It is the ordinary one where
    // `create` SUCCEEDS and `save` THROWS: the client gets a 500, the
    // transition row persists, and the item never moves -- exactly the
    // divergence ruling 2 forbids, reached without anything dying. Two ways to
    // get there, both real:
    //
    //   1. `save()` validates EVERY path, not only the modified one
    //      (`validateModifiedOnly` is false by default). A ClothingItem whose
    //      OTHER fields violate the current schema -- a row written before a
    //      guard existed, or any later stage removing a value from
    //      ITEM_CATEGORIES -- throws ValidationError here even though the only
    //      field this route touched is fine. Measured: 500, one orphan row,
    //      item still `available`.
    //   2. `save()` throws DocumentNotFoundError when the document was deleted
    //      between the ownership read and this write. `DELETE /items/:id` now
    //      exists (below), so that window is open: one user on two devices, or
    //      one device with the detail screen's delete and laundry toggle both
    //      reachable, is enough to hit it.
    //
    // Left uncompensated, three taps on such an item accumulate three
    // transition rows while the grid still shows it available and
    // `itemsInLaundry` never moves; the only signal is three 500s. Worse,
    // replaying the log -- the recovery the log-first ordering below rests on
    // -- would then apply three transitions indistinguishable from three real
    // presses.
    //
    // So the row is undone rather than the ordering reversed. Log-first is
    // still correct for the case compensation cannot reach (see the ordering
    // note above); this closes every failure short of process death, which
    // only a transaction can close and this standalone mongod cannot offer.
    //
    // The cleanup's own failure is logged and swallowed while the ORIGINAL
    // error propagates -- the same shape as the orphaned-object cleanup in
    // `POST /` above, and for the same reason: the caller must be told what
    // actually went wrong, and a cleanup failure that vanished with no signal
    // would be precisely the orphan this exists to prevent.
    try {
      doc.laundryStatus = patch.status;
      await doc.save();
    } catch (err) {
      await LaundryStatus.deleteOne({ _id: row._id }).catch((cleanupErr) => {
        console.error(
          `Failed to compensate a laundry transition after the item write failed. ` +
            `Orphan transition ${String(row._id)} for item ${String(doc._id)} now records a ` +
            `status change that never took effect.`,
          cleanupErr,
        );
      });
      throw err;
    }

    const item: PublicClothingItem = await signItemUrls(storage, doc);
    res.json({ item });
  });

  /**
   * Take an item out of, or put it back into, the active wardrobe.
   *
   * Unlike `/laundry` this writes no transition log: nothing here asks "when
   * did this item become retired", only "is it retired now", so a plain field
   * flip is enough. See `PublicClothingItem.retired` in `@wardrobe/shared` for
   * why this is a field distinct from `laundryStatus` rather than a third
   * laundry state.
   *
   * Registered before `PATCH /:id` for the same reason `/laundry` is — Express
   * 5's `:id` matches one path segment, so this is a habit rather than a
   * necessity today, but the ordering stays correct if that ever changes.
   */
  router.patch('/:id/retire', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const patch = parseBody(retireSchema, req.body);
    const doc = await findOwnedItem(req.params.id, userId);

    doc.retired = patch.retired;
    await doc.save();

    const item: PublicClothingItem = await signItemUrls(storage, doc);
    res.json({ item });
  });

  router.patch('/:id', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const patch = parseBody(patchItemSchema, req.body);

    // Body first, then the lookup -- unchanged from before this route shared
    // `findOwnedItem`, so an invalid body on an unknown id still answers 400.
    const doc = await findOwnedItem(req.params.id, userId);

    // `category` and nothing else. `source`, `aiConfidence` and `aiCategory`
    // all survive an override on purpose: together they record what the model
    // said and how sure it was, which is exactly what makes this override
    // legible later. Writing `source: 'manual'` here would redefine that field
    // from "how was this tagged" to "who last touched it", and clearing
    // `aiCategory` would erase the only record in the system that an override
    // happened at all.
    doc.category = patch.category;
    await doc.save();

    const item: PublicClothingItem = await signItemUrls(storage, doc);
    res.json({ item });
  });

  /**
   * Delete an item outright.
   *
   * NO CASCADE. An outfit or a wear-history row that references this id keeps
   * doing so — `resolveOwnedItems` in `apps/api/src/routes/outfits.ts` and the
   * detail/list reads it feeds already tolerate an id that does not resolve,
   * because that tolerance was built for exactly this: a stale reference left
   * behind by a deletion, degrading a screen instead of 500ing it.
   *
   * THE DATABASE ROW IS DELETED FIRST, storage cleanup second and best-effort.
   * The two failure orders are not symmetric: a storage object that outlives
   * its row is an invisible leak nobody's wardrobe ever sees again, while a row
   * that outlives its storage object is a grid tile with a dead image link.
   * The cheaper failure is chosen deliberately, the same way `POST /` chooses
   * to leave an orphaned upload behind rather than risk a half-written item.
   *
   * Ownership is part of the delete filter, exactly as `DELETE /outfits/:id`
   * does it: a foreign item is never deleted and never distinguished from one
   * that does not exist.
   */
  router.delete('/:id', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // Loaded (not just matched by a delete filter) so the image keys are still
    // in hand for the storage cleanup below.
    const doc = await findOwnedItem(req.params.id, userId);

    await ClothingItem.deleteOne({ _id: doc._id, userId });

    const keys = [doc.imageKey, ...(doc.thumbnailKey ? [doc.thumbnailKey] : [])];
    await Promise.all(
      keys.map((key) =>
        storage.delete(key).catch((err) => {
          console.error(`Failed to delete storage object for a removed item: ${key}`, err);
        }),
      ),
    );

    res.status(204).end();
  });

  return router;
}
