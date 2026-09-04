import request from 'supertest';
import { createApp } from './app';
import { loadConfig } from './config';
import type { HealthChecks } from './health/checks';
import type { StorageProvider } from './storage/StorageProvider';

const testConfig = loadConfig({ JWT_SECRET: 'test-secret' });

const allOk: HealthChecks = {
  database: async () => 'ok',
  storage: async () => 'ok',
  ai: async () => 'ok',
};

// A hermetic in-memory fake, not a real MinIO client, so these unit tests
// stay independent of live services.
const fakeStorage: StorageProvider = {
  put: async (key, body, contentType) => ({ key, size: body.length, contentType }),
  get: async () => Buffer.alloc(0),
  delete: async () => undefined,
  signUrl: async (key) => `https://fake.local/${key}`,
};

describe('GET /health', () => {
  it('returns 200 and every service status when all are ok', async () => {
    const res = await request(createApp(allOk, testConfig, fakeStorage)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ api: 'ok', database: 'ok', storage: 'ok', ai: 'ok' });
  });

  it('returns 503 when a dependency is down', async () => {
    const checks: HealthChecks = { ...allOk, database: async () => 'down' };
    const res = await request(createApp(checks, testConfig, fakeStorage)).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.database).toBe('down');
  });

  it('returns 200 but reports degraded when the AI service is degraded', async () => {
    const checks: HealthChecks = { ...allOk, ai: async () => 'degraded' };
    const res = await request(createApp(checks, testConfig, fakeStorage)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ai).toBe('degraded');
  });

  it('reports a dependency as down when its check throws', async () => {
    const checks: HealthChecks = {
      ...allOk,
      storage: async () => {
        throw new Error('connection refused');
      },
    };
    const res = await request(createApp(checks, testConfig, fakeStorage)).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.storage).toBe('down');
  });
});
