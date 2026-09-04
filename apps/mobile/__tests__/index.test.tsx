import React from 'react';
import { FlatList } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import type { PublicClothingItem } from '@wardrobe/shared';
import HomeScreen from '../app/(tabs)/index';
import { useWardrobe, type UseWardrobeResult } from '../src/wardrobe/useWardrobe';
import { useWearHistory } from '../src/tracking/useWearHistory';
import { useItemIndex } from '../src/wardrobe/useItemIndex';

// This file lives in `__tests__/` rather than next to the route it tests.
// Expo Router's Android require-context scans every `.tsx` under `app/` as a
// candidate route with no `.test.` exclusion, so a colocated test drags
// @testing-library/react-native (which imports Node's `console`) into the
// production bundle and breaks it. Found on-device in Stage 2 Task 8 and
// recorded in README.md's "Constraints worth knowing"; `__tests__/add.test.tsx`
// is here for the same reason.

// `useWardrobe` has its own 19-test suite (`src/wardrobe/useWardrobe.test.ts`).
// Mocking it at the module boundary keeps this file about what the *screen*
// derives from the contract, and stops `src/api/client` — whose ApiClientError
// cannot survive automocking — from being pulled in at all.
jest.mock('../src/wardrobe/useWardrobe', () => ({ useWardrobe: jest.fn() }));

// Only `useRouter` is used by this screen, so a factory mock avoids loading
// expo-router (and its native deps) entirely.
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



const mockedUseWardrobe = jest.mocked(useWardrobe);
const mockedUseWearHistory = jest.mocked(useWearHistory);
const mockedUseItemIndex = jest.mocked(useItemIndex);
const mockedUseRouter = useRouter as unknown as jest.Mock;

type Element = ReturnType<typeof screen.getByTestId>;
type Node = Element['children'][number];

/** Every string rendered inside `node`, in order. */
function textContent(node: Element): string {
  const parts: string[] = [];
  const visit = (current: Node): void => {
    if (typeof current === 'string') {
      parts.push(current);
      return;
    }
    current.children.forEach(visit);
  };
  node.children.forEach(visit);
  return parts.join(' ');
}

/** See `imageUri` in ItemTile.test.tsx — RN may normalise `source` to an array. */
function imageUri(el: Element): string | undefined {
  const source = el.props.source as { uri?: string } | { uri?: string }[] | undefined;
  return Array.isArray(source) ? source[0]?.uri : source?.uri;
}

/**
 * Minimal shape of a React fiber, declared locally so this file does not take a
 * dependency on react-reconciler's types for one assertion.
 */
type FiberLike = { type: unknown; memoizedProps: Record<string, unknown>; return: FiberLike | null };

/**
 * The props the `<FlatList>` above `host` was actually rendered with.
 *
 * RNTL 14 exposes host elements only, and a React key never reaches the
 * rendered tree — `toJSON()` returns `{ type, props, children }` and nothing
 * else — so no query can observe which key the grid used. Verified rather than
 * assumed: with `keyExtractor={(_item, index) => String(index)}` in place, all
 * 28 tests of this task passed. `unstable_fiber` is the escape hatch
 * `TestInstance` documents for exactly this, and RNTL's own `fireEvent` walks
 * the same chain to find handlers.
 *
 * What this proves: the list was handed a keyExtractor that returns ids.
 * What it does not prove: that the resulting scroll looks right on a device.
 * That is a native rendering property; Task 7 photographs the screen.
 */
function flatListProps(host: Element): Record<string, unknown> {
  let fiber = host.unstable_fiber as unknown as FiberLike | null;
  while (fiber !== null) {
    if (fiber.type === FlatList) return fiber.memoizedProps;
    fiber = fiber.return;
  }
  throw new Error('No <FlatList> found above the wardrobe grid element');
}

function item(id: string, overrides: Partial<PublicClothingItem> = {}): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/full/${id}.jpg`,
    thumbnailUrl: `https://example.test/thumb/${id}.jpg`,
    category: 'jacket',
    colors: [{ hex: '#001f3f', name: 'navy', share: 1 }],
    seasons: ['winter'],
    laundryStatus: 'available',
    wearCount: 0,
    source: 'ai',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

