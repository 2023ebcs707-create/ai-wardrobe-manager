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
import { WearHistory } from '../models/WearHistory';
import { createStorageProvider } from '../storage/MinioStorageProvider';

const config = loadConfig({ JWT_SECRET: 'wear-test-secret', MONGO_URL: process.env.MONGO_URL });
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
 * That churn is what made the outfits suite flaky -- a torn-down ephemeral
 * port can be recycled by the OS and a socket held open against the old server
 * then carries a reply belonging to another exchange.
 */
let server: Server;

const SORT_INDEX_NAME = 'userId_1_wornAt_-1__id_-1';

let token = '';
let ownerId = '';

beforeAll(async () => {
  server = app.listen(0);
  await connectDatabase(config.mongoUrl);
  await User.init();
  await ClothingItem.init();
  await Outfit.init();
  await WearHistory.init();
}, 30000);

async function clean(): Promise<void> {
  await User.deleteMany({});
  await ClothingItem.deleteMany({});
  await Outfit.deleteMany({});
  await WearHistory.deleteMany({});
}

beforeEach(async () => {
  await clean();
  const res = await request(server)
    .post('/auth/register')
    .send({ name: 'Owner', email: 'owner@example.com', password: 'password123' });
  token = res.body.token;
  ownerId = res.body.user.id;
});

