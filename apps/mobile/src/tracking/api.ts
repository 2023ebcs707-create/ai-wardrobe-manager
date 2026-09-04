import type {
  LaundryStatus,
  PublicClothingItem,
  PublicUsageAnalytics,
  PublicWearEvent,
} from '@wardrobe/shared';
import { apiRequest } from '../api/client';

export interface LogWearOptions {
  token: string | null;
  /** The outfit that was worn. A foreign or unknown id is a 400, not a 404. */
  outfitId: string;
  /**
   * **OMIT THIS FOR A WEAR THAT IS HAPPENING NOW.** Send it ONLY for a date
   * the user explicitly chose in the past.
   *
   * This is the client contract stated on `PublicWearEvent.wornAt` in
   * `@wardrobe/shared`, restated here because this is the function that would
   * violate it. `POST /wear-history` compares the value against a `now` it
   * takes AFTER the request lands, with a strict `>` and no skew tolerance
   * whatsoever. The tolerance a client actually gets is therefore one-way
   * transit time and nothing more — measured against this API, a client clock
   * 1ms ahead passes and 5ms ahead is a 400.
   *
   * A handset with an unsynced clock loses that bet on every "Log wear" tap,
   * and the failure is INVISIBLE on a dev machine, where the emulator and the
   * API share one clock and skew is exactly zero. It appears only in the
   * field, as a 400 the user cannot act on.
   *
   * So there is deliberately no default here and this layer never reads the
   * clock. `logWear({ token, outfitId })` sends a body with one key and lets
   * the server stamp the instant the request landed, which is what "now" means
   * anyway. A widened server-side window would not fix it either: any number
   * large enough to absorb a real handset's skew is large enough to admit a
   * genuinely future date.
   */
  wornAt?: string;
  /**
   * Free text, trimmed server-side and bounded by `MAX_OCCASION_LENGTH` from
   * `@wardrobe/shared` — which is what a text input's `maxLength` must be set
   * from, so a user cannot type their way into a 400.
   *
   * Not trimmed or emptied here: the API already treats a blank occasion as
   * absent, and a client that re-implemented that rule would be a second place
   * for it to drift.
   */
  occasion?: string;
}

export interface FetchWearHistoryOptions {
  token: string | null;
  /** Opaque, server-issued. Never parsed or constructed here. */
  cursor?: string;
  /** 1..100. Omitted to take the server's default of 24. */
  limit?: number;
}

export interface WearHistoryPage {
  /** Newest wear first — sorted on `wornAt`, not `createdAt`. */
  events: PublicWearEvent[];
  /**
   * Absent — not null — once the last page has been served. `GET
   * /wear-history` spreads the key in conditionally, so "no more pages" is
   * `nextCursor === undefined` and nothing else.
   */
  nextCursor?: string;
}

export interface SetLaundryStatusOptions {
  token: string | null;
  /**
   * The shared union, never re-declared as string literals here. `PATCH
   * /items/:id/laundry` validates against `LAUNDRY_STATUSES` — one array, and
   * a status this client could send that the route rejects would be a 400
   * nothing in the type system had a chance to catch.
   */
  status: LaundryStatus;
}

export interface FetchUsageAnalyticsOptions {
  token: string | null;
  /**
   * 1..`MAX_ANALYTICS_LIMIT`. Omitted to take the server's
   * `DEFAULT_ANALYTICS_LIMIT` of 5.
   *
   * Deliberately NOT the list endpoints' bounds: this is a top-N leaderboard,
   * not a page of a list, and the endpoint signs a URL per returned item, so a
   * caller-chosen N is a caller-chosen amount of server work.
   */
  limit?: number;
}

