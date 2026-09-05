import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicOutfitPlan } from '@wardrobe/shared';
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { fetchOutfitPlans } from './api';

/**
 * The two-axis contract the list hooks use, with `loadingMore` REMOVED — the
 * same narrowing `useSuggestions` makes, and for the same reason.
 *
 * `GET /outfit-plans` is a bounded RANGE read with no cursor in the response,
 * so a `loadingMore` value would be a state nothing can produce and would
 * invite a screen to wire an `onEndReached` to a `loadMore` that does not
 * exist. The month cursor moving is a new range, not a next page.
 */
export type PlansActivity = 'idle' | 'loading' | 'refreshing';

export interface UsePlannedOutfitsResult {
  /** Soonest first, as the endpoint returns them. */
  plans: PublicOutfitPlan[];
  activity: PlansActivity;
  /** A ready-to-render message, or `null` if the last request succeeded. */
  error: string | null;
  /** Re-read the CURRENT range. Safe to call from a focus effect. */
  refresh: () => void;
}

function messageFor(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  return 'Something went wrong loading your planned outfits.';
}

/**
 * The planned outfits inside one date range — what the calendar's visible
 * month reads.
 *
 * ## Why the range is a parameter rather than internal state
 *
 * The month cursor lives on the calendar screen, which already owns it for the
 * grid. Duplicating it here would be a second source for one fact, and the two
 * could disagree about which month is on screen — so this hook takes the range
 * it should read and refetches whenever that range changes.
 *
 * ## The guards
 *
 * 1. **Stale responses.** Moving the cursor quickly (or a token change) can
 *    leave two range reads in flight, and the loser must not write one month's
 *    plans over another's. A monotonic sequence number, not a value
 *    comparison: paging September → October → September leaves the first
 *    September response indistinguishable from the third BY VALUE while being
 *    two requests old. Only ordering separates them — the same reasoning
 *    `useSuggestions` and `useWearHistory` record.
 * 2. **Duplicated refreshes.** A focus effect firing while a load is already
 *    in flight would otherwise issue a second identical range read.
 * 3. **Partial state on failure.** An error keeps the last good list, so a
 *    stale month sits beside the message rather than a blank grid.
 *
 * A `null` range means "do not read anything yet" — a screen with no month
 * resolved must not send `from=Invalid Date`.
 */
export function usePlannedOutfits(range: { from: string; to: string } | null): UsePlannedOutfitsResult {
  const { token } = useAuth();

  const [plans, setPlans] = useState<PublicOutfitPlan[]>([]);
  const [activity, setActivity] = useState<PlansActivity>('loading');
  const [error, setError] = useState<string | null>(null);

  // Refs, not state, for the reason the other hooks give: both are read and
  // written inside one synchronous burst, where a state value would still be
  // the stale one from the last commit.
  const requestIdRef = useRef(0);
  const inFlightRef = useRef(false);

  const from = range?.from ?? null;
  const to = range?.to ?? null;

  const run = useCallback(
    async (kind: Exclude<PlansActivity, 'idle'>) => {
      if (from === null || to === null) {
        setPlans([]);
        setActivity('idle');
        return;
      }

      const requestId = ++requestIdRef.current;
      inFlightRef.current = true;
      setActivity(kind);
      // A new request makes the previous failure history, not current state.
      setError(null);

      try {
        const loaded = await fetchOutfitPlans({ token, from, to });
        // Superseded while we were waiting — by a month change or a token
        // change.
        if (requestIdRef.current !== requestId) return;
        setPlans(loaded);
        setActivity('idle');
      } catch (err) {
        // The same guard on the catch path, which is the half that gets
        // forgotten because it is written after the success path works.
        if (requestIdRef.current !== requestId) return;
        // `plans` is deliberately untouched: the last good month stays on
        // screen beside the error.
        setError(messageFor(err));
        setActivity('idle');
      } finally {
        if (requestIdRef.current === requestId) inFlightRef.current = false;
      }
    },
    [from, to, token],
  );

  // A new range, or a new user, means what is held is not what should be shown.
  useEffect(() => {
    void run('loading');
  }, [run]);

  const refresh = useCallback(() => {
    if (inFlightRef.current) return;
    // The previous list stays on screen meanwhile — a refresh is not a reset.
    void run('refreshing');
  }, [run]);

  return { plans, activity, error, refresh };
}
