import React from 'react';
import { act, render } from '@testing-library/react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import HomeScreen from '../app/(tabs)/index';
import { useWardrobe, type UseWardrobeResult } from '../src/wardrobe/useWardrobe';
import { TRACKING_READERS, consumeTrackingDirty, markTrackingDirty } from '../src/tracking/trackingDirty';

// In `__tests__/` rather than beside the route — see the note in
// `__tests__/index.test.tsx`. Expo Router's Android require-context is
// recursive and a `__tests__` directory is not special to it.

/**
 * TC-09's last mile: "item visually distinguished **in wardrobe**".
 *
 * The toggle lives on the item detail screen, which Expo Router pushes OVER
 * this tab while it stays mounted. `useWardrobe`'s fetch effect keys on
 * `[token, category]`, so nothing about coming back re-reads the list — the
 * garment the user just put in the wash keeps rendering as available until
 * they happen to pull to refresh, or restart the app. The badge would exist,
 * be correct, pass every unit test, and never appear on the screen TC-09
 * names.
 *
 * The gate is the design, exactly as it is on the outfit gallery. `refresh()`
 * is a page-ONE load that replaces the list, so an ungated focus effect throws
 * away every page the user has scrolled to — the regression Stage 5 Task 5
 * shipped and then removed.
 *
 * `useWardrobe` is mocked here because what is being asserted is the SCREEN's
 * gate: whether `refresh` is called, and how often. It has its own 19-test
 * suite for what it does when called.
 */
jest.mock('../src/wardrobe/useWardrobe', () => ({ useWardrobe: jest.fn() }));

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
 * `useFocusEffect` reduced to its ordering-relevant core, lifted from
 * `__tests__/outfits/favorites.focus.test.tsx`: expo-router runs the callback
 * from a `React.useEffect` declared in the calling component, and calls it
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

const mockedUseWardrobe = jest.mocked(useWardrobe);
const mockedUseRouter = useRouter as unknown as jest.Mock;
const mockedUseFocusEffect = useFocusEffect as unknown as jest.Mock;

const refresh = jest.fn();

function wardrobe(overrides: Partial<UseWardrobeResult> = {}): UseWardrobeResult {
  return {
    items: [],
    category: null,
    setCategory: jest.fn(),
    activity: 'idle',
    error: null,
    loadMore: jest.fn(),
    refresh,
    hasMore: false,
    ...overrides,
  };
}

/** The focus callback the screen registered, as a callable. */
function focus(): () => void {
  return mockedUseFocusEffect.mock.calls[0][0] as () => void;
}

describe('wardrobe grid focus refetch (Stage 6 Task 4 — FR7 / TC-09)', () => {
  beforeEach(() => {
    mockedUseRouter.mockReturnValue({ push: jest.fn() });
    mockedUseWardrobe.mockReturnValue(wardrobe());
  });

  afterEach(() => {
    jest.clearAllMocks();
    TRACKING_READERS.forEach((reader) => consumeTrackingDirty(reader));
  });

  it('does not refetch when the tab regains focus with nothing changed', async () => {
    // THE regression the gate exists for. Ungated, every return to this tab
    // fires a page-one load that REPLACES the list, so browse → open an item →
    // come back → keep browsing loses every page past the first for anyone
    // with more than the server's 24-per-page default.
    await render(<HomeScreen />);
    refresh.mockClear();

    await act(async () => {
      focus()();
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it('refetches when the tab regains focus after a laundry toggle', async () => {
    await render(<HomeScreen />);
    refresh.mockClear();

    markTrackingDirty();
    await act(async () => {
      focus()();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('acts on a change exactly once', async () => {
    // `consumeTrackingDirty` reads AND clears, so one toggle causes one reload
    // rather than one per focus for the rest of the session.
    await render(<HomeScreen />);
    refresh.mockClear();

    markTrackingDirty();
    await act(async () => {
      focus()();
    });
    await act(async () => {
      focus()();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('leaves the Profile tab its own copy of the signal', async () => {
    // Per reader, which is the whole reason `trackingDirty` is not
    // `outfitsDirty`. With one shared bit this grid would consume the change
    // and Profile's analytics would never learn that `itemsInLaundry` moved.
    await render(<HomeScreen />);

    markTrackingDirty();
    await act(async () => {
      focus()();
    });

    expect(consumeTrackingDirty('profile')).toBe(true);
  });
});
