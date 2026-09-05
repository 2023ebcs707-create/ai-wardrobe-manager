import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PublicClothingItem } from '@wardrobe/shared';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed, which is why
// `src/api/client` is never `jest.mock`ed anywhere in this repo.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { setLaundryStatus } from '../../src/tracking/api';
import { useLaundryStatus } from '../../src/tracking/useLaundryStatus';

jest.mock('../../src/tracking/api', () => ({
  logWear: jest.fn(),
  fetchWearHistory: jest.fn(),
  setLaundryStatus: jest.fn(),
  fetchUsageAnalytics: jest.fn(),
}));

jest.mock('../../src/auth/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockedSetLaundryStatus = jest.mocked(setLaundryStatus);
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

function item(id: string, laundryStatus: 'available' | 'in_laundry'): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/${id}.jpg`,
    category: 'shirt',
    colors: [],
    seasons: [],
    laundryStatus,
    retired: false,
    wearCount: 2,
    source: 'manual',
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

const washed = item('item-1', 'in_laundry');

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
  mockedSetLaundryStatus.mockImplementation(() => new Promise(() => {}));
}

beforeEach(() => {
  mockedUseAuth.mockReturnValue(authValue(TOKEN));
});

afterEach(() => {
  jest.resetAllMocks();
});

describe('useLaundryStatus', () => {
  it('moves an item into the laundry and resolves the updated item', async () => {
    mockedSetLaundryStatus.mockResolvedValueOnce(washed);
    const { result } = await renderHook(() => useLaundryStatus());

    let updated: PublicClothingItem | null = null;
    await act(async () => {
      updated = await result.current.setStatus('item-1', 'in_laundry');
    });

    expect(mockedSetLaundryStatus).toHaveBeenCalledWith('item-1', {
      token: TOKEN,
      status: 'in_laundry',
    });
    expect(updated).toEqual(washed);
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it('moves an item back out of the laundry', async () => {
    const clean = item('item-1', 'available');
    mockedSetLaundryStatus.mockResolvedValueOnce(clean);
    const { result } = await renderHook(() => useLaundryStatus());

    await act(async () => {
      await result.current.setStatus('item-1', 'available');
    });

    expect(mockedSetLaundryStatus).toHaveBeenCalledWith('item-1', {
      token: TOKEN,
      status: 'available',
    });
  });

  it('issues ONE request for two synchronous calls on the same item', async () => {
    // A laundry toggle has no optimistic update, so the button still reads
    // "Mark as washing" while the first request is in flight — a second tap
    // in the same frame is always a duplicate of the first intent, never a
    // new one. Left unguarded it appends a SECOND row to the transition log
    // (`PATCH /items/:id/laundry` records even a no-op transition, on
    // purpose), so the history Task 5 renders grows a phantom entry for a
    // change the user made once.
    //
    // The guard has to be a ref. A `pending` state flag is committed by React
    // on the next render, which is strictly after both handlers in one frame
    // have already run — so the second call reads `pending === false` and the
    // guard does nothing at all.
    const pending = deferred<PublicClothingItem>();
    stallSurplusRequests();
    mockedSetLaundryStatus.mockReturnValueOnce(pending.promise);

    const { result } = await renderHook(() => useLaundryStatus());

    let firstCall!: Promise<PublicClothingItem | null>;
    let secondCall!: Promise<PublicClothingItem | null>;
    await act(async () => {
      firstCall = result.current.setStatus('item-1', 'in_laundry');
      secondCall = result.current.setStatus('item-1', 'in_laundry');
    });

    expect(mockedSetLaundryStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(washed);
    });

    // Both callers observe the same outcome rather than the second being told
    // the toggle failed.
    await expect(firstCall).resolves.toEqual(washed);
    await expect(secondCall).resolves.toEqual(washed);
  });

  it('allows a genuine second transition once the first has settled', async () => {
    mockedSetLaundryStatus
      .mockResolvedValueOnce(washed)
      .mockResolvedValueOnce(item('item-1', 'available'));
    const { result } = await renderHook(() => useLaundryStatus());

    await act(async () => {
      await result.current.setStatus('item-1', 'in_laundry');
    });
    await act(async () => {
      await result.current.setStatus('item-1', 'available');
    });

    expect(mockedSetLaundryStatus).toHaveBeenCalledTimes(2);
  });

  it('does not collapse concurrent transitions on different items', async () => {
    // Keyed by item id, not a single flag: a wardrobe grid can have two rows
    // toggled at once and both must reach the server.
    stallSurplusRequests();
    const { result } = await renderHook(() => useLaundryStatus());

    await act(async () => {
      void result.current.setStatus('item-1', 'in_laundry');
      void result.current.setStatus('item-2', 'in_laundry');
    });

    expect(mockedSetLaundryStatus).toHaveBeenCalledTimes(2);
  });

  it('reports pending while a transition is in flight', async () => {
    const pending = deferred<PublicClothingItem>();
    stallSurplusRequests();
    mockedSetLaundryStatus.mockReturnValueOnce(pending.promise);
    const { result } = await renderHook(() => useLaundryStatus());

    expect(result.current.pending).toBe(false);

    await act(async () => {
      void result.current.setStatus('item-1', 'in_laundry');
    });
    expect(result.current.pending).toBe(true);

    await act(async () => {
      pending.resolve(washed);
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  it('resolves null and surfaces the message when the transition is rejected', async () => {
    mockedSetLaundryStatus.mockRejectedValueOnce(
      new ApiClientError('NOT_FOUND', 'Item not found', 404),
    );
    const { result } = await renderHook(() => useLaundryStatus());

    let updated: PublicClothingItem | null = washed;
    await act(async () => {
      updated = await result.current.setStatus('item-1', 'in_laundry');
    });

    expect(updated).toBeNull();
    expect(result.current.error).toBe('Item not found');
    expect(result.current.pending).toBe(false);
  });

  it('falls back to a readable message for a non-ApiClientError', async () => {
    mockedSetLaundryStatus.mockRejectedValueOnce(new TypeError('boom'));
    const { result } = await renderHook(() => useLaundryStatus());

    await act(async () => {
      await result.current.setStatus('item-1', 'in_laundry');
    });

    expect(result.current.error).toBe('Something went wrong updating that item.');
  });

  it('clears a previous error when a new transition starts', async () => {
    mockedSetLaundryStatus.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));
    const { result } = await renderHook(() => useLaundryStatus());

    await act(async () => {
      await result.current.setStatus('item-1', 'in_laundry');
    });
    expect(result.current.error).toBe('offline');

    const retry = deferred<PublicClothingItem>();
    stallSurplusRequests();
    mockedSetLaundryStatus.mockReturnValueOnce(retry.promise);

    await act(async () => {
      void result.current.setStatus('item-1', 'in_laundry');
    });

    expect(result.current.pending).toBe(true);
    expect(result.current.error).toBeNull();

    await act(async () => {
      retry.resolve(washed);
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});
