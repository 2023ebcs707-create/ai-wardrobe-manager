import { Router } from 'express';
import { Types } from 'mongoose';
import {
  DEFAULT_ANALYTICS_LIMIT,
  MAX_ANALYTICS_LIMIT,
  type LaundryStatus,
  type PublicUsageAnalytics,
} from '@wardrobe/shared';
import type { Config } from '../config';
import { ApiError } from '../http/errors';
import { requireAuth } from '../auth/requireAuth';
import {
  ClothingItem,
  LEAST_WORN_SORT,
  MOST_WORN_SORT,
  type ClothingItemDoc,
} from '../models/ClothingItem';
import type { StorageProvider } from '../storage/StorageProvider';
import { parseLimit } from './pagination';
import { signItemUrls } from './signing';

/**
 * The one status `itemsInLaundry` counts.
 *
 * Annotated with the shared union rather than left as a bare string, so a typo
 * here is a compile error instead of a count that is silently always zero.
 * The aggregation stage below is a plain object -- nothing in it is checked
 * against the schema at runtime, which is precisely why the check has to
 * happen at the type level.
 */
const IN_LAUNDRY: LaundryStatus = 'in_laundry';

interface UsageTotals {
  totalWears: number;
  itemsInLaundry: number;
}

export function createAnalyticsRouter(config: Config, storage: StorageProvider): Router {
  const router = Router();

  /**
   * FR6: "View usage analytics showing most/least worn items" (Phase 3).
   *
   * RANKED ON `ClothingItem.wearCount`, NOT BY AGGREGATING `WearHistory`
   * (ruling 4). `POST /wear-history` maintains that counter on every member
   * item of a worn outfit, so the answer is already computed; re-deriving it
   * from the log would be the same number at more cost, and the two would
   * drift the moment either side changed. The log's job is history and
   * provenance, not counting.
   *
   * EVERYTHING HERE IS SCOPED TO `req.userId`, and that is a security
   * boundary rather than input hygiene. This endpoint hands back whole
   * `PublicClothingItem`s -- signed image URLs, categories, colours. A missing
   * filter on any one of the three queries below does not degrade the answer,
   * it serves another user's wardrobe to whoever asked, and the scalars leak
   * just as loudly: `totalWears` would report how much a stranger wears their
   * clothes. `EXCLUDES another user's items from every field` is the test that
   * holds this, and it seeds a second user whose items outrank the caller's on
   * every axis so no coincidence of ordering can hide a leak.
   */
  router.get('/usage', requireAuth(config), async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // Same parser, same rejection-not-clamping behaviour and same error body
    // as every list endpoint; different bounds, because a leaderboard is not a
    // page. See parseLimit.
    const limit = parseLimit(req.query.limit, DEFAULT_ANALYTICS_LIMIT, MAX_ANALYTICS_LIMIT);

    // `Model.aggregate()` does NOT cast against the schema the way `find()`
    // does -- a pipeline is sent as written. `req.userId` is the token's `sub`
    // and is therefore a STRING, and `$match: { userId: '<hex>' }` against a
    // field stored as an ObjectId matches nothing at all. The failure mode is
    // silent and plausible: every caller's totals come back as zero, which
    // reads exactly like a wardrobe nobody has worn yet. Hence the explicit
    // construction, and hence a test that asserts non-zero totals.
    const owner = new Types.ObjectId(userId);

    const [mostWornDocs, leastWornDocs, totals] = await Promise.all([
      // Ownership comes from the verified token, never from a query parameter.
      ClothingItem.find({ userId }).sort(MOST_WORN_SORT).limit(limit) as Promise<
        ClothingItemDoc[]
      >,
      // `leastWorn` deliberately applies NO `wearCount` floor. Never-worn
      // items (`wearCount: 0`) are exactly what a wardrobe app exists to
      // surface -- "you have never worn this" is the whole point -- and
      // excluding them would make the feature say nothing at all about a fresh
      // wardrobe, where every item qualifies.
      ClothingItem.find({ userId }).sort(LEAST_WORN_SORT).limit(limit) as Promise<
        ClothingItemDoc[]
      >,
      // One pass for both scalars: they answer questions about the WHOLE
      // wardrobe, not about the truncated lists above, so they cannot be
      // derived from them.
      ClothingItem.aggregate<UsageTotals>([
        { $match: { userId: owner } },
        {
          $group: {
            _id: null,
            totalWears: { $sum: '$wearCount' },
            itemsInLaundry: {
              $sum: { $cond: [{ $eq: ['$laundryStatus', IN_LAUNDRY] }, 1, 0] },
            },
          },
        },
      ]),
    ]);

    // Signing is one network round trip per key, so a whole list runs
    // concurrently rather than in a sequential loop. An item that appears in
    // both lists -- ordinary on a wardrobe smaller than 2x limit -- is signed
    // twice; deduplicating would couple the two lists together to save one
    // round trip on the smallest wardrobes there are.
    const [mostWorn, leastWorn] = await Promise.all([
      Promise.all(mostWornDocs.map((doc) => signItemUrls(storage, doc))),
      Promise.all(leastWornDocs.map((doc) => signItemUrls(storage, doc))),
    ]);

    // An empty wardrobe produces no group at all, not a group of zeroes.
    // Answered as 0 rather than omitted: the Profile screen renders these as
    // numbers, and an absent field renders as a blank that looks like a failed
    // load rather than an honest "nothing yet".
    const body: PublicUsageAnalytics = {
      mostWorn,
      leastWorn,
      totalWears: totals[0]?.totalWears ?? 0,
      itemsInLaundry: totals[0]?.itemsInLaundry ?? 0,
    };

    res.json(body);
  });

  return router;
}
