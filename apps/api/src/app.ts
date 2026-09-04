import express, { type Express } from 'express';
import { overallStatus, type HealthResponse } from '@wardrobe/shared';
import { safeCheck, type HealthChecks } from './health/checks';
import { errorHandler, notFoundHandler } from './http/errors';
import { createAuthRouter } from './routes/auth';
import { createItemsRouter } from './routes/items';
import { createOutfitsRouter } from './routes/outfits';
import { createWearHistoryRouter } from './routes/wearHistory';
import { createAnalyticsRouter } from './routes/analytics';
import { createSuggestionsRouter } from './routes/suggestions';
import { createCommunityRouter } from './routes/community';
import type { Config } from './config';
import type { StorageProvider } from './storage/StorageProvider';

export function createApp(checks: HealthChecks, config: Config, storage: StorageProvider): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    const [database, storage, ai] = await Promise.all([
      safeCheck(checks.database),
      safeCheck(checks.storage),
      safeCheck(checks.ai),
    ]);

    const body: HealthResponse = { api: 'ok', database, storage, ai };
    res.status(overallStatus(body) === 'down' ? 503 : 200).json(body);
  });

  app.use('/auth', createAuthRouter(config));
  app.use('/items', createItemsRouter(config, storage));
  app.use('/outfits', createOutfitsRouter(config, storage));
  // No storage dependency: a wear event carries ids and dates, never an image.
  app.use('/wear-history', createWearHistoryRouter(config));
  // Storage IS a dependency here: the usage rankings return whole
  // PublicClothingItems, with the same signed URLs GET /items hands out.
  app.use('/analytics', createAnalyticsRouter(config, storage));
  // FR8 / TC-10. Storage IS a dependency: a suggestion resolves whole
  // PublicClothingItems, with the same signed URLs GET /items hands out.
  app.use('/suggestions', createSuggestionsRouter(config, storage));
  // FR9 / FR10. Storage IS a dependency: a post carries the same signed
  // PublicClothingItems every other read path hands out, so a client can
  // render a feed card without a second round trip per garment.
  app.use('/community', createCommunityRouter(config, storage));

  // notFoundHandler matches every remaining route, so any router mounted after this
  // point is unreachable and would 404 forever. All feature routers (auth, wardrobe,
  // outfits, etc., added in later tasks) MUST be app.use()'d above this line.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
