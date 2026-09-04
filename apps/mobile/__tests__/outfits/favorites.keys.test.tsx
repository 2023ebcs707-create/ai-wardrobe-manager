import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import type { PublicOutfit } from '@wardrobe/shared';
import FavoritesScreen from '../../app/(tabs)/favorites';
import { useOutfits, type UseOutfitsResult } from '../../src/outfits/useOutfits';

// In `__tests__/` rather than beside the route — see the note in
// favorites.test.tsx. This file mirrors `__tests__/index.keys.test.tsx` and
// `__tests__/outfits/OutfitComposer.keys.test.tsx`, which pin the same
// property on the wardrobe grid and on the composer.

jest.mock('../../src/outfits/useOutfits', () => ({ useOutfits: jest.fn() }));

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

jest.mock('../../src/auth/AuthContext', () => ({
  useAuth: jest.fn(() => ({
    status: 'authenticated',
    user: null,
    token: 'tok-abc',
    signIn: jest.fn(),
    signUp: jest.fn(),
    signOut: jest.fn(),
  })),
}));

jest.mock('expo-router', () => ({ useRouter: jest.fn(), useFocusEffect: jest.fn() }));

/**
 * The card is replaced by a probe that records, in a ref, the id it was
 * **first** rendered with, and renders that recorded id as text under a testID
 * keyed by its **current** id. A cell React remounts starts a fresh ref, so
 * `probe-x` reads "x". A cell React reuses keeps the old one, so `probe-x`
 * reads "o1" — the mounted-cover-in-the-wrong-cell defect, made textual.
 *
 * The probe replaces the card rather than wrapping it so that this file states
 * one thing only; `OutfitCard.test.tsx` exercises the real card.
 */
jest.mock('../../src/outfits/OutfitCard', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  // Only `OutfitCard` is replaced. An earlier draft also restated
  // `UNNAMED_OUTFIT: 'Unnamed outfit'` here; nothing in this file reads a name,
  // so it was dead — and a hard-coded copy of a constant that nothing asserts
  // is a drift hazard rather than a safety net.
  return {
    OutfitCard: ({ outfit }: { outfit: PublicOutfit }) => {
      const firstRenderedWith = ReactActual.useRef(outfit.id);
      return ReactActual.createElement(
        Text,
        { testID: `probe-${outfit.id}` },
        firstRenderedWith.current,
      );
    },
  };
});

const mockedUseOutfits = jest.mocked(useOutfits);
const mockedUseRouter = useRouter as unknown as jest.Mock;

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

function gallery(overrides: Partial<UseOutfitsResult> = {}): UseOutfitsResult {
  return {
    outfits: [],
    activity: 'idle',
    error: null,
    loadMore: jest.fn(),
    refresh: jest.fn(),
    hasMore: false,
    remove: jest.fn(),
    ...overrides,
  };
}

describe('outfit gallery cell identity', () => {
  beforeEach(() => {
    mockedUseRouter.mockReturnValue({ push: jest.fn() });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('remounts a cell when a refresh replaces the outfit that was in it', async () => {
    // The real sequence this reproduces, and the one this screen invites more
    // than any other in the app: the gallery refetches on every focus, so a
    // wholesale replacement of `outfits` happens each time the user comes back
    // from the detail screen or the Add tab. `refresh()` sets `activity` to
    // `'refreshing'` and deliberately leaves the rows on screen, so the list
    // stays mounted throughout and React reconciles the old cells against the
    // new outfits. With an index keyExtractor the row key is unchanged, so
    // every cell is reused — and keeps the cover image already mounted in it —
    // for a different outfit.
    //
    // This is the case a paging test cannot reach. FlatList keys each cell
    // within a row by its column index (FlatList.js), so `keyExtractor` only
    // sets the row key, and a pure append leaves every existing row's mapping
    // untouched: id keys and index keys reconcile identically there.
    const before = [outfit('o1'), outfit('o2')];
    mockedUseOutfits.mockReturnValue(gallery({ outfits: before }));
    const view = await render(<FavoritesScreen />);
    expect(screen.getByTestId('probe-o1')).toHaveTextContent('o1');

    mockedUseOutfits.mockReturnValue(gallery({ outfits: before, activity: 'refreshing' }));
    await act(async () => {
      view.rerender(<FavoritesScreen />);
    });

    const after = [outfit('x'), outfit('y')];
    mockedUseOutfits.mockReturnValue(gallery({ outfits: after, activity: 'idle' }));
    await act(async () => {
      view.rerender(<FavoritesScreen />);
    });

    // Each cell must be showing the outfit it is labelled with, not the one
    // that occupied that position a moment ago.
    expect(screen.getByTestId('probe-x')).toHaveTextContent('x');
    expect(screen.getByTestId('probe-y')).toHaveTextContent('y');
  });

  it('remounts a cell when a delete shortens the list under it', async () => {
    // The other route to a reused cell, and it needs no network at all: an
    // outfit deleted on the detail screen is gone from the next focus refresh,
    // so every outfit after it shifts up one position. Row 0 column 1 becomes
    // a different outfit while the list stays mounted — index keys hand that
    // cell the cover it was already showing.
    mockedUseOutfits.mockReturnValue(
      gallery({ outfits: [outfit('o1'), outfit('o2'), outfit('o3')] }),
    );
    const view = await render(<FavoritesScreen />);
    expect(screen.getByTestId('probe-o2')).toHaveTextContent('o2');

    mockedUseOutfits.mockReturnValue(gallery({ outfits: [outfit('o1'), outfit('o3')] }));
    await act(async () => {
      view.rerender(<FavoritesScreen />);
    });

    expect(screen.getByTestId('probe-o1')).toHaveTextContent('o1');
    expect(screen.getByTestId('probe-o3')).toHaveTextContent('o3');
  });
});
