import request from 'supertest';
import mongoose from 'mongoose';
import type { Server } from 'node:http';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { connectDatabase } from '../db';
import { User } from '../models/User';
import { createStorageProvider } from '../storage/MinioStorageProvider';

const config = loadConfig({ JWT_SECRET: 'integration-test-secret', MONGO_URL: process.env.MONGO_URL });
const okChecks = {
  database: async () => 'ok' as const,
  storage: async () => 'ok' as const,
  ai: async () => 'ok' as const,
};

const app = createApp(okChecks, config, createStorageProvider(config));

/**
 * One HTTP server for the whole file. See the same block in
 * `outfits.integration.test.ts` for why: `request(server)` listens and closes an
 * ephemeral server per request, and a recycled port can hand a later request a
 * reply belonging to an earlier exchange.
 *
 * This file is the reason the conversion did not stop at two files. After
 * outfits and items were converted, the identical superagent failure --
 * `Unexpected non-whitespace character after JSON at position 39`, two
 * responses read as one -- surfaced here instead, on run 3 of a stability
 * sweep. The hazard was never specific to a route; it was specific to
 * `request(server)`.
 */
let server: Server;

// Connect once for the whole file rather than per describe block: TC-01 and
// TC-02 share this connection, and disconnecting inside TC-01's afterAll
// would tear it down before TC-02's tests (a sibling describe) run.
beforeAll(async () => {
  server = app.listen(0);
  await connectDatabase(config.mongoUrl);
  await User.init();
}, 30000);

