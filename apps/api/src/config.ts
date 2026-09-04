export interface Config {
  port: number;
  mongoUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  minioEndpoint: string;
  minioPort: number;
  minioAccessKey: string;
  minioSecretKey: string;
  minioBucket: string;
  aiServiceUrl: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env and set it, or export it before starting the API.`,
    );
  }
  return value;
}

function numeric(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    port: numeric(env, 'PORT', 3000),
    // `?.trim() ||`, not `??`. `??` only falls back on undefined, so a
    // MONGO_URL that is present but BLANK -- an exported-but-empty shell
    // variable, a `.env` line with nothing after the `=` -- passed '' straight
    // through as the connection string. Every other required value goes
    // through `required()`, which rejects blanks; this one key did not, and
    // the failure mode was silent: `mongoose.connect('')` rejects instantly
    // with `MongoParseError: Invalid scheme`, but inside a jest `beforeAll`
    // that shows up as a suite producing NO output at all while its handles
    // never settle. Cost this project ten minutes of a hung run once.
    mongoUrl: env.MONGO_URL?.trim() || 'mongodb://localhost:27017/wardrobe',
    jwtSecret: required(env, 'JWT_SECRET'),
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '7d',
    minioEndpoint: env.MINIO_ENDPOINT ?? 'localhost',
    minioPort: numeric(env, 'MINIO_PORT', 9000),
    minioAccessKey: env.MINIO_ACCESS_KEY ?? 'wardrobe',
    minioSecretKey: env.MINIO_SECRET_KEY ?? 'wardrobe123',
    minioBucket: env.MINIO_BUCKET ?? 'wardrobe-items',
    aiServiceUrl: env.AI_SERVICE_URL ?? 'http://localhost:8000',
  };
}
