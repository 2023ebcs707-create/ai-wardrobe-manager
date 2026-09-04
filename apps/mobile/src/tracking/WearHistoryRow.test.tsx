import React from 'react';
import { StyleSheet, type TextStyle } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import type { PublicWearEvent } from '@wardrobe/shared';
import { NAMELESS_OUTFIT_LABEL, WearHistoryRow } from './WearHistoryRow';

/** The flattened style actually applied to a rendered element. */
function styleOf(testID: string): TextStyle {
  const el = screen.getByTestId(testID);
  return (StyleSheet.flatten(el.props.style as TextStyle) ?? {}) as TextStyle;
}

/**
 * One row of the Profile tab's wear history — FR6, and the half of TC-08 that
 * reads "Wear event recorded; **visible in history list**".
 */
function event(overrides: Partial<PublicWearEvent> = {}): PublicWearEvent {
  return {
    id: 'wear-1',
    userId: 'user-1',
    outfitId: 'outfit-1',
    outfitName: 'Friday best',
    itemIds: ['item-a', 'item-b', 'item-c'],
    wornAt: '2026-08-20T18:00:00.000Z',
    createdAt: '2026-08-20T18:05:00.000Z',
    ...overrides,
  };
}

describe('WearHistoryRow', () => {
  it('names the outfit, the day it was worn and how many items it held', async () => {
    await render(<WearHistoryRow event={event()} />);

    expect(screen.getByTestId('wear-event-name-wear-1')).toHaveTextContent('Friday best');
    // The date is the one field TC-08 names — "entry recorded with date".
    // Formatted in the device timezone: 18:00 UTC on 20 August is 11:00 on the
    // 20th in the pinned Los Angeles zone, so both readings agree here and the
    // timezone contract itself is pinned in `src/format/text.test.ts`.
    expect(screen.getByTestId('wear-event-meta-wear-1')).toHaveTextContent('20 Aug 2026 · 3 items');
  });

  it('shows the occasion when the wear carried one', async () => {
    await render(<WearHistoryRow event={event({ occasion: 'brunch' })} />);

    expect(screen.getByTestId('wear-event-occasion-wear-1')).toHaveTextContent('For brunch');
  });

  it('renders no occasion element at all when the wear carried none', async () => {
    // Not an empty Text: an empty line in a list row is a rendering artefact
    // the reader has to interpret, and `occasion` is genuinely optional on
    // `PublicWearEvent` — the API omits the key rather than sending `''`.
    await render(<WearHistoryRow event={event()} />);

    expect(screen.queryByTestId('wear-event-occasion-wear-1')).toBeNull();
  });

  it('STILL RENDERS a wear whose outfit has been deleted, and says so', async () => {
    // Ruling 3, the user-facing half. `DELETE /outfits/:id` exists, so this is
    // live rather than hypothetical: a wear happened, and deleting the outfit
    // afterwards does not un-happen it. The API keeps the row and omits
    // `outfitName` (`apps/api/src/routes/wearHistory.integration.test.ts`
    // "STILL LISTS an event whose outfit was deleted, without outfitName").
    //
    // The row must not go blank and must not be dropped.
    const orphan = event({ id: 'wear-9', outfitName: undefined, itemIds: ['item-a', 'item-b'] });
    await render(<WearHistoryRow event={orphan} />);

    expect(screen.getByTestId('wear-event-wear-9')).toBeTruthy();
    expect(screen.getByTestId('wear-event-name-wear-9')).toHaveTextContent(NAMELESS_OUTFIT_LABEL);
  });

  it('describes a deleted outfit from the event\'s OWN snapshot', async () => {
    // The reason ruling 3 is possible at all: `itemIds` is snapshotted onto the
    // event at write time, so the row can still say what was worn when the
    // outfit it points at is gone. Without the snapshot the only honest
    // rendering of an orphaned row would be a name and nothing else.
    const orphan = event({ id: 'wear-9', outfitName: undefined, itemIds: ['item-a', 'item-b'] });
    await render(<WearHistoryRow event={orphan} />);

    expect(screen.getByTestId('wear-event-meta-wear-9')).toHaveTextContent('20 Aug 2026 · 2 items');
  });

  it('does NOT claim the outfit was deleted, because the response cannot say that', async () => {
    // The literal wording is pinned here, and only here, because it is a
    // correctness claim rather than copy.
    //
    // `outfitName` absent has TWO causes and the API collapses them on
    // purpose. `apps/api/src/routes/wearHistory.ts`'s `outfitNames()`: "An
    // outfit with no name and an outfit that no longer exists both mean 'no
    // name to show', and collapsing them here keeps the response shape from
    // having two ways to say so." Its own integration suite asserts both —
    // "omits outfitName for an outfit that never had one" sits directly above
    // "STILL LISTS an event whose outfit was deleted, without outfitName".
    //
    // And an unnamed outfit is not a curiosity: `OutfitComposer`'s name field
    // is labelled "Outfit name, optional" and omits the key when blank, so
    // this app produces them routinely. A row reading "Outfit deleted" over an
    // outfit sitting in the user's gallery is a confident falsehood the user
    // can see is false.
    //
    // So the label names the deletion — which is what the row must make
    // explicit — without asserting it as the only cause.
    expect(NAMELESS_OUTFIT_LABEL).toBe('Deleted or unnamed outfit');

    await render(<WearHistoryRow event={event({ outfitName: undefined })} />);
    expect(screen.getByTestId('wear-event-name-wear-1')).toHaveTextContent(
      'Deleted or unnamed outfit',
    );
  });

  it('treats a blank outfitName as no name', async () => {
    // `toPublicWearEvent` spreads `...(outfitName ? { outfitName } : {})`, so
    // the shipping API cannot send `''`. Nothing between the socket and here
    // enforces that — `apiRequest` ends in `return parsed as T` — and a `??`
    // would let an empty string through as a title, which renders as the blank
    // row this test exists to forbid.
    await render(<WearHistoryRow event={event({ outfitName: '   ' })} />);

    expect(screen.getByTestId('wear-event-name-wear-1')).toHaveTextContent(NAMELESS_OUTFIT_LABEL);
  });

  it('sets the placeholder apart from a real outfit name by more than its wording', async () => {
    // Otherwise a user whose outfit is genuinely called something unusual and
    // a user whose outfit is gone read the same row. The channel is deliberately
    // italic-plus-grey rather than a colour: both survive desaturation — a
    // slant is a shape and grey is a luminance — which the laundry badge one
    // directory over had to learn the hard way.
    // Both in one render. Two renders in one test with an `unmount` between
    // them opens a second act() scope inside the first, which React reports as
    // "overlapping act() calls" — a warning line, and this suite's output has
    // to be clean.
    await render(
      <>
        <WearHistoryRow event={event({ id: 'named' })} />
        <WearHistoryRow event={event({ id: 'orphan', outfitName: undefined })} />
      </>,
    );

    const named = styleOf('wear-event-name-named');
    const orphan = styleOf('wear-event-name-orphan');

    // The slant is carried by the FACE, not by `fontStyle`. Every weight and
    // slant in this app is its own registered family (`src/theme/type.ts`)
    // because React Native on Android does not synthesise an italic for a
    // custom family: `fontStyle: 'italic'` beside `Fraunces_400Regular` either
    // does nothing or drops the text back to the system font, so asserting it
    // would pin the one property that cannot deliver the slant.
    expect(orphan.fontFamily).not.toBe(named.fontFamily);
    expect(orphan.fontFamily).toMatch(/italic/i);
    expect(named.fontFamily).not.toMatch(/italic/i);
    expect(orphan.color).not.toBe(named.color);
  });

  it('speaks the whole row as one utterance', async () => {
    // Three sibling Texts are three separate stops for a screen reader, and
    // the date means nothing read apart from the outfit it belongs to.
    await render(<WearHistoryRow event={event({ occasion: 'brunch' })} />);

    expect(screen.getByTestId('wear-event-wear-1').props.accessibilityLabel).toBe(
      'Friday best, worn 20 Aug 2026, 3 items, for brunch',
    );
  });

  it('speaks the missing name too, rather than a silent gap', async () => {
    await render(<WearHistoryRow event={event({ outfitName: undefined })} />);

    expect(screen.getByTestId('wear-event-wear-1').props.accessibilityLabel).toBe(
      `${NAMELESS_OUTFIT_LABEL}, worn 20 Aug 2026, 3 items`,
    );
  });
});
