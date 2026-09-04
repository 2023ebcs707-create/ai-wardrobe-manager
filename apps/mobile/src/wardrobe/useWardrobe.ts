import { useCallback, useEffect, useRef, useState } from 'react';
import type { ItemCategory, PublicClothingItem } from '@wardrobe/shared';
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { fetchItems } from './api';

/**
 * What is in flight *right now*. Deliberately orthogonal to `error`, which
 * says what happened *last*.
 *
 * An earlier draft folded the two into one `status` union
 * (`loading | ready | error | refreshing`) and it conflated them in three
 * places. The sharpest: after a page-2 failure, calling `loadMore()` again
 * really does issue the request, but a combined status stays on `error` until
 * that request settles — so a retry button has no way to show that the retry
 * started. Two axes cost one field and remove the whole class of problem.
 *
 * - `idle`        — nothing in flight. Says nothing about success; read
 *                   `error` for that.
 * - `loading`     — a full-list load with nothing renderable behind it: first
 *                   mount, or a category/token change (both clear `items`).
 * - `refreshing`  — pull-to-refresh; the previous rows are still on screen.
 * - `loadingMore` — a page append; the rows already loaded stay valid.
 */
export type WardrobeActivity = 'idle' | 'loading' | 'refreshing' | 'loadingMore';

export interface UseWardrobeResult {
  items: PublicClothingItem[];
  /** `null` means "no filter" — every category. */
  category: ItemCategory | null;
  /**
   * Selecting the category that is *already* selected is a no-op: the fetch
   * effect keys on the value, so re-tapping the active chip after a failure
   * does not retry. `refresh()` is the retry path.
   */
  setCategory: (next: ItemCategory | null) => void;
  activity: WardrobeActivity;
  /** A ready-to-render message, or `null` if the last request succeeded. */
  error: string | null;
  /** Safe to pass straight to `FlatList#onEndReached`; see the guard below. */
  loadMore: () => void;
  /** Safe to pass straight to `RefreshControl#onRefresh`. */
  refresh: () => void;
  hasMore: boolean;
}

function messageFor(err: unknown): string {
  // ApiClientError messages are already written for a person to read (the
  // client turns a network failure into "Cannot reach the server…" and passes
  // the API's own message through otherwise).
  if (err instanceof ApiClientError) return err.message;
  return 'Something went wrong loading your wardrobe.';
}

/**
 * The wardrobe grid's data source (FR4 / TC-06).
 *
 * Four races are handled here rather than in the screen, because none of them
 * is visible until the network is slow:
 *
 * 1. **Stale responses.** Tapping `jacket` then `shoes` issues two requests;
 *    the jacket one can answer last. Every request carries a sequence number
 *    and only the newest may write state — an ordering guarantee the category
 *    alone cannot give (tapping `jacket`, `shoes`, `jacket` would let the
 *    first jacket response through a category-only check).
 * 2. **Overlapping pages.** `onEndReached` fires many times through one fling.
 *    `loadMore` is a no-op while anything at all is in flight.
 * 3. **Duplicated refreshes.** Double-tapping "Try again" on a slow network
 *    would otherwise issue two identical page-one requests. `refresh` is a
 *    no-op while another full-list load is running — but it deliberately
 *    still *supersedes* a background page append, because a pull-to-refresh
 *    is an explicit gesture and silently dropping it is worse than one extra
 *    round trip.
 * 4. **Partial state on failure.** An error keeps `items` and the cursor, so
 *    the user keeps what they had and `onEndReached` can retry.
 *
 * The screen is only reachable when authenticated (`app/_layout.tsx` redirects
 * anonymous users and renders a splash while restoring), so the token is
 * present by the time this mounts; no guard for a null token is needed and a
 * 401 would surface through `error` anyway.
 */
export function useWardrobe(): UseWardrobeResult {
  const { token } = useAuth();

  const [items, setItems] = useState<PublicClothingItem[]>([]);
  const [category, setCategoryState] = useState<ItemCategory | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [activity, setActivity] = useState<WardrobeActivity>('loading');
  const [error, setError] = useState<string | null>(null);

  // Refs, not state: both are read and written inside one synchronous burst
  // (`onEndReached` firing three times before React can re-render), where a
  // state value would still be the stale one from the last commit. That is
  // exactly the case the guards exist for, so they cannot be built on state.
  const requestIdRef = useRef(0);
  const inFlightRef = useRef<WardrobeActivity>('idle');

  const run = useCallback(
    async (
      kind: Exclude<WardrobeActivity, 'idle'>,
      mode: 'replace' | 'append',
      forCategory: ItemCategory | null,
      cursor?: string,
    ) => {
      const requestId = ++requestIdRef.current;
      inFlightRef.current = kind;
      setActivity(kind);
      // A new request makes the previous failure history, not current state.
      // Without this a banner keyed on `error !== null` sits under the refresh
      // spinner still showing the message the refresh is trying to clear.
      setError(null);

      try {
        const page = await fetchItems({
          token,
          // Omitted, never sent empty: `?category=` is a 400, not "all".
          ...(forCategory === null ? {} : { category: forCategory }),
          ...(cursor === undefined ? {} : { cursor }),
        });

        // Superseded while we were waiting. Dropping the items is not enough —
        // the cursor has to go too, or the next `loadMore` pages the filter
        // the user already moved away from.
        if (requestIdRef.current !== requestId) return;

        setItems((prev) => (mode === 'append' ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setActivity('idle');
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        // `items` and `nextCursor` are deliberately untouched.
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

  // Mount, category change, and token change all mean the same thing: the list
  // on screen no longer matches what was asked for. Clearing here rather than
  // inside `setCategory` keeps the three entry points on one code path.
  useEffect(() => {
    setItems([]);
    setNextCursor(undefined);
    void run('loading', 'replace', category);
  }, [run, category]);

  const setCategory = useCallback((next: ItemCategory | null) => {
    setCategoryState(next);
  }, []);

  const loadMore = useCallback(() => {
    if (inFlightRef.current !== 'idle') return;
    // `!= null`, not `!== undefined`: nothing between here and the socket
    // validates the response shape (`apiRequest` ends in `return parsed as T`),
    // so a server that ever sent `nextCursor: null` would leave paging
    // permanently "on" and send `?cursor=null` — which the API rejects — on
    // every onEndReached. The declared type says that cannot happen; this
    // costs one character and does not rely on the declaration being true.
    if (nextCursor == null) return;
    void run('loadingMore', 'append', category, nextCursor);
  }, [run, category, nextCursor]);

  const refresh = useCallback(() => {
    // Another full-list load is already fetching exactly this; a second one is
    // pure duplicate work. A background `loadingMore` is not, and gets
    // superseded — see race 3 above.
    if (inFlightRef.current === 'loading' || inFlightRef.current === 'refreshing') return;
    // Page one of the *current* filter, replacing the list on success. The
    // rows stay on screen meanwhile — a refresh is not a filter change.
    void run('refreshing', 'replace', category);
  }, [run, category]);

  return {
    items,
    category,
    setCategory,
    activity,
    error,
    loadMore,
    refresh,
    hasMore: nextCursor != null,
  };
}
