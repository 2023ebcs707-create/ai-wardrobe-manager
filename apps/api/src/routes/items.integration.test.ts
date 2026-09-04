import request from 'supertest';
import mongoose from 'mongoose';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { connectDatabase } from '../db';
import { User } from '../models/User';
import { ClothingItem, type ClothingItemDoc } from '../models/ClothingItem';
import { createStorageProvider } from '../storage/MinioStorageProvider';
import { MAX_THUMBNAIL_BYTES } from './items';

const config = loadConfig({ JWT_SECRET: 'items-test-secret', MONGO_URL: process.env.MONGO_URL });
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

// A real, classifiable garment photo (ground truth: tshirt), used by the
// live AI-tagging tests below. Distinct from the minimal JPEG fixture
// further down, which has no actual pixel data and the AI service correctly
// refuses to decode.
const TSHIRT_FIXTURE = fs.readFileSync(
  path.resolve(__dirname, '../../../../services/ai/tests/fixtures/tshirt-0.jpg'),
);

// docker-compose.yml lives at the repo root, four levels up from this file
// (routes -> src -> api -> apps -> root).
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');

async function waitForAiHealthy(baseUrl: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status === 'ok') return;
      }
    } catch {
      // Not accepting connections yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`AI service at ${baseUrl} did not report healthy within ${timeoutMs}ms`);
}

// A minimal but genuinely valid JPEG: SOI, APP0/JFIF, EOI.
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

// The PNG signature (8 bytes) is all magic-byte detection reads; the rest is
// an arbitrary trailer so the fixture stays a real, distinguishable file.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

// A second JPEG whose bytes differ from JPEG's -- the trailer sits after the
// EOI marker, so the stream is still exactly as valid as JPEG is. Distinct
// content is the only way a test can prove the thumbnail bytes went to the
// thumbnail key rather than the image bytes being stored twice.
const THUMBNAIL_JPEG = Buffer.concat([JPEG, Buffer.from('thumb', 'ascii')]);

let token = '';
// The owner's own id, straight from the register response. The GET /items
// tests below seed documents directly through the model (they need control
// over createdAt), so they need the id the token's `sub` carries.
let ownerId = '';
const storedKeys: string[] = [];

// Fix round 1, finding 2: `tagImage` now logs via console.warn on every
// failure path (unreachable, non-2xx, malformed shape). Most fixtures in
// this file (the minimal JPEG, the PNG signature stub) are deliberately not
// real, decodable garment photos, so the live AI service legitimately
// rejects them and tagImage legitimately warns on almost every upload here
// -- that is expected noise from fixture content, not something each
// unrelated test should have to know about or assert on. Silence it
// globally, the same way the orphan-cleanup test below silences the
// unrelated console.error it triggers; the warn's actual content is pinned
// by apps/api/src/ai/tagClient.test.ts's dedicated, per-branch assertions,
// and the fail-soft test below additionally asserts it fires for that one
// case it specifically cares about.
let consoleWarn: jest.SpyInstance;

beforeAll(async () => {
  server = app.listen(0);
  await connectDatabase(config.mongoUrl);
  await User.init();
  await ClothingItem.init();
}, 30000);

beforeEach(async () => {
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  await User.deleteMany({});
  await ClothingItem.deleteMany({});
  const res = await request(server)
    .post('/auth/register')
    .send({ name: 'Owner', email: 'owner@example.com', password: 'password123' });
  token = res.body.token;
  ownerId = res.body.user.id;
});

afterEach(() => {
  consoleWarn.mockRestore();
});

