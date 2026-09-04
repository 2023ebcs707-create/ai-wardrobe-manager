import request from 'supertest';
import mongoose from 'mongoose';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { connectDatabase } from '../db';
import { User } from '../models/User';
import { ClothingItem, type ClothingItemDoc } from '../models/ClothingItem';
import { LaundryStatus } from '../models/LaundryStatus';
import { createStorageProvider } from '../storage/MinioStorageProvider';

/**
 * `PATCH /items/:id/laundry` -- FR7, TC-09's database half.
 *
 * Its own file rather than more tests inside `items.integration.test.ts`,
 * deliberately. That file's setup exists to exercise upload: it reads a real
 * garment fixture off disk, waits on the live AI service, and installs a
 * global `console.warn` spy because its deliberately-undecodable fixtures make
 * `tagImage` warn on nearly every request. None of that is relevant to a
 * status toggle, and inheriting it would make every mutation run in this task
 * pay ~20 seconds and drag a live Python service into the loop.
 *
 * The route itself lives in `items.ts` -- see the comment above the handler
 * there for why a sub-path of `/items/:id` stayed on the items router.
 */
const config = loadConfig({ JWT_SECRET: 'laundry-test-secret', MONGO_URL: process.env.MONGO_URL });
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
  await LaundryStatus.init();
}, 30000);

