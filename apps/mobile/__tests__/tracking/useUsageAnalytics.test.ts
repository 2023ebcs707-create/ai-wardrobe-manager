import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PublicClothingItem, PublicUsageAnalytics } from '@wardrobe/shared';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed, which is why
// `src/api/client` is never `jest.mock`ed anywhere in this repo.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { fetchUsageAnalytics } from '../../src/tracking/api';
import { useUsageAnalytics } from '../../src/tracking/useUsageAnalytics';

jest.mock('../../src/tracking/api', () => ({
  logWear: jest.fn(),
  fetchWearHistory: jest.fn(),
  setLaundryStatus: jest.fn(),
  fetchUsageAnalytics: jest.fn(),
}));

jest.mock('../../src/auth/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockedFetchUsageAnalytics = jest.mocked(fetchUsageAnalytics);
const mockedUseAuth = jest.mocked(useAuth);

const TOKEN = 'tok-abc';

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

function item(id: string, wearCount: number): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/${id}.jpg`,
    category: 'shirt',
    colors: [],
    seasons: [],
    laundryStatus: 'available',
    wearCount,
    source: 'manual',
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

function snapshot(overrides: Partial<PublicUsageAnalytics> = {}): PublicUsageAnalytics {
  return {
    mostWorn: [item('item-1', 9)],
    leastWorn: [item('item-2', 0)],
    totalWears: 9,
    itemsInLaundry: 1,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function stallSurplusRequests() {
  mockedFetchUsageAnalytics.mockImplementation(() => new Promise(() => {}));
}

const first = snapshot();
const second = snapshot({ totalWears: 12, itemsInLaundry: 0 });

beforeEach(() => {
  mockedUseAuth.mockReturnValue(authValue(TOKEN));
});

afterEach(() => {
  jest.resetAllMocks();
});

describe('useUsageAnalytics', () => {
  it('loads the snapshot on mount', async () => {
    const pending = deferred<PublicUsageAnalytics>();
    mockedFetchUsageAnalytics.mockReturnValueOnce(pending.promise);

    const { result } = await renderHook(() => useUsageAnalytics());

    expect(result.current.activity).toBe('loading');
    // `null`, not an empty snapshot: "not loaded yet" and "loaded, and the
    // wardrobe is empty" render differently, and only the API can tell the
    // screen which one it is looking at.
    expect(result.current.analytics).toBeNull();
    // No `limit`: `?limit=` is a 400, not the server's DEFAULT_ANALYTICS_LIMIT.
    expect(mockedFetchUsageAnalytics).toHaveBeenCalledWith({ token: TOKEN });

    await act(async () => {
      pending.resolve(first);
    });

    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.analytics).toEqual(first);
    expect(result.current.error).toBeNull();
  });

  it('exposes no loadMore, because a snapshot has no pages', async () => {
    // `GET /analytics/usage` returns a leaderboard, not a page: there is no
    // cursor in the response and no paging to drive. A `loadMore` here would
    // be a control with nothing behind it, and a screen wiring it to
    // onEndReached would silently do nothing forever.
    mockedFetchUsageAnalytics.mockResolvedValueOnce(first);
    const { result } = await renderHook(() => useUsageAnalytics());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current).not.toHaveProperty('loadMore');
    expect(result.current).not.toHaveProperty('hasMore');
  });

  it('refreshes into refreshing rather than loading, keeping the old snapshot on screen', async () => {
    mockedFetchUsageAnalytics.mockResolvedValueOnce(first);
    const { result } = await renderHook(() => useUsageAnalytics());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const refreshed = deferred<PublicUsageAnalytics>();
    stallSurplusRequests();
    mockedFetchUsageAnalytics.mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.activity).toBe('refreshing');
    expect(result.current.analytics).toEqual(first);

    await act(async () => {
      refreshed.resolve(second);
    });
    await waitFor(() => expect(result.current.analytics).toEqual(second));
    expect(result.current.activity).toBe('idle');
  });

  it('does not issue a second refresh while one is in flight', async () => {
    mockedFetchUsageAnalytics.mockResolvedValueOnce(first);
    const { result } = await renderHook(() => useUsageAnalytics());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const refreshed = deferred<PublicUsageAnalytics>();
    stallSurplusRequests();
    mockedFetchUsageAnalytics.mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.refresh();
      result.current.refresh();
      result.current.refresh();
    });

    // One for the mount, one for the first refresh. Nothing else.
    expect(mockedFetchUsageAnalytics).toHaveBeenCalledTimes(2);

    await act(async () => {
      refreshed.resolve(second);
    });
    await waitFor(() => expect(result.current.analytics).toEqual(second));
  });

  it('keeps the last good snapshot when a refresh fails', async () => {
    // A stale leaderboard beside an error banner is strictly more useful than
    // a blank one: the numbers were true a moment ago.
    mockedFetchUsageAnalytics.mockResolvedValueOnce(first);
    const { result } = await renderHook(() => useUsageAnalytics());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedFetchUsageAnalytics.mockRejectedValueOnce(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(result.current.error).toBe('Cannot reach the server. Check your connection.'),
    );
    expect(result.current.analytics).toEqual(first);
    expect(result.current.activity).toBe('idle');
  });

  it('surfaces a first-load failure with a null snapshot', async () => {
    mockedFetchUsageAnalytics.mockRejectedValueOnce(
      new ApiClientError('UNAUTHORIZED', 'Session expired', 401),
    );

    const { result } = await renderHook(() => useUsageAnalytics());

    await waitFor(() => expect(result.current.error).toBe('Session expired'));
    expect(result.current.analytics).toBeNull();
    expect(result.current.activity).toBe('idle');
  });

  it('falls back to a readable message for a non-ApiClientError', async () => {
    mockedFetchUsageAnalytics.mockRejectedValueOnce(new TypeError('boom'));

    const { result } = await renderHook(() => useUsageAnalytics());

    await waitFor(() =>
      expect(result.current.error).toBe('Something went wrong loading your usage analytics.'),
    );
  });

  it('clears a previous error when a new request starts', async () => {
    mockedFetchUsageAnalytics.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));
    const { result } = await renderHook(() => useUsageAnalytics());
    await waitFor(() => expect(result.current.error).toBe('offline'));

    const retry = deferred<PublicUsageAnalytics>();
    stallSurplusRequests();
    mockedFetchUsageAnalytics.mockReturnValueOnce(retry.promise);

    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.activity).toBe('refreshing');
    expect(result.current.error).toBeNull();

    await act(async () => {
      retry.resolve(first);
    });
    await waitFor(() => expect(result.current.analytics).toEqual(first));
  });

  it('discards a stale response superseded by a token change', async () => {
    // The snapshot has no cursor, so the only way two of these overlap is a
    // token change while one is in flight. The guard is a monotonic sequence
    // number for the same reason the list hooks use one: the two requests are
    // otherwise indistinguishable, and the loser must not write another user's
    // wardrobe totals over this one's.
    const stale = deferred<PublicUsageAnalytics>();
    const fresh = deferred<PublicUsageAnalytics>();
    stallSurplusRequests();
    mockedFetchUsageAnalytics.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    const { result, rerender } = await renderHook(() => useUsageAnalytics());

    mockedUseAuth.mockReturnValue(authValue('tok-other'));
    await act(async () => {
      await rerender(undefined);
    });
    expect(mockedFetchUsageAnalytics).toHaveBeenLastCalledWith({ token: 'tok-other' });

    await act(async () => {
      fresh.resolve(second);
    });
    await waitFor(() => expect(result.current.analytics).toEqual(second));

    await act(async () => {
      stale.resolve(first);
    });

    expect(result.current.analytics).toEqual(second);
    expect(result.current.activity).toBe('idle');
  });

  it('discards a stale failure superseded by a token change', async () => {
    // The catch path carries the same guard as the success path — the half
    // that is easy to leave unguarded, because it is written after the success
    // path already works.
    const stale = deferred<PublicUsageAnalytics>();
    const fresh = deferred<PublicUsageAnalytics>();
    stallSurplusRequests();
    mockedFetchUsageAnalytics.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    const { result, rerender } = await renderHook(() => useUsageAnalytics());

    mockedUseAuth.mockReturnValue(authValue('tok-other'));
    await act(async () => {
      await rerender(undefined);
    });

    await act(async () => {
      fresh.resolve(second);
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    await act(async () => {
      stale.reject(new ApiClientError('UNAUTHORIZED', 'Session expired', 401));
    });

    expect(result.current.error).toBeNull();
    expect(result.current.analytics).toEqual(second);
    expect(result.current.activity).toBe('idle');
  });

  it('clears the previous user snapshot when the token changes', async () => {
    mockedFetchUsageAnalytics.mockResolvedValueOnce(first);
    const { result, rerender } = await renderHook(() => useUsageAnalytics());
    await waitFor(() => expect(result.current.analytics).toEqual(first));

    const next = deferred<PublicUsageAnalytics>();
    stallSurplusRequests();
    mockedFetchUsageAnalytics.mockReturnValueOnce(next.promise);
    mockedUseAuth.mockReturnValue(authValue('tok-other'));

    await act(async () => {
      await rerender(undefined);
    });

    // Another user's totals are not this user's totals: they go away
    // immediately rather than lingering under a spinner.
    expect(result.current.analytics).toBeNull();
    expect(result.current.activity).toBe('loading');

    await act(async () => {
      next.resolve(second);
    });
    await waitFor(() => expect(result.current.analytics).toEqual(second));
  });
});
