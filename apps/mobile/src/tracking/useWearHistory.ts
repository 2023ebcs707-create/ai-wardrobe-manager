import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicWearEvent } from '@wardrobe/shared';
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { fetchWearHistory } from './api';

/**
 * What is in flight *right now*. Deliberately orthogonal to `error`, which
 * says what happened *last*.
 *
 * This is Stage 4's `WardrobeActivity` contract, carried forward through
 * Stage 5's `OutfitsActivity` unchanged, and it is not re-derived here. An
 * earlier draft of that hook folded the two into one `status` union
 * (`loading | ready | error | refreshing`) and it conflated them: after a
 * page-2 failure, calling `loadMore()` again really does issue the request,
 * but a combined status stays on `error` until that request settles — so a
 * retry button has no way to show that the retry started. Two axes cost one
 * field and remove the whole class of problem.
 *
 * - `idle`        — nothing in flight. Says nothing about success; read
 *                   `error` for that.
 * - `loading`     — a full-list load with nothing renderable behind it: first
 *                   mount, or a token change (both clear `events`).
 * - `refreshing`  — pull-to-refresh; the previous rows are still on screen.
 * - `loadingMore` — a page append; the rows already loaded stay valid.
 */
export type WearHistoryActivity = 'idle' | 'loading' | 'refreshing' | 'loadingMore';

export interface UseWearHistoryResult {
  /** Newest wear first, by `wornAt` — a back-dated entry sorts where it
   *  happened, not where it was typed. */
  events: PublicWearEvent[];
  activity: WearHistoryActivity;
  /** A ready-to-render message, or `null` if the last request succeeded. */
  error: string | null;
  /** Safe to pass straight to `FlatList#onEndReached`; see the guard below. */
  loadMore: () => void;
  /** Safe to pass straight to `RefreshControl#onRefresh`. */
  refresh: () => void;
  hasMore: boolean;
}

/**
 * A single `error` channel with no operation tag, unlike `useOutfits`.
 *
 * That hook needed one because a delete and a list load shared the channel, so
 * "clear the error when a new request starts" was only correct *within* an
 * operation. This hook performs exactly one kind of operation — a list read —
 * so there is nothing for a tag to distinguish. Logging a wear is a separate
 * hook (`useLogWear`) with its own error, deliberately: the outfit screen that
 * logs a wear has no reason to mount a history list, and a shared channel
 * between two screens would let one erase the other's message.
 */
function messageFor(err: unknown): string {
  // ApiClientError messages are already written for a person to read (the
  // client turns a network failure into "Cannot reach the server…" and passes
  // the API's own message through otherwise).
  if (err instanceof ApiClientError) return err.message;
  return 'Something went wrong loading your wear history.';
}

/**
 * The wear-history list's data source (FR6 / TC-08).
 *
 * The machinery is Stage 4's `useWardrobe` and Stage 5's `useOutfits` minus
 * their extra axes. The races it handles are the same ones, and they are
 * handled here rather than in the screen because none of them is visible until
 * the network is slow:
 *
 * 1. **Stale responses.** A page append and a pull-to-refresh can be in flight
 *    together and answer out of order. Every request carries a monotonic
 *    sequence number and only the newest may write state. A *value*
 *    comparison — "is this response for the cursor I currently hold?" — is not
 *    enough, and this list is the sharpest example of why: a refresh of a
 *    history whose newest entry has not changed hands back the SAME
 *    `nextCursor` the superseded append was already paging on, so two requests
 *    that must be told apart are identical in every argument they carry. Only
 *    ordering separates them. `useWearHistory.test.ts` writes that A → B → A
 *    sequence out explicitly.
 * 2. **Overlapping pages.** `onEndReached` fires many times through one fling.
 *    `loadMore` is a no-op while anything at all is in flight.
 * 3. **Duplicated refreshes.** Double-tapping "Try again" on a slow network
 *    would otherwise issue two identical page-one requests. `refresh` is a
 *    no-op while another full-list load is running — but it deliberately
 *    still *supersedes* a background page append, because a pull-to-refresh
 *    is an explicit gesture and silently dropping it is worse than one extra
 *    round trip.
 * 4. **Partial state on failure.** An error keeps `events` and the cursor, so
 *    the user keeps what they had and `onEndReached` can retry.
 *
 * There is deliberately NO equivalent of `useOutfits`' deleted-id filter, and
 * the reason is a property of the endpoint rather than an oversight. That
 * filter exists because a page computed before a delete commits can re-serve a
 * removed row. Here: no endpoint deletes or edits a wear event, and the cursor
 * is a keyset on (`wornAt`, `_id`) with a strict `$lt` rather than an offset —
 * so a wear logged mid-scroll (including a back-dated one) can neither shift a
 * row from an unseen page onto a seen one nor drop a row between pages. A row
 * this hook has shown can never become a row that should not be on screen.
 * Deleting the outfit a row refers to only removes its `outfitName`; the event
 * renders from its own snapshotted `itemIds`.
 *
 * The screen is only reachable when authenticated (`app/_layout.tsx` redirects
 * anonymous users and renders a splash while restoring), so the token is
 * present by the time this mounts; no guard for a null token is needed and a
 * 401 would surface through `error` anyway.
 */
