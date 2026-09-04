import React from 'react';
import { FlatList } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { PublicOutfit } from '@wardrobe/shared';
import FavoritesScreen, { outfitKeyExtractor } from '../../app/(tabs)/favorites';
// The real signal module — see the note in `[id].test.tsx`. This screen's job is
// to READ it, so a mock here would test that a function was called rather than
// that the gate is wired to the bit the writers actually set.
import { consumeOutfitsDirty, markOutfitsDirty } from '../../src/outfits/outfitsDirty';
import { useOutfits, type UseOutfitsResult } from '../../src/outfits/useOutfits';

// This file lives in `__tests__/` rather than beside the route it tests. Expo
// Router's Android require-context is recursive and excludes only
// `+api`/`+html`/`+middleware`, so any `.tsx` beneath the app root — including
// one inside a `__tests__/` subdirectory — is bundled as a route and drags
// @testing-library/react-native into the production build. README.md:161.

// `useOutfits` has its own 26-test suite (`__tests__/outfits/useOutfits.test.ts`).
// Mocking it at the module boundary keeps this file about what the SCREEN
// derives from that contract, and stops `src/api/client` — whose
// `ApiClientError` cannot survive automocking — from being loaded through it.
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


// A factory mock, so expo-router (and its native dependencies) never loads.
// `useFocusEffect` is a no-op here on purpose: the tests that are about focus
// invoke the captured callback themselves, and every other test would
// otherwise be running an extra refresh it never asked for.
jest.mock('expo-router', () => ({ useRouter: jest.fn(), useFocusEffect: jest.fn() }));

const mockedUseOutfits = jest.mocked(useOutfits);
const mockedUseRouter = useRouter as unknown as jest.Mock;
const mockedUseFocusEffect = useFocusEffect as unknown as jest.Mock;

type Element = ReturnType<typeof screen.getByTestId>;
type Node = Element['children'][number];

/** Every string rendered inside `node`, in order. Same helper as
 *  `__tests__/index.test.tsx`; RNTL exposes no textContent of its own. */
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

/**
 * Minimal shape of a React fiber, declared locally so this file does not take a
 * dependency on react-reconciler's types for two assertions.
 */
type FiberLike = { type: unknown; memoizedProps: Record<string, unknown>; return: FiberLike | null };

/**
 * The props the `<FlatList>` above `host` was actually rendered with.
 *
 * Lifted verbatim from `__tests__/index.test.tsx:74`, where it was introduced
 * for the same job. RNTL 14 exposes host elements only, and neither a React key
 * nor `numColumns` reaches the rendered tree — `toJSON()` returns
 * `{ type, props, children }` and nothing else — so no query can observe
 * either. `unstable_fiber` is the escape hatch `TestInstance` documents for
 * exactly this, and RNTL's own `fireEvent` walks the same chain to find
 * handlers.
 *
 * What this proves: the list was handed two columns and a keyExtractor that
 * returns ids. What it does NOT prove: that two columns actually lay out side
 * by side on a device, or that React reconciled the cells correctly.
 * `favorites.keys.test.tsx` proves the second through public queries; the first
 * is a native layout property and Task 6 photographs it.
 */
function flatListProps(host: Element): Record<string, unknown> {
  let fiber = host.unstable_fiber as unknown as FiberLike | null;
  while (fiber !== null) {
    if (fiber.type === FlatList) return fiber.memoizedProps;
    fiber = fiber.return;
  }
  throw new Error('No <FlatList> found above the outfit gallery element');
}

function outfit(id: string, overrides: Partial<PublicOutfit> = {}): PublicOutfit {
  return {
    id,
    userId: 'user-1',
    name: `Outfit ${id}`,
    itemIds: ['a', 'b'],
    itemCount: 2,
    coverUrl: `https://example.test/cover/${id}.jpg`,
    createdAt: '2026-08-24T09:00:00.000Z',
    ...overrides,
  };
}

const loadMore = jest.fn();
const refresh = jest.fn();
const remove = jest.fn<Promise<boolean>, [string]>();
const push = jest.fn();

/** The hook's contract, defaulted to "idle and empty" so each test states only
 *  the axis it is about. */
function gallery(overrides: Partial<UseOutfitsResult> = {}): UseOutfitsResult {
  return {
    outfits: [],
    activity: 'idle',
    error: null,
    loadMore,
    refresh,
    hasMore: false,
    remove,
    ...overrides,
  };
}

function showing(overrides: Partial<UseOutfitsResult> = {}): UseOutfitsResult {
  const value = gallery(overrides);
  mockedUseOutfits.mockReturnValue(value);
  return value;
}

