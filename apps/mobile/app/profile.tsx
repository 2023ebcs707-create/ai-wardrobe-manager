import React, { useCallback } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import type { PublicWearEvent } from '@wardrobe/shared';
import { useAuth } from '../src/auth/AuthContext';
import { HealthBanner } from '../src/components/HealthBanner';
import { API_BASE_URL } from '../src/config';
import { LaundryList } from '../src/tracking/LaundryList';
import { UsageAnalyticsPanel } from '../src/tracking/UsageAnalyticsPanel';
import { WearHistoryRow } from '../src/tracking/WearHistoryRow';
import { consumeTrackingDirty } from '../src/tracking/trackingDirty';
import { useUsageAnalytics } from '../src/tracking/useUsageAnalytics';
import { useWearHistory } from '../src/tracking/useWearHistory';
import { useWardrobe } from '../src/wardrobe/useWardrobe';
import { color, space } from '../src/theme/tokens';
import { text } from '../src/theme/type';
import { Avatar, Button, EmptyState, ErrorPlate, screen as screenStyles } from '../src/theme/ui';

/**
 * The history's React key. **Never the array index.**
 *
 * Be precise about when that matters, because a paging test cannot tell the
 * two apart at all. `FlatList` keys each cell *within* a row by its column
 * index — `<React.Fragment key={kk}>` in FlatList.js — so this extractor only
 * ever sets the **row** key, and a pure page append leaves every existing
 * row's item-to-position mapping untouched. Stage 4 verified that directly:
 * with `keyExtractor={(_item, index) => String(index)}` in place, all 28 of
 * its screen tests passed.
 *
 * The defect bites on **replacement**, and this list produces one on its own
 * without any refresh gesture from the user: a newly logged wear sorts to the
 * top by `wornAt`, so the focus gate below reloads page one and every row that
 * was on screen moves down one position while the list stays mounted
 * (`activity` goes to `'refreshing'`, not `'loading'`, so the rows are kept).
 * Under index keys React reuses each cell for a different wear.
 *
 * Exported so the contract is directly assertable; the mount probe in
 * `__tests__/profile.keys.test.tsx` catches the same defect through public
 * queries only, and catches it when the extractor is replaced inline here.
 */
export const wearEventKeyExtractor = (event: PublicWearEvent): string => event.id;

/**
 * The Profile tab: who is signed in, the wear history (FR6 / TC-08), the usage
 * analytics Phase 3 promises, and the laundry list (FR7).
 *
 * ## Why the wear history is the screen's list rather than a section in it
 *
 * The history is the only unbounded thing here — the analytics is a fixed
 * top-N snapshot and the wash is short by construction — so it is the only one
 * that needs virtualising. The obvious arrangement (a `ScrollView` of sections
 * with the history list inside it) nests a `VirtualizedList` in a plain
 * `ScrollView`, which makes the list render every row it holds instead of a
 * window. So it is the other way round: one list, and everything else is its
 * header and footer. That also makes the pull-to-refresh gesture cover the
 * whole screen rather than one section of it.
 *
 * **No test in this repo catches the nested arrangement, and an earlier
 * version of this comment implied one would.** React Native does carry a check
 * — `@react-native/virtualized-lists@0.86.2/Lists/VirtualizedList.js:1153-1165`
 * logs "VirtualizedLists should never be nested inside plain ScrollViews with
 * the same orientation" — but it is guarded on `ScrollView.Context` being
 * populated, and under jest-expo it is not. Measured twice: wrapping this
 * screen's `FlatList` in a `ScrollView` left all 32 Profile tests green with
 * zero warning lines, and so did a four-line probe of `ScrollView > FlatList`
 * on its own. So this arrangement is held by the reasoning above and by the
 * device gate, not by the suite.
 *
 * ## Three requests, three error channels
 *
 * Each section owns its own banner and its own retry, and the retries are NOT
 * wired together. These are three independent endpoints — one can fail while
 * the other two are fine — and a single screen-wide "Try again" would re-issue
 * two requests that had just succeeded, one of which signs a URL per returned
 * item server-side. The pull-to-refresh gesture is the deliberate exception:
 * it is one gesture that means "all of it".
 */
