import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { LaundryStatus, PublicClothingItem } from '@wardrobe/shared';
import { LaundryList, type LaundryListProps } from './LaundryList';

/**
 * The Profile tab's laundry list — FR7's readable half.
 *
 * The mutating control is NOT here: the toggle lives on the item detail screen
 * this list links to, so there is exactly one control per state.
 *
 * ## What this section is allowed to SAY
 *
 * Most of the tests below are about one rule: **the section may never state a
 * fact about the user's laundry that it does not have.** It sees page ONE of
 * the wardrobe and a wardrobe-wide count that arrives from a different
 * request, so "Nothing in the wash." is only true under conditions it has to
 * check — and an unchecked version of that sentence renders on first mount,
 * before any request has landed, which is where a first draft of this
 * component shipped it.
 */
function item(id: string, laundryStatus: LaundryStatus, overrides: Partial<PublicClothingItem> = {}): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/full/${id}.jpg`,
    thumbnailUrl: `https://example.test/thumb/${id}.jpg`,
    category: 'shirt',
    colors: [{ hex: '#ffffff', name: 'white', share: 1 }],
    seasons: ['summer'],
    laundryStatus,
    retired: false,
    wearCount: 2,
    source: 'ai',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

const onOpen = jest.fn();
const onRetry = jest.fn();

/**
 * Defaulted to "the wardrobe has fully loaded and this is all of it", so each
 * test states only the axis it is about.
 *
 * `hasMore: false` is the default deliberately: it is the state in which the
 * section CAN speak confidently, so a test that says nothing about paging is
 * asking about the confident case.
 */
function props(overrides: Partial<LaundryListProps> = {}): LaundryListProps {
  return {
    items: [],
    activity: 'idle',
    hasMore: false,
    onOpen,
    error: null,
    onRetry,
    ...overrides,
  };
}

