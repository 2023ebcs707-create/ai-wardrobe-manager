import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import type { PublicClothingItem } from '@wardrobe/shared';
import { useAuth } from '../../src/auth/AuthContext';
import { WeekStrip } from '../../src/calendar/WeekStrip';
import { indexWearsByDay, localDayKey, weekOf, weekRangeLabel } from '../../src/calendar/month';
import { useSuggestions } from '../../src/suggestions/useSuggestions';
import { consumeTrackingDirty } from '../../src/tracking/trackingDirty';
import { useWearHistory } from '../../src/tracking/useWearHistory';
import { useItemIndex } from '../../src/wardrobe/useItemIndex';
import { CategoryFilter } from '../../src/wardrobe/CategoryFilter';
import { ItemTile } from '../../src/wardrobe/ItemTile';
import { useWardrobe } from '../../src/wardrobe/useWardrobe';
import { color, space } from '../../src/theme/tokens';
import { text } from '../../src/theme/type';
import {
  Avatar,
  EmptyState,
  ErrorPlate,
  InkPanel,
  ScreenHeader,
  Strip,
  screen,
} from '../../src/theme/ui';

/**
 * The grid's React key. **Never the array index.**
 *
 * Be precise about when that matters, because an earlier version of this
 * comment was not. `FlatList` keys each cell *within* a row by its column
 * index — `<React.Fragment key={kk}>` in FlatList.js — so this extractor only
 * ever sets the **row** key. A pure page append therefore changes no existing
 * row's item-to-position mapping, and id keys and index keys reconcile
 * identically: paging alone cannot tell them apart, however it is asserted.
 *
 * The defect bites on **replacement**, where position 0 becomes a different
 * garment. In this screen that is a refresh whose response differs from what
 * is on screen: `refresh()` keeps the rows mounted (`activity` goes to
 * `'refreshing'`, not `'loading'`) and then swaps `items` wholesale. With
 * index keys the row key is unchanged, so React reuses each cell — and the
 * image already mounted in it — for a different item. A category change ends
 * up at the same place but usually escapes it by accident: the hook clears
 * `items` first, which trips `showFirstPageSpinner` and unmounts the list.
 *
 * Exported so the contract is directly assertable; see also the mount probe in
 * `__tests__/index.keys.test.tsx`, which catches the same defect through
 * public queries only.
 */
export const wardrobeKeyExtractor = (item: PublicClothingItem): string => item.id;

/**
 * The digital wardrobe — FR4, and the screen TC-06 names: "All user's clothing
 * items displayed in a grid; filter by category works."
 *
 * Every screen state is derived from the hook's *two* axes rather than one
 * field. `activity` says what is in flight; `error` says what happened last,
 * and the two can be true at once (a retry running over a previous failure).
 *
 * ## Two columns, not three
 *
 * The Soft direction trades a third of the density for a caption under every
 * garment — the category, the colour the AI measured, and the wear count — and
 * for the glow that lights each card from its own palette. That is the trade
 * this screen exists to make: a wardrobe app whose grid is photographs alone
 * cannot answer "what am I not wearing", which is the question the wear count
 * is there for.
 */
