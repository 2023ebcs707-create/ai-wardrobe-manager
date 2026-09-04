import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { PublicOutfit } from '@wardrobe/shared';
import FavoritesScreen from '../../app/(tabs)/favorites';
import { useAuth } from '../../src/auth/AuthContext';
import { fetchOutfits } from '../../src/outfits/api';
import { consumeOutfitsDirty, markOutfitsDirty } from '../../src/outfits/outfitsDirty';

// In `__tests__/` rather than beside the route — see the note in
// favorites.test.tsx.

/**
 * The one file in this task that runs the REAL `useOutfits`, because the two
 * properties below are properties of the hook and the screen TOGETHER and are
 * unfalsifiable with the hook mocked — a mocked `refresh` is a `jest.fn` that
 * cannot decline, and a mocked `outfits` array cannot be paged.
 *
 * 1. **Deep paging survives a focus event.** `refresh()` is a page-ONE load
 *    that replaces the list. An ungated focus effect therefore threw away
 *    every page the user had scrolled to: load page one, scroll to page two,
 *    open an outfit, come back — page-two rows gone, last request carrying no
 *    cursor. `keeps pages already loaded when the tab regains focus` reproduces
 *    exactly that sequence and asserts the rows are still there.
 * 2. **The first focus costs nothing, even when the flag is set.** The gate
 *    consumes on a mount whose page-one load is already in flight, and
 *    `refresh` is a no-op while a full-list load is running. That is a claim
 *    about effect ordering across two modules — the hook's effect is registered
 *    earlier in the same component, so it runs first. If it were wrong, every
 *    first visit after a create would issue two page-one requests and no test
 *    in this repo would notice.
 *
 * `../../src/outfits/api` exports plain functions and (erased) interfaces — no
 * class — so a factory mock here is safe in the way a mock of
 * `../../src/api/client` would not be.
 */
jest.mock('../../src/outfits/api', () => ({
  createOutfit: jest.fn(),
  fetchOutfits: jest.fn(),
  fetchOutfit: jest.fn(),
  updateOutfit: jest.fn(),
  deleteOutfit: jest.fn(),
}));

// Only `useAuth` is used, so the real module (and its expo-secure-store
// dependency) is never loaded.
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));

// This screen has a second mode whose pane calls `useSavedPosts` and
// `useAuth`, and no test in this file chooses it. Both are mocked anyway, and
// the reason is measurement rather than tidiness: a MUTATION that mounts that
// pane here — the default mode changed, or the two branches swapped — otherwise
// fails every test in this file with `useAuth must be used inside an
// AuthProvider`, which says the fixture could not render rather than that the
// screen is wrong. A harness cannot tell those two apart from a count, and this
// project has had verdicts fabricated by exactly that confusion. With these in
// place the same mutation fails on the assertion it should: the gallery is not
// on screen. Task 7's M10 and M11 are the rows that reach this.
jest.mock('../../src/community/useSavedPosts', () => ({
  useSavedPosts: jest.fn(() => ({
    posts: [],
    activity: 'idle',
    error: null,
    loadMore: jest.fn(),
    refresh: jest.fn(),
    hasMore: false,
    toggleLike: jest.fn(),
    toggleSave: jest.fn(),
  })),
}));


/**
 * `useFocusEffect` reduced to its ordering-relevant core: expo-router's own
 * implementation runs the callback from inside a `React.useEffect` declared in
 * THIS component, and calls it immediately when the screen is already focused
 * (`navigation.isFocused()` — true for a tab the user is standing on). The
 * substitution that matters is that the effect is registered at the point the
 * screen calls the hook, which is what puts it after `useOutfits`'s own mount
 * effect. Nothing else about focus is simulated here; the captured callback is
 * invoked directly to stand for a later re-focus.
 */
jest.mock('expo-router', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: jest.fn(),
    useFocusEffect: jest.fn((effect: () => void) => {
      ReactActual.useEffect(effect, [effect]);
    }),
  };
});

const mockedFetchOutfits = jest.mocked(fetchOutfits);
const mockedUseAuth = jest.mocked(useAuth);
const mockedUseRouter = useRouter as unknown as jest.Mock;
const mockedUseFocusEffect = useFocusEffect as unknown as jest.Mock;

const TOKEN = 'tok-abc';

function outfit(id: string): PublicOutfit {
  return {
    id,
    userId: 'user-1',
    name: `Outfit ${id}`,
    itemIds: ['a', 'b'],
    itemCount: 2,
    coverUrl: `https://example.test/cover/${id}.jpg`,
    createdAt: '2026-08-24T09:00:00.000Z',
  };
}

