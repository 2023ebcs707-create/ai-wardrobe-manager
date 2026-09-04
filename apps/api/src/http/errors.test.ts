import express from 'express';
import request from 'supertest';
import multer from 'multer';
import { z } from 'zod';
import { ApiError, errorHandler, notFoundHandler } from './errors';
import { parseBody } from './validate';

function appWith(handler: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.post('/thing', handler);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('error envelope', () => {
  it('renders an ApiError as the shared envelope with its status', async () => {
    const app = appWith(() => {
      throw new ApiError(409, 'EMAIL_TAKEN', 'That email is already registered');
    });
    const res = await request(app).post('/thing').send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'EMAIL_TAKEN', message: 'That email is already registered' } });
  });

  it('renders an async ApiError too', async () => {
    const app = appWith(async () => {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    });
    const res = await request(app).post('/thing').send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('turns an unexpected error into INTERNAL without leaking its message', async () => {
    // The handler deliberately logs unexpected errors server-side (so they are not lost)
    // while keeping them out of the response. Spy on console.error rather than letting it
    // print, and assert it fired, so the logging behaviour stays covered instead of just
    // being silenced as noise.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = appWith(() => {
      throw new Error('connection string user:hunter2@db');
    });
    const res = await request(app).post('/thing').send({});
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(consoleError).toHaveBeenCalledWith('Unhandled error:', expect.objectContaining({ message: 'connection string user:hunter2@db' }));
    consoleError.mockRestore();
  });

  it('returns a JSON envelope for an unknown route, not HTML', async () => {
    const app = appWith(() => undefined);
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('maps zod failures to VALIDATION_FAILED with per-field messages', async () => {
    const schema = z.object({ email: z.string().email(), password: z.string().min(8) });
    const app = appWith((req) => {
      parseBody(schema, req.body);
    });
    const res = await request(app).post('/thing').send({ email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const paths = res.body.error.fields.map((f: { path: string }) => f.path).sort();
    expect(paths).toEqual(['email', 'password']);
  });

  it('returns parsed data when the body is valid', async () => {
    const schema = z.object({ email: z.string().email() });
    const app = appWith((req, res) => {
      res.json(parseBody(schema, req.body));
    });
    const res = await request(app).post('/thing').send({ email: 'a@b.com', extra: 'ignored' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'a@b.com' });
  });

  it('maps an over-large JSON body to a 413 VALIDATION_FAILED, not a 500', async () => {
    // body-parser rejects an over-large body with a PayloadTooLargeError,
    // which carries `status: 413` and `type: 'entity.too.large'` but is NOT a
    // SyntaxError -- so the malformed-JSON branch never matched it and it fell
    // through to INTERNAL: a client sending too much read as a server fault,
    // and a healthy server logged a stack trace for it. The same shape the
    // multer branches above already exist to prevent.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = appWith((_req, res) => {
      res.json({ ok: true });
    });

    try {
      const res = await request(app)
        .post('/thing')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ big: 'x'.repeat(200 * 1024) }));

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      // In a `finally`, not trailing the assertions: a failing expectation
      // would otherwise leave the spy installed and break the NEXT test, which
      // is exactly what it did on the first red run.
      consoleError.mockRestore();
    }
  });

  it('maps a genuine multer file-size error to a 413 VALIDATION_FAILED', async () => {
    const app = appWith(() => {
      throw new multer.MulterError('LIMIT_FILE_SIZE');
    });
    const res = await request(app).post('/thing').send({});
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  // A client posting a part multer was not told to expect -- a typo'd field
  // name, or a second `image` part -- is a malformed request, not a server
  // fault. Before this mapping it fell through to the generic branch and
  // produced a 500 plus a `console.error` on every such request, which is
  // both the wrong status and a log line that says nothing is wrong.
  it('maps a multer unexpected-file error to a 400 VALIDATION_FAILED, not a 500', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = appWith(() => {
      throw new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'photo');
    });
    const res = await request(app).post('/thing').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    // Nothing unexpected happened server-side, so nothing should be logged as
    // though it had.
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // The same reasoning as the file-size branch above: a non-multer error
  // carrying a colliding `.code` must not be reclassified as a client error.
  it('does not mistake an unrelated error carrying the same .code for a multer unexpected-file error', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = appWith(() => {
      const err = new Error('not actually a multer error') as Error & { code?: string };
      err.code = 'LIMIT_UNEXPECTED_FILE';
      throw err;
    });
    const res = await request(app).post('/thing').send({});
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    consoleError.mockRestore();
  });

  it('does not mistake an unrelated error carrying the same .code for a multer file-size error', async () => {
    // Stage 3 adds a Python-service HTTP call whose failures carry `.code`
    // values like ECONNREFUSED/ETIMEDOUT. Duck-typing on `.code` alone
    // (`(err as { code?: string }).code === 'LIMIT_FILE_SIZE'`) would
    // misclassify any error that happens to reuse this string as a 413,
    // however unrelated to multer. Checking `instanceof multer.MulterError`
    // closes that: a plain error with a colliding `.code` must still fall
    // through to the generic 500 branch.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = appWith(() => {
      const err = new Error('not actually a multer error') as Error & { code?: string };
      err.code = 'LIMIT_FILE_SIZE';
      throw err;
    });
    const res = await request(app).post('/thing').send({});
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    consoleError.mockRestore();
  });
});