export default function HomeScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { items, category, setCategory, activity, error, loadMore, refresh } = useWardrobe();
  const { snapshot } = useSuggestions();

  /**
   * The week strip's two reads, and the only two requests on this screen that
   * are not the grid itself.
   *
   * `useWearHistory`'s first page is 24 events, which covers a week many times
   * over, so it never pages here. `useItemIndex` is the expensive one — it
   * walks `GET /items` to turn the ids a wear event snapshots into
   * photographs, because a wear record deliberately stores nothing else. It is
   * worth it precisely here: the gap in a wear log is what makes the log
   * useless, and a gap you can see on the screen you open every morning is one
   * you actually fill in.
   *
   * Both degrade to nothing rather than to an error. A week strip is a glance,
   * and the grid below it is the screen; a banner about the wear history
   * failing would be a report about something the user did not ask for.
   */
  const { events } = useWearHistory();
  const { byId: itemsById } = useItemIndex();

  // Once per mount, not per render: a strip that silently reshaped itself at
  // midnight would be worse than one that is a day stale until the next open.
  const [now] = useState(() => new Date());
  const todayKey = localDayKey(now);
  const week = useMemo(() => weekOf(now), [now]);
  const wearsByDay = useMemo(() => indexWearsByDay(events), [events]);

  const openItem = useCallback(
    (id: string) => {
      router.push(`/items/${id}`);
    },
    [router],
  );

  /**
   * Refetch when this tab comes back into view **and a tracked field actually
   * changed** — never merely because it came back.
   *
   * This is TC-09's last mile. The laundry toggle lives on the item detail
   * screen, which Expo Router pushes OVER this tab while it stays mounted, and
   * `useWardrobe`'s fetch effect keys on `[token, category]` alone — so
   * nothing about returning here re-reads the list. Without this gate the
   * garment the user just put in the wash keeps rendering as available until
   * they happen to pull to refresh or restart the app: the badge would exist,
   * be correct, pass every unit test, and never appear on the screen TC-09
   * names ("item visually distinguished **in wardrobe**").
   *
   * **The gate is the whole design, and refreshing unconditionally would be a
   * regression** — the same one Stage 5 shipped and removed on the outfit
   * gallery. `refresh()` is a page-ONE load that replaces the list, so an
   * ungated focus effect throws away every page the user has scrolled to:
   * browse, open an item, come back, keep browsing is this screen's primary
   * loop and it breaks for anyone past the server's 24-per-page default.
   *
   * `consumeTrackingDirty` reads and clears, so one change causes exactly one
   * reload rather than one per focus for the rest of the session — and it is
   * keyed by reader, so consuming here does not blind the Profile tab. See
   * `src/tracking/trackingDirty.ts` for why that is not the outfit gallery's
   * single shared bit.
   *
   * `useCallback` is not optional. `useFocusEffect` lists `effect` in its own
   * `useEffect` deps, so an inline arrow would re-run this on every render —
   * and this effect fetches, and a fetch renders.
   */
  useFocusEffect(
    useCallback(() => {
      if (consumeTrackingDirty('wardrobe')) refresh();
    }, [refresh]),
  );

  // A full-list load with nothing behind it. `activity === 'loading'` alone is
  // not enough: on a category change the hook clears `items` and reloads, and
  // this is exactly that case — but a `refreshing` load keeps its rows, so it
  // must not blank the screen.
  const showFirstPageSpinner = activity === 'loading' && items.length === 0;

  // A failed load is not an empty wardrobe. Without the `error === null` guard
  // the screen would tell a user whose request just failed that they own
  // nothing, which is both false and unrecoverable-looking.
  const showEmptyState = activity === 'idle' && items.length === 0 && error === null;

  // The first suggestion, and only ever the first: this is a glance, not the
  // shortlist. The Add tab is where all of them live, and duplicating the list
  // here would make the same content the answer to two different questions.
  const today = snapshot?.suggestions[0];

  const header = (
    <>
      <ScreenHeader
        hi={greeting(user?.name)}
        title={<Text style={text.display}>{wardrobeLine(items.length, category !== null)}</Text>}
        right={
          <Pressable
            testID="wardrobe-profile"
            onPress={() => router.push('/profile')}
            accessibilityRole="button"
            accessibilityLabel="Your profile"
          >
            <Avatar initials={initialsOf(user?.name)} />
          </Pressable>
        }
      />

      {/* The one dark surface in the app, and it earns it: this is the app's
          own answer to the only question a wardrobe app is really asked. It is
          absent rather than empty when there is no suggestion — a card reading
          "no ideas" is worse than no card. */}
      {today === undefined ? null : (
        <Pressable
          testID="wardrobe-today"
          onPress={() => router.push('/(tabs)/add')}
          accessibilityRole="button"
          accessibilityLabel="Today you could wear this outfit. Opens the suggestions."
          style={styles.today}
        >
          <InkPanel glow={today.items.flatMap((item) => item.colors)}>
            <Text style={styles.todayLabel}>Today you could wear</Text>
            <View style={styles.todayStrip}>
              <Strip uris={today.items.map((item) => item.thumbnailUrl ?? item.imageUrl)} />
            </View>
            {/* The rule engine's own sentence, verbatim. It explains a colour
                decision in words a person actually uses ("navy and white sit
                opposite each other"), and paraphrasing it here would be a
                second, worse explanation of the same thing. */}
            <Text style={styles.todayWhy}>{today.rationale}</Text>
          </InkPanel>
        </Pressable>
      )}

      {/* Outside the list on purpose: the filter must stay reachable while the
          first page is loading and while an error is showing, which it would
          not be as a ListHeaderComponent behind a spinner. */}
      {/* The calendar's idea, one week wide. */}
      <View testID="wardrobe-week-heading" style={styles.weekHeading}>
        <Text style={styles.weekTitle}>This week</Text>
        <Text style={styles.weekRange}>{weekRangeLabel(week)}</Text>
      </View>
      <WeekStrip
        days={week}
        wearsByDay={wearsByDay}
        itemsById={itemsById}
        todayKey={todayKey}
        onOpen={() => router.push('/(tabs)/calendar')}
      />

      <CategoryFilter value={category} onChange={setCategory} />

      {error !== null ? (
        <ErrorPlate
          testID="wardrobe-error"
          messageTestID="wardrobe-error-message"
          retryTestID="wardrobe-retry"
          message={error}
          // Wired to `refresh`, never to re-selecting the current chip:
          // `setCategory(currentCategory)` is a no-op because the hook's fetch
          // effect keys on the category value, so a retry built that way
          // would silently do nothing.
          onRetry={refresh}
          retryAccessibilityLabel="Try loading your wardrobe again"
        />
      ) : null}
    </>
  );

  return (
    <SafeAreaView style={screen.root} edges={['top']}>
      {showFirstPageSpinner ? (
        <>
          {header}
          <View testID="wardrobe-loading" style={styles.centre}>
            <ActivityIndicator size="large" color={color.soft} />
          </View>
        </>
      ) : (
        <FlatList
          testID="wardrobe-grid"
          data={items}
          numColumns={2}
          keyExtractor={wardrobeKeyExtractor}
          renderItem={({ item }) => <ItemTile item={item} onPress={openItem} layout="card" />}
          // The header scrolls with the grid rather than sitting above it: the
          // greeting and the suggestion are a glance, not chrome, and pinning
          // them would cost a third of the screen on every scroll.
          ListHeaderComponent={header}
          contentContainerStyle={styles.grid}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          refreshing={activity === 'refreshing'}
          onRefresh={refresh}
          ListEmptyComponent={
            showEmptyState ? (
              category === null ? (
                <EmptyState
                  testID="wardrobe-empty"
                  title="Your wardrobe is empty"
                  hint="Add your first item from the Add tab."
                />
              ) : (
                // Deliberately a different message. "Your wardrobe is empty" is
                // simply false for someone with forty items who filtered to a
                // category they own none of, and it hides the fix (change the
                // filter) behind a statement about the wrong thing.
                //
                // The raw category, not `categoryLabel` — this sentence names
                // the filter the user just chose, and every other surface that
                // reports a filter state uses the same spelling.
                <EmptyState
                  testID="wardrobe-empty-filter"
                  title={`No ${category} items yet`}
                  hint="Pick another category, or add one from the Add tab."
                />
              )
            ) : null
          }
          ListFooterComponent={
            activity === 'loadingMore' ? (
              <View testID="wardrobe-loading-more" style={styles.footer}>
                <ActivityIndicator color={color.soft} />
              </View>
            ) : null
          }
        />
      )}
    </SafeAreaView>
  );
}

