import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import type { PublicClothingItem } from '@wardrobe/shared';
import { OutfitComposer } from '../../src/outfits/OutfitComposer';
import { useWardrobe, type UseWardrobeResult } from '../../src/wardrobe/useWardrobe';
import { useAuth } from '../../src/auth/AuthContext';

// In `__tests__/` rather than beside the component — see the note in
// OutfitComposer.test.tsx. This file mirrors `__tests__/index.keys.test.tsx`,
// which pins the same property on the wardrobe grid.

jest.mock('../../src/wardrobe/useWardrobe', () => ({ useWardrobe: jest.fn() }));
jest.mock('../../src/outfits/api', () => ({ createOutfit: jest.fn() }));
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));

/**
 * The tile is replaced by a probe that records, in a ref, the id it was
 * **first** rendered with, and renders that recorded id as text under a testID
 * keyed by its **current** id. A cell React remounts starts a fresh ref, so
 * `probe-x` reads "x". A cell React reuses keeps the old one, so `probe-x`
 * reads "a" — the mounted-image-in-the-wrong-cell defect, made textual.
 *
 * The probe replaces the tile rather than wrapping it so that this file states
 * one thing only; `OutfitComposer.test.tsx` exercises the real `ItemTile`.
 */
jest.mock('../../src/wardrobe/ItemTile', () => {
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
const mockedUseAuth = useAuth as jest.Mock;

function item(id: string): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/full/${id}.jpg`,
    thumbnailUrl: `https://example.test/thumb/${id}.jpg`,
    category: 'tshirt',
    colors: [],
    seasons: [],
    laundryStatus: 'available',
    wearCount: 0,
    source: 'manual',
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

describe('outfit composer cell identity', () => {
  beforeEach(() => {
    // The composer reads a token for its save path. Nothing here saves, but
    // the hook still runs on every render.
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', name: 'Zaid', email: 'z@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
      token: 'tok-abc',
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('remounts a cell when a refresh replaces the item that was in it', async () => {
    // `refresh()` sets `activity` to `'refreshing'` and deliberately leaves the
    // rows on screen, then replaces `items` wholesale when the response lands.
    // The list stays mounted throughout, so React reconciles the old cells
    // against the new items — and with an index keyExtractor the row key is
    // unchanged, so every cell is reused for a different garment.
    //
    // The consequence is sharper in the composer than on the grid it is
    // borrowed from: a reused cell keeps the image already mounted in it, so
    // the selection ring and the ordinal disc end up drawn over a garment that
    // is not in the outfit — a lie about what the user is about to save.
    //
    // This is the case a paging test cannot reach. FlatList keys each cell
    // within a row by its column index, so this extractor only sets the row
    // key, and a pure append leaves every existing row's mapping untouched.
    const before = [item('a'), item('b'), item('c')];
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: before }));
    const view = await render(<OutfitComposer />);
    expect(screen.getByTestId('probe-a')).toHaveTextContent('a');

    mockedUseWardrobe.mockReturnValue(wardrobe({ items: before, activity: 'refreshing' }));
    await act(async () => {
      view.rerender(<OutfitComposer />);
    });

    const after = [item('x'), item('y'), item('z')];
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: after, activity: 'idle' }));
    await act(async () => {
      view.rerender(<OutfitComposer />);
    });

    expect(screen.getByTestId('probe-x')).toHaveTextContent('x');
    expect(screen.getByTestId('probe-y')).toHaveTextContent('y');
    expect(screen.getByTestId('probe-z')).toHaveTextContent('z');
  });

  it('remounts a cell when a category filter replaces the item that was in it', async () => {
    // The other route to a wholesale replacement, and the one the composer
    // invites: picking a top, then filtering to shoes. Unlike the wardrobe
    // grid — where the hook clears `items` first, trips the first-page
    // spinner and unmounts the list by accident — this path is reached here
    // with rows already on screen whenever the new page lands before the
    // spinner does.
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a'), item('b'), item('c')] }));
    const view = await render(<OutfitComposer />);
    expect(screen.getByTestId('probe-b')).toHaveTextContent('b');

    mockedUseWardrobe.mockReturnValue(
      wardrobe({ items: [item('p'), item('q'), item('r')], category: 'shoes' }),
    );
    await act(async () => {
      view.rerender(<OutfitComposer />);
    });

    expect(screen.getByTestId('probe-p')).toHaveTextContent('p');
    expect(screen.getByTestId('probe-q')).toHaveTextContent('q');
    expect(screen.getByTestId('probe-r')).toHaveTextContent('r');
  });
});
