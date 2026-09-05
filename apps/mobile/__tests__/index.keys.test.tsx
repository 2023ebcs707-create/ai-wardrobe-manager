import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import type { PublicClothingItem } from '@wardrobe/shared';
import HomeScreen from '../app/(tabs)/index';
import { useWardrobe, type UseWardrobeResult } from '../src/wardrobe/useWardrobe';

// In `__tests__/` rather than beside the route — see the note in index.test.tsx.

jest.mock('../src/wardrobe/useWardrobe', () => ({ useWardrobe: jest.fn() }));
// `useFocusEffect` is a no-op here: this file is about what the screen renders,
// and the focus gate that Stage 6 added has its own suite
// (`__tests__/wardrobe.focus.test.tsx`). Left out of the factory entirely it
// would be `undefined` and the screen would fail to render at all.
jest.mock('expo-router', () => ({ useRouter: jest.fn(), useFocusEffect: jest.fn() }));

// The Soft header greets the user by name and the "Today you could wear" card
// is the first suggestion, so this screen now reads two more contracts. Both
// have their own suites (`src/auth/AuthContext.test.tsx`,
// `src/suggestions/useSuggestions.test.ts`); mocking them at the module
// boundary keeps this file about what the GRID derives, and avoids mounting an
// AuthProvider around every case just to render a set of initials.
jest.mock('../src/auth/AuthContext', () => ({ useAuth: jest.fn(() => ({ user: null })) }));
jest.mock('../src/suggestions/useSuggestions', () => ({
  // `null`, the hook's own "not loaded yet" — so no case below renders the
  // suggestion card unless it opts in. A snapshot here would put three extra
  // images above the grid in every assertion about what the grid shows.
  useSuggestions: jest.fn(() => ({ snapshot: null })),
}));

// The week strip's two reads. Mocked for the same reason `useWardrobe` is —
// each has its own suite — and, more pressingly, because an unmocked
// `useWearHistory` calls `fetch` for real: `useAuth` is mocked here, so the
// hook would run with no token and issue a live request from a unit test.
jest.mock('../src/tracking/useWearHistory', () => ({
  useWearHistory: jest.fn(() => ({
    events: [],
    activity: 'idle',
    error: null,
    loadMore: jest.fn(),
    refresh: jest.fn(),
    hasMore: false,
  })),
}));
jest.mock('../src/wardrobe/useItemIndex', () => ({
  useItemIndex: jest.fn(() => ({ byId: {}, ready: true })),
}));



/**
 * The tile is replaced by a probe that records, in a ref, the id it was
 * **first** rendered with, and renders that recorded id as text under a testID
 * keyed by its **current** id. A cell React remounts starts a fresh ref, so
 * `probe-x` reads "x". A cell React reuses keeps the old one, so `probe-x`
 * reads "a" — the mounted-image-in-the-wrong-cell defect, made textual.
 *
 * The probe replaces the tile rather than wrapping it so that this file states
 * one thing only; `index.test.tsx` exercises the real `ItemTile`.
 */
jest.mock('../src/wardrobe/ItemTile', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ItemTile: ({ item }: { item: PublicClothingItem }) => {
      const firstRenderedWith = ReactActual.useRef(item.id);
      return ReactActual.createElement(
        Text,
        { testID: `probe-${item.id}` },
        firstRenderedWith.current,
      );
    },
  };
});

const mockedUseWardrobe = jest.mocked(useWardrobe);
const mockedUseRouter = useRouter as unknown as jest.Mock;

function item(id: string): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/full/${id}.jpg`,
    thumbnailUrl: `https://example.test/thumb/${id}.jpg`,
    category: 'jacket',
    colors: [],
    seasons: [],
    laundryStatus: 'available',
    retired: false,
    wearCount: 0,
    source: 'ai',
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

function wardrobe(overrides: Partial<UseWardrobeResult> = {}): UseWardrobeResult {
  return {
    items: [],
    category: null,
    setCategory: jest.fn(),
    activity: 'idle',
    error: null,
    loadMore: jest.fn(),
    refresh: jest.fn(),
    hasMore: false,
    ...overrides,
  };
}

describe('wardrobe grid cell identity', () => {
  beforeEach(() => {
    mockedUseRouter.mockReturnValue({ push: jest.fn() });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('remounts a cell when a refresh replaces the item that was in it', async () => {
    // The real sequence this reproduces: `refresh()` sets `activity` to
    // `'refreshing'` and deliberately leaves the rows on screen, then replaces
    // `items` wholesale when the response lands. The list stays mounted
    // throughout, so React reconciles the old cells against the new items —
    // and with an index keyExtractor the row key is unchanged, so every cell is
    // reused for a different garment.
    //
    // This is the case a paging test cannot reach. FlatList keys each cell
    // within a row by its column index (FlatList.js:657), so this extractor
    // only sets the row key (FlatList.js:554-570, joined with ':'), and a pure
    // append leaves every existing row's mapping untouched — id keys and index
    // keys reconcile identically there.
    const before = [item('a'), item('b'), item('c')];
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: before }));
    const view = await render(<HomeScreen />);
    expect(screen.getByTestId('probe-a')).toHaveTextContent('a');

    mockedUseWardrobe.mockReturnValue(wardrobe({ items: before, activity: 'refreshing' }));
    await view.rerender(<HomeScreen />);

    const after = [item('x'), item('y'), item('z')];
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: after, activity: 'idle' }));
    await view.rerender(<HomeScreen />);

    // Each cell must be showing the item it is labelled with, not the one that
    // occupied that position a moment ago.
    expect(screen.getByTestId('probe-x')).toHaveTextContent('x');
    expect(screen.getByTestId('probe-y')).toHaveTextContent('y');
    expect(screen.getByTestId('probe-z')).toHaveTextContent('z');
  });
});