describe('FavoritesScreen (outfit gallery) — TC-07', () => {
  beforeEach(() => {
    mockedUseRouter.mockReturnValue({ push });
    showing();
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Module state is shared between the tests in this file; a leftover mark
    // would make the "does not refresh" tests pass or fail on ordering.
    consumeOutfitsDirty();
  });

  it('shows a loading state before the first page', async () => {
    showing({ activity: 'loading' });

    await render(<FavoritesScreen />);

    expect(screen.getByTestId('outfits-loading')).toBeTruthy();
    // A screen that says "no outfits yet" while it is still finding out is
    // making a claim it cannot support.
    expect(screen.queryByTestId('outfits-empty')).toBeNull();
  });

  it('keeps rows on screen for a load that has something behind it', async () => {
    // A CONTRACT test, not a behaviour test, and worth naming as such.
    // `UseOutfitsResult` permits `activity: 'loading'` with a populated list;
    // today's `useOutfits` cannot produce it, because its mount effect batches
    // `setOutfits([])` into the same commit as `run('loading', ...)` and is the
    // only caller of `run('loading')`. So this state is unreachable through the
    // real hook — which is precisely why the `outfits.length === 0` conjunct in
    // `showFirstPageSpinner` survived every mutation until this test existed.
    //
    // The conjunct is what stops a hook that ever cleared the list a commit
    // later — a `loading` that arrives before the rows go — from blanking a
    // populated gallery behind a spinner. The screen is written against the
    // contract, so it is tested against the contract.
    showing({ outfits: [outfit('o1')], activity: 'loading' });

    await render(<FavoritesScreen />);

    expect(screen.queryByTestId('outfits-loading')).toBeNull();
    expect(screen.getByTestId('outfit-card-o1')).toBeTruthy();
  });

  it('renders a card per outfit in two columns', async () => {
    showing({ outfits: [outfit('o1'), outfit('o2'), outfit('o3')] });

    await render(<FavoritesScreen />);

    expect(screen.getByTestId('outfit-card-o1')).toBeTruthy();
    expect(screen.getByTestId('outfit-card-o2')).toBeTruthy();
    expect(screen.getByTestId('outfit-card-o3')).toBeTruthy();
    // Two, not three: an outfit cell carries a cover, a name AND a count, and
    // a third of a phone's width is not enough for the caption. The number is
    // invisible to every RNTL query — only the prop can be read.
    expect(flatListProps(screen.getByTestId('outfits-gallery')).numColumns).toBe(2);
  });

  it('shows the empty state with a pointer to the Add tab', async () => {
    showing({ outfits: [] });

    await render(<FavoritesScreen />);

    const empty = screen.getByTestId('outfits-empty');
    expect(textContent(empty)).toContain('No outfits yet');
    // The gallery has no filter, so "empty" is unambiguous — and the fix is
    // one tab away. Naming it is the difference between a dead end and an
    // instruction.
    expect(textContent(empty)).toContain('Add tab');
  });

  it('keeps the empty state on screen during a refresh', async () => {
    showing({ outfits: [], activity: 'refreshing' });

    await render(<FavoritesScreen />);

    // The empty state IS this list's rows when it has none, and a refresh
    // deliberately keeps the rows on screen. Keyed on `activity === 'idle'`, a
    // new user who comes back to this tab watches "No outfits yet" and the
    // pointer to the Add tab disappear for the length of a round trip — losing
    // the only instruction the screen offers, at the only moment it matters.
    expect(screen.getByTestId('outfits-empty')).toBeTruthy();
    expect(screen.queryByTestId('outfits-loading')).toBeNull();
  });

  it('does not call an empty gallery empty when the load failed', async () => {
    showing({ outfits: [], error: 'Cannot reach the server. Check your connection.' });

    await render(<FavoritesScreen />);

    // Telling a user whose request just failed that they own no outfits is
    // both false and unrecoverable-looking.
    expect(screen.queryByTestId('outfits-empty')).toBeNull();
    expect(screen.getByTestId('outfits-error')).toBeTruthy();
  });

  it('shows an error state with a retry that refetches', async () => {
    showing({ error: 'Cannot reach the server. Check your connection.' });

    await render(<FavoritesScreen />);

    expect(screen.getByTestId('outfits-error-message')).toHaveTextContent(
      'Cannot reach the server. Check your connection.',
    );

    fireEvent.press(screen.getByTestId('outfits-retry'));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('navigates to the outfit detail route on card press', async () => {
    showing({ outfits: [outfit('o1'), outfit('o2')] });

    await render(<FavoritesScreen />);

    fireEvent.press(screen.getByTestId('outfit-card-o2'));

    // The literal path matters: `app/outfits/[id].tsx` is what makes this a
    // real route, and expo-router's typed-route generator rewrites
    // `.expo/types/router.d.ts` from the files on disk at every dev-server
    // start. A push with no file behind it breaks `pnpm typecheck` the moment
    // anyone runs `pnpm dev:mobile`.
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/outfits/o2');
  });

  it('loads the next page when the list end is reached', async () => {
    showing({ outfits: [outfit('o1'), outfit('o2')], hasMore: true });

    await render(<FavoritesScreen />);

    await act(async () => {
      fireEvent(screen.getByTestId('outfits-gallery'), 'endReached');
    });

    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('shows a footer spinner while a page is appending', async () => {
    showing({ outfits: [outfit('o1')], activity: 'loadingMore' });

    await render(<FavoritesScreen />);

    expect(screen.getByTestId('outfits-loading-more')).toBeTruthy();
    // The rows already loaded stay valid; blanking them for a page append
    // would throw away everything the user has scrolled past.
    expect(screen.getByTestId('outfit-card-o1')).toBeTruthy();
    expect(screen.queryByTestId('outfits-loading')).toBeNull();
  });

  it('keeps the cards on screen during a refresh', async () => {
    showing({ outfits: [outfit('o1')], activity: 'refreshing' });

    await render(<FavoritesScreen />);

    // `showFirstPageSpinner` keys on `activity === 'loading'` AND an empty
    // list. A refresh is neither, and swapping the rows for a spinner would
    // make a pull-to-refresh look like a reset.
    expect(screen.getByTestId('outfit-card-o1')).toBeTruthy();
    expect(screen.queryByTestId('outfits-loading')).toBeNull();
    expect(flatListProps(screen.getByTestId('outfits-gallery')).refreshing).toBe(true);
  });

  it('refetches on pull-to-refresh', async () => {
    showing({ outfits: [outfit('o1')] });

    await render(<FavoritesScreen />);

    await act(async () => {
      fireEvent(screen.getByTestId('outfits-gallery'), 'refresh');
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes the gallery on focus when an outfit has changed elsewhere', async () => {
    showing({ outfits: [outfit('o1')] });

    await render(<FavoritesScreen />);

    // Nothing in `app/` refetches on its own, and `useOutfits`'s effect keys
    // only on `[token]`, so an outfit created on the Add tab — or renamed on
    // the detail screen this gallery pushes — is invisible on return until a
    // manual pull-to-refresh. Expo Router keeps this screen mounted the whole
    // time, so a focus effect is the only place that can notice.
    expect(mockedUseFocusEffect).toHaveBeenCalled();
    const onFocus = mockedUseFocusEffect.mock.calls[0][0] as () => void;

    expect(refresh).not.toHaveBeenCalled();
    markOutfitsDirty();
    // `await act(async () => ...)`, never the synchronous form: React 19's
    // `act` returns a thenable that has to be awaited, and dropping it logs
    // "You called act(async () => ...) without await" AND leaves the act queue
    // in a state that breaks the tests after this one. Found the hard way.
    await act(async () => {
      onFocus();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh on focus when nothing has changed', async () => {
    showing({ outfits: [outfit('o1')] });

    await render(<FavoritesScreen />);
    const onFocus = mockedUseFocusEffect.mock.calls[0][0] as () => void;

    await act(async () => {
      onFocus();
    });

    // `refresh()` is a page-ONE load that replaces the list, so firing it on
    // every focus discards every page the user has scrolled to. Browse, open
    // one, come back, keep browsing is the gallery's primary loop, and an
    // ungated focus effect breaks it for everyone past the server's 24-per-page
    // default. The paging half of this is proven against the real hook in
    // `favorites.focus.test.tsx`; this half proves the gate is a gate.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('consumes the change signal, so one edit causes one refresh', async () => {
    showing({ outfits: [outfit('o1')] });

    await render(<FavoritesScreen />);
    const onFocus = mockedUseFocusEffect.mock.calls[0][0] as () => void;

    markOutfitsDirty();
    await act(async () => {
      onFocus();
    });
    await act(async () => {
      onFocus();
    });

    // Reading without clearing would make one rename refetch the gallery on
    // every focus for the rest of the session — the same always-refetch
    // regression, reached by a longer route.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('passes a stable focus callback, so the effect does not re-run every render', async () => {
    const view = await render(<FavoritesScreen />);

    const first = mockedUseFocusEffect.mock.calls[0][0];
    await act(async () => {
      view.rerender(<FavoritesScreen />);
    });
    const latest = mockedUseFocusEffect.mock.calls[mockedUseFocusEffect.mock.calls.length - 1][0];

    // `useFocusEffect` lists `effect` in its own `useEffect` deps, so a
    // callback rebuilt on every render re-runs the effect on every render —
    // and this one fetches. Each fetch sets state, which renders, which builds
    // another callback: a refetch loop that only a slow network makes visible.
    expect(latest).toBe(first);
  });

  it('keys the list by outfit id, not array index', async () => {
    showing({ outfits: [outfit('o1'), outfit('o2')] });

    await render(<FavoritesScreen />);

    // Two halves, and only together are they a test.
    //
    // This half reads the extractor the list was actually handed and checks
    // what it returns. It is NOT a paging test, and a paging test could not
    // stand in for it: `FlatList` keys each cell WITHIN a row by its column
    // index, so `keyExtractor` sets only the ROW key, and a pure append
    // reconciles identically with ids and with indices. Verified rather than
    // assumed — Stage 4 recorded that all 28 of its screen tests passed with
    // `keyExtractor={(_item, index) => String(index)}` in place.
    //
    // The other half is `favorites.keys.test.tsx`, which reaches the defect
    // through public queries only, by REPLACING the list.
    expect(flatListProps(screen.getByTestId('outfits-gallery')).keyExtractor).toBe(
      outfitKeyExtractor,
    );
    expect(outfitKeyExtractor(outfit('o7'))).toBe('o7');
  });
});