afterAll(async () => {
  await clean();
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

/**
 * Seed an outfit together with the items it references.
 *
 * The items are created in sequence rather than concurrently so their
 * ObjectIds ascend, which is what lets an ordering assertion tell request
 * order from index order.
 */
async function seedOutfit(
  owner: string,
  count = 1,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; items: ClothingItemDoc[]; itemIds: string[] }> {
  const items: ClothingItemDoc[] = [];
  for (let i = 0; i < count; i += 1) {
    items.push(await seedItem(owner));
  }
  const outfit = await Outfit.create({
    userId: owner,
    itemIds: items.map((item) => item._id),
    ...overrides,
  });
  return { id: String(outfit._id), items, itemIds: items.map((item) => String(item._id)) };
}

function logWear(body: object, as = token) {
  return request(server).post('/wear-history').set('Authorization', `Bearer ${as}`).send(body);
}

function list(query = '', as = token) {
  return request(server).get(`/wear-history${query}`).set('Authorization', `Bearer ${as}`);
}

/** Re-read one item's tracking fields straight from the database. */
async function readItem(id: unknown): Promise<{ wearCount: number; lastWornAt?: Date }> {
  const doc = await ClothingItem.findById(id).lean();
  return doc as unknown as { wearCount: number; lastWornAt?: Date };
}

const MALFORMED_ID = 'not-an-object-id';

describe('POST /wear-history (TC-08 wear logging)', () => {
  it("records a wear event for the caller's outfit", async () => {
    const outfit = await seedOutfit(ownerId, 2, { name: 'Friday' });

    const res = await logWear({ outfitId: outfit.id });

    expect(res.status).toBe(201);
    expect(res.body.event.outfitId).toBe(outfit.id);
    expect(res.body.event.userId).toBe(ownerId);
    expect(res.body.event.id).toEqual(expect.any(String));
    expect(res.body.event.createdAt).toEqual(expect.any(String));

    const stored = await WearHistory.findById(res.body.event.id).lean();
    expect(stored).not.toBeNull();
    expect(String(stored!.userId)).toBe(ownerId);
    expect(String(stored!.outfitId)).toBe(outfit.id);
  });

  it('requires authentication', async () => {
    const outfit = await seedOutfit(ownerId);
    const res = await request(server).post('/wear-history').send({ outfitId: outfit.id });
    expect(res.status).toBe(401);
    expect(await WearHistory.countDocuments({})).toBe(0);
  });

  it('INCREMENTS wearCount on every item of the outfit', async () => {
    const outfit = await seedOutfit(ownerId, 3);
    // An item the caller owns but did not wear. The fan-out must be scoped to
    // the outfit, not "all my items".
    const bystander = await seedItem(ownerId);

    const res = await logWear({ outfitId: outfit.id });
    expect(res.status).toBe(201);

    for (const item of outfit.items) {
      expect((await readItem(item._id)).wearCount).toBe(1);
    }
    expect((await readItem(bystander._id)).wearCount).toBe(0);
  });

  it('sets lastWornAt on every item of the outfit', async () => {
    const outfit = await seedOutfit(ownerId, 3);
    const bystander = await seedItem(ownerId);
    const wornAt = new Date('2026-08-20T09:15:00.000Z');

    const res = await logWear({ outfitId: outfit.id, wornAt: wornAt.toISOString() });
    expect(res.status).toBe(201);

    for (const item of outfit.items) {
      const after = await readItem(item._id);
      expect(after.lastWornAt).toBeDefined();
      expect(new Date(after.lastWornAt!).toISOString()).toBe(wornAt.toISOString());
    }
    expect((await readItem(bystander._id)).lastWornAt).toBeUndefined();
  });

  it('increments again on a second wear rather than resetting', async () => {
    const outfit = await seedOutfit(ownerId, 2);

    expect((await logWear({ outfitId: outfit.id })).status).toBe(201);
    expect((await logWear({ outfitId: outfit.id })).status).toBe(201);
    expect((await logWear({ outfitId: outfit.id })).status).toBe(201);

    for (const item of outfit.items) {
      expect((await readItem(item._id)).wearCount).toBe(3);
    }
    expect(await WearHistory.countDocuments({})).toBe(3);
  });

  it('does NOT touch items belonging to another user', async () => {
    // THE security test for the fan-out. The realistic defect is an
    // `updateMany` scoped by `_id` alone, which looks correct and passes every
    // test written with one user's own items. The outfit is seeded directly so
    // that a foreign id is genuinely present in the id set the fan-out builds
    // -- `POST /outfits` would have refused to compose it.
    //
    // Refusing the foreign id is BY DEFINITION a partial fan-out, so this
    // request logs the divergence. The spy keeps that line out of the suite's
    // output; asserting on it is the next test's job, not this one's.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const other = await registerOther('other-fanout@example.com');
      const foreign = await seedItem(other.id);
      const mine = await seedItem(ownerId);
      const outfit = await Outfit.create({
        userId: ownerId,
        itemIds: [mine._id, foreign._id],
      });

      const res = await logWear({ outfitId: String(outfit._id) });
      expect(res.status).toBe(201);

      // The caller's own item moved, so the fan-out definitely ran -- without
      // this half, deleting the fan-out entirely would also pass.
      expect((await readItem(mine._id)).wearCount).toBe(1);

      const theirs = await readItem(foreign._id);
      expect(theirs.wearCount).toBe(0);
      expect(theirs.lastWornAt).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reports a partial fan-out instead of silently under-counting', async () => {
    // A fan-out that matches fewer items than the event snapshotted throws
    // nothing, still answers 201, and leaves those items under-reporting for
    // good -- on the very number Task 2's "most/least worn" ranks by. The one
    // thing that makes it recoverable is a log line naming the row to replay.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const other = await registerOther('other-partial@example.com');
      const foreign = await seedItem(other.id);
      const mine = await seedItem(ownerId);
      const outfit = await Outfit.create({ userId: ownerId, itemIds: [mine._id, foreign._id] });

      const res = await logWear({ outfitId: String(outfit._id) });

      // Still 201, deliberately: the wear happened and the event is written.
      // A 500 here would invite a retry, and a retry writes a SECOND event and
      // increments a second time.
      expect(res.status).toBe(201);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = String(errorSpy.mock.calls[0]![0]);
      // The event id is the whole point -- a line that says "something
      // diverged" without naming the row cannot be acted on.
      expect(line).toContain(String(res.body.event.id));
      expect(line).toContain('2');
      expect(line).toContain('1');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs nothing when the fan-out matches every item', async () => {
    // The other half of the previous test: a detector that fires on every
    // healthy request is noise, and noise is ignored.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const outfit = await seedOutfit(ownerId, 3);
      expect((await logWear({ outfitId: outfit.id })).status).toBe(201);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('snapshots itemIds onto the event, so a later edit cannot rewrite history', async () => {
    const outfit = await seedOutfit(ownerId, 2);
    const replacement = await seedItem(ownerId);

    const res = await logWear({ outfitId: outfit.id });
    expect(res.status).toBe(201);
    expect(res.body.event.itemIds).toEqual(outfit.itemIds);

    // Recompose the outfit through the API. The event must still describe what
    // was actually worn.
    const patched = await request(server)
      .patch(`/outfits/${outfit.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ itemIds: [String(replacement._id)] });
    expect(patched.status).toBe(200);

    const after = await list();
    expect(after.status).toBe(200);
    expect(after.body.events).toHaveLength(1);
    expect(after.body.events[0].itemIds).toEqual(outfit.itemIds);
  });

  it('defaults wornAt to now when omitted', async () => {
    const outfit = await seedOutfit(ownerId);
    const before = Date.now();

    const res = await logWear({ outfitId: outfit.id });

    expect(res.status).toBe(201);
    const worn = new Date(res.body.event.wornAt).getTime();
    expect(Number.isNaN(worn)).toBe(false);
    expect(worn).toBeGreaterThanOrEqual(before - 1000);
    expect(worn).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('accepts a back-dated wornAt', async () => {
    const outfit = await seedOutfit(ownerId);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const res = await logWear({ outfitId: outfit.id, wornAt: yesterday.toISOString() });

    expect(res.status).toBe(201);
    expect(res.body.event.wornAt).toBe(yesterday.toISOString());
  });

  it('rejects a future wornAt with 400', async () => {
    const outfit = await seedOutfit(ownerId);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const res = await logWear({ outfitId: outfit.id, wornAt: tomorrow.toISOString() });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    // Rejected BEFORE anything is written: no event, and no counter moved.
    expect(await WearHistory.countDocuments({})).toBe(0);
    expect((await readItem(outfit.items[0]!._id)).wearCount).toBe(0);
  });

  it('rejects a wornAt seconds in the future, as a skewed client clock sends', async () => {
    // The realistic shape of the future-wornAt defect is not a user typing
    // next Tuesday -- it is a handset whose clock runs ahead sending its own
    // `new Date()` for a wear happening right now. There is no skew tolerance,
    // so that is a 400 the user cannot act on, which is why the contract on
    // PublicWearEvent.wornAt tells clients to OMIT the field for "now".
    //
    // Five seconds, not five milliseconds: the boundary itself is unreachable
    // over HTTP (see wearHistory.test.ts, which pins it directly) and a
    // millisecond-scale skew here would be a race against transit time.
    const outfit = await seedOutfit(ownerId);
    const skewed = new Date(Date.now() + 5_000);

    const res = await logWear({ outfitId: outfit.id, wornAt: skewed.toISOString() });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields[0].path).toBe('wornAt');
    expect(await WearHistory.countDocuments({})).toBe(0);
  });

  it('rejects an unparseable wornAt with 400', async () => {
    const outfit = await seedOutfit(ownerId);
    const res = await logWear({ outfitId: outfit.id, wornAt: 'yesterday-ish' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await WearHistory.countDocuments({})).toBe(0);
  });

  it('does not move lastWornAt backwards when an older wear is logged later', async () => {
    // `lastWornAt` means "the date of the most recent wear", not "the date on
    // the most recently typed row". Back-dating is ordinary use, so logging
    // Monday's outfit on Wednesday -- after Tuesday's is already recorded --
    // must not make the item report Monday as its last wear.
    const outfit = await seedOutfit(ownerId, 2);
    const tuesday = new Date('2026-08-18T08:00:00.000Z');
    const monday = new Date('2026-08-17T08:00:00.000Z');

    expect((await logWear({ outfitId: outfit.id, wornAt: tuesday.toISOString() })).status).toBe(201);
    expect((await logWear({ outfitId: outfit.id, wornAt: monday.toISOString() })).status).toBe(201);

    for (const item of outfit.items) {
      const after = await readItem(item._id);
      // Both wears counted...
      expect(after.wearCount).toBe(2);
      // ...but the later DATE is what "last worn" reports.
      expect(new Date(after.lastWornAt!).toISOString()).toBe(tuesday.toISOString());
    }
  });

  it('stores a trimmed occasion and omits it when blank', async () => {
    const outfit = await seedOutfit(ownerId);

    const trimmed = await logWear({ outfitId: outfit.id, occasion: '  Job interview  ' });
    expect(trimmed.status).toBe(201);
    expect(trimmed.body.event.occasion).toBe('Job interview');

    const blank = await logWear({ outfitId: outfit.id, occasion: '   ' });
    expect(blank.status).toBe(201);
    expect(blank.body.event.occasion).toBeUndefined();

    const absent = await logWear({ outfitId: outfit.id });
    expect(absent.status).toBe(201);
    expect(absent.body.event.occasion).toBeUndefined();
  });

  it('accepts an occasion of exactly 60 characters, padded or not', async () => {
    const outfit = await seedOutfit(ownerId);
    const sixty = 'x'.repeat(60);

    const exact = await logWear({ outfitId: outfit.id, occasion: sixty });
    expect(exact.status).toBe(201);
    expect(exact.body.event.occasion).toBe(sixty);

    // Trimmed BEFORE the bound: 64 characters of padding is a 60-character
    // occasion the user asked for, not an over-long one.
    const padded = await logWear({ outfitId: outfit.id, occasion: `  ${sixty}  ` });
    expect(padded.status).toBe(201);
    expect(padded.body.event.occasion).toBe(sixty);
  });

  it('rejects an occasion longer than 60 characters', async () => {
    const outfit = await seedOutfit(ownerId);
    const res = await logWear({ outfitId: outfit.id, occasion: 'x'.repeat(61) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await WearHistory.countDocuments({})).toBe(0);
  });

  it("rejects another user's outfitId with 400", async () => {
    const other = await registerOther('other-outfit@example.com');
    const theirs = await seedOutfit(other.id, 1, { name: 'Theirs' });

    const res = await logWear({ outfitId: theirs.id });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await WearHistory.countDocuments({})).toBe(0);
    // Nothing of theirs moved either.
    expect((await readItem(theirs.items[0]!._id)).wearCount).toBe(0);
  });

  it('gives an identical error for an unknown, a foreign and a malformed outfitId', async () => {
    // Distinguishing them would confirm through the response alone that an
    // outfit exists at an id the caller has no business knowing about -- the
    // same reasoning behind this codebase's 404-not-403 rule.
    const other = await registerOther('other-identical@example.com');
    const theirs = await seedOutfit(other.id);

    const foreign = await logWear({ outfitId: theirs.id });
    const unknown = await logWear({ outfitId: String(new mongoose.Types.ObjectId()) });
    const malformed = await logWear({ outfitId: MALFORMED_ID });

    expect(foreign.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(unknown.body).toEqual(foreign.body);
    expect(malformed.body).toEqual(foreign.body);
  });

  it('rejects a body with no outfitId at all', async () => {
    const res = await logWear({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a malformed JSON body with 400, not 500', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(server)
        .post('/wear-history')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"outfitId": ');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      // A healthy server must not log a stack trace for a client's typo.
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('GET /wear-history', () => {
  /** Log one wear straight into the collection, bypassing the write path. */
  async function seedEvent(
    owner: string,
    wornAt: Date,
    overrides: Record<string, unknown> = {},
  ) {
    const outfit = await seedOutfit(owner, 1);
    return WearHistory.create({
      userId: owner,
      outfitId: outfit.id,
      itemIds: outfit.items.map((item) => item._id),
      wornAt,
      ...overrides,
    });
  }

  it('requires authentication', async () => {
    const res = await request(server).get('/wear-history');
    expect(res.status).toBe(401);
  });

  it("returns only the caller's events", async () => {
    const other = await registerOther('other-list@example.com');
    await seedEvent(ownerId, new Date('2026-08-20T10:00:00.000Z'), { occasion: 'Mine' });
    await seedEvent(other.id, new Date('2026-08-21T10:00:00.000Z'), { occasion: 'Theirs' });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].occasion).toBe('Mine');
    expect(res.body.events[0].userId).toBe(ownerId);
  });

  it('returns events most-recently-worn first', async () => {
    // Seeded so that insertion order (and therefore createdAt order) is the
    // OPPOSITE of wornAt order. Sorting by createdAt reverses this list.
    await seedEvent(ownerId, new Date('2026-08-01T00:00:00.000Z'), { occasion: 'old' });
    await seedEvent(ownerId, new Date('2026-08-20T00:00:00.000Z'), { occasion: 'new' });
    await seedEvent(ownerId, new Date('2026-08-10T00:00:00.000Z'), { occasion: 'mid' });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { occasion: string }) => e.occasion)).toEqual([
      'new',
      'mid',
      'old',
    ]);
  });

  it('pages with a cursor without repeating or skipping', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedEvent(ownerId, new Date(Date.UTC(2026, 7, 1 + i)));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const q = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await list(q);
      expect(res.status).toBe(200);
      seen.push(...res.body.events.map((e: { id: string }) => e.id));
      cursor = res.body.nextCursor;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeUndefined();
  }, 30000);

  it('omits nextCursor on the final page', async () => {
    await seedEvent(ownerId, new Date('2026-08-20T10:00:00.000Z'));
    // A 500 body is `{error:{...}}`, which also has no `nextCursor` -- so
    // asserting its absence alone passes against a thrown handler. Status and
    // page shape are what make this test about paging.
    const res = await list('?limit=24');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect('nextCursor' in res.body).toBe(false);
  });

  it('rejects a malformed cursor with 400', async () => {
    const res = await list('?cursor=!!!not-base64!!!');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.events).toBeUndefined();
  });

  it('rejects limit=0, limit=101 and a non-numeric limit with 400', async () => {
    // Status alone would pass on a 400 raised for some unrelated reason, so
    // each case also has to be about `limit` specifically.
    for (const bad of ['0', '101', 'abc']) {
      const res = await list(`?limit=${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.fields[0].path).toBe('limit');
      expect(res.body.events).toBeUndefined();
    }
  });

  it('resolves outfitName', async () => {
    const outfit = await seedOutfit(ownerId, 1, { name: 'Friday best' });
    expect((await logWear({ outfitId: outfit.id })).status).toBe(201);

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].outfitName).toBe('Friday best');
  });

  it('omits outfitName for an outfit that never had one', async () => {
    const outfit = await seedOutfit(ownerId, 1);
    expect((await logWear({ outfitId: outfit.id })).status).toBe(201);

    const res = await list();

    expect(res.body.events[0].outfitId).toBe(outfit.id);
    expect(res.body.events[0].outfitName).toBeUndefined();
  });

  it('STILL LISTS an event whose outfit was deleted, without outfitName', async () => {
    // Ruling 3: a wear happened, and deleting the outfit afterwards does not
    // un-happen it. The event describes itself from its own snapshot.
    const outfit = await seedOutfit(ownerId, 2, { name: 'Doomed' });
    expect((await logWear({ outfitId: outfit.id, occasion: 'Brunch' })).status).toBe(201);

    const deleted = await request(server)
      .delete(`/outfits/${outfit.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(deleted.status).toBe(204);

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].outfitId).toBe(outfit.id);
    expect(res.body.events[0].outfitName).toBeUndefined();
    expect(res.body.events[0].occasion).toBe('Brunch');
    // The snapshot is what makes the row still meaningful.
    expect(res.body.events[0].itemIds).toEqual(outfit.itemIds);
  });

  it('lists a surviving event beside a deleted-outfit one without failing the page', async () => {
    // A whole page must not be lost to one stale reference.
    const doomed = await seedOutfit(ownerId, 1, { name: 'Doomed' });
    const kept = await seedOutfit(ownerId, 1, { name: 'Kept' });
    // Each set-up request is asserted: an unasserted 400 here would still fail
    // the test below, but it would point at the listing rather than at the
    // write that never happened.
    const first = await logWear({
      outfitId: doomed.id,
      wornAt: new Date('2026-08-19T10:00:00.000Z').toISOString(),
    });
    expect(first.status).toBe(201);
    const second = await logWear({
      outfitId: kept.id,
      wornAt: new Date('2026-08-20T10:00:00.000Z').toISOString(),
    });
    expect(second.status).toBe(201);
    const removed = await request(server)
      .delete(`/outfits/${doomed.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(removed.status).toBe(204);

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0].outfitName).toBe('Kept');
    expect(res.body.events[1].outfitName).toBeUndefined();
  });

  it("never resolves an outfitName across users", async () => {
    // The name lookup is a second query, and a second query is a second place
    // to forget the ownership filter. A foreign outfit's name must not leak
    // through a history row that references it.
    const other = await registerOther('other-name@example.com');
    const theirs = await seedOutfit(other.id, 1, { name: 'Their secret outfit' });
    await WearHistory.create({
      userId: ownerId,
      outfitId: theirs.id,
      itemIds: theirs.items.map((item) => item._id),
      wornAt: new Date('2026-08-20T10:00:00.000Z'),
    });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].outfitName).toBeUndefined();
  });

  it('separates same-millisecond events when no index can supply the tie order', async () => {
    // The compound index is itself _id-descending within equal wornAt and is
    // the winning plan, so it hands ties back correctly regardless of the sort
    // spec. Dropping it forces an in-memory sort, where only the sort spec's
    // `_id: -1` can separate the pair. Stage 4 established this technique.
    await WearHistory.collection.dropIndex(SORT_INDEX_NAME);
    try {
      const sameInstant = new Date('2026-08-24T10:30:00.000Z');
      const first = await seedEvent(ownerId, sameInstant);
      const second = await seedEvent(ownerId, sameInstant);
      const [lower, higher] = [String(first._id), String(second._id)].sort();

      const page1 = await list('?limit=1');
      expect(page1.body.events).toHaveLength(1);
      expect(page1.body.nextCursor).toEqual(expect.any(String));

      const page2 = await list(`?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
      expect(page2.body.events).toHaveLength(1);

      expect([page1.body.events[0].id, page2.body.events[0].id]).toEqual([higher, lower]);
    } finally {
      // createIndexes, not syncIndexes: syncIndexes also DROPS indexes absent
      // from the schema, which is not this test's business on a shared database.
      await WearHistory.createIndexes();
    }
  }, 30000);
});

describe('WearHistory model', () => {
  /**
   * The model layer, not the route.
   *
   * `POST /wear-history` resolves and validates `wornAt` before it creates
   * anything, so no HTTP request can reach the schema without one -- which is
   * why adding `default: Date.now` to the path failed all 32 integration tests
   * when it was mutated. That makes the declaration unreachable FROM THE API,
   * not untestable: at this layer the two spellings are plainly different, and
   * pinning the difference is what stops a future writer from being handed a
   * row silently dated "now" instead of an error.
   */
  it('refuses to create an event with no wornAt', async () => {
    const outfit = await seedOutfit(ownerId, 1);

    await expect(
      WearHistory.create({
        userId: ownerId,
        outfitId: outfit.id,
        itemIds: outfit.items.map((item) => item._id),
      }),
    ).rejects.toThrow(mongoose.Error.ValidationError);

    expect(await WearHistory.countDocuments({})).toBe(0);
  });
});
