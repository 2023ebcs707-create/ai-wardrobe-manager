import request from 'supertest';
import { createApp } from './app';
import { loadConfig } from './config';
import { connectDatabase, databaseStatus } from './db';
import { createStorageClient, storageStatus } from './health/storageCheck';
import { aiStatus } from './health/aiCheck';
import { createStorageProvider } from './storage/MinioStorageProvider';
import mongoose from 'mongoose';

const BUCKET = process.env.MINIO_BUCKET ?? 'wardrobe-items';
const AI_URL = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';
const testConfig = loadConfig({ JWT_SECRET: 'test-secret' });

describe('health against live containers', () => {
  beforeAll(async () => {
    await connectDatabase(process.env.MONGO_URL ?? 'mongodb://localhost:27017/wardrobe');
  }, 20000);

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('reports every real dependency as ok', async () => {
    const storage = createStorageClient();
    const app = createApp(
      {
        database: databaseStatus,
        storage: () => storageStatus(storage, BUCKET),
        ai: () => aiStatus(AI_URL),
      },
      testConfig,
      createStorageProvider(testConfig),
    );

    // Bound here rather than handed to `request(app)`, which would listen and
    // close an ephemeral server of its own -- the churn that let a recycled
    // port serve one request another request's reply. This file builds its app
    // inside the test, so the server is scoped to the test too.
    const server = app.listen(0);
    try {
      const res = await request(server).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ api: 'ok', database: 'ok', storage: 'ok', ai: 'ok' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20000);
});
