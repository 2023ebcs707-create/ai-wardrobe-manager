import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { PublicOutfit, PublicOutfitPlan } from '@wardrobe/shared';
// The real `ApiClientError` — automocking a class that extends Error yields
// something that cannot be constructed, which is why `src/api/client` is never
// `jest.mock`ed anywhere in this repo.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { createOutfitPlan } from '../../src/calendar/api';
import { consumePlansDirty, PLAN_READERS } from '../../src/calendar/plansDirty';
import { useOutfits } from '../../src/outfits/useOutfits';
import { useItemIndex } from '../../src/wardrobe/useItemIndex';
import PlanOutfitScreen from '../../app/calendar/plan/[date]';

// This file lives in `__tests__/` and NOT under `app/`: Expo Router's Android
// require-context is recursive and would bundle a colocated test as a route.
// See README.md:161.

jest.mock('../../src/calendar/api', () => {
  // `plannedForOn` is real — it is pure date arithmetic with its own
  // correctness argument (local noon, so the chosen day survives DST), and
  // stubbing it would make "sends the right instant" unfalsifiable.
  const actual = jest.requireActual('../../src/calendar/api');
  return {
    ...actual,
    createOutfitPlan: jest.fn(),
    fetchOutfitPlans: jest.fn(),
    deleteOutfitPlan: jest.fn(),
  };
});

jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../../src/outfits/useOutfits', () => ({ useOutfits: jest.fn() }));
jest.mock('../../src/wardrobe/useItemIndex', () => ({ useItemIndex: jest.fn() }));
jest.mock('expo-router', () => ({
  useLocalSearchParams: jest.fn(),
  useRouter: jest.fn(),
}));

const mockedCreateOutfitPlan = jest.mocked(createOutfitPlan);
const mockedUseOutfits = jest.mocked(useOutfits);
const mockedUseItemIndex = jest.mocked(useItemIndex);
const mockedUseAuth = jest.mocked(useAuth);
const mockedUseLocalSearchParams = useLocalSearchParams as unknown as jest.Mock;
const mockedUseRouter = useRouter as unknown as jest.Mock;

const TOKEN = 'tok-abc';
const back = jest.fn();

/** A day key well clear of today in either direction, built from the clock so
 *  the suite cannot rot into "that date is in the past now". */
