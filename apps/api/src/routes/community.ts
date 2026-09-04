import { Router, type Request } from 'express';
import mongoose, { Types, type Model } from 'mongoose';
import { z } from 'zod';
import { MAX_CAPTION_LENGTH, type PostAuthor, type PublicClothingItem, type PublicPost } from '@wardrobe/shared';
import type { Config } from '../config';
import { ApiError } from '../http/errors';
import { parseBody } from '../http/validate';
import { requireAuth } from '../auth/requireAuth';
import { ClothingItem, type ClothingItemDoc } from '../models/ClothingItem';
import { Outfit, type OutfitDoc } from '../models/Outfit';
import { User, type UserDoc } from '../models/User';
import { CommunityPost, type CommunityPostDoc, toPostAuthor, toPublicPost } from '../models/CommunityPost';
import { PostLike, type PostLikeDoc } from '../models/PostLike';
import { PostSave, type PostSaveDoc } from '../models/PostSave';
import type { StorageProvider } from '../storage/StorageProvider';
import { encodeCursor, decodeCursor, parseLimit } from './pagination';
import { signItemUrls } from './signing';

/**
 * The share body.
 *
 * `.trim()` comes BEFORE both bounds, and the order is the whole point:
 * `min(1)` after a trim is what makes a whitespace-only caption a 400 rather
 * than a post whose caption renders as an empty line, and `max()` after a trim
 * is what stops padding from consuming a user's characters. Neither reads as
 * load-bearing and both are.
 *
 * `outfitId` is only checked for being a string here. Whether it names an
 * outfit, and whether that outfit is the caller's, is resolved below — and
 * both answers are the SAME 404, which is why they cannot be a validation
 * issue on a field.
 */
const shareSchema = z.object({
  outfitId: z.string(),
  caption: z.string().trim().min(1).max(MAX_CAPTION_LENGTH),
});

/**
 * The one 404 the share endpoint returns for an outfit.
 *
 * A foreign outfit, an outfit that never existed and a malformed id all
 * produce an identical body. THIS IS THE SECURITY PROPERTY OF THIS ENDPOINT,
 * not a stylistic choice: any difference between "not found" and "not yours"
 * turns `POST /community/posts` into an existence oracle over every other
 * user's outfits — an authenticated attacker could enumerate ids and learn
 * which ones are real without ever being allowed to read one.
 *
 * A 403 would leak the same thing, more loudly. So would a distinct "malformed
 * id" message, which is why the id's shape is checked on this path too rather
 * than reported as a validation error on `outfitId`.
 *
 * Deliberately a copy of the 404 `outfits.ts` returns rather than an import
 * from it: that one is the contract of `/outfits/:id`, a different endpoint
 * with a different resource in its path, and coupling this route's answer to
 * changes in that one would be the wrong kind of sharing. The two must LOOK
 * alike; they must not be forced to move together.
 */
function outfitNotFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Outfit not found');
}

/**
 * Load the outfit named in the body, but only if the caller owns it.
 *
 * Ownership is part of the QUERY rather than a check afterwards, for the
 * reason `outfits.ts` documents: a check afterwards is one early return away
 * from being skipped, and the version that filters cannot answer differently
 * for a foreign outfit no matter what the rest of the handler does.
 *
 * This is the owner-scoped half of Stage 8. It stays owner-scoped: you may
 * only share an outfit you own. The FEED is the half that must not filter by
 * the caller — do not reach for this helper there.
 *
 * The shape check has to happen before the query: a malformed id can never
 * match a document, and without the check Mongoose rejects with a CastError,
 * so a client typo would read as a 500.
 */
async function findOwnedOutfit(rawId: string, userId: string): Promise<OutfitDoc> {
  if (!mongoose.isValidObjectId(rawId)) {
    throw outfitNotFound();
  }
  const doc = (await Outfit.findOne({
    // Canonicalised rather than passed through: an ObjectId's hex form is
    // case-insensitive, so the caller's casing must never be what a query
    // keys on.
    _id: new Types.ObjectId(rawId),
    userId,
  })) as OutfitDoc | null;
  if (!doc) {
    throw outfitNotFound();
  }
  return doc;
}

/**
 * The caller's own id, or a 401.
 *
 * `requireAuth` has already rejected a request with no usable token, so this
 * never fires in practice — it exists because `req.userId` is `string |
 * undefined` on the global augmentation, and the alternative at eight call sites
 * is a non-null assertion. An assertion says "trust me"; this says 401, which
 * is the answer that would be correct if the middleware were ever reordered
 * away.
 */
function callerId(req: Request): string {
  const userId = req.userId;
  if (!userId) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return userId;
}

