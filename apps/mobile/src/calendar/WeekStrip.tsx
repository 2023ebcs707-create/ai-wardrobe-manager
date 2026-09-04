/**
 * The week so far, on the Wardrobe screen.
 *
 * Seven boxes: a photograph of what was worn, or the date if nothing was. It
 * is the calendar's idea at a glance — and it is on the home screen because
 * the gap in a wear log is what makes it useless, and a gap you can see on the
 * screen you open every morning is one you fill in.
 *
 * Read-only. Every cell goes to the Calendar tab, which is where logging,
 * editing and the month itself live; a strip that led to three different
 * places depending on which box you hit would be a puzzle rather than a
 * preview.
 */
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PublicClothingItem } from '@wardrobe/shared';
import { color, radius, space } from '../theme/tokens';
import { font } from '../theme/type';
import { dateFromDayKey, type DayWears } from './month';

const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

export interface WeekStripProps {
  /** Seven `YYYY-MM-DD` keys, Monday first — from `weekOf`. */
  days: readonly string[];
  wearsByDay: Record<string, DayWears>;
  itemsById: Record<string, PublicClothingItem>;
  todayKey: string;
  onOpen: () => void;
}

export function WeekStrip({ days, wearsByDay, itemsById, todayKey, onOpen }: WeekStripProps) {
  return (
    <View testID="week-strip" style={styles.strip}>
      {days.map((dayKey, index) => {
        const wears = wearsByDay[dayKey];
        const photo = wears === undefined ? undefined : photoFor(wears.latest.itemIds, itemsById);
        const date = dateFromDayKey(dayKey);
        const isToday = dayKey === todayKey;

        return (
          <Pressable
            key={dayKey}
            testID={`week-day-${dayKey}`}
            onPress={onOpen}
            accessibilityRole="button"
            // The visible cell is a letter and a photograph, neither of which
            // announces anything — this is the whole accessible content.
            accessibilityLabel={label(dayKey, wears, isToday)}
            style={styles.day}
          >
            <Text style={styles.initial}>{WEEKDAY_INITIALS[index]}</Text>
            <View style={[styles.box, isToday ? styles.boxToday : null]}>
              {photo === undefined ? (
                <Text style={styles.number}>{date === null ? '' : date.getDate()}</Text>
              ) : (
                <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} />
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The first garment of the wear that still resolves — see `MonthGrid`'s copy. */
function photoFor(
  itemIds: readonly string[],
  itemsById: Record<string, PublicClothingItem>,
): string | undefined {
  for (const id of itemIds) {
    const item = itemsById[id];
    if (item !== undefined) return item.thumbnailUrl ?? item.imageUrl;
  }
  return undefined;
}

function label(dayKey: string, wears: DayWears | undefined, isToday: boolean): string {
  const date = dateFromDayKey(dayKey);
  const day = date === null ? dayKey : `${WEEKDAY_NAMES[date.getDay()]} ${date.getDate()}`;
  const when = isToday ? `${day}, today` : day;
  if (wears === undefined) return `${when}, nothing logged`;
  return `${when}, ${wears.latest.outfitName ?? 'an outfit'}`;
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', gap: 7, paddingHorizontal: space.gutter, paddingBottom: 22 },
  day: { flex: 1 },
  initial: {
    textAlign: 'center',
    fontFamily: font.semibold,
    fontSize: 10,
    color: color.soft,
    marginBottom: 5,
  },
  box: {
    aspectRatio: 1,
    borderRadius: radius.sm - 1,
    overflow: 'hidden',
    backgroundColor: color.cloud,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Today is a ring, not a fill: the fill is already carrying "was anything
  // worn", and one box cannot say two things with the same property.
  boxToday: { borderWidth: 2, borderColor: color.ink },
  number: { fontFamily: font.semibold, fontSize: 11, color: color.soft },
});
