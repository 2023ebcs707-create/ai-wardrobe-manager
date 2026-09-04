import React from 'react';
import { FlatList } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import type { PublicClothingItem, PublicUsageAnalytics, PublicWearEvent } from '@wardrobe/shared';
import ProfileScreen, { wearEventKeyExtractor } from '../app/profile';
import { useAuth } from '../src/auth/AuthContext';
import { useLaundryStatus } from '../src/tracking/useLaundryStatus';
import { useUsageAnalytics, type UseUsageAnalyticsResult } from '../src/tracking/useUsageAnalytics';
import { useWearHistory, type UseWearHistoryResult } from '../src/tracking/useWearHistory';
import { useWardrobe, type UseWardrobeResult } from '../src/wardrobe/useWardrobe';

// In `__tests__/` rather than beside the route for the same reason as
// `index.test.tsx` — expo-router's Android require-context is recursive and a
// `__tests__` directory is not special to it.

// Every hook is mocked at its MODULE boundary, never `src/api/client`: an
// automocked `ApiClientError` cannot be constructed, and each of these hooks
// already has its own suite under `__tests__/tracking/`. What is asserted here
// is what the SCREEN derives from their contracts.
jest.mock('../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../src/tracking/useWearHistory', () => ({ useWearHistory: jest.fn() }));
jest.mock('../src/tracking/useUsageAnalytics', () => ({ useUsageAnalytics: jest.fn() }));
jest.mock('../src/wardrobe/useWardrobe', () => ({ useWardrobe: jest.fn() }));
// Not used by this screen. Mocked so that "the screen never obtains a laundry
// mutator" is an assertion rather than a hope — see the test at the end.
jest.mock('../src/tracking/useLaundryStatus', () => ({ useLaundryStatus: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: jest.fn(), useFocusEffect: jest.fn() }));

const mockedUseAuth = useAuth as unknown as jest.Mock;
const mockedUseWearHistory = jest.mocked(useWearHistory);
const mockedUseUsageAnalytics = jest.mocked(useUsageAnalytics);
const mockedUseWardrobe = jest.mocked(useWardrobe);
const mockedUseLaundryStatus = jest.mocked(useLaundryStatus);
const mockedUseRouter = useRouter as unknown as jest.Mock;

type Element = ReturnType<typeof screen.getByTestId>;

/**
 * Minimal shape of a React fiber, declared locally so this file does not take a
 * dependency on react-reconciler's types for one assertion.
 */
type FiberLike = { type: unknown; memoizedProps: Record<string, unknown>; return: FiberLike | null };

/**
 * The props the `<FlatList>` above `host` was actually rendered with — the
 * helper from `__tests__/index.test.tsx:74`, lifted here for the same reason.
 *
 * A React key never reaches the rendered tree (`toJSON()` returns
 * `{ type, props, children }` and nothing else), so no public query can
 * observe which key the list used. `unstable_fiber` is the escape hatch
 * `TestInstance` documents for exactly this, and RNTL's own `fireEvent` walks
 * the same chain to find handlers.
 */
function flatListProps(host: Element): Record<string, unknown> {
  let fiber = host.unstable_fiber as unknown as FiberLike | null;
  while (fiber !== null) {
    if (fiber.type === FlatList) return fiber.memoizedProps;
    fiber = fiber.return;
  }
  throw new Error('No <FlatList> found above the wear history element');
}

function event(id: string, overrides: Partial<PublicWearEvent> = {}): PublicWearEvent {
  return {
    id,
    userId: 'user-1',
    outfitId: 'outfit-1',
    outfitName: 'Friday best',
    itemIds: ['item-a', 'item-b', 'item-c'],
    wornAt: '2026-08-20T18:00:00.000Z',
    createdAt: '2026-08-20T18:05:00.000Z',
    ...overrides,
  };
}

function item(id: string, overrides: Partial<PublicClothingItem> = {}): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/full/${id}.jpg`,
    thumbnailUrl: `https://example.test/thumb/${id}.jpg`,
    category: 'shirt',
    colors: [{ hex: '#ffffff', name: 'white', share: 1 }],
    seasons: ['summer'],
    laundryStatus: 'available',
    wearCount: 2,
    source: 'ai',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

