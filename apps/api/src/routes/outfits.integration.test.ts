import request from 'supertest';
import mongoose from 'mongoose';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { connectDatabase } from '../db';
import { User } from '../models/User';
import { ClothingItem, type ClothingItemDoc } from '../models/ClothingItem';
import { Outfit } from '../models/Outfit';
import { createStorageProvider } from '../storage/MinioStorageProvider';

const config = loadConfig({ JWT_SECRET: 'outfits-test-secret', MONGO_URL: process.env.MONGO_URL });
const storage = createStorageProvider(config);
const okChecks = {
  database: async () => 'ok' as const,
  storage: async () => 'ok' as const,
  ai: async () => 'ok' as const,
};
const app = createApp(okChecks, config, storage);

/**
 * One HTTP server for the whole file, instead of one per request.
 *
 * `request(server)` makes supertest create a fresh `http.createServer` and
 * `app.listen(0)` it for EVERY request, closing it immediately afterwards. Its
 * `serverAddress` only does that when the app is not already listening, so
 * handing it a listening server removes the per-request listen/close entirely.
 *
 * That churn is what made this suite flaky: a torn-down ephemeral port can be
 * recycled by the OS for a later request, and a socket held open against the
 * old server then carries a reply belonging to another exchange. Observed
 * twice as a concatenated-JSON parse failure and once as a test reading
 * another test's 404 -- including, tellingly, during a mutation run whose
 * patch could not reach the failing tests at all.
 */
let server: Server;

const SORT_INDEX_NAME = 'userId_1_createdAt_-1__id_-1';

let token = '';
let ownerId = '';

beforeAll(async () => {
  server = app.listen(0);
  await connectDatabase(config.mongoUrl);
  await User.init();
  await ClothingItem.init();
  await Outfit.init();
}, 30000);

beforeEach(async () => {
  await User.deleteMany({});
  await ClothingItem.deleteMany({});
  await Outfit.deleteMany({});
  const res = await request(server)
    .post('/auth/register')
    .send({ name: 'Owner', email: 'owner@example.com', password: 'password123' });
  token = res.body.token;
  ownerId = res.body.user.id;
});

