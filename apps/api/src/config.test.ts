import { loadConfig } from './config';

const base = { JWT_SECRET: 'test-secret-value' };

describe('loadConfig', () => {
  it('throws when JWT_SECRET is missing', () => {
    expect(() => loadConfig({})).toThrow(/JWT_SECRET/);
  });

  it('throws when JWT_SECRET is blank', () => {
    expect(() => loadConfig({ JWT_SECRET: '   ' })).toThrow(/JWT_SECRET/);
  });

  it('returns the secret when present', () => {
    expect(loadConfig(base).jwtSecret).toBe('test-secret-value');
  });

  it('falls back to the docker-compose defaults for optional values', () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(3000);
    expect(cfg.mongoUrl).toBe('mongodb://localhost:27017/wardrobe');
    expect(cfg.minioBucket).toBe('wardrobe-items');
    expect(cfg.aiServiceUrl).toBe('http://localhost:8000');
  });

  it('falls back to the default mongoUrl when MONGO_URL is present but blank', () => {
    // `??` only falls back on undefined, so a blank MONGO_URL used to pass ''
    // through as the connection string. `mongoose.connect('')` rejects
    // instantly, but inside a jest `beforeAll` that reads as a suite emitting
    // no output while its handles never settle -- a hang, not a failure.
    for (const blank of ['', '   ', '\t']) {
      expect(loadConfig({ ...base, MONGO_URL: blank }).mongoUrl).toBe(
        'mongodb://localhost:27017/wardrobe',
      );
    }
  });

  it('trims surrounding whitespace off a provided MONGO_URL', () => {
    expect(loadConfig({ ...base, MONGO_URL: '  mongodb://db:27017/x  ' }).mongoUrl).toBe(
      'mongodb://db:27017/x',
    );
  });

  it('prefers provided values over defaults', () => {
    const cfg = loadConfig({ ...base, PORT: '4001', MINIO_BUCKET: 'other-bucket' });
    expect(cfg.port).toBe(4001);
    expect(cfg.minioBucket).toBe('other-bucket');
  });

  it('rejects a non-numeric PORT rather than silently using NaN', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('rejects a PORT of zero', () => {
    expect(() => loadConfig({ ...base, PORT: '0' })).toThrow(/PORT/);
  });

  it('rejects a negative PORT', () => {
    expect(() => loadConfig({ ...base, PORT: '-1' })).toThrow(/PORT/);
  });

  it('rejects a non-integer PORT', () => {
    expect(() => loadConfig({ ...base, PORT: '3.5' })).toThrow(/PORT/);
  });
});
