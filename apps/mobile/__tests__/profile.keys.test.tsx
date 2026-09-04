import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import type { PublicWearEvent } from '@wardrobe/shared';
import ProfileScreen from '../app/profile';
import { useAuth } from '../src/auth/AuthContext';
import { useUsageAnalytics } from '../src/tracking/useUsageAnalytics';
import { useWearHistory, type UseWearHistoryResult } from '../src/tracking/useWearHistory';
import { useWardrobe } from '../src/wardrobe/useWardrobe';

// In `__tests__/` rather than beside the route — see the note in
// `__tests__/profile.test.tsx`. This file mirrors
// `__tests__/outfits/favorites.keys.test.tsx` and `__tests__/index.keys.test.tsx`,
// which pin the same property on the outfit gallery and the wardrobe grid.

jest.mock('../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../src/tracking/useWearHistory', () => ({ useWearHistory: jest.fn() }));
jest.mock('../src/tracking/useUsageAnalytics', () => ({ useUsageAnalytics: jest.fn() }));
jest.mock('../src/wardrobe/useWardrobe', () => ({ useWardrobe: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: jest.fn(), useFocusEffect: jest.fn() }));

/**
 * The row is replaced by a probe that records, in a ref, the id it was
 * **first** rendered with, and renders that recorded id as text under a testID
 * keyed by its **current** id. A cell React remounts starts a fresh ref, so
 * `probe-w9` reads "w9". A cell React reuses keeps the old one, so `probe-w9`
 * reads "w1" — the wrong-row-in-the-wrong-cell defect, made textual.
 *
 * The probe replaces the row rather than wrapping it so that this file states
 * one thing only; `src/tracking/WearHistoryRow.test.tsx` exercises the real row.
 */
jest.mock('../src/tracking/WearHistoryRow', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    WearHistoryRow: ({ event }: { event: PublicWearEvent }) => {
      const firstRenderedWith = ReactActual.useRef(event.id);
      return ReactActual.createElement(Text, { testID: `probe-${event.id}` }, firstRenderedWith.current);
    },
  };
});

const mockedUseAuth = useAuth as unknown as jest.Mock;
const mockedUseWearHistory = jest.mocked(useWearHistory);
const mockedUseUsageAnalytics = jest.mocked(useUsageAnalytics);
const mockedUseWardrobe = jest.mocked(useWardrobe);
const mockedUseRouter = useRouter as unknown as jest.Mock;

function event(id: string): PublicWearEvent {
  return {
    id,
    userId: 'user-1',
    outfitId: `outfit-${id}`,
    outfitName: `Outfit ${id}`,
    itemIds: ['item-a', 'item-b'],
    wornAt: '2026-08-20T18:00:00.000Z',
    createdAt: '2026-08-20T18:05:00.000Z',
  };
}

function history(overrides: Partial<UseWearHistoryResult> = {}): UseWearHistoryResult {
  return {
    events: [],
    activity: 'idle',
    error: null,
    loadMore: jest.fn(),
    refresh: jest.fn(),
    hasMore: false,
    ...overrides,
  };
}

describe('wear history cell identity', () => {
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
    mockedUseUsageAnalytics.mockReturnValue({
      analytics: null,
      activity: 'idle',
      error: null,
      refresh: jest.fn(),
    });
    mockedUseWardrobe.mockReturnValue({
      items: [],
      category: null,
      setCategory: jest.fn(),
      activity: 'idle',
      error: null,
      loadMore: jest.fn(),
      refresh: jest.fn(),
      hasMore: false,
    });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ api: 'ok', database: 'ok', storage: 'ok', ai: 'ok' }), { status: 200 }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('remounts a row when a newly logged wear shifts the list under it', async () => {
    // The real sequence, and the one this screen produces on its own: log a
    // wear on the outfit screen, come back to Profile, and the focus gate
    // refreshes page one. The new event sorts to the TOP by `wornAt`, so every
    // row that was on screen moves down one position while the list stays
    // mounted — `refresh()` sets `activity` to `'refreshing'` and deliberately
    // keeps the rows there.
    //
    // This is the case a paging test cannot reach. `FlatList` keys each cell
    // *within* a row by its column index (`<React.Fragment key={kk}>` in
    // FlatList.js), so `keyExtractor` only sets the row key, and a pure append
    // leaves every existing row's mapping untouched: id keys and index keys
    // reconcile identically there.
    const before = [event('w1'), event('w2')];
    mockedUseWearHistory.mockReturnValue(history({ events: before }));
    const view = await render(<ProfileScreen />);
    expect(screen.getByTestId('probe-w1')).toHaveTextContent('w1');

    mockedUseWearHistory.mockReturnValue(history({ events: before, activity: 'refreshing' }));
    await act(async () => {
      view.rerender(<ProfileScreen />);
    });

    const after = [event('w9'), event('w1'), event('w2')];
    mockedUseWearHistory.mockReturnValue(history({ events: after, activity: 'idle' }));
    await act(async () => {
      view.rerender(<ProfileScreen />);
    });

    // Each cell must be showing the wear it is labelled with, not the one that
    // occupied that position a moment ago.
    expect(screen.getByTestId('probe-w9')).toHaveTextContent('w9');
    expect(screen.getByTestId('probe-w1')).toHaveTextContent('w1');
    expect(screen.getByTestId('probe-w2')).toHaveTextContent('w2');
  });

  it('remounts a row when a refresh replaces the page wholesale', async () => {
    // The other route to a reused cell: a token change, or a history whose
    // first page differs from what is held. No append is involved at all.
    mockedUseWearHistory.mockReturnValue(history({ events: [event('w1'), event('w2')] }));
    const view = await render(<ProfileScreen />);
    expect(screen.getByTestId('probe-w2')).toHaveTextContent('w2');

    mockedUseWearHistory.mockReturnValue(history({ events: [event('x'), event('y')] }));
    await act(async () => {
      view.rerender(<ProfileScreen />);
    });

    expect(screen.getByTestId('probe-x')).toHaveTextContent('x');
    expect(screen.getByTestId('probe-y')).toHaveTextContent('y');
  });
});
