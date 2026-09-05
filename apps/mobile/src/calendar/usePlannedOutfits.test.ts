import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PublicOutfitPlan } from '@wardrobe/shared';
// The real `ApiClientError` — automocking a class that extends Error yields
// something that cannot be constructed.
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { fetchOutfitPlans } from './api';
import { usePlannedOutfits } from './usePlannedOutfits';

jest.mock('./api', () => ({
  createOutfitPlan: jest.fn(),
  fetchOutfitPlans: jest.fn(),
  deleteOutfitPlan: jest.fn(),
  plannedForOn: jest.fn(),
}));

jest.mock('../auth/AuthContext', () => ({ useAuth: jest.fn() }));

const mockedFetchOutfitPlans = jest.mocked(fetchOutfitPlans);
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

function plan(id: string): PublicOutfitPlan {
  return {
    id,
    userId: 'user-1',
    outfitId: 'outfit-1',
    itemIds: ['item-1'],
    plannedFor: '2026-09-20T19:00:00.000Z',
    createdAt: '2026-09-05T10:00:00.000Z',
  };
}

const SEPTEMBER = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' };
const OCTOBER = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };

/** A promise whose settlement the test controls. */
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

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue(authValue(TOKEN));
});

describe('usePlannedOutfits', () => {
  it('reads the range it was given, with the session token', async () => {
    mockedFetchOutfitPlans.mockResolvedValueOnce([plan('p1')]);

    const { result } = await renderHook(() => usePlannedOutfits(SEPTEMBER));
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(mockedFetchOutfitPlans).toHaveBeenCalledWith({ token: TOKEN, ...SEPTEMBER });
    expect(result.current.plans).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('reads nothing at all for a null range', async () => {
    // A screen with no month resolved must not send `from=Invalid Date`.
    const { result } = await renderHook(() => usePlannedOutfits(null));
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(mockedFetchOutfitPlans).not.toHaveBeenCalled();
    expect(result.current.plans).toEqual([]);
  });

  it('refetches when the range changes', async () => {
    mockedFetchOutfitPlans.mockResolvedValue([]);

    const { rerender, result } = await renderHook(
      ({ range }: { range: { from: string; to: string } | null }) => usePlannedOutfits(range),
      { initialProps: { range: SEPTEMBER } },
    );
    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(mockedFetchOutfitPlans).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ range: OCTOBER });
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(mockedFetchOutfitPlans).toHaveBeenCalledTimes(2);
    expect(mockedFetchOutfitPlans).toHaveBeenLastCalledWith({ token: TOKEN, ...OCTOBER });
  });

  it('does NOT refetch when the range object is new but its values are not', async () => {
    // The hook keys on the two strings rather than the object identity, so a
    // caller that builds the range inline does not refetch on every render.
    mockedFetchOutfitPlans.mockResolvedValue([]);

    const { rerender, result } = await renderHook(
      ({ range }: { range: { from: string; to: string } | null }) => usePlannedOutfits(range),
      { initialProps: { range: { ...SEPTEMBER } } },
    );
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    await act(async () => {
      rerender({ range: { ...SEPTEMBER } });
    });

    expect(mockedFetchOutfitPlans).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good list when a read fails, and reports the message', async () => {
    mockedFetchOutfitPlans.mockResolvedValueOnce([plan('p1')]);
    const { rerender, result } = await renderHook(
      ({ range }: { range: { from: string; to: string } | null }) => usePlannedOutfits(range),
      { initialProps: { range: SEPTEMBER } },
    );
    await waitFor(() => expect(result.current.plans).toHaveLength(1));

    mockedFetchOutfitPlans.mockRejectedValueOnce(
      new ApiClientError('UNKNOWN', 'Cannot reach the server', 0),
    );
    await act(async () => {
      rerender({ range: OCTOBER });
    });
    await waitFor(() => expect(result.current.error).toBe('Cannot reach the server'));

    // A stale month sits beside the message rather than a blank grid.
    expect(result.current.plans).toHaveLength(1);
  });

  it('does not issue a second read while one is in flight', async () => {
    const pending = deferred<PublicOutfitPlan[]>();
    mockedFetchOutfitPlans.mockReturnValueOnce(pending.promise);

    const { result } = await renderHook(() => usePlannedOutfits(SEPTEMBER));

    await act(async () => {
      result.current.refresh();
      result.current.refresh();
    });

    expect(mockedFetchOutfitPlans).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve([]);
    });
  });

  it('refreshes into refreshing, keeping the previous list on screen', async () => {
    mockedFetchOutfitPlans.mockResolvedValueOnce([plan('p1')]);
    const { result } = await renderHook(() => usePlannedOutfits(SEPTEMBER));
    await waitFor(() => expect(result.current.plans).toHaveLength(1));

    const pending = deferred<PublicOutfitPlan[]>();
    mockedFetchOutfitPlans.mockReturnValueOnce(pending.promise);

    await act(async () => {
      result.current.refresh();
    });

    // A refresh is not a reset.
    expect(result.current.activity).toBe('refreshing');
    expect(result.current.plans).toHaveLength(1);

    await act(async () => {
      pending.resolve([plan('p1'), plan('p2')]);
    });
    await waitFor(() => expect(result.current.plans).toHaveLength(2));
  });

  it('discards a response that a newer request has superseded', async () => {
    // A monotonic sequence number, not a value comparison: paging
    // September → October → September leaves the first September response
    // indistinguishable from the third BY VALUE while being two requests old.
    const first = deferred<PublicOutfitPlan[]>();
    const second = deferred<PublicOutfitPlan[]>();
    mockedFetchOutfitPlans.mockReturnValueOnce(first.promise);
    mockedFetchOutfitPlans.mockReturnValueOnce(second.promise);

    const { rerender, result } = await renderHook(
      ({ range }: { range: { from: string; to: string } | null }) => usePlannedOutfits(range),
      { initialProps: { range: SEPTEMBER } },
    );
    await act(async () => {
      rerender({ range: OCTOBER });
    });

    // October lands first, then the superseded September response arrives.
    await act(async () => {
      second.resolve([plan('october')]);
    });
    await act(async () => {
      first.resolve([plan('september'), plan('september-2')]);
    });

    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.plans.map((p) => p.id)).toEqual(['october']);
  });

  it('clears a previous error as soon as a new read starts', async () => {
    mockedFetchOutfitPlans.mockRejectedValueOnce(new ApiClientError('UNKNOWN', 'Broke', 500));
    const { rerender, result } = await renderHook(
      ({ range }: { range: { from: string; to: string } | null }) => usePlannedOutfits(range),
      { initialProps: { range: SEPTEMBER } },
    );
    await waitFor(() => expect(result.current.error).toBe('Broke'));

    const pending = deferred<PublicOutfitPlan[]>();
    mockedFetchOutfitPlans.mockReturnValueOnce(pending.promise);
    await act(async () => {
      rerender({ range: OCTOBER });
    });

    // Without this a banner keyed on `error !== null` sits under the spinner
    // still showing the message the new read is trying to clear.
    expect(result.current.error).toBeNull();

    await act(async () => {
      pending.resolve([]);
    });
  });

  it('falls back to a readable message for a non-ApiClientError', async () => {
    mockedFetchOutfitPlans.mockRejectedValueOnce(new Error('kaboom'));

    const { result } = await renderHook(() => usePlannedOutfits(SEPTEMBER));
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.error).toBe('Something went wrong loading your planned outfits.');
  });
});
