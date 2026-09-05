/**
 * The month, as a contact sheet.
 *
 * THE IDEA THIS SCREEN EXISTS FOR: a worn day is a *photograph*, not a dot.
 * A dot calendar tells you that you logged something, which you already knew;
 * a grid of the actual garments tells you that you have worn the same jacket
 * to every dinner this month. That is the only thing this screen can say that
 * a generic calendar cannot, so it is what the cell is built around.
 */
import { memo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { PublicClothingItem } from '@wardrobe/shared';
import { color, occasionColor, radius, space } from '../theme/tokens';
import { font } from '../theme/type';
import { WEEKDAY_INITIALS, type DayPlans, type DayWears } from './month';

export interface MonthGridProps {
  year: number;
  month: number;
  /** From `monthCells` — `null` is a leading blank before the 1st. */
  cells: (number | null)[];
  /** Keyed by `YYYY-MM-DD`, from `indexWearsByDay`. */
  wearsByDay: Record<string, DayWears>;
  /**
   * Keyed by `YYYY-MM-DD`, from `indexPlansByDay`.
   *
   * Optional so a host that does not read plans is unaffected — the same
   * reason `ItemTile.selected` is optional. Defaults to nothing planned.
   */
  plansByDay?: Record<string, DayPlans>;
  itemsById: Record<string, PublicClothingItem>;
  /** `YYYY-MM-DD`, or null when the visible month contains no today. */
  todayKey: string | null;
  selectedKey: string | null;
  onSelectDay: (dayKey: string) => void;
}

const COLUMNS = 7;

export function MonthGrid({
  year,
  month,
  cells,
  wearsByDay,
  plansByDay = {},
  itemsById,
  todayKey,
  selectedKey,
  onSelectDay,
}: MonthGridProps) {
  // Chunked into rows rather than laid out by `flexWrap` with percentage
  // widths: a percentage width plus a `gap` overflows its container by the
  // total gap, and the usual fix is measuring the container. Explicit rows of
  // `flex: 1` cells need no measurement and stay correct at any width.
  const rows: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += COLUMNS) rows.push(cells.slice(i, i + COLUMNS));

  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;

  return (
    <View testID="calendar-grid">
      <View style={styles.weekdays}>
        {WEEKDAY_INITIALS.map((initial, i) => (
          // The key is the position: "T" and "S" each appear twice, so the
          // letter alone is not unique.
          <Text key={i} style={styles.weekday}>
            {initial}
          </Text>
        ))}
      </View>

      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {row.map((day, columnIndex) => {
            if (day === null) return <View key={`pad-${columnIndex}`} style={styles.cellSlot} />;
            const dayKey = `${monthPrefix}-${String(day).padStart(2, '0')}`;
            return (
              <DayCell
                key={dayKey}
                day={day}
                dayKey={dayKey}
                wears={wearsByDay[dayKey]}
                plans={plansByDay[dayKey]}
                itemsById={itemsById}
                isToday={dayKey === todayKey}
                isSelected={dayKey === selectedKey}
                // A day is "ahead" by string compare, which is safe because
                // both sides are zero-padded `YYYY-MM-DD` within one month.
                isAhead={todayKey !== null && dayKey > todayKey}
                onPress={onSelectDay}
              />
            );
          })}
          {/* Spacers so a short last row keeps the same column width as every
              other row. Not day cells: a screen reader must not find seven
              items in a row that only has three. */}
          {row.length < COLUMNS
            ? Array.from({ length: COLUMNS - row.length }, (_, i) => (
                <View key={`tail-${i}`} style={styles.cellSlot} />
              ))
            : null}
        </View>
      ))}
    </View>
  );
}

interface DayCellProps {
  day: number;
  dayKey: string;
  wears: DayWears | undefined;
  plans: DayPlans | undefined;
  itemsById: Record<string, PublicClothingItem>;
  isToday: boolean;
  isSelected: boolean;
  isAhead: boolean;
  onPress: (dayKey: string) => void;
}

