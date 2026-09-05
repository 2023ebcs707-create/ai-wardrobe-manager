import request from 'supertest';
import mongoose from 'mongoose';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { connectDatabase } from '../db';
import { User } from '../models/User';
import { ClothingItem, type ClothingItemDoc } from '../models/ClothingItem';
import { Outfit, type OutfitDoc } from '../models/Outfit';
import { OutfitPlan } from '../models/OutfitPlan';
import { WearHistory } from '../models/WearHistory';
import { createStorageProvider } from '../storage/MinioStorageProvider';
import { resolvePlannedFor } from './outfitPlans';
import { ApiError } from '../http/errors';

const config = loadConfig({ JWT_SECRET: 'plans-test-secret', MONGO_URL: process.env.MONGO_URL });
const storage = createStorageProvider(config);
const okChecks = {
  database: async () => 'ok' as const,
  storage: async () => 'ok' as const,
  ai: async () => 'ok' as const,
};
const app = createApp(okChecks, config, storage);

let server: Server;

let token = '';
let ownerId = '';

beforeAll(async () => {
  server = app.listen(0);
  await connectDatabase(config.mongoUrl);
  await User.init();
  await ClothingItem.init();
  await Outfit.init();
  await OutfitPlan.init();
}, 30000);

async function clean(): Promise<void> {
  await User.deleteMany({});
  await ClothingItem.deleteMany({});
  await Outfit.deleteMany({});
  await OutfitPlan.deleteMany({});
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
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function seedItem(owner: string): Promise<ClothingItemDoc> {
  return (await ClothingItem.create({
    userId: owner,
    imageKey: `items/${owner}/${randomUUID()}.jpg`,
    category: 'tshirt',
    source: 'manual',
  })) as ClothingItemDoc;
}

async function seedOutfit(owner: string, name?: string): Promise<OutfitDoc> {
  const items = [await seedItem(owner), await seedItem(owner)];
  return (await Outfit.create({
    userId: owner,
    ...(name ? { name } : {}),
    itemIds: items.map((item) => item._id),
  })) as OutfitDoc;
}

async function registerOther(email: string): Promise<{ token: string; id: string }> {
  const res = await request(server)
    .post('/auth/register')
    .send({ name: 'Other', email, password: 'password123' });
  return { token: res.body.token, id: res.body.user.id };
}

function plan(body: object, as = token) {
  return request(server).post('/outfit-plans').set('Authorization', `Bearer ${as}`).send(body);
}

function list(query = '', as = token) {
  return request(server).get(`/outfit-plans${query}`).set('Authorization', `Bearer ${as}`);
}

function cancel(id: unknown, as = token) {
  return request(server).delete(`/outfit-plans/${String(id)}`).set('Authorization', `Bearer ${as}`);
}

/** An instant safely in the future, in days from now. */
function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

const MALFORMED_ID = 'not-an-object-id';

describe('POST /outfit-plans', () => {
  it('plans an outfit for a future day', async () => {
    const outfit = await seedOutfit(ownerId, 'Friday');
    const plannedFor = inDays(3);

    const res = await plan({ outfitId: String(outfit._id), plannedFor });

    expect(res.status).toBe(201);
    expect(res.body.plan.outfitId).toBe(String(outfit._id));
    expect(res.body.plan.outfitName).toBe('Friday');
    expect(res.body.plan.userId).toBe(ownerId);
    expect(new Date(res.body.plan.plannedFor).toISOString()).toBe(plannedFor);
    // The composition is SNAPSHOTTED onto the plan, not read through the
    // outfit at display time.
    expect(res.body.plan.itemIds).toEqual(outfit.itemIds.map((id) => String(id)));
  });

  it('carries an occasion, and stores a blank one as absent', async () => {
    const outfit = await seedOutfit(ownerId);

    const withOccasion = await plan({
      outfitId: String(outfit._id),
      plannedFor: inDays(1),
      occasion: 'work',
    });
    expect(withOccasion.status).toBe(201);
    expect(withOccasion.body.plan.occasion).toBe('work');

    const blank = await plan({
      outfitId: String(outfit._id),
      plannedFor: inDays(2),
      occasion: '   ',
    });
    expect(blank.status).toBe(201);
    expect(blank.body.plan.occasion).toBeUndefined();
  });

  it('DOES NOT touch wear counts — a plan is not a wear', async () => {
    // The entire reason plans are their own collection. If this ever fails,
    // `GET /analytics/usage` is ranking garments by days that have not
    // happened yet.
    const outfit = await seedOutfit(ownerId);

    const res = await plan({ outfitId: String(outfit._id), plannedFor: inDays(2) });
    expect(res.status).toBe(201);

    const items = await ClothingItem.find({ userId: ownerId }).lean();
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.wearCount).toBe(0);
      expect(item.lastWornAt).toBeUndefined();
    }
    // And no wear event was written either.
    expect(await WearHistory.countDocuments({})).toBe(0);
  });

  it('rejects a plannedFor in the past with 400', async () => {
    const outfit = await seedOutfit(ownerId);

    const res = await plan({ outfitId: String(outfit._id), plannedFor: inDays(-1) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields[0].path).toBe('plannedFor');
    expect(await OutfitPlan.countDocuments({})).toBe(0);
  });

  it('rejects a malformed plannedFor with 400', async () => {
    const outfit = await seedOutfit(ownerId);

    const res = await plan({ outfitId: String(outfit._id), plannedFor: 'next tuesday' });

    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].path).toBe('plannedFor');
    expect(await OutfitPlan.countDocuments({})).toBe(0);
  });

  it('requires authentication', async () => {
    const outfit = await seedOutfit(ownerId);

    const res = await request(server)
      .post('/outfit-plans')
      .send({ outfitId: String(outfit._id), plannedFor: inDays(1) });

    expect(res.status).toBe(401);
    expect(await OutfitPlan.countDocuments({})).toBe(0);
  });

  it("refuses another user's outfit with the same body as an unknown one", async () => {
    const other = await registerOther('other@example.com');
    const theirs = await seedOutfit(other.id, 'Theirs');
    const missing = new mongoose.Types.ObjectId();

    const foreignRes = await plan({ outfitId: String(theirs._id), plannedFor: inDays(1) });
    const missingRes = await plan({ outfitId: String(missing), plannedFor: inDays(1) });
    const malformedRes = await plan({ outfitId: MALFORMED_ID, plannedFor: inDays(1) });

    expect(foreignRes.status).toBe(400);
    expect(foreignRes.body.error.message).toBe('Unknown outfit');
    // Byte-identical: distinguishing them would confirm through the response
    // alone that an outfit exists at an id the caller cannot see.
    expect(JSON.stringify(missingRes.body)).toBe(JSON.stringify(foreignRes.body));
    expect(JSON.stringify(malformedRes.body)).toBe(JSON.stringify(foreignRes.body));
    // And the outfit's NAME never leaks through the rejection.
    expect(JSON.stringify(foreignRes.body)).not.toContain('Theirs');
    expect(await OutfitPlan.countDocuments({})).toBe(0);
  });
});

