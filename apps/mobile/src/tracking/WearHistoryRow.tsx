import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PublicWearEvent } from '@wardrobe/shared';
import { color, space } from '../theme/tokens';
import { font, text } from '../theme/type';
import { countLabel, formatDay } from '../format/text';

/**
 * What a wear event is called when the response carried no outfit name.
 *
 * **The wording is a correctness claim, not copy, and "Outfit deleted" would
 * be wrong.** An absent `outfitName` has two causes and the API collapses them
 * deliberately. From `apps/api/src/routes/wearHistory.ts`'s `outfitNames()`:
 *
 * > Only real names go in the map. An outfit with no name and an outfit that
 * > no longer exists both mean "no name to show", and collapsing them here
 * > keeps the response shape from having two ways to say so.
 *
 * Its integration suite asserts both, adjacently: "omits outfitName for an
 * outfit that never had one" sits directly above "STILL LISTS an event whose
 * outfit was deleted, without outfitName". So nothing in the response tells
 * this row which happened, and nothing on the client can find out — the wear
 * history and the outfit gallery are different endpoints with different
 * cursors, and an id missing from page one of the gallery is as likely to be
 * on page two as to be deleted.
 *
 * An unnamed outfit is also not a curiosity. `OutfitComposer`'s name field is
 * labelled "Outfit name, optional" and omits the key entirely when blank, so
 * this app produces unnamed outfits as a matter of course. A row reading
 * "Outfit deleted" above an outfit sitting in the user's own gallery is a
 * confident falsehood the user can see is false, and the kind that gets
 * reported as data loss.
 *
 * So the label names deletion first — ruling 3's state has to be visible
 * rather than swallowed — without asserting it as the only cause.
 *
 * `packages/shared/src/tracking.ts` documents the field as "Absent when the
 * outfit has since been deleted", which is the half of the truth that made
 * this worth writing down here. Recorded in the Task 5 report.
 *
 * Exported so tests assert against the shipped string rather than a copy of
 * it, with one test pinning the literal because the wording is the claim.
 */
export const NAMELESS_OUTFIT_LABEL = 'Deleted or unnamed outfit';

export interface WearHistoryRowProps {
  /**
   * The event, whole. Every field this row renders comes off it and none
   * comes from a lookup, which is the property ruling 3 turns on: the event
   * carries a snapshot of `itemIds` taken when the outfit was worn, so it can
   * still describe itself when the outfit it points at no longer exists.
   */
  event: PublicWearEvent;
}

/**
 * One row of the Profile tab's wear history — FR6, and the half of TC-08 that
 * reads "Wear event recorded; **visible in history list**".
 *
 * Non-interactive, deliberately. There is nowhere for a tap to go: the outfit
 * may not exist any more, which is exactly the state below, and a row that
 * navigates for some events and not others is a control that fails silently
 * for the user who most needs an explanation. Nothing in this system edits or
 * deletes a wear event either — `PublicWearEvent` carries no `updatedAt` for
 * that reason — so there is no mutating control to put here.
 */
export function WearHistoryRow({ event }: WearHistoryRowProps): React.JSX.Element {
  // Trimmed, and length-checked rather than `??`. `toPublicWearEvent` spreads
  // `...(outfitName ? { outfitName } : {})`, so the shipping API cannot send
  // `''` — but nothing between the socket and here enforces that (`apiRequest`
  // ends in `return parsed as T`), and `??` would let an empty string through
  // as a title. The result would be the blank row this component exists to
  // rule out, in the one state it is least explicable.
  const given = event.outfitName?.trim() ?? '';
  const name = given.length > 0 ? given : NAMELESS_OUTFIT_LABEL;

  // `itemIds` is the composition AT THE MOMENT IT WAS WORN, not the outfit's
  // composition now. Reading it from the outfit instead would report a number
  // that changes when the outfit is edited, and would have nothing at all to
  // report once the outfit is deleted.
  const meta = `${formatDay(event.wornAt)} · ${countLabel(event.itemIds.length)}`;

  // Omitted, never rendered empty: `occasion` is genuinely optional and the
  // API omits the key rather than sending `''`, so an empty line here would be
  // a rendering artefact the reader has to interpret.
  const occasion = event.occasion === undefined || event.occasion.trim() === '' ? null : event.occasion;

  // Three sibling `Text`s are three separate stops for a screen reader, and a
  // date read apart from the outfit it belongs to says nothing. Grouping them
  // costs the individual strings — `accessible` on a View hides its children
  // from the accessibility tree — so the label has to carry all of it.
  const spoken = `${name}, worn ${formatDay(event.wornAt)}, ${countLabel(event.itemIds.length)}${
    occasion === null ? '' : `, for ${occasion}`
  }`;

  return (
    <View
      testID={`wear-event-${event.id}`}
      style={styles.row}
      accessible
      accessibilityLabel={spoken}
    >
      <Text
        testID={`wear-event-name-${event.id}`}
        style={[styles.name, given.length > 0 ? null : styles.nameless]}
        numberOfLines={1}
      >
        {name}
      </Text>
      <Text testID={`wear-event-meta-${event.id}`} style={styles.meta}>
        {meta}
      </Text>
      {occasion === null ? null : (
        <Text testID={`wear-event-occasion-${event.id}`} style={styles.occasion} numberOfLines={1}>
          {`For ${occasion}`}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: space.md,
    paddingHorizontal: space.gutter,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.cloud,
    gap: 2,
  },
  name: { ...text.name, fontSize: 15 },
  // Italic and quiet, so the placeholder does not read as an outfit actually
  // called "Deleted or unnamed outfit". A second channel beside the words, for
  // the same reason the laundry badge has three: style alone would be invisible
  // to a screen reader, and the words alone are ambiguous with a real name.
  nameless: { fontFamily: font.displayItalic, color: color.soft },
  meta: { ...text.meta },
  occasion: { ...text.meta, color: color.ink },
});