/**
 * The one 404 every post-addressed endpoint in this file returns.
 *
 * The same non-distinguishing discipline `outfitNotFound` documents, applied
 * to a resource that is PUBLICLY READABLE — which changes what it protects but
 * not whether it is needed. Anyone may read any post through the feed, so the
 * existence of a post id is not a secret; what must not leak is the difference
 * between "no such post" and "not YOURS", because that difference is the whole
 * answer `DELETE /community/posts/:id` would otherwise hand an attacker
 * probing which of a page of feed ids they could delete. A malformed id gets
 * the same body for the same reason it does on the share path: a distinct
 * "malformed" message is a second bit of information about an id the caller
 * supplied.
 *
 * Deliberately NOT reused from `outfitNotFound`: a different resource in a
 * different path, and the two must look alike without being forced to move
 * together.
 */
function postNotFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Post not found');
}

/**
 * Load the post named in the path.
 *
 * NOT OWNER-SCOPED, and that is the point: liking and saving act on OTHER
 * people's posts, so `findOwnedOutfit`'s pattern is exactly wrong here. Ruling
 * 2's owner-scoped half covers creating, deleting and the saved list — not
 * these. `DELETE /community/posts/:id` does its own owner-scoped delete rather
 * than calling this and checking afterwards, for the reason `outfits.ts`
 * documents: a check after a load is one early return away from being skipped.
 *
 * The shape check comes before the query because a malformed id can never
 * match a document, and without it Mongoose raises a CastError — a client typo
 * reported as a 500.
 *
 * The post DOCUMENT rather than a boolean: the like endpoints need
 * `likeCount` to answer with when nothing changed, and re-reading it after the
 * existence check would be a second round trip for a value already in hand.
 */
function postObjectId(raw: unknown): Types.ObjectId {
  if (!mongoose.isValidObjectId(raw)) {
    throw postNotFound();
  }
  // Canonicalised rather than passed through, as everywhere else in this file:
  // an ObjectId's hex form is case-insensitive and a query must never key on
  // the caller's casing.
  return new Types.ObjectId(String(raw));
}

async function findPost(raw: unknown): Promise<CommunityPostDoc> {
  const doc = (await CommunityPost.findOne({
    _id: postObjectId(raw),
  })) as CommunityPostDoc | null;
  if (!doc) {
    throw postNotFound();
  }
  return doc;
}

/**
 * Is this the duplicate-key error a unique index raises?
 *
 * Exported for a unit test, because the branch that consumes it is a RACE and
 * nothing in an integration suite can interleave two handlers deterministically
 * enough to enter it. See `recordInteraction` for what was measured about how
 * rarely it fires; the predicate itself is ordinary code and is tested as such.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

/**
 * Record one (post, user) interaction, and report whether THIS call created it.
 *
 * RULING 3, AND THE RETURN VALUE IS THE WHOLE MECHANISM. A read-then-write
 * ("is there a like already? no — insert and increment") has a race: two taps
 * in the same frame both read "no" and both increment, and TC-12's "like count
 * increments" becomes "increments by two". This project has shipped that exact
 * double-submit defect twice already. So the insert is an upsert against the
 * unique `{ postId, userId }` index and the caller increments only when the
 * upsert actually inserted.
 *
 * `upsertedCount`, NEVER `modifiedCount`. MEASURED against mongod 8.2.12: the
 * second upsert of an identical pair reports `modifiedCount: 1`, because
 * `timestamps: true` puts `updatedAt` in a `$set` that matches and rewrites the
 * existing row. A gate on `modifiedCount` would therefore increment on EVERY
 * tap while looking like a gate — the double-tap defect wearing a guard.
 *
 * The duplicate-key catch is a belt-and-braces path and is documented as one.
 * MEASURED, 40 rounds of 16 genuinely concurrent upserts on a fresh key: every
 * round produced exactly one row and exactly one `upsertedCount === 1`, and NOT
 * ONE E11000 surfaced, because mongod retries an upsert internally when the
 * query is an exact equality match on the unique index's own fields. The same
 * probe with the `unique: true` removed produced up to SEVEN rows per round and
 * 170 insertions across 40 rounds — which is what the index is buying, and why
 * this is the layer idempotency lives at. The catch stays because that retry is
 * a server implementation detail rather than a contract, and a 500 on a double
 * tap would be user-visible.
 */