describe('GET /outfit-plans', () => {
  it('returns the plans inside the range, soonest first', async () => {
    const outfit = await seedOutfit(ownerId, 'Friday');
    // Deliberately created out of order, so an implementation that returned
    // insertion order would fail.
    await plan({ outfitId: String(outfit._id), plannedFor: inDays(5) });
    await plan({ outfitId: String(outfit._id), plannedFor: inDays(2) });
    await plan({ outfitId: String(outfit._id), plannedFor: inDays(9) });

    const res = await list(`?from=${encodeURIComponent(inDays(0))}&to=${encodeURIComponent(inDays(10))}`);

    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(3);
    const dates = res.body.plans.map((p: { plannedFor: string }) => p.plannedFor);
    expect([...dates]).toEqual([...dates].sort());
    expect(res.body.plans[0].outfitName).toBe('Friday');
  });

  it('excludes plans outside the range', async () => {
    const outfit = await seedOutfit(ownerId);
    await plan({ outfitId: String(outfit._id), plannedFor: inDays(2) });
    await plan({ outfitId: String(outfit._id), plannedFor: inDays(40) });

    const res = await list(`?from=${encodeURIComponent(inDays(0))}&to=${encodeURIComponent(inDays(10))}`);

    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(1);
  });

  it("never returns another user's plans", async () => {
    const other = await registerOther('other@example.com');
    const theirOutfit = await seedOutfit(other.id, 'Theirs');
    await plan({ outfitId: String(theirOutfit._id), plannedFor: inDays(2) }, other.token);

    const res = await list(`?from=${encodeURIComponent(inDays(0))}&to=${encodeURIComponent(inDays(10))}`);

    expect(res.status).toBe(200);
    expect(res.body.plans).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('Theirs');
  });

  it('requires both range bounds', async () => {
    for (const query of ['', `?from=${encodeURIComponent(inDays(0))}`, `?to=${encodeURIComponent(inDays(9))}`]) {
      const res = await list(query);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('rejects a range that ends before it starts', async () => {
    const res = await list(`?from=${encodeURIComponent(inDays(9))}&to=${encodeURIComponent(inDays(1))}`);
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].path).toBe('to');
  });

  it('still lists a plan whose outfit was deleted, with no name', async () => {
    // Ruling-3 shaped: deleting an outfit does not un-plan the day. The plan
    // describes itself from its own snapshotted itemIds.
    const outfit = await seedOutfit(ownerId, 'Doomed');
    const created = await plan({ outfitId: String(outfit._id), plannedFor: inDays(2) });
    expect(created.status).toBe(201);

    await Outfit.deleteOne({ _id: outfit._id });

    const res = await list(`?from=${encodeURIComponent(inDays(0))}&to=${encodeURIComponent(inDays(10))}`);

    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0].outfitName).toBeUndefined();
    expect(res.body.plans[0].itemIds).toHaveLength(2);
  });

  it('requires authentication', async () => {
    const res = await request(server).get('/outfit-plans');
    expect(res.status).toBe(401);
  });
});