function dayKeyOffsetBy(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function outfit(overrides: Partial<PublicOutfit> = {}): PublicOutfit {
  return {
    id: 'outfit-1',
    userId: 'user-1',
    name: 'Friday',
    itemIds: ['item-1'],
    itemCount: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function plan(): PublicOutfitPlan {
  return {
    id: 'plan-1',
    userId: 'user-1',
    outfitId: 'outfit-1',
    itemIds: ['item-1'],
    plannedFor: '2026-09-20T19:00:00.000Z',
    createdAt: '2026-09-05T10:00:00.000Z',
  };
}

function outfitsValue(overrides: Partial<ReturnType<typeof useOutfits>> = {}) {
  return {
    outfits: [outfit()],
    activity: 'idle' as const,
    error: null,
    loadMore: jest.fn(),
    refresh: jest.fn(),
    remove: jest.fn(),
    hasMore: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({
    status: 'authenticated',
    user: null,
    token: TOKEN,
    signIn: jest.fn(),
    signUp: jest.fn(),
    signOut: jest.fn(),
  });
  mockedUseRouter.mockReturnValue({ back, push: jest.fn(), replace: jest.fn() });
  mockedUseOutfits.mockReturnValue(outfitsValue());
  mockedUseItemIndex.mockReturnValue({ byId: {}, ready: true });
  mockedUseLocalSearchParams.mockReturnValue({ date: dayKeyOffsetBy(5) });
});

afterEach(() => {
  PLAN_READERS.forEach((reader) => consumePlansDirty(reader));
});

describe('PlanOutfitScreen', () => {
  it('lists the outfits to plan from', async () => {
    await render(<PlanOutfitScreen />);

    expect(screen.getByTestId('plan-outfit-outfit-1')).toBeTruthy();
    expect(screen.getByTestId('plan-outfit-plan-outfit-1')).toBeTruthy();
  });

  it('plans the tapped outfit for the day in the route', async () => {
    mockedCreateOutfitPlan.mockResolvedValueOnce(plan());
    const date = dayKeyOffsetBy(5);
    mockedUseLocalSearchParams.mockReturnValue({ date });

    await render(<PlanOutfitScreen />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('plan-outfit-plan-outfit-1'));
    });

    expect(mockedCreateOutfitPlan).toHaveBeenCalledTimes(1);
    const sent = mockedCreateOutfitPlan.mock.calls[0][0];
    expect(sent.outfitId).toBe('outfit-1');
    expect(sent.token).toBe(TOKEN);
    // LOCAL NOON on the chosen day, never midnight and never the device clock:
    // the API refuses an instant in the past, and local midnight for today is
    // already hours gone. Read back through the local getters, which is the
    // only way to assert "noon on that day" without restating the zone.
    const at = new Date(sent.plannedFor);
    expect(at.getHours()).toBe(12);
    expect(
      `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`,
    ).toBe(date);
  });

  it('sends a chosen occasion, and omits it when none is chosen', async () => {
    mockedCreateOutfitPlan.mockResolvedValue(plan());

    await render(<PlanOutfitScreen />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('plan-outfit-plan-outfit-1'));
    });
    expect(mockedCreateOutfitPlan.mock.calls[0][0].occasion).toBeUndefined();

    // Pick one, then plan again.
    const chip = screen.getAllByTestId(/^plan-outfit-occasion-/)[0];
    await act(async () => {
      fireEvent.press(chip);
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('plan-outfit-plan-outfit-1'));
    });
    expect(mockedCreateOutfitPlan.mock.calls[1][0].occasion).toEqual(expect.any(String));
  });

  it('goes back and marks the calendar dirty after a successful plan', async () => {
    mockedCreateOutfitPlan.mockResolvedValueOnce(plan());

    await render(<PlanOutfitScreen />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('plan-outfit-plan-outfit-1'));
    });

    expect(back).toHaveBeenCalled();
    // The month behind this screen is holding a range that just gained a plan
    // and cannot see its own staleness.
    expect(consumePlansDirty('calendar')).toBe(true);
  });

  it('ignores a second press that lands before the first resolves', async () => {
    // `POST /outfit-plans` is not idempotent: a second request writes a second
    // plan for the same day that the user then has to cancel by hand.
    let resolve!: (value: PublicOutfitPlan) => void;
    const pending = new Promise<PublicOutfitPlan>((res) => {
      resolve = res;
    });
    pending.catch(() => {});
    mockedCreateOutfitPlan.mockReturnValueOnce(pending);

    await render(<PlanOutfitScreen />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('plan-outfit-plan-outfit-1'));
      fireEvent.press(screen.getByTestId('plan-outfit-plan-outfit-1'));
    });

    expect(mockedCreateOutfitPlan).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(plan());
    });
  });

  it('stays put and shows the message when planning fails', async () => {
    mockedCreateOutfitPlan.mockRejectedValueOnce(
      new ApiClientError('VALIDATION_FAILED', 'Unknown outfit', 400),
    );

    await render(<PlanOutfitScreen />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('plan-outfit-plan-outfit-1'));
    });

    expect(back).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('plan-outfit-error')).toHaveTextContent('Unknown outfit'),
    );
    // Nothing was marked, because nothing was written.
    expect(consumePlansDirty('calendar')).toBe(false);
  });

  it('refuses a day that has already passed', async () => {
    // The mirror of the log screen's future guard: `POST /outfit-plans`
    // rejects a `plannedFor` in the past, so offering the action would be
    // offering a 400.
    mockedUseLocalSearchParams.mockReturnValue({ date: dayKeyOffsetBy(-3) });

    await render(<PlanOutfitScreen />);

    expect(screen.getByTestId('plan-outfit-past')).toBeTruthy();
    expect(screen.queryByTestId('plan-outfit-plan-outfit-1')).toBeNull();
  });

  it('allows TODAY — planning what you are about to put on is ordinary', async () => {
    mockedUseLocalSearchParams.mockReturnValue({ date: dayKeyOffsetBy(0) });

    await render(<PlanOutfitScreen />);

    expect(screen.queryByTestId('plan-outfit-past')).toBeNull();
    expect(screen.getByTestId('plan-outfit-plan-outfit-1')).toBeTruthy();
  });

  it('shows a bad-date state for a route param that is not a date', async () => {
    mockedUseLocalSearchParams.mockReturnValue({ date: 'not-a-date' });

    await render(<PlanOutfitScreen />);

    expect(screen.getByTestId('plan-outfit-bad-date')).toBeTruthy();
  });

  it('invites the user to build one when there are no outfits', async () => {
    mockedUseOutfits.mockReturnValue(outfitsValue({ outfits: [] }));

    await render(<PlanOutfitScreen />);

    expect(screen.getByTestId('plan-outfit-no-outfits')).toBeTruthy();
  });

  it('shows the outfit list error rather than an empty state', async () => {
    // A failed load is not an empty gallery — telling a user with outfits that
    // they have none is the failure this guard exists for.
    mockedUseOutfits.mockReturnValue(outfitsValue({ outfits: [], error: 'Cannot reach the server' }));

    await render(<PlanOutfitScreen />);

    expect(screen.getByTestId('plan-outfit-outfits-error')).toBeTruthy();
    expect(screen.queryByTestId('plan-outfit-no-outfits')).toBeNull();
  });
});