async function recordInteraction(
  model: Model<PostLikeDoc> | Model<PostSaveDoc>,
  postId: Types.ObjectId,
  userId: string,
): Promise<boolean> {
  try {
    // ONE cast, and it is the reason `PostSave.ts` says the two schemas must
    // stay the same shape: `PostLikeDoc` and `PostSaveDoc` are structurally
    // identical, so this narrows a union of two models over one document shape
    // rather than papering over a difference. If they ever diverge, the two
    // endpoints would be answering "already done?" by different rules and this
    // helper should be the thing that stops compiling.
    const result = await (model as Model<PostLikeDoc>).updateOne(
      { postId, userId },
      { $setOnInsert: { postId, userId } },
      { upsert: true },
    );
    return result.upsertedCount === 1;
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
    // Someone else's identical upsert won the race, so the row exists and this
    // call did not create it — which is exactly what `false` means here.
    return false;
  }
}

/**
 * The author of a post, resolved from the verified token.
 *
 * NEVER from the request body. The body cannot name an author, and this is
 * what makes that true rather than a convention: the only id that reaches
 * `CommunityPost.userId` is the one `requireAuth` put on the request.
 *
 * A valid token for a user who no longer exists is a 401, not a 500 and not a
 * post with a blank author. The token is genuine; the identity it asserts is
 * not there any more, which is exactly what "authentication required" means.
 * It is checked BEFORE anything is written, so a request that cannot be
 * attributed leaves nothing behind.
 */
async function loadAuthor(userId: string): Promise<PostAuthor> {
  const user = (await User.findById(userId)) as UserDoc | null;
  if (!user) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return toPostAuthor(user);
}

/**
 * The name a post carries when its author's account is gone.
 *
 * A POST OUTLIVES ITS AUTHOR. Nothing in this system cascades a user delete
 * onto their posts, so a feed page routinely can contain one. `loadAuthor`
 * above answers 401 for a missing user, which is right on the create path — an
 * unattributable request must write nothing — and would be catastrophic here:
 * one deleted account would take down the whole page for everybody.
 *
 * So the post stays and its author degrades. A NAME rather than an omitted
 * `author`, because `PostAuthor.name` is required and it is the input the
 * initials avatar is derived from (ruling 6): a card with no name renders a
 * hole where an avatar should be. The id is kept as the (now dangling) ref, so
 * a client keying on `author.id` still has a key.
 */
export const DELETED_AUTHOR_NAME = 'Deleted user';

/**
 * Neutralise every regex metacharacter in a user-supplied search term.
 *
 * `?q=` reaches Mongo as a `$regex`, so without this the query string IS a
 * regular expression written by whoever typed in the search box. Three
 * distinct failures follow, and only the loudest of them looks like a bug:
 *
 *  - `.*` matches every caption in the system, so the search silently stops
 *    filtering;
 *  - `(blue)` is a capture group matching the substring "blue", which WIDENS
 *    the result set rather than breaking it — the quiet one;
 *  - `[` is not a valid regex at all, so a client typo becomes a 500.
 *
 * There is a fourth: a crafted pattern like `(a+)+$` is catastrophic
 * backtracking, run server-side against every caption. Escaping removes all
 * four at once, and it is the only fix that does — a try/catch around the
 * compile addresses the third and none of the others.
 *
 * The character class is the standard one. `-` and `/` are deliberately absent:
 * neither is a metacharacter outside a character class, and escaping them
 * would be noise in the pattern with no effect on what it matches.
 *
 * WHAT THIS DOES NOT COVER: a character that is not a metacharacter cannot be
 * neutralised by escaping it, and one of those is fatal — see
 * `CONTROL_CHARACTERS` below, which is the other half of making `?q=` safe.
 */
export function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Control characters a search term may not contain.
 *
 * NUL IS NOT A REGEX METACHARACTER, so `escapeRegex` hands it to Mongo
 * untouched — and mongod refuses any `$regex` carrying an embedded NUL
 * outright ("Regular expression cannot contain an embedded null byte",
 * BadValue). Measured through this route before the guard existed, `?q=%00`
 * answered 500 with a driver stack trace in the log: the client's fault
 * reported as the server's, which is the exact failure the third bullet above
 * says escaping prevents, arriving through a character escaping cannot reach.
 *
 * IT IS ALSO INVISIBLE TO A `new RegExp` TEST — `new RegExp('\0')` compiles
 * perfectly well, so the unit assertions on `escapeRegex` pass against the
 * bug. Only the route's own answer can see it, which is where it is tested.
 *
 * The WHOLE C0 range and DEL, not only NUL: the rest do not throw on this
 * mongod, but that is a fact about one server build rather than a contract,
 * and a search box emits typed text — a raw control byte in a term is a
 * malformed client or a probe either way, so the class goes at the edge.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Narrow a filter to everything strictly after a `?cursor=`, or leave it alone.
 *
 * Lifted out of the feed so the SAVED LIST cannot page by different rules than
 * the feed does. The two select different rows — the feed keysets over posts,
 * the saved list over `PostSave` — but the predicate, the rejection and the
 * error body a client parses are the same thing in both, and two copies of a
 * paging predicate is precisely the duplication that drifts into a page
 * boundary that drops a row in one list and not the other.
 *
 * A bad cursor is an ERROR, not a silent restart from page 1: restarting makes
 * an infinite scroll loop forever with no signal.
 *
 * BOTH `$or` branches are required, for the reason `items.ts` and `outfits.ts`
 * document: the first alone loses same-millisecond siblings at a page
 * boundary, the second alone matches nothing across timestamps.
 */
