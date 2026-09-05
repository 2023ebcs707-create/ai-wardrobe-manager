import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PublicClothingItem } from '@wardrobe/shared';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed, which is why
// `src/api/client` is never `jest.mock`ed anywhere in this repo.
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { setRetired } from './api';
import { useRetireItem } from './useRetireItem';

jest.mock('./api', () => ({
  fetchItems: jest.fn(),
  fetchItem: jest.fn(),
  setRetired: jest.fn(),
  deleteItem: jest.fn(),
}));

jest.mock('../auth/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockedSetRetired = jest.mocked(setRetired);
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

function item(id: string, retired: boolean): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/${id}.jpg`,
    category: 'shirt',
    colors: [],
    seasons: [],
    laundryStatus: 'available',
    retired,
    wearCount: 2,
    source: 'manual',
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

const retiredItem = item('item-1', true);

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue(authValue(TOKEN));
});

describe('useRetireItem', () => {
  it('sends the requested value with the session token', async () => {
    mockedSetRetired.mockResolvedValue(retiredItem);
    const { result } = await renderHook(() => useRetireItem());

    await act(async () => {
      await result.current.setRetired('item-1', true);
    });

    expect(mockedSetRetired).toHaveBeenCalledWith('item-1', { token: TOKEN, retired: true });
  });

  it('resolves the item the server answered with', async () => {
    mockedSetRetired.mockResolvedValue(retiredItem);
    const { result } = await renderHook(() => useRetireItem());

    let resolved: PublicClothingItem | null = null;
    await act(async () => {
      resolved = await result.current.setRetired('item-1', true);
    });

    // The SERVER's item, never a locally-constructed guess — the whole reason
    // this hook has no optimistic update.
    expect(resolved).toBe(retiredItem);
  });

  it('can un-retire, not only retire', async () => {
    // A one-way door here would make `retired: false` unreachable from the app.
    const active = item('item-1', false);
    mockedSetRetired.mockResolvedValue(active);
    const { result } = await renderHook(() => useRetireItem());

    await act(async () => {
      await result.current.setRetired('item-1', false);
    });

    expect(mockedSetRetired).toHaveBeenCalledWith('item-1', { token: TOKEN, retired: false });
  });

  it('issues ONE request for two calls in the same frame on the same item', async () => {
    // Not a nicety: two writes for one intent is a wasted round trip, and the
    // guard is a ref precisely because a `pending` state flag cannot win this
    // race — React commits it after every handler in the frame has run.
    mockedSetRetired.mockResolvedValue(retiredItem);
    const { result } = await renderHook(() => useRetireItem());

    await act(async () => {
      await Promise.all([
        result.current.setRetired('item-1', true),
        result.current.setRetired('item-1', true),
      ]);
    });

    expect(mockedSetRetired).toHaveBeenCalledTimes(1);
  });

  it('lets two DIFFERENT items be toggled at once', async () => {
    mockedSetRetired.mockResolvedValue(retiredItem);
    const { result } = await renderHook(() => useRetireItem());

    await act(async () => {
      await Promise.all([
        result.current.setRetired('item-1', true),
        result.current.setRetired('item-2', true),
      ]);
    });

    expect(mockedSetRetired).toHaveBeenCalledTimes(2);
  });

  it('resolves null and reports the message on failure', async () => {
    mockedSetRetired.mockRejectedValue(
      new ApiClientError('NOT_FOUND', 'Item not found', 404),
    );
    const { result } = await renderHook(() => useRetireItem());

    let resolved: PublicClothingItem | null = retiredItem;
    await act(async () => {
      resolved = await result.current.setRetired('item-1', true);
    });

    // Resolves rather than rejects, so a screen writing
    // `onPress={() => setRetired(...)}` cannot produce an unhandled rejection.
    expect(resolved).toBeNull();
    await waitFor(() => expect(result.current.error).toBe('Item not found'));
  });

  it('allows a genuine retry once the first attempt has settled', async () => {
    // The half that gets forgotten: a guard released only on the success path
    // makes a failed toggle permanently dead.
    mockedSetRetired.mockRejectedValueOnce(new ApiClientError('UNKNOWN', 'Nope', 500));
    mockedSetRetired.mockResolvedValueOnce(retiredItem);
    const { result } = await renderHook(() => useRetireItem());

    await act(async () => {
      await result.current.setRetired('item-1', true);
    });
    await act(async () => {
      await result.current.setRetired('item-1', true);
    });

    expect(mockedSetRetired).toHaveBeenCalledTimes(2);
  });
});