export function useWearHistory(): UseWearHistoryResult {
  const { token } = useAuth();

  const [events, setEvents] = useState<PublicWearEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [activity, setActivity] = useState<WearHistoryActivity>('loading');
  const [error, setError] = useState<string | null>(null);

  // Refs, not state: both are read and written inside one synchronous burst
  // (`onEndReached` firing three times before React can re-render), where a
  // state value would still be the stale one from the last commit. That is
  // exactly the case the guards exist for, so they cannot be built on state.
  const requestIdRef = useRef(0);
  const inFlightRef = useRef<WearHistoryActivity>('idle');

  const run = useCallback(
    async (kind: Exclude<WearHistoryActivity, 'idle'>, mode: 'replace' | 'append', cursor?: string) => {
      const requestId = ++requestIdRef.current;
      inFlightRef.current = kind;
      setActivity(kind);
      // A new request makes the previous failure history, not current state.
      // Without this a banner keyed on `error !== null` sits under the refresh
      // spinner still showing the message the refresh is trying to clear.
      setError(null);

      try {
        const page = await fetchWearHistory({
          token,
          // Omitted, never sent empty: `?cursor=` is a 400, not "page one".
          ...(cursor === undefined ? {} : { cursor }),
        });

        // Superseded while we were waiting. Dropping the events is not enough
        // — the cursor has to go too, or the next `loadMore` pages the list
        // the user has already been moved off.
        if (requestIdRef.current !== requestId) return;

        setEvents((prev) => (mode === 'append' ? [...prev, ...page.events] : page.events));
        setNextCursor(page.nextCursor);
        setActivity('idle');
      } catch (err) {
        // The same guard on the catch path, which is the half that gets
        // forgotten because it is written after the success path already
        // works. Without it a request the user has moved on from paints an
        // error over a list that loaded fine.
        if (requestIdRef.current !== requestId) return;
        // `events` and `nextCursor` are deliberately untouched.
        setError(messageFor(err));
        setActivity('idle');
      } finally {
        // Only the newest request owns the flag; a superseded one clearing it
        // would re-open `loadMore` while its replacement is still running.
        if (requestIdRef.current === requestId) inFlightRef.current = 'idle';
      }
    },
    [token],
  );

  // Mount and token change mean the same thing: the list on screen no longer
  // matches what was asked for.
  useEffect(() => {
    setEvents([]);
    setNextCursor(undefined);
    void run('loading', 'replace');
  }, [run]);

  const loadMore = useCallback(() => {
    if (inFlightRef.current !== 'idle') return;
    // `!= null`, not `!== undefined`: nothing between here and the socket
    // validates the response shape (`apiRequest` ends in `return parsed as T`),
    // so a server that ever sent `nextCursor: null` would leave paging
    // permanently "on" and send `?cursor=null` — which the API rejects — on
    // every onEndReached. The declared type says that cannot happen; this
    // costs one character and does not rely on the declaration being true.
    if (nextCursor == null) return;
    void run('loadingMore', 'append', nextCursor);
  }, [run, nextCursor]);

  const refresh = useCallback(() => {
    // Another full-list load is already fetching exactly this; a second one is
    // pure duplicate work. A background `loadingMore` is not, and gets
    // superseded — see race 3 above.
    if (inFlightRef.current === 'loading' || inFlightRef.current === 'refreshing') return;
    // Page one, replacing the list on success. The rows stay on screen
    // meanwhile — a refresh is not a reset.
    void run('refreshing', 'replace');
  }, [run]);

  return {
    events,
    activity,
    error,
    loadMore,
    refresh,
    hasMore: nextCursor != null,
  };
}
