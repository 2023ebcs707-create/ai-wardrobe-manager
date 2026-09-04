import request from 'supertest';
import mongoose from 'mongoose';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MAX_CAPTION_LENGTH } from '@wardrobe/shared';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { connectDatabase } from '../db';
import { User } from '../models/User';
import { ClothingItem, type ClothingItemDoc } from '../models/ClothingItem';
import { Outfit, type OutfitDoc } from '../models/Outfit';
import { CommunityPost } from '../models/CommunityPost';
import { PostLike } from '../models/PostLike';
import { PostSave } from '../models/PostSave';
import { createStorageProvider } from '../storage/MinioStorageProvider';
import { isDuplicateKeyError } from './community';

const config = loadConfig({ JWT_SECRET: 'community-test-secret', MONGO_URL: process.env.MONGO_URL });
const storage = createStorageProvider(config);
const okChecks = {
  database: async () => 'ok' as const,
  storage: async () => 'ok' as const,
  ai: async () => 'ok' as const,
};
const app = createApp(okChecks, config, storage);

/**
 * One HTTP server for the whole file, for the reason `outfits.integration.test.ts`
 * documents at length: `request(app)` binds and tears down an ephemeral server
 * per request, and a recycled port can hand one exchange's reply to another.
 */
let server: Server;

let token = '';
let ownerId = '';

beforeAll(async () => {
  server = app.listen(0);
  await connectDatabase(config.mongoUrl);
  await User.init();
  await ClothingItem.init();
  await Outfit.init();
  // Rebuild every index from the CURRENT schema: settle, drop, create. All
  // three steps are load-bearing and the order is not interchangeable. Each
  // one was arrived at by watching the previous version fail.
  //
  // 1. `init()` awaits the automatic index build Mongoose starts when a model
  //    is compiled against a connected instance. Dropping before that settles
  //    is a RACE, and it loses non-deterministically: measured here, it left
  //    `{ userId: 1 }` standing (built after the drop) while
  //    `{ createdAt: -1, _id: -1 }` was built before it and destroyed.
  //    Its rejection is SWALLOWED, and only its rejection: the automatic build
  //    is the very thing that fails when the collection carries an index whose
  //    options differ from the declaration, and repairing that is what the
  //    next two lines do. `createIndexes()` below is not swallowed, so a real
  //    problem still fails the suite.
  //
  // 2. `dropIndexes()` — removing everything but `_id_` — rather than trusting
  //    `createIndexes()` or `syncIndexes()` to reconcile.
  //    * `createIndexes()` only ever CREATES. An index built by an earlier run
  //      of an EARLIER schema survives, and every index assertion below then
  //      passes against a declaration that has since been deleted: precisely
  //      the mutation these tests exist to catch.
  //    * `syncIndexes()` DOES reconcile options — an earlier version of this
  //      comment claimed it compares by key only, and that was wrong. Measured
  //      on mongod 8.2.12 with mongoose 9.9.3: plant a non-unique
  //      `{ postId: 1, userId: 1 }`, declare a UNIQUE one, call
  //      `syncIndexes()`, and it RESOLVES — `dropped: ["postId_1_userId_1"]`,
  //      the index comes back with `unique: true`, and a duplicate insert is
  //      then rejected with E11000. It drops stale undeclared indexes too.
  //
  //      The real hazard is one line earlier. Mongoose kicks off an AUTOMATIC
  //      index build, and `Model.init()` surfaces that build's rejection: with
  //      the same residue in place, `await Model.init()` throws "An existing
  //      index has the same name as the requested index" BEFORE any
  //      reconciliation runs. That failure is inside `beforeAll`, so it takes
  //      the WHOLE FILE down rather than one test, and it persists across runs
  //      because nothing ever removes the offending index. Seven consecutive
  //      rows of one harness run — six mutations plus a control — were
  //      fabricated by exactly that before the control caught it.
  //
  //      So `.catch(() => undefined)` on `init()` below is the load-bearing
  //      change, not the choice of reconciler. `dropIndexes()` +
  //      `createIndexes()` is kept because these three collections have no
  //      other user and a full rebuild is the most direct guarantee; on a
  //      shared collection `syncIndexes()` would be the right tool, and it
  //      would work.
  //
  // 3. `createIndexes()` then builds the declared set, options included.
  //
  // Other suites in this repo deliberately avoid dropping, because they share
  // `clothingitems` with the rest of the app. These three collections have no
  // other user, so here it is the correct tool rather than a hazard.
  // DOCUMENTS FIRST, then indexes. The repair above is index-only, and that is
  // not enough on its own: a mutation that drops a unique constraint lets
  // duplicate rows in, and if that run is killed (the harness kills a jest
  // child at 900s) the rows survive. `createIndexes()` is deliberately NOT
  // swallowed, so the next run dies in `beforeAll` with "Index build failed …
  // E11000" and every test in the file fails — handing the next mutation a
  // fabricated CAUGHT. Measured: planting the residue plus two duplicate
  // `postlikes` rows fails all 31 tests here.
  await Promise.all([
    CommunityPost.deleteMany({}),
    PostLike.deleteMany({}),
    PostSave.deleteMany({}),
  ]);
  for (const Model of [CommunityPost, PostLike, PostSave]) {
    await Model.init().catch(() => undefined);
    await Model.collection.dropIndexes().catch(() => undefined);
    await Model.createIndexes();
  }
}, 30000);

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    ClothingItem.deleteMany({}),
    Outfit.deleteMany({}),
    CommunityPost.deleteMany({}),
    PostLike.deleteMany({}),
    PostSave.deleteMany({}),
  ]);
  const res = await request(server)
    .post('/auth/register')
    .send({ name: 'Ada Lovelace', email: 'owner@example.com', password: 'password123' });
  token = res.body.token;
  ownerId = res.body.user.id;
});