describe('DELETE /outfit-plans/:id', () => {
  it('cancels a plan', async () => {
    const outfit = await seedOutfit(ownerId);
    const created = await plan({ outfitId: String(outfit._id), plannedFor: inDays(2) });

    const res = await cancel(created.body.plan.id);

    expect(res.status).toBe(204);
    expect(await OutfitPlan.countDocuments({})).toBe(0);
  });

  it("returns 404 for another user's plan and does not delete it", async () => {
    const other = await registerOther('other@example.com');
    const theirOutfit = await seedOutfit(other.id);
    const theirs = await plan(
      { outfitId: String(theirOutfit._id), plannedFor: inDays(2) },
      other.token,
    );

    const res = await cancel(theirs.body.plan.id);

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    expect(await OutfitPlan.countDocuments({})).toBe(1);
  });

  it('returns 404 for a malformed id and for one that is already gone', async () => {
    const outfit = await seedOutfit(ownerId);
    const created = await plan({ outfitId: String(outfit._id), plannedFor: inDays(2) });

    expect((await cancel(MALFORMED_ID)).status).toBe(404);
    expect((await cancel(new mongoose.Types.ObjectId())).status).toBe(404);
    expect((await cancel(created.body.plan.id)).status).toBe(204);
    // Not idempotent-silent: the second delete is a 404, so a client cannot
    // retry blindly and be told it worked.
    expect((await cancel(created.body.plan.id)).status).toBe(404);
  });

  it('requires authentication', async () => {
    const outfit = await seedOutfit(ownerId);
    const created = await plan({ outfitId: String(outfit._id), plannedFor: inDays(2) });

    const res = await request(server).delete(`/outfit-plans/${created.body.plan.id}`);

    expect(res.status).toBe(401);
    expect(await OutfitPlan.countDocuments({})).toBe(1);
  });
});

describe('resolvePlannedFor (the boundary, unit-level)', () => {
  // Over HTTP alone, `now` is always taken after the request landed, so an
  // instant equal to it is unobservable — which is exactly why this is tested
  // directly, the same way `resolveWornAt` is.
  const now = new Date('2026-09-05T12:00:00.000Z');

  it('accepts an instant equal to now', () => {
    expect(resolvePlannedFor(now.toISOString(), now).toISOString()).toBe(now.toISOString());
  });

  it('accepts the future', () => {
    const later = new Date(now.getTime() + 1000).toISOString();
    expect(resolvePlannedFor(later, now).toISOString()).toBe(later);
  });

  it('rejects one millisecond into the past', () => {
    const earlier = new Date(now.getTime() - 1).toISOString();
    expect(() => resolvePlannedFor(earlier, now)).toThrow(ApiError);
  });

  it('rejects an unparseable value', () => {
    expect(() => resolvePlannedFor('not a date', now)).toThrow(ApiError);
  });
});
