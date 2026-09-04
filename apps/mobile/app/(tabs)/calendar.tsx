import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import type { ItemColor } from '@wardrobe/shared';
import { MonthGrid } from '../../src/calendar/MonthGrid';
import {
  dateFromDayKey,
  indexWearsByDay,
  localDayKey,
  monthCells,
  monthIsCovered,
  monthName,
  shiftMonth,
} from '../../src/calendar/month';
import { useAuth } from '../../src/auth/AuthContext';
import { consumeTrackingDirty } from '../../src/tracking/trackingDirty';
import { useWearHistory } from '../../src/tracking/useWearHistory';
import { useItemIndex } from '../../src/wardrobe/useItemIndex';
import { OCCASION_LEGEND, color, occasionColor, radius, space } from '../../src/theme/tokens';
import { font, text } from '../../src/theme/type';
import {
  Avatar,
  Button,
  ErrorPlate,
  Lozenge,
  Panel,
  Pip,
  ScreenHeader,
  Section,
  Strip,
  screen,
} from '../../src/theme/ui';

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/**
 * FR6, seen sideways: the wear history the app already records, drawn as the
 * month it actually happened in.
 *
 * The list on the Profile tab answers "what have I worn lately"; it cannot
 * answer "how often do I actually reach for this" or "what did I wear to the
 * last three dinners", because a list has no shape. A month grid does, which
 * is the whole reason this screen exists rather than a longer list.
 *
 * NO NEW API. Every byte on this screen comes from `GET /wear-history` and
 * `GET /items`, both of which shipped in earlier stages.
 */