const setCategory = jest.fn();
const loadMore = jest.fn();
const refresh = jest.fn();
const push = jest.fn();

/** The hook's contract, defaulted to "idle and empty" so each test states only
 *  the axis it is about. */
function wardrobe(overrides: Partial<UseWardrobeResult> = {}): UseWardrobeResult {
  return {
    items: [],
    category: null,
    setCategory,
    activity: 'idle',
    error: null,
    loadMore,
    refresh,
    hasMore: false,
    ...overrides,
  };
}

describe('HomeScreen (wardrobe grid) — TC-06', () => {
  beforeEach(() => {
    mockedUseRouter.mockReturnValue({ push });
    mockedUseWardrobe.mockReturnValue(wardrobe());
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows a loading state before the first page arrives', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ activity: 'loading', items: [] }));

    await render(<HomeScreen />);

    expect(screen.getByTestId('wardrobe-loading')).toBeTruthy();
    expect(screen.queryByTestId('wardrobe-empty')).toBeNull();
  });

  it('renders a tile per item', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a'), item('b'), item('c')] }));

    await render(<HomeScreen />);

    expect(screen.getAllByTestId(/^item-tile-/)).toHaveLength(3);
    expect(screen.getByTestId('item-tile-a')).toBeTruthy();
    expect(screen.getByTestId('item-tile-b')).toBeTruthy();
    expect(screen.getByTestId('item-tile-c')).toBeTruthy();
  });

  it('shows the empty-wardrobe message when there are no items at all', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [], category: null }));

    await render(<HomeScreen />);

    expect(screen.getByTestId('wardrobe-empty')).toBeTruthy();
    expect(screen.queryByTestId('wardrobe-empty-filter')).toBeNull();
    // The document's promise is that a new user is told where to go next.
    expect(textContent(screen.getByTestId('wardrobe-empty'))).toContain('Add');
  });

  it('shows the empty-filter message when a filter matches nothing', async () => {
    // Must be a DIFFERENT message from the empty-wardrobe case: "your wardrobe
    // is empty" is a false statement to a user with 40 items who filtered to a
    // category they own none of. Comparing the two rendered texts is what makes
    // that falsifiable — distinct testIDs alone would still pass if both blocks
    // said the same thing.
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [], category: null }));
    const emptyWardrobe = await render(<HomeScreen />);
    const emptyWardrobeText = textContent(screen.getByTestId('wardrobe-empty'));
    await emptyWardrobe.unmount();

    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [], category: 'jacket' }));
    await render(<HomeScreen />);

    expect(screen.queryByTestId('wardrobe-empty')).toBeNull();
    const emptyFilterText = textContent(screen.getByTestId('wardrobe-empty-filter'));
    expect(emptyFilterText).not.toBe(emptyWardrobeText);
    expect(emptyFilterText).toContain('jacket');
  });

  it('shows an error state with a retry that refetches', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ error: 'Cannot reach the server.' }));

    await render(<HomeScreen />);
    expect(screen.getByTestId('wardrobe-error-message')).toHaveTextContent('Cannot reach the server.');

    await fireEvent.press(screen.getByTestId('wardrobe-retry'));

    expect(refresh).toHaveBeenCalledTimes(1);
    // Re-tapping the active chip is a no-op — the hook's effect keys on the
    // category value — so a retry wired to setCategory would never refetch.
    expect(setCategory).not.toHaveBeenCalled();
  });

  it('keeps the error visible while the retry is still in flight', async () => {
    // `error` says what happened last, `activity` says what is in flight. They
    // are separate fields precisely so this state is representable.
    mockedUseWardrobe.mockReturnValue(
      wardrobe({ error: 'Cannot reach the server.', activity: 'refreshing', items: [item('a')] }),
    );

    await render(<HomeScreen />);

    expect(screen.getByTestId('wardrobe-error')).toBeTruthy();
    expect(screen.getByTestId('item-tile-a')).toBeTruthy();
  });

  it('does not claim the wardrobe is empty when the load failed', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [], category: null, error: 'Cannot reach the server.' }));

    await render(<HomeScreen />);

    expect(screen.queryByTestId('wardrobe-empty')).toBeNull();
    expect(screen.queryByTestId('wardrobe-empty-filter')).toBeNull();
    expect(screen.getByTestId('wardrobe-error')).toBeTruthy();
  });

  it('requests the chosen category when a filter chip is tapped', async () => {
    await render(<HomeScreen />);

    await fireEvent.press(screen.getByTestId('filter-jacket'));

    expect(setCategory).toHaveBeenCalledWith('jacket');
  });

  it('asks for no category at all — never "all" — when the All chip is tapped', async () => {
    // `all` is not in ITEM_CATEGORIES; `GET /items?category=all` is a 400.
    mockedUseWardrobe.mockReturnValue(wardrobe({ category: 'jacket' }));

    await render(<HomeScreen />);
    await fireEvent.press(screen.getByTestId('filter-all'));

    expect(setCategory).toHaveBeenCalledWith(null);
    expect(setCategory).not.toHaveBeenCalledWith('all');
  });

  it('navigates to the item detail route on tile press', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a'), item('b')] }));

    await render(<HomeScreen />);
    await fireEvent.press(screen.getByTestId('item-tile-b'));

    expect(push).toHaveBeenCalledWith('/items/b');
  });

  it('loads the next page when the list end is reached', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a')], hasMore: true }));

    await render(<HomeScreen />);
    await fireEvent(screen.getByTestId('wardrobe-grid'), 'endReached');

    expect(loadMore).toHaveBeenCalled();
  });

  it('lays the items out as a two-column grid', async () => {
    // TC-06's claim is specifically "displayed in a grid". Nothing else in this
    // file distinguishes a grid from a single-column list — RNTL renders no
    // layout — so without this assertion `numColumns` could be deleted with
    // every other test still green.
    //
    // TWO, since the Soft direction: each cell carries a caption under the
    // photograph — category, measured colour, wear count — and there is no room
    // for it at a third of the screen. The cell width in `ItemTile` is derived
    // from its `layout` prop rather than from this number, so the two have to
    // agree; that is the coupling this assertion pins, and it is why the number
    // is written here rather than left to whatever the screen passes.
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a'), item('b'), item('c'), item('d')] }));

    await render(<HomeScreen />);

    expect(flatListProps(screen.getByTestId('wardrobe-grid')).numColumns).toBe(2);
  });

  it('shows the week strip, with today marked and a worn day showing its garment', async () => {
    // The strip is the calendar's idea one week wide, and it is on the home
    // screen because a gap you can see every morning is one you fill in. Both
    // halves are pinned: the seven cells exist, and the day the mocked history
    // has a wear on resolves to a photograph rather than a date.
    mockedUseWearHistory.mockReturnValue({
      events: [
        {
          id: 'w1',
          userId: 'user-1',
          outfitId: 'o1',
          outfitName: 'Weekday uniform',
          itemIds: ['a'],
          wornAt: new Date(2026, 7, 26, 12).toISOString(),
          createdAt: new Date(2026, 7, 26, 12).toISOString(),
        },
      ],
      activity: 'idle',
      error: null,
      loadMore: jest.fn(),
      refresh: jest.fn(),
      hasMore: false,
    });
    mockedUseItemIndex.mockReturnValue({
      byId: { a: item('a', { thumbnailUrl: 'https://example.test/thumb/a.jpg' }) },
      ready: true,
    });
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 30, 9));

    try {
      mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a')] }));
      await render(<HomeScreen />);

      // Monday the 24th to Sunday the 30th — the week today is IN, not the
      // last seven days.
      expect(screen.getByTestId('week-day-2026-08-24')).toBeTruthy();
      expect(screen.getByTestId('week-day-2026-08-30')).toBeTruthy();
      expect(screen.queryByTestId('week-day-2026-08-23')).toBeNull();

      // The worn day speaks its outfit; an empty one says so. This is the
      // whole accessible content of a cell — the visible version is a letter
      // and a photograph, and neither announces anything.
      expect(screen.getByTestId('week-day-2026-08-26').props.accessibilityLabel).toContain(
        'Weekday uniform',
      );
      expect(screen.getByTestId('week-day-2026-08-25').props.accessibilityLabel).toContain(
        'nothing logged',
      );
      expect(screen.getByTestId('week-day-2026-08-30').props.accessibilityLabel).toContain('today');
    } finally {
      jest.useRealTimers();
    }
  });

  it('renders the grid cells in the card layout', async () => {
    // The other half of the pairing above: `numColumns={2}` with the default
    // (three-up) tile layout renders two half-width cells with a third of the
    // row left blank, and every other assertion in this file still passes.
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a')] }));

    await render(<HomeScreen />);

    const renderItem = flatListProps(screen.getByTestId('wardrobe-grid')).renderItem as (
      info: { item: PublicClothingItem; index: number },
    ) => React.ReactElement<{ layout?: string }>;
    expect(renderItem({ item: item('a'), index: 0 }).props.layout).toBe('card');
  });

  it('keys the grid by item id, never by array index', async () => {
    const items = [item('a'), item('b'), item('c')];
    mockedUseWardrobe.mockReturnValue(wardrobe({ items }));

    await render(<HomeScreen />);
    const keyExtractor = flatListProps(screen.getByTestId('wardrobe-grid')).keyExtractor as (
      value: PublicClothingItem,
      index: number,
    ) => string;

    // Index keys tell React that position 1 is "the same tile" after a filter
    // change or a page append, so it reuses the cell — and its mounted image —
    // for a different garment.
    expect(items.map(keyExtractor)).toEqual(['a', 'b', 'c']);
  });

  it('keeps every tile showing its own photo across two pages', async () => {
    const pageOne = [item('a'), item('b'), item('c')];
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: pageOne, hasMore: true }));
    const view = await render(<HomeScreen />);
    expect(screen.getAllByTestId(/^item-tile-/)).toHaveLength(3);

    await fireEvent(screen.getByTestId('wardrobe-grid'), 'endReached');
    expect(loadMore).toHaveBeenCalled();

    // The hook answers a `loadMore` by appending to `items`; this is that
    // second page arriving.
    const pageTwo = [...pageOne, item('d'), item('e'), item('f')];
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: pageTwo, hasMore: false }));
    await view.rerender(<HomeScreen />);

    expect(screen.getAllByTestId(/^item-tile-/)).toHaveLength(6);
    for (const each of pageTwo) {
      expect(imageUri(screen.getByTestId(`item-image-${each.id}`))).toBe(each.thumbnailUrl);
    }
  });

  it('drives the pull-to-refresh spinner from the refreshing activity', async () => {
    // More load-bearing than it looks. After a failed *first* load the list is
    // empty, so `showFirstPageSpinner` is false during the retry
    // (`activity === 'refreshing'`, not `'loading'`) — this RefreshControl is
    // then the only progress feedback the retry produces at all. Hardcoding
    // `refreshing={false}` passes every other test in this file.
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a')], activity: 'refreshing' }));
    const refreshing = await render(<HomeScreen />);
    expect(flatListProps(screen.getByTestId('wardrobe-grid')).refreshing).toBe(true);
    await refreshing.unmount();

    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a')], activity: 'idle' }));
    await render(<HomeScreen />);
    expect(flatListProps(screen.getByTestId('wardrobe-grid')).refreshing).toBe(false);
  });

  it('refreshes on pull-to-refresh', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a')] }));

    await render(<HomeScreen />);
    await fireEvent(screen.getByTestId('wardrobe-grid'), 'refresh');

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows a footer spinner only while a page is appending', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a')], activity: 'loadingMore' }));
    const appending = await render(<HomeScreen />);
    expect(screen.getByTestId('wardrobe-loading-more')).toBeTruthy();
    // The first-page spinner is a different state and must not be showing.
    expect(screen.queryByTestId('wardrobe-loading')).toBeNull();
    await appending.unmount();

    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a')], activity: 'idle' }));
    await render(<HomeScreen />);
    expect(screen.queryByTestId('wardrobe-loading-more')).toBeNull();
  });

  it('keeps the filter row reachable while the first page is still loading', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ activity: 'loading', items: [], category: 'shoes' }));

    await render(<HomeScreen />);

    expect(screen.getByTestId('filter-shoes')).toBeSelected();
  });
});
