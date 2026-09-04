import { createApp } from './app';
import { loadConfig } from './config';
import { connectDatabase, databaseStatus } from './db';
import { createStorageClient, storageStatus } from './health/storageCheck';
import { aiStatus } from './health/aiCheck';
import { createStorageProvider } from './storage/MinioStorageProvider';

const config = loadConfig();
const DB_RETRY_DELAY_MS = Number(process.env.DB_RETRY_DELAY_MS ?? 5000);

// mongoose.connect() only attempts once: if it rejects (e.g. Mongo unreachable
// at boot), the underlying connection is left closed rather than retried in the
// background. Without an explicit retry loop, /health would report
// `database: 'down'` forever even after Mongo comes back, requiring an API
// restart to notice. Retry on a fixed interval until it succeeds.
function connectWithRetry(url: string): void {
  connectDatabase(url).catch((err) => {
    console.error(`Failed to connect to database, retrying in ${DB_RETRY_DELAY_MS}ms:`, err);
    setTimeout(() => connectWithRetry(url), DB_RETRY_DELAY_MS);
  });
}

function main() {
  const storageClient = createStorageClient();

  const app = createApp(
    {
      database: databaseStatus,
      storage: () => storageStatus(storageClient, config.minioBucket),
      ai: () => aiStatus(config.aiServiceUrl),
    },
    config,
    createStorageProvider(config),
  );

  // Listen first, connect after: Mongoose buffers commands until the connection
  // is ready, so requests that don't touch the database are served immediately,
  // and /health can report `database: 'down'` instead of the process never
  // coming up at all when Mongo is unreachable at boot.
  app.listen(config.port, () => console.log(`API listening on ${config.port}`));

  connectWithRetry(config.mongoUrl);
}

main();
