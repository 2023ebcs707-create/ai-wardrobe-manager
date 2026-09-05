import request from 'supertest';
import mongoose from 'mongoose';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { connectDatabase } from '../db';
import { User } from '../models/User';
import { ClothingItem, type ClothingItemDoc } from '../models/ClothingItem';
import { createStorageProvider } from '../storage/MinioStorageProvider';

/**
 * `PATCH /items/:id/retire` and `DELETE /items/:id`.
 *
 * Its own file rather than more tests inside `items.integration.test.ts`, for
 * the same reason `itemsLaundry.integration.test.ts` is its own file: that
 * file's setup exists to exercise upload, and neither of these routes needs
 * any of it.
 */
const config = loadConfig({ JWT_SECRET: 'retire-delete-test-secret', MONGO_URL: process.env.MONGO_URL });
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
}, 30000);

async function clean(): Promise<void> {
  await User.deleteMany({});
  await ClothingItem.deleteMany({});
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

function setRetired(id: unknown, body: object, as = token) {
  return request(server)
    .patch(`/items/${String(id)}/retire`)
    .set('Authorization', `Bearer ${as}`)
    .send(body);
}

function del(id: unknown, as = token) {
  return request(server).delete(`/items/${String(id)}`).set('Authorization', `Bearer ${as}`);
}

async function readRetired(id: unknown): Promise<boolean> {
  const doc = await ClothingItem.findById(id).lean();
  return (doc as unknown as { retired: boolean }).retired;
}

const MALFORMED_ID = 'not-an-object-id';

describe('PATCH /items/:id/retire', () => {
  it('retires an item and returns the updated item', async () => {
    const item = await seedItem(ownerId);
    expect(item.retired).toBe(false);

    const res = await setRetired(item._id, { retired: true });

    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe(String(item._id));
    expect(res.body.item.retired).toBe(true);
    expect(res.body.item.imageUrl).toEqual(expect.any(String));
    expect(await readRetired(item._id)).toBe(true);
  });

  it('un-retires an item back to active', async () => {
    const item = await seedItem(ownerId, { retired: true });

    const res = await setRetired(item._id, { retired: false });

    expect(res.status).toBe(200);
    expect(res.body.item.retired).toBe(false);
    expect(await readRetired(item._id)).toBe(false);
  });

  it('requires authentication', async () => {
    const item = await seedItem(ownerId);

    const res = await request(server).patch(`/items/${String(item._id)}/retire`).send({ retired: true });

    expect(res.status).toBe(401);
    expect(await readRetired(item._id)).toBe(false);
  });

  it('rejects a non-boolean body with 400', async () => {
    const item = await seedItem(ownerId);

    for (const body of [{ retired: 'yes' }, { retired: 1 }, {}]) {
      const res = await setRetired(item._id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect(await readRetired(item._id)).toBe(false);
  });

  it("returns 404 for another user's item and does not modify it", async () => {
    const other = await registerOther('other@example.com');
    const foreign = await seedItem(other.id);

    const res = await setRetired(foreign._id, { retired: true });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Item not found');
    expect(res.status).not.toBe(403);
    expect(await readRetired(foreign._id)).toBe(false);
  });

  it('returns 404 for a malformed id with an identical body to a foreign one', async () => {
    const other = await registerOther('other@example.com');
    const foreign = await seedItem(other.id);
    const missing = new mongoose.Types.ObjectId();

    const foreignRes = await setRetired(foreign._id, { retired: true });
    const malformedRes = await setRetired(MALFORMED_ID, { retired: true });
    const missingRes = await setRetired(missing, { retired: true });

    expect(malformedRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    expect(foreignRes.status).toBe(404);
    expect(JSON.stringify(malformedRes.body)).toBe(JSON.stringify(foreignRes.body));
    expect(JSON.stringify(missingRes.body)).toBe(JSON.stringify(foreignRes.body));
  });
});

describe('DELETE /items/:id', () => {
  it('deletes an item outright', async () => {
    const item = await seedItem(ownerId);

    const res = await del(item._id);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(await ClothingItem.findById(item._id).lean()).toBeNull();
  });

  it('removes the object, and its thumbnail, from storage', async () => {
    const key = `items/${ownerId}/${randomUUID()}.jpg`;
    const thumbnailKey = `items/${ownerId}/${randomUUID()}-thumb.jpg`;
    await storage.put(key, Buffer.from('fake-image-bytes'), 'image/jpeg');
    await storage.put(thumbnailKey, Buffer.from('fake-thumb-bytes'), 'image/jpeg');
    const item = await seedItem(ownerId, { imageKey: key, thumbnailKey });

    const res = await del(item._id);
    expect(res.status).toBe(204);

    // MinIO's getObject rejects for a key that no longer exists.
    await expect(storage.get(key)).rejects.toBeTruthy();
    await expect(storage.get(thumbnailKey)).rejects.toBeTruthy();
  });

  it('requires authentication', async () => {
    const item = await seedItem(ownerId);

    const res = await request(server).delete(`/items/${String(item._id)}`);

    expect(res.status).toBe(401);
    expect(await ClothingItem.findById(item._id).lean()).not.toBeNull();
  });

  it("returns 404 for another user's item and does not delete it", async () => {
    const other = await registerOther('other@example.com');
    const foreign = await seedItem(other.id);

    const res = await del(foreign._id);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Item not found');
    expect(res.status).not.toBe(403);
    expect(await ClothingItem.findById(foreign._id).lean()).not.toBeNull();
  });

  it('returns 404 for a malformed id with an identical body to a foreign one', async () => {
    const other = await registerOther('other@example.com');
    const foreign = await seedItem(other.id);
    const missing = new mongoose.Types.ObjectId();

    const foreignRes = await del(foreign._id);
    // A fresh foreign item for the malformed/missing comparisons, since the
    // first delete above already consumed `foreign`.
    const secondForeign = await seedItem(other.id);
    const malformedRes = await del(MALFORMED_ID);
    const missingRes = await del(missing);
    const secondForeignRes = await del(secondForeign._id);

    expect(foreignRes.status).toBe(404);
    expect(malformedRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    expect(JSON.stringify(malformedRes.body)).toBe(JSON.stringify(foreignRes.body));
    expect(JSON.stringify(missingRes.body)).toBe(JSON.stringify(foreignRes.body));
    expect(secondForeignRes.status).toBe(404);
  });

  it('is not idempotent-silent: deleting an already-deleted item is 404', async () => {
    const item = await seedItem(ownerId);
    const first = await del(item._id);
    expect(first.status).toBe(204);

    const second = await del(item._id);
    expect(second.status).toBe(404);
  });

  it('does not touch any other item of the caller', async () => {
    const target = await seedItem(ownerId);
    const bystander = await seedItem(ownerId);

    const res = await del(target._id);
    expect(res.status).toBe(204);

    expect(await ClothingItem.findById(target._id).lean()).toBeNull();
    expect(await ClothingItem.findById(bystander._id).lean()).not.toBeNull();
  });
});