function applyKeysetCursor(filter: Record<string, unknown>, rawCursor: unknown): void {
  if (rawCursor === undefined) {
    return;
  }
  if (typeof rawCursor !== 'string') {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Malformed cursor', [
      { path: 'cursor', message: 'Expected a string' },
    ]);
  }
  const cursor = decodeCursor(rawCursor);
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

export function createCommunityRouter(config: Config, storage: StorageProvider): Router {
  /**
   * Resolve and sign a post's snapshotted items, in the snapshot's order.
   *
   * TOLERANT WHERE THE OUTFIT COMPOSER IS STRICT. An id that no longer
   * resolves is skipped rather than fatal, so the result may be shorter than
   * `ids` and may be empty. That is ruling 4 in force: a post outlives the
   * items it was made from, and a feed that 404s or 500s on a post whose
   * garments have been tidied away develops holes.
   *
   * `owner` is a parameter, not `req.userId`. At share time they are the same
   * person, but the feed renders OTHER users' posts, and an item query scoped
   * to the viewer would return nothing for every post but their own — the
   * ownership inversion this stage turns on. Scoping to the post's author is
   * what keeps this correct in both places.
   *
   * `$in` returns index order, never the order the ids were given, so the
   * composition order is reapplied deliberately. It is the order the author
   * chose and the order the card must render.
   *
   * DE-DUPLICATED, and the snapshot beside it is not. An outfit carrying the
   * same item id twice is reachable only by a direct database write —
   * `POST /outfits` answers 400 — but the feed card keys its list on
   * `item.id`, and two elements sharing one key is a defect in any keyed list.
   * `PublicPost.itemIds` keeps both occurrences, because it is a faithful
   * record of what was shared; `items` is the render list and carries each
   * garment once, at its first position. `Set` preserves insertion order, so
   * "first position" is exactly what survives.
   */
  async function signSnapshotItems(
    ids: Types.ObjectId[],
    owner: Types.ObjectId | string,
  ): Promise<PublicClothingItem[]> {
    const hex = [...new Set(ids.map((id) => id.toHexString()))];

    const docs = (await ClothingItem.find({
      _id: { $in: hex },
      userId: owner,
    })) as ClothingItemDoc[];

    // Both sides of this lookup come from `ObjectId.toHexString()`, which is
    // canonical lowercase — the same discipline `outfits.ts` documents, and
    // the reason a key is never taken from a raw request string.
    const byId = new Map(docs.map((doc) => [doc._id.toHexString(), doc]));
    const ordered = hex
      .map((id) => byId.get(id))
      .filter((doc): doc is ClothingItemDoc => doc !== undefined);

    // One signing round trip per item, run concurrently rather than in a
    // sequential loop.
    return Promise.all(ordered.map((doc) => signItemUrls(storage, doc)));
  }

  /**
   * Resolve a page of post documents into wire shape, in the order given.
   *
   * SHARED BY THE FEED AND THE SAVED LIST, deliberately. The two select
   * different rows — the feed keysets over posts, the saved list over the
   * viewer's `PostSave` rows — but a post must not describe itself differently
   * depending on which list it arrived in. `liked`, `saved`, `likeCount` and
   * the author are exactly the fields a viewer ACTS on, and two copies of this
   * resolution would let the saved list's `liked` drift from the feed's with
   * both suites green.
   *
   * THREE QUERIES FOR THE WHOLE PAGE, not three per post. `loadAuthor` is
   * deliberately not reused here: it is one query per call AND it throws 401
   * for a user who no longer exists, so a single deleted account would 401 an
   * entire feed page for everybody. Ruling 5 populates the author on every
   * read; it does not license N round trips to do it.
   *
   * The like and save lookups are scoped to the VIEWER, and that scope is the
   * whole meaning of these two flags. Without it `liked` would answer "has
   * anyone liked this", which is `likeCount > 0` wearing a different name, and
   * every viewer would see the same value.
   *
   * `viewerId` NEVER reaches the item query or the post selection — it is a
   * parameter about whose flags these are, not about whose posts these are.
   * Ruling 2 in force: the feed's rows come from every user.
   */
  async function hydratePosts(
    page: CommunityPostDoc[],
    viewer: string,
  ): Promise<PublicPost[]> {
    const postIds = page.map((doc) => doc._id);
    // De-duplicated: a page can hold several posts by one author, and that is
    // one row to fetch, not several.
    const authorIds = [...new Set(page.map((doc) => String(doc.userId)))];

    const [users, likes, saves] = (await Promise.all([
      User.find({ _id: { $in: authorIds } }),
      PostLike.find({ postId: { $in: postIds }, userId: viewer }),
      PostSave.find({ postId: { $in: postIds }, userId: viewer }),
    ])) as [UserDoc[], PostLikeDoc[], PostSaveDoc[]];

    const authorById = new Map(users.map((user) => [String(user._id), toPostAuthor(user)]));
    const likedPostIds = new Set(likes.map((like) => String(like.postId)));
    const savedPostIds = new Set(saves.map((save) => String(save.postId)));

    // Each post's items are a lookup plus a signing round trip per garment, so
    // a page's worth runs concurrently rather than in a sequential loop.
    return Promise.all(
      page.map(async (doc) =>
        toPublicPost(doc, {
          // The AUTHOR's wardrobe, never the viewer's — see
          // `signSnapshotItems`. Scoped to the viewer this would return `[]`
          // for every post but the reader's own.
          items: await signSnapshotItems(doc.itemIds, doc.userId),
          author: authorById.get(String(doc.userId)) ?? {
            id: String(doc.userId),
            name: DELETED_AUTHOR_NAME,
          },
          liked: likedPostIds.has(String(doc._id)),
          saved: savedPostIds.has(String(doc._id)),
        }),
      ),
    );
  }

  const router = Router();

  // FR9 / TC-11: "share an outfit to the community feed with a caption".
  router.post('/posts', requireAuth(config), async (req, res) => {
    const userId = callerId(req);

    const body = parseBody(shareSchema, req.body);

    const outfit = await findOwnedOutfit(body.outfitId, userId);

    // An outfit with no ids at all cannot become a post: there would be
    // nothing for a card to render and nothing a snapshot could preserve.
    // Unreachable through `POST /outfits` (MIN_OUTFIT_ITEMS is 1) and so only
    // reachable by a direct database write — but the alternative is a
    // ValidationError from the model surfacing as a 500, which reports a
    // client's impossible request as the server's fault.
    //
    // NOT the same thing as "no item RESOLVES". An outfit whose garments have
    // since been deleted still has its ids, and it still shares: the snapshot
    // keeps them and `items` comes back short. Those two cases answer
    // differently on purpose.
    if (outfit.itemIds.length === 0) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Outfit has no items', [
        { path: 'outfitId', message: 'An outfit with no items cannot be shared' },
      ]);
    }

    // Everything that can reject the request happens before the write, so a
    // refused share leaves no post behind.
    const author = await loadAuthor(userId);

    // Snapshotted, not referenced (ruling 4): the ids are COPIED out of the
    // outfit in the outfit's order. Deleting the source outfit afterwards
    // cannot blank the post, because nothing reads back through `outfitId`.
    const itemIds = outfit.itemIds.map((id) => new Types.ObjectId(id));

    const items = await signSnapshotItems(itemIds, outfit.userId);

    const doc = await CommunityPost.create({
      userId,
      // Provenance. Stored, never published and never read through.
      outfitId: outfit._id,
      itemIds,
      caption: body.caption,
    });

    // `liked` and `saved` are false because nobody can have liked or saved a
    // post that did not exist a moment ago — not because this endpoint is
    // unable to compute them. The mapper takes them as parameters from this,
    // its first caller, so that the feed and the like endpoint add callers
    // rather than change the shape underneath this one.
    const post: PublicPost = toPublicPost(doc, { items, author, liked: false, saved: false });

    // 201, and the whole post rather than an id: the same shape the feed
    // returns, so a client can render what it just shared without refetching
    // and one renderer serves both.
    res.status(201).json({ post });
  });

  /**
   * FR10 / TC-12: the public community feed.
   *
   * THIS IS THE ONE ROUTE IN THIS API THAT MUST NOT FILTER BY `req.userId`,
   * and the danger is precisely that it looks like every route that must.
   * Ruling 2: the feed returns posts from ALL users, which the submitted
   * document states twice. A `{ userId }` filter copy-pasted from `outfits.ts`
   * — one line, in the idiom of every other list endpoint here — turns this
   * into a "community" feed with an audience of one, and NOT ONE existing
   * ownership test in this repository goes red, because that filter is exactly
   * what they all assert. The guard has to be written backwards, and it is:
   * `community.integration.test.ts` gives its viewer no posts of their own, so
   * the filtered version answers with an empty page.
   *
   * `req.userId` is still needed, and only for these things: authenticating
   * the reader at all, and computing the VIEWER-RELATIVE `liked` and `saved`
   * flags. It never reaches the post query, and it never reaches the item
   * query — `signSnapshotItems` is scoped to each post's own AUTHOR, which is
   * what makes another user's card render at all.
   */
  router.get('/posts', requireAuth(config), async (req, res) => {
    const viewerId = callerId(req);

    const limit = parseLimit(req.query.limit);

    // EMPTY, AND IT STAYS EMPTY UNLESS THE CLIENT ASKED FOR A NARROWING.
    // Nothing derived from the viewer is ever added to it. See above.
    const filter: Record<string, unknown> = {};

    const rawQ = req.query.q;
    if (rawQ !== undefined) {
      // Repeated `?q=` arrives as an array. Rejected rather than joined or
      // silently reduced to the first: a client sending two search terms has a
      // bug, and answering as though it had sent one hides it.
      if (typeof rawQ !== 'string') {
        throw new ApiError(400, 'VALIDATION_FAILED', 'Malformed search term', [
          { path: 'q', message: 'Expected a string' },
        ]);
      }
      const term = rawQ.trim();
      // Rejected with the 400 `q` already uses, rather than passed to Mongo.
      // AFTER the trim on purpose: `?q=%0A` is whitespace-only and still means
      // "no filter" like `?q=%20`, while `trim()` does not strip NUL, so
      // `?q=%00` still arrives here with its byte intact.
      if (CONTROL_CHARACTERS.test(term)) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'Malformed search term', [
          { path: 'q', message: 'Search term cannot contain control characters' },
        ]);
      }
      // An empty search box is not a search for the empty string. `?q=` and
      // `?q=%20` mean "no filter" — the alternative is a `$regex` of `''`,
      // which matches everything anyway but does so through a collection-wide
      // regex scan rather than through no predicate at all.
      if (term) {
        // ESCAPED. The search term is a user-typed string, not a pattern —
        // see `escapeRegex` for the four distinct things that go wrong
        // without this, only one of which looks like a failure.
        filter.caption = { $regex: escapeRegex(term), $options: 'i' };
      }
    }

    applyKeysetCursor(filter, req.query.cursor);

    // `_id` in the sort is not decoration: two posts created in the same
    // millisecond would otherwise straddle a page boundary in an order the
    // database does not promise, and one is then dropped or repeated.
    //
    // limit + 1 tells us whether another page exists without a second query.
    const docs = (await CommunityPost.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)) as CommunityPostDoc[];

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    const posts = await hydratePosts(page, viewerId);

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.createdAt, String(last._id)) : undefined;

    res.json({ posts, ...(nextCursor ? { nextCursor } : {}) });
  });

  /**
   * TC-12, FIRST HALF: "like count increments".
   *
   * IDEMPOTENT AT THE DATABASE, NOT IN THIS HANDLER (ruling 3). The counter
   * moves only when `recordInteraction` reports that THIS call created the
   * row, so a second tap — same frame, same finger, or a client retrying a
   * request whose reply it never saw — answers identically and moves nothing.
   * An unconditional `$inc` here would look correct in every single-tap test in
   * this file and would be the double-submit defect this project has already
   * shipped twice.
   *
   * NOT owner-scoped: liking is the one thing you do to somebody ELSE's post.
   * The 404 for an unknown post is what stops a like row being written against
   * an id that names nothing.
   *
   * The response carries a `likeCount`, and it is a SNAPSHOT rather than a
   * promise. The request that inserts reads its number back from the increment
   * itself, so that one is exact; a request that did NOT insert answers with
   * the count as it stood when this handler read the post, and another request
   * in flight may not have committed its own increment yet. MEASURED: eight
   * simultaneous likes of one post from one user leave the stored count at
   * exactly 1, and the seven that did not insert can each answer 0, because
   * they read before the winner incremented. Two writes cannot be made atomic
   * on a standalone mongod, so every implementation of this endpoint has that
   * window; what must be exactly right is the STORED count, and it is. A client
   * should treat its own button as authoritative and this number as the
   * server's latest word on it.
   */
  router.post('/posts/:id/like', requireAuth(config), async (req, res) => {
    const userId = callerId(req);
    const post = await findPost(req.params.id);

    const inserted = await recordInteraction(PostLike, post._id, userId);
    if (!inserted) {
      // ALREADY LIKED. `post.likeCount` is the count as read a moment ago and
      // this request did not change it. Answered with the same shape as the
      // first tap on purpose: a client has nothing to branch on, and a "you
      // already did that" error would make a lost reply unretryable.
      res.json({ likeCount: post.likeCount, liked: true });
      return;
    }

    // `findOneAndUpdate` returning the AFTER document rather than `updateOne` plus
    // `post.likeCount + 1`: two users liking at the same moment would both
    // report the same number if the count were computed here, and only the
    // database knows the value after both increments.
    const updated = (await CommunityPost.findOneAndUpdate(
      { _id: post._id },
      { $inc: { likeCount: 1 } },
      // `returnDocument: 'after'` rather than the older `new: true`: mongoose
      // 9 deprecates that spelling and warns on every call, and this suite's
      // output has to stay pristine.
      { returnDocument: 'after' },
    )) as CommunityPostDoc | null;

    if (!updated) {
      // The post was deleted between the two writes above. The like row this
      // request inserted is then either already gone (the delete cascaded over
      // it) or orphaned (it cascaded first), so it is removed here rather than
      // left pointing at nothing. NOT REACHABLE FROM A TEST that can only
      // order whole requests — `likes and deletes racing on one post` in the
      // integration suite hammers the window and asserts the invariant this
      // branch exists to keep (no orphan row, and never a 500) rather than
      // pretending to enter it.
      await PostLike.deleteOne({ postId: post._id, userId });
      throw postNotFound();
    }

    res.json({ likeCount: updated.likeCount, liked: true });
  });

  /**
   * Unlike.
   *
   * `$inc: -1` ONLY WHEN THE DELETE ACTUALLY REMOVED A ROW, and that gate is
   * the ONLY floor under this counter. MEASURED in Task 1 against mongod
   * 8.2.12: `min: 0` on the schema does not apply to an `$inc` — not even with
   * `runValidators: true` — so an ungated decrement drives `likeCount` to -1
   * and nothing stops it. It also, and more commonly, decrements a count that
   * this user never contributed to: unlike a post you never liked and the
   * author loses somebody else's like. That second failure needs no negative
   * number to show, which is why the test that pins this gate uses a post with
   * a positive count and a viewer who never liked it.
   */
  router.delete('/posts/:id/like', requireAuth(config), async (req, res) => {
    const userId = callerId(req);
    const post = await findPost(req.params.id);

    const result = await PostLike.deleteOne({ postId: post._id, userId });
    if (result.deletedCount !== 1) {
      // Nothing to undo, so nothing moves. Not an error: a client whose first
      // unlike succeeded but whose reply was lost must be able to send it
      // again.
      res.json({ likeCount: post.likeCount, liked: false });
      return;
    }

    const updated = (await CommunityPost.findOneAndUpdate(
      { _id: post._id },
      { $inc: { likeCount: -1 } },
      // `returnDocument: 'after'` rather than the older `new: true`: mongoose
      // 9 deprecates that spelling and warns on every call, and this suite's
      // output has to stay pristine.
      { returnDocument: 'after' },
    )) as CommunityPostDoc | null;

    if (!updated) {
      throw postNotFound();
    }

    res.json({ likeCount: updated.likeCount, liked: false });
  });

  /**
   * TC-12, SECOND HALF: "post added to user's saved list".
   *
   * The same shape as the like path and idempotent for the same reason, minus
   * the counter: a save is private to the saver, so there is nothing to
   * denormalise onto the post and nothing a second tap could inflate. What a
   * second tap must still not do is create a second row — that would put the
   * post in the saved list twice — and the unique index is what prevents it.
   */
  router.post('/posts/:id/save', requireAuth(config), async (req, res) => {
    const userId = callerId(req);
    const post = await findPost(req.params.id);

    await recordInteraction(PostSave, post._id, userId);

    res.json({ saved: true });
  });

  router.delete('/posts/:id/save', requireAuth(config), async (req, res) => {
    const userId = callerId(req);
    const post = await findPost(req.params.id);

    await PostSave.deleteOne({ postId: post._id, userId });

    res.json({ saved: false });
  });

  /**
   * The viewer's saved posts, newest SAVE first.
   *
   * OWNER-SCOPED, AND THIS IS WHERE RULING 2 RUNS THE ORDINARY WAY AGAIN. The
   * feed twenty lines up must never filter by the caller; this must, and the
   * danger is the mirror image — `const filter = {}` copied down from the feed
   * reads as consistency with the file it sits in and hands every user
   * everybody else's bookmarks. A saved list is private: it is what a user
   * kept, not what they published.
   *
   * KEYSET OVER `PostSave`, NOT OVER POSTS, and the ordering is the reason.
   * "Newest first" here means newest SAVE, not newest post — a user who
   * bookmarks a year-old outfit expects it at the top — so the cursor is the
   * save row's own `{ createdAt, _id }`, served by the
   * `{ userId: 1, createdAt: -1, _id: -1 }` index `PostSave` declares for
   * exactly this query. Paging over posts and sorting afterwards would put the
   * year-old outfit at the bottom and, worse, would page by a key the sort does
   * not match.
   *
   * The page is COMPACTED against the posts that still exist. Deleting a post
   * cascades its saves, so an orphan row is only reachable by a direct
   * database write — but the cursor is taken from the SAVE rows rather than
   * from the surviving posts, so a compacted page still pages correctly, and a
   * list that 500s on a dangling row would be a hole a user could not clear.
   */
  router.get('/saved', requireAuth(config), async (req, res) => {
    const viewerId = callerId(req);

    const limit = parseLimit(req.query.limit);

    // THE VIEWER'S OWN SAVES AND NOTHING ELSE. Unlike the feed's, this filter
    // starts owner-scoped and must stay that way.
    const filter: Record<string, unknown> = { userId: viewerId };

    applyKeysetCursor(filter, req.query.cursor);

    const saves = (await PostSave.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)) as PostSaveDoc[];

    const hasMore = saves.length > limit;
    const page = hasMore ? saves.slice(0, limit) : saves;

    const docs = (await CommunityPost.find({
      _id: { $in: page.map((save) => save.postId) },
    })) as CommunityPostDoc[];

    // `$in` returns index order, never the order asked for, so the save order
    // is reapplied — the same discipline `signSnapshotItems` documents.
    const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
    const ordered = page
      .map((save) => byId.get(String(save.postId)))
      .filter((doc): doc is CommunityPostDoc => doc !== undefined);

    // The same resolution the feed uses, so a saved card cannot describe
    // itself differently from the same card in the feed.
    const posts = await hydratePosts(ordered, viewerId);

    // FROM THE LAST SAVE ROW, not the last post: the sort key is the save's,
    // and a cursor built from a post would page by a key nothing is sorted on.
    // `page` rather than `ordered`, so a compacted row cannot make the next
    // page skip back over the rows between it and the one that survived.
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.createdAt, String(last._id)) : undefined;

    res.json({ posts, ...(nextCursor ? { nextCursor } : {}) });
  });

  /**
   * Delete your own post.
   *
   * RULING 7: BEYOND THE DOCUMENTS, ADDED FOR SAFETY, and recorded as such in
   * `VERIFICATION.md` so Stage 10 does not mistake it for a claim being
   * discharged. Publishing to a public feed with no way to retract is a
   * user-harm gap rather than a feature gap.
   *
   * OWNER-SCOPED, with `userId` in the delete FILTER rather than checked after
   * a load — the reason `outfits.ts` gives: a check afterwards is one early
   * return away from being skipped, and the filtered version cannot answer
   * differently for a foreign post no matter what the rest of the handler
   * does. A foreign post, a post that never existed and a malformed id all get
   * the same 404.
   *
   * CASCADES, and it must: the likes and saves of a deleted post are rows
   * pointing at nothing. A stale `PostSave` would otherwise sit in some other
   * user's saved list forever, unreachable and undeletable by them, because
   * the endpoint that removes a save 404s once the post is gone.
   *
   * The cascade runs AFTER the post is deleted, so a request that turns out
   * not to own the post cannot delete anybody's interaction rows on the way to
   * finding that out.
   */
  router.delete('/posts/:id', requireAuth(config), async (req, res) => {
    const userId = callerId(req);

    const postId = postObjectId(req.params.id);

    const result = await CommunityPost.deleteOne({ _id: postId, userId });
    if (result.deletedCount === 0) {
      // Deliberately not idempotent-silent: a 204 for an id that never existed
      // hides a client bug with nothing to signal it.
      throw postNotFound();
    }

    // NOT ATOMIC WITH THE DELETE ABOVE, and it cannot be on a standalone
    // mongod — a multi-collection transaction needs a replica set. So a crash
    // between the two statements leaves like and save rows whose post is gone,
    // and no user can clear them: `DELETE /posts/:id/save` answers 404 once the
    // post no longer exists.
    //
    // What actually keeps that harmless is NOT this cascade but the saved
    // list's compaction — a saved row whose post is missing is dropped from the
    // response rather than rendered — so an orphan is invisible even when it
    // survives. The cascade is the tidy path; the compaction is the guarantee.
    await Promise.all([PostLike.deleteMany({ postId }), PostSave.deleteMany({ postId })]);

    res.status(204).end();
  });

  return router;
}
