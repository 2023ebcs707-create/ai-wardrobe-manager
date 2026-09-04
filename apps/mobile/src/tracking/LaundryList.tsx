import React from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PublicClothingItem } from '@wardrobe/shared';
import { color, radius, space } from '../theme/tokens';
import { font, text } from '../theme/type';
import { countLabel } from '../format/text';
import type { WardrobeActivity } from '../wardrobe/useWardrobe';
import { isInLaundry } from './LaundryBadge';

export interface LaundryListProps {
  /**
   * The wardrobe page, **unfiltered**.
   *
   * The filtering happens here, through `isInLaundry`, rather than at the call
   * site. Two reasons, and the second is the one that matters: a filtered prop
   * would let a caller hand over a list that disagrees with the predicate the
   * wardrobe grid draws its badge from, and the type system would be perfectly
   * happy; and this component needs to know how many it *dropped* to say
   * anything useful about `total`.
   */
  items: PublicClothingItem[];
  /**
   * What the wardrobe request is doing right now.
   *
   * Required, and it is the difference between a section that reports and a
   * section that guesses. `items: []` means "no garments in the wash" only
   * once something has answered; before that it means "no request has come
   * back yet", and the two are the same array. This is the conflation
   * `useUsageAnalytics` hands its consumers a `null` to avoid, arriving one
   * component over through a different door: an empty list rather than a null
   * object.
   */
  activity: WardrobeActivity;
  /**
   * Whether the wardrobe has pages this screen has not read.
   *
   * `false` is a licence to speak confidently: page one IS the wardrobe, so
   * the filtered list is complete whether or not the analytics snapshot ever
   * arrives. `true` without a `total` means the section is looking at part of
   * a wardrobe and must say so.
   */
  hasMore: boolean;
  /**
   * How many of the user's items are in the wash **across the whole wardrobe**,
   * from `PublicUsageAnalytics.itemsInLaundry`, or `undefined` when the
   * analytics snapshot has not landed or failed.
   *
   * This exists because the two counts are taken over different populations
   * and can legitimately differ — see `hidden` below.
   */
  total?: number;
  /** Opens the item's detail screen, which is where the toggle lives. */
  onOpen: (id: string) => void;
  /** A ready-to-render message, or `null` if the last request succeeded. */
  error: string | null;
  onRetry: () => void;
}

/** Where the garments this section cannot show are: not further down THIS screen. */
const ELSEWHERE = 'the Wardrobe tab';

/**
 * The Profile tab's laundry list — FR7's readable half, and the counterpart to
 * TC-09's badge on the wardrobe grid.
 *
 * **No toggle here.** One mutating control per state: the transition lives on
 * the item detail screen this list links to, where it is ref-guarded, shows
 * its own pending state, and has somewhere to put an error message. A second
 * control over the same field would be a second guard to keep in step and a
 * second place for an optimistic update to be reintroduced.
 *
 * ## The rule this component is mostly made of
 *
 * **It may never state a fact about the user's laundry that it does not have.**
 *
 * It sees page ONE of the wardrobe (24 items by the server's default) and a
 * wardrobe-wide count that arrives from a different request which can fail on
 * its own. So the confident sentence — "Nothing in the wash." — needs a
 * licence, and there are exactly two: `total === 0`, which is the server
 * counting every item the user owns, or `hasMore === false`, which means this
 * page is the whole wardrobe. With neither, the section says what it actually
 * knows, which is a sentence about the first page.
 *
 * A first draft had no `activity` and no `hasMore` and shipped the confident
 * sentence in two states it had no business being confident in: on every first
 * mount, between the history's spinner and the analytics' spinner; and
 * indefinitely, whenever the analytics request failed while page one happened
 * to hold no dirty garments — with no error of its own, because the *wardrobe*
 * load had succeeded.
 */
