import React from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PublicClothingItem, PublicUsageAnalytics } from '@wardrobe/shared';
import { categoryLabel } from '../format/text';
import { color, radius, space } from '../theme/tokens';
import { font, text } from '../theme/type';
import { countLabel, wearLabel } from '../format/text';
import type { UsageAnalyticsActivity } from './useUsageAnalytics';

export interface UsageAnalyticsPanelProps {
  /**
   * `null` means "the first load has not landed", **not** "everything is
   * zero", and this component must never collapse the two.
   *
   * `useUsageAnalytics` hands over `null` deliberately rather than a zeroed
   * placeholder, and its header says why: the API answers `totalWears: 0` for
   * a genuinely empty wardrobe, so a zeroed object is indistinguishable from a
   * real answer. A `?? { mostWorn: [], leastWorn: [], totalWears: 0, … }` here
   * would put the empty state — the one that tells a new user what this
   * section will show them — on screen for the length of every request,
   * including the ones that are about to come back full.
   */
  analytics: PublicUsageAnalytics | null;
  activity: UsageAnalyticsActivity;
  /** A ready-to-render message, or `null` if the last request succeeded. */
  error: string | null;
  onRetry: () => void;
}

/**
 * Phase 3's promise, on the Profile tab: "View usage analytics showing
 * most/least worn items" (FR6).
 *
 * The section has its own retry, and `activity` is what makes that retry
 * visible. The two axes are orthogonal on purpose: `error` says what happened
 * last, `activity` says what is in flight now. Pressing "Try again" over a
 * stale snapshot clears the banner in the same commit that starts the request
 * — the hook clears `error` when a request STARTS, not when it succeeds — so
 * without this line the only feedback for that press is the numbers changing
 * some seconds later, or not changing at all if they were already current.
 */