afterAll(async () => {
  await Promise.all([
    User.deleteMany({}),
    ClothingItem.deleteMany({}),
    Outfit.deleteMany({}),
    CommunityPost.deleteMany({}),
    PostLike.deleteMany({}),
    PostSave.deleteMany({}),
  ]);
  await mongoose.disconnect();
  // closeAllConnections first: `close()` alone waits for live sockets and
  // would hang this hook rather than fail it.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function seedItem(owner: string, overrides: Record<string, unknown> = {}) {
  return (await ClothingItem.create({
    userId: owner,
    imageKey: `items/${owner}/${randomUUID()}.jpg`,
    category: 'tshirt',
    source: 'manual',
    ...overrides,
  })) as ClothingItemDoc;
}

/**
 * Seed an outfit and the items it references.
 *
 * The items are created SEQUENTIALLY so their ObjectIds ascend, and the
 * outfit stores them in `order` — an index permutation. That is what makes
 * composition order observable at all: a `$in` lookup returns _id-ascending
 * order, so unless the seeded order and the stored order can disagree, a read
 * path that lost the ordering would look identical to one that kept it.
 */
async function seedOutfitWithItems(
  owner: string,
  count: number,
  order?: number[],
): Promise<{ outfit: OutfitDoc; items: ClothingItemDoc[]; orderedIds: string[] }> {
  const items: ClothingItemDoc[] = [];
  for (let i = 0; i < count; i += 1) {
    items.push(await seedItem(owner));
  }
  const permutation = order ?? items.map((_, i) => i);
  const ordered = permutation.map((i) => items[i]!);
  const outfit = (await Outfit.create({
    userId: owner,
    itemIds: ordered.map((item) => item._id),
  })) as OutfitDoc;
  return { outfit, items, orderedIds: ordered.map((item) => String(item._id)) };
}

async function registerOther(email: string): Promise<{ token: string; id: string }> {
  const res = await request(server)
    .post('/auth/register')
    .send({ name: 'Grace Hopper', email, password: 'password123' });
  return { token: res.body.token, id: res.body.user.id };
}

function share(body: object, as: string | null = token) {
  const req = request(server).post('/community/posts');
  if (as !== null) req.set('Authorization', `Bearer ${as}`);
  return req.send(body);
}

function keysOf(indexes: { key: Record<string, unknown> }[]): string[] {
  return indexes.map((i) => JSON.stringify(i.key));
}

describe('CommunityPost, PostLike and PostSave schemas', () => {
  async function basePost(overrides: Record<string, unknown> = {}) {
    const item = await seedItem(ownerId);
    const outfit = await Outfit.create({ userId: ownerId, itemIds: [item._id] });
    return {
      userId: ownerId,
      outfitId: outfit._id,
      itemIds: [item._id],
      caption: 'A caption',
      ...overrides,
    };
  }

  it('defaults likeCount to 0 and stamps createdAt', async () => {
    const doc = await CommunityPost.create(await basePost());
    expect(doc.likeCount).toBe(0);
    expect(doc.createdAt).toBeInstanceOf(Date);
  });

  it('refuses a caption longer than MAX_CAPTION_LENGTH at the schema, not only at the route', async () => {
    // 280 is accepted and 281 is not, so this cannot pass against a schema
    // whose bound is merely "some number near 280".
    await expect(
      CommunityPost.create(await basePost({ caption: 'x'.repeat(MAX_CAPTION_LENGTH) })),
    ).resolves.toBeDefined();
    await expect(
      CommunityPost.create(await basePost({ caption: 'x'.repeat(MAX_CAPTION_LENGTH + 1) })),
    ).rejects.toThrow(mongoose.Error.ValidationError);
  });

  it('trims the caption and refuses one that is blank after trimming', async () => {
    const doc = await CommunityPost.create(await basePost({ caption: '  spaced  ' }));
    expect(doc.caption).toBe('spaced');
    await expect(CommunityPost.create(await basePost({ caption: '   ' }))).rejects.toThrow(
      mongoose.Error.ValidationError,
    );
  });

  it('refuses a post with no snapshotted items', async () => {
    // `required: true` alone does NOT reject [] on a Mongoose array — an empty
    // array is present. This asserts the explicit non-empty validator.
    await expect(CommunityPost.create(await basePost({ itemIds: [] }))).rejects.toThrow(
      mongoose.Error.ValidationError,
    );
  });

  it('refuses a post with no author, no outfit or no caption', async () => {
    for (const missing of ['userId', 'outfitId', 'caption'] as const) {
      const attrs = await basePost();
      delete (attrs as Record<string, unknown>)[missing];
      await expect(CommunityPost.create(attrs)).rejects.toThrow(mongoose.Error.ValidationError);
    }
  });

  it('refuses a negative likeCount', async () => {
    await expect(CommunityPost.create(await basePost({ likeCount: -1 }))).rejects.toThrow(
      mongoose.Error.ValidationError,
    );
  });

  it('indexes posts for the feed sort and by author, confirmed against the live database', async () => {
    const keys = keysOf(await CommunityPost.collection.indexes());
    // The feed's keyset sort. `_id` is not decoration: without it two posts
    // created in the same millisecond can straddle a page boundary.
    expect(keys).toContain(JSON.stringify({ createdAt: -1, _id: -1 }));
    expect(keys).toContain(JSON.stringify({ userId: 1 }));
  });

  it('makes a like unique per (post, user) in the database, not only in the route', async () => {
    const post = await CommunityPost.create(await basePost());
    const other = await registerOther('like-unique@example.com');

    await PostLike.create({ postId: post._id, userId: ownerId });
    await expect(PostLike.create({ postId: post._id, userId: ownerId })).rejects.toThrow(
      /E11000|duplicate key/i,
    );

    // The index must be COMPOUND. A unique index on postId alone would also
    // reject the duplicate above, and would additionally break both of these —
    // which is the difference this pair exists to see.
    await expect(PostLike.create({ postId: post._id, userId: other.id })).resolves.toBeDefined();
    const second = await CommunityPost.create(await basePost());
    await expect(PostLike.create({ postId: second._id, userId: ownerId })).resolves.toBeDefined();

    const keys = keysOf(await PostLike.collection.indexes());
    expect(keys).toContain(JSON.stringify({ postId: 1, userId: 1 }));
    const unique = (await PostLike.collection.indexes()).find(
      (i) => JSON.stringify(i.key) === JSON.stringify({ postId: 1, userId: 1 }),
    );
    expect(unique?.unique).toBe(true);
  });

  it('makes a save unique per (post, user) and indexes the saved list keyset sort', async () => {
    const post = await CommunityPost.create(await basePost());
    const other = await registerOther('save-unique@example.com');

    await PostSave.create({ postId: post._id, userId: ownerId });
    await expect(PostSave.create({ postId: post._id, userId: ownerId })).rejects.toThrow(
      /E11000|duplicate key/i,
    );
    await expect(PostSave.create({ postId: post._id, userId: other.id })).resolves.toBeDefined();

    const indexes = await PostSave.collection.indexes();
    const keys = keysOf(indexes);
    expect(keys).toContain(JSON.stringify({ postId: 1, userId: 1 }));
    // The saved list is `userId` equality then the same keyset sort the feed
    // uses. Without this it is a collection scan plus an in-memory sort.
    expect(keys).toContain(JSON.stringify({ userId: 1, createdAt: -1, _id: -1 }));
    const unique = indexes.find(
      (i) => JSON.stringify(i.key) === JSON.stringify({ postId: 1, userId: 1 }),
    );
    expect(unique?.unique).toBe(true);
  });

  /**
   * The other end of the unit test on `isDuplicateKeyError`.
   *
   * That file asserts what the predicate classifies; this asserts that what a
   * REAL unique index on a REAL mongod actually raises is a member of that
   * class. Neither test can see the gap between them on its own, and the gap is
   * where a `code` that was a string, or an error the driver wrapped, would
   * live — the interaction upsert would then surface a duplicate as a 500.
   */
  it('raises a duplicate-key error that isDuplicateKeyError recognises', async () => {
    const post = await CommunityPost.create(await basePost());
    for (const Model of [PostLike, PostSave]) {
      await Model.create({ postId: post._id, userId: ownerId });
      const err = await Model.create({ postId: post._id, userId: ownerId }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeDefined();
      expect(isDuplicateKeyError(err)).toBe(true);
    }
  });

  it('refuses a like or a save with no post or no user', async () => {
    const post = await CommunityPost.create(await basePost());
    for (const Model of [PostLike, PostSave]) {
      await expect(Model.create({ postId: post._id })).rejects.toThrow(
        mongoose.Error.ValidationError,
      );
      await expect(Model.create({ userId: ownerId })).rejects.toThrow(
        mongoose.Error.ValidationError,
      );
    }
  });
});

describe('POST /community/posts (FR9, TC-11 — sharing an outfit)', () => {
  it('rejects an unauthenticated share', async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1);
    const res = await share({ outfitId: String(outfit._id), caption: 'Hello' }, null);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(await CommunityPost.countDocuments({})).toBe(0);
  });

  it('creates a post carrying the caption, the author and a zeroed like state', async () => {
    const { outfit, orderedIds } = await seedOutfitWithItems(ownerId, 2);

    const res = await share({ outfitId: String(outfit._id), caption: 'Friday best' });

    expect(res.status).toBe(201);
    expect(res.body.post.caption).toBe('Friday best');
    expect(res.body.post.author).toEqual({ id: ownerId, name: 'Ada Lovelace' });
    expect(res.body.post.likeCount).toBe(0);
    expect(res.body.post.liked).toBe(false);
    expect(res.body.post.saved).toBe(false);
    expect(res.body.post.itemIds).toEqual(orderedIds);
    expect(res.body.post.items).toHaveLength(2);
    expect(res.body.post.createdAt).toEqual(expect.any(String));
    expect(new Date(res.body.post.createdAt).getTime()).not.toBeNaN();

    const doc = await CommunityPost.findById(res.body.post.id).lean();
    expect(doc).not.toBeNull();
    expect(String(doc!.userId)).toBe(ownerId);
    expect(String(doc!.outfitId)).toBe(String(outfit._id));
    expect(doc!.itemIds.map(String)).toEqual(orderedIds);
    expect(doc!.likeCount).toBe(0);
    // Ruling 5, asserted where it is actually decidable in this task: the
    // author is a REF and nothing about them is copied onto the post. An
    // exact key set is what makes that testable before a read endpoint
    // exists — a denormalised `authorName` added later fails right here.
    expect(Object.keys(doc!).sort()).toEqual(
      [
        '_id',
        '__v',
        'caption',
        'createdAt',
        'itemIds',
        'likeCount',
        'outfitId',
        'updatedAt',
        'userId',
      ].sort(),
    );
  });

  it('answers 201, not 200 — the post is a new resource', async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1);
    const res = await share({ outfitId: String(outfit._id), caption: 'New' });
    expect(res.status).toBe(201);
  });

  it("snapshots the outfit's item ids IN THE OUTFIT'S ORDER, not in index order", async () => {
    // Three items whose stored order (c, a, b) is neither _id-ascending nor
    // its own reverse, so both "lost the order" and "reversed the order" are
    // visible as distinct failures.
    const { outfit, items, orderedIds } = await seedOutfitWithItems(ownerId, 3, [2, 0, 1]);
    const ascending = items.map((i) => String(i._id));
    expect(orderedIds).not.toEqual(ascending);
    expect(orderedIds).not.toEqual([...ascending].reverse());
    expect(orderedIds).not.toEqual([...orderedIds].reverse());

    const res = await share({ outfitId: String(outfit._id), caption: 'Ordered' });

    expect(res.status).toBe(201);
    expect(res.body.post.itemIds).toEqual(orderedIds);
    expect(res.body.post.items.map((i: { id: string }) => i.id)).toEqual(orderedIds);

    const doc = await CommunityPost.findById(res.body.post.id).lean();
    expect(doc!.itemIds.map(String)).toEqual(orderedIds);
  });

  it('returns items with signed URLs and never a storage key', async () => {
    const item = await seedItem(ownerId, { thumbnailKey: `items/${ownerId}/thumb.jpg` });
    const outfit = await Outfit.create({ userId: ownerId, itemIds: [item._id] });

    const res = await share({ outfitId: String(outfit._id), caption: 'Signed' });

    expect(res.status).toBe(201);
    expect(res.body.post.items[0].imageUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    expect(res.body.post.items[0].imageUrl).toContain(
      encodeURIComponent(item.imageKey).replace(/%2F/g, '/'),
    );
    expect(res.body.post.items[0].thumbnailUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    expect(JSON.stringify(res.body)).not.toContain('imageKey');
    expect(JSON.stringify(res.body)).not.toContain('thumbnailKey');
  });

  it('does not expose the source outfit id to clients', async () => {
    // Provenance is stored, not published: a post is a snapshot, and reading
    // through to the outfit is what ruling 4 exists to prevent.
    const { outfit } = await seedOutfitWithItems(ownerId, 1);
    const res = await share({ outfitId: String(outfit._id), caption: 'Snapshot' });

    expect(res.status).toBe(201);
    expect(res.body.post.outfitId).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(String(outfit._id));
  });

  it('answers 404 for another user\'s outfit, indistinguishably from one that does not exist', async () => {
    const other = await registerOther('other@example.com');
    const { outfit } = await seedOutfitWithItems(other.id, 2);
    const absent = new mongoose.Types.ObjectId();

    const foreign = await share({ outfitId: String(outfit._id), caption: 'Not mine' });
    const missing = await share({ outfitId: String(absent), caption: 'Not mine' });

    expect(foreign.status).toBe(404);
    // The whole body, not just the status: a distinct message would confirm
    // that an outfit exists at an id the caller has no business knowing about.
    expect(foreign.body).toEqual(missing.body);
    expect(foreign.body.error.message).not.toMatch(/your|owner|permission|forbidden/i);
    // The exact message, because "two 404s match" is also true when the route
    // does not exist at all and both are the generic 'Route not found'. This
    // assertion is what makes the pair above evidence about THIS endpoint.
    expect(foreign.body.error).toEqual({ code: 'NOT_FOUND', message: 'Outfit not found' });
    expect(await CommunityPost.countDocuments({})).toBe(0);
  });

  it('answers 404 for a malformed outfit id, with the same body', async () => {
    const absent = new mongoose.Types.ObjectId();
    const malformed = await share({ outfitId: 'not-an-object-id', caption: 'Bad id' });
    const missing = await share({ outfitId: String(absent), caption: 'Bad id' });

    expect(malformed.status).toBe(404);
    expect(malformed.body).toEqual(missing.body);
    expect(malformed.body.error).toEqual({ code: 'NOT_FOUND', message: 'Outfit not found' });
  });

  it('refuses an empty or whitespace-only caption', async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1);

    for (const caption of ['', '   ', '\t\n  ']) {
      const res = await share({ outfitId: String(outfit._id), caption });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'caption' })]),
      );
    }
    expect(await CommunityPost.countDocuments({})).toBe(0);
  });

  it(`refuses a caption over ${MAX_CAPTION_LENGTH} characters and accepts one of exactly that length`, async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1);

    const tooLong = await share({
      outfitId: String(outfit._id),
      caption: 'x'.repeat(MAX_CAPTION_LENGTH + 1),
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'caption' })]),
    );
    expect(await CommunityPost.countDocuments({})).toBe(0);

    const exact = await share({
      outfitId: String(outfit._id),
      caption: 'y'.repeat(MAX_CAPTION_LENGTH),
    });
    expect(exact.status).toBe(201);
    expect(exact.body.post.caption).toHaveLength(MAX_CAPTION_LENGTH);
  });

  /**
   * The unit the caption bound is measured in — **UTF-16 code units**, not code
   * points — against the real route and a real mongod.
   *
   * The mobile composer counts `caption.length` and sets `maxLength` from the
   * same constant, and its header argues that this is right from zod's `.max()`
   * comparing `String.length` and from Android's `InputFilter.LengthFilter`
   * counting Java `char`s. That was a derivation, and every caption-length test
   * in this file was ASCII, where the two units are identical — so nothing
   * server-side actually pinned it. A silent move to a code-point bound (a zod
   * refinement over `[...caption].length`, a Mongo-side check) would have left
   * the composer promising 140 characters the server had already stopped
   * accepting, and the field cutting the user off at a number the counter never
   * reached.
   *
   * **Three rows, because two are not enough.** 140 emoji accepted and 141
   * refused is equally consistent with a code-point bound of 140. Only the
   * third row — 141 ASCII characters, which is 141 code points, ACCEPTED —
   * rules that out and leaves UTF-16 code units as the only bound that explains
   * all three.
   */
  it('bounds the caption in UTF-16 code units, not code points', async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1);
    const outfitId = String(outfit._id);
    // Non-BMP: one code point, a surrogate pair, so `.length` is 2.
    const COAT = '🧥';
    expect(COAT.length).toBe(2);

    // Row 1 — exactly at the bound in code units, half of it in code points.
    const atBound = COAT.repeat(MAX_CAPTION_LENGTH / 2);
    expect(atBound.length).toBe(MAX_CAPTION_LENGTH);
    expect([...atBound].length).toBe(MAX_CAPTION_LENGTH / 2);

    const accepted = await share({ outfitId, caption: atBound });
    expect(accepted.status).toBe(201);
    // Stored whole, and stored at its code-unit length: no truncation to 140
    // and no re-encoding that would split a surrogate pair.
    expect(accepted.body.post.caption).toBe(atBound);
    expect(accepted.body.post.caption).toHaveLength(MAX_CAPTION_LENGTH);
    const doc = await CommunityPost.findById(accepted.body.post.id).lean();
    expect(doc!.caption).toBe(atBound);
    expect(doc!.caption).toHaveLength(MAX_CAPTION_LENGTH);

    // Row 2 — one emoji further: 282 code units, 141 code points. REFUSED.
    const overBound = COAT.repeat(MAX_CAPTION_LENGTH / 2 + 1);
    expect(overBound.length).toBe(MAX_CAPTION_LENGTH + 2);
    expect([...overBound].length).toBe(MAX_CAPTION_LENGTH / 2 + 1);

    const refused = await share({ outfitId, caption: overBound });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    expect(refused.body.error.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'caption' })]),
    );

    // Row 3 — THE ROW THAT MAKES THE OTHER TWO MEAN SOMETHING. 141 code points
    // and 141 code units: over a code-point bound of 140, under the real one.
    // Accepted, so the bound is not counting code points.
    const asciiPastCodePoints = 'x'.repeat(MAX_CAPTION_LENGTH / 2 + 1);
    expect(asciiPastCodePoints.length).toBe(MAX_CAPTION_LENGTH / 2 + 1);
    expect([...asciiPastCodePoints].length).toBe(MAX_CAPTION_LENGTH / 2 + 1);

    const alsoAccepted = await share({ outfitId, caption: asciiPastCodePoints });
    expect(alsoAccepted.status).toBe(201);
    expect(alsoAccepted.body.post.caption).toBe(asciiPastCodePoints);

    // Two posts, not three: only the over-bound emoji caption was refused.
    expect(await CommunityPost.countDocuments({})).toBe(2);
  });

  it('trims before applying the bound, and stores the trimmed caption', async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1);
    const padded = `   ${'z'.repeat(MAX_CAPTION_LENGTH)}   `;

    const res = await share({ outfitId: String(outfit._id), caption: padded });

    expect(res.status).toBe(201);
    expect(res.body.post.caption).toBe('z'.repeat(MAX_CAPTION_LENGTH));
    const doc = await CommunityPost.findById(res.body.post.id).lean();
    expect(doc!.caption).toBe('z'.repeat(MAX_CAPTION_LENGTH));
  });

  it('refuses a caption that is not a string, and a missing one', async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1);

    const numeric = await share({ outfitId: String(outfit._id), caption: 42 });
    expect(numeric.status).toBe(400);
    const absent = await share({ outfitId: String(outfit._id) });
    expect(absent.status).toBe(400);
    expect(await CommunityPost.countDocuments({})).toBe(0);
  });

  it('refuses an outfitId that is not a string', async () => {
    // A TYPE error is a 400 on the field; a RESOLUTION failure is the
    // indistinguishable 404 above. The two are different answers on purpose:
    // nothing about "you sent a number" reveals whether an outfit exists.
    const numeric = await share({ outfitId: 42, caption: 'Wrong type' });
    expect(numeric.status).toBe(400);
    expect(numeric.body.error.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'outfitId' })]),
    );
  });

  it('refuses to share an outfit that has no items', async () => {
    // Unreachable through `POST /outfits` (MIN_OUTFIT_ITEMS is 1), so it is
    // seeded directly. A post with nothing to render is not a post.
    const outfit = await Outfit.create({ userId: ownerId, itemIds: [] });

    const res = await share({ outfitId: String(outfit._id), caption: 'Nothing here' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await CommunityPost.countDocuments({})).toBe(0);
  });

  it('still shares when SOME items have been deleted, snapshotting every id and returning the rest', async () => {
    // The distinction the previous test does not draw: an outfit with no ids
    // is refused, an outfit whose ids no longer all resolve is not. Ruling 4 —
    // the post keeps the full snapshot and the card renders what is left.
    const { outfit, orderedIds } = await seedOutfitWithItems(ownerId, 3, [2, 0, 1]);
    await ClothingItem.deleteOne({ _id: orderedIds[1] });

    const res = await share({ outfitId: String(outfit._id), caption: 'Partly gone' });

    expect(res.status).toBe(201);
    expect(res.body.post.itemIds).toEqual(orderedIds);
    expect(res.body.post.items.map((i: { id: string }) => i.id)).toEqual([
      orderedIds[0],
      orderedIds[2],
    ]);
    const doc = await CommunityPost.findById(res.body.post.id).lean();
    expect(doc!.itemIds.map(String)).toEqual(orderedIds);
  });

  it('shares an outfit whose every item has been deleted, with the caption intact', async () => {
    const { outfit, orderedIds } = await seedOutfitWithItems(ownerId, 2);
    await ClothingItem.deleteMany({ _id: { $in: orderedIds } });

    const res = await share({ outfitId: String(outfit._id), caption: 'All gone' });

    expect(res.status).toBe(201);
    expect(res.body.post.items).toEqual([]);
    expect(res.body.post.itemIds).toEqual(orderedIds);
    expect(res.body.post.caption).toBe('All gone');
  });

  /**
   * FINDING 4, ON THE CREATE PATH — the half that nothing held.
   *
   * De-duplication lives in `signSnapshotItems`, which both endpoints call, so
   * "the two cannot answer differently" was true of the code as written and
   * pinned by NOTHING. A Stage 9 change that batches item resolution inside the
   * feed handler and bypasses the shared helper would silently drop it here
   * while the feed's own de-duplication test stayed green — measured: removing
   * the `Set` from the helper and re-adding it at the feed call site failed 0
   * of 66 tests. This assertion is what turns that into a red one.
   *
   * Seeded through `Outfit.create` because `POST /outfits` answers 400 for a
   * duplicated id — it refuses rather than dedups, deliberately. The MODEL does
   * not refuse, so the shape is reachable by a direct database write, and a
   * post can be shared from it.
   */
  it('de-duplicates `items` on the CREATE path too, while `itemIds` keeps both', async () => {
    const a = await seedItem(ownerId);
    const b = await seedItem(ownerId);
    const outfit = (await Outfit.create({
      userId: ownerId,
      itemIds: [b._id, a._id, b._id],
    })) as OutfitDoc;

    const res = await share({ outfitId: String(outfit._id), caption: 'Doubled at share time' });

    expect(res.status).toBe(201);
    expect(res.body.post.itemIds).toEqual([String(b._id), String(a._id), String(b._id)]);
    // Each garment once, at its FIRST position — the same answer the feed gives.
    expect(res.body.post.items.map((i: { id: string }) => i.id)).toEqual([
      String(b._id),
      String(a._id),
    ]);
    // The stored snapshot keeps both occurrences: compaction is a property of
    // the wire shape, not of what was written.
    const doc = await CommunityPost.findById(res.body.post.id).lean();
    expect(doc!.itemIds.map(String)).toEqual([String(b._id), String(a._id), String(b._id)]);
  });

  it("never signs an item that belongs to someone else, even when an outfit references one", async () => {
    // The security property of the snapshot query. `POST /outfits` cannot
    // build such an outfit, so this is seeded directly — but the item query
    // must not depend on a write-time guarantee made somewhere else to stay
    // safe, because the FEED calls the same code for other people's posts.
    // Without `userId` in that query this response carries a working signed
    // URL to another user's photograph.
    const other = await registerOther('foreign-item@example.com');
    const mine = await seedItem(ownerId);
    const theirs = await seedItem(other.id);
    const outfit = await Outfit.create({ userId: ownerId, itemIds: [mine._id, theirs._id] });

    const res = await share({ outfitId: String(outfit._id), caption: 'Mixed' });

    expect(res.status).toBe(201);
    expect(res.body.post.itemIds).toEqual([String(mine._id), String(theirs._id)]);
    expect(res.body.post.items.map((i: { id: string }) => i.id)).toEqual([String(mine._id)]);
    // The id itself is in the snapshot and that is correct — an id is not a
    // capability. What must never appear is a URL that opens their photograph.
    expect(JSON.stringify(res.body)).not.toContain(
      encodeURIComponent(theirs.imageKey).replace(/%2F/g, '/'),
    );
    expect(JSON.stringify(res.body)).not.toContain(other.id);
  });

  it("carries the author's avatarUrl when they have one", async () => {
    await User.updateOne({ _id: ownerId }, { $set: { avatarUrl: 'https://cdn.example/ada.png' } });
    const { outfit } = await seedOutfitWithItems(ownerId, 1);

    const res = await share({ outfitId: String(outfit._id), caption: 'With avatar' });

    expect(res.status).toBe(201);
    expect(res.body.post.author).toEqual({
      id: ownerId,
      name: 'Ada Lovelace',
      avatarUrl: 'https://cdn.example/ada.png',
    });
  });

  it("takes the author's name from the user record, not from the request", async () => {
    // Ruling 5: the name is populated, never denormalised or client-supplied.
    await User.updateOne({ _id: ownerId }, { $set: { name: 'Renamed Author' } });
    const { outfit } = await seedOutfitWithItems(ownerId, 1);

    const res = await share({
      outfitId: String(outfit._id),
      caption: 'Whose name?',
      author: { id: 'spoofed', name: 'Attacker' },
    });

    expect(res.status).toBe(201);
    expect(res.body.post.author.name).toBe('Renamed Author');
    expect(res.body.post.author.id).toBe(ownerId);
    expect(JSON.stringify(res.body)).not.toContain('Attacker');
    const doc = await CommunityPost.findById(res.body.post.id).lean();
    expect(doc).not.toHaveProperty('author');
  });

  it('never lets the caller choose the post author', async () => {
    const other = await registerOther('spoof@example.com');
    const { outfit } = await seedOutfitWithItems(ownerId, 1);

    const res = await share({
      outfitId: String(outfit._id),
      caption: 'Mine',
      userId: other.id,
      likeCount: 99,
    });

    expect(res.status).toBe(201);
    expect(res.body.post.author.id).toBe(ownerId);
    expect(res.body.post.likeCount).toBe(0);
    const doc = await CommunityPost.findById(res.body.post.id).lean();
    expect(String(doc!.userId)).toBe(ownerId);
    expect(doc!.likeCount).toBe(0);
  });

  it('refuses a token whose user no longer exists, and writes nothing', async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1);
    await User.deleteOne({ _id: ownerId });

    const res = await share({ outfitId: String(outfit._id), caption: 'Ghost' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(await CommunityPost.countDocuments({})).toBe(0);
  });
});