describe('outfit gallery focus refetch (real useOutfits)', () => {
  beforeEach(() => {
    mockedUseRouter.mockReturnValue({ push: jest.fn() });
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: null,
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    consumeOutfitsDirty();
  });

  it('does not issue a second page-one request when the screen mounts focused', async () => {
    mockedFetchOutfits.mockResolvedValue({ outfits: [outfit('o1')] });

    await render(<FavoritesScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('outfit-card-o1')).toBeTruthy();
    });

    // ONE. Nothing has changed, so the gate does not even reach `refresh`.
    expect(mockedFetchOutfits).toHaveBeenCalledTimes(1);
  });

  it('does not issue a second page-one request when it mounts focused with a pending change', async () => {
    // The real sequence: the user composes an outfit on the Add tab and then
    // opens Favorites for the first time this session. The flag is set BEFORE
    // this screen mounts, so the mount load and the focus gate both want page
    // one — and the hook's `inFlightRef` guard is what makes the second a
    // no-op. That only works because `useOutfits`'s effect is registered
    // earlier in this component than the focus effect, so it runs first.
    markOutfitsDirty();
    mockedFetchOutfits.mockResolvedValue({ outfits: [outfit('o1')] });

    await render(<FavoritesScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('outfit-card-o1')).toBeTruthy();
    });

    expect(mockedFetchOutfits).toHaveBeenCalledTimes(1);
    // Consumed rather than left pending: the request that swallowed it was
    // itself a page-one load, so the list on screen already reflects the
    // change. Leaving the flag set would refetch the same page on the next
    // focus for no reason.
    expect(consumeOutfitsDirty()).toBe(false);
  });

  it('keeps pages already loaded when the tab regains focus', async () => {
    // THE regression this gate exists for, reproduced end to end against the
    // real hook: page one, then a real `onEndReached` append to page two, then
    // a focus event. Ungated, the focus fires `refresh()` — a page-ONE load
    // that REPLACES the list — and o2 disappears while the last request goes
    // out with no cursor at all.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfit('o1')], nextCursor: 'cur-1' });
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfit('o2')] });

    await render(<FavoritesScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('outfit-card-o1')).toBeTruthy();
    });

    await act(async () => {
      fireEvent(screen.getByTestId('outfits-gallery'), 'endReached');
    });
    await waitFor(() => {
      expect(screen.getByTestId('outfit-card-o2')).toBeTruthy();
    });
    expect(mockedFetchOutfits).toHaveBeenCalledTimes(2);
    expect(mockedFetchOutfits).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'cur-1' });

    const onFocus = mockedUseFocusEffect.mock.calls[0][0] as () => void;
    await act(async () => {
      onFocus();
    });

    // No third request, and BOTH pages still on screen.
    expect(mockedFetchOutfits).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('outfit-card-o1')).toBeTruthy();
    expect(screen.getByTestId('outfit-card-o2')).toBeTruthy();
  });

  it('refetches page one when the screen is focused after a change', async () => {
    mockedFetchOutfits.mockResolvedValue({ outfits: [outfit('o1')] });

    await render(<FavoritesScreen />);
    await waitFor(() => {
      expect(mockedFetchOutfits).toHaveBeenCalledTimes(1);
    });

    const onFocus = mockedUseFocusEffect.mock.calls[0][0] as () => void;
    markOutfitsDirty();
    mockedFetchOutfits.mockResolvedValue({ outfits: [outfit('o2')] });
    await act(async () => {
      onFocus();
    });

    await waitFor(() => {
      expect(mockedFetchOutfits).toHaveBeenCalledTimes(2);
    });
    // Page one, not a cursor: something changed, and the change is as likely to
    // be on the first page as anywhere — a `?cursor=` would page straight past
    // the row that moved.
    expect(mockedFetchOutfits).toHaveBeenLastCalledWith({ token: TOKEN });
    await waitFor(() => {
      expect(screen.getByTestId('outfit-card-o2')).toBeTruthy();
    });
    expect(screen.queryByTestId('outfit-card-o1')).toBeNull();
  });

  it('discards a change made while the tab is already open only once', async () => {
    mockedFetchOutfits.mockResolvedValue({ outfits: [outfit('o1')] });

    await render(<FavoritesScreen />);
    await waitFor(() => {
      expect(mockedFetchOutfits).toHaveBeenCalledTimes(1);
    });

    const onFocus = mockedUseFocusEffect.mock.calls[0][0] as () => void;
    markOutfitsDirty();
    await act(async () => {
      onFocus();
    });
    await waitFor(() => {
      expect(mockedFetchOutfits).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      onFocus();
    });

    // A second focus with nothing new is free. Against the real hook this also
    // proves the consume is not defeated by the re-render the refetch causes.
    expect(mockedFetchOutfits).toHaveBeenCalledTimes(2);
  });
});
