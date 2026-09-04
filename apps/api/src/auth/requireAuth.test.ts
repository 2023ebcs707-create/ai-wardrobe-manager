import express from 'express';
import request from 'supertest';
import { requireAuth, type AuthedRequest } from './requireAuth';
import { signToken } from './tokens';
import { loadConfig } from '../config';
import { errorHandler } from '../http/errors';

const config = loadConfig({ JWT_SECRET: 'middleware-test-secret' });

function appWithGuard() {
  const app = express();
  app.get('/protected', requireAuth(config), (req, res) => {
    res.json({ userId: (req as AuthedRequest).userId });
  });
  app.use(errorHandler);
  return app;
}

describe('requireAuth', () => {
  it('allows a request carrying a valid bearer token', async () => {
    const token = signToken('user-abc', config);
    const res = await request(appWithGuard()).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-abc');
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await request(appWithGuard()).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a header that is not a Bearer scheme', async () => {
    const token = signToken('user-abc', config);
    const res = await request(appWithGuard()).get('/protected').set('Authorization', `Basic ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an invalid token', async () => {
    const res = await request(appWithGuard()).get('/protected').set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a token signed with a different secret', async () => {
    const foreign = signToken('user-abc', loadConfig({ JWT_SECRET: 'someone-elses-secret' }));
    const res = await request(appWithGuard()).get('/protected').set('Authorization', `Bearer ${foreign}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('is case-insensitive about the Bearer keyword', async () => {
    const token = signToken('user-abc', config);
    const res = await request(appWithGuard()).get('/protected').set('Authorization', `bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