/**
 * Builds the `GET /wear-history` query string.
 *
 * Every parameter is *omitted* when it is absent rather than sent empty. The
 * API deliberately never coerces an empty value to a default — `?limit=` fails
 * its digits check and `?cursor=` fails to decode — so both answer 400.
 * Interpolating `` `?limit=${limit ?? ''}` `` would therefore break the very
 * first page.
 *
 * `URLSearchParams` also does the percent-encoding, which matters for the
 * cursor: it is opaque, and although the server currently issues base64url
 * (which has no '+' or '/'), nothing here may rely on that.
 */
function buildWearHistoryQuery(opts: FetchWearHistoryOptions): string {
  const params = new URLSearchParams();
  if (opts.cursor !== undefined) params.set('cursor', opts.cursor);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));

  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Builds the `GET /analytics/usage` query string.
 *
 * Same rule, same reason: `parseLimit` is the very parser the list endpoints
 * use, so `?limit=` is a 400 here too — it just carries analytics' own bounds.
 */
function buildAnalyticsQuery(opts: FetchUsageAnalyticsOptions): string {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));

  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * FR6/TC-08: log that an outfit was worn. `201 { event }`.
 *
 * Read `LogWearOptions.wornAt` before touching the body below. The one rule
 * that matters here is that a wear happening NOW carries no `wornAt` at all.
 */
export async function logWear(opts: LogWearOptions): Promise<PublicWearEvent> {
  const res = await apiRequest<{ event: PublicWearEvent }>('/wear-history', {
    method: 'POST',
    token: opts.token,
    body: {
      outfitId: opts.outfitId,
      // Spread, not `wornAt: opts.wornAt`. `JSON.stringify` drops an explicit
      // `undefined` today, but writing the key unconditionally is how a
      // default gets added to it later — and the default someone reaches for
      // is `new Date().toISOString()`, which is the exact 400 this contract
      // exists to prevent. The key is not there to be defaulted.
      ...(opts.wornAt === undefined ? {} : { wornAt: opts.wornAt }),
      ...(opts.occasion === undefined ? {} : { occasion: opts.occasion }),
    },
  });
  return res.event;
}

/** One page of the signed-in user's wear history. Ownership comes from the token. */
export async function fetchWearHistory(
  opts: FetchWearHistoryOptions,
): Promise<WearHistoryPage> {
  return apiRequest<WearHistoryPage>(`/wear-history${buildWearHistoryQuery(opts)}`, {
    token: opts.token,
  });
}

/**
 * FR7/TC-09: move one item into or out of the laundry. `200 { item }`.
 *
 * The path is a sub-path of the item resource, so the id is encoded rather
 * than interpolated: an id that is not a well-formed ObjectId should reach the
 * route and get its 404, not silently address some other path.
 *
 * There is no client-supplied transition date and there must never be one —
 * `PATCH /items/:id/laundry` stamps its own, precisely because a laundry
 * transition has no back-dating story and therefore no reason to carry the
 * clock-skew hazard `logWear` has to live with.
 */
export async function setLaundryStatus(
  id: string,
  opts: SetLaundryStatusOptions,
): Promise<PublicClothingItem> {
  const res = await apiRequest<{ item: PublicClothingItem }>(
    `/items/${encodeURIComponent(id)}/laundry`,
    { method: 'PATCH', token: opts.token, body: { status: opts.status } },
  );
  return res.item;
}

/**
 * FR6: the usage snapshot Task 5 renders on the Profile tab.
 *
 * Answered as a bare body rather than wrapped in an envelope — there is no
 * `{ analytics }` key to reach through — and it carries NO cursor. It is a
 * snapshot, not a page: `mostWorn`/`leastWorn` are a top-N leaderboard and can
 * legitimately overlap, and `totalWears`/`itemsInLaundry` describe the whole
 * wardrobe rather than the truncated lists beside them.
 */
export async function fetchUsageAnalytics(
  opts: FetchUsageAnalyticsOptions,
): Promise<PublicUsageAnalytics> {
  return apiRequest<PublicUsageAnalytics>(`/analytics/usage${buildAnalyticsQuery(opts)}`, {
    token: opts.token,
  });
}