afterAll(async () => {
  await User.deleteMany({});
  await mongoose.disconnect();
  // closeAllConnections first: `close()` alone waits for live sockets and
  // would hang this hook rather than fail it.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('TC-01 user registration', () => {
  beforeEach(async () => {
    await User.deleteMany({});
  });

  it('creates an account with valid details and returns the public user', async () => {
    const res = await request(server)
      .post('/auth/register')
      .send({ name: 'Zaid', email: 'zaid@example.com', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: 'Zaid', email: 'zaid@example.com' });
    expect(res.body.user.id).toEqual(expect.any(String));
    expect(typeof res.body.token).toBe('string');
  });

  it('never returns the password hash', async () => {
    const res = await request(server)
      .post('/auth/register')
      .send({ name: 'Zaid', email: 'hash@example.com', password: 'password123' });
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain('$2b$');
  });

  it('rejects a duplicate email with 409 EMAIL_TAKEN', async () => {
    const body = { name: 'Zaid', email: 'dup@example.com', password: 'password123' };
    await request(server).post('/auth/register').send(body).expect(201);

    const res = await request(server).post('/auth/register').send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('treats a differently-cased duplicate email as taken', async () => {
    await request(server)
      .post('/auth/register')
      .send({ name: 'Zaid', email: 'case@example.com', password: 'password123' })
      .expect(201);

    const res = await request(server)
      .post('/auth/register')
      .send({ name: 'Zaid', email: 'CASE@EXAMPLE.COM', password: 'password123' });
    expect(res.status).toBe(409);
  });

  it('rejects a malformed email with 400 and a field error', async () => {
    const res = await request(server)
      .post('/auth/register')
      .send({ name: 'Zaid', email: 'not-an-email', password: 'password123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields.map((f: { path: string }) => f.path)).toContain('email');
  });

  it('rejects a short password with 400', async () => {
    const res = await request(server)
      .post('/auth/register')
      .send({ name: 'Zaid', email: 'short@example.com', password: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.map((f: { path: string }) => f.path)).toContain('password');
  });

  it('rejects a password longer than 72 bytes', async () => {
    const res = await request(server)
      .post('/auth/register')
      .send({ name: 'Zaid', email: 'long@example.com', password: 'A'.repeat(73) });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.map((f: { path: string }) => f.path)).toContain('password');
  });

  it('measures the password limit in bytes, not characters', async () => {
    // 20 emoji are 40 characters but 80 bytes. A character-based cap would
    // wrongly accept this, and bcrypt would silently ignore everything past
    // byte 72 — so two different passwords could log into the same account.
    const res = await request(server)
      .post('/auth/register')
      .send({ name: 'Zaid', email: 'emoji@example.com', password: '\u{1F512}'.repeat(20) });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.map((f: { path: string }) => f.path)).toContain('password');
  });

  it('accepts a password exactly at the 72-byte limit', async () => {
    const res = await request(server)
      .post('/auth/register')
      .send({ name: 'Zaid', email: 'exact@example.com', password: 'A'.repeat(72) });
    expect(res.status).toBe(201);
  });

  it('stores the password hashed, never in plaintext', async () => {
    await request(server)
      .post('/auth/register')
      .send({ name: 'Zaid', email: 'stored@example.com', password: 'password123' })
      .expect(201);

    const doc = await User.findOne({ email: 'stored@example.com' }).lean();
    expect(doc).not.toBeNull();
    expect(doc!.passwordHash).not.toBe('password123');
    expect(doc!.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it('rejects a name longer than 80 characters with a field error', async () => {
    const res = await request(server)
      .post('/auth/register')
      .send({ name: 'A'.repeat(81), email: 'longname@example.com', password: 'password123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields.map((f: { path: string }) => f.path)).toContain('name');
  });

  it('trims surrounding whitespace from name and email before storing', async () => {
    await request(server)
      .post('/auth/register')
      .send({ name: '  Zaid  ', email: '  trimmed@example.com  ', password: 'password123' })
      .expect(201);

    const doc = await User.findOne({ email: 'trimmed@example.com' }).lean();
    expect(doc).not.toBeNull();
    expect(doc!.name).toBe('Zaid');
    expect(doc!.email).toBe('trimmed@example.com');
  });
});

describe('TC-02 user login', () => {
  const creds = { name: 'Zaid', email: 'login@example.com', password: 'password123' };

  beforeEach(async () => {
    await User.deleteMany({});
    await request(server).post('/auth/register').send(creds).expect(201);
  });

  it('returns a JWT and the public user for valid credentials', async () => {
    const res = await request(server)
      .post('/auth/login')
      .send({ email: creds.email, password: creds.password });

    expect(res.status).toBe(200);
    expect(res.body.token.split('.')).toHaveLength(3);
    expect(res.body.user.email).toBe(creds.email);
  });

  it('returns 401 INVALID_CREDENTIALS for a wrong password', async () => {
    const res = await request(server)
      .post('/auth/login')
      .send({ email: creds.email, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 for an unknown email', async () => {
    const res = await request(server)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'password123' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const wrongPassword = await request(server)
      .post('/auth/login')
      .send({ email: creds.email, password: 'wrong-password' });
    const unknownEmail = await request(server)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'password123' });

    expect(wrongPassword.status).toBe(unknownEmail.status);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it('logs in with a differently-cased email', async () => {
    const res = await request(server)
      .post('/auth/login')
      .send({ email: 'LOGIN@EXAMPLE.COM', password: creds.password });
    expect(res.status).toBe(200);
  });

  it('issues a token that identifies the registered user', async () => {
    const res = await request(server)
      .post('/auth/login')
      .send({ email: creds.email, password: creds.password });
    const doc = await User.findOne({ email: creds.email }).lean();
    const { verifyToken } = await import('../auth/tokens');
    expect(verifyToken(res.body.token, config).sub).toBe(String(doc!._id));
  });

  it(
    'keeps unknown-email login timing in the same order of magnitude as wrong-password login',
    async () => {
      // Guards the anti-enumeration property: login must run a bcrypt
      // comparison against DUMMY_HASH even when the email doesn't exist, so
      // response time can't reveal whether an email is registered. Skipping
      // that comparison (an early "no such user" return) drops the
      // unknown-email path from ~200ms (bcrypt cost 12) to ~1-5ms — a ~40x
      // gap. Asserting the unknown-email median is at least half the
      // wrong-password median is a huge margin relative to that 40x
      // regression signal: ordinary variance (GC pauses, scheduler jitter, a
      // slow CI runner) will not push a real ~1x ratio below 0.5, but a
      // regression that skips the comparison entirely still fails this
      // decisively.
      const iterations = 8;
      const unknownTimesMs: number[] = [];
      const wrongPasswordTimesMs: number[] = [];

      const median = (values: number[]): number => {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
      };

      for (let i = 0; i < iterations; i++) {
        const unknownStart = process.hrtime.bigint();
        await request(server)
          .post('/auth/login')
          .send({ email: `nobody-${i}@example.com`, password: 'password123' });
        unknownTimesMs.push(Number(process.hrtime.bigint() - unknownStart) / 1e6);

        const wrongPasswordStart = process.hrtime.bigint();
        await request(server)
          .post('/auth/login')
          .send({ email: creds.email, password: 'wrong-password' });
        wrongPasswordTimesMs.push(Number(process.hrtime.bigint() - wrongPasswordStart) / 1e6);
      }

      const unknownMedian = median(unknownTimesMs);
      const wrongPasswordMedian = median(wrongPasswordTimesMs);

      expect(unknownMedian).toBeGreaterThanOrEqual(wrongPasswordMedian * 0.5);
    },
    30000,
  );
});

describe('GET /auth/me', () => {
  it('returns the current user for a valid token', async () => {
    await User.deleteMany({});
    const reg = await request(server)
      .post('/auth/register')
      .send({ name: 'Me', email: 'me@example.com', password: 'password123' })
      .expect(201);

    const res = await request(server).get('/auth/me').set('Authorization', `Bearer ${reg.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('me@example.com');
    expect(JSON.stringify(res.body)).not.toContain('$2b$');
  });

  it('returns 401 without a token', async () => {
    await request(server).get('/auth/me').expect(401);
  });

  it('returns 401 when the token is valid but the user no longer exists', async () => {
    await User.deleteMany({});
    const reg = await request(server)
      .post('/auth/register')
      .send({ name: 'Gone', email: 'gone@example.com', password: 'password123' })
      .expect(201);

    await User.deleteMany({});

    const res = await request(server).get('/auth/me').set('Authorization', `Bearer ${reg.body.token}`);
    expect(res.status).toBe(401);
  });
});
