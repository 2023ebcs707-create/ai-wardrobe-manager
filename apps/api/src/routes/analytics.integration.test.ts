import request from 'supertest';
import mongoose from 'mongoose';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ANALYTICS_LIMIT, MAX_ANALYTICS_LIMIT } from '@wardrobe/shared';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { connectDatabase } from '../db';
import { User } from '../models/User';
import {
  ClothingItem,
  LEAST_WORN_SORT,
  MOST_WORN_SORT,
  WEAR_RANK_INDEX,
  type ClothingItemDoc,
} from '../models/ClothingItem';
import { LaundryStatus } from '../models/LaundryStatus';
import { createStorageProvider } from '../storage/MinioStorageProvider';

const config = loadConfig({ JWT_SECRET: 'analytics-test-secret', MONGO_URL: process.env.MONGO_URL });
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

let token = '';
let ownerId = '';

beforeAll(async () => {
  server = app.listen(0);
  await connectDatabase(config.mongoUrl);
  await User.init();
  await ClothingItem.init();
}, 30000);

async function clean(): Promise<void> {
  await User.deleteMany({});
  await ClothingItem.deleteMany({});
  // The itemsInLaundry test below drives the real PATCH, which appends a
  // transition row. Cleaned here so this suite leaves nothing behind.
  await LaundryStatus.deleteMany({});
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

/**
 * Seed one item per wear count, in ascending `_id` order.
 *
 * Sequential rather than concurrent so the ObjectIds ascend with the array
 * index, which is what lets a tiebreaker assertion tell insertion order from
 * index order.
 */
async function seedWearCounts(owner: string, counts: number[]): Promise<ClothingItemDoc[]> {
  const docs: ClothingItemDoc[] = [];
  for (const wearCount of counts) {
    docs.push(
      await seedItem(owner, {
        wearCount,
        // A never-worn item genuinely has no lastWornAt -- that absence is
        // part of what the ascending sort has to handle.
        ...(wearCount > 0 ? { lastWornAt: new Date(Date.UTC(2026, 0, 1 + wearCount)) } : {}),
      }),
    );
  }
  return docs;
}

async function registerOther(email: string): Promise<{ token: string; id: string }> {
  const res = await request(server)
    .post('/auth/register')
    .send({ name: 'Other', email, password: 'password123' });
  return { token: res.body.token, id: res.body.user.id };
}

function usage(query = '', as = token) {
  return request(server).get(`/analytics/usage${query}`).set('Authorization', `Bearer ${as}`);
}

const ids = (list: Array<{ id: string }>): string[] => list.map((item) => item.id);

describe('GET /analytics/usage', () => {
  it('requires authentication', async () => {
    const res = await request(server).get('/analytics/usage');

    expect(res.status).toBe(401);
    expect(res.body.mostWorn).toBeUndefined();
  });

  it('ranks mostWorn by wearCount descending', async () => {
    const [zero, one, five, two, nine] = await seedWearCounts(ownerId, [0, 1, 5, 2, 9]);

    const res = await usage();

    expect(res.status).toBe(200);
    expect(ids(res.body.mostWorn)).toEqual([nine, five, two, one, zero].map((d) => String(d._id)));
    expect(res.body.mostWorn.map((i: { wearCount: number }) => i.wearCount)).toEqual([
      9, 5, 2, 1, 0,
    ]);
    // A full PublicClothingItem per entry, signed like every other
    // item-returning route -- the Profile leaderboard renders thumbnails.
    expect(res.body.mostWorn[0].imageUrl).toEqual(expect.any(String));
    expect(res.body.mostWorn[0].category).toBe('tshirt');
  });

  it('ranks leastWorn by wearCount ascending, including never-worn items', async () => {
    const [zero, one, five, two, nine] = await seedWearCounts(ownerId, [0, 1, 5, 2, 9]);

    const res = await usage();

    expect(res.status).toBe(200);
    // The never-worn item leads the list. Excluding `wearCount: 0` would make
    // this feature say nothing at all about a fresh wardrobe, which is exactly
    // the wardrobe it is most useful for.
    expect(ids(res.body.leastWorn)).toEqual([zero, one, two, five, nine].map((d) => String(d._id)));
    expect(res.body.leastWorn[0].wearCount).toBe(0);
    expect(res.body.leastWorn[0].lastWornAt).toBeUndefined();
  });

  it('breaks wearCount ties by lastWornAt then _id, identically across calls', async () => {
    const worn = new Date(Date.UTC(2026, 1, 1));
    const older = new Date(Date.UTC(2026, 0, 1));
    // Two items tied on BOTH wearCount and lastWornAt, so only `_id` can
    // separate them, plus a third tied on wearCount alone.
    const a = await seedItem(ownerId, { wearCount: 4, lastWornAt: worn });
    const b = await seedItem(ownerId, { wearCount: 4, lastWornAt: worn });
    const c = await seedItem(ownerId, { wearCount: 4, lastWornAt: older });

    const first = await usage();
    const second = await usage();

    expect(first.status).toBe(200);
    // Descending on every key: newest wear first, then the higher _id.
    expect(ids(first.body.mostWorn)).toEqual([b, a, c].map((d) => String(d._id)));
    // And the exact reverse for leastWorn, which is what lets one index serve
    // both directions.
    expect(ids(first.body.leastWorn)).toEqual([c, a, b].map((d) => String(d._id)));
    // Stable: a Profile screen that re-fetches must not shuffle its rows.
    expect(ids(second.body.mostWorn)).toEqual(ids(first.body.mostWorn));
    expect(ids(second.body.leastWorn)).toEqual(ids(first.body.leastWorn));
  });

  it('orders a fresh wardrobe, where every item is tied at zero with no lastWornAt', async () => {
    // THE CASE leastWorn EXISTS TO SERVE. On a wardrobe nobody has worn yet
    // every item ties at `wearCount: 0` with `lastWornAt` absent, so the two
    // leading sort keys separate nothing and `_id` decides alone -- and
    // `lastWornAt` is MISSING rather than merely equal, which is a different
    // comparison for MongoDB (a missing key sorts as null). The tie test above
    // uses worn items, so it does not reach this shape.
    const fresh: ClothingItemDoc[] = [];
    for (let i = 0; i < 4; i += 1) {
      fresh.push(await seedItem(ownerId));
    }
    const ascending = fresh.map((d) => String(d._id));

    const res = await usage();

    expect(res.status).toBe(200);
    expect(res.body.leastWorn).toHaveLength(4);
    expect(ids(res.body.leastWorn)).toEqual(ascending);
    expect(ids(res.body.mostWorn)).toEqual([...ascending].reverse());
    // Every one of them is a never-worn item, which is the whole point.
    expect(res.body.leastWorn.every((i: { wearCount: number }) => i.wearCount === 0)).toBe(true);
    expect(res.body.leastWorn.every((i: { lastWornAt?: string }) => i.lastWornAt === undefined)).toBe(
      true,
    );
    expect(res.body.totalWears).toBe(0);
  });

  it('reports totalWears and itemsInLaundry', async () => {
    await seedWearCounts(ownerId, [0, 3, 4]);
    await seedItem(ownerId, { wearCount: 2, laundryStatus: 'in_laundry' });
    await seedItem(ownerId, { wearCount: 0, laundryStatus: 'in_laundry' });

    const res = await usage();

    expect(res.status).toBe(200);
    expect(res.body.totalWears).toBe(9);
    expect(res.body.itemsInLaundry).toBe(2);
  });

  it('counts an item into itemsInLaundry as soon as PATCH /items/:id/laundry moves it', async () => {
    // The two halves of this stage, joined: the denormalised field the laundry
    // route writes is the field this count reads. If they ever stop being the
    // same field, this is what says so.
    const item = await seedItem(ownerId, { wearCount: 1 });

    expect((await usage()).body.itemsInLaundry).toBe(0);

    const patched = await request(server)
      .patch(`/items/${String(item._id)}/laundry`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'in_laundry' });
    expect(patched.status).toBe(200);

    const res = await usage();
    expect(res.body.itemsInLaundry).toBe(1);
    // The wear counter is untouched by a laundry move.
    expect(res.body.totalWears).toBe(1);
  });

  it("EXCLUDES another user's items from every field", async () => {
    const other = await registerOther('other@example.com');
    // A genuinely bigger, more-worn, half-washed wardrobe belonging to someone
    // else. Every one of these outranks the caller's single item, so a missing
    // `userId` filter cannot hide behind a coincidence of ordering.
    const foreign = [
      await seedItem(other.id, { wearCount: 99, lastWornAt: new Date(), category: 'jacket' }),
      await seedItem(other.id, { wearCount: 77, laundryStatus: 'in_laundry' }),
      await seedItem(other.id, { wearCount: 0, laundryStatus: 'in_laundry' }),
    ];
    const mine = await seedItem(ownerId, { wearCount: 3 });

    const res = await usage();

    expect(res.status).toBe(200);
    const foreignIds = foreign.map((d) => String(d._id));
    // Not just "the top entry is mine" -- no foreign id anywhere in either
    // list. This endpoint hands back images, categories and colours; one leaked
    // row is another user's wardrobe on screen.
    expect(ids(res.body.mostWorn)).toEqual([String(mine._id)]);
    expect(ids(res.body.leastWorn)).toEqual([String(mine._id)]);
    for (const id of foreignIds) {
      expect(ids(res.body.mostWorn)).not.toContain(id);
      expect(ids(res.body.leastWorn)).not.toContain(id);
    }
    expect(
      [...res.body.mostWorn, ...res.body.leastWorn].every(
        (item: { userId: string }) => item.userId === ownerId,
      ),
    ).toBe(true);
    // The scalars leak just as loudly: 3, not 179.
    expect(res.body.totalWears).toBe(3);
    // And 0, not 2.
    expect(res.body.itemsInLaundry).toBe(0);
  });

  it('caps the lists at limit and rejects an out-of-range limit', async () => {
    await seedWearCounts(ownerId, [1, 2, 3, 4, 5, 6, 7]);

    const capped = await usage('?limit=2');
    expect(capped.status).toBe(200);
    expect(capped.body.mostWorn).toHaveLength(2);
    expect(capped.body.leastWorn).toHaveLength(2);
    // The scalars describe the WHOLE wardrobe, not the truncated lists.
    expect(capped.body.totalWears).toBe(28);

    // The default, pinned: 7 items in, 5 out.
    const defaulted = await usage();
    expect(defaulted.body.mostWorn).toHaveLength(DEFAULT_ANALYTICS_LIMIT);
    expect(defaulted.body.leastWorn).toHaveLength(DEFAULT_ANALYTICS_LIMIT);

    // At the ceiling exactly: accepted.
    const atMax = await usage(`?limit=${MAX_ANALYTICS_LIMIT}`);
    expect(atMax.status).toBe(200);
    expect(atMax.body.mostWorn).toHaveLength(7);

    for (const bad of ['0', String(MAX_ANALYTICS_LIMIT + 1), 'five', '-1', '2.5', '']) {
      const res = await usage(`?limit=${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.fields[0].path).toBe('limit');
      expect(res.body.mostWorn).toBeUndefined();
    }
  });

  it('returns empty lists and zeroes for a wardrobe with no items', async () => {
    const res = await usage();

    expect(res.status).toBe(200);
    expect(res.body.mostWorn).toEqual([]);
    expect(res.body.leastWorn).toEqual([]);
    // Zero, not absent: a Profile screen renders "0 wears", and `undefined`
    // would render as an empty slot that looks like a failed load.
    expect(res.body.totalWears).toBe(0);
    expect(res.body.itemsInLaundry).toBe(0);
  });

  it('separates fully-tied items by _id when no index can supply the order', async () => {
    // WHY THIS TEST DROPS AN INDEX. The ranking index is itself `_id`-ordered
    // within equal `(wearCount, lastWornAt)`, and it is the winning plan, so
    // while it exists it hands ties back in `_id` order NO MATTER WHAT the
    // sort spec says. Deleting `_id` from MOST_WORN_SORT and LEAST_WORN_SORT
    // therefore passes every other test in this file -- measured, not assumed.
    // Removing the index for the duration is the only way to make the sort
    // spec, rather than the index, decide the tie.
    //
    // The assertion is deliberately on BOTH lists. Under a sort spec with no
    // `_id`, the two queries see the same fully-tied input and the same
    // comparator, so they come back in the same order as each other; the
    // shipped specs make them exact REVERSES. At most one of those two facts
    // can hold at a time, which is what makes this independent of whichever
    // order an unindexed sort happens to produce.
    //
    // COUPLED TO `--runInBand`, which `pnpm test:integration` passes. The
    // index is dropped process-wide for the duration, so a concurrently
    // running suite touching ClothingItem would see it missing. Serial
    // execution is what makes that safe today; the `finally` restores it, and
    // any later `Model.init()` would rebuild it anyway, so a crash mid-test
    // costs one slow query rather than a broken tree.
    await ClothingItem.syncIndexes();
    await ClothingItem.collection.dropIndex(WEAR_RANK_INDEX);
    try {
      // Tied on every ranking key, so only `_id` is left to separate them.
      const worn = new Date(Date.UTC(2026, 1, 1));
      const tied: ClothingItemDoc[] = [];
      for (let i = 0; i < 4; i += 1) {
        tied.push(await seedItem(ownerId, { wearCount: 4, lastWornAt: worn }));
      }
      const ascending = tied.map((d) => String(d._id));

      const res = await usage();

      expect(res.status).toBe(200);
      expect(ids(res.body.mostWorn)).toEqual([...ascending].reverse());
      expect(ids(res.body.leastWorn)).toEqual(ascending);
    } finally {
      // createIndexes, deliberately not syncIndexes: put back exactly what the
      // schema declares without dropping anything else on the way.
      await ClothingItem.createIndexes();
    }
  });

  it('answers both rankings from the wearCount index, with no in-memory sort', async () => {
    // Ruling 4's claim is "ONE INDEXED QUERY answers most/least worn". Indexes
    // existing is not the same fact as the planner choosing them -- Stage 5
    // left exactly that gap open on GET /outfits -- so this asserts the
    // winning plan, using the same sort specs the route uses.
    //
    // syncIndexes rather than init: it drops indexes the schema no longer
    // declares, which is what makes removing the index a mutation this test
    // can actually see. `init()` would leave a previous run's index in place
    // and score a false pass.
    await ClothingItem.syncIndexes();
    await seedWearCounts(ownerId, [0, 1, 2, 3, 4, 5]);

    const owner = new mongoose.Types.ObjectId(ownerId);
    const plans = await Promise.all(
      [MOST_WORN_SORT, LEAST_WORN_SORT].map((sort) =>
        ClothingItem.find({ userId: owner })
          .sort(sort)
          .limit(DEFAULT_ANALYTICS_LIMIT)
          .explain('queryPlanner'),
      ),
    );

    for (const plan of plans) {
      const winning = JSON.stringify(
        (plan as unknown as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan,
      );
      expect(winning).toContain('IXSCAN');
      expect(winning).toContain(WEAR_RANK_INDEX);
      // A blocking SORT stage means the index did not serve the ordering and
      // the whole matched set was sorted in memory.
      expect(winning).not.toContain('"stage":"SORT"');
      expect(winning).not.toContain('COLLSCAN');
    }
  });
});