/**
 * Seed one post DIRECTLY, bypassing `POST /community/posts`.
 *
 * The share endpoint can only ever create a post owned by the caller, with
 * `createdAt` of "now" and `likeCount` of 0. Every property this feed has to
 * get right — other people's posts, a deterministic sort order, a
 * denormalised counter that is not a row count — is unreachable through it.
 *
 * `createdAt` is forced through `collection.updateOne` rather than the
 * model's, because `timestamps: true` manages that path and a Mongoose write
 * would reassert "now" over the value the fixture depends on.
 */
async function seedPost(opts: {
  author: string;
  caption?: string;
  createdAt?: Date;
  itemIds?: (string | mongoose.Types.ObjectId)[];
  outfitId?: mongoose.Types.ObjectId;
  likeCount?: number;
}): Promise<string> {
  const itemIds = opts.itemIds ?? [(await seedItem(opts.author))._id];
  const doc = await CommunityPost.create({
    userId: opts.author,
    // Provenance only, never read through and never published, so a bare id
    // is as real as a seeded outfit here.
    outfitId: opts.outfitId ?? new mongoose.Types.ObjectId(),
    itemIds,
    caption: opts.caption ?? 'A caption',
    ...(opts.likeCount !== undefined ? { likeCount: opts.likeCount } : {}),
  });
  if (opts.createdAt) {
    await CommunityPost.collection.updateOne(
      { _id: doc._id },
      { $set: { createdAt: opts.createdAt } },
    );
  }
  return String(doc._id);
}

type FeedPost = {
  id: string;
  caption: string;
  itemIds: string[];
  items: { id: string; imageUrl: string; thumbnailUrl?: string }[];
  likeCount: number;
  liked: boolean;
  saved: boolean;
  author: { id: string; name: string; avatarUrl?: string };
  createdAt: string;
};