/**
 * The title, which says something true about the wardrobe rather than the word
 * "Wardrobe" — the user knows which app they opened.
 *
 * Silent about the count while a filter is on: "3 pieces" under a jacket
 * filter would be read as the size of the whole wardrobe.
 */
function wardrobeLine(count: number, filtered: boolean): string {
  if (filtered) return 'Your wardrobe';
  if (count === 0) return 'Nothing here yet';
  return `${count} ${count === 1 ? 'piece' : 'pieces'}`;
}

/** Reads the clock once per render, which is all a greeting needs. */
function greeting(name: string | undefined): string {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = name?.trim().split(/\s+/)[0];
  return first === undefined || first === '' ? part : `${part}, ${first}`;
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
  // 12 here plus each card's own 8 of padding gives the 20 gutter the rest of
  // the screen aligns to, without a flex `gap` that a partial last row would
  // spread.
  grid: { paddingHorizontal: space.md, paddingBottom: space.xxl },
  centre: { paddingVertical: 48, alignItems: 'center' },
  footer: { paddingVertical: space.lg },

  today: { paddingHorizontal: space.gutter, paddingBottom: 22 },
  weekHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: space.gutter,
    paddingBottom: 13,
  },
  // 17pt, not the 20 a `Section` heading takes: this labels a strip inside the
  // screen, and at 20 it competes with the screen's own title above it.
  weekTitle: { ...text.heading, fontSize: 17 },
  weekRange: { ...text.meta },
  todayLabel: { ...text.label, color: 'rgba(253, 251, 247, 0.62)' },
  todayStrip: { marginTop: 15, marginBottom: 14 },
  todayWhy: { ...text.rationale, color: color.onInk, opacity: 0.9 },
});