export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const router = useRouter();

  const { events, activity, error, loadMore, refresh } = useWearHistory();
  const {
    analytics,
    activity: analyticsActivity,
    error: analyticsError,
    refresh: refreshAnalytics,
  } = useUsageAnalytics();
  // `category`, `setCategory` and `loadMore` are deliberately not taken. This
  // is the wardrobe read at its default filter — every category, page one —
  // and the laundry list narrows it locally. Paging it from here would be a
  // second infinite scroll inside another list's header.
  //
  // `hasMore` IS taken, and it is not bookkeeping: it is what tells the
  // laundry section whether the page it is filtering is the whole wardrobe.
  // Without it that section cannot tell "nothing is in the wash" from "nothing
  // on this page is in the wash" and says the first one either way.
  const {
    items,
    activity: wardrobeActivity,
    error: wardrobeError,
    refresh: refreshWardrobe,
    hasMore: wardrobeHasMore,
  } = useWardrobe();

  const openItem = useCallback(
    (id: string) => {
      router.push(`/items/${id}`);
    },
    [router],
  );

  /**
   * One gesture, three requests.
   *
   * Refreshing only the history would leave the leaderboard and the laundry
   * list showing figures from before the pull, on the same screen as freshly
   * loaded rows — and the two sections that would be stale are exactly the two
   * a wear or a toggle moves.
   *
   * Each hook's `refresh` is already a no-op while its own full-list load is
   * running, so a double pull costs nothing.
   */
  const refreshAll = useCallback(() => {
    refresh();
    refreshAnalytics();
    refreshWardrobe();
  }, [refresh, refreshAnalytics, refreshWardrobe]);

  /**
   * Refetch when this tab comes back into view **and something actually
   * changed** — never merely because it came back.
   *
   * `'profile'` has been a declared `TrackingReader` since Task 4 with nothing
   * consuming it; this is the consumer. All three hooks key their fetch
   * effects on `[token]` alone and Expo Router keeps this tab mounted while
   * the item and outfit detail screens are pushed over it, so a laundry
   * toggle, a logged wear and a deleted outfit are all invisible on return.
   * A wear the user logged thirty seconds ago missing from the history list is
   * TC-08's claim ("visible in history list") failing on the screen that makes
   * it.
   *
   * **The gate is the whole design, and refreshing unconditionally would be a
   * regression** — the same one Stage 5 shipped and removed on the outfit
   * gallery. `refresh()` is a page-ONE load that replaces the list, so an
   * ungated focus effect throws away every page of history the user has
   * scrolled back through.
   *
   * `consumeTrackingDirty` reads and clears, so one write causes exactly one
   * reload rather than one per focus for the rest of the session — and it is
   * keyed by reader, so the wardrobe grid consuming its own copy does not
   * blind this tab. That per-reader split is the entire reason
   * `src/tracking/trackingDirty.ts` is not `outfitsDirty`.
   *
   * `useCallback` is not optional. `useFocusEffect` lists `effect` in its own
   * `useEffect` deps, so an inline arrow would re-run this on every render —
   * and this effect fetches, and a fetch renders.
   */
  useFocusEffect(
    useCallback(() => {
      if (consumeTrackingDirty('profile')) refreshAll();
    }, [refreshAll]),
  );

  return (
    <SafeAreaView style={screenStyles.root} edges={['top']}>
      {/* Profile is reached from the avatar in each tab's header rather than
          from a tab of its own — five slots, six destinations, and the wear
          calendar earns the fifth. So this screen is PUSHED, and it owes the
          user a way back that the tab bar used to provide. */}
      <View style={styles.bar}>
        <Pressable
          testID="profile-back"
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => [styles.back, pressed ? styles.pressed : null]}
        >
          <Ionicons name="chevron-back" size={20} color={color.ink} />
        </Pressable>
      </View>

      <FlatList
        testID="wear-history"
        data={events}
        keyExtractor={wearEventKeyExtractor}
        renderItem={({ item }) => <WearHistoryRow event={item} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        // Every section, not just the history. The gesture is over the whole
        // screen — the other two are inside this list's header — so a spinner
        // that stops while the leaderboard below is still being replaced
        // reports the wrong thing about the pull the user just made.
        refreshing={
          activity === 'refreshing' ||
          analyticsActivity === 'refreshing' ||
          wardrobeActivity === 'refreshing'
        }
        onRefresh={refreshAll}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View>
            <View style={styles.identity}>
              <Avatar initials={initialsOf(user?.name)} size={54} />
              <View style={styles.who}>
                <Text style={styles.name} numberOfLines={1}>
                  {user?.name ?? ''}
                </Text>
                <Text style={styles.email} numberOfLines={1}>
                  {user?.email ?? ''}
                </Text>
              </View>
            </View>

            <UsageAnalyticsPanel
              analytics={analytics}
              activity={analyticsActivity}
              error={analyticsError}
              onRetry={refreshAnalytics}
            />

            <LaundryList
              items={items}
              // Both of these are what stop the section stating a fact it does
              // not have. `activity` distinguishes "no garments in the wash"
              // from "no request has come back yet" — the same array either
              // way — and `hasMore` distinguishes "the wash is empty" from
              // "the wash is empty on the 24 items I can see".
              activity={wardrobeActivity}
              hasMore={wardrobeHasMore}
              // `itemsInLaundry` is a count over the WHOLE wardrobe, while
              // `items` is page one of it. Handing both over is what lets the
              // list say so rather than contradict the number three lines
              // above it. `undefined` while the snapshot is missing, never 0:
              // "not loaded" and "none" are different answers.
              total={analytics?.itemsInLaundry}
              onOpen={openItem}
              error={wardrobeError}
              onRetry={refreshWardrobe}
            />

            <View style={styles.historyHeader}>
              <Text style={styles.heading}>Wear history</Text>
              {/* The message carries its own testID: the plate also holds the
                  retry button's label, and RNTL's `toHaveTextContent` compares
                  a string matcher by exact equality after normalisation. */}
              {error !== null ? (
                <ErrorPlate
                  testID="wear-history-error"
                  messageTestID="wear-history-error-message"
                  retryTestID="wear-history-retry"
                  message={error}
                  onRetry={refresh}
                  retryAccessibilityLabel="Try loading your wear history again"
                  style={styles.historyError}
                />
              ) : null}
            </View>
          </View>
        }
        ListEmptyComponent={
          // Rendered only when `events` is empty, so a `length === 0` conjunct
          // in either branch below would be a conjunct no mutation can kill.
          //
          // `activity === 'loading'` and not `!== 'idle'`: a `refreshing` load
          // keeps the rows on screen, and the empty state IS this list's rows
          // when it has none — so swapping it for a spinner on a pull would
          // take away the only instruction the section offers at the only
          // moment it matters.
          activity === 'loading' ? (
            <View testID="wear-history-loading" style={styles.centre}>
              <ActivityIndicator size="large" color={color.soft} />
            </View>
          ) : error === null ? (
            // A failed load is not an empty history. Without this guard the
            // screen tells a user who has logged forty wears that they have
            // logged none, which is both false and unrecoverable-looking; the
            // banner in the header is what that user gets instead.
            <EmptyState
              testID="wear-history-empty"
              title="No wears logged yet"
              hint="Open a day on the calendar, or an outfit, and log what you wore."
            />
          ) : null
        }
        ListFooterComponent={
          <View>
            {activity === 'loadingMore' ? (
              <View testID="wear-history-loading-more" style={styles.footer}>
                <ActivityIndicator color={color.soft} />
              </View>
            ) : null}

            {/* Stage 0 developer scaffolding, moved here from the Home tab in
                Stage 4 Task 4. It does not belong on the product's main screen
                — the wardrobe grid is what FR4 and TC-06 describe — but the
                diagnostic is genuinely useful when the API, MinIO or the AI
                service is down, so it is relocated rather than deleted.

                In the FOOTER rather than beside the sign-out button, where
                Stage 4 left it: three product sections now sit on this screen,
                and a diagnostic above them would be the first thing a user
                reads on their own profile. It is still one screen away, which
                is all its relocation ever promised. */}
            <View style={styles.calendarLink}>
              <Button
                testID="profile-calendar"
                label="Open the calendar"
                variant="ghost"
                onPress={() => router.replace('/(tabs)/calendar')}
              />
            </View>

            <View style={styles.diagnostics}>
              <Text style={styles.sectionLabel}>Service status</Text>
              <HealthBanner baseUrl={API_BASE_URL} />
            </View>

            {/* Last, and quiet. Signing out is the one irreversible thing on
                this screen and it is not what anybody opened it for. */}
            <View style={styles.signOut}>
              <Button
                testID="profile-signout"
                label="Sign out"
                variant="ghost"
                onPress={() => signOut()}
              />
            </View>
          </View>
        }
      />
    </SafeAreaView>
  );
}

function initialsOf(name: string | undefined): string {
  if (name === undefined || name.trim() === '') return '?';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: space.md, paddingTop: space.sm },
  back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },

  content: { paddingBottom: space.xxl },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: space.gutter,
    paddingTop: space.sm,
  },
  who: { flex: 1, minWidth: 0 },
  name: { ...text.display, fontSize: 24, lineHeight: 28 },
  email: { ...text.meta, fontSize: 13, marginTop: 2 },

  historyHeader: { paddingHorizontal: space.gutter, paddingTop: space.xxl, paddingBottom: space.xs, gap: space.sm },
  heading: { ...text.heading },
  historyError: { marginHorizontal: 0 },

  centre: { paddingVertical: 32, alignItems: 'center', gap: 6 },
  footer: { paddingVertical: space.lg },

  calendarLink: { paddingHorizontal: space.gutter, paddingTop: space.xxl },
  diagnostics: { paddingHorizontal: space.gutter, paddingTop: space.xxl, gap: space.xs },
  sectionLabel: { ...text.label },
  signOut: { paddingHorizontal: space.gutter, paddingTop: space.xl },

  pressed: { opacity: 0.72 },
});
