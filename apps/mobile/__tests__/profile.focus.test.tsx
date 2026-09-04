import React from 'react';
import { act, render } from '@testing-library/react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import ProfileScreen from '../app/profile';
import { useAuth } from '../src/auth/AuthContext';
import { useUsageAnalytics } from '../src/tracking/useUsageAnalytics';
import { useWearHistory } from '../src/tracking/useWearHistory';
import { useWardrobe } from '../src/wardrobe/useWardrobe';
import {
  TRACKING_READERS,
  consumeTrackingDirty,
  markTrackingDirty,
} from '../src/tracking/trackingDirty';

// In `__tests__/` rather than beside the route — see the note in
// `__tests__/profile.test.tsx`.

/**
 * `'profile'` has been a declared `TrackingReader` since Task 4 with nothing
 * consuming it. This is the consumer.
 *
 * Profile cannot see its own staleness. All three of its hooks key their fetch
 * effects on `[token]` alone, and Expo Router keeps this tab mounted while the
 * item and outfit detail screens are pushed over it — so a laundry toggle, a
 * logged wear and a deleted outfit are all invisible on return until the user
 * happens to pull to refresh. A wear the user just logged not appearing in the
 * wear-history list is TC-08's claim failing on the screen that makes it.
 *
 * The gate is the design, exactly as it is on the wardrobe grid and the outfit
 * gallery: `refresh()` is a page-ONE load, so an ungated focus effect throws
 * away every page of history the user has scrolled to.
 */
jest.mock('../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../src/tracking/useWearHistory', () => ({ useWearHistory: jest.fn() }));
jest.mock('../src/tracking/useUsageAnalytics', () => ({ useUsageAnalytics: jest.fn() }));
jest.mock('../src/wardrobe/useWardrobe', () => ({ useWardrobe: jest.fn() }));

/**
 * `useFocusEffect` reduced to its ordering-relevant core, lifted from
 * `__tests__/wardrobe.focus.test.tsx`: expo-router runs the callback from a
 * `React.useEffect` declared in the calling component, and calls it
 * immediately when the screen is already focused. The captured callback is
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

const mockedUseAuth = useAuth as unknown as jest.Mock;
const mockedUseWearHistory = jest.mocked(useWearHistory);
const mockedUseUsageAnalytics = jest.mocked(useUsageAnalytics);
const mockedUseWardrobe = jest.mocked(useWardrobe);
const mockedUseRouter = useRouter as unknown as jest.Mock;
const mockedUseFocusEffect = useFocusEffect as unknown as jest.Mock;

const refreshHistory = jest.fn();
const refreshAnalytics = jest.fn();
const refreshWardrobe = jest.fn();

/** The focus callback the screen registered, as a callable. */
function focus(): () => void {
  return mockedUseFocusEffect.mock.calls[0][0] as () => void;
}

describe('Profile tab focus refetch (Stage 6 Task 5 — FR6 / FR7)', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', name: 'Zaid', email: 'z@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
      token: 'tok-abc',
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseRouter.mockReturnValue({ push: jest.fn() });
    mockedUseWearHistory.mockReturnValue({
      events: [],
      activity: 'idle',
      error: null,
      loadMore: jest.fn(),
      refresh: refreshHistory,
      hasMore: false,
    });
    mockedUseUsageAnalytics.mockReturnValue({
      analytics: null,
      activity: 'idle',
      error: null,
      refresh: refreshAnalytics,
    });
    mockedUseWardrobe.mockReturnValue({
      items: [],
      category: null,
      setCategory: jest.fn(),
      activity: 'idle',
      error: null,
      loadMore: jest.fn(),
      refresh: refreshWardrobe,
      hasMore: false,
    });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ api: 'ok', database: 'ok', storage: 'ok', ai: 'ok' }), { status: 200 }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    TRACKING_READERS.forEach((reader) => consumeTrackingDirty(reader));
  });

  it('does not refetch when the tab regains focus with nothing changed', async () => {
    // THE regression the gate exists for. Ungated, every return to this tab
    // fires three page-one loads, and the history one REPLACES the list — so
    // scrolling back through months of wears and then glancing at another tab
    // loses everything past page one.
    await render(<ProfileScreen />);
    refreshHistory.mockClear();
    refreshAnalytics.mockClear();
    refreshWardrobe.mockClear();

    await act(async () => {
      focus()();
    });

    expect(refreshHistory).not.toHaveBeenCalled();
    expect(refreshAnalytics).not.toHaveBeenCalled();
    expect(refreshWardrobe).not.toHaveBeenCalled();
  });

  it('refetches all three sections after a tracked write', async () => {
    // One write moves all three: logging a wear adds a history row, bumps
    // `wearCount` (which the leaderboard ranks on) and moves `totalWears`; a
    // laundry toggle moves `itemsInLaundry` and the laundry list itself.
    await render(<ProfileScreen />);
    refreshHistory.mockClear();
    refreshAnalytics.mockClear();
    refreshWardrobe.mockClear();

    markTrackingDirty();
    await act(async () => {
      focus()();
    });

    expect(refreshHistory).toHaveBeenCalledTimes(1);
    expect(refreshAnalytics).toHaveBeenCalledTimes(1);
    expect(refreshWardrobe).toHaveBeenCalledTimes(1);
  });

  it('acts on a change exactly once', async () => {
    // `consumeTrackingDirty` reads AND clears, so one write causes one reload
    // rather than one per focus for the rest of the session.
    await render(<ProfileScreen />);
    refreshHistory.mockClear();

    markTrackingDirty();
    await act(async () => {
      focus()();
    });
    await act(async () => {
      focus()();
    });

    expect(refreshHistory).toHaveBeenCalledTimes(1);
  });

  it('leaves the wardrobe grid its own copy of the signal', async () => {
    // Per reader, which is the whole reason `trackingDirty` is not
    // `outfitsDirty`. With one shared bit, whichever tab the user opened first
    // would consume the change and the other would never learn about it.
    await render(<ProfileScreen />);

    markTrackingDirty();
    await act(async () => {
      focus()();
    });

    expect(consumeTrackingDirty('wardrobe')).toBe(true);
  });

  it('acts on a change addressed to Profile alone', async () => {
    // Deleting an outfit changes what a PAST wear event reads back as — the
    // API resolves `outfitName` at read time, so the row becomes nameless —
    // while the wardrobe grid is entirely unaffected. Marking both readers for
    // it would make the grid throw away its scrolled pages for nothing.
    await render(<ProfileScreen />);
    refreshHistory.mockClear();

    markTrackingDirty(['profile']);
    await act(async () => {
      focus()();
    });

    expect(refreshHistory).toHaveBeenCalledTimes(1);
    expect(consumeTrackingDirty('wardrobe')).toBe(false);
  });
});
