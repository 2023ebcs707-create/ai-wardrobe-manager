import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PublicWearEvent } from '@wardrobe/shared';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed, which is why
// `src/api/client` is never `jest.mock`ed anywhere in this repo.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { fetchWearHistory } from '../../src/tracking/api';
import { useWearHistory } from '../../src/tracking/useWearHistory';

// `../../src/tracking/api` exports plain functions and (erased) interfaces — no
// class — so a factory mock here is safe in the way a mock of
// `../../src/api/client` would not be. Mocking at this boundary keeps these
// tests about state machinery rather than about URLs, which `api.test.ts`
// already pins down.
jest.mock('../../src/tracking/api', () => ({
  logWear: jest.fn(),
  fetchWearHistory: jest.fn(),
  setLaundryStatus: jest.fn(),
  fetchUsageAnalytics: jest.fn(),
}));

// Only `useAuth` is used here, so the real module (and its expo-secure-store
// dependency) is never loaded.
jest.mock('../../src/auth/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockedFetchWearHistory = jest.mocked(fetchWearHistory);
const mockedUseAuth = jest.mocked(useAuth);

const TOKEN = 'tok-abc';

type Page = { events: PublicWearEvent[]; nextCursor?: string };

function authValue(token: string | null) {
  return {
    status: token ? ('authenticated' as const) : ('anonymous' as const),
    user: null,
    token,
    signIn: jest.fn(),
    signUp: jest.fn(),
    signOut: jest.fn(),
  };
}

function wear(id: string, wornAt: string): PublicWearEvent {
  return {
    id,
    userId: 'user-1',
    outfitId: `outfit-${id}`,
    outfitName: `Outfit ${id}`,
    itemIds: [`${id}-item-1`],
    wornAt,
    createdAt: wornAt,
  };
}

/** A promise whose settlement this test controls, so request *ordering* can be
 *  written down explicitly instead of being left to the microtask queue. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // An unhandled rejection would be reported by Jest even though the hook does
  // handle it, because the handler is attached only once the hook awaits.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Any request beyond the ones a test queues up gets a promise that never
 *  settles. Without this a surplus request resolves to `undefined` and the
 *  test dies inside the mock — failing loudly, but for a reason that is not
 *  the one it is named for. With it, a surplus request shows up as the call
 *  count it is. */
function stallSurplusRequests() {
  mockedFetchWearHistory.mockImplementation(() => new Promise(() => {}));
}

// Two RNTL 14 rules this file depends on, both inherited from Stage 4's
// `useWardrobe.test.ts` and Stage 5's `useOutfits.test.ts`, where they were
// learned the hard way:
//
// 1. `renderHook` is async and must be awaited. Unawaited, `result` is a
//    promise and every `result.current` read throws "Cannot read properties of
//    undefined".
// 2. Every `act` must be `await act(async () => …)`. RNTL exposes the hook's
//    value through a ref assigned inside a `useEffect`, and the synchronous
//    `act(() => …)` form does not flush that effect — `result.current` stays on
//    the *previous* commit, so an assertion made right after a state change
//    silently reads the old value.
//
// Awaiting `act` does not weaken any assertion below, because every response
// this file wants to hold open is a `deferred` that only the test resolves.

const wearA = wear('a', '2026-08-22T18:00:00.000Z');
const wearB = wear('b', '2026-08-21T18:00:00.000Z');
const wearC = wear('c', '2026-08-20T18:00:00.000Z');

beforeEach(() => {
  mockedUseAuth.mockReturnValue(authValue(TOKEN));
});

afterEach(() => {
  // `reset`, not `clear`: some tests install a lasting `mockImplementation` on
  // `fetchWearHistory`, and `clearAllMocks` wipes only the call log, so that
  // implementation would leak into every test after it. `useAuth`'s return
  // value is re-established in `beforeEach`, so resetting is safe.
  jest.resetAllMocks();
});

describe('useWearHistory', () => {
  it('loads the first page on mount', async () => {
    const first = deferred<Page>();
    mockedFetchWearHistory.mockReturnValueOnce(first.promise);

    const { result } = await renderHook(() => useWearHistory());

    expect(result.current.activity).toBe('loading');
    expect(result.current.events).toEqual([]);
    // No `limit`, no `cursor`: `?limit=` is a 400, not the server default.
    expect(mockedFetchWearHistory).toHaveBeenCalledWith({ token: TOKEN });

    await act(async () => {
      first.resolve({ events: [wearA, wearB], nextCursor: 'cursor-1' });
    });

    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.events).toEqual([wearA, wearB]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('appends the next page on loadMore', async () => {
    mockedFetchWearHistory.mockResolvedValueOnce({ events: [wearA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWearHistory());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const page2 = deferred<Page>();
    mockedFetchWearHistory.mockReturnValueOnce(page2.promise);
    await act(async () => {
      result.current.loadMore();
    });

    // A page append is its own activity: the rows already on screen stay
    // valid, so this must not read as a first-page load.
    expect(result.current.activity).toBe('loadingMore');
    expect(result.current.events).toEqual([wearA]);

    await act(async () => {
      page2.resolve({ events: [wearB] });
    });

    await waitFor(() => expect(result.current.events).toEqual([wearA, wearB]));
    expect(mockedFetchWearHistory).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'cursor-1' });
    // The last page omits nextCursor entirely, so paging stops here.
    expect(result.current.hasMore).toBe(false);
    expect(result.current.activity).toBe('idle');
  });

  it('does not issue a second request while one is in flight', async () => {
    // FlatList's onEndReached fires repeatedly through a single fling. Without
    // the in-flight guard, one scroll issues N overlapping requests for the
    // same cursor — N times the data over the wire, and N pages' worth of
    // outfit-name resolution server-side, for one gesture.
    mockedFetchWearHistory.mockResolvedValueOnce({ events: [wearA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWearHistory());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const second = deferred<Page>();
    stallSurplusRequests();
    mockedFetchWearHistory.mockReturnValueOnce(second.promise);

    await act(async () => {
      result.current.loadMore();
      result.current.loadMore();
      result.current.loadMore();
    });

    // One for the mount, one for the first loadMore. Nothing else.
    expect(mockedFetchWearHistory).toHaveBeenCalledTimes(2);
    expect(mockedFetchWearHistory).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'cursor-1' });

    await act(async () => {
      second.resolve({ events: [wearB] });
    });
    await waitFor(() => expect(result.current.events).toEqual([wearA, wearB]));
  });

  it('does not call loadMore when hasMore is false', async () => {
    mockedFetchWearHistory.mockResolvedValueOnce({ events: [wearA] });
    const { result } = await renderHook(() => useWearHistory());
    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchWearHistory).toHaveBeenCalledTimes(1);
  });

  it('treats a null nextCursor as the end of the list', async () => {
    // Nothing between the socket and the hook validates the response shape —
    // `apiRequest` ends in `return parsed as T`. The declared type says
    // `nextCursor` is `string | undefined`, but if the API ever sent `null`,
    // an `!== undefined` check would leave paging permanently on and send
    // `?cursor=null` — which the API rejects with a 400 — on every
    // onEndReached. The cast is the point of the test.
    mockedFetchWearHistory.mockResolvedValueOnce({
      events: [wearA],
      nextCursor: null,
    } as unknown as Page);
    const { result } = await renderHook(() => useWearHistory());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchWearHistory).toHaveBeenCalledTimes(1);
  });

  it('does not issue a second refresh while one is in flight', async () => {
    // A "Try again" button double-tapped on a slow network. State stays
    // correct either way — the sequence guard discards the losers — so the
    // cost is duplicate round trips, which is exactly what a guard is for.
    mockedFetchWearHistory.mockResolvedValueOnce({ events: [wearA] });
    const { result } = await renderHook(() => useWearHistory());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const refreshed = deferred<Page>();
    stallSurplusRequests();
    mockedFetchWearHistory.mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.refresh();
      result.current.refresh();
      result.current.refresh();
    });

    expect(mockedFetchWearHistory).toHaveBeenCalledTimes(2);
    expect(result.current.activity).toBe('refreshing');

    await act(async () => {
      refreshed.resolve({ events: [wearC] });
    });
    await waitFor(() => expect(result.current.events).toEqual([wearC]));
  });

  it('keeps loadMore closed while a newer request is still running', async () => {
    // A superseded request finishing first must not hand the in-flight flag
    // back: `refresh` is still running, and re-opening `loadMore` would let
    // onEndReached fire a page request against the cursor the refresh is about
    // to replace — which then supersedes the refresh and throws its result
    // away.
    //
    // The third call below also pins the deliberate asymmetry between the two
    // guards: `refresh` is allowed to start while a page append is in flight
    // (it supersedes it), where a second `loadMore` would not be. A pull-to-
    // refresh is an intentional gesture; an onEndReached is not.
    mockedFetchWearHistory.mockResolvedValueOnce({ events: [wearA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWearHistory());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const page2 = deferred<Page>();
    const refreshed = deferred<Page>();
    stallSurplusRequests();
    mockedFetchWearHistory
      .mockReturnValueOnce(page2.promise)
      .mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.refresh();
    });
    expect(mockedFetchWearHistory).toHaveBeenCalledTimes(3);
    expect(result.current.activity).toBe('refreshing');

    await act(async () => {
      page2.resolve({ events: [wearB] });
    });
    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchWearHistory).toHaveBeenCalledTimes(3);

    await act(async () => {
      refreshed.resolve({ events: [wearC] });
    });
    await waitFor(() => expect(result.current.events).toEqual([wearC]));
  });

  it('discards a stale response superseded by a refresh', async () => {
    // A page append is still in flight when the user pulls to refresh. The
    // refresh answers first; the append answers second. If the append wins,
    // the list shows page two of a history the refresh just replaced,
    // concatenated onto the refreshed page one — duplicated rows, and a cursor
    // pointing into a list that no longer exists.
    mockedFetchWearHistory.mockResolvedValueOnce({ events: [wearA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWearHistory());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const page2 = deferred<Page>();
    const refreshed = deferred<Page>();
    stallSurplusRequests();
    mockedFetchWearHistory
      .mockReturnValueOnce(page2.promise)
      .mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.refresh();
    });

    await act(async () => {
      refreshed.resolve({ events: [wearC] });
    });
    await waitFor(() => expect(result.current.events).toEqual([wearC]));

    await act(async () => {
      page2.resolve({ events: [wearB], nextCursor: 'stale-cursor' });
    });

    expect(result.current.events).toEqual([wearC]);
    expect(result.current.events).not.toContainEqual(wearB);
    // The stale page's cursor must be dropped as well, or loadMore would page
    // the old list into the refreshed one a screen later.
    expect(result.current.hasMore).toBe(false);
    expect(result.current.activity).toBe('idle');
  });

  it('discards a stale response whose cursor matches the current one (A → B → A)', async () => {
    // THE TEST THE SEQUENCE NUMBER EXISTS FOR, and the one Stage 5's reviewer
    // found missing on a hook that had the mechanism.
    //
    // A *value* comparison — "is this response for the cursor I currently
    // hold?" — looks equivalent to a sequence number and is not. Three
    // requests are enough to separate them:
    //
    //   1. loadMore(cursor-1)   — request A, held open
    //   2. refresh()            — request B, answers with nextCursor 'cursor-1'
    //                             AGAIN, which is ordinary: the newest wear is
    //                             still the newest wear
    //   3. loadMore(cursor-1)   — request C, held open
    //   4. A finally answers
    //
    // A and C are indistinguishable by their arguments — same cursor, same
    // mode — so a value comparison lets A's page append onto the refreshed
    // list, while C is still in flight against the same cursor. The user then
    // sees page two twice. Only a monotonic sequence number can tell A from C.
    mockedFetchWearHistory.mockResolvedValueOnce({ events: [wearA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWearHistory());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const firstLoadMore = deferred<Page>();
    const refreshed = deferred<Page>();
    const secondLoadMore = deferred<Page>();
    stallSurplusRequests();
    mockedFetchWearHistory
      .mockReturnValueOnce(firstLoadMore.promise)
      .mockReturnValueOnce(refreshed.promise)
      .mockReturnValueOnce(secondLoadMore.promise);

    await act(async () => {
      result.current.loadMore();
    });
    expect(mockedFetchWearHistory).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'cursor-1' });

    await act(async () => {
      result.current.refresh();
    });

    // The refresh hands back the SAME cursor the superseded append is paging
    // on. That is the whole trap.
    await act(async () => {
      refreshed.resolve({ events: [wearC], nextCursor: 'cursor-1' });
    });
    await waitFor(() => expect(result.current.events).toEqual([wearC]));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });
    expect(mockedFetchWearHistory).toHaveBeenCalledTimes(4);
    expect(mockedFetchWearHistory).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'cursor-1' });
    expect(result.current.activity).toBe('loadingMore');

    // The FIRST loadMore lands, long after it was superseded.
    await act(async () => {
      firstLoadMore.resolve({ events: [wearB], nextCursor: 'stale-cursor' });
    });

    expect(result.current.events).toEqual([wearC]);
    expect(result.current.events).not.toContainEqual(wearB);
    expect(result.current.hasMore).toBe(true);
    // A stale response must not report the newest request as finished either:
    // request C is still open, so the spinner stays.
    expect(result.current.activity).toBe('loadingMore');

    await act(async () => {
      secondLoadMore.resolve({ events: [wearB] });
    });
    await waitFor(() => expect(result.current.events).toEqual([wearC, wearB]));
  });

  it('discards a stale failure superseded by a refresh', async () => {
    // The mirror of the test above on the error path — the half that is easy
    // to leave unguarded, because the `catch` is written after the success
    // path is already working. A request the user has moved on from must not
    // be able to paint an error over a list that loaded fine.
    mockedFetchWearHistory.mockResolvedValueOnce({ events: [wearA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWearHistory());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const page2 = deferred<Page>();
    const refreshed = deferred<Page>();
    stallSurplusRequests();
    mockedFetchWearHistory
      .mockReturnValueOnce(page2.promise)
      .mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.refresh();
    });

    await act(async () => {
      refreshed.resolve({ events: [wearC] });
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    await act(async () => {
      page2.reject(
        new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
      );
    });

    expect(result.current.error).toBeNull();
    expect(result.current.events).toEqual([wearC]);
    expect(result.current.activity).toBe('idle');
  });

  it('keeps already-loaded events when a later page fails', async () => {
    mockedFetchWearHistory.mockResolvedValueOnce({ events: [wearA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWearHistory());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedFetchWearHistory.mockRejectedValueOnce(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await act(async () => {
      result.current.loadMore();
    });

    await waitFor(() =>
      expect(result.current.error).toBe('Cannot reach the server. Check your connection.'),
    );
    expect(result.current.events).toEqual([wearA]);
    expect(result.current.activity).toBe('idle');
    // The cursor survives, so onEndReached can retry the same page.
    expect(result.current.hasMore).toBe(true);
  });

  it('surfaces a first-page failure with an empty list', async () => {
    mockedFetchWearHistory.mockRejectedValueOnce(
      new ApiClientError('UNAUTHORIZED', 'Session expired', 401),
    );

    const { result } = await renderHook(() => useWearHistory());

    await waitFor(() => expect(result.current.error).toBe('Session expired'));
    expect(result.current.events).toEqual([]);
    expect(result.current.activity).toBe('idle');
  });

  it('falls back to a readable message for a non-ApiClientError', async () => {
    mockedFetchWearHistory.mockRejectedValueOnce(new TypeError('undefined is not a function'));

    const { result } = await renderHook(() => useWearHistory());

    await waitFor(() =>
      expect(result.current.error).toBe('Something went wrong loading your wear history.'),
    );
  });

  it('clears a previous error when a new request starts', async () => {
    // Not when it succeeds — when it *starts*. A screen rendering its banner
    // on `error !== null` would otherwise show the dead message underneath the
    // refresh spinner for the whole round trip.
    mockedFetchWearHistory.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));
    const { result } = await renderHook(() => useWearHistory());
    await waitFor(() => expect(result.current.error).toBe('offline'));

    const retry = deferred<Page>();
    stallSurplusRequests();
    mockedFetchWearHistory.mockReturnValueOnce(retry.promise);

    await act(async () => {
      result.current.refresh();
    });

    // Mid-flight: the request has started and has not answered.
    expect(result.current.activity).toBe('refreshing');
    expect(result.current.error).toBeNull();

    await act(async () => {
      retry.resolve({ events: [wearA] });
    });
    await waitFor(() => expect(result.current.events).toEqual([wearA]));
  });

  it('reloads from scratch when the token changes', async () => {
    mockedFetchWearHistory.mockResolvedValueOnce({ events: [wearA], nextCursor: 'cursor-1' });
    const { result, rerender } = await renderHook(() => useWearHistory());
    await waitFor(() => expect(result.current.events).toEqual([wearA]));

    const next = deferred<Page>();
    stallSurplusRequests();
    mockedFetchWearHistory.mockReturnValueOnce(next.promise);
    mockedUseAuth.mockReturnValue(authValue('tok-other'));

    await act(async () => {
      await rerender(undefined);
    });

    // The previous user's history is not this user's history: it goes away
    // immediately rather than lingering under a spinner.
    expect(result.current.events).toEqual([]);
    expect(result.current.activity).toBe('loading');
    expect(result.current.hasMore).toBe(false);
    expect(mockedFetchWearHistory).toHaveBeenLastCalledWith({ token: 'tok-other' });

    await act(async () => {
      next.resolve({ events: [wearC] });
    });
    await waitFor(() => expect(result.current.events).toEqual([wearC]));
  });
});