afterAll(async () => {
  await Promise.all(storedKeys.map((k) => storage.delete(k).catch(() => undefined)));
  await User.deleteMany({});
  await ClothingItem.deleteMany({});
  await mongoose.disconnect();
  // closeAllConnections first: `close()` alone waits for live sockets and
  // would hang this hook rather than fail it.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('TC-03 image upload', () => {
  it('stores the image and persists its metadata', async () => {
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'tshirt')
      .field('seasons', 'summer')
      .attach('image', JPEG, { filename: 'shirt.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.item.category).toBe('tshirt');
    expect(res.body.item.seasons).toEqual(['summer']);
    expect(res.body.item.imageUrl).toEqual(expect.stringContaining('http'));
    // This fixture is SOI/APP0/EOI only — no actual pixel data — so the live
    // AI service correctly 400s on it and tagImage() falls back to null:
    // source stays 'manual' here even with the AI container healthy. The
    // 'ai' path (real photo, live service) is covered by the "TC-04 / TC-05
    // AI tagging" describe block below; the deliberate 'manual' path via an
    // unreachable AI container is covered by its "fail-soft" sibling.
    expect(res.body.item.source).toBe('manual');

    const doc = await ClothingItem.findById(res.body.item.id).lean();
    expect(doc).not.toBeNull();
    expect(doc!.imageKey).toEqual(expect.any(String));
    expect(doc!.source).toBe('manual');
    storedKeys.push(doc!.imageKey);
  }, 30000);

  it('stores the exact bytes that were uploaded', async () => {
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'shirt')
      .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' });

    const doc = await ClothingItem.findById(res.body.item.id).lean();
    storedKeys.push(doc!.imageKey);

    const bytes = await storage.get(doc!.imageKey);
    expect(bytes.equals(JPEG)).toBe(true);
  }, 30000);

  it('never exposes the raw storage key to the client', async () => {
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'shirt')
      .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' });

    const doc = await ClothingItem.findById(res.body.item.id).lean();
    storedKeys.push(doc!.imageKey);
    expect(JSON.stringify(res.body)).not.toContain('imageKey');
  }, 30000);

  it('attributes the item to the authenticated user, not a body field', async () => {
    const other = new mongoose.Types.ObjectId().toString();
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'shirt')
      .field('userId', other)
      .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' });

    const doc = await ClothingItem.findById(res.body.item.id).lean();
    storedKeys.push(doc!.imageKey);
    expect(String(doc!.userId)).not.toBe(other);
  }, 30000);

  it('requires authentication', async () => {
    const res = await request(server)
      .post('/items')
      .field('category', 'shirt')
      .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });

  it('rejects a request with no file', async () => {
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'shirt');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown category', async () => {
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'spacesuit')
      .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
  });

  it('rejects a non-image content type', async () => {
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'shirt')
      .attach('image', Buffer.from('#!/bin/sh\nrm -rf /'), {
        filename: 'evil.sh',
        contentType: 'application/x-sh',
      });
    expect(res.status).toBe(400);
  });

  // The declared Content-Type is a client-supplied multipart header, not
  // proof of what the bytes actually are. An attacker can upload arbitrary
  // bytes and simply lie about it. These four cases pin down that the
  // file's own magic bytes, not the declared header, decide what is
  // accepted and stored.
  it('accepts a real PNG', async () => {
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'shirt')
      .attach('image', PNG, { filename: 'x.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    const doc = await ClothingItem.findById(res.body.item.id).lean();
    storedKeys.push(doc!.imageKey);
    expect(doc!.imageKey).toEqual(expect.stringContaining('.png'));
  }, 30000);

  it('rejects a shell script that dishonestly declares itself as image/jpeg', async () => {
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'shirt')
      .attach('image', Buffer.from('#!/bin/sh\nrm -rf /'), {
        filename: 'evil.jpg',
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a real JPEG that declares a non-image content type', async () => {
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'shirt')
      .attach('image', JPEG, { filename: 'x.jpg', contentType: 'application/x-sh' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  // Stage 4 Task 2. `thumbnailKey` has been declared on the schema and on
  // PublicClothingItem since Stage 2 and was never once written by anything --
  // the grid would otherwise decode a 1280px photo per tile. The client
  // generates the thumbnail (expo-image-manipulator) and sends it as a second
  // file part; the API never decodes an image itself.
  describe('thumbnail part', () => {
    it('stores a thumbnail when one is supplied and returns a signed thumbnailUrl', async () => {
      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' })
        .attach('thumbnail', THUMBNAIL_JPEG, { filename: 'x-thumb.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);

      const doc = await ClothingItem.findById(res.body.item.id).lean();
      storedKeys.push(doc!.imageKey);
      storedKeys.push(doc!.thumbnailKey!);

      // Its own object under the caller's own prefix, never the image key
      // reused or a path derived from anything the client sent.
      expect(doc!.thumbnailKey).toMatch(
        new RegExp(`^items/${ownerId}/[0-9a-f-]{36}-thumb\\.jpg$`),
      );
      expect(doc!.thumbnailKey).not.toBe(doc!.imageKey);

      // The thumbnail's own bytes, not a second copy of the image.
      expect((await storage.get(doc!.thumbnailKey!)).equals(THUMBNAIL_JPEG)).toBe(true);
      expect((await storage.get(doc!.imageKey)).equals(JPEG)).toBe(true);

      // This is the assertion Task 1's review could not write: POST's
      // thumbnailUrl was untestable until something populated the key.
      expect(res.body.item.thumbnailUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
      expect(res.body.item.thumbnailUrl).toEqual(expect.stringContaining(doc!.thumbnailKey!));
      expect(res.body.item.thumbnailUrl).not.toBe(res.body.item.imageUrl);
      // The keys themselves still never reach the client.
      expect(JSON.stringify(res.body)).not.toContain('thumbnailKey');
    }, 30000);

    // Optional server-side on purpose: PublicClothingItem.thumbnailUrl is
    // optional and the grid falls back to imageUrl, which is what lets every
    // item uploaded before this stage keep working with no backfill.
    it('accepts an upload with no thumbnail part and omits thumbnailUrl', async () => {
      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);
      expect(res.body.item.thumbnailUrl).toBeUndefined();

      const doc = await ClothingItem.findById(res.body.item.id).lean();
      storedKeys.push(doc!.imageKey);
      expect(doc!.thumbnailKey).toBeUndefined();
    }, 30000);

    // A client-supplied file written to storage under the user's prefix.
    // Calling it a thumbnail does not make it trustworthy: Stage 2 found a
    // shell script declaring image/jpeg was accepted with 201 on the image
    // part, and the same hole must not reopen on a second field.
    it('rejects a thumbnail part whose bytes are not an image', async () => {
      const before = await ClothingItem.countDocuments({});

      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' })
        .attach('thumbnail', Buffer.from('#!/bin/sh\nrm -rf /'), {
          filename: 'evil-thumb.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      // Rejected before anything is written: no document, and (asserted by
      // the storage spy below) no object either.
      expect(await ClothingItem.countDocuments({})).toBe(before);
    }, 30000);

    it('rejects a thumbnail part that declares a type its bytes contradict', async () => {
      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' })
        .attach('thumbnail', PNG, { filename: 'x-thumb.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }, 30000);

    it('stores nothing at all when the thumbnail part is rejected', async () => {
      const putSpy = jest.spyOn(storage, 'put');

      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' })
        .attach('thumbnail', Buffer.from('#!/bin/sh\nrm -rf /'), {
          filename: 'evil-thumb.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(400);
      // Validating the thumbnail only after the image was already uploaded
      // would leave an orphan on every rejected request.
      expect(putSpy).not.toHaveBeenCalled();
      putSpy.mockRestore();
    }, 30000);

    // The single most likely defect in moving from upload.single('image') to
    // upload.fields([...]): `req.file` becomes `req.files`, and a narrowing
    // that reads the thumbnail slot (or reads `req.files` as truthy) would
    // let an image-less request through.
    it('still rejects a request that supplies only a thumbnail and no image', async () => {
      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('thumbnail', THUMBNAIL_JPEG, { filename: 'x-thumb.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'image' })]),
      );
    }, 30000);

    // multer's fileSize limit is per file, so the thumbnail gets its own 10MB
    // budget rather than sharing the image's.
    it('rejects an oversized thumbnail with 413', async () => {
      const tooBig = Buffer.concat([JPEG, Buffer.alloc(11 * 1024 * 1024, 0x00)]);
      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' })
        .attach('thumbnail', tooBig, { filename: 'huge-thumb.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }, 60000);

    // Magic bytes prove "this is an image". They prove nothing about how big
    // it is. Without a size bound, a buggy or hostile client can send a valid
    // 10MB JPEG under `thumbnail` and the server will store it and then sign
    // it as the grid's tile source -- defeating the entire reason this task
    // exists, and doubling per-item storage.
    it('rejects a thumbnail larger than MAX_THUMBNAIL_BYTES', async () => {
      const before = await ClothingItem.countDocuments({});
      const putSpy = jest.spyOn(storage, 'put');
      // Valid JPEG magic bytes, comfortably over the bound and comfortably
      // under multer's 10MB per-file cap, so this is our check rejecting it
      // and not multer's.
      const oversized = Buffer.concat([JPEG, Buffer.alloc(MAX_THUMBNAIL_BYTES, 0x00)]);

      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' })
        .attach('thumbnail', oversized, { filename: 'fat-thumb.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'thumbnail' })]),
      );
      // Rejected before anything is written, so there is no orphan and no row.
      expect(putSpy).not.toHaveBeenCalled();
      expect(await ClothingItem.countDocuments({})).toBe(before);
      putSpy.mockRestore();
    }, 60000);

    it('accepts a thumbnail at exactly MAX_THUMBNAIL_BYTES', async () => {
      // The bound is inclusive; a real 320px q0.6 JPEG is orders of magnitude
      // under it, so this only pins which side of the comparison is strict.
      const atLimit = Buffer.concat([
        JPEG,
        Buffer.alloc(MAX_THUMBNAIL_BYTES - JPEG.length, 0x00),
      ]);
      expect(atLimit.length).toBe(MAX_THUMBNAIL_BYTES);

      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' })
        .attach('thumbnail', atLimit, { filename: 'edge-thumb.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);
      const doc = await ClothingItem.findById(res.body.item.id).lean();
      storedKeys.push(doc!.imageKey);
      storedKeys.push(doc!.thumbnailKey!);
      expect(doc!.thumbnailKey).toEqual(expect.any(String));
    }, 60000);

    it('pins MAX_THUMBNAIL_BYTES so a silent widening is caught', () => {
      // Asserted directly: every other assertion compares the constant
      // against itself and would survive any change to its value.
      expect(MAX_THUMBNAIL_BYTES).toBe(512 * 1024);
    });

    // Pre-existing behaviour that nothing pinned: multer rejects a part it was
    // not told to expect with LIMIT_UNEXPECTED_FILE, which used to fall
    // through to a 500. Adding a second accepted field name makes it easier to
    // hit by accident, so it gets tests.
    it('rejects an unexpected file field with 400 rather than 500', async () => {
      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('photo', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }, 30000);

    it('rejects a duplicated image part with 400 rather than 500', async () => {
      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('image', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' })
        .attach('image', JPEG, { filename: 'b.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }, 30000);

    // With two stored objects a failed database write leaks the thumbnail
    // unless the cleanup deletes both. Asserted against real MinIO, not just
    // against the spy, because "delete() was called" is not the same claim as
    // "the object is gone".
    it('deletes BOTH stored objects when the database write fails', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const putSpy = jest.spyOn(storage, 'put');
      const deleteSpy = jest.spyOn(storage, 'delete');
      const createSpy = jest
        .spyOn(ClothingItem, 'create')
        .mockRejectedValueOnce(new Error('simulated database failure'));

      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' })
        .attach('thumbnail', THUMBNAIL_JPEG, { filename: 'x-thumb.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(500);

      expect(putSpy).toHaveBeenCalledTimes(2);
      const imageKey = putSpy.mock.calls[0][0];
      const thumbnailKey = putSpy.mock.calls[1][0];
      expect(thumbnailKey).toContain('-thumb.');

      expect(deleteSpy).toHaveBeenCalledWith(imageKey);
      expect(deleteSpy).toHaveBeenCalledWith(thumbnailKey);
      await expect(storage.get(imageKey)).rejects.toBeTruthy();
      await expect(storage.get(thumbnailKey)).rejects.toBeTruthy();

      createSpy.mockRestore();
      putSpy.mockRestore();
      deleteSpy.mockRestore();
      consoleError.mockRestore();
    }, 30000);

    // The mirror case: the image lands, storing the thumbnail then fails.
    // Without tracking what actually reached storage, the image is orphaned.
    it('deletes the already-stored image when storing the thumbnail fails', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const realPut = storage.put.bind(storage);
      const putSpy = jest
        .spyOn(storage, 'put')
        .mockImplementationOnce(realPut)
        .mockRejectedValueOnce(new Error('simulated storage failure'));
      const deleteSpy = jest.spyOn(storage, 'delete');

      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'shirt')
        .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' })
        .attach('thumbnail', THUMBNAIL_JPEG, { filename: 'x-thumb.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(500);

      const imageKey = putSpy.mock.calls[0][0];
      expect(deleteSpy).toHaveBeenCalledWith(imageKey);
      await expect(storage.get(imageKey)).rejects.toBeTruthy();
      // The thumbnail never reached storage, so it must not be deleted --
      // deleting a key that was never written would mask a real failure.
      expect(deleteSpy).toHaveBeenCalledTimes(1);

      putSpy.mockRestore();
      deleteSpy.mockRestore();
      consoleError.mockRestore();
    }, 30000);
  });

  // None of the tests above ever force ClothingItem.create to fail, so they
  // cannot catch a mutation that deletes the try/catch cleanup around it.
  // Simulate a DB failure directly and confirm the already-uploaded bytes
  // are removed rather than orphaned.
  it('deletes the uploaded object when the database write fails, leaving no orphan behind', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const putSpy = jest.spyOn(storage, 'put');
    const deleteSpy = jest.spyOn(storage, 'delete');
    const createSpy = jest
      .spyOn(ClothingItem, 'create')
      .mockRejectedValueOnce(new Error('simulated database failure'));

    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'shirt')
      .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(500);

    const key = putSpy.mock.calls[0][0];
    expect(deleteSpy).toHaveBeenCalledWith(key);
    // Assert against real MinIO, not just that delete() was called: the
    // object must actually be gone.
    await expect(storage.get(key)).rejects.toBeTruthy();

    createSpy.mockRestore();
    putSpy.mockRestore();
    deleteSpy.mockRestore();
    consoleError.mockRestore();
  }, 30000);
});

describe('TC-04 / TC-05 AI tagging', () => {
  it('tags a real garment photo via the live AI service', async () => {
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      // Deliberately mismatched from the real ground truth ('tshirt'): if
      // tagging silently failed and the route fell back to `meta.category`,
      // this test would still see a category, just the wrong one — 'other'
      // makes that failure mode visible instead of coincidentally passing.
      .field('category', 'other')
      .attach('image', TSHIRT_FIXTURE, { filename: 'tshirt-0.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    const doc = await ClothingItem.findById(res.body.item.id).lean();
    expect(doc).not.toBeNull();
    storedKeys.push(doc!.imageKey);

    expect(res.body.item.source).toBe('ai');
    // The model is frozen and this fixture's ground truth is 'tshirt'
    // (services/ai/tests/fixtures/README.md); Task 3 measured 94.4% category
    // accuracy upright, and a direct call against the live container during
    // this task's implementation confirmed this exact fixture classifies as
    // 'tshirt' at confidence ~0.89 — so pin the specific value rather than
    // only "any known category", which a mutated/hardcoded response would
    // also satisfy.
    expect(res.body.item.category).toBe('tshirt');
    expect(res.body.item.aiConfidence).toBeGreaterThan(0);
    expect(res.body.item.aiConfidence).toBeLessThanOrEqual(1);

    // At least one colour, and `share` — the TC-05 confidence signal — must
    // have survived the full round trip: Python response -> tagImage ->
    // ClothingItem document -> toPublicItem -> this HTTP response.
    expect(res.body.item.colors.length).toBeGreaterThanOrEqual(1);
    for (const colour of res.body.item.colors) {
      expect(typeof colour.hex).toBe('string');
      expect(typeof colour.name).toBe('string');
      expect(typeof colour.share).toBe('number');
      expect(colour.share).toBeGreaterThan(0);
      expect(colour.share).toBeLessThanOrEqual(1);
    }

    // `aiCategory` records what the MODEL said, as opposed to what the item is
    // filed under. On a freshly tagged item the two agree, and that agreement
    // is precisely what licenses the detail screen to show a confidence beside
    // the category. Asserted against the same pinned ground truth rather than
    // only `=== category`, which a route that copied `category` into
    // `aiCategory` would also satisfy.
    expect(res.body.item.aiCategory).toBe('tshirt');
    expect(res.body.item.aiCategory).toBe(res.body.item.category);

    expect(doc!.source).toBe('ai');
    expect(doc!.category).toBe('tshirt');
    expect(doc!.aiCategory).toBe('tshirt');
    expect(doc!.colors.length).toBeGreaterThanOrEqual(1);
    expect(doc!.colors[0].share).toEqual(expect.any(Number));
  }, 30000);
});

// A stopped AI container is disruptive to share with the rest of the suite,
// so this lives in its own describe block: the container comes down only
// inside the one test that needs it, and comes back up (with a health check,
// not just a bare `docker compose start`) in that test's own `finally` *and*
// again in this block's `afterAll` as a safety net, so a failure partway
// through the test still cannot leave the stack down for whichever suite
// (in this file or another integration test file — `--runInBand` runs them
// one at a time in one process) runs next.
describe('TC-04 / TC-05 AI tagging fail-soft', () => {
  afterAll(async () => {
    execSync('docker compose start ai', { cwd: PROJECT_ROOT, stdio: 'ignore' });
    await waitForAiHealthy(config.aiServiceUrl, 30000);
  }, 40000);

  it('still returns 201 with source: manual when the AI container is unreachable', async () => {
    execSync('docker compose stop ai', { cwd: PROJECT_ROOT, stdio: 'ignore' });
    try {
      // The same real, classifiable photo as the live-tagging test above —
      // the only thing that changed is the AI container's availability, so
      // this isolates fail-soft behaviour from fixture content.
      const res = await request(server)
        .post('/items')
        .set('Authorization', `Bearer ${token}`)
        .field('category', 'tshirt')
        .attach('image', TSHIRT_FIXTURE, { filename: 'tshirt-0.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);
      expect(res.body.item.source).toBe('manual');
      expect(res.body.item.category).toBe('tshirt');
      expect('aiConfidence' in res.body.item).toBe(false);
      // No model ran, so there is nothing the model suggested. Absent, not
      // "the same as category" -- a client must not be able to read agreement
      // out of an item that was never tagged.
      expect('aiCategory' in res.body.item).toBe(false);

      const doc = await ClothingItem.findById(res.body.item.id).lean();
      expect(doc).not.toBeNull();
      storedKeys.push(doc!.imageKey);
      expect(doc!.source).toBe('manual');

      // This is the one test in the file where the warning is the point,
      // not incidental fixture noise — assert it actually fired for the
      // unreachable-service path specifically.
      expect(consoleWarn).toHaveBeenCalledWith(
        'tagImage: request to the AI service failed',
        expect.anything(),
      );
    } finally {
      execSync('docker compose start ai', { cwd: PROJECT_ROOT, stdio: 'ignore' });
      await waitForAiHealthy(config.aiServiceUrl, 30000);
    }
  }, 60000);
});

describe('TC-14 large image handling', () => {
  it('accepts an image just under the limit', async () => {
    const nearLimit = Buffer.concat([JPEG, Buffer.alloc(9 * 1024 * 1024, 0x00)]);
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'jacket')
      .attach('image', nearLimit, { filename: 'big.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    const doc = await ClothingItem.findById(res.body.item.id).lean();
    storedKeys.push(doc!.imageKey);
  }, 60000);

  it('rejects an image over the limit with 413 rather than hanging or 500ing', async () => {
    const tooBig = Buffer.concat([JPEG, Buffer.alloc(11 * 1024 * 1024, 0x00)]);
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'jacket')
      .attach('image', tooBig, { filename: 'huge.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  }, 60000);

  it('leaves no database record when the upload is rejected', async () => {
    const before = await ClothingItem.countDocuments({});
    await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${token}`)
      .field('category', 'jacket')
      .attach('image', Buffer.concat([JPEG, Buffer.alloc(11 * 1024 * 1024, 0x00)]), {
        filename: 'huge.jpg',
        contentType: 'image/jpeg',
      });
    expect(await ClothingItem.countDocuments({})).toBe(before);
  }, 60000);

  // NOTE: orphan cleanup is already covered by Task 3's test that stubs
  // `ClothingItem.create` to reject and asserts the uploaded object is deleted
  // from real MinIO. An earlier draft of this task tried to trigger it with an
  // invalid category — that does not work: `parseBody` rejects the category
  // BEFORE `storage.put` runs, so nothing is ever uploaded and the assertion
  // passes trivially. Do not re-add that test; it verifies nothing.
});

// Task 5 (FR3, mobile override): the Add screen shows the AI's guess and
// lets the user correct it. This is the follow-up write the correction
// calls — see items.ts and the task report for why the app saves first and
// PATCHes to correct, rather than tagging before the first write.
describe('PATCH /items/:id (category override)', () => {
  async function uploadOwnedItem(ownerToken: string, category = 'shirt'): Promise<{ id: string; category: string }> {
    const res = await request(server)
      .post('/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('category', category)
      .attach('image', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' });
    const doc = await ClothingItem.findById(res.body.item.id).lean();
    storedKeys.push(doc!.imageKey);
    return res.body.item as { id: string; category: string };
  }

  it('updates the category for the item\'s own owner', async () => {
    const item = await uploadOwnedItem(token, 'shirt');

    const res = await request(server)
      .patch(`/items/${item.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'jacket' });

    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe(item.id);
    expect(res.body.item.category).toBe('jacket');

    const doc = await ClothingItem.findById(item.id).lean();
    expect(doc!.category).toBe('jacket');
  }, 30000);

  // The brief's own test, verbatim in spirit: register two users, upload as
  // A, PATCH as B. Not optional — this is the one test in this block that
  // catches an ownership filter being dropped from the query.
  it('refuses to let one user edit another user\'s item', async () => {
    const itemIdOwnedByA = (await uploadOwnedItem(token, 'shirt')).id;

    const registerB = await request(server)
      .post('/auth/register')
      .send({ name: 'Intruder', email: 'intruder-b@example.com', password: 'password123' });
    const tokenForB = registerB.body.token;

    const res = await request(server)
      .patch(`/items/${itemIdOwnedByA}`)
      .set('Authorization', `Bearer ${tokenForB}`)
      .send({ category: 'jacket' });

    expect(res.status).toBe(404);

    // The response alone isn't enough proof: a mutation that dropped the
    // ownership filter but still happened to 404 for some unrelated reason
    // (e.g. a typo'd route param) would slip past a status-only assertion.
    // Confirm the item itself was never touched.
    const doc = await ClothingItem.findById(itemIdOwnedByA).lean();
    expect(doc!.category).toBe('shirt');
  }, 30000);

  // This codebase already applies this reasoning at login (see
  // auth.integration.test.ts: "gives the same error for a wrong password
  // and an unknown email"). A 403 for "not yours" and a 404 for "does not
  // exist" would let user B learn, just from the status code, that some
  // *other* user's item exists at that id — an information leak. Both cases
  // must be byte-identical.
  it('gives the same 404 for another user\'s item as for an item that does not exist at all', async () => {
    const itemIdOwnedByA = (await uploadOwnedItem(token, 'shirt')).id;

    const registerB = await request(server)
      .post('/auth/register')
      .send({ name: 'Intruder', email: 'intruder-c@example.com', password: 'password123' });
    const tokenForB = registerB.body.token;

    const notMine = await request(server)
      .patch(`/items/${itemIdOwnedByA}`)
      .set('Authorization', `Bearer ${tokenForB}`)
      .send({ category: 'jacket' });

    const doesNotExist = await request(server)
      .patch(`/items/${new mongoose.Types.ObjectId().toString()}`)
      .set('Authorization', `Bearer ${tokenForB}`)
      .send({ category: 'jacket' });

    expect(notMine.status).toBe(404);
    expect(notMine.status).toBe(doesNotExist.status);
    expect(notMine.body).toEqual(doesNotExist.body);
  }, 30000);

  it('returns 404 rather than 500 for a well-formed but nonexistent id', async () => {
    const res = await request(server)
      .patch(`/items/${new mongoose.Types.ObjectId().toString()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'jacket' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // An id that isn't even a well-formed ObjectId can never match a
  // document. Without an explicit check, Mongoose throws a CastError that
  // would otherwise fall through to the generic 500 handler — a client
  // typo becoming a server error is exactly the kind of bug an ownership
  // test alone would not catch.
  it('returns 404, not 500, for a malformed id', async () => {
    const res = await request(server)
      .patch('/items/not-a-valid-object-id')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'jacket' });
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const item = await uploadOwnedItem(token, 'shirt');
    const res = await request(server).patch(`/items/${item.id}`).send({ category: 'jacket' });
    expect(res.status).toBe(401);
  }, 30000);

  // Review fix M1: this route used to sign imageKey inline and pass no
  // thumbnailUrl to toPublicItem, so it would have returned the same document
  // *without* the thumbnail that GET /items/:id returns *with* -- and the
  // mobile category-correction flow re-renders its tile straight from this
  // response, so it would have dropped the image it had just displayed.
  //
  // Nothing populates thumbnailKey yet (that is Task 2), so it is seeded here
  // directly. The assertion is deliberately not "uploading produces a
  // thumbnail" -- that one belongs to Task 2 and cannot pass today -- it is
  // only that this route signs a thumbnail it is given.
  it('returns a signed thumbnailUrl when the item has one', async () => {
    const doc = (await ClothingItem.create({
      userId: ownerId,
      imageKey: `items/${ownerId}/${randomUUID()}.jpg`,
      thumbnailKey: `items/${ownerId}/${randomUUID()}-thumb.jpg`,
      category: 'shirt',
      source: 'manual',
    })) as ClothingItemDoc;

    const res = await request(server)
      .patch(`/items/${String(doc._id)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'jacket' });

    expect(res.status).toBe(200);
    expect(res.body.item.category).toBe('jacket');
    expect(res.body.item.imageUrl).toEqual(expect.stringContaining(doc.imageKey));
    expect(res.body.item.thumbnailUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    expect(res.body.item.thumbnailUrl).toEqual(expect.stringContaining(doc.thumbnailKey!));
  }, 30000);

  // The invariant the detail screen depends on. `source` staying 'ai' through
  // an override is a deliberate Stage 3 Task 5 ruling -- it records how the
  // item was tagged, not who last touched it -- which is exactly why `source`
  // alone cannot tell a model's category from a user's. `aiCategory` is what
  // closes that gap, and it is worth nothing if PATCH can move it: an override
  // would then be indistinguishable from agreement, and the confidence would
  // go back to being displayed beside a category it was never about.
  //
  // Seeded through the model rather than uploaded, exactly as the thumbnail
  // test above is and for the same reason: this is about what PATCH does to
  // three fields, and routing it through the live AI service would make the
  // starting state depend on what the model happened to say.
  it('leaves aiCategory, aiConfidence and source untouched when the category is overridden', async () => {
    const doc = (await ClothingItem.create({
      userId: ownerId,
      imageKey: `items/${ownerId}/${randomUUID()}.jpg`,
      category: 'shirt',
      source: 'ai',
      aiConfidence: 0.87,
      aiCategory: 'shirt',
    })) as ClothingItemDoc;
    storedKeys.push(doc.imageKey);

    const res = await request(server)
      .patch(`/items/${String(doc._id)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'jacket' });

    expect(res.status).toBe(200);
    expect(res.body.item.category).toBe('jacket');
    // The three that must not have moved.
    expect(res.body.item.aiCategory).toBe('shirt');
    expect(res.body.item.aiConfidence).toBe(0.87);
    expect(res.body.item.source).toBe('ai');

    // The response could be right while the write was wrong, so re-read.
    const stored = await ClothingItem.findById(doc._id).lean();
    expect(stored!.category).toBe('jacket');
    expect(stored!.aiCategory).toBe('shirt');
    expect(stored!.aiConfidence).toBe(0.87);
    expect(stored!.source).toBe('ai');
  }, 30000);

  it('rejects an unknown category and leaves the stored category unchanged', async () => {
    const item = await uploadOwnedItem(token, 'shirt');

    const res = await request(server)
      .patch(`/items/${item.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'spacesuit' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');

    const doc = await ClothingItem.findById(item.id).lean();
    expect(doc!.category).toBe('shirt');
  }, 30000);

  // "accepting only { category }" (task brief): fields beyond category must
  // have no effect, not merely be accepted-and-ignored by accident.
  it('ignores fields other than category in the request body', async () => {
    const item = await uploadOwnedItem(token, 'shirt');

    const res = await request(server)
      .patch(`/items/${item.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'jacket', wearCount: 999, userId: new mongoose.Types.ObjectId().toString() });

    expect(res.status).toBe(200);
    expect(res.body.item.category).toBe('jacket');
    expect(res.body.item.wearCount).toBe(0);
  }, 30000);
});

// Stage 4 Task 1 (FR4 / TC-06): "all items displayed in a grid; filter by
// category works" is only true once there is a way to read the wardrobe back.
// These tests seed through the model rather than POST /items on purpose --
// paging behaviour depends on exact createdAt values (ordering, and two
// items sharing a millisecond), which the upload path cannot produce on
// demand, and none of these cases exercises upload at all.
describe('GET /items (TC-06 wardrobe display)', () => {
  // Mongoose's generated name for clothingItemSchema.index({ userId: 1,
  // createdAt: -1, _id: -1 }) -- the list sort's index.
  const SORT_INDEX_NAME = 'userId_1_createdAt_-1__id_-1';

  interface PlanStage {
    stage: string;
    indexName?: string;
    inputStage?: PlanStage;
  }

  async function seed(
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

  function list(query = '', asToken = token) {
    return request(server).get(`/items${query}`).set('Authorization', `Bearer ${asToken}`);
  }

  it('returns an empty page for a wardrobe with no items', async () => {
    const res = await list();

    expect(res.status).toBe(200);
    // An empty array, not a missing key: Task 3's client maps over this
    // directly, and a first-run wardrobe is the very first thing it renders.
    expect(res.body.items).toEqual([]);
    expect('nextCursor' in res.body).toBe(false);
  });

  it('returns only the caller\'s items', async () => {
    const mine = await seed(ownerId);
    const other = await registerOther('other-list@example.com');
    const theirs = await seed(other.id);

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(String(mine._id));
    expect(res.body.items.map((i: { id: string }) => i.id)).not.toContain(String(theirs._id));
    // Ownership comes from the verified token, so every row must carry it.
    expect(res.body.items[0].userId).toBe(ownerId);
  });

  it('returns items newest first', async () => {
    const oldest = await seed(ownerId, { createdAt: new Date('2026-08-01T00:00:00.000Z') });
    const middle = await seed(ownerId, { createdAt: new Date('2026-08-10T00:00:00.000Z') });
    const newest = await seed(ownerId, { createdAt: new Date('2026-08-20T00:00:00.000Z') });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([
      String(newest._id),
      String(middle._id),
      String(oldest._id),
    ]);
  });

  it('filters by category', async () => {
    await seed(ownerId, { category: 'tshirt' });
    const jacket = await seed(ownerId, { category: 'jacket' });

    const res = await list('?category=jacket');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(String(jacket._id));
    expect(res.body.items[0].category).toBe('jacket');
  });

  // An unknown category must not fall through as "no filter": that would
  // silently return the whole wardrobe when the client meant to narrow it.
  it('rejects an unknown category with 400', async () => {
    await seed(ownerId, { category: 'tshirt' });

    const res = await list('?category=hat');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.items).toBeUndefined();
  });

  it('rejects a non-numeric limit with 400', async () => {
    const res = await list('?limit=abc');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  // Out of range is an error, never a silent clamp -- a clamped limit makes
  // the client's paging arithmetic wrong with no signal that it happened.
  it('rejects limit=0 and limit=101 with 400', async () => {
    await seed(ownerId);

    const zero = await list('?limit=0');
    expect(zero.status).toBe(400);
    expect(zero.body.error.code).toBe('VALIDATION_FAILED');
    expect(zero.body.items).toBeUndefined();

    const tooMany = await list('?limit=101');
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('VALIDATION_FAILED');
    expect(tooMany.body.items).toBeUndefined();
  });

  // 24 is part of the contract Task 3's client pages against, and nothing else
  // in this suite would notice if it changed -- every other test passes an
  // explicit limit.
  it('defaults to a page size of 24', async () => {
    for (let i = 0; i < 25; i += 1) {
      await seed(ownerId, { createdAt: new Date(Date.UTC(2026, 0, i + 1)) });
    }

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(24);
    expect(res.body.nextCursor).toEqual(expect.any(String));
  }, 30000);

  // The boundary the other side of `rejects limit=0 and limit=101`: 100 is in
  // range, so an off-by-one in the range check has a test on both sides of it.
  it('accepts limit=100 at the upper boundary', async () => {
    await seed(ownerId);

    const res = await list('?limit=100');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('pages with a cursor without repeating or skipping an item', async () => {
    const seeded: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const doc = await seed(ownerId, { createdAt: new Date(`2026-08-0${i + 1}T00:00:00.000Z`) });
      seeded.push(String(doc._id));
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const res = await list(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      collected.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
    }

    // No repeats, nothing skipped: this is what catches an off-by-one in the
    // limit + 1 lookahead.
    expect(collected).toHaveLength(5);
    expect(new Set(collected).size).toBe(5);
    expect([...collected].sort()).toEqual([...seeded].sort());
    // And the newest-first order has to hold across page boundaries too.
    expect(collected).toEqual([...seeded].reverse());
  });

  // Filter plus cursor is the combination the wardrobe screen actually issues
  // once a category chip is selected and the user keeps scrolling. Seeded
  // interleaved so a filter that stopped applying after page 1 shows up as a
  // tshirt among the jackets, not merely as a wrong count.
  it('keeps the category filter applied across a cursor page', async () => {
    const jackets: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const jacket = await seed(ownerId, {
        category: 'jacket',
        createdAt: new Date(`2026-08-0${i * 2 + 1}T00:00:00.000Z`),
      });
      jackets.push(String(jacket._id));
      await seed(ownerId, {
        category: 'tshirt',
        createdAt: new Date(`2026-08-0${i * 2 + 2}T00:00:00.000Z`),
      });
    }

    const page1 = await list('?category=jacket&limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((i: { id: string }) => i.id)).toEqual([jackets[2], jackets[1]]);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await list(
      `?category=jacket&limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.items.map((i: { id: string }) => i.id)).toEqual([jackets[0]]);
    expect('nextCursor' in page2.body).toBe(false);

    for (const item of [...page1.body.items, ...page2.body.items]) {
      expect(item.category).toBe('jacket');
    }
  });

  it('omits nextCursor on the final page', async () => {
    for (let i = 0; i < 3; i += 1) {
      await seed(ownerId, { createdAt: new Date(`2026-08-0${i + 1}T00:00:00.000Z`) });
    }

    const first = await list('?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const last = await list(`?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(last.status).toBe(200);
    expect(last.body.items).toHaveLength(1);
    expect('nextCursor' in last.body).toBe(false);

    // A page that exactly exhausts the collection is also a final page.
    const exact = await list('?limit=3');
    expect(exact.body.items).toHaveLength(3);
    expect('nextCursor' in exact.body).toBe(false);
  });

  // Silently restarting from page 1 on a bad cursor makes an infinite scroll
  // loop forever, so it has to be an error the client can see.
  it('rejects a malformed cursor with 400', async () => {
    await seed(ownerId);

    const res = await list('?cursor=!!!not-a-cursor!!!');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.items).toBeUndefined();
  });

  // Named for what it actually guards. It seeds a same-millisecond pair, but
  // the { userId, createdAt: -1, _id: -1 } index hands ties back in _id order
  // by itself, so this cannot fail if the sort's tiebreaker is dropped -- the
  // index-removed test below is what covers the tiebreaker. What this one does
  // catch is a broken limit + 1 lookahead dropping the final page.
  it('pages one item at a time without losing the final page', async () => {
    const sameInstant = new Date('2026-08-24T10:30:00.000Z');
    const first = await seed(ownerId, { createdAt: sameInstant });
    const second = await seed(ownerId, { createdAt: sameInstant });
    // ObjectIds ascend with creation order, so with _id descending as the
    // tiebreaker `second` must come first. Sorting the hex strings makes the
    // expected order explicit rather than assumed.
    const [lower, higher] = [String(first._id), String(second._id)].sort();

    const page1 = await list('?limit=1');
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await list(`?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);

    // Both pages, both items, no repeat -- and pinned in the order the index
    // serves them, so a page that silently reordered would not slip past.
    expect([page1.body.items[0].id, page2.body.items[0].id]).toEqual([higher, lower]);
  });

  // The compound index this stage adds, { userId: 1, createdAt: -1, _id: -1 },
  // hands ties back in _id-descending order all by itself -- which means a sort
  // that forgot `_id: -1` still looks correct as long as the planner picks that
  // index. The test above therefore cannot fail if the tiebreaker is dropped.
  // Removing the index for the duration of this one test forces an in-memory
  // sort, where ties come back in insertion order instead, and only an explicit
  // `_id: -1` keeps the second item from being skipped between the two pages.
  // Restored in `finally`; `beforeAll`'s ClothingItem.init() would rebuild it
  // anyway if this process died mid-test.
  it('still separates same-millisecond items when no index can supply the tie order', async () => {
    await ClothingItem.collection.dropIndex(SORT_INDEX_NAME);
    try {
      const sameInstant = new Date('2026-08-24T10:30:00.000Z');
      const first = await seed(ownerId, { createdAt: sameInstant });
      const second = await seed(ownerId, { createdAt: sameInstant });
      const [lower, higher] = [String(first._id), String(second._id)].sort();

      const page1 = await list('?limit=1');
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(1);
      expect(page1.body.nextCursor).toEqual(expect.any(String));

      const page2 = await list(`?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(1);

      expect([page1.body.items[0].id, page2.body.items[0].id]).toEqual([higher, lower]);
    } finally {
      // createIndexes(), not syncIndexes(): syncIndexes additionally drops any
      // index present on the collection but absent from the schema, which is a
      // side effect this test has no business having on a shared database. This
      // test removed exactly one index; putting it back is all that is owed.
      await ClothingItem.createIndexes();
    }
  }, 30000);

  // Dropping clothingItemSchema.index({ userId: 1, createdAt: -1, _id: -1 })
  // does not make the list "merely slower": the plan degrades from
  // LIMIT -> FETCH -> IXSCAN to SORT -> FETCH -> IXSCAN on { userId, category },
  // a blocking in-memory sort of every document the filter matched, re-done on
  // every page. That is a scaling cliff, so it gets an assertion rather than a
  // note in a report.
  it('serves the list sort from an index, with no blocking in-memory SORT stage', async () => {
    for (let i = 0; i < 3; i += 1) {
      await seed(ownerId, { category: 'jacket', createdAt: new Date(Date.UTC(2026, 7, i + 1)) });
      await seed(ownerId, { category: 'tshirt', createdAt: new Date(Date.UTC(2026, 7, i + 10)) });
    }

    // Asserted against the schema, not only the live collection: ClothingItem
    // .init() only ever creates indexes, so a database that already carries
    // this one from an earlier run would keep serving the good plan even after
    // the schema stopped declaring it. This makes deleting that line fail here
    // on any database.
    expect(ClothingItem.schema.indexes()).toContainEqual([
      { userId: 1, createdAt: -1, _id: -1 },
      expect.anything(),
    ]);

    // explain() can report a plan the cache already held ("isCached": true),
    // and the test right above this one drops and re-creates the very index
    // under test. Clearing this collection's cached plans first makes the
    // assertion about what the planner chooses now rather than about what an
    // earlier query left behind; discarding cached plans has no effect beyond
    // making them be recomputed.
    await mongoose.connection.db!.command({
      planCacheClear: ClothingItem.collection.collectionName,
    });

    // The exact query GET /items issues for a category-filtered first page.
    const plan = (await ClothingItem.find({ userId: ownerId, category: 'jacket' })
      .sort({ createdAt: -1, _id: -1 })
      .limit(25)
      .explain('queryPlanner')) as unknown as { queryPlanner: { winningPlan: PlanStage } };

    const stages: string[] = [];
    let indexName: string | undefined;
    for (let stage: PlanStage | undefined = plan.queryPlanner.winningPlan; stage; stage = stage.inputStage) {
      stages.push(stage.stage);
      if (stage.indexName) indexName = stage.indexName;
    }

    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('SORT');
    expect(stages).not.toContain('COLLSCAN');
    expect(indexName).toBe(SORT_INDEX_NAME);
  }, 30000);

  // The grid renders thumbnailUrl per tile and falls back to imageUrl, so
  // both must survive a list response -- and items from before Stage 4 (no
  // thumbnailKey at all) must still come back, without a thumbnailUrl key.
  it('returns thumbnailUrl for items that have one', async () => {
    const withThumb = await seed(ownerId, {
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      thumbnailKey: `items/${ownerId}/${randomUUID()}-thumb.jpg`,
    });
    const withoutThumb = await seed(ownerId, { createdAt: new Date('2026-08-01T00:00:00.000Z') });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);

    const [first, second] = res.body.items;
    expect(first.thumbnailUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    expect(first.thumbnailUrl).toEqual(expect.stringContaining(withThumb.thumbnailKey!));
    expect(first.thumbnailUrl).not.toBe(first.imageUrl);

    expect(second.thumbnailUrl).toBeUndefined();
    expect(second.imageUrl).toEqual(expect.stringContaining(withoutThumb.imageKey));

    expect(JSON.stringify(res.body)).not.toContain('thumbnailKey');
  });

  it('returns a signed imageUrl for each item', async () => {
    const a = await seed(ownerId, { createdAt: new Date('2026-08-01T00:00:00.000Z') });
    const b = await seed(ownerId, { createdAt: new Date('2026-08-02T00:00:00.000Z') });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    for (const item of res.body.items) {
      expect(item.imageUrl).toEqual(expect.stringContaining('http'));
      // A presigned SigV4 URL, not a bare object path.
      expect(item.imageUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    }
    // Each row is signed for its own key, not one key reused across the page.
    expect(res.body.items[0].imageUrl).toEqual(expect.stringContaining(b.imageKey));
    expect(res.body.items[1].imageUrl).toEqual(expect.stringContaining(a.imageKey));
    // The key itself still never reaches the client as a field.
    expect(JSON.stringify(res.body)).not.toContain('imageKey');
  });
});

describe('GET /items/:id (detail)', () => {
  async function seed(owner: string): Promise<ClothingItemDoc> {
    return (await ClothingItem.create({
      userId: owner,
      imageKey: `items/${owner}/${randomUUID()}.jpg`,
      category: 'jacket',
      source: 'manual',
    })) as ClothingItemDoc;
  }

  async function registerOther(email: string): Promise<{ token: string; id: string }> {
    const res = await request(server)
      .post('/auth/register')
      .send({ name: 'Other', email, password: 'password123' });
    return { token: res.body.token, id: res.body.user.id };
  }

  it('returns a single item by id', async () => {
    const doc = await seed(ownerId);

    const res = await request(server)
      .get(`/items/${String(doc._id)}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe(String(doc._id));
    expect(res.body.item.category).toBe('jacket');
    expect(res.body.item.userId).toBe(ownerId);
    expect(res.body.item.imageUrl).toEqual(expect.stringContaining('X-Amz-Signature'));
    expect(JSON.stringify(res.body)).not.toContain('imageKey');
  });

  it('returns 404 for another user\'s item', async () => {
    const other = await registerOther('other-detail@example.com');
    const theirs = await seed(other.id);

    const res = await request(server)
      .get(`/items/${String(theirs._id)}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // notFoundHandler answers an unregistered route with 404 NOT_FOUND too, so
    // status and code alone would pass with no handler mounted at all. The
    // message is what separates the two: it says 'Route not found'.
    expect(res.body.error.message).toBe('Item not found');
  });

  it('returns 404 for a malformed id', async () => {
    const res = await request(server)
      .get('/items/not-a-valid-object-id')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Item not found');
  });

  // Same reasoning as PATCH /items/:id and /auth/login: a 403 for "not yours"
  // versus a 404 for "no such id" would tell a caller, from the status alone,
  // that some other user's item exists at that id.
  it('returns an identical body for both 404 cases', async () => {
    const other = await registerOther('other-identical@example.com');
    const theirs = await seed(other.id);

    const notMine = await request(server)
      .get(`/items/${String(theirs._id)}`)
      .set('Authorization', `Bearer ${token}`);

    const malformed = await request(server)
      .get('/items/not-a-valid-object-id')
      .set('Authorization', `Bearer ${token}`);

    const doesNotExist = await request(server)
      .get(`/items/${new mongoose.Types.ObjectId().toString()}`)
      .set('Authorization', `Bearer ${token}`);

    expect(notMine.status).toBe(404);
    // Pinned to the route's own message, not notFoundHandler's -- three bodies
    // can be identical to each other and still all be "no such route".
    expect(notMine.body.error.message).toBe('Item not found');
    expect(notMine.status).toBe(malformed.status);
    expect(notMine.status).toBe(doesNotExist.status);
    expect(notMine.body).toEqual(malformed.body);
    expect(notMine.body).toEqual(doesNotExist.body);
  });
});