const loadMore = jest.fn();
const refreshHistory = jest.fn();
const refreshAnalytics = jest.fn();
const refreshWardrobe = jest.fn();
const push = jest.fn();

function history(overrides: Partial<UseWearHistoryResult> = {}): UseWearHistoryResult {
  return {
    events: [],
    activity: 'idle',
    error: null,
    loadMore,
    refresh: refreshHistory,
    hasMore: false,
    ...overrides,
  };
}

function analytics(overrides: Partial<UseUsageAnalyticsResult> = {}): UseUsageAnalyticsResult {
  return {
    analytics: null,
    activity: 'idle',
    error: null,
    refresh: refreshAnalytics,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PublicUsageAnalytics> = {}): PublicUsageAnalytics {
  return {
    mostWorn: [item('a', { wearCount: 9 })],
    leastWorn: [item('c', { wearCount: 0 })],
    totalWears: 14,
    itemsInLaundry: 1,
    ...overrides,
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
    refresh: refreshWardrobe,
    hasMore: false,
    ...overrides,
  };
}

describe('ProfileScreen', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', name: 'Zaid', email: 'z@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
      token: 'tok-abc',
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseRouter.mockReturnValue({ push });
    mockedUseWearHistory.mockReturnValue(history());
    mockedUseUsageAnalytics.mockReturnValue(analytics());
    mockedUseWardrobe.mockReturnValue(wardrobe());
    // Given a WORKING return value even though the screen must never call it.
    // Left as a bare `jest.fn()` this returns `undefined`, so a screen that did
    // obtain a mutator would crash on the destructure and take the whole suite
    // down — which kills the mutation, but through a TypeError rather than
    // through the assertion that is supposed to state the rule. Measured: with
    // the toggle wired in and this line absent, 24 tests failed and
    // "DUPLICATES NO MUTATING CONTROL" never reached its `expect`.
    mockedUseLaundryStatus.mockReturnValue({ setStatus: jest.fn(), pending: false, error: null });
    // HealthBanner fetches on mount. Left unmocked it would reach the network,
    // which no test in this repo may do.
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ api: 'ok', database: 'ok', storage: 'ok', ai: 'ok' }), { status: 200 }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('still shows the signed-in user and a sign-out button', async () => {
    await render(<ProfileScreen />);

    expect(screen.getByText('Zaid')).toBeTruthy();
    // The EMAIL as well as the name. One of the four things this tab already
    // held and had to keep, and it was the only one of the four with no
    // assertion behind it: deleting the line compiled and left 635 tests
    // green.
    expect(screen.getByText('z@example.com')).toBeTruthy();
    expect(screen.getByTestId('profile-signout')).toBeTruthy();
  });

  it('hosts the service-health diagnostic that moved off the Home tab', async () => {
    // Stage 4 Task 4 took HealthBanner off the wardrobe screen — it is Stage 0
    // developer scaffolding, not a product feature. This asserts the other half
    // of that decision: it was relocated, not deleted, so the diagnostic stays
    // reachable when the API, MinIO or the AI service is down.
    await render(<ProfileScreen />);

    await waitFor(() => expect(screen.getByTestId('health-banner')).toBeTruthy());
  });

  describe('wear history (FR6 / TC-08)', () => {
    it('lists the wear events, newest first as the hook hands them over', async () => {
      mockedUseWearHistory.mockReturnValue(
        history({ events: [event('w1', { outfitName: 'Friday best' }), event('w2', { outfitName: 'Rain day' })] }),
      );

      await render(<ProfileScreen />);

      expect(screen.getByTestId('wear-event-name-w1')).toHaveTextContent('Friday best');
      expect(screen.getByTestId('wear-event-name-w2')).toHaveTextContent('Rain day');
    });

    it('shows the date TC-08 names, on the row', async () => {
      mockedUseWearHistory.mockReturnValue(history({ events: [event('w1')] }));

      await render(<ProfileScreen />);

      expect(screen.getByTestId('wear-event-meta-w1')).toHaveTextContent('20 Aug 2026 · 3 items');
    });

    it('KEEPS a wear whose outfit has since been deleted', async () => {
      // Ruling 3, end to end through the screen. The row must not vanish and
      // must not go blank — the wear happened, and deleting the outfit
      // afterwards does not un-happen it.
      mockedUseWearHistory.mockReturnValue(
        history({ events: [event('w1', { outfitName: undefined })] }),
      );

      await render(<ProfileScreen />);

      expect(screen.getByTestId('wear-event-w1')).toBeTruthy();
      expect(screen.getByTestId('wear-event-name-w1')).toHaveTextContent('Deleted or unnamed outfit');
    });

    it('shows a spinner before the first page arrives', async () => {
      mockedUseWearHistory.mockReturnValue(history({ activity: 'loading', events: [] }));

      await render(<ProfileScreen />);

      expect(screen.getByTestId('wear-history-loading')).toBeTruthy();
      expect(screen.queryByTestId('wear-history-empty')).toBeNull();
    });

    it('keeps the rest of the Profile tab on screen while the history loads', async () => {
      // The history is one section of a screen, not the screen. Replacing the
      // whole list with a spinner — the pattern the wardrobe grid and the
      // outfit gallery use, where the list IS the screen — would blank the
      // user's name, the sign-out button and the health diagnostic every time
      // a history request is in flight.
      mockedUseWearHistory.mockReturnValue(history({ activity: 'loading', events: [] }));

      await render(<ProfileScreen />);

      expect(screen.getByTestId('profile-signout')).toBeTruthy();
    });

    it('invites a first wear when the history is empty', async () => {
      await render(<ProfileScreen />);

      expect(screen.getByTestId('wear-history-empty')).toBeTruthy();
    });

    it('does not call an empty history empty when the request FAILED', async () => {
      // A failed load is not an empty history. Telling a user who has logged
      // forty wears that they have logged none is both false and
      // unrecoverable-looking.
      mockedUseWearHistory.mockReturnValue(history({ error: 'Cannot reach the server.' }));

      await render(<ProfileScreen />);

      expect(screen.queryByTestId('wear-history-empty')).toBeNull();
      expect(screen.getByTestId('wear-history-error-message')).toHaveTextContent('Cannot reach the server.');
    });

    it('keeps the empty state on screen during a refresh', async () => {
      // The empty state IS this list's rows when it has none, and the rows stay
      // on screen through a refresh — that is what makes a pull-to-refresh not
      // a reset. Keyed on `activity === 'idle'` the only instruction the
      // section offers would vanish for a round trip.
      mockedUseWearHistory.mockReturnValue(history({ activity: 'refreshing', events: [] }));

      await render(<ProfileScreen />);

      expect(screen.getByTestId('wear-history-empty')).toBeTruthy();
    });

    it('retries the history load from its own banner', async () => {
      mockedUseWearHistory.mockReturnValue(history({ error: 'Cannot reach the server.' }));

      await render(<ProfileScreen />);
      await fireEvent.press(screen.getByTestId('wear-history-retry'));

      expect(refreshHistory).toHaveBeenCalledTimes(1);
      // The history's own retry, not a whole-screen reload: the analytics
      // snapshot and the wardrobe page are separate requests that did not fail.
      expect(refreshAnalytics).not.toHaveBeenCalled();
      expect(refreshWardrobe).not.toHaveBeenCalled();
    });

    it('pages when the list reaches its end', async () => {
      mockedUseWearHistory.mockReturnValue(history({ events: [event('w1')], hasMore: true }));

      await render(<ProfileScreen />);
      await fireEvent(screen.getByTestId('wear-history'), 'endReached');

      expect(loadMore).toHaveBeenCalled();
    });

    it('shows a footer spinner while a page is appending', async () => {
      mockedUseWearHistory.mockReturnValue(history({ events: [event('w1')], activity: 'loadingMore' }));

      await render(<ProfileScreen />);

      expect(screen.getByTestId('wear-history-loading-more')).toBeTruthy();
    });

    it('shows NO footer spinner for any other activity', async () => {
      // The negative half, which `__tests__/index.test.tsx` pins for the
      // wardrobe grid's equivalent and this suite did not. With the footer
      // keyed on `activity !== 'idle'` a pull-to-refresh puts a spinner
      // underneath the empty state, and a first load puts one underneath the
      // first-load spinner — two progress indicators for one request, in the
      // one arrangement where they are visible at the same time because the
      // footer is not virtualised away.
      mockedUseWearHistory.mockReturnValue(history({ events: [event('w1')], activity: 'refreshing' }));

      await render(<ProfileScreen />);

      expect(screen.queryByTestId('wear-history-loading-more')).toBeNull();
    });

    it('refreshes all three sections on pull-to-refresh', async () => {
      // One gesture, three independent requests. Refreshing only the history
      // would leave the leaderboard and the laundry list showing figures from
      // before the pull, on the same screen as freshly loaded rows.
      await render(<ProfileScreen />);
      await fireEvent(screen.getByTestId('wear-history'), 'refresh');

      expect(refreshHistory).toHaveBeenCalledTimes(1);
      expect(refreshAnalytics).toHaveBeenCalledTimes(1);
      expect(refreshWardrobe).toHaveBeenCalledTimes(1);
    });

    it('keeps the pull-to-refresh spinner up until every section has landed', async () => {
      // The history is usually the quickest of the three. With the spinner
      // keyed on the history alone it would snap away while the leaderboard
      // below was still being replaced.
      mockedUseWearHistory.mockReturnValue(history({ activity: 'idle' }));
      mockedUseUsageAnalytics.mockReturnValue(analytics({ activity: 'refreshing' }));

      await render(<ProfileScreen />);

      expect(flatListProps(screen.getByTestId('wear-history')).refreshing).toBe(true);
    });
  });

  describe('cell identity', () => {
    it('keys a row by the event id, never by its position', async () => {
      mockedUseWearHistory.mockReturnValue(history({ events: [event('w1'), event('w2')] }));

      await render(<ProfileScreen />);

      const keyExtractor = flatListProps(screen.getByTestId('wear-history')).keyExtractor as (
        e: PublicWearEvent,
        index: number,
      ) => string;
      // The index argument is deliberately wrong for the item: an extractor
      // that reads it answers "7".
      expect(keyExtractor(event('w2'), 7)).toBe('w2');
    });

    it('exports the extractor so the contract is assertable directly', async () => {
      expect(wearEventKeyExtractor(event('w5'))).toBe('w5');
    });
  });

  describe('usage analytics', () => {
    it('renders the leaderboard the hook hands over', async () => {
      mockedUseUsageAnalytics.mockReturnValue(analytics({ analytics: snapshot() }));

      await render(<ProfileScreen />);

      expect(screen.getByTestId('usage-most-a')).toBeTruthy();
      expect(screen.getByTestId('usage-least-c')).toBeTruthy();
      expect(screen.getByTestId('usage-total-wears')).toHaveTextContent('14 wears logged');
    });

    it('handles the null snapshot rather than assuming a zeroed one', async () => {
      // `useUsageAnalytics` hands over `null` until the first load lands, and
      // that is not an oversight to paper over with `?? { totalWears: 0, … }`:
      // the API answers `totalWears: 0` for a genuinely empty wardrobe, so a
      // zeroed default is indistinguishable from a real answer.
      mockedUseUsageAnalytics.mockReturnValue(analytics({ analytics: null, activity: 'loading' }));

      await render(<ProfileScreen />);

      expect(screen.getByTestId('usage-loading')).toBeTruthy();
      expect(screen.queryByTestId('usage-summary')).toBeNull();
    });

    it('retries the snapshot from its own banner', async () => {
      mockedUseUsageAnalytics.mockReturnValue(analytics({ error: 'Cannot reach the server.' }));

      await render(<ProfileScreen />);
      await fireEvent.press(screen.getByTestId('usage-retry'));

      expect(refreshAnalytics).toHaveBeenCalledTimes(1);
      expect(refreshHistory).not.toHaveBeenCalled();
    });
  });

  describe('laundry list (FR7)', () => {
    it('lists the garments in the wash', async () => {
      mockedUseWardrobe.mockReturnValue(
        wardrobe({ items: [item('a', { laundryStatus: 'in_laundry' }), item('b')] }),
      );

      await render(<ProfileScreen />);

      expect(screen.getByTestId('laundry-item-a')).toBeTruthy();
      expect(screen.queryByTestId('laundry-item-b')).toBeNull();
    });

    it('opens the item detail screen, where the toggle lives', async () => {
      mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a', { laundryStatus: 'in_laundry' })] }));

      await render(<ProfileScreen />);
      await fireEvent.press(screen.getByTestId('laundry-item-a'));

      expect(push).toHaveBeenCalledWith('/items/a');
    });

    it('DUPLICATES NO MUTATING CONTROL — it never even obtains one', async () => {
      // One mutating control per state. The strongest form this can be
      // asserted in from here: the screen never mounts the hook that performs
      // the transition, so there is nothing on Profile that could write a
      // laundry status at all.
      //
      // What it does not catch: a toggle built without `useLaundryStatus` —
      // calling `setLaundryStatus` from `src/tracking/api` directly, say. The
      // rows' accessibility contract in `LaundryList.test.tsx` is the other
      // half.
      mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a', { laundryStatus: 'in_laundry' })] }));

      await render(<ProfileScreen />);

      expect(mockedUseLaundryStatus).not.toHaveBeenCalled();
    });

    it('reconciles its page-one view with the wardrobe-wide count', async () => {
      // Profile reads page ONE of the wardrobe while `itemsInLaundry` counts
      // the whole of it, so the two can disagree — and they would disagree
      // visibly, in one screenshot, on the same screen.
      mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('a', { laundryStatus: 'in_laundry' })] }));
      mockedUseUsageAnalytics.mockReturnValue(
        analytics({ analytics: snapshot({ itemsInLaundry: 4 }) }),
      );

      await render(<ProfileScreen />);

      expect(screen.getByTestId('laundry-note')).toHaveTextContent(
        'Showing 1 of 4 — find the rest on the Wardrobe tab.',
      );
    });

    it('does not claim an empty wash before the wardrobe has loaded', async () => {
      // The screen half of the rule: `activity` has to REACH the section. The
      // screen destructures `wardrobeActivity` for the pull-to-refresh
      // spinner, and a version of this screen passed it nowhere else — so on
      // every first mount the laundry section reported confidently on a
      // wardrobe no request had answered for yet.
      mockedUseWardrobe.mockReturnValue(wardrobe({ items: [], activity: 'loading' }));

      await render(<ProfileScreen />);

      expect(screen.getByTestId('laundry-loading')).toBeTruthy();
      expect(screen.queryByTestId('laundry-empty')).toBeNull();
    });

    it('hedges the laundry list when it cannot see the whole wardrobe', async () => {
      // `hasMore` has to reach the section too. Analytics has failed here, so
      // `total` never arrives; page one holds no dirty garments; the wardrobe
      // load itself succeeded, so there is no banner. Without `hasMore` the
      // section says "Nothing in the wash." about 24 of the user's items.
      mockedUseWardrobe.mockReturnValue(wardrobe({ items: [item('b')], hasMore: true }));
      mockedUseUsageAnalytics.mockReturnValue(
        analytics({ analytics: null, error: 'Cannot reach the server.' }),
      );

      await render(<ProfileScreen />);

      expect(screen.queryByTestId('laundry-empty')).toBeNull();
      expect(screen.getByTestId('laundry-partial')).toBeTruthy();
    });

    it('retries the wardrobe load from its own banner', async () => {
      mockedUseWardrobe.mockReturnValue(wardrobe({ error: 'Cannot reach the server.' }));

      await render(<ProfileScreen />);
      await fireEvent.press(screen.getByTestId('laundry-retry'));

      expect(refreshWardrobe).toHaveBeenCalledTimes(1);
      expect(refreshHistory).not.toHaveBeenCalled();
    });
  });
});