afterAll(async () => {
  await User.deleteMany({});
  await ClothingItem.deleteMany({});
  await Outfit.deleteMany({});
  await mongoose.disconnect();
  // closeAllConnections first: `close()` alone waits for live sockets and
  // would hang this hook rather than fail it.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function seedItem(
  owner: string,
  overrides: Record<string, unknown> = {},
): Promise<ClothingItemDoc> {
  return (await ClothingItem.create({
    userId: owner,
    imageKey: `items/${owner}/${randomUUID()}.jpg`,
    category: 'tshirt',
    source: 'manual',
    ...overrides,
  })) as ClothingItemDoc;
}

async function registerOther(email: string): Promise<{ token: string; id: string }> {
  const res = await request(server)
    .post('/auth/register')
    .send({ name: 'Other', email, password: 'password123' });
  return { token: res.body.token, id: res.body.user.id };
}

function post(body: object, as = token) {
  return request(server).post('/outfits').set('Authorization', `Bearer ${as}`).send(body);
}

function list(query = '', as = token) {
  return request(server).get(`/outfits${query}`).set('Authorization', `Bearer ${as}`);
}

describe('POST /outfits (TC-07 outfit creation)', () => {
  it("creates an outfit from several of the caller's items", async () => {
    const [a, b, c] = await Promise.all([
      seedItem(ownerId),
      seedItem(ownerId),
      seedItem(ownerId),
    ]);

    const res = await post({ name: 'Friday', itemIds: [a, b, c].map((d) => String(d._id)) });

    expect(res.status).toBe(201);
    expect(res.body.outfit.name).toBe('Friday');
    expect(res.body.outfit.itemCount).toBe(3);
    expect(res.body.outfit.userId).toBe(ownerId);

    const doc = await Outfit.findById(res.body.outfit.id).lean();
    expect(doc).not.toBeNull();
    expect(doc!.itemIds).toHaveLength(3);
  });

  it('preserves the order of itemIds as sent', async () => {
    const [a, b, c] = await Promise.all([
      seedItem(ownerId),
      seedItem(ownerId),
      seedItem(ownerId),
    ]);
    // Deliberately not ascending _id order: a $in lookup returns index order,
    // so this fails unless the request order is reapplied.
    const sent = [String(c._id), String(a._id), String(b._id)];

    const res = await post({ itemIds: sent });

    expect(res.status).toBe(201);
    expect(res.body.outfit.itemIds).toEqual(sent);

    const doc = await Outfit.findById(res.body.outfit.id).lean();
    expect(doc!.itemIds.map((id) => String(id))).toEqual(sent);
  });

  it('stores an optional name and omits it when blank', async () => {
    const item = await seedItem(ownerId);
    const ids = [String(item._id)];

    const named = await post({ name: '  Trimmed  ', itemIds: ids });
    expect(named.body.outfit.name).toBe('Trimmed');

    const blank = await post({ name: '   ', itemIds: ids });
    expect(blank.status).toBe(201);
    expect(blank.body.outfit.name).toBeUndefined();

    const absent = await post({ itemIds: ids });
    expect(absent.body.outfit.name).toBeUndefined();
  });

  it('rejects a malformed JSON body with 400, not 500', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(server)
        .post('/outfits')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"itemIds": [');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      // A healthy server must not log a stack trace for a client's typo.
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects an empty itemIds array with 400', async () => {
    const res = await post({ itemIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await Outfit.countDocuments({})).toBe(0);
  });

  it('rejects more than 20 itemIds with 400', async () => {
    const items = await Promise.all(Array.from({ length: 21 }, () => seedItem(ownerId)));
    const res = await post({ itemIds: items.map((d) => String(d._id)) });
    expect(res.status).toBe(400);
    expect(await Outfit.countDocuments({})).toBe(0);
  });

  it('rejects duplicate itemIds with 400', async () => {
    const item = await seedItem(ownerId);
    const id = String(item._id);
    const res = await post({ itemIds: [id, id] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Duplicate items');
    expect(await Outfit.countDocuments({})).toBe(0);
  });

  it('rejects a retired item with 400, distinct from Unknown item', async () => {
    const active = await seedItem(ownerId);
    const retired = await seedItem(ownerId, { retired: true });

    const res = await post({ itemIds: [String(active._id), String(retired._id)] });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Item is retired');
    expect(res.body.error.message).not.toBe('Unknown item');
    expect(await Outfit.countDocuments({})).toBe(0);
  });

  it('rejects a malformed itemId with 400', async () => {
    const res = await post({ itemIds: ['not-an-object-id'] });
    expect(res.status).toBe(400);
    expect(await Outfit.countDocuments({})).toBe(0);
  });

  it("REJECTS an itemId belonging to another user with 400", async () => {
    // The security test. GET /outfits/:id returns signed URLs for an outfit's
    // items, so accepting a foreign id here would hand any authenticated user
    // working links to another user's photographs.
    const other = await registerOther('other@example.com');
    const theirs = await seedItem(other.id);
    const mine = await seedItem(ownerId);

    const res = await post({ itemIds: [String(mine._id), String(theirs._id)] });

    expect(res.status).toBe(400);
    expect(await Outfit.countDocuments({})).toBe(0);
    // Must not confirm the item exists.
    expect(JSON.stringify(res.body)).not.toContain(String(theirs._id));
  });

  it("gives an identical error for a nonexistent id and another user's id", async () => {
    const other = await registerOther('other2@example.com');
    const theirs = await seedItem(other.id);
    const ghost = new mongoose.Types.ObjectId();

    const foreign = await post({ itemIds: [String(theirs._id)] });
    const missing = await post({ itemIds: [String(ghost)] });

    // Both being 500 would also satisfy "identical", so pin the status first.
    expect(foreign.status).toBe(400);
    expect(missing.status).toBe(400);
    expect(foreign.body).toEqual(missing.body);
  });

  it('treats an uppercase-hex itemId as the same item', async () => {
    // An ObjectId's hex form is case-insensitive, so this is the SAME id. It
    // must resolve to the same document, not fall through a string-keyed
    // lookup and leave a hole where a document belongs.
    const item = await seedItem(ownerId, {
      thumbnailKey: `items/${ownerId}/${randomUUID()}-thumb.jpg`,
    });
    const upper = String(item._id).toUpperCase();
    expect(upper).not.toBe(String(item._id));

    const res = await post({ itemIds: [upper] });

    expect(res.status).toBe(201);
    // The cover proves the document was actually resolved, not just counted.
    expect(res.body.outfit.coverUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    // What is stored and returned is the canonical form, not the caller's casing.
    expect(res.body.outfit.itemIds).toEqual([String(item._id)]);
  });

  it('reports a case-variant duplicate as a duplicate, not as a missing item', async () => {
    const item = await seedItem(ownerId);
    const id = String(item._id);

    const res = await post({ itemIds: [id, id.toUpperCase()] });

    expect(res.status).toBe(400);
    // Comparing raw strings would let this past the dedup check and then
    // misreport it as "Unknown item" when the client sent one item twice.
    expect(res.body.error.message).toBe('Duplicate items');
    expect(await Outfit.countDocuments({})).toBe(0);
  });

  it('rejects a name longer than 80 characters, measured after trimming', async () => {
    const item = await seedItem(ownerId);
    const ids = [String(item._id)];

    const tooLong = await post({ name: 'x'.repeat(81), itemIds: ids });
    expect(tooLong.status).toBe(400);

    // Padded to 84 characters but only 80 once trimmed: the name the user
    // asked for is legal, so bounding before the trim would wrongly reject it.
    const padded = await post({ name: `  ${'x'.repeat(80)}  `, itemIds: ids });
    expect(padded.status).toBe(201);
    expect(padded.body.outfit.name).toBe('x'.repeat(80));
  });

  it('returns a signed coverUrl derived from the first item', async () => {
    const withThumb = await seedItem(ownerId, {
      thumbnailKey: `items/${ownerId}/${randomUUID()}-thumb.jpg`,
    });
    const plain = await seedItem(ownerId);

    const res = await post({ itemIds: [String(withThumb._id), String(plain._id)] });

    expect(res.status).toBe(201);
    expect(res.body.outfit.coverUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    // Derived from the FIRST item's thumbnail, not the second item and not the
    // first item's full image.
    expect(res.body.outfit.coverUrl).toContain(encodeURIComponent(withThumb.thumbnailKey!).replace(/%2F/g, '/'));
  });

  it('derives the cover from the first item SENT, not the lowest item id', async () => {
    // Seed order and request order are deliberately opposed. A `$in` lookup
    // returns index order (_id ascending), so an implementation that trusts
    // the query's order picks `first` and passes a naive cover test. Sending
    // [second, first] and asserting the cover is `second`'s is what makes the
    // reordering observable at all.
    const first = await seedItem(ownerId, {
      thumbnailKey: `items/${ownerId}/aaa-thumb.jpg`,
    });
    const second = await seedItem(ownerId, {
      thumbnailKey: `items/${ownerId}/zzz-thumb.jpg`,
    });
    expect(String(first._id) < String(second._id)).toBe(true);

    const res = await post({ itemIds: [String(second._id), String(first._id)] });

    expect(res.status).toBe(201);
    expect(res.body.outfit.coverUrl).toContain('zzz-thumb.jpg');
    expect(res.body.outfit.coverUrl).not.toContain('aaa-thumb.jpg');
  });

  it('falls back to the full image when the first item has no thumbnail', async () => {
    const plain = await seedItem(ownerId);
    const res = await post({ itemIds: [String(plain._id)] });
    expect(res.status).toBe(201);
    expect(res.body.outfit.coverUrl).toContain(encodeURIComponent(plain.imageKey).replace(/%2F/g, '/'));
  });
});

describe('GET /outfits', () => {
  async function seedOutfit(owner: string, overrides: Record<string, unknown> = {}) {
    const item = await seedItem(owner);
    return Outfit.create({ userId: owner, itemIds: [item._id], ...overrides });
  }

  it("returns only the caller's outfits", async () => {
    const other = await registerOther('other3@example.com');
    await seedOutfit(ownerId, { name: 'Mine' });
    await seedOutfit(other.id, { name: 'Theirs' });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.outfits).toHaveLength(1);
    expect(res.body.outfits[0].name).toBe('Mine');
  });

  it('returns outfits newest first', async () => {
    await seedOutfit(ownerId, { name: 'old', createdAt: new Date('2026-08-01T00:00:00.000Z') });
    await seedOutfit(ownerId, { name: 'mid', createdAt: new Date('2026-08-10T00:00:00.000Z') });
    await seedOutfit(ownerId, { name: 'new', createdAt: new Date('2026-08-20T00:00:00.000Z') });

    const res = await list();

    expect(res.body.outfits.map((o: { name: string }) => o.name)).toEqual(['new', 'mid', 'old']);
  });

  it('pages with a cursor without repeating or skipping', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedOutfit(ownerId, {
        name: `o${i}`,
        createdAt: new Date(Date.UTC(2026, 7, 1 + i)),
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const q = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await list(q);
      expect(res.status).toBe(200);
      seen.push(...res.body.outfits.map((o: { id: string }) => o.id));
      cursor = res.body.nextCursor;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeUndefined();
  });

  it('omits nextCursor on the final page', async () => {
    await seedOutfit(ownerId);
    // A 500 body is `{error:{...}}`, which also has no `nextCursor` — so
    // asserting its absence alone passes against a thrown handler. Status and
    // page shape are what make this test about paging.
    const res = await list('?limit=24');
    expect(res.status).toBe(200);
    expect(res.body.outfits).toHaveLength(1);
    expect('nextCursor' in res.body).toBe(false);
  });

  it('rejects a malformed cursor with 400', async () => {
    const res = await list('?cursor=!!!not-base64!!!');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.outfits).toBeUndefined();
  });

  it('defaults to a page size of 24', async () => {
    for (let i = 0; i < 25; i += 1) {
      await seedOutfit(ownerId, { createdAt: new Date(Date.UTC(2026, 7, 1, 0, i)) });
    }
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.outfits).toHaveLength(24);
    expect(res.body.nextCursor).toEqual(expect.any(String));
  }, 30000);

  it('accepts limit=100 at the upper boundary', async () => {
    await seedOutfit(ownerId);
    const res = await list('?limit=100');
    expect(res.status).toBe(200);
    expect(res.body.outfits).toHaveLength(1);
  });

  it('rejects limit=0 and limit=101 with 400', async () => {
    expect((await list('?limit=0')).status).toBe(400);
    expect((await list('?limit=101')).status).toBe(400);
    expect((await list('?limit=abc')).status).toBe(400);
  });

  it('reports itemCount', async () => {
    const items = await Promise.all([seedItem(ownerId), seedItem(ownerId), seedItem(ownerId)]);
    await Outfit.create({ userId: ownerId, itemIds: items.map((d) => d._id) });

    const res = await list();
    expect(res.body.outfits[0].itemCount).toBe(3);
    expect(res.body.outfits[0].itemIds).toHaveLength(3);
  });

  it('omits coverUrl when the first item cannot be resolved', async () => {
    const item = await seedItem(ownerId);
    await Outfit.create({ userId: ownerId, itemIds: [item._id] });
    // No cascade exists in this system, so this is only reachable by a direct
    // deletion — the point is that the list degrades rather than 500s.
    await ClothingItem.deleteOne({ _id: item._id });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.outfits).toHaveLength(1);
    expect(res.body.outfits[0].coverUrl).toBeUndefined();
    expect(res.body.outfits[0].itemCount).toBe(1);
  });

  it('still separates same-millisecond outfits when no index can supply the tie order', async () => {
    // The compound index is itself _id-descending within equal createdAt and is
    // the winning plan, so it hands ties back correctly regardless of the sort
    // spec. Dropping it forces an in-memory sort, where only the sort spec's
    // `_id: -1` can separate the pair. Stage 4 established this technique.
    await Outfit.collection.dropIndex(SORT_INDEX_NAME);
    try {
      const sameInstant = new Date('2026-08-24T10:30:00.000Z');
      const first = await seedOutfit(ownerId, { createdAt: sameInstant });
      const second = await seedOutfit(ownerId, { createdAt: sameInstant });
      const [lower, higher] = [String(first._id), String(second._id)].sort();

      const page1 = await list('?limit=1');
      expect(page1.body.outfits).toHaveLength(1);
      expect(page1.body.nextCursor).toEqual(expect.any(String));

      const page2 = await list(`?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
      expect(page2.body.outfits).toHaveLength(1);

      expect([page1.body.outfits[0].id, page2.body.outfits[0].id]).toEqual([higher, lower]);
    } finally {
      // createIndexes, not syncIndexes: syncIndexes also DROPS indexes absent
      // from the schema, which is not this test's business on a shared database.
      await Outfit.createIndexes();
    }
  }, 30000);
});

function detail(id: string, as = token) {
  return request(server).get(`/outfits/${id}`).set('Authorization', `Bearer ${as}`);
}

function patchOutfit(id: string, body: object, as = token) {
  return request(server).patch(`/outfits/${id}`).set('Authorization', `Bearer ${as}`).send(body);
}

function removeOutfit(id: string, as = token) {
  return request(server).delete(`/outfits/${id}`).set('Authorization', `Bearer ${as}`);
}

/**
 * Seed an outfit together with the items it references.
 *
 * The items are created in sequence, not concurrently, so their ObjectIds
 * ascend. That is what lets an ordering test send them in a different order
 * and observe the difference: a `$in` lookup returns _id-ascending order, so
 * seed order and request order have to be opposable for the reordering to be
 * visible at all.
 */
async function seedOutfitWithItems(
  owner: string,
  count = 2,
  overrides: Record<string, unknown> = {},
) {
  const items: ClothingItemDoc[] = [];
  for (let i = 0; i < count; i += 1) {
    items.push(await seedItem(owner));
  }
  const outfit = await Outfit.create({
    userId: owner,
    itemIds: items.map((item) => item._id),
    ...overrides,
  });
  return { outfit, items, ids: items.map((item) => String(item._id)) };
}

const MALFORMED_ID = 'not-an-object-id';

/**
 * `OutfitDoc` does not declare the timestamps the schema adds, so a lean read
 * has to be told they are there -- the same cast `toPublicOutfit` makes.
 */
async function readTimestamps(id: unknown): Promise<{ createdAt: Date; updatedAt: Date }> {
  const doc = await Outfit.findById(id).lean();
  return doc as unknown as { createdAt: Date; updatedAt: Date };
}

describe('GET /outfits/:id', () => {
  it('returns the outfit with its items resolved', async () => {
    const { outfit, ids } = await seedOutfitWithItems(ownerId, 2);

    const res = await detail(String(outfit._id));

    expect(res.status).toBe(200);
    expect(res.body.outfit.id).toBe(String(outfit._id));
    expect(res.body.outfit.userId).toBe(ownerId);
    expect(res.body.outfit.itemIds).toEqual(ids);
    expect(res.body.outfit.itemCount).toBe(2);
    // The whole point of the detail endpoint: the items themselves, signed, so
    // the detail screen renders without N extra round trips.
    expect(res.body.outfit.items).toHaveLength(2);
    expect(res.body.outfit.items.map((i: { id: string }) => i.id)).toEqual(ids);
    expect(res.body.outfit.items[0].imageUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    // The list endpoint carries a cover; the detail endpoint carries the items
    // instead. The asymmetry is deliberate and is pinned here.
    expect(res.body.outfit.coverUrl).toBeUndefined();
  });

  it('orders items to match itemIds', async () => {
    const { items } = await seedOutfitWithItems(ownerId, 3);
    const [a, b, c] = items;
    // Seeded in ascending _id order, so [c, a, b] is NOT what a $in returns.
    expect(String(a._id) < String(b._id)).toBe(true);
    expect(String(b._id) < String(c._id)).toBe(true);

    const composed = await Outfit.create({
      userId: ownerId,
      itemIds: [c._id, a._id, b._id],
    });

    const res = await detail(String(composed._id));

    expect(res.status).toBe(200);
    const sent = [c, a, b].map((d) => String(d._id));
    expect(res.body.outfit.itemIds).toEqual(sent);
    expect(res.body.outfit.items.map((i: { id: string }) => i.id)).toEqual(sent);
  });

  it('skips an item that no longer resolves and still returns 200', async () => {
    const { outfit, items, ids } = await seedOutfitWithItems(ownerId, 3);
    // No cascade exists in this system, so this is only reachable by a direct
    // deletion. The detail screen must degrade, not 500.
    await ClothingItem.deleteOne({ _id: items[1]._id });

    const res = await detail(String(outfit._id));

    expect(res.status).toBe(200);
    expect(res.body.outfit.itemIds).toEqual(ids);
    expect(res.body.outfit.itemCount).toBe(3);
    // Shorter than itemIds, and both are returned so a client can see the gap.
    expect(res.body.outfit.items).toHaveLength(2);
    expect(res.body.outfit.items.map((i: { id: string }) => i.id)).toEqual([ids[0], ids[2]]);
  });

  it("does not resolve an item the outfit's owner does not own", async () => {
    // The ONLY security mechanism on the read path, and the one a future
    // reader is most likely to delete as redundant.
    //
    // Task 1 removed a guard because a mutation proved it could not fail
    // alone, and recorded the rule: a guard that cannot fail alone is not
    // defence in depth, it is untestable weight. That rule does NOT reach this
    // filter, and the difference is the point. Task 1's count check guarded an
    // invariant established two lines above it in the same function. This
    // filter guards ANOTHER function's invariant -- `resolveOwnedItems`, on
    // the write path -- and this endpoint hands back signed URLs. The moment
    // any other writer (Stage 7's suggestion engine, an import, a migration)
    // puts a foreign id in `itemIds`, this filter is the only thing between an
    // attacker and a working link to another user's photograph.
    //
    // So the id is written straight into the document here, bypassing the API
    // that refuses it -- which is exactly the situation the filter exists for.
    const other = await registerOther('detail-foreign-item@example.com');
    const theirs = await seedItem(other.id, {
      thumbnailKey: `items/${other.id}/${randomUUID()}-thumb.jpg`,
    });
    const { outfit, ids } = await seedOutfitWithItems(ownerId, 1);
    await Outfit.updateOne({ _id: outfit._id }, { $push: { itemIds: theirs._id } });

    const res = await detail(String(outfit._id));

    expect(res.status).toBe(200);
    // The id is echoed, because it really is in the document...
    expect(res.body.outfit.itemIds).toEqual([...ids, String(theirs._id)]);
    expect(res.body.outfit.itemCount).toBe(2);
    // ...but it is never resolved, so no signed URL for it is ever produced.
    expect(res.body.outfit.items.map((i: { id: string }) => i.id)).toEqual(ids);
    expect(JSON.stringify(res.body)).not.toContain(theirs.imageKey);
    expect(JSON.stringify(res.body)).not.toContain(theirs.thumbnailKey!);
  });

  it("returns 404 for another user's outfit", async () => {
    const other = await registerOther('detail-other@example.com');
    const { outfit } = await seedOutfitWithItems(other.id, 1);

    const res = await detail(String(outfit._id));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // Not the router's own "Route not found": that would pass even if this
    // route did not exist at all.
    expect(res.body.error.message).toBe('Outfit not found');
  });

  it('returns 404 for a malformed id', async () => {
    const res = await detail(MALFORMED_ID);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // Not the router's own "Route not found": that would pass even if this
    // route did not exist at all.
    expect(res.body.error.message).toBe('Outfit not found');
  });

  it('returns an identical body for both 404 cases', async () => {
    const other = await registerOther('detail-other2@example.com');
    const { outfit } = await seedOutfitWithItems(other.id, 1);

    const foreign = await detail(String(outfit._id));
    const malformed = await detail(MALFORMED_ID);

    // Both being 500 would also satisfy "identical", so pin the status first.
    expect(foreign.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(foreign.body.error.message).toBe('Outfit not found');
    expect(foreign.body).toEqual(malformed.body);
  });
});

describe('PATCH /outfits/:id (edit)', () => {
  it('renames an outfit', async () => {
    const { outfit, ids } = await seedOutfitWithItems(ownerId, 2, { name: 'Old' });

    const res = await patchOutfit(String(outfit._id), { name: '  New  ' });

    expect(res.status).toBe(200);
    expect(res.body.outfit.name).toBe('New');
    // The items are untouched by a rename.
    expect(res.body.outfit.itemIds).toEqual(ids);
    expect(res.body.outfit.items).toHaveLength(2);

    const doc = await Outfit.findById(outfit._id).lean();
    expect(doc!.name).toBe('New');
  });

  it('clears the name when sent an empty string', async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1, { name: 'Old' });

    const res = await patchOutfit(String(outfit._id), { name: '' });

    expect(res.status).toBe(200);
    expect(res.body.outfit.name).toBeUndefined();
    const doc = await Outfit.findById(outfit._id).lean();
    expect(doc!.name).toBeUndefined();

    // Whitespace-only is the same operation: a name of spaces is not a name.
    await Outfit.updateOne({ _id: outfit._id }, { $set: { name: 'Back' } });
    const blank = await patchOutfit(String(outfit._id), { name: '   ' });
    expect(blank.status).toBe(200);
    expect(blank.body.outfit.name).toBeUndefined();
    expect((await Outfit.findById(outfit._id).lean())!.name).toBeUndefined();
  });

  it('leaves the name unchanged when name is omitted', async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1, { name: 'Keep me' });
    const replacement = await seedItem(ownerId);

    // Patching only itemIds. Omitting `name` means "do not touch it", which is
    // a different operation from clearing it -- conflating the two means a
    // user can never remove a name.
    const res = await patchOutfit(String(outfit._id), { itemIds: [String(replacement._id)] });

    expect(res.status).toBe(200);
    expect(res.body.outfit.name).toBe('Keep me');
    expect((await Outfit.findById(outfit._id).lean())!.name).toBe('Keep me');
  });

  it('replaces itemIds and reorders items accordingly', async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1);
    const a = await seedItem(ownerId);
    const b = await seedItem(ownerId);
    const c = await seedItem(ownerId);
    expect(String(a._id) < String(c._id)).toBe(true);
    const sent = [String(c._id), String(a._id), String(b._id)];

    const res = await patchOutfit(String(outfit._id), { itemIds: sent });

    expect(res.status).toBe(200);
    expect(res.body.outfit.itemIds).toEqual(sent);
    expect(res.body.outfit.itemCount).toBe(3);
    expect(res.body.outfit.items.map((i: { id: string }) => i.id)).toEqual(sent);

    const doc = await Outfit.findById(outfit._id).lean();
    expect(doc!.itemIds.map((id) => String(id))).toEqual(sent);
  });

  it('rejects a patch with neither name nor itemIds with 400', async () => {
    const { outfit, ids } = await seedOutfitWithItems(ownerId, 2, { name: 'Untouched' });

    const res = await patchOutfit(String(outfit._id), {});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const doc = await Outfit.findById(outfit._id).lean();
    expect(doc!.name).toBe('Untouched');
    expect(doc!.itemIds.map((id) => String(id))).toEqual(ids);
  });

  it("REJECTS itemIds containing another user's item with 400", async () => {
    // THE SECOND SECURITY TEST. PATCH is a separate code path from POST, and a
    // shared helper is not proof that this path calls it: editing a foreign
    // item into an outfit would hand back signed URLs for another user's
    // photographs exactly as creating one would.
    const other = await registerOther('patch-attacker-victim@example.com');
    const theirs = await seedItem(other.id, {
      thumbnailKey: `items/${other.id}/${randomUUID()}-thumb.jpg`,
    });
    const { outfit, ids } = await seedOutfitWithItems(ownerId, 1);
    const mine = await seedItem(ownerId);

    const res = await patchOutfit(String(outfit._id), {
      itemIds: [String(mine._id), String(theirs._id)],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    // No signed URL for anything, and no confirmation the item exists.
    expect(JSON.stringify(res.body)).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(res.body)).not.toContain(String(theirs._id));
    expect(JSON.stringify(res.body)).not.toContain(theirs.imageKey);

    // Nothing was written: the outfit still holds only its original item.
    const doc = await Outfit.findById(outfit._id).lean();
    expect(doc!.itemIds.map((id) => String(id))).toEqual(ids);

    // And a follow-up read cannot surface the foreign item either.
    const after = await detail(String(outfit._id));
    expect(after.body.outfit.items.map((i: { id: string }) => i.id)).toEqual(ids);
  });

  it('rejects a retired item when itemIds is resupplied', async () => {
    const { outfit, ids } = await seedOutfitWithItems(ownerId, 1);
    const retired = await seedItem(ownerId, { retired: true });

    const res = await patchOutfit(String(outfit._id), {
      itemIds: [...ids, String(retired._id)],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Item is retired');
    const doc = await Outfit.findById(outfit._id).lean();
    expect(doc!.itemIds.map((each) => String(each))).toEqual(ids);
  });

  it('leaves an outfit alone when a member item is retired AFTER it was saved, on a name-only patch', async () => {
    const { outfit, ids } = await seedOutfitWithItems(ownerId, 1);
    await ClothingItem.updateOne({ _id: ids[0] }, { retired: true });

    // `resolveOwnedItems` only runs when itemIds is (re)supplied — a rename
    // must not force the caller to first remove a since-retired member.
    const res = await patchOutfit(String(outfit._id), { name: 'Still fine' });

    expect(res.status).toBe(200);
    expect(res.body.outfit.name).toBe('Still fine');
    const doc = await Outfit.findById(outfit._id).lean();
    expect(doc!.itemIds.map((each) => String(each))).toEqual(ids);
  });

  it('rejects duplicate itemIds with 400', async () => {
    const { outfit, ids } = await seedOutfitWithItems(ownerId, 1);
    const item = await seedItem(ownerId);
    const id = String(item._id);

    const res = await patchOutfit(String(outfit._id), { itemIds: [id, id] });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Duplicate items');
    const doc = await Outfit.findById(outfit._id).lean();
    expect(doc!.itemIds.map((each) => String(each))).toEqual(ids);
  });

  it('rejects an empty itemIds array with 400', async () => {
    const { outfit, ids } = await seedOutfitWithItems(ownerId, 1);

    const res = await patchOutfit(String(outfit._id), { itemIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const doc = await Outfit.findById(outfit._id).lean();
    expect(doc!.itemIds.map((id) => String(id))).toEqual(ids);
  });

  it("returns 404 for another user's outfit and does not modify it", async () => {
    const other = await registerOther('patch-other@example.com');
    const { outfit } = await seedOutfitWithItems(other.id, 2, { name: 'Theirs' });
    const mine = await seedItem(ownerId);
    const before = await Outfit.findById(outfit._id).lean();

    const res = await patchOutfit(String(outfit._id), {
      name: 'Hijacked',
      itemIds: [String(mine._id)],
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // Not the router's own "Route not found": that would pass even if this
    // route did not exist at all.
    expect(res.body.error.message).toBe('Outfit not found');

    // Byte-for-byte unchanged: name, itemIds, createdAt AND updatedAt.
    const after = await Outfit.findById(outfit._id).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('returns 404 for a malformed id', async () => {
    const res = await patchOutfit(MALFORMED_ID, { name: 'Anything' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // Not the router's own "Route not found": that would pass even if this
    // route did not exist at all.
    expect(res.body.error.message).toBe('Outfit not found');
  });

  it('treats an uppercase-hex itemId as the same item', async () => {
    // An ObjectId's hex form is case-insensitive, so this is the SAME id. POST
    // pins this; PATCH is a separate code path and needs its own.
    const { outfit } = await seedOutfitWithItems(ownerId, 1);
    const replacement = await seedItem(ownerId, {
      thumbnailKey: `items/${ownerId}/${randomUUID()}-thumb.jpg`,
    });
    const upper = String(replacement._id).toUpperCase();
    expect(upper).not.toBe(String(replacement._id));

    const res = await patchOutfit(String(outfit._id), { itemIds: [upper] });

    expect(res.status).toBe(200);
    // Resolved, not merely counted: a signed URL proves a document came back.
    expect(res.body.outfit.items).toHaveLength(1);
    expect(res.body.outfit.items[0].imageUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    // Stored and returned canonical, not in the caller's casing.
    expect(res.body.outfit.itemIds).toEqual([String(replacement._id)]);
    const doc = await Outfit.findById(outfit._id).lean();
    expect(doc!.itemIds.map((id) => String(id))).toEqual([String(replacement._id)]);
  });

  it('answers 404 before it looks at the body', async () => {
    const other = await registerOther('patch-order@example.com');
    const { outfit } = await seedOutfitWithItems(other.id, 1);

    // An empty patch is a 400 on the caller's OWN outfit. On an id that is not
    // theirs -- malformed or foreign -- the 404 must win, so "all three routes
    // return 404 for a foreign outfit and for a malformed id" holds
    // unconditionally instead of only for bodies that happen to validate.
    const malformed = await patchOutfit(MALFORMED_ID, {});
    const foreign = await patchOutfit(String(outfit._id), {});

    expect(malformed.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(malformed.body.error.message).toBe('Outfit not found');
    expect(foreign.body.error.message).toBe('Outfit not found');
  });

  it('returns an identical body for both 404 cases', async () => {
    // A shared factory makes these identical today; nothing else holds it
    // there, and GET was the only route that pinned it.
    const other = await registerOther('patch-identical@example.com');
    const { outfit } = await seedOutfitWithItems(other.id, 1);

    const foreign = await patchOutfit(String(outfit._id), { name: 'Hijacked' });
    const malformed = await patchOutfit(MALFORMED_ID, { name: 'Hijacked' });

    expect(foreign.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(foreign.body.error.message).toBe('Outfit not found');
    expect(foreign.body).toEqual(malformed.body);
  });

  it('returns 404 when the outfit is deleted between the read and the write', async () => {
    // PATCH is read-modify-write, so one user on two devices can delete an
    // outfit while the other request holds it. `save()` then rejects with
    // mongoose's DocumentNotFoundError, which must reach the client as the 404
    // it actually is -- not a 500 with a stack trace in a healthy server's log.
    const { outfit } = await seedOutfitWithItems(ownerId, 1, { name: 'Doomed' });
    const stale = await Outfit.findOne({ _id: outfit._id, userId: ownerId });
    await Outfit.deleteOne({ _id: outfit._id });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Hands the handler the document it would have read a moment before the
    // delete landed. One call only: `detailItems` uses ClothingItem.find.
    const findOne = jest
      .spyOn(Outfit, 'findOne')
      .mockReturnValueOnce(Promise.resolve(stale) as never);
    try {
      const res = await patchOutfit(String(outfit._id), { name: 'Renamed' });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Outfit not found');
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      findOne.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('rejects an over-large body with 413, not 500', async () => {
    // body-parser rejects this with a PayloadTooLargeError, which is NOT a
    // SyntaxError -- so the malformed-JSON branch never saw it and it fell
    // through to INTERNAL. PATCH is a new door to a pre-existing defect.
    const { outfit } = await seedOutfitWithItems(ownerId, 1, { name: 'Untouched' });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(server)
        .patch(`/outfits/${String(outfit._id)}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ name: 'x'.repeat(200 * 1024) }));

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
    expect((await Outfit.findById(outfit._id).lean())!.name).toBe('Untouched');
  });

  it('does not change createdAt', async () => {
    const created = new Date('2026-08-01T09:00:00.000Z');
    const { outfit } = await seedOutfitWithItems(ownerId, 1, { name: 'Old', createdAt: created });
    const before = await readTimestamps(outfit._id);
    // Mongoose timestamps are millisecond-resolution, so a patch landing in the
    // same millisecond as the create would make a strict comparison flaky
    // rather than wrong. `toBeGreaterThanOrEqual` would dodge that -- and would
    // also be satisfied by a document nothing wrote to, which is precisely the
    // mutation (`save({ timestamps: false })`) it must catch.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const res = await patchOutfit(String(outfit._id), { name: 'New' });

    expect(res.status).toBe(200);
    expect(res.body.outfit.createdAt).toBe(created.toISOString());
    const after = await readTimestamps(outfit._id);
    expect(after.createdAt).toEqual(created);
    // ...while updatedAt does move, which is what timestamps are for.
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });
});

describe('DELETE /outfits/:id', () => {
  it("deletes the caller's outfit and returns 204 with no body", async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 2);

    const res = await removeOutfit(String(outfit._id));

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(res.body).toEqual({});
  });

  it('actually removes the document', async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1);

    expect((await removeOutfit(String(outfit._id))).status).toBe(204);

    expect(await Outfit.findById(outfit._id).lean()).toBeNull();
    expect((await detail(String(outfit._id))).status).toBe(404);
  });

  it('returns 404 on a second delete of the same id', async () => {
    const { outfit } = await seedOutfitWithItems(ownerId, 1);

    expect((await removeOutfit(String(outfit._id))).status).toBe(204);

    // Not idempotent-silent: a 204 for an id that never existed hides a client
    // bug with nothing to signal it.
    const second = await removeOutfit(String(outfit._id));
    expect(second.status).toBe(404);
    expect(second.body.error.code).toBe('NOT_FOUND');
    expect(second.body.error.message).toBe('Outfit not found');
  });

  it("returns 404 for another user's outfit and leaves it in place", async () => {
    const other = await registerOther('delete-other@example.com');
    const { outfit } = await seedOutfitWithItems(other.id, 2, { name: 'Theirs' });
    const before = await Outfit.findById(outfit._id).lean();

    const res = await removeOutfit(String(outfit._id));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // Not the router's own "Route not found": that would pass even if this
    // route did not exist at all.
    expect(res.body.error.message).toBe('Outfit not found');

    // Still present, and untouched.
    const after = await Outfit.findById(outfit._id).lean();
    expect(after).not.toBeNull();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('returns 404 for a malformed id', async () => {
    const res = await removeOutfit(MALFORMED_ID);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // Not the router's own "Route not found": that would pass even if this
    // route did not exist at all.
    expect(res.body.error.message).toBe('Outfit not found');
  });

  it('returns an identical body for both 404 cases', async () => {
    const other = await registerOther('delete-identical@example.com');
    const { outfit } = await seedOutfitWithItems(other.id, 1);

    const foreign = await removeOutfit(String(outfit._id));
    const malformed = await removeOutfit(MALFORMED_ID);

    expect(foreign.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(foreign.body.error.message).toBe('Outfit not found');
    expect(foreign.body).toEqual(malformed.body);
  });

  it("does not delete the outfit's items", async () => {
    // No cascade. Items belong to the wardrobe, not to the outfit that
    // happens to reference them -- deleting an outfit must not empty a
    // wardrobe, and another outfit may reference the same items.
    const { outfit, items } = await seedOutfitWithItems(ownerId, 3);
    const survivor = await Outfit.create({ userId: ownerId, itemIds: [items[0]._id] });

    expect((await removeOutfit(String(outfit._id))).status).toBe(204);

    expect(await ClothingItem.countDocuments({ userId: ownerId })).toBe(3);
    for (const item of items) {
      expect(await ClothingItem.findById(item._id).lean()).not.toBeNull();
    }
    // ...and an outfit that shares an item is unaffected.
    expect((await detail(String(survivor._id))).status).toBe(200);
  });
});
