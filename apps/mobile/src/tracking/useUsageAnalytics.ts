import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicUsageAnalytics } from '@wardrobe/shared';
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { fetchUsageAnalytics } from './api';

/**
 * The same two-axis contract the list hooks use, with `loadingMore` REMOVED
 * rather than carried along unused.
 *
 * `GET /analytics/usage` is a snapshot, not a page: it returns a top-N
 * leaderboard plus two wardrobe-wide scalars, and there is no cursor in the
 * response to page on. A `loadingMore` value here would be a state nothing can
 * ever produce, and it would invite a screen to wire an `onEndReached` to a
 * `loadMore` that does not exist. Narrowing the union is a subtype of the list
 * hooks' one, so a screen that renders both can still key on a single type.
 */
export type UsageAnalyticsActivity = 'idle' | 'loading' | 'refreshing';

export interface UseUsageAnalyticsResult {
  /**
   * `null` until the first load lands, and `null` again after a token change.
   *
   * Deliberately not an all-zeroes placeholder: "not loaded yet" and "loaded,
   * and this wardrobe has never been worn" are different screens, and only the
   * API can say which one the user is looking at. The API already answers
   * `totalWears: 0` rather than omitting the field for an empty wardrobe, so a
   * zeroed placeholder here would be indistinguishable from a real answer.
   */
  analytics: PublicUsageAnalytics | null;
  activity: UsageAnalyticsActivity;
  /** A ready-to-render message, or `null` if the last request succeeded. */
  error: string | null;
  /** Safe to pass straight to `RefreshControl#onRefresh`. */
  refresh: () => void;
}

function messageFor(err: unknown): string {
  // ApiClientError messages are already written for a person to read.
  if (err instanceof ApiClientError) return err.message;
  return 'Something went wrong loading your usage analytics.';
}

/**
 * The Profile tab's usage snapshot (FR6).
 *
 * There is NO `loadMore` and no cursor, and that is a property of the endpoint
 * rather than an omission: `GET /analytics/usage` answers a fixed top-N
 * leaderboard with no `nextCursor`, so paging would be a control with nothing
 * behind it. `useUsageAnalytics.test.ts` asserts the absence directly, because
 * "we chose not to add paging" and "we forgot to add paging" look identical in
 * a diff a year later.
 *
 * The two guards that DO apply are kept, for the same reasons the list hooks
 * keep them:
 *
 * 1. **Stale responses.** A refresh cannot overlap another refresh (guard 2),
 *    but a token change can supersede one in flight — and the loser must not
 *    write one user's wardrobe totals over another's. A monotonic sequence
 *    number, not a value comparison: two snapshot requests carry no arguments
 *    that could tell them apart at all, so ordering is the only thing that
 *    can. The guard covers the catch path as well as the success path.
 * 2. **Duplicated refreshes.** Double-tapping "Try again" would otherwise
 *    issue two identical requests, each of which signs a URL per returned item
 *    server-side.
 * 3. **Partial state on failure.** An error keeps the last good snapshot, so
 *    a stale leaderboard sits beside the banner rather than a blank one. The
 *    numbers were true a moment ago.
 */
export function useUsageAnalytics(): UseUsageAnalyticsResult {
  const { token } = useAuth();

  const [analytics, setAnalytics] = useState<PublicUsageAnalytics | null>(null);
  const [activity, setActivity] = useState<UsageAnalyticsActivity>('loading');
  const [error, setError] = useState<string | null>(null);

  // Refs, not state, for the reason the list hooks give: both are read and
  // written inside one synchronous burst, where a state value would still be
  // the stale one from the last commit.
  const requestIdRef = useRef(0);
  const inFlightRef = useRef<UsageAnalyticsActivity>('idle');

  const run = useCallback(
    async (kind: Exclude<UsageAnalyticsActivity, 'idle'>) => {
      const requestId = ++requestIdRef.current;
      inFlightRef.current = kind;
      setActivity(kind);
      // A new request makes the previous failure history, not current state.
      setError(null);

      try {
        // No `limit`: omitted entirely, because `?limit=` is a 400 rather than
        // the server's DEFAULT_ANALYTICS_LIMIT.
        const snapshot = await fetchUsageAnalytics({ token });

        // Superseded while we were waiting — most likely by a token change.
        if (requestIdRef.current !== requestId) return;

        setAnalytics(snapshot);
        setActivity('idle');
      } catch (err) {
        // The same guard on the catch path, which is the half that gets
        // forgotten because it is written after the success path already
        // works.
        if (requestIdRef.current !== requestId) return;
        // `analytics` is deliberately untouched: the last good snapshot stays
        // on screen beside the error.
        setError(messageFor(err));
        setActivity('idle');
      } finally {
        if (requestIdRef.current === requestId) inFlightRef.current = 'idle';
      }
    },
    [token],
  );

  // Mount and token change mean the same thing: the snapshot on screen is not
  // this user's.
  useEffect(() => {
    setAnalytics(null);
    void run('loading');
  }, [run]);

  const refresh = useCallback(() => {
    // Anything at all in flight is already fetching exactly this — there is
    // only one kind of request here, so unlike the list hooks there is no
    // background append for a refresh to legitimately supersede.
    if (inFlightRef.current !== 'idle') return;
    // The previous snapshot stays on screen meanwhile — a refresh is not a
    // reset.
    void run('refreshing');
  }, [run]);

  return { analytics, activity, error, refresh };
}