function feed(query: Record<string, string | number> = {}, as: string | null = token) {
  const req = request(server).get('/community/posts').query(query);
  if (as !== null) req.set('Authorization', `Bearer ${as}`);
  return req;
}

/** Raw query string, for the shapes `.query({})` cannot express (repeated keys). */
function feedRaw(queryString: string, as: string | null = token) {
  const req = request(server).get(`/community/posts?${queryString}`);
  if (as !== null) req.set('Authorization', `Bearer ${as}`);
  return req;
}

const ids = (posts: FeedPost[]) => posts.map((p) => p.id);
const captions = (posts: FeedPost[]) => posts.map((p) => p.caption);

describe('GET /community/posts (FR10, TC-12 — the public feed)', () => {
  it('rejects an unauthenticated read', async () => {
    await seedPost({ author: ownerId });

    const res = await feed({}, null);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.posts).toBeUndefined();
  });

  /**
   * RULING 2, AND THIS TEST IS WRITTEN BACKWARDS ON PURPOSE.
   *
   * Every other list endpoint in this API filters by `req.userId`, and every
   * ownership test in this repository asserts that it does. Copy that filter
   * into the feed — one line, from `outfits.ts`, and it reads like every other
   * route in the file — and you get a "community" feed with an audience of
   * one. Not a single existing test goes red, because a `{ userId }` filter is
   * precisely what they all assert.
   *
   * So the failure this guards is the PRESENCE of a filter, and the test is
   * shaped around a viewer who owns NONE of the rows: with the filter, the
   * feed is empty and the assertion below is unmissable. A viewer who happened
   * to have posted would still see something, and the test would be weaker for
   * it — which is why the first assertion pins that they have posted nothing.
   */
  it('returns posts from EVERY user, to a viewer who has posted nothing', async () => {
    const b = await registerOther('feed-b@example.com');
    const c = await registerOther('feed-c@example.com');
    const idB = await seedPost({ author: b.id, caption: 'From B' });
    const idC = await seedPost({ author: c.id, caption: 'From C' });

    const res = await feed();

    expect(res.status).toBe(200);
    // The fixture's own precondition: the viewer authored none of these.
    expect(await CommunityPost.countDocuments({ userId: ownerId })).toBe(0);
    expect(ids(res.body.posts).sort()).toEqual([idB, idC].sort());
    expect(captions(res.body.posts).sort()).toEqual(['From B', 'From C']);
  });

  it("includes the viewer's own posts alongside everyone else's", async () => {
    // The inversion is not "only other people's posts" either. Both halves
    // have to hold, or the feed is a different wrong thing.
    const other = await registerOther('feed-mine@example.com');
    const mine = await seedPost({ author: ownerId, caption: 'Mine' });
    const theirs = await seedPost({ author: other.id, caption: 'Theirs' });

    const res = await feed();

    expect(res.status).toBe(200);
    expect(ids(res.body.posts).sort()).toEqual([mine, theirs].sort());
  });

  /**
   * FINDING 1, MEASURED IN TASK 1'S REVIEW: DROPPING THE INDEX IS NOT ENOUGH.
   *
   * With posts inserted newest-first, `find({}).limit(n)` with no `.sort()` at
   * all is a `LIMIT ← COLLSCAN` that returns the same rows in the same order
   * as the sorted query. The scan alone reproduces the expected answer, so the
   * sort spec can be deleted and a newest-first fixture stays green whether or
   * not the index exists.
   *
   * This fixture therefore inserts OLDEST FIRST, so natural order is the exact
   * REVERSE of the expected answer and a collection scan cannot fake it. The
   * `expect` below the loop is the fixture checking itself: if seeding ever
   * stopped producing an ascending series, this test would quietly become the
   * very thing it exists to avoid.
   */
  it('returns newest first, from a fixture seeded OLDEST first', async () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const seeded: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      seeded.push(
        await seedPost({
          author: ownerId,
          caption: `Post ${i}`,
          createdAt: new Date(base + i * 60_000),
        }),
      );
    }
    const stored = await CommunityPost.find({}).lean();
    expect(stored.map((d) => String(d._id))).toEqual(seeded);

    const res = await feed();

    expect(res.status).toBe(200);
    expect(ids(res.body.posts)).toEqual([...seeded].reverse());
    expect(captions(res.body.posts)).toEqual(['Post 4', 'Post 3', 'Post 2', 'Post 1', 'Post 0']);
    // Insertion order and the answer disagree at every position, which is the
    // property that makes the assertion above evidence about the sort.
    expect(ids(res.body.posts)).not.toEqual(seeded);
  });

  it('breaks a same-millisecond tie by _id descending, and pages across the tie', async () => {
    // Four posts sharing one timestamp. Without `_id` in the sort the order
    // inside the tie is unspecified — in practice natural order, which is the
    // reverse of the answer — and without `_id` in the CURSOR predicate the
    // second page is empty, because nothing has a `createdAt` strictly less
    // than the cursor's.
    const same = new Date('2026-02-02T12:00:00.000Z');
    const seeded: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      seeded.push(await seedPost({ author: ownerId, caption: `Tie ${i}`, createdAt: same }));
    }
    // ObjectIds minted in one process ascend, so the answer is the reverse of
    // the insertion order. Asserted rather than assumed.
    expect(seeded).toEqual([...seeded].sort());
    const expected = [...seeded].reverse();

    const first = await feed({ limit: 2 });
    expect(first.status).toBe(200);
    expect(ids(first.body.posts)).toEqual(expected.slice(0, 2));
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await feed({ limit: 2, cursor: first.body.nextCursor });
    expect(second.status).toBe(200);
    expect(ids(second.body.posts)).toEqual(expected.slice(2, 4));
    expect(second.body.nextCursor).toBeUndefined();
  });

  it('pages the whole feed with the shared cursor helpers, without a gap or a repeat', async () => {
    const other = await registerOther('feed-page@example.com');
    const base = Date.parse('2026-03-03T00:00:00.000Z');
    const seeded: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      seeded.push(
        await seedPost({
          // Alternating authors: paging must not become user-scoped either.
          author: i % 2 === 0 ? ownerId : other.id,
          caption: `P${i}`,
          createdAt: new Date(base + i * 1000),
        }),
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const res: { status: number; body: { posts: FeedPost[]; nextCursor?: string } } = await feed({
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      expect(res.status).toBe(200);
      seen.push(...ids(res.body.posts));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeUndefined();
    expect(seen).toEqual([...seeded].reverse());
    expect(new Set(seen).size).toBe(7);
  });

  it('rejects a limit outside the shared bounds, and honours one inside them', async () => {
    for (const limit of ['0', '101', 'abc', '-1', '1.5', '']) {
      const res = await feed({ limit });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'limit' })]),
      );
    }

    const base = Date.parse('2026-05-05T00:00:00.000Z');
    for (let i = 0; i < 3; i += 1) {
      await seedPost({ author: ownerId, caption: `L${i}`, createdAt: new Date(base + i * 1000) });
    }
    const ok = await feed({ limit: '2' });
    expect(ok.status).toBe(200);
    expect(captions(ok.body.posts)).toEqual(['L2', 'L1']);
    // 100 is the shared maximum and must be accepted, so the bound is pinned
    // from both sides rather than only from above.
    expect((await feed({ limit: '100' })).status).toBe(200);
  });

  it('rejects a malformed cursor rather than silently restarting at page 1', async () => {
    await seedPost({ author: ownerId, caption: 'Only post' });

    for (const cursor of ['not-a-cursor', Buffer.from('nope').toString('base64url')]) {
      const res = await feed({ cursor });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'cursor' })]),
      );
      // A restart would have answered 200 with the page, which is the failure
      // that makes an infinite scroll loop forever with no signal.
      expect(res.body.posts).toBeUndefined();
    }

    const repeated = await feedRaw('cursor=a&cursor=b');
    expect(repeated.status).toBe(400);
    expect(repeated.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns items signed, compacted and in SNAPSHOT order, with the full id list beside them', async () => {
    const other = await registerOther('feed-compact@example.com');
    // Stored order (c, a, b) is neither _id-ascending nor its reverse, so
    // "lost the order" and "reversed the order" fail differently.
    const { outfit, orderedIds } = await seedOutfitWithItems(other.id, 3, [2, 0, 1]);
    await ClothingItem.deleteOne({ _id: orderedIds[1] });
    const id = await seedPost({
      author: other.id,
      itemIds: outfit.itemIds,
      caption: 'Compacted',
    });

    const res = await feed();

    expect(res.status).toBe(200);
    const post: FeedPost = res.body.posts[0];
    expect(post.id).toBe(id);
    // `itemIds` is the uncompacted snapshot; `items` is the compacted render
    // list. They are not parallel arrays and this is where that shows.
    expect(post.itemIds).toEqual(orderedIds);
    expect(post.items.map((i) => i.id)).toEqual([orderedIds[0], orderedIds[2]]);
    // `$in` returns index order, which for these two ids is the reverse.
    expect(post.items.map((i) => i.id)).not.toEqual([orderedIds[2], orderedIds[0]]);
    expect(post.items[0]!.imageUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    expect(JSON.stringify(res.body)).not.toContain('imageKey');
    expect(JSON.stringify(res.body)).not.toContain('thumbnailKey');
  });

  it('signs both URLs when the item has a thumbnail, and points them at the real keys', async () => {
    const other = await registerOther('feed-thumb@example.com');
    const item = await seedItem(other.id, { thumbnailKey: `items/${other.id}/thumb.jpg` });
    await seedPost({ author: other.id, itemIds: [item._id], caption: 'Thumbed' });

    const res = await feed();

    const rendered = res.body.posts[0].items[0];
    expect(rendered.imageUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    expect(rendered.imageUrl).toContain(encodeURIComponent(item.imageKey).replace(/%2F/g, '/'));
    expect(rendered.thumbnailUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    expect(rendered.thumbnailUrl).toContain(`items/${other.id}/thumb.jpg`);
  });

  it('still returns a post whose every item has been deleted, with items: []', async () => {
    const other = await registerOther('feed-empty-items@example.com');
    const { outfit, orderedIds } = await seedOutfitWithItems(other.id, 2);
    const id = await seedPost({ author: other.id, itemIds: outfit.itemIds, caption: 'All gone' });
    await ClothingItem.deleteMany({ _id: { $in: orderedIds } });

    const res = await feed();

    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(1);
    expect(res.body.posts[0]).toMatchObject({
      id,
      items: [],
      itemIds: orderedIds,
      caption: 'All gone',
    });
  });

  /**
   * The item query is scoped to the POST'S AUTHOR, and this is the test that
   * can tell that apart from "scoped to the viewer".
   *
   * The snapshot names one of the author's items and one of the VIEWER's. A
   * feed that resolved items against `req.userId` — the reflex everywhere else
   * in this codebase — would render the viewer's garment on someone else's
   * card and drop the author's. Both halves are asserted, because either alone
   * also passes against an unscoped query.
   */
  it("resolves a post's items against its AUTHOR's wardrobe, never the viewer's", async () => {
    const other = await registerOther('feed-foreign@example.com');
    const mine = await seedItem(ownerId);
    const theirs = await seedItem(other.id);
    await seedPost({ author: other.id, itemIds: [theirs._id, mine._id], caption: 'Mixed' });

    const res = await feed();

    const post: FeedPost = res.body.posts[0];
    expect(post.itemIds).toEqual([String(theirs._id), String(mine._id)]);
    expect(post.items.map((i) => i.id)).toEqual([String(theirs._id)]);
    // An id is not a capability, so the id staying in the snapshot is correct.
    // A working signed URL to the viewer's photograph on another user's card
    // is not.
    expect(JSON.stringify(res.body)).not.toContain(
      encodeURIComponent(mine.imageKey).replace(/%2F/g, '/'),
    );
  });

  /**
   * FINDING 4. An outfit with a duplicated item id is reachable only by direct
   * database write (`POST /outfits` answers 400), but the card's list key is
   * `item.id` and two elements with one key is a defect in any keyed list.
   *
   * DECIDED: `items` de-duplicates, `itemIds` does not. The snapshot stays a
   * faithful record of what was shared; the render list carries each garment
   * once, in first-occurrence order.
   */
  it('de-duplicates a repeated snapshot id in `items` while `itemIds` keeps both', async () => {
    const other = await registerOther('feed-dupe@example.com');
    const a = await seedItem(other.id);
    const b = await seedItem(other.id);
    await seedPost({ author: other.id, itemIds: [b._id, a._id, b._id], caption: 'Doubled' });

    const res = await feed();

    const post: FeedPost = res.body.posts[0];
    expect(post.itemIds).toEqual([String(b._id), String(a._id), String(b._id)]);
    expect(post.items.map((i) => i.id)).toEqual([String(b._id), String(a._id)]);
  });

  /**
   * `liked` AND `saved` ARE PER-VIEWER, AND THIS TEST PROVES IT IN ONE RUN.
   *
   * Two users, one post, DIFFERENT answers. A test that only checks "the user
   * who liked sees `liked: true`" proves the field exists; it does not prove
   * the field is viewer-relative, and a feed returning `liked: <anyone liked
   * this>` passes it comfortably. The third viewer — the author, who did
   * neither — is what stops "always true" passing as well.
   *
   * The two flags are deliberately held by DIFFERENT users, so a feed that
   * read likes into `saved` and saves into `liked` fails on every row.
   */
  it('answers `liked` and `saved` per VIEWER — two users, one post, different values', async () => {
    const authorUser = await registerOther('feed-author@example.com');
    const bob = await registerOther('feed-bob@example.com');
    const id = await seedPost({ author: authorUser.id, caption: 'Who liked me?' });
    await PostLike.create({ postId: id, userId: ownerId });
    await PostSave.create({ postId: id, userId: bob.id });

    const asOwner = await feed({}, token);
    const asBob = await feed({}, bob.token);
    const asAuthor = await feed({}, authorUser.token);

    expect(asOwner.body.posts[0]).toMatchObject({ id, liked: true, saved: false });
    expect(asBob.body.posts[0]).toMatchObject({ id, liked: false, saved: true });
    expect(asAuthor.body.posts[0]).toMatchObject({ id, liked: false, saved: false });
  });

  it('answers `liked` and `saved` per POST, not once for the page', async () => {
    const base = Date.parse('2026-06-06T00:00:00.000Z');
    const older = await seedPost({ author: ownerId, caption: 'Older', createdAt: new Date(base) });
    const newer = await seedPost({
      author: ownerId,
      caption: 'Newer',
      createdAt: new Date(base + 1000),
    });
    await PostLike.create({ postId: newer, userId: ownerId });
    await PostSave.create({ postId: older, userId: ownerId });

    const res = await feed();

    expect(
      res.body.posts.map((p: FeedPost) => [p.caption, p.liked, p.saved]),
    ).toEqual([
      ['Newer', true, false],
      ['Older', false, true],
    ]);
  });

  it('returns the denormalised likeCount rather than counting rows on every read', async () => {
    const id = await seedPost({ author: ownerId, likeCount: 7 });

    const res = await feed();

    expect(res.body.posts[0].likeCount).toBe(7);
    // No like rows exist at all: an implementation that counted them would
    // answer 0 here, which is the whole point of the denormalised counter.
    expect(await PostLike.countDocuments({ postId: id })).toBe(0);
  });

  it('populates the author on every read, so a rename shows on old posts', async () => {
    const other = await registerOther('feed-rename@example.com');
    await seedPost({ author: other.id, caption: 'Before the rename' });
    await User.updateOne(
      { _id: other.id },
      { $set: { name: 'Renamed Author', avatarUrl: 'https://cdn.example/g.png' } },
    );

    const res = await feed();

    expect(res.body.posts[0].author).toEqual({
      id: other.id,
      name: 'Renamed Author',
      avatarUrl: 'https://cdn.example/g.png',
    });
  });

  it('omits avatarUrl entirely when the author has none', async () => {
    const other = await registerOther('feed-noavatar@example.com');
    await seedPost({ author: other.id });

    const res = await feed();

    expect(res.body.posts[0].author).toEqual({ id: other.id, name: 'Grace Hopper' });
    expect(res.body.posts[0].author).not.toHaveProperty('avatarUrl');
  });

  it("never puts an author's email or password hash on the wire", async () => {
    const other = await registerOther('secret-address@example.com');
    await seedPost({ author: other.id });

    const res = await feed();

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('secret-address@example.com');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(res.body.posts[0].author).toEqual({ id: other.id, name: 'Grace Hopper' });
  });

  /**
   * FINDING 2. `loadAuthor` answers 401 when the user record is gone, which is
   * right on the create path — a request that cannot be attributed must write
   * nothing — and catastrophic here.
   *
   * Posts outlive their authors: nothing in this system cascades a user delete
   * onto their posts. Reusing `loadAuthor` per post would mean ONE deleted
   * account takes down the whole feed page for everybody, and a post is public
   * content — losing its author should not remove it or 401 the page.
   */
  it('keeps rendering a post whose author has been deleted, and does not 401 the page', async () => {
    const base = Date.parse('2026-07-07T00:00:00.000Z');
    const ghost = await registerOther('ghost@example.com');
    const live = await registerOther('live@example.com');
    const ghostPost = await seedPost({
      author: ghost.id,
      caption: 'Author gone',
      createdAt: new Date(base),
    });
    const livePost = await seedPost({
      author: live.id,
      caption: 'Author here',
      createdAt: new Date(base + 1000),
    });
    await User.deleteOne({ _id: ghost.id });

    const res = await feed();

    expect(res.status).toBe(200);
    expect(ids(res.body.posts)).toEqual([livePost, ghostPost]);
    expect(res.body.posts[1].caption).toBe('Author gone');
    expect(res.body.posts[1].author).toEqual({ id: ghost.id, name: 'Deleted user' });
    expect(res.body.posts[0].author.name).toBe('Grace Hopper');
  });

  /**
   * RULING 5's cost line and FINDING 2's second half: the page's authors are
   * ONE query, not one per post. Five distinct authors, one `User.find`, and
   * `findById` — which is what `loadAuthor` reaches for — never touched.
   */
  it('resolves authors, likes and saves with one query each for the whole page', async () => {
    const authors = [];
    for (let i = 0; i < 5; i += 1) {
      authors.push(await registerOther(`nplus1-${i}@example.com`));
    }
    for (const a of authors) {
      await seedPost({ author: a.id });
    }

    const userFind = jest.spyOn(User, 'find');
    const userFindById = jest.spyOn(User, 'findById');
    const likeFind = jest.spyOn(PostLike, 'find');
    const saveFind = jest.spyOn(PostSave, 'find');
    const itemFind = jest.spyOn(ClothingItem, 'find');
    try {
      const res = await feed();

      expect(res.status).toBe(200);
      expect(res.body.posts).toHaveLength(5);
      expect(res.body.posts.map((p: FeedPost) => p.author.name)).toEqual(
        Array(5).fill('Grace Hopper'),
      );
      expect(userFindById).not.toHaveBeenCalled();
      expect(userFind).toHaveBeenCalledTimes(1);
      expect(likeFind).toHaveBeenCalledTimes(1);
      expect(saveFind).toHaveBeenCalledTimes(1);
      // THE FOURTH COLLECTION, and the only one this page does NOT batch.
      // `signSnapshotItems` runs once per post — five posts, five item
      // queries — which is a deliberate decision (it consumes the helper Task
      // 1 built for this caller rather than reimplementing it) and the one
      // this task is least sure of. Recorded here so that batching it later is
      // a DELIBERATE edit to a red test rather than a silent change to a
      // number nothing was watching. Not a bound: an exact count, so a
      // regression in either direction shows.
      expect(itemFind).toHaveBeenCalledTimes(5);
    } finally {
      userFind.mockRestore();
      userFindById.mockRestore();
      likeFind.mockRestore();
      saveFind.mockRestore();
      itemFind.mockRestore();
    }
  });

  it('does not publish the source outfit id', async () => {
    const other = await registerOther('feed-provenance@example.com');
    const outfitId = new mongoose.Types.ObjectId();
    await seedPost({ author: other.id, outfitId, caption: 'Snapshot' });

    const res = await feed();

    expect(res.body.posts[0].outfitId).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(String(outfitId));
  });

  /**
   * The EXACT key set, on the envelope and on a post.
   *
   * `not.toContain(outfitId)` above catches the leak it was aimed at and
   * nothing else. This catches the whole class: any field added to the wire
   * later — a denormalised author name, an internal flag, `__v` — has to come
   * through here and be argued for, rather than arriving unnoticed on a public
   * endpoint that hands one user's record to another user.
   */
  it('returns exactly the documented PublicPost shape and nothing else', async () => {
    const other = await registerOther('feed-shape@example.com');
    const item = await seedItem(other.id);
    await seedPost({ author: other.id, itemIds: [item._id], caption: 'Shape' });

    const res = await feed();

    expect(Object.keys(res.body)).toEqual(['posts']);
    expect(Object.keys(res.body.posts[0]).sort()).toEqual(
      [
        'author',
        'caption',
        'createdAt',
        'id',
        'itemIds',
        'items',
        'likeCount',
        'liked',
        'saved',
      ].sort(),
    );
    expect(Object.keys(res.body.posts[0].author).sort()).toEqual(['id', 'name']);
    expect(res.body.posts[0].createdAt).toEqual(expect.any(String));
    expect(new Date(res.body.posts[0].createdAt).getTime()).not.toBeNaN();
  });

  it('returns an empty page and no cursor when nothing has been shared', async () => {
    const res = await feed();

    expect(res.status).toBe(200);
    expect(res.body.posts).toEqual([]);
    expect(res.body.nextCursor).toBeUndefined();
  });

  it('filters by caption with `q`, case-insensitively, across every author', async () => {
    const other = await registerOther('feed-q@example.com');
    const hit = await seedPost({ author: other.id, caption: 'Summer LINEN suit' });
    await seedPost({ author: ownerId, caption: 'Winter wool coat' });

    const res = await feed({ q: 'linen' });

    expect(res.status).toBe(200);
    expect(ids(res.body.posts)).toEqual([hit]);
    // A substring anywhere, not a prefix and not a whole word.
    expect(ids((await feed({ q: 'INEN SU' })).body.posts)).toEqual([hit]);
    expect((await feed({ q: 'cashmere' })).body.posts).toEqual([]);
  });

  /**
   * THE ESCAPE, and why the fixture is shaped this way.
   *
   * `q=.*` matches EVERYTHING as a regex and exactly one caption as a literal,
   * so the escaped and unescaped implementations cannot both pass. `(blue)` is
   * the subtler one: unescaped it is a capture group matching the substring
   * "blue", which silently WIDENS the search rather than breaking it — a
   * failure a "did it return something?" assertion would miss. `[` is not a
   * valid regex at all, so without the escape a client typo becomes a 500.
   */
  it('treats a regex metacharacter in `q` as a literal', async () => {
    const dotStar = await seedPost({ author: ownerId, caption: 'Literally .* here' });
    const parens = await seedPost({ author: ownerId, caption: 'Cotton (blue) shirt' });
    const plain = await seedPost({ author: ownerId, caption: 'Cotton blue shirt' });

    expect(ids((await feed({ q: '.*' })).body.posts)).toEqual([dotStar]);
    expect(ids((await feed({ q: '(blue)' })).body.posts)).toEqual([parens]);

    const bracket = await feed({ q: '[' });
    expect(bracket.status).toBe(200);
    expect(bracket.body.posts).toEqual([]);

    // "Matched nothing" is only evidence if the corpus is non-empty and
    // reachable by a query that does not need escaping.
    expect(await CommunityPost.countDocuments({})).toBe(3);
    expect(ids((await feed({ q: 'Cotton blue' })).body.posts)).toEqual([plain]);
  });

  /**
   * MAJ-1 — THE `?q=` FAILURE THE ESCAPE CANNOT REACH, AND THE TEST SHAPE THAT
   * SEES IT.
   *
   * `escapeRegex` neutralises regex METACHARACTERS. NUL is not one, so it went
   * through untouched and mongod refused the `$regex` outright. Measured end to
   * end before the guard existed: `?q=%00` answered
   * `500 {"error":{"code":"INTERNAL"…}}` with a `MongoServerError: Regular
   * expression cannot contain an embedded null byte` and a driver stack trace
   * in the log — the client's fault reported as the server's, which is exactly
   * what the escape's own comment says escaping prevents.
   *
   * ASSERTED THROUGH THE ROUTE, AND THAT IS THE POINT. The unit suite's
   * question is "does `new RegExp(escapeRegex(x))` compile" — and
   * `new RegExp('\0')` compiles perfectly well, so a unit test of this bug
   * PASSES AGAINST THE BUG. The JS regex engine and Mongo's do not accept the
   * same inputs, and only an answer from the real route sits on the right side
   * of that boundary.
   *
   * `%01`, `%7F` and `%1F` do NOT throw on this mongod. They are refused
   * anyway, because "which control bytes this server build rejects" is not a
   * contract — see `CONTROL_CHARACTERS`.
   */
  it('rejects a `q` carrying a control character with a 400, never a 500', async () => {
    await seedPost({ author: ownerId, caption: 'Anything at all' });

    for (const q of ['%00', 'a%00b', '%20%00%20', '%01', '%1F', '%7F', 'a%09b']) {
      const res = await feedRaw(`q=${q}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'q' })]),
      );
    }

    // The guard sits AFTER the trim, so a term that trims away still means
    // "no filter" — a bare newline or tab is not suddenly a 400.
    for (const blank of ['q=%0A', 'q=%09', 'q=%0D%0A']) {
      const res = await feedRaw(blank);
      expect(res.status).toBe(200);
      expect(captions(res.body.posts)).toEqual(['Anything at all']);
    }

    // And an ordinary term still searches, so "400 for everything" is not what
    // just passed.
    expect(captions((await feed({ q: 'Anything' })).body.posts)).toEqual(['Anything at all']);
  });

  it('keeps the `q` filter on every page, not only the first', async () => {
    const base = Date.parse('2026-04-04T00:00:00.000Z');
    for (let i = 0; i < 4; i += 1) {
      await seedPost({ author: ownerId, caption: `linen ${i}`, createdAt: new Date(base + i * 1000) });
      await seedPost({
        author: ownerId,
        caption: `wool ${i}`,
        createdAt: new Date(base + i * 1000 + 500),
      });
    }

    const first = await feed({ q: 'linen', limit: 2 });
    expect(first.status).toBe(200);
    expect(captions(first.body.posts)).toEqual(['linen 3', 'linen 2']);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await feed({ q: 'linen', limit: 2, cursor: first.body.nextCursor });
    expect(second.status).toBe(200);
    // A page 2 that forgot the filter would return the interleaved wool posts.
    expect(captions(second.body.posts)).toEqual(['linen 1', 'linen 0']);
    expect(second.body.nextCursor).toBeUndefined();
  });

  it('rejects a repeated `q`, and treats a blank one as no filter', async () => {
    await seedPost({ author: ownerId, caption: 'Anything at all' });

    const repeated = await feedRaw('q=a&q=b');
    expect(repeated.status).toBe(400);
    expect(repeated.body.error.code).toBe('VALIDATION_FAILED');
    expect(repeated.body.error.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'q' })]),
    );

    // An empty search box is not a search for the empty string.
    for (const blank of ['q=', 'q=%20%20']) {
      const res = await feedRaw(blank);
      expect(res.status).toBe(200);
      expect(captions(res.body.posts)).toEqual(['Anything at all']);
    }
  });
});

/**
 * Task 3's endpoints: like, save, the saved list, and delete-your-own-post.
 *
 * The helpers below post to the route rather than writing rows, because these
 * suites are about what the ROUTE does. Where a test is about the saved LIST
 * rather than the save ENDPOINT it seeds `PostSave` directly instead — that
 * separation is deliberate, and it is what keeps a mutation in the save
 * endpoint from failing every paging test and drowning the signal.
 */
function like(id: string, as: string | null = token) {
  const req = request(server).post(`/community/posts/${id}/like`);
  if (as !== null) req.set('Authorization', `Bearer ${as}`);
  return req.send();
}

function unlike(id: string, as: string | null = token) {
  const req = request(server).delete(`/community/posts/${id}/like`);
  if (as !== null) req.set('Authorization', `Bearer ${as}`);
  return req.send();
}

function save(id: string, as: string | null = token) {
  const req = request(server).post(`/community/posts/${id}/save`);
  if (as !== null) req.set('Authorization', `Bearer ${as}`);
  return req.send();
}

function unsave(id: string, as: string | null = token) {
  const req = request(server).delete(`/community/posts/${id}/save`);
  if (as !== null) req.set('Authorization', `Bearer ${as}`);
  return req.send();
}

function savedList(query: Record<string, string | number> = {}, as: string | null = token) {
  const req = request(server).get('/community/saved').query(query);
  if (as !== null) req.set('Authorization', `Bearer ${as}`);
  return req;
}

function removePost(id: string, as: string | null = token) {
  const req = request(server).delete(`/community/posts/${id}`);
  if (as !== null) req.set('Authorization', `Bearer ${as}`);
  return req.send();
}

/**
 * Seed a save row DIRECTLY, with a chosen save time.
 *
 * `createdAt` goes through `collection.updateOne` for the reason `seedPost`
 * documents: `timestamps: true` manages that path, and a Mongoose write would
 * reassert "now" over the value the fixture depends on. The saved list sorts on
 * this field, so a fixture that could not control it could not tell a list
 * ordered by save time from one ordered by post time.
 */
async function seedSave(postId: string, userId: string, createdAt?: Date): Promise<string> {
  const doc = await PostSave.create({ postId, userId });
  if (createdAt) {
    await PostSave.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });
  }
  return String(doc._id);
}

/** One post as the feed sees it, or undefined when the feed does not carry it. */
async function feedPost(id: string, as: string | null = token): Promise<FeedPost | undefined> {
  const res = await feed({}, as);
  return (res.body.posts as FeedPost[]).find((p) => p.id === id);
}

/**
 * A post with its signed URLs reduced to their object paths.
 *
 * A presigned URL carries `X-Amz-Date` and a signature, so two signings of one
 * key seconds apart are not string-equal. The PATH is the part that says which
 * object is being pointed at, which is the part two endpoints have to agree on.
 */
function withoutSignatures(post: FeedPost): FeedPost {
  return {
    ...post,
    items: post.items.map((item) => ({
      ...item,
      imageUrl: new URL(item.imageUrl).pathname,
      ...(item.thumbnailUrl ? { thumbnailUrl: new URL(item.thumbnailUrl).pathname } : {}),
    })),
  };
}

describe('POST/DELETE /community/posts/:id/like (FR10, TC-12 — "like count increments")', () => {
  it('rejects an unauthenticated like and unlike, and writes nothing', async () => {
    const id = await seedPost({ author: ownerId });

    const liked = await like(id, null);
    const unliked = await unlike(id, null);

    expect(liked.status).toBe(401);
    expect(unliked.status).toBe(401);
    expect(liked.body.error.code).toBe('UNAUTHORIZED');
    expect(await PostLike.countDocuments({})).toBe(0);
    expect((await CommunityPost.findById(id))?.likeCount).toBe(0);
  });

  /**
   * TC-12, FIRST HALF, AND THE ONE TEST THAT MUST FAIL IF THE COUNTER STOPS
   * MOVING.
   *
   * Three different observers of the same fact, because each can fail while
   * the others hold: the endpoint's own answer, the stored counter, and what a
   * later reader of the FEED sees. The third is the one that matters to a user
   * and the one a route returning a number it never wrote would sail past.
   */
  it('increments the like count, records the like, and the feed agrees', async () => {
    const author = await registerOther('like-tc12@example.com');
    const id = await seedPost({ author: author.id, caption: 'Like me' });

    const res = await like(id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ likeCount: 1, liked: true });
    expect((await CommunityPost.findById(id))?.likeCount).toBe(1);
    expect(await PostLike.countDocuments({ postId: id, userId: ownerId })).toBe(1);

    const asViewer = await feedPost(id);
    expect(asViewer).toMatchObject({ likeCount: 1, liked: true, saved: false });

    // VIEWER-RELATIVE, and the count is not: the author sees the same count
    // and their own `liked` false.
    const asAuthor = await feedPost(id, author.token);
    expect(asAuthor).toMatchObject({ likeCount: 1, liked: false });
  });

  /**
   * RULING 3. The defect this project has already shipped twice.
   *
   * `likeCount` after two taps is 1, not 2 — and the second response is
   * identical to the first, so a client has nothing to branch on and a retry of
   * a request whose reply was lost is safe.
   */
  it('does not move the count on a second like from the same user', async () => {
    const author = await registerOther('like-double@example.com');
    const id = await seedPost({ author: author.id });

    const first = await like(id);
    const second = await like(id);

    expect(first.body).toEqual({ likeCount: 1, liked: true });
    expect(second.body).toEqual({ likeCount: 1, liked: true });
    expect(second.status).toBe(200);
    expect((await CommunityPost.findById(id))?.likeCount).toBe(1);
    expect(await PostLike.countDocuments({ postId: id })).toBe(1);
  });

  /**
   * The other half of idempotency, and it is not decoration: a route that
   * incremented only the FIRST time a post was ever liked by anyone would pass
   * the test above and be a different, quieter defect.
   */
  it('counts two different users separately', async () => {
    const bob = await registerOther('like-bob@example.com');
    const id = await seedPost({ author: ownerId });

    expect((await like(id)).body).toEqual({ likeCount: 1, liked: true });
    expect((await like(id, bob.token)).body).toEqual({ likeCount: 2, liked: true });
    expect((await CommunityPost.findById(id))?.likeCount).toBe(2);
    expect(await PostLike.countDocuments({ postId: id })).toBe(2);
  });

  /**
   * THE DOUBLE TAP AS A CLIENT ACTUALLY PRODUCES IT — eight requests in flight
   * at once, not eight one after another.
   *
   * WHAT THIS TEST IS, AND WHAT IT IS NOT.
   *
   * IT IS end-to-end idempotency evidence, and it is stable: the invariants
   * below hold under every interleaving of correct code, so it cannot produce
   * a false red. It stayed green across ~30 consecutive full runs.
   *
   * IT IS NOT the falsifier for the unique index, and an earlier version of
   * this comment claimed it was. MEASURED: dropping `unique: true` from
   * `PostLike` fails exactly two tests, and this is not one of them — in the
   * implementer's run and again in the reviewer's. Its twin on the save side
   * caught the equivalent mutation in one run and not the other, which is the
   * definition of unreliable.
   *
   * WHY: through HTTP the eight requests do not stay concurrent enough to
   * reproduce what driver-level upserts do. MEASURED against mongod 8.2.12:
   * 40 rounds of 16 concurrent upserts on a fresh key produced exactly one row
   * every time WITH the unique index — and ZERO duplicate-key errors, because
   * mongod retries an upsert conflict internally — while WITHOUT it up to
   * SEVEN rows per round appeared. The route never sees the race the index
   * exists to win.
   *
   * THE FALSIFIER OF RECORD for the unique index is the model-level test
   * `makes a like unique per (post, user) in the database, not only in the
   * route`, which asserts `unique: true` on the LIVE index and that a real
   * duplicate insert raises an E11000 that `isDuplicateKeyError` classifies.
   * It caught the mutation deterministically in both runs. DO NOT DELETE IT AS
   * REDUNDANT TO THIS ONE — this one does not cover it.
   */
  it('increments once for eight simultaneous likes from one finger', async () => {
    const author = await registerOther('like-race@example.com');
    const id = await seedPost({ author: author.id });

    const responses = await Promise.all(Array.from({ length: 8 }, () => like(id)));

    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(responses.every((r) => r.body.liked === true)).toBe(true);
    // THE STORED COUNT IS THE ONE THAT HAS TO BE EXACT.
    expect(await PostLike.countDocuments({ postId: id })).toBe(1);
    expect((await CommunityPost.findById(id))?.likeCount).toBe(1);
    // Each REPLY is a snapshot, and this asserts the half of it that is a
    // guarantee: no reply ever reports MORE than the truth. The seven requests
    // that did not insert answer with the count as they read it, and a run of
    // this test was observed where some of them read 0 — the winner had not
    // committed its increment yet. An inflated count could not hide here: the
    // stored assertion above and this maximum both move the moment a second
    // request manages to increment.
    expect(Math.max(...responses.map((r) => r.body.likeCount as number))).toBe(1);
  });

  it('unlikes: removes the row, decrements the count, and the feed agrees', async () => {
    const author = await registerOther('unlike@example.com');
    const bob = await registerOther('unlike-bob@example.com');
    const id = await seedPost({ author: author.id });
    await like(id);
    await like(id, bob.token);

    const res = await unlike(id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ likeCount: 1, liked: false });
    expect((await CommunityPost.findById(id))?.likeCount).toBe(1);
    expect(await PostLike.countDocuments({ postId: id, userId: ownerId })).toBe(0);
    expect(await feedPost(id)).toMatchObject({ likeCount: 1, liked: false });
    // Bob's like is untouched, so the decrement removed one like rather than
    // the post's likes.
    expect(await feedPost(id, bob.token)).toMatchObject({ likeCount: 1, liked: true });
  });

  /**
   * THE `deletedCount === 1` GATE, AND THIS FIXTURE IS SHAPED TO SEE IT
   * WITHOUT A NEGATIVE NUMBER.
   *
   * MEASURED IN TASK 1: `min: 0` on `CommunityPost.likeCount` does NOT apply to
   * an `$inc` — not even with `runValidators: true`, which drove the counter to
   * -2 — so there is no schema floor and a route-level assertion that "it never
   * goes negative" would be true with or without that bound. The gate is
   * therefore the only floor, and the failure it prevents needs no negative
   * number to show: a post with 4 likes and a viewer who never liked it loses
   * one of somebody ELSE's likes on an ungated decrement.
   */
  it('leaves the count alone when the unliker never liked the post', async () => {
    const author = await registerOther('unlike-never@example.com');
    const id = await seedPost({ author: author.id, likeCount: 4 });

    const res = await unlike(id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ likeCount: 4, liked: false });
    expect((await CommunityPost.findById(id))?.likeCount).toBe(4);
  });

  it('leaves the count alone on a second unlike, having decremented once', async () => {
    const author = await registerOther('unlike-twice@example.com');
    const id = await seedPost({ author: author.id, likeCount: 3 });
    await like(id);
    expect((await CommunityPost.findById(id))?.likeCount).toBe(4);

    expect((await unlike(id)).body).toEqual({ likeCount: 3, liked: false });
    expect((await unlike(id)).body).toEqual({ likeCount: 3, liked: false });
    expect((await CommunityPost.findById(id))?.likeCount).toBe(3);
  });

  it("never removes another user's like row", async () => {
    const bob = await registerOther('unlike-scope@example.com');
    const id = await seedPost({ author: ownerId });
    await like(id, bob.token);

    const res = await unlike(id);

    expect(res.body).toEqual({ likeCount: 1, liked: false });
    expect(await PostLike.countDocuments({ postId: id, userId: bob.id })).toBe(1);
    expect((await CommunityPost.findById(id))?.likeCount).toBe(1);
  });

  it('answers one 404 for an unknown post, a malformed id and a control character, and writes nothing', async () => {
    const gone = String(new mongoose.Types.ObjectId());

    const unknown = await like(gone);
    const malformed = await like('not-an-id');
    const nul = await like('%00');
    const unknownUnlike = await unlike(gone);

    for (const res of [unknown, malformed, nul, unknownUnlike]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Post not found' } });
    }
    expect(await PostLike.countDocuments({})).toBe(0);
  });

  /**
   * THE TWO HALVES OF TC-12 ARE TWO MECHANISMS, and this is what says so from
   * the endpoint side: liking writes no save and moves no save, saving writes
   * no like and moves no counter.
   */
  it('likes without saving, and saves without liking or counting', async () => {
    const author = await registerOther('like-save-split@example.com');
    const id = await seedPost({ author: author.id });

    await like(id);
    expect(await PostSave.countDocuments({})).toBe(0);
    expect(await feedPost(id)).toMatchObject({ liked: true, saved: false, likeCount: 1 });

    await unlike(id);
    await save(id);
    expect(await PostLike.countDocuments({})).toBe(0);
    expect((await CommunityPost.findById(id))?.likeCount).toBe(0);
    expect(await feedPost(id)).toMatchObject({ liked: false, saved: true, likeCount: 0 });
  });

  /**
   * THE RETHROW IN `recordInteraction`'s CATCH, ASSERTED AT THE ROUTE'S ANSWER.
   *
   * That catch exists to treat a duplicate key as "somebody else inserted this
   * row first". Everything ELSE it could catch is a real write failure, and
   * swallowing one would answer `liked: true` over a row that was never
   * written — the endpoint reporting work it did not do, which is the exact
   * shape of defect this stage's TC-12 turns on.
   *
   * The unit test on `isDuplicateKeyError` cannot see this: it asserts the
   * predicate's classification, and a catch that ignored the predicate
   * entirely would leave every one of its assertions green. Finding 6's lesson
   * — assert the ROUTE's answer, not the helper's behaviour — applied to a
   * branch that only a stubbed failure can reach.
   */
  it('surfaces a write failure that is not a duplicate key instead of reporting a like it never wrote', async () => {
    const author = await registerOther('like-write-fails@example.com');
    const id = await seedPost({ author: author.id });
    // The handler logs an unexpected error server-side and keeps it out of the
    // response. Spied rather than silenced, so the logging stays covered and
    // this suite's output stays pristine — the technique `errors.test.ts` uses.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const updateOne = jest
      .spyOn(PostLike, 'updateOne')
      .mockImplementation((() =>
        Promise.reject(new Error('replica set stepped down'))) as never);

    try {
      const res = await like(id);

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL');
      // Never `liked: true` over a write that failed.
      expect(res.body.liked).toBeUndefined();
      expect(await PostLike.countDocuments({})).toBe(0);
      // Asserted BEFORE the restore: `mockRestore` clears the call record as
      // well as the implementation, so a check afterwards reads zero calls no
      // matter what happened — which is how this assertion first went green
      // against a handler that had logged nothing at all.
      expect(consoleError).toHaveBeenCalledWith(
        'Unhandled error:',
        expect.objectContaining({ message: 'replica set stepped down' }),
      );
    } finally {
      updateOne.mockRestore();
      consoleError.mockRestore();
    }

    expect((await CommunityPost.findById(id))?.likeCount).toBe(0);
  });

  /**
   * THE RACE THE `!updated` BRANCH IN THE LIKE HANDLER EXISTS FOR, attacked
   * rather than asserted to be untestable.
   *
   * No test can order two requests INSIDE one handler, so this cannot pin which
   * interleaving happened. What it can do is hammer the window and assert the
   * invariant that must hold across every interleaving: a like row never
   * outlives the post it points at, and neither request ever answers 500. A
   * handler that inserted the row and walked away from a post deleted
   * underneath it would leave rows behind here.
   */
  it('leaves no like row behind when a delete lands mid-like, and never answers 500', async () => {
    const bob = await registerOther('like-vs-delete@example.com');

    for (let round = 0; round < 20; round += 1) {
      const id = await seedPost({ author: ownerId });
      const [liked, deleted] = await Promise.all([like(id, bob.token), removePost(id)]);
      expect([200, 404]).toContain(liked.status);
      expect(deleted.status).toBe(204);
    }

    expect(await CommunityPost.countDocuments({})).toBe(0);
    expect(await PostLike.countDocuments({})).toBe(0);
  });
});

describe('POST/DELETE /community/posts/:id/save (FR10, TC-12 — "added to the saved list")', () => {
  it('rejects an unauthenticated save and unsave, and writes nothing', async () => {
    const id = await seedPost({ author: ownerId });

    const saved = await save(id, null);
    const unsaved = await unsave(id, null);

    expect(saved.status).toBe(401);
    expect(unsaved.status).toBe(401);
    expect(saved.body.error.code).toBe('UNAUTHORIZED');
    expect(await PostSave.countDocuments({})).toBe(0);
  });

  /**
   * TC-12, SECOND HALF, AND THE ONE TEST THAT MUST FAIL IF SAVING STOPS
   * PUTTING THE POST IN THE LIST.
   *
   * The list is the claim — "post added to user's saved list" — so the
   * assertion is the LIST's answer, not the save row. A route that answered
   * `{ saved: true }` and wrote nothing passes any assertion about its own
   * reply; it cannot pass this one.
   */
  it('adds the post to the saved list, and the feed agrees', async () => {
    const author = await registerOther('save-tc12@example.com');
    const id = await seedPost({ author: author.id, caption: 'Save me' });

    const res = await save(id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: true });

    const list = await savedList();
    expect(list.status).toBe(200);
    expect(ids(list.body.posts)).toEqual([id]);
    expect(captions(list.body.posts)).toEqual(['Save me']);
    expect(await feedPost(id)).toMatchObject({ saved: true });

    // Nobody else's list moved.
    expect(ids((await savedList({}, author.token)).body.posts)).toEqual([]);
  });

  it('does not add the post twice on a second save', async () => {
    const author = await registerOther('save-double@example.com');
    const id = await seedPost({ author: author.id });

    const first = await save(id);
    const second = await save(id);

    expect(first.body).toEqual({ saved: true });
    expect(second.body).toEqual({ saved: true });
    expect(second.status).toBe(200);
    expect(await PostSave.countDocuments({ postId: id })).toBe(1);
    expect(ids((await savedList()).body.posts)).toEqual([id]);
  });

  /**
   * The save-side twin of the like race above, and it carries the same caveat:
   * end-to-end idempotency evidence, NOT the falsifier for `PostSave`'s unique
   * index. MEASURED: dropping `unique: true` from `PostSave` was caught by this
   * test in the reviewer's run and NOT in the implementer's — the same mutation,
   * two honest runs, two different answers. The deterministic falsifier is the
   * model-level uniqueness test; see the long note on the like race for why the
   * route cannot see this race.
   */
  it('adds it once for eight simultaneous saves from one finger', async () => {
    const author = await registerOther('save-race@example.com');
    const id = await seedPost({ author: author.id });

    const responses = await Promise.all(Array.from({ length: 8 }, () => save(id)));

    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(await PostSave.countDocuments({ postId: id })).toBe(1);
    expect(ids((await savedList()).body.posts)).toEqual([id]);
  });

  it('unsaves: takes the post out of the list', async () => {
    const author = await registerOther('unsave@example.com');
    const id = await seedPost({ author: author.id });
    await save(id);

    const res = await unsave(id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: false });
    expect(ids((await savedList()).body.posts)).toEqual([]);
    expect(await feedPost(id)).toMatchObject({ saved: false });
  });

  it("never removes another user's save row", async () => {
    const bob = await registerOther('unsave-scope@example.com');
    const id = await seedPost({ author: ownerId });
    await save(id, bob.token);

    const res = await unsave(id);

    expect(res.body).toEqual({ saved: false });
    expect(ids((await savedList({}, bob.token)).body.posts)).toEqual([id]);
    expect(await PostSave.countDocuments({ postId: id, userId: bob.id })).toBe(1);
  });

  it('answers one 404 for an unknown post, a malformed id and a control character, and writes nothing', async () => {
    const gone = String(new mongoose.Types.ObjectId());

    const unknown = await save(gone);
    const malformed = await save('not-an-id');
    const nul = await save('%00');
    const unknownUnsave = await unsave(gone);

    for (const res of [unknown, malformed, nul, unknownUnsave]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Post not found' } });
    }
    expect(await PostSave.countDocuments({})).toBe(0);
  });
});

describe('GET /community/saved (the viewer\'s saved list)', () => {
  it('rejects an unauthenticated read', async () => {
    const id = await seedPost({ author: ownerId });
    await seedSave(id, ownerId);

    const res = await savedList({}, null);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.posts).toBeUndefined();
  });

  /**
   * RULING 2, THE ORDINARY WAY ROUND — and the danger here is the mirror image
   * of the feed's. The feed twenty lines up must NOT filter by the caller, so
   * `const filter = {}` is correct there; copied down here it reads as
   * consistency with the file it sits in and hands every user everybody else's
   * bookmarks. A saved list is private.
   */
  it("returns the viewer's own saved posts and never another user's", async () => {
    const other = await registerOther('saved-scope@example.com');
    const mine = await seedPost({ author: other.id, caption: 'Mine' });
    const theirs = await seedPost({ author: ownerId, caption: 'Theirs' });
    await seedSave(mine, ownerId);
    await seedSave(theirs, other.id);

    const asOwner = await savedList();
    const asOther = await savedList({}, other.token);

    expect(asOwner.status).toBe(200);
    expect(captions(asOwner.body.posts)).toEqual(['Mine']);
    expect(captions(asOther.body.posts)).toEqual(['Theirs']);
    // The fixture's own precondition: two saves exist, one per user, so an
    // unscoped list would return two rows to each of them.
    expect(await PostSave.countDocuments({})).toBe(2);
  });

  /**
   * NEWEST SAVE FIRST, NOT NEWEST POST.
   *
   * The two posts are saved in the OPPOSITE order to the one they were posted
   * in, so the two mistakes this can make — sorting by the post's `createdAt`,
   * or sorting the saves the wrong way up — both produce the same wrong answer
   * and neither can look like the right one.
   */
  it('orders by when the post was SAVED, not by when it was posted', async () => {
    const author = await registerOther('saved-order@example.com');
    const posted = Date.parse('2026-02-02T00:00:00.000Z');
    const savedAt = Date.parse('2026-03-03T00:00:00.000Z');
    const older = await seedPost({
      author: author.id,
      caption: 'Posted first',
      createdAt: new Date(posted),
    });
    const newer = await seedPost({
      author: author.id,
      caption: 'Posted second',
      createdAt: new Date(posted + 60_000),
    });
    await seedSave(newer, ownerId, new Date(savedAt));
    await seedSave(older, ownerId, new Date(savedAt + 60_000));

    const res = await savedList();

    expect(captions(res.body.posts)).toEqual(['Posted first', 'Posted second']);
  });

  it('pages the whole list with the shared cursor helpers, without a gap or a repeat', async () => {
    const author = await registerOther('saved-page@example.com');
    const base = Date.parse('2026-07-07T00:00:00.000Z');
    const expected: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await seedPost({ author: author.id, caption: `saved ${i}` });
      await seedSave(id, ownerId, new Date(base + i * 1000));
      expected.unshift(`saved ${i}`);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const res = await savedList({ limit: 2, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      seen.push(...captions(res.body.posts));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeUndefined();
    expect(seen).toEqual(expected);
  });

  it('pages across same-millisecond saves without dropping or repeating one', async () => {
    const author = await registerOther('saved-tie@example.com');
    const at = new Date(Date.parse('2026-08-08T00:00:00.000Z'));
    const captured: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await seedPost({ author: author.id, caption: `tie ${i}` });
      await seedSave(id, ownerId, at);
      captured.push(`tie ${i}`);
    }

    const first = await savedList({ limit: 2 });
    const second = await savedList({ limit: 2, cursor: first.body.nextCursor });

    const seen = [...captions(first.body.posts), ...captions(second.body.posts)];
    expect(seen).toHaveLength(3);
    expect([...seen].sort()).toEqual([...captured].sort());
    expect(second.body.nextCursor).toBeUndefined();
  });

  /**
   * ONE POST, TWO LISTS, ONE SHAPE.
   *
   * The saved list and the feed resolve a post through the same helper on
   * purpose: a card must not describe itself differently depending on which
   * list it arrived in. This compares the whole object rather than a field —
   * anything that drifts, including a field added to one path and not the
   * other, comes through here.
   */
  it('returns a saved post in exactly the shape the feed returns it in', async () => {
    const author = await registerOther('saved-shape@example.com');
    const item = await seedItem(author.id, { thumbnailKey: `thumbs/${author.id}/x.jpg` });
    const id = await seedPost({ author: author.id, itemIds: [item._id], caption: 'Shape' });
    await like(id);
    await save(id);

    const fromFeed = await feedPost(id);
    const fromSaved = ((await savedList()).body.posts as FeedPost[]).find((p) => p.id === id);

    expect(fromSaved).toBeDefined();
    expect(withoutSignatures(fromSaved!)).toEqual(withoutSignatures(fromFeed!));
    expect(fromSaved).toMatchObject({ likeCount: 1, liked: true, saved: true });
    expect(fromSaved!.items).toHaveLength(1);
    expect(fromSaved!.author.name).toBe('Grace Hopper');
  });

  /**
   * A save row whose post is gone is only reachable by a direct database write,
   * because deleting a post cascades its saves. It is seeded here anyway: the
   * alternative to compacting is a page that 500s on a row the user cannot see
   * and therefore cannot clear.
   */
  it('skips a saved post that no longer exists rather than failing the page', async () => {
    const author = await registerOther('saved-orphan@example.com');
    const alive = await seedPost({ author: author.id, caption: 'Alive' });
    const ghost = String(new mongoose.Types.ObjectId());
    await seedSave(ghost, ownerId, new Date(Date.parse('2026-09-09T00:00:00.000Z')));
    await seedSave(alive, ownerId, new Date(Date.parse('2026-09-08T00:00:00.000Z')));

    const res = await savedList();

    expect(res.status).toBe(200);
    expect(captions(res.body.posts)).toEqual(['Alive']);
  });

  it('rejects a malformed cursor and an out-of-range limit with the feed\'s own bodies', async () => {
    const badCursor = await savedList({ cursor: 'not-a-cursor' });
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.code).toBe('VALIDATION_FAILED');
    // Byte-identical to the feed's: both lists page with the shared helpers, so
    // a client that learned one endpoint's error shape can parse the other's.
    expect(badCursor.body).toEqual((await feed({ cursor: 'not-a-cursor' })).body);

    const badLimit = await savedList({ limit: 0 });
    expect(badLimit.status).toBe(400);
    expect(badLimit.body).toEqual((await feed({ limit: 0 })).body);
  });

  it('returns an empty page and no cursor when the viewer has saved nothing', async () => {
    await seedPost({ author: ownerId });

    const res = await savedList();

    expect(res.status).toBe(200);
    expect(res.body.posts).toEqual([]);
    expect(res.body.nextCursor).toBeUndefined();
  });
});

/**
 * RULING 7 — BEYOND THE DOCUMENTS, ADDED FOR SAFETY.
 *
 * No submitted document claims delete-your-own-post. It is built anyway because
 * publishing to a public feed with no way to retract is a user-harm gap rather
 * than a feature gap, and it is recorded as an addition in `VERIFICATION.md` so
 * Stage 10 does not mistake it for a claim being discharged.
 */
describe('DELETE /community/posts/:id (ruling 7 — retracting your own post)', () => {
  it('rejects an unauthenticated delete, and the post survives', async () => {
    const id = await seedPost({ author: ownerId });

    const res = await removePost(id, null);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(await CommunityPost.countDocuments({ _id: id })).toBe(1);
  });

  it('deletes your own post and takes it out of the feed', async () => {
    const keep = await seedPost({ author: ownerId, caption: 'Keep' });
    const id = await seedPost({ author: ownerId, caption: 'Retract' });

    const res = await removePost(id);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(await CommunityPost.countDocuments({ _id: id })).toBe(0);
    expect(captions((await feed()).body.posts)).toEqual(['Keep']);
    expect(await CommunityPost.countDocuments({ _id: keep })).toBe(1);
  });

  /**
   * OWNER-SCOPED, and the 404 is the same body a post that never existed gets.
   *
   * Any difference between "not found" and "not yours" turns this endpoint into
   * an oracle over which of the ids on a feed page belong to whom — and the
   * feed hands every viewer a page of other people's ids by design.
   */
  it("answers one 404 for another user's post, an unknown id and a malformed id", async () => {
    const other = await registerOther('delete-foreign@example.com');
    const theirs = await seedPost({ author: other.id, caption: 'Theirs' });

    const foreign = await removePost(theirs);
    const unknown = await removePost(String(new mongoose.Types.ObjectId()));
    const malformed = await removePost('not-an-id');

    for (const res of [foreign, unknown, malformed]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Post not found' } });
    }
    // Not deleted, and still readable by everyone: the refusal is about who may
    // retract it, not about who may see it.
    expect(await CommunityPost.countDocuments({ _id: theirs })).toBe(1);
    expect(captions((await feed()).body.posts)).toEqual(['Theirs']);
  });

  it("cascades the deleted post's likes", async () => {
    const bob = await registerOther('delete-cascade-like@example.com');
    const id = await seedPost({ author: ownerId });
    const survivor = await seedPost({ author: ownerId });
    await like(id, bob.token);
    await like(id);
    await like(survivor, bob.token);

    expect(await removePost(id)).toMatchObject({ status: 204 });

    expect(await PostLike.countDocuments({ postId: id })).toBe(0);
    // Only THAT post's likes: a cascade with no filter would take the whole
    // collection with it and nothing else in this file would notice.
    expect(await PostLike.countDocuments({ postId: survivor })).toBe(1);
  });

  /**
   * The cascade a USER can see. A stale `PostSave` would sit in somebody else's
   * saved list forever: they cannot delete it, because the endpoint that
   * removes a save 404s once the post is gone.
   */
  it("cascades the deleted post's saves, and clears it from the list that held it", async () => {
    const bob = await registerOther('delete-cascade-save@example.com');
    const id = await seedPost({ author: ownerId, caption: 'Retract' });
    const survivor = await seedPost({ author: ownerId, caption: 'Survivor' });
    await save(id, bob.token);
    await save(survivor, bob.token);
    expect(captions((await savedList({}, bob.token)).body.posts)).toEqual(
      expect.arrayContaining(['Retract', 'Survivor']),
    );

    expect(await removePost(id)).toMatchObject({ status: 204 });

    expect(await PostSave.countDocuments({ postId: id })).toBe(0);
    expect(captions((await savedList({}, bob.token)).body.posts)).toEqual(['Survivor']);
    expect(await PostSave.countDocuments({ postId: survivor })).toBe(1);
  });

  it('leaves interaction rows alone when the delete is refused', async () => {
    const other = await registerOther('delete-refused@example.com');
    const theirs = await seedPost({ author: other.id });
    await like(theirs);
    await save(theirs);

    expect((await removePost(theirs, token)).status).toBe(404);

    expect(await PostLike.countDocuments({ postId: theirs })).toBe(1);
    expect(await PostSave.countDocuments({ postId: theirs })).toBe(1);
    expect((await CommunityPost.findById(theirs))?.likeCount).toBe(1);
  });
});