export default function CalendarScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { events, activity, error, loadMore, refresh, hasMore } = useWearHistory();
  const { byId: itemsById } = useItemIndex();

  // `new Date()` once per mount, not per render: the month the user is looking
  // at is state, and re-reading the clock every render would make `todayKey`
  // a new value on a render that happens to cross midnight, silently moving
  // the ring mid-session.
  const [today] = useState(() => new Date());
  const todayKey = localDayKey(today);

  const [cursor, setCursor] = useState(() => ({
    year: today.getFullYear(),
    month: today.getMonth(),
  }));
  const [selectedKey, setSelectedKey] = useState<string>(todayKey);

  const wearsByDay = useMemo(() => indexWearsByDay(events), [events]);
  const cells = useMemo(() => monthCells(cursor.year, cursor.month), [cursor]);

  /**
   * Page backwards until the visible month is definitely complete.
   *
   * `GET /wear-history` is newest-first, so a month older than the first page
   * would otherwise render as a grid of empty days that *looks* like an honest
   * answer — the worst possible failure for this screen, because nothing about
   * it says "still loading". `loadMore` is self-guarding (it returns early
   * while a request is in flight or the cursor is exhausted), so this effect
   * re-runs harmlessly on every page it causes.
   */
  const covered = monthIsCovered(events, hasMore, cursor.year, cursor.month);
  useEffect(() => {
    if (!covered) loadMore();
  }, [covered, loadMore]);

  /** Someone logged a wear elsewhere — the grid is now out of date. */
  useFocusEffect(
    useCallback(() => {
      if (consumeTrackingDirty('calendar')) refresh();
    }, [refresh]),
  );

  const monthPrefix = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}`;
  const loggedThisMonth = Object.keys(wearsByDay).filter((k) => k.startsWith(monthPrefix)).length;

  const goToMonth = useCallback(
    (by: number) => {
      setCursor((current) => {
        const next = shiftMonth(current, by);
        // Selection follows the month rather than being cleared: landing on a
        // month with no selected day would empty the panel below the grid and
        // make the screen look like it lost the user's place.
        setSelectedKey(`${next.year}-${String(next.month + 1).padStart(2, '0')}-01`);
        return next;
      });
    },
    [],
  );

  const selected = wearsByDay[selectedKey];
  const selectedDate = dateFromDayKey(selectedKey);
  const selectedIsAhead = selectedKey > todayKey;

  const selectedItems = useMemo(
    () =>
      selected === undefined
        ? []
        : selected.latest.itemIds
            .map((id) => itemsById[id])
            .filter((item) => item !== undefined),
    [selected, itemsById],
  );
  const selectedColors: ItemColor[] = selectedItems.flatMap((item) => item.colors);

  const showFirstLoad = activity === 'loading' && events.length === 0;

  return (
    <SafeAreaView style={screen.root} edges={['top']}>
      <ScrollView contentContainerStyle={screen.scroll}>
        <ScreenHeader
          hi={`${loggedThisMonth} ${loggedThisMonth === 1 ? 'day' : 'days'} logged in ${monthName(cursor.month)}`}
          title="What you wore"
          right={
            <Pressable
              testID="calendar-profile"
              onPress={() => router.push('/profile')}
              accessibilityRole="button"
              accessibilityLabel="Your profile"
            >
              <Avatar initials={initialsOf(user?.name)} />
            </Pressable>
          }
        />

        {error !== null ? (
          <ErrorPlate
            testID="calendar-error"
            messageTestID="calendar-error-message"
            retryTestID="calendar-retry"
            message={error}
            onRetry={refresh}
            retryAccessibilityLabel="Try loading your wear history again"
          />
        ) : null}

        <View style={styles.calendar}>
          <View style={styles.nav}>
            <Text style={styles.month}>
              {monthName(cursor.month)} <Text style={styles.year}>{cursor.year}</Text>
            </Text>
            <View style={styles.arrows}>
              <NavArrow
                testID="calendar-prev"
                icon="chevron-back"
                label={`Show ${monthName(shiftMonth(cursor, -1).month)}`}
                onPress={() => goToMonth(-1)}
              />
              <NavArrow
                testID="calendar-next"
                icon="chevron-forward"
                label={`Show ${monthName(shiftMonth(cursor, 1).month)}`}
                onPress={() => goToMonth(1)}
              />
            </View>
          </View>

          {showFirstLoad ? (
            <View testID="calendar-loading" style={styles.loading}>
              <ActivityIndicator color={color.soft} />
            </View>
          ) : (
            <MonthGrid
              year={cursor.year}
              month={cursor.month}
              cells={cells}
              wearsByDay={wearsByDay}
              itemsById={itemsById}
              // Null in any month that is not this one, so no cell in a past
              // month is ringed as though it were today.
              todayKey={todayKey.startsWith(monthPrefix) ? todayKey : null}
              selectedKey={selectedKey}
              onSelectDay={setSelectedKey}
            />
          )}

          <View style={styles.legend}>
            {OCCASION_LEGEND.map((entry) => (
              <View key={entry.name} style={styles.legendItem}>
                <Pip hex={entry.hex} size={8} />
                <Text style={styles.legendText}>{entry.name}</Text>
              </View>
            ))}
          </View>
        </View>

        <Section
          testID="calendar-day"
          title={selectedDate === null ? 'That day' : `${WEEKDAYS[selectedDate.getDay()]} ${selectedDate.getDate()}`}
          aside={selected === undefined ? undefined : relativeDay(selectedKey, todayKey)}
          style={styles.daySection}
        >
          {selected === undefined ? (
            <Panel testID="calendar-day-empty">
              <Text style={styles.emptyTitle}>
                {selectedIsAhead ? 'Not yet' : 'Nothing logged'}
              </Text>
              <Text style={styles.emptyHint}>
                {selectedIsAhead
                  ? 'You can log this day once it has happened.'
                  : 'Logging what you wore keeps your wear counts honest and teaches the suggestions what you actually reach for.'}
              </Text>
              {/* No button on a future day: `POST /wear-history` rejects a
                  `wornAt` in the future outright, so offering it would be
                  offering a 400. */}
              {selectedIsAhead ? null : (
                <Button
                  testID="calendar-log"
                  label="Log what you wore"
                  onPress={() => router.push(`/calendar/${selectedKey}`)}
                  style={styles.dayButton}
                />
              )}
            </Panel>
          ) : (
            <>
              <Panel testID="calendar-day-wear" glow={selectedColors}>
                {selectedItems.length > 0 ? (
                  <Strip uris={selectedItems.map((i) => i.thumbnailUrl ?? i.imageUrl)} />
                ) : null}
                <View style={styles.wearFoot}>
                  <Text style={text.title} numberOfLines={1}>
                    {/* Never "Outfit deleted": the name is absent both when the
                        outfit is gone AND when it simply never had one, and
                        `GET /wear-history` collapses the two on purpose. */}
                    {selected.latest.outfitName ?? 'Unnamed outfit'}
                  </Text>
                  {selected.latest.occasion === undefined ? null : (
                    <Lozenge>
                      <Pip hex={occasionColor(selected.latest.occasion)} size={7} />
                      <Text style={styles.occasionText}>{selected.latest.occasion}</Text>
                    </Lozenge>
                  )}
                </View>
                {selected.count > 1 ? (
                  <Text style={styles.alsoWorn}>
                    {`and ${selected.count - 1} more ${selected.count === 2 ? 'outfit' : 'outfits'} that day`}
                  </Text>
                ) : null}
              </Panel>
              <Button
                testID="calendar-log-another"
                label="Log another outfit for this day"
                variant="ghost"
                onPress={() => router.push(`/calendar/${selectedKey}`)}
                style={styles.dayButton}
              />
            </>
          )}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function NavArrow({
  testID,
  icon,
  label,
  onPress,
}: {
  testID: string;
  icon: 'chevron-back' | 'chevron-forward';
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.arrow, pressed ? styles.pressed : null]}
    >
      <Ionicons name={icon} size={16} color={color.ink} />
    </Pressable>
  );
}

/** "Today" / "Yesterday" / "6 days ago" — from day keys, so no clock is read. */
function relativeDay(dayKey: string, todayKey: string): string | undefined {
  const day = dateFromDayKey(dayKey);
  const today = dateFromDayKey(todayKey);
  if (day === null || today === null) return undefined;
  // Both are local midnights, so this is a whole number of days even across a
  // daylight-saving boundary once rounded.
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 0) return undefined;
  return `${days} days ago`;
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
  calendar: { paddingHorizontal: space.gutter },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  month: { fontFamily: font.displayMedium, fontSize: 24, letterSpacing: -0.5, color: color.ink },
  year: { fontFamily: font.body, fontSize: 15, color: color.soft },
  arrows: { flexDirection: 'row', gap: 6 },
  arrow: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: color.cloud,
    alignItems: 'center',
    justifyContent: 'center',
  },

  loading: { paddingVertical: 90, alignItems: 'center' },

  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 13, marginTop: space.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendText: { ...text.meta, fontSize: 11.5 },

  daySection: { paddingTop: space.xxl },
  wearFoot: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.md,
    marginTop: 13,
  },
  occasionText: { fontFamily: font.medium, fontSize: 12, color: color.ink },
  alsoWorn: { ...text.meta, marginTop: space.sm },

  emptyTitle: { ...text.title, marginBottom: 6 },
  emptyHint: { ...text.meta, fontSize: 13.5, lineHeight: 20 },
  dayButton: { marginTop: space.md },

  pressed: { opacity: 0.72 },
});