async function clean(): Promise<void> {
  await User.deleteMany({});
  await ClothingItem.deleteMany({});
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

async function registerOther(email: string): Promise<{ token: string; id: string }> {
  const res = await request(server)
    .post('/auth/register')
    .send({ name: 'Other', email, password: 'password123' });
  return { token: res.body.token, id: res.body.user.id };
}

function setLaundry(id: unknown, body: object, as = token) {
  return request(server)
    .patch(`/items/${String(id)}/laundry`)
    .set('Authorization', `Bearer ${as}`)
    .send(body);
}

/** Re-read one item's denormalised laundry status straight from the database. */
async function readStatus(id: unknown): Promise<string> {
  const doc = await ClothingItem.findById(id).lean();
  return (doc as unknown as { laundryStatus: string }).laundryStatus;
}

/** The transition log for one item, oldest first. */
async function transitions(id: mongoose.Types.ObjectId) {
  return LaundryStatus.find({ itemId: id }).sort({ changedAt: 1, _id: 1 }).lean();
}

const MALFORMED_ID = 'not-an-object-id';

describe('PATCH /items/:id/laundry (TC-09)', () => {
  it('marks an item as in_laundry and returns the updated item', async () => {
    const item = await seedItem(ownerId);
    expect(item.laundryStatus).toBe('available');

    const res = await setLaundry(item._id, { status: 'in_laundry' });

    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe(String(item._id));
    expect(res.body.item.laundryStatus).toBe('in_laundry');
    // The response is a full PublicClothingItem, signed like every other
    // item-returning route -- TC-09's tile re-renders straight from it rather
    // than re-fetching the wardrobe.
    expect(res.body.item.imageUrl).toEqual(expect.any(String));
    expect(res.body.item.userId).toBe(ownerId);
  });

  it('requires authentication', async () => {
    const item = await seedItem(ownerId);

    const res = await request(server)
      .patch(`/items/${String(item._id)}/laundry`)
      .send({ status: 'in_laundry' });

    expect(res.status).toBe(401);
    expect(await readStatus(item._id)).toBe('available');
    expect(await transitions(item._id)).toHaveLength(0);
  });

  it('APPENDS a transition row and updates the item together', async () => {
    const item = await seedItem(ownerId);
    const before = Date.now();

    const res = await setLaundry(item._id, { status: 'in_laundry' });
    expect(res.status).toBe(200);

    // HALF ONE: the transition log recorded the event.
    const rows = await transitions(item._id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('in_laundry');
    expect(String(rows[0].itemId)).toBe(String(item._id));
    // Scoped to the caller, from the verified token -- see the model's note on
    // why the log carries userId at all.
    expect(String(rows[0].userId)).toBe(ownerId);
    expect(rows[0].changedAt).toBeInstanceOf(Date);
    expect(rows[0].changedAt.getTime()).toBeGreaterThanOrEqual(before);

    // HALF TWO: the denormalised current status moved with it.
    expect(await readStatus(item._id)).toBe('in_laundry');

    // AND THEY AGREE. This is the ruling-2 invariant, and it is the assertion
    // that has to fail from BOTH directions: delete the log write and the
    // length check above fails; delete the item write and this one does.
    expect(rows[rows.length - 1].status).toBe(await readStatus(item._id));
    expect(res.body.item.laundryStatus).toBe(await readStatus(item._id));
  });

  it('records a transition even when the status is unchanged', async () => {
    const item = await seedItem(ownerId, { laundryStatus: 'in_laundry' });

    const res = await setLaundry(item._id, { status: 'in_laundry' });

    expect(res.status).toBe(200);
    expect(res.body.item.laundryStatus).toBe('in_laundry');
    expect(await readStatus(item._id)).toBe('in_laundry');

    // The log is a record of EVENTS, and "the user pressed it again" is a real
    // event. Suppressing the row because the value did not change would
    // silently lose that provenance, and the history would then imply nothing
    // happened between two transitions when something did.
    const rows = await transitions(item._id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('in_laundry');
  });

  it('marks an item back to available', async () => {
    const item = await seedItem(ownerId);

    await setLaundry(item._id, { status: 'in_laundry' });
    const res = await setLaundry(item._id, { status: 'available' });

    expect(res.status).toBe(200);
    expect(res.body.item.laundryStatus).toBe('available');
    expect(await readStatus(item._id)).toBe('available');

    // Both transitions kept, in the order they happened. The log accumulates;
    // it is not a single row that gets overwritten.
    const rows = await transitions(item._id);
    expect(rows.map((r) => r.status)).toEqual(['in_laundry', 'available']);
  });

  it('rejects an unknown status with 400', async () => {
    const item = await seedItem(ownerId, { laundryStatus: 'in_laundry' });

    for (const body of [{ status: 'washing' }, { status: 'IN_LAUNDRY' }, { status: 1 }, {}]) {
      const res = await setLaundry(item._id, body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.fields[0].path).toBe('status');
      expect(res.body.item).toBeUndefined();
    }

    // A rejected request leaves neither write behind.
    expect(await readStatus(item._id)).toBe('in_laundry');
    expect(await transitions(item._id)).toHaveLength(0);
  });

  it("returns 404 for another user's item and does not modify it", async () => {
    const other = await registerOther('other@example.com');
    const foreign = await seedItem(other.id);

    const res = await setLaundry(foreign._id, { status: 'in_laundry' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // The ROUTE's 404, not the router's. Asserted on the message because
    // `notFoundHandler` also answers 404 for an unmounted path, so a status
    // check alone would pass against a route that does not exist.
    expect(res.body.error.message).toBe('Item not found');
    // 404, never 403: a 403 would confirm through the status code alone that
    // an item exists at an id the caller has no business knowing about.
    expect(res.status).not.toBe(403);
    expect(await readStatus(foreign._id)).toBe('available');
    expect(await transitions(foreign._id)).toHaveLength(0);
  });

  it('returns 404 for a malformed id with an identical body', async () => {
    const other = await registerOther('other@example.com');
    const foreign = await seedItem(other.id);
    const missing = new mongoose.Types.ObjectId();

    const foreignRes = await setLaundry(foreign._id, { status: 'in_laundry' });
    const malformedRes = await setLaundry(MALFORMED_ID, { status: 'in_laundry' });
    const missingRes = await setLaundry(missing, { status: 'in_laundry' });

    // Byte-identical, not merely same-status: distinguishing the three would
    // leak, through the response alone, which ids have documents behind them.
    expect(malformedRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    expect(foreignRes.status).toBe(404);
    // Again the route's own body, so this cannot pass against an unmounted
    // path where `notFoundHandler` would make all three identical for free.
    expect(foreignRes.body.error.message).toBe('Item not found');
    expect(JSON.stringify(malformedRes.body)).toBe(JSON.stringify(foreignRes.body));
    expect(JSON.stringify(missingRes.body)).toBe(JSON.stringify(foreignRes.body));
  });

  it('matches an id whose hex is uppercased, rather than 404ing on its own item', async () => {
    // An ObjectId's hex form is case-insensitive, so this is the SAME id the
    // client was handed -- a client that upcases it must not be told its own
    // item does not exist. Stage 5 shipped exactly this bug on a map keyed by
    // raw request id.
    const item = await seedItem(ownerId);
    const upper = String(item._id).toUpperCase();
    expect(upper).not.toBe(String(item._id));

    const res = await setLaundry(upper, { status: 'in_laundry' });

    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe(String(item._id));

    // And the row it logged is keyed on the canonical id, so the history for
    // this item is one series rather than two that depend on request casing.
    const rows = await transitions(item._id);
    expect(rows).toHaveLength(1);
  });

  it('leaves NO orphan transition row when the item write fails', async () => {
    // The other half of the ruling-2 invariant, and the one ordering alone
    // does not give you. `create` succeeding while `save` throws is not a
    // crash -- it is an ordinary 500 that leaves a transition row recording a
    // status change that never took effect.
    //
    // The document is inserted through the raw collection to bypass
    // validation, which is exactly how a real one gets into this state: a row
    // written before a guard existed, or any later stage removing a value from
    // ITEM_CATEGORIES. `save()` validates EVERY path, not only the modified
    // one, so writing `laundryStatus` on it throws over a field this route
    // never touched.
    const legacy = await ClothingItem.collection.insertOne({
      userId: new mongoose.Types.ObjectId(ownerId),
      imageKey: `items/${ownerId}/${randomUUID()}.jpg`,
      // Not in ITEM_CATEGORIES. Valid when it was written; invalid now.
      category: 'kilt',
      colors: [],
      seasons: [],
      laundryStatus: 'available',
      wearCount: 0,
      source: 'manual',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // errorHandler logs every unhandled error; silenced so the suite output
    // stays pristine. The test deliberately asserts nothing about the spy --
    // what matters here is the surviving state, not the log line.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let res;
    try {
      res = await setLaundry(legacy.insertedId, { status: 'in_laundry' });
    } finally {
      consoleError.mockRestore();
    }

    // The request genuinely failed -- this is not a test of a happy path in
    // disguise.
    expect(res.status).toBe(500);

    // NEITHER write survives. Without the compensating delete the row is still
    // here, and the log claims a transition the wardrobe never made.
    expect(await transitions(legacy.insertedId)).toHaveLength(0);
    expect(await LaundryStatus.countDocuments({})).toBe(0);
    expect(await readStatus(legacy.insertedId)).toBe('available');
  });

  it('reports a body-less request at the body root, not at status', async () => {
    // With no Content-Type, Express 5 leaves `req.body` undefined, so zod
    // reports at the ROOT rather than at `status`. Pinned because the
    // difference is easy to overstate in a contract: every request that
    // carries a body reports `status`, and this one does not.
    const item = await seedItem(ownerId);

    const res = await request(server)
      .patch(`/items/${String(item._id)}/laundry`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields[0].path).toBe('(body)');
    expect(await readStatus(item._id)).toBe('available');
    expect(await transitions(item._id)).toHaveLength(0);
  });

  it('does not touch any other item of the caller', async () => {
    const target = await seedItem(ownerId);
    const bystander = await seedItem(ownerId);

    const res = await setLaundry(target._id, { status: 'in_laundry' });
    expect(res.status).toBe(200);

    expect(await readStatus(target._id)).toBe('in_laundry');
    expect(await readStatus(bystander._id)).toBe('available');
    expect(await transitions(bystander._id)).toHaveLength(0);
  });
});

describe('ClothingItem.laundryStatus (the denormalised half)', () => {
  it('refuses a status outside the shared union', async () => {
    // The route's zod schema is the guard a client meets, so no HTTP request
    // can reach this one -- unreachable from the API, distinguishable at the
    // model layer, the same distinction `LaundryStatus.changedAt` documents.
    // It is worth having: this field is what the wardrobe grid renders and
    // what `GET /analytics/usage` counts, and a value outside the union would
    // be a tile with no treatment and a count that silently misses rows.
    await expect(
      ClothingItem.create({
        userId: ownerId,
        imageKey: `items/${ownerId}/${randomUUID()}.jpg`,
        category: 'tshirt',
        source: 'manual',
        laundryStatus: 'washing',
      }),
    ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);

    expect(await ClothingItem.countDocuments({})).toBe(0);
  });
});

describe('LaundryStatus model', () => {
  it('refuses to create a transition with no changedAt', async () => {
    // Unreachable from the API -- the route stamps `changedAt` before it
    // creates anything -- but perfectly observable one layer down, which is
    // the difference between "no test can see this" and "no HTTP test can".
    // Without this, `required: true` and `required: true, default: Date.now`
    // are indistinguishable, and a future writer that forgets to date a
    // transition would get a row silently dated "now" instead of an error.
    const item = await seedItem(ownerId);

    await expect(
      LaundryStatus.create({ userId: ownerId, itemId: item._id, status: 'in_laundry' }),
    ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);

    expect(await LaundryStatus.countDocuments({})).toBe(0);
  });

  it('refuses to create a transition with a status outside the shared union', async () => {
    const item = await seedItem(ownerId);

    // Cast because the union is enforced at the TYPE level too -- that is the
    // point of deriving both from LAUNDRY_STATUSES -- so the only way to ask
    // whether the RUNTIME guard is also present is to defeat the compiler.
    await expect(
      LaundryStatus.create({
        userId: ownerId,
        itemId: item._id,
        status: 'washing',
        changedAt: new Date(),
      } as unknown as Record<string, unknown>),
    ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);

    expect(await LaundryStatus.countDocuments({})).toBe(0);
  });
});
