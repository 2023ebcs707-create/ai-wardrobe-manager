import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ItemCategory, PublicClothingItem } from '@wardrobe/shared';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed, which is why
// `src/api/client` is never `jest.mock`ed anywhere in this repo.
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { fetchItems } from './api';
import { useWardrobe } from './useWardrobe';

// `./api` exports two plain functions and (erased) interfaces — no class — so
// a factory mock here is safe in the way a mock of `../api/client` would not
// be. Mocking at this boundary keeps the hook's tests about state machinery
// rather than about URLs, which `api.test.ts` already pins down.
jest.mock('./api', () => ({
  fetchItems: jest.fn(),
  fetchItem: jest.fn(),
}));

// Only `useAuth` is used here, so the real module (and its expo-secure-store
// dependency) is never loaded.
jest.mock('../auth/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockedFetchItems = jest.mocked(fetchItems);
const mockedUseAuth = jest.mocked(useAuth);

const TOKEN = 'tok-abc';

type Page = { items: PublicClothingItem[]; nextCursor?: string };

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

function item(id: string, category: ItemCategory = 'jacket'): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/${id}.jpg`,
    category,
    colors: [],
    seasons: [],
    laundryStatus: 'available',
    retired: false,
    wearCount: 0,
    source: 'ai',
    createdAt: '2026-08-01T10:00:00.000Z',
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
  mockedFetchItems.mockImplementation(() => new Promise(() => {}));
}

// Two RNTL 14 rules this file depends on, both learned the hard way here:
//
// 1. `renderHook` is async and must be awaited. Unawaited, `result` is a
//    promise and every `result.current` read throws "Cannot read properties of
//    undefined".
// 2. Every `act` must be `await act(async () => …)`. RNTL exposes the hook's
//    value through a ref assigned inside a `useEffect`, and the synchronous
//    `act(() => …)` form does not flush that effect — `result.current` stays on
//    the *previous* commit, so an assertion made right after a state change
//    silently reads the old value. That form made `clears items when the
//    category changes` fail against a correct implementation (it saw the
//    jackets still there) and made `does not issue a second request…` fail on
//    an append that had in fact happened.
//
// Awaiting `act` does not weaken any assertion below, because every response
// this file wants to hold open is a `deferred` that only the test resolves.

const jacketA = item('a', 'jacket');
const jacketB = item('b', 'jacket');
const shoesC = item('c', 'shoes');
const shoesD = item('d', 'shoes');

beforeEach(() => {
  mockedUseAuth.mockReturnValue(authValue(TOKEN));
});

afterEach(() => {
  // `reset`, not `clear`: some tests install a lasting `mockImplementation` on
  // `fetchItems`, and `clearAllMocks` wipes only the call log, so that
  // implementation would leak into every test after it. `useAuth`'s return
  // value is re-established in `beforeEach`, so resetting is safe.
  jest.resetAllMocks();
});

describe('useWardrobe', () => {
  it('loads the first page on mount', async () => {
    const first = deferred<Page>();
    mockedFetchItems.mockReturnValueOnce(first.promise);

    const { result } = await renderHook(() => useWardrobe());

    expect(result.current.activity).toBe('loading');
    expect(result.current.items).toEqual([]);
    expect(result.current.category).toBeNull();
    expect(mockedFetchItems).toHaveBeenCalledWith({ token: TOKEN });

    await act(async () => {
      first.resolve({ items: [jacketA, jacketB], nextCursor: 'cursor-1' });
    });

    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.items).toEqual([jacketA, jacketB]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('appends the next page on loadMore', async () => {
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const page2 = deferred<Page>();
    mockedFetchItems.mockReturnValueOnce(page2.promise);
    await act(async () => {
      result.current.loadMore();
    });

    // A page append is its own activity: the rows already on screen stay
    // valid, so this must not read as a first-page load.
    expect(result.current.activity).toBe('loadingMore');
    expect(result.current.items).toEqual([jacketA]);

    await act(async () => {
      page2.resolve({ items: [jacketB] });
    });

    await waitFor(() => expect(result.current.items).toEqual([jacketA, jacketB]));
    expect(mockedFetchItems).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'cursor-1' });
    // The last page omits nextCursor entirely, so paging stops here.
    expect(result.current.hasMore).toBe(false);
    expect(result.current.activity).toBe('idle');
  });

  it('does not issue a second request while one is in flight', async () => {
    // FlatList's onEndReached fires repeatedly through a single fling. Without
    // the in-flight guard, one scroll issues N overlapping requests for the
    // same cursor — N times the data over the wire and N times the signing
    // work server-side for one gesture.
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const second = deferred<Page>();
    stallSurplusRequests();
    mockedFetchItems.mockReturnValueOnce(second.promise);

    await act(async () => {
      result.current.loadMore();
      result.current.loadMore();
      result.current.loadMore();
    });

    // One for the mount, one for the first loadMore. Nothing else.
    expect(mockedFetchItems).toHaveBeenCalledTimes(2);
    expect(mockedFetchItems).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'cursor-1' });

    await act(async () => {
      second.resolve({ items: [jacketB] });
    });
    await waitFor(() => expect(result.current.items).toEqual([jacketA, jacketB]));
  });

  it('does not call loadMore when hasMore is false', async () => {
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA] });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchItems).toHaveBeenCalledTimes(1);
  });

  it('treats a null nextCursor as the end of the list', async () => {
    // Nothing between the socket and the hook validates the response shape —
    // `apiRequest` ends in `return parsed as T`. The declared type says
    // `nextCursor` is `string | undefined`, but if the API ever sent `null`,
    // an `!== undefined` check would leave paging permanently on and send
    // `?cursor=null` — which the API rejects with a 400 — on every
    // onEndReached. The cast is the point of the test.
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA], nextCursor: null } as unknown as Page);
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchItems).toHaveBeenCalledTimes(1);
  });

  it('keeps loadMore closed while a newer request is still running', async () => {
    // A superseded request finishing first must not hand the in-flight flag
    // back: `refresh` is still running, and re-opening `loadMore` would let
    // onEndReached fire a page request against the cursor the refresh is
    // about to replace — which then supersedes the refresh and throws its
    // result away.
    //
    // The third call below also pins the deliberate asymmetry between the two
    // guards: `refresh` is allowed to start while a page append is in flight
    // (it supersedes it), where a second `loadMore` would not be. Tightening
    // refresh's guard to "anything in flight" makes this a 2-call test.
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const page2 = deferred<Page>();
    const refreshed = deferred<Page>();
    stallSurplusRequests();
    mockedFetchItems.mockReturnValueOnce(page2.promise).mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.refresh();
    });
    expect(mockedFetchItems).toHaveBeenCalledTimes(3);
    expect(result.current.activity).toBe('refreshing');

    await act(async () => {
      page2.resolve({ items: [jacketB] });
    });
    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchItems).toHaveBeenCalledTimes(3);

    await act(async () => {
      refreshed.resolve({ items: [shoesC] });
    });
    await waitFor(() => expect(result.current.items).toEqual([shoesC]));
  });

  it('does not issue a second refresh while one is in flight', async () => {
    // A "Try again" button double-tapped on a slow network. State stays
    // correct either way — the sequence guard discards the losers — so the
    // cost is duplicate round trips and duplicate URL signing server-side,
    // which is exactly what a guard is for.
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA] });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const refreshed = deferred<Page>();
    stallSurplusRequests();
    mockedFetchItems.mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.refresh();
      result.current.refresh();
      result.current.refresh();
    });

    expect(mockedFetchItems).toHaveBeenCalledTimes(2);
    expect(result.current.activity).toBe('refreshing');

    await act(async () => {
      refreshed.resolve({ items: [shoesC] });
    });
    await waitFor(() => expect(result.current.items).toEqual([shoesC]));
  });

  it('clears items when the category changes', async () => {
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA, jacketB], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    const shoesPage = deferred<Page>();
    mockedFetchItems.mockReturnValueOnce(shoesPage.promise);

    await act(async () => {
      result.current.setCategory('shoes');
    });

    // Before the shoes response lands. Keeping the jackets on screen while the
    // filter says "shoes" is TC-06's exact failure mode.
    expect(result.current.items).toEqual([]);
    expect(result.current.activity).toBe('loading');
    expect(result.current.category).toBe('shoes');
    // Paging state resets too, or loadMore would page the jacket list.
    expect(result.current.hasMore).toBe(false);
    expect(mockedFetchItems).toHaveBeenLastCalledWith({ token: TOKEN, category: 'shoes' });

    await act(async () => {
      shoesPage.resolve({ items: [shoesC] });
    });
    await waitFor(() => expect(result.current.items).toEqual([shoesC]));
  });

  it('drops the filter when the category is set back to null', async () => {
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA] });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedFetchItems.mockResolvedValueOnce({ items: [shoesC] });
    await act(async () => {
      result.current.setCategory('shoes');
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA, shoesC] });
    await act(async () => {
      result.current.setCategory(null);
    });
    await waitFor(() => expect(result.current.items).toEqual([jacketA, shoesC]));

    // No `category` key at all — `?category=` is a 400, not "everything".
    expect(mockedFetchItems).toHaveBeenLastCalledWith({ token: TOKEN });
    expect(result.current.category).toBeNull();
  });

  it('discards a response for a category that is no longer selected', async () => {
    // Tap `jacket`, then `shoes` before jacket answers. The jacket response
    // lands last; if it wins, the grid shows jackets under a `shoes` chip.
    mockedFetchItems.mockResolvedValueOnce({ items: [] });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const jacketPage = deferred<Page>();
    const shoesPage = deferred<Page>();
    mockedFetchItems.mockReturnValueOnce(jacketPage.promise).mockReturnValueOnce(shoesPage.promise);

    await act(async () => {
      result.current.setCategory('jacket');
    });
    await act(async () => {
      result.current.setCategory('shoes');
    });

    await act(async () => {
      shoesPage.resolve({ items: [shoesC] });
    });
    await waitFor(() => expect(result.current.items).toEqual([shoesC]));

    await act(async () => {
      jacketPage.resolve({ items: [jacketA, jacketB], nextCursor: 'jacket-cursor' });
    });

    expect(result.current.items).toEqual([shoesC]);
    expect(result.current.category).toBe('shoes');
    // The stale page's cursor must be dropped as well, or loadMore would page
    // the jacket list into the shoes grid one screen later.
    expect(result.current.hasMore).toBe(false);
    expect(result.current.activity).toBe('idle');
  });

  it('discards a page append for a category that is no longer selected', async () => {
    // The same race as above, but the stale request is a `loadMore` rather
    // than a filter load — so the concrete damage is jackets *concatenated*
    // into the shoes grid rather than replacing it.
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const page2 = deferred<Page>();
    const shoesPage = deferred<Page>();
    mockedFetchItems.mockReturnValueOnce(page2.promise).mockReturnValueOnce(shoesPage.promise);

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.setCategory('shoes');
    });
    await act(async () => {
      shoesPage.resolve({ items: [shoesC] });
    });
    await waitFor(() => expect(result.current.items).toEqual([shoesC]));

    await act(async () => {
      page2.resolve({ items: [jacketB], nextCursor: 'jacket-cursor' });
    });

    expect(result.current.items).toEqual([shoesC]);
    expect(result.current.items).not.toContainEqual(jacketB);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.activity).toBe('idle');
  });

  it('discards a failure for a category that is no longer selected', async () => {
    // The mirror of the tests above on the error path. A request the user has
    // moved on from must not be able to paint an error over a list that
    // loaded fine.
    mockedFetchItems.mockResolvedValueOnce({ items: [] });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const jacketPage = deferred<Page>();
    const shoesPage = deferred<Page>();
    mockedFetchItems.mockReturnValueOnce(jacketPage.promise).mockReturnValueOnce(shoesPage.promise);

    await act(async () => {
      result.current.setCategory('jacket');
    });
    await act(async () => {
      result.current.setCategory('shoes');
    });

    await act(async () => {
      shoesPage.resolve({ items: [shoesC] });
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    await act(async () => {
      jacketPage.reject(new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'));
    });

    expect(result.current.activity).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(result.current.items).toEqual([shoesC]);
  });

  it('keeps already-loaded items when a later page fails', async () => {
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedFetchItems.mockRejectedValueOnce(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await act(async () => {
      result.current.loadMore();
    });

    await waitFor(() => expect(result.current.error).toBe('Cannot reach the server. Check your connection.'));
    expect(result.current.items).toEqual([jacketA]);
    expect(result.current.activity).toBe('idle');
    // The cursor survives, so onEndReached can retry the same page.
    expect(result.current.hasMore).toBe(true);
  });

  it('surfaces a first-page failure with an empty list', async () => {
    mockedFetchItems.mockRejectedValueOnce(new ApiClientError('UNAUTHORIZED', 'Session expired', 401));

    const { result } = await renderHook(() => useWardrobe());

    await waitFor(() => expect(result.current.error).toBe('Session expired'));
    expect(result.current.items).toEqual([]);
    expect(result.current.activity).toBe('idle');
  });

  it('clears the previous error as soon as a new request starts', async () => {
    // Not when it succeeds — when it *starts*. A grid rendering its banner on
    // `error !== null` would otherwise show the dead message underneath the
    // refresh spinner for the whole round trip.
    mockedFetchItems.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.error).toBe('offline'));

    const refreshed = deferred<Page>();
    mockedFetchItems.mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.activity).toBe('refreshing');
    expect(result.current.error).toBeNull();

    await act(async () => {
      refreshed.resolve({ items: [jacketA] });
    });
    await waitFor(() => expect(result.current.items).toEqual([jacketA]));
    expect(result.current.error).toBeNull();
  });

  it('reports a retry that is in flight, not the failure it is retrying', async () => {
    // The case the single `status` union could not express: after a page-2
    // failure, `loadMore()` really does issue the request, and the screen has
    // to be able to say so.
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedFetchItems.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.error).toBe('offline'));

    const retry = deferred<Page>();
    mockedFetchItems.mockReturnValueOnce(retry.promise);
    await act(async () => {
      result.current.loadMore();
    });

    expect(result.current.activity).toBe('loadingMore');
    expect(result.current.error).toBeNull();
    expect(result.current.items).toEqual([jacketA]);

    await act(async () => {
      retry.resolve({ items: [jacketB] });
    });
    await waitFor(() => expect(result.current.items).toEqual([jacketA, jacketB]));
  });

  it('refresh replaces the list rather than appending', async () => {
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA, jacketB], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const refreshed = deferred<Page>();
    mockedFetchItems.mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.refresh();
    });

    // Pull-to-refresh keeps the current rows on screen behind the spinner —
    // unlike a category change, which must clear them.
    expect(result.current.activity).toBe('refreshing');
    expect(result.current.items).toEqual([jacketA, jacketB]);
    // Page one: no cursor, whatever page the user had scrolled to.
    expect(mockedFetchItems).toHaveBeenLastCalledWith({ token: TOKEN });

    await act(async () => {
      refreshed.resolve({ items: [shoesC] });
    });

    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.items).toEqual([shoesC]);
    expect(result.current.hasMore).toBe(false);
  });

  it('refresh keeps the active category filter', async () => {
    mockedFetchItems.mockResolvedValueOnce({ items: [] });
    const { result } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedFetchItems.mockResolvedValueOnce({ items: [shoesC] });
    await act(async () => {
      result.current.setCategory('shoes');
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedFetchItems.mockResolvedValueOnce({ items: [shoesC, shoesD] });
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(mockedFetchItems).toHaveBeenLastCalledWith({ token: TOKEN, category: 'shoes' });
    // Not just the request shape: the response has to land on the list, or an
    // implementation that drops the refresh on the floor passes this test.
    expect(result.current.items).toEqual([shoesC, shoesD]);
    expect(result.current.category).toBe('shoes');
    expect(result.current.error).toBeNull();
  });

  it('reloads when the token changes', async () => {
    mockedFetchItems.mockResolvedValueOnce({ items: [jacketA] });
    const { result, rerender } = await renderHook(() => useWardrobe());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedUseAuth.mockReturnValue(authValue('tok-other'));
    mockedFetchItems.mockResolvedValueOnce({ items: [shoesC] });
    await act(async () => {
      await rerender(undefined);
    });

    await waitFor(() => expect(result.current.items).toEqual([shoesC]));
    expect(mockedFetchItems).toHaveBeenLastCalledWith({ token: 'tok-other' });
  });
});
