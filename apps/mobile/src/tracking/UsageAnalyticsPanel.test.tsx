import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { PublicClothingItem, PublicUsageAnalytics } from '@wardrobe/shared';
import { UsageAnalyticsPanel } from './UsageAnalyticsPanel';

/**
 * Phase 3's promise, on the Profile tab: "View usage analytics showing
 * most/least worn items".
 */
function item(id: string, wearCount: number, overrides: Partial<PublicClothingItem> = {}): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/full/${id}.jpg`,
    thumbnailUrl: `https://example.test/thumb/${id}.jpg`,
    category: 'jacket',
    colors: [{ hex: '#001f3f', name: 'navy', share: 1 }],
    seasons: ['winter'],
    laundryStatus: 'available',
    retired: false,
    wearCount,
    source: 'ai',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function snapshot(overrides: Partial<PublicUsageAnalytics> = {}): PublicUsageAnalytics {
  return {
    mostWorn: [item('a', 9), item('b', 4)],
    leastWorn: [item('c', 0), item('d', 1)],
    totalWears: 14,
    itemsInLaundry: 2,
    ...overrides,
  };
}

const onRetry = jest.fn();

describe('UsageAnalyticsPanel', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('waits rather than inventing a zeroed snapshot before the first load lands', async () => {
    // `useUsageAnalytics` hands over `null`, deliberately not an all-zeroes
    // placeholder, because the API answers `totalWears: 0` for a real empty
    // wardrobe — so a zeroed object here would be indistinguishable from a
    // loaded answer. Rendering "0 wears logged" while the request is still in
    // flight states a fact the panel does not have.
    await render(<UsageAnalyticsPanel analytics={null} activity="loading" error={null} onRetry={onRetry} />);

    expect(screen.getByTestId('usage-loading')).toBeTruthy();
    expect(screen.queryByTestId('usage-summary')).toBeNull();
    expect(screen.queryByTestId('usage-empty')).toBeNull();
  });

  it('shows no spinner once the first load has FAILED', async () => {
    // Nothing is in flight after a failure — `activity` is back to `'idle'` —
    // so a spinner beside the banner would promise a retry nobody started.
    await render(
      <UsageAnalyticsPanel analytics={null} activity="idle" error="Cannot reach the server." onRetry={onRetry} />,
    );

    expect(screen.queryByTestId('usage-loading')).toBeNull();
    expect(screen.getByTestId('usage-error-message')).toHaveTextContent('Cannot reach the server.');
  });

  it('offers a retry that calls back', async () => {
    await render(
      <UsageAnalyticsPanel analytics={null} activity="idle" error="Cannot reach the server." onRetry={onRetry} />,
    );

    await fireEvent.press(screen.getByTestId('usage-retry'));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good numbers on screen beside an error', async () => {
    // The hook leaves `analytics` untouched on failure on purpose: the numbers
    // were true a moment ago, and a blank leaderboard under a banner is a
    // worse answer than a slightly stale one.
    await render(
      <UsageAnalyticsPanel analytics={snapshot()} activity="idle" error="Cannot reach the server." onRetry={onRetry} />,
    );

    expect(screen.getByTestId('usage-error-message')).toBeTruthy();
    expect(screen.getByTestId('usage-most-a')).toBeTruthy();
  });

  it('ranks the most-worn and least-worn items, with their counts', async () => {
    await render(<UsageAnalyticsPanel analytics={snapshot()} activity="idle" error={null} onRetry={onRetry} />);

    expect(screen.getByTestId('usage-most-count-a')).toHaveTextContent('9 wears');
    expect(screen.getByTestId('usage-most-count-b')).toHaveTextContent('4 wears');
    expect(screen.getByTestId('usage-least-count-c')).toHaveTextContent('0 wears');
    // Singular. A leaderboard is exactly where "1 wears" gets shipped.
    expect(screen.getByTestId('usage-least-count-d')).toHaveTextContent('1 wear');
  });

  it('lets one item stand in BOTH lists', async () => {
    // Correct rather than a bug to hide, and `packages/shared/src/tracking.ts`
    // says why: a wardrobe of three items has all three in both lists.
    // Subtracting one list from the other would make "least worn" mean "least
    // worn, excluding some items that are worn even less".
    const both = snapshot({ mostWorn: [item('a', 9)], leastWorn: [item('a', 9)] });
    await render(<UsageAnalyticsPanel analytics={both} activity="idle" error={null} onRetry={onRetry} />);

    expect(screen.getByTestId('usage-most-a')).toBeTruthy();
    expect(screen.getByTestId('usage-least-a')).toBeTruthy();
  });

  it('reports the two wardrobe-wide scalars', async () => {
    await render(<UsageAnalyticsPanel analytics={snapshot()} activity="idle" error={null} onRetry={onRetry} />);

    expect(screen.getByTestId('usage-total-wears')).toHaveTextContent('14 wears logged');
    expect(screen.getByTestId('usage-items-in-laundry')).toHaveTextContent('2 items in the wash');
  });

  it('EXPLAINS ITSELF on an empty wardrobe instead of showing two empty lists', async () => {
    // A new user opening Profile should learn what this section will show
    // them. Two headings with nothing under them teach nothing and read as a
    // broken screen.
    const empty = snapshot({ mostWorn: [], leastWorn: [], totalWears: 0, itemsInLaundry: 0 });
    await render(<UsageAnalyticsPanel analytics={empty} activity="idle" error={null} onRetry={onRetry} />);

    expect(screen.getByTestId('usage-empty')).toBeTruthy();
    expect(screen.queryByTestId('usage-most-worn')).toBeNull();
    expect(screen.queryByTestId('usage-least-worn')).toBeNull();
  });

  it('explains itself for a wardrobe nobody has worn YET, where every rank ties at zero', async () => {
    // The case an "are both lists empty?" test would miss entirely. The API
    // ranks on `wearCount`, so a 40-item wardrobe with no wears returns two
    // full lists — an arbitrary ordering of a column of zeroes, presented as a
    // ranking. `leastWorn` including never-worn items is deliberate and useful
    // *once something has been worn*; before that there is nothing to compare.
    const unworn = snapshot({
      mostWorn: [item('a', 0), item('b', 0)],
      leastWorn: [item('c', 0), item('d', 0)],
      totalWears: 0,
    });
    await render(<UsageAnalyticsPanel analytics={unworn} activity="idle" error={null} onRetry={onRetry} />);

    expect(screen.getByTestId('usage-empty')).toBeTruthy();
    expect(screen.queryByTestId('usage-most-worn')).toBeNull();
  });

  it('never renders two empty lists, whatever the totals claim', async () => {
    // A response whose scalars and lists disagree is not one this API produces
    // — nothing deletes an item, so a non-zero `totalWears` implies items
    // exist. It is asserted anyway because the panel is a pure function of its
    // props and "two empty headings" is the one output it must never have; a
    // rule that depends on the server staying self-consistent is a rule with a
    // hole in it.
    const contradictory = snapshot({ mostWorn: [], leastWorn: [], totalWears: 3 });
    await render(<UsageAnalyticsPanel analytics={contradictory} activity="idle" error={null} onRetry={onRetry} />);

    expect(screen.getByTestId('usage-empty')).toBeTruthy();
    expect(screen.queryByTestId('usage-most-worn')).toBeNull();
    expect(screen.queryByTestId('usage-least-worn')).toBeNull();
  });

  it('still reports the scalars alongside the empty state', async () => {
    // "0 wears logged" is a fact, and the one that makes the explanation
    // concrete rather than decorative.
    const empty = snapshot({ mostWorn: [], leastWorn: [], totalWears: 0, itemsInLaundry: 0 });
    await render(<UsageAnalyticsPanel analytics={empty} activity="idle" error={null} onRetry={onRetry} />);

    expect(screen.getByTestId('usage-total-wears')).toHaveTextContent('0 wears logged');
  });

  it('shows that a retry over stale numbers is under way', async () => {
    // The section has its own "Try again", and the hook clears `error` when a
    // request STARTS rather than when it succeeds — so the banner the user
    // just pressed disappears in the same commit. Without this line the only
    // feedback for that press is the numbers changing some seconds later, or
    // not changing at all if they were already current.
    await render(
      <UsageAnalyticsPanel analytics={snapshot()} activity="refreshing" error={null} onRetry={onRetry} />,
    );

    expect(screen.getByTestId('usage-refreshing')).toBeTruthy();
    // And the numbers stay: a refresh is not a reset.
    expect(screen.getByTestId('usage-most-a')).toBeTruthy();
  });

  it('does not double up on progress when there is nothing behind the request', async () => {
    // `activity="refreshing"` with a null snapshot, NOT `"loading"`, and the
    // difference is the whole test. A first mount is `loading`, so a mutant
    // that renders "Updating…" for `refreshing` alone survives a `loading`
    // fixture untouched — which is what a first draft of this test did.
    //
    // The state is reachable and ordinary: the first load fails, the user
    // presses the section's own "Try again", and `refresh()` sets `refreshing`
    // while `analytics` is still null. The spinner below is the progress
    // indication there, and two of them for one request is noise.
    await render(
      <UsageAnalyticsPanel analytics={null} activity="refreshing" error={null} onRetry={onRetry} />,
    );

    expect(screen.getByTestId('usage-loading')).toBeTruthy();
    expect(screen.queryByTestId('usage-refreshing')).toBeNull();
  });

  it('speaks each leaderboard row as one utterance', async () => {
    // A thumbnail, a category and a number are three stops for a screen
    // reader, and the number means nothing read apart from the garment.
    await render(<UsageAnalyticsPanel analytics={snapshot()} activity="idle" error={null} onRetry={onRetry} />);

    expect(screen.getByTestId('usage-most-a').props.accessibilityLabel).toBe('jacket, 9 wears');
  });
});