export function LaundryList({
  items,
  activity,
  hasMore,
  total,
  onOpen,
  error,
  onRetry,
}: LaundryListProps): React.JSX.Element {
  // The SAME predicate the wardrobe grid's badge reads, deliberately imported
  // rather than restated as `item.laundryStatus === 'in_laundry'`. Two
  // comparisons are two things that can be changed apart, and the state they
  // would produce — a garment listed here with no badge on it in the grid, or
  // the reverse — is unexplainable to a user looking at both screens.
  const shown = items.filter(isInLaundry);

  /**
   * How many are in the wash that this list cannot show.
   *
   * Without this the section contradicts the one above it in a single
   * screenshot: a user with thirty items whose three dirty shirts all sort
   * onto page two reads "3 items in the wash" in the analytics summary and
   * "Nothing in the wash" here.
   *
   * **This can go negative, deliberately.** `total` can legitimately be
   * smaller than what is on screen: the two sections are independent requests
   * and either can land first, so a toggle that refreshes the wardrobe before
   * the analytics leaves `shown` ahead for a round trip. "Showing 2 of 1" is
   * worse than silence.
   *
   * A `Math.max(0, …)` clamp was written here first and then removed, because
   * every read of this value is a `> 0` comparison — so the clamp could not
   * change any output, and no mutation could kill it. It read as a tested
   * guard while covering nothing, which is worse than not having it. What
   * actually holds the property is the pair of `hidden > 0` tests below, and
   * `adds no note when the wardrobe is ahead of the analytics snapshot` is the
   * one that pins the negative case.
   */
  const hidden = total === undefined ? 0 : total - shown.length;

  // A full wardrobe load with nothing renderable behind it. `activity ===
  // 'loading'` and not `!== 'idle'`: a refresh keeps the rows and whatever
  // sentence is under them, exactly as the history list keeps its empty state.
  const loading = activity === 'loading' && shown.length === 0;

  // Can the section speak for the whole wardrobe? Either the server counted it
  // (`total` present, so `hidden` is exact) or this page is all of it.
  const sees = total !== undefined || !hasMore;

  return (
    <View testID="laundry-list" style={styles.section}>
      <Text style={styles.heading}>In the wash</Text>

      {error !== null ? (
        <View testID="laundry-error" style={styles.errorBanner}>
          <Text testID="laundry-error-message" style={styles.errorText}>
            {error}
          </Text>
          <Pressable
            testID="laundry-retry"
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Try loading your wardrobe again"
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {shown.map((item) => (
        // Keyed by id. A plain map rather than a list — the wash is short by
        // construction and this section sits inside another list's header, so
        // a nested VirtualizedList would be both wrong and noisy — but the key
        // rule is the same one and for the same reason: an index key hands a
        // reused row the thumbnail already mounted in it when an item leaves
        // the wash and everything after it shifts up.
        <LaundryRow key={item.id} item={item} onOpen={onOpen} />
      ))}

      {/* A failed load is not an empty wash and is not a load in flight, so
          nothing below renders under an error: telling a user with four shirts
          in the machine that there is nothing in it is both false and
          unrecoverable-looking. */}
      {error !== null ? null : loading ? (
        <View testID="laundry-loading" style={styles.centre}>
          <ActivityIndicator />
        </View>
      ) : shown.length === 0 ? (
        hidden > 0 ? (
          <Text testID="laundry-elsewhere" style={styles.note}>
            {`${countLabel(hidden)} in the wash — find them on ${ELSEWHERE}.`}
          </Text>
        ) : sees ? (
          <Text testID="laundry-empty" style={styles.note}>
            Nothing in the wash.
          </Text>
        ) : (
          <Text testID="laundry-partial" style={styles.note}>
            {`Nothing in the wash on the first page of your wardrobe — check ${ELSEWHERE} for the rest.`}
          </Text>
        )
      ) : hidden > 0 ? (
        <Text testID="laundry-note" style={styles.note}>
          {`Showing ${shown.length} of ${total} — find the rest on ${ELSEWHERE}.`}
        </Text>
      ) : sees ? null : (
        <Text testID="laundry-partial" style={styles.note}>
          {`Showing what is in the wash on the first page of your wardrobe — check ${ELSEWHERE} for the rest.`}
        </Text>
      )}
    </View>
  );
}

function LaundryRow({
  item,
  onOpen,
}: {
  item: PublicClothingItem;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  // Pre-Stage-4 uploads have no thumbnail and the full image is what keeps
  // them visible — the same fallback `ItemTile` makes.
  const uri = item.thumbnailUrl ?? item.imageUrl;
  const colourNames = item.colors.map((colour) => colour.name).filter((name) => name.length > 0);
  // The category alone makes two white shirts indistinguishable, which is the
  // exact question this list is answering: *which* shirt is in the machine.
  const described = colourNames.length > 0 ? `${item.category}, ${colourNames.join(', ')}` : item.category;

  return (
    <Pressable
      testID={`laundry-item-${item.id}`}
      onPress={() => onOpen(item.id)}
      accessibilityRole="button"
      accessibilityLabel={described}
      // Not "removes this item from the laundry". The row navigates; it
      // changes nothing. A screen reader announcing a mutation that does not
      // happen is worse than announcing nothing, and the status itself is
      // implied by the section this row is inside.
      accessibilityHint="Opens this item's details"
      style={styles.row}
    >
      <Image
        testID={`laundry-image-${item.id}`}
        source={{ uri }}
        style={styles.thumbnail}
        resizeMode="cover"
        accessible={false}
      />
      <Text style={styles.rowText} numberOfLines={1}>
        {described}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: space.gutter, paddingTop: space.xxl, gap: space.sm },
  heading: { ...text.heading },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 7 },
  thumbnail: { width: 40, height: 40, borderRadius: 11, backgroundColor: color.cloud },
  rowText: { flex: 1, ...text.name },
  note: { ...text.meta, fontSize: 13.5 },
  centre: { paddingVertical: space.md, alignItems: 'flex-start' },
  errorBanner: { padding: space.lg, borderRadius: radius.lg, backgroundColor: color.wash, gap: space.md },
  errorText: { ...text.body, fontSize: 13.5, color: color.washInk },
  retryButton: {
    alignSelf: 'flex-start',
    backgroundColor: color.washInk,
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  retryText: { fontFamily: font.semibold, fontSize: 13, color: color.wash },
});