const DayCell = memo(function DayCell({
  day,
  dayKey,
  wears,
  plans,
  itemsById,
  isToday,
  isSelected,
  isAhead,
  onPress,
}: DayCellProps) {
  const worn = wears !== undefined;
  /**
   * A day shows its PLAN only while nothing has been worn on it.
   *
   * A worn day is a settled fact and a planned one is an intention, so once
   * the day has happened the photograph of what was actually worn is the
   * honest cell — showing a plan over it would keep asserting an intention the
   * day has already answered. This is also what keeps the two markers from
   * ever competing for the same corner.
   */
  const planned = !worn && plans !== undefined;
  // A planned day is drawn from the outfit it plans, using the same
  // snapshotted-ids fallback a worn day uses.
  const photo = worn
    ? photoFor(wears.latest.itemIds, itemsById)
    : planned
      ? photoFor(plans.first.itemIds, itemsById)
      : undefined;

  return (
    // The ring lives on an outer view with a transparent border by default, so
    // selecting a day changes a colour and never the layout — a border that
    // appears on selection reflows the whole grid by 2px.
    <View style={[styles.cellSlot, styles.ring, isSelected ? styles.ringOn : null]}>
      <Pressable
        testID={`calendar-day-${dayKey}`}
        onPress={() => onPress(dayKey)}
        accessibilityRole="button"
        accessibilityState={{ selected: isSelected }}
        accessibilityLabel={dayLabel(day, wears, planned ? plans : undefined, isToday)}
        style={({ pressed }) => [
          styles.cell,
          worn ? null : isAhead ? styles.cellAhead : styles.cellFree,
          // Not while it is also selected: the selection ring is drawn just
          // outside this cell, and two concentric ink outlines read as a
          // rendering fault rather than as two facts. Nothing is lost — the
          // panel below names the day, and today is where the screen opens.
          isToday && !isSelected ? styles.cellToday : null,
          pressed ? styles.pressed : null,
        ]}
      >
        {photo === undefined ? null : (
          <>
            <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} />
            {/* The scrim, so a white shirt cannot swallow the date on top of it. */}
            <LinearGradient
              colors={['transparent', 'rgba(0,0,0,0.48)']}
              locations={[0.45, 1]}
              style={StyleSheet.absoluteFill}
            />
          </>
        )}
        {worn ? (
          <View
            testID={`calendar-occasion-${dayKey}`}
            style={[styles.occasion, { backgroundColor: occasionColor(wears.latest.occasion) }]}
          />
        ) : planned ? (
          /* A HOLLOW ring where a worn day has a filled dot — a SHAPE
             difference, not a colour one, so "planned" and "worn" stay
             distinguishable in greyscale and to a colour-blind reader. The
             same argument the `cellAhead` outline below is built on. The ring
             still takes the occasion's hue, so a planned dinner and a planned
             work day read as they do everywhere else in this app. */
          <View
            testID={`calendar-planned-${dayKey}`}
            style={[styles.planned, { borderColor: occasionColor(plans.first.occasion) }]}
          />
        ) : null}
        <Text
          style={[
            styles.number,
            isToday ? styles.numberToday : null,
            // Last, so it wins on a day that is both today and worn: the ring
            // already says "today", and ink on a photograph is unreadable.
            photo === undefined ? null : styles.numberOnPhoto,
          ]}
        >
          {day}
        </Text>
      </Pressable>
    </View>
  );
});

/**
 * The first garment of the wear that has a photo — not strictly the first id.
 *
 * `itemIds` is a snapshot, so an item deleted since can be missing from the
 * wardrobe map; falling through to the next one keeps the day photographic
 * instead of blanking it because of a garment the user threw out.
 */
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

/**
 * What a screen reader says. The visible cell is a numeral and a photograph,
 * neither of which announces anything, so this is the entire accessible
 * content of the day.
 */
function dayLabel(
  day: number,
  wears: DayWears | undefined,
  plans: DayPlans | undefined,
  isToday: boolean,
): string {
  const parts = [isToday ? `${day}, today` : `${day}`];
  if (wears !== undefined) {
    parts.push(wears.latest.outfitName ?? 'an outfit');
    if (wears.latest.occasion !== undefined) parts.push(`for ${wears.latest.occasion}`);
    if (wears.count > 1) parts.push(`and ${wears.count - 1} more`);
  } else if (plans !== undefined) {
    // The hollow ring is invisible to a screen reader, so without this the
    // planned state simply does not exist for a TalkBack user. "Planned"
    // leads, because that is the word that distinguishes this from a worn day.
    parts.push(`planned: ${plans.first.outfitName ?? 'an outfit'}`);
    if (plans.first.occasion !== undefined) parts.push(`for ${plans.first.occasion}`);
    if (plans.count > 1) parts.push(`and ${plans.count - 1} more planned`);
  } else {
    parts.push('nothing logged');
  }
  return parts.join(', ');
}

const styles = StyleSheet.create({
  weekdays: { flexDirection: 'row', gap: 6, marginBottom: 7, marginTop: space.lg },
  weekday: {
    flex: 1,
    textAlign: 'center',
    fontFamily: font.semibold,
    fontSize: 10,
    letterSpacing: 0.4,
    color: color.soft,
  },
  row: { flexDirection: 'row', gap: 6, marginBottom: 6 },

  cellSlot: { flex: 1 },
  ring: { borderWidth: 2, borderColor: 'transparent', borderRadius: radius.sm + 4, padding: 2 },
  ringOn: { borderColor: color.ink },

  cell: {
    aspectRatio: 1,
    borderRadius: radius.sm,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  cellFree: { backgroundColor: color.cloud },
  // A future day is drawn, not hidden: an invisible cell would make the
  // month's shape unreadable. Outlined where a past day is filled — the state
  // is a SHAPE, not a lighter numeral, so it survives greyscale and stays
  // legible. See the note at the foot of `theme/tokens.ts`.
  cellAhead: { borderWidth: StyleSheet.hairlineWidth, borderColor: color.cloud },
  cellToday: { borderWidth: 2, borderColor: color.ink },

  occasion: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.85)',
  },
  // The planned marker: same size and position as the occasion dot, HOLLOW
  // rather than filled. `backgroundColor` is deliberately absent — that
  // absence is the whole distinction, and `borderColor` is supplied inline
  // from the occasion hue.
  planned: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    borderWidth: 2,
  },

  number: {
    fontFamily: font.semibold,
    fontSize: 11,
    lineHeight: 13,
    color: color.soft,
    paddingHorizontal: 6,
    paddingBottom: 4,
  },
  numberOnPhoto: {
    // Pure white, not `shell` — this one sits on a photograph rather than on a
    // surface, and it is paired with a text shadow rather than with a token.
    color: '#FFFFFF',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
  numberToday: { color: color.ink, fontFamily: font.bold },

  pressed: { opacity: 0.7 },
});