export function UsageAnalyticsPanel({
  analytics,
  activity,
  error,
  onRetry,
}: UsageAnalyticsPanelProps): React.JSX.Element {
  return (
    <View testID="usage-analytics" style={styles.section}>
      <Text style={styles.heading}>Usage</Text>

      {error !== null ? (
        <View testID="usage-error" style={styles.errorBanner}>
          {/* The message carries its own testID: the banner also contains the
              retry button's label, and RNTL's `toHaveTextContent` compares a
              string matcher by exact equality after normalisation. */}
          <Text testID="usage-error-message" style={styles.errorText}>
            {error}
          </Text>
          <Pressable
            testID="usage-retry"
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Try loading your usage analytics again"
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {analytics === null ? (
        // The `error === null` guard is load-bearing rather than defensive:
        // after a failed first load nothing is in flight — `activity` is back
        // to `'idle'` — so a spinner beside the banner would promise a retry
        // that nobody started.
        error === null ? (
          <View testID="usage-loading" style={styles.centre}>
            <ActivityIndicator />
          </View>
        ) : null
      ) : (
        <View>
          {/* Only over a snapshot that is already on screen. While
              `analytics === null` the spinner above is the progress
              indication, and two of them for one request is noise. */}
          {activity === 'refreshing' ? (
            <Text testID="usage-refreshing" style={styles.refreshing}>
              Updating…
            </Text>
          ) : null}
          <Snapshot analytics={analytics} />
        </View>
      )}
    </View>
  );
}

function Snapshot({ analytics }: { analytics: PublicUsageAnalytics }): React.JSX.Element {
  /**
   * When is there a ranking to show?
   *
   * Not "are the lists non-empty". The API ranks on `ClothingItem.wearCount`,
   * so a forty-item wardrobe nobody has worn yet comes back with two FULL
   * lists of items at zero — an arbitrary ordering of a column of zeroes,
   * presented under the words "Most worn". That is worse than saying nothing,
   * because it looks like an answer.
   *
   * `totalWears === 0` is exactly "no wear has ever been logged", so it covers
   * the literal empty wardrobe (both lists empty) and the unworn one (both
   * lists full, both meaningless) with one rule.
   *
   * The second clause is not implied by the first for any response this API
   * can produce — nothing deletes an item, so a non-zero `totalWears` means
   * items exist. It is here because "two headings with nothing under them" is
   * the one output this panel must never have, and a rule that holds only
   * while the server stays self-consistent is a rule with a hole in it. It is
   * asserted directly, so it is not unkillable decoration.
   */
  const hasRanking =
    analytics.totalWears > 0 && (analytics.mostWorn.length > 0 || analytics.leastWorn.length > 0);

  return (
    <View>
      {/* The scalars are facts whether or not there is a ranking, and "0 wears
          logged" is what makes the empty state's explanation concrete. */}
      <View testID="usage-summary" style={styles.summary}>
        {/* The count is set in the serif at three times the size of the words
            beside it, as a NESTED `<Text>` rather than a sibling. That is not a
            style detail: a sibling would split the accessible name into "52"
            and "wears logged" as two nodes, and the string a screen reader — and
            this component's own tests — read back is the concatenation of the
            children with no separator, so "52wears logged". Nested, the space in
            the template literal survives. */}
        <Text testID="usage-total-wears" style={styles.summaryText}>
          <Text style={styles.summaryNumber}>{analytics.totalWears}</Text>
          {` ${wearLabel(analytics.totalWears).replace(/^\d+\s/, '')} logged`}
        </Text>
        <Text testID="usage-items-in-laundry" style={styles.summaryText}>
          <Text style={styles.summaryNumber}>{analytics.itemsInLaundry}</Text>
          {` ${countLabel(analytics.itemsInLaundry).replace(/^\d+\s/, '')} in the wash`}
        </Text>
      </View>

      {hasRanking ? (
        <View>
          <Leaderboard testIDPrefix="most" title="Most worn" items={analytics.mostWorn} />
          {/* `mostWorn` and `leastWorn` can OVERLAP, and that is correct rather
              than something to hide: a wardrobe of three items has all three in
              both lists. Subtracting one from the other would make "least worn"
              mean "least worn, excluding some items that are worn even less".
              The two lists carry different testID prefixes so one item in both
              is two addressable rows rather than a collision. */}
          <Leaderboard testIDPrefix="least" title="Least worn" items={analytics.leastWorn} />
        </View>
      ) : (
        <View testID="usage-empty" style={styles.centre}>
          <Text style={styles.emptyTitle}>No wears logged yet</Text>
          {/* Names what will appear and where the action is. An empty state
              that does not say what it is waiting for is a dead end, and this
              is the first thing a new user sees in this section. */}
          <Text style={styles.emptyHint}>
            Log a wear from any outfit and your most- and least-worn items will show up here.
          </Text>
        </View>
      )}
    </View>
  );
}

function Leaderboard({
  testIDPrefix,
  title,
  items,
}: {
  testIDPrefix: 'most' | 'least';
  title: string;
  items: PublicClothingItem[];
}): React.JSX.Element {
  return (
    <View testID={`usage-${testIDPrefix}-worn`} style={styles.board}>
      <Text style={styles.boardTitle}>{title}</Text>
      {items.map((item) => (
        // Keyed by id. This is a plain map rather than a list, so there is no
        // `keyExtractor` — but the same rule applies for the same reason, and
        // it is cheaper here: an index key would hand a reused row the
        // thumbnail already mounted in it when the ranking changes order.
        <LeaderRow key={item.id} testIDPrefix={testIDPrefix} item={item} />
      ))}
    </View>
  );
}

function LeaderRow({
  testIDPrefix,
  item,
}: {
  testIDPrefix: 'most' | 'least';
  item: PublicClothingItem;
}): React.JSX.Element {
  // Pre-Stage-4 uploads have no thumbnail and the full image is what keeps
  // them visible — the same fallback `ItemTile` makes.
  const uri = item.thumbnailUrl ?? item.imageUrl;
  const spoken = `${item.category}, ${wearLabel(item.wearCount)}`;

  return (
    <View
      testID={`usage-${testIDPrefix}-${item.id}`}
      style={styles.row}
      // A thumbnail, a category and a number are three stops for a screen
      // reader, and the number means nothing read apart from the garment.
      accessible
      accessibilityLabel={spoken}
    >
      <Image
        testID={`usage-${testIDPrefix}-image-${item.id}`}
        source={{ uri }}
        style={styles.thumbnail}
        resizeMode="cover"
        // Decorative: the row above already carries the label, and an image
        // label would make a screen reader read every row twice.
        accessible={false}
      />
      {/* The category as a word — "T-shirt", not the wire's `tshirt`. The
          SPOKEN label above keeps the wire spelling, so a screen reader hears
          the same name every other surface in this app uses. */}
      <Text style={styles.rowCategory} numberOfLines={1}>
        {categoryLabel(item.category)}
      </Text>
      <Text testID={`usage-${testIDPrefix}-count-${item.id}`} style={styles.rowCount}>
        {wearLabel(item.wearCount)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: space.gutter, paddingTop: space.xxl, gap: space.sm },
  heading: { ...text.heading },
  summary: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  // Each headline number gets its own card, so "52 wears" and "1 in the wash"
  // read as two facts rather than one sentence with a comma in it.
  summaryNumber: { fontFamily: font.displayMedium, fontSize: 26, color: color.ink },
  summaryText: {
    flex: 1,
    ...text.meta,
    fontSize: 13,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    overflow: 'hidden',
  },
  board: { marginTop: space.lg, gap: space.xs },
  boardTitle: { ...text.label },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 6 },
  thumbnail: { width: 40, height: 40, borderRadius: 11, backgroundColor: color.cloud },
  rowCategory: { flex: 1, ...text.name },
  // The count is the ranking key, so it is set in the serif at a size that
  // makes the leaderboard readable as a ranking rather than as a list.
  rowCount: { fontFamily: font.displayMedium, fontSize: 18, color: color.ink },
  refreshing: { ...text.meta, fontFamily: font.displayItalic, fontSize: 13 },
  centre: { paddingVertical: space.xl, alignItems: 'center', gap: 6 },
  emptyTitle: { ...text.title, fontSize: 16 },
  emptyHint: { ...text.meta, fontSize: 13.5, textAlign: 'center' },
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