describe('LaundryList', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('lists the garments in the wash and no others', async () => {
    await render(
      <LaundryList
        {...props({ items: [item('a', 'in_laundry'), item('b', 'available'), item('c', 'in_laundry')] })}
      />,
    );

    expect(screen.getByTestId('laundry-item-a')).toBeTruthy();
    expect(screen.getByTestId('laundry-item-c')).toBeTruthy();
    expect(screen.queryByTestId('laundry-item-b')).toBeNull();
  });

  it('opens the item detail screen, which is where the toggle lives', async () => {
    await render(<LaundryList {...props({ items: [item('a', 'in_laundry')] })} />);

    await fireEvent.press(screen.getByTestId('laundry-item-a'));

    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('announces itself as a link to the details, not as a control that changes anything', async () => {
    // One mutating control per state. A row that a screen reader announces as
    // "removes from laundry" would be a second one, and the wrong one: the
    // detail screen's toggle is ref-guarded, shows its own pending state and
    // has somewhere to put an error message.
    await render(<LaundryList {...props({ items: [item('a', 'in_laundry')] })} />);

    const row = screen.getByTestId('laundry-item-a');
    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityLabel).toBe('shirt, white');
    expect(row.props.accessibilityHint).toBe("Opens this item's details");
  });

  it('reads the status through the SAME predicate the wardrobe badge uses', async () => {
    // `isInLaundry` is an equality against the one member that means "in the
    // wash", never `!== 'available'`. Nothing between the socket and here
    // validates the response — `apiRequest` ends in `return parsed as T` — so
    // a status only the server has heard of arrives typed as one of the two.
    // Under `!== 'available'` it would be listed as being in the wash, which
    // would also disagree with the grid, where the same value draws no badge.
    const unknown = item('z', 'tumble_drying' as unknown as LaundryStatus);
    await render(<LaundryList {...props({ items: [unknown] })} />);

    expect(screen.queryByTestId('laundry-item-z')).toBeNull();
    expect(screen.getByTestId('laundry-empty')).toBeTruthy();
  });

  describe('what it is allowed to say', () => {
    it('does NOT claim an empty wash before the first wardrobe page has landed', async () => {
      // The state every user sees for the first second of every visit to this
      // tab: `useWardrobe` starts at `activity: 'loading'` with `items: []`
      // and no error, and `useUsageAnalytics` starts at `analytics: null`. The
      // history section shows a spinner and the analytics section shows a
      // spinner; a first draft of this section confidently reported on the
      // user's laundry in between them.
      //
      // Exactly the "an empty array is indistinguishable from not-loaded"
      // conflation that `useUsageAnalytics`'s own prop doc argues against.
      await render(<LaundryList {...props({ items: [], activity: 'loading' })} />);

      expect(screen.getByTestId('laundry-loading')).toBeTruthy();
      expect(screen.queryByTestId('laundry-empty')).toBeNull();
      expect(screen.queryByTestId('laundry-partial')).toBeNull();
    });

    it('does NOT claim an empty wash when it cannot see the whole wardrobe', async () => {
      // The failure that does not resolve on its own: the analytics request
      // fails, so `total` never arrives, and page one happens to hold no dirty
      // garments. The wardrobe load SUCCEEDED, so there is no error banner
      // here — and without this the section says "Nothing in the wash."
      // indefinitely about a wardrobe it has seen 24 items of.
      await render(
        <LaundryList {...props({ items: [item('b', 'available')], hasMore: true })} />,
      );

      expect(screen.queryByTestId('laundry-empty')).toBeNull();
      expect(screen.getByTestId('laundry-partial')).toHaveTextContent(
        'Nothing in the wash on the first page of your wardrobe — check the Wardrobe tab for the rest.',
      );
    });

    it('DOES claim an empty wash once the server has counted the whole wardrobe', async () => {
      // `itemsInLaundry: 0` is a count over every item the user owns, so it
      // licenses the confident sentence even though more pages exist.
      await render(
        <LaundryList {...props({ items: [item('b', 'available')], total: 0, hasMore: true })} />,
      );

      expect(screen.getByTestId('laundry-empty')).toHaveTextContent('Nothing in the wash.');
      expect(screen.queryByTestId('laundry-partial')).toBeNull();
    });

    it('DOES claim an empty wash once it has seen the whole wardrobe itself', async () => {
      // The other licence, and the one most users get: `hasMore === false`
      // means page one IS the wardrobe, so the filtered list is complete
      // whether or not the analytics snapshot ever arrives.
      await render(<LaundryList {...props({ items: [item('b', 'available')], hasMore: false })} />);

      expect(screen.getByTestId('laundry-empty')).toHaveTextContent('Nothing in the wash.');
    });

    it('says it may not be showing all of them when the total is unknown', async () => {
      await render(
        <LaundryList {...props({ items: [item('a', 'in_laundry')], hasMore: true })} />,
      );

      expect(screen.getByTestId('laundry-item-a')).toBeTruthy();
      expect(screen.getByTestId('laundry-partial')).toHaveTextContent(
        'Showing what is in the wash on the first page of your wardrobe — check the Wardrobe tab for the rest.',
      );
    });

    it('adds no hedge when it has seen the whole wardrobe', async () => {
      await render(
        <LaundryList {...props({ items: [item('a', 'in_laundry')], hasMore: false })} />,
      );

      expect(screen.queryByTestId('laundry-partial')).toBeNull();
      expect(screen.queryByTestId('laundry-note')).toBeNull();
    });

    it('keeps the rows on screen for a load that has something behind it', async () => {
      // The `shown.length === 0` conjunct on the loading branch, stated as a
      // contract rather than as a fact about today's `useWardrobe` — that hook
      // batches `setItems([])` into the same commit as the loading run, so no
      // render it currently produces can reach this. The conjunct is what
      // stops a hook that ever cleared the list a commit later from showing a
      // spinner underneath rows that are perfectly good.
      await render(
        <LaundryList {...props({ items: [item('a', 'in_laundry')], activity: 'loading' })} />,
      );

      expect(screen.getByTestId('laundry-item-a')).toBeTruthy();
      expect(screen.queryByTestId('laundry-loading')).toBeNull();
    });

    it('keeps its answer on screen during a refresh', async () => {
      // `activity === 'loading'` and not `!== 'idle'`. A pull-to-refresh keeps
      // the rows on every other list in this app, and the sentence under this
      // one IS its rows when it has none — so swapping it for a spinner would
      // take the section's only statement away for a round trip, every time
      // the user pulls.
      await render(<LaundryList {...props({ items: [], activity: 'refreshing' })} />);

      expect(screen.getByTestId('laundry-empty')).toBeTruthy();
      expect(screen.queryByTestId('laundry-loading')).toBeNull();
    });

    it('shows no loading placeholder under an error', async () => {
      // A failed load is not a load in flight. `activity` is back to `'idle'`
      // by the time the error is set, but a screen that keyed the placeholder
      // on "no items yet" rather than on the activity would show both.
      await render(<LaundryList {...props({ error: 'Cannot reach the server.' })} />);

      expect(screen.queryByTestId('laundry-loading')).toBeNull();
    });
  });

  it('does NOT contradict the analytics count when the garments are past page one', async () => {
    // The failure this exists to prevent, and it is a contradiction visible in
    // one screenshot: Profile reads page ONE of the wardrobe (24 items by the
    // server's default), while `itemsInLaundry` is a count over the whole
    // wardrobe. A user with 30 items whose three dirty shirts all sort onto
    // page two would otherwise read "3 items in the wash" in the section above
    // and "Nothing in the wash" here.
    await render(
      <LaundryList {...props({ items: [item('b', 'available')], total: 3, hasMore: true })} />,
    );

    expect(screen.queryByTestId('laundry-empty')).toBeNull();
    expect(screen.getByTestId('laundry-elsewhere')).toHaveTextContent(
      '3 items in the wash — find them on the Wardrobe tab.',
    );
  });

  it('says how many it is showing when it cannot show them all', async () => {
    await render(
      <LaundryList
        {...props({ items: [item('a', 'in_laundry'), item('b', 'available')], total: 3, hasMore: true })}
      />,
    );

    expect(screen.getByTestId('laundry-note')).toHaveTextContent(
      'Showing 1 of 3 — find the rest on the Wardrobe tab.',
    );
  });

  it('adds no note when it is showing all of them', async () => {
    await render(
      <LaundryList
        {...props({ items: [item('a', 'in_laundry'), item('c', 'in_laundry')], total: 2, hasMore: true })}
      />,
    );

    expect(screen.queryByTestId('laundry-note')).toBeNull();
    expect(screen.queryByTestId('laundry-partial')).toBeNull();
  });

  it('adds no note when the wardrobe is ahead of the analytics snapshot', async () => {
    // The two sections are two independent requests and either can land first,
    // so `shown` can legitimately exceed `total` for a round trip — after a
    // toggle refreshes the wardrobe before the analytics. "Showing 2 of 1" is
    // worse than saying nothing.
    await render(
      <LaundryList
        {...props({ items: [item('a', 'in_laundry'), item('c', 'in_laundry')], total: 1, hasMore: true })}
      />,
    );

    expect(screen.queryByTestId('laundry-note')).toBeNull();
  });

  it('shows a failed wardrobe load as an error with a retry, not as an empty wash', async () => {
    await render(<LaundryList {...props({ error: 'Cannot reach the server.' })} />);

    expect(screen.getByTestId('laundry-error-message')).toHaveTextContent('Cannot reach the server.');
    expect(screen.queryByTestId('laundry-empty')).toBeNull();
    expect(screen.queryByTestId('laundry-partial')).toBeNull();

    await fireEvent.press(screen.getByTestId('laundry-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
